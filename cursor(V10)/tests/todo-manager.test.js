/**
 * todo-manager.test.js — 回归测试
 * 覆盖：批量 completed / 跳跃 / 回退硬拒绝 / step_id 传递 / 新 item
 */
const assert = require('assert');
require('./_fix-console-encoding');

// 模拟 todoStore
function createTodoStore(initial = []) {
    let data = [...initial];
    return {
        get: () => [...data],
        set: (items) => { data = [...items]; },
        getProgress: () => {
            const total = data.length;
            const completed = data.filter(t => t.status === 'completed').length;
            return { total, completed, percent: total > 0 ? Math.round((completed / total) * 100) : 0 };
        },
        _raw: () => data,
    };
}

const todoManager = require('../src/tools/todo-manager');

async function test1_batchCompleted() {
    console.log('[Test 1] 批量 completed — 允许但有 warning');
    const store = createTodoStore([
        { id: 'a', content: 'Task A', status: 'in_progress' },
        { id: 'b', content: 'Task B', status: 'in_progress' },
        { id: 'c', content: 'Task C', status: 'in_progress' },
    ]);
    const result = await todoManager.handler({
        todos: [
            { id: 'a', content: 'Task A', status: 'completed' },
            { id: 'b', content: 'Task B', status: 'completed' },
            { id: 'c', content: 'Task C', status: 'completed' },
        ],
        merge: true,
    }, '/test', { todoStore: store });

    assert.strictEqual(result.success, true, '调用应成功');
    assert.strictEqual(result.completed, 3, '3 个 completed');
    assert(result.warnings && result.warnings.length > 0, '应包含 batch warning');
    console.log('  ✅ PASS — warnings:', result.warnings);
}

async function test2_pendingToCompleted() {
    console.log('[Test 2] pending → completed 跳跃 — 允许 + warning');
    const store = createTodoStore([
        { id: 'x', content: 'Task X', status: 'pending' },
    ]);
    const result = await todoManager.handler({
        todos: [{ id: 'x', content: 'Task X', status: 'completed' }],
        merge: true,
    }, '/test', { todoStore: store });

    assert.strictEqual(result.success, true, '调用应成功');
    assert.strictEqual(result.completed, 1, 'completed = 1');
    assert(result.warnings && result.warnings.some(w => w.includes('pending → completed')), '应有跳跃 warning');
    // 确认状态确实被设置为 completed（而非被强制改为 in_progress）
    const items = store._raw();
    assert.strictEqual(items[0].status, 'completed', '状态应为 completed 而非被拦截');
    console.log('  ✅ PASS');
}

async function test3_completedRollbackRejected() {
    console.log('[Test 3] completed → pending 回退 — 硬拒绝');
    const store = createTodoStore([
        { id: 'y', content: 'Task Y', status: 'completed' },
    ]);
    const result = await todoManager.handler({
        todos: [{ id: 'y', content: 'Task Y', status: 'pending' }],
        merge: true,
    }, '/test', { todoStore: store });

    assert.strictEqual(result.success, false, '回退应被硬拒绝');
    assert.strictEqual(result.code, 'E_TODO_ROLLBACK_FORBIDDEN');
    assert(Array.isArray(result.conflicts) && result.conflicts.length === 1, '应返回冲突详情');
    const items = store._raw();
    assert.strictEqual(items[0].status, 'completed', '状态应保持 completed');
    console.log('  ✅ PASS');
}

async function test4_stepIdPassthrough() {
    console.log('[Test 4] step_id 信号传递');
    const store = createTodoStore([]);
    const result = await todoManager.handler({
        todos: [{ id: 'z', content: 'Task Z', status: 'pending' }],
        merge: false,
        step_id: 'step_3',
    }, '/test', { todoStore: store });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.stepId, 'step_3', 'output 应包含 stepId');
    console.log('  ✅ PASS');

    // 兼容 alias
    const result2 = await todoManager.handler({
        todos: [{ id: 'z2', content: 'Task Z2', status: 'pending' }],
        merge: false,
        stepId: 'step_5',
    }, '/test', { todoStore: store });
    assert.strictEqual(result2.stepId, 'step_5', 'stepId alias 也应工作');
    console.log('  ✅ PASS (alias)');
}

async function test5_newItemDirectCompleted() {
    console.log('[Test 5] 新 item 直接 completed — 允许');
    const store = createTodoStore([
        { id: 'a', content: 'Existing', status: 'pending' },
    ]);
    const result = await todoManager.handler({
        todos: [{ id: 'new1', content: 'New Task', status: 'completed' }],
        merge: true,
    }, '/test', { todoStore: store });

    assert.strictEqual(result.success, true);
    const items = store._raw();
    const newItem = items.find(t => t.id === 'new1');
    assert(newItem, '新 item 应被添加');
    assert.strictEqual(newItem.status, 'completed', '新 item 状态应为 completed');
    assert(result.warnings && result.warnings.some(w => w.includes('新建项直接标记为 completed')), '应有引导 warning');
    console.log('  ✅ PASS');
}

async function test6_noTodoStoreGraceful() {
    console.log('[Test 6] 无 todoStore — 优雅降级');
    const result = await todoManager.handler({
        todos: [{ id: 'x', content: 'Task', status: 'pending' }],
        merge: true,
        step_id: 'step_1',
    }, '/test', {});

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.stepId, 'step_1', 'step_id 仍应传递');
    console.log('  ✅ PASS');
}

async function test7_replaceModeRollbackRejected() {
    console.log('[Test 7] replace 模式 completed 回退 — 硬拒绝');
    const store = createTodoStore([
        { id: 'a', content: 'Task A', status: 'completed' },
        { id: 'b', content: 'Task B', status: 'pending' },
    ]);
    const result = await todoManager.handler({
        todos: [
            { id: 'a', content: 'Task A', status: 'in_progress' },
            { id: 'b', content: 'Task B', status: 'completed' },
        ],
        merge: false,
    }, '/test', { todoStore: store });

    assert.strictEqual(result.success, false, 'replace 模式也应拒绝回退');
    assert.strictEqual(result.code, 'E_TODO_ROLLBACK_FORBIDDEN');
    const items = store._raw();
    assert.strictEqual(items.length, 2, '硬拒绝时不应覆盖原清单');
    assert.strictEqual(items.find(t => t.id === 'a').status, 'completed');
    console.log('  ✅ PASS');
}

(async () => {
    console.log('=== todo-manager.test.js ===\n');
    let passed = 0;
    let failed = 0;

    for (const fn of [test1_batchCompleted, test2_pendingToCompleted, test3_completedRollbackRejected, test4_stepIdPassthrough, test5_newItemDirectCompleted, test6_noTodoStoreGraceful, test7_replaceModeRollbackRejected]) {
        try {
            await fn();
            passed++;
        } catch (e) {
            failed++;
            console.error(`  ❌ FAIL: ${e.message}`);
        }
        console.log();
    }

    console.log(`\n=== Results: ${passed}/${passed + failed} passed ===`);
    if (failed > 0) process.exit(1);
})();
