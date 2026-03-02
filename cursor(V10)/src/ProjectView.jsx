import React, { useState, useEffect, useRef, useCallback, createContext, useContext } from 'react';
import { useDialog } from './components/DialogProvider';
import { isProjectRelated } from './components/RichAnswerRenderer';
import AskMessageCard from './components/AskMessageCard';
import AgentStatusBar from './components/AgentStatusBar';
import QuestionPanel from './components/QuestionPanel';
import ModeSwitchPanel from './components/ModeSwitchPanel';
import WorkflowExecutionPanel from './components/WorkflowExecutionPanel';
import './styles/chat-theme.css';
import './styles/ask-theme.css';
import {
    FileText, Folder, FolderOpen, Search, GitGraph, Settings, X,
    ChevronRight, ChevronDown, Terminal, Play, MoreHorizontal,
    MessageSquare, Copy, Check, LayoutTemplate, Bug, Files,
    Command, Send, ChevronUp, Minus, Square, Layout, Plus, Clock,
    Loader2, Infinity, Globe, Image as ImageIcon, Mic, ListTree, Brain,
    PanelLeft, PanelBottom, PanelRight, Activity, Download, Filter,
    AlertTriangle, Info, Trash2, FileDown, ClipboardCopy, Edit3, FileCode,
    Paperclip, Bell, BellRing, Volume2, VolumeX, Zap, Save
} from 'lucide-react';

// ============================================================
// 自定义 SVG 图标（匹配 Cursor 布局按钮）

// 左侧栏图标
const LayoutSidebarLeftIcon = ({ active }) => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2.75" y="4.75" width="18.5" height="14.5" rx="1.5" stroke={active ? '#c8c8c8' : '#5a5a5a'} strokeWidth="1.5" fill="none" />
        <rect x="3.5" y="5.5" width="5.5" height="13" rx="0.75" fill={active ? '#7a7a7a' : '#3a3a3a'} />
    </svg>
);

// 底部面板图标
const LayoutPanelBottomIcon = ({ active }) => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2.75" y="4.75" width="18.5" height="14.5" rx="1.5" stroke={active ? '#c8c8c8' : '#5a5a5a'} strokeWidth="1.5" fill="none" />
        <rect x="3.5" y="14.5" width="17" height="4" rx="0.75" fill={active ? '#7a7a7a' : '#3a3a3a'} />
    </svg>
);

// 右侧栏图标
const LayoutSidebarRightIcon = ({ active }) => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2.75" y="4.75" width="18.5" height="14.5" rx="1.5" stroke={active ? '#c8c8c8' : '#5a5a5a'} strokeWidth="1.5" fill="none" />
        <rect x="15" y="5.5" width="5.5" height="13" rx="0.75" fill={active ? '#7a7a7a' : '#3a3a3a'} />
    </svg>
);

