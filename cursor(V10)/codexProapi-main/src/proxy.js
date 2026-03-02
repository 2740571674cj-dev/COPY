import { randomUUID } from 'crypto';
import { loadAuth } from './auth.js';
import { markAccountUnavailable } from './accountStatus.js';
import { recordUsage, clearUsage } from './usageTracker.js';

const BACKEND_URL = 'https://chatgpt.com/backend-api/codex/responses';

const BROWSER_HEADERS = {
  'Accept': 'text/event-stream',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Referer': 'https://chatgpt.com/',
  'Origin': 'https://chatgpt.com',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'DNT': '1',
  'OpenAI-Beta': 'responses=experimental',
  'originator': 'codex_cli_rs',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

function getMessageContentParts(msg) {
  const content = [];
  const raw = msg.content;
  if (typeof raw === 'string') {
    if (raw.trim()) content.push({ type: 'text', text: raw });
  } else if (Array.isArray(raw)) {
    for (const c of raw) {
      if (c == null) continue;
      if (typeof c === 'string') {
        if (c.trim()) content.push({ type: 'text', text: c });
        continue;
      }
      if (typeof c !== 'object') continue;
      if (c.type === 'image_url' || c.image_url) {
        const url = typeof c.image_url === 'string' ? c.image_url : (c.image_url?.url || '');
        const detail = c.image_url?.detail || 'auto';
        if (url) content.push({ type: 'image_url', url, detail });
      } else if (c.type === 'text' || c.text != null) {
        const text = String(c.text ?? '').trim();
        if (text) content.push({ type: 'text', text });
      }
    }
  } else {
    const text = String(raw ?? '').trim();
    if (text) content.push({ type: 'text', text });
  }
  return content;
}

/**
 * 将 OpenAI Chat Completions messages 转为 Codex Responses API input 格式。
 * 关键：保留 function_call / function_call_output 结构，让模型能理解多轮工具调用上下文。
 *
 * 规则：
 * - 第一条 system 消息 → 提取为 instructions（Responses API 的持久系统提示）
 * - 后续 system 消息 → 转为 developer role 的 message（保留在对话流中）
 * - assistant + tool_calls → function_call 项
 * - tool role → function_call_output 项
 *
 * @returns {{ items: Array, systemText: string }}
 */
function messagesToInput(messages) {
  const items = [];
  let systemText = '';
  let isFirstSystem = true;

  for (const msg of messages) {
    const role = String(msg.role || 'user').toLowerCase();
    const contentParts = getMessageContentParts(msg);
    const texts = contentParts.filter(p => p.type === 'text').map(p => p.text);
    const images = contentParts.filter(p => p.type === 'image_url');
    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;

    if (role === 'system') {
      const t = texts.join('\n').trim();
      if (!t) continue;
      if (isFirstSystem) {
        systemText = t;
        isFirstSystem = false;
      } else {
        items.push({
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: t }],
        });
      }
      continue;
    }

    if (role === 'user') {
      const content = [];
      for (const t of texts) content.push({ type: 'input_text', text: t });
      for (const img of images) content.push({ type: 'input_image', image_url: img.url, detail: img.detail || 'auto' });
      if (content.length > 0) items.push({ type: 'message', role: 'user', content });
      continue;
    }

    if (role === 'assistant') {
      // 注入 reasoning traces（Codex 依赖此保持思维连续性，丢失将导致 ~30% 性能下降）
      if (msg._reasoning && typeof msg._reasoning === 'string' && msg._reasoning.trim()) {
        items.push({
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: msg._reasoning }],
        });
      }
      if (texts.length > 0 && texts.join('').trim()) {
        items.push({
          type: 'message',
          role: 'assistant',
          content: texts.map(t => ({ type: 'output_text', text: t })),
        });
      }
      if (hasToolCalls) {
        for (const tc of msg.tool_calls) {
          const fn = tc?.function || {};
          items.push({
            type: 'function_call',
            call_id: tc.id || `call_${randomUUID().slice(0, 12)}`,
            name: String(fn.name || 'unknown'),
            arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}),
          });
        }
      }
      continue;
    }

    if (role === 'tool') {
      const output = texts.join(' ') || (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || ''));
      items.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id || 'unknown',
        output: output,
      });
      continue;
    }
  }

  return { items, systemText };
}

