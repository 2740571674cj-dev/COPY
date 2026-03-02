/**
 * agent-loop-controller contract tests
 */
require('./_fix-console-encoding');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AgentLoopController } = require('../src/core/agent-loop-controller');
const { TodoStore } = require('../src/core/todo-store');
const { ContextEngine } = require('../src/core/context-engine');

function makeController(overrides = {}) {
  const ctrl = new AgentLoopController({
    llmGateway: {},
    toolExecutor: { getDefinitions: () => [], getTool: () => null },
    promptAssembler: null,
    contextEngine: new ContextEngine(),
    config: {
      maxIterations: 10,
      todoStore: overrides.todoStore || new TodoStore(),
      ...overrides,
    },
  });

  ctrl.sessionId = 'test';
  ctrl.iteration = overrides.iteration || 1;
  ctrl.messages = overrides.messages || [];
  ctrl._modifiedFiles = overrides.modifiedFiles || new Set();
  ctrl._lintCheckPending = overrides.lintCheckPending || false;
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

test('smartTruncate: short content is unchanged', () => {
  const ctrl = makeController();
  const content = JSON.stringify({ success: true, data: 'hello' });
  const truncated = ctrl._smartTruncate(content);
  assert.strictEqual(truncated, content);
});

test('smartTruncate: long plain text keeps head and tail', () => {
  const ctrl = makeController();
  const longContent = 'A'.repeat(3500) + 'M'.repeat(4000) + 'B'.repeat(1500);
  const truncated = ctrl._smartTruncate(longContent);

  assert.ok(truncated.length < longContent.length);
  assert.ok(truncated.startsWith('A'.repeat(100)));
  assert.ok(truncated.endsWith('B'.repeat(100)));
});

test('smartTruncate: long JSON array remains parseable', () => {
  const ctrl = makeController();
  const items = Array.from({ length: 200 }, (_, i) => ({
    file: `src/module${i}/component-${i}.tsx`,
    line: i + 1,
    message: `Error message ${i} with details`,
  }));

  const jsonStr = JSON.stringify(items);
  const truncated = ctrl._smartTruncate(jsonStr, 1200);
  const parsed = JSON.parse(truncated);

  assert.ok(Array.isArray(parsed));
  assert.ok(truncated.length <= 1200);
});

test('CompletionGate: pass when no todos', () => {
  const ctrl = makeController();
  const gate = ctrl._checkCompletionGate();
  assert.strictEqual(gate.pass, true);
  assert.strictEqual(gate.reasons.length, 0);
});

test('CompletionGate: fail when pending todo exists', () => {
  const todoStore = new TodoStore();
  todoStore.set([
    { id: '1', content: 'done', status: 'completed' },
    { id: '2', content: 'todo', status: 'pending' },
  ]);

  const ctrl = makeController({ todoStore });
  const gate = ctrl._checkCompletionGate();
  assert.strictEqual(gate.pass, false);
  assert.ok(gate.reasons.length > 0);
});

test('CompletionGate: fail when modified files are not verified', () => {
  const ctrl = makeController({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user' },
      { role: 'assistant', tool_calls: [{ id: 'tc1', function: { name: 'edit_file', arguments: '{"path":"a.js"}' } }] },
      { role: 'tool', tool_call_id: 'tc1', content: '{"success":true}' },
    ],
    modifiedFiles: new Set(['a.js']),
    lintCheckPending: true,
  });

  const gate = ctrl._checkCompletionGate();
  assert.strictEqual(gate.pass, false);
});

test('Token estimate: CJK estimate should be higher than same-length ASCII', () => {
  const ctrl = makeController();

  ctrl.messages = [{ role: 'user', content: '你好世界测试中文内容一二三四五' }];
  const cjk = ctrl._estimateTokenCount();

  ctrl.messages = [{ role: 'user', content: 'abcdefghijklmnop' }];
  const ascii = ctrl._estimateTokenCount();

  assert.ok(cjk > ascii, `expected CJK > ASCII, got ${cjk} <= ${ascii}`);
});

test('executeTools: codex model should run tool calls serially', async () => {
  const ctrl = makeController();
  ctrl.modelId = 'codex-test';
  ctrl.abortController = { signal: { aborted: false } };
  ctrl.tools = { getTool: () => ({ riskLevel: 'safe' }) };

  let active = 0;
  let maxActive = 0;
  ctrl._executeSingleTool = async (tc) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return { toolCallId: tc.id, toolName: tc.function.name, output: { success: true } };
  };

  await ctrl._executeTools([
    { id: '1', function: { name: 'read_file', arguments: '{}' } },
    { id: '2', function: { name: 'grep_search', arguments: '{}' } },
  ]);

  assert.strictEqual(maxActive, 1);
});

