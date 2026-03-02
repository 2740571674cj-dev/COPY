/**
 * Self-Improve Pipeline — IDE 自我迭代评审+应用流程
 * 
 * allowlist 硬校验 + 规则引擎建议生成 + 应用执行 + 两级门禁
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// 支持 AbortSignal 的异步命令执行（取消时杀死子进程）
function execWithSignal(cmd, opts = {}) {
    return new Promise((resolve, reject) => {
        const isWin = process.platform === 'win32';
        const child = isWin
            ? spawn('cmd', ['/c', cmd], { cwd: opts.cwd, stdio: 'pipe', shell: false })
            : spawn('sh', ['-c', cmd], { cwd: opts.cwd, stdio: 'pipe' });
        let stdout = '', stderr = '';
        child.stdout?.on('data', d => { stdout += d; });
        child.stderr?.on('data', d => { stderr += d; });

        // 超时
        const timer = opts.timeout ? setTimeout(() => {
            child.kill('SIGTERM');
            reject(Object.assign(new Error('Timeout'), { stderr }));
        }, opts.timeout) : null;

        // AbortSignal 绑定
        if (opts.signal) {
            if (opts.signal.aborted) { child.kill('SIGTERM'); reject(new Error('Aborted')); return; }
            opts.signal.addEventListener('abort', () => { child.kill('SIGTERM'); reject(new Error('Aborted')); }, { once: true });
        }

        child.on('close', code => {
            if (timer) clearTimeout(timer);
            if (code === 0) resolve({ stdout, stderr });
            else reject(Object.assign(new Error(`Exit code ${code}`), { stdout, stderr }));
        });
        child.on('error', e => {
            if (timer) clearTimeout(timer);
            reject(Object.assign(e, { stderr }));
        });
    });
}

// === Allowlist：path.resolve 校验 + 目录包含 ===
const ALLOWLIST_DIRS = {
    auto: ['src/prompts'],
    semi: ['src/prompts', 'src/core', 'src/tools'],
    manual: null, // 无限制（需人工审批）
};

function validateTargetFiles(suggestion, projectRoot) {
    const dirs = ALLOWLIST_DIRS[suggestion.autoLevel];
    if (!dirs) return []; // manual 无限制

    const violations = [];
    const resolvedRoot = path.resolve(projectRoot) + path.sep;

    for (const f of (suggestion.targetFiles || [])) {
        // 拒绝含 .. 或绝对路径
        if (f.includes('..') || path.isAbsolute(f)) {
            violations.push({ file: f, reason: 'path traversal or absolute path' });
            continue;
        }
        const resolved = path.resolve(projectRoot, f);
        // 必须在 projectRoot 内
        if (!resolved.startsWith(resolvedRoot)) {
            violations.push({ file: f, reason: 'escapes project root' });
            continue;
        }
        // 必须在允许目录之一内
        const inAllowed = dirs.some(dir =>
            resolved.startsWith(path.resolve(projectRoot, dir) + path.sep)
        );
        if (!inAllowed) {
            violations.push({ file: f, reason: `not in allowed dirs: ${dirs.join(', ')}` });
        }
    }
    return violations;
}

// === 规则引擎：基于执行指标生成建议 ===
const METRIC_RULES = [
    {
        check: (m) => (m.editNotFoundCount || 0) >= 3,
        suggestion: {
            type: 'tool-chain',
            title: 'edit_file 匹配失败率过高',
            description: '多次出现 edit_file 目标内容未找到，建议优化 edit_file 工具的提示词，增加要求模型先 read_file 确认内容再编辑的指导。',
            targetFiles: ['src/prompts/mode-agent.js'],
            priority: 'high',
            autoLevel: 'auto',
        },
    },
    {
        check: (m) => (m.editMultipleMatchCount || 0) >= 3,
        suggestion: {
            type: 'tool-chain',
            title: 'edit_file 多重匹配频发',
            description: '编辑目标内容在文件中多次出现导致歧义，建议在工具提示中要求模型提供更长的上下文片段以精确匹配。',
            targetFiles: ['src/prompts/mode-agent.js'],
            priority: 'medium',
            autoLevel: 'auto',
        },
    },
    {
        check: (m) => (m.qualityInterceptCount || 0) >= 2,
        suggestion: {
            type: 'prompt',
            title: '质量拦截频繁触发',
            description: '模型回复频繁包含违规措辞，建议加强 system-base.js 中 quality_mandate 部分的措辞力度，或扩展 LAZY_PHRASES 黑名单。',
            targetFiles: ['src/prompts/system-base.js'],
            priority: 'high',
            autoLevel: 'auto',
        },
    },
    {
        check: (m) => (m.duplicateReadCount || 0) >= 5,
        suggestion: {
            type: 'tool-chain',
            title: '重复读取文件过多',
            description: '模型反复读取相同文件，建议在提示词中强化"已读文件无需重复读取"的指导，或增加读取缓存提示。',
            targetFiles: ['src/prompts/mode-agent.js'],
            priority: 'medium',
            autoLevel: 'auto',
        },
    },
    {
        check: (m, ctx) => ctx.iterations > 0 && ctx.toolCallCount === 0,
        suggestion: {
            type: 'prompt',
            title: 'Agent 执行无工具调用',
            description: '本次 Agent 执行期间未调用任何工具即结束，可能是提示词未能有效引导模型使用工具。建议检查 mode-agent.js 中的工具使用指导。',
            targetFiles: ['src/prompts/mode-agent.js'],
            priority: 'low',
            autoLevel: 'auto',
        },
    },
];

/**
 * 基于执行指标生成建议（规则引擎 + 24h 去重冷却）
 * @param {object} executionSummary
 * @param {object[]} existingSuggestions - 已有建议列表，用于去重
 */
