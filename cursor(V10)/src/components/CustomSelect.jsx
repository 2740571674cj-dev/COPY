import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * CustomSelect - 自定义下拉选择器（替代原生 <select>）
 * 完全匹配暗色主题，弹出菜单可控样式
 *
 * @param {string}   value        当前选中值
 * @param {function} onChange     值变化回调
 * @param {Array}    options      [{value, label}]
 * @param {string}   placeholder  占位文字
 * @param {string}   className    附加 class
 */
export default function CustomSelect({ value, onChange, options = [], placeholder = '', className = '' }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
    }, [open]);

    const selected = options.find(o => o.value === value);

    return (
        <div ref={ref} className={`relative ${className}`}>
            <button
                type="button"
                onClick={() => setOpen(p => !p)}
                className="w-full flex items-center justify-between gap-1.5 bg-zinc-900/80 text-[11px] px-2.5 py-1.5 rounded-lg border border-zinc-800 outline-none hover:border-zinc-700 focus:border-zinc-600 transition-colors cursor-pointer text-left"
            >
                <span className={selected ? 'text-zinc-300 truncate' : 'text-zinc-600 truncate'}>
                    {selected ? selected.label : placeholder}
                </span>
                <ChevronDown size={12} className={`text-zinc-600 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
            </button>

            {open && (
                <div className="absolute z-50 top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded-lg border border-zinc-700/80 bg-[#18181b] shadow-xl shadow-black/40 py-0.5">
                    <button
                        type="button"
                        onClick={() => { onChange(''); setOpen(false); }}
                        className={`w-full text-left px-2.5 py-1.5 text-[11px] transition-colors hover:bg-zinc-800 ${!value ? 'text-zinc-400 bg-zinc-800/50' : 'text-zinc-600'}`}
                    >
                        {placeholder}
                    </button>
                    {options.map(o => (
                        <button
                            key={o.value}
                            type="button"
                            onClick={() => { onChange(o.value); setOpen(false); }}
                            className={`w-full text-left px-2.5 py-1.5 text-[11px] transition-colors hover:bg-zinc-700/60 truncate ${o.value === value ? 'text-blue-400 bg-zinc-800/60' : 'text-zinc-300'}`}
                        >
                            {o.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
