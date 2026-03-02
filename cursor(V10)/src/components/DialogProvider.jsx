import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';

const DialogContext = createContext(null);

export const useDialog = () => {
    const ctx = useContext(DialogContext);
    if (!ctx) throw new Error('useDialog must be used within DialogProvider');
    return ctx;
};

// ============================================================
// 弹窗组件 (暗色 + 居中卡片 + 圆角 + 阴影)
// ============================================================
const DialogOverlay = ({ children, onClose, dismissOnOverlay = true, wide = false }) => {
    useEffect(() => {
        const handler = (e) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [onClose]);

    return (
        <div
            className="fixed inset-0 z-[9999] flex items-center justify-center"
            style={{ backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)' }}
            onClick={dismissOnOverlay ? onClose : undefined}
        >
            <div
                className={`bg-[#252526] border border-[#3a3a3a] rounded-lg shadow-2xl mx-4 animate-fade-in ${wide ? 'min-w-[400px] max-w-[680px] w-full' : 'min-w-[320px] max-w-[480px] w-full'}`}
                onClick={(e) => e.stopPropagation()}
            >
                {children}
            </div>
        </div>
    );
};

const DialogTitle = ({ children }) => (
    <div className="px-5 pt-4 pb-2">
        <h3 className="text-[13px] font-semibold text-[#ddd]">{children}</h3>
    </div>
);

const DialogMessage = ({ children }) => (
    <div className="px-5 pb-3">
        <p className="text-[11px] text-[#999] leading-relaxed whitespace-pre-wrap">{children}</p>
    </div>
);

const DialogActions = ({ children }) => (
    <div className="flex justify-end gap-2 px-5 pb-4 pt-1">
        {children}
    </div>
);

const Btn = ({ children, onClick, variant = 'secondary', autoFocus }) => {
    const base = 'px-4 py-[5px] text-[11px] font-medium rounded-md border transition-colors cursor-pointer outline-none focus:ring-1 focus:ring-blue-500/50';
    const styles = {
        primary: 'bg-[#0e639c] border-[#1177bb] text-white hover:bg-[#1177bb]',
        danger: 'bg-[#5a1d1d] border-[#722727] text-[#f48771] hover:bg-[#6e2222]',
        secondary: 'bg-[#2d2d2d] border-[#3a3a3a] text-[#ccc] hover:bg-[#353535]',
    };
    return (
        <button className={`${base} ${styles[variant]}`} onClick={onClick} autoFocus={autoFocus}>
            {children}
        </button>
    );
};

// ============================================================
// DialogProvider
// ============================================================
export default function DialogProvider({ children }) {
    const [queue, setQueue] = useState([]);

    const pushDialog = useCallback((dialog) => {
        return new Promise((resolve) => {
            setQueue(prev => [...prev, { ...dialog, resolve }]);
        });
    }, []);

    const closeTop = useCallback((value) => {
        setQueue(prev => {
            if (prev.length === 0) return prev;
            const top = prev[prev.length - 1];
            top.resolve(value);
            return prev.slice(0, -1);
        });
    }, []);

    // --- Public API ---
    const alert = useCallback((message, title = '提示') => {
        return pushDialog({ type: 'alert', title, message });
    }, [pushDialog]);

    const confirm = useCallback((message, title = '确认') => {
        return pushDialog({ type: 'confirm', title, message });
    }, [pushDialog]);

    const prompt = useCallback((message, defaultValue = '', title = '输入') => {
        return pushDialog({ type: 'prompt', title, message, defaultValue });
    }, [pushDialog]);

    /** Agent 应用更改确认：展示 diff，返回 true/false */
    const confirmApply = useCallback((filePath, oldContent, newContent) => {
        return pushDialog({ type: 'confirmApply', title: '应用更改', filePath, oldContent, newContent });
    }, [pushDialog]);

    const ctx = { alert, confirm, prompt, confirmApply };

    const current = queue.length > 0 ? queue[queue.length - 1] : null;

    return (
        <DialogContext.Provider value={ctx}>
            {children}
            {current && <DialogRenderer dialog={current} onClose={closeTop} />}
        </DialogContext.Provider>
    );
}

// ============================================================
// 渲染器
// ============================================================
// 简单 unified diff 行
function diffLines(oldStr, newStr) {
    const oldLines = (oldStr || '').split('\n');
    const newLines = (newStr || '').split('\n');
    const result = [];
    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
        const o = oldLines[i];
        const n = newLines[i];
        if (o === undefined) result.push({ type: 'add', num: i + 1, text: n });
        else if (n === undefined) result.push({ type: 'del', num: i + 1, text: o });
        else if (o !== n) {
            result.push({ type: 'del', num: i + 1, text: o });
            result.push({ type: 'add', num: i + 1, text: n });
        } else result.push({ type: 'ctx', num: i + 1, text: o });
    }
    return result;
}

function DialogRenderer({ dialog, onClose }) {
    const { type, title, message } = dialog;
    const [inputValue, setInputValue] = useState(dialog.defaultValue || '');
    const inputRef = useRef(null);

    useEffect(() => {
        if (type === 'prompt' && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [type]);

    if (type === 'alert') {
        return (
            <DialogOverlay onClose={() => onClose(undefined)}>
                <DialogTitle>{title}</DialogTitle>
                <DialogMessage>{message}</DialogMessage>
                <DialogActions>
                    <Btn variant="primary" onClick={() => onClose(undefined)} autoFocus>确定</Btn>
                </DialogActions>
            </DialogOverlay>
        );
    }

    if (type === 'confirm') {
        return (
            <DialogOverlay onClose={() => onClose(false)} dismissOnOverlay={false}>
                <DialogTitle>{title}</DialogTitle>
                <DialogMessage>{message}</DialogMessage>
                <DialogActions>
                    <Btn onClick={() => onClose(false)}>取消</Btn>
                    <Btn variant="primary" onClick={() => onClose(true)} autoFocus>确定</Btn>
                </DialogActions>
            </DialogOverlay>
        );
    }

    if (type === 'prompt') {
        const handleSubmit = () => onClose(inputValue.trim() || null);
        return (
            <DialogOverlay onClose={() => onClose(null)} dismissOnOverlay={false}>
                <DialogTitle>{title}</DialogTitle>
                <DialogMessage>{message}</DialogMessage>
                <div className="px-5 pb-3">
                    <input
                        ref={inputRef}
                        type="text"
                        className="w-full bg-[#181818] border border-[#3a3a3a] rounded-md px-3 py-[6px] text-[11px] text-[#ccc] outline-none focus:border-[#0e639c] transition-colors placeholder-[#555]"
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
                    />
                </div>
                <DialogActions>
                    <Btn onClick={() => onClose(null)}>取消</Btn>
                    <Btn variant="primary" onClick={handleSubmit}>确定</Btn>
                </DialogActions>
            </DialogOverlay>
        );
    }

    if (type === 'confirmApply') {
        const { filePath, oldContent, newContent } = dialog;
        const lines = diffLines(oldContent ?? '', newContent ?? '');
        const isNewFile = !oldContent || oldContent.trim() === '';
        return (
            <DialogOverlay onClose={() => onClose(false)} dismissOnOverlay={false} wide>
                <div className="max-w-[90vw] w-[640px] max-h-[85vh] flex flex-col">
                    <DialogTitle>{isNewFile ? '新建文件' : '应用更改'}</DialogTitle>
                    <div className="px-5 pb-2">
                        <p className="text-[11px] text-[#999] font-mono truncate" title={filePath}>{filePath}</p>
                    </div>
                    <div className="px-5 pb-3 flex-1 min-h-0 overflow-hidden border-t border-[#2d2d2d] pt-2">
                        <div className="bg-[#0d0d11] border border-[#2d2d3d] rounded-md overflow-auto font-mono text-[11px] leading-relaxed" style={{ maxHeight: '320px' }}>
                            {lines.length === 0 && isNewFile && (
                                <div className="p-3 text-[#666]">（新文件内容）</div>
                            )}
                            {lines.map((line, i) => (
                                <div
                                    key={i}
                                    className={`px-3 py-0.5 border-l-2 ${
                                        line.type === 'add' ? 'bg-[#162b1f]/40 border-[#4cc38a] text-[#a8e6a0]' :
                                        line.type === 'del' ? 'bg-[#2b1a1a]/40 border-[#e06060] text-[#f0a0a0]' :
                                        'border-transparent text-[#888]'
                                    }`}
                                >
                                    <span className="select-none text-[#555] w-6 inline-block">{line.num}</span>
                                    {line.type === 'add' && <span className="text-[#4cc38a]">+ </span>}
                                    {line.type === 'del' && <span className="text-[#e06060]">- </span>}
                                    <span className="whitespace-pre">{line.text || ' '}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                    <DialogActions>
                        <Btn onClick={() => onClose(false)}>取消</Btn>
                        <Btn variant="primary" onClick={() => onClose(true)} autoFocus>应用</Btn>
                    </DialogActions>
                </div>
            </DialogOverlay>
        );
    }

    return null;
}
