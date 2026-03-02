# Cursor Agent 对齐分析报告

> 本文档由 Cursor Agent 在处理用户请求的过程中自动生成。
> 内容包含：(1) Cursor Agent 处理本次请求的完整流程复盘；(2) 系统提示词关键规则梳理；(3) 与当前 IDenty IDE Agent 实现的逐项对比；(4) 可对齐的改进建议。

---

## 第一部分：Cursor Agent 处理本次请求的完整流程

### 1.1 请求分析阶段

用户请求的核心意图：
- 审视当前 IDE 应用中 Agent 的处理逻辑
- 让我（Cursor Agent）自我观察，总结处理本次问题的全过程
- 整理成文档，与当前应用的 Agent 逻辑做对比，找出对齐点

**关键决策**：这是一个复杂的分析任务，涉及代码阅读、系统反思、文档撰写，符合直接执行模式（Agent Mode），无需切换到 Plan 模式。

### 1.2 工具调用序列与决策理由

| 步骤 | 工具 | 目标 | 决策理由 |
|------|------|------|----------|
| 1 | `Task`（explore 子代理） | 探索项目整体结构 | 项目完全陌生，需要快速了解全貌。使用 explore 子代理而非手动搜索，因为系统提示词要求"broadly exploring the codebase to gather context for a large task" 时使用 Task 工具 |
| 2 | `Read`（4个文件并行） | 读取核心文件：agent-loop-controller.js、prompt-assembler.js、system-base.js、mode-agent.js | 系统提示词要求"编辑/分析文件前必须先读取"，并鼓励"批量并行读取可能相关的文件" |
| 3 | `Read`（4个文件并行） | 读取补充文件：recovery-prompt.js、context-engine.js、security-layer.js、tool-executor.js | 第一批读取后发现还需要了解更多组件。继续并行读取 |
| 4 | `Read`（4个文件并行） | 读取剩余关键文件：dynamic-context-provider.js、llm-gateway.js、mode-plan.js、mode-debug.js | 补全对系统所有模块的理解 |
| 5 | `Write` | 生成本分析文档 | 用户要求输出文档。使用 Write 工具直接创建文件，而非在对话中输出大量文本 |

### 1.3 我受到的系统提示词约束

在处理本次请求时，以下系统提示词规则直接影响了我的行为：

#### A. 工具使用规则
```
- 使用专用工具而非终端命令（Read 而非 cat，Grep 而非 grep）
- 可以一次调用多个独立的工具（并行探索）
- 编辑/分析文件前必须至少使用一次 Read 工具
- NEVER use echo or other command-line tools to communicate
```

#### B. 搜索与阅读规则
```
- 广泛探索代码库时使用 Task(explore) 子代理
- 批量并行读取可能相关的文件
- 不确定时收集更多信息，倾向于自己找答案
```

#### C. 文件操作规则
```
- 优先编辑现有文件，不随意创建新文件
- 不主动创建文档文件（除非用户要求）——本次用户明确要求了文档
- 不添加只是复述代码意思的多余注释
```

#### D. 模式选择规则
```
- 任务大/模糊/有权衡时切换到 Plan 模式
- 当前模式运行良好时不切换
- 本次为分析+文档任务，Agent 模式合适，无需切换
```

#### E. 输出格式规则
```
- 使用 markdown 格式化回复
- 用反引号格式化文件名、目录名、函数名和类名
- 代码引用使用 startLine:endLine:filepath 格式
- 新代码使用标准 markdown 代码块
- 不使用 emoji（除非用户要求）
```

#### F. 任务管理规则
```
- 复杂任务（3步以上）使用 TodoWrite 创建任务清单
- 本次为单一分析任务，步骤明确，未使用 TodoWrite
```

---

## 第二部分：Cursor Agent 系统架构全景

### 2.1 工具体系（我实际可用的工具）

