const fs = require('fs');
const { validatePath } = require('../core/security-layer');

// Aligned with Cursor: read entire files by default.
// Only paginate for truly massive files (3000+ lines).
const DEFAULT_MAX_LINES = 2000;
const MAX_LINE_CHARS = 5000;
const MAX_TOTAL_CHARS = 250000;

module.exports = {
  name: 'read_file',
  description: `Read the contents of a file. Output lines are numbered as LINE_NUMBER|LINE_CONTENT.

By default, the tool reads the ENTIRE file in one call (up to ~2000 lines). Most project files can be read in a single call.

You can optionally specify offset and limit for targeted reading of very large files, but it is RECOMMENDED to read the whole file by NOT providing these parameters.

If the file has been read before in this session and is unchanged, the system may return cached content to save tokens.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The path of the file to read, relative to the project root.' },
      offset: { type: 'number', description: 'The one-indexed line number to start reading from. Only use for very large files (3000+ lines).' },
      limit: { type: 'number', description: 'Max number of lines to read. Only use for very large files.' },
      force_refresh: { type: 'boolean', description: 'Set true to bypass the read coverage cache and force re-read.' },
      explanation: { type: 'string', description: 'One sentence explanation as to why this tool is being used.' },
    },
    required: ['path'],
  },
  riskLevel: 'safe',
  timeout: 15000,

  async handler(args, projectPath) {
    const check = validatePath(args.path, projectPath);
    if (!check.valid) return check;

    const fullPath = check.resolvedPath;
    if (!fs.existsSync(fullPath)) {
      return { success: false, error: `File not found: ${args.path}`, code: 'E_FILE_NOT_FOUND' };
    }

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      return { success: false, error: 'Path is a directory, not a file. Use list_directory instead.', code: 'E_IS_DIRECTORY' };
    }
    if (stat.size > 5 * 1024 * 1024) {
      return { success: false, error: 'File too large (>5MB). Use offset and limit to read in chunks.', code: 'E_FILE_TOO_LARGE' };
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    if (content.length === 0) {
      return { success: true, content: '(empty file)', totalLines: 0, truncated: false, mtimeMs: stat.mtimeMs, size: stat.size };
    }

    const lines = content.split('\n');
    const totalLines = lines.length;

    let start = 0;
    if (args.offset) {
      start = Math.max(0, args.offset - 1);
    }

    // Default: read the entire file (up to DEFAULT_MAX_LINES)
    // Only use explicit limit if provided by the caller
    const limit = args.limit || DEFAULT_MAX_LINES;
    const end = Math.min(totalLines, start + limit);

    let lineTruncated = false;
    const numbered = lines.slice(start, end).map((line, i) => {
      const isLongLine = line.length > MAX_LINE_CHARS;
      if (isLongLine) lineTruncated = true;
      const safeLine = isLongLine
        ? line.substring(0, MAX_LINE_CHARS) + `... [truncated, ${line.length} chars total]`
        : line;
      const lineNum = String(start + i + 1).padStart(6, ' ');
      return `${lineNum}|${safeLine}`;
    }).join('\n');

    let outputContent = numbered;
    let charTruncated = false;
    if (outputContent.length > MAX_TOTAL_CHARS) {
      outputContent = outputContent.substring(0, MAX_TOTAL_CHARS) + '\n... [output truncated at character limit]';
      charTruncated = true;
    }

    const paginationTruncated = end < totalLines;
    const truncated = paginationTruncated || charTruncated || lineTruncated;
    const remainingLines = paginationTruncated ? Math.max(0, totalLines - end) : 0;

    const result = {
      success: true,
      content: outputContent,
      totalLines,
      startLine: start + 1,
      endLine: end,
      truncated,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };

    // Only add pagination info for truly large files that need continuation
    if (paginationTruncated) {
      result.nextOffset = end + 1;
      result.remainingLines = remainingLines;
      result.note = `File has ${totalLines} lines total. ${remainingLines} lines remain. Use offset=${end + 1} to continue, or use grep_search to find a specific section.`;
    }

    return result;
  },
};
