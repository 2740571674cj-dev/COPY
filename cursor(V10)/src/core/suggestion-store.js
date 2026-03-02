/**
 * SuggestionStore — IDE 自我迭代建议库
 * 
 * 串行队列 + 跨进程文件锁 + Windows 安全写 + 频率限制原子操作
 */
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

class SuggestionStore {
    constructor(basePath) {
        this._path = path.join(basePath, 'suggestions.json');
        this._tmpPath = this._path + '.tmp';
        this._ratePath = path.join(basePath, 'apply-rate.json');
        this._rateTmpPath = this._ratePath + '.tmp';
        this._lockPath = path.join(basePath, 'suggestions.lock');
        this._queue = Promise.resolve();
    }

    // --- 跨进程文件锁（异步，不阻塞事件循环）---
    async _acquireLock(maxWaitMs = 5000) {
        const start = Date.now();
        while (Date.now() - start < maxWaitMs) {
            try {
                fs.writeFileSync(this._lockPath, `${process.pid}\n${Date.now()}`, { flag: 'wx' });
                return true;
            } catch (_) {
                // 检测 stale lock（>30s 或持有进程已退出）
                try {
                    const content = fs.readFileSync(this._lockPath, 'utf-8');
                    const [pidStr, ts] = content.split('\n');
                    const lockAge = Date.now() - Number(ts || 0);
                    const lockPid = Number(pidStr);
                    // PID 存活校验：process.kill(pid, 0) 不发信号，仅检查进程是否存在
                    let pidAlive = true;
                    if (lockPid && lockPid !== process.pid) {
                        try { process.kill(lockPid, 0); } catch (_k) { pidAlive = false; }
                    }
                    if (lockAge > 30000 || !pidAlive) {
                        try { fs.unlinkSync(this._lockPath); } catch (__) { }
                        continue;
                    }
                } catch (__) { }
                // 异步 sleep 50ms，不阻塞事件循环
                await new Promise(r => setTimeout(r, 50));
            }
        }
        return false;
    }

    _releaseLock() {
        try { fs.unlinkSync(this._lockPath); } catch (_) { }
    }

    // --- 串行队列：catch 后恢复链条，不毒化后续操作 ---
    // 错误传回当前调用方（返回 _queueError 对象），但不阻断后续操作
    _enqueue(fn) {
        const op = this._queue
            .then(() => fn())
            .catch(e => {
                console.error('[SuggestionStore] Queue op failed:', e.message);
                return { _queueError: true, message: e.message };
            });
        // 队列始终指向已 resolve 的尾节点
        this._queue = op.then(() => { }, () => { });
        return op; // 返回给调用方的 promise 携带结果或错误对象
    }

    // --- 安全写（锁失败则拒绝写入） ---
    async _safeSave(data) {
        const locked = await this._acquireLock(3000);
        if (!locked) {
            throw new Error('Failed to acquire file lock for suggestions.json');
        }
        try {
            const json = JSON.stringify(data, null, 2);
            fs.writeFileSync(this._tmpPath, json, 'utf-8');
            try {
                if (fs.existsSync(this._path)) fs.unlinkSync(this._path);
                fs.renameSync(this._tmpPath, this._path);
            } catch (_) {
                fs.writeFileSync(this._path, json, 'utf-8');
                try { fs.unlinkSync(this._tmpPath); } catch (__) { }
            }
        } finally {
            this._releaseLock();
        }
    }

    // --- 崩溃恢复读取：优先主文件，不存在则尝试 .tmp ---
    _load() {
        for (const p of [this._path, this._tmpPath]) {
            try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { }
        }
        return [];
    }

