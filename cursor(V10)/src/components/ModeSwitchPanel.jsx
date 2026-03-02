import React from 'react';
import { Repeat, Check, X } from 'lucide-react';

const MODE_LABELS = {
  agent: 'Agent',
  plan: 'Plan',
  ask: 'Ask',
  chat: 'Ask',
  debug: 'Debug',
};

export default function ModeSwitchPanel({ targetMode, explanation, onApprove, onReject }) {
  const label = MODE_LABELS[targetMode] || targetMode || 'Unknown';

  return (
    <div className="ml-5 mr-1 mt-1.5 mb-2 rounded-lg border border-amber-700/40 bg-amber-950/10 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-amber-700/25 bg-amber-950/20">
        <Repeat size={13} className="text-amber-400 shrink-0" />
        <span className="text-[12px] text-amber-200 font-medium">请求切换到 {label} 模式</span>
      </div>

      <div className="px-3 py-2">
        <div className="text-[12px] text-zinc-300 leading-relaxed">
          {explanation || '模型建议切换模式以更好地完成当前任务。'}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-amber-700/25">
        <button
          onClick={onReject}
          className="px-3 py-1 text-[11px] rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors flex items-center gap-1"
        >
          <X size={11} />
          保持当前模式
        </button>
        <button
          onClick={onApprove}
          className="px-3 py-1 text-[11px] rounded bg-amber-600 hover:bg-amber-500 text-white transition-colors flex items-center gap-1"
        >
          <Check size={11} />
          同意切换
        </button>
      </div>
    </div>
  );
}

