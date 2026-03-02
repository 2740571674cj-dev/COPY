# Agent 稳定性修复实施方案（EditFile 失败 + 编码乱码专项）

## 1. 背景与目标

当前项目已具备 Agent 主流程能力，但在稳定性和可维护性上存在关键缺口：

1. `edit_file` 在部分场景下失败率高，且错误类型反馈不准确，导致恢复策略失效。
2. 多处中文文案出现乱码（mojibake），影响模型行为、UI 可读性与调试效率。
3. 缺少针对编辑链路的一键回归入口和关键场景自动化测试。

本方案目标：

1. 将 `edit_file` 相关失败归因清晰化并显著降低失败率。
2. 清理并防止编码乱码再次进入主分支。
3. 建立“可持续回归”的测试与质量门禁。

---

## 2. 已确认问题（基于当前代码）

### 2.1 工具参数合并导致 JSON 损坏

- 文件：`src/core/llm-gateway.js`
- 现状：`tool_call.arguments` 采用字符串累加（`+=`）方式。
- 问题：当某些模型返回“累计块”而非“增量块”时，拼接后 JSON 变坏，触发 `E_INVALID_JSON`。
- 影响：`edit_file`/`write_file` 等工具会被误判为调用失败。

### 2.2 `edit_file` 错误类型被覆盖

- 文件：`src/core/edit-fuzzy-matcher.js`
- 现状：`_exactMatch` 的 `E_MULTIPLE_MATCHES` 可能在后续策略中被覆盖为 `E_MATCH_NOT_FOUND`。
- 影响：恢复路径走错（应补上下文去唯一化，却被引导去“重读重试”）。

### 2.3 编辑后换行风格漂移（CRLF/LF 混用）

- 文件：`src/tools/edit-file.js`
- 现状：写回时不保持原文件换行风格。
- 影响：后续匹配失败概率上升，diff 噪音增多，跨平台协作不稳定。

### 2.4 控制器存在损坏文案与坏插值

- 文件：`src/core/agent-loop-controller.js`
- 现状：存在乱码文本与坏模板插值（如 `?{...}`）。
- 影响：
  - Gate/继续执行提示可读性和有效性下降。
  - 部分提示变量无法正确注入，影响 Agent 决策质量。

### 2.5 会话间 `reapply` 状态串扰风险

- 文件：`src/tools/reapply.js`
- 现状：`lastEditAttempt` 为进程级全局变量。
- 影响：多会话并行时可能误用他会话的编辑上下文。

### 2.6 测试入口与覆盖不足

- 文件：`package.json`、`tests/*`
- 现状：无统一 `npm test` 脚本；`edit_file` 关键场景缺专项回归。
- 影响：修复后难以持续防回归。

---

## 3. 修复原则

1. **先保正确性再保体验**：先修数据链路和错误分类，再做文案与交互优化。
2. **错误可判别**：同类失败必须映射到稳定错误码，供恢复策略分流。
3. **编码单一来源**：统一 UTF-8（含文档、提示词、工具输出）；禁止隐式转码。
4. **每个修复必须有回归测试**：至少 1 个失败前复现用例 + 1 个通过断言。
5. **小步快跑可回滚**：按 P0/P1/P2 分阶段合入。

---

## 4. 分阶段实施计划

## P0（高优先级，建议 1-2 天）

### P0-1 修复 `tool_call.arguments` 合并策略

- 修改文件：`src/core/llm-gateway.js`
- 实施：
  - 新增 `_mergeToolArguments(current, incoming)`。
  - 识别“累计块”与“增量块”：
    - 若 `incoming` 本身是完整 JSON 前缀并覆盖 `current`，则用 `incoming` 替换。
    - 否则按增量拼接。
  - 保留向后兼容逻辑，避免破坏现有流式模型。
- 验收：累计块/增量块/混合块都能得到可解析 JSON。

### P0-2 修复 `edit-fuzzy-matcher` 错误优先级

- 修改文件：`src/core/edit-fuzzy-matcher.js`
- 实施：
  - `findMatch` 保留“最强失败原因”：
    - 优先 `E_MULTIPLE_MATCHES`
    - 次级 `E_MATCH_NOT_FOUND`
  - 返回附加元信息（`candidateCount` 可选）供后续恢复策略使用。
- 验收：多匹配场景必须稳定返回 `E_MULTIPLE_MATCHES`。

### P0-3 保持文件原始换行风格

- 修改文件：`src/tools/edit-file.js`
- 实施：
  - 读取时检测 EOL 风格（CRLF 或 LF）。
  - 写回前将 `new_string` 与拼接结果归一到目标文件风格。
  - 保留 `write verification` 校验。
