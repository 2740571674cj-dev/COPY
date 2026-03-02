const { exec } = require('child_process');
const { validateCommand, validatePath } = require('../core/security-layer');

module.exports = {
  name: 'run_terminal_cmd',
  description: `Execute a terminal command in the project directory.\n\nGuidelines:\n1. For commands that use a pager (git, less, head, tail, more), append \` | cat\`.\n2. For long-running commands, set is_background to true.\n3. Don't include newlines in the command.\n4. If a tool exists for an action, prefer using the tool instead of shell commands (e.g. read_file over cat).`,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The terminal command to execute.' },
      working_directory: { type: 'string', description: 'Working directory relative to project root. Defaults to project root.' },
      is_background: { type: 'boolean', description: 'Whether the command should be run in the background.' },
      explanation: { type: 'string', description: 'One sentence explanation as to why this command needs to be run and how it contributes to the goal.' },
    },
    required: ['command'],
  },
  riskLevel: 'medium',
  timeout: 130000,

  async handler(args, projectPath) {
    const cmdCheck = validateCommand(args.command);
    if (!cmdCheck.valid) return cmdCheck;

    let cwd = projectPath;
    if (args.working_directory) {
      const pathCheck = validatePath(args.working_directory, projectPath);
      if (!pathCheck.valid) return pathCheck;
      cwd = pathCheck.resolvedPath;
    }

    const fs = require('fs');
    if (!fs.existsSync(cwd)) {
      return { success: false, error: `Working directory not found: ${cwd}`, code: 'E_DIR_NOT_FOUND' };
    }

    // Resolve block_until_ms: default 120000 for foreground, 0 for background
    const blockMs = args.is_background ? 0 : 120000;

    return new Promise((resolve) => {
      const opts = {
        cwd,
        maxBuffer: 2 * 1024 * 1024,
        timeout: blockMs > 0 ? blockMs : undefined,
        encoding: 'utf-8',
        windowsHide: true,
      };

      let actualCmd = args.command;
      if (process.platform === 'win32') {
        opts.shell = 'cmd.exe';
        actualCmd = `chcp 65001 >nul 2>&1 && ${args.command}`;
      }

      // Background mode: spawn detached and return immediately with PID
      if (args.is_background) {
        const { spawn } = require('child_process');
        const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
        const shellArgs = process.platform === 'win32' ? ['/c', actualCmd] : ['-c', actualCmd];

        // Terminal state file: write command info to a temp file for monitoring
        const path = require('path');
        const termDir = path.join(projectPath, '.agent-terminal');
        try { fs.mkdirSync(termDir, { recursive: true }); } catch (_) {}

        const child = spawn(shell, shellArgs, {
          cwd,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });

        const pid = child.pid;
        const termFile = path.join(termDir, `${pid}.txt`);
        let stdout = '';
        let stderr = '';

        // Use TextDecoder to properly handle multi-byte chars split across chunks
        const stdoutDecoder = new TextDecoder('utf-8');
        const stderrDecoder = new TextDecoder('utf-8');

        // Capture output to terminal state file
        if (child.stdout) {
          child.stdout.on('data', (data) => {
            stdout += stdoutDecoder.decode(data, { stream: true });
            // Keep last 10KB
            if (stdout.length > 10240) stdout = stdout.slice(-10240);
            this._writeTerminalState(termFile, { pid, cwd, command: args.command, stdout, stderr, running: true });
          });
        }
        if (child.stderr) {
          child.stderr.on('data', (data) => {
            stderr += stderrDecoder.decode(data, { stream: true });
            if (stderr.length > 5120) stderr = stderr.slice(-5120);
            this._writeTerminalState(termFile, { pid, cwd, command: args.command, stdout, stderr, running: true });
          });
        }

        child.on('exit', (code) => {
          this._writeTerminalState(termFile, { pid, cwd, command: args.command, stdout, stderr, running: false, exitCode: code });
        });

        child.unref();
        resolve({
          success: true,
          is_background: true,
          pid: child.pid,
          terminal_file: termFile,
          message: `Command started in background (PID: ${child.pid}). Use read_file on the terminal state file to monitor output.`,
        });
        return;
      }

      exec(actualCmd, opts, (error, stdout, stderr) => {
        const exitCode = error ? (error.code ?? -1) : 0;
        const truncatedStdout = stdout?.length > 50000 ? stdout.substring(0, 50000) + '\n...(truncated)' : (stdout || '');
        const truncatedStderr = stderr?.length > 10000 ? stderr.substring(0, 10000) + '\n...(truncated)' : (stderr || '');

        if (error && error.killed) {
          resolve({ success: false, stdout: truncatedStdout, stderr: truncatedStderr, exitCode: -1, error: `Command timed out (${Math.round(blockMs / 1000)}s). Consider using is_background=true for long-running commands.`, code: 'E_CMD_TIMEOUT' });
        } else if (exitCode !== 0) {
          resolve({ success: false, stdout: truncatedStdout, stderr: truncatedStderr, exitCode, code: 'E_CMD_FAILED' });
        } else {
          resolve({ success: true, stdout: truncatedStdout, stderr: truncatedStderr, exitCode: 0 });
        }
      });
    });
  },

  _writeTerminalState(filePath, state) {
    const fs = require('fs');
    try {
      const content = [
        `PID: ${state.pid}`,
        `CWD: ${state.cwd}`,
        `Command: ${state.command}`,
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
  },
};
