# Agent 系统优化完整蓝图

> 基于 AgentFlow-Doc 协议借鉴 + Cursor Agent 对标 + 当前代码审计
> 按优先级分三个阶段，每项标注当前状态、差距、具体改法

---

## 阶段 1：工具协议层（直接解决循环/重试/调试难题）

### 1.1 统一工具返回协议

**当前状态**：21 个工具返回格式不统一——`read_file` 返回 `{success, content, totalLines, truncated, ...}`，`edit_file` 返回 `{success, path, replacements, matchStrategy, ...}`，`run_terminal_cmd` 返回 `{success, stdout, stderr, exitCode, ...}`。`agent-loop-controller.js` 需要对每个工具做 `if (toolName === 'read_file')` 类型的硬编码分支处理。

**AgentFlow-Doc 参考**：统一 envelope `{code, message, data, meta}`。

**具体改法**：

```javascript
// 统一返回协议 — 所有工具的 handler 返回值都经过 envelope 包装
// 文件：src/core/tool-executor.js 的 execute 方法中包装

const envelope = {
  success: Boolean,          // 是否成功
  code: String,              // 错误码（成功时为 'OK'）
  message: String,           // 人类可读的结果摘要
  data: Object,              // 工具特有的结构化数据
  meta: {
    tool: String,            // 工具名
    execution_time_ms: Number, // 执行耗时
    token_estimate: Number,  // 返回内容的估算 token 数（用于上下文预算）
    retryable: Boolean,      // 是否可重试
    idempotent: Boolean,     // 结果是否幂等（已应用的变更再次调用会得到相同结果）
  },
};
```

**改动范围**：
- `src/core/tool-executor.js`：在 `execute()` 方法中包装返回值，计算 `execution_time_ms` 和 `token_estimate`
- `src/core/agent-loop-controller.js`：`_executeSingleTool` 返回后统一读取 `envelope.meta` 字段
- 各 tool handler：无需改动（executor 层包装），但可以逐步迁移到直接返回 envelope 格式

**收益**：
- 循环检测可以直接用 `meta.execution_time_ms` 检测"快速失败循环"（如 5 次调用总耗时 < 500ms）
- 上下文管理可以用 `meta.token_estimate` 做预算控制
- 前端可以统一展示工具执行状态

---

### 1.2 错误码分层 + 重试矩阵

**当前状态**：`error-codes.js` 已有 16 个错误码，每个都标记了 `recoverable`，但 `agent-loop-controller.js` 没有利用 `recoverable` 字段做自动重试决策——所有错误都靠模型自行判断是否重试。

**AgentFlow-Doc 参考**：按编号段分类（1xxx 客户端错误/2xxx 成功/5xxx 系统错误），明确每种错误的重试策略。

**具体改法**：