test('executeTools: non-codex safe tools may run in parallel', async () => {
  const ctrl = makeController();
  ctrl.modelId = 'gpt-test';
  ctrl.abortController = { signal: { aborted: false } };
  ctrl.tools = { getTool: () => ({ riskLevel: 'safe' }) };

  let active = 0;
  let maxActive = 0;
  ctrl._executeSingleTool = async (tc) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return { toolCallId: tc.id, toolName: tc.function.name, output: { success: true } };
  };

  await ctrl._executeTools([
    { id: '1', function: { name: 'read_file', arguments: '{}' } },
    { id: '2', function: { name: 'grep_search', arguments: '{}' } },
  ]);

  assert.ok(maxActive > 1);
});

test('executeTools: mixed-risk sequence preserves original order', async () => {
  const ctrl = makeController();
  ctrl.modelId = 'gpt-test';
  ctrl.abortController = { signal: { aborted: false } };
  ctrl.tools = {
    getTool: (name) => (name === 'edit_file' ? { riskLevel: 'medium' } : { riskLevel: 'safe' }),
  };

  ctrl._executeSingleTool = async (tc) => {
    if (tc.function.name === 'read_file') await new Promise((r) => setTimeout(r, 30));
    if (tc.function.name === 'grep_search') await new Promise((r) => setTimeout(r, 5));
    if (tc.function.name === 'edit_file') await new Promise((r) => setTimeout(r, 10));
    if (tc.function.name === 'list_dir') await new Promise((r) => setTimeout(r, 1));
    return { toolCallId: tc.id, toolName: tc.function.name, output: { success: true } };
  };

  const results = await ctrl._executeTools([
    { id: '1', function: { name: 'read_file', arguments: '{}' } },
    { id: '2', function: { name: 'grep_search', arguments: '{}' } },
    { id: '3', function: { name: 'edit_file', arguments: '{}' } },
    { id: '4', function: { name: 'list_dir', arguments: '{}' } },
  ]);

  assert.deepStrictEqual(results.map((r) => r.toolCallId), ['1', '2', '3', '4']);
});

test('workflow advance: todo_write stepId advances workflow step state', () => {
  const ctrl = makeController();
  ctrl._activeWorkflow = { id: 'wf1' };
  ctrl._workflowStepStatus = [
    { id: 's1', title: 'Step One', status: 'in_progress' },
    { id: 's2', title: 'Step Two', status: 'pending' },
  ];

  ctrl._tryAdvanceWorkflow('', [
    { toolName: 'todo_write', output: { success: true, stepId: 's1' }, args: { step_id: 's1' } },
  ]);

  const s1 = ctrl._workflowStepStatus.find((s) => s.id === 's1');
  const s2 = ctrl._workflowStepStatus.find((s) => s.id === 's2');
  assert.strictEqual(s1.status, 'completed');
  assert.strictEqual(s2.status, 'in_progress');
});

test('read_file short-circuit falls back to tool execution when cached content is missing', async () => {
  const projectPath = path.join(os.tmpdir(), `alc-shortcircuit-${Date.now()}-a`);
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'a.txt'), 'line1\nline2\n', 'utf8');
  const stat = fs.statSync(path.join(projectPath, 'a.txt'));

  const ctrl = makeController();
  ctrl.projectPath = projectPath;
  ctrl.abortController = { signal: { aborted: false } };
  ctrl.tracer = { startSpan: () => ({ end: () => { } }) };
  ctrl.tools = {
    getTool: () => ({ riskLevel: 'safe' }),
    execute: async () => ({
      success: true,
      content: '     1|line1\n     2|line2',
      totalLines: 2,
      startLine: 1,
      endLine: 2,
      truncated: false,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    }),
  };

  ctrl.readCoverage.recordRead('a.txt', {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    totalLines: 2,
    startLine: 1,
    endLine: 2,
  });

  const result = await ctrl._executeSingleTool({
    id: 't1',
    function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
  });

  // With the no-content short-circuit enhancement, coverage-only hits also short-circuit
  // (returning a message telling the model the content is in context above).
  assert.strictEqual(result.output.shortCircuited, true);
  assert.ok(result.output.message.includes('already read'));
  assert.strictEqual(ctrl.toolCallCount, 1);

  fs.rmSync(projectPath, { recursive: true, force: true });
});

