/**
 * 修复脚本：修改三个核心文件解决 "Invalid consecutive assistant message" 问题
 * 
 * 目标文件：
 * 1. src/core/model-adapters.js   — deepseek llmConfig 增加 requireUserLast + strictAlternation
 * 2. src/core/agent-loop-controller.js — _callLLM 内新增 _sanitizeConversation 并写回 this.messages
 * 3. src/core/llm-gateway.js       — 兜底 sanitize
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ═══════════════════════════════════════════
// 1. model-adapters.js
// ═══════════════════════════════════════════
{
    const fp = path.join(ROOT, 'src/core/model-adapters.js');
    let src = fs.readFileSync(fp, 'utf8');

    // 在 deepseek.llmConfig 中 parallelToolCalls: false 的下一行插入两行配置
    const needle = 'parallelToolCalls: false,\r\n            // Reasoner';
    const needle2 = 'parallelToolCalls: false,\n            // Reasoner';
    const replacement = `parallelToolCalls: false,
            // DeepSeek 后端要求严格的 user/assistant 交替，不允许连续 assistant
            requireUserLast: true,
            strictAlternation: true,
            // Reasoner`;

    if (src.includes(needle)) {
        src = src.replace(needle, replacement);
    } else if (src.includes(needle2)) {
        src = src.replace(needle2, replacement);
    } else {
        console.error('[FAIL] model-adapters.js: 未找到插入点');
        process.exit(1);
    }

    fs.writeFileSync(fp, src, 'utf8');
    console.log('[OK] model-adapters.js: deepseek 增加 requireUserLast + strictAlternation');
}

// ═══════════════════════════════════════════
// 2. agent-loop-controller.js
// ═══════════════════════════════════════════
{
    const fp = path.join(ROOT, 'src/core/agent-loop-controller.js');
    let src = fs.readFileSync(fp, 'utf8');

    // --- 2a. 新增 _sanitizeConversation 方法 ---
    // 在 _compressContextIfNeeded 之前插入新方法
    const compressAnchor = '  // --- Context smart compression ---';
    if (!src.includes(compressAnchor)) {
        console.error('[FAIL] agent-loop-controller.js: 未找到 _compressContextIfNeeded 锚点');
        process.exit(1);
    }

    const sanitizeMethod = `  // --- 消息序列规范化：消除连续 assistant，确保 user-last ---
  // 规则：
  // 1) 连续 assistant 且都无 tool_calls → 合并 content（\\n\\n 拼接）
  // 2) 连续 assistant 且其中一条含 tool_calls → 保留含 tool_calls 的，另一条转 user（加 [note] 前缀）
  // 3) 不能破坏 assistant(tool_calls) → tool 的协议对（不在它们之间插 user）
  // 4) 最后一条不是 user 时，push user 并写回 this.messages
  _sanitizeConversation(messages, { strict = false, writeBack = false } = {}) {
    if (!messages || messages.length === 0) return messages;
    const result = [];
    for (let i = 0; i < messages.length; i++) {
      const cur = messages[i];
      const prev = result.length > 0 ? result[result.length - 1] : null;

      // 检测连续 assistant
      if (prev && prev.role === 'assistant' && cur.role === 'assistant') {
        const prevHasTC = !!(prev.tool_calls && prev.tool_calls.length > 0);
        const curHasTC = !!(cur.tool_calls && cur.tool_calls.length > 0);

        if (!prevHasTC && !curHasTC) {
          // 都无 tool_calls → 合并 content
          const prevContent = prev.content || '';
          const curContent = cur.content || '';
          if (prevContent && curContent) {
            prev.content = prevContent + '\\n\\n' + curContent;
          } else {
            prev.content = prevContent || curContent || '';
          }
          this.tracer?.warn(\`sanitize: merged consecutive assistant msgs at index \${i}\`);
          continue; // 跳过当前，已合并到 prev
        } else {
          // 其中一条含 tool_calls → 将无 tool_calls 的那条转 user
          if (prevHasTC && !curHasTC) {
            // prev 有 tool_calls，但 prev 后面应该紧跟 tool 结果
            // 先检查 prev 后续是否有 tool 消息未到
            // 安全做法：将 cur 转为 user
            cur.role = 'user';
            cur.content = '[note] ' + (cur.content || '');
            this.tracer?.warn(\`sanitize: converted assistant→user at index \${i} (prev has tool_calls)\`);
          } else if (!prevHasTC && curHasTC) {
            // cur 有 tool_calls → 把 prev 转 user
            prev.role = 'user';
            prev.content = '[note] ' + (prev.content || '');
            this.tracer?.warn(\`sanitize: converted assistant→user at index \${i-1} (next has tool_calls)\`);
          } else {
            // 都有 tool_calls（极端情况）→ 在中间插一条 user
            result.push({ role: 'user', content: 'Continue with the next step.' });
            this.tracer?.warn(\`sanitize: inserted user between dual tool_calls assistants at index \${i}\`);
          }
        }
      }
      result.push(cur);
    }

    // 确保最后一条是 user（但不破坏 assistant(tool_calls)→tool 协议对）
    if (result.length > 0) {
      const last = result[result.length - 1];
      if (last.role !== 'user') {
        // 如果最后是 tool 消息，说明后面紧跟 LLM 调用，可以直接加 user
        // 如果最后是 assistant，要分情况：有 tool_calls 就不加（工具结果还没来）
        const hasToolCalls = !!(last.tool_calls && last.tool_calls.length > 0);
        if (!hasToolCalls) {
          const prompt = last.role === 'tool'
            ? 'Continue based on the tool results above.'
            : last.role === 'system'
              ? 'Please follow the latest system instructions and continue with the next actionable step.'
              : 'Continue based on the conversation above.';
          result.push({ role: 'user', content: prompt });
        }
      }
    }

    // 写回 this.messages
    if (writeBack) {
      this.messages = result;
    }

    // 日志：打印角色序列用于调试
    if (strict) {
      const roleSeq = result.map(m => m.role).join(', ');
      console.log('[sanitize] roles:', roleSeq);
      // 验证无连续 assistant
      for (let i = 1; i < result.length; i++) {
        if (result[i].role === 'assistant' && result[i-1].role === 'assistant') {
          this.tracer?.warn(\`sanitize: STILL consecutive assistant at index \${i} after cleanup!\`);
        }
      }
    }

    return result;
  }

`;

    src = src.replace(compressAnchor, sanitizeMethod + compressAnchor);

    // --- 2b. 修改 _callLLM 中的消息序列规范化逻辑 ---
    // 找到旧的 sanitizedMessages 逻辑并替换
    const oldSanitizeStart = '      // 消息序列规范化：部分模型要求最后一条消息是 user 角色';
    const oldSanitizeEnd = '      this.llm.streamChat({';

    const startIdx = src.indexOf(oldSanitizeStart);
    const endIdx = src.indexOf(oldSanitizeEnd, startIdx);

    if (startIdx < 0 || endIdx < 0) {
        console.error('[FAIL] agent-loop-controller.js: 未找到 _callLLM sanitize 替换区间');
        process.exit(1);
    }

    const newSanitizeBlock = `      // 消息序列规范化：消除连续 assistant + 确保 user-last
      // 获取适配器配置判断是否需要 strict 模式
      const _adapter = require('./model-adapters').getAdapter(effectiveModelId);
      const _llmCfg = _adapter.llmConfig || {};
      const _strict = !!_llmCfg.strictAlternation;

      // 深拷贝消息避免副作用
      let sanitizedMessages = this.messages.map(m => {
        const cloned = { ...m };
        if (m.tool_calls) cloned.tool_calls = m.tool_calls;
        return cloned;
      });
      sanitizedMessages = this._sanitizeConversation(sanitizedMessages, { strict: _strict, writeBack: true });

`;

    src = src.substring(0, startIdx) + newSanitizeBlock + src.substring(endIdx);

    fs.writeFileSync(fp, src, 'utf8');
    console.log('[OK] agent-loop-controller.js: 新增 _sanitizeConversation + 替换 _callLLM sanitize 逻辑');
}

// ═══════════════════════════════════════════
// 3. llm-gateway.js
// ═══════════════════════════════════════════
{
    const fp = path.join(ROOT, 'src/core/llm-gateway.js');
    let src = fs.readFileSync(fp, 'utf8');

    // 在 _ensureUserLastMessage 之后添加兜底 sanitize 方法
    const ensureEnd = src.indexOf('  _mergeToolName(');
    if (ensureEnd < 0) {
        console.error('[FAIL] llm-gateway.js: 未找到 _mergeToolName 锚点');
        process.exit(1);
    }

    const gatewayMethod = `  // 兜底：消除 messages 中的连续 assistant，确保严格交替
  // 不破坏 assistant(tool_calls) → tool 协议对
  _sanitizeMessagesStrict(messages) {
    if (!messages || messages.length === 0) return messages;
    const result = [];
    for (let i = 0; i < messages.length; i++) {
      const cur = { ...messages[i] };
      if (messages[i].tool_calls) cur.tool_calls = messages[i].tool_calls;
      const prev = result.length > 0 ? result[result.length - 1] : null;

      if (prev && prev.role === 'assistant' && cur.role === 'assistant') {
        const prevHasTC = !!(prev.tool_calls && prev.tool_calls.length > 0);
        const curHasTC = !!(cur.tool_calls && cur.tool_calls.length > 0);
        if (!prevHasTC && !curHasTC) {
          prev.content = ((prev.content || '') + '\\n\\n' + (cur.content || '')).trim();
          continue;
        } else if (prevHasTC && !curHasTC) {
          cur.role = 'user';
          cur.content = '[note] ' + (cur.content || '');
        } else if (!prevHasTC && curHasTC) {
          prev.role = 'user';
          prev.content = '[note] ' + (prev.content || '');
        } else {
          result.push({ role: 'user', content: 'Continue.' });
        }
      }
      result.push(cur);
    }
    return result;
  }

`;

    src = src.substring(0, ensureEnd) + gatewayMethod + src.substring(ensureEnd);

    // 在 body.messages 确定后、发请求前，增加 strictAlternation 兜底 sanitize
    // 找到 "if (llmCfg.requireUserLast === true)" 那一段
    const requireUserLastBlock = 'if (llmCfg.requireUserLast === true) {';
    const requireUserLastIdx = src.indexOf(requireUserLastBlock);
    if (requireUserLastIdx < 0) {
        console.error('[FAIL] llm-gateway.js: 未找到 requireUserLast 检查');
        process.exit(1);
    }

    // 在 requireUserLast 代码块之后插入 strictAlternation 块
    // 找到这个 if 块的 closing }
    let braceDepth = 0;
    let blockEnd = requireUserLastIdx;
    for (let i = requireUserLastIdx; i < src.length; i++) {
        if (src[i] === '{') braceDepth++;
        else if (src[i] === '}') {
            braceDepth--;
            if (braceDepth === 0) {
                blockEnd = i + 1;
                break;
            }
        }
    }

    const strictBlock = `

    // 兜底：strictAlternation 模式下消除连续 assistant
    if (llmCfg.strictAlternation === true) {
      body.messages = this._sanitizeMessagesStrict(body.messages);
      // 打印角色序列用于调试（仅 warn 级别）
      const roleSeq = body.messages.map(m => m.role).join(', ');
      console.log('[LLMGateway] strict roles:', roleSeq);
    }
`;

    src = src.substring(0, blockEnd) + strictBlock + src.substring(blockEnd);

    fs.writeFileSync(fp, src, 'utf8');
    console.log('[OK] llm-gateway.js: 新增 _sanitizeMessagesStrict + strictAlternation 兜底');
}

console.log('\n✅ 三个文件全部修改完成');