| 工具 | 类型 | 用途 | IDenty 是否有对应工具 |
|------|------|------|----------------------|
| `Shell` | 执行 | 终端命令执行（git, npm, docker 等） | ✅ `run_terminal_cmd` |
| `Read` | 读取 | 读取文件内容，支持 offset/limit | ✅ `read_file` |
| `Write` | 写入 | 创建/覆盖文件 | ✅ `write_file` |
| `StrReplace` | 编辑 | 精确字符串替换，支持 replace_all | ✅ `edit_file` |
| `Delete` | 删除 | 删除文件 | ✅ `delete_file` |
| `Glob` | 搜索 | 按文件名模式搜索 | ✅ `glob_search` / `file_search` |
| `Grep` | 搜索 | 正则搜索文件内容（基于 ripgrep） | ✅ `search_files` / `grep_search` |
| `SemanticSearch` | 搜索 | **语义搜索**——按含义而非精确文本搜索代码 | ❌ **缺失** |
| `ReadLints` | 质量 | 读取 linter 错误 | ✅ `read_lints` |
| `TodoWrite` | 管理 | 任务清单管理 | ✅ `todo_write` |
| `WebSearch` | 网络 | 网络搜索 | ✅ `web_search` |
| `WebFetch` | 网络 | 获取网页内容 | ✅ `web_fetch` |
| `GenerateImage` | 生成 | 文本描述生成图片 | ✅ `generate_image` |
| `AskQuestion` | 交互 | **结构化多选题**向用户收集信息 | ❌ **缺失** |
| `Task` | 代理 | **子代理系统**——启动专门子代理处理复杂任务 | ⚠️ `task_delegation`（简化版） |
| `SwitchMode` | 模式 | **模式切换**——在模式间切换 | ⚠️ 有模式但缺模式间主动切换 |
| `EditNotebook` | 编辑 | Jupyter Notebook 编辑 | ❌ **缺失** |

### 2.2 子代理系统（Task 工具的核心能力）

Cursor 的 Task 工具是一个**子代理调度系统**，支持多种子代理类型：

| 子代理类型 | 用途 | 特点 |
|-----------|------|------|
| `generalPurpose` | 通用任务 | 研究复杂问题、搜索代码、多步骤任务 |
| `explore` | 代码探索 | **快速**专门用于探索代码库，查找文件模式，搜索关键词 |
| `shell` | 命令执行 | 专门执行 bash 命令、git 操作 |
| `browser-use` | 浏览器自动化 | 网页测试、UI 验证、表单交互 |

关键设计特点：
- **并发启动**：可同时启动最多 4 个子代理
- **模型选择**：每个子代理可选择不同模型（`fast` 用于简单任务）
- **可恢复**：通过 `resume` 参数恢复之前的子代理上下文
- **只读模式**：子代理可以 readonly 模式运行
- **隔离上下文**：子代理无法看到用户消息或父 agent 的先前步骤

### 2.3 系统提示词结构

Cursor Agent 的系统提示词由以下模块化片段组成（按注入顺序）：

```
1. [用户信息] OS、Shell、工作区路径、Git 状态、日期
2. [代理记录] 过往对话的 JSONL 日志引用
3. [技能系统] 可用技能清单及路径
4. [打开的文件] 当前 IDE 中打开的文件列表
5. [核心人格] 你是 AI 编程助手，在 Cursor 中运行
6. [工具定义] 每个工具的完整 JSON Schema + 使用规则
7. [系统通讯] system_reminder 标签处理规则
8. [语气风格] 不用 emoji、不用冒号引出工具调用
9. [工具调用] 并行 vs 顺序调用规则
10. [代码修改] 先读后写、不加多余注释、修 lint 错误
11. [禁止思考注释] 不在代码/命令注释中暴露推理过程
12. [Lint 检查] 编辑后检查、只修自己引入的错误
13. [代码引用格式] CODE REFERENCES vs MARKDOWN CODE BLOCKS 格式规范
14. [行号元数据] LINE_NUMBER|LINE_CONTENT 格式说明
15. [终端文件] 终端状态文件的读取方式
16. [任务管理] TodoWrite 使用规则
17. [模式选择] 何时切换模式的指导
```

### 2.4 Cursor Agent 的模式体系

