import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Save, Wand2, Download, Upload, RefreshCw, Tag, Sparkles, ArrowRightLeft, Search, Loader2 } from 'lucide-react';

export default function SkillsSettingsPanel({ dialog }) {
    const [skills, setSkills] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [form, setForm] = useState({ name: '', summary: '', detail: '', tags: '' });
    const [loading, setLoading] = useState(false);
    const [aiLoading, setAiLoading] = useState(false);
    const [models, setModels] = useState([]);
    const [selectedModelId, setSelectedModelId] = useState('');
    const [aiPrompt, setAiPrompt] = useState('');
    const [showAiPanel, setShowAiPanel] = useState(null); // 'generate' | 'optimize' | 'convert' | null
    const [convertContent, setConvertContent] = useState('');
    const [testQuery, setTestQuery] = useState('');
    const [testResults, setTestResults] = useState(null);
    const [testLoading, setTestLoading] = useState(false);

    const api = window.electronAPI;

    const loadSkills = useCallback(async () => {
        const res = await api.skillList();
        if (res?.success) setSkills(res.data || []);
    }, []);

    const loadModels = useCallback(async () => {
        const res = await api.modelList();
        if (res?.success) {
            const list = res.data || [];
            setModels(list);
            if (list.length > 0 && !selectedModelId) setSelectedModelId(list[0].id);
        }
    }, []);

    useEffect(() => { loadSkills(); loadModels(); }, []);

    const selected = skills.find(s => s.id === selectedId);

    useEffect(() => {
        if (selected) {
            setForm({
                name: selected.name || '',
                summary: selected.summary || '',
                detail: selected.detail || '',
                tags: (selected.tags || []).join(', '),
            });
        }
    }, [selectedId, selected?.updatedAt]);

    const handleNew = () => {
        setSelectedId(null);
        setForm({ name: '', summary: '', detail: '', tags: '' });
    };

    const handleSave = async () => {
        const tags = form.tags.split(/[,，]/).map(t => t.trim()).filter(Boolean);
        const data = { ...form, tags };
        setLoading(true);
        try {
            if (selectedId) {
                const res = await api.skillUpdate(selectedId, data);
                if (res?.success) {
                    await loadSkills();
                    dialog?.alert('保存成功');
                } else {
                    dialog?.alert(res?.error || '保存失败');
                }
            } else {
                const res = await api.skillCreate(data);
                if (res?.success) {
                    await loadSkills();
                    setSelectedId(res.data.id);
                    dialog?.alert('创建成功');
                } else {
                    dialog?.alert(res?.error || '创建失败');
                }
            }
        } finally {
            setLoading(false);
        }
    };

    const handleDelete = async () => {
        if (!selectedId) return;
        const yes = await dialog?.confirm('确定删除此技能？');
        if (!yes) return;
        const res = await api.skillDelete(selectedId);
        if (res?.success) {
            setSelectedId(null);
            setForm({ name: '', summary: '', detail: '', tags: '' });
            await loadSkills();
        } else {
            dialog?.alert(res?.error || '删除失败');
        }
    };

    const handleExport = async () => {
        if (!selectedId) return;
        const res = await api.skillExport(selectedId);
        if (res?.success) dialog?.alert(`已导出到 ${res.data.path}`);
        else if (res?.error !== '用户取消') dialog?.alert(res?.error || '导出失败');
    };

    const handleImport = async () => {
        // 让用户选择冲突策略
        let strategy = 'rename';
        const overwrite = await dialog?.confirm('导入时如遇同名技能，是否覆盖？\n\n点击「确认」= 覆盖旧版本\n点击「取消」= 重命名导入');
        if (overwrite === null || overwrite === undefined) return; // dialog dismissed
        if (overwrite) {
            strategy = 'overwrite';
        } else {
            const skip = await dialog?.confirm('是否跳过同名技能（不导入）？\n\n点击「确认」= 跳过\n点击「取消」= 重命名后导入');
            if (skip === null || skip === undefined) return;
            strategy = skip ? 'skip' : 'rename';
        }
        const res = await api.skillImport(strategy);
        if (res?.success) {
            await loadSkills();
            const cnt = res.data?.imported?.length || 0;
            const conflicts = res.data?.conflicts?.length || 0;
            const skipped = res.data?.skipped?.length || 0;
            let msg = `导入完成: ${cnt} 个成功`;
            if (conflicts > 0) msg += `, ${conflicts} 个冲突已处理(${strategy})`;
            if (skipped > 0) msg += `, ${skipped} 个已跳过`;
            dialog?.alert(msg);
        } else if (res?.error !== '用户取消') {
            dialog?.alert(res?.error || '导入失败');
        }
    };

    const handleAiGenerate = async () => {
        if (!aiPrompt.trim()) return;
        setAiLoading(true);
        try {
            const res = await api.skillGenerate({ modelId: selectedModelId, description: aiPrompt });
            if (res?.success) {
                setForm({
                    name: res.data.name || '',
                    summary: res.data.summary || '',
                    detail: res.data.detail || '',
                    tags: (res.data.tags || []).join(', '),
                });
                setSelectedId(null);
                setShowAiPanel(null);
                setAiPrompt('');
                dialog?.alert('AI 生成完成，请确认后点击保存');
            } else {
                dialog?.alert(res?.error || 'AI 生成失败');
            }
        } finally {
            setAiLoading(false);
        }
    };

    const handleAiOptimize = async () => {
        if (!selectedId || !aiPrompt.trim()) return;
        setAiLoading(true);
        try {
            const res = await api.skillOptimize({ modelId: selectedModelId, skillId: selectedId, instruction: aiPrompt });
            if (res?.success) {
                setForm({
                    name: res.data.name || '',
                    summary: res.data.summary || '',
                    detail: res.data.detail || '',
                    tags: (res.data.tags || []).join(', '),
                });
                setShowAiPanel(null);
                setAiPrompt('');
                dialog?.alert('AI 优化完成，请确认后点击保存');
            } else {
                dialog?.alert(res?.error || 'AI 优化失败');
            }
        } finally {
            setAiLoading(false);
        }
    };

    const handleAiConvert = async () => {
        if (!convertContent.trim()) return;
        setAiLoading(true);
        try {
            const res = await api.skillConvert({ modelId: selectedModelId, content: convertContent });
            if (res?.success) {
                setForm({
                    name: res.data.name || '',
                    summary: res.data.summary || '',
                    detail: res.data.detail || '',
                    tags: (res.data.tags || []).join(', '),
                });
                setSelectedId(null);
                setShowAiPanel(null);
                setConvertContent('');
                dialog?.alert('转换完成，请确认后点击保存');
            } else {
                dialog?.alert(res?.error || '转换失败');
            }
        } finally {
            setAiLoading(false);
        }
    };

    const sourceLabel = (s) => {
        const map = { manual: '手动', 'ai-generated': 'AI生成', imported: '导入', converted: '转换' };
        return map[s] || s || '手动';
    };

    return (
        <>
            {/* 左侧技能列表 */}
            <div className="w-56 border-r border-zinc-900 flex flex-col bg-[#0c0c0c]">
                <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-900">
                    <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">技能列表</span>
                    <div className="flex gap-1">
                        <button onClick={handleImport} className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-200 transition-colors" title="导入">
                            <Upload size={13} />
                        </button>
                        <button onClick={handleNew} className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-200 transition-colors" title="新建">
                            <Plus size={14} />
                        </button>
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                    {skills.length === 0 ? (
                        <div className="p-4 text-[11px] text-zinc-600 text-center">暂无技能</div>
                    ) : skills.map(s => (
                        <button
                            key={s.id}
                            onClick={() => setSelectedId(s.id)}
                            className={`w-full text-left px-3 py-2 border-b border-zinc-900/60 transition-all ${selectedId === s.id ? 'bg-zinc-800/60 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900/40 hover:text-zinc-200'}`}
                        >
                            <div className="text-[11px] font-semibold truncate">{s.name}</div>
                            <div className="text-[9px] text-zinc-600 mt-0.5 truncate">{s.summary || '无简述'}</div>
                            <div className="flex items-center gap-1 mt-1">
                                <span className="text-[8px] px-1.5 py-0.5 bg-zinc-800 text-zinc-500 rounded">{sourceLabel(s.source)}</span>
                            </div>
                        </button>
                    ))}
                </div>
            </div>

            {/* 右侧编辑区 */}
            <div className="flex-1 overflow-y-auto p-6">
                <div className="max-w-2xl mx-auto space-y-5">
                    <div className="flex items-center justify-between">
                        <h2 className="text-sm font-bold text-zinc-200">
                            {selectedId ? '编辑技能' : '新建技能'}
                        </h2>
                        <div className="flex items-center gap-2">
                            {/* 模型选择器 — 始终可见 */}
                            <select
                                value={selectedModelId}
                                onChange={e => setSelectedModelId(e.target.value)}
                                className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-[10px] text-zinc-300 outline-none max-w-[140px] truncate"
                                title="选择 AI 模型"
                            >
                                {models.length === 0 && <option value="">未配置模型</option>}
                                {models.map(m => (
                                    <option key={m.id} value={m.id}>{m.displayName || m.modelName}</option>
                                ))}
                            </select>
                            <button onClick={() => setShowAiPanel('generate')} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-900/30 border border-emerald-800/40 text-emerald-400 text-[10px] font-semibold hover:bg-emerald-900/50 transition-all">
                                <Wand2 size={12} /> AI 生成
                            </button>
                            {selectedId && (
                                <button onClick={() => setShowAiPanel('optimize')} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-900/30 border border-blue-800/40 text-blue-400 text-[10px] font-semibold hover:bg-blue-900/50 transition-all">
                                    <Sparkles size={12} /> AI 优化
                                </button>
                            )}
                            <button onClick={() => setShowAiPanel('convert')} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-900/30 border border-purple-800/40 text-purple-400 text-[10px] font-semibold hover:bg-purple-900/50 transition-all">
                                <ArrowRightLeft size={12} /> 转换
                            </button>
                        </div>
                    </div>

                    {/* AI 操作面板 */}
                    {showAiPanel && (
                        <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4 space-y-3">
                            <div className="flex items-center justify-between">
                                <span className="text-[11px] font-semibold text-zinc-300">
                                    {showAiPanel === 'generate' ? '🤖 AI 生成技能' : showAiPanel === 'optimize' ? '✨ AI 优化技能' : '🔄 转换外部技能'}
                                </span>
                                <button onClick={() => { setShowAiPanel(null); setAiPrompt(''); setConvertContent(''); }} className="text-zinc-600 hover:text-zinc-300 text-[10px]">关闭</button>
                            </div>
                            <div>
                                <label className="text-[10px] text-zinc-500 mb-1 block">选择模型</label>
                                <select
                                    value={selectedModelId}
                                    onChange={e => setSelectedModelId(e.target.value)}
                                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-[11px] text-zinc-200 outline-none"
                                >
                                    {models.map(m => (
                                        <option key={m.id} value={m.id}>{m.displayName || m.modelName}</option>
                                    ))}
                                </select>
                            </div>
                            {showAiPanel === 'convert' ? (
                                <div>
                                    <label className="text-[10px] text-zinc-500 mb-1 block">粘贴外部 SKILL 内容（SKILL.md 等）</label>
                                    <textarea
                                        value={convertContent}
                                        onChange={e => setConvertContent(e.target.value)}
                                        className="w-full h-32 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-[11px] text-zinc-200 outline-none resize-none font-mono"
                                        placeholder="粘贴其他 IDE 的 SKILL 内容..."
                                    />
                                </div>
                            ) : (
                                <div>
                                    <label className="text-[10px] text-zinc-500 mb-1 block">
                                        {showAiPanel === 'generate' ? '描述你需要的技能' : '描述优化方向'}
                                    </label>
                                    <textarea
                                        value={aiPrompt}
                                        onChange={e => setAiPrompt(e.target.value)}
                                        className="w-full h-20 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-[11px] text-zinc-200 outline-none resize-none"
                                        placeholder={showAiPanel === 'generate' ? '例如：生成一个专注于React性能优化的技能...' : '例如：增加更多边界情况处理...'}
                                    />
                                </div>
                            )}
                            <button
                                onClick={showAiPanel === 'generate' ? handleAiGenerate : showAiPanel === 'optimize' ? handleAiOptimize : handleAiConvert}
                                disabled={aiLoading}
                                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-700/80 text-white text-[11px] font-semibold hover:bg-emerald-600/80 transition-all disabled:opacity-50"
                            >
                                {aiLoading ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                                {aiLoading ? '处理中...' : '执行'}
                            </button>
                        </div>
                    )}

                    {/* 表单 */}
                    <div className="bg-zinc-900/40 border border-zinc-800/60 rounded-xl p-5 space-y-4">
                        <div>
                            <label className="text-[10px] text-zinc-500 mb-1 block">技能名称 <span className="text-zinc-700">（必须包含中文）</span></label>
                            <input
                                value={form.name}
                                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-[12px] text-zinc-200 outline-none focus:border-zinc-500 transition-colors"
                                placeholder="例如：React性能优化专家"
                            />
                        </div>
                        <div>
                            <label className="text-[10px] text-zinc-500 mb-1 block">简述</label>
                            <input
                                value={form.summary}
                                onChange={e => setForm(f => ({ ...f, summary: e.target.value }))}
                                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-[12px] text-zinc-200 outline-none focus:border-zinc-500 transition-colors"
                                placeholder="一两句话描述技能的核心功能"
                            />
                        </div>
                        <div>
                            <label className="text-[10px] text-zinc-500 mb-1 block">详细内容 <span className="text-zinc-700">（支持 Markdown）</span></label>
                            <textarea
                                value={form.detail}
                                onChange={e => setForm(f => ({ ...f, detail: e.target.value }))}
                                className="w-full h-48 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-[11px] text-zinc-200 outline-none resize-y font-mono focus:border-zinc-500 transition-colors"
                                placeholder="技能的详细指导内容..."
                            />
                        </div>
                        <div>
                            <label className="text-[10px] text-zinc-500 mb-1 block">标签 <span className="text-zinc-700">（逗号分隔）</span></label>
                            <input
                                value={form.tags}
                                onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
                                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-[12px] text-zinc-200 outline-none focus:border-zinc-500 transition-colors"
                                placeholder="前端, React, 性能优化"
                            />
                        </div>
                    </div>

                    {/* 测试匹配面板 */}
                    <div className="bg-zinc-900/40 border border-zinc-800/60 rounded-xl p-4 space-y-3">
                        <div className="flex items-center gap-2">
                            <Search size={12} className="text-zinc-500" />
                            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">测试匹配</span>
                        </div>
                        <div className="flex gap-2">
                            <input
                                value={testQuery}
                                onChange={e => setTestQuery(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter' && testQuery.trim()) {
                                        setTestLoading(true);
                                        api.skillMatch(testQuery).then(res => {
                                            setTestResults(res);
                                            setTestLoading(false);
                                        }).catch(() => setTestLoading(false));
                                    }
                                }}
                                className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-[11px] text-zinc-200 outline-none focus:border-zinc-500 transition-colors"
                                placeholder="输入用户消息测试匹配效果（如：帮我优化React性能）"
                            />
                            <button
                                onClick={() => {
                                    if (!testQuery.trim()) return;
                                    setTestLoading(true);
                                    api.skillMatch(testQuery).then(res => {
                                        setTestResults(res);
                                        setTestLoading(false);
                                    }).catch(() => setTestLoading(false));
                                }}
                                disabled={testLoading || !testQuery.trim()}
                                className="px-3 py-1.5 rounded-lg bg-indigo-900/40 border border-indigo-800/40 text-indigo-400 text-[10px] font-semibold hover:bg-indigo-900/60 transition-all disabled:opacity-50"
                            >
                                {testLoading ? <Loader2 size={11} className="animate-spin" /> : '匹配'}
                            </button>
                        </div>
                        {testResults && (
                            <div className="text-[10px] space-y-1">
                                {testResults.success ? (
                                    testResults.data?.length > 0 ? (
                                        testResults.data.map((s, i) => (
                                            <div key={i} className="flex items-center gap-2 px-2 py-1 bg-emerald-950/30 border border-emerald-900/30 rounded">
                                                <span className="text-emerald-400 font-semibold">{s.name}</span>
                                                <span className="text-zinc-500">score: {s.score?.toFixed(3)}</span>
                                                <span className="text-zinc-600 truncate">{s.summary}</span>
                                            </div>
                                        ))
                                    ) : (
                                        <div className="text-zinc-600 px-2 py-1">无匹配结果（尝试在技能名称或标签中使用查询中的关键词）</div>
                                    )
                                ) : (
                                    <div className="text-red-400 px-2 py-1">匹配错误：{testResults.error}</div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* 操作按钮 */}
                    <div className="flex items-center gap-3">
                        <button
                            onClick={handleSave}
                            disabled={loading || !form.name.trim()}
                            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-700/80 text-white text-[11px] font-semibold hover:bg-emerald-600/80 transition-all disabled:opacity-50"
                        >
                            <Save size={12} /> {loading ? '保存中...' : '保存'}
                        </button>
                        {selectedId && (
                            <>
                                <button
                                    onClick={handleExport}
                                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300 text-[11px] font-semibold hover:bg-zinc-700 transition-all"
                                >
                                    <Download size={12} /> 导出
                                </button>
                                <button
                                    onClick={handleDelete}
                                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-900/30 border border-red-800/40 text-red-400 text-[11px] font-semibold hover:bg-red-900/50 transition-all"
                                >
                                    <Trash2 size={12} /> 删除
                                </button>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </>
    );
}
