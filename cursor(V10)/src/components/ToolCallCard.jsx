import React, { useState, useMemo } from 'react';
import {
  ChevronDown, ChevronRight, Check, X, Loader2, Clock,
  FileText, Terminal, Search, Folder, Trash2, Edit3, PenTool,
  Globe, Image, GitBranch, ListTodo, Compass, ExternalLink,
  ShieldCheck, ShieldAlert
} from 'lucide-react';

const TOOL_META = {
  read_file: { label: 'Read', doneLabel: 'Read', color: '#8a8a8a', key: 'path' },
  write_file: { label: 'Write', doneLabel: 'Wrote', color: '#a0a0a0', key: 'path' },
  edit_file: { label: 'Edit', doneLabel: 'Edited', color: '#a0a0a0', key: 'path' },
  create_file: { label: 'Create', doneLabel: 'Created', color: '#a0a0a0', key: 'path' },
  delete_file: { label: 'Delete', doneLabel: 'Deleted', color: '#8a6060', key: 'path' },
  run_terminal_cmd: { label: 'Run', doneLabel: 'Ran', color: '#9a9a7a', key: 'command' },
  grep_search: { label: 'Grep', doneLabel: 'Grepped', color: '#8a8a8a', key: 'query' },
  file_search: { label: 'Search', doneLabel: 'Found', color: '#8a8a8a', key: 'query' },
  list_dir: { label: 'List', doneLabel: 'Listed', color: '#8a8a8a', key: 'relative_workspace_path' },
  todo_write: { label: 'Update checklist', doneLabel: 'Updated checklist', color: '#8a8a8a', key: null },
  web_search: { label: 'Search web', doneLabel: 'Searched web', color: '#8a8a8a', key: 'query' },
  web_fetch: { label: 'Fetch', doneLabel: 'Fetched', color: '#8a8a8a', key: 'url' },
  task: { label: 'Task', doneLabel: 'Completed task', color: '#a0a0a0', key: 'description' },
  browser_use: { label: 'Browse', doneLabel: 'Browsed', color: '#8a8a8a', key: 'action' },
  generate_image: { label: 'Generate', doneLabel: 'Generated', color: '#a0a0a0', key: 'description' },
  git: { label: 'Git', doneLabel: 'Git', color: '#9a9a7a', key: null },
  read_lints: { label: 'Check lints', doneLabel: 'Checked lints', color: '#8a8a8a', key: null },
  diff_history: { label: 'Diff', doneLabel: 'Diffed', color: '#9a9a7a', key: null },
  reapply: { label: 'Reapply', doneLabel: 'Reapplied', color: '#a0a0a0', key: 'target_file' },
  search_files: { label: 'Grep', doneLabel: 'Grepped', color: '#8a8a8a', key: 'pattern' },
  glob_search: { label: 'Search', doneLabel: 'Found', color: '#8a8a8a', key: 'pattern' },
  list_directory: { label: 'List', doneLabel: 'Listed', color: '#8a8a8a', key: 'path' },
};

const EXPLORATION_TOOLS = new Set([
  'read_file', 'grep_search', 'file_search', 'list_dir',
  'list_directory', 'search_files', 'glob_search', 'read_lints',
]);

const CODE_TOOLS = new Set(['write_file', 'edit_file', 'create_file']);

function extractFileName(filePath) {
  if (!filePath) return '';
  return filePath.replace(/\\/g, '/').split('/').pop() || filePath;
}

