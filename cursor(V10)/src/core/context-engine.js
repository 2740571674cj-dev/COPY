const { TokenCounter } = require('./token-counter');
const { DynamicContextProvider } = require('./dynamic-context-provider');

class ContextEngine {
  constructor() {
    this.tokenCounter = new TokenCounter();
    this.contextProvider = new DynamicContextProvider();
  }

  async buildContext({ projectPath, openFiles, recentlyEdited, linterErrors, terminalOutput, maxTokens = 8000 }) {
    return this.contextProvider.gather({
      projectPath,
      openFiles,
      recentlyEdited,
      linterErrors,
      terminalOutput,
      maxTokens,
    });
  }

  computeBudget({ modelMaxTokens = 128000, systemPromptTokens = 4000, toolDefsTokens = 3000, responseReserve = 4096 }) {
    const available = modelMaxTokens - systemPromptTokens - toolDefsTokens - responseReserve;
    return {
      totalBudget: modelMaxTokens,
      systemReserve: systemPromptTokens,
      toolDefsReserve: toolDefsTokens,
      responseReserve,
      historyBudget: Math.floor(available * 0.6),
      contextBudget: Math.floor(available * 0.4),
      available,
    };
  }

  /**
   * 估算消息列表的 token 数（CJK/ASCII 区分）
   */
  estimateTokenCount(messages) {
    let tokens = 0;
    for (const msg of messages) {
      if (msg.content) {
        // content 可能是字符串或数组（Prompt Caching 格式: [{type:'text', text:'...', cache_control:{...}}]）
        let text;
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content.map(c => c.text || (typeof c === 'string' ? c : '')).join('');
        } else {
          text = String(msg.content);
        }
        const cjkCount = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
        const asciiCount = text.length - cjkCount;
        tokens += Math.ceil(cjkCount / 1.5 + asciiCount / 4);
      }
      if (msg.tool_calls) tokens += Math.ceil(JSON.stringify(msg.tool_calls).length / 4);
    }
    return tokens;
  }

  /**
   * 统一的上下文压缩（从 AgentLoopController 迁移）
   * 保留：系统消息、用户消息、TODO 进度、工作流/记忆关键消息、文件变更/关键决策摘要
   *
   * @param {Array} messages - 当前消息列表
   * @param {object} opts
   * @param {number} opts.budget - token 预算上限
   * @param {number} opts.thresholdPct - 触发压缩的阈值百分比 (0-100)
   * @param {object} [opts.todoStore] - TodoStore 实例
   * @returns {{ compressed: boolean, messages: Array, stats?: { removed: number, kept: number } }}
   */
  compressIfNeeded(messages, { budget, thresholdPct = 60, todoStore = null } = {}) {
    if (!messages || messages.length < 2) {
      return { compressed: false, messages: messages || [] };
    }

    const estimatedTokens = this.estimateTokenCount(messages);
    const threshold = (thresholdPct || 60) / 100;
    // Bug #7 fix: 绝对阈值从 16000 调高到 40000，避免复杂任务中过早压缩丢失上下文
    const absoluteLimit = 40000;
    if (estimatedTokens < absoluteLimit && estimatedTokens < budget * threshold) {
      return { compressed: false, messages };
    }

    const systemMsg = messages[0];
    const userMsg = messages[1];

    // Separate critical system messages (workflow, memory, summaries) — always keep
    const criticalSystemMsgs = [];
    const middle = [];
    for (let i = 2; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'system' && (
        msg.content?.includes('[工作流已匹配]') ||
        msg.content?.includes('[Workflow matched]') ||
        msg.content?.includes('[会话记忆]') ||
        msg.content?.includes('[上下文摘要]')
      )) {
        criticalSystemMsgs.push(msg);
      } else {
        middle.push(msg);
      }
    }

    if (middle.length < 6) {
      return { compressed: false, messages };
    }

    // ─── 配对感知的轮次分组 ───
    // 将 middle 按 "assistant(tool_calls) + 后续 tool(result)" 分组为不可分割的轮次。
    // 这确保压缩切割不会从 tool_use/tool_result 配对中间断开。
    const rounds = this._groupIntoRounds(middle);

    // --- 3-tier decay (以轮次为单位) ---
    const HOT_ROUNDS = 2;   // [Optimize: Token Saving] 最近 2 轮完整保留（从 3 收紧）
    const WARM_ROUNDS = 3;  // [Optimize: Token Saving] 2-5 轮截断长内容（从 5 收紧）

    const hotRounds = rounds.slice(Math.max(0, rounds.length - HOT_ROUNDS));
    const warmStart = Math.max(0, rounds.length - HOT_ROUNDS - WARM_ROUNDS);
    const warmEnd = Math.max(0, rounds.length - HOT_ROUNDS);
    const warmRounds = rounds.slice(warmStart, warmEnd);
    const coldRounds = rounds.slice(0, warmStart);

    // 展平轮次回消息数组
    const hotZone = hotRounds.flat();
    const warmZone = warmRounds.flat();
    const coldZone = coldRounds.flat();

    // Warm zone: truncate tool results but keep structure intact
    const compressedWarm = warmZone.map(msg => {
      // [Optimize: Token Saving] 阅后即焚：read_file 结果（含 totalLines）直接替换为占位符
      if (msg.role === 'tool' && msg.content && msg.content.includes('totalLines')) {
        return { ...msg, content: '[File read successful. Content omitted to save context. Read again if strictly needed.]' };
      }
      // [Optimize: Token Saving] 其他 tool 截断阈值从 2000 收紧到 1500
      if (msg.role === 'tool' && msg.content && msg.content.length > 1500) {
        return { ...msg, content: msg.content.substring(0, 1500) + '\n... [truncated by context compression]' };
      }
      if (msg.role === 'assistant' && msg.content && msg.content.length > 3000 && !msg.tool_calls) {
        return { ...msg, content: msg.content.substring(0, 3000) + '\n... [truncated]' };
      }
      return msg;
    });

    // Cold zone: extract file changes, tool call history, and key decisions
    const fileChanges = new Set();
    const keyDecisions = [];
    const toolCallSummary = [];

    for (const msg of coldZone) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const name = tc.function?.name;
          if (['write_file', 'edit_file', 'create_file', 'delete_file'].includes(name)) {
            try {
              const args = JSON.parse(tc.function.arguments);
              if (args.path || args.file_path) fileChanges.add(args.path || args.file_path);
            } catch (_) { }
          }
          if (name) toolCallSummary.push({ id: tc.id, name });
        }
        if (msg.content && msg.content.length > 20) {
          keyDecisions.push(msg.content.substring(0, 200));
        }
      } else if (msg.role === 'tool' && msg.tool_call_id) {
        const entry = toolCallSummary.find(t => t.id === msg.tool_call_id);
        if (entry) {
          try {
            const parsed = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
            entry.success = parsed?.success !== false;
          } catch (_) {
            entry.success = !msg.content?.includes('"success":false');
          }
        }
      } else if (msg.role === 'assistant' && msg.content && msg.content.length > 50) {
        keyDecisions.push(msg.content.substring(0, 200));
      }
    }

    // Build todo progress snapshot
    let todoDetail = '';
    if (todoStore) {
      const todos = todoStore.get();
      const progress = todoStore.getProgress();
      todoDetail = `\n\n当前任务清单（${progress.completed}/${progress.total} 完成）：\n`;
      for (const t of todos) {
        const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜';
        todoDetail += `${icon} ${t.content}\n`;
      }
    }

    const fileChangeList = fileChanges.size > 0 ? `\n已修改的文件：${[...fileChanges].join('、')}` : '';
    const toolHistory = toolCallSummary.length > 0
      ? `\n工具调用历史：${toolCallSummary.map(t => `${t.name}(${t.success === false ? '失败' : '成功'})`).join('、')}`
      : '';
    const decisionList = keyDecisions.length > 0
      ? `\n关键操作记录：\n${keyDecisions.slice(-5).map(d => `- ${d}`).join('\n')}`
      : '';

    const summaryMsg = {
      role: 'system',
      content: `[上下文摘要] 已压缩 ${coldZone.length} 条旧消息。${fileChangeList}${toolHistory}${decisionList}${todoDetail}\n\n请继续执行清单中剩余未完成的任务，不要重复已完成的工作。`,
    };

    const newMessages = [systemMsg, userMsg, ...criticalSystemMsgs, summaryMsg, ...compressedWarm, ...hotZone];

    // ─── 安全校验：确保最终消息序列中没有孤立的 tool_result ───
    const validated = this._validateToolPairing(newMessages);

    return {
      compressed: true,
      messages: validated,
      stats: {
        removed: coldZone.length,
        kept: compressedWarm.length + hotZone.length + criticalSystemMsgs.length,
        hotZoneSize: hotZone.length,
        warmZoneSize: compressedWarm.length,
        coldZoneSize: coldZone.length,
      },
    };
  }

  /**
   * 将消息列表按 tool_use/tool_result 配对分组为不可分割的"轮次"。
   * 每一轮 = [assistant(with tool_calls), tool_result_1, tool_result_2, ...] 或 [单条消息]
   */
  _groupIntoRounds(messages) {
    const rounds = [];
    let currentRound = [];

    for (const msg of messages) {
      if (msg.role === 'assistant') {
        // 遇到新 assistant 消息：上一轮结束（如果有的话）
        if (currentRound.length > 0) {
          rounds.push(currentRound);
        }
        currentRound = [msg];
      } else if (msg.role === 'tool') {
        // tool_result 必须跟在 assistant 后面
        currentRound.push(msg);
      } else {
        // user / system 等其他消息独立成轮
        if (currentRound.length > 0) {
          rounds.push(currentRound);
          currentRound = [];
        }
        rounds.push([msg]);
      }
    }
    if (currentRound.length > 0) {
      rounds.push(currentRound);
    }
    return rounds;
  }

  /**
   * 安全校验：移除所有找不到对应 tool_use 的 tool_result 消息。
   * 防止压缩后残留孤立 tool_result 导致 API 400 错误。
   */
  _validateToolPairing(messages) {
    // 收集所有 assistant 消息中声明的 tool_call_id
    const declaredIds = new Set();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.id) declaredIds.add(tc.id);
        }
      }
    }

    // 过滤掉孤立的 tool_result
    return messages.filter(msg => {
      if (msg.role === 'tool' && msg.tool_call_id) {
        return declaredIds.has(msg.tool_call_id);
      }
      return true; // 非 tool 消息全部保留
    });
  }
}

module.exports = { ContextEngine };
