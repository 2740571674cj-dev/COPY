const fs = require('fs');
const path = require('path');
const { validatePath } = require('../core/security-layer');

// ============================================================
// read_lints — 对标 Cursor 的 ReadLints 工具
//
// Cursor 行为参考：
// - 可指定文件或目录路径，不指定则检查全部文件
// - 返回 diagnostics 包含 file, line, column, severity, message, source
// - 只返回当前工作区内的诊断信息
// - 应在代码编辑后使用，检查是否引入了新错误
// - 支持 ESLint、Biome、TypeScript 等多种 linter
// ============================================================

module.exports = {
  name: 'read_lints',
  description: `Read and return linter errors from the current workspace. You can provide paths to specific files or directories, or omit the argument to get diagnostics for all files.

- If a file path is provided, returns diagnostics for that file only
- If a directory path is provided, returns diagnostics for all files within that directory
- If no path is provided, returns diagnostics for all files in the workspace
- This tool can return linter errors that were already present before your edits, so avoid calling it with a very wide scope of files
- NEVER call this tool on a file unless you've edited it or are about to edit it`,
  parameters: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional. An array of paths to files or directories to read linter errors for. You can use either relative paths in the workspace or absolute paths. If provided, returns diagnostics for the specified files/directories only. If not provided, returns diagnostics for all files in the workspace.',
      },
      explanation: {
        type: 'string',
        description: 'One sentence explanation as to why this tool is being used.',
      },
    },
    required: [],
  },
  riskLevel: 'safe',
  timeout: 120000,

  async handler(args, projectPath) {
    const { getLinterErrors, detectAvailableEngines, checkSyntaxBuiltin } = require('../core/linter-runner');
    const targetPaths = args.paths || [];

    // 解析并验证路径
    const resolvedFiles = [];
    const resolvedDirs = [];

    if (targetPaths.length > 0) {
      for (const p of targetPaths) {
        // 尝试解析为绝对路径
        let fullPath;
        if (path.isAbsolute(p)) {
          fullPath = p;
        } else {
          fullPath = path.join(projectPath, p);
        }

        // 安全检查
        const check = validatePath(fullPath, projectPath);
        if (!check.valid) continue;

        const resolved = check.resolvedPath;
        try {
          const stat = fs.statSync(resolved);
          if (stat.isDirectory()) {
            resolvedDirs.push(resolved);
          } else if (stat.isFile()) {
            resolvedFiles.push(resolved);
          }
        } catch (_) {
          // 文件不存在，跳过
        }
      }
    }

    // 如果指定了目录，收集其中的文件
    for (const dir of resolvedDirs) {
      const dirFiles = this._collectFiles(dir, projectPath);
      resolvedFiles.push(...dirFiles);
    }

    // 去重
    const uniqueFiles = [...new Set(resolvedFiles)];

    // 构建相对路径列表用于 linter
    const relativeFiles = uniqueFiles.map(f => {
      const rel = path.relative(projectPath, f).replace(/\\/g, '/');
      return rel;
    });

    // 检测可用的 linter 引擎
    const availableEngines = detectAvailableEngines(projectPath);

    let result;
    if (relativeFiles.length > 0) {
      result = await getLinterErrors(projectPath, relativeFiles);
    } else if (targetPaths.length === 0) {
      // 没指定路径 → 检查所有文件（但限制范围避免性能问题）
      result = await getLinterErrors(projectPath, ['.']);
    } else {
      // 指定了路径但全部无效
      return {
        success: true,
        diagnostics: [],
        message: 'No valid files found at the specified paths.',
      };
    }

    if (!result.success) {
      return {
        success: false,
        error: result.error || 'Linter execution failed',
        diagnostics: [],
      };
    }

    const diagnostics = result.diagnostics || [];

    // 如果指定了具体文件，只返回那些文件的诊断
    let filteredDiagnostics = diagnostics;
    if (relativeFiles.length > 0) {
      const fileSet = new Set(relativeFiles.map(f => f.replace(/\\/g, '/')));
      filteredDiagnostics = diagnostics.filter(d => {
        const diagFile = (d.file || '').replace(/\\/g, '/');
        return fileSet.has(diagFile);
      });
    }

    // 限制返回数量，避免输出过大
    const MAX_DIAGNOSTICS = 50;
    const truncated = filteredDiagnostics.length > MAX_DIAGNOSTICS;
    const displayDiagnostics = filteredDiagnostics.slice(0, MAX_DIAGNOSTICS);

    if (displayDiagnostics.length === 0) {
      return {
        success: true,
        diagnostics: [],
        engines: result.engines || availableEngines,
        message: 'No linter errors found.',
      };
    }

    // 格式化输出 — 对标 Cursor 的返回格式
    const errorCount = displayDiagnostics.filter(d => d.severity === 'error').length;
    const warningCount = displayDiagnostics.filter(d => d.severity === 'warning').length;
    const fileCount = new Set(displayDiagnostics.map(d => d.file)).size;

    return {
      success: true,
      diagnostics: displayDiagnostics.map(d => ({
        file: d.file,
        line: d.line,
        column: d.column,
        endLine: d.endLine,
        endColumn: d.endColumn,
        severity: d.severity,
        message: d.message,
        source: d.source,
        ruleId: d.ruleId,
      })),
      summary: `Found ${errorCount} error(s) and ${warningCount} warning(s) in ${fileCount} file(s).`,
      engines: result.engines || availableEngines,
      truncated,
      totalCount: filteredDiagnostics.length,
    };
  },

  /**
   * 收集目录中的可 lint 文件
   */
  _collectFiles(dir, projectPath, depth = 0) {
    if (depth > 5) return [];
    const files = [];
    const LINT_EXTENSIONS = [
      '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
      '.json', '.vue', '.svelte', '.css', '.py',
    ];
    const IGNORE_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.cache', 'coverage', '.turbo'];

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.eslintrc' && !entry.name.startsWith('.eslintrc')) continue;
        if (IGNORE_DIRS.includes(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...this._collectFiles(fullPath, projectPath, depth + 1));
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (LINT_EXTENSIONS.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch (_) {}

    return files.slice(0, 100);
  },
};