function generateRuleBasedSuggestions(executionSummary, existingSuggestions = []) {
    const { metrics = {}, iterations = 0, toolCallCount = 0 } = executionSummary;
    const ctx = { iterations, toolCallCount };
    const suggestions = [];
    const now = Date.now();
    const COOLDOWN_MS = 24 * 3600_000; // 24h

    for (const rule of METRIC_RULES) {
        try {
            if (rule.check(metrics, ctx)) {
                const s = { ...rule.suggestion, evidence: JSON.stringify(metrics) };
                // fingerprint = type + title + targetFiles
                const fp = `${s.type}|${s.title}|${(s.targetFiles || []).sort().join(',')}`;
                // 24h 内是否已有相同 fingerprint 的建议
                const dup = existingSuggestions.find(ex => {
                    const exFp = `${ex.type}|${ex.title}|${(ex.targetFiles || []).sort().join(',')}`;
                    return exFp === fp && (now - new Date(ex.createdAt).getTime()) < COOLDOWN_MS;
                });
                if (!dup) {
                    s.fingerprint = fp;
                    suggestions.push(s);
                }
            }
        } catch (_) { }
    }

    return suggestions;
}
// === #6 建议质量评分 ===
function scoreSuggestion(suggestion) {
    let score = 50; // 基础分
    // 类型权重
    if (suggestion.type === 'prompt') score += 15; // 可自动应用
    if (suggestion.type === 'tool-chain') score += 10;
    // 优先级
    if (suggestion.priority === 'high') score += 20;
    if (suggestion.priority === 'medium') score += 10;
    // 目标文件明确性
    if (suggestion.targetFiles?.length > 0) score += 10;
    if (suggestion.targetFiles?.length > 3) score -= 5; // 影响面太大扣分
    // 自动化级别
    if (suggestion.autoLevel === 'auto') score += 10;
    if (suggestion.autoLevel === 'manual') score -= 10;
    return Math.max(0, Math.min(100, score));
}

