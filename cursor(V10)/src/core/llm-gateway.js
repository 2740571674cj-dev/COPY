const { AgentTracer } = require('./agent-tracer');
const { getAdapter, supportsCaching } = require('./model-adapters');

class LLMGateway {
  constructor({ loadModels }) {
    this.loadModels = loadModels;
  }

  _ensureUserLastMessage(messages) {
    const patched = Array.isArray(messages) ? messages.map(m => ({ ...m })) : [];
    if (patched.length === 0) {
      return [{ role: 'user', content: 'Please continue with the task.' }];
    }
    const last = patched[patched.length - 1];
    if (last?.role === 'user') return patched;

    let prompt = 'Please continue based on the conversation above.';
    if (last?.role === 'tool') {
      prompt = 'Please continue based on the tool results above.';
    } else if (last?.role === 'assistant') {
      prompt = 'Please continue from your previous response without repeating it, then proceed with the next actionable step.';
    } else if (last?.role === 'system') {
      prompt = 'Please follow the latest system instructions and continue with the next actionable step.';
    }

    patched.push({ role: 'user', content: prompt });
    return patched;
  }

  // [comment] messages [comment] assistant[comment]
  // [comment] assistant(tool_calls) [comment] tool [comment]
  _sanitizeMessagesStrict(messages) {
    if (!messages || messages.length === 0) return messages;
    const result = [];
    for (let i = 0; i < messages.length; i++) {
      const cur = { ...messages[i] };
      if (messages[i].tool_calls) cur.tool_calls = messages[i].tool_calls;
      const prev = result.length > 0 ? result[result.length - 1] : null;

      if (prev && prev.role === 'assistant' && cur.role === 'assistant') {
        const prevHasTC = !!(prev.tool_calls && prev.tool_calls.length > 0);
        const curHasTC = !!(cur.tool_calls && cur.tool_calls.length > 0);
        if (!prevHasTC && !curHasTC) {
          prev.content = ((prev.content || '') + '\n\n' + (cur.content || '')).trim();
          continue;
        } else if (prevHasTC && !curHasTC) {
          cur.role = 'user';
          cur.content = '[note] ' + (cur.content || '');
        } else if (!prevHasTC && curHasTC) {
          prev.role = 'user';
          prev.content = '[note] ' + (prev.content || '');
        } else {
          result.push({ role: 'user', content: 'Continue.' });
        }
      }
      result.push(cur);
    }
    return result;
  }

  _mergeToolName(currentName, incomingName) {
    if (!incomingName) return currentName || '';
    if (!currentName) return incomingName;
    if (currentName === incomingName) return currentName;

    // Some providers send cumulative chunks: "read_" -> "read_file"
    if (incomingName.startsWith(currentName)) return incomingName;

    // Some providers resend partial/full name; avoid duplicating.
    if (currentName.startsWith(incomingName) || currentName.endsWith(incomingName)) {
      return currentName;
    }

    // Merge incremental suffix chunks with overlap, e.g. "read_" + "file"
    const maxOverlap = Math.min(currentName.length, incomingName.length);
    for (let i = maxOverlap; i > 0; i--) {
      if (currentName.slice(-i) === incomingName.slice(0, i)) {
        return currentName + incomingName.slice(i);
      }
    }

    return currentName + incomingName;
  }