function buildSummaryText(toolName, args) {
  switch (toolName) {
    case 'read_file': {
      const name = extractFileName(args.path || args.file_path);
      const parts = [name];
      if (args.offset && args.limit) parts.push(`L${args.offset}-${args.offset + args.limit}`);
      else if (args.offset) parts.push(`L${args.offset}+`);
      return parts.join(' ');
    }
    case 'write_file': case 'create_file': case 'edit_file':
    case 'delete_file': case 'reapply':
      return extractFileName(args.path || args.file_path || args.target_file);
    case 'run_terminal_cmd':
      return (args.command || '').substring(0, 80);
    case 'grep_search': case 'search_files': {
      const pattern = (args.query || args.pattern || '').substring(0, 50);
      const searchPath = args.path ? extractFileName(args.path) : (args.include_pattern || null);
      return searchPath ? `${pattern} in ${searchPath}` : pattern;
    }
    case 'file_search': case 'glob_search':
      return (args.query || args.pattern || '').substring(0, 50);
    case 'list_dir': case 'list_directory':
      return args.relative_workspace_path || args.path || '.';
    case 'todo_write':
      return `${(args.todos || []).length} items`;
    case 'web_search':
      return `"${(args.query || '').substring(0, 40)}"`;
    case 'web_fetch':
      return (args.url || '').substring(0, 60);
    case 'task':
      return (args.description || '').substring(0, 50);
    case 'git':
      return (args.args || []).join(' ');
    case 'read_lints': {
      const paths = args.paths || [];
      return paths.length > 0 ? paths.map(extractFileName).join(', ') : '';
    }
    default: return '';
  }
}

function calcDiffStats(toolName, args) {
  if (toolName === 'edit_file' && (args.old_string != null || args.new_string != null)) {
    const oldLines = (args.old_string || '').split('\n').length;
    const newLines = (args.new_string || '').split('\n').length;
    return { added: newLines, removed: oldLines };
  }
  if ((toolName === 'write_file' || toolName === 'create_file') && args.content) {
    return { added: args.content.split('\n').length, removed: 0 };
  }
  return null;
}

