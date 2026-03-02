import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Plus, Trash2, Save, ChevronDown, ChevronRight,
  Loader2, Sparkles, ArrowUp, Edit3, Check, X
} from 'lucide-react';
import CustomSelect from './CustomSelect';

/* ================================================================
 * StepItem — 递归步骤条目
 * ================================================================ */
function StepItem({ step, index, onUpdate, onDelete, onAddSub, depth = 0 }) {
  const [expanded, setExpanded] = useState(true);
  const hasSubs = step.subSteps && step.subSteps.length > 0;

  const depthColors = ['border-blue-500/20', 'border-purple-500/20', 'border-emerald-500/20', 'border-amber-500/20'];
  const depthBorder = depthColors[depth % depthColors.length];

  return (
    <div className={depth > 0 ? `ml-5 border-l ${depthBorder} pl-2.5` : ''}>
      <div className="group flex items-center gap-1.5 py-1 px-1.5 rounded-md hover:bg-zinc-800/40 transition-colors">
        <span className="text-zinc-600 text-[10px] font-mono w-4 shrink-0 text-right select-none">
          {index + 1}
        </span>

        {hasSubs ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-zinc-500 hover:text-zinc-300 transition-colors p-0.5"
          >
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        ) : (
          <div className="w-[15px] shrink-0 flex items-center justify-center">
            <div className="w-1 h-1 rounded-full bg-zinc-700" />
          </div>
        )}

        <input
          className="flex-1 bg-transparent text-zinc-200 text-[11px] outline-none placeholder-zinc-700 leading-relaxed"
          value={step.title}
          onChange={e => onUpdate({ ...step, title: e.target.value })}
          placeholder="描述这个步骤..."
        />

        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity shrink-0">
          <button onClick={() => onAddSub()} className="p-0.5 text-zinc-600 hover:text-blue-400 transition-colors" title="添加子步骤">
            <Plus size={11} />
          </button>
          <button onClick={onDelete} className="p-0.5 text-zinc-600 hover:text-red-400 transition-colors" title="删除">
            <Trash2 size={11} />
          </button>
        </div>
      </div>

      {hasSubs && expanded && (
        <div className="mt-0.5">
          {step.subSteps.map((sub, si) => (
            <StepItem
              key={sub.id || si}
              step={sub}
              index={si}
              depth={depth + 1}
              onUpdate={(updated) => {
                const newSubs = [...step.subSteps];
                newSubs[si] = updated;
                onUpdate({ ...step, subSteps: newSubs });
              }}
              onDelete={() => {
                onUpdate({ ...step, subSteps: step.subSteps.filter((_, i) => i !== si) });
              }}
              onAddSub={() => {
                const newSubs = [...(sub.subSteps || []), { id: crypto.randomUUID(), title: '', subSteps: [] }];
                const updatedSub = { ...sub, subSteps: newSubs };
                const newParentSubs = [...step.subSteps];
                newParentSubs[si] = updatedSub;
                onUpdate({ ...step, subSteps: newParentSubs });
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ================================================================
 * InlineRenameInput — 内联重命名输入
 * ================================================================ */
function InlineRenameInput({ value, onSave, onCancel }) {
  const [text, setText] = useState(value);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  const commit = () => { if (text.trim()) onSave(text.trim()); else onCancel(); };
  return (
    <input
      ref={inputRef}
      className="w-full bg-zinc-900 text-zinc-100 text-[11px] font-medium px-2 py-0.5 rounded outline-none border border-blue-500/40"
      value={text}
      onChange={e => setText(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') onCancel(); }}
      onBlur={commit}
    />
  );
}

/* ================================================================
 * WorkflowPanel — 主面板
 * ================================================================ */
export default function WorkflowPanel({ models = [], onDirtyChange }) {
  const [workflows, setWorkflows] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [aiInput, setAiInput] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const detailRef = useRef(null);
  const dirtyRef = useRef(false);

  useEffect(() => { dirtyRef.current = dirty; onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { detailRef.current = detail; }, [detail]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (dirtyRef.current && detailRef.current) {
        window.electronAPI?.workflowUpdate(detailRef.current.id, {
          name: detailRef.current.name,
          description: detailRef.current.description,
        });
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  useEffect(() => { loadList(); }, []);

  const loadList = async () => {
    const list = await window.electronAPI.workflowList();
    setWorkflows(list);
  };

  const loadDetail = async (id) => {
    const wf = await window.electronAPI.workflowGet(id);
    setDetail(wf);
    setSelectedId(id);
    setDirty(false);
    const savedModelId = wf?.versions?.find(v => v.id === wf.activeVersionId)?.modelId;
    if (savedModelId) setAiModel(savedModelId);
  };

  const handleCreate = async () => {
    const wf = await window.electronAPI.workflowCreate({
      name: '新工作流',
      description: '',
      steps: [{ id: crypto.randomUUID(), title: '', subSteps: [] }],
    });
    await loadList();
    loadDetail(wf.id);
  };

  const handleDelete = async (id) => {
    await window.electronAPI.workflowDelete(id);
    if (selectedId === id) { setDetail(null); setSelectedId(null); }
    setConfirmDeleteId(null);
    await loadList();
  };

  const handleRenameFromList = async (id, newName) => {
    await window.electronAPI.workflowUpdate(id, { name: newName });
    setRenamingId(null);
    await loadList();
    if (detail && detail.id === id) {
      setDetail({ ...detail, name: newName });
    }
  };

  // 保存 = 更新基本信息 + 更新当前版本步骤（不创建新版本）
  const handleSave = useCallback(async () => {
    if (!detail) return;
    setSaving(true);
    try {
      await window.electronAPI.workflowUpdate(detail.id, {
        name: detail.name,
        description: detail.description,
      });
      const activeVer = detail.versions?.find(v => v.id === detail.activeVersionId);
      if (activeVer) {
        await window.electronAPI.workflowUpdateActiveVersion(detail.id, {
          steps: activeVer.steps || [],
          modelId: aiModel || undefined,
        });
      }
      setDirty(false);
      await loadList();
    } catch (e) {
      console.error('Save workflow error:', e);
    }
    setSaving(false);
  }, [detail, aiModel]);

  const handleSaveAsNewVersion = async () => {
    if (!detail) return;
    setSaving(true);
    const activeVer = detail.versions?.find(v => v.id === detail.activeVersionId);
    await window.electronAPI.workflowSaveVersion(detail.id, {
      steps: activeVer?.steps || [],
      label: `v${detail.versions.length + 1}`,
      modelId: aiModel || undefined,
    });
    await loadDetail(detail.id);
    setSaving(false);
  };

  const handleDeleteVersion = async (verId) => {
    if (!detail || detail.versions.length <= 1) return;
    await window.electronAPI.workflowDeleteVersion(detail.id, verId);
    await loadDetail(detail.id);
  };

  const handleSelectVersion = async (verId) => {
    await window.electronAPI.workflowUpdate(detail.id, { activeVersionId: verId });
    await loadDetail(detail.id);
  };

  // AI 生成工作流
  const handleGenerate = async () => {
    if (!aiInput.trim() || !aiModel) return;
    setGenerating(true);
    try {
      const sysPrompt = `你是一个工作流设计专家。用户会用大白话描述一个工作流需求，你需要生成一个结构化的工作流。

必须返回以下 JSON 格式（不要返回其他内容，不要使用 markdown 代码块包裹）：
{
  "name": "工作流名称（简短）",
  "description": "适用场景描述（一两句话，说明什么情况下该引用这个工作流）",
  "steps": [
    {
      "title": "步骤描述",
      "subSteps": [
        { "title": "子步骤描述", "subSteps": [] }
      ]
    }
  ]
}

要求：
- 全部使用简体中文
- 步骤要具体、可执行
- 适当使用子步骤来细化复杂步骤
- 通常 3-8 个主步骤
- 只输出 JSON，不要有任何其他文字`;

      const result = await window.electronAPI.llmChat({
        modelId: aiModel,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: aiInput }
        ],
      });

      // llmChat 可能返回 { success, data } 或直接返回 { content }
      let text = '';
      if (result?.success && result?.data?.content) {
        text = result.data.content;
      } else if (result?.content) {
        text = result.content;
      } else if (typeof result === 'string') {
        text = result;
      }

      if (!text) {
        console.error('AI generate: empty response', result);
        setGenerating(false);
        return;
      }

      // 提取 JSON（可能被 markdown 代码块包裹）
      let jsonStr = '';
      const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      } else {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) jsonStr = jsonMatch[0];
      }

      if (!jsonStr) {
        console.error('AI generate: no JSON found in response', text);
        setGenerating(false);
        return;
      }

      const parsed = JSON.parse(jsonStr);
      const addIds = (steps) => (steps || []).map(s => ({
        ...s,
        id: crypto.randomUUID(),
        subSteps: s.subSteps ? addIds(s.subSteps) : [],
      }));

      if (detail) {
        // 更新现有工作流并保存新版本
        const newName = parsed.name || detail.name;
        const newDesc = parsed.description || detail.description;
        const newSteps = addIds(parsed.steps || []);

        await window.electronAPI.workflowUpdate(detail.id, { name: newName, description: newDesc });
        await window.electronAPI.workflowSaveVersion(detail.id, {
          steps: newSteps,
          label: `v${(detail.versions?.length || 0) + 1} (AI)`,
          modelId: aiModel,
        });
        await loadDetail(detail.id);
        await loadList();
      } else {
        // 创建新工作流
        const wf = await window.electronAPI.workflowCreate({
          name: parsed.name || '新工作流',
          description: parsed.description || '',
          steps: addIds(parsed.steps || []),
          modelId: aiModel,
        });
        await loadList();
        loadDetail(wf.id);
      }
      setAiInput('');
    } catch (e) {
      console.error('AI generate workflow error:', e);
    }
    setGenerating(false);
  };

  const activeVersion = detail?.versions?.find(v => v.id === detail.activeVersionId);
  const steps = activeVersion?.steps || [];
  const markDirty = () => setDirty(true);

  const updateStep = (idx, updated) => {
    if (!activeVersion) return;
    const newSteps = [...steps];
    newSteps[idx] = updated;
    activeVersion.steps = newSteps;
    setDetail({ ...detail });
    markDirty();
  };

  const deleteStep = (idx) => {
    if (!activeVersion) return;
    activeVersion.steps = steps.filter((_, i) => i !== idx);
    setDetail({ ...detail });
    markDirty();
  };

  const addStep = () => {
    if (!activeVersion) return;
    activeVersion.steps = [...steps, { id: crypto.randomUUID(), title: '', subSteps: [] }];
    setDetail({ ...detail });
    markDirty();
  };

  const addSubStep = (idx) => {
    if (!activeVersion) return;
    const step = steps[idx];
    const newSubs = [...(step.subSteps || []), { id: crypto.randomUUID(), title: '', subSteps: [] }];
    updateStep(idx, { ...step, subSteps: newSubs });
  };

  const stepCount = steps.length;
  const subStepCount = steps.reduce((n, s) => n + (s.subSteps?.length || 0), 0);

  return (
    <div className="flex h-full">
      {/* ── 左侧工作流列表 ── */}
      <div className="w-52 border-r border-zinc-900/80 flex flex-col bg-[#0b0b0b]">
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-zinc-900/80">
          <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">工作流</span>
          <button onClick={handleCreate} className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-blue-400 transition-colors" title="新建工作流">
            <Plus size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5 scrollbar-thin">
          {workflows.map(wf => (
            <div
              key={wf.id}
              className={`group relative w-full text-left px-2.5 py-2 rounded-md text-xs transition-all cursor-pointer ${
                selectedId === wf.id
                  ? 'bg-zinc-800/80 text-zinc-100 shadow-sm shadow-black/20'
                  : 'text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200'
              }`}
              onClick={() => { if (renamingId !== wf.id) loadDetail(wf.id); }}
            >
              {renamingId === wf.id ? (
                <InlineRenameInput
                  value={wf.name}
                  onSave={(name) => handleRenameFromList(wf.id, name)}
                  onCancel={() => setRenamingId(null)}
                />
              ) : (
                <>
                  <div className="font-medium truncate text-[11px] pr-10">{wf.name}</div>
                  <div className="text-[10px] text-zinc-600 truncate mt-0.5 leading-tight">{wf.description || '无描述'}</div>
                </>
              )}
              {/* hover 操作按钮 */}
              {renamingId !== wf.id && (
                <div className="absolute right-1.5 top-1.5 opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity">
                  <button
                    onClick={(e) => { e.stopPropagation(); setRenamingId(wf.id); }}
                    className="p-0.5 text-zinc-600 hover:text-blue-400 transition-colors rounded"
                    title="重命名"
                  >
                    <Edit3 size={10} />
                  </button>
                  {confirmDeleteId === wf.id ? (
                    <div className="flex items-center gap-0.5 bg-zinc-900 rounded px-0.5">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(wf.id); }}
                        className="p-0.5 text-red-400 hover:text-red-300 transition-colors"
                        title="确认删除"
                      >
                        <Check size={10} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); }}
                        className="p-0.5 text-zinc-500 hover:text-zinc-300 transition-colors"
                        title="取消"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(wf.id); }}
                      className="p-0.5 text-zinc-600 hover:text-red-400 transition-colors rounded"
                      title="删除"
                    >
                      <Trash2 size={10} />
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          {workflows.length === 0 && (
            <div className="text-zinc-700 text-[10px] text-center py-12 leading-relaxed">
              暂无工作流<br/>
              <span className="text-zinc-600">点击 + 创建第一个</span>
            </div>
          )}
        </div>
      </div>

      {/* ── 右侧编辑区 ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!detail ? (
          <div className="flex-1 flex flex-col items-center justify-center text-zinc-700 gap-3">
            <Sparkles size={28} className="opacity-20" />
            <span className="text-xs">选择或创建一个工作流</span>
          </div>
        ) : (
          <>
            {/* 顶部栏 */}
            <div className="flex items-center justify-between px-6 py-2 border-b border-zinc-900/80 bg-[#0c0c0c]">
              <div className="flex items-center gap-2 text-zinc-500 text-[10px]">
                <span>{stepCount} 步骤</span>
                {subStepCount > 0 && <><span className="text-zinc-800">·</span><span>{subStepCount} 子步骤</span></>}
                {detail.versions?.length > 1 && <><span className="text-zinc-800">·</span><span>{detail.versions.length} 版本</span></>}
              </div>
              <button
                onClick={handleSave}
                disabled={saving || !dirty}
                className={`px-3 py-1 text-[11px] rounded-md flex items-center gap-1.5 transition-all ${
                  dirty
                    ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-sm shadow-blue-500/20'
                    : 'bg-zinc-900 text-zinc-600 cursor-default'
                }`}
              >
                {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
                {saving ? '保存中' : dirty ? '保存' : '已保存'}
              </button>
            </div>

            {/* AI 生成区 */}
            <div className="px-6 py-3 border-b border-zinc-900/80 bg-[#0c0c0c]">
              <div className="flex gap-2">
                <div className="w-32 shrink-0">
                  <CustomSelect
                    value={aiModel}
                    onChange={setAiModel}
                    options={models.map(m => ({ value: m.id, label: m.name || m.displayName }))}
                    placeholder="选择模型"
                  />
                </div>
                <div className="flex-1 relative">
                  <input
                    className="w-full bg-zinc-900/60 text-zinc-200 text-[11px] pl-3 pr-9 py-1.5 rounded-lg border border-zinc-800 outline-none focus:border-zinc-600 placeholder-zinc-600 transition-colors"
                    placeholder="用大白话描述工作流需求，AI 自动生成步骤..."
                    value={aiInput}
                    onChange={e => setAiInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleGenerate(); } }}
                  />
                  <button
                    onClick={handleGenerate}
                    disabled={generating || !aiInput.trim() || !aiModel}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-zinc-500 hover:text-blue-400 disabled:text-zinc-700 disabled:hover:text-zinc-700 transition-colors"
                    title="生成工作流"
                  >
                    {generating ? <Loader2 size={13} className="animate-spin text-blue-400" /> : <ArrowUp size={13} />}
                  </button>
                </div>
              </div>
            </div>

            {/* 基本信息 */}
            <div className="px-6 py-3 border-b border-zinc-900/80 space-y-1.5">
              <input
                className="w-full bg-transparent text-zinc-100 text-[13px] font-semibold outline-none placeholder-zinc-700"
                value={detail.name}
                onChange={e => { setDetail({ ...detail, name: e.target.value }); markDirty(); }}
                placeholder="工作流名称"
              />
              <textarea
                className="w-full bg-transparent text-zinc-500 text-[11px] outline-none resize-none placeholder-zinc-700 leading-relaxed"
                rows={2}
                value={detail.description}
                onChange={e => { setDetail({ ...detail, description: e.target.value }); markDirty(); }}
                placeholder="适用场景：什么情况下引用这个工作流..."
              />
            </div>

            {/* 版本条 */}
            <div className="px-6 py-1.5 border-b border-zinc-900/80 flex items-center gap-1.5 flex-wrap bg-[#0a0a0a]">
              <span className="text-[9px] text-zinc-600 uppercase tracking-wider mr-1">VER</span>
              {detail.versions?.map(ver => (
                <button
                  key={ver.id}
                  onClick={() => handleSelectVersion(ver.id)}
                  className={`px-2 py-0.5 rounded text-[10px] font-mono transition-all ${
                    ver.id === detail.activeVersionId
                      ? 'bg-blue-500/15 text-blue-400 border border-blue-500/25'
                      : 'text-zinc-600 hover:text-zinc-400 border border-transparent hover:border-zinc-800'
                  }`}
                >
                  {ver.label}
                </button>
              ))}
              <button
                onClick={handleSaveAsNewVersion}
                className="px-1.5 py-0.5 rounded text-[10px] text-zinc-600 hover:text-zinc-300 transition-colors"
                title="保存为新版本"
              >
                <Plus size={10} />
              </button>
              {detail.versions?.length > 1 && detail.activeVersionId && (
                <button
                  onClick={() => handleDeleteVersion(detail.activeVersionId)}
                  className="px-1.5 py-0.5 text-[10px] text-zinc-700 hover:text-red-400 transition-colors"
                  title="删除当前版本"
                >
                  <Trash2 size={10} />
                </button>
              )}
            </div>

            {/* 步骤列表 */}
            <div className="flex-1 overflow-y-auto px-6 py-3 space-y-0 scrollbar-thin">
              {steps.map((step, idx) => (
                <StepItem
                  key={step.id || idx}
                  step={step}
                  index={idx}
                  onUpdate={(updated) => updateStep(idx, updated)}
                  onDelete={() => deleteStep(idx)}
                  onAddSub={() => addSubStep(idx)}
                />
              ))}
              <button
                onClick={addStep}
                className="w-full mt-1 py-1.5 border border-dashed border-zinc-800/60 rounded-md text-zinc-700 text-[10px] hover:border-zinc-600 hover:text-zinc-400 transition-colors flex items-center justify-center gap-1"
              >
                <Plus size={11} /> 添加步骤
              </button>
            </div>

            {/* 底部 */}
            <div className="px-6 py-2 border-t border-zinc-900/80 flex items-center justify-start bg-[#0a0a0a]">
              <button
                onClick={() => setConfirmDeleteId(detail.id)}
                className="text-[10px] text-zinc-700 hover:text-red-400 transition-colors"
              >
                删除此工作流
              </button>
              {confirmDeleteId === detail.id && (
                <span className="ml-2 flex items-center gap-1">
                  <button onClick={() => handleDelete(detail.id)} className="text-[10px] text-red-400 hover:text-red-300">确认</button>
                  <button onClick={() => setConfirmDeleteId(null)} className="text-[10px] text-zinc-600 hover:text-zinc-400">取消</button>
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
