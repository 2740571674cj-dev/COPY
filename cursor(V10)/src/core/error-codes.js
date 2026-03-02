const ERROR_CODES = {
  // === 不可重试（用户/安全类） ===
  PATH_TRAVERSAL: { code: 'E_PATH_TRAVERSAL', message: 'Path traversal detected: access outside project directory is forbidden', recoverable: false, retryStrategy: 'none', maxRetries: 0 },
  CMD_BLOCKED: { code: 'E_CMD_BLOCKED', message: 'Command blocked by security policy', recoverable: false, retryStrategy: 'none', maxRetries: 0 },
  APPROVAL_DENIED: { code: 'E_APPROVAL_DENIED', message: 'User denied the operation', recoverable: false, retryStrategy: 'none', maxRetries: 0 },
  MAX_ITERATIONS: { code: 'E_MAX_ITERATIONS', message: 'Agent reached maximum iteration limit', recoverable: false, retryStrategy: 'none', maxRetries: 0 },
  BUDGET_EXCEEDED: { code: 'E_BUDGET_EXCEEDED', message: 'Token budget exceeded', recoverable: false, retryStrategy: 'none', maxRetries: 0 },
  TOOL_NOT_FOUND: { code: 'E_TOOL_NOT_FOUND', message: 'Unknown tool name', recoverable: false, retryStrategy: 'none', maxRetries: 0 },

  // === 可重试 — 需要模型修正输入 ===
  MATCH_NOT_FOUND: { code: 'E_MATCH_NOT_FOUND', message: 'old_string not found in file content', recoverable: true, retryStrategy: 'reread_then_retry', maxRetries: 3 },
  MULTIPLE_MATCHES: { code: 'E_MULTIPLE_MATCHES', message: 'old_string matches multiple locations — provide more context', recoverable: true, retryStrategy: 'add_context', maxRetries: 2 },
  FILE_NOT_FOUND: { code: 'E_FILE_NOT_FOUND', message: 'File not found', recoverable: true, retryStrategy: 'search_then_retry', maxRetries: 1 },
  FILE_TOO_LARGE: { code: 'E_FILE_TOO_LARGE', message: 'File exceeds size limit', recoverable: true, retryStrategy: 'model_decide', maxRetries: 0 },
  INVALID_PARAMS: { code: 'E_INVALID_PARAMS', message: 'Invalid or missing tool parameters', recoverable: true, retryStrategy: 'fix_params', maxRetries: 2 },

  // === 可重试 — 系统级，自动退避 ===
  LLM_ERROR: { code: 'E_LLM_ERROR', message: 'LLM API call failed', recoverable: true, retryStrategy: 'auto_backoff', maxRetries: 3 },
  TOOL_TIMEOUT: { code: 'E_TOOL_TIMEOUT', message: 'Tool execution timed out', recoverable: true, retryStrategy: 'auto_backoff', maxRetries: 2 },
  CMD_TIMEOUT: { code: 'E_CMD_TIMEOUT', message: 'Command timed out', recoverable: true, retryStrategy: 'auto_backoff', maxRetries: 1 },
  WRITE_FAILED: { code: 'E_WRITE_FAILED', message: 'Failed to write file', recoverable: true, retryStrategy: 'auto_backoff', maxRetries: 1 },
  CMD_FAILED: { code: 'E_CMD_FAILED', message: 'Command exited with non-zero code', recoverable: true, retryStrategy: 'model_decide', maxRetries: 0 },
};

function makeError(errorDef, details = '') {
  return {
    success: false,
    error: details ? `${errorDef.message}: ${details}` : errorDef.message,
    code: errorDef.code,
    recoverable: errorDef.recoverable,
  };
}

module.exports = { ERROR_CODES, makeError };
