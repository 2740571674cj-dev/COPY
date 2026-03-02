import React, { useState, useEffect, useCallback } from 'react';
import { Check, X, Play, RefreshCw, AlertTriangle, Loader2, ChevronDown, ChevronUp, Eye, Square } from 'lucide-react';

const TYPE_BADGE = {
    prompt: { label: '提示词', cls: 'bg-emerald-900/40 text-emerald-400 border-emerald-800/40' },
    'tool-chain': { label: '工具链', cls: 'bg-blue-900/40 text-blue-400 border-blue-800/40' },
    'ui-ux': { label: 'UI/UX', cls: 'bg-purple-900/40 text-purple-400 border-purple-800/40' },
};

const STATUS_BADGE = {
    pending: { label: '待审', cls: 'bg-yellow-900/40 text-yellow-400' },
    approved: { label: '已审批', cls: 'bg-blue-900/40 text-blue-400' },
    implementing: { label: '应用中', cls: 'bg-cyan-900/40 text-cyan-400' },
    implemented: { label: '已应用', cls: 'bg-emerald-900/40 text-emerald-400' },
    failed: { label: '失败', cls: 'bg-red-900/40 text-red-400' },
    rejected: { label: '已拒绝', cls: 'bg-zinc-800/60 text-zinc-500' },
};

const PRIORITY_ICON = { high: '🔴', medium: '🟡', low: '🟢' };

// #8: 自动应用能力说明
const APPLY_CAPABILITY = {
    prompt: { canAuto: true, label: '✅ 可自动应用', desc: '将在目标文件末尾追加建议内容' },
    'tool-chain': { canAuto: false, label: '❌ 需手动实施', desc: '工具链优化需通过 Agent 手动执行' },
    'ui-ux': { canAuto: false, label: '❌ 需手动实施', desc: 'UI/UX 修改需通过 Agent 手动执行' },
};

