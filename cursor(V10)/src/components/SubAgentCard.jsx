import React, { useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Loader2, Check, X } from 'lucide-react';

const STATUS_MAP = {
  running: { color: 'border-blue-800/50 bg-blue-950/20', icon: Loader2, spin: true, label: '运行中' },
  complete: { color: 'border-green-800/40 bg-green-950/20', icon: Check, spin: false, label: '完成' },
  failed: { color: 'border-red-800/40 bg-red-950/20', icon: X, spin: false, label: '失败' },
  cancelled: { color: 'border-zinc-700 bg-zinc-900', icon: X, spin: false, label: '已取消' },
};

export default function SubAgentCard({ description, status = 'running', iterations, toolsUsed, content, error, elapsed }) {
  const [expanded, setExpanded] = useState(false);
  const cfg = STATUS_MAP[status] || STATUS_MAP.running;
  const Icon = cfg.icon;

  return (
    <div className={`rounded-lg border ${cfg.color} my-2 overflow-hidden`}>
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-white/5 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown size={14} className="text-zinc-500" /> : <ChevronRight size={14} className="text-zinc-500" />}
        <Bot size={14} className="text-cyan-400" />
        <span className="text-xs font-medium text-zinc-300">子代理: {description || '子任务'}</span>
        <div className="flex-1" />
        <Icon size={14} className={`${cfg.spin ? 'animate-spin' : ''} ${status === 'complete' ? 'text-green-400' : status === 'failed' ? 'text-red-400' : 'text-blue-400'}`} />
        <span className="text-[10px] text-zinc-500">{cfg.label}</span>
        {iterations > 0 && <span className="text-[10px] text-zinc-600">· {iterations}轮</span>}
        {toolsUsed > 0 && <span className="text-[10px] text-zinc-600">· {toolsUsed}次工具</span>}
        {elapsed && <span className="text-[10px] text-zinc-600">· {(elapsed / 1000).toFixed(1)}s</span>}
      </div>

      {expanded && (
        <div className="border-t border-zinc-800 px-3 py-2">
          {error && (
            <div className="text-xs text-red-400 bg-red-950/20 rounded p-2 mb-2 font-mono">{error}</div>
          )}
          {content && (
            <pre className="text-xs text-zinc-400 bg-zinc-900/50 rounded p-2 overflow-auto max-h-[300px] font-mono whitespace-pre-wrap">
              {content}
            </pre>
          )}
          {!content && !error && (
            <div className="text-xs text-zinc-500">子代理正在工作中...</div>
          )}
        </div>
      )}
    </div>
  );
}
