const fs = require('fs');
const path = require('path');

class DynamicContextProvider {
  async gather({ projectPath, openFiles = [], recentlyEdited = [], linterErrors = [], terminalOutput = '', maxTokens = 8000, linterRunner = null }) {
    const context = {
      openFiles: [],
      cursorContext: null,
      linterErrors: [],
      recentlyEdited: [],
      terminalOutput: '',
      projectStructure: '',
    };

    let usedTokens = 0;
    const estimateTokens = (text) => Math.ceil((text || '').length / 4);
    const fileContentCache = new Map(); // 缓存已读文件内容，避免重复 readFileSync

    // Source 1: Open files — show content of currently open files
    for (const file of openFiles.slice(0, 5)) {
      if (usedTokens >= maxTokens) break;
      try {
        const filePath = path.isAbsolute(file.path)
          ? file.path
          : path.resolve(projectPath, file.path);
        if (!fs.existsSync(filePath)) continue;

        const stat = fs.statSync(filePath);
        if (stat.size > 100000) continue;

        const content = fs.readFileSync(filePath, 'utf-8');
        fileContentCache.set(filePath, content); // 缓存供 Source 2 复用
        const relPath = path.relative(projectPath, filePath).replace(/\\/g, '/');
        const tokens = estimateTokens(content);

        if (usedTokens + tokens > maxTokens) {
          const lines = content.split('\n');
          const truncated = lines.slice(0, 50).join('\n') + '\n// ... (truncated)';
          context.openFiles.push({ path: relPath, content: truncated, truncated: true });
          usedTokens += estimateTokens(truncated);
        } else {
          context.openFiles.push({ path: relPath, content, truncated: false });
          usedTokens += tokens;
        }
      } catch (_) { }
    }

    // Source 2: Cursor context — code around the cursor position
    for (const file of openFiles) {
      if (file.cursorLine && file.path) {
        try {
          const filePath = path.isAbsolute(file.path)
            ? file.path
            : path.resolve(projectPath, file.path);
          if (!fs.existsSync(filePath)) continue;

          // 复用 Source 1 缓存，避免重复读取
          const content = fileContentCache.get(filePath) || fs.readFileSync(filePath, 'utf-8');
          const lines = content.split('\n');
          const cursor = file.cursorLine - 1;
          const start = Math.max(0, cursor - 30);
          const end = Math.min(lines.length, cursor + 30);
          const snippet = lines.slice(start, end).map((l, i) => {
            const lineNum = start + i + 1;
            const marker = lineNum === file.cursorLine ? ' >>> ' : '     ';
            return `${marker}${lineNum}|${l}`;
          }).join('\n');

          const relPath = path.relative(projectPath, filePath).replace(/\\/g, '/');
          context.cursorContext = {
            file: relPath,
            cursorLine: file.cursorLine,
            snippet,
          };
          usedTokens += estimateTokens(snippet);
          break;
        } catch (_) { }
      }
    }

    // Source 3: Linter errors — use provided list, or run linter if available
    let resolvedLinterErrors = linterErrors;
    if (resolvedLinterErrors.length === 0 && linterRunner && usedTokens < maxTokens) {
      try {
        const recentFiles = openFiles.map(f => f.path).filter(Boolean).slice(0, 10);
        if (recentFiles.length > 0) {
          const result = await linterRunner(projectPath, recentFiles);
          // 兼容新 API (diagnostics) 和旧 API (errors)
          const items = result?.diagnostics || result?.errors || [];
          if (result?.success && items.length > 0) {
            resolvedLinterErrors = items;
          }
        }
      } catch (_) { }
    }
    if (resolvedLinterErrors.length > 0 && usedTokens < maxTokens) {
      context.linterErrors = resolvedLinterErrors.slice(0, 20).map(e => ({
        file: e.file,
        line: e.line,
        column: e.column || 1,
        severity: e.severity || 'error',
        message: e.message,
        source: e.source || null,
        ruleId: e.ruleId || null,
      }));
      usedTokens += estimateTokens(JSON.stringify(context.linterErrors));
    }

    // Source 4: Recently edited files (list only)
    if (recentlyEdited.length > 0) {
      context.recentlyEdited = recentlyEdited.slice(0, 10).map(f => ({
        path: path.relative(projectPath, f.path || f).replace(/\\/g, '/'),
        editTime: f.editTime,
      }));
      usedTokens += estimateTokens(JSON.stringify(context.recentlyEdited));
    }

    // Source 5: Terminal output
    if (terminalOutput && usedTokens < maxTokens) {
      const maxTerminal = Math.min(2000, (maxTokens - usedTokens) * 4);
      context.terminalOutput = terminalOutput.length > maxTerminal
        ? '...(truncated)\n' + terminalOutput.slice(-maxTerminal)
        : terminalOutput;
      usedTokens += estimateTokens(context.terminalOutput);
    }

    // Source 6: Project structure overview (top-level)
    if (usedTokens < maxTokens) {
      try {
        const entries = fs.readdirSync(projectPath, { withFileTypes: true });
        const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '__pycache__']);
        const listing = entries
          .filter(e => !SKIP.has(e.name))
          .map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`)
          .join('\n');
        context.projectStructure = listing;
        usedTokens += estimateTokens(listing);
      } catch (_) { }
    }

    context._meta = { totalEstimatedTokens: usedTokens, maxTokens };
    return context;
  }
}

module.exports = { DynamicContextProvider };