```javascript
// 文件：src/core/error-codes.js — 增加重试策略字段

const ERROR_CODES = {
  // === 不可重试（用户/安全类）===
  PATH_TRAVERSAL:   { code: 'E_PATH_TRAVERSAL',   recoverable: false, retryStrategy: 'none' },
  CMD_BLOCKED:      { code: 'E_CMD_BLOCKED',       recoverable: false, retryStrategy: 'none' },
  APPROVAL_DENIED:  { code: 'E_APPROVAL_DENIED',   recoverable: false, retryStrategy: 'none' },
  MAX_ITERATIONS:   { code: 'E_MAX_ITERATIONS',    recoverable: false, retryStrategy: 'none' },
  BUDGET_EXCEEDED:  { code: 'E_BUDGET_EXCEEDED',   recoverable: false, retryStrategy: 'none' },
  TOOL_NOT_FOUND:   { code: 'E_TOOL_NOT_FOUND',    recoverable: false, retryStrategy: 'none' },

  // === 可重试 — 需要模型修正输入 ===
  MATCH_NOT_FOUND:  { code: 'E_MATCH_NOT_FOUND',   recoverable: true,  retryStrategy: 'reread_then_retry', maxRetries: 3 },
  MULTIPLE_MATCHES: { code: 'E_MULTIPLE_MATCHES',  recoverable: true,  retryStrategy: 'add_context',       maxRetries: 2 },
  FILE_NOT_FOUND:   { code: 'E_FILE_NOT_FOUND',    recoverable: true,  retryStrategy: 'search_then_retry', maxRetries: 1 },
  INVALID_PARAMS:   { code: 'E_INVALID_PARAMS',    recoverable: true,  retryStrategy: 'fix_params',        maxRetries: 2 },

  // === 可重试 — 系统级，自动重试 ===
  LLM_ERROR:        { code: 'E_LLM_ERROR',         recoverable: true,  retryStrategy: 'auto_backoff',      maxRetries: 3 },
  TOOL_TIMEOUT:     { code: 'E_TOOL_TIMEOUT',      recoverable: true,  retryStrategy: 'auto_backoff',      maxRetries: 2 },
  CMD_TIMEOUT:      { code: 'E_CMD_TIMEOUT',       recoverable: true,  retryStrategy: 'auto_backoff',      maxRetries: 1 },
  WRITE_FAILED:     { code: 'E_WRITE_FAILED',      recoverable: true,  retryStrategy: 'auto_backoff',      maxRetries: 1 },
  CMD_FAILED:       { code: 'E_CMD_FAILED',        recoverable: true,  retryStrategy: 'model_decide',      maxRetries: 0 },
};
```

**agent-loop-controller.js 中利用重试矩阵**：

```javascript
// 工具执行失败后，根据 retryStrategy 决定注入什么恢复消息
const errorDef = Object.values(ERROR_CODES).find(e => e.code === output.code);
if (errorDef) {
  if (errorDef.retryStrategy === 'none') {
    // 不可恢复，不注入重试提示
  } else if (errorDef.retryStrategy === 'reread_then_retry') {
    // 注入"重新读取文件后用精确 old_string 重试"
  } else if (errorDef.retryStrategy === 'auto_backoff') {
    // 系统自动重试，不需要模型介入
  }
  // ...
}
```

**收益**：
- 模型不需要"猜"该怎么恢复——系统直接告诉它
- `auto_backoff` 类错误不需要浪费模型的推理 token
- `none` 类错误立即中止重试，不进入循环

---

### 1.3 轨迹（Trajectory）全量记录

**当前状态**：`_recentToolCalls` 只保留最近 30 条的 `{name, argsHash}`，丢失了时间戳、耗时、成功/失败、token 消耗等维度。`_metrics` 只有聚合计数，无法回溯"第几轮调用了什么、结果是什么"。

**AgentFlow-Doc 参考**：轨迹全量记录用于合成训练数据和排查问题。

**具体改法**：

```javascript
// 文件：src/core/agent-loop-controller.js — 增加轨迹记录器

class TrajectoryRecorder {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.entries = [];
  }

  recordToolCall({ iteration, toolName, argsHash, argsSummary, elapsed_ms, success, errorCode, tokenEstimate }) {
    this.entries.push({
      ts: Date.now(),
      iteration,
      type: 'tool_call',
      tool: toolName,
      argsHash,
      argsSummary,         // 截取前 200 字符的参数摘要
      elapsed_ms,
      success,
      errorCode: errorCode || null,
      tokenEstimate: tokenEstimate || 0,
    });
  }

  recordLLMCall({ iteration, elapsed_ms, hasToolCalls, toolCallCount, contentLength }) {
    this.entries.push({
      ts: Date.now(),
      iteration,
      type: 'llm_call',
      elapsed_ms,
      hasToolCalls,
      toolCallCount,
      contentLength,
    });
  }

  // 时间维度循环检测：同一工具 30s 内被调用 5+ 次
  detectTimeBasedLoop(toolName, windowMs = 30000, threshold = 5) {
    const now = Date.now();
    const recent = this.entries.filter(e =>
      e.type === 'tool_call' && e.tool === toolName && (now - e.ts) < windowMs
    );
    return recent.length >= threshold;
  }

  // 成功/失败交替检测：success → fail → success → fail 模式
  detectAlternatingResult(toolName, depth = 6) {
    const toolEntries = this.entries.filter(e => e.type === 'tool_call' && e.tool === toolName).slice(-depth);
    if (toolEntries.length < depth) return false;
    return toolEntries.every((e, i) => e.success === (i % 2 === 0));
  }

  // 导出为 JSON（用于排查和分析看板）
  export() {
    return {
      sessionId: this.sessionId,
      totalEntries: this.entries.length,
      entries: this.entries,
    };
  }
}
```

