import React, { useState, useEffect, useCallback } from 'react';
import { History, Download, RotateCcw, Trash2, Loader2, Shield, FileText } from 'lucide-react';

export default function VersionSettingsPanel({ dialog }) {
    const [versions, setVersions] = useState([]);
    const [loading, setLoading] = useState(false);
    const [actionId, setActionId] = useState(null);

    const api = window.electronAPI;

    const loadVersions = useCallback(async () => {
        const res = await api.versionList();
        if (res?.success) setVersions(res.data || []);
    }, []);

    useEffect(() => { loadVersions(); }, []);

    const handleBackup = async () => {
        setLoading(true);
        try {
            const res = await api.versionBackup({ label: 'manual-backup' });
            if (res?.success) {
                await loadVersions();
                dialog?.alert(`备份成功: ${res.data.fileCount} 个文件`);
            } else {
                dialog?.alert(res?.error || '备份失败');
            }
        } finally {
            setLoading(false);
        }
    };

    const handleRollback = async (id) => {
        const yes = await dialog?.confirm('确定回退到此版本？回退前会自动创建安全备份。');
        if (!yes) return;
        setActionId(id);
        try {
            const res = await api.versionRollback(id);
            if (res?.success) {
                await loadVersions();
                dialog?.alert(`回退成功: 恢复了 ${res.data.restored} 个文件\n安全备份: ${res.data.safetyBackup}`);
            } else {
                dialog?.alert(res?.error || '回退失败');
            }
        } finally {
            setActionId(null);
        }
    };

    const handleDelete = async (id) => {
        const yes = await dialog?.confirm('确定删除此版本快照？此操作不可撤销。');
        if (!yes) return;
        const res = await api.versionDelete(id);
        if (res?.success) {
            await loadVersions();
        } else {
            dialog?.alert(res?.error || '删除失败');
        }
    };

    const formatTime = (ts) => {
        if (!ts) return '-';
        try {
            const d = new Date(ts);
            return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        } catch (_) { return ts; }
    };

    const labelColor = (label) => {
        if (label === 'rollback-safety-net') return 'text-amber-400 bg-amber-900/30 border-amber-800/40';
        if (label?.includes('auto')) return 'text-blue-400 bg-blue-900/30 border-blue-800/40';
        return 'text-zinc-400 bg-zinc-800 border-zinc-700';
    };

    return (
        <div className="flex-1 overflow-y-auto p-6">
            <div className="max-w-2xl mx-auto space-y-5">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <History size={16} className="text-zinc-400" />
                        <h2 className="text-sm font-bold text-zinc-200">版本管理</h2>
                    </div>
                    <button
                        onClick={handleBackup}
                        disabled={loading}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-700/80 text-white text-[11px] font-semibold hover:bg-emerald-600/80 transition-all disabled:opacity-50"
                    >
                        {loading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                        {loading ? '备份中...' : '创建快照'}
                    </button>
                </div>

                <div className="bg-zinc-900/40 border border-zinc-800/60 rounded-xl p-4">
                    <p className="text-[10px] text-zinc-500 leading-relaxed">
                        <Shield size={10} className="inline mr-1" />
                        快照将备份项目所有源代码文件（排除 node_modules、dist、.git 等），每个文件均计算 SHA256 校验和。回退前会自动创建安全备份。
                    </p>
                </div>

                {versions.length === 0 ? (
                    <div className="text-center py-12">
                        <FileText size={28} className="mx-auto text-zinc-700 mb-3" />
                        <p className="text-[11px] text-zinc-600">暂无版本快照</p>
                        <p className="text-[10px] text-zinc-700 mt-1">点击「创建快照」备份当前源码</p>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {versions.map(v => (
                            <div key={v.id} className="bg-zinc-900/50 border border-zinc-800/60 rounded-lg p-3 flex items-center justify-between hover:bg-zinc-900/70 transition-all group">
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <span className="text-[11px] text-zinc-200 font-semibold truncate">{formatTime(v.timestamp)}</span>
                                        <span className={`text-[8px] px-1.5 py-0.5 rounded border ${labelColor(v.label)}`}>
                                            {v.label || 'manual'}
                                        </span>
                                    </div>
                                    <div className="text-[9px] text-zinc-600 mt-0.5">
                                        {v.fileCount} 个文件 · ID: {v.id.slice(0, 20)}...
                                    </div>
                                </div>
                                <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button
                                        onClick={() => handleRollback(v.id)}
                                        disabled={actionId === v.id}
                                        className="flex items-center gap-1 px-2.5 py-1 rounded bg-blue-900/30 border border-blue-800/40 text-blue-400 text-[9px] font-semibold hover:bg-blue-900/50 transition-all disabled:opacity-50"
                                        title="回退到此版本"
                                    >
                                        {actionId === v.id ? <Loader2 size={10} className="animate-spin" /> : <RotateCcw size={10} />}
                                        回退
                                    </button>
                                    <button
                                        onClick={() => handleDelete(v.id)}
                                        className="flex items-center gap-1 px-2.5 py-1 rounded bg-red-900/20 border border-red-800/30 text-red-500 text-[9px] font-semibold hover:bg-red-900/40 transition-all"
                                        title="删除此快照"
                                    >
                                        <Trash2 size={10} /> 删除
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