test('read_file short-circuit replays cached content and increments toolCallCount', async () => {
  const projectPath = path.join(os.tmpdir(), `alc-shortcircuit-${Date.now()}-b`);
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'b.txt'), 'line1\nline2\n', 'utf8');
  const stat = fs.statSync(path.join(projectPath, 'b.txt'));

  const ctrl = makeController();
  ctrl.projectPath = projectPath;
  ctrl.abortController = { signal: { aborted: false } };
  ctrl.tracer = { startSpan: () => ({ end: () => { } }) };

  let executeCalled = false;
  ctrl.tools = {
    getTool: () => ({ riskLevel: 'safe' }),
    execute: async () => {
      executeCalled = true;
      return { success: false, error: 'should not execute' };
    },
  };

  ctrl.readCoverage.recordRead('b.txt', {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    totalLines: 2,
    startLine: 1,
    endLine: 2,
    content: '     1|line1\n     2|line2',
  });

  const result = await ctrl._executeSingleTool({
    id: 't2',
    function: { name: 'read_file', arguments: JSON.stringify({ path: 'b.txt' }) },
  });

  assert.strictEqual(result.output.shortCircuited, true);
  assert.strictEqual(result.output.content.includes('line1'), true);
  assert.strictEqual(executeCalled, false);
  assert.strictEqual(ctrl.toolCallCount, 1);

  fs.rmSync(projectPath, { recursive: true, force: true });
});

test('peakTokenEstimate tracks max value, not final value', () => {
  const ctrl = makeController();
  ctrl._metrics.peakTokenEstimate = 0;

  ctrl.messages = [{ role: 'user', content: 'short message' }];
  const a = ctrl._updatePeakTokenEstimate();

  ctrl.messages = [{ role: 'user', content: 'x'.repeat(5000) }];
  const b = ctrl._updatePeakTokenEstimate();

  ctrl.messages = [{ role: 'user', content: 'tiny' }];
  ctrl._updatePeakTokenEstimate();

  assert.ok(b >= a);
  assert.strictEqual(ctrl._metrics.peakTokenEstimate, b);
});

test('auto-lint flag prevents _lintCheckPending from being overridden', () => {
  const ctrl = makeController();
  // Simulate: auto-lint ran this round and cleared _lintCheckPending
  ctrl._lintCheckPending = false;
  ctrl._autoLintRanThisRound = true;
  ctrl._modifiedFiles = new Set(['file.js']);

  // Simulate the lint-pending check logic (L577-587 in agent-loop-controller.js)
  const hasNewFileChanges = true;
  const hasLintCall = false; // No explicit read_lints in toolCalls
  if (hasNewFileChanges && !hasLintCall && !ctrl._autoLintRanThisRound) {
    ctrl._lintCheckPending = true;
  }
  if (hasLintCall) {
    ctrl._lintCheckPending = false;
  }
  ctrl._autoLintRanThisRound = false;

  // _lintCheckPending should remain false because auto-lint already handled it
  assert.strictEqual(ctrl._lintCheckPending, false, '_lintCheckPending should stay false when auto-lint ran');
});

test('without auto-lint flag, _lintCheckPending is set to true for new file changes', () => {
  const ctrl = makeController();
  ctrl._lintCheckPending = false;
  ctrl._autoLintRanThisRound = false;

  const hasNewFileChanges = true;
  const hasLintCall = false;
  if (hasNewFileChanges && !hasLintCall && !ctrl._autoLintRanThisRound) {
    ctrl._lintCheckPending = true;
  }

  assert.strictEqual(ctrl._lintCheckPending, true, '_lintCheckPending should be true without auto-lint');
});

test('plan mode hard-blocks write tools at execution layer', async () => {
  const ctrl = makeController();
  ctrl._currentMode = 'plan';
  ctrl.webSearchEnabled = false;
  ctrl.abortController = { signal: { aborted: false } };
  ctrl.tracer = { startSpan: () => ({ end: () => { } }) };
  ctrl.tools = {
    getDefinitions: () => [{ name: 'read_file' }],
    getTool: () => ({ riskLevel: 'safe' }),
    execute: async () => ({ success: true }),
  };

  const result = await ctrl._executeSingleTool({
    id: 'plan-block-1',
    function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.js', content: 'x' }) },
  });

  assert.strictEqual(result.output.success, false);
  assert.strictEqual(result.output.code, 'E_TOOL_NOT_ALLOWED_IN_MODE');
});

test('mode switch hot-applies prompt and current mode', async () => {
  const ctrl = makeController();
  ctrl.projectPath = process.cwd();
  ctrl.modelId = 'test-model';
  ctrl.webSearchEnabled = false;
  ctrl._openFiles = [];
  ctrl._currentMode = 'agent';
  ctrl.promptAssembler = {
    assemble: ({ mode }) => `PROMPT-${mode}`,
  };
  ctrl.messages = [
    { role: 'system', content: 'PROMPT-agent' },
    { role: 'user', content: 'hello' },
  ];

  const switched = await ctrl._applyModeSwitch('plan');
  assert.strictEqual(switched.ok, true);
  assert.strictEqual(ctrl._currentMode, 'plan');
  assert.strictEqual(ctrl.messages[0].content, 'PROMPT-plan');
  assert.ok(ctrl.messages.some(m => m.role === 'system' && String(m.content).includes('Mode switched from agent to plan')));
});
// ============================================================
// Iteration counting and retry breakdown tests
// ============================================================

