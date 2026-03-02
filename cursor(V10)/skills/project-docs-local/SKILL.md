---
name: project-docs-local
description: 强制所有计划、变更、方案等文档必须存储在本项目的 docs/ 目录中，禁止外部存储。当 Agent 需要创建实施计划、分析报告、变更记录或任何项目相关文档时自动激活。
---

# 项目文档本地化规则

## 目的

确保本项目的所有设计文档、变更方案、分析报告等始终存储在项目内部，便于版本控制和团队协作。

## 强制规则

1. **文档存储位置**：所有项目相关文档 **必须** 写入 `{projectPath}/docs/` 目录，禁止写到 brain 目录、tmp 目录或任何项目外部路径。

2. **适用文档类型**：
   - 实施计划 (`implementation_plan.md`)
   - 分析报告 (`analysis_report.md`)
   - 变更记录 / Walkthrough (`walkthrough.md`, `changelog.md`)
   - 任务清单 (`task.md`)
   - 技术方案 / 设计文档 (`*.md`)
   - Sprint 计划、对齐分析、优化蓝图等

3. **命名规范**：
   - 使用 `小写字母 + 连字符` 命名，如 `checkpoint-rollback-plan.md`
   - 日期相关文档加日期前缀：`2026-03-02-yolo-mode-walkthrough.md`

4. **目录结构**：

   ```
   {projectPath}/docs/
   ├── plans/          # 实施计划、Sprint 计划
   ├── reports/        # 分析报告、对比报告
   ├── walkthroughs/   # 变更总结、验证记录
   └── archive/        # 已完成/归档文档
   ```

5. **创建文档时**：
   - 若 `docs/` 目录不存在，自动创建
   - 若子目录不存在，自动创建
   - 文档头部必须包含标题和日期

6. **禁止操作**：
   - ❌ 将项目文档写入 `~/.gemini/antigravity/brain/` 或任何会话目录
   - ❌ 将项目文档写入 `/tmp/` 或系统临时目录
   - ❌ 将文档散落在项目根目录（应归类到 `docs/` 子目录）

## 示例

当用户要求"写一份实施计划"时：

```
✅ 正确：{projectPath}/docs/plans/checkpoint-rollback-plan.md
❌ 错误：~/.gemini/antigravity/brain/{conversationId}/implementation_plan.md
❌ 错误：{projectPath}/IMPLEMENTATION_PLAN.md（根目录散落）
```

## 迁移提示

如果发现项目根目录存在旧的文档文件（如 `AGENT_ALIGNMENT_PLAN.md`、`PARITY_90_SPRINT_PLAN.md` 等），应建议用户将其迁移到 `docs/` 目录下。
