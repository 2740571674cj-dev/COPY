const { ERROR_CODES, makeError } = require('./error-codes');
const { validatePath, needsApproval } = require('./security-layer');

const TOOL_ALIASES = {
  'search_files': 'grep_search',
  'glob_search': 'file_search',
  'list_directory': 'list_dir',
};

const READONLY_MODES = new Set(['plan', 'ask', 'chat', 'debug']);
const READONLY_MODE_TOOLS = new Set([
  'read_file',
  'grep_search',
  'file_search',
  'list_dir',
  'read_lints',
  'diff_history',
  'codebase_search',
  'todo_write',
  'ask_question',
  'switch_mode',
  'web_search',
  'web_fetch',
]);

class ToolExecutor {
  constructor() {
    this.registry = new Map();
  }

  register(toolDef) {
    if (!toolDef.name || !toolDef.handler) {
      throw new Error(`Invalid tool definition: missing name or handler`);
    }
    this.registry.set(toolDef.name, toolDef);
  }

  getDefinitions(options = {}) {
    const mode = typeof options === 'string' ? options : options.mode;
    const webSearchEnabled = typeof options === 'object' ? options.webSearchEnabled : undefined;

    let defs = Array.from(this.registry.values()).map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    if (mode && READONLY_MODES.has(mode)) {
      defs = defs.filter(t => READONLY_MODE_TOOLS.has(t.name));
    }
    if (webSearchEnabled === false) {
      defs = defs.filter(t => t.name !== 'web_search' && t.name !== 'web_fetch');
    }

    return defs;
  }

  getTool(name) {
    return this.registry.get(name) || this.registry.get(TOOL_ALIASES[name]);
  }

  getAllToolNames() {
    return Array.from(this.registry.keys());
  }

  async execute(name, args, projectPath, context = {}) {
    const tool = this.registry.get(name) || this.registry.get(TOOL_ALIASES[name]);
    if (!tool) {
      return makeError(ERROR_CODES.TOOL_NOT_FOUND, name);
    }

    const requiredParams = tool.parameters?.required || [];
    for (const param of requiredParams) {
      if (args[param] === undefined || args[param] === null) {
        return makeError(ERROR_CODES.INVALID_PARAMS, `Missing required parameter: ${param}`);
      }
    }

    // 按工具类型设不同默认超时
    const LONG_TIMEOUT_TOOLS = new Set(['run_terminal_cmd', 'task', 'web_fetch', 'web_search', 'browser_use']);
    const defaultTimeout = LONG_TIMEOUT_TOOLS.has(name) ? 120000 : 30000;
    const timeout = tool.timeout || defaultTimeout;
    const startTime = Date.now();
    let timeoutId;
    try {
      let result = await Promise.race([
        tool.handler(args, projectPath, context),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('TOOL_TIMEOUT')), timeout);
        }),
      ]);
      clearTimeout(timeoutId);
      // Guard: handler may return null/undefined/non-object
      if (!result || typeof result !== 'object') {
        result = { success: true, data: result };
      }
      const elapsed = Date.now() - startTime;
      // 1.1: Envelope meta wrapper (estimate tokens BEFORE attaching meta to avoid circular ref)
      const tokenEstimate = this._estimateTokens(result);
      result.meta = {
        tool: name,
        execution_time_ms: elapsed,
        token_estimate: tokenEstimate,
        retryable: result.success === false,
        idempotent: !!result.alreadyApplied,
      };
      return result;
    } catch (err) {
      clearTimeout(timeoutId);
      const elapsed = Date.now() - startTime;
      if (err.message === 'TOOL_TIMEOUT') {
        const errResult = makeError(ERROR_CODES.TOOL_TIMEOUT, `${name} exceeded ${timeout}ms`);
        errResult.meta = { tool: name, execution_time_ms: elapsed, token_estimate: 0, retryable: true, idempotent: false };
        return errResult;
      }
      const errResult = { success: false, error: err.message, code: 'E_TOOL_EXEC' };
      errResult.meta = { tool: name, execution_time_ms: elapsed, token_estimate: 0, retryable: true, idempotent: false };
      return errResult;
    }
  }

  _estimateTokens(result) {
    try {
      const str = JSON.stringify(result);
      // Size cap: 超过 1MB 直接粗估，避免 CJK regex 对巨大字符串的性能问题
      if (str.length > 1048576) return Math.ceil(str.length / 4);
      const cjkChars = (str.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
      const otherChars = str.length - cjkChars;
      return Math.ceil(cjkChars / 1.5 + otherChars / 4);
    } catch (_) { return 0; }
  }
}

module.exports = { ToolExecutor };