/** 官方标准：约 4 字符 = 1 token，用于估算 prompt_tokens */
function estimatePromptTokens(openaiReq) {
  let chars = 0;
  const messages = openaiReq.messages || [];
  for (const msg of messages) {
    const parts = getMessageContentParts(msg);
    for (const p of parts) {
      if (p.type === 'text' && p.text) chars += String(p.text).length;
    }
  }
  const tools = openaiReq.tools;
  if (Array.isArray(tools)) {
    chars += JSON.stringify(tools).length;
  }
  return Math.max(0, Math.ceil(chars / 4));
}

function normalizeToolsForCodex(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  const normalized = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'function' && t.function && typeof t.function === 'object') {
      const fn = t.function;
      if (!fn.name) continue;
      normalized.push({
        type: 'function',
        name: String(fn.name),
        description: fn.description ? String(fn.description) : '',
        parameters: fn.parameters && typeof fn.parameters === 'object'
          ? fn.parameters
          : { type: 'object', properties: {} },
      });
      continue;
    }
    if (t.type === 'function' && t.name) {
      normalized.push({
        type: 'function',
        name: String(t.name),
        description: t.description ? String(t.description) : '',
        parameters: t.parameters && typeof t.parameters === 'object'
          ? t.parameters
          : { type: 'object', properties: {} },
      });
      continue;
    }
    if (t.name) {
      normalized.push({
        type: 'function',
        name: String(t.name),
        description: t.description ? String(t.description) : '',
        parameters: t.parameters && typeof t.parameters === 'object'
          ? t.parameters
          : { type: 'object', properties: {} },
      });
    }
  }
  return normalized;
}

function normalizeToolChoiceForCodex(toolChoice) {
  if (toolChoice == null) return 'auto';
  if (typeof toolChoice === 'string') return toolChoice;
  if (typeof toolChoice !== 'object') return 'auto';

  if (toolChoice.type === 'function' && toolChoice.function && toolChoice.function.name) {
    return { type: 'function', name: String(toolChoice.function.name) };
  }
  if (toolChoice.type === 'function' && toolChoice.name) {
    return { type: 'function', name: String(toolChoice.name) };
  }
  return 'auto';
}

/**
 * 构建发往 ChatGPT Codex 后端的请求体
 * 后端强制要求 stream 为 true，故始终传 true；是否向客户端流式由 handleChatCompletions 根据 openaiReq.stream 决定。
 * instructions 取自 messages 中的 system 消息，保留完整的提示词上下文。
 */
function buildResponsesRequest(openaiReq) {
  const normalizedTools = normalizeToolsForCodex(openaiReq.tools || []);
  let { items, systemText } = messagesToInput(openaiReq.messages || []);

  // 截断过大的 function_call_output，防止 Codex 上下文溢出
  items = items.map(item => {
    if (item.type === 'function_call_output' && item.output && item.output.length > 6000) {
      const head = item.output.substring(0, 2500);
      const tail = item.output.substring(item.output.length - 1000);
      return { ...item, output: head + '\n...[truncated]...\n' + tail };
    }
    return item;
  });

  const result = {
    model: openaiReq.model || 'gpt-5.3-codex',
    instructions: systemText || 'You are a helpful AI assistant.',
    input: items,
    tools: normalizedTools,
    tool_choice: normalizeToolChoiceForCodex(openaiReq.tool_choice),
    parallel_tool_calls: false,
    store: false,
    stream: true,
  };
  return result;
}

/**
 * 非流式：从 SSE 响应中收集完整文本和 tool_calls 后返回
 * @returns {{ text: string, toolCalls: Array|null }}
 */