**与循环检测的联动**：

将当前的 `_detectToolLoop()` 增加两个新模式：
- **时间维度**：`trajectory.detectTimeBasedLoop('grep_search', 30000, 5)` — 30 秒内 grep 5 次
- **交替模式**：`trajectory.detectAlternatingResult('edit_file', 6)` — edit 成功→失败→成功→失败

**收益**：
- 精确回溯"为什么循环"（不再靠猜）
- 为后续的分析看板提供数据源
- 时间维度检测比纯计数更准确（5 次调用分散在 10 分钟内 vs 集中在 10 秒内，意义完全不同）

---

### 1.4 工具级幂等检测

**当前状态**：`_successfulEdits` 在 controller 层靠 `path:hash(old_string)` 追踪，但依赖 hash 碰撞不会发生。如果模型用稍有不同的 old_string 重试同一个编辑，hash 不同，检测失效。

**具体改法**：在 `edit-file.js` handler 中直接检查文件实际状态：

```javascript
// 文件：src/tools/edit-file.js — handler 开头增加幂等检测

// 如果 old_string 不存在但 new_string 已存在 → 说明编辑已经生效过
if (content.indexOf(oldString) === -1 && content.indexOf(newString) !== -1) {
  return {
    success: true,
    alreadyApplied: true,
    code: 'OK',
    message: `This change has already been applied to ${args.path}. No modification needed.`,
    path: args.path,
  };
}
```

**收益**：
- 不依赖 hash，直接检查文件实际内容——最可靠的幂等判断
- 即使 controller 层的 `_successfulEdits` 被清空（新会话），工具层仍然能检测到
- 返回 `success: true` + `alreadyApplied: true`，模型会自然地继续下一步

---

## 阶段 2：模型适配与上下文管理（解决 Gemini 稳定性 + 记忆丢失）

### 2.1 模型适配层（Model Adapter）

**当前状态**：`llm-gateway.js` 中有分散的 `if (isGemini)` 和 `if (isCodex)` 判断（L82-107），`agent-loop-controller.js` 中有 `_isGemini()` 方法控制 stall 阈值和 JSON 修复。这些适配逻辑分散在两个文件中，每新增一个模型就要到处加 if-else。

**具体改法**：