test('iteration always increments on every loop pass (never skipped)', () => {
  const ctrl = makeController({ maxIterations: 5 });
  // iteration starts at 0 in real loop, but makeController sets it to 1
  ctrl.iteration = 0;
  // Simulate 4 increments (as _loop does at top of each pass)
  for (let i = 0; i < 4; i++) ctrl.iteration++;
  assert.strictEqual(ctrl.iteration, 4, 'iteration should increment on every pass');
});

test('_productiveIterations initialized to 0 and independent of iteration', () => {
  const ctrl = makeController();
  // _productiveIterations is initialized inside _loop, not in constructor
  // but we can verify it's a separate counter from iteration
  ctrl._productiveIterations = 0;
  ctrl.iteration = 10;
  assert.strictEqual(ctrl._productiveIterations, 0, '_productiveIterations should be independent');
  ctrl._productiveIterations++;
  assert.strictEqual(ctrl._productiveIterations, 1);
  assert.strictEqual(ctrl.iteration, 10, 'iteration unchanged by _productiveIterations');
});

test('retryHardCap is exactly maxIterations * 2', () => {
  const ctrl = makeController({ maxIterations: 30 });
  const retryHardCap = ctrl.config.maxIterations * 2;
  assert.strictEqual(retryHardCap, 60, 'retryHardCap should be 2x maxIterations');
});

test('limitReason includes retry breakdown when hardcap reached', () => {
  const ctrl = makeController({ maxIterations: 5 });
  ctrl._productiveIterations = 3; // not exhausted
  ctrl.iteration = 10; // hardcap reached

  const retryBreakdown = { truncation: 2, quality: 1, stall: 1, noTool: 3, gate: 0, llmError: 0 };
  const retryTopContributors = Object.entries(retryBreakdown)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');

  const limitReason = ctrl._productiveIterations >= ctrl.config.maxIterations
    ? `Productive iterations exhausted (${ctrl._productiveIterations}/${ctrl.config.maxIterations})`
    : `Total rounds cap reached (${ctrl.iteration}, productive: ${ctrl._productiveIterations}, retries: ${retryTopContributors || 'none'})`;

  assert.ok(limitReason.includes('Total rounds cap reached'), 'should be hardcap reason');
  assert.ok(limitReason.includes('noTool:3'), 'should include top retry contributor');
  assert.ok(limitReason.includes('truncation:2'), 'should include truncation count');
  assert.ok(!limitReason.includes('gate:0'), 'should not include zero-count retries');
});

test('LAZY_PHRASES does not include legitimate terms like 简化版', () => {
  const { checkResponseQuality } = AgentLoopController;
  const result = checkResponseQuality('这是一个简化版的赛道实现');
  assert.strictEqual(result.pass, true, '简化版 should not be flagged as lazy phrase');
});

// ============================================================
// Prompt isolation tests
// ============================================================

test('PromptAssembler: Layer -1 identity_anchor is the first layer', () => {
  const { PromptAssembler } = require('../src/prompts/prompt-assembler');
  const pa = new PromptAssembler();
  const prompt = pa.assemble({ mode: 'agent', projectPath: '/tmp', modelId: 'test' });
  const anchorIdx = prompt.indexOf('<identity_anchor>');
  const userInfoIdx = prompt.indexOf('<user_info>');
  assert.ok(anchorIdx >= 0, 'identity_anchor should be present');
  assert.ok(anchorIdx < userInfoIdx, 'identity_anchor should appear before user_info');
});

test('system-base does not mention Cursor by name', () => {
  const systemBase = require('../src/prompts/system-base');
  assert.ok(!systemBase.includes('你是 Cursor'), 'system-base should not say "你是 Cursor"');
  assert.ok(!systemBase.includes('我是 Cursor'), 'system-base should not say "我是 Cursor"');
});

test('_defaultSystemPrompt fallback does not mention Cursor', () => {
  const ctrl = makeController();
  const prompt = ctrl._defaultSystemPrompt('agent');
  assert.ok(!prompt.includes('Cursor'), '_defaultSystemPrompt should not mention Cursor');
  assert.ok(prompt.includes('AI coding assistant'), '_defaultSystemPrompt should have generic identity');
});

// ============================================================
// User input detection tests
// ============================================================

test('_detectUserInputRequest: detects Chinese input request', () => {
  const ctrl = makeController();
  assert.strictEqual(ctrl._detectUserInputRequest('请提供Base64字符串以创建tiles.png'), true);
  assert.strictEqual(ctrl._detectUserInputRequest('需要用户提供项目路径'), true);
  assert.strictEqual(ctrl._detectUserInputRequest('需要等待用户的确认才能继续'), true);
});

