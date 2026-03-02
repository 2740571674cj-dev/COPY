const { AgentTracer } = require('./agent-tracer');
const { ERROR_CODES, makeError } = require('./error-codes');
const { needsApproval } = require('./security-layer');
const { ReadCoverageIndex } = require('./read-coverage-index');
const { TrajectoryRecorder } = require('./trajectory-recorder');
const { getAdapter } = require('./model-adapters');
const { tracker: tokenTracker } = require('./token-tracker');
const { getAnomalyLogger } = require('./anomaly-logger');

const STATES = {
  IDLE: 'idle',
  PLANNING: 'planning',
  CALLING_LLM: 'calling_llm',
  EXECUTING_TOOLS: 'executing_tools',
  AWAITING_APPROVAL: 'awaiting_approval',
  REFLECTING: 'reflecting',
  COMPLETE: 'complete',
  INCOMPLETE: 'incomplete',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const STATE_LABELS = {
  [STATES.PLANNING]: 'Planning next moves',
  [STATES.CALLING_LLM]: 'Thinking...',
  [STATES.EXECUTING_TOOLS]: 'Running tools...',
  [STATES.AWAITING_APPROVAL]: 'Waiting for approval...',
  [STATES.REFLECTING]: 'Reviewing changes...',
  [STATES.COMPLETE]: 'Task complete',
  [STATES.INCOMPLETE]: 'Task incomplete',
  [STATES.FAILED]: 'Task failed',
  [STATES.CANCELLED]: 'Task cancelled',
};

class AgentLoopController {
  constructor({ llmGateway, toolExecutor, promptAssembler, contextEngine, config = {} }) {
    this.llm = llmGateway;
    this.tools = toolExecutor;
    this.promptAssembler = promptAssembler;
    this.contextEngine = contextEngine;

    this.config = {
      maxIterations: config.maxIterations || 60,
      maxTokenBudget: config.maxTokenBudget || 128000,
      responseTokenReserve: config.responseTokenReserve || 4096,
      ...config,
      // 2.3: Rollout guardrails — MUST be after ...config to avoid being overwritten
      guardrails: {
        maxToolCallsPerIteration: 10,
        maxToolCallsTotal: 300,
        maxEditRetriesPerFile: 3,
        maxReadRetriesPerFile: 3,
        maxConsecutiveSameToolCalls: 3, // 修复1: 从4降到3，更快检测工具循环
        sessionTTL: 3600000,
        chunkTimeoutMs: 90000,
        chunkIdleAfterFirstMs: 60000,
        ...(config.guardrails || {}),
      },
    };

    this.state = STATES.IDLE;
    this.messages = [];
    this.iteration = 0;
    this.toolCallCount = 0;
    this.abortController = null;
    this.pendingApproval = null;
    this.tracer = null;
    this.emitter = null;
    this.sessionId = null;
    this._currentMode = 'agent';
    this._openFiles = [];

    this._streamBuffer = '';
    this._lastFlushTime = 0;
    this._flushTimer = null;

    // Layer 1: Idle heartbeat fields
    this._heartbeatTimer = null;
    this._lastActivityTs = 0;
    this._heartbeatStart = 0;
    this._heartbeatPhase = '';

    this._gateRetries = 0;
    this._maxGateRetries = Number(config.maxGateRetries) > 0 ? Number(config.maxGateRetries) : 5;
    this._lastNoToolContent = '';
    this._stallCount = 0;
    this._consecutiveNoToolRounds = 0;
    this._modifiedFiles = new Set();
    this._lintCheckPending = false;
    this.readCoverage = new ReadCoverageIndex();
    this._splitSuggestSet = new Set();
    this._fileReadCounts = new Map();
    this._recentToolCalls = [];
    this._toolResultCache = new Map();
    this._successfulEdits = new Map();
    this._webFetchBlockedHints = new Set();
    this._qualityRetries = 0; // quality interceptor retry counter per iteration
    this._toolLoopCount = 0; // 累进惩罚计数器
    this._toolLoopBlockedNames = new Set(); // 被循环检测阻止的工具名
    this._metrics = {
      duplicateReadCount: 0, truncatedReadCount: 0, continuationReadCount: 0, peakTokenEstimate: 0,
      editMultipleMatchCount: 0, editNotFoundCount: 0, editInvalidJsonArgsCount: 0,
      qualityInterceptCount: 0, toolLoopEscalations: 0,
    };

    // 1.3: Trajectory recorder
    this._trajectory = new TrajectoryRecorder(null);

    // 2.2: Context budget tracker
    this._budgetUsage = 0;
    this._budgetMax = (config.maxTokenBudget || 128000) - (config.responseTokenReserve || 4096);
  }

  /**
   * 注册事件监听器（供 RuntimeMonitor 等外部模块使用）
   */
  on(event, handler) {
    if (!this._listeners) this._listeners = new Map();
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(handler);
  }

  setEmitter(emitter) {
    this.emitter = emitter;
  }

  _emit(event, data) {
    const payload = { sessionId: this.sessionId, iteration: this.iteration, state: this.state, ...data };
    if (this.emitter) {
      this.emitter(event, payload);
    }
    // 通知事件监听器
    if (this._listeners?.has(event)) {
      for (const handler of this._listeners.get(event)) {
        try { handler(payload); } catch (_) { }
      }
    }
    this._touchHeartbeat();
  }

  // --- Layer 1: Idle Heartbeat ---
  _startHeartbeat(phase, detail) {
    this._stopHeartbeat();
    this._heartbeatPhase = phase;
    this._heartbeatStart = Date.now();
    this._lastActivityTs = Date.now();
    this._heartbeatTimer = setInterval(() => {
      if (Date.now() - this._lastActivityTs >= 3000) {
        const elapsed = Math.round((Date.now() - this._heartbeatStart) / 1000);
        this._emit('progress-note', {
          text: `${this._heartbeatPhase} · ${detail} (${elapsed}s)`,
          isHeartbeat: true,
          sessionId: this.sessionId,
        });
      }
    }, 3000);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _touchHeartbeat() {
    this._lastActivityTs = Date.now();
  }

  _setState(newState) {
    const oldState = this.state;
    this.state = newState;
    this._emit('state-change', { from: oldState, to: newState });
    const label = STATE_LABELS[newState];
    if (label) {
      this._emit('progress-note', { text: label });
    }
  }

  async start({ sessionId, modelId, userMessage, projectPath, mode = 'agent', openFiles = [], autoApprove = false, webSearchEnabled = false, evalPassScore, compressThreshold, autoAgent = false }) {
    this.sessionId = sessionId;
    this.tracer = new AgentTracer(sessionId);
    this.abortController = new AbortController();
    this.iteration = 0;
    this.toolCallCount = 0;
    this._gateRetries = 0;
    this._noToolRetries = 0;
    this._autoAskFired = false;
    this._forceToolRequired = false;
    this._truncationRetries = 0;
    this._llmConsecutiveErrors = 0;
    this._sessionStartTime = null;
    this._routeFailedLastRound = false;
    this._autoLintRanThisRound = false;
    this._editFailCounts = new Map();
    this._stallCount = 0;
    this._consecutiveNoToolRounds = 0;
    this._lastNoToolContent = '';
    this._qualityRetries = 0;
    this._lintCheckPending = false;
    this._modifiedFiles = new Set();
    this._recentToolCalls = [];
    this._toolResultCache = new Map();
    this._successfulEdits = new Map();
    this._webFetchBlockedHints = new Set();
    this._fileReadCounts = new Map();
    this._toolLoopCount = 0;
    this._toolLoopBlockedNames = new Set();
    this._toolLoopBlockedAt = 0;
    this._totalRetries = 0;
    this._noToolResetCount = 0;
    this.readCoverage.clear();
    this._metrics = {
      duplicateReadCount: 0, truncatedReadCount: 0, continuationReadCount: 0, peakTokenEstimate: 0,
      editMultipleMatchCount: 0, editNotFoundCount: 0, editInvalidJsonArgsCount: 0,
      qualityInterceptCount: 0, toolLoopEscalations: 0, duplicateToolSuppressCount: 0,
    };
    this._matchedSkillNames = null;
    this._usedSkills = null;
    this._firstTokenReceived = false;
    this._toolCallsDetected = false;
    this._streamBuffer = '';
    this._lastFlushTime = 0;
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    this.modelId = modelId;
    this.projectPath = projectPath;
    // 初始化异常日志器
    this.anomalyLogger = getAnomalyLogger();
    this.anomalyLogger.init(sessionId, projectPath);
    this._currentMode = mode || 'agent';
    this._openFiles = Array.isArray(openFiles) ? openFiles : [];
    this.autoApprove = autoApprove;
    this.webSearchEnabled = webSearchEnabled;

    // YOLO 模式初始化
    if (this.config.yoloMode) {
      const { setYoloMode } = require('./security-layer');
      setYoloMode(true, this.config.yoloAllowlist);
    }

    // Linter 自动反馈循环计数器
    this._lintAutoFixCount = 0;
    this._lintNoProgressCount = 0;
    this._lastLintErrorCount = undefined;
    this.evalPassScore = typeof evalPassScore === 'number' ? evalPassScore : (this.config.evalPassScore || 75);
    this.compressThresholdPct = typeof compressThreshold === 'number' ? compressThreshold : (this.config.compressThreshold || 60);

    // Auto Agent 模式状态
    this.autoAgent = autoAgent;
    this._autoAgentComplexity = null; // 首轮判断后设置: 'complex'|'medium'|'simple'
    this._autoAgentRoutedModelId = null; // 路由后的模型 ID

    const span = this.tracer.startSpan('agent-loop');

    try {
      this._setState(STATES.PLANNING);

      const systemPrompt = await this._buildSystemPrompt(this._currentMode, { emitSkillEvent: true });

      this.messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ];

      // --- Workflow matching ---
      this._activeWorkflow = null;
      this._workflowStepStatus = [];
      try {
        const matched = await this._matchWorkflow(userMessage);
        if (matched && matched.steps && matched.steps.length > 0) {
          this._activeWorkflow = matched;
          this._workflowStepStatus = this._flattenSteps(matched.steps).map(s => ({
            id: s.id, title: s.title, depth: s.depth, status: 'pending'
          }));

          const stepsText = this._formatWorkflowSteps(matched.steps);
          this.messages.push({
            role: 'system',
            content: `[Workflow matched] "${matched.name}"\nPlease execute the following steps in order:\n\n${stepsText}\n\nExecution rules:\n- Complete steps in sequence\n- Briefly report after each step, then continue\n- Use tools as needed to make progress\n- Self-check before final conclusion`,
          });

          // Start first workflow step
          if (this._workflowStepStatus.length > 0) {
            this._workflowStepStatus[0].status = 'in_progress';
          }

          this._emit('workflow-matched', {
            workflowId: matched.id,
            name: matched.name,
            steps: this._workflowStepStatus,
          });
        }
      } catch (e) {
        this.tracer?.warn('Workflow match failed: ' + e.message);
      }

      this._emit('started', { userMessage });

      await this._loop();

      span.end({ iterations: this.iteration, toolCalls: this.toolCallCount });

      // P1: emit/persist runtime metrics
      this._updatePeakTokenEstimate();
      this._emit('agent-metrics', { sessionId: this.sessionId, ...this._metrics });

      if (this.state === STATES.CANCELLED) {
        return { success: false, error: 'Agent cancelled', iteration: this.iteration };
      }
      if (this.state === STATES.INCOMPLETE) {
        const todoStore = this.config.todoStore;
        const pendingTodos = todoStore ? todoStore.get().filter(t => t.status === 'pending' || t.status === 'in_progress') : [];
        return { success: false, code: 'E_INCOMPLETE', pendingTodos, iteration: this.iteration, finalContent: this._getLastAssistantContent() };
      }
      return { success: true, iteration: this.iteration, toolCallCount: this.toolCallCount, finalContent: this._getLastAssistantContent() };

    } catch (err) {
      span.end({ error: err.message });
      this._finalizeRun(STATES.FAILED);
      if (!this.abortController?.signal?.aborted && this.state !== STATES.CANCELLED) {
        this._setState(STATES.FAILED);
        this._emit('error', { error: err.message });
      }
      return { success: false, error: err.message, iteration: this.iteration };
    }
  }

  // Resolve tool_choice based on current state
  _resolveToolChoice() {
    if (this._forceToolRequired) {
      this._forceToolRequired = false;
      return 'required';
    }
    return 'auto';
  }

  async _loop() {
    this._sessionStartTime = this._sessionStartTime || Date.now();
    this._productiveIterations = 0;
    const retryHardCap = this.config.maxIterations * 2; // Safety: prevent infinite retry loops
    // Bug #1 fix: 全局非生产性重试上限，防止多层重试互相喂食形成雪球循环
    const retryLimit = Math.max(8, Math.floor(this.config.maxIterations * 0.5));
    let loopExitCause = null;

    // 分类重试计数器（仅用于可观测性，不改变循环终止逻辑）
    const retryBreakdown = {
      truncation: 0,
      quality: 0,
      stall: 0,
      noTool: 0,
      gate: 0,
      llmError: 0,
    };

    while (this._productiveIterations < this.config.maxIterations && this.iteration < retryHardCap) {
      // Bug #1 fix: 全局重试上限检查
      if (this._totalRetries >= retryLimit) {
        this.tracer?.warn(`Global retry limit reached (${this._totalRetries}/${retryLimit})`);
        this._emit('progress-note', { text: `⚠️ 非生产性重试已达上限(${retryLimit})，终止循环` });
        loopExitCause = 'retry_limit';
        break;
      }
      if (this.abortController.signal.aborted) {
        this._finalizeRun(STATES.CANCELLED);
        this._setState(STATES.CANCELLED);
        return;
      }

      // Guardrail: sessionTTL — hard limit on total session runtime
      const sessionTTL = this.config.guardrails?.sessionTTL || 3600000;
      if (Date.now() - this._sessionStartTime > sessionTTL) {
        this.tracer?.warn(`Guardrail: session TTL exceeded (${sessionTTL}ms)`);
        this._emit('progress-note', { text: `Session time limit reached (${Math.round(sessionTTL / 60000)}min), finalizing...` });
        loopExitCause = 'session_ttl';
        break; // Fall through to max-iterations final conclusion logic
      }

      this.iteration++;
      this.tracer.info(`Iteration ${this.iteration} start`);
      this._startHeartbeat('Thinking', `Iteration ${this.iteration}`);

      // Emit periodic progress updates
      if (this.iteration === 1 || this.iteration % 5 === 0) {
        const todoStore = this.config.todoStore;
        if (todoStore) {
          const p = todoStore.getProgress();
          if (p.total > 0 && this.iteration > 1) {
            this._emit('progress-note', { text: `Iteration ${this.iteration} — ${p.completed}/${p.total} tasks done` });
          }
        }
      }

      this._setState(STATES.CALLING_LLM);
      this._compressContextIfNeeded();

      const toolChoice = this._resolveToolChoice();
      let llmResult;
      console.log(`[AgentLoop] Iteration ${this.iteration}: calling LLM (toolChoice=${toolChoice}, msgs=${this.messages.length}, lastRole=${this.messages[this.messages.length - 1]?.role})`);
      try {
        llmResult = await this._callLLM(toolChoice);
      } catch (llmErr) {
        this._stopHeartbeat();
        // LLM call failed — check if aborted
        if (this.abortController.signal.aborted) {
          this._finalizeRun(STATES.CANCELLED);
          this._setState(STATES.CANCELLED);
          return;
        }
        // Transient LLM error: log and retry with exponential backoff
        this._llmConsecutiveErrors = (this._llmConsecutiveErrors || 0) + 1;
        retryBreakdown.llmError++;

        // 503/429/stream timeout 均属于可恢复的瞬时错误，允许更多重试
        const isRecoverableError = /503|429|token pool|rate.?limit|stream timeout|ECONNRESET|ETIMEDOUT|fetch failed/i.test(llmErr.message);
        const maxRetries = isRecoverableError ? 5 : 3;

        this.tracer?.warn(`LLM call failed (${this._llmConsecutiveErrors}/${maxRetries}): ${llmErr.message}`);
        if (this._llmConsecutiveErrors >= maxRetries) {
          // 降级策略：如果已有部分生成内容，返回已有内容而非终止
          if (this._lastPartialContent && this._lastPartialContent.length > 50) {
            this._emit('progress-note', { text: `⚠️ LLM retries exhausted but partial content available, continuing with partial result.` });
            this._llmConsecutiveErrors = 0;
            llmResult = { content: this._lastPartialContent, reasoning: '', toolCalls: null, truncated: true, interrupted: true };
            this._lastPartialContent = '';
            // Skip the throw, proceed with partial content
          } else {
            this._emit('progress-note', { text: `⚠️ LLM error retries exhausted (${maxRetries})` });
            this.anomalyLogger.llmError(llmErr.message, this._llmConsecutiveErrors, maxRetries, false, { iteration: this.iteration });
            throw llmErr; // Propagate to start() catch
          }
        } else {
          // 指数退避: 2s, 4s, 8s, 16s, 32s (capped)
          const backoffMs = Math.min(2000 * Math.pow(2, this._llmConsecutiveErrors - 1), 32000);
          this._emit('progress-note', {
            text: `LLM call failed: ${llmErr.message}. Retrying (${this._llmConsecutiveErrors}/${maxRetries}) in ${backoffMs / 1000}s...`,
          });
          this.anomalyLogger.llmError(llmErr.message, this._llmConsecutiveErrors, maxRetries, false, { iteration: this.iteration, backoffMs });
          await new Promise(r => setTimeout(r, backoffMs));

          // Push error context so the next call has awareness
          this.messages.push({
            role: 'system',
            content: `Previous LLM call failed with error: ${llmErr.message}. Retrying.`,
          });
          this._totalRetries++;
          continue;
        }
      }
      this._llmConsecutiveErrors = 0; // Reset on success

      // === Skill 使用检测：解析 <skill_used name="..."> 标记 ===
      if (this._matchedSkillNames && this._matchedSkillNames.size > 0 && llmResult.content) {
        const skillUsedRegex = /<skill_used\s+name="([^"]+)"\s*\/?>/gi;
        let skillMatch;
        while ((skillMatch = skillUsedRegex.exec(llmResult.content)) !== null) {
          const usedName = skillMatch[1];
          if (this._matchedSkillNames.has(usedName) && !this._usedSkills.has(usedName)) {
            this._usedSkills.add(usedName);
            this._emit('skill-used', { name: usedName });
            console.log(`[AgentLoop] Skill used: "${usedName}"`);
          }
        }
        // 清理协议标签，避免污染用户可见内容
        llmResult.content = llmResult.content.replace(/<skill_used\s+name="[^"]*"\s*\/?>/gi, '').trim();
      }

      if (!llmResult.toolCalls || llmResult.toolCalls.length === 0) {
        // === 截断/中断续传 ===
        if ((llmResult.truncated || llmResult.interrupted) && this._truncationRetries < 3) {
          this._truncationRetries++;
          const reason = llmResult.truncated ? 'finish_reason=length' : 'stream interrupted';
          this._emit('progress-note', {
            text: `输出被截断 (${reason})，续传中 (${this._truncationRetries}/3)...`,
          });
          if (llmResult.content) {
            this.messages.push({ role: 'assistant', content: llmResult.content });
          }
          // 续传提示：用 llmResult.model（实际执行模型名）判定，避免路由场景误判
          let supportsTools = true;
          try {
            const actualModelName = llmResult.model;
            if (actualModelName) {
              const adapter = require('./model-adapters').getAdapter(actualModelName);
              supportsTools = adapter.supportsToolCalls
                ? adapter.supportsToolCalls(actualModelName)
                : true;
            }
          } catch (_) { /* 回退为 true */ }
          const continueHint = supportsTools
            ? 'Continue from where you left off. Do not repeat what you already said.'
            : 'Continue from where you left off. If you need to call tools, output them in XML format. Do not repeat what you already said.';
          this.messages.push({ role: 'user', content: continueHint });
          retryBreakdown.truncation++;
          this._totalRetries++;
          if (retryBreakdown.truncation === 3) this._emit('progress-note', { text: '⚠️ Truncation retries exhausted (3)' });
          continue;
        }
        this._truncationRetries = 0; // 正常响应时重置
        this._consecutiveNoToolRounds++;

        // --- Quality Interceptor: block lazy phrases before displaying to user ---
        if (llmResult.content) {
          const qualityCheck = AgentLoopController.checkResponseQuality(llmResult.content);
          if (!qualityCheck.pass && this._qualityRetries < 2) {
            this._qualityRetries++;
            this._metrics.qualityInterceptCount = (this._metrics.qualityInterceptCount || 0) + 1;
            this.tracer?.warn(`Quality interceptor triggered (retry ${this._qualityRetries}/2): matched [${qualityCheck.matched.join(', ')}]`);
            this._emit('progress-note', {
              text: `Quality check failed: detected lazy phrase(s) [${qualityCheck.matched.join(', ')}], regenerating...`,
            });
            // Include rejected content as reference so LLM knows what to avoid
            const rejectedSnippet = llmResult.content.length > 500
              ? llmResult.content.substring(0, 500) + '...(truncated)'
              : llmResult.content;
            this.messages.push({
              role: 'system',
              content: `Your previous response contained prohibited lazy phrases: [${qualityCheck.matched.join(', ')}]. This violates the quality mandate.\n\nRejected response (for reference — do NOT repeat this):\n---\n${rejectedSnippet}\n---\n\nRegenerate a complete, production-grade response without omitting any implementation details.`,
            });
            this._forceToolRequired = false;
            retryBreakdown.quality++;
            this._totalRetries++;
            if (retryBreakdown.quality === 2) this._emit('progress-note', { text: '⚠️ Quality retries exhausted (2)' });
            continue; // re-enter loop to call LLM again
          }
          // If quality retries exhausted (2 attempts) and still failing, strip lazy phrases before passing
          if (!qualityCheck.pass) {
            let cleaned = llmResult.content;
            for (const phrase of qualityCheck.matched) {
              // Remove the phrase and surrounding sentence if it's a standalone fragment
              const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              cleaned = cleaned.replace(new RegExp(`[^。.\\n]*${escaped}[^。.\\n]*[。.\\n]?`, 'gi'), '');
            }
            cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
            this._emit('progress-note', {
              text: `⚠️ Quality: ${qualityCheck.matched.length} lazy phrase(s) stripped after max retries`,
            });
            // If stripping emptied the response, use a safe generic message — never fall back to original
            llmResult.content = cleaned || '（原始回复因包含违规措辞已被拦截，请重新提问以获取完整实现。）';
          }
          this._qualityRetries = 0; // reset for next iteration
          this.messages.push({ role: 'assistant', content: llmResult.content });
        } else {
          // Empty content with no tool calls — push placeholder to maintain message protocol consistency
          this.messages.push({ role: 'assistant', content: llmResult.content || '' });
        }

        // Stall detection: consecutive text-only rounds with similar content → inject nudge
        // --- Echo detection: if LLM simply echoes injected prompt text, do NOT show to user ---
        const ECHO_PHRASES = [
          'Please follow the latest system instructions',
          'Please continue from your previous response',
          'Please continue with the task',
        ];
        const contentTrimmed = (llmResult.content || '').trim();
        // Bug #3 fix: 排除 [AUTO-CONTINUE] 占位符，避免 sanitize→echo→stall 恶性循环
        const isAutoContPlaceholder = contentTrimmed.startsWith('[AUTO-CONTINUE]');
        const isEchoOutput = !isAutoContPlaceholder && ECHO_PHRASES.some(p => contentTrimmed.startsWith(p));
        if (isEchoOutput) {
          // Pop the echoed assistant message — it's not useful to the user
          const lastMsg = this.messages[this.messages.length - 1];
          if (lastMsg?.role === 'assistant') this.messages.pop();
          this._stallCount++;
          this.tracer?.warn(`Echo output detected (stall ${this._stallCount}): "${contentTrimmed.substring(0, 60)}"`);
        }

        const cur = (llmResult.content || '').substring(0, 200);
        const prev = this._lastNoToolContent;
        if (!isEchoOutput && !isAutoContPlaceholder) {
          if (prev && cur && cur.startsWith(prev.substring(0, 100))) {
            this._stallCount++;
          } else {
            this._stallCount = 0;
          }
        }
        this._lastNoToolContent = cur;
        // Gemini models stall more easily, use lower threshold
        const stallThreshold = this._isGemini() ? 1 : 2;
        // 修复5: finish_reason=stop 且有实质内容 → 尊重模型的停止决定，不进入 stall 路径
        if (this._modelWantsToStop && contentTrimmed.length > 100) {
          this._modelWantsToStop = false;
          // 不进入 stall 路径，直接走正常完成流程
        } else if (this._stallCount >= stallThreshold) {
          retryBreakdown.stall++;
          this._totalRetries++;

          // Bug #2 fix: 硬性中断直接用 retryBreakdown.stall 判断，不依赖被重置的 _stallCount
          if (retryBreakdown.stall >= 3) {
            this.tracer?.warn(`Stall hard-break: ${retryBreakdown.stall} consecutive stalls, terminating loop`);
            this.anomalyLogger.stall(retryBreakdown.stall, llmResult.content, { iteration: this.iteration, action: 'hard_break' });
            this._emit('progress-note', { text: '⚠️ 模型持续重复输出，已强制停止' });
            break; // 直接跳出循环，由 start() 处理终态
          }

          this._emit('progress-note', { text: `检测到文本停滞 (${retryBreakdown.stall}/3)，尝试强制工具调用...` });
          this.anomalyLogger.stall(retryBreakdown.stall, llmResult.content, { iteration: this.iteration });
          const lastMsg = this.messages[this.messages.length - 1];
          if (lastMsg?.role === 'assistant' && !lastMsg.tool_calls) this.messages.pop();
          this.messages.push({
            role: 'system',
            content: 'You repeated similar text without using tools. Use tools now to continue the task; do not conclude yet.',
          });
          this._forceToolRequired = true;
          // Bug #2 fix: 不重置 _stallCount，让它持续累积以加速硬性中断触发
          continue;
        }
        // 修复5: finish_reason=stop 检查放在 stall 段之后（上面已处理）

        const todoStore = this.config.todoStore;
        const progress = todoStore ? todoStore.getProgress() : { pending: 0, inProgress: 0, total: 0, completed: 0 };
        const remaining = progress.pending + progress.inProgress;
        const hasPendingTodos = remaining > 0;

        // Never allow premature completion when todos remain.
        // 修复5: 但如果模型主动 stop 且内容充实，允许进入 gate 而非无限重试
        if (hasPendingTodos && !(this._modelWantsToStop && contentTrimmed.length > 200)) {
          this._noToolRetries++;

          // 检测 LLM 是否在请求用户提供信息（复用 ask_question 通道暂停）
          // _autoAskFired 防止同一轮循环重复弹框
          if (this._noToolRetries > 2 && !this._autoAskFired && this._detectUserInputRequest(llmResult.content)) {
            // 不 pop assistant 消息——它是给用户看的合法交互
            const syntheticId = `auto-ask-${this.iteration}`;
            this._setState(STATES.AWAITING_APPROVAL);
            this._emit('progress-note', { text: '⏳ 检测到需要用户输入，暂停等待中...' });
            this._emit('ask-question', {
              toolCallId: syntheticId,
              title: '等待用户输入',
              questions: [{ id: 'user_input', label: llmResult.content, type: 'text' }],
              isAutoDetected: true,
            });

            const answers = await this._waitForQuestionResponse(syntheticId);
            if (answers && answers.user_input) {
              // 用户提供了输入 → 注入消息，重置计数器继续
              this.messages.push({ role: 'user', content: answers.user_input });
              this._noToolRetries = 0;
              this._stallCount = 0;
              this._gateRetries = 0;
              this._autoAskFired = false;
              this._setState(STATES.CALLING_LLM);
              continue;
            }
            // 用户未回答（超时/取消）→ 标记已尝试，fall through 到正常 noTool 路径
            this._autoAskFired = true;
            this._setState(STATES.CALLING_LLM);
            // 不 continue，让下方正常 noTool 重试逻辑处理
          }

          // Remove pure-text assistant reply (likely a premature conclusion) to keep context clean
          const lastMsg = this.messages[this.messages.length - 1];
          if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.tool_calls) {
            this.messages.pop();
          }

          const pendingItems = todoStore.get()
            .filter(t => t.status === 'pending' || t.status === 'in_progress')
            .slice(0, 5)
            .map(t => `- ${t.content}`)
            .join('\n');

          if (this._noToolRetries <= 3) {
            this._emit('progress-note', {
              text: `Still ${remaining} todo item(s) pending, retry with tool_choice=required (${this._noToolRetries}/3)`,
            });
            this.messages.push({
              role: 'system',
              content: `Task is not complete. Pending items:\n${pendingItems}\n\nUse tools now to continue execution. Do not output a final conclusion yet.`,
            });
            this._forceToolRequired = true;
          } else if (this._noToolRetries <= 6) {
            // Escalate guidance when retries are still failing.
            this._emit('progress-note', {
              text: `Forced retry #${this._noToolRetries}, remaining ${remaining} todo item(s)`,
            });
            this.messages.push({
              role: 'system',
              content: `You skipped tool usage multiple times. Re-assess these pending items and start one immediately:\n${pendingItems}\n\nIf the previous approach failed, switch strategy. You must call tools to make progress.`,
            });
            this._forceToolRequired = true;
          } else {
            // Over 6 retries still no progress, fall through to gate check (don't COMPLETE directly)
            this._emit('progress-note', {
              text: `Tool retries exhausted (${this._noToolRetries}), entering gate check`,
            });
            // Don't continue; let it fall through to gate logic below
          }

          if (this._noToolRetries <= 6) {
            retryBreakdown.noTool++;
            this._totalRetries++;
            if (retryBreakdown.noTool === 6) this._emit('progress-note', { text: '⚠️ No-tool retries exhausted (6)' });
            continue;
          }
        }

        // 最低工作量检查：如果 _productiveIterations === 0 且已执行过探索工具，
        // 说明 Agent 仅做了 list_dir/read_file 等就想结束——强制继续深入
        this._prematureCompleteRetries = this._prematureCompleteRetries || 0;
        if (hasPendingTodos && this._productiveIterations === 0 && this.iteration > 1 && this._prematureCompleteRetries < 3) {
          this._prematureCompleteRetries++;
          this._emit('progress-note', {
            text: `Agent 尚未完成实质工作 (productive=0)，要求继续分析 (${this._prematureCompleteRetries}/3)`,
          });
          // 撤回过早结论
          const lastMsg = this.messages[this.messages.length - 1];
          if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.tool_calls) {
            this.messages.pop();
          }
          this.messages.push({
            role: 'system',
            content: 'You have not done enough work yet. You only listed files or did minimal reading. You MUST:\n1. Use read_file to examine specific source files in detail.\n2. Use grep_search to find potential issues.\n3. Perform thorough analysis before concluding.\nDo NOT output a final answer yet. Use tools to investigate deeper.',
          });
          this._forceToolRequired = true;
          retryBreakdown.noTool = (retryBreakdown.noTool || 0) + 1;
          this._totalRetries++;
          continue;
        }

        // Completion gate checks before allowing final answer.
        const gate = this._checkCompletionGate();
        if (!gate.pass) {
          this._gateRetries++;

          // Remove possible premature conclusion
          const lastMsg = this.messages[this.messages.length - 1];
          if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.tool_calls) {
            this.messages.pop();
          }

          if (this._gateRetries <= this._maxGateRetries) {
            this._emit('progress-note', {
              text: `Gate check failed (${this._gateRetries}/${this._maxGateRetries}): ${gate.reasons.length} issue(s)`,
            });
            this.messages.push({
              role: 'system',
              content: `Gate failed. Issues to fix:\n${gate.reasons.map(r => `- ${r}`).join('\n')}\n\nUse tools to fix them. If one approach fails, switch strategy.`,
            });
            // Bug #5 fix: 限制 gate→noTool 重置次数，防止无限弹球循环
            this._noToolResetCount = (this._noToolResetCount || 0) + 1;
            if (this._noToolResetCount <= 2) {
              this._noToolRetries = 0;
            }
            this._forceToolRequired = true;
            retryBreakdown.gate++;
            this._totalRetries++;
            if (retryBreakdown.gate === this._maxGateRetries) this._emit('progress-note', { text: `⚠️ Gate retries exhausted (${this._maxGateRetries})` });
            continue;
          }

          // Gate retries exhausted: mark incomplete and exit.
          this._emit('progress-note', {
            text: `Finalizing - gate retries exhausted (${this._maxGateRetries})`,
          });
          this.messages.push({
            role: 'system',
            content: `After repeated attempts, unresolved issues remain: ${gate.reasons.join('; ')}. Provide a final summary of what was accomplished and what remains unresolved.`,
          });
          this._finalizeRun(STATES.INCOMPLETE);
          this._setState(STATES.INCOMPLETE);
          this._emit('incomplete', {
            content: llmResult.content,
            iterations: this.iteration,
            productiveIterations: this._productiveIterations,
            reasons: gate.reasons,
            retryBreakdown,
            _metrics: { ...this._metrics },
          });
          return; // CRITICAL: must return to prevent falling through to COMPLETE
        }

        // Gate passed and no pending todos → normal completion
        this._productiveIterations++;
        this._autoAskFired = false; // 真实工作产出后允许新场景再次弹框
        this._finalizeRun(STATES.COMPLETE);
        this._setState(STATES.COMPLETE);
        this._emit('complete', {
          content: llmResult.content,
          iterations: this.iteration,
          productiveIterations: this._productiveIterations,
          retryBreakdown,
          _metrics: { ...this._metrics },
        });
        return;
      }

      // Model returned tool calls — preserve reasoning traces (Codex models rely on continuity)
      const assistantMsg = {
        role: 'assistant',
        content: llmResult.content || null,
        tool_calls: llmResult.toolCalls,
      };
      if (llmResult.reasoning) {
        assistantMsg._reasoning = llmResult.reasoning;
      }
      this.messages.push(assistantMsg);
      this._emit('tool-calls-received', {
        toolCalls: llmResult.toolCalls,
        cleanedContent: llmResult.content || '',
      });

      // Bug #4 fix: 定期清除工具封禁列表，防止永久封禁
      if (this._toolLoopBlockedNames.size > 0 && this._productiveIterations > (this._toolLoopBlockedAt || 0) + 2) {
        this._toolLoopBlockedNames.clear();
        this._toolLoopCount = 0;
      }

      this._setState(STATES.EXECUTING_TOOLS);
      console.log(`[AgentLoop] Iteration ${this.iteration}: executing ${llmResult.toolCalls.length} tool(s): ${llmResult.toolCalls.map(t => t.function?.name).join(', ')}`);
      const toolResults = await this._executeTools(llmResult.toolCalls);
      console.log(`[AgentLoop] Iteration ${this.iteration}: tools done, ${toolResults.length} result(s), appending to messages`);

      for (const result of toolResults) {
        let content = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);

        // === read_file special handling ===
        if (result.toolName === 'read_file' && result.output?.success) {
          const out = result.output;

          // Only record actual reads. Short-circuit payload is cache replay.
          if (!out.shortCircuited && out.totalLines && out.startLine && out.endLine) {
            this.readCoverage.recordRead(out._filePath || '', {
              mtimeMs: out.mtimeMs,
              size: out.size,
              totalLines: out.totalLines,
              startLine: out.startLine,
              endLine: out.endLine,
              content: out.content,
            });
          }

          if (out.truncated === true) {
            this._metrics.truncatedReadCount++;
            if (out.note) {
              content += `\n\n${out.note}`;
            }
          }

          if (out.startLine > 1) {
            this._metrics.continuationReadCount++;
          }
        } else if (content.length > 6000) { // [Optimize: Token Saving] 截断阈值从 15000 收紧到 6000
          // Non-read_file tool output safeguard.
          content = this._smartTruncate(content);
        }

        // === Write tools: invalidate read coverage ===
        if (['write_file', 'edit_file', 'create_file', 'delete_file'].includes(result.toolName) && result.output?.success) {
          const writePath = result.output?.path || result.output?.filePath || '';
          if (writePath) this.readCoverage.invalidate(writePath);
        }

        // P2: Track edit_file failures for observability
        if (result.toolName === 'edit_file' && result.output && !result.output.success) {
          if (result.output.code === 'E_MULTIPLE_MATCHES') this._metrics.editMultipleMatchCount++;
          else if (result.output.code === 'E_MATCH_NOT_FOUND') this._metrics.editNotFoundCount++;
        }

        this.messages.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content,
        });

        // If web_fetch is blocked by anti-bot/CAPTCHA, nudge model to continue with alternatives.
        if (result.toolName === 'web_fetch') {
          const url = result.args?.url || result.output?.url || '';
          const key = url || result.toolCallId;
          const signalText = `${result.output?.error || ''}\n${result.output?.content || ''}`;
          const blockedByBot = (result.output && result.output.success === false && result.output.code === 'E_BOT_BLOCKED')
            || /target url returned error\s*403|captcha|cloudflare|access denied|forbidden|just a moment/i.test(signalText);
          if (blockedByBot && !this._webFetchBlockedHints.has(key)) {
            this._webFetchBlockedHints.add(key);
            this.messages.push({
              role: 'system',
              content: `web_fetch was blocked for URL: ${url || '(unknown)'}. Do NOT stop the task. Continue by: (1) searching and fetching alternative sources/mirrors, (2) prioritizing accessible docs/pages, (3) if absolutely required, use browser_use for interactive access. Summarize blocked links briefly and keep making progress.`,
            });
          }
        }

        // Auto-inject correction when edit_file fails
        if (result.toolName === 'edit_file' && result.output && !result.output.success) {
          const editPath = result.args?.path || '';
          const failCount = (this._editFailCounts?.get(editPath) || 0) + 1;
          if (!this._editFailCounts) this._editFailCounts = new Map();
          this._editFailCounts.set(editPath, failCount);

          // Check if this exact edit was already applied successfully
          const editOldHash = this._simpleHash(result.args?.old_string || '');
          const editKey = `${editPath}:${editOldHash}`;
          const wasAlreadyApplied = this._successfulEdits.has(editKey);

          if (wasAlreadyApplied) {
            this.messages.push({
              role: 'system',
              content: `This edit on "${editPath}" was ALREADY APPLIED SUCCESSFULLY in a previous step. The old_string no longer exists because it was already replaced. Do NOT retry this edit. Move on to the next change or task.`,
            });
            this._editFailCounts.delete(editPath);
          } else if (failCount >= (this.config.guardrails?.maxEditRetriesPerFile || 3)) {
            this.messages.push({
              role: 'system',
              content: `edit_file has failed ${failCount} consecutive times on \"${editPath}\". STOP using edit_file for this file. Instead, use write_file to rewrite the entire file with your changes applied. This is more reliable.`,
            });
          } else if (failCount === 1) {
            // 首次失败：如果有 editableSnippet，直接提供精确代码供 AI 复制，免去 read_file
            const hasSnippet = result.output.editableSnippet;
            this.anomalyLogger.editFail(editPath, failCount, result.output.code || 'E_MATCH_NOT_FOUND', {
              iteration: this.iteration, hasSnippet: !!hasSnippet, errorHint: result.output.hint,
            });
            const recovery = hasSnippet
              ? `edit_file failed: old_string does not match actual file content.\n\n**Do NOT re-read the file.** The actual code around the target area is:\n\`\`\`\n${result.output.editableSnippet.substring(0, 1500)}\n\`\`\`\nCopy the EXACT lines you want to replace from above as your new old_string. Pay attention to indentation and whitespace.`
              : result.output.nearestContent
                ? `edit_file failed: old_string does not match. The nearest actual content is shown in nearestContent above. Copy the EXACT text from nearestContent as your new old_string. If the file is short (under 50 lines), consider using write_file to rewrite the entire file instead.`
                : `edit_file failed: old_string not found. Use read_file to re-read the target file. If you cannot match the exact text, use write_file to rewrite the entire file.`;
            this.messages.push({ role: 'system', content: recovery });
          } else if (failCount === 2) {
            this.messages.push({
              role: 'system',
              content: `edit_file failed again on "${editPath}" (attempt ${failCount}). 停止尝试 edit_file 的精准匹配！请立即改用 write_file 工具重写整个文件内容。这样更可靠且避免浪费 token 在盲猜缩进上。`,
            });
          }
        } else if (result.toolName === 'edit_file' && result.output?.success) {
          const editPath = result.args?.path || '';
          if (this._editFailCounts) this._editFailCounts.delete(editPath);
          // Track this successful edit so we can detect re-edit loops
          const editOldHash = this._simpleHash(result.args?.old_string || '');
          this._successfulEdits.set(`${editPath}:${editOldHash}`, true);
          // Reset read counter for this file so model can re-read the updated content
          const readKey = editPath.replace(/\\/g, '/');
          this._fileReadCounts.delete(readKey);
          // 刷新 ReadCoverageIndex 缓存，避免编辑后全文重读
          try {
            if (this.projectPath && this.readCoverage) {
              const fs = require('fs');
              const path = require('path');
              const fullPath = path.resolve(this.projectPath, editPath);
              if (fs.existsSync(fullPath)) {
                const stat = fs.statSync(fullPath);
                // 重置该文件的覆盖率，让 readCoverage 知道文件已变化
                this.readCoverage.invalidate?.(editPath);
              }
            }
          } catch (_) { }
        }

        // === run_terminal_cmd 失败处理：智能恢复引导 ===
        if (result.toolName === 'run_terminal_cmd' && !result.output?.success) {
          const code = result.output?.code || '';
          const stderr = (result.output?.stderr || '').substring(0, 500);
          if (code === 'E_CMD_TIMEOUT') {
            this.messages.push({
              role: 'system',
              content: `命令超时。请改用 is_background=true 在后台运行此命令，然后用 read_file 读取 terminal_file 获取输出。`,
            });
          } else if (code === 'E_CMD_FAILED') {
            let hint = '';
            if (/not recognized|not found|无法识别|is not recognized/i.test(stderr)) {
              hint = '该命令不存在或未安装。请检查命令名或先安装所需工具。';
            } else if (/permission denied|拒绝访问|Access is denied/i.test(stderr)) {
              hint = '权限不足。尝试用管理员权限或换一种方式。';
            } else if (/MODULE_NOT_FOUND|Cannot find module|No module named/i.test(stderr)) {
              hint = '缺少依赖模块。请先 npm install 或 pip install 安装依赖。';
            } else if (/ENOENT|No such file|找不到|系统找不到/i.test(stderr)) {
              hint = '文件或目录不存在。请检查路径是否正确。';
            }
            if (hint) {
              this.messages.push({ role: 'system', content: `run_terminal_cmd 失败：${hint}` });
              this.anomalyLogger.cmdFail(result.args?.command || '', code, stderr, { iteration: this.iteration, hint });
            }
          }
        }

        // === ask_question: emit to frontend and wait for user response ===
        if (result.toolName === 'ask_question' && result.output?.awaiting_response) {
          this._setState(STATES.AWAITING_APPROVAL);
          this._emit('ask-question', {
            toolCallId: result.toolCallId,
            title: result.output.title,
            questions: result.output.questions,
          });
          const answers = await this._waitForQuestionResponse(result.toolCallId);
          if (answers) {
            this.messages.push({
              role: 'system',
              content: `User answered the questions:\n${JSON.stringify(answers, null, 2)}\n\nProceed based on these answers.`,
            });
          }
          this._setState(STATES.EXECUTING_TOOLS);
        }

        // === switch_mode: end-to-end confirmation and hot mode switch ===
        if (result.toolName === 'switch_mode' && result.output?.awaiting_approval) {
          const targetMode = result.output.target_mode;
          this._setState(STATES.AWAITING_APPROVAL);
          this._emit('mode-switch-request', {
            toolCallId: result.toolCallId,
            target_mode: targetMode,
            explanation: result.output.explanation,
          });

          const approved = await this._waitForApproval(result.toolCallId);
          if (!approved) {
            this._emit('mode-switch-declined', {
              toolCallId: result.toolCallId,
              target_mode: targetMode,
            });
            this._setState(STATES.EXECUTING_TOOLS);
          } else {
            const switched = await this._applyModeSwitch(targetMode);
            if (switched?.ok) {
              this._emit('mode-switched', {
                toolCallId: result.toolCallId,
                from_mode: switched.from,
                to_mode: switched.to,
              });
            } else {
              this._emit('mode-switch-failed', {
                toolCallId: result.toolCallId,
                target_mode: targetMode,
                error: switched?.error || 'Unknown mode switch failure',
              });
            }
            this._setState(STATES.EXECUTING_TOOLS);
          }
        }
      }

      // Bug #8 fix: tools-executed 移到 for 循环外部，避免每个工具结果都 emit 一次
      // 修复3: 纯探索性工具不算有效产出——防止无限探索循环
      const EXPLORE_ONLY_TOOLS = new Set(['read_file', 'grep_search', 'file_search', 'list_dir', 'list_directory', 'search_files', 'glob_search', 'read_lints']);
      const hasActionTool = toolResults.some(r => !EXPLORE_ONLY_TOOLS.has(r.toolName));
      if (hasActionTool) {
        this._productiveIterations++;
        this._exploreOnlyRounds = 0;
      } else {
        this._exploreOnlyRounds = (this._exploreOnlyRounds || 0) + 1;
        if (this._exploreOnlyRounds >= 5) {
          this._emit('progress-note', { text: `⚠️ 连续 ${this._exploreOnlyRounds} 轮仅执行探索性工具，强制要求输出结论或执行修改` });
          this.messages.push({
            role: 'system',
            content: 'WARNING: You have read files for too many rounds without making any changes or providing output. Either:\n1. Output your final answer NOW with what you have learned.\n2. Start making actual edits/writes.\nDo NOT continue reading more files. Repeated file reading WITHOUT action is unacceptable.',
          });
          this._forceToolRequired = false;
        }
      }
      this._autoAskFired = false;
      this._noToolRetries = 0;
      this._noToolResetCount = 0;
      this._stallCount = 0;
      this._lastNoToolContent = '';
      this._consecutiveNoToolRounds = 0;
      this._modelWantsToStop = false;
      // 修复2: 有产出时部分重置（保留历史警觉度），不完全清零
      this._totalRetries = Math.max(0, this._totalRetries - 2);

      // 有实际新工具执行（非循环检测到的重复工具）→ 重置循环计数
      const hasNonBlockedTools = toolResults.some(r => !this._toolLoopBlockedNames.has(r.toolName));
      if (hasNonBlockedTools) {
        this._toolLoopCount = 0;
        this._toolLoopBlockedNames.clear();
      }

      // P0-3: Auto-lint after file edits (增强版：无进展提前停止 + 消息截断 + 全局上限)
      if (this._autoLintEnabled !== false && this._lintAutoFixCount < 5) {
        const editedFiles = toolResults
          .filter(r => ['edit_file', 'write_file', 'create_file'].includes(r.toolName) && r.output?.success)
          .map(r => r.output?.path || r.args?.path)
          .filter(Boolean);

        if (editedFiles.length > 0) {
          const filesToLint = [...new Set(editedFiles)].slice(0, 3);
          // 优先使用 linter-runner（独立引擎），回退到 read_lints 工具
          let lintErrors = [];
          try {
            const { getLinterErrors } = require('./linter-runner');
            const lintResult = await getLinterErrors(this.projectPath, filesToLint);
            lintErrors = (lintResult.diagnostics || []).filter(d => d.severity === 'error');
          } catch (_) {
            // 回退到 read_lints 工具
            const lintTool = this.tools.getTool('read_lints');
            if (lintTool) {
              try {
                const lintResult = await this.tools.execute('read_lints', { paths: filesToLint }, this.projectPath, {});
                if (lintResult?.success && lintResult.diagnostics) {
                  lintErrors = lintResult.diagnostics.filter(d => d.severity === 'error' || d.severity === 1);
                }
              } catch (__) { }
            }
          }

          if (lintErrors.length > 0) {
            // 无进展检测：连续 2 轮错误数未下降则停止自动修复
            if (this._lastLintErrorCount !== undefined
              && lintErrors.length >= this._lastLintErrorCount) {
              this._lintNoProgressCount = (this._lintNoProgressCount || 0) + 1;
            } else {
              this._lintNoProgressCount = 0;
            }
            this._lastLintErrorCount = lintErrors.length;

            if (this._lintNoProgressCount >= 2) {
              this._emit('progress-note', {
                text: `⚠️ Linter errors not decreasing (${lintErrors.length} for 2+ rounds), stopping auto-fix`,
              });
              this._lintAutoFixCount = 5; // 禁止后续自动修复
            } else {
              // 每条错误消息截断到 200 字符，防止 Token 爆炸
              const errorSummary = lintErrors.slice(0, 10).map(e => {
                const msg = (e.message || '').length > 200
                  ? e.message.substring(0, 200) + '...(truncated)'
                  : (e.message || '');
                return `  ${e.file || ''}:${e.line || '?'}:${e.column || '?'} [${e.source || 'lint'}] ${msg}`;
              }).join('\n');
              this.messages.push({
                role: 'system',
                content: `[AUTO-LINT] ${lintErrors.length} error(s) introduced by your recent edits. Fix them:\n${errorSummary}`,
              });
              this._emit('progress-note', { text: `🔍 Linter detected ${lintErrors.length} error(s) in edited files` });
              this._lintAutoFixCount++;
            }
          } else {
            // 错误全部修复，重置计数器
            this._lastLintErrorCount = undefined;
            this._lintNoProgressCount = 0;
          }

          this._lintCheckPending = false;
          this._autoLintRanThisRound = true;
        }
      }
      // Cursor-style batch summary for explored/edited files
      const EXPLORE_NAMES = new Set(['read_file', 'grep_search', 'file_search', 'list_dir', 'list_directory', 'search_files', 'glob_search', 'read_lints']);
      const exploredCount = llmResult.toolCalls.filter(tc => EXPLORE_NAMES.has(tc.function?.name)).length;
      const editedCount = llmResult.toolCalls.filter(tc => ['write_file', 'edit_file', 'create_file'].includes(tc.function?.name)).length;
      if (exploredCount > 2) {
        this._emit('progress-note', { text: `Explored ${exploredCount} files` });
      }
      if (editedCount > 1) {
        this._emit('progress-note', { text: `Edited ${editedCount} files` });
      }

      // Track file modifications for lint check readiness
      const FILE_CHANGE_TOOL_NAMES = ['write_file', 'edit_file', 'create_file', 'reapply'];
      let hasNewFileChanges = false;
      for (const tc of llmResult.toolCalls) {
        if (FILE_CHANGE_TOOL_NAMES.includes(tc.function?.name)) {
          try {
            const tcArgs = JSON.parse(tc.function.arguments || '{}');
            const changedFile = tcArgs.path || tcArgs.file_path || tcArgs.target_file;
            if (changedFile) {
              this._modifiedFiles.add(changedFile);
              hasNewFileChanges = true;
            }
          } catch (_) { }
        }
      }

      // If files changed without lint check, mark lint pending.
      // BUT skip if auto-lint already ran this round (it sets _lintCheckPending = false above)
      const hasLintCall = llmResult.toolCalls.some(tc => tc.function?.name === 'read_lints');
      if (hasNewFileChanges && !hasLintCall && !this._autoLintRanThisRound) {
        this._lintCheckPending = true;
      }
      if (hasLintCall) {
        this._lintCheckPending = false;
      }
      this._autoLintRanThisRound = false; // Reset for next round

      // Tool loop detection: track recent tool calls and detect repetitive patterns
      for (const tc of llmResult.toolCalls) {
        let semanticArgs = '';
        try {
          // Strip 'explanation' field before hashing - it varies per call but doesn't affect behavior
          const parsed = JSON.parse(tc.function?.arguments || '{}');
          delete parsed.explanation;
          semanticArgs = JSON.stringify(parsed);
        } catch (_) {
          semanticArgs = tc.function?.arguments || '';
        }
        this._recentToolCalls.push({
          name: tc.function?.name,
          argsHash: this._simpleHash(semanticArgs),
        });
      }
      if (this._recentToolCalls.length > 30) {
        this._recentToolCalls = this._recentToolCalls.slice(-30);
      }

      const loopDetected = this._detectToolLoop();
      if (loopDetected) {
        this._toolLoopCount++;
        this._toolLoopBlockedNames.add(loopDetected.toolName);
        this._toolLoopBlockedAt = this._productiveIterations; // Bug #4 fix: 记录封禁时间点
        this._metrics.toolLoopEscalations = (this._metrics.toolLoopEscalations || 0) + 1;

        // 修复4: 断路器从 3 轮降到 2 轮——更快终止死循环
        if (this._toolLoopCount >= 2) {
          // 第 2+ 次循环：强制终止循环行为，要求最终总结
          this._emit('progress-note', { text: `Tool loop persists (${this._toolLoopCount}x), forcing task conclusion.` });
          this.anomalyLogger.toolLoop(loopDetected.pattern, loopDetected.toolName, this._toolLoopCount, { iteration: this.iteration, action: 'force_stop' });
          this.messages.push({
            role: 'system',
            content: `CRITICAL: You have been stuck in a tool loop for ${this._toolLoopCount} rounds (${loopDetected.pattern}). STOP ALL tool calls immediately. Provide your final answer with what you have accomplished so far. Do NOT attempt any more tool calls.`,
          });
          this._forceToolRequired = false;
        } else {
          // 第 1 次循环：注入警告提示
          this._emit('progress-note', { text: `Tool loop detected: ${loopDetected.pattern}. Injecting guidance.` });
          this.messages.push({
            role: 'system',
            content: `WARNING: You are stuck in a loop - repeatedly calling ${loopDetected.pattern}. This is not making progress. STOP the repetitive calls and either:\n1. Move on to the next step using the information you already have.\n2. If you're stuck, explain what's blocking you.\n3. Use a DIFFERENT tool or approach to make progress.\nDo NOT call ${loopDetected.toolName} again for the same target.`,
          });
          this._forceToolRequired = false;
        }
      }

      // Auto-advance workflow steps
      this._tryAdvanceWorkflow(llmResult.content, toolResults);

      // Bug #8 fix: tools-executed 在所有工具结果处理完成后统一 emit
      this._emit('tools-executed', { results: toolResults });

      // === 动态 Skill 触发：执行过程中检测到需要未注入的 Skill ===
      this._dynamicSkillInject(llmResult, toolResults);

      this._setState(STATES.REFLECTING);
    }

    // Reached max iterations, force a final completion pass.
    const retryTopContributors = Object.entries(retryBreakdown)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(', ');
    let limitReason;
    if (loopExitCause === 'session_ttl') {
      const ttlMs = this.config.guardrails?.sessionTTL || 3600000;
      limitReason = `Session TTL reached (${Math.round(ttlMs / 60000)}min, iteration: ${this.iteration}, productive: ${this._productiveIterations})`;
    } else if (this._productiveIterations >= this.config.maxIterations) {
      limitReason = `Productive iterations exhausted (${this._productiveIterations}/${this.config.maxIterations})`;
    } else if (this.iteration >= retryHardCap) {
      limitReason = `Total rounds cap reached (${this.iteration}, productive: ${this._productiveIterations}, retries: ${retryTopContributors || 'none'})`;
    } else {
      limitReason = `Loop terminated early (iteration: ${this.iteration}, productive: ${this._productiveIterations})`;
    }
    this.tracer.warn(limitReason + ', requesting final conclusion');

    // Collect todo progress for the final conclusion prompt
    const todoStore = this.config.todoStore;
    let todoStatus = '';
    const pendingTodos = [];
    if (todoStore) {
      const todos = todoStore.get();
      const progress = todoStore.getProgress();
      if (progress.total > 0) {
        const completed = todos.filter(t => t.status === 'completed').map(t => `- ${t.content}`);
        const remaining = todos.filter(t => t.status !== 'completed');
        remaining.forEach(t => pendingTodos.push({ id: t.id, content: t.content, status: t.status }));
        const remainingText = remaining.map(t => `- ${t.content}`);
        todoStatus = `\n\nCompleted:\n${completed.join('\n') || '(none)'}\nRemaining:\n${remainingText.join('\n') || '(all done)'}`;
      }
    }

    this.messages.push({
      role: 'system',
      content: `${limitReason}. Output a final conclusion, detailing completed and incomplete work.${todoStatus}`,
    });
    this._setState(STATES.CALLING_LLM);
    let finalResult;
    try {
      finalResult = await this._callLLM('none');
    } catch (finalErr) {
      this._stopHeartbeat();
      this.tracer.warn('Final conclusion LLM call failed', { error: finalErr.message });
      finalResult = { content: `[Final conclusion could not be generated: ${finalErr.message}]`, toolCalls: [] };
    }

    if (finalResult.content) {
      this.messages.push({ role: 'assistant', content: finalResult.content });
    }

    // Final state: pending todos → INCOMPLETE, otherwise → COMPLETE
    if (pendingTodos.length > 0) {
      this._finalizeRun(STATES.INCOMPLETE);
      this._setState(STATES.INCOMPLETE);
      this._emit('incomplete', {
        code: 'E_INCOMPLETE',
        reasons: [limitReason],
        pendingTodos,
        maxIterationsReached: true,
        content: finalResult.content,
        iterations: this.iteration,
        productiveIterations: this._productiveIterations,
        retryBreakdown,
        _metrics: { ...this._metrics },
      });
    } else {
      this._finalizeRun(STATES.COMPLETE);
      this._setState(STATES.COMPLETE);
      this._emit('complete', {
        content: finalResult.content,
        iterations: this.iteration,
        productiveIterations: this._productiveIterations,
        maxIterationsReached: true,
        retryBreakdown,
        _metrics: { ...this._metrics },
      });
    }
  }

  // --- Tool Calls helpers ---

  // --- 消息序列规范化：消除连续 assistant，确保 user-last ---
  // 规则：
  // 1) 连续 assistant 且都无 tool_calls → 合并 content（\n\n 拼接）
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
            prev.content = prevContent + '\n\n' + curContent;
          } else {
            prev.content = prevContent || curContent || '';
          }
          this.tracer?.warn(`sanitize: merged consecutive assistant msgs at index ${i}`);
          continue; // 跳过当前，已合并到 prev
        } else {
          // 其中一条含 tool_calls → 将无 tool_calls 的那条转 user
          if (prevHasTC && !curHasTC) {
            // prev 有 tool_calls，但 prev 后面应该紧跟 tool 结果
            // 先检查 prev 后续是否有 tool 消息未到
            // 安全做法：将 cur 转为 user
            cur.role = 'user';
            cur.content = '[note] ' + (cur.content || '');
            this.tracer?.warn(`sanitize: converted assistant→user at index ${i} (prev has tool_calls)`);
          } else if (!prevHasTC && curHasTC) {
            // cur 有 tool_calls → 把 prev 转 user
            prev.role = 'user';
            prev.content = '[note] ' + (prev.content || '');
            this.tracer?.warn(`sanitize: converted assistant→user at index ${i - 1} (next has tool_calls)`);
          } else {
            // 都有 tool_calls（极端情况）→ 在中间插一条 user
            result.push({ role: 'user', content: 'Continue with the next step.' });
            this.tracer?.warn(`sanitize: inserted user between dual tool_calls assistants at index ${i}`);
          }
        }
      }
      result.push(cur);
    }

    // 确保最后一条是 user（但不破坏 assistant(tool_calls)→tool 协议对）
    if (result.length > 0) {
      const last = result[result.length - 1];
      // Bug #1 fix: 仅在明确被强制要求（_forceToolRequired）且最后不是 user/tool 时注入
      // 移除 result.some() 历史扫描，避免"工具模式锁死"——只要调用过一次工具就永远注入
      // 同时保护 tool 消息后不追加 user（防止 API 协议冲突：tool→user 会导致 HTTP 400）
      if (last.role !== 'user' && last.role !== 'tool') {
        const hasToolCalls = !!(last.tool_calls && last.tool_calls.length > 0);
        if (!hasToolCalls && this._forceToolRequired) {
          result.push({ role: 'user', content: '[AUTO-CONTINUE] Proceed with the next actionable step.' });
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
        if (result[i].role === 'assistant' && result[i - 1].role === 'assistant') {
          this.tracer?.warn(`sanitize: STILL consecutive assistant at index ${i} after cleanup!`);
        }
      }
    }

    return result;
  }

  // --- Context smart compression ---
  _compressContextIfNeeded() {
    this._updatePeakTokenEstimate();
    const budget = this.config.maxTokenBudget - this.config.responseTokenReserve;
    const result = this.contextEngine.compressIfNeeded(this.messages, {
      budget,
      thresholdPct: this.compressThresholdPct || 60,
      todoStore: this.config.todoStore,
    });

    if (result.compressed) {
      this.messages = result.messages;
      this._emit('progress-note', { text: `Summarized ${result.stats.removed} messages, kept ${result.stats.kept}` });
    }
  }

  _estimateTokenCount() {
    return this.contextEngine.estimateTokenCount(this.messages);
  }

  _updatePeakTokenEstimate() {
    const estimate = this.contextEngine
      ? this.contextEngine.estimateTokenCount(this.messages)
      : 0;
    this._metrics.peakTokenEstimate = Math.max(this._metrics.peakTokenEstimate || 0, estimate);
    return estimate;
  }

  // Smart truncation: JSON keeps valid structure, non-JSON keeps head/tail
  _smartTruncate(content, maxLen = 8000) {
    // Try JSON-aware truncation first
    try {
      const parsed = JSON.parse(content);
      const truncatedJson = this._truncateJsonValue(parsed, maxLen);
      if (truncatedJson) return truncatedJson;
    } catch (_) {
      // Not JSON, fall through to text truncation
    }
    // [Optimize: Token Saving] Non-JSON truncation: head 1500 + tail 1000
    const head = content.substring(0, 1500);
    const tail = content.substring(content.length - 1000);
    return head + '\n\n... [content too long, middle section truncated] ...\n\n' + tail;
  }

  _truncateJsonValue(value, maxLen) {
    const trySerialize = (v) => {
      try { return JSON.stringify(v); } catch (_) { return null; }
    };

    const shrink = (v, depth = 0) => {
      if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
      if (typeof v === 'string') {
        return v.length > 320 ? v.slice(0, 320) + '...(truncated)' : v;
      }
      if (Array.isArray(v)) {
        const maxItems = depth === 0 ? 20 : 10;
        return v.slice(0, maxItems).map(item => shrink(item, depth + 1));
      }
      if (typeof v === 'object') {
        const keys = Object.keys(v);
        const maxKeys = depth === 0 ? 30 : 10;
        const out = {};
        for (const key of keys.slice(0, maxKeys)) {
          out[key] = shrink(v[key], depth + 1);
        }
        if (keys.length > maxKeys) out.__truncated_keys = keys.length - maxKeys;
        return out;
      }
      return String(v);
    };

    let serialized = trySerialize(value);
    if (serialized && serialized.length <= maxLen) return serialized;

    serialized = trySerialize(shrink(value));
    if (serialized && serialized.length <= maxLen) return serialized;

    if (Array.isArray(value)) {
      for (let n = Math.min(value.length, 5); n >= 1; n--) {
        serialized = trySerialize(value.slice(0, n).map(item => shrink(item, 1)));
        if (serialized && serialized.length <= maxLen) return serialized;
      }
    } else if (value && typeof value === 'object') {
      const keys = Object.keys(value);
      for (let n = Math.min(keys.length, 5); n >= 1; n--) {
        const out = {};
        for (const key of keys.slice(0, n)) out[key] = shrink(value[key], 1);
        out.__truncated = true;
        serialized = trySerialize(out);
        if (serialized && serialized.length <= maxLen) return serialized;
      }
    }

    return JSON.stringify({ truncated: true, note: 'content too large' });
  }

  _flushStreamBuffer() {
    if (this._streamBuffer) {
      this._emit('stream-content', { content: this._streamBuffer, delta: true });
      this._streamBuffer = '';
    }
    this._lastFlushTime = Date.now();
    this._flushTimer = null;
  }

  async _callLLM(toolChoice = 'auto') {
    const span = this.tracer.startSpan('llm-call', { iteration: this.iteration, toolChoice });
    const activeMode = this._currentMode || 'agent';
    let toolDefs = this.tools.getDefinitions({ mode: activeMode, webSearchEnabled: this.webSearchEnabled });
    if (!Array.isArray(toolDefs)) toolDefs = this.tools.getDefinitions();
    if (!this.webSearchEnabled) {
      toolDefs = toolDefs.filter(t => t.name !== 'web_search' && t.name !== 'web_fetch');
    }

    const effectiveTools = toolDefs.length > 0 ? toolDefs : undefined;
    const effectiveToolChoice = effectiveTools ? toolChoice : undefined;

    // 智能路由：根据模式选择不同策略
    // 所有阈值走 guardrails 配置，用户可按需调整
    let effectiveModelId = this.modelId;
    const g = this.config.guardrails || {};
    const routeMinIterations = g.routeMinIterations ?? 4;
    const routeMinReadonly = g.routeMinConsecutiveReadonly ?? 3;
    const routeEnabled = g.routeEnabled !== false;

    // ─── Auto Agent 模式路由 ───
    if (this.autoAgent && !this._routeFailedLastRound) {
      try {
        const { classifyTaskComplexity, autoRouteModel } = require('./model-adapters');
        const models = this.llm.loadModels();

        if (this.iteration === 1 && !this._autoAgentComplexity) {
          // 首轮：用主选模型（中等+）判断任务复杂度
          // 同时通过关键词分析预判复杂度
          const userMsg = this.messages.find(m => m.role === 'user');
          const complexity = classifyTaskComplexity(userMsg?.content || '');
          this._autoAgentComplexity = complexity;

          // 根据复杂度路由
          const routed = autoRouteModel(models, this.modelId, complexity);
          if (routed) {
            this._autoAgentRoutedModelId = routed.id;
            effectiveModelId = routed.id;
            this._emit('progress-note', {
              text: `[Auto Agent] 任务复杂度: ${complexity} → ${routed.displayName || routed.modelName}`,
            });
          } else {
            this._emit('progress-note', {
              text: `[Auto Agent] 任务复杂度: ${complexity} → 使用主选模型`,
            });
          }
        } else if (this._autoAgentRoutedModelId) {
          // 后续轮次：继续使用路由后的模型
          effectiveModelId = this._autoAgentRoutedModelId;
        }
      } catch (_) { /* 回退到主选模型 */ }
    }
    // ─── 普通模式路由（仅只读分流） ───
    else if (routeEnabled
      && this.iteration >= routeMinIterations
      && toolChoice === 'auto'
      && !this._routeFailedLastRound) {
      try {
        const { routeModel, estimateRequiredTier } = require('./model-adapters');
        const recentNames = this._recentToolCalls.slice(-routeMinReadonly).map(r => r.name);
        const tier = (recentNames.length >= routeMinReadonly)
          ? estimateRequiredTier(recentNames)
          : 'medium';

        if (tier === 'light') {
          const models = this.llm.loadModels();
          const routed = routeModel(models, this.modelId, 'light');
          if (routed) {
            effectiveModelId = routed.id;
            this._emit('progress-note', {
              text: `[Route] 只读分流 → ${routed.displayName || routed.modelName}`,
            });
          }
        }
      } catch (_) { /* 回退到主选模型 */ }
    }
    // 重置回退标记（每轮清除，只有失败时才设置）
    this._routeFailedLastRound = false;

    return new Promise((resolve, reject) => {
      let result = { content: '', reasoning: '', toolCalls: null };
      let settled = false;

      // Chunk timeout: 首次等待更久（模型思考需要时间），收到首 chunk 后缩短
      const initialTimeoutMs = this.config.guardrails?.chunkTimeoutMs || 90000; // 首 chunk 180 秒
      const subsequentTimeoutMs = this.config.guardrails?.chunkIdleAfterFirstMs || 60000; // 后续 chunk 90 秒
      let firstChunkReceived = false;
      let chunkTimer = null;
      const resetChunkTimer = () => {
        if (chunkTimer) clearTimeout(chunkTimer);
        if (settled) return;
        const timeout = firstChunkReceived ? subsequentTimeoutMs : initialTimeoutMs;
        chunkTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
            // 保存已接收的部分内容供降级使用
            this._lastPartialContent = result.content || this._streamBuffer || '';
            this._streamBuffer = '';
            span.end({ error: 'chunk timeout' });
            reject(new Error(`LLM stream timeout: no data received for ${Math.round(timeout / 1000)}s`));
          }
        }, timeout);
      };
      resetChunkTimer();

      // Defensive: if abortController was already cleaned up, bail out
      if (!this.abortController) {
        if (chunkTimer) clearTimeout(chunkTimer);
        resolve({ content: '', reasoning: '', toolCalls: null, truncated: false, interrupted: false });
        return;
      }

      // 消息序列规范化：消除连续 assistant + 确保 user-last
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

      this.llm.streamChat({
        modelId: effectiveModelId,
        messages: sanitizedMessages,
        tools: effectiveTools,
        toolChoice: effectiveToolChoice,
        signal: this.abortController.signal,
        onChunk: (chunk) => {
          try {
            resetChunkTimer();
            this._touchHeartbeat();
            if (chunk.type === 'content') {
              // Layer 3: first token progress
              if (!this._firstTokenReceived) {
                this._firstTokenReceived = true;
                firstChunkReceived = true; // 切换到更短的后续超时
                this._emit('progress-note', { text: 'Receiving response...' });
              }
              this._streamBuffer += chunk.content;
              const now = Date.now();
              if (now - this._lastFlushTime >= 100) {
                if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
                this._flushStreamBuffer();
              } else if (!this._flushTimer) {
                this._flushTimer = setTimeout(() => {
                  try { this._flushStreamBuffer(); } catch (_) { /* non-critical */ }
                }, 100 - (now - this._lastFlushTime));
              }
            } else if (chunk.type === 'reasoning') {
              if (!firstChunkReceived) firstChunkReceived = true;
              this._emit('stream-reasoning', { content: chunk.content });
            } else if (chunk.type === 'tool_call_delta') {
              if (!firstChunkReceived) firstChunkReceived = true;
              // Layer 3: detect tool_calls
              if (!this._toolCallsDetected) {
                this._toolCallsDetected = true;
                this._emit('progress-note', { text: 'Preparing tool calls...' });
              }
              this._emit('tool-call-delta', { index: chunk.index, toolCall: chunk.toolCall });
            }
          } catch (chunkErr) {
            this.tracer?.warn('onChunk error (non-fatal)', { error: chunkErr.message });
          }
        },
        onDone: (data) => {
          if (chunkTimer) clearTimeout(chunkTimer);
          if (settled) return;
          settled = true;
          try {
            if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
            this._flushStreamBuffer();
            // Layer 3: report detected tool_calls count
            if (data.toolCalls && data.toolCalls.length > 0 && this._toolCallsDetected) {
              this._emit('progress-note', { text: `Preparing ${data.toolCalls.length} tool call${data.toolCalls.length > 1 ? 's' : ''}...` });
            }
            // Reset per-call flags
            this._firstTokenReceived = false;
            this._toolCallsDetected = false;

            result.content = data.content;
            result.reasoning = data.reasoning;
            result.toolCalls = data.toolCalls;
            result.truncated = data.truncated || false;
            result.interrupted = data.interrupted || false;
            result.model = data.model || null;
            // 修复5: 标记模型主动选择 stop（非截断/非中断）
            if (data.finish_reason === 'stop' && (!data.toolCalls || data.toolCalls.length === 0)) {
              this._modelWantsToStop = true;
            }
            // [Token Dashboard] 记录 token 消耗
            if (data.usage) {
              tokenTracker.record({
                modelId: effectiveModelId,
                promptTokens: data.usage.prompt_tokens || 0,
                completionTokens: data.usage.completion_tokens || 0,
              });
              // 供 RuntimeMonitor 捕获每步 token 消耗
              this._emit('token-usage', {
                modelId: effectiveModelId,
                promptTokens: data.usage.prompt_tokens || 0,
                completionTokens: data.usage.completion_tokens || 0,
                totalTokens: (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0),
              });
            }
            if (effectiveModelId !== this.modelId && !result.content && (!result.toolCalls || result.toolCalls.length === 0) && toolChoice !== 'none') {
              this._routeFailedLastRound = true;
              if (this.autoAgent) {
                this._autoAgentRoutedModelId = null;
                this._emit('progress-note', {
                  text: `[Auto Agent] 分流模型无响应，回退到主选模型`,
                });
              }
            }
            span.end({ hasToolCalls: !!result.toolCalls });
          } catch (doneErr) {
            this.tracer?.warn('onDone error', { error: doneErr.message });
            span.end({ error: doneErr.message });
          }
          resolve(result);
        },
        onError: (err) => {
          if (chunkTimer) clearTimeout(chunkTimer);
          if (settled) return;
          settled = true;
          if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
          this._streamBuffer = '';
          span.end({ error: err.error });
          reject(new Error(err.error));
        },
      });
    });
  }

  async _executeTools(toolCalls) {
    const results = [];
    const totalTools = toolCalls.length;
    const g = this.config.guardrails || {};

    // Guardrail: maxToolCallsPerIteration — cap tool calls per single LLM round
    const maxPerIteration = g.maxToolCallsPerIteration || 10;
    if (toolCalls.length > maxPerIteration) {
      this.tracer?.warn(`Guardrail: ${toolCalls.length} tool calls exceeds maxToolCallsPerIteration (${maxPerIteration}), truncating`);
      this._emit('progress-note', { text: `Guardrail: capping tool calls from ${toolCalls.length} to ${maxPerIteration}` });
      toolCalls = toolCalls.slice(0, maxPerIteration);
    }

    // Guardrail: maxToolCallsTotal — hard cap on total tool calls across all iterations
    const maxTotal = g.maxToolCallsTotal || 300;
    if (this.toolCallCount >= maxTotal) {
      this.tracer?.warn(`Guardrail: total tool calls (${this.toolCallCount}) reached maxToolCallsTotal (${maxTotal}), skipping all`);
      this._emit('progress-note', { text: `Guardrail: total tool call limit reached (${maxTotal}), skipping remaining tool calls` });
      for (const tc of toolCalls) {
        results.push({
          toolCallId: tc.id,
          toolName: tc.function?.name || 'tool',
          output: { success: false, error: `Total tool call limit reached (${maxTotal}). Provide your final answer now.`, code: 'E_GUARDRAIL_TOTAL_LIMIT' },
        });
      }
      return results;
    }

    // Fast path for single tool call.
    if (toolCalls.length === 1) {
      this._startHeartbeat('Running tools', toolCalls[0].function?.name || 'tool');
      this._emit('progress-note', { text: `Running ${toolCalls[0].function?.name || 'tool'} (1/1)`, isToolProgress: true });
      const startTs = Date.now();
      const res = await this._executeSingleTool(toolCalls[0]);
      this._emit('progress-note', { text: `✓ ${toolCalls[0].function?.name || 'tool'} (${Date.now() - startTs}ms)`, isToolProgress: true });
      return [res];
    }

    // Codex scenario: keep serial execution for chain stability
    if (this._isCodex()) {
      let idx = 0;
      for (const tc of toolCalls) {
        if (this.abortController.signal.aborted) break;
        const toolName = tc.function?.name || 'tool';
        this._startHeartbeat('Running tools', toolName);
        this._emit('progress-note', { text: `Running ${toolName} (${idx + 1}/${totalTools})`, isToolProgress: true });
        const startTs = Date.now();
        const res = await this._executeSingleTool(tc);
        this._emit('progress-note', { text: `✓ ${toolName} (${Date.now() - startTs}ms)`, isToolProgress: true });
        results.push(res);
        idx++;
      }
      return results;
    }

    // Non-codex: keep order, batch safe tool calls in parallel.
    let safeBatch = [];
    let safeBatchStartIdx = 0;
    const flushSafeBatch = async () => {
      if (safeBatch.length === 0) return;
      const batchSize = safeBatch.length;
      const batchNames = safeBatch.map(tc => tc.function?.name || 'tool');
      const batchStartTs = Date.now();

      if (batchSize > 1) {
        const uniqueNames = [...new Set(batchNames)];
        const summary = uniqueNames.length <= 3
          ? uniqueNames.join(', ')
          : `${uniqueNames.slice(0, 2).join(', ')} +${uniqueNames.length - 2}`;
        this._emit('progress-note', {
          text: `Running ${batchSize} tools in parallel: ${summary}`,
          isToolProgress: true,
          parallelBatch: { count: batchSize, tools: batchNames, startIdx: safeBatchStartIdx },
        });
        this._startHeartbeat('Parallel execution', `${batchSize} tools`);
      } else {
        this._emit('progress-note', {
          text: `Running ${batchNames[0]} (${safeBatchStartIdx + 1}/${totalTools})`,
          isToolProgress: true,
        });
        this._startHeartbeat('Running tools', batchNames[0]);
      }

      let completedInBatch = 0;
      const wrappedExecutions = safeBatch.map((tc, batchLocalIdx) => {
        const toolName = tc.function?.name || 'tool';
        const toolStartTs = Date.now();
        return this._executeSingleTool(tc).then(res => {
          completedInBatch++;
          const toolElapsed = Date.now() - toolStartTs;
          if (batchSize > 1) {
            this._emit('progress-note', {
              text: `✓ ${toolName} (${toolElapsed}ms) [${completedInBatch}/${batchSize}]`,
              isToolProgress: true,
              parallelProgress: { completed: completedInBatch, total: batchSize, toolName, elapsed: toolElapsed },
            });
          } else {
            this._emit('progress-note', {
              text: `✓ ${toolName} (${toolElapsed}ms)`,
              isToolProgress: true,
            });
          }
          return res;
        }).catch(err => {
          return {
            toolCallId: tc.id,
            toolName,
            output: { success: false, error: `Tool execution failed: ${err.message}`, code: 'E_TOOL_CRASH' },
          };
        });
      });

      const safeResults = await Promise.all(wrappedExecutions);
      results.push(...safeResults);

      if (batchSize > 1) {
        const batchElapsed = Date.now() - batchStartTs;
        this._emit('progress-note', {
          text: `Parallel batch done: ${batchSize} tools in ${batchElapsed}ms`,
          isToolProgress: true,
          parallelBatchDone: { count: batchSize, elapsed: batchElapsed },
        });
      }

      safeBatch = [];
    };

    let idx = 0;
    for (const tc of toolCalls) {
      if (this.abortController.signal.aborted) break;
      const tool = this.tools.getTool(tc.function?.name);
      const riskLevel = tool?.riskLevel || 'medium';
      const toolName = tc.function?.name || 'tool';

      if (riskLevel === 'safe') {
        if (safeBatch.length === 0) safeBatchStartIdx = idx;
        safeBatch.push(tc);
        idx++;
        continue;
      }

      await flushSafeBatch();
      if (this.abortController.signal.aborted) break;
      this._startHeartbeat('Running tools', toolName);
      this._emit('progress-note', { text: `Running ${toolName} (${idx + 1}/${totalTools})`, isToolProgress: true });
      const startTs = Date.now();
      const res = await this._executeSingleTool(tc);
      this._emit('progress-note', { text: `✓ ${toolName} (${Date.now() - startTs}ms)`, isToolProgress: true });
      results.push(res);
      idx++;
    }

    if (!this.abortController.signal.aborted) {
      await flushSafeBatch();
    }

    return results;
  }

  async _executeSingleTool(tc) {
    if (this.abortController.signal.aborted) {
      return { toolCallId: tc.id, toolName: tc.function.name, output: { success: false, error: 'Aborted', code: 'E_ABORTED' } };
    }

    const toolName = tc.function.name;
    let args;
    try {
      args = JSON.parse(tc.function.arguments);
    } catch (e) {
      // Attempt JSON repair for common LLM issues (Gemini trailing commas, unescaped newlines, etc.)
      args = this._repairToolArgs(tc.function.arguments);
      if (!args) {
        if (toolName === 'edit_file') this._metrics.editInvalidJsonArgsCount++;
        return { toolCallId: tc.id, toolName, output: { success: false, error: `Invalid JSON arguments: ${e.message}`, code: 'E_INVALID_JSON' } };
      }
    }

    // Hard block: even if model hallucinates hidden tools, enforce mode-level tool policy at execution layer.
    const allowedDefs = this.tools.getDefinitions
      ? this.tools.getDefinitions({ mode: this._currentMode || 'agent', webSearchEnabled: this.webSearchEnabled })
      : null;
    if (Array.isArray(allowedDefs)) {
      const allowedNames = new Set(allowedDefs.map(t => t.name));
      if (!allowedNames.has(toolName)) {
        return {
          toolCallId: tc.id,
          toolName,
          output: {
            success: false,
            error: `Tool "${toolName}" is not allowed in ${this._currentMode || 'agent'} mode`,
            code: 'E_TOOL_NOT_ALLOWED_IN_MODE',
          },
        };
      }
    }

    // 循环检测黑名单：被标记循环的工具在当前迭代内被阻止执行
    if (this._toolLoopBlockedNames && this._toolLoopBlockedNames.has(toolName)) {
      return {
        toolCallId: tc.id,
        toolName,
        output: {
          success: false,
          error: `Tool "${toolName}" is temporarily blocked due to detected loop behavior. Use a different tool or approach. The information you need is likely already in your conversation context.`,
          code: 'E_TOOL_LOOP_BLOCKED',
        },
      };
    }

    // Duplicate call suppression for common read-only tools.
    const toolSignature = this._buildToolSignature(toolName, args);
    if (toolSignature && !args.force_refresh && !args.bypass_cache) {
      const entry = this._toolResultCache.get(toolSignature);
      const isRecent = entry && (this.iteration - entry.iteration <= 1);
      if (isRecent && entry.output?.success) {
        this._metrics.duplicateToolSuppressCount = (this._metrics.duplicateToolSuppressCount || 0) + 1;
        const duplicateOutput = {
          success: true,
          shortCircuited: true,
          duplicateSuppressed: true,
          message: `Duplicate ${toolName} call suppressed. Same arguments were already executed recently; reuse previous result and continue.`,
          previousOutput: typeof entry.output === 'string'
            ? entry.output.substring(0, 600)
            : {
              success: !!entry.output?.success,
              message: entry.output?.message || '',
              content: typeof entry.output?.content === 'string' ? entry.output.content.substring(0, 600) : undefined,
              stdout: typeof entry.output?.stdout === 'string' ? entry.output.stdout.substring(0, 600) : undefined,
            },
        };
        this._emit('progress-note', { text: `Duplicate suppressed: ${toolName}` });
        this._emit('tool-executing', { toolCallId: tc.id, toolName, args });
        this.toolCallCount++;
        this._emit('tool-result', { toolCallId: tc.id, toolName, output: duplicateOutput, elapsed: 0 });
        return { toolCallId: tc.id, toolName, output: duplicateOutput, elapsed: 0, args };
      }
    }

    // Track per-file read counts and short-circuit excessive re-reads
    if (toolName === 'read_file' && args.path) {
      const key = (args.path || '').replace(/\\/g, '/');
      const count = (this._fileReadCounts.get(key) || 0) + 1;
      this._fileReadCounts.set(key, count);

      // Bug #6 fix + Bug #3 fix: 分段读取（带 offset）不受次数限制
      // Bug #3: !args.offset 会将 offset:0 误判为 true（JS Falsy），改为严格判断
      if (count > (this.config.guardrails?.maxReadRetriesPerFile || 3) && !args.force_refresh && (args.offset === undefined || args.offset === null)) {
        this._metrics.duplicateReadCount++;
        this.anomalyLogger.excessiveRead(args.path, count, { iteration: this.iteration });
        const skipOutput = {
          success: true,
          shortCircuited: true,
          message: `You have already read "${args.path}" ${count} times in this session. The content is in your conversation context. STOP re-reading and proceed with the task using the content you already have. If the file was externally modified, use force_refresh=true.`,
          _filePath: args.path,
        };
        this._emit('tool-executing', { toolCallId: tc.id, toolName, args });
        this.toolCallCount++;
        this._emit('tool-result', { toolCallId: tc.id, toolName, output: skipOutput, elapsed: 0 });
        return { toolCallId: tc.id, toolName, output: skipOutput, elapsed: 0, args };
      }
    }

    if (toolName === 'read_file' && !args.force_refresh && args.path && this.projectPath) {
      const fs = require('fs');
      const path = require('path');
      try {
        const fullPath = path.resolve(this.projectPath, args.path);
        if (fs.existsSync(fullPath)) {
          const stat = fs.statSync(fullPath);
          const parsedOffset = Number(args.offset);
          const parsedLimit = Number(args.limit);
          const requestStart = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 1;
          const requestEnd = Number.isFinite(parsedLimit) && parsedLimit > 0
            ? (requestStart + parsedLimit - 1)
            : undefined;
          const check = this.readCoverage.shouldShortCircuit(args.path, {
            mtimeMs: stat.mtimeMs, size: stat.size,
            requestStart, requestEnd,
          });
          // Short-circuit: when cached content can be replayed safely.
          if (check.skip && typeof check.cachedContent === 'string') {
            this._metrics.duplicateReadCount++;
            const shortCircuitOutput = {
              success: true,
              shortCircuited: true,
              message: check.message,
              content: check.cachedContent,
              totalLines: check.totalLines,
              startLine: check.range?.start,
              endLine: check.range?.end,
              truncated: false,
              _filePath: args.path,
            };
            this._emit('tool-executing', { toolCallId: tc.id, toolName, args });
            this.toolCallCount++;
            this._emit('tool-result', { toolCallId: tc.id, toolName, output: shortCircuitOutput, elapsed: 0 });
            return { toolCallId: tc.id, toolName, output: shortCircuitOutput, elapsed: 0, args };
          }
          // Short-circuit without content: coverage exists but chunk was evicted.
          // Still skip the read to save tokens, but tell the model to use context.
          if (check.skip && !check.cachedContent) {
            this._metrics.duplicateReadCount++;
            const range = check.range || {};
            const skipOutput = {
              success: true,
              shortCircuited: true,
              message: `You already read ${args.path} L${range.start || '?'}-${range.end || '?'} earlier in this session. The content is in your conversation context above. If you truly need to re-read, use force_refresh=true.`,
              totalLines: check.totalLines,
              startLine: range.start,
              endLine: range.end,
              truncated: false,
              _filePath: args.path,
            };
            this._emit('tool-executing', { toolCallId: tc.id, toolName, args });
            this.toolCallCount++;
            this._emit('tool-result', { toolCallId: tc.id, toolName, output: skipOutput, elapsed: 0 });
            return { toolCallId: tc.id, toolName, output: skipOutput, elapsed: 0, args };
          }
        }
      } catch (_) { /* Short-circuit failed, proceed with normal execution */ }
    }

    const tool = this.tools.getTool(toolName);
    const riskLevel = tool?.riskLevel || 'medium';

    if (needsApproval(riskLevel, this.autoApprove, {
      toolName,
      command: toolName === 'run_terminal_cmd' ? args.command : undefined,
    })) {
      this._setState(STATES.AWAITING_APPROVAL);
      this._emit('approval-needed', { toolCallId: tc.id, toolName, args, riskLevel });

      const approved = await this._waitForApproval(tc.id);
      if (!approved) {
        return { toolCallId: tc.id, toolName, output: makeError(ERROR_CODES.APPROVAL_DENIED) };
      }
      this._setState(STATES.EXECUTING_TOOLS);
    }

    this._emit('tool-executing', { toolCallId: tc.id, toolName, args });
    const span = this.tracer.startSpan(`tool:${toolName}`, { args });
    const startTime = Date.now();

    let output;
    try {
      output = await this.tools.execute(toolName, args, this.projectPath, {
        agentLoopFactory: this.config.agentLoopFactory,
        modelId: this.modelId,
        todoStore: this.config.todoStore,
        subAgentDepth: this.config.subAgentDepth || 0,
        parentEmitter: (event, data) => this._emit(event, data),
        signal: this.abortController?.signal,
        sessionId: this.sessionId,
      });
    } catch (execErr) {
      output = { success: false, error: execErr.message || 'Tool execution crashed', code: 'E_TOOL_CRASH' };
    }

    // Attach file path for read coverage bookkeeping.
    if (toolName === 'read_file' && output?.success && args.path) {
      output._filePath = args.path;
    }

    const elapsed = Date.now() - startTime;
    span.end({ output: { success: output?.success }, elapsed });

    this._cacheToolResult(toolSignature, output);
    this.toolCallCount++;
    this._emit('tool-result', { toolCallId: tc.id, toolName, output, elapsed });
    return { toolCallId: tc.id, toolName, output, elapsed, args };
  }

  _waitForApproval(toolCallId) {
    return new Promise((resolve) => {
      this.pendingApproval = { toolCallId, resolve };
      const timeout = setTimeout(() => {
        if (this.pendingApproval?.toolCallId === toolCallId) {
          this.pendingApproval = null;
          resolve(false);
        }
      }, 300000);
      this.pendingApproval.timeout = timeout;
    });
  }

  handleApproval(toolCallId, approved) {
    if (this.pendingApproval?.toolCallId === toolCallId) {
      clearTimeout(this.pendingApproval.timeout);
      this.pendingApproval.resolve(approved);
      this.pendingApproval = null;
    }
  }

  _waitForQuestionResponse(toolCallId) {
    return new Promise((resolve) => {
      this.pendingQuestion = { toolCallId, resolve };
      const timeout = setTimeout(() => {
        if (this.pendingQuestion?.toolCallId === toolCallId) {
          this.pendingQuestion = null;
          resolve(null);
        }
      }, 300000);
      this.pendingQuestion.timeout = timeout;
    });
  }

  handleQuestionResponse(toolCallId, answers) {
    if (this.pendingQuestion?.toolCallId === toolCallId) {
      clearTimeout(this.pendingQuestion.timeout);
      this.pendingQuestion.resolve(answers);
      this.pendingQuestion = null;
    }
  }

  /**
   * 检测 LLM 回复是否在请求用户提供信息。
   * 用于 noTool 路径中区分"消极怠工"和"合法等待用户输入"。
   */
  _detectUserInputRequest(content) {
    if (!content || content.length < 10) return false;
    const patterns = [
      /请.*?(?:提供|给我|输入|粘贴|发送|上传)/,
      /需要.*?(?:你|用户).*?(?:提供|确认|选择|输入)/,
      /(?:please|could you|can you).*?(?:provide|share|paste|upload|send)/i,
      /(?:需要|等待).*?(?:用户|你的?).*?(?:输入|反馈|回复|确认)/,
    ];
    return patterns.some(p => p.test(content));
  }

  cancel() {
    // Abort first so in-flight LLM/tool operations receive the signal immediately
    if (this.abortController) this.abortController.abort();
    this._finalizeRun(STATES.CANCELLED);
    this._setState(STATES.CANCELLED);
    if (this.pendingApproval) {
      clearTimeout(this.pendingApproval.timeout);
      this.pendingApproval.resolve(false);
      this.pendingApproval = null;
    }
    if (this.pendingQuestion) {
      clearTimeout(this.pendingQuestion.timeout);
      this.pendingQuestion.resolve(null);
      this.pendingQuestion = null;
    }
    this._emit('cancelled', {});
  }

  // On terminal state, archive in_progress → pending (to allow for potential recovery)
  _finalizeRun(terminalState) {
    this._stopHeartbeat();
    // 异常日志器：写入会话结束摘要
    try { this.anomalyLogger?.finalize(terminalState); } catch (_) { }
    if (terminalState === STATES.COMPLETE) return;
    const todoStore = this.config.todoStore;
    if (!todoStore) return;
    const todos = todoStore.get();
    let changed = false;
    const updated = todos.map(t => {
      if (t.status === 'in_progress') {
        changed = true;
        return { ...t, status: 'pending', _pauseReason: terminalState };
      }
      return t;
    });
    if (changed) {
      todoStore.set(updated);
    }
  }

  destroy() {
    const terminalStates = new Set([STATES.COMPLETE, STATES.INCOMPLETE, STATES.FAILED, STATES.CANCELLED]);
    if (!terminalStates.has(this.state)) {
      this.cancel();
    } else {
      if (this.abortController && !this.abortController.signal.aborted) {
        this.abortController.abort();
      }
      if (this.pendingApproval) {
        clearTimeout(this.pendingApproval.timeout);
        this.pendingApproval.resolve(false);
        this.pendingApproval = null;
      }
      if (this.pendingQuestion) {
        clearTimeout(this.pendingQuestion.timeout);
        this.pendingQuestion.resolve(null);
        this.pendingQuestion = null;
      }
      this._stopHeartbeat();
    }
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    this._streamBuffer = '';
    this.messages = [];
    this.emitter = null;
    this._recentToolCalls = [];
    this._toolResultCache.clear();
    this._modifiedFiles.clear();
    this._fileReadCounts.clear();
    this._successfulEdits.clear();
    if (this._editFailCounts) this._editFailCounts.clear();
    this.readCoverage.clear();
    this._trajectory = null;
    // 注意：不在此处清空 abortController，因为 _loop 可能仍在执行
    // abortController 的清空由 start() 的 finally 块或下次 start() 调用时处理
    this.tracer = null;
  }

  _getLastAssistantContent() {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'assistant' && this.messages[i].content) {
        return this.messages[i].content;
      }
    }
    return '';
  }

  _checkCompletionGate() {
    const reasons = [];

    // 1) Todo completion check
    const todoStore = this.config.todoStore;
    if (todoStore) {
      const progress = todoStore.getProgress();
      const remaining = progress.pending + progress.inProgress;
      if (remaining > 0) {
        const pendingItems = todoStore.get()
          .filter(t => t.status === 'pending' || t.status === 'in_progress')
          .slice(0, 5)
          .map(t => t.content);
        reasons.push(`${remaining} todo item(s) still pending: ${pendingItems.join(', ')}`);
      }
    }

    // 2) Check for tool failures (inspect during first two gate retries)
    if (this._gateRetries <= 1) {
      const lastToolCallIds = new Set();
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const msg = this.messages[i];
        if (msg.role === 'assistant' && msg.tool_calls) {
          for (const tc of msg.tool_calls) lastToolCallIds.add(tc.id);
          break;
        }
      }
      let failedToolCount = 0;
      for (const msg of this.messages) {
        if (msg.role === 'tool' && lastToolCallIds.has(msg.tool_call_id)) {
          try {
            const parsed = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
            if (parsed && parsed.success === false) failedToolCount++;
          } catch (_) { }
        }
      }
      if (failedToolCount > 0) {
        reasons.push(`${failedToolCount} tool call(s) failed in the most recent round. Please inspect and handle them.`);
      }
    }

    // 3) Files changed but no verification performed
    if (this._hasFileChanges()) {
      const VERIFY_TOOLS = ['run_terminal_cmd', 'read_file', 'grep_search', 'file_search', 'list_dir', 'read_lints',
        'search_files', 'glob_search', 'list_directory'];
      let hasRecentVerify = false;
      const recent = this.messages.slice(-8);
      for (const msg of recent) {
        if (msg.role === 'assistant' && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            if (VERIFY_TOOLS.includes(tc.function?.name)) hasRecentVerify = true;
          }
        }
      }
      if (!hasRecentVerify && this._gateRetries <= 1) {
        reasons.push('Files were changed but no recent verification read was found.');
      }
    }

    // 4) Files changed but lint not verified yet
    if (this._lintCheckPending && this._modifiedFiles.size > 0 && this._gateRetries <= 1) {
      const files = [...this._modifiedFiles].slice(0, 5).map(f => {
        const parts = f.replace(/\\/g, '/').split('/');
        return parts[parts.length - 1];
      });
      reasons.push(`Edited ${this._modifiedFiles.size} file(s) without running read_lints. Check files such as: ${files.join(', ')}`);
    }

    // 5) Progress sanity check
    if (todoStore) {
      const progress = todoStore.getProgress();
      if (progress.total >= 3 && this.iteration < progress.total * 2 && progress.completed < progress.total && this._gateRetries === 0) {
        reasons.push(`Todo list has ${progress.total} items but only ${this.iteration} iterations ran. Confirm all tasks are fully handled.`);
      }
    }

    return { pass: reasons.length === 0, reasons };
  }

  _hasFileChanges() {
    return this._lastFileChangeIndex() >= 0;
  }

  _lastFileChangeIndex() {
    const FILE_CHANGE_TOOLS = ['write_file', 'edit_file', 'delete_file', 'create_file', 'reapply'];
    let lastIdx = -1;
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (FILE_CHANGE_TOOLS.includes(tc.function?.name)) {
            lastIdx = i;
          }
        }
      }
    }
    return lastIdx;
  }

  _isCodex() {
    const ids = [this.modelId, this._autoAgentRoutedModelId].filter(Boolean);
    return ids.some(id => /codex/i.test(id));
  }

  _isGemini() {
    const ids = [this.modelId, this._autoAgentRoutedModelId].filter(Boolean);
    return ids.some(id => /gemini/i.test(id));
  }

  _simpleHash(str) {
    if (!str || str.length === 0) return 0;
    let hash = 0;
    const sample = str.length > 200 ? str.substring(0, 100) + str.substring(str.length - 100) : str;
    for (let i = 0; i < sample.length; i++) {
      hash = ((hash << 5) - hash + sample.charCodeAt(i)) | 0;
    }
    return hash;
  }

  _isReadOnlyTerminalCommand(command) {
    const cmd = String(command || '').trim().toLowerCase();
    if (!cmd) return false;

    // Conservative deny-list first for obvious side-effects.
    if (/(^|\s)(rm|del|move|mv|copy|cp|mkdir|rmdir|touch|sed\s+-i|perl\s+-i|npm\s+install|pnpm\s+add|yarn\s+add|pip\s+install|git\s+commit|git\s+reset|git\s+checkout|git\s+clean)(\s|$)/.test(cmd)) {
      return false;
    }
    if (/[>;]{1,2}|\btee\b/.test(cmd)) return false;

    // Whitelist common read-only / diagnostics commands.
    return /^(pwd|ls|dir|cat|type|echo|rg|grep|findstr|git\s+status|git\s+diff|git\s+log|git\s+show|git\s+rev-parse|node\s+-v|npm\s+ls|python\s+--version|where\s+|which\s+)/.test(cmd);
  }

  _buildToolSignature(toolName, args = {}) {
    const normalizePath = (p) => String(p || '').replace(/\\/g, '/').trim().toLowerCase();
    const trim = (v) => String(v || '').trim();

    if (toolName === 'read_file') {
      if (!args.path) return null;
      return `read_file:${normalizePath(args.path)}:${Number(args.offset) || 0}:${Number(args.limit) || 0}`;
    }

    if (toolName === 'list_dir' || toolName === 'list_directory') {
      const p = args.path || args.dir || '.';
      return `${toolName}:${normalizePath(p)}`;
    }

    if (toolName === 'grep_search' || toolName === 'search_files' || toolName === 'file_search' || toolName === 'glob_search') {
      const p = args.path || args.root || '.';
      const q = args.pattern || args.query || args.glob || '';
      return `${toolName}:${normalizePath(p)}:${trim(q).toLowerCase()}`;
    }

    if (toolName === 'read_lints') {
      return `read_lints:${normalizePath(args.path || args.file || '.')}::${Number(args.limit) || 0}`;
    }

    if (toolName === 'run_terminal_cmd') {
      const cmd = trim(args.command || args.cmd || args.script);
      const cwd = normalizePath(args.cwd || args.workdir || '.');
      if (!cmd || !this._isReadOnlyTerminalCommand(cmd)) return null;
      return `run_terminal_cmd:${cwd}:${cmd.toLowerCase()}`;
    }

    return null;
  }

  _cacheToolResult(signature, output) {
    if (!signature) return;
    const prev = this._toolResultCache.get(signature);
    const recent = prev && (this.iteration - prev.iteration <= 1);
    const next = {
      iteration: this.iteration,
      count: recent ? (prev.count + 1) : 1,
      output,
      ts: Date.now(),
    };
    this._toolResultCache.set(signature, next);
    if (this._toolResultCache.size > 120) {
      const firstKey = this._toolResultCache.keys().next().value;
      if (firstKey) this._toolResultCache.delete(firstKey);
    }
  }

  _detectToolLoop() {
    const recent = this._recentToolCalls;
    const g = this.config.guardrails || {};
    // 修复1: 循环检测阈值从 4 降到 3，更快发现重复
    const maxConsecutive = g.maxConsecutiveSameToolCalls || 3;
    if (recent.length < maxConsecutive) return null;

    const last8 = recent.slice(-8);

    // Pattern 1: Same tool + same args called maxConsecutive times in last 8 calls
    // Catches: identical grep_search, read_file, or any other tool repeating
    const exactCounts = new Map();
    for (const tc of last8) {
      const key = `${tc.name}:${tc.argsHash}`;
      exactCounts.set(key, (exactCounts.get(key) || 0) + 1);
    }
    for (const [key, count] of exactCounts) {
      if (count >= maxConsecutive) {
        const toolName = key.split(':')[0];
        return { pattern: `${toolName} with identical arguments (${count}x)`, toolName };
      }
    }

    // Pattern 2: Same tool name called maxConsecutive+ times in last 6 calls (regardless of args)
    // Catches: grep_search or read_file being spammed with slightly different args
    const last6 = last8.slice(-6);
    const toolNameCounts = new Map();
    for (const tc of last6) {
      toolNameCounts.set(tc.name, (toolNameCounts.get(tc.name) || 0) + 1);
    }
    for (const [toolName, count] of toolNameCounts) {
      if (count >= maxConsecutive) {
        return { pattern: `${toolName} called ${count}x in last 6 calls with varying arguments`, toolName };
      }
    }

    // Pattern 3: Alternating pattern detection (A -> B -> A -> B -> A -> B)
    if (last6.length >= 6) {
      const a = `${last6[0].name}:${last6[0].argsHash}`;
      const b = `${last6[1].name}:${last6[1].argsHash}`;
      if (a !== b) {
        const isAlternating = last6.every((tc, i) => {
          const key = `${tc.name}:${tc.argsHash}`;
          return key === (i % 2 === 0 ? a : b);
        });
        if (isAlternating) {
          return { pattern: `alternating ${last6[0].name} ↔ ${last6[1].name} loop`, toolName: last6[0].name };
        }
      }
    }

    // Pattern 4: 同一工具被不同参数反复调用（语义重复检测）
    // 捕捉「用不同行范围反复读取同一文件」等绕过 Pattern 2 的场景
    const last10 = recent.slice(-10);
    const semanticToolCounts = new Map();
    for (const tc of last10) {
      semanticToolCounts.set(tc.name, (semanticToolCounts.get(tc.name) || 0) + 1);
    }
    for (const [toolName, count] of semanticToolCounts) {
      // 修复1: 语义循环阈值从 6 降到 4，更快检测重复模式
      if (count >= 4) {
        return { pattern: `${toolName} called ${count}x in last 10 calls (semantic repeat)`, toolName };
      }
    }

    return null;
  }

  _repairToolArgs(raw) {
    if (!raw || typeof raw !== 'string') return null;

    const strategies = [
      // 1: Remove trailing commas before } or ]
      (s) => s.replace(/,\s*([}\]])/g, '$1'),
      // 2: Fix unescaped newlines inside JSON string values
      (s) => s.replace(/(?<=:\s*"(?:[^"\\]|\\.)*)(?<!\\)\n/g, '\\n'),
      // 3: Fix single quotes → double quotes (Gemini sometimes does this)
      (s) => s.replace(/'/g, '"'),
      // 4: Wrap bare value in object if it looks like key:value pairs
      (s) => s.startsWith('{') ? s : `{${s}}`,
      // 5: Strip markdown code fences that Gemini sometimes wraps around JSON
      (s) => s.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, ''),
    ];

    // Try each repair in isolation, then in combination
    for (const fix of strategies) {
      try {
        return JSON.parse(fix(raw));
      } catch (_) { }
    }

    // Try combining all repairs
    let repaired = raw;
    for (const fix of strategies) {
      repaired = fix(repaired);
    }
    try {
      return JSON.parse(repaired);
    } catch (_) { }

    return null;
  }

  async _buildSystemPrompt(mode, { emitSkillEvent = false } = {}) {
    const matchedSkills = this.config.matchedSkills || [];
    const skillCatalog = this.config.skillCatalog || [];
    let systemPrompt;
    if (this.promptAssembler?.assembleAsync) {
      systemPrompt = await this.promptAssembler.assembleAsync({
        mode,
        projectPath: this.projectPath,
        openFiles: this._openFiles,
        modelId: this.modelId,
        webSearchEnabled: this.webSearchEnabled,
        matchedSkills,
        skillCatalog,
      });
    } else if (this.promptAssembler) {
      systemPrompt = this.promptAssembler.assemble({
        mode,
        projectPath: this.projectPath,
        openFiles: this._openFiles,
        modelId: this.modelId,
        webSearchEnabled: this.webSearchEnabled,
        matchedSkills,
        skillCatalog,
      });
    } else {
      systemPrompt = this._defaultSystemPrompt(mode);
    }

    this._matchedSkillNames = new Set(matchedSkills.map(s => s.name));
    this._usedSkills = this._usedSkills || new Set();

    if (matchedSkills.length > 0 && mode === 'agent') {
      systemPrompt += '\n\n<skill_usage_protocol>\nWhen you apply knowledge from a matched skill during your response, output a structured tag: <skill_used name="SKILL_NAME" /> to indicate which skill you are using. This helps the user understand which skills are being applied.\n</skill_usage_protocol>';
    }

    if (emitSkillEvent) {
      this._emit('skills-matched', {
        skills: matchedSkills.map(s => ({
          name: s.name,
          summary: s.summary || '',
        })),
        availableSkills: skillCatalog.map(s => ({
          name: s.name,
          summary: s.summary || '',
        })),
      });
    }

    // Skill 记忆索引：精简的 name→tags 映射，让 AI 始终感知可用 Skill
    // 每次构建提示词时注入，体积极小（~200-500 chars），避免 AI 重复读取 skill 列表
    if (skillCatalog.length > 0 && mode === 'agent') {
      const idx = skillCatalog.map(s => {
        const tags = (s.tags && s.tags.length > 0) ? ` [${s.tags.join(',')}]` : '';
        return `  - ${s.name}${tags}`;
      }).join('\n');
      systemPrompt += `\n\n<skill_memory>\n你已加载以下技能索引，无需再次查询：\n${idx}\n当任务涉及上述技能的关键词时，直接调用对应技能。\n</skill_memory>`;
    }

    return systemPrompt;
  }

  /**
   * 动态 Skill 注入：在 Agent 执行过程中检测到需要未注入的 Skill 时，
   * 将其 detail 作为 system 消息注入到对话中。
   * 
   * 触发方式：
   * 1. 被动检测：LLM 输出或工具结果中包含 Skill name/tags
   * 2. 主动请求：LLM 输出 <skill_request name="..." /> 标签
   */
  _normalizeSkillText(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/<[^>]*>/g, ' ')
      .replace(/[`"'()[\]{}.,:;!?/\\|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _extractSkillKeywords(text) {
    const normalized = this._normalizeSkillText(text);
    if (!normalized) return [];

    const tokens = normalized.match(/[\u4e00-\u9fff]{2,}|[a-z0-9][a-z0-9_-]{1,}/g) || [];
    const keywords = new Set();

    for (const token of tokens) {
      if (token.length < 2) continue;
      keywords.add(token);

      if (/^[\u4e00-\u9fff]+$/.test(token) && token.length >= 4) {
        for (let i = 0; i < token.length - 1; i++) keywords.add(token.substring(i, i + 2));
      } else if (/^[a-z0-9_-]+$/.test(token)) {
        for (const part of token.split(/[_-]+/)) {
          if (part.length >= 2) keywords.add(part);
        }
      }
    }

    return [...keywords].filter(k => k.length >= 2 && k.length <= 24).slice(0, 200);
  }

  _buildSkillTriggers(skill) {
    const triggerSet = new Set();
    const seeds = [skill?.name || '', ...((skill?.tags && Array.isArray(skill.tags)) ? skill.tags : [])];
    for (const raw of seeds) {
      const normalized = this._normalizeSkillText(raw);
      if (normalized.length >= 2) triggerSet.add(normalized);
      for (const kw of this._extractSkillKeywords(normalized)) {
        triggerSet.add(kw);
      }
    }
    return [...triggerSet];
  }

  _dynamicSkillInject(llmResult, toolResults) {
    const catalog = this.config.skillCatalog || [];
    const alreadyMatched = this.config.matchedSkills || [];
    if (catalog.length === 0) return;

    // 已注入的 Skill 名称集合（初次匹配 + 动态注入的都算）
    this._injectedSkillNames = this._injectedSkillNames || new Set(alreadyMatched.map(s => s.name));

    const contentToScan = [
      llmResult?.content || '',
      ...(toolResults || []).map(r => {
        if (typeof r.output === 'string') return r.output;
        if (r.output?.content) return r.output.content;
        return '';
      }),
    ].join(' ').toLowerCase();

    if (contentToScan.length < 5) return;

    // === 方式 1：主动请求 <skill_request name="..." /> ===
    const requestRegex = /<skill_request\s+name="([^"]+)"\s*\/?>/gi;
    let reqMatch;
    while ((reqMatch = requestRegex.exec(llmResult?.content || '')) !== null) {
      const requestedName = reqMatch[1];
      if (!this._injectedSkillNames.has(requestedName)) {
        const skill = this._findSkillByName(requestedName);
        if (skill) {
          this._injectSkillDetail(skill, 'request');
        }
      }
    }
    if (llmResult?.content) {
      llmResult.content = llmResult.content.replace(/<skill_request\s+name="[^"]*"\s*\/?>/gi, '').trim();
    }

    // === 方式 2：Level 1 - 关键词/标签快速匹配（零 token 成本）===
    for (const entry of catalog) {
      if (this._injectedSkillNames.has(entry.name)) continue;
      const triggers = this._buildSkillTriggers(entry);
      if (triggers.some(kw => contentToScan.includes(kw))) {
        const skill = this._findSkillByName(entry.name);
        if (skill) this._injectSkillDetail(skill, 'trigger');
      }
    }

    // === 方式 3：Level 2 - 描述语义分析（仅执行一次，防重复浪费 token）===
    // 每个会话只做一次深度描述分析，命中后记住
    if (!this._skillDescAnalyzeDone) {
      this._skillDescAnalyzeDone = true; // 标记已分析，后续不再重复
      for (const entry of catalog) {
        if (this._injectedSkillNames.has(entry.name)) continue;
        // 从 summary + detail 首段提取关键词
        const allSkills = this.config.allSkills || [];
        const full = allSkills.find(s => s.name === entry.name);
        const descSource = `${entry.summary || ''} ${(full?.detail || '').substring(0, 500)}`;
        const keywords = this._extractSkillKeywords(descSource);
        const hitCount = keywords.filter(kw => contentToScan.includes(kw)).length;
        if (hitCount >= 3) {
          const skill = this._findSkillByName(entry.name);
          if (skill) this._injectSkillDetail(skill, 'desc-analysis');
        }
      }
    }
  }

  /**
   * 从技能存储中查找完整的 Skill 数据（含 detail）
   */
  _findSkillByName(name) {
    const allSkills = this.config.allSkills || [];
    const full = allSkills.find(s => s.name === name);
    if (full?.detail) return full;

    const matched = (this.config.matchedSkills || []).find(s => s.name === name);
    if (matched?.detail) return matched;

    const catalog = this.config.skillCatalog || [];
    return catalog.find(s => s.name === name) || null;
  }

  /**
   * 将 Skill detail 注入到对话消息中（带防重保护）
   */
  _injectSkillDetail(skill, triggerType) {
    if (this._injectedSkillNames.has(skill.name)) return;
    this._injectedSkillNames.add(skill.name);
    this._matchedSkillNames = this._matchedSkillNames || new Set();
    this._matchedSkillNames.add(skill.name);
    this._usedSkills = this._usedSkills || new Set();

    const detail = (skill.detail || skill.summary || '').substring(0, 3000);
    if (!detail) return;

    this.messages.push({
      role: 'system',
      content: `<dynamic_skill name="${skill.name}" trigger="${triggerType}">\n${detail}\n</dynamic_skill>\n\nYou just activated skill "${skill.name}". Follow the skill instructions above for subsequent actions.`,
    });

    this._emit('skill-injected', { name: skill.name, trigger: triggerType, summary: skill.summary || '' });
    console.log(`[AgentLoop] Dynamic skill injected: "${skill.name}" (trigger: ${triggerType})`);
  }

  async _applyModeSwitch(targetMode) {
    const fromMode = this._currentMode || 'agent';
    if (!targetMode) {
      return { ok: false, from: fromMode, to: fromMode, error: 'Missing target mode' };
    }
    if (targetMode === fromMode) {
      return { ok: true, from: fromMode, to: fromMode };
    }

    try {
      const nextPrompt = await this._buildSystemPrompt(targetMode, { emitSkillEvent: false });
      this._currentMode = targetMode;

      if (this.messages.length > 0 && this.messages[0].role === 'system') {
        this.messages[0] = { role: 'system', content: nextPrompt };
      } else {
        this.messages.unshift({ role: 'system', content: nextPrompt });
      }
      this.messages.push({
        role: 'system',
        content: `Mode switched from ${fromMode} to ${targetMode}. Follow ${targetMode} mode constraints strictly from now on.`,
      });

      return { ok: true, from: fromMode, to: targetMode };
    } catch (e) {
      return { ok: false, from: fromMode, to: fromMode, error: e.message };
    }
  }

  _defaultSystemPrompt(mode) {
    return `You are an intelligent AI coding assistant integrated in this IDE. You are in ${mode} mode. Help the user with their coding tasks. When you need to perform actions, use the available tools. Always respond in Simplified Chinese. When asked about your identity, say you are the user's AI programming assistant.`;
  }

  // --- Workflow matching (via IPC to backend) ---
  async _matchWorkflow(userMessage) {
    if (typeof this.config.workflowMatcher === 'function') {
      return await this.config.workflowMatcher(userMessage);
    }
    return null;
  }

  _flattenSteps(steps, depth = 0) {
    const result = [];
    for (const s of steps) {
      result.push({ id: s.id, title: s.title, depth });
      if (s.subSteps && s.subSteps.length > 0) {
        result.push(...this._flattenSteps(s.subSteps, depth + 1));
      }
    }
    return result;
  }

  _formatWorkflowSteps(steps, depth = 0) {
    const lines = [];
    steps.forEach((s, i) => {
      const indent = '  '.repeat(depth);
      const prefix = depth === 0 ? `${i + 1}.` : `${i + 1})`;
      lines.push(`${indent}${prefix} ${s.title}`);
      if (s.subSteps && s.subSteps.length > 0) {
        lines.push(this._formatWorkflowSteps(s.subSteps, depth + 1));
      }
    });
    return lines.join('\n');
  }

  _tryAdvanceWorkflow(textContent, toolResults = []) {
    if (!this._activeWorkflow || !this._workflowStepStatus) return;

    try {
      const current = this._workflowStepStatus.find(s => s.status === 'in_progress');
      if (!current) {
        this.advanceWorkflow();
        return;
      }

      // Signal 1 (explicit, highest priority): todo_write carries step ID
      const hasExplicitMark = toolResults.some(r => {
        if (r.toolName !== 'todo_write') return false;
        const explicitFromOutput = r.output?.stepId;
        const explicitFromArgs = r.args?.step_id || r.args?.stepId;
        return explicitFromOutput === current.id || explicitFromArgs === current.id;
      });

      // Signal 2 (weak, fallback): text contains both step keywords + completion hints
      const text = (textContent || '').toLowerCase();
      const stepTitle = (current.title || '').toLowerCase();
      const completionHints = ['complete', 'completed', 'done', 'fixed', 'implemented', 'success'];
      const stepKeywords = stepTitle.split(/\s+/).filter(w => w.length >= 2);
      const mentionsStep = stepKeywords.some(kw => text.includes(kw));
      const mentionsComplete = completionHints.some(h => text.includes(h));

      if (hasExplicitMark || (mentionsStep && mentionsComplete)) {
        this.advanceWorkflow();
      }
    } catch (e) {
      this.tracer?.warn('_tryAdvanceWorkflow error (non-fatal): ' + e.message);
    }
  }

  // Agent updates workflow step status during execution.
  updateWorkflowStep(stepId, status) {
    if (!this._workflowStepStatus) return;
    const step = this._workflowStepStatus.find(s => s.id === stepId);
    if (step) {
      step.status = status;
      this._emit('workflow-step-update', {
        stepId,
        status,
        steps: this._workflowStepStatus,
      });
    }
  }

  // Advance workflow sequentially: complete current and start next.
  advanceWorkflow() {
    if (!this._workflowStepStatus || this._workflowStepStatus.length === 0) return null;

    const current = this._workflowStepStatus.find(s => s.status === 'in_progress');
    if (current) {
      current.status = 'completed';
    }

    const next = this._workflowStepStatus.find(s => s.status === 'pending');
    if (next) {
      next.status = 'in_progress';
      this._emit('workflow-step-update', { stepId: next.id, status: 'in_progress', steps: this._workflowStepStatus });

      // [Optimize: Token Saving] Checkpoint：阶段切换时注入重置 prompt
      this.messages.push({
        role: 'system',
        content: '[Checkpoint] 阶段任务已完成。现在开始执行下一阶段。过去执行的冗余代码细节不再重要，请基于当前项目最新状态直接开始新任务。',
      });
      return next;
    }

    this._emit('workflow-step-update', { stepId: null, status: 'all_complete', steps: this._workflowStepStatus });
    return null;
  }
}

// --- Quality Interceptor: Lazy phrase blacklist ---
const LAZY_PHRASES = [
  '\u4e3a\u4e86\u7b80\u5355\u8d77\u89c1', '\u4e3a\u4e86\u5feb\u901f', '\u4e3a\u4e86\u6f14\u793a', '\u7701\u7565\u4e86',
  '\u5176\u4f59\u90e8\u5206\u7c7b\u4f3c', '\u4ee5\u6b64\u7c7b\u63a8', '\u8fd9\u91cc\u4e0d\u518d\u8d58\u8ff0', '\u7b80\u5355\u5b9e\u73b0',
  'for simplicity', 'for brevity', 'left as exercise',
  'similar to above', 'and so on', 'etc...',
];

AgentLoopController.checkResponseQuality = function checkResponseQuality(text) {
  if (!text || typeof text !== 'string') return { pass: true, matched: [] };
  const lower = text.toLowerCase();
  const matched = LAZY_PHRASES.filter(phrase => lower.includes(phrase.toLowerCase()));
  return { pass: matched.length === 0, matched };
};

module.exports = { AgentLoopController, STATES };