async function parseStreamToResult(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  let fullText = '';
  const toolCallMap = new Map();
  let nextIdx = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      try {
        const event = JSON.parse(data);
        const type = event.type;
        if (type === 'response.output_text.delta' && event.delta) {
          fullText += event.delta;
        }
        // response.output_text.done — full text of a single output_text part
        if (type === 'response.output_text.done' && event.text) {
          const ft = String(event.text);
          if (ft.length > fullText.length) {
            fullText = ft;
          }
        }
        // response.output_item.done with message type — may contain full text
        if (type === 'response.output_item.done' && event.item?.type === 'message') {
          const content = event.item.content;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part.type === 'output_text' && part.text) {
                const ft = String(part.text);
                if (ft.length > fullText.length) fullText = ft;
              }
            }
          }
        }
        // response.completed — extract full text and tool_calls from response output
        if ((type === 'response.completed' || type === 'response.done') && event.response?.output) {
          for (const item of event.response.output) {
            if (item.type === 'message' && Array.isArray(item.content)) {
              for (const part of item.content) {
                if (part.type === 'output_text' && part.text) {
                  const ft = String(part.text);
                  if (ft.length > fullText.length) fullText = ft;
                }
              }
            }
            if (item.type === 'function_call' && item.name) {
              const key = item.id || `tc_${nextIdx}`;
              if (!toolCallMap.has(key)) {
                toolCallMap.set(key, {
                  id: item.call_id || item.id || `call_${nextIdx}`,
                  type: 'function',
                  function: { name: item.name, arguments: String(item.arguments || '{}') },
                });
                nextIdx++;
              }
            }
          }
        }
        if ((type === 'response.output_item.added' || type === 'response.output_item.done') && event.item?.type === 'function_call') {
          const item = event.item;
          const key = item.id || `tc_${nextIdx}`;
          if (!toolCallMap.has(key)) {
            toolCallMap.set(key, {
              id: item.call_id || item.id || `call_${nextIdx}`,
              type: 'function',
              function: { name: item.name || '', arguments: '' },
            });
            nextIdx++;
          }
          const tc = toolCallMap.get(key);
          if (item.name) tc.function.name = item.name;
          if (type === 'response.output_item.done' && item.arguments) {
            tc.function.arguments = String(item.arguments);
          }
        }
        if (type === 'response.function_call_arguments.done') {
          const key = event.item_id || `tc_anon`;
          const tc = toolCallMap.get(key);
          if (tc) tc.function.arguments = String(event.arguments || '');
          if (tc && event.name) tc.function.name = event.name;
        }
      } catch (_) {}
    }
  }
  const toolCalls = [...toolCallMap.values()];
  return { text: fullText, toolCalls: toolCalls.length > 0 ? toolCalls : null };
}

/**
 * 流式：将后端 SSE 转为 OpenAI Chat Completions SSE 格式并写入 res
 * @param {object} [opts] - { onFinish(completionChars) } 流结束时回调，用于用量统计
 */
