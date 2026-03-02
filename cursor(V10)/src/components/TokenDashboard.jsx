import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
    ResponsiveContainer,
} from 'recharts';

// ── 模型费率表（每百万 token，美元） ──
const MODEL_RATES = {
    'gpt-4o': { prompt: 2.50, completion: 10.00 },
    'gpt-4o-mini': { prompt: 0.15, completion: 0.60 },
    'gpt-4-turbo': { prompt: 10.00, completion: 30.00 },
    'claude-3-5-sonnet': { prompt: 3.00, completion: 15.00 },
    'claude-3-haiku': { prompt: 0.25, completion: 1.25 },
    'deepseek-chat': { prompt: 0.14, completion: 0.28 },
    'deepseek-reasoner': { prompt: 0.55, completion: 2.19 },
    'gemini-2.0-flash': { prompt: 0.10, completion: 0.40 },
};
const DEFAULT_RATE = { prompt: 1.00, completion: 3.00 };

// ── 模型配色方案 ──
const PALETTE = [
    '#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6',
    '#ec4899', '#14b8a6', '#f97316', '#3b82f6', '#84cc16',
];

// ── 时间范围预设 ──
const TIME_RANGES = [
    {
        id: 'today', label: '今日', getRange: () => {
            const now = new Date();
            const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
            return { startTime: start, endTime: now.getTime() };
        }
    },
    {
        id: '7d', label: '近 7 天', getRange: () => {
            const now = Date.now();
            return { startTime: now - 7 * 24 * 60 * 60 * 1000, endTime: now };
        }
    },
    {
        id: '30d', label: '近 30 天', getRange: () => {
            const now = Date.now();
            return { startTime: now - 30 * 24 * 60 * 60 * 1000, endTime: now };
        }
    },
];

// ── 数字格式化 ──
const formatNumber = (n) => {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
};

const estimateCost = (records) => {
    let totalCost = 0;
    for (const r of records) {
        const rate = MODEL_RATES[r.m] || DEFAULT_RATE;
        totalCost += (r.p * rate.prompt + r.c * rate.completion) / 1_000_000;
    }
    return totalCost;
};

// ── 自定义 Tooltip ──
const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
        <div className="bg-[#1e1e1e] border border-zinc-700 rounded-lg p-3 shadow-xl text-xs">
            <p className="text-zinc-400 mb-2 font-medium">{label}</p>
            {payload.map((entry, i) => (
                <div key={i} className="flex items-center gap-2 py-0.5">
                    <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: entry.color }} />
                    <span className="text-zinc-300">{entry.name}:</span>
                    <span className="text-white font-mono ml-auto">{formatNumber(entry.value)}</span>
                </div>
            ))}
            <div className="mt-2 pt-2 border-t border-zinc-700 flex justify-between">
                <span className="text-zinc-500">合计</span>
                <span className="text-white font-mono font-medium">
                    {formatNumber(payload.reduce((s, p) => s + (p.value || 0), 0))}
                </span>
            </div>
        </div>
    );
};

