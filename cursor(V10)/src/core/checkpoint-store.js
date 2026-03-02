const fs = require('fs');
const path = require('path');

// ============================================================
// CheckpointStore — 文件快照管理（对标 Cursor Checkpoint 机制）
// 每次写/删操作前自动备份原文件，支持一键回滚
// ============================================================

// 大文件阈值：超过 1MB 的文件最多保留 2 个快照（防止存储膨胀）
const LARGE_FILE_THRESHOLD = 1024 * 1024;
const LARGE_FILE_MAX_SNAPSHOTS = 2;
const DEFAULT_MAX_SNAPSHOTS = 20;
const CHECKPOINT_DIR_NAME = '.agent-checkpoints';

class CheckpointStore {
    // 类级单例 Map: normalizedPath -> [{ id, timestamp, snapshotPath, originalSize, toolName, sessionId }]
    static _snapshots = new Map();
    static _gitignoreEnsured = new Set(); // 已处理过的 projectPath 集合

    /**
     * 保存文件快照。
     * @param {string} filePath - 要备份的文件绝对路径
     * @param {object} opts - { toolName, sessionId, projectPath }
     * @returns {{ id: string, snapshotPath: string } | null}
     */
    static save(filePath, { toolName = 'unknown', sessionId = '_default', projectPath = null } = {}) {
        if (!filePath || !fs.existsSync(filePath)) return null;

        // Bug #4 fix: 如果提供了 projectPath，检查文件是否在项目内
        // 避免在系统目录（如 /etc、~/.bashrc）创建快照文件夹
        if (projectPath) {
            const resolvedProject = path.resolve(projectPath).toLowerCase();
            const resolvedFile = path.resolve(filePath).toLowerCase();
            if (!resolvedFile.startsWith(resolvedProject)) {
                return null; // 项目外文件不创建快照
            }
        }

        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) return null;

        const fileSize = stat.size;
        const maxSnapshots = fileSize > LARGE_FILE_THRESHOLD
            ? LARGE_FILE_MAX_SNAPSHOTS
            : DEFAULT_MAX_SNAPSHOTS;

        // 超大文件直接跳过快照（> 5MB）
        if (fileSize > 5 * 1024 * 1024) return null;

        const content = fs.readFileSync(filePath);
        const timestamp = Date.now();
        const filename = path.basename(filePath);
        const id = `${timestamp}_${filename}`;

        // 构建快照目录（优先使用传入的 projectPath，回退到自动猜测）
        const projectDir = projectPath ? path.resolve(projectPath) : this._guessProjectDir(filePath);
        const checkpointDir = path.join(projectDir, CHECKPOINT_DIR_NAME, sessionId);

        try {
            fs.mkdirSync(checkpointDir, { recursive: true });
        } catch (_) { return null; }

        const snapshotPath = path.join(checkpointDir, id);
        try {
            fs.writeFileSync(snapshotPath, content);
        } catch (_) { return null; }

        // 记录元数据
        const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
        if (!this._snapshots.has(normalizedPath)) {
            this._snapshots.set(normalizedPath, []);
        }
        const snapshots = this._snapshots.get(normalizedPath);
        snapshots.push({
            id,
            timestamp,
            snapshotPath,
            originalSize: fileSize,
            toolName,
            sessionId,
            originalPath: filePath,
        });

        // 超出上限，移除最早的快照
        while (snapshots.length > maxSnapshots) {
            const oldest = snapshots.shift();
            try { fs.unlinkSync(oldest.snapshotPath); } catch (_) { }
        }