function pipeStreamToOpenAI(backendStream, res, model, id, opts = {}) {
  const dec = new TextDecoder();
  let buffer = '';
  let hasSentRole = false;
  let completionChars = 0;
  const onFinish = opts.onFinish || (() => {});
  const toolCallsByItemId = new Map();
  let nextToolIndex = 0;

  const ensureToolCallState = (itemId, meta = {}) => {
    const key = String(itemId || `anon_${nextToolIndex}`);
    let state = toolCallsByItemId.get(key);
    if (!state) {
      const preferredIndex = Number.isInteger(meta.output_index) ? meta.output_index : nextToolIndex++;
      state = {
        index: preferredIndex,
        id: meta.call_id || meta.id || `call_${preferredIndex}`,
        name: '',
        arguments: '',
        nameSent: false,
      };
      toolCallsByItemId.set(key, state);
    }
    if (meta.call_id) state.id = meta.call_id;
    if (meta.id && !state.id) state.id = meta.id;
    return state;
  };

  const sendToolCallName = (state, name) => {
    if (!name || state.nameSent) return;
    state.name = String(name);
    state.nameSent = true;
    sendDelta({
      tool_calls: [{
        index: state.index,
        id: state.id,
        type: 'function',
        function: { name: state.name },
      }],
    });
  };

  const sendToolCallArguments = (state, argDelta) => {
    if (!argDelta) return;
    const s = String(argDelta);
    state.arguments += s;
    sendDelta({
      tool_calls: [{
        index: state.index,
        id: state.id,
        type: 'function',
        function: { arguments: s },
      }],
    });
  };

  const sendChunk = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const sendDelta = (delta, finishReason = null) => {
    const choice = { index: 0, delta, finish_reason: finishReason };
    sendChunk({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [choice],
    });
  };
  let streamedTextLength = 0;
  const reader = backendStream.getReader();
  (async () => {
    const finalize = () => {
      const hasTools = toolCallsByItemId.size > 0;
      const reason = hasTools ? 'tool_calls' : 'stop';
      onFinish(completionChars);
      if (!hasSentRole) sendDelta({ role: 'assistant' });
      sendDelta({}, reason);
      res.write('data: [DONE]\n\n');
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += dec.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') {
            finalize();
            return;
          }
          try {
            const event = JSON.parse(data);
            const type = event.type;

            if (type === 'response.completed' || type === 'response.done') {
              // Extract any remaining text from the completed response output
              const output = event.response?.output;
              if (Array.isArray(output)) {
                for (const item of output) {
                  if (item.type === 'message' && Array.isArray(item.content)) {
                    for (const part of item.content) {
                      if (part.type === 'output_text' && part.text) {
                        const fullText = String(part.text);
                        if (fullText.length > streamedTextLength) {
                          const missed = fullText.slice(streamedTextLength);
                          if (missed) {
                            completionChars += missed.length;
                            if (!hasSentRole) {
                              sendDelta({ role: 'assistant' });
                              hasSentRole = true;
                            }
                            sendDelta({ content: missed });
                            streamedTextLength = fullText.length;
                          }
                        }
                      }
                    }
                  }
                  // Also handle function_calls that may only appear in response.completed
                  if (item.type === 'function_call' && item.name) {
                    if (!hasSentRole) {
                      sendDelta({ role: 'assistant' });
                      hasSentRole = true;
                    }
                    const itemId = item.id || `output_${nextToolIndex}`;
                    const state = ensureToolCallState(itemId, { ...item, output_index: nextToolIndex });
                    sendToolCallName(state, item.name);
                    if (item.arguments && String(item.arguments).length > state.arguments.length) {
                      const fullArgs = String(item.arguments);
                      if (state.arguments.length === 0) {
                        sendToolCallArguments(state, fullArgs);
                      } else if (fullArgs.startsWith(state.arguments)) {
                        sendToolCallArguments(state, fullArgs.slice(state.arguments.length));
                      } else {
                        state.arguments = '';
                        sendToolCallArguments(state, fullArgs);
                      }
                    }
                  }
                }
              }
              finalize();
              return;
            }

            // reasoning summary events → 转为 reasoning_content delta（保持 Codex 思维链可见性）
            if (type === 'response.reasoning_summary_text.delta' && event.delta) {
              if (!hasSentRole) {
                sendDelta({ role: 'assistant' });
                hasSentRole = true;
              }
              sendDelta({ reasoning_content: event.delta });
              continue;
            }

            if (type === 'response.output_text.delta' && event.delta) {
              const d = String(event.delta);
              completionChars += d.length;
              streamedTextLength += d.length;
              if (!hasSentRole) {
                sendDelta({ role: 'assistant' });
                hasSentRole = true;
              }
              sendDelta({ content: d });
              continue;
            }

            // response.output_text.done — contains the full text of an output_text part;
            // use it to recover any content that delta events may have missed
            if (type === 'response.output_text.done' && event.text) {
              const fullText = String(event.text);
              if (fullText.length > streamedTextLength) {
                const missed = fullText.slice(streamedTextLength);
                completionChars += missed.length;
                streamedTextLength = fullText.length;
                if (!hasSentRole) {
                  sendDelta({ role: 'assistant' });
                  hasSentRole = true;
                }
                sendDelta({ content: missed });
              }
              continue;
            }

            // response.output_item.done with type 'message' — may contain full text
            // that was never streamed via delta events (Codex sometimes skips deltas)
            if (type === 'response.output_item.done' && event.item?.type === 'message') {
              const content = event.item.content;
              if (Array.isArray(content)) {
                for (const part of content) {
                  if (part.type === 'output_text' && part.text) {
                    const fullText = String(part.text);
                    if (fullText.length > streamedTextLength) {
                      const missed = fullText.slice(streamedTextLength);
                      completionChars += missed.length;
                      streamedTextLength = fullText.length;
                      if (!hasSentRole) {
                        sendDelta({ role: 'assistant' });
                        hasSentRole = true;
                      }
                      sendDelta({ content: missed });
                    }
                  }
                }
              }
              continue;
            }

            if ((type === 'response.output_item.added' || type === 'response.output_item.done') && event.item?.type === 'function_call') {
              if (!hasSentRole) {
                sendDelta({ role: 'assistant' });
                hasSentRole = true;
              }
              const item = event.item || {};
              const itemId = item.id || event.item_id || `output_${event.output_index ?? nextToolIndex}`;
              const state = ensureToolCallState(itemId, { ...item, output_index: event.output_index });
              sendToolCallName(state, item.name);
              if (type === 'response.output_item.done' && item.arguments) {
                const fullArgs = String(item.arguments);
                if (state.arguments.length === 0) {
                  sendToolCallArguments(state, fullArgs);
                } else if (fullArgs.startsWith(state.arguments) && fullArgs.length > state.arguments.length) {
                  sendToolCallArguments(state, fullArgs.slice(state.arguments.length));
                } else if (fullArgs !== state.arguments) {
                  state.arguments = '';
                  sendToolCallArguments(state, fullArgs);
                }
              }
              continue;
            }

            if (type === 'response.function_call_arguments.delta') {
              if (!hasSentRole) {
                sendDelta({ role: 'assistant' });
                hasSentRole = true;
              }
              const itemId = event.item_id || `output_${event.output_index ?? nextToolIndex}`;
              const state = ensureToolCallState(itemId, { output_index: event.output_index });
              sendToolCallArguments(state, event.delta || '');
              continue;
            }

            if (type === 'response.function_call_arguments.done') {
              const itemId = event.item_id || `output_${event.output_index ?? nextToolIndex}`;
              const state = ensureToolCallState(itemId, { output_index: event.output_index });
              const fullArgs = String(event.arguments || '');
              if (fullArgs && fullArgs.length > state.arguments.length && fullArgs.startsWith(state.arguments)) {
                sendToolCallArguments(state, fullArgs.slice(state.arguments.length));
              } else if (fullArgs && fullArgs !== state.arguments) {
                state.arguments = '';
                sendToolCallArguments(state, fullArgs);
              }
              if (event.name) sendToolCallName(state, event.name);
            }
          } catch (_) {}
        }
      }
      finalize();
    } catch (e) {
      onFinish(completionChars);
      sendDelta({ content: `\n[Error: ${e.message}]` }, 'stop');
      res.write('data: [DONE]\n\n');
    } finally {
      res.end();
    }
  })();
}

