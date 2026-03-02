const { execFile, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ============================================================
// 多引擎 Linter Runner — 对标 Cursor 的诊断架构
// 支持 ESLint、Biome、TypeScript Compiler (tsc)
// ============================================================

const SUPPORTED_EXTENSIONS = {
  eslint: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte'],
  biome: ['.js', '.jsx', '.ts', '.tsx', '.json', '.jsonc', '.css'],
  tsc: ['.ts', '.tsx'],
};

// ── 查找工具路径 ──

function findBinary(projectPath, name) {
  if (!projectPath) return null;
  const localBin = path.join(projectPath, 'node_modules', '.bin', name);
  const localBinWin = localBin + '.cmd';
  if (process.platform === 'win32' && fs.existsSync(localBinWin)) return localBinWin;
  if (fs.existsSync(localBin)) return localBin;
  return null;
}

function findEslint(projectPath) { return findBinary(projectPath, 'eslint'); }
function findBiome(projectPath) { return findBinary(projectPath, 'biome'); }
function findTsc(projectPath) { return findBinary(projectPath, 'tsc'); }

function hasEslintConfig(projectPath) {
  const configFiles = [
    '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
    'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
  ];
  return configFiles.some(f => fs.existsSync(path.join(projectPath, f)));
}

function hasBiomeConfig(projectPath) {
  return fs.existsSync(path.join(projectPath, 'biome.json')) || fs.existsSync(path.join(projectPath, 'biome.jsonc'));
}

function hasTsConfig(projectPath) {
  return fs.existsSync(path.join(projectPath, 'tsconfig.json'));
}

// ── ESLint Runner ──

function runEslint(eslintPath, targetFiles, cwd) {
  const args = ['--format', 'json', '--no-error-on-unmatched-pattern', ...targetFiles];
  return new Promise((resolve) => {
    execFile(eslintPath, args, {
      cwd,
      timeout: 60000,
      maxBuffer: 1024 * 512,
      encoding: 'utf-8',
    }, (err, stdout, stderr) => {
      try {
        const output = stdout || '[]';
        const results = JSON.parse(output);
        const diagnostics = [];
        for (const file of results) {
          const relPath = path.relative(cwd, file.filePath).replace(/\\/g, '/');
          for (const msg of file.messages || []) {
            diagnostics.push({
              file: relPath,
              line: msg.line || 1,
              column: msg.column || 1,
              endLine: msg.endLine || msg.line || 1,
              endColumn: msg.endColumn || msg.column || 1,
              severity: msg.severity === 2 ? 'error' : 'warning',
              message: msg.message,
              source: 'eslint',
              ruleId: msg.ruleId || null,
            });
          }
        }
        resolve({ success: true, diagnostics, engine: 'eslint' });
      } catch (_) {
        const errorMsg = (stderr || '').substring(0, 200) || 'Failed to parse ESLint output';
        resolve({ success: false, diagnostics: [], engine: 'eslint', error: errorMsg });
      }
    });
  });
}

// ── Biome Runner ──

function runBiome(biomePath, targetFiles, cwd) {
  const args = ['lint', '--reporter', 'json', ...targetFiles];
  return new Promise((resolve) => {
    execFile(biomePath, args, {
      cwd,
      timeout: 60000,
      maxBuffer: 1024 * 512,
      encoding: 'utf-8',
    }, (err, stdout, stderr) => {
      try {
        const output = stdout || '{}';
        const result = JSON.parse(output);
        const diagnostics = [];
        for (const diag of (result.diagnostics || [])) {
          const location = diag.location || {};
          const span = location.span || {};
          diagnostics.push({
            file: (location.path?.file || '').replace(/\\/g, '/'),
            line: span.start?.line || 1,
            column: span.start?.character || 1,
            endLine: span.end?.line || span.start?.line || 1,
            endColumn: span.end?.character || span.start?.character || 1,
            severity: diag.severity === 'error' ? 'error' : 'warning',
            message: diag.message || diag.description || '',
            source: 'biome',
            ruleId: diag.category || null,
          });
        }
        resolve({ success: true, diagnostics, engine: 'biome' });
      } catch (_) {
        // Biome 可能输出到 stderr
        const diagnostics = [];
        try {
          const result = JSON.parse(stderr || '{}');
          for (const diag of (result.diagnostics || [])) {
            diagnostics.push({
              file: (diag.location?.path?.file || '').replace(/\\/g, '/'),
              line: diag.location?.span?.start?.line || 1,
              column: diag.location?.span?.start?.character || 1,
              severity: diag.severity === 'error' ? 'error' : 'warning',
              message: diag.message || '',
              source: 'biome',
              ruleId: diag.category || null,
            });
          }
          if (diagnostics.length > 0) {
            resolve({ success: true, diagnostics, engine: 'biome' });
            return;
          }
        } catch (__) {}
        resolve({ success: false, diagnostics: [], engine: 'biome', error: 'Failed to parse Biome output' });
      }
    });
  });
}

// ── TypeScript Compiler (tsc) Runner ──

function runTsc(tscPath, targetFiles, cwd) {
  return new Promise((resolve) => {
    const args = ['--noEmit', '--pretty', 'false'];
    // 如果指定了具体文件，添加到参数；否则用项目的 tsconfig
    if (targetFiles.length > 0 && targetFiles[0] !== '.') {
      args.push(...targetFiles);
      args.push('--skipLibCheck');
    }

    execFile(tscPath, args, {
      cwd,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
    }, (err, stdout) => {
      const diagnostics = [];
      const lines = (stdout || '').split('\n');

      // tsc 输出格式: file(line,col): error TSxxxx: message
      const tscPattern = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/;
      for (const line of lines) {
        const match = line.match(tscPattern);
        if (match) {
          const filePath = match[1].replace(/\\/g, '/');
          const relPath = path.isAbsolute(filePath)
            ? path.relative(cwd, filePath).replace(/\\/g, '/')
            : filePath;
          diagnostics.push({
            file: relPath,
            line: parseInt(match[2]),
            column: parseInt(match[3]),
            severity: match[4] === 'error' ? 'error' : 'warning',
            message: match[6].trim(),
            source: 'typescript',
            ruleId: match[5],
          });
        }
      }

      resolve({ success: true, diagnostics, engine: 'tsc' });
    });
  });
}

// ── Node.js 内置语法检查（回退方案） ──

function checkSyntaxBuiltin(filePath, relPath) {
  const ext = path.extname(filePath).toLowerCase();
  const diagnostics = [];

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.trim()) return diagnostics;

    if (ext === '.json') {
      try {
        JSON.parse(content);
      } catch (e) {
        const posMatch = e.message.match(/position (\d+)/);
        let line = 1, col = 1;
        if (posMatch) {
          const pos = parseInt(posMatch[1]);
          const before = content.substring(0, pos);
          line = before.split('\n').length;
          col = pos - before.lastIndexOf('\n');
        }
        diagnostics.push({
          file: relPath,
          line,
          column: col,
          severity: 'error',
          message: e.message.split('\n')[0],
          source: 'json-parse',
          ruleId: null,
        });
      }
      return diagnostics;
    }

    // JS/TS 基础语法检查：用 Node 的 vm.compileFunction（比 new Function 更准确）
    if (['.js', '.mjs', '.cjs'].includes(ext)) {
      try {
        const vm = require('vm');
        // 移除 hashbang
        const cleaned = content.replace(/^#!.*\n/, '\n');
        // 尝试作为模块编译（检查基本语法）
        new vm.Script(cleaned, { filename: filePath });
      } catch (e) {
        const lineMatch = e.stack?.match(/:(\d+)/) || e.message.match(/line (\d+)/i);
        const colMatch = e.stack?.match(/:(\d+):(\d+)/) ;
        diagnostics.push({
          file: relPath,
          line: lineMatch ? parseInt(lineMatch[1]) : 1,
          column: colMatch ? parseInt(colMatch[2]) : 1,
          severity: 'error',
          message: e.message.split('\n')[0],
          source: 'syntax-check',
          ruleId: null,
        });
      }
    }

    // Python 语法检查
    if (ext === '.py') {
      try {
        execSync(`python -c "import ast; ast.parse(open(r'${filePath.replace(/'/g, "\\'")}', encoding='utf-8').read())"`, {
          timeout: 10000,
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: path.dirname(filePath),
        });
      } catch (e) {
        const stderr = e.stderr?.toString() || '';
        const lineMatch = stderr.match(/line (\d+)/);
        const colMatch = stderr.match(/offset (\d+)/);
        diagnostics.push({
          file: relPath,
          line: lineMatch ? parseInt(lineMatch[1]) : 1,
          column: colMatch ? parseInt(colMatch[1]) : 1,
          severity: 'error',
          message: stderr.split('\n').filter(l => l.trim()).pop() || 'Python syntax error',
          source: 'python-ast',
          ruleId: null,
        });
      }
    }
  } catch (_) {}

  return diagnostics;
}

