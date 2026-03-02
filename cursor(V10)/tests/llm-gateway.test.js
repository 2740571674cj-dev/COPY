/**
 * llm-gateway.js 契约测试
 * 覆盖：SSE 多 chunk 拼接、tool_call 聚合、重试（改完后）、超时 abort
 */
const assert = require('assert');
require('./_fix-console-encoding');
const { LLMGateway } = require('../src/core/llm-gateway');

// ── 工具函数 ──

function makeGateway(fetchImpl) {
    const original = global.fetch;
    global.fetch = fetchImpl;
    const gw = new LLMGateway({
        loadModels: () => [{
            id: 'test-model',
            modelName: 'gpt-test',
            baseUrl: 'http://localhost:9999',
            apiKey: 'sk-test',
        }],
    });
    return { gw, restore: () => { global.fetch = original; } };
}

/** 构造一个模拟 SSE 流的 ReadableStream */
function makeSSEStream(chunks) {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream({
        pull(controller) {
            if (i < chunks.length) {
                controller.enqueue(encoder.encode(chunks[i]));
                i++;
            } else {
                controller.close();
            }
        },
    });
}

function makeSSEResponse(chunks, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        body: makeSSEStream(chunks),
        text: async () => chunks.join(''),
    };
}

// ── 测试用例 ──

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
            console.log(`  ✅ ${t.name}`);
        } catch (e) {
            failed++;
            console.log(`  ❌ ${t.name}`);
            console.log(`     ${e.message}`);
        }
    }
    console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);
    process.exit(failed > 0 ? 1 : 0);
}

// ── 1. SSE 多 chunk 拼接 ──
test('SSE 多 chunk 拼接：分片 content delta 正确合并', async () => {
    const sseChunks = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" World"}}]}\n\n',
        'data: [DONE]\n\n',
    ];

    const { gw, restore } = makeGateway(async () => makeSSEResponse(sseChunks));
    try {
        const result = await new Promise((resolve, reject) => {
            gw.streamChat({
                modelId: 'test-model',
                messages: [{ role: 'user', content: 'hi' }],
                onChunk: () => { },
                onDone: resolve,
                onError: reject,
            });
        });
        assert.strictEqual(result.content, 'Hello World');
        assert.strictEqual(result.toolCalls, null);
    } finally {
        restore();
    }
});

// ── 2. tool_call name/arguments 聚合 ──
test('tool_call 聚合：分片 name + arguments 正确拼接', async () => {
    const sseChunks = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"test.js\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
    ];

    const { gw, restore } = makeGateway(async () => makeSSEResponse(sseChunks));
    try {
        const result = await new Promise((resolve, reject) => {
            gw.streamChat({
                modelId: 'test-model',
                messages: [{ role: 'user', content: 'read test.js' }],
                tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } }],
                onChunk: () => { },
                onDone: resolve,
                onError: reject,
            });
        });
        assert.ok(result.toolCalls);
        assert.strictEqual(result.toolCalls.length, 1);
        assert.strictEqual(result.toolCalls[0].function.name, 'read_file');
        const parsed = JSON.parse(result.toolCalls[0].function.arguments);
        assert.strictEqual(parsed.path, 'test.js');
    } finally {
        restore();
    }
});

// ── 3. tool_call name 重复发送不会拼接出重复值 ──
test('tool_call name：多次发送同名不重复拼接', async () => {
    // 模拟某些模型在多个 chunk 中重复发送 name
    const sseChunks = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":""}}]}}]}\n\n',
        // 第二次又发了 name（某些兼容模型的行为）
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read_file","arguments":"{\\"path\\":\\"a.js\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
    ];

    const { gw, restore } = makeGateway(async () => makeSSEResponse(sseChunks));
    try {
        const result = await new Promise((resolve, reject) => {
            gw.streamChat({
                modelId: 'test-model',
                messages: [{ role: 'user', content: 'hi' }],
                tools: [{ name: 'read_file', description: 'read', parameters: {} }],
                onChunk: () => { },
                onDone: resolve,
                onError: reject,
            });
        });
        // 当前实现：name += 会变成 "read_fileread_file"
        // 修复后应该是 "read_file"
        // 此测试在修复 #4 前会失败，修复后通过
        const name = result.toolCalls[0].function.name;
        assert.strictEqual(name, 'read_file', `Expected "read_file" but got "${name}"`);
    } finally {
        restore();
    }
});