export default function SuggestionsSettingsPanel({ dialog }) {
    const [suggestions, setSuggestions] = useState([]);
    const [stats, setStats] = useState({});
    const [filter, setFilter] = useState('all');
    const [expandedId, setExpandedId] = useState(null);
    const [loading, setLoading] = useState(false);
    const [applyingId, setApplyingId] = useState(null);

    const api = window.electronAPI;

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await api.suggestionList(filter === 'all' ? null : filter);
            if (res?.success) {
                setSuggestions(res.data || []);
                setStats(res.stats || {});
            }
        } finally {
            setLoading(false);
        }
    }, [filter]);

    useEffect(() => { load(); }, [load]);

    const handleApprove = async (id) => {
        const res = await api.suggestionApprove(id);
        if (res?.success) {
            dialog?.alert('已审批');
            await load();
        } else {
            dialog?.alert(res?.error || '操作失败');
        }
    };

    const handleReject = async (id) => {
        const yes = await dialog?.confirm('确定拒绝此建议？');
        if (!yes) return;
        const res = await api.suggestionReject(id);
        if (res?.success) await load();
        else dialog?.alert(res?.error || '操作失败');
    };

    const handleApply = async (id) => {
        // 先展示预览
        const previewRes = await api.suggestionPreview(id);
        const previewInfo = previewRes?.success && previewRes.data?.files?.length > 0
            ? `\n\n预计修改 ${previewRes.data.files.length} 个文件：\n${previewRes.data.files.map(f => `  ${f.file}${f.exists ? ` (+${f.appendLines || 0}行)` : ' (不存在)'}`).join('\n')}`
            : '';
        const yes = await dialog?.confirm(`确定应用此建议？\n\n将自动备份 → 修改 → 构建验证\n失败会自动回滚${previewInfo}`);
        if (!yes) return;
        setApplyingId(id);
        try {
            const res = await api.suggestionApply(id);
            if (res?.success) {
                dialog?.alert('✅ 建议已成功应用！');
            } else if (res?.allowed === false) {
                dialog?.alert(`⏳ 频率限制：每小时最多 3 条，请稍后再试`);
            } else {
                const retryHint = res?.retryable ? ' (可重试)' : '';
                dialog?.alert(`❌ 应用失败: ${res?.error || '未知错误'}${retryHint}`);
            }
            await load();
        } finally {
            setApplyingId(null);
        }
    };

    const handleCancel = async (id) => {
        const res = await api.suggestionCancel(id);
        if (res?.success) {
            dialog?.alert('✅ 已发送取消请求');
        } else {
            dialog?.alert(res?.error || '取消失败');
        }
    };

    const filters = [
        { id: 'all', label: '全部' },
        { id: 'pending', label: `待审 (${stats.pending || 0})` },
        { id: 'approved', label: `已审批 (${stats.approved || 0})` },
        { id: 'implemented', label: `已应用 (${stats.implemented || 0})` },
        { id: 'failed', label: `失败 (${stats.failed || 0})` },
        { id: 'rejected', label: `已拒绝 (${stats.rejected || 0})` },
    ];

    return (
        <div className="flex-1 overflow-y-auto p-6">
            <div className="max-w-3xl mx-auto space-y-5">
                {/* 标题 + 统计 */}
                <div className="flex items-center justify-between">
                    <h2 className="text-sm font-bold text-zinc-200">🔄 IDE 自我迭代</h2>
                    <button
                        onClick={load}
                        disabled={loading}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300 text-[10px] font-semibold hover:bg-zinc-700 transition-all"
                    >
                        <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> 刷新
                    </button>
                </div>

                {/* 统计卡片 */}
                <div className="grid grid-cols-4 gap-3">
                    {[
                        { label: '待审', count: stats.pending || 0, color: 'text-yellow-400' },
                        { label: '已应用', count: stats.implemented || 0, color: 'text-emerald-400' },
                        { label: '失败', count: stats.failed || 0, color: 'text-red-400' },
                        { label: '总计', count: stats.total || 0, color: 'text-zinc-300' },
                    ].map(s => (
                        <div key={s.label} className="bg-zinc-900/50 border border-zinc-800/60 rounded-xl p-3 text-center">
                            <div className={`text-lg font-bold ${s.color}`}>{s.count}</div>
                            <div className="text-[9px] text-zinc-600 mt-0.5">{s.label}</div>
                        </div>
                    ))}
                </div>

                {/* 过滤按钮 */}
                <div className="flex gap-1.5 flex-wrap">
                    {filters.map(f => (
                        <button
                            key={f.id}
                            onClick={() => setFilter(f.id)}
                            className={`px-3 py-1 rounded-lg text-[10px] font-semibold transition-all border ${filter === f.id
                                ? 'bg-zinc-700 text-zinc-100 border-zinc-600'
                                : 'bg-zinc-900/40 text-zinc-500 border-zinc-800 hover:bg-zinc-800'
                                }`}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>

                {/* 建议列表 */}
                <div className="space-y-2">
                    {suggestions.length === 0 ? (
                        <div className="text-center py-12 text-zinc-600 text-[11px]">
                            {filter === 'all' ? '暂无建议 — Agent 执行后会自动生成' : `无 ${filter} 状态的建议`}
                        </div>
                    ) : suggestions.map(s => {
                        const typeBadge = TYPE_BADGE[s.type] || TYPE_BADGE.prompt;
                        const statusBadge = STATUS_BADGE[s.status] || STATUS_BADGE.pending;
                        const isExpanded = expandedId === s.id;

                        return (
                            <div
                                key={s.id}
                                className="bg-zinc-900/40 border border-zinc-800/60 rounded-xl overflow-hidden"
                            >
                                {/* 头部 */}
                                <button
                                    onClick={() => setExpandedId(isExpanded ? null : s.id)}
                                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800/30 transition-colors"
                                >
                                    <span className="text-[12px]">{PRIORITY_ICON[s.priority] || '🟡'}</span>
                                    <span className={`text-[9px] px-1.5 py-0.5 rounded border ${typeBadge.cls}`}>{typeBadge.label}</span>
                                    <span className="flex-1 text-[11px] text-zinc-200 truncate font-medium">{s.title}</span>
                                    {s.score != null && (
                                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${s.score >= 70 ? 'bg-emerald-900/30 text-emerald-400' :
                                            s.score >= 40 ? 'bg-yellow-900/30 text-yellow-400' :
                                                'bg-zinc-800 text-zinc-500'
                                            }`}>{s.score}分</span>
                                    )}
                                    <span className={`text-[9px] px-1.5 py-0.5 rounded ${statusBadge.cls}`}>{statusBadge.label}</span>
                                    <span className="text-[9px] text-zinc-600">{new Date(s.createdAt).toLocaleDateString()}</span>
                                    {isExpanded ? <ChevronUp size={12} className="text-zinc-500" /> : <ChevronDown size={12} className="text-zinc-500" />}
                                </button>

                                {/* 展开详情 */}
                                {isExpanded && (
                                    <div className="px-4 pb-4 space-y-3 border-t border-zinc-800/40">
                                        <div className="mt-3">
                                            <div className="text-[9px] text-zinc-600 mb-1">描述</div>
                                            <div className="text-[11px] text-zinc-300 leading-relaxed">{s.description}</div>
                                        </div>
                                        {s.targetFiles?.length > 0 && (
                                            <div>
                                                <div className="text-[9px] text-zinc-600 mb-1">目标文件</div>
                                                <div className="flex flex-wrap gap-1">
                                                    {s.targetFiles.map(f => (
                                                        <span key={f} className="text-[9px] px-1.5 py-0.5 bg-zinc-800 text-zinc-400 rounded font-mono">{f}</span>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                        <div className="flex items-center gap-1 text-[9px]">
                                            <span className="text-zinc-600">自动级别:</span>
                                            <span className={`px-1.5 py-0.5 rounded ${s.autoLevel === 'auto' ? 'bg-emerald-900/30 text-emerald-400' :
                                                s.autoLevel === 'semi' ? 'bg-yellow-900/30 text-yellow-400' :
                                                    'bg-red-900/30 text-red-400'
                                                }`}>{s.autoLevel}</span>
                                        </div>
                                        {/* #8: 应用能力指示 + #5: diff 预览 */}
                                        {(() => {
                                            const cap = APPLY_CAPABILITY[s.type] || APPLY_CAPABILITY['tool-chain'];
                                            return (
                                                <div className={`flex items-start gap-2 p-2 rounded-lg border text-[10px] ${cap.canAuto
                                                    ? 'bg-emerald-900/10 border-emerald-900/30 text-emerald-300'
                                                    : 'bg-yellow-900/10 border-yellow-900/30 text-yellow-300'
                                                    }`}>
                                                    <span>{cap.label}</span>
                                                    <span className="text-zinc-500">—</span>
                                                    <span className="text-zinc-400">{cap.desc}</span>
                                                    {cap.canAuto && s.targetFiles?.length > 0 && (
                                                        <span className="text-zinc-500 ml-auto">
                                                            预计修改 {s.targetFiles.length} 个文件（文件末尾追加注释）
                                                        </span>
                                                    )}
                                                </div>
                                            );
                                        })()}
                                        {s.failReason && (
                                            <div className="flex items-start gap-2 p-2 bg-red-900/10 border border-red-900/30 rounded-lg">
                                                <AlertTriangle size={12} className="text-red-400 mt-0.5 shrink-0" />
                                                <span className="text-[10px] text-red-300">{s.failReason}</span>
                                            </div>
                                        )}

                                        {/* 操作按钮 */}
                                        {(s.status === 'pending' || s.status === 'approved') && (
                                            <div className="flex items-center gap-2 pt-2">
                                                {s.status === 'pending' && (
                                                    <button
                                                        onClick={() => handleApprove(s.id)}
                                                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-900/30 border border-emerald-800/40 text-emerald-400 text-[10px] font-semibold hover:bg-emerald-900/50 transition-all"
                                                    >
                                                        <Check size={11} /> 审批
                                                    </button>
                                                )}
                                                {s.status === 'approved' && (
                                                    <>
                                                        <button
                                                            onClick={() => handleApply(s.id)}
                                                            disabled={applyingId === s.id}
                                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-900/30 border border-blue-800/40 text-blue-400 text-[10px] font-semibold hover:bg-blue-900/50 transition-all disabled:opacity-50"
                                                        >
                                                            {applyingId === s.id ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                                                            {applyingId === s.id ? '应用中...' : '立即应用'}
                                                        </button>
                                                        {applyingId === s.id && (
                                                            <button
                                                                onClick={() => handleCancel(s.id)}
                                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-900/30 border border-red-800/40 text-red-400 text-[10px] font-semibold hover:bg-red-900/50 transition-all"
                                                            >
                                                                <Square size={11} /> 取消
                                                            </button>
                                                        )}
                                                    </>
                                                )}
                                                {s.status === 'pending' && (
                                                    <button
                                                        onClick={() => handleReject(s.id)}
                                                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-400 text-[10px] font-semibold hover:bg-zinc-700 transition-all"
                                                    >
                                                        <X size={11} /> 拒绝
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