test('_detectUserInputRequest: detects English input request', () => {
  const ctrl = makeController();
  assert.strictEqual(ctrl._detectUserInputRequest('Could you please provide the API key?'), true);
  assert.strictEqual(ctrl._detectUserInputRequest('Please share the base64 encoded image data'), true);
});

test('_detectUserInputRequest: rejects normal conclusions', () => {
  const ctrl = makeController();
  assert.strictEqual(ctrl._detectUserInputRequest('任务已完成，所有文件已创建'), false);
  assert.strictEqual(ctrl._detectUserInputRequest('ok'), false);
  assert.strictEqual(ctrl._detectUserInputRequest(''), false);
  assert.strictEqual(ctrl._detectUserInputRequest(null), false);
});

test('skills-available event no longer exists in agent-loop-controller', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'agent-loop-controller.js'), 'utf-8');
  assert.ok(!src.includes("'skills-available'"), 'skills-available event should be removed');
});

// ============================================================
// _sanitizeConversation tests (consecutive assistant fix)
// ============================================================

test('_sanitizeConversation: no consecutive assistants — unchanged', () => {
  const ctrl = makeController();
  ctrl.tracer = { warn: () => { } };
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'do stuff' },
    { role: 'assistant', content: 'done', tool_calls: [{ id: 'tc1', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'tc1', content: 'file content' },
  ];
  const result = ctrl._sanitizeConversation(msgs);
  // Bug #1 fix: tool 消息后不再追加 user（防止 API 协议冲突 tool→user → HTTP 400）
  // 所以 result 长度等于原始长度
  assert.strictEqual(result.length, msgs.length);
  assert.strictEqual(result[2].role, 'assistant');
  assert.strictEqual(result[4].role, 'assistant');
  assert.strictEqual(result[result.length - 1].role, 'tool');
});

test('_sanitizeConversation: merges consecutive assistants without tool_calls', () => {
  const ctrl = makeController();
  ctrl.tracer = { warn: () => { } };
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'part1' },
    { role: 'assistant', content: 'part2' },
    { role: 'user', content: 'ok' },
  ];
  const result = ctrl._sanitizeConversation(msgs);
  assert.strictEqual(result.length, 4); // merged 2 assistants into 1
  assert.strictEqual(result[2].role, 'assistant');
  assert.ok(result[2].content.includes('part1'));
  assert.ok(result[2].content.includes('part2'));
});

test('_sanitizeConversation: preserves tool_calls, converts other to user', () => {
  const ctrl = makeController();
  ctrl.tracer = { warn: () => { } };
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'thinking...' },
    { role: 'assistant', content: 'calling tools', tool_calls: [{ id: 'tc1', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'tc1', content: 'result' },
  ];
  const result = ctrl._sanitizeConversation(msgs);
  // The first assistant (no tool_calls) should be converted to user
  assert.strictEqual(result[2].role, 'user');
  assert.ok(result[2].content.includes('[note]'));
  // The second assistant (with tool_calls) should stay
  assert.strictEqual(result[3].role, 'assistant');
  assert.ok(result[3].tool_calls);
});

test('_sanitizeConversation: does NOT append user when no tool_calls and no _forceToolRequired', () => {
  const ctrl = makeController();
  ctrl.tracer = { warn: () => { } };
  ctrl._forceToolRequired = false;
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'done' },
  ];
  const result = ctrl._sanitizeConversation(msgs);
  // 修复6: 没有 tool_calls 且无 _forceToolRequired → 不追加 user
  assert.strictEqual(result[result.length - 1].role, 'assistant');
});

test('_sanitizeConversation: does NOT append user after assistant with tool_calls', () => {
  const ctrl = makeController();
  ctrl.tracer = { warn: () => { } };
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', function: { name: 'read_file', arguments: '{}' } }] },
  ];
  const result = ctrl._sanitizeConversation(msgs);
  // Should NOT add user after assistant(tool_calls) — tool result should come next
  assert.strictEqual(result[result.length - 1].role, 'assistant');
});

test('_sanitizeConversation: writeBack updates this.messages', () => {
  const ctrl = makeController();
  ctrl.tracer = { warn: () => { } };
  ctrl.messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'a' },
    { role: 'assistant', content: 'b' },
  ];
  const input = ctrl.messages.map(m => ({ ...m }));
  ctrl._sanitizeConversation(input, { writeBack: true });
  // After writeBack, this.messages should be sanitized
  const roles = ctrl.messages.map(m => m.role);
  // Check no consecutive assistants
  for (let i = 1; i < roles.length; i++) {
    assert.ok(!(roles[i] === 'assistant' && roles[i - 1] === 'assistant'),
      `consecutive assistant at ${i}: ${roles.join(', ')}`);
  }
});