```javascript
// 新文件：src/core/model-adapters.js

const ADAPTERS = {
  gemini: {
    match: (modelId) => /gemini/i.test(modelId),
    llmConfig: {
      temperature: 0.3,
      parallelToolCalls: false,
      toolChoiceMapping: { required: 'any' }, // Gemini 用 "any" 代替 "required"
    },
    agentConfig: {
      stallThreshold: 1,        // Gemini 更容易 stall，1 轮就介入
      jsonRepairEnabled: true,  // Gemini 经常输出畸形 JSON
      editRetryCautious: true,  // edit 失败时给更详细的恢复指令
    },
    knownQuirks: [
      'tool_call JSON 可能有尾逗号、未转义换行、单引号',
      'function calling 不稳定，可能忽略 success 信号',
      'parallel_tool_calls 必须禁用',
    ],
  },

  codex: {
    match: (modelId) => /codex/i.test(modelId),
    llmConfig: {
      temperature: 0.2,
      parallelToolCalls: false,
    },
    agentConfig: {
      stallThreshold: 2,
      jsonRepairEnabled: false,
      editRetryCautious: false,
    },
    knownQuirks: [],
  },

  claude: {
    match: (modelId) => /claude/i.test(modelId),
    llmConfig: {
      // Claude 默认配置即可
    },
    agentConfig: {
      stallThreshold: 2,
      jsonRepairEnabled: false,
      editRetryCautious: false,
    },
    knownQuirks: [],
  },

  // 默认（OpenAI GPT、DeepSeek 等）
  default: {
    match: () => true,
    llmConfig: {},
    agentConfig: {
      stallThreshold: 2,
      jsonRepairEnabled: false,
      editRetryCautious: false,
    },
    knownQuirks: [],
  },
};

function getAdapter(modelId) {
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    if (name !== 'default' && adapter.match(modelId)) return { name, ...adapter };
  }
  return { name: 'default', ...ADAPTERS.default };
}

module.exports = { getAdapter, ADAPTERS };
```

**改动范围**：
- `llm-gateway.js`：`streamChat` 方法开头调用 `getAdapter(modelId)`，替换所有 `if (isGemini)` / `if (isCodex)` 判断
- `agent-loop-controller.js`：构造函数中 `this._adapter = getAdapter(modelId)`，替换 `_isGemini()` 方法

**收益**：
- 新增模型只需在 `model-adapters.js` 加一个条目
- Gemini 的所有 quirks 集中管理，不散落在业务逻辑中
- 可以暴露到前端让用户查看"当前模型的已知问题"

---

### 2.2 上下文预算管理

**当前状态**：`maxTokenBudget: 128000` 在配置中定义，但实际使用中没有真正的预算追踪。`read_file` 一次返回最多 250K 字符（约 62K tokens），3 个大文件就可能超出上下文。压缩发生在 `contextEngine` 中，但是被动的（等溢出后才压缩），不是主动的（预防性管理）。

**具体改法**：

```javascript
// 文件：src/core/agent-loop-controller.js — 增加上下文预算追踪

class ContextBudgetTracker {
  constructor(maxTokens = 128000, reserveTokens = 4096) {
    this.maxTokens = maxTokens;
    this.reserveTokens = reserveTokens;
    this.usableTokens = maxTokens - reserveTokens;
    this.currentUsage = 0;
    this.breakdown = []; // [{role, source, tokens}]
  }

  // 粗估 token 数：字符数 / 4（英文）或 / 2（中文混合）
  estimateTokens(text) {
    if (!text) return 0;
    const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
    const otherChars = text.length - cjkChars;
    return Math.ceil(cjkChars / 1.5 + otherChars / 4);
  }

  // 记录新增的 token 消耗
  track(role, source, text) {
    const tokens = this.estimateTokens(text);
    this.currentUsage += tokens;
    this.breakdown.push({ role, source, tokens });
    return tokens;
  }

  // 检查是否需要主动压缩（使用率 > 70%）
  shouldCompress() {
    return this.currentUsage > this.usableTokens * 0.7;
  }

  // 检查单次工具返回是否过大（> 可用预算的 25%）
  isToolOutputTooLarge(tokenEstimate) {
    return tokenEstimate > this.usableTokens * 0.25;
  }

  // 获取剩余预算
  remaining() {
    return Math.max(0, this.usableTokens - this.currentUsage);
  }
}
```

**在 agent-loop-controller 中使用**：

