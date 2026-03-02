const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

module.exports = {
  name: 'diff_history',
  description: `Retrieve the history of recent changes made to files in the workspace. Shows which files were changed, when, and how many lines were added or removed. Use when you need context about recent modifications.`,
  parameters: {
    type: 'object',
    properties: {
      explanation: {
        type: 'string',
        description: 'One sentence explanation as to why this tool is being used.',
      },
    },
    required: [],
  },
  riskLevel: 'safe',
  timeout: 15000,

  async handler(args, projectPath) {
    const isGit = fs.existsSync(path.join(projectPath, '.git'));

    if (isGit) {
      return this._gitHistory(projectPath);
    }

    return this._fsHistory(projectPath);
  },

  _gitHistory(projectPath) {
    try {
      const log = execSync(
        'git log --oneline --stat --no-color -10 | cat',
        { cwd: projectPath, timeout: 10000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const diff = execSync(
        'git diff --stat --no-color HEAD | cat',
        { cwd: projectPath, timeout: 10000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      return {
        success: true,
        type: 'git',
        recentCommits: log.trim().substring(0, 3000),
        uncommittedChanges: diff.trim().substring(0, 2000),
      };
    } catch (e) {
      return { success: false, error: `Git error: ${e.message}`, code: 'E_GIT' };
    }
  },

  _fsHistory(projectPath) {
    const files = [];
    const now = Date.now();
    const cutoff = now - 30 * 60 * 1000;

    const walk = (dir, depth = 0) => {
      if (depth > 3) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            walk(full, depth + 1);
          } else if (e.isFile()) {
            try {
              const stat = fs.statSync(full);
              if (stat.mtimeMs >= cutoff) {
                files.push({
                  path: path.relative(projectPath, full),
                  modified: new Date(stat.mtimeMs).toISOString(),
                  size: stat.size,
                });
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
    };

    walk(projectPath);
    files.sort((a, b) => new Date(b.modified) - new Date(a.modified));

    return {
      success: true,
      type: 'filesystem',
      recentlyModified: files.slice(0, 20),
      message: `Found ${files.length} file(s) modified in the last 30 minutes.`,
    };
  },
};