        return { id, snapshotPath };
    }

    /**
     * 回滚文件到指定快照（默认最近一次）。
     * @param {string} filePath - 原文件绝对路径
     * @param {string} [checkpointId] - 快照 ID，不传则回滚到最近快照
     * @returns {{ success: boolean, message: string, restoredFrom?: string }}
     */
    static restore(filePath, checkpointId = null) {
        const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
        const snapshots = this._snapshots.get(normalizedPath);

        if (!snapshots || snapshots.length === 0) {
            return { success: false, message: `No checkpoints found for ${path.basename(filePath)}` };
        }

        let target;
        if (checkpointId) {
            target = snapshots.find(s => s.id === checkpointId);
            if (!target) {
                return { success: false, message: `Checkpoint "${checkpointId}" not found. Available: ${snapshots.map(s => s.id).join(', ')}` };
            }
        } else {
            target = snapshots[snapshots.length - 1]; // 最近的快照
        }

        if (!fs.existsSync(target.snapshotPath)) {
            return { success: false, message: `Snapshot file missing: ${target.snapshotPath}` };
        }

        try {
            // 确保目录存在（文件可能已被删除）
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const content = fs.readFileSync(target.snapshotPath);
            fs.writeFileSync(filePath, content);

            // 从快照列表中移除已使用的及之后的快照（回滚后未来快照无意义）
            const idx = snapshots.indexOf(target);
            const removed = snapshots.splice(idx);
            for (const s of removed) {
                try { fs.unlinkSync(s.snapshotPath); } catch (_) { }
            }

            return {
                success: true,
                message: `Restored ${path.basename(filePath)} to checkpoint ${target.id} (created by ${target.toolName})`,
                restoredFrom: target.id,
            };
        } catch (err) {
            return { success: false, message: `Restore failed: ${err.message}` };
        }
    }

    /**
     * 列出文件的所有可用快照（预留 API，供未来 UI 使用）。
     */
    static list(filePath) {
        const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
        const snapshots = this._snapshots.get(normalizedPath) || [];
        return snapshots.map(s => ({
            id: s.id,
            timestamp: s.timestamp,
            toolName: s.toolName,
            originalSize: s.originalSize,
            exists: fs.existsSync(s.snapshotPath),
        }));
    }

    /**
     * 获取快照元数据（预留 API）。
     */
    static getMetadata(filePath) {
        const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
        const snapshots = this._snapshots.get(normalizedPath) || [];
        return {
            filePath,
            snapshotCount: snapshots.length,
            oldestTimestamp: snapshots.length > 0 ? snapshots[0].timestamp : null,
            newestTimestamp: snapshots.length > 0 ? snapshots[snapshots.length - 1].timestamp : null,
            totalSize: snapshots.reduce((sum, s) => sum + s.originalSize, 0),
        };
    }

    /**
     * 清理指定会话的所有快照。
     * @param {string} sessionId
     * @param {string} [projectPath] - 如果提供，清理该项目下的快照目录
     */
    static cleanup(sessionId, projectPath = null) {
        let cleanedCount = 0;

        // 清理内存中该 session 的快照记录
        for (const [key, snapshots] of this._snapshots.entries()) {
            const remaining = [];
            for (const s of snapshots) {
                if (s.sessionId === sessionId) {
                    try { fs.unlinkSync(s.snapshotPath); cleanedCount++; } catch (_) { }
                } else {
                    remaining.push(s);
                }
            }
            if (remaining.length === 0) {
                this._snapshots.delete(key);
            } else {
                this._snapshots.set(key, remaining);
            }
        }

        // 尝试删除会话目录
        if (projectPath) {
            const sessionDir = path.join(projectPath, CHECKPOINT_DIR_NAME, sessionId);
            try {
                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
            } catch (_) { }
        }

        return { cleaned: cleanedCount };
    }

    /**
     * 检测到 .git/ 目录时，自动将 .agent-checkpoints/ 追加到 .gitignore。
     * 仅在每个 projectPath 上执行一次。
     */
    static ensureGitignore(projectPath) {
        if (!projectPath) return;
        if (this._gitignoreEnsured.has(projectPath)) return;
        this._gitignoreEnsured.add(projectPath);

        const gitDir = path.join(projectPath, '.git');
        if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return;

        const gitignorePath = path.join(projectPath, '.gitignore');
        const entry = CHECKPOINT_DIR_NAME + '/';

        try {
            if (fs.existsSync(gitignorePath)) {
                const content = fs.readFileSync(gitignorePath, 'utf-8');
                if (content.includes(entry)) return; // 已存在
                fs.appendFileSync(gitignorePath, `\n# Agent checkpoint snapshots\n${entry}\n`, 'utf-8');
            } else {
                fs.writeFileSync(gitignorePath, `# Agent checkpoint snapshots\n${entry}\n`, 'utf-8');
            }
        } catch (_) { /* 写入失败不阻塞主流程 */ }
    }

    /**
     * 猜测项目根目录（向上查找 package.json 或 .git，最多 5 层）。
     * 回退到文件所在目录。
     */
    static _guessProjectDir(filePath) {
        let dir = path.dirname(filePath);
        for (let i = 0; i < 5; i++) {
            if (fs.existsSync(path.join(dir, 'package.json')) ||
                fs.existsSync(path.join(dir, '.git'))) {
                return dir;
            }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        return path.dirname(filePath); // 回退
    }
}

module.exports = { CheckpointStore, CHECKPOINT_DIR_NAME };
