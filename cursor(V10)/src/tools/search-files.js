const fs = require('fs');
const path = require('path');
const { validatePath } = require('../core/security-layer');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.cache', 'coverage', '.vscode', '.idea']);
const TEXT_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.scss', '.html', '.md', '.txt', '.yaml', '.yml', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.vue', '.svelte', '.toml', '.sh', '.bat', '.rb', '.php']);

function walkFiles(dir, maxDepth = 6, depth = 0) {
  if (depth > maxDepth) return [];
  let results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          results = results.concat(walkFiles(fullPath, maxDepth, depth + 1));
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (TEXT_EXTS.has(ext)) results.push(fullPath);
      }
    }
  } catch (_) {}
  return results;
}

module.exports = {
  name: 'grep_search',
  description: `Fast text-based regex search that finds exact pattern matches within files or directories.\nResults are formatted with file paths, line numbers, and matching content, capped at 100 matches.\nUse include_pattern to filter by file type.\n\nThis is best for finding exact text matches or regex patterns. Preferred over semantic search when you know the exact symbol/function name to search for.`,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The regex pattern to search for.' },
      path: { type: 'string', description: 'Directory or file to search in, relative to project root. Defaults to project root.' },
      include_pattern: { type: 'string', description: 'Glob pattern for files to include (e.g. "*.ts" for TypeScript files).' },
      case_sensitive: { type: 'boolean', description: 'Whether the search should be case sensitive. Default false.' },
      explanation: { type: 'string', description: 'One sentence explanation as to why this tool is being used.' },
    },
    required: ['query'],
  },
  riskLevel: 'safe',
  timeout: 30000,

  async handler(args, projectPath) {
    let searchRoot = projectPath;
    if (args.path) {
      const check = validatePath(args.path, projectPath);
      if (!check.valid) return check;
      searchRoot = check.resolvedPath;
    }

    if (!fs.existsSync(searchRoot)) {
      return { success: false, error: `Path not found: ${args.path || '.'}`, code: 'E_PATH_NOT_FOUND' };
    }

    const pattern = args.query || args.pattern;
    if (!pattern) return { success: false, error: 'Search query is required.', code: 'E_MISSING_QUERY' };

    const flags = args.case_sensitive ? 'g' : 'gi';
    let regex;
    try {
      regex = new RegExp(pattern, flags);
    } catch (e) {
      return { success: false, error: `Invalid regex: ${e.message}`, code: 'E_INVALID_REGEX' };
    }

    const files = fs.statSync(searchRoot).isFile()
      ? [searchRoot]
      : walkFiles(searchRoot);

    const filterStr = args.include_pattern || args.file_pattern;
    const extFilter = filterStr
      ? new RegExp(filterStr.replace(/\./g, '\\.').replace(/\*/g, '.*'))
      : null;

    const matches = [];
    for (const filePath of files) {
      if (matches.length >= 100) break;
      if (extFilter && !extFilter.test(path.basename(filePath))) continue;

      try {
        const stat = fs.statSync(filePath);
        if (stat.size > 1024 * 1024) continue;

        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const relPath = path.relative(projectPath, filePath).replace(/\\/g, '/');

        for (let i = 0; i < lines.length && matches.length < 100; i++) {
          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            const ctxStart = Math.max(0, i - 1);
            const ctxEnd = Math.min(lines.length, i + 2);
            matches.push({
              file: relPath,
              line: i + 1,
              content: lines[i].trim(),
              context: lines.slice(ctxStart, ctxEnd).map((l, j) => `${ctxStart + j + 1}|${l}`).join('\n'),
            });
          }
        }
      } catch (_) {}
    }

    return {
      success: true,
      matches,
      totalMatches: matches.length,
      searchedFiles: files.length,
      truncated: matches.length >= 100,
    };
  },
};