- 验收：CRLF 文件编辑后仍为 CRLF，不出现混合换行。

### P0-4 清理控制器损坏文案与坏插值

- 修改文件：`src/core/agent-loop-controller.js`
- 实施：
  - 清除乱码中文文案（优先状态提示、gate 提示、结束语）。
  - 修复坏模板插值（`?{...}` -> `${...}`）。
  - 保证语义不变，仅修可读性与变量注入正确性。
- 验收：状态提示可读、插值生效、回归测试通过。

### P0-5 增加统一测试入口

- 修改文件：`package.json`
- 实施：
  - 增加 `"test": "powershell -ExecutionPolicy Bypass -File tests/run-tests.ps1"`。
- 验收：`npm run test` 在本机稳定执行。

---

## P1（中优先级，建议 2-3 天）

### P1-1 `reapply` 会话隔离

- 修改文件：`src/tools/reapply.js`、`src/tools/edit-file.js`、调用上下文
- 实施：
  - 将全局 `lastEditAttempt` 改为按 `sessionId` 存储。
  - 会话结束后释放对应缓存。
- 验收：并行会话下不会出现交叉复用。

### P1-2 `edit_file` 失败恢复增强（代码级）

- 修改文件：`src/tools/edit-file.js`、`src/prompts/recovery-prompt.js`
- 实施：
  - 对 `E_MULTIPLE_MATCHES` 返回更明确指导（需要增加上下文行）。
  - 对 `E_MATCH_NOT_FOUND` 提供建议字段（如 `suggestReadBack: true`）。
- 验收：恢复路径命中率提升，重试轮次降低。

### P1-3 行号文本兼容（可选）

- 修改文件：`src/tools/edit-file.js`
- 实施：
  - 若 `old_string` 形如 `123|code`，先尝试去行号后匹配。
- 验收：从 `read_file` 复制片段导致的失败显著下降。

---

## P2（优化阶段，持续）

### P2-1 编码巡检与预防机制

- 新增：`scripts/check-encoding-mojibake.mjs`
- 实施：
  - 扫描高风险乱码特征（可配置白名单）。
  - 在 CI 中加入检查，阻止新乱码入库。

### P2-2 可观测性指标

- 修改文件：`src/core/agent-loop-controller.js` 等
- 新增指标：
  - `editInvalidJsonArgsCount`
  - `editMultipleMatchesCount`
  - `editEolNormalizedCount`
  - `encodingWarningCount`
- 在 UI/日志展示关键计数，支持持续优化。

---

## 5. 测试计划

## 5.1 新增/补强单元测试

- `tests/llm-gateway.test.js`
  - 累计参数块 + 增量参数块 + 混合参数块。
- `tests/edit-file.test.js`（新增）
  - 多匹配返回 `E_MULTIPLE_MATCHES`。
  - CRLF 文件编辑后保持 CRLF。
  - 行号文本兼容（若实现）。
- `tests/agent-loop-controller.test.js`
  - 校验提示插值和关键状态文案不损坏。

## 5.2 回归验证

1. `npm run test`
2. `npm run check`
3. 手工回归：
   - 连续 10 次 `edit_file`（含重复匹配、CRLF 文件、长文件）
   - 中断后继续执行
   - 中文 UI 全链路检查（工具卡片、状态栏、错误提示）

---

## 6. 风险与回滚

### 风险

1. 参数合并策略变更可能影响少数旧模型流式行为。
2. EOL 归一逻辑若实现不严谨，可能影响二进制/特殊文本文件。
3. 文案修复涉及控制器较大文件，需防止误改逻辑。

### 回滚策略

1. 每个 P0 子项单独提交，出现回归可按子项回滚。
2. 合并策略保留旧路径兜底（feature flag 可选）。
3. 关键修复后立即跑全量测试与构建检查，失败即停止后续合并。

---

## 7. 交付定义（DoD）

满足以下条件才算本轮完成：

1. `edit_file` 多匹配场景不再误报 `not found`。
2. 累计参数块场景工具参数 JSON 可稳定解析。
3. CRLF 文件编辑后保持原换行风格。
4. `agent-loop-controller` 中关键提示无乱码、无坏插值。
5. `npm run test` 与 `npm run check` 全绿。
6. 新增测试可覆盖上述修复点。

---

## 8. 推荐执行顺序（落地版）

1. `llm-gateway` 参数合并修复 + 测试。
2. `edit-fuzzy-matcher` 错误优先级修复 + 测试。
3. `edit-file` EOL 保真修复 + 测试。
4. `agent-loop-controller` 文案与插值修复 + 回归。
5. 增加 `npm test` 入口并接入 CI。

> 建议先完成 P0 全部改动，再开始 P1；避免“局部优化掩盖基础缺陷”。
