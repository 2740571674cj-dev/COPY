import React, { useState, useEffect } from 'react';
import { Check, Loader2, Circle, ChevronDown, ChevronRight, GitBranch } from 'lucide-react';

function StepStatus({ status }) {
  if (status === 'completed') {
    return (
      <div className="w-4 h-4 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0">
        <Check size={10} className="text-emerald-400" />
      </div>
    );
  }
  if (status === 'in_progress') {
    return <Loader2 size={14} className="text-blue-400 animate-spin shrink-0" />;
  }
  return <Circle size={14} className="text-zinc-700 shrink-0" />;
}

function StepRow({ step, depth = 0 }) {
  const isCompleted = step.status === 'completed';
  const isActive = step.status === 'in_progress';

  return (
    <div
      className={`flex items-center gap-2 py-1 px-2 rounded-md transition-all ${
        isActive ? 'bg-blue-500/5 border border-blue-500/20' : ''
      } ${depth > 0 ? 'ml-5' : ''}`}
    >
      <StepStatus status={step.status} />
      <span
        className={`text-xs transition-all ${
          isCompleted ? 'text-zinc-500 line-through' : isActive ? 'text-blue-300' : 'text-zinc-400'
        }`}
      >
        {step.title}
      </span>
    </div>
  );
}

export default function WorkflowExecutionPanel({ workflowName, steps }) {
  const [collapsed, setCollapsed] = useState(false);

  if (!steps || steps.length === 0) return null;

  const total = steps.length;
  const completed = steps.filter(s => s.status === 'completed').length;
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden bg-[#0c0c0c] mb-3">
      {/* 头部 */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-zinc-800/50 transition-colors"
      >
        <GitBranch size={12} className="text-blue-400 shrink-0" />
        <span className="text-xs text-zinc-300 font-medium flex-1 text-left truncate">
          {workflowName}
        </span>
        <span className="text-[10px] text-zinc-500 shrink-0">
          {completed}/{total}
        </span>
        <div className="w-16 h-1 bg-zinc-800 rounded-full overflow-hidden shrink-0">
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
        {collapsed ? <ChevronRight size={12} className="text-zinc-600" /> : <ChevronDown size={12} className="text-zinc-600" />}
      </button>

      {/* 步骤列表 */}
      {!collapsed && (
        <div className="px-2 pb-2 space-y-0.5">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} depth={step.depth || 0} />
          ))}
        </div>
      )}
    </div>
  );
}
