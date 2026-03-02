const { execFile } = require('child_process');
const path = require('path');

const SAFE_COMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'stash',
  'add', 'commit', 'checkout', 'switch', 'restore',
  'merge', 'rebase', 'cherry-pick', 'tag', 'remote',
  'fetch', 'pull', 'push', 'init', 'clone',
]);

const DANGEROUS_FLAGS = [
  '--force', '-f',
  '--hard',
  '--no-verify', '--no-gpg-sign',
  '--delete', '-D', '-d',
];

const PROTECTED_BRANCHES = ['main', 'master'];

function parseGitSubcommand(args) {
  for (const arg of args) {
    if (!arg.startsWith('-')) return arg;
  }
  return null;
}

function hasDangerousFlag(args, subcommand) {
  if (subcommand === 'push' || subcommand === 'reset' || subcommand === 'branch') {
    return args.some(a => DANGEROUS_FLAGS.includes(a));
  }
  if (subcommand === 'commit') {
    return args.some(a => ['--no-verify', '--no-gpg-sign'].includes(a));
  }
  return false;
}

function isConfigCommand(args) {
  return args[0] === 'config' || args.includes('config');
}

function isForcePushToProtected(args, subcommand) {
  if (subcommand !== 'push') return false;
  const hasForce = args.some(a => ['--force', '-f', '--force-with-lease'].includes(a));
  if (!hasForce) return false;
  return args.some(a => PROTECTED_BRANCHES.includes(a));
}

function isAmendCommit(args, subcommand) {
  return subcommand === 'commit' && args.includes('--amend');
}

function execGit(args, cwd, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 1024 * 512, encoding: 'utf-8' }, (err, stdout, stderr) => {
      if (err && err.killed) {
        reject(new Error(`Git command timed out after ${timeout}ms`));
        return;
      }
      resolve({ exitCode: err ? err.code || 1 : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

module.exports = {
  name: 'git',
  description: 'Run git commands in the project repository. Supports common operations: status, diff, log, add, commit, push, pull, branch, checkout, etc. Dangerous operations (force push, hard reset) require explicit confirmation.',
  parameters: {
    type: 'object',
    properties: {
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Git command arguments (without "git" prefix). Example: ["status"] or ["commit", "-m", "fix: typo"]',
      },
    },
    required: ['args'],
  },
  riskLevel: 'medium',
  timeout: 60000,

  async handler(params, projectPath) {
    const { args } = params;
    if (!args || args.length === 0) {
      return { success: false, error: 'No git arguments provided' };
    }

    // Git safety protocol: never modify git config
    if (isConfigCommand(args)) {
      return { success: false, error: 'Git config modifications are not allowed. The agent must not change user.name, user.email, or other git configuration.', code: 'E_GIT_CONFIG_BLOCKED' };
    }

    const subcommand = parseGitSubcommand(args);
    if (!subcommand || !SAFE_COMMANDS.has(subcommand)) {
      return { success: false, error: `Git subcommand "${subcommand || args[0]}" is not allowed. Allowed: ${[...SAFE_COMMANDS].join(', ')}` };
    }

    // Git safety protocol: block force push to main/master
    if (isForcePushToProtected(args, subcommand)) {
      return { success: false, error: `Force push to protected branch (main/master) is blocked. This is a destructive operation that can cause data loss for the entire team.`, code: 'E_GIT_FORCE_PUSH_PROTECTED' };
    }

    // Git safety protocol: block --amend (requires very specific conditions)
    if (isAmendCommit(args, subcommand)) {
      return { success: false, error: 'git commit --amend is blocked by safety protocol. Create a new commit instead. Amend is only safe when: (1) you explicitly requested it, (2) the HEAD commit was created in this session, and (3) it has not been pushed to remote.', code: 'E_GIT_AMEND_BLOCKED' };
    }

    if (hasDangerousFlag(args, subcommand)) {
      return { success: false, error: `Dangerous flag detected in "git ${args.join(' ')}". Force push, hard reset, hook-skipping, and branch deletion require manual execution.`, code: 'E_GIT_DANGEROUS_FLAG' };
    }

    const cwd = projectPath || process.cwd();
    try {
      const { exitCode, stdout, stderr } = await execGit(args, cwd);

      const truncatedStdout = stdout.length > 50000 ? stdout.substring(0, 50000) + '\n... (truncated)' : stdout;
      const truncatedStderr = stderr.length > 10000 ? stderr.substring(0, 10000) + '\n... (truncated)' : stderr;

      return {
        success: exitCode === 0,
        exitCode,
        stdout: truncatedStdout,
        stderr: truncatedStderr,
        command: `git ${args.join(' ')}`,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};