/**
 * 调用 Codex 后端（仅支持 Codex token，不支持纯 api_key 调此接口）
 */
/**
 * 解析认证：authProvider 可为路径字符串、auth 对象、或 () => auth 的 getter
 */
function resolveAuth(authProvider) {
  if (typeof authProvider === 'function') return authProvider();
  if (authProvider && typeof authProvider === 'object' && authProvider.accessToken) return authProvider;
  return loadAuth(authProvider);
}

export async function callCodexBackend(openaiReq, authProvider = null) {
  const auth = resolveAuth(authProvider);
  if (auth.type !== 'codex') {
    throw new Error('ChatGPT/Codex 反代需要 access_token + account_id，请使用 Codex 登录后的 auth.json');
  }
  const body = buildResponsesRequest(openaiReq);
  const sessionId = randomUUID();
  const headers = {
    ...BROWSER_HEADERS,
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${auth.accessToken}`,
    'chatgpt-account-id': auth.accountId,
    'session_id': sessionId,
  };
  const res = await fetch(BACKEND_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const status = res.status;
    if (status === 401 || status === 403) {
      markAccountUnavailable(auth.accountId);
      clearUsage(auth.accountId);
    }
    const text = await res.text();
    throw new Error(`Codex 后端错误 ${status}: ${text.slice(0, 500)}`);
  }
  return { response: res, model: body.model, stream: body.stream, auth };
}

/**
 * 处理一次 Chat Completions 请求：流式或非流式，支持多账号故障切换（失败时自动尝试下一账号）
 * @param {object} openaiReq - 请求体
 * @param {object} res - Express res
 * @param {Function} authProvider - () => auth 或轮询 getter，失败时可多次调用取下一账号
 * @param {number} accountCount - 账号数量，用于故障切换最大重试次数
 * @returns {Promise<object|null>} 成功时返回本次使用的 auth，失败返回 null
 */
export async function handleChatCompletions(openaiReq, res, authProvider = null, accountCount = 1) {
  const stream = openaiReq.stream === true;
  const model = openaiReq.model || 'gpt-5.3-codex';
  const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`;
  const maxTries = Math.max(1, Number(accountCount) || 1);
  let lastError = null;

  for (let tryIndex = 0; tryIndex < maxTries; tryIndex++) {
    try {
      const auth = typeof authProvider === 'function' ? authProvider() : null;
      const provider = auth ? () => auth : authProvider;
      const { response: backendRes, model: backendModel, auth: usedAuth } = await callCodexBackend(openaiReq, provider);
      const who = usedAuth || auth;
      const promptTokens = estimatePromptTokens(openaiReq);
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');
        pipeStreamToOpenAI(backendRes.body, res, backendModel, id, {
          onFinish: (completionChars) => {
            if (who?.accountId) {
              recordUsage(who.accountId, {
                prompt_tokens: promptTokens,
                completion_tokens: Math.ceil(completionChars / 4),
              });
            }
          },
        });
        return who ?? null;
      }
      const result = await parseStreamToResult(backendRes.body);
      const completionChars = result.text.length + (result.toolCalls || []).reduce((s, tc) => s + (tc.function?.arguments?.length || 0), 0);
      const completionTokens = Math.ceil(completionChars / 4);
      if (who?.accountId) {
        recordUsage(who.accountId, { prompt_tokens: promptTokens, completion_tokens: completionTokens });
      }
      const message = { role: 'assistant', content: result.text || null };
      if (result.toolCalls) message.tool_calls = result.toolCalls;
      res.json({
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: backendModel,
        choices: [
          {
            index: 0,
            message,
            finish_reason: result.toolCalls ? 'tool_calls' : 'stop',
          },
        ],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      });
      return who ?? null;
    } catch (e) {
      lastError = e;
      if (res.headersSent) throw e;
      const status = e.message && /^\D*(\d{3})/.exec(e.message);
      const code = status ? Number(status[1]) : 0;
      const isRetryable = code >= 400 && code < 600;
      if (!isRetryable || tryIndex >= maxTries - 1) break;
    }
  }

  if (!res.headersSent) {
    let msg = lastError?.message ?? 'Proxy error';
    if (msg === 'fetch failed' || /^fetch failed/i.test(msg)) {
      msg = 'fetch failed: 无法连接 Codex 后端 (chatgpt.com)。请检查网络/VPN，并确认已添加至少一个 Codex 账号。详见配置页或 README。';
    }
    res.status(500).json({
      error: {
        message: msg,
        type: 'proxy_error',
        code: 'internal_error',
      },
    });
  }
  return null;
}