// ── 3b. tool_call name 分片（read_ + file）应合并为完整名称 ──
test('tool_call name：分片名称应正确合并', async () => {
    const sseChunks = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"{\\"path\\":\\"a.js\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
    ];

    const { gw, restore } = makeGateway(async () => makeSSEResponse(sseChunks));
    try {
        const result = await new Promise((resolve, reject) => {
            gw.streamChat({
                modelId: 'test-model',
                messages: [{ role: 'user', content: 'hi' }],
                tools: [{ name: 'read_file', description: 'read', parameters: {} }],
                onChunk: () => { },
                onDone: resolve,
                onError: reject,
            });
        });
        assert.strictEqual(result.toolCalls[0].function.name, 'read_file');
    } finally {
        restore();
    }
});

// ── 4. HTTP 错误返回 ──
test('HTTP 错误：非重试状态码直接报错', async () => {
    const { gw, restore } = makeGateway(async () => ({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
    }));
    try {
        const result = await new Promise((resolve) => {
            gw.streamChat({
                modelId: 'test-model',
                messages: [{ role: 'user', content: 'hi' }],
                onChunk: () => { },
                onDone: () => resolve({ ok: true }),
                onError: (err) => resolve({ ok: false, error: err }),
            });
        });
        assert.strictEqual(result.ok, false);
        assert.ok(result.error.code.includes('401'));
    } finally {
        restore();
    }
});

// ── 4b. HTTP 429 应触发重试并成功 ──
test('HTTP 429：应重试并最终成功', async () => {
    let calls = 0;
    const sseChunks = [
        'data: {"choices":[{"delta":{"content":"retry-ok"}}]}\n\n',
        'data: [DONE]\n\n',
    ];
    const { gw, restore } = makeGateway(async () => {
        calls++;
        if (calls === 1) {
            return {
                ok: false,
                status: 429,
                text: async () => 'Rate limited',
            };
        }
        return makeSSEResponse(sseChunks);
    });
    try {
        const result = await new Promise((resolve, reject) => {
            gw.streamChat({
                modelId: 'test-model',
                messages: [{ role: 'user', content: 'hi' }],
                onChunk: () => { },
                onDone: resolve,
                onError: reject,
            });
        });
        assert.strictEqual(result.content, 'retry-ok');
        assert.strictEqual(calls, 2, 'Expected exactly one retry for initial 429');
    } finally {
        restore();
    }
});

// ── 5. 模型未找到 ──
test('模型未找到：直接报错', async () => {
    const { gw, restore } = makeGateway(async () => { });
    try {
        const result = await new Promise((resolve) => {
            gw.streamChat({
                modelId: 'nonexistent',
                messages: [{ role: 'user', content: 'hi' }],
                onChunk: () => { },
                onDone: () => resolve({ ok: true }),
                onError: (err) => resolve({ ok: false, error: err }),
            });
        });
        assert.strictEqual(result.ok, false);
        assert.ok(result.error.code === 'E_MODEL_NOT_FOUND');
    } finally {
        restore();
    }
});

