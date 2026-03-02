/**
 * agent-e2e-alignment.test.js
 *
 * End-to-end alignment tests for Agent behavior:
 * - Approval flow
 * - Pause/resume flow
 * - Long-session convergence
 * - Tool concurrency strategy
 */
require('./_fix-console-encoding');
const assert = require('assert');

const { AgentLoopController } = require('../src/core/agent-loop-controller');
const { TodoStore } = require('../src/core/todo-store');
const { ContextEngine } = require('../src/core/context-engine');

function makeE2EController({ modelId = 'gpt-test', maxIterations = 6, todoStore = null } = {}) {
  const ctrl = new AgentLoopController({
    llmGateway: {},
    toolExecutor: {
      getDefinitions: () => [],
      getTool: () => ({ riskLevel: 'safe' }),
      execute: async () => ({ success: true }),
    },
    promptAssembler: null,
    contextEngine: new ContextEngine(),
    config: {
      maxIterations,
      todoStore: todoStore || new TodoStore(),
    },
  });

  ctrl.sessionId = `e2e-${Date.now()}`;
  ctrl.modelId = modelId;
  ctrl.iteration = 1;
  ctrl.messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'start' },
  ];
  ctrl.abortController = new AbortController();
  ctrl.tracer = {
    info: () => { },
    warn: () => { },
    startSpan: () => ({ end: () => { } }),
  };
  ctrl.anomalyLogger = {
    toolLoop: () => { },
    stall: () => { },
    llmError: () => { },
    cmdFail: () => { },
    excessiveRead: () => { },
    editFail: () => { },
    finalize: () => { },
  };

  // Keep E2E tests focused on control-flow semantics.
  ctrl._compressContextIfNeeded = () => { };
  ctrl._dynamicSkillInject = () => { };
  ctrl._tryAdvanceWorkflow = () => { };

  return ctrl;
}

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

async function runTests() {
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  PASS ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL ${t.name}`);
      console.log(`    ${e.message}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);
  process.exit(failed > 0 ? 1 : 0);
}

test('E2E-01 approval flow: high-risk tool pauses and resumes after approval', async () => {
  const ctrl = makeE2EController({ modelId: 'gpt-test', maxIterations: 4 });

  const states = [];
  let approvalEvents = 0;
  let approvedExecCount = 0;
  ctrl.setEmitter((event, data) => {
    if (event === 'state-change') states.push(data.to);
    if (event === 'approval-needed') {
      approvalEvents++;
      setTimeout(() => ctrl.handleApproval(data.toolCallId, true), 5);
    }
  });

  let llmRound = 0;
  ctrl._callLLM = async () => {
    llmRound++;
    if (llmRound === 1) {
      return {
        content: '',
        reasoning: '',
        toolCalls: [
          { id: 'tc-approve-1', function: { name: 'run_terminal_cmd', arguments: '{"command":"echo ok"}' } },
        ],
        truncated: false,
        interrupted: false,
      };
    }
    return { content: 'done', reasoning: '', toolCalls: [], truncated: false, interrupted: false };
  };

  ctrl.tools = {
    getDefinitions: () => [{ name: 'run_terminal_cmd' }],
    getTool: (name) => {
      if (name === 'run_terminal_cmd') return { riskLevel: 'medium' };
      return { riskLevel: 'safe' };
    },
    execute: async (name) => {
      if (name === 'run_terminal_cmd') {
        approvedExecCount++;
        return { success: true, stdout: 'ok', stderr: '' };
      }
      return { success: true };
    },
  };

  await ctrl._loop();

  assert.strictEqual(ctrl.state, 'complete');
  assert.strictEqual(approvalEvents, 1, 'should emit exactly one approval-needed event');
  assert.strictEqual(approvedExecCount, 1, 'approved tool should execute exactly once');
  assert.ok(states.includes('awaiting_approval'), 'state should enter awaiting_approval');
  assert.ok(states.includes('executing_tools'), 'state should return to executing_tools after approval');
});

test('E2E-02 pause/resume: ask_question waits and resumes with user response', async () => {
  const ctrl = makeE2EController({ modelId: 'gpt-test', maxIterations: 5 });

  let askEvents = 0;
  ctrl.setEmitter((event, data) => {
    if (event === 'ask-question') {
      askEvents++;
      setTimeout(() => {
        ctrl.handleQuestionResponse(data.toolCallId, { user_input: 'mock-user-response' });
      }, 5);
    }
  });

  let llmRound = 0;
  ctrl._callLLM = async () => {
    llmRound++;
    if (llmRound === 1) {
      return {
        content: '',
        reasoning: '',
        toolCalls: [
          {
            id: 'tc-ask-1',
            function: {
              name: 'ask_question',
              arguments: '{"title":"Need Input","questions":[{"id":"user_input","label":"Provide input","type":"text"}]}',
            },
          },
        ],
        truncated: false,
        interrupted: false,
      };
    }
    return { content: 'completed after user input', reasoning: '', toolCalls: [], truncated: false, interrupted: false };
  };

  ctrl.tools = {
    getDefinitions: () => [{ name: 'ask_question' }],
    getTool: () => ({ riskLevel: 'safe' }),
    execute: async () => ({
      success: true,
      awaiting_response: true,
      title: 'Need Input',
      questions: [{ id: 'user_input', label: 'Provide input', type: 'text' }],
    }),
  };

  await ctrl._loop();

  assert.strictEqual(ctrl.state, 'complete');
  assert.strictEqual(askEvents, 1, 'should emit exactly one ask-question event');
  assert.ok(
    ctrl.messages.some((m) => m.role === 'system' && /User answered the questions/.test(m.content || '')),
    'should inject user answers back into conversation after resume'
  );
});

