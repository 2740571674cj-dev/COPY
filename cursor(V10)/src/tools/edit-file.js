const fs = require('fs');
const path = require('path');
const { validatePath } = require('../core/security-layer');
const { ERROR_CODES, makeError } = require('../core/error-codes');

module.exports = {
  name: 'edit_file',
  description: `Perform exact string replacement in a file.

Rules:
1. You MUST read the file at least once before editing — never edit a file you haven't read.
2. old_string must EXACTLY match the file content (including whitespace/indentation). Do NOT retype from memory — copy from the read output.
3. The edit will FAIL if old_string is not unique in the file. Provide more surrounding context lines to make it unique, or use replace_all.
4. old_string and new_string must be different.
5. Use replace_all for renaming variables/strings across the entire file.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The target file to modify, relative to the project root.' },
      old_string: { type: 'string', description: 'The exact text to find and replace. Must be unique in the file.' },
      new_string: { type: 'string', description: 'The replacement text (must differ from old_string).' },
      replace_all: { type: 'boolean', description: 'If true, replace all occurrences. Default false.' },
      explanation: { type: 'string', description: 'One sentence instruction describing what this edit does.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  riskLevel: 'medium',
  timeout: 10000,

  async handler(args, projectPath, context) {
    try {
      const { setLastEditAttempt } = require('./reapply');
      const sessionId = (context && context.sessionId) || '_default';
      setLastEditAttempt({ old_string: args.old_string, new_string: args.new_string, path: args.path }, sessionId);
    } catch (_) { }

    const check = validatePath(args.path, projectPath);
    if (!check.valid) return check;

    const fullPath = check.resolvedPath;
    if (!fs.existsSync(fullPath)) {
      return makeError(ERROR_CODES.FILE_NOT_FOUND, args.path);
    }

    const rawContent = fs.readFileSync(fullPath, 'utf-8');

    // Detect original EOL style (CRLF or LF)
    const crlfCount = (rawContent.match(/\r\n/g) || []).length;
    const lfCount = (rawContent.match(/(?<!\r)\n/g) || []).length;
    const originalEol = crlfCount > lfCount ? '\r\n' : '\n';

    // Normalize to LF for matching, then restore original EOL on write
    const content = rawContent.replace(/\r\n/g, '\n');
    const oldString = (args.old_string || '').replace(/\r\n/g, '\n');
    const newString = (args.new_string || '').replace(/\r\n/g, '\n');

    // 1.4: Idempotency detection — if old_string is absent but new_string is already present,
    // the edit was already applied (possibly in a previous attempt or session).
    // Guards: old !== new (avoid trivial match), both non-trivial (>= 10 chars),
    // and new_string is not a substring/prefix of old_string (avoid false positive).
    if (oldString && newString
      && oldString !== newString
      && oldString.length >= 10
      && content.indexOf(oldString) === -1
      && content.indexOf(newString) !== -1) {
      return {
        success: true,
        alreadyApplied: true,
        code: 'OK',
        message: `This change has already been applied to ${args.path}. No modification needed.`,
        path: args.path,
      };
    }

    let matchResult;
    try {
      const { EditFuzzyMatcher } = require('../core/edit-fuzzy-matcher');
      const matcher = new EditFuzzyMatcher();
      matchResult = matcher.findMatch(content, oldString, args.replace_all);

      // P1-3: If no match and old_string looks like it has line numbers (e.g. "123|code"),
      // strip them and retry.
      if (!matchResult.found) {
        const lineNumPattern = /^\s*\d+\s*[|:]\s?/;
        const lines = oldString.split('\n');
        if (lines.some(l => lineNumPattern.test(l))) {
          const stripped = lines.map(l => l.replace(lineNumPattern, '')).join('\n');
          const retryResult = matcher.findMatch(content, stripped, args.replace_all);
          if (retryResult.found) {
            matchResult = { ...retryResult, lineNumbersStripped: true };
            // Also strip line numbers from new_string for consistency
            const newLines = newString.split('\n');
            if (newLines.some(l => lineNumPattern.test(l))) {
              const strippedNew = newLines.map(l => l.replace(lineNumPattern, '')).join('\n');
              // Override newString for the replacement below
              args._strippedNewString = strippedNew;
            }
          }
        }
      }
    } catch (_) {
      matchResult = this._basicMatch(content, oldString, args.replace_all);
    }

    if (!matchResult.found) {
      // P1-2: Enhanced error with recovery hints
      const response = { success: false, error: matchResult.error, code: matchResult.code };
      if (matchResult.code === 'E_MULTIPLE_MATCHES') {
        response.hint = 'Include more surrounding lines to uniquely identify the edit location.';
        response.suggestMoreContext = true;
      } else if (matchResult.code === 'E_MATCH_NOT_FOUND') {
        response.hint = 'Do NOT re-read the file. Use the nearestContent below to fix your old_string and retry immediately.';
        response.suggestReadBack = true;
        response.code = 'E_MATCH_NOT_FOUND';
        const snippet = this._findNearestSnippet(content, oldString);
        if (snippet) {
          response.nearestContent = snippet.display;
          // 提供无行号的精确文本，AI 可直接复制为 old_string
          response.editableSnippet = snippet.raw;
        }
      }
      return response;
    }

    let newContent;
    // When line numbers were stripped, use the stripped versions for replacement
    const effectiveOld = matchResult.lineNumbersStripped
      ? oldString.split('\n').map(l => l.replace(/^\s*\d+\s*[|:]\s?/, '')).join('\n')
      : oldString;
    let effectiveNew = args._strippedNewString || newString;

    // 自动缩进适配：当使用非精确匹配策略时，将 new_string 的缩进适配到原文件同区域
    const fuzzyStrategies = ['indent_agnostic', 'line_trimmed', 'subsequence'];
    if (fuzzyStrategies.includes(matchResult.strategy)) {
      const matchedOriginal = content.substring(matchResult.start, matchResult.end);
      effectiveNew = this._adaptIndentation(matchedOriginal, effectiveNew);
    }

    if (args.replace_all) {
      const splitParts = content.split(effectiveOld);
      if (splitParts.length > 1) {
        newContent = splitParts.join(effectiveNew);
      } else {
        newContent = content.substring(0, matchResult.start) + effectiveNew + content.substring(matchResult.end);
      }
    } else {
      newContent = content.substring(0, matchResult.start) + effectiveNew + content.substring(matchResult.end);
    }

    // Restore original EOL style
    if (originalEol === '\r\n') {
      newContent = newContent.replace(/\r?\n/g, '\r\n');
    }

    // Checkpoint: 保存编辑前的文件快照
    try {
      const { CheckpointStore } = require('../core/checkpoint-store');
      CheckpointStore.save(fullPath, { toolName: 'edit_file', sessionId: context?.sessionId, projectPath });
      CheckpointStore.ensureGitignore(projectPath);
    } catch (_) { /* checkpoint 失败不阻塞编辑 */ }

    fs.writeFileSync(fullPath, newContent, 'utf-8');

    const readback = fs.readFileSync(fullPath, 'utf-8');
    if (readback !== newContent) {
      return { success: false, error: 'Write verification failed', code: 'E_VERIFY_FAILED' };
    }

    const result = {
      success: true,
      path: args.path,
      replacements: matchResult.count || 1,
      matchStrategy: matchResult.strategy || 'exact',
      eolNormalized: originalEol === '\r\n',
    };

    // Generate compact unified diff for model confirmation
    try {
      const oldLines = content.split('\n');
      const newLines = newContent.replace(/\r\n/g, '\n').split('\n');
      const diff = this._generateCompactDiff(oldLines, newLines, args.path);
      if (diff && diff.length <= 1500) {
        result.diff = diff;
      } else if (diff) {
        const addCount = (diff.match(/^\+[^+]/gm) || []).length;
        const delCount = (diff.match(/^-[^-]/gm) || []).length;
        result.diff = `(diff too large) +${addCount}/-${delCount} lines changed`;
      }
    } catch (_) { }

    return result;
  },

  _basicMatch(content, oldString, replaceAll) {
    const idx = content.indexOf(oldString);
    if (idx === -1) {
      return { found: false, error: `old_string not found in file. Read the file first to get the exact content.`, code: 'E_MATCH_NOT_FOUND' };
    }

    if (!replaceAll) {
      const secondIdx = content.indexOf(oldString, idx + 1);
      if (secondIdx !== -1) {
        return { found: false, error: `old_string matches multiple locations. Include more surrounding context to make it unique.`, code: 'E_MULTIPLE_MATCHES' };
      }
    }

    const count = replaceAll ? content.split(oldString).length - 1 : 1;
    return { found: true, start: idx, end: idx + oldString.length, count, strategy: 'exact' };
  },

  /**
   * 自动缩进适配：将 newText 的缩进级别调整为与 originalText 一致。
   * 检测 original 最小缩进 vs new 最小缩进的差值，统一偏移。
   */
  _adaptIndentation(originalText, newText) {
    const getMinIndent = (text) => {
      const lines = text.split('\n').filter(l => l.trim().length > 0);
      if (lines.length === 0) return 0;
      return Math.min(...lines.map(l => {
        const match = l.match(/^(\s*)/);
        return match ? match[1].length : 0;
      }));
    };

    const origIndent = getMinIndent(originalText);
    const newIndent = getMinIndent(newText);
    const diff = origIndent - newIndent;

    if (diff === 0) return newText;

    const newLines = newText.split('\n');
    const adjusted = newLines.map(line => {
      if (line.trim().length === 0) return line;
      if (diff > 0) {
        return ' '.repeat(diff) + line;
      } else {
        const currentIndent = line.match(/^(\s*)/)[1].length;
        const removeCount = Math.min(currentIndent, Math.abs(diff));
        return line.substring(removeCount);
      }
    });
    return adjusted.join('\n');
  },

  /**
   * Find the nearest matching snippet in the file content to help the model
   * self-correct when old_string doesn't match.
   * Returns ±5 lines around the best candidate, or null if no candidate found.
   */
  _findNearestSnippet(content, oldString) {
    const lines = content.split('\n');
    const searchLines = oldString.split('\n').map(l => l.trim()).filter(Boolean);
    if (searchLines.length === 0) return null;

    // Strategy 1: search by first non-empty line of old_string
    let bestLine = -1;
    const firstLine = searchLines[0];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().includes(firstLine) || firstLine.includes(lines[i].trim())) {
        bestLine = i;
        break;
      }
    }

    // Strategy 2: if first line didn't match, try the longest line
    if (bestLine === -1) {
      const longest = searchLines.reduce((a, b) => a.length >= b.length ? a : b, '');
      if (longest.length >= 5) {
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim().includes(longest) || longest.includes(lines[i].trim())) {
            bestLine = i;
            break;
          }
        }
      }
    }

    // Strategy 3: partial keyword match (function/class/method name)
    if (bestLine === -1) {
      const keywords = oldString.match(/(?:function|class|const|let|var|def|async)\s+([\w$]+)/g);
      if (keywords) {
        for (const kw of keywords) {
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(kw)) {
              bestLine = i;
              break;
            }
          }
          if (bestLine !== -1) break;
        }
      }
    }

    if (bestLine === -1) return null;

    // 扩大上下文到 ±8 行，提高首次修正成功率
    const contextRadius = 8;
    const start = Math.max(0, bestLine - contextRadius);
    const end = Math.min(lines.length, bestLine + contextRadius + searchLines.length);
    const numbered = lines.slice(start, end).map((l, i) => {
      const lineNum = String(start + i + 1).padStart(6, ' ');
      return `${lineNum}|${l}`;
    }).join('\n');
    // 同时返回无行号的原始文本，AI 可直接复制为 old_string
    const raw = lines.slice(start, end).join('\n');
    return {
      display: `[Lines ${start + 1}-${end}]:\n${numbered}`,
      raw,
    };
  },


  /**
   * Generate a compact unified-style diff with ±3 lines of context.
   */
  _generateCompactDiff(oldLines, newLines, filePath) {
    const CONTEXT = 3;
    const hunks = [];
    let i = 0, j = 0;

    // Simple LCS-based diff: find changed regions
    const changes = [];
    const maxLen = Math.max(oldLines.length, newLines.length);
    let oi = 0, ni = 0;
    while (oi < oldLines.length || ni < newLines.length) {
      if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
        oi++; ni++;
      } else {
        // Find end of changed region
        const startOi = oi, startNi = ni;
        // Look ahead for next matching line
        let found = false;
        for (let look = 1; look < 20 && !found; look++) {
          // Try advancing old
          if (oi + look < oldLines.length && ni < newLines.length) {
            const matchIdx = newLines.indexOf(oldLines[oi + look], ni);
            if (matchIdx >= 0 && matchIdx - ni < 20) {
              changes.push({ oldStart: startOi, oldEnd: oi + look, newStart: startNi, newEnd: matchIdx });
              oi = oi + look; ni = matchIdx;
              found = true;
            }
          }
        }
        if (!found) {
          // Consume one line from whichever is longer
          if (oi < oldLines.length) oi++;
          if (ni < newLines.length) ni++;
          if (oi >= oldLines.length || ni >= newLines.length ||
            (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni])) {
            changes.push({ oldStart: startOi, oldEnd: oi, newStart: startNi, newEnd: ni });
          }
        }
      }
    }

    if (changes.length === 0) return null;

    const lines = [`--- a/${filePath}`, `+++ b/${filePath}`];
    for (const ch of changes) {
      const ctxStart = Math.max(0, ch.oldStart - CONTEXT);
      const ctxEndOld = Math.min(oldLines.length, ch.oldEnd + CONTEXT);
      const ctxEndNew = Math.min(newLines.length, ch.newEnd + CONTEXT);
      lines.push(`@@ -${ctxStart + 1},${ctxEndOld - ctxStart} +${Math.max(0, ch.newStart - CONTEXT) + 1},${ctxEndNew - Math.max(0, ch.newStart - CONTEXT)} @@`);
      // Context before
      for (let k = ctxStart; k < ch.oldStart; k++) lines.push(` ${oldLines[k]}`);
      // Removed lines
      for (let k = ch.oldStart; k < ch.oldEnd; k++) lines.push(`-${oldLines[k]}`);
      // Added lines
      for (let k = ch.newStart; k < ch.newEnd; k++) lines.push(`+${newLines[k]}`);
      // Context after
      for (let k = ch.oldEnd; k < ctxEndOld; k++) lines.push(` ${oldLines[k]}`);
    }
    return lines.join('\n');
  },
};