```javascript
// 工具结果返回后
const tokenEstimate = this._budget.track('tool', result.toolName, content);

// 如果单次返回过大（>25% 预算），主动截断并提示
if (this._budget.isToolOutputTooLarge(tokenEstimate)) {
  content = this._smartTruncate(content);
  content += `\n[Context Budget] This output was truncated to save context. Use grep_search for targeted access.`;
}

// 每轮迭代结束后检查是否需要主动压缩
if (this._budget.shouldCompress()) {
  await this._proactiveCompress(); // 保留最近 2 轮原文，旧的压缩为摘要
}
```

**收益**：
- 从"被动溢出压缩"变为"主动预算管理"
- 避免读 3 个大文件后上下文爆满、模型忘记之前的 edit 结果
- `token_estimate` 数据也会写入轨迹记录，用于分析哪些操作最耗上下文

---

### 2.3 Rollout 护栏参数化

**当前状态**：`maxIterations: 60` 是唯一的全局护栏。缺少的关键护栏：
- 每个文件的最大 edit 重试次数（当前用 `_editFailStreak` 全局计数，应改为按文件）
- 每轮最大并行工具数（当前无限制）
- 每个会话的工具调用总预算

**AgentFlow-Doc 参考**：`max_turns / max_retries / max_workers / available_tools / parallel`。

**具体改法**：

```javascript
// 文件：src/core/agent-loop-controller.js — config 中增加护栏参数

this.config = {
  maxIterations: config.maxIterations || 60,
  maxTokenBudget: config.maxTokenBudget || 128000,
  responseTokenReserve: config.responseTokenReserve || 4096,

  // 新增护栏
  guardrails: {
    maxToolCallsPerIteration: 10,     // 单轮最多调用 10 个工具
    maxToolCallsTotal: 300,           // 整个会话最多 300 次工具调用
    maxEditRetriesPerFile: 3,         // 每个文件最多 edit 失败 3 次后降级 write
    maxReadRetriesPerFile: 3,         // 每个文件最多读 3 次（短路后续调用）
    maxConsecutiveSameToolCalls: 4,   // 连续调同一工具 4 次触发循环检测
    sessionTTL: 3600000,             // 会话最大存活 1 小时
  },
  ...config,
};
```

**与现有机制的关系**：
- `maxEditRetriesPerFile: 3` 替换当前的 `_editFailStreak`（全局 → 按文件）
- `maxReadRetriesPerFile: 3` 替换当前的 `_fileReadCounts` 判断（阈值从硬编码变为可配置）
- `maxConsecutiveSameToolCalls: 4` 和 `_detectToolLoop` 的 Pattern 2 对应

**收益**：
- 所有护栏集中配置，可按项目/模型调整
- 测试时可以设极端值验证边界行为

---

## 阶段 3：会话治理与安全（长期稳定性）

### 3.1 会话生命周期管理

**当前状态**：`SessionMemoryStore` 只做持久化存储，没有生命周期概念。会话没有 TTL、没有 warmup/cleanup 阶段、没有僵尸检测。如果一个会话 crash 了，内存中的状态（`_successfulEdits`、`_fileReadCounts` 等）全部丢失，但磁盘上的 summary 还在，可能导致不一致。

**AgentFlow-Doc 参考**：`warmup / initialize / cleanup / shutdown` + TTL 自动回收。

**具体改法**：

