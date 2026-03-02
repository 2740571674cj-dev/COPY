import React, { useState, useEffect, useRef } from 'react';
import { Loader2, Check, X, Pause, StopCircle, Brain, AlertTriangle, Zap } from 'lucide-react';

const STATE_CONFIG = {
  idle: { icon: null, label: '', color: '' },
  planning: { icon: Brain, label: '规划中...', color: 'text-zinc-400' },
  calling_llm: { icon: Loader2, label: '思考中...', color: 'text-zinc-300', spin: true },
  executing_tools: { icon: Loader2, label: '执行工具...', color: 'text-zinc-300', spin: true },
  awaiting_approval: { icon: Pause, label: '等待确认 — 请在上方操作栏中批准或拒绝', color: 'text-yellow-400/80', iconStyle: { color: '#b8a840' } },
  reflecting: { icon: Brain, label: '反思中...', color: 'text-zinc-400' },
  complete: { icon: Check, label: '完成', color: 'text-zinc-400' },
  incomplete: { icon: AlertTriangle, label: '未完成停止', color: 'text-zinc-300', iconStyle: { color: '#8a8a6a' } },
  failed: { icon: X, label: '失败', color: 'text-zinc-500', iconStyle: { color: '#8a6060' } },
  cancelled: { icon: StopCircle, label: '已取消', color: 'text-zinc-600' },
};

function ElapsedTimer({ startTime }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startTime) return;
    setElapsed(Math.round((Date.now() - startTime) / 1000));
    const timer = setInterval(() => {
      setElapsed(Math.round((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [startTime]);
  if (!startTime || elapsed < 1) return null;
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return (
    <span className="text-zinc-600 tabular-nums">
      {m > 0 ? `${m}m${s}s` : `${s}s`}
    </span>
  );
}

export default function AgentStatusBar({ state, iteration, toolCallCount, onCancel, activeToolName, parallelInfo, stateStartTime }) {
  const config = STATE_CONFIG[state] || STATE_CONFIG.idle;
  if (!config.icon) return null;

  const Icon = config.icon;
  const isActive = ['planning', 'calling_llm', 'executing_tools', 'awaiting_approval', 'reflecting'].includes(state);
  const isParallel = parallelInfo && parallelInfo.count > 1;

  const statusLabel = (() => {
    if (state === 'executing_tools') {
      if (isParallel) {
        return `并行执行 ${parallelInfo.completed || 0}/${parallelInfo.count} 工具`;
      }
      if (activeToolName) {
        return `执行 ${activeToolName}`;
      }
      return config.label;
    }
    return config.label;
  })();

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900/80 border-t border-zinc-800 text-xs">
      {isParallel ? (
        <Zap size={14} className="text-zinc-300 shrink-0" />
      ) : (
        <Icon size={14} className={`${config.color} ${config.spin ? 'animate-spin' : ''}`} style={config.iconStyle || {}} />
      )}
      <span className={config.color}>{statusLabel}</span>

      {iteration > 0 && (
        <span className="text-zinc-600">
          · 迭代 {iteration}
        </span>
      )}
      {toolCallCount > 0 && (
        <span className="text-zinc-600">
          · {toolCallCount} 次工具调用
        </span>
      )}

      {isActive && stateStartTime && (
        <span className="text-zinc-700">
          · <ElapsedTimer startTime={stateStartTime} />
        </span>
      )}

      {isParallel && (
        <div className="flex items-center gap-1 ml-1">
          <div className="w-[60px] h-[3px] bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-zinc-500 rounded-full transition-all duration-300"
              style={{ width: `${Math.round(((parallelInfo.completed || 0) / parallelInfo.count) * 100)}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex-1" />

      {isActive && onCancel && (
        <button
          onClick={onCancel}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
        >
          <StopCircle size={12} />
          取消
        </button>
      )}
    </div>
  );
}