// ── 主入口：检测可用引擎并运行 ──

async function getLinterErrors(projectPath, targetFiles, options = {}) {
  if (!projectPath) return { success: false, diagnostics: [], error: 'No project path' };

  const files = (targetFiles && targetFiles.length > 0) ? targetFiles : ['.'];
  const allDiagnostics = [];
  const enginesUsed = [];
  const errors = [];

  // 过滤目标文件，只保留对应引擎支持的扩展名
  const filterFiles = (files, extensions) => {
    if (files.length === 1 && files[0] === '.') return files;
    return files.filter(f => extensions.includes(path.extname(f).toLowerCase()));
  };

  // 1. ESLint
  if (!options.skipEslint) {
    const eslintPath = findEslint(projectPath);
    if (eslintPath && hasEslintConfig(projectPath)) {
      const eslintFiles = filterFiles(files, SUPPORTED_EXTENSIONS.eslint);
      if (eslintFiles.length > 0) {
        try {
          const result = await runEslint(eslintPath, eslintFiles, projectPath);
          if (result.success) {
            allDiagnostics.push(...result.diagnostics);
            enginesUsed.push('eslint');
          } else {
            errors.push(`ESLint: ${result.error}`);
          }
        } catch (e) {
          errors.push(`ESLint crashed: ${e.message}`);
        }
      }
    }
  }

  // 2. Biome
  if (!options.skipBiome) {
    const biomePath = findBiome(projectPath);
    if (biomePath && hasBiomeConfig(projectPath)) {
      const biomeFiles = filterFiles(files, SUPPORTED_EXTENSIONS.biome);
      if (biomeFiles.length > 0) {
        try {
          const result = await runBiome(biomePath, biomeFiles, projectPath);
          if (result.success) {
            allDiagnostics.push(...result.diagnostics);
            enginesUsed.push('biome');
          } else {
            errors.push(`Biome: ${result.error}`);
          }
        } catch (e) {
          errors.push(`Biome crashed: ${e.message}`);
        }
      }
    }
  }

  // 3. TypeScript Compiler
  if (!options.skipTsc) {
    const tscPath = findTsc(projectPath);
    if (tscPath && hasTsConfig(projectPath)) {
      const tscFiles = filterFiles(files, SUPPORTED_EXTENSIONS.tsc);
      if (tscFiles.length > 0) {
        try {
          const result = await runTsc(tscPath, tscFiles, projectPath);
          if (result.success) {
            // 去重：TSC 错误可能和 ESLint 重叠
            for (const diag of result.diagnostics) {
              const isDuplicate = allDiagnostics.some(d =>
                d.file === diag.file && d.line === diag.line && d.column === diag.column
              );
              if (!isDuplicate) allDiagnostics.push(diag);
            }
            enginesUsed.push('tsc');
          }
        } catch (e) {
          errors.push(`TSC crashed: ${e.message}`);
        }
      }
    }
  }

  // 4. 内置语法检查回退（当没有任何外部 linter 可用时）
  if (enginesUsed.length === 0 && files[0] !== '.') {
    for (const f of files.slice(0, 20)) {
      try {
        const fullPath = path.isAbsolute(f) ? f : path.join(projectPath, f);
        const relPath = path.relative(projectPath, fullPath).replace(/\\/g, '/');
        if (fs.existsSync(fullPath)) {
          const builtinDiags = checkSyntaxBuiltin(fullPath, relPath);
          allDiagnostics.push(...builtinDiags);
        }
      } catch (_) {}
    }
    if (allDiagnostics.length >= 0) enginesUsed.push('builtin');
  }

  // 按严重程度和文件排序
  allDiagnostics.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });

  return {
    success: true,
    diagnostics: allDiagnostics,
    engines: enginesUsed,
    errors: errors.length > 0 ? errors : undefined,
    totalFiles: new Set(allDiagnostics.map(d => d.file)).size,
  };
}

// ── 检测项目中可用的 linter ──

function detectAvailableEngines(projectPath) {
  if (!projectPath) return ['builtin'];
  const engines = [];
  if (findEslint(projectPath) && hasEslintConfig(projectPath)) engines.push('eslint');
  if (findBiome(projectPath) && hasBiomeConfig(projectPath)) engines.push('biome');
  if (findTsc(projectPath) && hasTsConfig(projectPath)) engines.push('tsc');
  if (engines.length === 0) engines.push('builtin');
  return engines;
}

module.exports = { getLinterErrors, findEslint, findBiome, findTsc, detectAvailableEngines, checkSyntaxBuiltin };