```javascript
// 文件：src/core/session-lifecycle.js（新建）

const LIFECYCLE_STATES = {
  CREATED: 'created',
  WARMING_UP: 'warming_up', // 加载记忆、恢复状态
  ACTIVE: 'active',
  PAUSED: 'paused',         // 用户不活跃
  CLEANING_UP: 'cleaning_up',
  TERMINATED: 'terminated',
};

class SessionLifecycle {
  constructor({ sessionId, memoryStore, ttl = 3600000 }) {
    this.sessionId = sessionId;
    this.memoryStore = memoryStore;
    this.ttl = ttl;
    this.state = LIFECYCLE_STATES.CREATED;
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    this._ttlTimer = null;
  }

  async warmup() {
    this.state = LIFECYCLE_STATES.WARMING_UP;
    const memory = this.memoryStore.getSummary(this.sessionId);
    this.state = LIFECYCLE_STATES.ACTIVE;
    this._startTTLTimer();
    return memory;
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  isExpired() {
    return Date.now() - this.lastActivityAt > this.ttl;
  }

  async cleanup() {
    this.state = LIFECYCLE_STATES.CLEANING_UP;
    if (this._ttlTimer) clearTimeout(this._ttlTimer);
    // 保存最终状态到磁盘
    this.state = LIFECYCLE_STATES.TERMINATED;
  }

  _startTTLTimer() {
    this._ttlTimer = setInterval(() => {
      if (this.isExpired()) {
        this.cleanup();
      }
    }, 60000); // 每分钟检查一次
  }
}
```

**收益**：
- 自动清理超时会话，防止内存泄漏
- warmup 阶段可以预加载记忆，减少首次交互延迟
- 状态机便于监控和排查"为什么这个会话卡住了"

---

### 3.2 write_file 大文件写保护

**共识阈值**：`>500 行 + <30%` 比例时触发警告（不硬拦截）。

**具体改法**：

```javascript
// 文件：src/tools/write-file.js — handler 中增加保护

if (fs.existsSync(fullPath)) {
  const existing = fs.readFileSync(fullPath, 'utf-8');
  const existingLines = existing.split('\n').length;
  const newLines = args.content.split('\n').length;

  if (existingLines > 500) {
    const ratio = args.content.length / existing.length;
    if (ratio < 0.3) {
      // 不硬拦截，返回成功但附带强警告
      // 同时在 meta 中标记，让 controller 注入系统消息
      return {
        success: true,
        path: args.path,
        bytesWritten: Buffer.byteLength(args.content, 'utf-8'),
        warning: `CAUTION: Original file had ${existingLines} lines but new content has only ${newLines} lines (${Math.round(ratio * 100)}% of original size). Verify this is intentional and not a partial overwrite.`,
        possiblePartialOverwrite: true,
      };
    }
  }
}
```

**controller 层处理**：

```javascript
if (result.toolName === 'write_file' && result.output?.possiblePartialOverwrite) {
  this.messages.push({
    role: 'system',
    content: result.output.warning + ' If you intended to significantly reduce the file, this is fine. If not, use read_file to get the full content and retry.',
  });
}
```

---

### 3.3 删除 _smartApply（对齐 Cursor 极简哲学）

**共识**：当前阈值已提高到 70%/60%，但残留风险仍在。Cursor 的原则是"宁可失败也不乱改"。

**具体改法**：
- 删除 `edit-file.js` 中的 `_smartApply` 方法（约 50 行）
- 删除 handler 中调用 `_smartApply` 的 fallback 代码块
- 保留 `_findNearestSnippet`（仅用于失败提示，不做实际替换）

**改动后的匹配失败处理**：

```javascript
if (!matchResult.found) {
  const response = {
    success: false,
    error: matchResult.error,
    code: matchResult.code,
  };
  if (matchResult.code === 'E_MULTIPLE_MATCHES') {
    response.hint = 'Include more surrounding lines to uniquely identify the edit location.';
  } else if (matchResult.code === 'E_MATCH_NOT_FOUND') {
    response.hint = 'Re-read the file to get exact content, then retry with precise old_string.';
    response.suggestReadBack = true;
    const snippet = this._findNearestSnippet(content, oldString);
    if (snippet) response.nearestContent = snippet;
  }
  return response;
}
```

---

### 3.4 后端扩展边界清晰化

**当前状态**：21 个工具全部在同一层注册和执行。`browser_use`（重型，需要浏览器实例）和 `read_file`（轻型，纯 I/O）共享同一个超时和执行模型。`task_delegation`（启动子 Agent）的复杂度远高于其他工具。

