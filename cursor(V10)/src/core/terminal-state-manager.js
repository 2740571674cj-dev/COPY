const fs = require('fs');
const path = require('path');

class TerminalStateManager {
  constructor(projectPath) {
    this.projectPath = projectPath;
    this.termDir = path.join(projectPath, '.agent-terminal');
    this._ensureDir();
  }

  _ensureDir() {
    try {
      fs.mkdirSync(this.termDir, { recursive: true });
    } catch (_) {}
  }

  getStateFilePath(pid) {
    return path.join(this.termDir, `${pid}.txt`);
  }

  writeState(pid, state) {
    const filePath = this.getStateFilePath(pid);
    try {
      const content = [
        `PID: ${pid}`,
        `CWD: ${state.cwd || ''}`,
        `Command: ${state.command || ''}`,
        `Running: ${state.running}`,
        state.exitCode !== undefined ? `Exit Code: ${state.exitCode}` : '',
        `Last Updated: ${new Date().toISOString()}`,
        '',
        '--- STDOUT ---',
        state.stdout || '(empty)',
        '',
        '--- STDERR ---',
        state.stderr || '(empty)',
      ].filter(Boolean).join('\n');
      fs.writeFileSync(filePath, content, 'utf-8');
    } catch (_) {}
  }

  readState(pid) {
    const filePath = this.getStateFilePath(pid);
    try {
      if (!fs.existsSync(filePath)) return null;
      const content = fs.readFileSync(filePath, 'utf-8');
      return { success: true, content, path: filePath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  listActive() {
    try {
      if (!fs.existsSync(this.termDir)) return [];
      const files = fs.readdirSync(this.termDir)
        .filter(f => f.endsWith('.txt'))
        .map(f => {
          const content = fs.readFileSync(path.join(this.termDir, f), 'utf-8');
          const running = /Running:\s*true/i.test(content);
          const pid = f.replace('.txt', '');
          const commandMatch = content.match(/Command:\s*(.+)/);
          return {
            pid,
            running,
            command: commandMatch ? commandMatch[1].trim() : '',
            file: path.join(this.termDir, f),
          };
        });
      return files;
    } catch (_) {
      return [];
    }
  }

  cleanup(maxAgeMs = 3600000) {
    try {
      if (!fs.existsSync(this.termDir)) return;
      const now = Date.now();
      const files = fs.readdirSync(this.termDir);
      for (const f of files) {
        const fullPath = path.join(this.termDir, f);
        try {
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs > maxAgeMs) {
            fs.unlinkSync(fullPath);
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
}

module.exports = { TerminalStateManager };