| 模式 | 能力 | 切换条件 |
|------|------|----------|
| **Agent** | 完整工具访问，可读写 | 默认模式 |
| **Plan** | 只读协作，设计方案 | 任务有多种方案、涉及架构决策、需求不明确 |
| **Ask** | 只读，回答问题 | 纯探索/问答 |
| **Debug** | 系统性排查 | 调查 bug、异常行为 |

关键区别：Agent 只能**主动切换到 Plan 模式**，其他模式需要用户触发。

---

## 第三部分：逐项对比与改进建议

### 3.1 🔴 缺失能力（建议新增）

#### 3.1.1 语义搜索（SemanticSearch）

**Cursor 实现**：
- 按含义而非精确文本搜索代码（"哪里处理用户认证？"）
- 支持限定目录范围
- 返回代码块签名和完整内容
- 与 Grep 互补：Grep 用于精确匹配，SemanticSearch 用于模糊/意图搜索

**建议**：
- 在 `src/tools/` 中新增 `semantic-search.js`
- 后端可基于 embedding 模型（如 text-embedding-3-small）实现
- 或者退而求其次，利用 LLM 自身做文件级相关性排序
- 工具定义参考：

```javascript
{
  name: 'semantic_search',
  description: '按含义搜索代码，适合探索不熟悉的代码库',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '完整的自然语言问题' },
      target_directory: { type: 'string', description: '限定搜索目录' },
      num_results: { type: 'number', default: 10, maximum: 15 },
    },
    required: ['query'],
  },
}
```

#### 3.1.2 结构化提问（AskQuestion）

**Cursor 实现**：
- 向用户提供多选题收集信息
- 每个问题有 id、prompt、options、allow_multiple
- 结构化收集避免自由文本的模糊性

**建议**：
- 在 `src/tools/` 中新增 `ask-question.js`
- 前端渲染为选择卡片 UI
- 适用场景：方案选择、配置确认、需求澄清

```javascript
{
  name: 'ask_question',
  description: '向用户提出结构化选择题',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            prompt: { type: 'string' },
            options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } } } },
            allow_multiple: { type: 'boolean', default: false },
          },
        },
      },
    },
    required: ['questions'],
  },
}
```

#### 3.1.3 Notebook 编辑（EditNotebook）

**Cursor 实现**：
- 专门编辑 Jupyter Notebook 的 cell
- 支持新建 cell 和编辑现有 cell
- 理解 cell 索引、语言类型

**建议**：如果目标用户群包含数据科学场景，可在后续版本中添加。非核心优先级。

### 3.2 🟡 已有但需增强的能力

#### 3.2.1 子代理系统升级

**当前实现**（`task_delegation.js`）：
- 支持委派任务给子代理
- 基本的代理工厂模式

**Cursor 的做法**：
- 4 种专门化子代理类型（explore、generalPurpose、shell、browser-use）
- 可并发启动最多 4 个子代理
- 每个子代理可选择不同模型（fast vs 默认）
- 子代理可以恢复（resume）
- 只读模式支持
- 子代理有独立的上下文隔离
- 明确的"什么时候该用、什么时候不该用"指导

**改进建议**：

```javascript
// src/tools/task-delegation.js 改进方向
const SUBAGENT_TYPES = {
  explore: {
    description: '快速代码探索',
    tools: ['read_file', 'grep_search', 'glob_search', 'list_directory'],
    model: 'fast', // 默认使用快速模型
    readonly: true,
  },
  generalPurpose: {
    description: '通用多步骤任务',
    tools: 'all',
    model: 'default',
  },
  shell: {
    description: '命令执行专家',
    tools: ['run_terminal_cmd'],
    model: 'fast',
  },
  'browser-use': {
    description: '浏览器自动化',
    tools: ['browser_use'],
    model: 'default',
    stateful: true, // 有状态，可恢复
  },
};
```

- 在系统提示词中添加"何时使用子代理"的指导：
  - 广泛探索代码库 → `explore`
  - 多步骤复杂任务 → `generalPurpose`
  - 简单搜索/读取 → 直接用工具，**不要**委托子代理
- 支持子代理并发启动（当前是否支持？如不支持需添加）

#### 3.2.2 模式切换机制增强