  /**
   * [comment] tool_calls [comment]?   * [comment] XML [comment]?system [comment]?   */
  _buildToolPrompt(tools) {
    if (!tools || tools.length === 0) return '';

    const toolDescriptions = tools.map(t => {
      const params = t.parameters?.properties || {};
      const required = t.parameters?.required || [];
      const paramLines = Object.entries(params).map(([name, schema]) => {
        const req = required.includes(name) ? ' (required)' : ' (optional)';
        return `  - ${name}${req}: ${schema.description || schema.type || 'string'}`;
      }).join('\n');
      return `### ${t.name}\n${t.description || ''}\nParameters:\n${paramLines}`;
    }).join('\n\n');

    return '\n\n## Available Tools\n\n'
      + 'You have access to the following tools. To call a tool, output an XML block like this:\n\n'
      + '```xml\n'
      + '<tool_name>\n'
      + '<param_name>value</param_name>\n'
      + '</tool_name>\n'
      + '```\n\n'
      + 'Example - to read a file:\n'
      + '```xml\n'
      + '<read_file>\n'
      + '<path>src/main.js</path>\n'
      + '<explanation>Read the main entry file</explanation>\n'
      + '</read_file>\n'
      + '```\n\n'
      + 'IMPORTANT RULES:\n'
      + '- You MUST use XML tags to call tools. Do NOT describe tool calls in plain text.\n'
      + '- Use the tool name as the XML tag. Put each parameter as a child element.\n'
      + '- For JSON object/array parameters, output valid JSON as the parameter value.\n'
      + '- After outputting a tool call XML block, STOP and wait for the tool results.\n'
      + '- You can call multiple tools by outputting multiple XML blocks.\n\n'
      + toolDescriptions;
  }

