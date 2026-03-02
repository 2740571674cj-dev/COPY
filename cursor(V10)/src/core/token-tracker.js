/**
 * TokenTracker — 轻量级 Token 消耗追踪器
 * 将每次 LLM 调用的 usage 数据持久化到 JSONL 文件
 * 
 * 每行格式: {"t":1708800000,"m":"deepseek-r1","p":1500,"c":800}
 * t = timestamp (ms), m = modelId, p = promptTokens, c = completionTokens
 */
const fs = require('fs');
const path = require('path');

class TokenTracker {
    constructor(storePath) {
        // storePath 由外层传入（通常是 app.getPath('userData') + '/token-usage.jsonl'）
        this._storePath = storePath || null;
    }

    /**
     * 设置存储路径（延迟初始化，Electron app ready 后调用）
     */
    setStorePath(p) {
        this._storePath = p;
    }

    /**
     * 记录一次 LLM 调用的 token 消耗
     * @param {{ modelId: string, promptTokens: number, completionTokens: number }} data
     */
    record({ modelId, promptTokens, completionTokens }) {
        if (!this._storePath) return;
        if (!promptTokens && !completionTokens) return; // 无有效数据不记录

        const entry = {
            t: Date.now(),
            m: modelId || 'unknown',
            p: promptTokens || 0,
            c: completionTokens || 0,
        };

        try {
            // 确保目录存在
            const dir = path.dirname(this._storePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            // 追加写入 JSONL
            fs.appendFileSync(this._storePath, JSON.stringify(entry) + '\n', 'utf8');
        } catch (err) {
            console.error('[TokenTracker] record error:', err.message);
        }
    }

    /**
     * 查询指定时间范围内的 token 消耗数据
     * @param {{ startTime: number, endTime: number }} opts - 时间范围（ms 时间戳）
     * @returns {{ records: Array, aggregated: Array, totals: object, models: string[] }}
     */
    query({ startTime, endTime } = {}) {
        if (!this._storePath || !fs.existsSync(this._storePath)) {
            return { records: [], aggregated: [], totals: { prompt: 0, completion: 0, total: 0 }, models: [] };
        }

        const now = Date.now();
        const start = startTime || (now - 24 * 60 * 60 * 1000); // 默认近24小时
        const end = endTime || now;

        // 读取并过滤
        const raw = fs.readFileSync(this._storePath, 'utf8');
        const lines = raw.split('\n').filter(l => l.trim());
        const records = [];
        const modelSet = new Set();

        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (entry.t >= start && entry.t <= end) {
                    records.push(entry);
                    modelSet.add(entry.m);
                }
            } catch (_) { /* skip malformed lines */ }
        }

        // 计算时间跨度决定聚合粒度
        const spanMs = end - start;
        const spanHours = spanMs / (1000 * 60 * 60);
        // < 48h → 按小时聚合，否则 → 按天聚合
        const granularity = spanHours <= 48 ? 'hour' : 'day';

        // 聚合
        const buckets = new Map(); // key → { time, models... }
        const models = [...modelSet];

        for (const r of records) {
            const d = new Date(r.t);
            let key;
            if (granularity === 'hour') {
                key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`;
            } else {
                key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            }

            if (!buckets.has(key)) {
                const bucket = { time: key };
                for (const m of models) bucket[m] = 0;
                buckets.set(key, bucket);
            }
            const bucket = buckets.get(key);
            bucket[r.m] = (bucket[r.m] || 0) + r.p + r.c;
        }

        // 排序聚合结果
        const aggregated = [...buckets.values()].sort((a, b) => a.time.localeCompare(b.time));

        // 总计
        let totalPrompt = 0, totalCompletion = 0;
        for (const r of records) {
            totalPrompt += r.p;
            totalCompletion += r.c;
        }

        return {
            records,
            aggregated,
            totals: {
                prompt: totalPrompt,
                completion: totalCompletion,
                total: totalPrompt + totalCompletion,
            },
            models,
            granularity,
        };
    }
}

// 单例
const tracker = new TokenTracker();

module.exports = { TokenTracker, tracker };