// === #5 失败分类 ===
const FAIL_CATEGORIES = {
    allowlist_fail: { retryable: false, label: 'Allowlist 校验失败' },
    unsupported: { retryable: false, label: '类型不支持自动应用' },
    io_fail: { retryable: true, maxRetries: 2, label: '文件 IO 错误' },
    build_fail: { retryable: true, maxRetries: 1, label: '构建失败' },
    smoke_fail: { retryable: true, maxRetries: 1, label: 'Smoke 测试失败' },
    backup_fail: { retryable: false, label: '版本备份失败' },
    cancelled: { retryable: false, label: '用户取消' },
    no_change: { retryable: false, label: '无实际修改' },
};

function makeFailResult(category, detail, extra = {}) {
    const cat = FAIL_CATEGORIES[category] || { retryable: false, label: category };
    return {
        success: false,
        failCategory: category,
        retryable: cat.retryable,
        maxRetries: cat.maxRetries || 0,
        error: `${cat.label}: ${detail}`,
        ...extra,
    };
}

// === #3 Dry-Run 预览 ===
function dryRunPreview(suggestion, projectRoot) {
    const result = { files: [], errors: [] };
    if (suggestion.type !== 'prompt') {
        result.errors.push(`类型 "${suggestion.type}" 不支持自动预览`);
        return result;
    }
    for (const relFile of (suggestion.targetFiles || [])) {
        const absPath = path.resolve(projectRoot, relFile);
        if (!fs.existsSync(absPath)) {
            result.files.push({ file: relFile, exists: false, diff: null });
            continue;
        }
        const content = fs.readFileSync(absPath, 'utf-8');
        const tag = `[Self-Improve ${(suggestion.id || '').slice(0, 8)}]`;
        const patch = `\n// ${tag} ${suggestion.title}\n// ${(suggestion.description || '').replace(/\n/g, '\n// ')}\n`;
        const lines = content.split('\n');
        result.files.push({
            file: relFile,
            exists: true,
            currentLines: lines.length,
            appendLines: patch.split('\n').length,
            diff: `@@ -${lines.length},0 +${lines.length + 1},${patch.split('\n').length} @@\n${patch.split('\n').map(l => '+ ' + l).join('\n')}`,
        });
    }
    return result;
}

/**
 * 应用一条建议的完整流程
 * @param {object} suggestion
 * @param {object} deps - { suggestionStore, versionBackup, versionRollback, projectRoot, signal?, auditLogger? }
 * @returns {object} { success, error?, appliedVersion?, failCategory?, retryable? }
 */