// ============================================================
// ToolCallCard — Cursor 风格工具调用行
// ============================================================
export default function ToolCallCard({ toolCall, status = 'pending', result, elapsed, defaultExpanded = false, onApprove, onDeny }) {
  const [open, setOpen] = useState(defaultExpanded);
  const codePreviewRef = React.useRef(null);

  const toolName = toolCall?.function?.name || 'unknown';
  const meta = TOOL_META[toolName] || { label: toolName, doneLabel: toolName, color: '#a1a1aa', key: null };
  const isStreaming = toolCall?._streaming === true;

  const args = useMemo(() => {
    try { return JSON.parse(toolCall?.function?.arguments || '{}'); }
    catch { return {}; }
  }, [toolCall?.function?.arguments]);

  const summaryText = useMemo(() => buildSummaryText(toolName, args), [toolName, args]);
  const diffStats = useMemo(() => calcDiffStats(toolName, args), [toolName, args]);
  const explanation = args.explanation || null;

  const isAwaitingApproval = status === 'awaiting_approval';
  const isDone = status === 'success' || status === 'failed' || status === 'cancelled';
  const isFailed = status === 'failed';
  const isRunning = !isAwaitingApproval && (status === 'running' || status === 'pending');
  const isCodeTool = CODE_TOOLS.has(toolName);
  const actionLabel = isDone ? meta.doneLabel : meta.label;

  const cleanStr = (s) => (s || '').replace(/[\ufeff\ufffe\u0000-\u0008\u000b\u000c\u000e-\u001f\uFFFD]/g, '');

  const codeContent = useMemo(() => {
    if (!isCodeTool) return null;
    return args.content || args.new_string || args.code || null;
  }, [isCodeTool, args]);

  React.useEffect(() => {
    if (isStreaming && codePreviewRef.current) {
      codePreviewRef.current.scrollTop = codePreviewRef.current.scrollHeight;
    }
  }, [isStreaming, codeContent]);

  const resultPreview = useMemo(() => {
    if (!result) return null;
    if (typeof result === 'string') return cleanStr(result).substring(0, 120);
    if (result.error) return cleanStr(result.error).substring(0, 120);
    if (result.stdout) return cleanStr(result.stdout).substring(0, 120);
    if (result.content) return cleanStr(typeof result.content === 'string' ? result.content : '').substring(0, 120);
    return null;
  }, [result]);

  return (
    <div className={`${isRunning || isStreaming ? 'tool-call-running' : ''}`}>
      {/* 主行 */}
      <div
        className={`flex items-center gap-1.5 px-1 py-[3px] rounded cursor-pointer transition-colors group
          ${isRunning || isStreaming ? 'tool-call-active-row' : ''}
          ${isFailed ? 'bg-red-950/10' : 'hover:bg-white/[0.03]'}`}
        onClick={() => setOpen(!open)}
      >
        {isStreaming ? (
          <Loader2 size={13} className="animate-spin text-zinc-400 shrink-0" />
        ) : isAwaitingApproval ? (
          toolCall?.riskLevel === 'high'
            ? <ShieldAlert size={13} className="text-red-400 shrink-0 animate-pulse" />
            : <ShieldCheck size={13} className="text-yellow-400 shrink-0 animate-pulse" />
        ) : isRunning ? (
          <Loader2 size={13} className="animate-spin text-zinc-500 shrink-0" />
        ) : isFailed ? (
          <X size={13} className="text-zinc-400 shrink-0" style={{ color: '#8a6060' }} />
        ) : isDone ? (
          <Check size={13} className="shrink-0" style={{ color: '#6b6b6b' }} />
        ) : null}

        <span className="text-[13px] font-medium shrink-0" style={{ color: isFailed ? '#8a6060' : meta.color }}>
          {actionLabel}
        </span>

        {summaryText && (
          <span className="text-[13px] text-zinc-400 truncate font-mono">
            {summaryText}
          </span>
        )}

        {/* Cursor 风格 diff 统计 +X -Y */}
        {diffStats && isDone && (
          <span className="text-[12px] font-mono shrink-0 flex items-center gap-1 ml-1">
            <span className="text-green-400">+{diffStats.added}</span>
            {diffStats.removed > 0 && <span className="text-red-400">-{diffStats.removed}</span>}
          </span>
        )}

        <div className="flex-1 min-w-0" />

        {isDone && (
          <span className="text-zinc-700 opacity-0 group-hover:opacity-100 transition-opacity">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        )}

        {elapsed != null && isDone && (
          <span className="text-[10px] text-zinc-600 tabular-nums shrink-0 flex items-center gap-0.5">
            <Clock size={9} />
            {elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`}
          </span>
        )}
      </div>

      {/* Cursor 风格 explanation 字幕 */}
      {explanation && !open && (
        <div className="pl-6 text-[11px] text-zinc-600 truncate leading-tight pb-0.5">
          {explanation}
        </div>
      )}

      {/* 审批操作栏 */}
      {isAwaitingApproval && (
        <div className={`ml-5 mr-1 mt-1 mb-1.5 flex items-center gap-2 px-3 py-2 rounded-md border ${
          toolCall?.riskLevel === 'high' ? 'bg-red-950/20 border-red-800/40' : 'bg-yellow-950/15 border-yellow-800/30'
        }`}>
          <span className={`text-[11px] flex-1 ${
            toolCall?.riskLevel === 'high' ? 'text-red-300/80' : 'text-yellow-300/70'
          }`}>
            {toolCall?.riskLevel === 'high' ? '高风险操作 — 请确认' : 'Agent 请求执行此操作'}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); onDeny?.(toolCall?.id); }}
            className="px-3 py-1 text-[11px] rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors"
          >
            拒绝
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onApprove?.(toolCall?.id); }}
            className={`px-3 py-1 text-[11px] rounded text-white transition-colors ${
              toolCall?.riskLevel === 'high' ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'
            }`}
          >
            允许
          </button>
        </div>
      )}

      {/* 流式代码预览 */}
      {(isStreaming || isRunning) && isCodeTool && codeContent && (
        <div className="ml-5 mr-1 mt-0.5 mb-1 rounded border border-zinc-800 bg-[#0d1117] overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1 border-b border-zinc-800/60 bg-[#161b22]">
            <span className="text-[9px] uppercase tracking-widest text-zinc-500">{args.path || args.file_path || ''}</span>
            <div className="flex-1" />
            {isStreaming && <span className="streaming-cursor streaming-cursor--code" />}
          </div>
          <pre
            ref={codePreviewRef}
            className="px-3 py-2 text-[11px] text-zinc-300 font-mono whitespace-pre-wrap break-all leading-relaxed max-h-[300px] overflow-y-auto"
          >
            {codeContent}
            {isStreaming && <span className="streaming-cursor streaming-cursor--code" />}
          </pre>
        </div>
      )}

      {/* Cursor 风格 diff 展开 — 完成后展示代码变更 */}
      {open && isDone && isCodeTool && codeContent && (
        <div className="ml-5 mr-1 mt-0.5 mb-1.5 rounded border border-zinc-800/60 bg-[#0d1117] overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800/40 bg-[#161b22]">
            <FileText size={11} className="text-zinc-500" />
            <span className="text-[11px] text-zinc-400 font-mono">{args.path || args.file_path || ''}</span>
            {diffStats && (
              <span className="text-[11px] font-mono flex items-center gap-1">
                <span className="text-green-400">+{diffStats.added}</span>
                {diffStats.removed > 0 && <span className="text-red-400">-{diffStats.removed}</span>}
              </span>
            )}
          </div>
          <pre className="px-3 py-2 text-[11px] font-mono whitespace-pre-wrap break-all leading-relaxed max-h-[300px] overflow-y-auto">
            {toolName === 'edit_file' && args.old_string != null ? (
              <>
                {args.old_string.split('\n').map((line, i) => (
                  <div key={`del-${i}`} className="text-red-300/80 bg-red-950/20">
                    <span className="text-red-500/60 select-none mr-1">-</span>{line}
                  </div>
                ))}
                {(args.new_string || '').split('\n').map((line, i) => (
                  <div key={`add-${i}`} className="text-green-300/80 bg-green-950/20">
                    <span className="text-green-500/60 select-none mr-1">+</span>{line}
                  </div>
                ))}
              </>
            ) : (
              <span className="text-zinc-300">{codeContent}</span>
            )}
          </pre>
        </div>
      )}

      {/* 非代码工具展开详情 */}
      {open && isDone && !isCodeTool && (
        <div className="ml-5 mr-1 mt-0.5 mb-1.5 rounded border border-zinc-800/60 bg-[#141414] overflow-hidden max-h-[240px] overflow-y-auto">
          <div className="px-3 py-2">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600 mb-1">参数</div>
            <pre className="text-[11px] text-zinc-400 font-mono whitespace-pre-wrap break-all leading-relaxed max-h-[100px] overflow-y-auto">
              {JSON.stringify(args, null, 2)}
            </pre>
          </div>
          {result && (
            <div className={`px-3 py-2 border-t border-zinc-800/40 ${isFailed ? 'bg-[#1a1515]' : 'bg-[#141414]'}`}>
              <div className="text-[9px] uppercase tracking-widest text-zinc-600 mb-1">结果</div>
              {resultPreview ? (
                <pre className={`text-[11px] font-mono whitespace-pre-wrap break-all leading-relaxed max-h-[100px] overflow-y-auto ${isFailed ? 'text-red-300/80' : 'text-green-300/70'}`}>
                  {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
                </pre>
              ) : (
                <span className={`text-[11px] ${isFailed ? 'text-red-300/60' : 'text-green-300/60'}`}>
                  {result.success ? '✓' : '✗'}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export { TOOL_META, EXPLORATION_TOOLS, CODE_TOOLS, extractFileName, buildSummaryText };
