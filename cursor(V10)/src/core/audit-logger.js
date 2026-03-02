/**
 * AuditLogger — 自我迭代审计日志
 * 
 * 每次自动应用的完整记录（JSONL 格式），便于追责与回溯。
 * 写到 userData/self-improve-log.jsonl
 */
const fs = require('fs');
const path = require('path');

class AuditLogger {
    constructor(basePath) {
        this._path = path.join(basePath, 'self-improve-log.jsonl');
    }

    /**
     * 追加一条审计记录
     * @param {object} entry
     * @param {string} entry.action - apply|rollback|approve|reject|generate
     * @param {string} entry.suggestionId
     * @param {string} [entry.suggestionTitle]
     * @param {string} [entry.status] - 最终状态
     * @param {string} [entry.failReason]
     * @param {string[]} [entry.filesModified]
     * @param {string} [entry.backupDir]
     * @param {number} [entry.durationMs]
     * @param {object} [entry.extra]
     */
    log(entry) {
        try {
            const record = {
                timestamp: new Date().toISOString(),
                ...entry,
            };
            fs.appendFileSync(this._path, JSON.stringify(record) + '\n', 'utf-8');
        } catch (e) {
            console.error('[AuditLogger] Write failed:', e.message);
        }
    }

    /** 读取最近 N 条审计记录 */
    recent(n = 50) {
        try {
            if (!fs.existsSync(this._path)) return [];
            const lines = fs.readFileSync(this._path, 'utf-8').trim().split('\n');
            return lines.slice(-n).map(l => {
                try { return JSON.parse(l); } catch (_) { return null; }
            }).filter(Boolean);
        } catch (_) {
            return [];
        }
    }

    /** 清理超过 N 天的记录 */
    cleanup(maxDays = 30) {
        try {
            if (!fs.existsSync(this._path)) return 0;
            const cutoff = Date.now() - maxDays * 86400_000;
            const lines = fs.readFileSync(this._path, 'utf-8').trim().split('\n');
            const kept = lines.filter(l => {
                try {
                    const r = JSON.parse(l);
                    return new Date(r.timestamp).getTime() > cutoff;
                } catch (_) { return false; }
            });
            const removed = lines.length - kept.length;
            if (removed > 0) {
                fs.writeFileSync(this._path, kept.join('\n') + '\n', 'utf-8');
            }
            return removed;
        } catch (_) { return 0; }
    }
}

module.exports = { AuditLogger };
