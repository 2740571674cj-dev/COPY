/**
 * Smoke Test — IDE 回归烟雾测试
 * 
 * L1: 模块可加载
 * L2: 关键行为断言
 */
const path = require('path');

let passed = 0;
let failed = 0;
const pending = []; // 收集 async 测试的 promise

function test(name, fn) {
    try {
        const result = fn();
        // async 函数返回 Promise，收集后统一 await
        if (result && typeof result.then === 'function') {
            pending.push(
                result
                    .then(() => { passed++; console.log(`  ✓ ${name}`); })
                    .catch(e => { failed++; console.error(`  ✗ ${name}: ${e.message}`); })
            );
        } else {
            // 同步测试成功
            passed++;
            console.log(`  ✓ ${name}`);
        }
    } catch (e) {
        // 同步测试抛异常 = 失败
        failed++;
        console.error(`  ✗ ${name}: ${e.message}`);
    }
}

console.log('\\n=== Smoke Test ===\\n');

// L1: 模块可加载
test('PromptAssembler loads', () => {
    require('../src/prompts/prompt-assembler');
});

test('AgentLoopController loads', () => {
    require('../src/core/agent-loop-controller');
});

test('system-base loads', () => {
    require('../src/prompts/system-base');
});

test('SuggestionStore loads', () => {
    require('../src/core/suggestion-store');
});

test('self-improve-pipeline loads', () => {
    require('../src/core/self-improve-pipeline');
});

test('semantic-index loads', () => {
    require('../src/core/semantic-index');
});

// L2: Prompt 组装行为
test('Prompt assemble produces valid output', () => {
    const { PromptAssembler } = require('../src/prompts/prompt-assembler');
    const p = new PromptAssembler();
    const result = p.assemble({ mode: 'agent' });
    if (!result || result.length < 50) throw new Error('prompt too short: ' + (result || '').length);
});

// L3: Allowlist 行为 — 必须拦截 path traversal
test('Allowlist blocks path traversal', () => {
    const { validateTargetFiles } = require('../src/core/self-improve-pipeline');
    const v = validateTargetFiles(
        { autoLevel: 'auto', targetFiles: ['src/prompts/../../main.js'] },
        path.resolve(__dirname, '..')
    );
    if (v.length === 0) throw new Error('allowlist failed to block traversal');
});

test('Allowlist blocks absolute paths', () => {
    const { validateTargetFiles } = require('../src/core/self-improve-pipeline');
    const v = validateTargetFiles(
        { autoLevel: 'auto', targetFiles: ['C:\\\\Windows\\\\System32\\\\cmd.exe'] },
        path.resolve(__dirname, '..')
    );
    if (v.length === 0) throw new Error('allowlist failed to block absolute path');
});

test('Allowlist allows valid auto path', () => {
    const { validateTargetFiles } = require('../src/core/self-improve-pipeline');
    const v = validateTargetFiles(
        { autoLevel: 'auto', targetFiles: ['src/prompts/system-base.js'] },
        path.resolve(__dirname, '..')
    );
    if (v.length > 0) throw new Error('allowlist wrongly blocked valid path: ' + JSON.stringify(v));
});

// L4: Quality check 行为
test('Quality check detects lazy phrases', () => {
    const { AgentLoopController } = require('../src/core/agent-loop-controller');
    const r = AgentLoopController.checkResponseQuality('为了简单起见');
    if (r.pass) throw new Error('quality check should fail on lazy phrase');
});

test('Quality check passes clean text', () => {
    const { AgentLoopController } = require('../src/core/agent-loop-controller');
    const r = AgentLoopController.checkResponseQuality('This is a complete production-ready implementation with full error handling.');
    if (!r.pass) throw new Error('quality check should pass clean text');
});

// L5: Rule engine 行为
test('Rule engine generates suggestion on high editNotFoundCount', () => {
    const { generateRuleBasedSuggestions } = require('../src/core/self-improve-pipeline');
    const suggestions = generateRuleBasedSuggestions({
        metrics: { editNotFoundCount: 5 },
        iterations: 3,
        toolCallCount: 10,
    });
    if (suggestions.length === 0) throw new Error('should generate suggestion for high editNotFoundCount');
});

// L6: 去重冷却（#2 + #7）
test('Rule engine dedup: same fingerprint within 24h is suppressed', () => {
    const { generateRuleBasedSuggestions } = require('../src/core/self-improve-pipeline');
    const existing = [{
        type: 'tool-chain', title: 'edit_file 匹配失败率过高',
        targetFiles: ['src/prompts/mode-agent.js'],
        createdAt: new Date().toISOString(), // just created
    }];
    const suggestions = generateRuleBasedSuggestions({
        metrics: { editNotFoundCount: 5 }, iterations: 3, toolCallCount: 10,
    }, existing);
    if (suggestions.some(s => s.title === 'edit_file 匹配失败率过高')) {
        throw new Error('dedup should suppress duplicate within 24h');
    }
});

// L7: Windows 路径绕过测试（#7）
test('Allowlist blocks Windows backslash traversal', () => {
    const { validateTargetFiles } = require('../src/core/self-improve-pipeline');
    const v = validateTargetFiles(
        { autoLevel: 'auto', targetFiles: ['src\\prompts\\..\\..\\main.js'] },
        path.resolve(__dirname, '..')
    );
    if (v.length === 0) throw new Error('allowlist failed to block backslash traversal');
});

// L8: _queueError 对象识别（#3 + #7）
test('_queueError object is detectable', () => {
    const errObj = { _queueError: true, message: 'test error' };
    if (!errObj._queueError) throw new Error('_queueError flag should be true');
    if (errObj.message !== 'test error') throw new Error('_queueError message mismatch');
});

// L9: SuggestionStore 并发不毒化（#7）
test('SuggestionStore queue does not poison on error', async () => {
    const { SuggestionStore } = require('../src/core/suggestion-store');
    const os = require('os');
    const store = new SuggestionStore(os.tmpdir());
    // Force an error via invalid internal operation
    const r1 = await store._enqueue(() => { throw new Error('deliberate'); });
    if (!r1?._queueError) throw new Error('should return _queueError on failure');
    // Subsequent operation should still work
    const r2 = await store._enqueue(() => 42);
    if (r2 !== 42) throw new Error('queue poisoned: subsequent op returned ' + r2);
});

// L10: semantic search index query
test('codebase_search returns indexed result', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const semanticSearch = require('../src/tools/semantic-search');
    const dir = path.join(os.tmpdir(), `cl-smoke-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'auth-service.js');
    fs.writeFileSync(filePath, [
        'export async function authenticateUser(token) {',
        '  if (!token) return null;',
        '  return { ok: true };',
        '}',
    ].join('\n'), 'utf-8');

    const res = await semanticSearch.handler({ query: 'where is user authentication handled' }, dir);
    if (!res?.success) throw new Error('semantic search failed');
    const files = (res.results || []).map(r => r.file);
    if (!files.includes('auth-service.js')) {
        throw new Error('expected indexed file not found in results');
    }
});

// 等待所有异步测试完成后再输出结果
(async () => {
    await Promise.all(pending);
    console.log(`\\n=== Results: ${passed} passed, ${failed} failed ===\\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