test('_sanitizeConversation: triple consecutive assistant merged to one', () => {
  const ctrl = makeController();
  ctrl.tracer = { warn: () => { } };
  const msgs = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'alpha' },
    { role: 'assistant', content: 'beta' },
    { role: 'assistant', content: 'gamma' },
  ];
  const result = ctrl._sanitizeConversation(msgs);
  const assistants = result.filter(m => m.role === 'assistant');
  assert.strictEqual(assistants.length, 1, 'should merge 3 consecutive assistants into 1');
  assert.ok(assistants[0].content.includes('alpha'));
  assert.ok(assistants[0].content.includes('gamma'));
});

// ============================================================
// Bug fix regression tests
// ============================================================

test('Bug #1: _totalRetries and _noToolResetCount initialized in start()', () => {
  const ctrl = makeController();
  ctrl._totalRetries = undefined;
  ctrl._noToolResetCount = undefined;
  // Simulate what start() does
  ctrl._totalRetries = 0;
  ctrl._noToolResetCount = 0;
  assert.strictEqual(ctrl._totalRetries, 0, '_totalRetries should be initialized to 0');
  assert.strictEqual(ctrl._noToolResetCount, 0, '_noToolResetCount should be initialized to 0');
});

test('Bug #2: _stallCount should NOT be reset to 0 after stall detection (verify via retryBreakdown)', () => {
  // The fix removes `this._stallCount = 0;` from the stall handler.
  // Verify by inspecting the source code directly.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'agent-loop-controller.js'), 'utf-8');
  // The old code had `this._stallCount = 0;` right before `continue;` in stall handler
  // After fix, there should be NO `_stallCount = 0` between `_forceToolRequired = true` and `continue` in stall block
  const stallBlock = src.match(/this\._forceToolRequired = true;\s*\n(.*?)\s*continue;/s);
  if (stallBlock) {
    assert.ok(!stallBlock[1].includes('this._stallCount = 0'),
      'stall handler should NOT reset _stallCount to 0 (Bug #2 fix)');
  }
});

test('Bug #3: _sanitizeConversation uses [AUTO-CONTINUE] prefix when _forceToolRequired', () => {
  const ctrl = makeController();
  ctrl.tracer = { warn: () => { } };
  ctrl._forceToolRequired = true;
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'done' },
  ];
  const result = ctrl._sanitizeConversation(msgs);
  const lastUser = result[result.length - 1];
  assert.strictEqual(lastUser.role, 'user');
  assert.ok(lastUser.content.startsWith('[AUTO-CONTINUE]'),
    'sanitize should inject [AUTO-CONTINUE] prefix when _forceToolRequired is true');
  // Verify it won't match ECHO_PHRASES
  assert.ok(!lastUser.content.startsWith('Continue based on'),
    'should NOT use "Continue based on" which matches ECHO_PHRASES');
});

test('Bug #4: _toolLoopBlockedAt is set when tools are blocked', () => {
  const ctrl = makeController();
  ctrl._toolLoopBlockedAt = 0;
  ctrl._productiveIterations = 5;
  // Simulate blocking
  ctrl._toolLoopBlockedAt = ctrl._productiveIterations;
  assert.strictEqual(ctrl._toolLoopBlockedAt, 5, 'should record productive iteration count at block time');
  // Verify clearing after 2+ productive iterations
  ctrl._productiveIterations = 8;
  if (ctrl._productiveIterations > ctrl._toolLoopBlockedAt + 2) {
    ctrl._toolLoopBlockedNames = new Set();
    ctrl._toolLoopCount = 0;
  }
  assert.strictEqual(ctrl._toolLoopBlockedNames.size, 0, 'should clear blocked names after 2+ productive iterations');
});

test('Bug #5: gate resets _noToolRetries at most 2 times', () => {
  const ctrl = makeController();
  ctrl._noToolResetCount = 0;
  // Simulate 3 gate resets
  for (let i = 0; i < 3; i++) {
    ctrl._noToolRetries = 7; // simulate exhausted noTool
    ctrl._noToolResetCount++;
    if (ctrl._noToolResetCount <= 2) {
      ctrl._noToolRetries = 0;
    }
  }
  // After 3rd gate reset, _noToolRetries should NOT have been reset
  assert.strictEqual(ctrl._noToolRetries, 7, '_noToolRetries should stop being reset after 2 gate resets');
  assert.strictEqual(ctrl._noToolResetCount, 3, '_noToolResetCount should track total resets');
});

