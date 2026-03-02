const fs = require('fs');
const path = require('path');

const targetPath = path.join(__dirname, 'cursor(V10)/src/core/llm-gateway.js');
let content = fs.readFileSync(targetPath, 'utf8');

const replacements = [
  {
    old: '// ： messages е assistant，ȷϸ\n  // ƻ assistant(tool_calls) → tool Э',
    new: '// 注意：处理 messages 中的连续 assistant，确保严格交替\n  // 处理 assistant(tool_calls) → tool 协议兼容'
  },
  {
    old: '/**\n   * 为不原生 tool_calls 的ā型生成工具调ㄦ示文€?   * 将工具定义转 XML 格式的调ㄨ明，ㄥ?system 消息€?   */',
    new: '/**\n   * 为不支持原生 tool_calls 的模型生成工具调用提示文本。\n   * 将工具定义转换为 XML 格式的调用说明，注入到 system 消息中。\n   */'
  },
  {
    old: "+ 'Example ?to read a file:\\n'",
    new: "+ 'Example - to read a file:\\n'"
  },
  {
    old: '/**\n   * 从ā型的文本输出В?XML 格式的工具调ㄣ€?   * ㄤ不支持原?tool_calls 的ā型（?deepseek-reasoner）€?   */',
    new: '/**\n   * 从模型的文本输出中解析 XML 格式的工具调用。\n   * 用于不支持原生 tool_calls 的模型（如 deepseek-reasoner）。\n   */'
  },
  {
    old: '// Format 2: Direct tag format ?<tool_name><param>value</param></tool_name>',
    new: '// Format 2: Direct tag format - <tool_name><param>value</param></tool_name>'
  },
  {
    old: '/**\n   * ?content Щゅｆ?XML ュ调用?   */',
    new: '/**\n   * 从 content 中移除匹配到的 XML 工具调用块。\n   */'
  },
  {
    old: '/**\n   * 将包?tool role ?tool_calls ?messages 为普通文式，\n   * 使不原生 tool_calls 的ā型也能理ｅ具调ㄧ上下文€?   */',
    new: '/**\n   * 将包含 tool role 和 tool_calls 的 messages 转换为普通文本格式，\n   * 使不支持原生 tool_calls 的模型也能理解工具调用的上下文。\n   */'
  },
  {
    old: '// 处理 content 为数组格式的情况（ Prompt Caching ㄥ?cache_control 格式?        // ?tool_calls ″通常也不 content 数组格式，需要转︿',
    new: '// 处理 content 为数组格式的情况（如 Prompt Caching 注入的 cache_control 格式）\n        // 不支持 tool_calls 的模型通常也不支持 content 数组格式，需要转换为纯文本'
  },
  {
    old: '// Case 1: Simple cumulative ?incoming starts with current content ?replace.',
    new: '// Case 1: Simple cumulative - incoming starts with current content - replace.'
  },
  {
    old: '// Case 2: Exact duplicate chunk (same content resent) ?keep current.',
    new: '// Case 2: Exact duplicate chunk (same content resent) - keep current.'
  },
  {
    old: '// €ユā型是︽?tool_calls（ deepseek-reasoner 不支?Function Calling?',
    new: '// 检查模型是否支持 tool_calls（如 deepseek-reasoner 不支持 Function Calling）'
  },
  {
    old: '// 对不 tool_calls 的ā型，将工具定义注ュ system 消息?',
    new: '// 对不支持 tool_calls 的模型，将工具定义注入到 system 消息中'
  },
  {
    old: '// _reasoning 仅在 messages 留，不发送给 API',
    new: '// _reasoning 仅在内部 messages 中保留，不发送给 API'
  },
  {
    old: '// Prompt Caching: 仅在″显式时注?cache_control',
    new: '// Prompt Caching: 仅在模型显式支持时注入 cache_control'
  },
  {
    old: '// 为不原生 tool_calls 的ā型注ュ具提示到 system 消息',
    new: '// 为不支持原生 tool_calls 的模型注入工具提示到 system 消息'
  },
  {
    old: '// 对不 tool_calls 的ā型，过滤?messages  tool_calls ?tool role\n    // ?tool role 的结果转 user 消息，使″能看到工具执行结?',
    new: '// 对不支持 tool_calls 的模型，过滤掉 messages 中的 tool_calls 和 tool role\n    // 将 tool role 的结果转换为 user 消息，使模型能看到工具执行结果'
  },
  {
    old: '// Apply model-specific tool_choice mapping (e.g. Gemini: required ?any)',
    new: '// Apply model-specific tool_choice mapping (e.g. Gemini: required -> any)'
  },
  {
    old: '// ：strictAlternation ģʽ assistant\n    if (llmCfg.strictAlternation === true) {\n      body.messages = this._sanitizeMessagesStrict(body.messages);\n      // ӡɫڵ（ warn ）',
    new: '// 修复：strictAlternation 模式下清理连续的 assistant 消息\n    if (llmCfg.strictAlternation === true) {\n      body.messages = this._sanitizeMessagesStrict(body.messages);\n      // 打印角色序列用于调试（如 warn 级别）'
  },
  {
    old: 'break; // 成功或不试的 HTTP 错',
    new: 'break; // 成功或不可重试的 HTTP 错误'
  },
  {
    old: '// 区分内部超时和用户主ㄥ?',
    new: '// 区分内部超时和用户主动取消'
  },
  {
    old: 'let usageData = null; // [Token Dashboard] һ chunk  usage',
    new: 'let usageData = null; // [Token Dashboard] 记录最后一个 chunk 的 usage'
  },
  {
    old: "lastFinishReason = 'interrupted'; // 有部分内容但流中标?interrupted",
    new: "lastFinishReason = 'interrupted'; // 有部分内容但流中断，标记为 interrupted"
  },
  {
    old: '// 如果ㄥ了工具提示，则不立即发€?content 块，而是等到 onDone 时再发€清理后的完整内?',
    new: '// 如果注入了工具提示，则不立即发送 content 块，而是等到 onDone 时再发送清理后的完整内容'
  },
  {
    old: '// [Token Dashboard] ȡ usage ',
    new: '// [Token Dashboard] 获取 usage 数据'
  },
  {
    old: '// 对不原生 tool_calls 的ā型，从文容中ｆ XML 格式的工具调?',
    new: '// 对不支持原生 tool_calls 的模型，从文本内容中恢复 XML 格式的工具调用'
  },
  {
    old: '// 无ｆ到工具调都发€清理后的内容给前\n      // ﹀ㄦ式传输期?UI 看不到任何文?',
    new: '// 无论是否恢复到工具调用，都要发送清理后的内容给前端\n      // 否则在流式传输期间 UI 看不到任何文本输出'
  },
  {
    old: 'usage: usageData, // [Token Dashboard]  usage  controller',
    new: 'usage: usageData, // [Token Dashboard] 传递 usage 到 controller'
  }
];

let replaced = 0;
for (const r of replacements) {
  if (content.includes(r.old)) {
    content = content.replace(r.old, r.new);
    replaced++;
  } else {
    console.log("Could not find:", r.old.slice(0, 40));
  }
}

fs.writeFileSync(targetPath, content, 'utf8');
console.log(`Replaced ${replaced}/${replacements.length} matches.`);