// ═══════════════════════════════════════════
// TokenDashboard 主组件
// ═══════════════════════════════════════════
const TokenDashboard = () => {
    const [rangeId, setRangeId] = useState('today');
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [selectedModels, setSelectedModels] = useState(new Set()); // 空集 = 全选
    const [showModelFilter, setShowModelFilter] = useState(false);

    // ── 数据获取 ──
    const fetchData = useCallback(async () => {
        if (!window.electronAPI?.getTokenStats) return;
        setLoading(true);
        const range = TIME_RANGES.find(r => r.id === rangeId)?.getRange() || TIME_RANGES[0].getRange();
        try {
            const result = await window.electronAPI.getTokenStats(range);
            if (result?.success) {
                setData(result.data);
                // 初始化时全选所有模型
                if (selectedModels.size === 0 && result.data.models.length > 0) {
                    setSelectedModels(new Set(result.data.models));
                }
            }
        } catch (err) {
            console.error('[TokenDashboard] fetch error:', err);
        }
        setLoading(false);
    }, [rangeId]);

    useEffect(() => { fetchData(); }, [fetchData]);

    // ── 过滤后的模型列表 ──
    const activeModels = useMemo(() => {
        if (!data?.models) return [];
        if (selectedModels.size === 0) return data.models;
        return data.models.filter(m => selectedModels.has(m));
    }, [data?.models, selectedModels]);

    // ── 过滤后的图表数据 ──
    const chartData = useMemo(() => {
        if (!data?.aggregated) return [];
        if (activeModels.length === data?.models?.length) return data.aggregated;
        return data.aggregated.map(row => {
            const filtered = { time: row.time };
            for (const m of activeModels) {
                filtered[m] = row[m] || 0;
            }
            return filtered;
        });
    }, [data?.aggregated, activeModels]);

    // ── 过滤后的费用计算 ──
    const filteredRecords = useMemo(() => {
        if (!data?.records) return [];
        if (activeModels.length === data?.models?.length) return data.records;
        return data.records.filter(r => activeModels.includes(r.m));
    }, [data?.records, activeModels]);

    const filteredTotals = useMemo(() => {
        let p = 0, c = 0;
        for (const r of filteredRecords) { p += r.p; c += r.c; }
        return { prompt: p, completion: c, total: p + c };
    }, [filteredRecords]);

    const cost = useMemo(() => estimateCost(filteredRecords), [filteredRecords]);

    const toggleModel = (m) => {
        setSelectedModels(prev => {
            const next = new Set(prev);
            if (next.has(m)) next.delete(m);
            else next.add(m);
            return next;
        });
    };

    // ═══════════════════════════════════════════
    // 渲染
    // ═══════════════════════════════════════════
    return (
        <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
            {/* ── 标题 ── */}
            <div className="mb-6">
                <h2 className="text-lg font-bold text-zinc-100 tracking-tight">Token 消耗看板</h2>
                <p className="text-xs text-zinc-500 mt-1">追踪每次 LLM 调用的 Token 消耗，按时间和模型维度聚合展示</p>
            </div>

            {/* ── 筛选器栏 ── */}
            <div className="flex items-center gap-3 mb-6">
                {/* 时间范围 */}
                <div className="flex bg-zinc-900 rounded-lg p-0.5 border border-zinc-800">
                    {TIME_RANGES.map(r => (
                        <button
                            key={r.id}
                            onClick={() => setRangeId(r.id)}
                            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${rangeId === r.id
                                    ? 'bg-indigo-600 text-white shadow-sm'
                                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                                }`}
                        >
                            {r.label}
                        </button>
                    ))}
                </div>

                {/* 模型筛选 */}
                <div className="relative">
                    <button
                        onClick={() => setShowModelFilter(!showModelFilter)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-400 bg-zinc-900 border border-zinc-800 rounded-lg hover:text-zinc-200 hover:border-zinc-700 transition-all"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>
                        模型筛选
                        {selectedModels.size > 0 && selectedModels.size < (data?.models?.length || 0) && (
                            <span className="bg-indigo-600 text-white w-4 h-4 rounded-full text-[10px] flex items-center justify-center">
                                {selectedModels.size}
                            </span>
                        )}
                    </button>

                    {showModelFilter && data?.models?.length > 0 && (
                        <div className="absolute top-full left-0 mt-1 w-56 bg-[#1e1e1e] border border-zinc-700 rounded-lg shadow-xl z-20 py-1 animate-fade-in">
                            <div className="px-3 py-1.5 border-b border-zinc-800 flex justify-between items-center">
                                <span className="text-[10px] text-zinc-500 uppercase font-bold">选择模型</span>
                                <button
                                    onClick={() => setSelectedModels(new Set(data.models))}
                                    className="text-[10px] text-indigo-400 hover:text-indigo-300"
                                >
                                    全选
                                </button>
                            </div>
                            {data.models.map((m, i) => (
                                <label key={m} data-ui-audit-ignore="true" className="flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-800 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={selectedModels.has(m)}
                                        onChange={() => toggleModel(m)}
                                        className="rounded border-zinc-600 bg-zinc-900 text-indigo-600 focus:ring-offset-0 focus:ring-indigo-500"
                                    />
                                    <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: PALETTE[i % PALETTE.length] }} />
                                    <span className="text-xs text-zinc-300 truncate">{m}</span>
                                </label>
                            ))}
                        </div>
                    )}
                </div>

                {/* 刷新 */}
                <button
                    onClick={fetchData}
                    disabled={loading}
                    className="ml-auto px-3 py-1.5 text-xs font-medium text-zinc-400 bg-zinc-900 border border-zinc-800 rounded-lg hover:text-zinc-200 hover:border-zinc-700 transition-all disabled:opacity-50"
                >
                    {loading ? '加载中...' : '刷新'}
                </button>
            </div>

            {/* ── 指标卡片 ── */}
            <div className="grid grid-cols-4 gap-3 mb-6">
                {[
                    { label: '总 Token', value: formatNumber(filteredTotals.total), color: 'text-white', icon: '⚡' },
                    { label: 'Prompt', value: formatNumber(filteredTotals.prompt), color: 'text-blue-400', icon: '📥' },
                    { label: 'Completion', value: formatNumber(filteredTotals.completion), color: 'text-emerald-400', icon: '📤' },
                    { label: '预估花费', value: `$${cost.toFixed(4)}`, color: 'text-amber-400', icon: '💰' },
                ].map((card, i) => (
                    <div
                        key={i}
                        className="bg-zinc-900/50 border border-zinc-800/60 rounded-xl p-4 flex flex-col gap-1"
                    >
                        <div className="flex items-center gap-1.5">
                            <span className="text-sm">{card.icon}</span>
                            <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">{card.label}</span>
                        </div>
                        <span className={`text-xl font-bold font-mono ${card.color} tracking-tight`}>{card.value}</span>
                    </div>
                ))}
            </div>

            {/* ── 图表 ── */}
            <div className="bg-zinc-900/30 border border-zinc-800/40 rounded-xl p-5">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-wider">
                        Token 消耗趋势 {data?.granularity === 'hour' ? '（按小时）' : data?.granularity === 'day' ? '（按天）' : ''}
                    </h3>
                    <span className="text-[10px] text-zinc-600">{activeModels.length} 个模型</span>
                </div>

                {!data || chartData.length === 0 ? (
                    /* Empty State */
                    <div className="flex flex-col items-center justify-center py-16 text-zinc-600">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-30">
                            <path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" />
                        </svg>
                        <p className="text-sm">暂无 Token 消耗数据</p>
                        <p className="text-xs mt-1 text-zinc-700">进行 LLM 对话后，数据将自动记录在此</p>
                    </div>
                ) : (
                    <ResponsiveContainer width="100%" height={360}>
                        <BarChart data={chartData} barGap={1} barCategoryGap="20%">
                            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                            <XAxis
                                dataKey="time"
                                tick={{ fill: '#71717a', fontSize: 10 }}
                                axisLine={{ stroke: '#3f3f46' }}
                                tickLine={false}
                                tickFormatter={(v) => {
                                    // 如果含:，只显示小时; 否则显示月-日
                                    if (v.includes(':')) return v.split(' ')[1] || v;
                                    const parts = v.split('-');
                                    return `${parts[1]}/${parts[2]}`;
                                }}
                            />
                            <YAxis
                                tick={{ fill: '#71717a', fontSize: 10 }}
                                axisLine={false}
                                tickLine={false}
                                tickFormatter={formatNumber}
                                width={50}
                            />
                            <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(99, 102, 241, 0.08)' }} />
                            <Legend
                                wrapperStyle={{ paddingTop: 12, fontSize: 11, color: '#a1a1aa' }}
                                formatter={(value) => <span className="text-zinc-400 text-xs">{value}</span>}
                            />
                            {activeModels.map((m, i) => (
                                <Bar
                                    key={m}
                                    dataKey={m}
                                    stackId="tokens"
                                    fill={PALETTE[i % PALETTE.length]}
                                    radius={i === activeModels.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
                                    maxBarSize={48}
                                />
                            ))}
                        </BarChart>
                    </ResponsiveContainer>
                )}
            </div>

            {/* ── 模型明细 ── */}
            {data?.models?.length > 0 && (
                <div className="mt-6 bg-zinc-900/30 border border-zinc-800/40 rounded-xl p-5">
                    <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-3">模型明细</h3>
                    <div className="space-y-2">
                        {data.models.filter(m => activeModels.includes(m)).map((m, i) => {
                            const modelRecords = data.records.filter(r => r.m === m);
                            const mp = modelRecords.reduce((s, r) => s + r.p, 0);
                            const mc = modelRecords.reduce((s, r) => s + r.c, 0);
                            const modelCost = estimateCost(modelRecords);
                            const pct = filteredTotals.total > 0 ? ((mp + mc) / filteredTotals.total * 100) : 0;
                            return (
                                <div key={m} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-zinc-800/50 transition-colors">
                                    <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: PALETTE[i % PALETTE.length] }} />
                                    <span className="text-xs text-zinc-300 font-medium min-w-[140px]">{m}</span>
                                    <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                                        <div
                                            className="h-full rounded-full transition-all"
                                            style={{ width: `${pct}%`, backgroundColor: PALETTE[i % PALETTE.length] }}
                                        />
                                    </div>
                                    <span className="text-[10px] text-zinc-500 font-mono w-12 text-right">{pct.toFixed(1)}%</span>
                                    <span className="text-[10px] text-zinc-400 font-mono w-16 text-right">{formatNumber(mp + mc)}</span>
                                    <span className="text-[10px] text-amber-500/70 font-mono w-16 text-right">${modelCost.toFixed(4)}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
};

export default TokenDashboard;