async function applySuggestion(suggestion, deps) {
    const { suggestionStore, projectRoot, signal, auditLogger } = deps;
    const startTime = Date.now();

    // #4 取消检查 helper
    const checkCancel = async () => {
        if (signal?.aborted) {
            await suggestionStore.updateStatus(suggestion.id, 'approved', {
                failReason: '用户取消了应用操作',
            });
            return true;
        }
        return false;
    };

    // Step 1: Allowlist 校验
    const violations = validateTargetFiles(suggestion, projectRoot);
    if (violations.length > 0) {
        await suggestionStore.updateStatus(suggestion.id, 'pending', {
            autoLevel: 'manual',
            failReason: `Allowlist violation: ${violations.map(v => v.file + ' - ' + v.reason).join('; ')}`,
        });
        const r = makeFailResult('allowlist_fail', violations.map(v => v.file).join(', '), { violations });
        auditLogger?.log({ action: 'apply', suggestionId: suggestion.id, suggestionTitle: suggestion.title, status: 'failed', failCategory: 'allowlist_fail', durationMs: Date.now() - startTime });
        return r;
    }

    if (await checkCancel()) return makeFailResult('cancelled', '用户取消');

    // Step 2: 版本备份
    let backupResult;
    try {
        backupResult = await deps.versionBackup({ label: `self-improve-${suggestion.id.slice(0, 8)}` });
        if (!backupResult?.success) {
            const r = makeFailResult('backup_fail', backupResult?.error || 'unknown');
            auditLogger?.log({ action: 'apply', suggestionId: suggestion.id, status: 'failed', failCategory: 'backup_fail', durationMs: Date.now() - startTime });
            return r;
        }
    } catch (e) {
        const r = makeFailResult('backup_fail', e.message);
        auditLogger?.log({ action: 'apply', suggestionId: suggestion.id, status: 'failed', failCategory: 'backup_fail', durationMs: Date.now() - startTime });
        return r;
    }

    if (await checkCancel()) {
        try { await deps.versionRollback(backupResult.data?.backupDir); } catch (_) { }
        return makeFailResult('cancelled', '用户取消');
    }

    await suggestionStore.updateStatus(suggestion.id, 'implementing');

    // Step 3: 应用修改（#2 结构化补丁：带标记的分段，可定位回滚审计）
    let filesModified = 0;
    const modifiedFiles = [];
    try {
        if (suggestion.type === 'prompt' && suggestion.targetFiles.length > 0) {
            const tag = `[Self-Improve ${suggestion.id.slice(0, 8)}]`;
            for (const relFile of suggestion.targetFiles) {
                const absPath = path.resolve(projectRoot, relFile);
                if (!fs.existsSync(absPath)) continue;
                const content = fs.readFileSync(absPath, 'utf-8');
                // 结构化补丁：带开始/结束标记，可精确定位和回滚
                const patch = [
                    '',
                    `// ── ${tag} START ──`,
                    `// Title: ${suggestion.title}`,
                    `// ${(suggestion.description || '').replace(/\n/g, '\n// ')}`,
                    `// Applied: ${new Date().toISOString()}`,
                    `// ── ${tag} END ──`,
                    '',
                ].join('\n');
                fs.writeFileSync(absPath, content + patch, 'utf-8');
                filesModified++;
                modifiedFiles.push(relFile);
            }
        } else {
            try { await deps.versionRollback(backupResult.data?.backupDir); } catch (_) { }
            await suggestionStore.updateStatus(suggestion.id, 'approved', {
                failReason: `类型 "${suggestion.type}" 暂不支持自动应用，需通过 Agent 手动实施`,
            });
            const r = makeFailResult('unsupported', suggestion.type);
            auditLogger?.log({ action: 'apply', suggestionId: suggestion.id, status: 'failed', failCategory: 'unsupported', durationMs: Date.now() - startTime });
            return r;
        }
    } catch (e) {
        try { await deps.versionRollback(backupResult.data?.backupDir); } catch (_) { }
        await suggestionStore.updateStatus(suggestion.id, 'failed', { failReason: 'IO error: ' + e.message });
        const r = makeFailResult('io_fail', e.message);
        auditLogger?.log({ action: 'apply', suggestionId: suggestion.id, status: 'failed', failCategory: 'io_fail', durationMs: Date.now() - startTime });
        return r;
    }

    if (filesModified === 0) {
        try { await deps.versionRollback(backupResult.data?.backupDir); } catch (_) { }
        await suggestionStore.updateStatus(suggestion.id, 'approved', {
            failReason: '目标文件均不存在，无实际修改',
        });
        const r = makeFailResult('no_change', '目标文件不存在');
        auditLogger?.log({ action: 'apply', suggestionId: suggestion.id, status: 'failed', failCategory: 'no_change', durationMs: Date.now() - startTime });
        return r;
    }

    if (await checkCancel()) {
        try { await deps.versionRollback(backupResult.data?.backupDir); } catch (_) { }
        return makeFailResult('cancelled', '用户取消');
    }

    // Step 4: 两级门禁（异步执行）
    try {
        await execWithSignal('npm run build', { cwd: projectRoot, timeout: 60000, signal });
    } catch (e) {
        if (e.message === 'Aborted') {
            try { await deps.versionRollback(backupResult.data?.backupDir); } catch (_) { }
            return makeFailResult('cancelled', '用户取消');
        }
        const rollbackId = backupResult.data?.backupDir;
        if (rollbackId) { try { await deps.versionRollback(rollbackId); } catch (_) { } }
        await suggestionStore.updateStatus(suggestion.id, 'failed', {
            failReason: 'Build failed: ' + (e.stderr?.toString().slice(0, 200) || e.message),
            failCategory: 'build_fail',
        });
        const r = makeFailResult('build_fail', e.stderr?.toString().slice(0, 200) || e.message);
        auditLogger?.log({ action: 'apply', suggestionId: suggestion.id, status: 'failed', failCategory: 'build_fail', filesModified: modifiedFiles, durationMs: Date.now() - startTime });
        return r;
    }

    try {
        const smokeScript = path.join(projectRoot, 'scripts', 'smoke-test.js');
        if (fs.existsSync(smokeScript)) {
            await execWithSignal(`node "${smokeScript}"`, { cwd: projectRoot, timeout: 30000, signal });
        }
    } catch (e) {
        if (e.message === 'Aborted') {
            try { await deps.versionRollback(backupResult.data?.backupDir); } catch (_) { }
            return makeFailResult('cancelled', '用户取消');
        }
        const rollbackId = backupResult.data?.backupDir;
        if (rollbackId) { try { await deps.versionRollback(rollbackId); } catch (_) { } }
        await suggestionStore.updateStatus(suggestion.id, 'failed', {
            failReason: 'Smoke test failed: ' + (e.stderr?.toString().slice(0, 200) || e.message),
            failCategory: 'smoke_fail',
        });
        const r = makeFailResult('smoke_fail', e.stderr?.toString().slice(0, 200) || e.message);
        auditLogger?.log({ action: 'apply', suggestionId: suggestion.id, status: 'failed', failCategory: 'smoke_fail', filesModified: modifiedFiles, durationMs: Date.now() - startTime });
        return r;
    }

    // Step 5: 成功
    await suggestionStore.updateStatus(suggestion.id, 'implemented', {
        appliedVersion: backupResult.data?.backupDir || null,
    });
    auditLogger?.log({
        action: 'apply', suggestionId: suggestion.id, suggestionTitle: suggestion.title,
        status: 'implemented', filesModified: modifiedFiles, backupDir: backupResult.data?.backupDir,
        durationMs: Date.now() - startTime,
    });
    return { success: true, appliedVersion: backupResult.data?.backupDir, filesModified };
}