test('E2E-03 long-session convergence: max-iteration finalization emits INCOMPLETE with unresolved todos', async () => {
  const todoStore = new TodoStore();
  todoStore.set([{ id: 't1', content: 'must finish task', status: 'pending' }]);
  const ctrl = makeE2EController({ modelId: 'gpt-test', maxIterations: 1, todoStore });

  let incompletePayload = null;
  ctrl.setEmitter((event, data) => {
    if (event === 'incomplete') incompletePayload = data;
  });

  let llmRound = 0;
  ctrl._callLLM = async (toolChoice) => {
    llmRound++;
    if (toolChoice === 'none') {
      return { content: 'final summary with unresolved work', reasoning: '', toolCalls: [], truncated: false, interrupted: false };
    }
    return {
      content: '',
      reasoning: '',
      toolCalls: [{ id: 'tc-edit-1', function: { name: 'edit_file', arguments: '{"path":"a.js","old_string":"a","new_string":"b"}' } }],
      truncated: false,
      interrupted: false,
    };
  };

  ctrl.tools = {
    getDefinitions: () => [{ name: 'edit_file' }],
    getTool: () => ({ riskLevel: 'low' }),
    execute: async () => ({ success: true, path: 'a.js' }),
  };

  await ctrl._loop();

  assert.strictEqual(ctrl.state, 'incomplete');
  assert.ok(incompletePayload, 'should emit incomplete payload');
  assert.strictEqual(incompletePayload.maxIterationsReached, true, 'should mark maxIterationsReached');
  assert.ok(llmRound >= 2, 'should include final conclusion round');
});

test('E2E-04 tool concurrency strategy: codex model executes safe tools serially', async () => {
  const ctrl = makeE2EController({ modelId: 'gpt-5-codex', maxIterations: 4 });

  let llmRound = 0;
  ctrl._callLLM = async () => {
    llmRound++;
    if (llmRound === 1) {
      return {
        content: '',
        reasoning: '',
        toolCalls: [
          { id: 'tc-read-1', function: { name: 'read_file', arguments: '{"path":"a.js"}' } },
          { id: 'tc-grep-1', function: { name: 'grep_search', arguments: '{"query":"x"}' } },
        ],
        truncated: false,
        interrupted: false,
      };
    }
    return { content: 'done', reasoning: '', toolCalls: [], truncated: false, interrupted: false };
  };

  let active = 0;
  let maxActive = 0;
  ctrl.tools = {
    getDefinitions: () => [{ name: 'read_file' }, { name: 'grep_search' }],
    getTool: () => ({ riskLevel: 'safe' }),
    execute: async (_name) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return { success: true, content: 'ok' };
    },
  };

  await ctrl._loop();

  assert.strictEqual(ctrl.state, 'complete');
  assert.strictEqual(maxActive, 1, 'codex mode should keep safe tools serial');
});

test('E2E-05 tool concurrency strategy: non-codex model parallelizes safe tools', async () => {
  const ctrl = makeE2EController({ modelId: 'gpt-4.1', maxIterations: 4 });

  let llmRound = 0;
  ctrl._callLLM = async () => {
    llmRound++;
    if (llmRound === 1) {
      return {
        content: '',
        reasoning: '',
        toolCalls: [
          { id: 'tc-read-2', function: { name: 'read_file', arguments: '{"path":"a.js"}' } },
          { id: 'tc-grep-2', function: { name: 'grep_search', arguments: '{"query":"x"}' } },
        ],
        truncated: false,
        interrupted: false,
      };
    }
    return { content: 'done', reasoning: '', toolCalls: [], truncated: false, interrupted: false };
  };

  let active = 0;
  let maxActive = 0;
  ctrl.tools = {
    getDefinitions: () => [{ name: 'read_file' }, { name: 'grep_search' }],
    getTool: () => ({ riskLevel: 'safe' }),
    execute: async (_name) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return { success: true, content: 'ok' };
    },
  };

  await ctrl._loop();

  assert.strictEqual(ctrl.state, 'complete');
  assert.ok(maxActive > 1, `non-codex mode should parallelize safe tools, got maxActive=${maxActive}`);
});

console.log('agent-e2e-alignment.test.js\n');
runTests();