  /**
   * [comment]?XML [comment]?   * [comment]?tool_calls [comment]?deepseek-reasoner[comment]?   */
  _parseXmlToolCalls(content, toolDefs) {
    if (!content || typeof content !== 'string') return [];

    const toolCalls = [];

    // Format 1: <function_calls><invoke name="tool">...</invoke></function_calls>
    const fcRegex = /<function_calls>([\s\S]*?)<\/function_calls>/g;
    let fcMatch;
    while ((fcMatch = fcRegex.exec(content)) !== null) {
      const fcBlock = fcMatch[1];
      const invokeRegex = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
      let invokeMatch;
      while ((invokeMatch = invokeRegex.exec(fcBlock)) !== null) {
        const toolName = invokeMatch[1];
        const paramsBlock = invokeMatch[2];
        const params = {};
        const paramRegex = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
        let paramMatch;
        while ((paramMatch = paramRegex.exec(paramsBlock)) !== null) {
          let val = paramMatch[2].trim();
          try { val = JSON.parse(val); } catch (_) { }
          params[paramMatch[1]] = val;
        }
        toolCalls.push({
          id: `xmlcall_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${toolCalls.length}`,
          type: 'function',
          function: {
            name: toolName,
            arguments: JSON.stringify(params),
          },
        });
      }
    }

    if (toolCalls.length > 0) return toolCalls;

    // Format 2: Direct tag format - <tool_name><param>value</param></tool_name>
    // deepseek-reasoner often outputs this format instead of the instructed XML format
    const knownTools = new Set();
    if (toolDefs && Array.isArray(toolDefs)) {
      for (const t of toolDefs) knownTools.add(t.name);
    }
    if (knownTools.size === 0) {
      for (const n of ['read_file', 'write_file', 'edit_file', 'list_dir', 'grep_search',
        'file_search', 'run_terminal_cmd', 'delete_file', 'create_file', 'todo_write',
        'read_lints', 'diff_history', 'codebase_search', 'web_search', 'web_fetch',
        'ask_question', 'switch_mode', 'reapply', 'generate_image', 'browser_use']) {
        knownTools.add(n);
      }
    }

    for (const toolName of knownTools) {
      const directRegex = new RegExp('<' + toolName + '\\b[^>]*>([\\s\\S]*?)<\\/' + toolName + '>', 'g');
      let directMatch;
      while ((directMatch = directRegex.exec(content)) !== null) {
        const innerBlock = directMatch[1];
        const params = {};
        const childRegex = /<([a-z_][a-z0-9_]*)(?:\s[^>]*)?>([^<]*(?:<(?!\/\1>)[^<]*)*)<\/\1>/gi;
        let childMatch;
        while ((childMatch = childRegex.exec(innerBlock)) !== null) {
          let val = childMatch[2].trim();
          try { val = JSON.parse(val); } catch (_) { }
          params[childMatch[1]] = val;
        }
        toolCalls.push({
          id: `xmlcall_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${toolCalls.length}`,
          type: 'function',
          function: {
            name: toolName,
            arguments: JSON.stringify(params),
          },
        });
      }
    }

    // Format 3: [Tool Call: tool_name] {json_args}
    // deepseek-reasoner sometimes mimics the _convertMessagesForNonToolModel format
    if (toolCalls.length === 0) {
      const headerRegex = /\[Tool Call:\s*([a-z_][a-z0-9_]*)\]\s*\{/gi;
      let headerMatch;
      while ((headerMatch = headerRegex.exec(content)) !== null) {
        const toolName = headerMatch[1];
        const braceStart = content.lastIndexOf('{', headerMatch.index + headerMatch[0].length - 1);
        if (braceStart < 0) continue;
        let depth = 0, end = -1;
        for (let i = braceStart; i < content.length; i++) {
          if (content[i] === '{') depth++;
          else if (content[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end < 0) continue;
        const jsonStr = content.substring(braceStart, end + 1);
        let args = {};
        try {
          args = JSON.parse(jsonStr);
        } catch (_) {
          continue;
        }
        toolCalls.push({
          id: `xmlcall_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${toolCalls.length}`,
          type: 'function',
          function: {
            name: toolName,
            arguments: JSON.stringify(args),
          },
        });
        headerRegex.lastIndex = end + 1;
      }
    }

    return toolCalls;
  }

  /**
   * [comment]?content [comment]?XML [comment]?   */
  _removeToolCallXml(content, toolDefs) {
    if (!content) return '';
    // Remove Format 1
    let cleaned = content.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '');
    // Remove Format 2 (direct tags)
    const knownTools = new Set();
    if (toolDefs && Array.isArray(toolDefs)) {
      for (const t of toolDefs) knownTools.add(t.name);
    }
    if (knownTools.size === 0) {
      for (const n of ['read_file', 'write_file', 'edit_file', 'list_dir', 'grep_search',
        'file_search', 'run_terminal_cmd', 'delete_file', 'create_file', 'todo_write',
        'read_lints', 'diff_history', 'codebase_search', 'web_search', 'web_fetch',
        'ask_question', 'switch_mode', 'reapply', 'generate_image', 'browser_use']) {
        knownTools.add(n);
      }
    }
    for (const toolName of knownTools) {
      const re = new RegExp('<' + toolName + '\\b[^>]*>[\\s\\S]*?<\\/' + toolName + '>', 'g');
      cleaned = cleaned.replace(re, '');
    }
    // Remove Format 3: [Tool Call: tool_name] {json_args}
    cleaned = this._removeBracketToolCalls(cleaned);
    return cleaned.trim();
  }

  _removeBracketToolCalls(content) {
    const regex = /\[Tool Call:\s*[a-z_][a-z0-9_]*\]\s*\{/gi;
    let match;
    const ranges = [];
    while ((match = regex.exec(content)) !== null) {
      const braceStart = content.indexOf('{', match.index + match[0].length - 1);
      if (braceStart < 0) continue;
      let depth = 0, end = -1;
      for (let i = braceStart; i < content.length; i++) {
        if (content[i] === '{') depth++;
        else if (content[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end > 0) {
        ranges.push([match.index, end + 1]);
      }
    }
    if (ranges.length === 0) return content;
    let result = '';
    let lastEnd = 0;
    for (const [start, end] of ranges) {
      result += content.substring(lastEnd, start);
      lastEnd = end;
    }
    result += content.substring(lastEnd);
    return result;
  }

  _buildApiUrl(baseUrl) {
    const trimmed = (baseUrl || '').trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
    if (/\/v1$/i.test(trimmed)) return trimmed + '/chat/completions';
    return trimmed + '/v1/chat/completions';
  }

  /**
   * [comment]?tool role [comment]?tool_calls [comment]?messages [comment]
   * [comment] tool_calls [comment]?   */
  _convertMessagesForNonToolModel(messages) {
    const result = [];
    for (const m of messages) {
      if (m.role === 'tool') {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        result.push({
          role: 'user',
          content: `<tool_result>\n${content}\n</tool_result>`,
        });
      } else if (m.role === 'assistant' && m.tool_calls) {
        const cleaned = { role: 'assistant', content: m.content || '' };
        const tcText = m.tool_calls.map(tc => {
          const name = tc.function?.name || 'unknown';
          const args = tc.function?.arguments || '{}';
          let paramsXml = '';
          try {
            const parsed = JSON.parse(args);
            paramsXml = Object.entries(parsed).map(([k, v]) => {
              const val = typeof v === 'string' ? v : JSON.stringify(v);
              return `<${k}>${val}</${k}>`;
            }).join('\n');
          } catch (_) {
            paramsXml = `<arguments>${args}</arguments>`;
          }
          return `<${name}>\n${paramsXml}\n</${name}>`;
        }).join('\n');
        if (tcText) {
          cleaned.content = (cleaned.content ? cleaned.content + '\n' : '') + tcText;
        }
        if (cleaned.content) result.push(cleaned);
      } else {
        const cleaned = { ...m };
        delete cleaned.tool_calls;
        delete cleaned.tool_call_id;
        // [comment] content [comment] Prompt Caching [comment]?cache_control [comment]?        // [comment]?tool_calls [comment] content [comment]
        if (Array.isArray(cleaned.content)) {
          cleaned.content = cleaned.content.map(c => c.text || (typeof c === 'string' ? c : '')).join('');
        }
        result.push(cleaned);
      }
    }
    return result;
  }

  _mergeToolArguments(current, incoming) {
    if (!incoming) return current || '';
    if (!current) return incoming;

    // Case 1: Simple cumulative [comment]?incoming starts with current content [comment]?replace.
    if (incoming.length > current.length && incoming.startsWith(current)) {
      return incoming;
    }

    // Case 2: Exact duplicate chunk (same content resent) [comment]?keep current.
    if (incoming === current) return current;

    // Case 3: Current is a prefix of incoming with additional content (partial cumulative).
    // Some providers send overlapping chunks where incoming extends current.
    if (incoming.length > current.length && current.length >= 2) {
      const tail = current.slice(-Math.min(current.length, 20));
      const overlapIdx = incoming.indexOf(tail);
      if (overlapIdx >= 0 && overlapIdx < current.length) {
        return current + incoming.slice(overlapIdx + tail.length);
      }
    }

    // Default: incremental append (standard SSE streaming behavior).
    return current + incoming;
  }

  async streamChat({ modelId, messages, tools, toolChoice, onChunk, onDone, onError, signal }) {
    const models = this.loadModels();
    const model = models.find(m => m.id === modelId);
    if (!model) {
      onError({ error: 'Model not found', code: 'E_MODEL_NOT_FOUND' });
      return;
    }

    const url = this._buildApiUrl(model.baseUrl);
    const apiKey = (model.apiKey || '').trim().replace(/^\$\{(.+)\}$/, '$1').trim();
    const headers = {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      ...(model.headers || {}),
    };

    const maskedKey = apiKey ? apiKey.substring(0, 6) + '****' + apiKey.slice(-4) : '(none)';
    console.log('[LLMGateway] streamChat request:', {
      url,
      baseUrl: model.baseUrl,
      modelName: model.modelName,
      apiKey: maskedKey,
      hasCustomHeaders: Object.keys(model.headers || {}).length > 0,
    });
    // Pre-compute caching support (once, outside message loop)
    const cachingSupported = supportsCaching(model);

    const adapter = getAdapter(model.modelName || modelId);
    const llmCfg = adapter.llmConfig || {};

    // [comment]?tool_calls[comment] deepseek-reasoner [comment]?Function Calling[comment]?
    const modelSupportsTools = adapter.supportsToolCalls
      ? adapter.supportsToolCalls(model.modelName)
      : true;

    // [comment] tool_calls [comment] system [comment]?
    let toolPromptInjected = false;
    const mappedMessages = messages.map((m, idx) => {
      const msg = { role: m.role === 'ai' ? 'assistant' : m.role };
      if (m.content !== undefined) msg.content = m.content;
      if (m.text !== undefined && msg.content === undefined) msg.content = m.text;
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      // _reasoning [comment] messages [comment] API
      if (msg.content === undefined) msg.content = '';

      // Prompt Caching: [comment]?cache_control
      if (cachingSupported === true && msg.role === 'system' && typeof msg.content === 'string' && idx === 0) {
        msg.content = [
          { type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } },
        ];
      }

      return msg;
    });

    // [comment] tool_calls [comment] system [comment]
    if (!modelSupportsTools && tools && tools.length > 0) {
      const toolPrompt = this._buildToolPrompt(tools);
      if (toolPrompt && mappedMessages.length > 0 && mappedMessages[0].role === 'system') {
        const sysContent = mappedMessages[0].content;
        if (typeof sysContent === 'string') {
          mappedMessages[0].content = sysContent + toolPrompt;
        } else if (Array.isArray(sysContent) && sysContent[0]?.text) {
          sysContent[0].text = sysContent[0].text + toolPrompt;
        }
        toolPromptInjected = true;
      }
    }

    // [comment] tool_calls [comment]?messages [comment] tool_calls [comment]?tool role
    // [comment]?tool role [comment] user [comment]?
    const finalMessages = modelSupportsTools
      ? mappedMessages
      : this._convertMessagesForNonToolModel(mappedMessages);

    const { stream: _ignoreStream, ...safeExtraBody } = model.extraBody || {};
    const body = {
      model: model.modelName,
      messages: finalMessages,
      stream: true,
      ...safeExtraBody,
    };

    if (llmCfg.temperature !== undefined && body.temperature === undefined) {
      body.temperature = llmCfg.temperature;
    }
    if (llmCfg.parallelToolCalls === false) {
      body.parallel_tool_calls = false;
    }

    if (tools && tools.length > 0 && modelSupportsTools) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      if (toolChoice) {
        // Apply model-specific tool_choice mapping (e.g. Gemini: required [comment]?any)
        const mapping = llmCfg.toolChoiceMapping || {};
        body.tool_choice = mapping[toolChoice] || toolChoice;
      }
    }

    // [comment]
    if (llmCfg.requireUserLast === true) {
      body.messages = this._ensureUserLastMessage(body.messages);
    }

  // Fix: handle consecutive assistant messages in strictAlternation mode
    if (llmCfg.strictAlternation === true) {
      body.messages = this._sanitizeMessagesStrict(body.messages);
      // [comment] warn [comment]
      const roleSeq = body.messages.map(m => m.role).join(', ');
      console.log('[LLMGateway] strict roles:', roleSeq);
    }


    const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
    const MAX_RETRIES = 3;
    const USER_LAST_REQUIRED_RE = /(assistant message prefill|must end with a user message|conversation must end with a user message)/i;
    const isRetryableError = (err) => {
      if (err.name === 'AbortError') return false;
      const codeBag = [
        err.code,
        err.errno,
        err.cause?.code,
        err.cause?.errno,
      ].filter(Boolean).join(' ');
      const messageBag = `${err.message || ''} ${err.cause?.message || ''}`;
      return ['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'ERR_TLS'].some(
        c => codeBag.includes(c) || messageBag.includes(c)
      );
    };

    const adapterTimeouts = llmCfg.getTimeouts?.(model.modelName) || {};
    const fetchTimeoutMs = adapterTimeouts.fetchTimeout || 120000;

    let response;
    let userLastPatched = false;
    let lastHttpErrorBody = '';
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      let isInternalTimeout = false;
      const timeoutId = setTimeout(() => { isInternalTimeout = true; controller.abort(); }, fetchTimeoutMs);
      const onAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timeoutId);
          onError({ error: 'Request aborted', code: 'E_ABORTED' });
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        // Handle providers that reject assistant-prefill / non-user-ending messages.
        if (!response.ok && response.status === 400) {
          let errBody = '';
          try { errBody = await response.text(); } catch (_) { }
          lastHttpErrorBody = errBody;
          if (!userLastPatched && USER_LAST_REQUIRED_RE.test(errBody)) {
            body.messages = this._ensureUserLastMessage(body.messages);
            userLastPatched = true;
            if (signal) signal.removeEventListener('abort', onAbort);
            continue;
          }
        }

        if (!response.ok && RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
          if (signal) signal.removeEventListener('abort', onAbort);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        if (signal) signal.removeEventListener('abort', onAbort);
        break; // [comment] HTTP [comment]
      } catch (err) {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (err.name === 'AbortError') {
          // [comment]?
          if (isInternalTimeout && attempt < MAX_RETRIES) {
            const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          onError({ error: isInternalTimeout ? 'Request timed out' : 'Request aborted', code: isInternalTimeout ? 'E_TIMEOUT' : 'E_ABORTED' });
          return;
        }
        // [comment]
        if (isRetryableError(err) && attempt < MAX_RETRIES) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        onError({ error: `Network error: ${err.message}`, code: 'E_NETWORK' });
        return;
      }
    }

    if (!response.ok) {
      let errBody = lastHttpErrorBody || '';
      if (!errBody) {
        try { errBody = await response.text(); } catch (_) { }
      }
      const hint = response.status === 401
        ? ` [Debug] URL=${url}, Key=${maskedKey}. Please verify your API Key and Base URL in model settings.`
        : '';
      onError({ error: `HTTP ${response.status}: ${errBody.substring(0, 300)}${hint}`, code: `E_HTTP_${response.status}` });
      return;
    }

    let fullContent = '';
    let fullReasoning = '';
    const toolCallAccumulator = {};
    let buffer = '';
    let usageData = null; // [Token Dashboard] record usage of last chunk
    let lastFinishReason = null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const CHUNK_IDLE_TIMEOUT = adapterTimeouts.chunkIdleTimeout || 90000;
    const MAX_STREAM_DURATION = adapterTimeouts.maxStreamDuration || 150000;
    const streamStartTs = Date.now();
    let chunkTimerId = null;

    // Register abort listener once, not per-chunk
    let abortReject = null;
    const abortPromise = signal
      ? new Promise((_, reject) => { abortReject = reject; })
      : new Promise(() => { });
    const abortHandler = signal ? () => { if (abortReject) abortReject(new Error('Aborted')); } : null;
    if (signal && abortHandler) {
      if (signal.aborted) {
        onError({ error: 'Request aborted', code: 'E_ABORTED' });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    try {
      while (true) {
        if (Date.now() - streamStartTs > MAX_STREAM_DURATION) {
          try { reader.cancel(); } catch (_) { }
          if (fullContent || Object.keys(toolCallAccumulator).length > 0) {
            lastFinishReason = 'interrupted';
            break;
          }
          onError({
            error: `Stream max duration exceeded (${Math.round(MAX_STREAM_DURATION / 1000)}s)`,
            code: 'E_STREAM_MAX',
          });
          return;
        }

        // Clean up previous iteration's timer
        if (chunkTimerId) { clearTimeout(chunkTimerId); chunkTimerId = null; }

        const readPromise = reader.read();
        const timeoutPromise = new Promise((_, reject) => {
          chunkTimerId = setTimeout(() => reject(new Error(`Stream chunk idle timeout (${CHUNK_IDLE_TIMEOUT / 1000}s)`)), CHUNK_IDLE_TIMEOUT);
        });

        let done, value;
        try {
          ({ done, value } = await Promise.race([readPromise, timeoutPromise, abortPromise]));
        } catch (idleErr) {
          if (chunkTimerId) { clearTimeout(chunkTimerId); chunkTimerId = null; }
          try { reader.cancel(); } catch (_) { }
          if (fullContent || Object.keys(toolCallAccumulator).length > 0) {
            lastFinishReason = 'interrupted'; // Stream interrupted
            break;
          }
          onError({ error: `Stream interrupted: ${idleErr.message}`, code: 'E_STREAM_IDLE' });
          return;
        }
        if (chunkTimerId) { clearTimeout(chunkTimerId); chunkTimerId = null; }
        if (done) {
          // Flush TextDecoder internal buffer (may hold incomplete multi-byte chars)
          const remaining = decoder.decode();
          if (remaining) buffer += remaining;
          // Process any remaining data in buffer
          if (buffer.trim()) {
            const trimmed = buffer.trim();
            if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
              try {
                const parsed = JSON.parse(trimmed.slice(6));
                const delta = parsed.choices?.[0]?.delta;
                const message = parsed.choices?.[0]?.message;
                const finishReason = parsed.choices?.[0]?.finish_reason;
                const src = delta || message;
                if (src?.content) {
                  fullContent += src.content;
                  if (!toolPromptInjected) {
                    onChunk({ type: 'content', content: src.content, fullContent });
                  }
                }
                if (finishReason) lastFinishReason = finishReason;
                if (parsed.usage) usageData = parsed.usage; // [Token Dashboard]
              } catch (_) { }
            }
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const parsed = JSON.parse(trimmed.slice(6));
            const delta = parsed.choices?.[0]?.delta;
            const message = parsed.choices?.[0]?.message;
            const finishReason = parsed.choices?.[0]?.finish_reason;
            // Some providers (DeepSeek, etc.) put content/tool_calls in `message` instead of `delta`
            const src = delta || message;
            if (!src && !finishReason) continue;

            if (src?.content) {
              fullContent += src.content;
              // [comment]?content [comment] onDone [comment]?
              if (!toolPromptInjected) {
                onChunk({ type: 'content', content: src.content, fullContent });
              }
            }

            if (src?.reasoning_content) {
              fullReasoning += src.reasoning_content;
              onChunk({ type: 'reasoning', content: src.reasoning_content, fullReasoning });
            } else if (src?.reasoning) {
              fullReasoning += src.reasoning;
              onChunk({ type: 'reasoning', content: src.reasoning, fullReasoning });
            }

            const rawToolCalls = src?.tool_calls;
            if (rawToolCalls) {
              for (let i = 0; i < rawToolCalls.length; i++) {
                const tc = rawToolCalls[i];
                const idx = tc.index ?? i;
                if (!toolCallAccumulator[idx]) {
                  toolCallAccumulator[idx] = {
                    id: tc.id || `call_${idx}`,
                    type: 'function',
                    function: { name: '', arguments: '' },
                  };
                }
                if (tc.id) toolCallAccumulator[idx].id = tc.id;
                if (tc.function?.name) {
                  toolCallAccumulator[idx].function.name = this._mergeToolName(
                    toolCallAccumulator[idx].function.name,
                    tc.function.name
                  );
                }
                if (tc.function?.arguments !== undefined && tc.function?.arguments !== null) {
                  toolCallAccumulator[idx].function.arguments = this._mergeToolArguments(
                    toolCallAccumulator[idx].function.arguments,
                    tc.function.arguments
                  );
                }

                onChunk({
                  type: 'tool_call_delta',
                  index: idx,
                  toolCall: { ...toolCallAccumulator[idx] },
                });
              }
            }

            if (finishReason) {
              lastFinishReason = finishReason;
              // [Token Dashboard] [comment] usage [comment]
              if (parsed.usage) usageData = parsed.usage;
              onChunk({ type: 'finish', finishReason });
            }
          } catch (_) { }
        }
      }
    } catch (readErr) {
      onError({ error: `Stream read error: ${readErr.message}`, code: 'E_STREAM' });
      return;
    } finally {
      if (chunkTimerId) clearTimeout(chunkTimerId);
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    }

    let toolCalls = Object.values(toolCallAccumulator);

    // [comment] tool_calls [comment] XML [comment]?
    if (toolPromptInjected && toolCalls.length === 0 && fullContent) {
      const xmlToolCalls = this._parseXmlToolCalls(fullContent, tools);
      if (xmlToolCalls.length > 0) {
        toolCalls = xmlToolCalls;
        fullContent = this._removeToolCallXml(fullContent, tools);
      }
      // [comment]
      // [comment]?UI [comment]?
      if (fullContent) {
        onChunk({ type: 'content', content: fullContent, fullContent });
      }
    }

    onDone({
      content: fullContent,
      usage: usageData, // [Token Dashboard] pass usage to controller
      reasoning: fullReasoning,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      model: model.modelName,
      finish_reason: lastFinishReason || null,
      truncated: lastFinishReason === 'length',
      interrupted: lastFinishReason === 'interrupted',
    });
  }
}

module.exports = { LLMGateway };
