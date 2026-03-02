const fs = require('fs');
const path = require('path');
const { validatePath } = require('../core/security-layer');

// Session-scoped storage for last edit attempts (prevents cross-session leaks).
const sessionEditAttempts = new Map();

function setLastEditAttempt(data, sessionId = '_default') {
  sessionEditAttempts.set(sessionId, data);
}

function clearSession(sessionId) {
  sessionEditAttempts.delete(sessionId);
}

const tool = {
  name: 'reapply',
  description: `Calls a smarter model to apply the last edit to the specified file. Use this tool immediately after an edit_file call ONLY IF the result was not what you expected, indicating the matching logic was not smart enough to follow your instructions.`,
  parameters: {
    type: 'object',
    properties: {
      target_file: {
        type: 'string',
        description: 'The relative path to the file to reapply the last edit to.',
      },
    },
    required: ['target_file'],
  },
  riskLevel: 'medium',
  timeout: 15000,

  async handler(args, projectPath, contextOrSessionId = '_default') {
    // tool-executor passes a context object { agentLoopFactory, modelId, todoStore, sessionId? }
    // as the 3rd arg; extract sessionId from it, falling back to string or default.
    const sessionId = (typeof contextOrSessionId === 'object' && contextOrSessionId !== null)
      ? (contextOrSessionId.sessionId || '_default')
      : (contextOrSessionId || '_default');
    const lastEditAttempt = sessionEditAttempts.get(sessionId) || null;
    if (!lastEditAttempt) {
      return { success: false, error: 'No previous edit attempt to reapply.', code: 'E_NO_PREV_EDIT' };
    }

    const check = validatePath(args.target_file, projectPath);
    if (!check.valid) return check;

    const fullPath = check.resolvedPath;
    if (!fs.existsSync(fullPath)) {
      return { success: false, error: `File not found: ${args.target_file}`, code: 'E_FILE_NOT_FOUND' };
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    const { old_string, new_string } = lastEditAttempt;

    if (!old_string || !new_string) {
      return { success: false, error: 'Invalid previous edit data.', code: 'E_INVALID_EDIT' };
    }

    // 尝试多种模糊匹配策略
    const strategies = [
      () => fuzzyWhitespaceMatch(content, old_string, new_string),
      () => fuzzyLineMatch(content, old_string, new_string),
      () => contextMatch(content, old_string, new_string),
    ];

    for (const strategy of strategies) {
      const result = strategy();
      if (result.success) {
        fs.writeFileSync(fullPath, result.newContent, 'utf-8');
        return {
          success: true,
          path: args.target_file,
          strategy: result.strategy,
          message: `Edit reapplied successfully using ${result.strategy} matching.`,
        };
      }
    }

    return {
      success: false,
      error: 'Could not find a suitable match even with fuzzy strategies. Please read the file and try a new edit.',
      code: 'E_REAPPLY_FAILED',
    };
  },
};

function fuzzyWhitespaceMatch(content, oldStr, newStr) {
  const normalize = s => s.replace(/\s+/g, ' ').trim();
  const normalizedOld = normalize(oldStr);
  const normalizedContent = normalize(content);
  const idx = normalizedContent.indexOf(normalizedOld);
  if (idx === -1) return { success: false };

  let charCount = 0;
  let start = -1, end = -1;
  const contentChars = content.split('');
  const normalizedChars = normalizedContent.split('');

  let ci = 0;
  for (let ni = 0; ni <= normalizedContent.length && ci < content.length; ni++) {
    if (ni === idx) start = ci;
    if (ni === idx + normalizedOld.length) { end = ci; break; }
    if (content[ci] === normalizedContent[ni]) {
      ci++;
    } else {
      while (ci < content.length && /\s/.test(content[ci])) ci++;
      if (ci < content.length) ci++;
    }
  }

  if (start >= 0 && end > start) {
    const newContent = content.substring(0, start) + newStr + content.substring(end);
    return { success: true, newContent, strategy: 'fuzzy-whitespace' };
  }

  return { success: false };
}

function fuzzyLineMatch(content, oldStr, newStr) {
  const contentLines = content.split('\n');
  const oldLines = oldStr.split('\n').map(l => l.trim()).filter(Boolean);

  if (oldLines.length === 0) return { success: false };

  const firstLine = oldLines[0];
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() === firstLine) {
      let matched = true;
      for (let j = 1; j < oldLines.length; j++) {
        if (i + j >= contentLines.length || contentLines[i + j].trim() !== oldLines[j]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        const before = contentLines.slice(0, i);
        const after = contentLines.slice(i + oldLines.length);
        const newContent = [...before, newStr, ...after].join('\n');
        return { success: true, newContent, strategy: 'fuzzy-line' };
      }
    }
  }

  return { success: false };
}

function contextMatch(content, oldStr, newStr) {
  const oldLines = oldStr.split('\n');
  if (oldLines.length < 3) return { success: false };

  const firstTwo = oldLines.slice(0, 2).map(l => l.trim()).join('\n');
  const lastTwo = oldLines.slice(-2).map(l => l.trim()).join('\n');
  const contentLines = content.split('\n');

  for (let i = 0; i < contentLines.length - 1; i++) {
    const twoLines = contentLines.slice(i, i + 2).map(l => l.trim()).join('\n');
    if (twoLines === firstTwo) {
      for (let j = i + 2; j < contentLines.length - 1; j++) {
        const endTwo = contentLines.slice(j, j + 2).map(l => l.trim()).join('\n');
        if (endTwo === lastTwo) {
          const before = contentLines.slice(0, i);
          const after = contentLines.slice(j + 2);
          const newContent = [...before, newStr, ...after].join('\n');
          return { success: true, newContent, strategy: 'context-boundary' };
        }
      }
    }
  }

  return { success: false };
}

module.exports = tool;
module.exports.setLastEditAttempt = setLastEditAttempt;
module.exports.clearSession = clearSession;