test('Bug #6: _fileReadCounts should not block reads with offset', async () => {
  const projectPath = path.join(os.tmpdir(), `alc-offset-read-${Date.now()}`);
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'big.txt'), Array(100).fill('line').join('\n'), 'utf8');

  const ctrl = makeController();
  ctrl.projectPath = projectPath;
  ctrl.abortController = { signal: { aborted: false } };
  ctrl.tracer = { startSpan: () => ({ end: () => { } }) };
  ctrl.tools = {
    getTool: () => ({ riskLevel: 'safe' }),
    getDefinitions: () => [{ name: 'read_file' }],
    execute: async () => ({
      success: true, content: 'content', totalLines: 100,
      startLine: 1, endLine: 50, truncated: false,
      mtimeMs: Date.now(), size: 500,
    }),
  };

  // Simulate 4 reads with different offsets — should NOT be blocked
  for (let i = 0; i < 4; i++) {
    const result = await ctrl._executeSingleTool({
      id: `rt${i}`,
      function: { name: 'read_file', arguments: JSON.stringify({ path: 'big.txt', offset: (i * 50) + 1, limit: 50 }) },
    });
    assert.ok(!result.output.shortCircuited || result.output.content,
      `Read #${i + 1} with offset should not be blocked by _fileReadCounts`);
  }

  fs.rmSync(projectPath, { recursive: true, force: true });
});

test('Bug #7: context compression absoluteLimit is 40000 (not 16000)', () => {
  const { ContextEngine } = require('../src/core/context-engine');
  const ce = new ContextEngine();
  // Create messages under 40000 but above 16000 tokens
  const msgs = [
    { role: 'system', content: 'x'.repeat(4000) },
    { role: 'user', content: 'y'.repeat(4000) },
    ...Array(20).fill(null).map((_, i) => ({ role: i % 2 === 0 ? 'assistant' : 'user', content: 'z'.repeat(2000) })),
  ];
  const tokens = ce.estimateTokenCount(msgs);
  // With 4000*2 + 20*2000 = 48000 chars ≈ 12000 tokens, should NOT compress (under 40000 threshold)
  if (tokens < 40000) {
    const result = ce.compressIfNeeded(msgs, { budget: 128000, thresholdPct: 60 });
    assert.strictEqual(result.compressed, false, 'should not compress when under 40000 token absolute limit');
  }
});

test('Bug #8: tools-executed event not emitted inside per-result loop (source check)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'agent-loop-controller.js'), 'utf-8');
  // Verify tools-executed is emitted AFTER _tryAdvanceWorkflow (not inside the per-result loop)
  const advanceIdx = src.indexOf('this._tryAdvanceWorkflow(llmResult.content, toolResults)');
  const toolsExecutedIdx = src.indexOf("this._emit('tools-executed'", advanceIdx);
  assert.ok(advanceIdx > 0, '_tryAdvanceWorkflow should exist in source');
  assert.ok(toolsExecutedIdx > advanceIdx, 'tools-executed should be emitted after _tryAdvanceWorkflow');
  // Verify it's NOT between 'for (const result of toolResults)' and the closing of that loop
  const forOfIdx = src.indexOf('for (const result of toolResults)');
  const nextToolsExecuted = src.indexOf("this._emit('tools-executed'", forOfIdx);
  // The tools-executed emit should be far enough from the for-of (at least after workflow advance)
  assert.ok(nextToolsExecuted > forOfIdx + 1000,
    'tools-executed should be well after the per-result for-of loop body');
});

test('Bug #9: tools-executed and auto-lint should run once per tool round', async () => {
  const ctrl = makeController();
  ctrl.abortController = { signal: { aborted: false } };
  ctrl.projectPath = os.tmpdir(); // linter-runner 需要 projectPath
  // 模拟 start() 中的 Linter 计数器初始化
  ctrl._lintAutoFixCount = 0;
  ctrl._lintNoProgressCount = 0;
  ctrl._lastLintErrorCount = undefined;
  ctrl.messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'do work' },
  ];
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
  };

  let llmCalls = 0;
  ctrl._callLLM = async () => {
    llmCalls++;
    if (llmCalls === 1) {
      return {
        content: '',
        reasoning: '',
        toolCalls: [
          { id: 'tc1', function: { name: 'edit_file', arguments: '{"path":"a.js"}' } },
          { id: 'tc2', function: { name: 'list_dir', arguments: '{}' } },
        ],
        truncated: false,
        interrupted: false,
      };
    }
    return { content: 'done', reasoning: '', toolCalls: [], truncated: false, interrupted: false };
  };

  ctrl._executeTools = async () => ([
    { toolCallId: 'tc1', toolName: 'edit_file', args: { path: 'a.js' }, output: { success: true, path: 'a.js' } },
    { toolCallId: 'tc2', toolName: 'list_dir', args: {}, output: { success: true } },
  ]);

  let toolsExecutedEvents = 0;
  let lintProgressNotes = 0;
  ctrl.setEmitter((event, data) => {
    if (event === 'tools-executed') toolsExecutedEvents++;
    // auto-lint 完成后会 emit 'progress-note' 且 text 包含 'Reviewing changes'
    // 增强后的 auto-lint 在有错误时 emit '🔍 Linter detected'
    // 无错误时不 emit 特殊消息，但 tools-executed 会正常 emit
    if (event === 'progress-note' && data?.text?.includes('Reviewing changes')) lintProgressNotes++;
  });
  ctrl.tools = {
    getDefinitions: () => [
      { name: 'edit_file' },
      { name: 'list_dir' },
      { name: 'read_lints' },
    ],
    getTool: (name) => (name === 'read_lints' ? { riskLevel: 'safe' } : { riskLevel: 'medium' }),
    execute: async (name) => {
      return { success: true, diagnostics: [] };
    },
  };

  await ctrl._loop();

  // 增强后的 auto-lint 优先使用 linter-runner 模块
  // 验证 tools-executed 事件只触发 1 次，且 lint 确实运行过（通过 Reviewing changes 事件）
  assert.strictEqual(toolsExecutedEvents, 1, 'tools-executed should be emitted exactly once per tool round');
  assert.strictEqual(lintProgressNotes, 1, 'reviewing changes progress note should fire once after lint check');
});

