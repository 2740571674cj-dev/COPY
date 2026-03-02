/**
 * 修复两处语法/内容问题
 */
const fs = require('fs');
const fp = 'e:/COPY/cursor(V10)/src/core/agent-loop-controller.js';
let src = fs.readFileSync(fp, 'utf8');

// 修复 1: L701 多余的 ") {" — 脚本替换时把 "15000" 替换成了包含多余字符的字符串
// 当前: content.length > 6000) { // [Optimize: Token Saving] 截断阈值从 15000 收紧到 6000) {
// 应该是: content.length > 6000) {
const bad701 = 'content.length > 6000) { // [Optimize: Token Saving] \u622a\u65ad\u9608\u503c\u4ece 15000 \u6536\u7d27\u5230 6000) {';
if (src.includes(bad701)) {
    src = src.replace(bad701, 'content.length > 6000) { // [Optimize: Token Saving] \u622a\u65ad\u9608\u503c\u4ece 15000 \u6536\u7d27\u5230 6000');
    console.log('[OK] \u4fee\u590d L701 \u591a\u4f59\u8bed\u6cd5');
} else {
    console.log('[SKIP] L701 \u5df2\u6b63\u786e\u6216\u4e0d\u5339\u914d');
}

// 修复 2: L765 failCount=1 nearestContent case — 替换过长的提示
const oldNearestMsg = 'old_string does not match the file content. The nearest actual content is shown in nearestContent above.\\n\\nCRITICAL: Copy the EXACT text from nearestContent as your new old_string';
const newNearestMsg = 'old_string does not match. The nearest actual content is shown in nearestContent above. Copy the EXACT text from nearestContent as your new old_string. If the file is short (under 50 lines), consider using write_file to rewrite the entire file instead.';

// 用正则找包含原始消息的行
if (src.includes('old_string does not match the file content')) {
    // 找到整个 ternary 表达式并替换
    const oldTernary = /\? `edit_file failed: old_string does not match the file content\. The nearest actual content is shown in nearestContent above\.\\n\\nCRITICAL: Copy the EXACT text from nearestContent as your new old_string [^`]*`/;
    if (oldTernary.test(src)) {
        src = src.replace(oldTernary, '? `edit_file failed: old_string does not match. The nearest actual content is shown in nearestContent above. Copy the EXACT text from nearestContent as your new old_string. If the file is short (under 50 lines), consider using write_file to rewrite the entire file instead.`');
        console.log('[OK] \u4fee\u590d failCount=1 nearestContent case');
    } else {
        console.log('[INFO] \u6b63\u5219\u4e0d\u5339\u914d\uff0c\u5c1d\u8bd5\u76f4\u63a5\u66ff\u6362');
        // 直接定位到行内容
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('old_string does not match the file content')) {
                lines[i] = '              ? `edit_file failed: old_string does not match. The nearest actual content is shown in nearestContent above. Copy the EXACT text from nearestContent as your new old_string. If the file is short (under 50 lines), consider using write_file to rewrite the entire file instead.`';
                console.log('[OK] \u884c\u66ff\u6362\u6210\u529f at line', i + 1);
                break;
            }
        }
        src = lines.join('\n');
    }
}

fs.writeFileSync(fp, src, 'utf8');
console.log('\n\u2705 \u4fee\u590d\u5b8c\u6210');
