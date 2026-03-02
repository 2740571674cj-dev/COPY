import React, { useState, useCallback, useEffect } from 'react';
import { FlaskConical, Loader2, Star, AlertCircle, BarChart3, Trophy, RotateCcw, Play } from 'lucide-react';
import CustomSelect from './CustomSelect';

const SCORE_DIMENSIONS = [
  { key: 'accuracy', label: '准确性', desc: '回答是否正确、无事实错误' },
  { key: 'completeness', label: '完整性', desc: '是否覆盖了所有要求的要点' },
  { key: 'structure', label: '结构性', desc: '回答是否条理清晰、层次分明' },
  { key: 'practicality', label: '实用性', desc: '是否有实际可操作的指导价值' },
];

function ScoreBar({ score, maxScore = 10, winner = false, color = 'blue' }) {
  const pct = maxScore > 0 ? (score / maxScore) * 100 : 0;
  const colors = {
    blue: { bar: 'bg-blue-500', bg: 'bg-blue-500/10', text: 'text-blue-400' },
    purple: { bar: 'bg-purple-500', bg: 'bg-purple-500/10', text: 'text-purple-400' },
  };
  const c = colors[color] || colors.blue;
  return (
    <div className="flex items-center gap-2.5 w-full">
      <div className={`flex-1 h-2 rounded-full ${c.bg} overflow-hidden`}>
        <div className={`h-full rounded-full ${c.bar} transition-all duration-700 ease-out`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-[12px] font-bold tabular-nums w-8 text-right ${winner ? c.text : 'text-zinc-500'}`}>
        {score > 0 ? score : '-'}
      </span>
    </div>
  );
}

function ScoreCard({ label, aScore, bScore }) {
  const aWins = aScore > bScore;
  const bWins = bScore > aScore;
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-center py-1.5">
      <ScoreBar score={aScore} winner={aWins} color="blue" />
      <span className="text-[11px] text-zinc-500 font-medium w-14 text-center whitespace-nowrap">{label}</span>
      <div className="flex flex-row-reverse">
        <ScoreBar score={bScore} winner={bWins} color="purple" />
      </div>
    </div>
  );
}

function ResultPanel({ label, color, result, running, versionLabel, isWinner, elapsed }) {
  const borderColor = isWinner
    ? (color === 'blue' ? 'border-blue-500/30 bg-blue-500/[0.03]' : 'border-purple-500/30 bg-purple-500/[0.03]')
    : 'border-zinc-800/60 bg-zinc-900/20';
  const headerColor = isWinner
    ? (color === 'blue' ? 'text-blue-400' : 'text-purple-400')
    : 'text-zinc-500';

  return (
    <div className={`flex-1 min-w-0 rounded-xl border transition-all overflow-hidden flex flex-col ${borderColor}`}>
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800/40">
        <span className={`text-[11px] font-semibold uppercase tracking-wider ${headerColor}`}>
          {label} — {versionLabel || '?'}
        </span>
        {elapsed > 0 && <span className="text-[10px] text-zinc-600 tabular-nums">{(elapsed / 1000).toFixed(1)}s</span>}
      </div>
      <div className="flex-1 overflow-y-auto p-4 scrollbar-thin">
        {result?.error ? (
          <div className="flex items-center gap-2 text-red-400 text-xs"><AlertCircle size={14} />{result.error}</div>
        ) : result?.content ? (
          <pre className="text-zinc-300 text-[12px] leading-relaxed whitespace-pre-wrap break-words font-sans">{result.content}</pre>
        ) : running ? (
          <div className="flex items-center gap-2 text-zinc-600 text-xs py-12 justify-center"><Loader2 size={16} className="animate-spin" />执行中...</div>
        ) : (
          <div className="text-zinc-700 text-xs text-center py-12">等待执行</div>
        )}
      </div>
    </div>
  );
}

export default function WorkflowBattlePanel({ workflowList: externalList, models = [] }) {
  const [internalList, setInternalList] = useState([]);
  const workflowList = externalList || internalList;

  useEffect(() => {
    if (!externalList) {
      window.electronAPI?.workflowList?.().then(list => setInternalList(list || []));
    }
  }, [externalList]);

  const [workflowId, setWorkflowId] = useState('');
  const [selectedWorkflow, setSelectedWorkflow] = useState(null);
  const [leftVersionId, setLeftVersionId] = useState('');
  const [leftModelId, setLeftModelId] = useState('');
  const [rightVersionId, setRightVersionId] = useState('');
  const [rightModelId, setRightModelId] = useState('');
  const [judgeModelId, setJudgeModelId] = useState('');
  const [userInput, setUserInput] = useState('');
  const [running, setRunning] = useState(false);
  const [leftResult, setLeftResult] = useState(null);
  const [rightResult, setRightResult] = useState(null);
  const [judgeResult, setJudgeResult] = useState(null);
  const [error, setError] = useState('');

  const versions = selectedWorkflow?.versions || [];

  const validationError = (() => {
    if (!workflowId) return '请先选择工作流';
    if (!leftVersionId || !leftModelId) return '请配置 A 方版本和模型';
    if (!rightVersionId || !rightModelId) return '请配置 B 方版本和模型';
    if (leftVersionId === rightVersionId && leftModelId === rightModelId) return '两侧配置不能完全相同';
    if (!judgeModelId) return '请选择评分模型';
    if (!userInput.trim()) return '请输入测试问题';
    return '';
  })();

  const buildWorkflowPrompt = useCallback((version) => {
    if (!version?.steps?.length) return '';
    const lines = ['请严格按照以下工作流步骤执行任务：\n'];
    version.steps.forEach((step, i) => {
      lines.push(`${i + 1}. ${step.title || '未命名步骤'}`);
      if (step.subSteps?.length) {
        step.subSteps.forEach((sub, j) => lines.push(`   ${i + 1}.${j + 1}. ${sub.title || ''}`));
      }
    });
    return lines.join('\n');
  }, []);

  const handleBattle = useCallback(async () => {
    if (validationError) return;
    setRunning(true); setLeftResult(null); setRightResult(null); setJudgeResult(null); setError('');

    const leftVersion = versions.find(v => v.id === leftVersionId);
    const rightVersion = versions.find(v => v.id === rightVersionId);
    const buildMessages = (ver) => {
      const sys = buildWorkflowPrompt(ver);
      const msgs = [];
      if (sys) msgs.push({ role: 'system', content: sys });
      msgs.push({ role: 'user', content: userInput.trim() });
      return msgs;
    };

    try {
      const [leftRes, rightRes] = await Promise.all([
        window.electronAPI.llmChat({ modelId: leftModelId, messages: buildMessages(leftVersion) }),
        window.electronAPI.llmChat({ modelId: rightModelId, messages: buildMessages(rightVersion) }),
      ]);

      const lr = leftRes.success ? { content: leftRes.data.content, elapsed: leftRes.data.elapsed, error: null } : { content: '', elapsed: 0, error: leftRes.error || '执行失败' };
      const rr = rightRes.success ? { content: rightRes.data.content, elapsed: rightRes.data.elapsed, error: null } : { content: '', elapsed: 0, error: rightRes.error || '执行失败' };
      setLeftResult(lr); setRightResult(rr);

      if (lr.content && rr.content) {
        const lLabel = leftVersion?.label || 'A';
        const rLabel = rightVersion?.label || 'B';
        const lName = models.find(m => m.id === leftModelId)?.name || leftModelId;
        const rName = models.find(m => m.id === rightModelId)?.name || rightModelId;
        const dimDesc = SCORE_DIMENSIONS.map(d => `- ${d.key}: ${d.desc}`).join('\n');
        const dimKeys = SCORE_DIMENSIONS.map(d => `"${d.key}"`).join(', ');

        const judgePrompt = [
          { role: 'system', content: `你是一个公正的 AI 评审员。请对两个回答进行多维度评分（1-10 分）。\n\n评分维度：\n${dimDesc}\n\n请以以下 JSON 格式严格输出，不要输出任何其他内容：\n{\n  "left": { ${dimKeys}: <number> },\n  "right": { ${dimKeys}: <number> },\n  "summary": "<简要评价两个回答的优劣差异>"\n}` },
          { role: 'user', content: `用户问题：${userInput.trim()}\n\n--- 回答 A (${lLabel}/${lName}) ---\n${lr.content}\n\n--- 回答 B (${rLabel}/${rName}) ---\n${rr.content}\n\n请评分。` },
        ];

        const judgeRes = await window.electronAPI.llmChat({ modelId: judgeModelId, messages: judgePrompt });
        if (judgeRes.success) {
          try {
            const raw = judgeRes.data.content;
            const m = raw.match(/\{[\s\S]*\}/);
            if (m) {
              const p = JSON.parse(m[0]);
              const leftScores = {}, rightScores = {};
              let leftTotal = 0, rightTotal = 0;
              for (const dim of SCORE_DIMENSIONS) {
                const ls = Number(p.left?.[dim.key]) || 0;
                const rs = Number(p.right?.[dim.key]) || 0;
                leftScores[dim.key] = ls; rightScores[dim.key] = rs;
                leftTotal += ls; rightTotal += rs;
              }
              setJudgeResult({ leftScores, rightScores, leftTotal: Math.round(leftTotal / SCORE_DIMENSIONS.length * 10) / 10, rightTotal: Math.round(rightTotal / SCORE_DIMENSIONS.length * 10) / 10, summary: p.summary || '' });
            } else {
              setJudgeResult({ leftScores: {}, rightScores: {}, leftTotal: 0, rightTotal: 0, summary: raw });
            }
          } catch (_) {
            setJudgeResult({ leftScores: {}, rightScores: {}, leftTotal: 0, rightTotal: 0, summary: judgeRes.data.content });
          }
        } else {
          setError(`评分失败: ${judgeRes.error}`);
        }
      }
    } catch (e) {
      setError(`执行出错: ${e.message}`);
    } finally {
      setRunning(false);
    }
  }, [validationError, versions, leftVersionId, rightVersionId, leftModelId, rightModelId, judgeModelId, userInput, buildWorkflowPrompt, models]);

  const handleReset = () => { setLeftResult(null); setRightResult(null); setJudgeResult(null); setError(''); };

  const handleWorkflowChange = async (id) => {
    setWorkflowId(id); setLeftVersionId(''); setRightVersionId(''); setSelectedWorkflow(null); handleReset();
    if (id) { const wf = await window.electronAPI.workflowGet(id); setSelectedWorkflow(wf); }
  };

  const leftWins = judgeResult && judgeResult.leftTotal > judgeResult.rightTotal;
  const rightWins = judgeResult && judgeResult.rightTotal > judgeResult.leftTotal;
  const hasResults = leftResult || rightResult || running;

  return (
    <div className="flex h-full bg-[#0a0a0a]">
      {/* ── 左侧：配置面板 ── */}
      <div className="w-72 flex-shrink-0 border-r border-zinc-900/80 flex flex-col">
        {/* 标题 */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-900/80">
          <div className="flex items-center gap-2">
            <FlaskConical size={14} className="text-violet-400" />
            <span className="text-[11px] font-bold text-zinc-300 tracking-wide">效果评测</span>
          </div>
          {hasResults && (
            <button onClick={handleReset} className="text-[10px] text-zinc-600 hover:text-zinc-300 transition-colors flex items-center gap-1">
              <RotateCcw size={10} /> 重置
            </button>
          )}
        </div>

        {/* 配置区 */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 scrollbar-thin">
          <div>
            <label className="text-[10px] text-zinc-600 mb-1 block">工作流</label>
            <CustomSelect value={workflowId} onChange={handleWorkflowChange}
              options={workflowList.map(w => ({ value: w.id, label: w.name || '未命名' }))} placeholder="选择工作流" className="w-full" />
          </div>

          {selectedWorkflow && (
            <>
              {/* A方 */}
              <div className="p-3 rounded-lg bg-blue-500/[0.03] border border-blue-500/10 space-y-2">
                <span className="text-[9px] font-bold text-blue-400/60 uppercase tracking-widest">A 方</span>
                <CustomSelect value={leftVersionId} onChange={v => { setLeftVersionId(v); handleReset(); }}
                  options={versions.map(v => ({ value: v.id, label: v.label || v.id }))} placeholder="版本" className="w-full" />
                <CustomSelect value={leftModelId} onChange={v => { setLeftModelId(v); handleReset(); }}
                  options={models.map(m => ({ value: m.id, label: m.name || m.displayName || m.id }))} placeholder="模型" className="w-full" />
              </div>

              {/* B方 */}
              <div className="p-3 rounded-lg bg-purple-500/[0.03] border border-purple-500/10 space-y-2">
                <span className="text-[9px] font-bold text-purple-400/60 uppercase tracking-widest">B 方</span>
                <CustomSelect value={rightVersionId} onChange={v => { setRightVersionId(v); handleReset(); }}
                  options={versions.map(v => ({ value: v.id, label: v.label || v.id }))} placeholder="版本" className="w-full" />
                <CustomSelect value={rightModelId} onChange={v => { setRightModelId(v); handleReset(); }}
                  options={models.map(m => ({ value: m.id, label: m.name || m.displayName || m.id }))} placeholder="模型" className="w-full" />
              </div>

              {/* 评分模型 */}
              <div>
                <label className="text-[10px] text-zinc-600 mb-1 block">评分模型</label>
                <CustomSelect value={judgeModelId} onChange={setJudgeModelId}
                  options={models.map(m => ({ value: m.id, label: m.name || m.displayName || m.id }))} placeholder="选择评分模型" className="w-full" />
              </div>

              {/* 问题输入 */}
              <div>
                <label className="text-[10px] text-zinc-600 mb-1 block">测试问题</label>
                <textarea
                  className="w-full bg-zinc-900/50 text-zinc-200 text-[11px] px-3 py-2 rounded-lg border border-zinc-800 outline-none focus:border-zinc-600 placeholder-zinc-600 resize-none transition-colors leading-relaxed"
                  rows={3} placeholder="输入测试问题..." value={userInput} onChange={e => setUserInput(e.target.value)}
                />
              </div>

              {/* 验证提示 */}
              {validationError && (
                <div className="flex items-center gap-1.5 text-[10px] text-amber-500/70">
                  <AlertCircle size={11} /><span>{validationError}</span>
                </div>
              )}

              {/* 开始按钮 */}
              <button
                onClick={handleBattle}
                disabled={running || !!validationError}
                className={`w-full py-2.5 rounded-lg text-[12px] font-bold flex items-center justify-center gap-2 transition-all ${
                  running ? 'bg-zinc-800 text-zinc-500 cursor-wait'
                  : validationError ? 'bg-zinc-900 text-zinc-700 cursor-not-allowed'
                  : 'bg-gradient-to-r from-violet-600 to-purple-600 text-white hover:from-violet-500 hover:to-purple-500 shadow-lg shadow-violet-500/15 active:scale-[0.98]'
                }`}
              >
                {running ? <><Loader2 size={14} className="animate-spin" /> 评测中...</> : <><Play size={14} /> 开始评测</>}
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── 右侧：结果展示区（充分利用空间） ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {!hasResults && !error ? (
          /* 空状态 */
          <div className="flex-1 flex flex-col items-center justify-center text-zinc-700 gap-3">
            <FlaskConical size={48} className="opacity-10" />
            <span className="text-[12px]">配置左侧参数后开始评测</span>
            <span className="text-[10px] text-zinc-800">A/B 版本 × 模型 对比，多维度自动评分</span>
          </div>
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* 评分面板（横跨顶部） */}
            {judgeResult && Object.keys(judgeResult.leftScores).length > 0 && (
              <div className="border-b border-zinc-900/80 px-6 py-4">
                {/* 总分 */}
                <div className="flex items-center justify-between mb-3">
                  <div className={`flex items-center gap-2 text-[14px] font-bold ${leftWins ? 'text-blue-400' : 'text-zinc-500'}`}>
                    {leftWins && <Trophy size={16} className="text-blue-400" />}
                    <span>A 方: {judgeResult.leftTotal}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <BarChart3 size={13} className="text-zinc-600" />
                    <span className="text-[10px] text-zinc-600 uppercase tracking-wider font-bold">评分详情</span>
                  </div>
                  <div className={`flex items-center gap-2 text-[14px] font-bold ${rightWins ? 'text-purple-400' : 'text-zinc-500'}`}>
                    <span>B 方: {judgeResult.rightTotal}</span>
                    {rightWins && <Trophy size={16} className="text-purple-400" />}
                  </div>
                </div>
                {/* 维度分 */}
                <div className="space-y-0">
                  {SCORE_DIMENSIONS.map(dim => (
                    <ScoreCard key={dim.key} label={dim.label} aScore={judgeResult.leftScores[dim.key] || 0} bScore={judgeResult.rightScores[dim.key] || 0} />
                  ))}
                </div>
                {/* 总结 */}
                {judgeResult.summary && (
                  <div className="mt-3 pt-3 border-t border-zinc-800/40">
                    <p className="text-zinc-400 text-[11px] leading-relaxed">{judgeResult.summary}</p>
                  </div>
                )}
              </div>
            )}

            {/* A/B 结果并排（充满剩余空间） */}
            <div className="flex-1 flex gap-0 min-h-0 overflow-hidden">
              <ResultPanel
                label="A 方" color="blue"
                result={leftResult} running={running}
                versionLabel={versions.find(v => v.id === leftVersionId)?.label}
                isWinner={leftWins}
                elapsed={leftResult?.elapsed || 0}
              />
              <div className="w-px bg-zinc-900/80 flex-shrink-0" />
              <ResultPanel
                label="B 方" color="purple"
                result={rightResult} running={running}
                versionLabel={versions.find(v => v.id === rightVersionId)?.label}
                isWinner={rightWins}
                elapsed={rightResult?.elapsed || 0}
              />
            </div>

            {/* 错误 */}
            {error && (
              <div className="px-6 py-3 border-t border-zinc-900/80">
                <div className="flex items-center gap-2 text-red-400 text-[11px] bg-red-500/5 rounded-lg px-3 py-2 border border-red-500/15">
                  <AlertCircle size={13} /><span>{error}</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
