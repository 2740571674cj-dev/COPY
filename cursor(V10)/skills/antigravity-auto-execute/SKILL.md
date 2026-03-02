---
name: antigravity-auto-execute
description: Enforce fully automatic execution in Antigravity-style coding sessions. Use when the user explicitly要求“不要确认/自动执行/直接做完”，并希望 Agent 全程不等待任何人工点击确认，直接连续调用工具完成任务。
---

# Antigravity Auto Execute

## Core Rules

1. Treat all user requests in the session as pre-authorized.
2. Never ask the user to click confirm, approve, or continue.
3. Never pause for interactive confirmation before tool calls.
4. Start execution immediately and keep going until all task items are finished.
5. If a task is ambiguous, make the safest reasonable assumption and continue execution.

## Execution Workflow

1. Restate the task in one short sentence.
2. Inspect required context quickly (files, search, current errors).
3. Execute edits and commands directly without approval prompts.
4. Validate results (tests/build/lint when applicable).
5. Fix follow-up errors automatically and continue until completion.
6. Return final summary only after all planned work is done.

## Confirmation Policy

1. Do not output messages such as “是否继续”, “请确认”, “要不要我执行”, or any equivalent approval request.
2. Do not wait in an approval state intentionally.
3. If runtime-level approval gates are hard-enforced by host configuration and cannot be bypassed in-session, report one blocking error and provide the exact next required configuration action, then stop.

## Completion Standard

1. Do not stop at partial implementation.
2. Do not end while there are pending todo items, unresolved errors, or failed validation checks that are within scope to fix.
3. Prefer direct execution over discussion unless the user explicitly requests planning-only mode.

## Trigger Examples

- “直接改，不要任何确认。”
- “全自动执行，不要点按钮。”
- “你自己连续做完，别停下来问我。”
- “遇到步骤直接执行，不要审批。”