// ── 6. abort 信号 ──
test('abort 信号：中途取消返回 E_ABORTED', async () => {
    const controller = new AbortController();
    const { gw, restore } = makeGateway(async (url, opts) => {
        // 模拟在 fetch 阶段被 abort
        if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        // 延迟后 abort
        controller.abort();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    try {
        const result = await new Promise((resolve) => {
            gw.streamChat({
                modelId: 'test-model',
                messages: [{ role: 'user', content: 'hi' }],
                signal: controller.signal,
                onChunk: () => { },
                onDone: () => resolve({ ok: true }),
                onError: (err) => resolve({ ok: false, error: err }),
            });
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.error.code, 'E_ABORTED');
    } finally {
        restore();
    }
});

// ── 7. SSE 跨行 buffer 处理 ──
test('SSE buffer：单个 chunk 包含多条 SSE 行', async () => {
    // 一次发送多条 SSE 事件
    const sseChunks = [
        'data: {"choices":[{"delta":{"content":"A"}}]}\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\ndata: {"choices":[{"delta":{"content":"C"}}]}\n\ndata: [DONE]\n\n',
    ];

    const { gw, restore } = makeGateway(async () => makeSSEResponse(sseChunks));
    try {
        const result = await new Promise((resolve, reject) => {
            gw.streamChat({
                modelId: 'test-model',
                messages: [{ role: 'user', content: 'hi' }],
                onChunk: () => { },
                onDone: resolve,
                onError: reject,
            });
        });
        assert.strictEqual(result.content, 'ABC');
    } finally {
        restore();
    }
});

// ── 8. _reasoning 字段不应出现在请求 body 中 ──
test('_reasoning 泄漏：请求 body 不含 _reasoning 字段', async () => {
    let capturedBody = null;
    const sseChunks = [
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: [DONE]\n\n',
    ];

    const { gw, restore } = makeGateway(async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return makeSSEResponse(sseChunks);
    });
    try {
        await new Promise((resolve, reject) => {
            gw.streamChat({
                modelId: 'test-model',
                messages: [
                    { role: 'user', content: 'hi' },
                    { role: 'assistant', content: 'thinking...', _reasoning: 'internal thought process' },
                ],
                onChunk: () => { },
                onDone: resolve,
                onError: reject,
            });
        });
        // 检查发送的消息中是否泄漏了 _reasoning
        const hasReasoning = capturedBody.messages.some(m => m._reasoning !== undefined);
        // 修复 #3 前此断言会失败，修复后通过
        assert.strictEqual(hasReasoning, false, '_reasoning should not be sent to API');
    } finally {
        restore();
    }
});

// ── 9. 网络异常（cause.code）应触发重试并成功 ──
test('网络异常：cause.code=ECONNRESET 时应重试并成功', async () => {
    let calls = 0;
    const sseChunks = [
        'data: {"choices":[{"delta":{"content":"net-retry-ok"}}]}\n\n',
        'data: [DONE]\n\n',
    ];
    const { gw, restore } = makeGateway(async () => {
        calls++;
        if (calls === 1) {
            const err = new Error('socket hang up');
            err.cause = { code: 'ECONNRESET', message: 'read ECONNRESET' };
            throw err;
        }
        return makeSSEResponse(sseChunks);
    });
    try {
        const result = await new Promise((resolve, reject) => {
            gw.streamChat({
                modelId: 'test-model',
                messages: [{ role: 'user', content: 'hi' }],
                onChunk: () => { },
                onDone: resolve,
                onError: reject,
            });
        });
        assert.strictEqual(result.content, 'net-retry-ok');
        assert.strictEqual(calls, 2, 'Expected exactly one retry for retryable network error');
    } finally {
        restore();
    }
});

// ── 10. 累计参数块：模型发送完整 JSON 前缀覆盖 ──
test('累计参数块：incoming 包含 current 前缀应替换', async () => {
    const sseChunks = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"edit_file","arguments":""}}]}}]}\n\n',
        // 第一块：部分 JSON
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}\n\n',
        // 累计块：完整 JSON（包含第一块的内容）
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"test.js\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
    ];

    const { gw, restore } = makeGateway(async () => makeSSEResponse(sseChunks));
    try {
        const result = await new Promise((resolve, reject) => {
            gw.streamChat({
                modelId: 'test-model',
                messages: [{ role: 'user', content: 'edit' }],
                tools: [{ name: 'edit_file', description: 'edit', parameters: {} }],
                onChunk: () => { },
                onDone: resolve,
                onError: reject,
            });
        });
        assert.ok(result.toolCalls);
        const args = result.toolCalls[0].function.arguments;
        const parsed = JSON.parse(args);
        assert.strictEqual(parsed.path, 'test.js', `Expected valid JSON with path, got: ${args}`);
    } finally {
        restore();
    }
});

// ── 11. 重复参数块：相同块发两次不应拼接 ──
test('重复参数块：相同内容发两次不重复', async () => {
    const sseChunks = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.js\\"}"}}]}}]}\n\n',
        // 重复发送相同参数
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a.js\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
    ];

    const { gw, restore } = makeGateway(async () => makeSSEResponse(sseChunks));
    try {
        const result = await new Promise((resolve, reject) => {
            gw.streamChat({
                modelId: 'test-model',
                messages: [{ role: 'user', content: 'read' }],
                tools: [{ name: 'read_file', description: 'read', parameters: {} }],
                onChunk: () => { },
                onDone: resolve,
                onError: reject,
            });
        });
        const args = result.toolCalls[0].function.arguments;
        const parsed = JSON.parse(args);
        assert.strictEqual(parsed.path, 'a.js', `Expected single valid JSON, got: ${args}`);
    } finally {
        restore();
    }
});

// ── 运行 ──
console.log('llm-gateway.js 契约测试\n');
runTests();
