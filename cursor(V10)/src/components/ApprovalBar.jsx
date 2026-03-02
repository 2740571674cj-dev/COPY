import React from 'react';
import { ShieldCheck, ShieldAlert } from 'lucide-react';

export default function ApprovalBar({ toolName, args, riskLevel, onApprove, onDeny }) {
  const isHigh = riskLevel === 'high';

  const summary = (() => {
    if (toolName === 'run_terminal_cmd') return `执行命令: ${args?.command || ''}`;
    if (toolName === 'edit_file') return `编辑文件: ${args?.path || ''}`;
    if (toolName === 'write_file') return `写入文件: ${args?.path || ''}`;
    if (toolName === 'delete_file') return `删除文件: ${args?.path || ''}`;
    return `${toolName}`;
  })();

  return (
    <div className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${isHigh ? 'bg-red-950/20 border-red-800/40' : 'bg-yellow-950/20 border-yellow-800/40'}`}>
      {isHigh
        ? <ShieldAlert size={18} className="text-red-400 shrink-0" />
        : <ShieldCheck size={18} className="text-yellow-400 shrink-0" />
      }
      <div className="flex-1 min-w-0">
        <div className="text-sm text-zinc-200 truncate">{summary}</div>
        <div className="text-xs text-zinc-500">
          {isHigh ? '高风险操作 — 请仔细确认' : 'Agent 请求执行此操作'}
        </div>
      </div>
      <button
        onClick={onDeny}
        className="px-4 py-1.5 text-sm rounded-md bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors shrink-0"
      >
        拒绝
      </button>
      <button
        onClick={onApprove}
        className={`px-4 py-1.5 text-sm rounded-md text-white transition-colors shrink-0 ${isHigh ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'}`}
      >
        允许
      </button>
    </div>
  );
}
