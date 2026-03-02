# Agent E2E Alignment Checklist (Cursor Parity)

This checklist defines end-to-end behavior targets for Agent mode and maps each target to an executable integration test.

## 1. Approval Flow

Acceptance criteria:
- High-risk/medium-risk tool calls must pause execution and emit `approval-needed`.
- Agent must resume exactly once after approval and continue the same run.
- State transitions must include `awaiting_approval -> executing_tools`.

Test coverage:
- `E2E-01` in [tests/agent-e2e-alignment.test.js](/e:/COPY/cursor(V10)/tests/agent-e2e-alignment.test.js:83)

## 2. Pause/Resume Flow

Acceptance criteria:
- Interactive tool (`ask_question`) must pause execution and emit `ask-question`.
- Agent must resume after user response and inject answers into context.
- Run should complete without restarting session.

Test coverage:
- `E2E-02` in [tests/agent-e2e-alignment.test.js](/e:/COPY/cursor(V10)/tests/agent-e2e-alignment.test.js:138)

## 3. Long-Session Convergence

Acceptance criteria:
- Agent must converge under max-iteration constraints (no infinite loop).
- On unresolved TODOs at convergence boundary, Agent must emit `incomplete` with `maxIterationsReached=true`.
- A final conclusion pass must still be attempted before termination.

Test coverage:
- `E2E-03` in [tests/agent-e2e-alignment.test.js](/e:/COPY/cursor(V10)/tests/agent-e2e-alignment.test.js:194)

## 4. Tool Concurrency Strategy

Acceptance criteria:
- Codex-class models execute safe tools serially (chain stability first).
- Non-codex models may batch safe tools in parallel.
- Both modes must preserve run completion semantics.

Test coverage:
- `E2E-04` in [tests/agent-e2e-alignment.test.js](/e:/COPY/cursor(V10)/tests/agent-e2e-alignment.test.js:238)
- `E2E-05` in [tests/agent-e2e-alignment.test.js](/e:/COPY/cursor(V10)/tests/agent-e2e-alignment.test.js:279)

## Execution

- Single suite: `node tests/agent-e2e-alignment.test.js`
- Full test pipeline: `npm run test`