    // --- 频率文件安全写（同样加锁） ---
    async _safeSaveRate(data) {
        const locked = await this._acquireLock(3000);
        if (!locked) {
            throw new Error('Failed to acquire file lock for apply-rate.json');
        }
        try {
            const json = JSON.stringify(data, null, 2);
            fs.writeFileSync(this._rateTmpPath, json, 'utf-8');
            try {
                if (fs.existsSync(this._ratePath)) fs.unlinkSync(this._ratePath);
                fs.renameSync(this._rateTmpPath, this._ratePath);
            } catch (_) {
                fs.writeFileSync(this._ratePath, json, 'utf-8');
                try { fs.unlinkSync(this._rateTmpPath); } catch (__) { }
            }
        } finally {
            this._releaseLock();
        }
    }

    _loadRate() {
        for (const p of [this._ratePath, this._rateTmpPath]) {
            try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { }
        }
        return { timestamps: [] };
    }

    // === 公开 API ===

    /** 添加建议 */
    async add(suggestion) {
        return this._enqueue(async () => {
            const data = this._load();
            const entry = {
                id: randomUUID(),
                type: suggestion.type || 'prompt',
                title: suggestion.title || '',
                description: suggestion.description || '',
                evidence: suggestion.evidence || '',
                targetFiles: suggestion.targetFiles || [],
                priority: suggestion.priority || 'medium',
                status: 'pending',
                autoLevel: suggestion.autoLevel || 'manual',
                createdAt: new Date().toISOString(),
                resolvedAt: null,
                appliedVersion: null,
                failReason: null,
            };
            data.push(entry);
            await this._safeSave(data);
            return entry;
        });
    }

    /** 批量添加 */
    async addBatch(suggestions) {
        return this._enqueue(async () => {
            const data = this._load();
            const entries = suggestions.map(s => ({
                id: randomUUID(),
                type: s.type || 'prompt',
                title: s.title || '',
                description: s.description || '',
                evidence: s.evidence || '',
                targetFiles: s.targetFiles || [],
                priority: s.priority || 'medium',
                status: 'pending',
                autoLevel: s.autoLevel || 'manual',
                createdAt: new Date().toISOString(),
                resolvedAt: null,
                appliedVersion: null,
                failReason: null,
            }));
            data.push(...entries);
            await this._safeSave(data);
            return entries;
        });
    }

    /** 列出建议（可按 status 过滤） */
    list(statusFilter) {
        const data = this._load();
        if (statusFilter) return data.filter(s => s.status === statusFilter);
        return data;
    }

    /** 更新建议状态 */
    async updateStatus(id, status, extra = {}) {
        return this._enqueue(async () => {
            const data = this._load();
            const item = data.find(s => s.id === id);
            if (!item) return null;
            item.status = status;
            item.statusUpdatedAt = new Date().toISOString(); // 用于崩溃恢复超时判断
            if (status === 'implemented' || status === 'rejected' || status === 'failed') {
                item.resolvedAt = new Date().toISOString();
            }
            Object.assign(item, extra);
            await this._safeSave(data);
            return item;
        });
    }

    /** 频率限制内的应用操作（成功后才记账） */
    async applyWithRateLimit(applyFn) {
        return this._enqueue(async () => {
            const rate = this._loadRate();
            const oneHourAgo = Date.now() - 3600_000;
            rate.timestamps = rate.timestamps.filter(ts => new Date(ts).getTime() > oneHourAgo);
            if (rate.timestamps.length >= 3) {
                const oldest = new Date(rate.timestamps[0]).getTime();
                return { allowed: false, remaining: 0, resetInMs: oldest + 3600_000 - Date.now() };
            }

            const result = await applyFn();

            // 成功后才记账
            if (result?.success) {
                rate.timestamps.push(new Date().toISOString());
                await this._safeSaveRate(rate);
            }
            return { allowed: true, remaining: 3 - rate.timestamps.length, ...result };
        });
    }

    /** 统计 */
    getStats() {
        const data = this._load();
        const counts = { pending: 0, approved: 0, implementing: 0, implemented: 0, failed: 0, rejected: 0 };
        for (const s of data) {
            if (counts[s.status] !== undefined) counts[s.status]++;
        }
        return { total: data.length, ...counts };
    }
}

module.exports = { SuggestionStore };