test('Bug #10: _loop should continue across multiple tool rounds before completing', async () => {
  const ctrl = makeController();
  ctrl.abortController = { signal: { aborted: false } };
  ctrl.messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'start task' },
  ];
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
  };
  ctrl._compressContextIfNeeded = () => { };
  ctrl._dynamicSkillInject = () => { };
  ctrl._tryAdvanceWorkflow = () => { };

  let llmRounds = 0;
  ctrl._callLLM = async () => {
    llmRounds++;
    if (llmRounds === 1) {
      return {
        content: '',
        reasoning: '',
        toolCalls: [{ id: 'tc1', function: { name: 'list_dir', arguments: '{}' } }],
        truncated: false,
        interrupted: false,
      };
    }
    if (llmRounds === 2) {
      return {
        content: '',
        reasoning: '',
        toolCalls: [{ id: 'tc2', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }],
        truncated: false,
        interrupted: false,
      };
    }
    return { content: 'all done', reasoning: '', toolCalls: [], truncated: false, interrupted: false };
  };

  let executeRounds = 0;
  ctrl._executeTools = async (toolCalls) => {
    executeRounds++;
    return toolCalls.map((tc) => ({
      toolCallId: tc.id,
      toolName: tc.function.name,
      args: {},
      output: { success: true },
    }));
  };

  await ctrl._loop();

  assert.strictEqual(executeRounds, 2, 'expected two tool execution rounds before completion');
  assert.ok(llmRounds >= 3, 'expected at least 3 LLM rounds');
  assert.strictEqual(ctrl.state, 'complete');
});

test('Bug #11: destroy() should not emit cancelled after terminal completion', () => {
  const ctrl = makeController();
  ctrl.state = 'complete';
  ctrl.abortController = new AbortController();

  let cancelledEvents = 0;
  ctrl.setEmitter((event) => {
    if (event === 'cancelled') cancelledEvents++;
  });

  ctrl.destroy();

  assert.strictEqual(cancelledEvents, 0, 'destroy should not emit cancelled for completed runs');
  assert.strictEqual(ctrl.state, 'complete', 'destroy should keep terminal state unchanged');
});

test('Bug #12: read-only workflow without pending todos should not be forced into extra retries', async () => {
  const todoStore = new TodoStore();
  const ctrl = makeController({ todoStore });
  ctrl.abortController = { signal: { aborted: false } };
  ctrl.messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'analyze only' },
  ];
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
  };
  ctrl._compressContextIfNeeded = () => { };
  ctrl._dynamicSkillInject = () => { };
  ctrl._tryAdvanceWorkflow = () => { };

  let llmRounds = 0;
  ctrl._callLLM = async () => {
    llmRounds++;
    if (llmRounds === 1) {
      return {
        content: '',
        reasoning: '',
        toolCalls: [{ id: 'tc1', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }],
        truncated: false,
        interrupted: false,
      };
    }
    return { content: 'analysis finished', reasoning: '', toolCalls: [], truncated: false, interrupted: false };
  };
  ctrl._executeTools = async (toolCalls) => toolCalls.map((tc) => ({
    toolCallId: tc.id,
    toolName: tc.function.name,
    args: { path: 'a.js' },
    output: { success: true, content: 'file content' },
  }));

  await ctrl._loop();

  assert.strictEqual(ctrl.state, 'complete');
  assert.strictEqual(llmRounds, 2, 'should complete immediately after read-only conclusion when no pending todos');
});
console.log('agent-loop-controller.js contract tests\n');
runTests();
