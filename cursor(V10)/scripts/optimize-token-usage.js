/**
 * Token 优化脚本 v3 — 使用正则匹配绕过 CRLF 问题
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// ═══════════════════════════════════════════
// agent-loop-controller.js 的 4 处修改
// ═══════════════════════════════════════════
const fp = path.join(ROOT, 'src/core/agent-loop-controller.js');
let src = fs.readFileSync(fp, 'utf8');
const lines = src.split('\n');

let changes = 0;

// --- 修改 1: 截断阈值 15000 → 6000 (约 L701) ---
for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('content.length > 15000')) {
        lines[i] = lines[i].replace('content.length > 15000', 'content.length > 6000) { // [Optimize: Token Saving] 截断阈值从 15000 收紧到 6000');
        // 实际上只替换数字即可
        // 重新做
        break;
    }
}

// 更简单的方式：直接在整个 src 上操作
src = lines.join('\n');

// 1. 截断 15000 → 6000
if (src.includes('content.length > 15000')) {
    src = src.replace('content.length > 15000', 'content.length > 6000');
    src = src.replace(
        '// Non-read_file tool output safeguard.',
        '// [Optimize: Token Saving] Non-read_file tool output safeguard (6000 chars).'
    );
    changes++;
    console.log('[OK] 截断阈值 15000 → 6000');
} else {
    console.error('[SKIP] 未找到 15000');
}

// 2. _smartTruncate head/tail 收紧
if (src.includes('content.substring(0, 3500)')) {
    src = src.replace('content.substring(0, 3500)', 'content.substring(0, 1500)');
    src = src.replace('content.substring(content.length - 1500)', 'content.substring(content.length - 1000)');
    src = src.replace(
        '// Non-JSON truncation keeps head and tail.',
        '// [Optimize: Token Saving] Non-JSON truncation: head 1500 + tail 1000'
    );
    changes++;
    console.log('[OK] _smartTruncate head 3500→1500, tail 1500→1000');
} else {
    console.error('[SKIP] 未找到 3500');
}

// 3. edit_file failCount=1 降级提示
const f1old = 'old_string does not match the file content. The nearest actual content is shown in nearestContent above.';
if (src.includes(f1old)) {
    src = src.replace(
        f1old + '\\n\\nCRITICAL: Copy the EXACT text from nearestContent as your new old_string \\u2014 do NOT retype from memory. Character-level precision is required (including whitespace and indentation).',
        'old_string does not match. The nearest actual content is shown in nearestContent above. Copy the EXACT text from nearestContent as your new old_string. If the file is short (under 50 lines), consider using write_file to rewrite the entire file instead.'
    );
    console.log('[OK] edit_file failCount=1 recovery (nearestContent case)');
    changes++;
} else {
    // 尝试直接替换整个 failCount=1 recovery 字符串 — 可能包含特殊字符
    console.log('[INFO] 尝试替换 failCount=1 without nearestContent case');
}

const f1bOld = 'old_string not found. Use read_file to re-read the target file and find the exact text you want to change.';
if (src.includes(f1bOld)) {
    src = src.replace(
        f1bOld,
        'old_string not found. Use read_file to re-read the target file. If you cannot match the exact text, use write_file to rewrite the entire file.'
    );
    changes++;
    console.log('[OK] edit_file failCount=1 recovery (no nearestContent case)');
}

// 4. edit_file failCount=2 强制降级
const f2old = 'Use read_file to re-read the relevant section, then copy the EXACT text as old_string. Include 3-5 lines of surrounding context to ensure uniqueness.';
if (src.includes(f2old)) {
    src = src.replace(
        f2old,
        '\u505c\u6b62\u5c1d\u8bd5 edit_file \u7684\u7cbe\u51c6\u5339\u914d\uff01\u8bf7\u7acb\u5373\u6539\u7528 write_file \u5de5\u5177\u91cd\u5199\u6574\u4e2a\u6587\u4ef6\u5185\u5bb9\u3002\u8fd9\u6837\u66f4\u53ef\u9760\u4e14\u907f\u514d\u6d6a\u8d39 token \u5728\u76f2\u731c\u7f29\u8fdb\u4e0a\u3002'
    );
    changes++;
    console.log('[OK] edit_file failCount=2 强制降级');
} else {
    console.error('[SKIP] 未找到 failCount=2 内容');
}

// 5. advanceWorkflow Checkpoint 注入
const advAnchor = "this._emit('workflow-step-update', { stepId: next.id, status: 'in_progress', steps: this._workflowStepStatus });";
const checkpointCode = `
    // [Optimize: Token Saving] Checkpoint：阶段切换时注入重置 prompt
    this.messages.push({
      role: 'system',
      content: '[Checkpoint] \u9636\u6bb5\u4efb\u52a1\u5df2\u5b8c\u6210\u3002\u73b0\u5728\u5f00\u59cb\u6267\u884c\u4e0b\u4e00\u9636\u6bb5\u3002\u8fc7\u53bb\u6267\u884c\u7684\u5197\u4f59\u4ee3\u7801\u7ec6\u8282\u4e0d\u518d\u91cd\u8981\uff0c\u8bf7\u57fa\u4e8e\u5f53\u524d\u9879\u76ee\u6700\u65b0\u72b6\u6001\u76f4\u63a5\u5f00\u59cb\u65b0\u4efb\u52a1\u3002',
    });`;

// advanceWorkflow 中的 emit 出现两次（一次 in_progress，一次 all_complete）
// 我们只在包含 "return next" 前面的那个 emit 后面插入
const advLines = src.split('\n');
let insertedCheckpoint = false;
for (let i = 0; i < advLines.length; i++) {
    if (advLines[i].includes(advAnchor) && i + 1 < advLines.length && advLines[i + 1].trim().startsWith('return next')) {
        // 在 emit 和 return next 之间插入
        advLines.splice(i + 1, 0, checkpointCode);
        insertedCheckpoint = true;
        break;
    }
}

if (insertedCheckpoint) {
    src = advLines.join('\n');
    changes++;
    console.log('[OK] advanceWorkflow Checkpoint 注入');
} else {
    console.error('[SKIP] 未找到 advanceWorkflow emit+return next');
}

fs.writeFileSync(fp, src, 'utf8');
console.log(`\n✅ agent-loop-controller.js: ${changes} 处修改完成`);
