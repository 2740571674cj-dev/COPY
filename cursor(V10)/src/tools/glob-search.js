const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.cache', 'coverage']);

function globToRegex(pattern) {
  let re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\?/g, '[^/\\\\]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(`^${re}$`, 'i');
}

function walkAll(dir, projectRoot, maxDepth = 8, depth = 0) {
  if (depth > maxDepth) return [];
  let results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') && depth > 0) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(projectRoot, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          results.push({ path: relPath, type: 'directory' });
          results = results.concat(walkAll(fullPath, projectRoot, maxDepth, depth + 1));
        }
      } else {
        results.push({ path: relPath, type: 'file' });
      }
    }
  } catch (_) {}
  return results;
}

module.exports = {
  name: 'file_search',
  description: `Fast file search based on fuzzy matching against file path. Use if you know part of the file path but don't know where it's located exactly. Response will be capped at 10 results. Make your query more specific to filter results further.`,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Fuzzy filename or glob pattern to search for.' },
      explanation: { type: 'string', description: 'One sentence explanation as to why this tool is being used.' },
    },
    required: ['query'],
  },
  riskLevel: 'safe',
  timeout: 15000,

  async handler(args, projectPath) {
    let pattern = args.query || args.pattern;
    if (!pattern.startsWith('**/') && !pattern.startsWith('/')) {
      pattern = '**/' + pattern;
    }

    const regex = globToRegex(pattern);
    const allEntries = walkAll(projectPath, projectPath);
    const allMatched = allEntries.filter(e => e.type === 'file' && regex.test(e.path));
    const matched = allMatched.slice(0, 200);

    const withStats = matched.map(e => {
      try {
        const fullPath = path.join(projectPath, e.path);
        const stat = fs.statSync(fullPath);
        return { path: e.path, mtime: stat.mtimeMs, size: stat.size };
      } catch (_) {
        return { path: e.path, mtime: 0, size: 0 };
      }
    });

    withStats.sort((a, b) => b.mtime - a.mtime);

    return {
      success: true,
      files: withStats.map(f => f.path),
      totalFound: withStats.length,
      truncated: allMatched.length > 200,
    };
  },
};