**AgentFlow-Doc 参考**：区分"轻量工具"（本地 I/O）和"重型 backend"（网络/子进程）。

**具体改法**：

```javascript
// 文件：src/tools/index.js — 按类型分类注册

const TOOL_TIERS = {
  // Tier 1: 纯本地 I/O，<100ms，无副作用风险
  local_readonly: ['read_file', 'grep_search', 'glob_search', 'list_directory', 'read_lints'],

  // Tier 2: 本地 I/O + 文件修改，<1s，有副作用
  local_write: ['write_file', 'edit_file', 'delete_file', 'reapply'],

  // Tier 3: 子进程/网络，耗时不确定
  external: ['run_terminal_cmd', 'web_search', 'web_fetch', 'browser_use', 'generate_image'],

  // Tier 4: 控制面（影响 Agent 自身行为）
  control: ['todo_manager', 'task_delegation', 'ask_question', 'switch_mode', 'diff_history', 'git_operations'],
};
```

**收益**：
- 不同 tier 设不同默认超时、重试策略、并行策略
- Tier 1 可以放心并行，Tier 2 必须串行，Tier 3 单独超时管理
- 新增工具时只需选择 tier，继承该 tier 的治理规则

---

## 保留现有防线清单（执行任何改动时必须保留）

以下机制已上线且经过验证，任何重构/新增都不得破坏：

| 机制 | 文件:行号 | 作用 |
|------|-----------|------|
| `_successfulEdits` Map | `agent-loop-controller.js:76, 443, 472` | 检测"已成功 edit 后重复尝试" |
| `delete parsed.explanation` | `agent-loop-controller.js:595` | grep/read 循环检测不被 explanation 干扰 |
| Pattern 2 工具名频率检测 | `agent-loop-controller.js:1256` | 同一工具 4+/6 次即判循环 |
| edit 成功后 read 计数重置 | `agent-loop-controller.js:475` | 允许重读已修改的文件 |
| `_editFailStreak` 3 次降级 | `agent-loop-controller.js:461-466` | edit 连续失败 3 次 → 提示 write_file |
| `_repairToolArgs()` JSON 修复 | `agent-loop-controller.js:1286+` | Gemini 畸形 JSON 自动修复 |
| read_file 短路（>3 次） | `agent-loop-controller.js:916-930` | 防止同一文件被反复读取 |

---

## 落地顺序总结

| 阶段 | 内容 | 预计工作量 | 对当前痛点的帮助 |
|------|------|-----------|----------------|
| **1.1** | 统一工具返回协议 | 中（需改 tool-executor + 适配各工具） | 高（循环检测、前端展示、预算管理的基础） |
| **1.2** | 错误码重试矩阵 | 小（改 error-codes + controller 分支） | 高（直接减少盲重试循环） |
| **1.3** | 轨迹记录 | 小（新建 recorder + 接入 controller） | 高（排查循环原因、验证其他改动效果） |
| **1.4** | 工具级幂等检测 | 小（改 edit-file handler） | 高（彻底解决"edit 成功后重复"问题） |
| **2.1** | 模型适配层 | 中（新建 adapter + 改 gateway/controller） | 高（Gemini 稳定性系统化） |
| **2.2** | 上下文预算管理 | 中（新建 tracker + 改 controller） | 高（解决"记忆丢失"根因） |
| **2.3** | Rollout 护栏参数化 | 小（改 config + 替换硬编码） | 中（所有护栏集中配置） |
| **3.1** | 会话生命周期 | 中（新建 lifecycle + 改 IPC） | 中（防僵尸会话、内存泄漏） |
| **3.2** | write_file 写保护 | 小（改 write-file handler） | 中（防大文件误覆写） |
| **3.3** | 删除 smartApply | 小（删 50 行 + 改 fallback） | 中（消除残留误匹配风险） |
| **3.4** | 工具分层 | 小（改 index.js 分类） | 低（架构改善，非急迫） |
