const path = require('path');
const { ERROR_CODES, makeError } = require('./error-codes');

const DANGEROUS_COMMANDS = [
  /\brm\s+(-rf?|--recursive)\s+[\/\\]/i,
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/[sfq]/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/sd/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bkill\s+-9\s+1\b/,
  /\breg\s+delete/i,
  /\bnet\s+user\b.*\/add/i,
  // Git-specific dangerous patterns
  /\bgit\s+config\s+--global\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /\bgit\s+push\s+.*-f\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-fd/i,
  /\bgit\s+reflog\s+expire/i,
];

const RISK_LEVELS = {
  safe: { needsApproval: false, description: 'Read-only operations' },
  low: { needsApproval: false, description: 'Low risk write operations' },
  medium: { needsApproval: true, description: 'File modifications, command execution' },
  high: { needsApproval: true, description: 'Destructive or irreversible operations' },
};

function validatePath(filePath, projectPath) {
  if (!projectPath || !filePath) {
    return makeError(ERROR_CODES.PATH_TRAVERSAL, filePath || '(empty)');
  }
  if (typeof filePath === 'string' && filePath.trim() === '') {
    return makeError(ERROR_CODES.PATH_TRAVERSAL, '(empty path)');
  }
  const resolved = path.resolve(projectPath, filePath);
  const normalizedProject = path.resolve(projectPath);
  // Windows 下盘符大小写不一致（D:\ vs d:\），统一转小写比较
  const resolvedLower = resolved.toLowerCase();
  const projectLower = (normalizedProject + path.sep).toLowerCase();
  const projectExactLower = normalizedProject.toLowerCase();
  if (!resolvedLower.startsWith(projectLower) && resolvedLower !== projectExactLower) {
    return makeError(ERROR_CODES.PATH_TRAVERSAL, filePath);
  }
  return { valid: true, resolvedPath: resolved };
}

function validateCommand(command) {
  for (const pattern of DANGEROUS_COMMANDS) {
    if (pattern.test(command)) {
      return makeError(ERROR_CODES.CMD_BLOCKED, `Matched dangerous pattern: ${pattern}`);
    }
  }
  return { valid: true };
}

function needsApproval(riskLevel, autoApproveMode = false, { toolName, command } = {}) {
  if (autoApproveMode) return false;
  if (_yoloMode) {
    // YOLO 模式下高风险操作仍强制审批（delete_file 等）
    if (riskLevel === 'high') return true;
    // 终端命令需要额外检查白名单
    if (toolName === 'run_terminal_cmd' && command) {
      return !isCommandInAllowlist(command);
    }
    return false;
  }
  const level = RISK_LEVELS[riskLevel];
  return level ? level.needsApproval : true;
}

// ── YOLO Mode ──

// 白名单：仅只读/构建类命令，有副作用的命令仍需审批
const DEFAULT_YOLO_ALLOWLIST = [
  // 包管理器（构建/测试/安装）
  /^(npm|npx|pnpm|yarn|bun)\s+(run|test|install|build|start|dev|lint|format)\b/i,
  // 脚本运行
  /^(node|python|python3)\s/i,
  // Git 只读操作（不含 checkout/add/commit/push/pull 等有副作用操作）
  /^git\s+(status|log|diff|branch|show|remote|tag)\b/i,
  // 文件系统只读命令
  /^(ls|dir|cat|type|echo|pwd|find|grep|rg|fd|head|tail|wc|tree)\b/i,
  // Linter / Formatter / 测试 / 编译器（只读分析）
  /^(tsc|eslint|biome|prettier|jest|vitest|mocha|pytest)\b/i,
  /^(cargo\s+(check|build|test)|go\s+(build|test|vet)|make|cmake)\b/i,
];

let _yoloMode = false;
let _yoloAllowlist = DEFAULT_YOLO_ALLOWLIST;

function setYoloMode(enabled, customAllowlist = null) {
  _yoloMode = !!enabled;
  if (customAllowlist) {
    _yoloAllowlist = customAllowlist.map(p =>
      p instanceof RegExp ? p : new RegExp(p, 'i')
    );
  } else {
    _yoloAllowlist = DEFAULT_YOLO_ALLOWLIST;
  }
}

function isYoloMode() { return _yoloMode; }

/**
 * 检查命令是否在 YOLO 白名单内。
 * 包含命令注入防护：拦截 shell 操作符（&&, ||, ;, |, >, <）防止绕过。
 */
function isCommandInAllowlist(command) {
  if (!command) return false;
  const trimmed = command.trim();

  // 命令注入防护：拦截 shell 操作符组合、重定向、命令替换符
  // 允许单独的 | cat（pager 推荐模式），但拦截其他管道/重定向/拼接
  // Bug #2 fix: 增加反引号 ` 和 $() 命令替换符的拦截，防止 `npm run build $(rm -rf /)` 绕过
  if (/[;&`]|&&|\|\||>>|>[^&]|<|\$\(/.test(trimmed)) {
    return false;
  }
  // 允许简单管道 "xxx | cat" 但拦截复杂管道
  const pipes = trimmed.split('|').map(s => s.trim());
  if (pipes.length > 2) return false; // 多级管道不允许
  if (pipes.length === 2 && !/^cat\s*$/.test(pipes[1])) return false; // 仅允许 | cat

  return _yoloAllowlist.some(regex => regex.test(trimmed));
}

module.exports = {
  validatePath, validateCommand, needsApproval, RISK_LEVELS,
  setYoloMode, isYoloMode, isCommandInAllowlist, DEFAULT_YOLO_ALLOWLIST,
};