**当前实现**：
- 有 agent/ask/plan/debug 四种模式
- 模式在启动时确定，运行中不切换

**Cursor 的做法**：
- Agent 可以**主动建议**切换到 Plan 模式
- 有 `SwitchMode` 工具，Agent 自主调用
- 切换需要用户批准
- 切换时附带解释说明

**改进建议**：
1. 添加 `switch_mode` 工具定义：

```javascript
{
  name: 'switch_mode',
  description: '建议切换交互模式',
  parameters: {
    type: 'object',
    properties: {
      target_mode: { type: 'string', enum: ['plan'] },
      explanation: { type: 'string', description: '为什么需要切换' },
    },
    required: ['target_mode'],
  },
}
```

2. 在系统提示词中添加切换指导：

```
切换到 Plan 模式的场景：
- 任务有多种有效方案，需要权衡
- 需要架构决策（如"加缓存"——Redis vs 内存 vs 文件）
- 任务涉及大量文件或系统（大规模重构、迁移）
- 需求不明确，需要先探索再理解范围

不切换的场景：
- 简单明确的任务
- 正在做且进展顺利
- 单纯的澄清性问题
```

#### 3.2.3 Shell 工具的长时间命令管理

**Cursor 的做法**：
- 命令有 `block_until_ms` 参数控制阻塞时间
- 超时的命令自动移到后台
- 后台命令的输出流到终端文件
- 通过读取终端文件来监控后台命令
- 明确的轮询策略指导（指数退避）
- 可以通过 pid 杀死挂起的进程

**当前实现**（`run_terminal_cmd`）：
- 有超时机制（120s 默认）
- 缺少后台化、轮询、恢复机制

**改进建议**：
1. 为 `run_terminal_cmd` 添加 `block_until_ms` 参数
2. 超时命令移入后台，将输出写入终端文件
3. 添加终端文件读取能力
4. 在系统提示词中添加长时间命令管理指导

#### 3.2.4 Git 安全协议

**Cursor 的做法**——系统提示词中有完整的 Git 安全协议：

```
Git 安全协议：
- 绝不更新 git config
- 绝不执行破坏性/不可逆的 git 命令（如 push --force, hard reset）除非用户明确要求
- 绝不跳过 hooks（--no-verify, --no-gpg-sign）除非用户明确要求
- 绝不 force push 到 main/master
- 避免 git commit --amend，仅在以下所有条件满足时使用：
  1. 用户明确要求 amend，或提交成功但 pre-commit hook 自动修改了文件
  2. HEAD 提交是本次对话中创建的
  3. 提交还未推送到远程
- 提交失败或被 hook 拒绝时，绝不 amend——修复后创建新提交
- 不主动提交，只在用户明确要求时才提交
```

**当前实现**：
- `security-layer.js` 有危险命令检测
- 但缺少上述 git 专属安全规则

**改进建议**：
1. 在 `system-base.js` 或 `mode-agent.js` 中添加 Git 安全协议段
2. 在 `security-layer.js` 的 `DANGEROUS_COMMANDS` 中添加 git-specific 规则
3. 在 `git-operations.js` 工具中实现安全检查逻辑

#### 3.2.5 PR 创建协议

**Cursor 的做法**：
- 系统提示词中有完整的 PR 创建步骤
- 使用 `gh` CLI 工具
- 明确的步骤：检查状态 → 分析变更 → 创建分支 → 推送 → 创建 PR
- PR body 使用 HEREDOC 格式
- 明确的输出格式（Summary + Test plan）

**改进建议**：在系统提示词中添加标准化的 PR 创建流程。

### 3.3 🟢 系统提示词细节对齐

#### 3.3.1 工具调用中的通信规范

**Cursor 的规则**（当前缺失）：

```
- 跟用户说话时不提工具名——说自然语言
- 不用冒号引出工具调用（"让我看看这个文件。"而非"让我看看这个文件："）
- 绝不用 echo 或其他命令行工具来传达想法
- 工具调用可能不会直接显示，所以文本要自成一体
```

**当前状态**：`system-base.js` 第 17-18 行已有类似规则，但不够具体。