// BrainIcon for model selector
const BrainIcon = () => (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[#555] inline">
        <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
        <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
    </svg>
);

// ============================================================
// 工具函数
// ============================================================

const getFileIcon = (filename) => {
    if (filename.endsWith('.js') || filename.endsWith('.jsx')) return <span className="text-yellow-400 font-semibold text-[10px] mr-1.5">JS</span>;
    if (filename.endsWith('.ts') || filename.endsWith('.tsx')) return <span className="text-blue-400 font-semibold text-[10px] mr-1.5">TS</span>;
    if (filename.endsWith('.json')) return <span className="text-yellow-200 font-semibold text-[10px] mr-1.5">{'{}'}</span>;
    if (filename.endsWith('.html')) return <span className="text-orange-500 font-semibold text-[10px] mr-1.5">&lt;&gt;</span>;
    if (filename.endsWith('.css') || filename.endsWith('.scss')) return <span className="text-blue-300 font-semibold text-[10px] mr-1.5">#</span>;
    if (filename.endsWith('.md')) return <span className="text-gray-300 font-semibold text-[10px] mr-1.5">MD</span>;
    if (filename.endsWith('.py')) return <span className="text-green-400 font-semibold text-[10px] mr-1.5">PY</span>;
    if (filename.startsWith('.git')) return <span className="text-red-400 font-semibold text-[10px] mr-1.5">git</span>;
    return <FileText size={12} className="text-gray-500 mr-1.5 flex-shrink-0" />;
};

const getLanguageDisplay = (filename) => {
    if (!filename) return 'Plain Text';
    const ext = filename.split('.').pop()?.toLowerCase();
    const map = {
        js: 'JavaScript', jsx: 'JavaScript React', ts: 'TypeScript', tsx: 'TypeScript React',
        json: 'JSON', html: 'HTML', css: 'CSS', scss: 'SCSS',
        md: 'Markdown', py: 'Python', yaml: 'YAML', yml: 'YAML',
        xml: 'XML', svg: 'XML', sh: 'Shell Script', bat: 'Batch',
    };
    return map[ext] || 'Plain Text';
};

const AT_REF_TOKEN_REGEX = /(^|\s)@([^\s@`"'，。！？；:]+)/g;
const AT_REF_MAX_FILES = 3;
const AT_REF_MAX_FOLDERS = 2;
const AT_REF_FILE_MAX_LINES = 140;
const AT_REF_CONTEXT_MAX_CHARS = 18000;

const normalizeAtRefPath = (raw) => {
    return String(raw || '')
        .trim()
        .replace(/^['"`]+|['"`]+$/g, '')
        .replace(/^[./\\]+/, '')
        .replace(/\\/g, '/')
        .replace(/\/{2,}/g, '/');
};

const isPathLikeAtRef = (token) => {
    if (!token) return false;
    if (token.includes('/') || token.includes('\\')) return true;
    if (/^[A-Za-z]:/.test(token)) return true;
    if (/^\.[A-Za-z0-9]/.test(token)) return true;
    return /\.[A-Za-z0-9_-]{1,12}$/.test(token);
};

const clipByLines = (content, maxLines = 120) => {
    const lines = String(content || '').split('\n');
    if (lines.length <= maxLines) {
        return { text: lines.join('\n'), truncated: false };
    }
    return {
        text: lines.slice(0, maxLines).join('\n'),
        truncated: true,
    };
};

const parseAtReferences = (text) => {
    const refs = [];
    const seen = new Set();
    const input = String(text || '');
    let m;
    while ((m = AT_REF_TOKEN_REGEX.exec(input)) !== null) {
        const raw = (m[2] || '').trim();
        if (!raw) continue;

        let type = null;
        let value = raw;
        const fileMatch = raw.match(/^file:(.+)$/i);
        const folderMatch = raw.match(/^folder:(.+)$/i);
        if (/^codebase$/i.test(raw)) {
            type = 'codebase';
            value = 'codebase';
        } else if (fileMatch) {
            type = 'file';
            value = fileMatch[1];
        } else if (folderMatch) {
            type = 'folder';
            value = folderMatch[1];
        } else if (raw.endsWith('/')) {
            type = 'folder';
            value = raw.slice(0, -1);
        } else if (isPathLikeAtRef(raw)) {
            type = 'file';
        }
        if (!type) continue;

        value = normalizeAtRefPath(value);
        if (type !== 'codebase' && !value) continue;

        const key = `${type}:${value.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ raw, type, value });
    }
    return refs;
};

const TAB_COMPLETION_METHODS = {
    javascript: ['map', 'filter', 'reduce', 'find', 'some', 'every', 'includes', 'slice', 'split', 'join', 'trim', 'toLowerCase', 'toUpperCase', 'push', 'pop'],
    typescript: ['map', 'filter', 'reduce', 'find', 'some', 'every', 'includes', 'slice', 'split', 'join', 'trim', 'toLowerCase', 'toUpperCase', 'push', 'pop'],
    python: ['append', 'extend', 'strip', 'split', 'join', 'lower', 'upper', 'items', 'keys', 'values', 'get'],
    java: ['length', 'substring', 'contains', 'equals', 'startsWith', 'endsWith', 'toString'],
    default: ['length', 'toString', 'trim', 'includes', 'split', 'slice'],
};

const guessEditorLanguage = (filename) => {
    const ext = String(filename || '').toLowerCase().split('.').pop();
    if (ext === 'js' || ext === 'jsx') return 'javascript';
    if (ext === 'ts' || ext === 'tsx') return 'typescript';
    if (ext === 'py') return 'python';
    if (ext === 'java') return 'java';
    return 'default';
};

const dedupeByInsert = (items) => {
    const seen = new Set();
    const out = [];
    for (const it of items) {
        const key = String(it.insertText || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(it);
    }
    return out;
};

const buildTabCompletion = (text, cursorPos, fileName) => {
    const source = String(text || '');
    const cursor = Math.max(0, Math.min(Number(cursorPos) || 0, source.length));
    const before = source.slice(0, cursor);
    const lineStart = before.lastIndexOf('\n') + 1;
    const linePrefix = before.slice(lineStart);
    const trimmedPrefix = linePrefix.replace(/^\s+/, '');
    if (!trimmedPrefix) return null;

    const language = guessEditorLanguage(fileName);
    const candidates = [];
    const tail = source.slice(cursor);

    const pairMap = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
    const lastChar = linePrefix.slice(-1);
    if (pairMap[lastChar]) {
        candidates.push({ insertText: pairMap[lastChar], score: 18, kind: 'pair' });
    }

    const dotMatch = linePrefix.match(/\.([A-Za-z_]*)$/);
    if (dotMatch) {
        const typed = dotMatch[1] || '';
        const methods = TAB_COMPLETION_METHODS[language] || TAB_COMPLETION_METHODS.default;
        for (const m of methods) {
            if (typed && !m.startsWith(typed)) continue;
            if (!typed && m.length < 3) continue;
            const suffix = `${m.slice(typed.length)}()`;
            if (suffix && suffix.length <= 40) {
                candidates.push({ insertText: suffix, score: 30 - suffix.length, kind: 'member' });
            }
        }
    }

    if (trimmedPrefix.length >= 2) {
        const scan = source.length > 120000 ? source.slice(0, 120000) : source;
        const lines = scan.split('\n');
        for (const ln of lines) {
            const t = ln.trim();
            if (!t || t === trimmedPrefix) continue;
            if (!t.startsWith(trimmedPrefix)) continue;
            let suffix = t.slice(trimmedPrefix.length);
            suffix = suffix.replace(/\s+$/, '');
            if (!suffix || suffix.length > 80) continue;
            candidates.push({ insertText: suffix, score: 22 - Math.min(20, suffix.length), kind: 'line' });
            if (candidates.length > 80) break;
        }
    }

    const wordMatch = linePrefix.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
    if (wordMatch) {
        const prefix = wordMatch[1];
        if (prefix.length >= 2) {
            const scan = source.length > 90000 ? source.slice(0, 90000) : source;
            const rx = /\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g;
            const freq = new Map();
            let m;
            while ((m = rx.exec(scan)) !== null) {
                const w = m[0];
                if (!w.startsWith(prefix) || w === prefix) continue;
                freq.set(w, (freq.get(w) || 0) + 1);
            }
            for (const [word, count] of freq.entries()) {
                const suffix = word.slice(prefix.length);
                if (!suffix || suffix.length > 30) continue;
                candidates.push({ insertText: suffix, score: 10 + Math.min(10, count), kind: 'word' });
            }
        }
    }

    const merged = dedupeByInsert(candidates)
        .filter(c => !tail.startsWith(c.insertText))
        .sort((a, b) => b.score - a.score);

    const best = merged[0];
    if (!best) return null;
    return {
        insertText: best.insertText,
        preview: best.insertText.replace(/\n/g, '\\n').slice(0, 60),
        kind: best.kind,
    };
};

// 绮剧畝 Tooltip
const WithTooltip = ({ children, text, side = 'right' }) => {
    const pos = {
        top: 'bottom-full left-1/2 -translate-x-1/2 mb-1',
        bottom: 'top-full left-1/2 -translate-x-1/2 mt-1',
        left: 'right-full top-1/2 -translate-y-1/2 mr-1',
        right: 'left-full top-1/2 -translate-y-1/2 ml-1',
    };
    return (
        <div className="group relative flex items-center justify-center">
            {children}
            <div className={`absolute ${pos[side]} hidden group-hover:flex bg-[#1a1a1a] border border-[#3a3a3a] text-[#bbb] text-[10px] px-1.5 py-0.5 rounded shadow-lg whitespace-nowrap z-[100] pointer-events-none select-none`}>
                {text}
            </div>
        </div>
    );
};

// ============================================================
// 全局日志服务（单例，挂载到 window 防止 HMR 重复创建）
// ============================================================
if (!window.__globalLogger) {
    let logs = [];
    let listeners = [];
    let idCounter = 0;
    const log = (level, source, message, detail = '') => {
        const entry = { id: ++idCounter, timestamp: new Date(), level, source, message, detail };
        logs.push(entry);
        if (logs.length > 5000) logs = logs.slice(-4000);
        listeners.forEach(fn => fn(entry));
        return entry;
    };
    window.__globalLogger = {
        info: (src, msg, d) => log('info', src, msg, d),
        warn: (src, msg, d) => log('warn', src, msg, d),
        error: (src, msg, d) => log('error', src, msg, d),
        debug: (src, msg, d) => log('debug', src, msg, d),
        success: (src, msg, d) => log('success', src, msg, d),
        getLogs: () => [...logs],
        clear: () => { logs = []; listeners.forEach(fn => fn(null)); },
        subscribe: (fn) => { listeners.push(fn); return () => { listeners = listeners.filter(l => l !== fn); }; },
    };
    window.__globalLogger.info('System', 'Application started', new Date().toLocaleString('zh-CN'));
}
const globalLogger = window.__globalLogger;
const notImplemented = (source, action, detail = '') => {
    globalLogger.warn(source, `${action} - not implemented, returning null`, detail);
    return null;
};

// ============================================================
// 全局监测面板
// ============================================================
const MonitorPanel = ({ onClose }) => {
    const [logs, setLogs] = useState(globalLogger.getLogs());
    const [filter, setFilter] = useState('all');
    const [keyword, setKeyword] = useState('');
    const [autoScroll, setAutoScroll] = useState(true);
    const [selectedRange, setSelectedRange] = useState({ start: null, end: null });
    const [selectMode, setSelectMode] = useState(false);
    const logEndRef = useRef(null);

    useEffect(() => {
        const unsub = globalLogger.subscribe(() => setLogs(globalLogger.getLogs()));
        return unsub;
    }, []);

    useEffect(() => {
        if (autoScroll && logEndRef.current) logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }, [logs, autoScroll]);

    const filteredLogs = logs.filter(l => {
        if (filter === 'agent') {
            if (!(l.source || '').startsWith('Agent:')) return false;
        } else if (filter !== 'all' && l.level !== filter) return false;
        if (keyword) {
            const kw = keyword.toLowerCase();
            if (!l.message.toLowerCase().includes(kw) && !l.source.toLowerCase().includes(kw) && !(l.detail || '').toLowerCase().includes(kw)) return false;
        }
        return true;
    });

    const getSelectedLogs = () => {
        if (!selectedRange.start || !selectedRange.end) return filteredLogs;
        const s = filteredLogs.findIndex(l => l.id === selectedRange.start);
        const e = filteredLogs.findIndex(l => l.id === selectedRange.end);
        if (s === -1 || e === -1) return filteredLogs;
        const [a, b] = s <= e ? [s, e] : [e, s];
        return filteredLogs.slice(a, b + 1);
    };

    const fmtLogs = (arr) => arr.map(l => {
        const ts = l.timestamp.toLocaleString('zh-CN', { hour12: false });
        return `[${ts}] [${l.level.toUpperCase()}] [${l.source}] ${l.message}${l.detail ? ' | ' + l.detail : ''}`;
    }).join('\n');

    const dlBlob = (blob, name) => {
        const u = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = u; a.download = name; document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(u);
    };

    const handleCopy = () => {
        const t = getSelectedLogs();
        navigator.clipboard?.writeText(fmtLogs(t));
        globalLogger.info('Monitor', `Copied ${t.length} log lines`);
    };

    const exportTxt = () => {
        const t = getSelectedLogs();
        dlBlob(new Blob([fmtLogs(t)], { type: 'text/plain;charset=utf-8' }), `logs_${Date.now()}.txt`);
        globalLogger.info('Monitor', `Exported TXT (${t.length})`);
    };

    const exportPdf = () => {
        const t = getSelectedLogs();
        const html = `<html><head><meta charset="utf-8"><title>日志</title><style>body{font:11px Consolas,monospace;background:#1e1e1e;color:#ccc;padding:20px}.error{color:#f44747}.warn{color:#cca700}.info{color:#3794ff}.debug{color:#888}.success{color:#4ec9b0}h1{font-size:15px;color:#fff;border-bottom:1px solid #333;padding-bottom:6px}.e{padding:2px 0;border-bottom:1px solid #2a2a2a}</style></head><body><h1>IDenty 日志 - ${new Date().toLocaleString('zh-CN')}</h1><p style="color:#888">${t.length} 条</p>${t.map(l => `<div class="e ${l.level}"><span style="color:#666">[${l.timestamp.toLocaleString('zh-CN', { hour12: false })}]</span> <b>[${l.level.toUpperCase()}]</b> <span style="color:#dcdcaa">[${l.source}]</span> ${l.message}${l.detail ? ` | <span style="color:#888">${l.detail}</span>` : ''}</div>`).join('')}</body></html>`;
        const w = window.open('', '_blank');
        w.document.write(html); w.document.close();
        w.onload = () => w.print();
        globalLogger.info('Monitor', `Opened PDF print view (${t.length})`);
    };

    const exportWord = () => {
        const t = getSelectedLogs();
        const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"></head><body style="font:10pt Consolas,monospace"><h2>IDenty 日志 - ${new Date().toLocaleString('zh-CN')}</h2><table border="1" cellpadding="3" cellspacing="0" style="border-collapse:collapse;font-size:9pt;width:100%"><tr style="background:#333;color:#fff"><th>时间</th><th>级别</th><th>来源</th><th>消息</th><th>详情</th></tr>${t.map(l => `<tr style="color:${l.level === 'error' ? '#f44747' : l.level === 'warn' ? '#cca700' : '#333'}"><td>${l.timestamp.toLocaleString('zh-CN', { hour12: false })}</td><td>${l.level.toUpperCase()}</td><td>${l.source}</td><td>${l.message}</td><td>${l.detail || ''}</td></tr>`).join('')}</table></body></html>`;
        dlBlob(new Blob([html], { type: 'application/msword' }), `logs_${Date.now()}.doc`);
        globalLogger.info('Monitor', `Exported Word (${t.length})`);
    };

    const handleLogClick = (id) => {
        if (!selectMode) return;
        if (!selectedRange.start) setSelectedRange({ start: id, end: null });
        else { setSelectedRange(p => ({ ...p, end: id })); setSelectMode(false); }
    };

    const isInRange = (id) => {
        if (!selectedRange.start || !selectedRange.end) return false;
        const ids = filteredLogs.map(l => l.id);
        const s = ids.indexOf(selectedRange.start), e = ids.indexOf(selectedRange.end), i = ids.indexOf(id);
        const [a, b] = s <= e ? [s, e] : [e, s];
        return i >= a && i <= b;
    };

    const lc = { info: { t: 'text-[#3794ff]', bg: 'bg-[#3794ff]/10', i: <Info size={11} /> }, warn: { t: 'text-[#cca700]', bg: 'bg-[#cca700]/10', i: <AlertTriangle size={11} /> }, error: { t: 'text-[#f44747]', bg: 'bg-[#f44747]/15', i: <Bug size={11} /> }, debug: { t: 'text-[#888]', bg: 'bg-[#888]/5', i: <Terminal size={11} /> }, success: { t: 'text-[#4ec9b0]', bg: 'bg-[#4ec9b0]/10', i: <Check size={11} /> } };
    const sts = { total: logs.length, error: logs.filter(l => l.level === 'error').length, warn: logs.filter(l => l.level === 'warn').length, info: logs.filter(l => l.level === 'info').length };
    const fbs = [
        { k: 'all', lb: '全部', c: logs.length },
        { k: 'error', lb: '错误', c: sts.error, cl: 'text-[#f44747]' },
        { k: 'warn', lb: '警告', c: sts.warn, cl: 'text-[#cca700]' },
        { k: 'info', lb: '信息', c: sts.info, cl: 'text-[#3794ff]' },
        { k: 'debug', lb: '调试', c: logs.filter(l => l.level === 'debug').length, cl: 'text-[#888]' },
        { k: 'success', lb: '成功', c: logs.filter(l => l.level === 'success').length, cl: 'text-[#4ec9b0]' },
        { k: 'agent', lb: 'Agent', c: logs.filter(l => (l.source || '').startsWith('Agent:')).length, cl: 'text-[#c586c0]' },
    ];

    return (
        <div className="flex-1 flex flex-col bg-[#1e1e1e] h-full overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-1.5 bg-[#252526] border-b border-[#1e1e1e] flex-shrink-0">
                <div className="flex items-center gap-2">
                    <Activity size={14} className="text-[#4ec9b0]" />
                    <span className="text-[12px] font-semibold text-white">全局监测</span>
                    <span className="text-[10px] text-[#666] ml-1">总 {sts.total} 条</span>
                </div>
                <div className="flex items-center gap-1">
                    <WithTooltip text="清空日志"><div className="p-1 rounded hover:bg-[#333] cursor-pointer text-[#888] hover:text-white" onClick={() => { globalLogger.clear(); setSelectedRange({ start: null, end: null }); }}><Trash2 size={12} /></div></WithTooltip>
                    <WithTooltip text="关闭"><div className="p-1 rounded hover:bg-[#333] cursor-pointer text-[#888] hover:text-white" onClick={onClose}><X size={12} /></div></WithTooltip>
                </div>
            </div>

            {/* 统计 */}
            <div className="flex items-center gap-2 px-3 py-1 bg-[#1e1e1e] border-b border-[#2a2a2a] flex-shrink-0">
                <div className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#f44747]/10 text-[#f44747] text-[10px] font-mono"><Bug size={10} /> {sts.error} 错误</div>
                <div className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#cca700]/10 text-[#cca700] text-[10px] font-mono"><AlertTriangle size={10} /> {sts.warn} 警告</div>
                <div className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#3794ff]/10 text-[#3794ff] text-[10px] font-mono"><Info size={10} /> {sts.info} 信息</div>
                <div className="text-[10px] text-[#555] ml-auto font-mono">显示 {filteredLogs.length}/{logs.length}</div>
            </div>

            {/* 工具栏 */}
            <div className="flex items-center gap-1 px-3 py-1 bg-[#252526] border-b border-[#2a2a2a] flex-shrink-0 flex-wrap">
                <div className="flex items-center gap-0.5 mr-2">
                    {fbs.map(fb => (
                        <button key={fb.k} className={`px-1.5 py-[2px] rounded text-[10px] transition-colors ${filter === fb.k ? 'bg-[#04395e] text-white' : `bg-[#2a2a2a] ${fb.cl || 'text-[#aaa]'} hover:bg-[#333]`}`} onClick={() => setFilter(fb.k)}>
                            {fb.lb}{fb.c > 0 && <span className="opacity-60 ml-0.5">{fb.c}</span>}
                        </button>
                    ))}
                </div>
                <div className="w-px h-4 bg-[#333] mx-1" />
                <div className="flex items-center bg-[#2a2a2a] rounded px-1.5 py-[2px] border border-[#3a3a3a] flex-1 min-w-[120px] max-w-[220px]">
                    <Search size={10} className="text-[#666] mr-1 flex-shrink-0" />
                    <input type="text" className="bg-transparent text-[10px] text-[#ccc] outline-none w-full placeholder-[#555]" placeholder="搜索日志..." value={keyword} onChange={e => setKeyword(e.target.value)} />
                    {keyword && <X size={9} className="text-[#666] cursor-pointer hover:text-white ml-1" onClick={() => setKeyword('')} />}
                </div>
                <div className="w-px h-4 bg-[#333] mx-1" />
                <WithTooltip text={selectMode ? '点击两条日志选择范围' : '选择范围'}>
                    <button className={`px-1.5 py-[2px] rounded text-[10px] ${selectMode ? 'bg-[#04395e] text-white' : 'bg-[#2a2a2a] text-[#aaa] hover:bg-[#333]'}`} onClick={() => { setSelectMode(!selectMode); setSelectedRange({ start: null, end: null }); }}>
                        <ListTree size={10} className="inline mr-0.5" />{selectMode ? '选择中...' : '选择范围'}
                    </button>
                </WithTooltip>
                {selectedRange.start && selectedRange.end && <span className="text-[9px] text-[#4ec9b0]">已选 {getSelectedLogs().length} 条</span>}
                <div className="w-px h-4 bg-[#333] mx-1" />
                <div className="flex items-center gap-0.5">
                    <button className="px-1.5 py-[2px] rounded text-[10px] bg-[#2a2a2a] text-[#aaa] hover:bg-[#333] hover:text-white" onClick={handleCopy}><ClipboardCopy size={10} className="inline mr-0.5" />澶嶅埗</button>
                    <button className="px-1.5 py-[2px] rounded text-[10px] bg-[#2a2a2a] text-[#aaa] hover:bg-[#333] hover:text-white" onClick={exportTxt}><FileDown size={10} className="inline mr-0.5" />TXT</button>
                    <button className="px-1.5 py-[2px] rounded text-[10px] bg-[#2a2a2a] text-[#aaa] hover:bg-[#333] hover:text-white" onClick={exportPdf}><FileDown size={10} className="inline mr-0.5" />PDF</button>
                    <button className="px-1.5 py-[2px] rounded text-[10px] bg-[#2a2a2a] text-[#aaa] hover:bg-[#333] hover:text-white" onClick={exportWord}><FileDown size={10} className="inline mr-0.5" />Word</button>
                </div>
                <div className="ml-auto">
                    <button className={`px-1.5 py-[2px] rounded text-[10px] ${autoScroll ? 'bg-[#04395e] text-white' : 'bg-[#2a2a2a] text-[#666]'}`} onClick={() => setAutoScroll(!autoScroll)}>Auto</button>
                </div>
            </div>

            {/* 日志列表 */}
            <div className="flex-1 overflow-y-auto custom-scrollbar font-mono text-[11px]">
                {filteredLogs.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-[#555]"><Activity size={32} className="mb-2 opacity-20" /><span className="text-[11px]">暂无日志</span></div>
                ) : (
                    filteredLogs.map(log => {
                        const c = lc[log.level] || lc.info;
                        const ts = log.timestamp.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                        const ms = String(log.timestamp.getMilliseconds()).padStart(3, '0');
                        const inR = isInRange(log.id);
                        const isEp = log.id === selectedRange.start || log.id === selectedRange.end;
                        return (
                            <div key={log.id} className={`flex items-start px-3 py-[2px] border-b border-[#1e1e1e] hover:bg-[#2a2d2e] cursor-default ${log.level === 'error' ? 'bg-[#f44747]/8' : ''} ${inR ? 'bg-[#04395e]/30' : ''} ${isEp ? 'ring-1 ring-[#007fd4]' : ''} ${selectMode ? 'cursor-pointer' : ''}`} onClick={() => handleLogClick(log.id)}>
                                <span className="text-[#555] w-[70px] flex-shrink-0 text-[10px]">{ts}.{ms}</span>
                                <span className={`w-[18px] flex-shrink-0 ${c.t}`}>{c.i}</span>
                                <span className={`w-[52px] flex-shrink-0 px-1 rounded text-[9px] font-bold uppercase ${c.t} ${c.bg} text-center leading-[16px]`}>{log.level}</span>
                                <span className="text-[#dcdcaa] w-[90px] flex-shrink-0 truncate text-[10px] px-1">{log.source}</span>
                                <span className={`flex-1 ${log.level === 'error' ? 'text-[#f44747]' : 'text-[#ccc]'}`}>{log.message}</span>
                                {log.detail && <span className="text-[#666] ml-2 text-[10px] truncate max-w-[200px]">{log.detail}</span>}
                            </div>
                        );
                    })
                )}
                <div ref={logEndRef} />
            </div>
        </div>
    );
};

// ============================================================
// 左侧活动栏（含监测按钮和资源管理器三态）
// ============================================================
const ActivityBar = ({ monitorActive, onToggleMonitor, explorerActive, onExplorerClick, onOpenSettings }) => (
    <div className="w-11 bg-[#333333] flex flex-col items-center py-1 text-[#858585] border-r border-[#1e1e1e] select-none z-20 flex-shrink-0">
        <WithTooltip text="资源管理器 (Ctrl+Shift+E)">
            <div
                className={`p-2.5 cursor-pointer transition-colors ${explorerActive ? 'text-white border-l-2 border-white' : 'hover:text-white'}`}
                onClick={onExplorerClick}
            >
                <Files size={20} />
            </div>
        </WithTooltip>
        <WithTooltip text="搜索 (Ctrl+Shift+F)">
            <div className="p-2.5 hover:text-white cursor-pointer" onClick={() => globalLogger.warn('ActivityBar', 'Search not implemented yet')}><Search size={20} /></div>
        </WithTooltip>
        <WithTooltip text="源代码管理 (Ctrl+Shift+G)">
            <div className="p-2.5 hover:text-white cursor-pointer" onClick={() => globalLogger.warn('ActivityBar', 'Source control not implemented yet')}><GitGraph size={20} /></div>
        </WithTooltip>
        <WithTooltip text="运行和调试 (Ctrl+Shift+D)">
            <div className="p-2.5 hover:text-white cursor-pointer" onClick={() => globalLogger.warn('ActivityBar', 'Run/Debug not implemented yet')}><Bug size={20} /></div>
        </WithTooltip>
        <WithTooltip text="扩展 (Ctrl+Shift+X)">
            <div className="p-2.5 hover:text-white cursor-pointer" onClick={() => globalLogger.warn('ActivityBar', 'Extensions not implemented yet')}><LayoutTemplate size={20} /></div>
        </WithTooltip>
        <WithTooltip text="全局监测">
            <div className={`p-2.5 cursor-pointer transition-colors ${monitorActive ? 'text-[#4ec9b0] border-l-2 border-[#4ec9b0]' : 'hover:text-white'}`} onClick={onToggleMonitor}>
                <Activity size={20} />
            </div>
        </WithTooltip>
        <div className="mt-auto">
            <WithTooltip text="管理">
                <div className="p-2.5 hover:text-white cursor-pointer" onClick={() => { globalLogger.info('ActivityBar', 'Open settings'); onOpenSettings?.(); }}><Settings size={20} /></div>
            </WithTooltip>
        </div>
    </div>
);

// ============================================================
// 右键上下文菜单
// ============================================================
const ContextMenu = ({ x, y, items, onClose }) => {
    const menuRef = useRef(null);

    useEffect(() => {
        const handler = (e) => {
            if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
        };
        document.addEventListener('mousedown', handler);
        document.addEventListener('contextmenu', handler);
        return () => {
            document.removeEventListener('mousedown', handler);
            document.removeEventListener('contextmenu', handler);
        };
    }, [onClose]);

    // 自动调整位置，防止溢出
    useEffect(() => {
        if (!menuRef.current) return;
        const rect = menuRef.current.getBoundingClientRect();
        if (rect.right > window.innerWidth) menuRef.current.style.left = `${window.innerWidth - rect.width - 4}px`;
        if (rect.bottom > window.innerHeight) menuRef.current.style.top = `${window.innerHeight - rect.height - 4}px`;
    }, [x, y]);

    return (
        <div
            ref={menuRef}
            className="fixed bg-[#252526] border border-[#3a3a3a] rounded-[3px] shadow-2xl py-[3px] z-[200] min-w-[200px] select-none"
            style={{ left: x, top: y }}
        >
            {items.map((item, i) => {
                if (item.type === 'separator') {
                    return <div key={i} className="h-[1px] bg-[#3a3a3a] my-[3px] mx-2" />;
                }
                return (
                    <div
                        key={i}
                        className={`flex items-center justify-between px-3 py-[3px] text-[12px] cursor-pointer transition-colors ${item.disabled
                            ? 'text-[#555] cursor-default'
                            : 'text-[#ccc] hover:bg-[#04395e] hover:text-white'
                            }`}
                        onClick={() => {
                            if (item.disabled) {
                                globalLogger.warn('ContextMenu', `${item.label} is disabled, skipped`);
                                return;
                            }
                            if (typeof item.action === 'function') {
                                item.action();
                            } else {
                                notImplemented('ContextMenu', item.label);
                            }
                            onClose();
                        }}
                    >
                        <span>{item.label}</span>
                        {item.shortcut && (
                            <span className={`text-[11px] ml-6 ${item.disabled ? 'text-[#444]' : 'text-[#888]'}`}>{item.shortcut}</span>
                        )}
                    </div>
                );

            })}
        </div>
    );
};

// 文件夹右键菜单项，绑定真实 Electron API
const getFolderContextMenu = (node, { onRefresh, projectPath, onOpenFile, onStartRename, dialog }) => {
    const dirPath = node.path || node.id;
    return [
        {
            label: 'New File...', action: async () => {
                const name = await dialog.prompt('请输入新文件名：');
                if (!name) return;
                const sep = dirPath.includes('/') ? '/' : '\\';
                const filePath = dirPath + sep + name;
                const r = await window.electronAPI?.createFile(filePath);
                if (r?.success) {
                    globalLogger.success('FileSystem', 'File created', filePath);
                    onRefresh?.();
                } else {
                    globalLogger.error('FileSystem', 'Create file failed', r?.error || 'unknown');
                    await dialog.alert('创建失败：' + (r?.error || '未知错误'));
                }
            }
        },
        {
            label: 'New Folder...', action: async () => {
                const name = await dialog.prompt('请输入新文件夹名：');
                if (!name) return;
                const sep = dirPath.includes('/') ? '/' : '\\';
                const folderPath = dirPath + sep + name;
                const r = await window.electronAPI?.createFolder(folderPath);
                if (r?.success) {
                    globalLogger.success('FileSystem', 'Folder created', folderPath);
                    onRefresh?.();
                } else {
                    globalLogger.error('FileSystem', 'Create folder failed', r?.error || 'unknown');
                    await dialog.alert('创建失败：' + (r?.error || '未知错误'));
                }
            }
        },
        { type: 'separator' },
        {
            label: 'Reveal in File Explorer', shortcut: 'Shift+Alt+R',
            action: () => { globalLogger.info('ContextMenu', 'Reveal folder in explorer', dirPath); window.electronAPI?.showInExplorer(dirPath); }
        },
        {
            label: 'Open in Terminal',
            action: () => { globalLogger.info('ContextMenu', 'Open terminal', dirPath); window.electronAPI?.openTerminal(dirPath); }
        },
        { type: 'separator' },
        {
            label: 'Copy Path', shortcut: 'Shift+Alt+C',
            action: () => { navigator.clipboard?.writeText(dirPath); }
        },
        {
            label: 'Copy Relative Path', shortcut: 'Ctrl+M Ctrl+Shift+C',
            action: () => {
                const rel = projectPath && dirPath.startsWith(projectPath) ? dirPath.slice(projectPath.length + 1) : dirPath;
                navigator.clipboard?.writeText(rel);
            }
        },
        { type: 'separator' },
        {
            label: 'Rename...', shortcut: 'F2',
            action: () => { onStartRename?.(node); }
        },
        {
            label: 'Delete', shortcut: 'Delete',
            action: async () => {
                if (!(await dialog.confirm(`确定删除文件夹 "${node.name}" 及其所有内容吗？`))) return;
                const r = await window.electronAPI?.deleteItem(dirPath);
                if (r?.success) {
                    globalLogger.success('FileSystem', 'Folder deleted', node.name);
                    onRefresh?.();
                } else {
                    globalLogger.error('FileSystem', 'Delete folder failed', r?.error || 'unknown');
                    await dialog.alert('删除失败：' + (r?.error || '未知错误'));
                }
            }
        },
    ];
};

const getFileContextMenu = (node, { onRefresh, projectPath, onOpenFile, onStartRename, dialog }) => {
    const filePath = node.path || node.id;
    return [
        {
            label: 'Open', shortcut: 'Ctrl+→',
            action: () => { onOpenFile?.(node); }
        },
        {
            label: 'Reveal in File Explorer', shortcut: 'Shift+Alt+R',
            action: () => { window.electronAPI?.showInExplorer(filePath); }
        },
        {
            label: 'Open in Terminal',
            action: () => {
                const sep = filePath.includes('/') ? '/' : '\\';
                const parentDir = filePath.substring(0, filePath.lastIndexOf(sep));
                window.electronAPI?.openTerminal(parentDir);
            }
        },
        { type: 'separator' },
        {
            label: 'Copy Path', shortcut: 'Shift+Alt+C',
            action: () => { navigator.clipboard?.writeText(filePath); }
        },
        {
            label: 'Copy Relative Path', shortcut: 'Ctrl+M Ctrl+Shift+C',
            action: () => {
                const rel = projectPath && filePath.startsWith(projectPath) ? filePath.slice(projectPath.length + 1) : filePath;
                navigator.clipboard?.writeText(rel);
            }
        },
        { type: 'separator' },
        {
            label: 'Rename...', shortcut: 'F2',
            action: () => { onStartRename?.(node); }
        },
        {
            label: 'Delete', shortcut: 'Delete',
            action: async () => {
                if (!(await dialog.confirm(`确定删除文件 "${node.name}" 吗？`))) return;
                const r = await window.electronAPI?.deleteItem(filePath);
                if (r?.success) {
                    globalLogger.success('FileSystem', 'File deleted', node.name);
                    onRefresh?.();
                } else {
                    globalLogger.error('FileSystem', 'Delete file failed', r?.error || 'unknown');
                    await dialog.alert('删除失败：' + (r?.error || '未知错误'));
                }
            }
        },
    ];
};

// ============================================================
// 非法文件名字符校验
// ============================================================
const INVALID_NAME_CHARS = /[\\/:*?"<>|]/;
const validateFileName = (name) => {
    if (!name || !name.trim()) return '名称不能为空';
    if (INVALID_NAME_CHARS.test(name)) return '名称包含非法字符 (\\/:*?"<>|)';
    if (name.trim() !== name) return '名称首尾不能有空格';
    return null;
};
const SidebarItem = ({ node, depth, onToggle, onSelect, activeFileId, onRefresh, projectPath }) => {
    const dialog = useDialog();
    const isSelected = activeFileId === node.id;
    const [contextMenu, setContextMenu] = useState(null);
    const [isRenaming, setIsRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState('');
    const renameInputRef = useRef(null);

    const startRename = useCallback((targetNode) => {
        setIsRenaming(true);
        setRenameValue(targetNode.name);
        globalLogger.debug('Rename', '进入重命名编辑状态', targetNode.name);
    }, []);

    const confirmRename = useCallback(async () => {
        const newName = renameValue.trim();
        const nodePath = node.path || node.id;
        const sep = nodePath.includes('/') ? '/' : '\\';
        const parentDir = nodePath.substring(0, nodePath.lastIndexOf(sep));

        if (newName === node.name) {
            globalLogger.debug('Rename', '名称未变化，取消重命名', node.name);
            setIsRenaming(false);
            return;
        }

        const err = validateFileName(newName);
        if (err) {
            globalLogger.error('Rename', `名称校验失败: ${err}`, newName);
            if (renameInputRef.current) {
                renameInputRef.current.style.outline = '1px solid #f44';
                setTimeout(() => {
                    if (renameInputRef.current) renameInputRef.current.style.outline = '1px solid #007acc';
                }, 800);
            }
            return;
        }

        const newPath = parentDir + sep + newName;
        globalLogger.info('Rename', `提交重命名: ${node.name} -> ${newName}`, nodePath);

        try {
            const result = await window.electronAPI?.rename(nodePath, newPath);
            if (result?.success) {
                globalLogger.success('Rename', `重命名成功: ${node.name} -> ${newName}`, newPath);
                setIsRenaming(false);
                onRefresh();
            } else {
                const codeMap = {
                    E_EXISTS: '目标已存在',
                    E_NOT_FOUND: '源文件不存在',
                    E_LOCKED: '文件被占用',
                };
                const msg = codeMap[result?.code] || result?.error || '未知错误';
                globalLogger.error('Rename', `重命名失败 [${result?.code || 'E_UNKNOWN'}]`, msg);
                if (renameInputRef.current) {
                    renameInputRef.current.style.outline = '1px solid #f44';
                    setTimeout(() => {
                        if (renameInputRef.current) renameInputRef.current.style.outline = '1px solid #007acc';
                    }, 1200);
                }
            }
        } catch (ex) {
            globalLogger.error('Rename', '重命名 IPC 异常', ex?.message || String(ex));
            setIsRenaming(false);
        }
    }, [renameValue, node, onRefresh]);

    const cancelRename = useCallback(() => {
        globalLogger.debug('Rename', '取消重命名', node.name);
        setIsRenaming(false);
        setRenameValue('');
    }, [node.name]);

    const handleRenameKeyDown = useCallback((e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            confirmRename();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelRename();
        }
    }, [confirmRename, cancelRename]);

    useEffect(() => {
        if (isRenaming && renameInputRef.current) {
            renameInputRef.current.focus();
            const dotIndex = node.type === 'file' ? renameValue.lastIndexOf('.') : -1;
            if (dotIndex > 0) {
                renameInputRef.current.setSelectionRange(0, dotIndex);
            } else {
                renameInputRef.current.select();
            }
        }
    }, [isRenaming, renameValue, node.type]);

    const ctx = { onRefresh, projectPath, onOpenFile: onSelect, onStartRename: startRename, dialog };

    const handleContextMenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const items = node.type === 'folder' ? getFolderContextMenu(node, ctx) : getFileContextMenu(node, ctx);
        setContextMenu({ x: e.clientX, y: e.clientY, items });
    };

    return (
        <div className="select-none">
            <div
                className={`flex items-center py-[2px] px-1 cursor-pointer hover:bg-[#2a2d2e] ${isSelected ? 'bg-[#37373d] text-white' : 'text-[#ccc]'}`}
                style={{ paddingLeft: `${depth * 10 + 8}px` }}
                onClick={() => {
                    if (isRenaming) return;
                    if (node.type === 'folder') onToggle(node.id);
                    else onSelect(node);
                }}
                onContextMenu={handleContextMenu}
                onDoubleClick={(e) => {
                    if (node.type === 'file') {
                        e.stopPropagation();
                        startRename(node);
                    }
                }}
            >
                {node.type === 'folder' && (
                    <span className="mr-0.5 text-gray-500">
                        {node.isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </span>
                )}
                {node.type === 'file' && getFileIcon(node.name)}

                {isRenaming ? (
                    <input
                        ref={renameInputRef}
                        className="text-[12px] leading-tight bg-[#3c3c3c] text-white px-1 py-0 border-0 rounded-sm flex-1 min-w-0"
                        style={{ outline: '1px solid #007acc', fontFamily: 'inherit' }}
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={handleRenameKeyDown}
                        onBlur={cancelRename}
                        onClick={(e) => e.stopPropagation()}
                        spellCheck={false}
                    />
                ) : (
                    <span className="text-[12px] truncate leading-tight">{node.name}</span>
                )}
            </div>
            {node.type === 'folder' && node.isOpen && node.children && (
                <div>
                    {node.children.map(child => (
                        <SidebarItem
                            key={child.id}
                            node={child}
                            depth={depth + 1}
                            onToggle={onToggle}
                            onSelect={onSelect}
                            activeFileId={activeFileId}
                            onRefresh={onRefresh}
                            projectPath={projectPath}
                        />
                    ))}
                </div>
            )}
            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    items={contextMenu.items}
                    onClose={() => setContextMenu(null)}
                />
            )}
        </div>
    );
};

// ============================================================
// 文件资源管理器（含标题栏菜单）
// ============================================================
const FileExplorer = ({ fileTree, onToggle, onSelect, activeFileId, projectName, style, onRefresh, projectPath, onCollapseAll, onNewFile, onNewFolder }) => {
    const dialog = useDialog();
    const [menuOpen, setMenuOpen] = useState(false);
    const [rootCollapsed, setRootCollapsed] = useState(false);
    const menuBtnRef = useRef(null);

    const explorerMenuItems = [
        {
            label: '新建文件...',
            action: async () => {
                const name = await dialog.prompt('请输入新文件名：');
                if (!name) return;
                globalLogger.info('ExplorerMenu', '新建文件', name);
                onNewFile?.(name);
            },
        },
        {
            label: '新建文件夹...',
            action: async () => {
                const name = await dialog.prompt('请输入新文件夹名：');
                if (!name) return;
                globalLogger.info('ExplorerMenu', '新建文件夹', name);
                onNewFolder?.(name);
            },
        },
        { type: 'separator' },
        {
            label: '刷新文件树',
            action: () => {
                globalLogger.info('ExplorerMenu', '刷新文件树');
                onRefresh?.();
            },
        },
        {
            label: '全部折叠',
            action: () => {
                globalLogger.info('ExplorerMenu', '全部折叠');
                onCollapseAll?.();
            },
        },
    ];

    return (
        <div className="bg-[#252526] flex flex-col h-full text-[#ccc] overflow-hidden flex-shrink-0" style={style}>
            <div className="px-3 py-1 text-[10px] font-bold tracking-wider flex justify-between items-center group uppercase">
                <span>Explorer</span>
                <div
                    ref={menuBtnRef}
                    onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpen(true);
                        globalLogger.info('Explorer', '打开标题栏菜单');
                    }}
                >
                    <MoreHorizontal size={14} className="opacity-0 group-hover:opacity-100 hover:text-white" />
                </div>
            </div>
            {menuOpen && menuBtnRef.current && (
                <ContextMenu
                    x={menuBtnRef.current.getBoundingClientRect().right}
                    y={menuBtnRef.current.getBoundingClientRect().bottom + 2}
                    items={explorerMenuItems}
                    onClose={() => setMenuOpen(false)}
                />
            )}
            <div className="overflow-y-auto flex-1 custom-scrollbar">
                <div
                    className="px-1 py-0.5 font-bold text-[10px] flex items-center cursor-pointer hover:bg-[#2a2d2e] uppercase tracking-wide"
                    onClick={() => {
                        setRootCollapsed((prev) => !prev);
                        globalLogger.info('Explorer', rootCollapsed ? '展开项目树' : '折叠项目树', projectName);
                    }}
                >
                    {rootCollapsed ? <ChevronRight size={12} className="mr-0.5" /> : <ChevronDown size={12} className="mr-0.5" />}
                    {projectName}
                </div>
                {!rootCollapsed && fileTree.length > 0 && fileTree[0].children?.map(node => (
                    <SidebarItem
                        key={node.id}
                        node={node}
                        depth={1}
                        onToggle={onToggle}
                        onSelect={onSelect}
                        activeFileId={activeFileId}
                        onRefresh={onRefresh}
                        projectPath={projectPath}
                    />
                ))}
            </div>
        </div>
    );
};

// ============================================================
// 编辑器标签栏
// ============================================================
const EditorTabs = ({ files, activeId, onSelect, onClose }) => (
    <div className="flex bg-[#252526] overflow-x-auto h-[30px]" style={{ scrollbarWidth: 'none' }}>
        {files.map(file => (
            <div
                key={file.id}
                className={`flex items-center px-2.5 min-w-[100px] max-w-[180px] text-[11px] border-r border-[#1e1e1e] cursor-pointer group select-none
                    ${activeId === file.id ? 'bg-[#1e1e1e] text-white border-t border-t-[#007fd4]' : 'bg-[#2d2d2d] text-[#969696] hover:bg-[#252526]'}`}
                onClick={() => onSelect(file.id)}
            >
                <span className="mr-1.5">{getFileIcon(file.name)}</span>
                <span className="truncate flex-1 text-[11px]">{file.name}</span>
                <span
                    className={`ml-1.5 p-0.5 rounded hover:bg-[#444] ${activeId === file.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                    onClick={(e) => onClose(e, file.id)}
                >
                    <X size={12} />
                </span>
            </div>
        ))}
    </div>
);

// ============================================================
// 代码编辑器（高密度，紧凑行高）
// ============================================================
const CodeEditor = ({ file, content, projectName, onContentChange, onSave, isDirty }) => {
    const text = typeof content === 'string' ? content : '';
    const textareaRef = useRef(null);
    const lineNoRef = useRef(null);
    const [cursorPos, setCursorPos] = useState(0);
    const [completion, setCompletion] = useState(null);
    const [saveState, setSaveState] = useState('idle'); // idle | saving | saved | error
    const [saveMessage, setSaveMessage] = useState('');

    useEffect(() => {
        setCursorPos(0);
        setCompletion(null);
        setSaveState('idle');
        setSaveMessage('');
    }, [file?.id]);

    const refreshCompletion = useCallback((nextText, pos) => {
        if (!file?.id) {
            setCompletion(null);
            return;
        }
        const next = buildTabCompletion(nextText, pos, file.name);
        setCompletion(next);
    }, [file?.id, file?.name]);

    const syncScroll = useCallback(() => {
        if (lineNoRef.current && textareaRef.current) {
            lineNoRef.current.scrollTop = textareaRef.current.scrollTop;
        }
    }, []);

    const handleChange = useCallback((e) => {
        const value = e.target.value;
        const pos = e.target.selectionStart || 0;
        onContentChange?.(file.id, value);
        setCursorPos(pos);
        refreshCompletion(value, pos);
    }, [file?.id, onContentChange, refreshCompletion]);

    const handleSelect = useCallback((e) => {
        const pos = e.target.selectionStart || 0;
        setCursorPos(pos);
        refreshCompletion(e.target.value, pos);
    }, [refreshCompletion]);

    const applyInsert = useCallback((insertText) => {
        if (!textareaRef.current || !file?.id || !insertText) return false;
        const ta = textareaRef.current;
        const start = ta.selectionStart || 0;
        const end = ta.selectionEnd || 0;
        const nextText = text.slice(0, start) + insertText + text.slice(end);
        const nextPos = start + insertText.length;
        onContentChange?.(file.id, nextText);
        setCursorPos(nextPos);
        setCompletion(null);
        requestAnimationFrame(() => {
            if (!textareaRef.current) return;
            textareaRef.current.focus();
            textareaRef.current.setSelectionRange(nextPos, nextPos);
        });
        return true;
    }, [file?.id, onContentChange, text]);

    const runSave = useCallback(async () => {
        if (!file?.id || !onSave) return;
        setSaveState('saving');
        setSaveMessage('');
        const result = await onSave(file);
        if (result?.success) {
            setSaveState('saved');
            setSaveMessage('Saved');
            setTimeout(() => {
                setSaveState((prev) => (prev === 'saved' ? 'idle' : prev));
                setSaveMessage((prev) => (prev === 'Saved' ? '' : prev));
            }, 1400);
        } else {
            setSaveState('error');
            setSaveMessage(result?.error || 'Save failed');
        }
    }, [file, onSave]);

    const handleKeyDown = useCallback((e) => {
        if (!file?.id || !textareaRef.current) return;

        if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
            e.preventDefault();
            runSave();
            return;
        }

        if (e.key === 'Escape') {
            setCompletion(null);
            return;
        }

        if (e.key !== 'Tab') return;
        e.preventDefault();

        const ta = textareaRef.current;
        const start = ta.selectionStart || 0;
        const end = ta.selectionEnd || 0;
        if (start !== end) {
            applyInsert('  ');
            return;
        }

        if (completion?.insertText) {
            const tail = text.slice(start);
            if (tail.startsWith(completion.insertText)) {
                const nextPos = start + completion.insertText.length;
                setCursorPos(nextPos);
                requestAnimationFrame(() => {
                    if (!textareaRef.current) return;
                    textareaRef.current.focus();
                    textareaRef.current.setSelectionRange(nextPos, nextPos);
                });
                setCompletion(null);
                return;
            }
            applyInsert(completion.insertText);
            return;
        }

        applyInsert('  ');
    }, [applyInsert, completion, file?.id, runSave, text]);

    if (!file) {
        return (
            <div className="flex-1 bg-[#1e1e1e] flex flex-col items-center justify-center text-gray-600">
                <Command size={48} className="mb-3 opacity-15" />
                <p className="text-[11px]">选择一个文件开始编辑</p>
                <div className="text-[10px] mt-3 flex gap-3 text-gray-700">
                    <span><span className="bg-[#333] px-1 rounded text-[9px]">Ctrl</span> + <span className="bg-[#333] px-1 rounded text-[9px]">P</span> 搜索文件</span>
                </div>
            </div>
        );
    }

    const lines = text.split('\n');
    const breadcrumbs = file.path ? file.path.split('\\').slice(-3) : [file.name];
    const dirty = !!isDirty;

    return (
        <div className="flex-1 bg-[#1e1e1e] text-[#d4d4d4] font-mono text-[12px] overflow-hidden relative">
            <div className="sticky top-0 left-0 right-0 bg-[#1e1e1e] px-3 py-0.5 text-[10px] text-[#969696] flex items-center justify-between z-10 border-b border-[#1e1e1e]">
                <div className="flex items-center min-w-0">
                    {breadcrumbs.map((part, i) => (
                        <React.Fragment key={i}>
                            {i > 0 && <ChevronRight size={10} className="mx-0.5 text-[#555]" />}
                            <span className={i === breadcrumbs.length - 1 ? 'text-[#ccc] truncate max-w-[220px]' : ''}>{part}</span>
                        </React.Fragment>
                    ))}
                </div>
                <div className="flex items-center gap-2 ml-2">
                    <span className={`text-[9px] ${dirty ? 'text-amber-400' : 'text-[#666]'}`}>
                        {saveState === 'saving' ? 'Saving...' : saveState === 'error' ? 'Save failed' : dirty ? 'Unsaved' : 'Saved'}
                    </span>
                    <button
                        type="button"
                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] transition-colors ${dirty ? 'border-[#3a3a3a] text-[#bbb] hover:bg-[#2a2a2a]' : 'border-[#2a2a2a] text-[#666] cursor-default'}`}
                        onClick={runSave}
                        disabled={!dirty || saveState === 'saving'}
                        title="Save (Ctrl+S)"
                    >
                        <Save size={10} />
                        <span>Save</span>
                    </button>
                </div>
            </div>

            <div className="flex h-[calc(100%-22px)] p-2 pt-1 overflow-hidden">
                <div
                    ref={lineNoRef}
                    className="flex flex-col items-end pr-3 text-[#5a5a5a] select-none min-w-[40px] text-right text-[11px] leading-[18px] overflow-hidden"
                >
                    {lines.map((_, i) => (
                        <div key={i} className="leading-[18px]">{i + 1}</div>
                    ))}
                </div>
                <textarea
                    ref={textareaRef}
                    value={text}
                    wrap="off"
                    spellCheck={false}
                    onChange={handleChange}
                    onSelect={handleSelect}
                    onClick={handleSelect}
                    onKeyDown={handleKeyDown}
                    onScroll={syncScroll}
                    className="flex-1 bg-transparent outline-none resize-none text-[#d4d4d4] leading-[18px] whitespace-pre overflow-auto"
                    style={{ tabSize: 2 }}
                />
            </div>

            {completion?.preview && (
                <div className="absolute bottom-2 right-3 px-2 py-1 rounded bg-[#141414] border border-[#2e2e2e] text-[10px] text-[#9ba2ad] max-w-[420px] truncate">
                    <span className="text-[#6b93c5] mr-1">Tab</span>
                    <span className="text-[#777] mr-1">accept:</span>
                    <span>{completion.preview}</span>
                </div>
            )}

            {saveMessage && saveState === 'error' && (
                <div className="absolute bottom-2 left-3 px-2 py-1 rounded bg-[#2a1515] border border-[#5a2a2a] text-[10px] text-[#f0a2a2] max-w-[420px] truncate">
                    {saveMessage}
                </div>
            )}
        </div>
    );
};

// ============================================================
// 历史会话面板
// ============================================================
const HistoryPanel = ({ sessions, activeId, onSelect, onRename, onDelete, onClose }) => {
    const dialog = useDialog();
    const [search, setSearch] = useState('');
    const [editingId, setEditingId] = useState(null);
    const [editTitle, setEditTitle] = useState('');
    const filtered = sessions.filter(s => s.title.toLowerCase().includes(search.toLowerCase()));
    const handleRenameStart = (s) => { setEditingId(s.id); setEditTitle(s.title); };
    const handleRenameConfirm = () => { if (editTitle.trim() && editingId) onRename(editingId, editTitle.trim()); setEditingId(null); };
    return (
        <div className="absolute inset-0 bg-[#1e1e1e] z-50 flex flex-col animate-fade-in">
            <div className="h-[28px] flex items-center justify-between px-2 border-b border-[#333] flex-shrink-0">
                <span className="text-[10px] uppercase font-semibold text-[#999] tracking-wider">历史会话</span>
                <div className="p-[3px] rounded hover:bg-[#333] cursor-pointer text-[#888] hover:text-white" onClick={onClose}><X size={14} /></div>
            </div>
            <div className="px-2 py-1.5">
                <input type="text" className="w-full bg-[#141414] border border-[#2a2a2a] rounded px-2 py-1 text-[10px] text-[#ccc] outline-none focus:border-[#444] placeholder-[#444]" placeholder="搜索会话..." value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar">
                {filtered.length === 0 ? (
                    <div className="px-3 py-6 text-center text-[10px] text-[#555]">{search ? '未找到匹配会话' : '暂无历史会话'}</div>
                ) : filtered.map(s => (
                    <div key={s.id} className={`px-2 py-1.5 flex items-center gap-1 border-b border-[#252525] cursor-pointer transition-colors group ${s.id === activeId ? 'bg-[#2a2d2e]' : 'hover:bg-[#252525]'}`} onClick={() => { onSelect(s.id); onClose(); }}>
                        <div className="flex-1 min-w-0">
                            {editingId === s.id ? (
                                <input className="w-full bg-[#141414] border border-[#444] rounded px-1 py-0.5 text-[10px] text-[#ccc] outline-none" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} onBlur={handleRenameConfirm} onKeyDown={(e) => { if (e.key === 'Enter') handleRenameConfirm(); if (e.key === 'Escape') setEditingId(null); }} onClick={(e) => e.stopPropagation()} autoFocus />
                            ) : (
                                <>
                                    <div className="text-[10px] text-[#bbb] truncate">{s.title}</div>
                                    <div className="text-[9px] text-[#555] mt-0.5 flex gap-2">
                                        <span>{s.messageCount || 0} 条消息</span>
                                        <span>{new Date(s.updatedAt).toLocaleDateString('zh-CN')}</span>
                                    </div>
                                </>
                            )}
                        </div>
                        <div className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                            <div className="p-0.5 rounded hover:bg-[#333] text-[#666] hover:text-[#aaa] cursor-pointer" onClick={() => handleRenameStart(s)}><Edit3 size={10} /></div>
                            <div
                                className="p-0.5 rounded hover:bg-[#3a1a1a] text-[#666] hover:text-red-400 cursor-pointer"
                                onClick={async () => {
                                    if (await dialog.confirm(`确定删除会话「${s.title}」吗？`)) onDelete(s.id);
                                }}
                            >
                                <Trash2 size={10} />
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

// ============================================================
// 更多操作菜单
// ============================================================
const MoreActionsMenu = ({ onRename, onClear, onExportJSON, onExportTXT, onExportMD, onExportPDF, onDelete, onClose }) => {
    const ref = useRef(null);
    useEffect(() => {
        const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);
    const items = [
        { label: '重命名会话', icon: <Edit3 size={12} />, action: onRename },
        { label: '清空消息', icon: <Trash2 size={12} />, action: onClear, warn: true },
        { divider: true },
        { label: '导出为 JSON', icon: <FileCode size={12} />, action: onExportJSON },
        { label: '导出为 TXT', icon: <FileText size={12} />, action: onExportTXT },
        { label: '导出为 Markdown', icon: <FileText size={12} />, action: onExportMD },
        { label: '导出为 PDF', icon: <FileText size={12} />, action: onExportPDF },
        { divider: true },
        { label: '删除当前会话', icon: <Trash2 size={12} />, action: onDelete, danger: true },
    ];
    return (
        <div ref={ref} className="absolute top-[28px] right-1 w-[160px] bg-[#1a1a1a] border border-[#2a2a2a] rounded-md shadow-xl z-50 py-0.5 animate-fade-in">
            {items.map((item, i) => item.divider ? (
                <div key={i} className="border-t border-[#252525] my-0.5" />
            ) : (
                <div key={i} className={`flex items-center gap-2 px-2.5 py-[5px] cursor-pointer text-[10px] transition-colors ${item.danger ? 'text-red-400 hover:bg-red-900/30' : item.warn ? 'text-yellow-400 hover:bg-yellow-900/20' : 'text-[#bbb] hover:bg-[#252525] hover:text-white'}`} onClick={() => { item.action(); onClose(); }}>
                    {item.icon}<span>{item.label}</span>
                </div>
            ))}
        </div>
    );
};

// ============================================================
// AI 聊天面板
// ============================================================
const AIPanel = ({ history, onSend, onClose, sessionTitle, onNewChat, onOpenHistory, onOpenMoreActions, historyOpen, moreActionsOpen, sessions, activeSessionId, onSelectSession, onRenameSession, onDeleteSession, onCloseHistory, onCloseMoreActions, onRenameCurrentSession, onClearMessages, onExportJSON, onExportTXT, onExportMD, onExportPDF, onDeleteCurrentSession, chatMode, onModeChange, isGenerating, generatingStartTime, onStopGeneration, projectPath, autoExecute, onStepApplied, onEditMessage, agentState, agentIteration, agentToolCallCount, agentActiveToolName, agentParallelInfo, agentStateStartTime, onAgentApprove, onAgentDeny, pendingQuestion, onQuestionSubmit, onQuestionCancel, pendingModeSwitch, onModeSwitchApprove, onModeSwitchReject }) => {
    const [input, setInput] = useState('');
    const [askMenuOpen, setAskMenuOpen] = useState(false);
    const [modelMenuOpen, setModelMenuOpen] = useState(false);
    const [savedModels, setSavedModels] = useState([]);
    const [currentModel, setCurrentModel] = useState(null);
    const [attachments, setAttachments] = useState([]);
    const [isDragOver, setIsDragOver] = useState(false);
    const [webSearchEnabled, setWebSearchEnabled] = useState(false);
    const [panelWidth, setPanelWidth] = useState(320);
    const panelRef = useRef(null);
    const fileInputRef = useRef(null);
    const mode = chatMode || 'agent';
    const setMode = (m) => { if (typeof onModeChange === 'function') onModeChange(m); };

    // ============================================================
    // Agent 完成提醒功能
    // ============================================================
    // alertMode: 'off' | 'all' | 'selective'
    // off = 关闭提醒
    // all = 所有 Agent 任务完成后自动提醒
    // selective = 每次发送前可选择是否提醒
    const [alertMode, setAlertMode] = useState(() => {
        try { return localStorage.getItem('agent_alert_mode') || 'off'; } catch { return 'off'; }
    });
    // alertType: 'gentle' | 'persistent'
    // gentle = 轻提示（短铃声，播放一次）
    // persistent = 持续提醒（循环播放直到用户停止）
    const [alertType, setAlertType] = useState(() => {
        try { return localStorage.getItem('agent_alert_type') || 'gentle'; } catch { return 'gentle'; }
    });
    // selective 模式下，当前任务是否启用提醒
    const [alertThisTask, setAlertThisTask] = useState(false);
    const [alertMenuOpen, setAlertMenuOpen] = useState(false);
    const alertMenuRef = useRef(null);
    const alertAudioRef = useRef(null);
    const [isAlertPlaying, setIsAlertPlaying] = useState(false);
    const prevAgentStateRef = useRef('idle');

    // 持久化提醒设置
    useEffect(() => {
        try { localStorage.setItem('agent_alert_mode', alertMode); } catch { }
    }, [alertMode]);
    useEffect(() => {
        try { localStorage.setItem('agent_alert_type', alertType); } catch { }
    }, [alertType]);

    // 点击菜单外区域时关闭菜单
    useEffect(() => {
        const handler = (e) => {
            if (alertMenuRef.current && !alertMenuRef.current.contains(e.target)) setAlertMenuOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    // 使用 Web Audio API 合成提醒音效（不依赖外部音频文件）
    const playAlertSound = useCallback((type) => {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const playTone = (freq, startTime, duration, gain = 0.15) => {
                const osc = ctx.createOscillator();
                const g = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, startTime);
                g.gain.setValueAtTime(0, startTime);
                g.gain.linearRampToValueAtTime(gain, startTime + 0.02);
                g.gain.linearRampToValueAtTime(gain * 0.7, startTime + duration * 0.6);
                g.gain.linearRampToValueAtTime(0, startTime + duration);
                osc.connect(g);
                g.connect(ctx.destination);
                osc.start(startTime);
                osc.stop(startTime + duration);
            };

            if (type === 'gentle') {
                // 轻提示三音阶
                const now = ctx.currentTime;
                playTone(880, now, 0.15, 0.12);       // A5
                playTone(1100, now + 0.15, 0.15, 0.12); // C#6
                playTone(1320, now + 0.30, 0.25, 0.10); // E6
                setTimeout(() => ctx.close(), 1000);
            } else {
                // 持续提醒：循环播放直到用户手动停止
                setIsAlertPlaying(true);
                let stopped = false;
                const playLoop = () => {
                    if (stopped) { ctx.close(); return; }
                    const now = ctx.currentTime;
                    // 双音交替
                    for (let i = 0; i < 4; i++) {
                        playTone(880, now + i * 0.5, 0.12, 0.18);
                        playTone(1200, now + i * 0.5 + 0.15, 0.12, 0.18);
                        playTone(880, now + i * 0.5 + 0.30, 0.12, 0.15);
                    }
                    setTimeout(() => playLoop(), 2500);
                };
                playLoop();
                alertAudioRef.current = { stop: () => { stopped = true; setIsAlertPlaying(false); try { ctx.close(); } catch { } } };
            }
        } catch (e) {
            console.warn('Alert sound failed:', e);
        }
    }, []);

    const stopAlertSound = useCallback(() => {
        if (alertAudioRef.current?.stop) {
            alertAudioRef.current.stop();
            alertAudioRef.current = null;
        }
        setIsAlertPlaying(false);
    }, []);

    // 监听 Agent 状态变化，在任务结束时触发提醒
    useEffect(() => {
        const prev = prevAgentStateRef.current;
        prevAgentStateRef.current = agentState;

        // 仅在从活跃状态回到 idle 时检查（即任务完成）
        if (prev !== 'idle' && prev !== undefined && agentState === 'idle') {
            const shouldAlert = alertMode === 'all' || (alertMode === 'selective' && alertThisTask);
            if (shouldAlert) {
                playAlertSound(alertType);
                if (alertMode === 'selective') setAlertThisTask(false);
            }
        }
    }, [agentState, alertMode, alertType, alertThisTask, playAlertSound]);

    // 初始化时读取联网开关配置
    useEffect(() => {
        (async () => {
            try {
                const r = await window.electronAPI?.modeConfigGet();
                if (r?.success) setWebSearchEnabled(r.data?.webSearch?.enabled ?? false);
            } catch (_) { }
        })();
    }, []);

    const messagesEndRef = useRef(null);
    const messagesContainerRef = useRef(null);
    const userScrolledUp = useRef(false);
    const askMenuRef = useRef(null);
    const modelMenuRef = useRef(null);
    const textareaRef = useRef(null);

    const MODES = {
        agent: { label: 'Agent', icon: Infinity, shortcut: 'Ctrl I', desc: '执行代码修改和任务' },
        autoAgent: { label: 'Auto', icon: Zap, shortcut: '', desc: '智能路由，自动选择最优模型' },
        plan: { label: 'Plan', icon: ListTree, shortcut: '', desc: '架构设计与方案规划' },
        debug: { label: 'Debug', icon: Bug, shortcut: '', desc: '错误诊断与修复建议' },
        chat: { label: 'Ask', icon: MessageSquare, shortcut: 'Ctrl L', desc: '只读分析与问答' },
    };
    const CurrentModeIcon = MODES[mode]?.icon || MessageSquare;

    const MODE_PLACEHOLDERS = {
        chat: '向 Ask 提问（只读模式，分析项目与代码）...',
        debug: '描述你遇到的错误或异常现象...',
        plan: '描述你想要规划或设计的功能...',
        agent: '描述你想要执行的代码修改...',
        autoAgent: '描述任务，系统自动选择最优模型...',
    };

    const MODE_EMPTY = {
        chat: { icon: MessageSquare, text: '向 Ask 提问任意代码问题', sub: '只读模式 · 代码分析 · 概念解释' },
        debug: { icon: Bug, text: '描述你遇到的 Bug 或报错信息', sub: '诊断模式 · 问题定位 · 修复建议' },
        plan: { icon: ListTree, text: '描述需要规划的功能或架构', sub: '规划模式 · 方案设计 · 权衡分析' },
        agent: { icon: Infinity, text: '描述你要执行的代码修改', sub: '执行模式 · 编写代码 · 文件操作' },
        autoAgent: { icon: Zap, text: '描述任务，系统自动选择最优模型', sub: '智能路由 · 复杂→Claude/Codex · 中等→Gemini · 简单→DeepSeek' },
    };

    useEffect(() => {
        if (!userScrolledUp.current) {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [history, isGenerating]);

    const handleScroll = useCallback(() => {
        const el = messagesContainerRef.current;
        if (!el) return;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        userScrolledUp.current = !atBottom;
    }, []);

    useEffect(() => {
        const handler = (e) => {
            if (askMenuRef.current && !askMenuRef.current.contains(e.target)) setAskMenuOpen(false);
            if (modelMenuRef.current && !modelMenuRef.current.contains(e.target)) setModelMenuOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const loadModels = useCallback(async () => {
        const r = await window.electronAPI?.modelList();
        if (r?.success && r.data?.length > 0) {
            setSavedModels(r.data);
            if (!currentModel) {
                const savedId = localStorage.getItem('identy_last_model_id');
                const saved = savedId && r.data.find(m => m.id === savedId);
                setCurrentModel(saved || r.data[0]);
            }
        }
    }, [currentModel]);

    useEffect(() => { loadModels(); }, []);

    // 监听面板宽度变化，用于响应式按钮展示
    useEffect(() => {
        const el = panelRef.current;
        if (!el) return;
        const ro = new ResizeObserver(entries => {
            for (const e of entries) setPanelWidth(e.contentRect.width);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const isCompact = panelWidth < 280;

    // 打开模型选择菜单时刷新列表，确保新增模型可见
    useEffect(() => {
        if (modelMenuOpen) loadModels();
    }, [modelMenuOpen]);

    const autoResize = (el) => {
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 160) + 'px';
    };

    const emptyState = MODE_EMPTY[mode] || MODE_EMPTY.chat;
    const EmptyIcon = emptyState.icon;

    return (
        <div ref={panelRef} className="bg-[#252526] flex flex-col h-full relative z-40 overflow-hidden">
            {/* Header */}
            <div className="h-[28px] flex items-center justify-between px-2 border-b border-[#1e1e1e] bg-[#252526] flex-shrink-0">
                <span className="text-[10px] uppercase font-semibold text-[#999] tracking-wider truncate" title={sessionTitle}>{sessionTitle || 'Chat'}</span>
                <div className="flex items-center gap-0.5">
                    <WithTooltip text="新对话" side="bottom">
                        <div className="p-[3px] rounded hover:bg-[#333] cursor-pointer text-[#888] hover:text-white" onClick={onNewChat}>
                            <Plus size={14} />
                        </div>
                    </WithTooltip>
                    <WithTooltip text="历史会话" side="bottom">
                        <div className="p-[3px] rounded hover:bg-[#333] cursor-pointer text-[#888] hover:text-white" onClick={onOpenHistory}>
                            <Clock size={14} />
                        </div>
                    </WithTooltip>
                    <WithTooltip text="更多操作" side="bottom">
                        <div className="p-[3px] rounded hover:bg-[#333] cursor-pointer text-[#888] hover:text-white" onClick={onOpenMoreActions}>
                            <MoreHorizontal size={14} />
                        </div>
                    </WithTooltip>
                </div>
            </div>

            {historyOpen && (
                <HistoryPanel sessions={sessions} activeId={activeSessionId} onSelect={onSelectSession} onRename={onRenameSession} onDelete={onDeleteSession} onClose={onCloseHistory} />
            )}

            {moreActionsOpen && (
                <MoreActionsMenu onRename={onRenameCurrentSession} onClear={onClearMessages} onExportJSON={onExportJSON} onExportTXT={onExportTXT} onExportMD={onExportMD} onExportPDF={onExportPDF} onDelete={onDeleteCurrentSession} onClose={onCloseMoreActions} />
            )}

            {/* Chat Area */}
            <div
                ref={messagesContainerRef}
                className="flex-1 overflow-y-auto px-3 py-2 custom-scrollbar"
                style={{ background: 'var(--chat-bg)' }}
                onScroll={handleScroll}
            >
                {history.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full select-none" style={{ color: 'var(--chat-text-dim)' }}>
                        <EmptyIcon size={28} className="mb-3 opacity-15" />
                        <p className="text-[11px] text-[#666] font-medium">{emptyState.text}</p>
                        <p className="text-[9px] text-[#444] mt-1">{emptyState.sub}</p>
                    </div>
                ) : (
                    history.map((msg, idx) => (
                        <AskMessageCard
                            key={msg.id}
                            msg={msg}
                            isGenerating={isGenerating && idx === history.length - 1 && msg.role === 'ai'}
                            generatingStartTime={generatingStartTime}
                            chatMode={msg.mode || mode}
                            onModeSwitch={setMode}
                            projectPath={projectPath}
                            autoExecute={autoExecute}
                            onStepApplied={onStepApplied}
                            onAgentApprove={onAgentApprove}
                            onAgentDeny={onAgentDeny}
                            onEditMessage={(editMsg, text) => {
                                setInput(text);
                                onEditMessage?.(editMsg);
                                // 鑱氱劍杈撳叆妗?                                setTimeout(() => textareaRef.current?.focus(), 50);
                            }}
                        />
                    ))
                )}
                {pendingQuestion && (
                    <QuestionPanel
                        title={pendingQuestion.title}
                        questions={pendingQuestion.questions}
                        onSubmit={onQuestionSubmit}
                        onCancel={onQuestionCancel}
                    />
                )}
                {pendingModeSwitch && (
                    <ModeSwitchPanel
                        targetMode={pendingModeSwitch.targetMode}
                        explanation={pendingModeSwitch.explanation}
                        onApprove={onModeSwitchApprove}
                        onReject={onModeSwitchReject}
                    />
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="px-2 pb-2 bg-[#252526] flex-shrink-0">
                {/* Stop Generation Button */}
                {isGenerating && (
                    <div className="flex justify-center mb-1.5">
                        <button
                            onClick={onStopGeneration}
                            className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-[#2a2a2a] border border-[#3a3a3a] text-[10px] text-[#bbb] hover:bg-[#333] hover:text-white transition-colors"
                        >
                            <Square size={8} className="fill-current" />
                            <span>鍋滄鐢熸垚</span>
                        </button>
                    </div>
                )}
                {/* Agent Status Bar（Agent 运行中显示） */}
                {mode === 'agent' && agentState && agentState !== 'idle' && (
                    <AgentStatusBar
                        state={agentState}
                        iteration={agentIteration}
                        toolCallCount={agentToolCallCount}
                        onCancel={onStopGeneration}
                        activeToolName={agentActiveToolName}
                        parallelInfo={agentParallelInfo}
                        stateStartTime={agentStateStartTime}
                    />
                )}
                {/* Agent Review Bar（仅 Agent 模式、非生成中显示） */}
                {mode === 'agent' && !isGenerating && history.length > 0 && (
                    <div className="flex items-center justify-end gap-3 px-1 py-1 mb-1">
                        <span className="text-[10px] text-[#666]">Undo All</span>
                        <span className="text-[10px] text-[#666]">Keep All</span>
                        <button data-ui-audit-ignore type="button" className="text-[10px] bg-[#2a2a2a] text-[#bbb] px-2 py-0.5 rounded border border-[#3a3a3a] cursor-not-allowed opacity-70" title="Coming soon" disabled>
                            Review
                        </button>
                    </div>
                )}

                <div
                    className={`bg-[#181818] rounded-lg border flex flex-col transition-colors duration-200 shadow-md relative ${isDragOver ? 'border-[#4ca0e0] bg-[#1a2a3a]' : ''} ${mode === 'agent' ? 'border-[#1e2e45] focus-within:border-[#2a4060]' :
                        mode === 'plan' ? 'border-[#3a2e1e] focus-within:border-[#4a3e2e]' :
                            mode === 'debug' ? 'border-[#3a1e1e] focus-within:border-[#4a2e2e]' :
                                'border-[#1e3a29] focus-within:border-[#2e4a39]'
                        }`}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); }}
                    onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(false); }}
                    onDrop={(e) => {
                        e.preventDefault(); e.stopPropagation(); setIsDragOver(false);
                        const files = Array.from(e.dataTransfer?.files || []);
                        if (files.length > 0) {
                            const newAttachments = files.map(f => ({
                                id: Date.now() + Math.random(),
                                name: f.name,
                                size: f.size,
                                type: f.type,
                                file: f,
                                preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
                            }));
                            setAttachments(prev => [...prev, ...newAttachments]);
                        }
                    }}
                >
                    {isDragOver && (
                        <div className="absolute inset-0 flex items-center justify-center bg-[#1a2a3a]/80 rounded-lg z-10 pointer-events-none">
                            <span className="text-[11px] text-[#4ca0e0] font-medium">松开即可添加文件</span>
                        </div>
                    )}

                    {/* Attachment Preview */}
                    {attachments.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 px-2.5 pt-2">
                            {attachments.map(att => (
                                <div key={att.id} className="relative group flex items-center gap-1 bg-[#222] rounded px-1.5 py-1 max-w-[150px]">
                                    {att.preview ? (
                                        <img src={att.preview} alt="" className="w-[28px] h-[28px] rounded object-cover" />
                                    ) : (
                                        <Paperclip size={10} className="text-[#777] flex-shrink-0" />
                                    )}
                                    <span className="text-[9px] text-[#aaa] truncate">{att.name}</span>
                                    <button
                                        className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-[#444] text-[#ccc] flex items-center justify-center text-[8px] opacity-0 group-hover:opacity-100 transition-opacity"
                                        onClick={() => { if (att.preview) URL.revokeObjectURL(att.preview); setAttachments(prev => prev.filter(a => a.id !== att.id)); }}
                                    >x</button>
                                </div>
                            ))}
                        </div>
                    )}

                    <textarea
                        ref={textareaRef}
                        className="bg-transparent border-none outline-none text-[11px] text-[#ccc] resize-none overflow-y-auto h-auto min-h-[36px] max-h-[160px] px-2.5 py-2 placeholder-[#4a4a4a] w-full leading-[16px]"
                        placeholder={MODE_PLACEHOLDERS[mode] || MODE_PLACEHOLDERS.chat}
                        value={input}
                        disabled={isGenerating}
                        onChange={(e) => { setInput(e.target.value); autoResize(e.target); }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                if ((input.trim() || attachments.length > 0) && !isGenerating) {
                                    onSend(input, currentModel, attachments, { webSearchEnabled });
                                    setInput(''); setAttachments([]);
                                    if (textareaRef.current) textareaRef.current.style.height = '36px';
                                }
                            }
                        }}
                        onPaste={(e) => {
                            const items = Array.from(e.clipboardData?.items || []);
                            const imageItems = items.filter(i => i.type.startsWith('image/'));
                            if (imageItems.length > 0) {
                                e.preventDefault();
                                const newAttachments = imageItems.map(item => {
                                    const blob = item.getAsFile();
                                    return {
                                        id: Date.now() + Math.random(),
                                        name: `clipboard-${Date.now()}.${item.type.split('/')[1] || 'png'}`,
                                        size: blob.size,
                                        type: blob.type,
                                        file: blob,
                                        preview: URL.createObjectURL(blob),
                                    };
                                });
                                setAttachments(prev => [...prev, ...newAttachments]);
                            }
                        }}
                    />

                    {/* Hidden file input */}
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        className="hidden"
                        accept="image/*,.txt,.md,.json,.js,.jsx,.ts,.tsx,.py,.html,.css,.csv,.xml,.yaml,.yml,.toml,.env,.log,.pdf,.doc,.docx,.zip,.rar,.7z,.tar,.gz,.xls,.xlsx,.ppt,.pptx,.svg,.mp3,.mp4,.wav,.c,.cpp,.h,.java,.rs,.go,.rb,.php,.sql,.sh,.bat,.ps1"
                        onChange={(e) => {
                            const files = Array.from(e.target?.files || []);
                            const newAttachments = files.map(f => ({
                                id: Date.now() + Math.random(),
                                name: f.name,
                                size: f.size,
                                type: f.type,
                                file: f,
                                preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
                            }));
                            setAttachments(prev => [...prev, ...newAttachments]);
                            e.target.value = '';
                        }}
                    />

                    {/* Bottom Toolbar */}
                    <div className="flex justify-between items-center px-1.5 py-1 border-t border-[#222]">
                        <div className="flex items-center gap-1 relative z-20">
                            {/* Mode Switcher */}
                            <div className="relative" ref={askMenuRef}>
                                <button
                                    className={`flex items-center gap-1 px-1.5 py-[2px] rounded text-[10px] transition-colors border ${mode === 'chat' ? 'bg-[#162b1f] border-[#1e3a29] text-[#4cc38a] hover:bg-[#1d3326]' :
                                        mode === 'agent' ? 'bg-[#162030] border-[#1e2e45] text-[#4ca0e0] hover:bg-[#1d2a3d]' :
                                            mode === 'plan' ? 'bg-[#2b2318] border-[#3a2e1e] text-[#d4a24c] hover:bg-[#332a1d]' :
                                                mode === 'debug' ? 'bg-[#2b1a1a] border-[#3a1e1e] text-[#e06060] hover:bg-[#331d1d]' :
                                                    'bg-[#1a1a1a] border-[#2a2a2a] text-[#999] hover:bg-[#252525]'
                                        }`}
                                    onClick={() => setAskMenuOpen(!askMenuOpen)}
                                >
                                    <CurrentModeIcon size={10} />
                                    {!isCompact && <span className="font-medium">{MODES[mode]?.label || 'Ask'}</span>}
                                    <ChevronDown size={8} className="opacity-60" />
                                </button>

                                {askMenuOpen && (
                                    <div className="absolute bottom-full left-0 mb-1.5 w-[180px] bg-[#1a1a1a] border border-[#2a2a2a] rounded-md shadow-xl overflow-hidden py-0.5">
                                        {Object.entries(MODES).map(([key, config]) => {
                                            const Icon = config.icon;
                                            const modeColors = {
                                                chat: 'text-[#4cc38a]', agent: 'text-[#4ca0e0]',
                                                plan: 'text-[#d4a24c]', debug: 'text-[#e06060]'
                                            };
                                            return (
                                                <div
                                                    key={key}
                                                    className={`flex items-center gap-1.5 px-2.5 py-[5px] text-[#bbb] hover:bg-[#04395e] hover:text-white cursor-pointer group ${mode === key ? 'bg-[#04395e]/40' : ''}`}
                                                    onClick={() => { setMode(key); setAskMenuOpen(false); }}
                                                >
                                                    <Icon size={12} className={`${mode === key ? modeColors[key] : 'text-[#666]'} group-hover:text-white flex-shrink-0`} />
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-[10px] font-medium">{config.label}</div>
                                                        <div className="text-[8px] text-[#555] group-hover:text-[#999] truncate">{config.desc}</div>
                                                    </div>
                                                    {config.shortcut && <span className="text-[8px] text-[#555] group-hover:text-[#aaa] whitespace-nowrap">{config.shortcut}</span>}
                                                    {mode === key && <Check size={9} className="text-white flex-shrink-0" />}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            {/* Model Selector */}
                            <div className="relative" ref={modelMenuRef}>
                                <button
                                    className="flex items-center gap-0.5 hover:bg-[#252525] px-1.5 py-[2px] rounded transition-colors text-[#666]"
                                    onClick={() => setModelMenuOpen(!modelMenuOpen)}
                                >
                                    <span className={`text-[10px] text-[#777] truncate ${isCompact ? 'max-w-[60px]' : 'max-w-[200px]'}`} title={currentModel?.displayName || 'No Model'}>{currentModel?.displayName || 'No Model'}</span>
                                    <ChevronDown size={8} />
                                </button>

                                {modelMenuOpen && (
                                    <div className="absolute bottom-full left-0 mb-1.5 w-[200px] bg-[#1a1a1a] border border-[#2a2a2a] rounded-md shadow-xl overflow-hidden flex flex-col">
                                        <div className="py-0.5 max-h-[200px] overflow-y-auto custom-scrollbar">
                                            {savedModels.length === 0 ? (
                                                <div className="px-3 py-3 text-[10px] text-[#555] text-center">
                                                    No models configured.<br />Go to Settings -&gt; Model to add one.
                                                </div>
                                            ) : (
                                                savedModels.map(m => (
                                                    <div
                                                        key={m.id}
                                                        className="flex items-center gap-1.5 px-2 py-[4px] hover:bg-[#04395e] hover:text-white cursor-pointer group"
                                                        onClick={() => { setCurrentModel(m); localStorage.setItem('identy_last_model_id', m.id); setModelMenuOpen(false); }}
                                                    >
                                                        <div className="flex-1 min-w-0">
                                                            <span className="text-[10px] text-[#bbb] group-hover:text-white truncate block">{m.displayName}</span>
                                                            {m.modelName && m.modelName !== m.displayName && !m.displayName?.toLowerCase().includes(m.modelName?.toLowerCase()) && (
                                                                <span className="text-[9px] text-[#555] group-hover:text-[#aaa] truncate block">{m.modelName}</span>
                                                            )}
                                                        </div>
                                                        {currentModel?.id === m.id && <Check size={9} className="text-white flex-shrink-0" />}
                                                    </div>
                                                ))
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Right: Context indicator + Actions */}
                        <div className="flex items-center gap-1.5 z-20">
                            {/* Attach file button */}
                            <button
                                className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-[#555] hover:text-[#aaa] hover:bg-[#252525] transition-colors"
                                title="添加附件（支持图片、文档、代码等格式）"
                                onClick={() => fileInputRef.current?.click()}
                            >
                                <Plus size={11} />
                                {!isCompact && <span>附件</span>}
                            </button>
                            {/* Web search toggle */}
                            <button
                                onClick={() => {
                                    setWebSearchEnabled(v => {
                                        const next = !v;
                                        // 同步写入配置
                                        (async () => {
                                            try {
                                                const r = await window.electronAPI?.modeConfigGet();
                                                const cfg = r?.success ? r.data : {};
                                                cfg.webSearch = { ...(cfg.webSearch || {}), enabled: next };
                                                await window.electronAPI?.modeConfigSave(cfg);
                                            } catch (_) { }
                                        })();
                                        return next;
                                    });
                                }}
                                title={webSearchEnabled ? '联网搜索已开启，点击关闭' : '联网搜索已关闭，点击开启'}
                                className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-all cursor-pointer ${webSearchEnabled
                                    ? 'bg-blue-600/25 text-blue-400 border border-blue-500/40 shadow-[0_0_6px_rgba(59,130,246,0.15)]'
                                    : 'text-[#555] hover:text-[#aaa] hover:bg-[#252525] border border-transparent'
                                    }`}
                            >
                                <Globe size={11} />
                                {!isCompact && <span>联网</span>}
                            </button>
                            {/* Agent 完成提醒按钮 */}
                            {mode === 'agent' && (
                                <div className="relative" ref={alertMenuRef}>
                                    {/* 持续提醒播放时显示停止按钮 */}
                                    {isAlertPlaying ? (
                                        <button
                                            onClick={stopAlertSound}
                                            className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-all cursor-pointer bg-red-600/25 text-red-400 border border-red-500/40 animate-pulse"
                                            title="点击停止提醒"
                                        >
                                            <VolumeX size={11} />
                                            {!isCompact && <span>停止</span>}
                                        </button>
                                    ) : (
                                        <button
                                            onClick={() => setAlertMenuOpen(!alertMenuOpen)}
                                            title={alertMode === 'off' ? '完成提醒：关闭' : alertMode === 'all' ? '完成提醒：全部提醒' : '完成提醒：选择提醒'}
                                            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-all cursor-pointer ${alertMode !== 'off'
                                                ? 'bg-amber-600/20 text-amber-400 border border-amber-500/35 shadow-[0_0_6px_rgba(245,158,11,0.1)]'
                                                : 'text-[#555] hover:text-[#aaa] hover:bg-[#252525] border border-transparent'
                                                }`}
                                        >
                                            {alertMode !== 'off' ? <BellRing size={11} /> : <Bell size={11} />}
                                            {!isCompact && <span>{alertMode === 'off' ? '提醒' : alertMode === 'all' ? '提醒' : '选择'}</span>}
                                        </button>
                                    )}

                                    {alertMenuOpen && (
                                        <div className="absolute bottom-full right-0 mb-1.5 w-[220px] bg-[#1a1a1a] border border-[#2a2a2a] rounded-md shadow-xl overflow-hidden py-1 z-50">
                                            <div className="px-2.5 py-1.5 text-[9px] text-[#555] border-b border-[#2a2a2a] font-medium uppercase tracking-wider">Agent 完成提醒</div>

                                            {/* 提醒模式 */}
                                            {[
                                                { key: 'off', label: '关闭提醒', desc: '不播放任何提醒', icon: VolumeX },
                                                { key: 'all', label: '全部提醒', desc: '每次 Agent 完成后自动提醒', icon: BellRing },
                                                { key: 'selective', label: '选择提醒', desc: '发送前选择本次是否提醒', icon: Bell },
                                            ].map(opt => {
                                                const Icon = opt.icon;
                                                return (
                                                    <div
                                                        key={opt.key}
                                                        className={`flex items-center gap-2 px-2.5 py-[6px] cursor-pointer hover:bg-[#04395e] hover:text-white group ${alertMode === opt.key ? 'bg-[#04395e]/40' : ''}`}
                                                        onClick={() => { setAlertMode(opt.key); if (opt.key === 'off') setAlertThisTask(false); }}
                                                    >
                                                        <Icon size={12} className={`flex-shrink-0 ${alertMode === opt.key ? 'text-amber-400' : 'text-[#666]'} group-hover:text-white`} />
                                                        <div className="flex-1 min-w-0">
                                                            <div className="text-[10px] font-medium text-[#bbb] group-hover:text-white">{opt.label}</div>
                                                            <div className="text-[8px] text-[#555] group-hover:text-[#999]">{opt.desc}</div>
                                                        </div>
                                                        {alertMode === opt.key && <Check size={9} className="text-white flex-shrink-0" />}
                                                    </div>
                                                );
                                            })}

                                            {/* 提醒强度（仅非 off 模式显示） */}
                                            {alertMode !== 'off' && (
                                                <>
                                                    <div className="px-2.5 py-1.5 text-[9px] text-[#555] border-t border-[#2a2a2a] mt-0.5 font-medium uppercase tracking-wider">提醒强度</div>
                                                    {[
                                                        { key: 'gentle', label: '轻提示', desc: '短铃声，播放一次', icon: Volume2 },
                                                        { key: 'persistent', label: '持续提醒', desc: '循环铃声，直到手动停止', icon: BellRing },
                                                    ].map(opt => {
                                                        const Icon = opt.icon;
                                                        return (
                                                            <div
                                                                key={opt.key}
                                                                className={`flex items-center gap-2 px-2.5 py-[6px] cursor-pointer hover:bg-[#04395e] hover:text-white group ${alertType === opt.key ? 'bg-[#04395e]/40' : ''}`}
                                                                onClick={() => setAlertType(opt.key)}
                                                            >
                                                                <Icon size={12} className={`flex-shrink-0 ${alertType === opt.key ? 'text-amber-400' : 'text-[#666]'} group-hover:text-white`} />
                                                                <div className="flex-1 min-w-0">
                                                                    <div className="text-[10px] font-medium text-[#bbb] group-hover:text-white">{opt.label}</div>
                                                                    <div className="text-[8px] text-[#555] group-hover:text-[#999]">{opt.desc}</div>
                                                                </div>
                                                                {alertType === opt.key && <Check size={9} className="text-white flex-shrink-0" />}
                                                            </div>
                                                        );
                                                    })}

                                                    {/* 试听按钮 */}
                                                    <div className="px-2.5 py-1.5 border-t border-[#2a2a2a] mt-0.5">
                                                        <button
                                                            onClick={() => playAlertSound(alertType)}
                                                            className="w-full flex items-center justify-center gap-1 px-2 py-1 rounded text-[9px] bg-[#252525] text-[#aaa] hover:bg-[#333] hover:text-white transition-colors border border-[#333]"
                                                        >
                                                            <Volume2 size={10} />
                                                            <span>试听当前提醒音</span>
                                                        </button>
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}
                            {/* selective 模式下的本次任务提醒开关 */}
                            {mode === 'agent' && alertMode === 'selective' && !isGenerating && (
                                <button
                                    onClick={() => setAlertThisTask(v => !v)}
                                    title={alertThisTask ? '本次任务完成后将提醒，点击取消' : '点击启用本次任务完成提醒'}
                                    className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] transition-all cursor-pointer ${alertThisTask
                                        ? 'bg-amber-600/20 text-amber-400 border border-amber-500/35'
                                        : 'text-[#555] hover:text-[#aaa] hover:bg-[#252525] border border-transparent'
                                        }`}
                                >
                                    {alertThisTask ? <BellRing size={10} /> : <Bell size={10} />}
                                    {!isCompact && <span className="text-[9px]">本次提醒</span>}
                                </button>
                            )}
                            {/* Image button */}
                            <button
                                className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-[#555] hover:text-[#aaa] hover:bg-[#252525] transition-colors"
                                title="添加图片"
                                onClick={() => { fileInputRef.current.accept = 'image/*'; fileInputRef.current?.click(); setTimeout(() => { fileInputRef.current.accept = "image/*,.txt,.md,.json,.js,.jsx,.ts,.tsx,.py,.html,.css,.csv,.xml,.yaml,.yml,.toml,.env,.log,.pdf,.doc,.docx,.zip,.rar,.7z,.tar,.gz,.xls,.xlsx,.ppt,.pptx,.svg,.mp3,.mp4,.wav"; }, 100); }}
                            >
                                <ImageIcon size={11} />
                            </button>

                            {/* Context usage indicator */}
                            {(() => {
                                const msgChars = (history || []).reduce((sum, m) => sum + ((m.text || '') + (m.answerText || '')).length, 0) + input.length;
                                const estimatedTokens = Math.ceil(msgChars / 3.5);
                                const maxTokens = 128000;
                                const pct = Math.min(100, Math.round((estimatedTokens / maxTokens) * 100));
                                const color = pct > 85 ? '#e06060' : pct > 60 ? '#d4a24c' : '#4cc38a';
                                const radius = 5; const circumference = 2 * Math.PI * radius;
                                const offset = circumference - (pct / 100) * circumference;
                                return (
                                    <div className="relative" title={`上下文 ~${Math.round(estimatedTokens / 1000)}k / ${maxTokens / 1000}k tokens (${pct}%)`}>
                                        <svg width="16" height="16" viewBox="0 0 16 16" className="transform -rotate-90">
                                            <circle cx="8" cy="8" r={radius} fill="none" stroke="#333" strokeWidth="1.5" />
                                            <circle cx="8" cy="8" r={radius} fill="none" stroke={color} strokeWidth="1.5"
                                                strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round"
                                                style={{ transition: 'stroke-dashoffset 0.3s ease' }} />
                                        </svg>
                                    </div>
                                );
                            })()}

                            {/* Send button */}
                            {(input.trim() || attachments.length > 0) && !isGenerating ? (
                                <button
                                    onClick={() => { if (input.trim() || attachments.length > 0) { onSend(input, currentModel, attachments, { webSearchEnabled }); setInput(''); setAttachments([]); if (textareaRef.current) textareaRef.current.style.height = '36px'; } }}
                                    className="w-[20px] h-[20px] rounded flex items-center justify-center bg-[#4ca0e0] hover:bg-[#5cb0f0] transition-colors"
                                >
                                    <Send size={10} className="text-white" />
                                </button>
                            ) : null}
                        </div>
                    </div>
                </div>
                <div className="text-[9px] text-[#444] mt-1 text-center select-none">AI generated content may be incorrect.</div>
            </div>
        </div>
    );
};

// ============================================================
// 命令面板
// ============================================================
const CommandPalette = ({ visible, onClose, fileTree, onOpenFile }) => {
    const [query, setQuery] = useState('');
    const getAllFiles = useCallback((nodes) => {
        let files = [];
        for (const node of nodes) {
            if (node.type === 'file') files.push(node);
            if (node.children) files = files.concat(getAllFiles(node.children));
        }
        return files;
    }, []);

    if (!visible) return null;

    const allFiles = getAllFiles(fileTree);
    const filtered = query ? allFiles.filter(f => f.name.toLowerCase().includes(query.toLowerCase())) : allFiles.slice(0, 10);

    return (
        <div className="absolute top-0 left-0 right-0 bottom-0 z-50 flex justify-center pt-2" onClick={onClose}>
            <div className="w-[480px] h-fit bg-[#1e1e1e] rounded-md shadow-2xl border border-[#3a3a3a] flex flex-col" onClick={e => e.stopPropagation()}>
                <div className="flex items-center px-2 py-1.5 border-b border-[#2a2a2a]">
                    <ChevronRight size={12} className="text-gray-500 mr-1.5" />
                    <input
                        autoFocus
                        className="bg-transparent border-none outline-none flex-1 text-[#ccc] placeholder-[#555] text-[11px]"
                        placeholder="搜索文件..."
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                </div>
                <div className="py-1 max-h-[240px] overflow-y-auto custom-scrollbar">
                    <div className="px-2 py-0.5 text-[9px] text-[#666] uppercase tracking-wide">{query ? '搜索结果' : '最近打开'}</div>
                    {filtered.map(file => (
                        <div
                            key={file.id}
                            className="px-2 py-1 hover:bg-[#2a2d2e] cursor-pointer flex justify-between"
                            onClick={() => {
                                if (typeof onOpenFile === 'function') {
                                    onOpenFile(file);
                                    onClose();
                                    return;
                                }
                                notImplemented('CommandPalette', `打开文件：${file.name}`);
                            }}
                        >
                            <span className="text-[#ccc] text-[11px] flex items-center gap-1.5">{getFileIcon(file.name)}{file.name}</span>
                            <span className="text-[#555] text-[9px] truncate max-w-[160px]">{file.path}</span>
                        </div>
                    ))}
                    {filtered.length === 0 && <div className="px-2 py-3 text-[10px] text-[#555] text-center">没有找到匹配的文件</div>}
                </div>
            </div>
        </div>
    );
};

// ============================================================
// 终端面板
// ============================================================
const TerminalPanel = ({ onClose }) => {
    const [activeTab, setActiveTab] = useState('terminal');
    const [termInput, setTermInput] = useState('');
    const [termHistory, setTermHistory] = useState([
        { type: 'info', text: 'Welcome to Terminal - DreamIDE v1.0' },
        { type: 'path', text: 'PS D:\\IDenty\\cursor-launcher>' },
    ]);
    const termEndRef = useRef(null);
    const inputRef = useRef(null);

    const TABS = [
        { key: 'problems', label: 'PROBLEMS', count: 0 },
        { key: 'output', label: 'OUTPUT' },
        { key: 'debug', label: 'DEBUG CONSOLE' },
        { key: 'terminal', label: 'TERMINAL' },
    ];

    useEffect(() => {
        termEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [termHistory]);

    const handleTermSubmit = (e) => {
        if (e.key !== 'Enter' || !termInput.trim()) return;
        const cmd = termInput.trim();
        globalLogger.info('Terminal', '执行命令', cmd);
        setTermHistory(prev => [
            ...prev,
            { type: 'cmd', text: `PS> ${cmd}` },
            { type: 'output', text: cmd === 'cls' || cmd === 'clear' ? '' : `'${cmd}' executed successfully.` }
        ]);
        if (cmd === 'cls' || cmd === 'clear') {
            setTermHistory([{ type: 'path', text: 'PS D:\\IDenty\\cursor-launcher>' }]);
            globalLogger.debug('Terminal', '终端已清空');
        }
        setTermInput('');
    };

    return (
        <div className="bg-[#1e1e1e] flex flex-col h-full overflow-hidden border-t border-[#2a2a2a]">
            {/* Tab Bar */}
            <div className="h-[26px] flex items-center justify-between bg-[#252526] border-b border-[#1e1e1e] px-1 flex-shrink-0">
                <div className="flex items-center gap-0">
                    {TABS.map(tab => (
                        <div
                            key={tab.key}
                            className={`flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase tracking-wide cursor-pointer border-b-2 transition-colors ${activeTab === tab.key
                                ? 'text-white border-white'
                                : 'text-[#888] border-transparent hover:text-[#ccc]'
                                }`}
                            onClick={() => { setActiveTab(tab.key); globalLogger.info('Terminal', '切换面板标签', tab.label); }}
                        >
                            {tab.label}
                            {tab.count !== undefined && (
                                <span className="text-[8px] bg-[#333] text-[#888] px-1 rounded-sm">{tab.count}</span>
                            )}
                        </div>
                    ))}
                </div>
                <div className="flex items-center gap-1">
                    <WithTooltip text="New Terminal" side="bottom">
                        <div className="p-0.5 rounded hover:bg-[#333] cursor-pointer text-[#888] hover:text-white" onClick={() => globalLogger.warn('Terminal', 'New Terminal - 功能未实现，返回空值')}>
                            <Terminal size={12} />
                        </div>
                    </WithTooltip>
                    <WithTooltip text="Split Terminal" side="bottom">
                        <div className="p-0.5 rounded hover:bg-[#333] cursor-pointer text-[#888] hover:text-white" onClick={() => globalLogger.warn('Terminal', 'Split Terminal - 功能未实现，返回空值')}>
                            <Layout size={12} />
                        </div>
                    </WithTooltip>
                    <WithTooltip text="Close Panel" side="bottom">
                        <div className="p-0.5 rounded hover:bg-[#333] cursor-pointer text-[#888] hover:text-white" onClick={() => { globalLogger.info('Terminal', '关闭终端面板'); onClose(); }}>
                            <X size={12} />
                        </div>
                    </WithTooltip>
                </div>
            </div>

            {/* Terminal Content */}
            {activeTab === 'terminal' && (
                <div
                    className="flex-1 overflow-y-auto px-3 py-1 font-mono text-[11px] leading-[16px] text-[#ccc] custom-scrollbar cursor-text"
                    onClick={() => inputRef.current?.focus()}
                >
                    {termHistory.map((line, i) => (
                        <div key={i} className={`${line.type === 'info' ? 'text-[#569cd6]' :
                            line.type === 'path' ? 'text-[#6a9955]' :
                                line.type === 'cmd' ? 'text-[#dcdcaa]' :
                                    line.type === 'error' ? 'text-[#f44747]' :
                                        'text-[#ccc]'
                            }`}>
                            {line.text}
                        </div>
                    ))}
                    <div className="flex items-center">
                        <span className="text-[#6a9955] mr-1">PS&gt;</span>
                        <input
                            ref={inputRef}
                            type="text"
                            className="flex-1 bg-transparent border-none outline-none text-[11px] text-[#ccc] font-mono caret-[#ccc]"
                            value={termInput}
                            onChange={(e) => setTermInput(e.target.value)}
                            onKeyDown={handleTermSubmit}
                            spellCheck={false}
                            autoComplete="off"
                        />
                    </div>
                    <div ref={termEndRef} />
                </div>
            )}

            {activeTab === 'problems' && (
                <div className="flex-1 flex items-center justify-center text-[10px] text-[#555]">
                    No problems detected in workspace.
                </div>
            )}
            {activeTab === 'output' && (
                <div className="flex-1 overflow-y-auto px-3 py-1 font-mono text-[10px] text-[#888] custom-scrollbar">
                    <div className="text-[#569cd6]">[Info] Output channel ready.</div>
                </div>
            )}
            {activeTab === 'debug' && (
                <div className="flex-1 flex items-center justify-center text-[10px] text-[#555]">
                    No active debug session.
                </div>
            )}
        </div>
    );
};

// ============================================================
// 主组件：项目视图
// ============================================================
export default function ProjectView({ project, onBackToHome, onOpenSettings }) {
    const dialog = useDialog();
    const [fileTree, setFileTree] = useState([]);
    const [openFiles, setOpenFiles] = useState([]);
    const [activeFileId, setActiveFileId] = useState(null);
    const [fileContents, setFileContents] = useState({});
    const [dirtyFiles, setDirtyFiles] = useState({});
    const [chatVisible, setChatVisible] = useState(true);
    const [sidebarVisible, setSidebarVisible] = useState(true);
    // --- 多会话状态 ---
    const [sessions, setSessions] = useState([]); // 会话元数据列表
    const [activeSessionId, setActiveSessionId] = useState(null);
    const [activeMessages, setActiveMessages] = useState([]);
    const [activeSessionTitle, setActiveSessionTitle] = useState('Chat');
    const [historyOpen, setHistoryOpen] = useState(false);
    const [moreActionsOpen, setMoreActionsOpen] = useState(false);
    const [cmdPaletteVisible, setCmdPaletteVisible] = useState(false);
    const [loading, setLoading] = useState(true);
    const [panelVisible, setPanelVisible] = useState(false);
    const [monitorVisible, setMonitorVisible] = useState(false);

    // 可调节面板宽高
    const [sidebarWidth, setSidebarWidth] = useState(220);
    const [chatWidth, setChatWidth] = useState(320);
    const [panelHeight, setPanelHeight] = useState(180);

    const MIN_SIDEBAR = 140;
    const MAX_SIDEBAR = 400;
    const MIN_CHAT = 100;
    const MAX_CHAT = 800;
    const MIN_PANEL = 80;
    const MAX_PANEL = 500;

    const refreshFileTree = useCallback(async () => {
        if (!window.electronAPI || !project?.path) return;
        const tree = await window.electronAPI.readFileTree(project.path);
        setFileTree(tree);
    }, [project?.path]);

    // 初始化加载 + 启动文件系统监听
    useEffect(() => {
        if (!window.electronAPI || !project?.path) return;
        setLoading(true);
        globalLogger.info('FileTree', '加载文件树', project.path);
        window.electronAPI.readFileTree(project.path).then(tree => {
            setFileTree(tree);
            setLoading(false);
            globalLogger.success('FileTree', '文件树加载完成');
        });

        // 启动 fs.watch 监听
        window.electronAPI.fsWatchStart(project.path);
        window.electronAPI.onFsChanged((data) => {
            if (data.projectPath === project.path) {
                refreshFileTree();
            }
        });

        return () => {
            window.electronAPI.fsWatchStop(project.path);
            window.electronAPI.removeFsChangedListener?.();
        };
    }, [project?.path, refreshFileTree]);

    // 资源管理器三态切换
    const handleExplorerClick = useCallback(() => {
        if (!sidebarVisible) {
            // 侧边栏隐藏 -> 显示并激活 Explorer
            setSidebarVisible(true);
            globalLogger.info('ActivityBar', '资源管理器 -> 显示侧边栏');
        } else {
            // 侧边栏可见 -> 折叠侧边栏
            setSidebarVisible(false);
            globalLogger.info('ActivityBar', '资源管理器 -> 折叠侧边栏');
        }
    }, [sidebarVisible]);

    // 全部折叠
    const collapseAll = useCallback(() => {
        const closeAll = (nodes) => nodes.map(node => {
            if (node.children) return { ...node, isOpen: false, children: closeAll(node.children) };
            return node;
        });
        setFileTree(prev => closeAll(prev));
        globalLogger.info('Explorer', '已全部折叠');
    }, []);

    // 从 Explorer 菜单新建文件
    const createFileAtRoot = useCallback(async (name) => {
        if (!project?.path) return;
        const sep = project.path.includes('/') ? '/' : '\\\\';
        const filePath = project.path + sep + name;
        try {
            const r = await window.electronAPI?.createFile(filePath);
            if (r?.success) { globalLogger.success('ExplorerMenu', '文件创建成功', filePath); refreshFileTree(); }
            else { globalLogger.error('ExplorerMenu', '文件创建失败', r?.error); dialog.alert('创建失败：' + (r?.error || '未知错误')); }
        } catch (ex) {
            globalLogger.error('ExplorerMenu', 'IPC 异常', ex?.message);
        }
    }, [project?.path, refreshFileTree]);

    // 从 Explorer 菜单新建文件夹
    const createFolderAtRoot = useCallback(async (name) => {
        if (!project?.path) return;
        const sep = project.path.includes('/') ? '/' : '\\\\';
        const folderPath = project.path + sep + name;
        try {
            const r = await window.electronAPI?.createFolder(folderPath);
            if (r?.success) { globalLogger.success('ExplorerMenu', '文件夹创建成功', folderPath); refreshFileTree(); }
            else { globalLogger.error('ExplorerMenu', '文件夹创建失败', r?.error); dialog.alert('创建失败：' + (r?.error || '未知错误')); }
        } catch (ex) {
            globalLogger.error('ExplorerMenu', 'IPC 异常', ex?.message);
        }
    }, [project?.path, refreshFileTree]);

    useEffect(() => {
        const handleKeyDown = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'p') { e.preventDefault(); setCmdPaletteVisible(prev => !prev); }
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'e' || e.key === 'E')) {
                e.preventDefault();
                globalLogger.info('Shortcut', 'Ctrl+Shift+E 触发资源管理器切换');
                setSidebarVisible(prev => !prev);
            }
            // Ctrl+L -> Ask mode + 聚焦 Chat
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'l' || e.key === 'L')) {
                e.preventDefault();
                setChatMode('chat');
                setChatVisible(true);
                globalLogger.info('Shortcut', 'Ctrl+L -> Ask 模式');
            }
            // Ctrl+I -> Agent mode + 聚焦 Chat
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'i' || e.key === 'I')) {
                e.preventDefault();
                setChatMode('agent');
                setChatVisible(true);
                globalLogger.info('Shortcut', 'Ctrl+I -> Agent 模式');
            }
            if (e.key === 'Escape') setCmdPaletteVisible(false);
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    const toggleFolder = (id) => {
        const toggleRecursive = (nodes) => nodes.map(node => {
            if (node.id === id) return { ...node, isOpen: !node.isOpen };
            if (node.children) return { ...node, children: toggleRecursive(node.children) };
            return node;
        });
        setFileTree(toggleRecursive(fileTree));
    };

    const openFile = async (node) => {
        globalLogger.info('Editor', '打开文件', node.name);
        if (!openFiles.find(f => f.id === node.id)) setOpenFiles(prev => [...prev, node]);
        setActiveFileId(node.id);
        if (!(node.id in fileContents) && window.electronAPI) {
            const content = await window.electronAPI.readFileContent(node.path || node.id);
            setFileContents(prev => ({ ...prev, [node.id]: content }));
            setDirtyFiles(prev => ({ ...prev, [node.id]: false }));
            globalLogger.debug('Editor', '文件内容已加载', `${node.name} (${content?.length || 0} 字符)`);
        }
    };

    const closeFile = (e, id) => {
        e.stopPropagation();
        const closedFile = openFiles.find(f => f.id === id);
        globalLogger.info('Editor', '关闭文件', closedFile?.name || id);
        const newOpenFiles = openFiles.filter(f => f.id !== id);
        setOpenFiles(newOpenFiles);
        setDirtyFiles(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
        });
        if (activeFileId === id) setActiveFileId(newOpenFiles.length > 0 ? newOpenFiles[newOpenFiles.length - 1].id : null);
    };

    // --- 会话初始化（按项目隔离） ---
    useEffect(() => {
        const initSessions = async () => {
            const api = window.electronAPI;
            if (!api) return;
            const projectPath = project?.path || '';
            // 先保存上一个会话
            if (activeSessionId && activeMessages.length > 0) {
                await api.chatUpdate(activeSessionId, { messages: activeMessages });
            }
            const r = await api.chatList({ projectPath });
            if (r?.success && r.data?.length > 0) {
                setSessions(r.data);
                const latest = r.data[0];
                setActiveSessionId(latest.id);
                setActiveSessionTitle(latest.title);
                const full = await api.chatGet(latest.id);
                if (full?.success) setActiveMessages(full.data.messages || []);
                globalLogger.info('Chat', `加载项目会话：${latest.title}`);
            } else {
                const nr = await api.chatCreate({ projectPath });
                if (nr?.success) {
                    setSessions([{ id: nr.data.id, title: nr.data.title, messageCount: 0, createdAt: nr.data.createdAt, updatedAt: nr.data.updatedAt }]);
                    setActiveSessionId(nr.data.id);
                    setActiveSessionTitle(nr.data.title);
                    setActiveMessages([]);
                    globalLogger.info('Chat', `为项目创建新会话：${nr.data.title}`);
                }
            }
        };
        initSessions();
    }, [project?.path]);

    // --- 刷新会话列表（按项目过滤） ---
    const refreshSessions = async () => {
        const r = await window.electronAPI?.chatList({ projectPath: project?.path || '' });
        if (r?.success) setSessions(r.data || []);
    };

    // --- 新建会话 ---
    const handleNewChat = async () => {
        // 先保存当前会话
        if (activeSessionId && activeMessages.length > 0) {
            await window.electronAPI?.chatUpdate(activeSessionId, { messages: activeMessages });
        }
        const r = await window.electronAPI?.chatCreate({ projectPath: project?.path || '' });
        if (r?.success) {
            setActiveSessionId(r.data.id);
            setActiveSessionTitle(r.data.title);
            setActiveMessages([]);
            await refreshSessions();
            globalLogger.success('Chat', `新建会话：${r.data.title}`);
        } else {
            globalLogger.error('Chat', '新建会话失败', r?.error);
        }
    };

    // --- 切换会话 ---
    const handleSelectSession = async (id) => {
        if (id === activeSessionId) return;
        // 保存当前
        if (activeSessionId && activeMessages.length > 0) {
            await window.electronAPI?.chatUpdate(activeSessionId, { messages: activeMessages });
        }
        const full = await window.electronAPI?.chatGet(id);
        if (full?.success) {
            setActiveSessionId(id);
            setActiveSessionTitle(full.data.title);
            setActiveMessages(full.data.messages || []);
            globalLogger.info('Chat', `切换到会话：${full.data.title}`);
        } else {
            globalLogger.error('Chat', '加载会话失败', full?.error);
        }
    };

    // --- 重命名会话 ---
    const handleRenameSession = async (id, newTitle) => {
        const r = await window.electronAPI?.chatUpdate(id, { title: newTitle });
        if (r?.success) {
            if (id === activeSessionId) setActiveSessionTitle(newTitle);
            await refreshSessions();
            globalLogger.info('Chat', `重命名会话：${newTitle}`);
        }
    };

    // --- 删除会话 ---
    const handleDeleteSession = async (id) => {
        const r = await window.electronAPI?.chatDelete(id);
        if (r?.success) {
            globalLogger.info('Chat', '删除会话');
            // 同时清理会话记忆
            window.electronAPI?.memoryDelete?.(id).catch(() => { });
            if (id === activeSessionId) {
                const remaining = sessions.filter(s => s.id !== id);
                if (remaining.length > 0) {
                    await handleSelectSession(remaining[0].id);
                } else {
                    await handleNewChat();
                }
            }
            await refreshSessions();
        } else {
            globalLogger.error('Chat', '删除会话失败', r?.error);
        }
    };

    // --- 重命名当前会话（弹窗输入） ---
    const handleRenameCurrentSession = async () => {
        const newTitle = await dialog.prompt('请输入新的会话标题：', activeSessionTitle);
        if (newTitle && newTitle.trim()) handleRenameSession(activeSessionId, newTitle.trim());
    };

    // --- 清空当前会话消息 ---
    const handleClearMessages = async () => {
        if (!(await dialog.confirm('确定清空当前会话的所有消息吗？'))) return;
        setActiveMessages([]);
        await window.electronAPI?.chatUpdate(activeSessionId, { messages: [] });
        globalLogger.info('Chat', '已清空消息');
    };

    // --- 导出 ---
    const handleExportJSON = async () => {
        const r = await window.electronAPI?.chatExport(activeSessionId, 'json');
        if (r?.success) globalLogger.success('Chat', `导出 JSON 完成：${r.filePath}`);
        else globalLogger.error('Chat', '导出失败', r?.error);
    };
    const handleExportTXT = async () => {
        const r = await window.electronAPI?.chatExport(activeSessionId, 'txt');
        if (r?.success) globalLogger.success('Chat', `导出 TXT 完成：${r.filePath}`);
        else globalLogger.error('Chat', '导出失败', r?.error);
    };
    const handleExportMD = async () => {
        const r = await window.electronAPI?.chatExport(activeSessionId, 'md');
        if (r?.success) globalLogger.success('Chat', `导出 Markdown 完成：${r.filePath}`);
        else globalLogger.error('Chat', '导出失败', r?.error);
    };
    const handleExportPDF = async () => {
        const r = await window.electronAPI?.chatExport(activeSessionId, 'pdf');
        if (r?.success) globalLogger.success('Chat', `导出 PDF 完成：${r.filePath}`);
        else globalLogger.error('Chat', '导出失败', r?.error);
    };

    // --- 删除当前会话 ---
    const handleDeleteCurrentSession = async () => {
        if (!(await dialog.confirm(`确定删除会话“${activeSessionTitle}”吗？此操作不可撤销。`))) return;
        handleDeleteSession(activeSessionId);
    };

    // 当前聊天模式
    const [chatMode, setChatMode] = useState('agent');
    const [isGenerating, setIsGenerating] = useState(false);
    const [generatingStartTime, setGeneratingStartTime] = useState(null);
    const activeRequestIdRef = useRef(null);
    const streamingMsgRef = useRef(null);

    // Auto 鑷姩鎵ц + Agent 寮曟搸閰嶇疆
    const [autoExecute, setAutoExecute] = useState(true);
    const [agentEngine, setAgentEngineState] = useState('v2');
    useEffect(() => {
        (async () => {
            const r = await window.electronAPI?.modeConfigGet();
            if (r?.success) {
                setAutoExecute(r.data?.taskExecution?.autoExecute ?? false);
                setAgentEngineState(r.data?.agentEngine || 'v2');
            }
        })();
    }, []);

    const handleEditorContentChange = useCallback((fileId, nextContent) => {
        if (!fileId) return;
        setFileContents(prev => ({ ...prev, [fileId]: nextContent }));
        setDirtyFiles(prev => ({ ...prev, [fileId]: true }));
    }, []);

    const handleSaveFile = useCallback(async (fileObj) => {
        try {
            if (!fileObj?.id || !window.electronAPI?.writeFile) {
                return { success: false, error: 'Save API unavailable' };
            }
            const targetPath = fileObj.path || fileObj.id;
            const currentContent = fileContents[fileObj.id] ?? '';
            const result = await window.electronAPI.writeFile(targetPath, currentContent);
            if (result?.success) {
                setDirtyFiles(prev => ({ ...prev, [fileObj.id]: false }));
                globalLogger.success('Editor', 'File saved', targetPath);
                return { success: true };
            }
            return { success: false, error: result?.error || 'Save failed' };
        } catch (e) {
            return { success: false, error: e?.message || 'Save failed' };
        }
    }, [fileContents]);

    // 写入后同步回调：刷新文件树 + 刷新已打开文件内容
    const handleStepApplied = useCallback(async (filePath) => {
        await refreshFileTree();
        if (filePath) {
            // 找到已打开的匹配文件
            const matchFile = openFiles.find(f => {
                const fp = f.path || f.id;
                return fp === filePath || fp.replace(/[\\/]+/g, '/') === filePath.replace(/[\\/]+/g, '/');
            });
            if (matchFile && window.electronAPI) {
                try {
                    const content = await window.electronAPI.readFileContent(matchFile.path || matchFile.id);
                    if (content) {
                        setFileContents(prev => ({ ...prev, [matchFile.id]: content }));
                        setDirtyFiles(prev => ({ ...prev, [matchFile.id]: false }));
                    }
                    globalLogger.success('Sync', '文件内容已同步', matchFile.name);
                } catch (e) {
                    globalLogger.error('Sync', '文件同步失败', e?.message);
                }
            }
        }
    }, [refreshFileTree, openFiles]);

    // Agent 模式状态
    const [agentState, setAgentState] = useState('idle');
    const [agentIteration, setAgentIteration] = useState(0);
    const [agentToolCallCount, setAgentToolCallCount] = useState(0);
    const [agentToolCalls, setAgentToolCalls] = useState([]);
    const [agentTodos, setAgentTodos] = useState([]);
    const [agentActiveToolName, setAgentActiveToolName] = useState(null);
    const [agentParallelInfo, setAgentParallelInfo] = useState(null);
    const [agentStateStartTime, setAgentStateStartTime] = useState(null);
    const agentSessionRef = useRef(null);
    const agentTextBufRef = useRef('');
    const agentReasoningBufRef = useRef('');
    const agentReasoningStartRef = useRef(null);
    const agentBatchRef = useRef(0);
    const [pendingQuestion, setPendingQuestion] = useState(null);
    const [pendingModeSwitch, setPendingModeSwitch] = useState(null);

    // 鍋滄鐢熸垚
    const handleStopGeneration = useCallback(() => {
        const normalizeCancelledToolCalls = (list) => (list || []).map(tc => {
            const status = tc?.status;
            if (status === 'success' || status === 'failed' || status === 'cancelled' || status === 'rejected') {
                return { ...tc, _streaming: false };
            }
            return { ...tc, status: 'cancelled', _streaming: false };
        });

        if (activeRequestIdRef.current) {
            window.electronAPI?.llmStreamAbort(activeRequestIdRef.current);
            activeRequestIdRef.current = null;
        }
        // 取消 Agent 模式
        if (agentSessionRef.current) {
            window.electronAPI?.agentCancel(agentSessionRef.current);
            agentSessionRef.current = null;
        }
        window.electronAPI?.removeAllAgentListeners?.();

        setAgentToolCalls(prev => normalizeCancelledToolCalls(prev));
        setActiveMessages(prev => {
            if (!Array.isArray(prev) || prev.length === 0) return prev;
            const updated = [...prev];
            for (let i = updated.length - 1; i >= 0; i--) {
                const msg = updated[i];
                if (msg?.role !== 'ai') continue;
                if (!msg.streaming && msg.agentTerminalState) break;
                updated[i] = {
                    ...msg,
                    streaming: false,
                    agentCurrentThinking: '',
                    agentCurrentReasoning: '',
                    agentHeartbeat: '',
                    agentToolCalls: normalizeCancelledToolCalls(msg.agentToolCalls || []),
                    agentTerminalState: msg.mode === 'agent' ? 'cancelled' : msg.agentTerminalState,
                };
                break;
            }
            return updated;
        });

        setIsGenerating(false);
        setGeneratingStartTime(null);
        setAgentState('idle');
        setAgentActiveToolName(null);
        setAgentParallelInfo(null);
        setAgentStateStartTime(null);
        setPendingQuestion(null);
        setPendingModeSwitch(null);
    }, []);

    // ===== 模式 System Prompt 工厂 =====
    const buildSystemPrompt = useCallback((mode, projectContext, extraContext) => {
        const base = {
            chat: `You are Cursor, an intelligent AI coding assistant. You are in Ask mode, a read-only analysis mode.
Your role: Help users understand code, explain concepts, analyze project structure, and answer questions.
Rules:
- NEVER suggest making changes to files, running commands, or executing any write operations.
- Focus on clear explanations with code references when available.
- Use concise Chinese for responses. If the user writes in English, respond in English.
- When referencing code, cite file paths and line numbers.`,

            debug: `You are Cursor, an intelligent AI coding assistant. You are in Debug mode, a diagnostic mode.
Your role: Help users identify bugs, analyze error messages, trace issues through code, and suggest targeted fixes.

You MUST structure your response using exactly these sections:

## 问题分析
Describe what the error/issue is and reproduce conditions.

## 根因定位
Identify the root cause with specific file references and line numbers.

## 修复方案
Provide concrete fix(es) with code blocks. For each fix:
- Show the file path in the code block header
- Explain what the change does and why

## 验证步骤
- [ ] Step 1 to verify the fix
- [ ] Step 2 to verify the fix

Rules:
- Always follow this exact 4-section format.
- Be specific about file paths and line numbers.
- If the user shares an error/stack trace, parse it carefully.
- Use concise Chinese for responses. If the user writes in English, respond in English.`,

            plan: `You are Cursor, an intelligent AI coding assistant. You are in Plan mode, an architecture and planning mode.
Your role: Help users design solutions, plan implementations, evaluate trade-offs, and create technical roadmaps.

You MUST structure your response using exactly these sections:

## 方案概述
Brief summary of what you're planning (1-2 sentences).

## 实施步骤
Use numbered checklist items. Each major step should be a checkbox item.
Sub-tasks should be indented under their parent step.
Format:
- [ ] **Step 1: Title** - Description of what this step involves
  - [ ] Sub-task 1.1
  - [ ] Sub-task 1.2
- [ ] **Step 2: Title** - Description
  ...

## 权衡分析
Compare alternatives, trade-offs, pros/cons if applicable.

## 涉及文件
List the files that will be affected.

Rules:
- Always use checkbox format (- [ ] for pending, - [x] for done).
- Be specific about files, components, and dependencies.
- Include estimated complexity for each step if possible.
- Use concise Chinese for responses. If the user writes in English, respond in English.`,

            agent: `You are Cursor, an intelligent AI coding assistant. You are in Agent mode, an execution mode.
Your role: Help users implement changes, write code, create files, and execute tasks.

Workflow (STRICT, must follow in every response):

1. 需求分析: Start with a brief section explaining what the user wants.
2. 执行思路: Briefly explain your approach.
3. To-dos 清单: Provide a checkbox list of all steps to execute. Mark finished steps as done.
4. 逐步执行: Execute each step with code blocks.

Output format (strict):
- For file edits: use fenced code blocks with language + file path on the first line. Example: three backticks followed by language and path. The user can click "Apply" to write the content to the file.
- For shell commands: use code blocks with bash/sh language identifier (no path). These will be shown as runnable terminal blocks.
- Prefer full file content for small files; for large files show the relevant snippet and mention the file path clearly.

Rules:
- ALWAYS follow the 4-step workflow above. Never skip the To-dos list.
- Provide concrete code with exact file paths (relative to project root).
- Use concise Chinese for responses. If the user writes in English, respond in English.`,
        };

        let prompt = base[mode] || base.chat;

        if (extraContext) {
            prompt += `\n\n${extraContext}`;
        }

        if (projectContext) {
            prompt += `\n\n${projectContext}`;
        }

        return prompt;
    }, []);

    // ===== 项目上下文检索 =====
    const searchProjectContext = useCallback(async (text) => {
        if (!project?.path) return { systemContext: '', citations: [] };

        let fileNames = [];
        try {
            const lr = await window.electronAPI?.projectListFiles(project?.path);
            if (lr?.success) fileNames = lr.data || [];
        } catch (e) { }

        const related = isProjectRelated(text, fileNames);
        if (!related) return { systemContext: '', citations: [] };

        const STOP_WORDS = new Set([
            '的', '是', '在', '了', '和', '与', '就', '都', '而', '及', '或', '一个', '怎么', '如何', '请', '问',
            '吗', '呢', '吧', '能', '可以',
            'the', 'is', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'how', 'what', 'why', 'where', 'when', 'this', 'that', 'it', 'be', 'with',
        ]);
        const words = text.replace(/[\u3000-\u303f\uff00-\uffef,.?!;:"'()\[\]{}<>\/]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !STOP_WORDS.has(w.toLowerCase()));
        const keywords = words.sort((a, b) => b.length - a.length).slice(0, 5).map(w => w.toLowerCase());
        const queryStr = keywords.join(' ') || text.substring(0, 30);

        const citations = [];
        let systemContext = '';

        try {
            const sr = await window.electronAPI?.projectSearch(project?.path, queryStr);
            if (sr?.success && sr.data?.length > 0) {
                const CONTEXT_BUDGET = 3000;
                let usedLen = 0;
                const snippets = [];
                for (const r of sr.data) {
                    const snip = (r.snippet || '').substring(0, 500);
                    if (usedLen + snip.length > CONTEXT_BUDGET) break;
                    usedLen += snip.length;
                    snippets.push(`--- ${r.relativePath || r.file}:${r.line || 1} ---\n${snip}`);
                    citations.push({ file: r.file, relativePath: r.relativePath || r.file, path: r.path, line: r.line, matchType: r.matchType });
                }
                if (snippets.length > 0) {
                    systemContext = `\n\nRelevant project code snippets:\n${snippets.join('\n\n')}`;
                }
            }
        } catch (e) {
            globalLogger.error('Search', '项目检索失败', e?.message);
        }

        return { systemContext, citations };
    }, [project?.path]);

    const resolveAtReferences = useCallback(async (text) => {
        const refs = parseAtReferences(text);
        if (!project?.path || refs.length === 0) {
            return { references: [], contextBlock: '' };
        }

        const references = [];
        const unresolved = [];
        const contextParts = [
            '<explicit_references>',
            'The user explicitly referenced the following targets with @mentions. Prioritize these targets when planning and execution.',
        ];
        let usedChars = 0;
        let fileCount = 0;
        let folderCount = 0;

        const appendContext = (chunk) => {
            if (!chunk) return;
            const remain = AT_REF_CONTEXT_MAX_CHARS - usedChars;
            if (remain <= 0) return;
            if (chunk.length <= remain) {
                contextParts.push(chunk);
                usedChars += chunk.length;
                return;
            }
            const clipped = chunk.slice(0, remain);
            contextParts.push(`${clipped}\n...(reference context truncated)`);
            usedChars = AT_REF_CONTEXT_MAX_CHARS;
        };

        const resolveFileBySearch = async (targetValue) => {
            try {
                const search = await window.electronAPI?.projectSearch(project.path, targetValue);
                const rows = search?.success ? (search.data || []) : [];
                const targetNorm = targetValue.replace(/\\/g, '/').toLowerCase();
                const hit = rows.find(r => {
                    const rel = String(r.relativePath || '').replace(/\\/g, '/').toLowerCase();
                    const file = String(r.file || '').toLowerCase();
                    return rel === targetNorm || rel.endsWith(`/${targetNorm}`) || file === targetNorm;
                });
                return hit?.relativePath || null;
            } catch (_) {
                return null;
            }
        };

        for (const ref of refs) {
            if (ref.type === 'codebase') {
                references.push({
                    type: 'codebase',
                    label: '@codebase',
                    status: 'resolved',
                    relativePath: '.',
                });
                appendContext('<reference type="codebase">The user explicitly requests codebase-wide reasoning. Start with codebase_search, then narrow down via read_file/grep_search before editing.</reference>');
                continue;
            }

            if (ref.type === 'file' && fileCount >= AT_REF_MAX_FILES) {
                unresolved.push({ ref, reason: `file reference limit reached (${AT_REF_MAX_FILES})` });
                continue;
            }
            if (ref.type === 'folder' && folderCount >= AT_REF_MAX_FOLDERS) {
                unresolved.push({ ref, reason: `folder reference limit reached (${AT_REF_MAX_FOLDERS})` });
                continue;
            }

            let candidate = ref.value;
            let stat = await window.electronAPI?.projectStatPath(project.path, candidate);
            if (ref.type === 'file' && (!stat?.success || !stat?.exists || !stat?.isFile)) {
                const fallbackPath = await resolveFileBySearch(candidate);
                if (fallbackPath) {
                    candidate = fallbackPath;
                    stat = await window.electronAPI?.projectStatPath(project.path, candidate);
                }
            }

            if (!stat?.success || !stat?.exists) {
                unresolved.push({ ref, reason: 'target not found in workspace' });
                references.push({
                    type: ref.type,
                    label: `@${ref.raw}`,
                    status: 'unresolved',
                    reason: 'not found',
                });
                continue;
            }

            const relPath = stat.relativePath || candidate;
            if (ref.type === 'file') {
                if (!stat.isFile) {
                    unresolved.push({ ref, reason: 'target is not a file' });
                    references.push({
                        type: 'file',
                        label: `@${ref.raw}`,
                        status: 'unresolved',
                        reason: 'not a file',
                    });
                    continue;
                }
                const content = await window.electronAPI?.readFileContent(stat.absPath);
                const clipped = clipByLines(content, AT_REF_FILE_MAX_LINES);
                references.push({
                    type: 'file',
                    label: `@${ref.raw}`,
                    status: 'resolved',
                    relativePath: relPath,
                });
                appendContext(`<reference type="file" path="${relPath}">\n${clipped.text}\n${clipped.truncated ? '\n...(truncated)' : ''}\n</reference>`);
                fileCount++;
                continue;
            }

            if (!stat.isDirectory) {
                unresolved.push({ ref, reason: 'target is not a folder' });
                references.push({
                    type: 'folder',
                    label: `@${ref.raw}`,
                    status: 'unresolved',
                    reason: 'not a folder',
                });
                continue;
            }

            const entries = await window.electronAPI?.readDir(stat.absPath) || [];
            const listText = entries
                .slice(0, 40)
                .map(e => `${e.isDirectory ? '[DIR]' : '[FILE]'} ${e.name}`)
                .join('\n');
            const hasMore = entries.length > 40;

            references.push({
                type: 'folder',
                label: `@${ref.raw}`,
                status: 'resolved',
                relativePath: relPath,
                entryCount: entries.length,
            });
            appendContext(`<reference type="folder" path="${relPath}">\n${listText || '(empty folder)'}${hasMore ? '\n...(more entries omitted)' : ''}\n</reference>`);
            folderCount++;
        }

        if (unresolved.length > 0) {
            const unresolvedText = unresolved
                .map(x => `- @${x.ref.raw}: ${x.reason}`)
                .join('\n');
            appendContext(`<unresolved_references>\n${unresolvedText}\n</unresolved_references>`);
        }

        contextParts.push('</explicit_references>');
        const contextBlock = references.length > 0 ? contextParts.join('\n') : '';
        return { references, contextBlock };
    }, [project?.path]);

    // ===== 编辑消息重发 =====
    const handleEditMessage = useCallback(async (editMsg) => {
        if (!editMsg?.id) return;
        const idx = activeMessages.findIndex(m => m.id === editMsg.id);
        if (idx < 0) return;
        const truncated = activeMessages.slice(0, idx);
        setActiveMessages(truncated);
        if (activeSessionId) {
            await window.electronAPI?.chatUpdate(activeSessionId, { messages: truncated });
        }
    }, [activeMessages, activeSessionId]);

    // ===== 主发送消息 =====
    const handleSendMessage = async (text, model, messageAttachments = [], options = {}) => {
        globalLogger.info('AgentChat', `[用户消息] ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`, `模式=${chatMode} | 模型=${model?.displayName || '未选择'} | 全文长度=${text.length}`);

        // 预读取所有附件内容（在 File 对象仍有效时立即读取）
        let resolvedAttachments = [];
        if (messageAttachments.length > 0) {
            resolvedAttachments = await Promise.all(messageAttachments.map(async (att) => {
                const base = { name: att.name, type: att.type, size: att.size, preview: att.preview };
                if (!att.file) return { ...base, content: null };
                try {
                    if (att.type?.startsWith('image/')) {
                        const base64 = await new Promise((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onload = () => resolve(reader.result);
                            reader.onerror = reject;
                            reader.readAsDataURL(att.file);
                        });
                        return { ...base, content: base64, isImage: true };
                    } else {
                        const content = await new Promise((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onload = () => resolve(reader.result);
                            reader.onerror = reject;
                            reader.readAsText(att.file);
                        });
                        const truncated = content.length > 50000 ? content.substring(0, 50000) + '\n...(文件内容过长，已截断)' : content;
                        return { ...base, content: truncated, isImage: false };
                    }
                } catch (e) {
                    return { ...base, content: null, error: e.message };
                }
            }));
        }

        let atRefResolution = { references: [], contextBlock: '' };
        try {
            atRefResolution = await resolveAtReferences(text);
            if (atRefResolution.references.length > 0) {
                const resolvedCount = atRefResolution.references.filter(r => r.status === 'resolved').length;
                globalLogger.info(
                    'AgentChat',
                    `[@ references] ${resolvedCount}/${atRefResolution.references.length} resolved`,
                    atRefResolution.references.map(r => `${r.status}:${r.relativePath || r.label}`).join(', ').substring(0, 300)
                );
            }
        } catch (e) {
            globalLogger.warn('AgentChat', 'Failed to resolve @ references', e?.message || 'unknown error');
        }

        const userMsg = {
            id: Date.now(), role: 'user', text, mode: chatMode,
            attachments: resolvedAttachments.length > 0 ? resolvedAttachments.map(a => ({
                name: a.name, type: a.type, size: a.size, preview: a.preview,
            })) : undefined,
            references: atRefResolution.references.length > 0 ? atRefResolution.references : undefined,
        };
        const newMessages = [...activeMessages, userMsg];
        setActiveMessages(newMessages);
        await window.electronAPI?.chatUpdate(activeSessionId, { messages: newMessages });
        await refreshSessions();

        if (!model?.id) {
            const errMsg = {
                id: Date.now() + 1,
                role: 'ai',
                text: '请先在底部工具栏选择一个模型，或前往 设置 -> Model 添加模型配置。',
                mode: chatMode,
            };
            const updated = [...newMessages, errMsg];
            setActiveMessages(updated);
            await window.electronAPI?.chatUpdate(activeSessionId, { messages: updated });
            await refreshSessions();
            return;
        }

        setIsGenerating(true);
        setGeneratingStartTime(Date.now());
        globalLogger.info('AgentChat', `[调用LLM] ${model.displayName} (${chatMode})`, `modelId=${model.id}`);

        // AI 自动生成会话标题：仅第一条消息触发（标题仍是默认“新对话”时）
        if (activeSessionTitle.startsWith('新对话') && activeMessages.length <= 1) {
            window.electronAPI?.chatGenerateTitle({ modelId: model.id, userMessage: text })
                .then(r => {
                    if (r?.success && r.data) {
                        setActiveSessionTitle(r.data);
                        window.electronAPI?.chatUpdate(activeSessionId, { title: r.data });
                        refreshSessions();
                        globalLogger.info('AgentChat', `[会话标题] ${r.data}`);
                    }
                }).catch(() => { });
        }

        // ============================================================
        // Agent 模式 v2: 走 Agent Loop IPC（tool_calls -> execute -> continue）
        // v1 模式回退到与其它模式一致的 llmStream 流程
        // ============================================================
        const effectiveChatMode = chatMode === 'autoAgent' ? 'agent' : chatMode;
        const isAutoAgent = chatMode === 'autoAgent';

        if (effectiveChatMode === 'agent' && agentEngine === 'v2') {
            const aiMsgId = Date.now() + 1;
            const placeholderAiMsg = {
                id: aiMsgId, role: 'ai', text: '', answerText: '',
                thoughtSummaryZh: '', isReasoningModel: false,
                mode: 'agent', streaming: true,
                agentToolCalls: [], agentTodos: [],
                availableSkills: [], matchedSkills: [], injectedSkills: [], usedSkills: [],
                agentThinkingTexts: [], agentReasoningTexts: [],
                agentCurrentThinking: '', agentCurrentReasoning: '', agentReasoningStart: null,
                agentConclusion: '',
            };
            setActiveMessages(prev => [...prev, placeholderAiMsg]);
            setAgentToolCalls([]);
            setAgentTodos([]);
            setAgentState('planning');
            setAgentIteration(0);
            setAgentToolCallCount(0);
            setPendingQuestion(null);
            setPendingModeSwitch(null);

            const agentSessionId = `agent_${Date.now()}`;
            agentSessionRef.current = agentSessionId;
            agentTextBufRef.current = '';
            agentReasoningBufRef.current = '';
            agentReasoningStartRef.current = null;
            agentBatchRef.current = 0;

            // 清除旧的 Agent 事件监听
            window.electronAPI?.removeAllAgentListeners?.();

            // 注册 Agent 事件
            window.electronAPI?.onAgentEvent('stream-content', (data) => {
                if (data.sessionId !== agentSessionId) return;
                const delta = data.content || '';
                // 将文本输出记录到全局监测
                if (delta && delta.trim()) {
                    globalLogger.info('Agent:Text', `📝 文本输出`, delta.substring(0, 200));
                }
                agentTextBufRef.current += delta;
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                        ...last,
                        answerText: data.fullContent || (last.answerText + delta),
                        text: data.fullContent || (last.answerText + delta),
                        agentCurrentThinking: agentTextBufRef.current,
                    };
                    return updated;
                });
            });

            window.electronAPI?.onAgentEvent('stream-reasoning', (data) => {
                if (data.sessionId !== agentSessionId) return;
                // 将思考内容记录到全局监测
                const reasonChunk = data.content || '';
                if (reasonChunk && reasonChunk.trim()) {
                    globalLogger.info('Agent:Reasoning', `🧠 思考中...`, reasonChunk.substring(0, 200));
                }
                if (!agentReasoningStartRef.current) {
                    agentReasoningStartRef.current = Date.now();
                }
                agentReasoningBufRef.current += reasonChunk;
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                        ...last,
                        thoughtSummaryZh: (last.thoughtSummaryZh || '') + reasonChunk,
                        isReasoningModel: true,
                        agentCurrentReasoning: agentReasoningBufRef.current,
                        agentReasoningStart: agentReasoningStartRef.current,
                    };
                    return updated;
                });
            });

            window.electronAPI?.onAgentEvent('state-change', (data) => {
                if (data.sessionId !== agentSessionId) return;
                globalLogger.debug('AgentChat', `[状态变更] ${data.from || '?'} -> ${data.to}`, `迭代=${data.iteration || 0}`);
                setAgentState(data.to);
                setAgentIteration(data.iteration || 0);
                setAgentStateStartTime(Date.now());
                if (data.to !== 'executing_tools') {
                    setAgentActiveToolName(null);
                    setAgentParallelInfo(null);
                }
                // 同步 agentState 到消息中，供 UI 组件读取
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    updated[updated.length - 1] = { ...last, agentState: data.to };
                    return updated;
                });
            });

            window.electronAPI?.onAgentEvent('tool-calls-received', (data) => {
                if (data.sessionId !== agentSessionId) return;
                const toolNames = (data.toolCalls || []).map(tc => tc.function?.name || '?').join(', ');
                globalLogger.info('AgentChat', `[工具调用] ${toolNames}`, `批次=${agentBatchRef.current} | 数量=${(data.toolCalls || []).length}`);
                const batch = agentBatchRef.current;
                agentBatchRef.current++;
                const thinkingText = agentTextBufRef.current.trim();
                agentTextBufRef.current = '';
                if (thinkingText) {
                    globalLogger.info('Agent:Think', `🧠 思考完成 (批次${batch})`, thinkingText.substring(0, 500) + (thinkingText.length > 500 ? '...' : ''));
                }
                const reasoningText = agentReasoningBufRef.current.trim();
                const reasoningDuration = agentReasoningStartRef.current
                    ? Date.now() - agentReasoningStartRef.current : 0;
                agentReasoningBufRef.current = '';
                agentReasoningStartRef.current = null;
                if (reasoningText) {
                    globalLogger.info('Agent:Reasoning', `💭 推理完成 (批次${batch}, ${(reasoningDuration / 1000).toFixed(1)}s)`, reasoningText.substring(0, 500) + (reasoningText.length > 500 ? '...' : ''));
                }

                const newCalls = (data.toolCalls || []).map(tc => ({
                    ...tc, status: 'pending', result: null, elapsed: null, _batch: batch,
                }));
                setAgentToolCalls(prev => [...prev, ...newCalls]);

                // 用 onDone 返回的清洗后 content 覆盖流式期间累积的 answerText，
                // 避免 XML/[Tool Call:] 原始文本残留在 UI。
                const cleaned = typeof data.cleanedContent === 'string' ? data.cleanedContent : null;

                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    const thinkingTexts = [...(last.agentThinkingTexts || [])];
                    thinkingTexts[batch] = thinkingText;
                    const reasoningTexts = [...(last.agentReasoningTexts || [])];
                    reasoningTexts[batch] = { text: reasoningText, durationMs: reasoningDuration };
                    updated[updated.length - 1] = {
                        ...last,
                        answerText: cleaned !== null ? cleaned : last.answerText,
                        text: cleaned !== null ? cleaned : last.text,
                        agentToolCalls: [...(last.agentToolCalls || []), ...newCalls],
                        agentThinkingTexts: thinkingTexts,
                        agentReasoningTexts: reasoningTexts,
                        agentCurrentThinking: '', // 清空当前思考文本，因为工具调用已接收
                        agentCurrentReasoning: '',
                        agentReasoningStart: null,
                    };
                    return updated;
                });
                // 清空缓冲，防止原始工具调用文本残留在 UI。
                agentTextBufRef.current = '';
            });

            // 流式工具调用增量更新：实时显示正在生成的工具参数（代码等）
            window.electronAPI?.onAgentEvent('tool-call-delta', (data) => {
                if (data.sessionId !== agentSessionId) return;
                const { index, toolCall } = data;
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    const calls = [...(last.agentToolCalls || [])];
                    // 寻找当前 batch 中对应 index 的流式 tool call
                    const pendingCalls = calls.filter(tc => tc.status === 'pending' || tc._streaming);
                    if (pendingCalls.length > 0) {
                        const target = pendingCalls[pendingCalls.length - 1];
                        const targetIdx = calls.indexOf(target);
                        if (targetIdx >= 0 && toolCall?.function?.arguments) {
                            calls[targetIdx] = {
                                ...calls[targetIdx],
                                _streaming: true,
                                _streamingArgs: (calls[targetIdx]._streamingArgs || '') + toolCall.function.arguments,
                                function: {
                                    ...calls[targetIdx].function,
                                    arguments: (calls[targetIdx]._streamingArgs || '') + toolCall.function.arguments,
                                },
                            };
                            updated[updated.length - 1] = { ...last, agentToolCalls: calls };
                        }
                    }
                    return updated;
                });
            });

            window.electronAPI?.onAgentEvent('tool-executing', (data) => {
                if (data.sessionId !== agentSessionId) return;
                globalLogger.info('Agent:Tool', `🔧 执行工具: ${data.toolName}`, `toolCallId=${data.toolCallId}`);
                setAgentToolCalls(prev => prev.map(tc =>
                    tc.id === data.toolCallId ? { ...tc, status: 'running' } : tc
                ));
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                        ...last,
                        agentToolCalls: (last.agentToolCalls || []).map(tc =>
                            tc.id === data.toolCallId ? { ...tc, status: 'running' } : tc
                        ),
                    };
                    return updated;
                });
            });

            window.electronAPI?.onAgentEvent('tool-result', (data) => {
                if (data.sessionId !== agentSessionId) return;
                const resultStatus = data.output?.success ? 'success' : 'failed';
                if (data.output?.success) {
                    globalLogger.success('Agent:Tool', `✅ 工具成功: ${data.toolName}`, `耗时=${data.elapsed || 0}ms`);
                } else {
                    const errorDetail = data.output?.error || data.output?.message || '未知错误';
                    const errorCode = data.output?.code || 'UNKNOWN';
                    globalLogger.error('Agent:Tool', `❌ 工具报错: ${data.toolName} [${errorCode}]`, errorDetail.substring(0, 500));
                }
                setAgentToolCallCount(prev => prev + 1);
                setAgentToolCalls(prev => prev.map(tc =>
                    tc.id === data.toolCallId ? { ...tc, status: resultStatus, result: data.output, elapsed: data.elapsed } : tc
                ));
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                        ...last,
                        agentToolCalls: (last.agentToolCalls || []).map(tc =>
                            tc.id === data.toolCallId ? { ...tc, status: resultStatus, result: data.output, elapsed: data.elapsed } : tc
                        ),
                    };
                    return updated;
                });
                // 文件操作工具完成后自动刷新已打开文件内容
                const writeTools = ['write_file', 'edit_file', 'delete_file'];
                if (writeTools.includes(data.toolName) && data.output?.success) {
                    handleStepApplied(data.output?.path || data.output?.filePath);
                }
            });

            window.electronAPI?.onAgentEvent('approval-needed', (data) => {
                if (data.sessionId !== agentSessionId) return;
                setAgentToolCalls(prev => prev.map(tc =>
                    tc.id === data.toolCallId ? { ...tc, status: 'awaiting_approval', riskLevel: data.riskLevel } : tc
                ));
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                        ...last,
                        agentToolCalls: (last.agentToolCalls || []).map(tc =>
                            tc.id === data.toolCallId ? { ...tc, status: 'awaiting_approval', riskLevel: data.riskLevel } : tc
                        ),
                    };
                    return updated;
                });
            });

            window.electronAPI?.onAgentEvent('ask-question', (data) => {
                if (data.sessionId && data.sessionId !== agentSessionId) return;
                setPendingQuestion({
                    sessionId: agentSessionId,
                    toolCallId: data.toolCallId,
                    title: data.title || null,
                    questions: data.questions || [],
                });
            });

            window.electronAPI?.onAgentEvent('mode-switch-request', (data) => {
                if (data.sessionId && data.sessionId !== agentSessionId) return;
                setPendingModeSwitch({
                    sessionId: agentSessionId,
                    toolCallId: data.toolCallId,
                    targetMode: data.target_mode || 'plan',
                    explanation: data.explanation || '',
                });
                setAgentToolCalls(prev => prev.map(tc =>
                    tc.id === data.toolCallId
                        ? {
                            ...tc,
                            status: 'awaiting_approval',
                            riskLevel: 'medium',
                            modeSwitch: {
                                targetMode: data.target_mode || 'plan',
                                explanation: data.explanation || '',
                            },
                        }
                        : tc
                ));
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                        ...last,
                        agentToolCalls: (last.agentToolCalls || []).map(tc =>
                            tc.id === data.toolCallId
                                ? {
                                    ...tc,
                                    status: 'awaiting_approval',
                                    riskLevel: 'medium',
                                    modeSwitch: {
                                        targetMode: data.target_mode || 'plan',
                                        explanation: data.explanation || '',
                                    },
                                }
                                : tc
                        ),
                    };
                    return updated;
                });
            });

            window.electronAPI?.onAgentEvent('mode-switched', (data) => {
                if (data.sessionId && data.sessionId !== agentSessionId) return;
                setPendingModeSwitch(null);
                const nextMode = data.to_mode || data.target_mode;
                if (nextMode) setChatMode(nextMode);
                setAgentToolCalls(prev => prev.map(tc =>
                    tc.id === data.toolCallId ? { ...tc, status: 'success' } : tc
                ));
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    const notes = [...(last.agentProgressNotes || [])];
                    notes.push({
                        text: `Mode switched: ${(data.from_mode || 'agent')} -> ${(data.to_mode || nextMode || 'unknown')}`,
                        ts: Date.now(),
                    });
                    updated[updated.length - 1] = {
                        ...last,
                        agentProgressNotes: notes,
                        agentToolCalls: (last.agentToolCalls || []).map(tc =>
                            tc.id === data.toolCallId ? { ...tc, status: 'success' } : tc
                        ),
                    };
                    return updated;
                });
            });

            window.electronAPI?.onAgentEvent('mode-switch-declined', (data) => {
                if (data.sessionId && data.sessionId !== agentSessionId) return;
                setPendingModeSwitch(null);
                setAgentToolCalls(prev => prev.map(tc =>
                    tc.id === data.toolCallId ? { ...tc, status: 'rejected' } : tc
                ));
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                        ...last,
                        agentToolCalls: (last.agentToolCalls || []).map(tc =>
                            tc.id === data.toolCallId ? { ...tc, status: 'rejected' } : tc
                        ),
                    };
                    return updated;
                });
            });

            window.electronAPI?.onAgentEvent('mode-switch-failed', (data) => {
                if (data.sessionId && data.sessionId !== agentSessionId) return;
                setPendingModeSwitch(null);
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    const notes = [...(last.agentProgressNotes || [])];
                    notes.push({ text: `Mode switch failed: ${data.error || 'unknown error'}`, ts: Date.now() });
                    updated[updated.length - 1] = { ...last, agentProgressNotes: notes };
                    return updated;
                });
            });

            window.electronAPI?.onAgentEvent('todo-update', (data) => {
                if (data.sessionId && data.sessionId !== agentSessionId) return;
                const todos = data.todos || [];
                const completed = todos.filter(t => t.status === 'completed').length;
                const total = todos.length;
                globalLogger.debug('AgentChat', `[任务清单] ${completed}/${total} 完成`, todos.map(t => `[${t.status}] ${(t.content || '').substring(0, 40)}`).join(' | '));
                setAgentTodos(todos);
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    updated[updated.length - 1] = { ...last, agentTodos: data.todos || [] };
                    return updated;
                });
            });

            window.electronAPI?.onAgentEvent('progress-note', (data) => {
                if (data.sessionId !== agentSessionId) return;

                // 提取并行执行信息并更新状态栏
                if (data.isToolProgress) {
                    if (data.parallelBatch) {
                        setAgentParallelInfo({ count: data.parallelBatch.count, completed: 0 });
                        setAgentActiveToolName(null);
                        setAgentStateStartTime(Date.now());
                    } else if (data.parallelProgress) {
                        setAgentParallelInfo(prev => prev ? { ...prev, completed: data.parallelProgress.completed } : null);
                        setAgentActiveToolName(data.parallelProgress.toolName);
                    } else if (data.parallelBatchDone) {
                        setAgentParallelInfo(null);
                        setAgentActiveToolName(null);
                    } else if (!data.parallelBatch && !data.parallelProgress && !data.parallelBatchDone) {
                        const match = data.text?.match(/^(?:Running |✓\s*)(\S+)/);
                        if (match) setAgentActiveToolName(match[1]);
                    }
                }

                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];

                    // Layer 4: Heartbeat events update agentHeartbeat only (no append)
                    if (data.isHeartbeat) {
                        updated[updated.length - 1] = { ...last, agentHeartbeat: data.text };
                        return updated;
                    }

                    // Non-heartbeat: append to progress notes, clear heartbeat
                    const notes = [...(last.agentProgressNotes || [])];
                    notes.push({ text: data.text, ts: Date.now() });
                    if (notes.length > 50) notes.splice(0, notes.length - 50);
                    updated[updated.length - 1] = { ...last, agentProgressNotes: notes, agentHeartbeat: '' };
                    return updated;
                });
            });

            window.electronAPI?.onAgentEvent('gate-failed', (data) => {
                if (data.sessionId !== agentSessionId) return;
                const reasonText = (data.reasons || []).join(' / ');
                globalLogger.warn('AgentChat', `[Gate failed] retry=${data.retries || 0}`, reasonText);
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                        ...last,
                        agentGateFailure: { reasons: data.reasons || [], retries: data.retries || 0 },
                        agentConclusion: `经过 ${data.retries || 0} 轮自动修复后，以下问题仍未通过：${reasonText}`,
                    };
                    return updated;
                });
            });

            window.electronAPI?.onAgentEvent('workflow-matched', (data) => {
                if (data.sessionId !== agentSessionId) return;
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                        ...last,
                        activeWorkflow: { name: data.name, workflowId: data.workflowId, steps: data.steps },
                    };
                    return updated;
                });
            });

            window.electronAPI?.onAgentEvent('workflow-step-update', (data) => {
                if (data.sessionId !== agentSessionId) return;
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId || !last.activeWorkflow) return prev;
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                        ...last,
                        activeWorkflow: { ...last.activeWorkflow, steps: data.steps },
                    };
                    return updated;
                });
            });

            window.electronAPI?.onAgentEvent('skills-matched', (data) => {
                if (data.sessionId !== agentSessionId) return;
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                        ...last,
                        // Keep skill matching data internal; do not render top skill panel.
                        matchedSkills: [],
                        availableSkills: [],
                        injectedSkills: [],
                        usedSkills: [],
                    };
                    return updated;
                });
            });

            window.electronAPI?.onAgentEvent('skill-injected', (data) => {
                if (data.sessionId !== agentSessionId) return;
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    const injectedSet = new Set(last.injectedSkills || []);
                    injectedSet.add(data.name);
                    updated[updated.length - 1] = {
                        ...last,
                        matchedSkills: [],
                        availableSkills: [],
                        injectedSkills: [...injectedSet],
                    };
                    return updated;
                });
            });

            window.electronAPI?.onAgentEvent('skill-used', (data) => {
                if (data.sessionId !== agentSessionId) return;
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    const usedSet = new Set(last.usedSkills || []);
                    usedSet.add(data.name);
                    const notes = [...(last.agentProgressNotes || [])];
                    notes.push({ text: `Skill used: ${data.name}`, ts: Date.now() });
                    updated[updated.length - 1] = { ...last, usedSkills: [...usedSet], agentProgressNotes: notes };
                    return updated;
                });
            });

            // 终态事件监听：固化到消息 badge（badge 是唯一终态展示源）
            window.electronAPI?.onAgentEvent('incomplete', (data) => {
                if (data.sessionId !== agentSessionId) return;
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                        ...last,
                        agentTerminalState: 'incomplete',
                        agentTerminalReasons: data.reasons || [],
                        agentTerminalPendingTodos: data.pendingTodos || [],
                    };
                    return updated;
                });
            });

            window.electronAPI?.onAgentEvent('cancelled', (data) => {
                if (data.sessionId !== agentSessionId) return;
                setIsGenerating(false);
                setGeneratingStartTime(null);
                setAgentState('idle');
                setAgentActiveToolName(null);
                setAgentParallelInfo(null);
                setAgentStateStartTime(null);
                setPendingQuestion(null);
                setPendingModeSwitch(null);
                setAgentToolCalls(prev => (prev || []).map(tc => {
                    if (['success', 'failed', 'cancelled', 'rejected'].includes(tc.status)) {
                        return { ...tc, _streaming: false };
                    }
                    return { ...tc, status: 'cancelled', _streaming: false };
                }));
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    const normalizedCalls = (last.agentToolCalls || []).map(tc => {
                        if (['success', 'failed', 'cancelled', 'rejected'].includes(tc.status)) {
                            return { ...tc, _streaming: false };
                        }
                        return { ...tc, status: 'cancelled', _streaming: false };
                    });
                    updated[updated.length - 1] = {
                        ...last,
                        streaming: false,
                        agentCurrentThinking: '',
                        agentCurrentReasoning: '',
                        agentHeartbeat: '',
                        agentToolCalls: normalizedCalls,
                        agentTerminalState: 'cancelled',
                    };
                    return updated;
                });
            });

            try {
                // 构建精炼的对话历史：
                // - 用户消息完整保留（最近 10 条）
                // - AI 结论保留（非执行中间态）
                // - 结构化注入，减少噪音
                const priorMessages = newMessages.slice(0, -1);
                const relevantMessages = priorMessages
                    .filter(m => m.role === 'user' || m.role === 'ai')
                    .slice(-6);

                const conversationHistory = [];
                for (const m of relevantMessages) {
                    if (m.role === 'user') {
                        conversationHistory.push(`[用户] ${(m.text || '').substring(0, 300)}`);
                    } else {
                        const conclusion = m.agentConclusion || m.answerText || m.text || '';
                        if (conclusion.trim().length > 10) {
                            conversationHistory.push(`[助手] ${conclusion.substring(0, 500)}`);
                        }
                    }
                }

                let historyContext = text;
                if (conversationHistory.length > 0) {
                    historyContext = `<conversation_history>\n${conversationHistory.join('\n\n')}\n</conversation_history>\n\n当前用户请求:\n${text}`;
                }

                // 处理附件：将预读取内容注入到消息中
                if (resolvedAttachments.length > 0) {
                    const attachmentTexts = [];
                    for (const att of resolvedAttachments) {
                        if (att.content) {
                            if (att.isImage) {
                                attachmentTexts.push(`<attachment name="${att.name}" type="${att.type}" encoding="base64">\n[图片文件: ${att.name} (${(att.size / 1024).toFixed(1)}KB)]\nBase64 Data URI: ${att.content}\n</attachment>`);
                            } else {
                                attachmentTexts.push(`<attachment name="${att.name}" type="${att.type}">\n${att.content}\n</attachment>`);
                            }
                        } else if (att.error) {
                            attachmentTexts.push(`<attachment name="${att.name}" type="${att.type}">\n[无法读取文件内容: ${att.error}]\n</attachment>`);
                        }
                    }
                    if (attachmentTexts.length > 0) {
                        historyContext += `\n\n<user_attachments>\n用户附带了以下文件，请仔细阅读并在回答中参考这些内容：\n${attachmentTexts.join('\n\n')}\n</user_attachments>`;
                    }
                }

                // 读取 agent 配置（评分线、压缩阈值）
                if (atRefResolution.contextBlock) {
                    historyContext += `\n\n${atRefResolution.contextBlock}`;
                }

                let agentConfig = {};
                try {
                    const cfgResp = await window.electronAPI?.modeConfigGet();
                    if (cfgResp?.success) agentConfig = cfgResp.data?.agent || {};
                } catch (_) { }

                // 模型级压缩阈值优先于通用设置
                const modelCompressThreshold = (typeof model.compressThreshold === 'number' && model.compressThreshold > 0)
                    ? model.compressThreshold
                    : agentConfig.compressThreshold;

                const result = await window.electronAPI?.agentStart({
                    sessionId: agentSessionId,
                    chatSessionId: activeSessionId,
                    modelId: model.id,
                    userMessage: historyContext,
                    atReferences: atRefResolution.references || [],
                    projectPath: project?.path,
                    mode: 'agent',
                    openFiles: openFiles.map(f => ({ path: f.path || f.id, cursorLine: null })),
                    autoApprove: true,
                    webSearchEnabled: options.webSearchEnabled || false,
                    evalPassScore: agentConfig.evalPassScore,
                    compressThreshold: modelCompressThreshold,
                    autoAgent: isAutoAgent,
                });

                window.electronAPI?.removeAllAgentListeners?.();

                const isSuccess = result?.success !== false;
                const isIncomplete = result?.code === 'E_INCOMPLETE';

                if (isSuccess) {
                    globalLogger.success('AgentChat', `[Agent完成] 迭代=${result?.iteration || 0} 工具调用=${result?.toolCallCount || 0}`, (result?.finalContent || '').substring(0, 200));
                } else if (isIncomplete) {
                    globalLogger.warn('AgentChat', `[Agent未完成] 迭代=${result?.iteration || 0}`, (result?.gateReasons || []).join('；') || '达到最大执行轮次');
                } else {
                    globalLogger.error('AgentChat', `[Agent失败] ${result?.error || '未知错误'}`, (result?.gateReasons || []).join('；'));
                }

                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    const remainingThinking = agentTextBufRef.current.trim();

                    let finalMsg;
                    if (isSuccess) {
                        const conclusion = remainingThinking || result?.finalContent || '';
                        finalMsg = {
                            ...last,
                            text: result?.finalContent || last.answerText || '(Agent 执行完成)',
                            answerText: result?.finalContent || last.answerText || '',
                            agentConclusion: conclusion,
                            agentCurrentThinking: '',
                            streaming: false,
                            agentResult: { iterations: result?.iteration, toolCalls: result?.toolCallCount },
                            agentTerminalState: 'complete',
                        };
                    } else if (isIncomplete) {
                        // 未完成停止（达到最大轮次或 gate 限制）
                        const conclusion = remainingThinking || result?.finalContent || '任务未完成';
                        finalMsg = {
                            ...last,
                            text: result?.finalContent || last.answerText || conclusion,
                            answerText: result?.finalContent || last.answerText || '',
                            agentConclusion: conclusion,
                            agentCurrentThinking: '',
                            streaming: false,
                            agentResult: { iterations: result?.iteration, toolCalls: result?.toolCallCount, incomplete: true },
                            agentTerminalState: 'incomplete',
                            agentTerminalReasons: result?.gateReasons || ['达到最大执行轮次'],
                            agentTerminalPendingTodos: result?.pendingTodos || [],
                        };
                    } else {
                        // gate 失败或其他失败
                        const gateReasons = result?.gateReasons || [];
                        const errorMsg = result?.error || '未知错误';
                        const failureText = gateReasons.length > 0
                            ? `以下验收项未通过：\n\n${gateReasons.map(r => `- ${r}`).join('\n')}`
                            : `<agent-error>${errorMsg}</agent-error>`;
                        finalMsg = {
                            ...last,
                            text: failureText,
                            answerText: failureText,
                            agentConclusion: last.agentConclusion || failureText,
                            agentCurrentThinking: '',
                            streaming: false,
                            agentResult: { iterations: result?.iteration, toolCalls: result?.toolCallCount, failed: true },
                            agentTerminalState: 'failed',
                            agentTerminalReasons: gateReasons,
                        };
                    }
                    updated[updated.length - 1] = finalMsg;
                    window.electronAPI?.chatUpdate(activeSessionId, { messages: updated });
                    refreshSessions();
                    return updated;
                });

            } catch (e) {
                window.electronAPI?.removeAllAgentListeners?.();
                globalLogger.error('AgentChat', `[Agent异常] ${e?.message || '未知错误'}`);
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                        ...last,
                        text: `<agent-error>${e?.message || '未知错误'}</agent-error>`,
                        answerText: `<agent-error>${e?.message || '未知错误'}</agent-error>`,
                        streaming: false,
                    };
                    window.electronAPI?.chatUpdate(activeSessionId, { messages: updated });
                    refreshSessions();
                    return updated;
                });
            } finally {
                setIsGenerating(false);
                setGeneratingStartTime(null);
                setAgentState('idle');
                setAgentActiveToolName(null);
                setAgentParallelInfo(null);
                setAgentStateStartTime(null);
                agentSessionRef.current = null;
            }
            return;
        }

        // ============================================================
        // 非 Agent 模式（Ask/Plan/Debug）：走原生 llmStream 流程
        // ============================================================
        try {
            const { systemContext, citations } = await searchProjectContext(text);

            let extraContext = '';
            if (effectiveChatMode === 'debug' && activeFileId) {
                const af = openFiles.find(f => f.id === activeFileId);
                const content = fileContents[activeFileId];
                if (af && content) {
                    const truncated = content.length > 4000 ? content.substring(0, 4000) + '\n... (truncated)' : content;
                    extraContext = `Currently open file: ${af.name} (${af.path || af.relativePath || af.name})\n\`\`\`\n${truncated}\n\`\`\``;
                }
            }

            const systemPrompt = buildSystemPrompt(effectiveChatMode, systemContext, extraContext);

            // 处理附件：将预读取内容附加到最后一条用户消息
            let attachmentSuffix = '';
            if (resolvedAttachments.length > 0) {
                const attachmentTexts = [];
                for (const att of resolvedAttachments) {
                    if (att.content) {
                        if (att.isImage) {
                            attachmentTexts.push(`<attachment name="${att.name}" type="${att.type}" encoding="base64">\n[图片文件: ${att.name} (${(att.size / 1024).toFixed(1)}KB)]\nBase64 Data URI: ${att.content}\n</attachment>`);
                        } else {
                            attachmentTexts.push(`<attachment name="${att.name}" type="${att.type}">\n${att.content}\n</attachment>`);
                        }
                    } else if (att.error) {
                        attachmentTexts.push(`<attachment name="${att.name}" type="${att.type}">\n[无法读取文件内容: ${att.error}]\n</attachment>`);
                    }
                }
                if (attachmentTexts.length > 0) {
                    attachmentSuffix = `\n\n<user_attachments>\n用户附带了以下文件，请仔细阅读并在回答中参考这些内容：\n${attachmentTexts.join('\n\n')}\n</user_attachments>`;
                }
            }

            if (atRefResolution.contextBlock) {
                attachmentSuffix += `\n\n${atRefResolution.contextBlock}`;
            }

            const apiMessages = [
                { role: 'system', text: systemPrompt },
                ...newMessages.map((m, idx) => ({
                    role: m.role === 'ai' ? 'assistant' : 'user',
                    text: (m.answerText || m.text || '') + (idx === newMessages.length - 1 && m.role === 'user' ? attachmentSuffix : ''),
                }))
            ];

            const aiMsgId = Date.now() + 1;
            const placeholderAiMsg = {
                id: aiMsgId, role: 'ai', text: '', answerText: '',
                thoughtSummaryZh: '', thoughtDurationMs: 0, isReasoningModel: false,
                citations: citations.length > 0 ? citations : undefined,
                mode: chatMode, streaming: true,
            };
            const messagesWithPlaceholder = [...newMessages, placeholderAiMsg];
            setActiveMessages(messagesWithPlaceholder);
            streamingMsgRef.current = placeholderAiMsg;

            const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            activeRequestIdRef.current = requestId;

            window.electronAPI?.removeAllStreamListeners?.();

            window.electronAPI?.onStreamChunk((data) => {
                if (data.requestId !== requestId) return;
                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    const msg = { ...last };
                    if (data.content !== undefined) {
                        msg.answerText = data.fullContent || (msg.answerText + data.content);
                        msg.text = msg.answerText;
                    }
                    if (data.reasoning !== undefined) {
                        msg.thoughtSummaryZh = data.fullReasoning || (msg.thoughtSummaryZh + data.reasoning);
                        msg.isReasoningModel = true;
                    }
                    if (data.toolCalls !== undefined) {
                        msg.toolCalls = msg.toolCalls || [];
                        data.toolCalls.forEach(tc => {
                            const idx = tc.index !== undefined ? tc.index : msg.toolCalls.length;
                            if (!msg.toolCalls[idx]) {
                                msg.toolCalls[idx] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
                            }
                            if (tc.id) msg.toolCalls[idx].id = tc.id;
                            if (tc.type) msg.toolCalls[idx].type = tc.type;
                            if (tc.function) {
                                if (tc.function.name) msg.toolCalls[idx].function.name += tc.function.name;
                                if (tc.function.arguments) msg.toolCalls[idx].function.arguments += tc.function.arguments;
                            }
                        });
                    }
                    updated[updated.length - 1] = msg;
                    return updated;
                });
            });

            const streamDonePromise = new Promise((resolve, reject) => {
                window.electronAPI?.onStreamDone((data) => {
                    if (data.requestId !== requestId) return;
                    resolve(data);
                });
                window.electronAPI?.onStreamError((data) => {
                    if (data.requestId !== requestId) return;
                    reject(data);
                });
            });

            window.electronAPI?.llmStream({
                modelId: model.id,
                messages: apiMessages,
                requestId,
            });

            try {
                const result = await streamDonePromise;
                window.electronAPI?.removeAllStreamListeners?.();

                const elapsed = result.elapsed;
                globalLogger.success('AgentChat', `[LLM回复完成] 耗时=${elapsed}ms`, (result.content || '').substring(0, 200));

                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    const finalMsg = {
                        ...last,
                        text: result.content || last.answerText || '(空回复)',
                        answerText: result.content || last.answerText || '',
                        thoughtSummaryZh: result.reasoning || last.thoughtSummaryZh || '',
                        thoughtDurationMs: elapsed,
                        isReasoningModel: result.isReasoningModel || false,
                        streaming: false,
                    };
                    updated[updated.length - 1] = finalMsg;
                    window.electronAPI?.chatUpdate(activeSessionId, { messages: updated });
                    refreshSessions();
                    return updated;
                });

            } catch (errData) {
                window.electronAPI?.removeAllStreamListeners?.();
                const errorText = `❌ **模型调用失败**\n\n${errData?.error || '未知错误'}\n\n> 错误码: ${errData?.code || 'N/A'}`;
                globalLogger.error('AgentChat', `[LLM错误] ${errData?.code || 'N/A'}`, (errData?.error || '').substring(0, 200));

                setActiveMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (!last || last.id !== aiMsgId) return prev;
                    const updated = [...prev];
                    updated[updated.length - 1] = { ...last, text: errorText, answerText: errorText, streaming: false };
                    window.electronAPI?.chatUpdate(activeSessionId, { messages: updated });
                    refreshSessions();
                    return updated;
                });
            }

        } catch (e) {
            globalLogger.error('AgentChat', `[调用异常] ${e?.message || '未知错误'}`);
            const aiMsg = { id: Date.now() + 1, role: 'ai', text: `❌ **调用异常**\n\n${e?.message || '未知错误'}`, mode: chatMode };
            const updated = [...newMessages, aiMsg];
            setActiveMessages(updated);
            await window.electronAPI?.chatUpdate(activeSessionId, { messages: updated });
            await refreshSessions();
        } finally {
            setIsGenerating(false);
            setGeneratingStartTime(null);
            activeRequestIdRef.current = null;
            streamingMsgRef.current = null;
            window.electronAPI?.removeAllStreamListeners?.();
        }
    };

    const activeFile = openFiles.find(f => f.id === activeFileId);

    // --- 高性能 Resizer（RAF 节流避免卡顿） ---
    const sidebarStartRef = useRef(sidebarWidth);
    const chatStartRef = useRef(chatWidth);
    const resizeRafRef = useRef(null);

    const handleSidebarResizeStart = useCallback((e) => {
        e.preventDefault();
        sidebarStartRef.current = sidebarWidth;
        const startX = e.clientX;
        const onMove = (ev) => {
            if (resizeRafRef.current) return;
            resizeRafRef.current = requestAnimationFrame(() => {
                resizeRafRef.current = null;
                const delta = ev.clientX - startX;
                setSidebarWidth(Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, sidebarStartRef.current + delta)));
            });
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            if (resizeRafRef.current) { cancelAnimationFrame(resizeRafRef.current); resizeRafRef.current = null; }
        };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }, [sidebarWidth]);

    const handleChatResizeStart = useCallback((e) => {
        e.preventDefault();
        chatStartRef.current = chatWidth;
        const startX = e.clientX;
        const onMove = (ev) => {
            if (resizeRafRef.current) return;
            resizeRafRef.current = requestAnimationFrame(() => {
                resizeRafRef.current = null;
                const delta = startX - ev.clientX;
                setChatWidth(Math.max(MIN_CHAT, Math.min(MAX_CHAT, chatStartRef.current + delta)));
            });
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            if (resizeRafRef.current) { cancelAnimationFrame(resizeRafRef.current); resizeRafRef.current = null; }
        };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }, [chatWidth]);

    if (loading) {
        return (
            <div className="flex items-center justify-center h-screen w-full bg-[#1e1e1e] text-[#999]">
                <div className="flex flex-col items-center gap-3">
                    <Loader2 size={24} className="animate-spin text-blue-400" />
                    <p className="text-[11px]">正在加载项目: {project?.name}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-screen w-full bg-[#1e1e1e] text-[#ccc] overflow-hidden font-['Inter',system-ui,-apple-system,'Segoe_UI',sans-serif] selection:bg-[#264f78] text-[12px]">
            {/* 标题栏 */}
            <div className="titlebar-drag flex items-center justify-between h-[28px] px-2 bg-[#323233] border-b border-[#1e1e1e] select-none text-[11px] text-[#888] flex-shrink-0">
                <div className="titlebar-no-drag flex items-center gap-1.5">
                    <button
                        onClick={() => { globalLogger.info('Navigation', '返回首页'); onBackToHome(); }}
                        className="flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-[#444] text-[#aaa] hover:text-white transition-colors text-[10px]"
                        title="返回启动页"
                    >
                        <ChevronRight size={10} className="rotate-180" />
                        <span>首页</span>
                    </button>
                    <span className="text-[#444]">|</span>
                </div>

                <span className="text-[#777] text-[10px]">{project?.name} - Cursor</span>

                <div className="titlebar-no-drag flex items-center gap-2">
                    {/* 布局切换控件 */}
                    <div className="flex items-center gap-[1px] bg-[#333] rounded-[2px] p-[2px] border border-[#2a2a2a]">
                        <WithTooltip text="Toggle Primary Side Bar" side="bottom">
                            <div
                                className={`flex items-center justify-center w-[28px] h-[22px] rounded-[2px] cursor-pointer transition-colors ${sidebarVisible ? 'bg-[#444] text-[#ccc]' : 'bg-transparent text-[#666] hover:bg-[#3c3c3c]'}`}
                                onClick={() => { setSidebarVisible(!sidebarVisible); globalLogger.info('Layout', '切换侧边栏', sidebarVisible ? '隐藏' : '显示'); }}
                            >
                                <LayoutSidebarLeftIcon active={sidebarVisible} />
                            </div>
                        </WithTooltip>
                        <WithTooltip text="Toggle Panel" side="bottom">
                            <div
                                className={`flex items-center justify-center w-[28px] h-[22px] rounded-[2px] cursor-pointer transition-colors ${panelVisible ? 'bg-[#444] text-[#ccc]' : 'bg-transparent text-[#666] hover:bg-[#3c3c3c]'}`}
                                onClick={() => { setPanelVisible(!panelVisible); globalLogger.info('Layout', '切换终端面板', panelVisible ? '关闭' : '打开'); }}
                            >
                                <LayoutPanelBottomIcon active={panelVisible} />
                            </div>
                        </WithTooltip>
                        <WithTooltip text="Toggle Secondary Side Bar" side="bottom">
                            <div
                                className={`flex items-center justify-center w-[28px] h-[22px] rounded-[2px] cursor-pointer transition-colors ${chatVisible ? 'bg-[#444] text-[#ccc]' : 'bg-transparent text-[#666] hover:bg-[#3c3c3c]'}`}
                                onClick={() => { setChatVisible(!chatVisible); globalLogger.info('Layout', '切换 AI 面板', chatVisible ? '关闭' : '打开'); }}
                            >
                                <LayoutSidebarRightIcon active={chatVisible} />
                            </div>
                        </WithTooltip>
                    </div>

                    {/* 窗口控制按钮 */}
                    <div className="flex items-center">
                        <div onClick={() => window.electronAPI?.windowMinimize()} className="px-2.5 h-[28px] flex items-center hover:bg-[#444] cursor-default">
                            <Minus size={11} />
                        </div>
                        <div onClick={() => window.electronAPI?.windowToggleMaximize()} className="px-2.5 h-[28px] flex items-center hover:bg-[#444] cursor-default">
                            <Square size={9} />
                        </div>
                        <div onClick={() => window.electronAPI?.windowClose()} className="px-2.5 h-[28px] flex items-center hover:bg-red-600 group cursor-default">
                            <X size={11} className="group-hover:text-white" />
                        </div>
                    </div>
                </div>
            </div>

            {/* 主布局 */}
            <div className="flex flex-1 overflow-hidden">
                <ActivityBar monitorActive={monitorVisible} onToggleMonitor={() => setMonitorVisible(v => !v)} explorerActive={sidebarVisible} onExplorerClick={handleExplorerClick} onOpenSettings={onOpenSettings} />

                {/* 文件管理器 + Resizer */}
                {sidebarVisible && (
                    <>
                        <FileExplorer
                            fileTree={fileTree}
                            onToggle={toggleFolder}
                            onSelect={openFile}
                            activeFileId={activeFileId}
                            projectName={project?.name || 'PROJECT'}
                            style={{ width: `${sidebarWidth}px`, willChange: 'width' }}
                            onRefresh={refreshFileTree}
                            projectPath={project?.path}
                            onCollapseAll={collapseAll}
                            onNewFile={createFileAtRoot}
                            onNewFolder={createFolderAtRoot}
                        />
                        <div
                            className="w-[1px] bg-[#2d2d2d] hover:w-[3px] hover:bg-[#007fd4] cursor-col-resize flex-shrink-0 z-30 transition-all duration-150"
                            onMouseDown={handleSidebarResizeStart}
                        />
                    </>
                )}

                {/* 监测面板打开时：覆盖编辑区和 AI 面板 */}
                {monitorVisible ? (
                    <MonitorPanel onClose={() => setMonitorVisible(false)} />
                ) : (
                    <>
                        {/* 编辑器区域：flex-grow 自动填充 + 底部终端 */}
                        <div className="flex-1 flex flex-col min-w-[200px] bg-[#1e1e1e]">
                            {/* 编辑器主体 */}
                            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                                {openFiles.length > 0 ? (
                                    <>
                                        <EditorTabs files={openFiles} activeId={activeFileId} onSelect={setActiveFileId} onClose={closeFile} />
                                        <CodeEditor
                                            file={activeFile}
                                            content={fileContents[activeFileId]}
                                            projectName={project?.name}
                                            isDirty={!!dirtyFiles[activeFileId]}
                                            onContentChange={handleEditorContentChange}
                                            onSave={handleSaveFile}
                                        />
                                    </>
                                ) : (
                                    <div className="flex-1 flex flex-col items-center justify-center text-gray-600">
                                        <Command size={48} className="mb-3 opacity-15" />
                                        <p className="text-[11px]">选择一个文件开始编辑</p>
                                        <div className="text-[10px] mt-3 flex gap-3 text-gray-700">
                                            <span><span className="bg-[#333] px-1 rounded text-[9px]">Ctrl</span> + <span className="bg-[#333] px-1 rounded text-[9px]">P</span> 搜索文件</span>
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* 终端面板 + 垂直 Resizer */}
                            {panelVisible && (
                                <>
                                    <div
                                        className="h-[1px] bg-[#2d2d2d] hover:h-[3px] hover:bg-[#007fd4] cursor-row-resize flex-shrink-0 z-30 transition-all duration-150"
                                        onMouseDown={(e) => {
                                            e.preventDefault();
                                            const startY = e.clientY;
                                            const startH = panelHeight;
                                            let raf = null;
                                            const onMove = (ev) => {
                                                if (raf) return;
                                                raf = requestAnimationFrame(() => {
                                                    raf = null;
                                                    const delta = startY - ev.clientY;
                                                    setPanelHeight(Math.max(MIN_PANEL, Math.min(MAX_PANEL, startH + delta)));
                                                });
                                            };
                                            const onUp = () => {
                                                document.removeEventListener('mousemove', onMove);
                                                document.removeEventListener('mouseup', onUp);
                                                document.body.style.cursor = '';
                                                document.body.style.userSelect = '';
                                                if (raf) { cancelAnimationFrame(raf); raf = null; }
                                            };
                                            document.body.style.cursor = 'row-resize';
                                            document.body.style.userSelect = 'none';
                                            document.addEventListener('mousemove', onMove);
                                            document.addEventListener('mouseup', onUp);
                                        }}
                                    />
                                    <div className="flex-shrink-0" style={{ height: `${panelHeight}px`, willChange: 'height' }}>
                                        <TerminalPanel onClose={() => setPanelVisible(false)} />
                                    </div>
                                </>
                            )}
                        </div>

                        {/* Chat Resizer + AI 面板 */}
                        {chatVisible && (
                            <>
                                <div
                                    className="w-[1px] bg-[#2d2d2d] hover:w-[3px] hover:bg-[#007fd4] cursor-col-resize flex-shrink-0 z-30 transition-all duration-150"
                                    onMouseDown={handleChatResizeStart}
                                />
                                <div className="flex-shrink-0" style={{ width: `${chatWidth}px`, willChange: 'width' }}>
                                    <AIPanel
                                        history={activeMessages}
                                        onSend={handleSendMessage}
                                        onClose={() => setChatVisible(false)}
                                        sessionTitle={activeSessionTitle}
                                        onNewChat={handleNewChat}
                                        onOpenHistory={() => setHistoryOpen(true)}
                                        onOpenMoreActions={() => setMoreActionsOpen(!moreActionsOpen)}
                                        historyOpen={historyOpen}
                                        moreActionsOpen={moreActionsOpen}
                                        sessions={sessions}
                                        activeSessionId={activeSessionId}
                                        onSelectSession={handleSelectSession}
                                        onRenameSession={handleRenameSession}
                                        onDeleteSession={handleDeleteSession}
                                        onCloseHistory={() => setHistoryOpen(false)}
                                        onCloseMoreActions={() => setMoreActionsOpen(false)}
                                        onRenameCurrentSession={handleRenameCurrentSession}
                                        onClearMessages={handleClearMessages}
                                        onExportJSON={handleExportJSON}
                                        onExportTXT={handleExportTXT}
                                        onExportMD={handleExportMD}
                                        onExportPDF={handleExportPDF}
                                        onDeleteCurrentSession={handleDeleteCurrentSession}
                                        chatMode={chatMode}
                                        onModeChange={setChatMode}
                                        isGenerating={isGenerating}
                                        generatingStartTime={generatingStartTime}
                                        onStopGeneration={handleStopGeneration}
                                        projectPath={project?.path}
                                        autoExecute={autoExecute}
                                        onStepApplied={handleStepApplied}
                                        onEditMessage={handleEditMessage}
                                        agentState={agentState}
                                        agentIteration={agentIteration}
                                        agentToolCallCount={agentToolCallCount}
                                        agentActiveToolName={agentActiveToolName}
                                        agentParallelInfo={agentParallelInfo}
                                        agentStateStartTime={agentStateStartTime}
                                        onAgentApprove={(toolCallId) => {
                                            window.electronAPI?.agentApprove({
                                                sessionId: agentSessionRef.current,
                                                toolCallId,
                                                approved: true,
                                            });
                                        }}
                                        onAgentDeny={(toolCallId) => {
                                            window.electronAPI?.agentApprove({
                                                sessionId: agentSessionRef.current,
                                                toolCallId,
                                                approved: false,
                                            });
                                        }}
                                        pendingQuestion={pendingQuestion}
                                        onQuestionSubmit={(answers) => {
                                            if (pendingQuestion) {
                                                window.electronAPI?.agentQuestionResponse({
                                                    sessionId: pendingQuestion.sessionId,
                                                    toolCallId: pendingQuestion.toolCallId,
                                                    answers,
                                                });
                                                setPendingQuestion(null);
                                            }
                                        }}
                                        onQuestionCancel={() => {
                                            if (pendingQuestion) {
                                                window.electronAPI?.agentQuestionResponse({
                                                    sessionId: pendingQuestion.sessionId,
                                                    toolCallId: pendingQuestion.toolCallId,
                                                    answers: null,
                                                });
                                                setPendingQuestion(null);
                                            }
                                        }}
                                        pendingModeSwitch={pendingModeSwitch}
                                        onModeSwitchApprove={() => {
                                            if (pendingModeSwitch) {
                                                window.electronAPI?.agentApprove({
                                                    sessionId: pendingModeSwitch.sessionId,
                                                    toolCallId: pendingModeSwitch.toolCallId,
                                                    approved: true,
                                                });
                                                setPendingModeSwitch(null);
                                            }
                                        }}
                                        onModeSwitchReject={() => {
                                            if (pendingModeSwitch) {
                                                window.electronAPI?.agentApprove({
                                                    sessionId: pendingModeSwitch.sessionId,
                                                    toolCallId: pendingModeSwitch.toolCallId,
                                                    approved: false,
                                                });
                                                setPendingModeSwitch(null);
                                            }
                                        }}
                                    />
                                </div>
                            </>
                        )}
                    </>
                )}
            </div>

            {/* 底部状态栏 */}
            <div className="h-[20px] bg-[#007acc] text-white flex items-center justify-between px-2 text-[10px] select-none flex-shrink-0">
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-0.5 cursor-pointer hover:bg-white/20 px-0.5 rounded" onClick={() => notImplemented('StatusBar', '分支切换')}>
                        <GitGraph size={10} /><span>main</span>
                    </div>
                    <div className="flex items-center gap-0.5 cursor-pointer hover:bg-white/20 px-0.5 rounded" onClick={() => notImplemented('StatusBar', '问题面板')}>
                        <X size={10} /><span>0</span>
                        <div className="w-[1px] h-2.5 bg-white/30 mx-0.5"></div>
                        <Bug size={10} /><span>0</span>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <span className="cursor-pointer hover:bg-white/20 px-0.5 rounded" onClick={() => notImplemented('StatusBar', '语言模式切换')}>
                        {activeFile?.name ? getLanguageDisplay(activeFile.name) : 'Plain Text'}
                    </span>
                    <span className="cursor-pointer hover:bg-white/20 px-0.5 rounded" onClick={() => notImplemented('StatusBar', '编码切换')}>
                        UTF-8
                    </span>
                    <div className="cursor-pointer hover:bg-white/20 px-0.5 rounded flex items-center gap-0.5" onClick={() => { setChatVisible(!chatVisible); globalLogger.info('StatusBar', '切换 AI 面板', chatVisible ? '关闭' : '打开'); }}>
                        <MessageSquare size={10} /><span>Cursor Tab</span>
                    </div>
                </div>
            </div>

            <CommandPalette visible={cmdPaletteVisible} onClose={() => setCmdPaletteVisible(false)} fileTree={fileTree} onOpenFile={openFile} />

            <style>{`
                .custom-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
                .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #444; }
            `}</style>
        </div>
    );
}
