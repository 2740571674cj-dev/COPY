const fs = require('fs');
const p = 'e:/COPY/cursor(V10)/.agent/skills/coding-best-practices/SKILL.md';
let s = fs.readFileSync(p, 'utf8');
const entry = `- [Auto-Log] \u274c \u9519\u8bef\u73b0\u8c61\uff1aAgent \u591a\u8f6e\u5bf9\u8bdd\u4e2d LLM \u8fd4\u56de HTTP 400 "Invalid consecutive assistant message at message index XX" \u2192 \u2705 \u89e3\u51b3\u65b9\u6848\uff1a_loop() \u4e2d\u591a\u4e2a\u91cd\u8bd5\u8def\u5f84\uff08truncation\u3001quality\u3001stall\u3001noTool\uff09push assistant \u540e continue\uff0c\u5bfc\u81f4\u6d88\u606f\u6570\u7ec4\u51fa\u73b0\u8fde\u7eed assistant\u3002\u4fee\u590d\u65b9\u6848\uff1a(1) \u5728 _callLLM \u53d1\u8bf7\u6c42\u524d\u8c03\u7528 _sanitizeConversation() \u5408\u5e76/\u8f6c\u6362\u8fde\u7eed assistant \u5e76\u5199\u56de this.messages\uff1b(2) llm-gateway.js \u589e\u52a0 _sanitizeMessagesStrict \u515c\u5e95\uff1b(3) model-adapters.js \u4e3a deepseek \u8bbe\u7f6e strictAlternation: true\u3002\u6838\u5fc3\u539f\u5219\uff1a\u4e0d\u6539\u53d8\u6bcf\u4e2a push \u7684\u4e1a\u52a1\u903b\u8f91\uff0c\u800c\u662f\u5728\u53d1\u9001\u524d\u7edf\u4e00\u89c4\u8303\u5316\u6d88\u606f\u5e8f\u5217\u3002`;
s = s.trimEnd() + '\n' + entry + '\n';
fs.writeFileSync(p, s, 'utf8');
console.log('OK');