**建议增补**：
```
- 不要用冒号引出工具调用。"让我看看这个文件。"而非"让我看看这个文件："
- 工具调用的结果可能不对用户直接可见，所以你的文本回复要能独立阅读
- 绝不在 Shell 命令注释中暴露推理过程（# 这里我需要先检查... ← 禁止）
```

#### 3.3.2 代码引用格式规范

**Cursor 的规则**（当前完全缺失）：

Cursor 有两种代码展示模式：
1. **CODE REFERENCES**：引用已存在于代码库中的代码，格式为 `` ```startLine:endLine:filepath ``
2. **MARKDOWN CODE BLOCKS**：展示新的/建议的代码，格式为 `` ```language ``

这是 Cursor 系统提示词中最长的规则段之一，目的是让代码引用在 IDE 中能正确渲染为可点击跳转的链接。

**改进建议**：
- 如果你的 IDE 前端支持代码引用跳转，添加类似格式规范
- 如果不支持，可简化为要求用 ` `` ` 格式化路径/函数名

#### 3.3.3 行号元数据处理

**Cursor 的规则**：

```
代码块中可能包含 LINE_NUMBER|LINE_CONTENT 格式的行号。
将 LINE_NUMBER| 前缀视为元数据，不要将其视为实际代码的一部分。
```

**当前状态**：`read_file` 返回的内容已包含行号，但系统提示词中未明确告知模型如何处理。

**建议**：在系统提示词中添加行号处理说明，避免模型在编辑时意外包含行号前缀。

#### 3.3.4 用户信息注入

**Cursor 的做法**：
在系统提示词开头注入以下用户环境信息：
```
OS Version: win32 10.0.19045
Shell: powershell
Workspace Path: d:\IDenty-main\cursor-launcher
Is directory a git repo: No
Today's date: Saturday Feb 21, 2026
```

**当前状态**：`prompt-assembler.js` 在 Layer 6 注入了 `projectPath`，但缺少 OS、Shell、日期等信息。

**改进建议**：
在 `DynamicContextProvider` 或 `PromptAssembler` 中添加系统环境信息收集：

```javascript
_formatUserInfo({ projectPath, osInfo }) {
  return `<user_info>