/**
 * #5 重试包装：对 retryable 失败自动重试
 * @param {object} suggestion
 * @param {object} deps - 同 applySuggestion
 * @returns {object}
 */
async function retryApply(suggestion, deps) {
    let lastResult;
    const maxAttempts = 3; // 总尝试次数上限
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        lastResult = await applySuggestion(suggestion, deps);
        if (lastResult.success) return lastResult;
        // 不可重试 → 直接返回 
        if (!lastResult.retryable) return lastResult;
        // 检查 maxRetries
        const catInfo = FAIL_CATEGORIES[lastResult.failCategory];
        if (attempt >= (catInfo?.maxRetries || 0)) return lastResult;
        // 重试前将状态改回 approved
        await deps.suggestionStore.updateStatus(suggestion.id, 'approved', {
            failReason: `${lastResult.error} (第 ${attempt + 1} 次失败，自动重试中...)`,
        });
        deps.auditLogger?.log({
            action: 'retry', suggestionId: suggestion.id,
            attempt: attempt + 1, failCategory: lastResult.failCategory,
        });
        // 等 2 秒再重试
        await new Promise(r => setTimeout(r, 2000));
    }
    return lastResult;
}

module.exports = {
    validateTargetFiles,
    generateRuleBasedSuggestions,
    applySuggestion,
    retryApply,            // #5
    scoreSuggestion,       // #6
    dryRunPreview,         // #3
    FAIL_CATEGORIES,       // #5
};