OS: ${osInfo.platform} ${osInfo.release}
Shell: ${osInfo.shell}
Workspace: ${projectPath}
Git repo: ${osInfo.isGitRepo ? 'Yes' : 'No'}
Date: ${new Date().toLocaleDateString('zh-CN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
</user_info>`;
}
```

#### 3.3.5 终端状态文件系统

**Cursor 的做法**：
- 每个终端实例对应一个文本文件（如 `3.txt`）
- 文件包含 pid、cwd、最近命令、当前运行命令、完整输出
- Agent 通过读取这些文件来监控长时间运行的命令

**当前状态**：`run_terminal_cmd` 直接执行并等待结果，缺少持久化终端状态。

**改进建议**：
1. 创建终端状态管理模块 `src/core/terminal-state-manager.js`
2. 每个命令执行创建/更新终端文件
3. 添加 `read_terminal` 工具供 Agent 读取终端状态

### 3.4 🔵 Agent Loop 控制层对比

#### 3.4.1 完成门检查（Completion Gate）

**IDenty 当前实现** ✅ 已实现，且做得很好：
- Todo 完成度检查
- 工具调用失败检查
- 文件变更验证检查
- Lint 检查完整性
- 进度合理性检查

**与 Cursor 的差异**：
Cursor **没有**显式的 Completion Gate 机制。Cursor 的完成判断完全依赖模型自身的判断 + 系统提示词中的规则（"不要在 todo 未完成时结束"）。

**评价**：IDenty 的 Completion Gate 是一个**优于 Cursor 的设计**。保留并继续完善。

#### 3.4.2 停滞检测（Stall Detection）

**IDenty 当前实现** ✅ 已实现：
- 检测连续纯文本回复（无工具调用）
- 相似内容检测
- 自动注入 nudge 消息
- 强制 tool_choice=required

**与 Cursor 的差异**：
Cursor 没有显式的停滞检测。Cursor 依赖模型智能和系统提示词来避免停滞。

**评价**：这也是 IDenty **优于 Cursor 的设计**。保留。

#### 3.4.3 上下文压缩（Context Compression）

**IDenty 当前实现** ✅ 已实现：
- Token 预算监控
- 保留系统消息、用户消息、关键系统消息
- 压缩中间消息（保留最近 40%）
- 提取文件变更和关键决策摘要
- Todo 进度注入

**与 Cursor 的差异**：
Cursor 的上下文管理对 Agent 开发者不透明（在底层实现），但从系统提示词的大小（非常长且详细）来看，Cursor 也有类似的上下文管理。

**评价**：实现合理，可继续优化压缩策略。建议：被压缩的工具调用结果可以保留工具名和状态（成功/失败），而不仅仅是文件变更列表。

#### 3.4.4 Read Coverage Index

**IDenty 当前实现** ✅ 已实现：
- 记录已读取的文件+行范围
- 重复读取时短路返回缓存内容
- 文件修改后失效缓存

**与 Cursor 的差异**：
Cursor 没有暴露类似的机制给 Agent 层，但底层可能有类似优化。

**评价**：这是 IDenty 的**独特优势**。保留并完善。

#### 3.4.5 工作流匹配（Workflow Matching）

**IDenty 当前实现** ✅ 已实现：
- 用户消息匹配预定义工作流
- 工作流步骤自动推进
- 与 todo_write 集成的 step_id

**与 Cursor 的差异**：
Cursor 没有类似的工作流匹配系统。Cursor 完全依赖 LLM 自身的规划能力。

**评价**：对于特定高频任务（如"创建 React 组件"、"添加 API 端点"），工作流匹配可以显著提升一致性。保留。

### 3.5 系统提示词结构对比

| 层级 | Cursor | IDenty | 差距 |
|------|--------|--------|------|
| 用户环境信息 | OS/Shell/Date/Git 状态 | 仅 projectPath | 需补充 |
| 核心身份 | AI coding assistant in Cursor | AI 编程助手集成在 IDE 中 | ✅ 一致 |
| 工具定义 | 每个工具的 JSON Schema + 详细使用指南内嵌于工具描述 | 工具定义和使用指南分离 | 可优化 |
| 通信规范 | 详细的格式/语气/emoji 规则 | 基本规则 | 需细化 |
| 代码修改规则 | 先读后写 + 不加多余注释 + 修 lint | ✅ 一致 | - |
| Lint 检查 | 详细的 lint 策略 | ✅ 一致 | - |
| 代码引用格式 | 非常详细的双模式格式规范 | 无 | 可选加 |
| 任务管理 | 详细的 TodoWrite 使用指南 | ✅ 一致 | - |
| Git 安全 | 完整的 Git 安全协议 | 仅有危险命令检测 | 需补充 |
| PR 创建 | 完整的 PR 创建流程 | 无 | 需补充 |
| 长时间命令 | block_until_ms + 后台化 + 终端文件 | 仅超时 | 需增强 |
| 模式切换指导 | 详细的何时切换指导 | 无 | 需补充 |
| 搜索策略 | 详细的搜索与阅读策略 | ✅ 一致 | - |
| 错误恢复 | ✅ 类似 | ✅ 已有 | - |
| 技能系统 | 可扩展的 Agent Skills | 无 | 可选加 |
| 对话记录 | Agent transcripts 引用 | Session memory | 不同但各有优势 |

---

## 第四部分：改进优先级建议

### P0 - 立即可做（影响大、实现简单）

1. **系统提示词增补**：
   - 添加用户环境信息（OS、Shell、日期）到 prompt 开头
   - 添加 Git 安全协议
   - 添加工具调用通信规范（不提工具名、不用冒号引出）
   - 添加行号元数据处理说明
   - 添加模式切换指导

2. **edit_file 的 replace_all 参数**：
   Cursor 的 StrReplace 支持 `replace_all` 参数，可以一次替换所有匹配项。这对于变量重命名等场景非常有用。当前 `edit_file` 是否支持此能力？如不支持，建议添加。

### P1 - 短期可做（影响大、需要一定开发量）

3. **结构化提问工具（AskQuestion）**：
   - 前端渲染选择卡片
   - 适用于方案选择、配置确认
   - 实现简单，体验提升明显

4. **子代理系统增强**：
   - 明确子代理类型（explore/generalPurpose/shell）
   - 支持并发启动
   - 支持只读模式
   - 添加模型选择能力

5. **模式切换工具（SwitchMode）**：
   - 允许 Agent 在执行中主动建议切换到 Plan 模式
   - 需要用户确认
   - 前端展示模式切换确认 UI

### P2 - 中期可做（有价值但复杂度高）

6. **语义搜索工具（SemanticSearch）**：
   - 需要 embedding 模型支持
   - 需要文件索引构建
   - 可考虑先用简化方案（LLM 排序）

7. **终端状态持久化**：
   - 长时间命令后台化
   - 终端文件系统
   - 轮询监控机制

8. **PR 创建标准化流程**：
   - 在系统提示词中添加
   - 在 `git-operations.js` 中集成 `gh` CLI

### P3 - 长期可做（锦上添花）

9. **Agent Skills 系统**：可扩展的技能库
10. **Notebook 编辑**：Jupyter 支持
11. **代码引用格式**：如果前端支持，添加可点击跳转的代码引用

---

## 第五部分：当前 IDenty 的独特优势（相对于 Cursor）

以下是当前实现中**优于 Cursor 的设计**，建议保留和强化：

1. **Completion Gate** — Cursor 完全依赖模型自律，IDenty 有结构化的多因素完成门检查
2. **Stall Detection** — 主动检测并打破停滞循环
3. **Read Coverage Index** — 避免重复读取，节省 token
4. **Workflow Matching** — 高频任务的标准化执行流
5. **Context Compression with Todo Progress** — 压缩时保留 todo 全量进度
6. **Edit Fail Streak Tracking** — 连续 edit 失败后自动切换策略（降级到 write_file）
7. **Smart JSON Truncation** — JSON 输出的智能截断（保持结构完整性）
8. **File Split Suggestions** — 大文件拆分建议（去重，不重复提醒）

---

## 附录：本次处理流程时序图

```
用户请求
  │
  ├─ 1. 分析意图：代码分析 + 对比 + 文档输出 → 选择 Agent 模式
  │
  ├─ 2. Task(explore) → 探索项目结构（子代理并行搜索整个代码库）
  │     └─ 返回：项目结构、核心文件列表、架构概览
  │
  ├─ 3. Read × 4（并行）→ 读取核心文件
  │     ├─ agent-loop-controller.js (1154 行)
  │     ├─ prompt-assembler.js (126 行)
  │     ├─ system-base.js (86 行)
  │     └─ mode-agent.js (107 行)
  │
  ├─ 4. Read × 4（并行）→ 读取补充文件
  │     ├─ recovery-prompt.js (48 行)
  │     ├─ context-engine.js (152 行)
  │     ├─ security-layer.js (55 行)
  │     └─ tool-executor.js (69 行)
  │
  ├─ 5. Read × 4（并行）→ 读取剩余文件
  │     ├─ dynamic-context-provider.js (147 行)
  │     ├─ llm-gateway.js (265 行)
  │     ├─ mode-plan.js (19 行)
  │     └─ mode-debug.js (21 行)
  │
  ├─ 6. 内部分析：对比 Cursor 系统提示词 vs IDenty 实现
  │     └─ 逐项对比 20+ 个维度
  │
  └─ 7. Write → 生成本文档
        └─ CURSOR_AGENT_ALIGNMENT_ANALYSIS.md
```

**工具调用统计**：
- Task(explore): 1 次
- Read: 12 次（3 批 × 4 并行）
- Write: 1 次
- 总计: 14 次工具调用

**批次效率**：通过并行调用，将 12 次文件读取压缩为 3 个批次，大幅减少轮次。

---

*文档生成时间: 2026-02-21*
*生成环境: Cursor IDE Agent Mode (claude-4.6-opus)*
