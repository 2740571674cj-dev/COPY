import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    ChevronDown, ChevronRight, Copy, Check, Pencil, Loader2,
    FileText, MessageSquare, Bug, ListTree, Infinity,
    Sparkles, Play, Terminal, X, CheckCircle2 as CheckCircleIcon,
    AlertTriangle, Info, AlertCircle, Lightbulb, Search, Target, Wrench, CheckCircle2, ArrowRight,
    CheckSquare, Square, Circle, StopCircle, Clock, Paperclip, Image as ImageIcon
} from 'lucide-react';
import { useDialog } from './DialogProvider';
import ToolCallCard from './ToolCallCard';
import TodoPanel, { StickyTodoTracker, PlanEvaluationCard } from './TodoPanel';
import WorkflowExecutionPanel from './WorkflowExecutionPanel';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import 'highlight.js/styles/github-dark.css'; // 暗色主题
import AnsiToHtml from 'ansi-to-html';

// 注册常用语言
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('java', java);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('css', css);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('sql', sql);

// ============================================================
// Agent 步骤解析 — 与 Cursor 一致：从回复中提取编辑步骤与命令步骤
// ============================================================

// 检查文本是否看起来像一个合理的文件路径
function looksLikeFilePath(text) {
    if (!text || typeof text !== 'string') return false;
    const t = text.trim();
    if (t.length === 0 || t.length > 260) return false;
    // 含中文字符 → 不是路径
    if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/.test(t)) return false;
    // 含 3 个以上空格分隔的单词 → 不是路径（路径偶尔有空格但不会是句子）
    if (t.split(/\s+/).length > 3) return false;
    // 有文件扩展名、或包含路径分隔符、或以 ./ ../ 开头 → 是路径
    if (/\.\w{1,10}$/.test(t)) return true;
    if (/[/\\]/.test(t)) return true;
    if (/^\.\.?\//.test(t)) return true;
    // 纯字母数字加下划线横线（如 "Makefile", "Dockerfile"）→ 视为路径
    if (/^[\w.-]+$/.test(t)) return true;
    return false;
}

// 流式步骤解析：支持部分完成的代码块（用于实时展示）
function parseAgentSteps(fullText, allowPartial = false) {
    if (!fullText || typeof fullText !== 'string') return { segments: [], hasSteps: false };
    const segments = [];

    // 匹配完整的代码块 ```lang path\ncode```
    const re = /```(\w*)\s*([^\n]*)\n([\s\S]*?)```/g;
    let lastEnd = 0;
    let match;
    const completedBlocks = [];

    while ((match = re.exec(fullText)) !== null) {
        const before = fullText.slice(lastEnd, match.index).trim();
        if (before) segments.push({ type: 'text', content: before });
        const lang = (match[1] || '').toLowerCase();
        const pathOrMeta = (match[2] || '').trim();
        const code = (match[3] || '').trimEnd();
        const isShell = /^(bash|sh|shell|zsh|powershell|cmd)$/.test(lang);
        if (isShell && !pathOrMeta) {
            segments.push({ type: 'command', code });
        } else if (pathOrMeta && looksLikeFilePath(pathOrMeta)) {
            segments.push({ type: 'edit', path: pathOrMeta, code, language: lang || 'text' });
        } else {
            segments.push({ type: 'text', content: '```' + (lang || '') + (pathOrMeta ? ' ' + pathOrMeta : '') + '\n' + code + '\n```' });
        }
        completedBlocks.push({ start: match.index, end: re.lastIndex });
        lastEnd = re.lastIndex;
    }

    // 如果允许部分解析，检查是否有未闭合的代码块
    if (allowPartial && lastEnd < fullText.length) {
        const remaining = fullText.slice(lastEnd);
        // 查找最后一个 ``` 开始标记
        const lastCodeBlockStart = remaining.lastIndexOf('```');
        if (lastCodeBlockStart >= 0) {
            const beforePartial = remaining.slice(0, lastCodeBlockStart).trim();
            if (beforePartial) segments.push({ type: 'text', content: beforePartial });

            const partialBlock = remaining.slice(lastCodeBlockStart + 3);
            const firstLineEnd = partialBlock.indexOf('\n');
            if (firstLineEnd >= 0) {
                const langLine = partialBlock.slice(0, firstLineEnd).trim();
                const langMatch = langLine.match(/^(\S+)\s*(.*)$/);
                const lang = langMatch ? langMatch[1].toLowerCase() : '';
                const pathOrMeta = langMatch && langMatch[2] ? langMatch[2].trim() : '';
                const code = partialBlock.slice(firstLineEnd + 1);

                const isShell = /^(bash|sh|shell|zsh|powershell|cmd)$/.test(lang);
                if (isShell && !pathOrMeta && code.trim()) {
                    segments.push({ type: 'command', code, partial: true });
                } else if (pathOrMeta && looksLikeFilePath(pathOrMeta) && code.trim()) {
                    segments.push({ type: 'edit', path: pathOrMeta, code, language: lang || 'text', partial: true });
                } else if (code.trim()) {
                    segments.push({ type: 'text', content: '```' + lang + '\n' + code });
                }
            } else {
                // 只有 ``` 标记，还没有内容
                segments.push({ type: 'text', content: remaining });
            }
        } else {
            const after = remaining.trim();
            if (after) segments.push({ type: 'text', content: after });
        }
    } else {
        const after = fullText.slice(lastEnd).trim();
        if (after) segments.push({ type: 'text', content: after });
    }

    // 后处理：从 text segments 中提取 todos 清单
    const finalSegments = [];
    for (const seg of segments) {
        if (seg.type === 'text') {
            const lines = seg.content.split('\n');
            let textBuf = [];
            let i = 0;
            while (i < lines.length) {
                if (lines[i].match(/^\s*[-*]\s*\[[ x]\]\s/i)) {
                    // 先 flush 之前的文本
                    if (textBuf.length > 0) {
                        finalSegments.push({ type: 'text', content: textBuf.join('\n') });
                        textBuf = [];
                    }
                    // 收集所有连续的 checkbox 行
                    const items = [];
                    while (i < lines.length && lines[i].match(/^\s*[-*]\s*\[[ x]\]\s/i)) {
                        const checked = /\[x\]/i.test(lines[i]);
                        const content = lines[i].replace(/^\s*[-*]\s*\[[ x]\]\s*/i, '');
                        items.push({ checked, content, index: items.length });
                        i++;
                    }
                    finalSegments.push({ type: 'todos', items });
                } else {
                    textBuf.push(lines[i]);
                    i++;
                }
            }
            if (textBuf.length > 0) {
                const remaining = textBuf.join('\n').trim();
                if (remaining) finalSegments.push({ type: 'text', content: remaining });
            }
        } else {
            finalSegments.push(seg);
        }
    }

    const hasSteps = finalSegments.some(s => s.type === 'edit' || s.type === 'command');
    return { segments: finalSegments, hasSteps };
}

// ANSI 转 HTML 转换器
const ansiConverter = new AnsiToHtml({
    fg: '#FFFFFF',
    bg: '#000000',
    newline: false,
    escapeXML: true,
    stream: false
});

// 简单 diff 行（与 DialogProvider 一致，支持语法高亮）
function diffLines(oldStr, newStr, language = 'text') {
    const oldLines = (oldStr || '').split('\n');
    const newLines = (newStr || '').split('\n');
    const result = [];
    const maxLen = Math.max(oldLines.length, newLines.length);

    // 如果语言不是 text，尝试高亮整段代码
    const shouldHighlight = language && language !== 'text' && hljs.getLanguage(language);

    for (let i = 0; i < maxLen; i++) {
        const o = oldLines[i];
        const n = newLines[i];
        let highlightedOld = o;
        let highlightedNew = n;

        // 语法高亮
        if (shouldHighlight) {
            if (o !== undefined) {
                try {
                    highlightedOld = hljs.highlight(o, { language }).value;
                } catch (e) {
                    highlightedOld = hljs.highlightAuto(o).value;
                }
            }
            if (n !== undefined) {
                try {
                    highlightedNew = hljs.highlight(n, { language }).value;
                } catch (e) {
                    highlightedNew = hljs.highlightAuto(n).value;
                }
            }
        } else {
            // 转义 HTML
            highlightedOld = o !== undefined ? o.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
            highlightedNew = n !== undefined ? n.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
        }

        if (o === undefined) {
            result.push({ type: 'add', num: i + 1, text: n, highlighted: highlightedNew });
        } else if (n === undefined) {
            result.push({ type: 'del', num: i + 1, text: o, highlighted: highlightedOld });
        } else if (o !== n) {
            result.push({ type: 'del', num: i + 1, text: o, highlighted: highlightedOld });
            result.push({ type: 'add', num: i + 1, text: n, highlighted: highlightedNew });
        } else {
            result.push({ type: 'ctx', num: i + 1, text: o, highlighted: highlightedOld });
        }
    }
    return result;
}

// ============================================================
// Mode Config
// ============================================================
const MODE_CONFIG = {
    chat: { label: 'Ask', color: '#4cc38a', bg: '#162b1f', border: '#1e3a29', icon: MessageSquare },
    debug: { label: 'Debug', color: '#e06060', bg: '#2b1a1a', border: '#3a1e1e', icon: Bug },
    plan: { label: 'Plan', color: '#d4a24c', bg: '#2b2318', border: '#3a2e1e', icon: ListTree },
    agent: { label: 'Agent', color: '#4ca0e0', bg: '#162030', border: '#1e2e45', icon: Infinity },
};

// Debug section icon/color mapping
const DEBUG_SECTION_STYLE = {
    '🔍 问题分析': { icon: Search, color: '#4ca0e0', bg: '#162030', border: '#1e2e45' },
    '🎯 根因定位': { icon: Target, color: '#e06060', bg: '#2b1a1a', border: '#3a1e1e' },
    '🛠️ 修复方案': { icon: Wrench, color: '#4cc38a', bg: '#162b1f', border: '#1e3a29' },
    '✅ 验证步骤': { icon: CheckCircle2, color: '#d4a24c', bg: '#2b2318', border: '#3a2e1e' },
};

// Agent section header mapping
const AGENT_SECTION_STYLE = {
    '需求分析': { cls: 'agent-section-header-analysis', emoji: '📝' },
    '执行思路': { cls: 'agent-section-header-plan', emoji: '🧠' },
    'To-dos': { cls: 'agent-section-header-todos', emoji: '📋' },
    '验收结果': { cls: 'agent-section-header-verify', emoji: '✅' },
    '风险与补充': { cls: 'agent-section-header-risk', emoji: '⚠️' },
    '最终结论': { cls: 'agent-section-header-conclusion', emoji: '💡' },
    '执行进度': { cls: 'agent-section-header-todos', emoji: '⏳' },
};

// ============================================================
// Markdown 渲染 — 增强版
// ============================================================
function renderMarkdown(text, options = {}) {
    if (!text) return null;

    // 清理常见乱码字符（BOM、零宽字符、替换字符等）
    text = text.replace(/[\ufeff\ufffe\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .replace(/\uFFFD/g, '');

    // 处理 <agent-error> 标签——渲染为高级暗色风格错误卡片
    const errorMatch = text.match(/^<agent-error>([\s\S]*?)<\/agent-error>$/);
    if (errorMatch) {
        const errorMsg = errorMatch[1].trim();
        return (
            <div style={{
                background: 'linear-gradient(135deg, rgba(239,68,68,0.08) 0%, rgba(30,30,30,0.95) 50%)',
                border: '1px solid rgba(239,68,68,0.2)',
                borderRadius: '10px',
                padding: '14px 16px',
                margin: '4px 0',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <div style={{
                        width: '22px', height: '22px', borderRadius: '6px',
                        background: 'rgba(239,68,68,0.15)', display: 'flex',
                        alignItems: 'center', justifyContent: 'center',
                    }}>
                        <AlertCircle size={13} style={{ color: '#f87171' }} />
                    </div>
                    <span style={{ fontSize: '12px', fontWeight: 500, color: '#f87171', letterSpacing: '0.3px' }}>
                        执行异常
                    </span>
                </div>
                <div style={{
                    fontSize: '11px', color: '#a1a1aa', lineHeight: '1.6',
                    padding: '8px 10px', borderRadius: '6px',
                    background: 'rgba(0,0,0,0.25)', fontFamily: 'ui-monospace, monospace',
                    wordBreak: 'break-word',
                }}>
                    {errorMsg}
                </div>
            </div>
        );
    }


    const lines = text.split('\n');
    const elements = [];
    let i = 0;
    let key = 0;
    const { enableCheckbox = false, enableApply = false, onCheckToggle, isDebugMode = false, isAgentMode = false, projectPath, onApply, showTerminalBlock = false } = options;

    while (i < lines.length) {
        const line = lines[i];

        // 代码块
        if (line.trimStart().startsWith('```')) {
            const rest = line.trimStart().slice(3).trim();
            const langMatch = rest.match(/^(\S+)/);
            const langRaw = langMatch ? langMatch[1] : '';
            const lang = langRaw.toLowerCase();
            const filePathFromBlock = langMatch && rest.length > langMatch[0].length ? rest.slice(langMatch[0].length).trim() : '';
            const codeLines = [];
            i++;
            while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
                codeLines.push(lines[i]);
                i++;
            }
            i++;
            const code = codeLines.join('\n');
            const isShellBlock = /^(bash|sh|shell|zsh|powershell|cmd)$/.test(lang);
            if (showTerminalBlock && isShellBlock && !filePathFromBlock) {
                elements.push(
                    <TerminalCard key={key++} code={code} projectPath={projectPath} />
                );
            } else {
                elements.push(
                    <CodeBlockCard
                        key={key++}
                        language={langRaw}
                        code={code}
                        filePath={filePathFromBlock}
                        showApply={enableApply && !!onApply}
                        onApply={onApply}
                    />
                );
            }
            continue;
        }

        // ── 表格预检：在空行跳过和水平线之前，先检测是否为表格起始 ──
        // 这解决了空行打断表格、水平线与分隔行冲突的问题
        const isTableLine = (l) => {
            if (!l || !l.trim()) return false;
            const t = l.trim();
            // 标准格式：以 | 开头
            if (/^\|/.test(t)) return true;
            // 宽松格式：至少有 2 个 | 且不是代码/逻辑运算符（排除 || && 等）
            const pipeCount = (t.match(/(?<!\|)\|(?!\|)/g) || []).length;
            return pipeCount >= 2;
        };
        const isSeparatorLine = (l) => {
            if (!l) return false;
            const t = l.trim();
            // 分隔行：由 |, -, :, 空格 组成，且至少有一个 --
            return /^[\s|:\-]+$/.test(t) && /--/.test(t) && t.includes('|');
        };
        if (isTableLine(line)) {
            const tableLines = [];
            const origI = i;
            // 收集所有连续的表格行（允许中间有空行，但不超过1行）
            while (i < lines.length) {
                const cur = lines[i];
                if (isTableLine(cur) || isSeparatorLine(cur)) {
                    tableLines.push(cur);
                    i++;
                } else if (cur.trim() === '' && i + 1 < lines.length && (isTableLine(lines[i + 1]) || isSeparatorLine(lines[i + 1]))) {
                    // 允许跳过表格行之间的单个空行
                    i++;
                } else {
                    break;
                }
            }
            if (tableLines.length >= 2) {
                const splitRow = (row) => {
                    // 去掉首尾 | 后按 | 分割，保留单元格内容
                    let r = row.trim();
                    if (r.startsWith('|')) r = r.slice(1);
                    if (r.endsWith('|')) r = r.slice(0, -1);
                    return r.split('|').map(c => c.trim());
                };
                const headers = splitRow(tableLines[0]);
                const colCount = headers.length;
                // 检测分隔行
                let dataStartIdx = 1;
                let aligns = null;
                if (tableLines.length > 1) {
                    const sepCells = splitRow(tableLines[1]);
                    const isSep = sepCells.every(c => /^[:\-\s]+$/.test(c) && c.replace(/[:\s]/g, '').length > 0);
                    if (isSep) {
                        aligns = sepCells.map(c => {
                            const t = c.trim();
                            if (t.startsWith(':') && t.endsWith(':')) return 'center';
                            if (t.endsWith(':')) return 'right';
                            return 'left';
                        });
                        dataStartIdx = 2;
                    }
                }
                const dataRows = tableLines.slice(dataStartIdx).map(r => {
                    const cells = splitRow(r);
                    while (cells.length < colCount) cells.push('');
                    return cells.slice(0, colCount);
                });
                if (headers.length > 0 && dataRows.length > 0) {
                    elements.push(<MarkdownTable key={key++} headers={headers} rows={dataRows} aligns={aligns} />);
                } else if (headers.length > 0) {
                    // 只有表头没有数据行 → 仍然渲染表格（空表体）
                    elements.push(<MarkdownTable key={key++} headers={headers} rows={[]} aligns={aligns} />);
                } else {
                    for (const tl of tableLines) {
                        elements.push(<p key={key++} className="ask-paragraph">{renderInline(tl)}</p>);
                    }
                }
                continue;
            }
            // 不足2行 → 回退，让后续逻辑处理
            i = origI;
        }

        if (line.trim() === '') { i++; continue; }

        // 水平线（排除表格分隔行模式：含 | 的不是水平线）
        if (line.trim().match(/^[-*_]{3,}$/) && !line.match(/^\s*[-*]\s/) && !line.includes('|')) {
            elements.push(<hr key={key++} className="ask-hr" />);
            i++; continue;
        }

        // 标题 (with debug section card detection)
        const hMatch = line.match(/^(#{1,4})\s(.+)/);
        if (hMatch) {
            const level = hMatch[1].length;
            const headingText = hMatch[2].trim();

            // Debug mode: Detect section headings and render as diagnostic cards
            if (isDebugMode && level === 2) {
                const sectionKey = Object.keys(DEBUG_SECTION_STYLE).find(k => {
                    const label = k.replace(/^[^\u4e00-\u9fff]+/, '').trim();
                    return headingText === k || headingText.includes(label) || k.includes(headingText.replace(/^[^\u4e00-\u9fff]+/, '').trim());
                });
                const sectionStyle = sectionKey ? DEBUG_SECTION_STYLE[sectionKey] : null;

                if (sectionStyle) {
                    // Collect all content until the next h2 heading
                    const sectionLines = [];
                    i++;
                    while (i < lines.length) {
                        const nextLine = lines[i];
                        if (nextLine.match(/^##\s/) && !nextLine.match(/^###/)) break;
                        sectionLines.push(nextLine);
                        i++;
                    }
                    const SectionIcon = sectionStyle.icon;
                    elements.push(
                        <div key={key++} className="ask-debug-section" style={{ borderColor: sectionStyle.border }}>
                            <div className="ask-debug-section-header" style={{ background: sectionStyle.bg }}>
                                <SectionIcon size={14} style={{ color: sectionStyle.color }} />
                                <span style={{ color: sectionStyle.color }}>{headingText}</span>
                            </div>
                            <div className="ask-debug-section-body">
                                {renderMarkdown(sectionLines.join('\n'), { ...options, isDebugMode: false })}
                            </div>
                        </div>
                    );
                    continue;
                }
            }

            // Agent mode: Detect section headings and render as agent section cards
            if (isAgentMode && level === 2) {
                const sectionKey = Object.keys(AGENT_SECTION_STYLE).find(k => headingText.includes(k));
                const sectionStyle = sectionKey ? AGENT_SECTION_STYLE[sectionKey] : null;

                if (sectionStyle) {
                    const sectionLines = [];
                    i++;
                    while (i < lines.length) {
                        const nextLine = lines[i];
                        if (nextLine.match(/^##\s/) && !nextLine.match(/^###/)) break;
                        sectionLines.push(nextLine);
                        i++;
                    }
                    elements.push(
                        <div key={key++} className={`ask-agent-section ${sectionStyle.cls}`}>
                            <div className="ask-agent-section-header">
                                <span className="ask-agent-section-title">{headingText.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f]+\s*/u, '')}</span>
                            </div>
                            <div className="ask-agent-section-body">
                                {renderMarkdown(sectionLines.join('\n'), { ...options, isAgentMode: false })}
                            </div>
                        </div>
                    );
                    continue;
                }
            }

            elements.push(
                <div key={key++} className={`ask-heading ask-heading-${level}`}>
                    {renderInline(hMatch[2])}
                </div>
            );
            i++;
            continue;
        }

        // Blockquote / callout (> [!NOTE], > [!WARNING], > text)
        if (line.match(/^\s*>/)) {
            const blockLines = [];
            while (i < lines.length && lines[i].match(/^\s*>/)) {
                blockLines.push(lines[i].replace(/^\s*>\s?/, ''));
                i++;
            }
            const fullBlock = blockLines.join('\n');
            // Check for GitHub-style callout: [!NOTE], [!WARNING], [!TIP], [!IMPORTANT], [!CAUTION]
            const calloutMatch = fullBlock.match(/^\[!(NOTE|WARNING|TIP|IMPORTANT|CAUTION)\]\s*/i);
            if (calloutMatch) {
                const type = calloutMatch[1].toUpperCase();
                const content = fullBlock.slice(calloutMatch[0].length);
                elements.push(
                    <CalloutBlock key={key++} type={type} content={content} options={options} />
                );
            } else {
                elements.push(
                    <div key={key++} className="ask-blockquote">
                        {renderMarkdown(fullBlock, options)}
                    </div>
                );
            }
            continue;
        }

        // Checkbox 列表 (Plan & Debug verification mode) — supports nesting
        if (enableCheckbox && line.match(/^\s*[-*]\s*\[[ x]\]\s/i)) {
            const items = [];
            while (i < lines.length && lines[i].match(/^\s*[-*]\s*\[[ x]\]\s/i)) {
                const indent = lines[i].match(/^(\s*)/)[1].length;
                const checked = /\[x\]/i.test(lines[i]);
                const content = lines[i].replace(/^\s*[-*]\s*\[[ x]\]\s*/i, '');
                items.push({ checked, content, indent, index: items.length });
                i++;
            }
            const minIndent = Math.min(...items.map(it => it.indent));
            elements.push(
                <div key={key++} className="ask-checklist">
                    {items.map((it) => {
                        const isSubTask = it.indent > minIndent;
                        return (
                            <div
                                key={it.index}
                                className={`ask-checklist-item ${it.checked ? 'ask-checklist-checked' : ''} ${isSubTask ? 'ask-checklist-sub' : ''}`}
                                onClick={() => onCheckToggle?.(it.index)}
                                role="button"
                                tabIndex={0}
                            >
                                <div className={`ask-checkbox ${it.checked ? 'ask-checkbox-checked' : ''}`}>
                                    {it.checked && <Check size={10} />}
                                </div>
                                <span className="ask-checklist-text">{renderInline(it.content)}</span>
                            </div>
                        );
                    })}
                </div>
            );
            continue;
        }

        // 无序列表
        if (line.match(/^\s*[-*]\s/) && !line.match(/^\s*[-*]\s*\[[ x]\]/i)) {
            const items = [];
            while (i < lines.length && lines[i].match(/^\s*[-*]\s/) && !lines[i].match(/^\s*[-*]\s*\[[ x]\]/i)) {
                items.push(lines[i].replace(/^\s*[-*]\s/, ''));
                i++;
            }
            elements.push(<ul key={key++} className="ask-list">{items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ul>);
            continue;
        }

        // 有序列表
        if (line.match(/^\s*\d+\.\s/)) {
            const items = [];
            while (i < lines.length && lines[i].match(/^\s*\d+\.\s/)) {
                items.push(lines[i].replace(/^\s*\d+\.\s/, ''));
                i++;
            }
            elements.push(<ol key={key++} className="ask-list ask-list-ordered">{items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ol>);
            continue;
        }

        // 段落
        elements.push(<p key={key++} className="ask-paragraph">{renderInline(line)}</p>);
        i++;
    }
    return elements;
}

// ============================================================
// MarkdownTable — 暗色主题表格卡片
// ============================================================
function MarkdownTable({ headers, rows, aligns }) {
    return (
        <div className="ask-table-wrapper">
            <table className="ask-table">
                <thead>
                    <tr>
                        {headers.map((h, i) => (
                            <th key={i} style={aligns?.[i] ? { textAlign: aligns[i] } : undefined}>{renderInline(h)}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, ri) => (
                        <tr key={ri}>
                            {row.map((cell, ci) => (
                                <td key={ci} style={aligns?.[ci] ? { textAlign: aligns[ci] } : undefined}>{renderInline(cell)}</td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

// ============================================================
// CalloutBlock — GitHub-style callout (NOTE, WARNING, TIP etc.)
// ============================================================
function CalloutBlock({ type, content, options }) {
    const config = {
        NOTE: { icon: Info, color: '#4ca0e0', bg: '#162030', border: '#1e3a55', label: '备注' },
        WARNING: { icon: AlertTriangle, color: '#e0a030', bg: '#2b2818', border: '#3a3220', label: '警告' },
        TIP: { icon: Lightbulb, color: '#4cc38a', bg: '#162b1f', border: '#1e3a29', label: '提示' },
        IMPORTANT: { icon: AlertCircle, color: '#a78bfa', bg: '#1e1a2b', border: '#2a2545', label: '重要' },
        CAUTION: { icon: AlertTriangle, color: '#e06060', bg: '#2b1a1a', border: '#3a1e1e', label: '注意' },
    };
    const c = config[type] || config.NOTE;
    const Icon = c.icon;

    return (
        <div className="ask-callout" style={{ borderLeftColor: c.color, background: c.bg }}>
            <div className="ask-callout-header">
                <Icon size={13} style={{ color: c.color }} />
                <span className="ask-callout-label" style={{ color: c.color }}>{c.label}</span>
            </div>
            <div className="ask-callout-content">
                {renderMarkdown(content, options)}
            </div>
        </div>
    );
}

function renderInline(text) {
    if (!text) return null;
    const parts = [];
    let key = 0;
    // Match: **bold**, `inline code`, [link](url), *italic*, ~~strikethrough~~
    const regex = /(\*\*(.+?)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))|(\*([^*]+)\*)|(~~(.+?)~~)/g;
    let lastIdx = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIdx) parts.push(<span key={key++}>{text.slice(lastIdx, match.index)}</span>);
        if (match[1]) parts.push(<strong key={key++} className="ask-bold">{match[2]}</strong>);
        else if (match[3]) parts.push(<code key={key++} className="ask-inline-code">{match[4]}</code>);
        else if (match[5]) parts.push(<span key={key++} className="ask-link">{match[6]}</span>);
        else if (match[8]) parts.push(<em key={key++} className="ask-italic">{match[9]}</em>);
        else if (match[10]) parts.push(<del key={key++} className="ask-strikethrough">{match[11]}</del>);
        lastIdx = match.index + match[0].length;
    }
    if (lastIdx < text.length) parts.push(<span key={key++}>{text.slice(lastIdx)}</span>);
    return parts.length > 0 ? parts : text;
}

// ============================================================
// CodeBlockCard — Cursor 风格代码块（支持 Apply 写入）
// ============================================================
function CodeBlockCard({ language, code, filePath, showApply, onApply }) {
    const [copied, setCopied] = useState(false);
    const [applying, setApplying] = useState(false);

    const handleCopy = () => {
        navigator.clipboard?.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    const handleApply = () => {
        if (!onApply || !filePath) return;
        setApplying(true);
        Promise.resolve(onApply(filePath, code)).finally(() => setApplying(false));
    };

    return (
        <div className="ask-code-block">
            <div className="ask-code-header">
                <div className="ask-code-header-left">
                    {filePath && (
                        <span className="ask-code-filepath">{filePath}</span>
                    )}
                    <span className="ask-code-lang">{language || 'code'}</span>
                </div>
                <div className="ask-code-actions">
                    {showApply && (
                        <button
                            className="ask-code-apply-btn"
                            title="Apply"
                            onClick={handleApply}
                            disabled={applying}
                        >
                            {applying ? <Loader2 size={9} className="animate-spin" /> : <Play size={9} />}
                            <span>{applying ? '应用中...' : 'Apply'}</span>
                        </button>
                    )}
                    <button className="ask-copy-btn" onClick={handleCopy} title="Copy">
                        {copied ? <Check size={10} /> : <Copy size={10} />}
                    </button>
                </div>
            </div>
            <pre className="ask-code-content"><code>{code}</code></pre>
        </div>
    );
}

// ============================================================
// TerminalCard — Agent 模式终端命令块（复制 + 打开终端）
// ============================================================
function TerminalCard({ code, projectPath }) {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        navigator.clipboard?.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    const handleOpenTerminal = () => {
        if (window.electronAPI?.openTerminal && projectPath) {
            window.electronAPI.openTerminal(projectPath);
        }
    };

    return (
        <div className="ask-terminal-block">
            <div className="ask-terminal-header">
                <Terminal size={12} className="ask-terminal-icon" />
                <span className="ask-terminal-title">终端命令</span>
                <div className="ask-terminal-actions">
                    <button className="ask-terminal-run-btn" onClick={handleOpenTerminal} title="在终端中打开项目目录" disabled={!projectPath}>
                        <Play size={9} />
                        <span>打开终端</span>
                    </button>
                    <button className="ask-copy-btn" onClick={handleCopy} title="Copy">
                        {copied ? <Check size={10} /> : <Copy size={10} />}
                    </button>
                </div>
            </div>
            <pre className="ask-terminal-content"><code>{code}</code></pre>
        </div>
    );
}

// ============================================================
// AgentEditStepCard — Cursor 风格：内联 diff + Accept/Reject（支持外部状态控制）
// ============================================================
function AgentEditStepCard({
    path, code, language, projectPath, onApplied, resolveFullPath,
    stepIndex, totalSteps, // 步骤编号
    status: externalStatus, onStatusChange, // 外部状态控制（用于批量操作）
    collapsed: externalCollapsed, onCollapsedChange, // 折叠状态
    onRetry, // 重试回调
    autoExecute // Auto 自动执行
}) {
    const dialog = useDialog();
    const [oldContent, setOldContent] = useState(null);
    const [loading, setLoading] = useState(true);
    const [status, setStatus] = useState(externalStatus || 'pending'); // pending | applied | rejected | failed
    const [applying, setApplying] = useState(false);
    const [collapsed, setCollapsed] = useState(externalCollapsed ?? false);
    const [error, setError] = useState(null);
    const [executionTime, setExecutionTime] = useState(null); // 执行时间（毫秒）
    const cardRef = useRef(null);

    // 同步外部状态
    useEffect(() => {
        if (externalStatus !== undefined) setStatus(externalStatus);
    }, [externalStatus]);

    useEffect(() => {
        if (externalCollapsed !== undefined) setCollapsed(externalCollapsed);
    }, [externalCollapsed]);

    useEffect(() => {
        let cancelled = false;
        const fullPath = resolveFullPath(projectPath, path);
        if (!fullPath) {
            setOldContent('');
            setLoading(false);
            return;
        }
        window.electronAPI?.readFileContent?.(fullPath)
            .then((raw) => {
                if (cancelled) return;
                if (raw && !raw.startsWith('// 无法读取') && !raw.startsWith('// [文件过大')) setOldContent(raw);
                else setOldContent('');
            })
            .catch(() => { if (!cancelled) setOldContent(''); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [projectPath, path, resolveFullPath]);

    const handleAccept = useCallback(async () => {
        const fullPath = resolveFullPath(projectPath, path);
        if (!fullPath) {
            setError('路径无效或安全检查失败');
            setStatus('failed');
            onStatusChange?.('failed');
            return;
        }

        // 文件变更检测：应用前检查文件是否被外部修改
        try {
            const currentContent = await window.electronAPI?.readFileContent?.(fullPath);
            if (currentContent && currentContent !== oldContent && oldContent !== null && oldContent !== '') {
                // Auto=ON 时跳过确认；Auto=OFF 时用 dialog 确认
                if (!autoExecute) {
                    const confirmed = await dialog.confirm(`文件 ${path} 已被外部修改。是否覆盖？`);
                    if (!confirmed) return;
                }
            }
        } catch (e) {
            // 忽略读取错误（可能是新文件）
        }

        // 再次验证路径安全性（双重检查）
        const validation = validatePathSafety(projectPath, fullPath);
        if (!validation.safe) {
            setError(validation.error || '路径安全检查失败');
            setStatus('failed');
            onStatusChange?.('failed');
            return;
        }
        setApplying(true);
        setError(null);
        const startTime = Date.now();
        try {
            const result = await window.electronAPI?.writeFile?.(fullPath, code);
            const elapsed = Date.now() - startTime;
            setExecutionTime(elapsed);
            if (result?.success) {
                // ===== Readback 验证 =====
                try {
                    const readback = await window.electronAPI?.readFileContent?.(fullPath);
                    if (readback != null && readback !== code) {
                        setError('写入验证失败：文件内容与预期不一致（readback mismatch）');
                        setStatus('failed');
                        onStatusChange?.('failed');
                        return;
                    }
                } catch (_rb) { /* readback 失败不阻塞，但记录 */ }
                // ===== Readback 通过 =====
                setStatus('applied');
                onStatusChange?.('applied');
                onApplied?.(fullPath);
                setCollapsed(true);
                onCollapsedChange?.(true);
                setOldContent(code);
            } else {
                setError(result?.error || '写入失败');
                setStatus('failed');
                onStatusChange?.('failed');
            }
        } catch (e) {
            setError(e?.message || '写入失败');
            setStatus('failed');
            onStatusChange?.('failed');
        } finally {
            setApplying(false);
        }
    }, [projectPath, path, code, oldContent, resolveFullPath, onStatusChange, onApplied]);

    const handleReject = useCallback(() => {
        setStatus('rejected');
        onStatusChange?.('rejected');
    }, [onStatusChange]);

    const handleRetry = () => {
        setError(null);
        setStatus('pending');
        onStatusChange?.('pending');
        onRetry?.();
        handleAccept();
    };

    const handleToggleCollapse = () => {
        const newCollapsed = !collapsed;
        setCollapsed(newCollapsed);
        onCollapsedChange?.(newCollapsed);
    };

    const handleCardKeyDown = useCallback((e) => {
        if (status !== 'pending') return;
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            if (!applying) handleAccept();
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            handleReject();
        }
    }, [status, applying, handleAccept, handleReject]);

    if (status === 'rejected') return null;
    const lines = loading ? [] : diffLines(oldContent ?? '', code, language);
    const isNewFile = !loading && (oldContent == null || oldContent === '');

    const statusLabels = {
        pending: isNewFile ? '新建文件' : '编辑文件',
        applied: '已应用',
        failed: '应用失败',
        rejected: '已拒绝'
    };

    const statusIcons = {
        pending: FileText,
        applied: CheckCircleIcon,
        failed: AlertTriangle,
        rejected: X
    };

    const StatusIcon = statusIcons[status] || FileText;
    const showActions = status === 'pending' || status === 'failed';

    return (
        <div
            ref={cardRef}
            className={`agent-step-card agent-step-edit ${status === 'applied' ? 'agent-step-applied' : ''} ${status === 'failed' ? 'agent-step-failed' : ''}`}
            tabIndex={status === 'pending' ? 0 : -1}
            title={status === 'pending' ? 'Ctrl+Enter: 应用 | Esc: 拒绝' : ''}
            onKeyDown={handleCardKeyDown}
        >
            <div className="agent-step-header" onClick={status === 'applied' ? handleToggleCollapse : undefined} style={{ cursor: status === 'applied' ? 'pointer' : 'default' }}>
                <div className="agent-step-header-left">
                    {stepIndex !== undefined && totalSteps !== undefined && (
                        <span className="agent-step-number">步骤 {stepIndex + 1}/{totalSteps}</span>
                    )}
                    <StatusIcon size={13} className={`agent-step-icon ${status === 'applied' ? 'agent-step-icon-applied' : status === 'failed' ? 'agent-step-icon-failed' : ''}`} />
                    <span className="agent-step-title">{statusLabels[status]}</span>
                    <span className="agent-step-path" title={path}>{path}</span>
                    {executionTime !== null && status === 'applied' && (
                        <span className="agent-step-time" title="执行时间">
                            {executionTime < 1000 ? `${executionTime}ms` : `${(executionTime / 1000).toFixed(1)}s`}
                        </span>
                    )}
                </div>
                {showActions && (
                    <div className="agent-step-actions">
                        {status === 'failed' && onRetry && (
                            <button type="button" className="agent-step-btn agent-step-retry" onClick={handleRetry} title="重试">
                                <Loader2 size={12} />
                                <span>重试</span>
                            </button>
                        )}
                        {status === 'pending' && (
                            <>
                                <button type="button" className="agent-step-btn agent-step-copy" onClick={() => {
                                    navigator.clipboard?.writeText(code);
                                }} title="复制代码">
                                    <Copy size={12} />
                                </button>
                                <button type="button" className="agent-step-btn agent-step-reject" onClick={handleReject} title="拒绝 (Esc)">
                                    <X size={12} />
                                    <span>拒绝</span>
                                </button>
                                <button type="button" className="agent-step-btn agent-step-accept" onClick={handleAccept} disabled={applying} title="应用 (Ctrl+Enter)">
                                    {applying ? <Loader2 size={12} className="animate-spin" /> : <CheckCircleIcon size={12} />}
                                    <span>{applying ? '应用中...' : '应用'}</span>
                                </button>
                            </>
                        )}
                    </div>
                )}
                {status === 'applied' && (
                    <div className="agent-step-actions">
                        <button type="button" className="agent-step-btn agent-step-copy" onClick={() => {
                            navigator.clipboard?.writeText(code);
                        }} title="复制代码">
                            <Copy size={12} />
                        </button>
                    </div>
                )}
                {status === 'applied' && (
                    <button type="button" className="agent-step-collapse-btn" onClick={handleToggleCollapse} title={collapsed ? '展开' : '折叠'}>
                        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    </button>
                )}
            </div>
            {error && (
                <div className="agent-step-error">
                    <AlertCircle size={12} style={{ color: '#f87171', flexShrink: 0 }} />
                    <span>{error}</span>
                </div>
            )}
            {!collapsed && (
                <>
                    {loading ? (
                        <div className="agent-step-body agent-step-loading"><Loader2 size={16} className="animate-spin" /> 加载中...</div>
                    ) : (
                        <div className="agent-step-body agent-step-diff">
                            {lines.map((line, i) => (
                                <div
                                    key={i}
                                    className={`agent-diff-line agent-diff-${line.type}`}
                                >
                                    <span className="agent-diff-num">{line.num}</span>
                                    {line.type === 'add' && <span className="agent-diff-prefix">+</span>}
                                    {line.type === 'del' && <span className="agent-diff-prefix">-</span>}
                                    <span
                                        className="agent-diff-text"
                                        dangerouslySetInnerHTML={{ __html: line.highlighted || (line.text || ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }}
                                    />
                                </div>
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

// ============================================================
// AgentTodosCard — Cursor 风格：折叠 To-dos 清单卡片
// ============================================================
function AgentTodosCard({ items }) {
    const [collapsed, setCollapsed] = useState(false);
    const total = items.length;
    const doneCount = items.filter(it => it.checked).length;
    const allDone = doneCount === total;

    return (
        <div className="agent-todos-card">
            <div
                className="agent-todos-header"
                onClick={() => setCollapsed(!collapsed)}
            >
                <span className="agent-todos-chevron">
                    {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </span>
                <span className="agent-todos-title">To-dos</span>
                <span className="agent-todos-count">{total}</span>
                {allDone && <span className="agent-todos-done-badge">✓</span>}
            </div>
            {!collapsed && (
                <div className="agent-todos-list">
                    {items.map((it, i) => (
                        <div
                            key={i}
                            className={`agent-todos-item ${it.checked ? 'agent-todos-item-done' : ''}`}
                        >
                            <span className="agent-todos-check">
                                {it.checked ? (
                                    <CheckCircle2 size={14} className="agent-todos-icon-done" />
                                ) : (
                                    <Circle size={14} className="agent-todos-icon-pending" />
                                )}
                            </span>
                            <span className={`agent-todos-text ${it.checked ? 'agent-todos-text-done' : ''}`}>
                                {it.content}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ============================================================
// AgentTerminalStepCard — Cursor 风格：执行命令 + 内联输出（支持外部状态控制）
// ============================================================
function AgentTerminalStepCard({
    code, projectPath,
    stepIndex, totalSteps, // 步骤编号
    status: externalStatus, onStatusChange, // 外部状态控制
    collapsed: externalCollapsed, onCollapsedChange, // 折叠状态
    onCancel // 取消回调
}) {
    const [output, setOutput] = useState(null);
    const [running, setRunning] = useState(false);
    const [status, setStatus] = useState(externalStatus || 'pending'); // pending | running | completed | failed
    const [collapsed, setCollapsed] = useState(externalCollapsed ?? false);
    const [error, setError] = useState(null);
    const cancelRef = useRef(null);

    useEffect(() => {
        if (externalStatus !== undefined) setStatus(externalStatus);
    }, [externalStatus]);

    useEffect(() => {
        if (externalCollapsed !== undefined) setCollapsed(externalCollapsed);
    }, [externalCollapsed]);

    const handleRun = async () => {
        if (!projectPath || !code.trim()) {
            setError('项目路径或命令无效');
            setStatus('failed');
            onStatusChange?.('failed');
            return;
        }

        // 命令注入防护 + 高危拦截
        const sanitized = sanitizeCommand(code);
        if (!sanitized.safe) {
            const isBlocked = sanitized.blocked === true;
            setError((sanitized.error || '命令安全检查失败') + (sanitized.suggestion ? `\n💡 建议：${sanitized.suggestion}` : ''));
            setStatus(isBlocked ? 'blocked' : 'failed');
            onStatusChange?.(isBlocked ? 'blocked' : 'failed');
            return;
        }

        setRunning(true);
        setOutput(null);
        setError(null);
        setStatus('running');
        onStatusChange?.('running');
        try {
            const result = await window.electronAPI?.agentRunCommand?.({ projectPath, command: sanitized.command });
            setOutput({
                stdout: result?.stdout ?? '',
                stderr: result?.stderr ?? '',
                success: result?.success,
                code: result?.code,
            });
            if (result?.success) {
                setStatus('completed');
                onStatusChange?.('completed');
            } else {
                setError(result?.stderr || result?.error || '执行失败');
                setStatus('failed');
                onStatusChange?.('failed');
            }
        } catch (e) {
            setError(e?.message || '执行失败');
            setStatus('failed');
            onStatusChange?.('failed');
            setOutput({ stdout: '', stderr: e?.message || '执行失败', success: false });
        } finally {
            setRunning(false);
            if (status !== 'failed') setStatus('completed');
        }
    };

    const handleCancel = () => {
        if (cancelRef.current) {
            window.electronAPI?.agentCancelCommand?.({ requestId: cancelRef.current });
        }
        setRunning(false);
        setStatus('failed');
        onStatusChange?.('failed');
        setError('已取消');
        onCancel?.();
    };

    const handleRetry = () => {
        setError(null);
        setStatus('pending');
        onStatusChange?.('pending');
        handleRun();
    };

    const handleToggleCollapse = () => {
        const newCollapsed = !collapsed;
        setCollapsed(newCollapsed);
        onCollapsedChange?.(newCollapsed);
    };

    const showActions = status === 'pending' || status === 'failed' || status === 'blocked';
    const isCompleted = status === 'completed';
    const isBlocked = status === 'blocked';

    return (
        <div className={`agent-step-card agent-step-terminal ${isCompleted ? 'agent-step-completed' : ''} ${status === 'failed' ? 'agent-step-failed' : ''} ${isBlocked ? 'agent-step-blocked' : ''}`}>
            <div className="agent-step-header" onClick={isCompleted ? handleToggleCollapse : undefined} style={{ cursor: isCompleted ? 'pointer' : 'default' }}>
                <div className="agent-step-header-left">
                    {stepIndex !== undefined && totalSteps !== undefined && (
                        <span className="agent-step-number">步骤 {stepIndex + 1}/{totalSteps}</span>
                    )}
                    {isBlocked
                        ? <AlertTriangle size={13} className="agent-step-icon" style={{ color: '#e8a838' }} />
                        : <Terminal size={13} className={`agent-step-icon agent-step-icon-terminal ${isCompleted ? 'agent-step-icon-completed' : ''}`} />
                    }
                    <span className="agent-step-title">
                        {isBlocked ? '⚠ 高危命令已拦截' : status === 'running' ? '执行中...' : status === 'completed' ? '执行完成' : status === 'failed' ? '执行失败' : '终端命令'}
                    </span>
                </div>
                {showActions && (
                    <div className="agent-step-actions">
                        {status === 'failed' && (
                            <button type="button" className="agent-step-btn agent-step-retry" onClick={handleRetry} title="重试">
                                <Loader2 size={12} />
                                <span>重试</span>
                            </button>
                        )}
                        {status === 'pending' && (
                            <>
                                <button type="button" className="agent-step-btn agent-step-copy" onClick={() => {
                                    navigator.clipboard?.writeText(code);
                                }} title="复制命令">
                                    <Copy size={12} />
                                </button>
                                <button
                                    type="button"
                                    className="agent-step-btn agent-step-run"
                                    onClick={handleRun}
                                    disabled={running || !projectPath}
                                    title="运行"
                                >
                                    <Play size={12} />
                                    <span>运行</span>
                                </button>
                            </>
                        )}
                    </div>
                )}
                {isCompleted && (
                    <div className="agent-step-actions">
                        <button type="button" className="agent-step-btn agent-step-copy" onClick={() => {
                            navigator.clipboard?.writeText(code);
                        }} title="复制命令">
                            <Copy size={12} />
                        </button>
                    </div>
                )}
                {status === 'running' && (
                    <div className="agent-step-actions">
                        <button type="button" className="agent-step-btn agent-step-cancel" onClick={handleCancel} title="取消">
                            <X size={12} />
                            <span>取消</span>
                        </button>
                    </div>
                )}
                {isCompleted && (
                    <button type="button" className="agent-step-collapse-btn" onClick={handleToggleCollapse} title={collapsed ? '展开' : '折叠'}>
                        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    </button>
                )}
            </div>
            {error && (
                <div className="agent-step-error">
                    <AlertCircle size={12} style={{ color: '#f87171', flexShrink: 0 }} />
                    <span>{error}</span>
                </div>
            )}
            {!collapsed && (
                <>
                    <pre className="agent-step-command"><code>{code}</code></pre>
                    {output && (
                        <div className={`agent-step-output ${output.success ? '' : 'agent-step-output-error'}`}>
                            {output.stdout && (
                                <pre
                                    className="agent-step-stdout"
                                    dangerouslySetInnerHTML={{ __html: ansiConverter.toHtml(output.stdout) }}
                                />
                            )}
                            {output.stderr && (
                                <pre
                                    className="agent-step-stderr"
                                    dangerouslySetInnerHTML={{ __html: ansiConverter.toHtml(output.stderr) }}
                                />
                            )}
                            {output.code !== undefined && output.code !== 0 && (
                                <div className="agent-step-exit">退出码: {output.code}</div>
                            )}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

// ============================================================
// ThoughtPanel — Cursor 风格 Thinking/Thought 面板
// 正在思考时: "Thinking..." (带旋转图标)
// 思考完成后: "Thought for Xs" (带完成图标)
// ============================================================
function ThoughtPanel({ thoughtText, durationMs, isGenerating, generatingStartTime }) {
    const [manualToggle, setManualToggle] = useState(null);
    const [liveSeconds, setLiveSeconds] = useState(0);
    const prevGenerating = useRef(isGenerating);

    useEffect(() => {
        if (!isGenerating || !generatingStartTime) return;
        const interval = setInterval(() => {
            setLiveSeconds(Math.floor((Date.now() - generatingStartTime) / 1000));
        }, 200);
        return () => clearInterval(interval);
    }, [isGenerating, generatingStartTime]);

    useEffect(() => {
        if (prevGenerating.current && !isGenerating) {
            setManualToggle(false);
        }
        if (!prevGenerating.current && isGenerating) {
            setManualToggle(true);
        }
        prevGenerating.current = isGenerating;
    }, [isGenerating]);

    const secs = isGenerating ? liveSeconds : (durationMs != null ? Math.round(durationMs / 1000) : 0);
    const hasContent = thoughtText && thoughtText.trim().length > 0;
    const expanded = manualToggle !== null ? manualToggle : isGenerating;

    const formatTime = (s) => {
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        const rem = s % 60;
        return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
    };

    const label = isGenerating
        ? `Thinking${liveSeconds > 0 ? ` ${formatTime(liveSeconds)}` : ''}...`
        : `Thought${secs > 0 ? ` for ${formatTime(secs)}` : ''}`;

    return (
        <div className={`ask-thought-panel ${isGenerating ? 'ask-thought-panel--active' : ''}`}>
            <button
                className="ask-thought-header"
                onClick={() => {
                    if (hasContent) setManualToggle(prev => prev === null ? !isGenerating : !prev);
                }}
            >
                <div className="ask-thought-header-left">
                    {isGenerating
                        ? <Loader2 size={13} className="animate-spin" style={{ color: '#a78bfa' }} />
                        : <Sparkles size={13} style={{ color: '#a78bfa' }} />}
                    <span className="ask-thought-title">{label}</span>
                </div>
                {hasContent && (expanded
                    ? <ChevronDown size={12} className="ask-thought-chevron" />
                    : <ChevronRight size={12} className="ask-thought-chevron" />)}
            </button>
            {expanded && hasContent && (
                <div className="ask-thought-body">
                    <div className="ask-thought-content">
                        {renderMarkdown(thoughtText)}
                        {isGenerating && <span className="streaming-cursor streaming-cursor--thought" />}
                    </div>
                </div>
            )}
        </div>
    );
}

// ============================================================
// CitationPills — Cursor 风格文件引用药丸
// ============================================================
function CitationPills({ citations }) {
    if (!citations || citations.length === 0) return null;
    return (
        <div className="ask-citation-pills">
            {citations.map((c, i) => (
                <div key={i} className="ask-citation-pill" title={c.path || c.relativePath}>
                    <FileText size={10} className="ask-citation-pill-icon" />
                    <span className="ask-citation-pill-name">
                        {c.relativePath || c.file}
                    </span>
                    {c.line && <span className="ask-citation-pill-line">:{c.line}</span>}
                </div>
            ))}
        </div>
    );
}

// ============================================================
// UserMessageCard — Cursor 风格用户消息
// ============================================================
function UserMessageCard({ text, attachments, references, onEdit }) {
    return (
        <div className="ask-user-card">
            <div className="ask-user-card-content">
                <p className="ask-user-text">{text}</p>
                {attachments && attachments.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {attachments.map((att, i) => (
                            <div key={att.id || i} className="flex items-center gap-1 bg-[#1e1e1e] border border-[#333] rounded px-1.5 py-0.5 max-w-[180px]">
                                {att.preview ? (
                                    <img src={att.preview} alt="" className="w-[20px] h-[20px] rounded object-cover flex-shrink-0" />
                                ) : att.type?.startsWith('image/') ? (
                                    <ImageIcon size={11} className="text-[#777] flex-shrink-0" />
                                ) : (
                                    <Paperclip size={10} className="text-[#777] flex-shrink-0" />
                                )}
                                <span className="text-[9px] text-[#888] truncate">{att.name}</span>
                                {att.size && (
                                    <span className="text-[8px] text-[#555] flex-shrink-0">
                                        {att.size < 1024 ? `${att.size}B` : att.size < 1048576 ? `${(att.size / 1024).toFixed(0)}KB` : `${(att.size / 1048576).toFixed(1)}MB`}
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                )}
                {references && references.length > 0 && (
                    <div className="ask-citation-pills mt-1.5">
                        {references.map((ref, i) => (
                            <div
                                key={`${ref.label || ref.relativePath || ref.type}_${i}`}
                                className="ask-citation-pill"
                                style={ref.status === 'unresolved' ? { borderColor: '#5b2d2d', color: '#e28e8e' } : undefined}
                                title={ref.relativePath || ref.label || ref.reason || ref.type}
                            >
                                {ref.type === 'folder' ? (
                                    <ListTree size={10} className="ask-citation-pill-icon" />
                                ) : ref.type === 'codebase' ? (
                                    <Search size={10} className="ask-citation-pill-icon" />
                                ) : (
                                    <FileText size={10} className="ask-citation-pill-icon" />
                                )}
                                <span className="ask-citation-pill-name">{ref.relativePath || ref.label || ref.type}</span>
                                {ref.status === 'unresolved' && <span className="ask-citation-pill-line">!</span>}
                            </div>
                        ))}
                    </div>
                )}
            </div>
            <div className="ask-user-card-actions">
                <button className="ask-action-btn" title="编辑" onClick={() => onEdit?.(text)}><Pencil size={11} /></button>
            </div>
        </div>
    );
}

// ============================================================
// PlanActions — Plan 模式底部操作栏
// ============================================================
function PlanActions({ onStartImplementation }) {
    return (
        <div className="ask-plan-actions">
            <button className="ask-plan-implement-btn" onClick={onStartImplementation}>
                <ArrowRight size={13} />
                <span>开始实施</span>
            </button>
        </div>
    );
}

// ============================================================
// AiAnswerBlock — AI 回答正文 + 流式光标（Agent 模式为步骤卡片优先）
// ============================================================
function AiAnswerBlock({ text, streaming, mode, onCheckToggle, projectPath, onApply, resolveFullPath, onStepApplied, autoExecute }) {
    if (!text && !streaming) return null;
    const enableCheckbox = mode === 'plan' || mode === 'debug' || mode === 'agent';
    const isDebugMode = mode === 'debug';

    // Agent 模式：解析步骤（流式时允许部分解析以实时展示）
    const isAgent = mode === 'agent';
    const { segments, hasSteps } = isAgent && text ? parseAgentSteps(text, streaming) : { segments: [], hasSteps: false };

    // 步骤状态管理（用于批量操作）
    const stepIndices = segments.map((seg, idx) => seg.type === 'edit' || seg.type === 'command' ? idx : -1).filter(i => i >= 0);
    const totalSteps = stepIndices.length;
    const [stepStatuses, setStepStatuses] = useState({}); // { stepIndex: 'pending' | 'applied' | 'rejected' | 'failed' | 'running' | 'completed' }
    const [stepCollapsed, setStepCollapsed] = useState({}); // { stepIndex: boolean }

    // 计算进度
    const appliedCount = Object.values(stepStatuses).filter(s => s === 'applied' || s === 'completed').length;
    const pendingCount = Object.values(stepStatuses).filter(s => s === 'pending' || s === undefined).length;
    const progressPercent = totalSteps > 0 ? Math.round((appliedCount / totalSteps) * 100) : 0;
    const allCompleted = !streaming && totalSteps > 0 && appliedCount === totalSteps;

    // 完成通知
    const [hasShownCompletion, setHasShownCompletion] = useState(false);
    useEffect(() => {
        if (allCompleted && !hasShownCompletion) {
            setHasShownCompletion(true);
            // 显示完成通知（可以使用浏览器通知或简单的视觉提示）
            if (window.Notification && Notification.permission === 'granted') {
                new Notification('所有步骤已完成', {
                    body: `已完成 ${totalSteps} 个步骤`,
                    icon: '/favicon.ico'
                });
            }
        }
    }, [allCompleted, hasShownCompletion, totalSteps]);

    const handleStepStatusChange = useCallback((stepIdx, status) => {
        setStepStatuses(prev => ({ ...prev, [stepIdx]: status }));
    }, []);

    const handleStepCollapsedChange = useCallback((stepIdx, collapsed) => {
        setStepCollapsed(prev => ({ ...prev, [stepIdx]: collapsed }));
    }, []);

    // 批量操作：Accept All（仅处理编辑步骤）
    const handleAcceptAll = useCallback(async () => {
        const editSteps = segments
            .map((seg, idx) => ({ seg, idx }))
            .filter(({ seg, idx }) => seg.type === 'edit' && (stepStatuses[idx] === 'pending' || stepStatuses[idx] === undefined));

        for (const { seg, idx } of editSteps) {
            const fullPath = resolveFullPath(projectPath, seg.path);
            if (!fullPath) {
                handleStepStatusChange(idx, 'failed');
                continue;
            }

            handleStepStatusChange(idx, 'applied');
            try {
                await window.electronAPI?.writeFile?.(fullPath, seg.code);
                onStepApplied?.(fullPath);
            } catch (e) {
                handleStepStatusChange(idx, 'failed');
            }
        }
    }, [segments, stepStatuses, projectPath, resolveFullPath, handleStepStatusChange, onStepApplied]);

    // Auto 自动执行：流式结束后自动应用所有编辑步骤
    const autoAppliedRef = useRef(false);
    useEffect(() => {
        if (autoExecute && isAgent && hasSteps && !streaming && totalSteps > 0 && !autoAppliedRef.current) {
            const pendingExists = stepIndices.some(i => !stepStatuses[i] || stepStatuses[i] === 'pending');
            if (pendingExists) {
                autoAppliedRef.current = true;
                handleAcceptAll();
            }
        }
    }, [autoExecute, isAgent, hasSteps, streaming, totalSteps, stepIndices, stepStatuses, handleAcceptAll]);

    // 批量操作：Reject All（处理所有待处理的步骤）
    const handleRejectAll = useCallback(() => {
        const pendingSteps = segments
            .map((seg, idx) => ({ seg, idx }))
            .filter(({ seg, idx }) => {
                return (seg.type === 'edit' || seg.type === 'command') &&
                    (stepStatuses[idx] === 'pending' || stepStatuses[idx] === undefined);
            });

        pendingSteps.forEach(({ idx }) => {
            handleStepStatusChange(idx, 'rejected');
        });
    }, [segments, stepStatuses, handleStepStatusChange]);

    if (isAgent && hasSteps && segments.length > 0) {
        let currentStepNumber = 0;
        return (
            <div className="ask-answer-block agent-answer-with-steps">
                {/* 紧凑进度指示 + 批量操作（仅非流式时） */}
                {!streaming && totalSteps > 0 && (
                    <div className="agent-batch-actions-bar" style={{ padding: '6px 10px', gap: '8px', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
                            <div className="agent-progress-bar" style={{ flex: 1, height: '3px', borderRadius: '2px' }}>
                                <div className="agent-progress-fill" style={{ width: `${progressPercent}%`, height: '100%', borderRadius: '2px', transition: 'width 0.3s ease' }} />
                            </div>
                            <span style={{ fontSize: '10px', color: allCompleted ? '#4cc38a' : '#888', whiteSpace: 'nowrap', fontWeight: 600 }}>
                                {allCompleted ? '✓ 全部完成' : `${appliedCount}/${totalSteps}`}
                            </span>
                        </div>
                        {pendingCount > 0 && (
                            <div style={{ display: 'flex', gap: '4px' }}>
                                <button type="button" className="agent-batch-btn agent-batch-accept" onClick={handleAcceptAll} title="全部应用" style={{ padding: '3px 8px', fontSize: '10px' }}>
                                    <CheckSquare size={11} />
                                    <span>全部应用</span>
                                </button>
                                <button type="button" className="agent-batch-btn agent-batch-reject" onClick={handleRejectAll} title="全部拒绝" style={{ padding: '3px 8px', fontSize: '10px' }}>
                                    <Square size={11} />
                                    <span>拒绝</span>
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {/* Agent 流式思考指示器 */}
                {streaming && (
                    <div className="agent-thinking-indicator">
                        <div className="agent-thinking-dots">
                            <span /><span /><span />
                        </div>
                        <span className="agent-thinking-text">思考中...</span>
                    </div>
                )}

                {segments.map((seg, idx) => {
                    if (seg.type === 'todos') {
                        return <AgentTodosCard key={idx} items={seg.items} />;
                    }
                    if (seg.type === 'text') {
                        return (
                            <div key={idx} className="agent-segment-text">
                                {renderMarkdown(seg.content, { enableCheckbox, onCheckToggle, isDebugMode, isAgentMode: true, enableApply: false, showTerminalBlock: false })}
                            </div>
                        );
                    }
                    if (seg.type === 'edit') {
                        const stepNumber = currentStepNumber++;
                        const isPartial = seg.partial === true;
                        return (
                            <AgentEditStepCard
                                key={idx}
                                stepIndex={stepNumber}
                                totalSteps={totalSteps}
                                path={seg.path}
                                code={seg.code}
                                language={seg.language}
                                projectPath={projectPath}
                                resolveFullPath={resolveFullPath}
                                onApplied={onStepApplied}
                                status={isPartial ? 'pending' : (stepStatuses[idx] || 'pending')}
                                onStatusChange={(status) => handleStepStatusChange(idx, status)}
                                collapsed={stepCollapsed[idx]}
                                onCollapsedChange={(collapsed) => handleStepCollapsedChange(idx, collapsed)}
                                onRetry={() => handleStepStatusChange(idx, 'pending')}
                                autoExecute={autoExecute}
                            />
                        );
                    }
                    if (seg.type === 'command') {
                        const stepNumber = currentStepNumber++;
                        const isPartial = seg.partial === true;
                        return (
                            <AgentTerminalStepCard
                                key={idx}
                                stepIndex={stepNumber}
                                totalSteps={totalSteps}
                                code={seg.code}
                                projectPath={projectPath}
                                status={isPartial ? 'pending' : (stepStatuses[idx] || 'pending')}
                                onStatusChange={(status) => handleStepStatusChange(idx, status)}
                                collapsed={stepCollapsed[idx]}
                                onCollapsedChange={(collapsed) => handleStepCollapsedChange(idx, collapsed)}
                                onCancel={() => handleStepStatusChange(idx, 'failed')}
                            />
                        );
                    }
                    return null;
                })}
                {streaming && <span className="streaming-cursor" />}
            </div>
        );
    }

    const enableApply = isAgent;
    const showTerminalBlock = isAgent;

    return (
        <div className="ask-answer-block">
            {renderMarkdown(text || '', { enableApply, enableCheckbox, onCheckToggle, isDebugMode, isAgentMode: isAgent, projectPath, onApply, showTerminalBlock })}
            {streaming && (!text || text.length === 0) && (
                <div className="ask-generating-inline">
                    <Loader2 size={14} className="animate-spin" style={{ color: '#a78bfa' }} />
                    <span className="ask-generating-text">正在生成回复...</span>
                </div>
            )}
            {streaming && text && text.length > 0 && (
                <span className="streaming-cursor" />
            )}
        </div>
    );
}

// ============================================================
// 路径安全验证（防止路径遍历攻击）
// ============================================================
function validatePathSafety(projectPath, filePath) {
    if (!projectPath || !filePath) return { safe: false, error: '路径无效' };

    const normalizedProject = projectPath.replace(/[\\/]+$/, '').replace(/[\\/]+/g, '/');
    const normalizedFile = filePath.replace(/[\\/]+/g, '/');

    // 检查绝对路径是否在项目目录内
    if (/^[A-Za-z]:/.test(normalizedFile) || normalizedFile.startsWith('/')) {
        const absFile = normalizedFile.replace(/^[A-Za-z]:/, '').replace(/^\//, '');
        const absProject = normalizedProject.replace(/^[A-Za-z]:/, '').replace(/^\//, '');
        if (!absFile.startsWith(absProject)) {
            return { safe: false, error: '路径超出项目目录' };
        }
    }

    // 检查相对路径中的路径遍历（../ 或 ..\\）
    if (normalizedFile.includes('../') || normalizedFile.includes('..\\')) {
        // 解析路径并检查是否超出项目目录
        const parts = normalizedFile.split(/[\\/]+/);
        let depth = 0;
        for (const part of parts) {
            if (part === '..') {
                depth--;
                if (depth < 0) {
                    return { safe: false, error: '路径遍历攻击检测' };
                }
            } else if (part !== '.' && part !== '') {
                depth++;
            }
        }
    }

    // 检查危险字符（Windows 盘符中的 : 不算非法）
    const pathForCheck = normalizedFile.replace(/^[A-Za-z]:/, '');
    const dangerousChars = /[<>"|?*\x00-\x1f]/;
    if (dangerousChars.test(pathForCheck)) {
        return { safe: false, error: '路径包含非法字符' };
    }

    return { safe: true };
}

// ============================================================
// 命令注入防护（白名单 + 转义 + 高危拦截 blocked）
// ============================================================
function sanitizeCommand(command) {
    if (!command || typeof command !== 'string') return { safe: false, error: '命令无效' };

    const trimmed = command.trim();
    if (!trimmed) return { safe: false, error: '命令为空' };

    // 高危命令 → blocked + 安全替代建议
    const dangerousPatterns = [
        { re: /rm\s+-rf\s+[\/~]/i, msg: '递归删除根/主目录', suggestion: '仅删除特定子目录，如 rm -rf ./build' },
        { re: /rm\s+-rf/i, msg: '递归强制删除', suggestion: '删除前先列出目标文件确认范围' },
        { re: /del\s+\/s/i, msg: 'Windows 递归删除', suggestion: '使用 del /s 指定具体子目录' },
        { re: /format\s+[a-z]:/i, msg: '格式化磁盘', suggestion: '此操作不可逆，请手动在终端执行' },
        { re: /mkfs/i, msg: '创建文件系统', suggestion: '此操作不可逆，请手动在终端执行' },
        { re: /dd\s+if=/i, msg: '磁盘级写入', suggestion: '此操作不可逆，请手动在终端执行' },
        { re: /shutdown/i, msg: '关机命令', suggestion: '请手动关机' },
        { re: /reboot/i, msg: '重启命令', suggestion: '请手动重启' },
        { re: /sudo\s+rm/i, msg: 'sudo 删除', suggestion: '移除 sudo 或指定安全目录' },
        { re: /\|\s*sh\s*$/i, msg: '管道到 shell', suggestion: '先检查输入内容再执行' },
        { re: /\|\s*bash\s*$/i, msg: '管道到 bash', suggestion: '先检查输入内容再执行' },
        { re: /;\s*rm/i, msg: '命令注入（;rm）', suggestion: '拆分为独立命令' },
        { re: /&&\s*rm/i, msg: '命令注入（&&rm）', suggestion: '拆分为独立命令' },
        { re: /\|\s*rm/i, msg: '管道删除', suggestion: '拆分为独立命令' },
        { re: /`.*rm/i, msg: '反引号注入', suggestion: '避免嵌套命令' },
        { re: /\$\(.*rm/i, msg: '命令替换注入', suggestion: '避免嵌套命令' },
    ];

    for (const { re, msg, suggestion } of dangerousPatterns) {
        if (re.test(trimmed)) {
            return { safe: false, blocked: true, error: `🚫 高危命令已拦截：${msg}`, suggestion };
        }
    }

    // 检查命令长度（防止超长命令）
    if (trimmed.length > 10000) {
        return { safe: false, error: '命令过长' };
    }

    return { safe: true, command: trimmed };
}

// ============================================================
// AskMessageCard — 消息组主组件
// ============================================================
function resolveFullPath(projectPath, filePathFromBlock) {
    let t = (filePathFromBlock || '').trim();
    if (!t) return null;

    // 清理可能混入的行号标记（如 "file.js:143" → "file.js"，"143|code" → 忽略）
    if (/^\d+\|/.test(t)) return null;
    t = t.replace(/:\d+$/, '').replace(/:\d+:\d+$/, '');

    // 过滤明显非路径的文本（含中文、过多空格分隔的单词、过长）
    if (!looksLikeFilePath(t)) return null;

    // 路径安全验证
    const validation = validatePathSafety(projectPath, t);
    if (!validation.safe) {
        console.warn('路径安全验证失败:', validation.error, t);
        return null; // 返回 null 表示路径不安全
    }

    if (/^[A-Za-z]:[\\/]/.test(t) || t.startsWith('/')) return t;
    if (!projectPath) return t;
    const sep = projectPath.includes('/') ? '/' : '\\';
    const base = projectPath.replace(/[\\/]+$/, '');
    const rel = t.replace(/^[\\/]+/, '');
    return (base + sep + rel).split(/[\\/]+/).join(sep);
}

// ============================================================
// InlineThoughtPanel — 批次级 Thinking/Thought
// 正在思考: "Thinking Xs..." (旋转图标)
// 思考完成: "Thought for Xs" (完成图标)
// ============================================================
function InlineThoughtPanel({ reasoning, durationMs, streaming, startTime }) {
    const [expanded, setExpanded] = useState(false);
    const [liveSec, setLiveSec] = useState(0);

    React.useEffect(() => {
        if (!streaming || !startTime) return;
        const iv = setInterval(() => setLiveSec(Math.floor((Date.now() - startTime) / 1000)), 200);
        return () => clearInterval(iv);
    }, [streaming, startTime]);

    const secs = streaming ? liveSec : (durationMs != null ? Math.round(durationMs / 1000) : 0);
    const hasContent = reasoning && reasoning.trim().length > 0;

    const label = streaming
        ? `Thinking${liveSec > 0 ? ` ${liveSec}s` : ''}...`
        : secs > 5 ? `Thought for ${secs}s` : secs > 0 ? `Thought for ${secs}s` : 'Thought briefly';

    if (!hasContent && !streaming) return null;

    return (
        <div className={`my-1 ${streaming ? 'inline-thought--active' : ''}`}>
            <button
                className={`flex items-center gap-1.5 py-1 text-[12px] transition-colors ${streaming ? 'text-purple-400' : 'text-zinc-500 hover:text-zinc-400'}`}
                onClick={() => hasContent && setExpanded(!expanded)}
            >
                {streaming
                    ? <Loader2 size={12} className="animate-spin text-purple-400" />
                    : <Sparkles size={12} className="text-purple-400" />
                }
                <span>{label}</span>
                {hasContent && !streaming && (
                    expanded
                        ? <ChevronDown size={11} className="text-zinc-600" />
                        : <ChevronRight size={11} className="text-zinc-600" />
                )}
            </button>
            {expanded && hasContent && (
                <div className="ml-5 pl-2 border-l border-zinc-800 text-[11px] text-zinc-500 leading-relaxed max-h-[200px] overflow-y-auto">
                    {renderMarkdown(reasoning)}
                </div>
            )}
        </div>
    );
}

// ============================================================
// AgentThinkingSegment — Cursor 风格
// 短文本 → 简约灰色状态行 (如 "Planning next moves")
// 长文本/带编号标题 → markdown 渲染 (如 "1. 重写 ToolCallCard")
// ============================================================
function AgentThinkingSegment({ text, streaming }) {
    if (!text || !text.trim()) return null;
    const trimmed = text.trim();
    const hasStructure = trimmed.includes('\n') || /^#+\s/.test(trimmed) || /^\d+\.\s/.test(trimmed) || /\*\*/.test(trimmed);
    const isShort = trimmed.length < 80 && !hasStructure;

    if (isShort) {
        return (
            <div className={`flex items-center gap-1.5 px-1 py-[3px] text-[13px] ${streaming ? 'text-zinc-300 agent-thinking--active' : 'text-zinc-500'}`}>
                <span>{trimmed}</span>
                {streaming && <span className="streaming-cursor streaming-cursor--thought" />}
            </div>
        );
    }

    return (
        <div className={`px-1 py-1 text-[13px] leading-relaxed ${streaming ? 'text-zinc-300 agent-thinking--active' : 'text-zinc-400'}`}>
            {renderMarkdown(trimmed)}
            {streaming && <span className="streaming-cursor streaming-cursor--thought" />}
        </div>
    );
}

// ============================================================
// TodoUpdateLine — Cursor 风格
// "Started to-do ✅ [描述]"  |  "Completed 5 of 5 ✅ [描述]"
// ============================================================
function TodoUpdateLine({ toolCall, agentTodos }) {
    const args = React.useMemo(() => {
        try { return JSON.parse(toolCall?.function?.arguments || '{}'); }
        catch { return {}; }
    }, [toolCall?.function?.arguments]);

    const todos = Array.isArray(args.todos) ? args.todos : [];
    if (todos.length === 0) return null;

    const totalTodos = agentTodos?.length || todos.length;
    const completedTodos = agentTodos?.filter(t => t.status === 'completed').length || 0;

    const hasCompletedItems = todos.some(t => t.status === 'completed');
    const hasStartedItems = todos.some(t => t.status === 'in_progress');

    if (hasCompletedItems && completedTodos > 0) {
        const lastCompleted = todos.filter(t => t.status === 'completed').pop();
        return (
            <div className="flex items-center gap-1.5 px-1 py-[3px] text-[13px]">
                <span className="text-zinc-400 font-medium">Completed {completedTodos} of {totalTodos}</span>
                <span className="text-green-400">✅</span>
                {lastCompleted && <span className="text-zinc-300">{lastCompleted.content}</span>}
            </div>
        );
    }

    if (hasStartedItems) {
        const started = todos.filter(t => t.status === 'in_progress');
        return (
            <div className="flex flex-col gap-0.5 my-0.5">
                {started.map((todo, i) => (
                    <div key={todo.id || i} className="flex items-center gap-1.5 px-1 py-[2px] text-[13px]">
                        <span className="text-zinc-500">Started to-do</span>
                        <span className="text-green-400">✅</span>
                        <span className="text-zinc-300">{todo.content}</span>
                    </div>
                ))}
            </div>
        );
    }

    return (
        <div className="flex items-center gap-1.5 px-1 py-[3px] text-[13px]">
            <span className="text-zinc-500">Updated to-do</span>
            <span className="text-zinc-400">{todos.length} items</span>
        </div>
    );
}

// ============================================================
// ExploredFilesSummary — Cursor 风格 "Explored X files" 分组
// 增强：显示并行执行的实时进度
// ============================================================
function ExploredFilesSummary({ tools }) {
    const [expanded, setExpanded] = useState(false);
    const fileCount = tools.length;
    const runningCount = tools.filter(tc => tc.status === 'running').length;
    const pendingCount = tools.filter(tc => tc.status === 'pending').length;
    const completedCount = tools.filter(tc => tc.status === 'success' || tc.status === 'failed').length;
    const isActive = runningCount > 0 || pendingCount > 0;
    const allDone = completedCount === fileCount && fileCount > 0;
    const totalElapsed = tools.reduce((sum, tc) => sum + (tc.elapsed || 0), 0);

    return (
        <div>
            <div
                className={`flex items-center gap-1.5 px-1 py-[3px] rounded cursor-pointer transition-colors
                    ${isActive ? 'tool-call-active-row' : 'hover:bg-white/[0.03]'}`}
                onClick={() => setExpanded(!expanded)}
            >
                {isActive ? (
                    <Loader2 size={13} className="animate-spin text-zinc-400 shrink-0" />
                ) : expanded ? (
                    <ChevronDown size={12} className="text-zinc-600 shrink-0" />
                ) : (
                    <ChevronRight size={12} className="text-zinc-600 shrink-0" />
                )}
                <span className={`text-[13px] ${isActive ? 'text-zinc-300' : 'text-zinc-500'}`}>
                    {isActive
                        ? `Exploring ${fileCount} file${fileCount !== 1 ? 's' : ''}`
                        : `Explored ${fileCount} file${fileCount !== 1 ? 's' : ''}`}
                </span>

                {/* 并行执行中：显示进度计数器 */}
                {isActive && (
                    <span className="text-[11px] text-zinc-500 tabular-nums shrink-0">
                        {completedCount}/{fileCount}
                        {runningCount > 0 && (
                            <span className="text-zinc-400 ml-1">
                                ({runningCount} running)
                            </span>
                        )}
                    </span>
                )}

                {/* 完成后显示总耗时 */}
                {allDone && totalElapsed > 0 && (
                    <span className="text-[10px] text-zinc-600 tabular-nums shrink-0 flex items-center gap-0.5 ml-auto">
                        <Clock size={9} />
                        {totalElapsed < 1000 ? `${totalElapsed}ms` : `${(totalElapsed / 1000).toFixed(1)}s`}
                    </span>
                )}

                {/* 进度条 */}
                {isActive && fileCount > 1 && (
                    <div className="flex-1 min-w-[40px] max-w-[120px] h-[3px] bg-zinc-800 rounded-full overflow-hidden ml-1">
                        <div
                            className="h-full bg-zinc-500 rounded-full transition-all duration-300"
                            style={{ width: `${Math.round((completedCount / fileCount) * 100)}%` }}
                        />
                    </div>
                )}
            </div>
            {expanded && (
                <div className="ml-3">
                    {tools.map((tc, i) => (
                        <ToolCallCard
                            key={tc.id || i}
                            toolCall={tc}
                            status={tc.status || 'success'}
                            result={tc.result}
                            elapsed={tc.elapsed}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// ============================================================
// CursorStatusLine — "Summarized Chat context summarized." 等状态行
// ============================================================
function CursorStatusLine({ label, text }) {
    return (
        <div className="flex items-center gap-1.5 px-1 py-[3px] text-[13px]">
            <span className="text-zinc-400 font-medium">{label}</span>
            <span className="text-zinc-500">{text}</span>
        </div>
    );
}

// ============================================================
// VerificationBadge — 验收结果指示
// ============================================================
function VerificationBadge({ agentToolCalls, agentTodos }) {
    const failedTools = agentToolCalls.filter(tc => tc.status === 'failed').length;
    const pendingTodos = agentTodos.filter(t => t.status !== 'completed' && t.status !== 'cancelled').length;
    const totalTodos = agentTodos.length;
    const completedTodos = agentTodos.filter(t => t.status === 'completed').length;
    const totalTools = agentToolCalls.length;

    if (totalTools === 0 && totalTodos === 0) return null;

    const allGood = failedTools === 0 && pendingTodos === 0;

    if (allGood && totalTodos > 0) {
        return (
            <div className="flex items-center gap-1.5 px-1 py-[3px] text-[13px]">
                <span className="text-zinc-400 font-medium">Completed {completedTodos} of {totalTodos}</span>
                <span className="text-green-400">✅</span>
                <span className="text-zinc-500">验证所有修改无 linter 错误</span>
            </div>
        );
    }

    if (!allGood) {
        return (
            <div className="flex items-center gap-2 px-2 py-1.5 my-1 rounded text-[12px] bg-yellow-950/15 border border-yellow-800/20 text-yellow-400/90">
                <AlertTriangle size={13} />
                <span>
                    {failedTools > 0 ? `${failedTools} 项操作失败` : ''}
                    {failedTools > 0 && pendingTodos > 0 ? '，' : ''}
                    {pendingTodos > 0 ? `${pendingTodos} 项任务未完成` : ''}
                </span>
            </div>
        );
    }

    return null;
}

// ============================================================
// AgentConclusionBlock — 最终结论（仅执行完成后显示）
// ============================================================
function AgentConclusionBlock({ text, mode, onCheckToggle, projectPath, onApply }) {
    if (!text || !text.trim()) return null;
    return (
        <div className="mt-3 pt-3 border-t border-zinc-800/50">
            <AiAnswerBlock
                text={text}
                streaming={false}
                mode={mode}
                onCheckToggle={onCheckToggle}
                projectPath={projectPath}
                onApply={onApply}
                resolveFullPath={resolveFullPath}
                autoExecute={false}
            />
        </div>
    );
}


// ============================================================
// TerminalStateBadge — 终态 badge（唯一终态展示源）
// ============================================================
function TerminalStateBadge({ msg }) {
    if (!msg) return null;
    if (msg.streaming) return null;

    if (msg.agentTerminalState === 'incomplete' && msg.agentTerminalReasons?.length > 0) {
        const reasons = msg.agentTerminalReasons;
        const pendingTodos = msg.agentTerminalPendingTodos || [];
        return (
            <div style={{
                background: 'linear-gradient(135deg, rgba(202,138,4,0.08) 0%, rgba(30,30,30,0.95) 50%)',
                border: '1px solid rgba(202,138,4,0.2)',
                borderRadius: '10px',
                padding: '12px 14px',
                margin: '4px 0 8px 0',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: pendingTodos.length > 0 ? '8px' : '0' }}>
                    <div style={{
                        width: '22px', height: '22px', borderRadius: '6px',
                        background: 'rgba(202,138,4,0.15)', display: 'flex',
                        alignItems: 'center', justifyContent: 'center',
                    }}>
                        <AlertTriangle size={13} style={{ color: '#ca8a04' }} />
                    </div>
                    <span style={{ fontSize: '12px', fontWeight: 500, color: '#ca8a04', letterSpacing: '0.3px' }}>
                        未完成停止
                    </span>
                    <span style={{ fontSize: '10px', color: '#71717a', marginLeft: 'auto' }}>
                        {reasons.join('；')}
                    </span>
                </div>
                {pendingTodos.length > 0 && (
                    <div style={{ fontSize: '11px', color: '#a1a1aa', lineHeight: '1.5', paddingLeft: '30px' }}>
                        {pendingTodos.map((t, i) => (
                            <div key={i}>⬜ {t.content}</div>
                        ))}
                    </div>
                )}
            </div>
        );
    }

    if (msg.agentTerminalState === 'cancelled') {
        return (
            <div style={{
                background: 'rgba(113,113,122,0.08)',
                border: '1px solid rgba(113,113,122,0.2)',
                borderRadius: '10px',
                padding: '10px 14px',
                margin: '4px 0 8px 0',
                display: 'flex', alignItems: 'center', gap: '8px',
            }}>
                <StopCircle size={13} style={{ color: '#71717a' }} />
                <span style={{ fontSize: '12px', color: '#71717a' }}>用户已取消</span>
            </div>
        );
    }

    return null;
}

export default function AskMessageCard({ msg, isGenerating, generatingStartTime, chatMode, onModeSwitch, projectPath, autoExecute, onStepApplied, onEditMessage, onAgentApprove, onAgentDeny }) {
    const dialog = useDialog();
    if (msg.role === 'user') return <UserMessageCard text={msg.text} attachments={msg.attachments} references={msg.references} onEdit={(text) => onEditMessage?.(msg, text)} />;

    const showThought = msg.isReasoningModel === true;
    const answerText = msg.answerText || msg.text || '';
    const thoughtText = msg.thoughtSummaryZh || '';
    const durationMs = msg.thoughtDurationMs;
    const citations = msg.citations || [];
    const msgMode = msg.mode || chatMode || 'chat';
    const isStreaming = msg.streaming === true;
    const isPlan = msgMode === 'plan';
    const toolCalls = msg.toolCalls || [];
    const agentToolCalls = msg.agentToolCalls || [];
    const agentTodos = msg.agentTodos || [];
    const hasAgentTools = agentToolCalls.length > 0;
    const activeWorkflow = msg.activeWorkflow || null;
    const agentThinkingTexts = msg.agentThinkingTexts || [];
    const agentReasoningTexts = msg.agentReasoningTexts || [];
    const agentProgressNotes = msg.agentProgressNotes || [];
    const agentCurrentThinking = msg.agentCurrentThinking || '';
    const agentCurrentReasoning = msg.agentCurrentReasoning || '';
    const agentReasoningStart = msg.agentReasoningStart || null;
    const agentConclusion = msg.agentConclusion || '';
    const hasSkillFeedback = (msg.availableSkills && msg.availableSkills.length > 0) || (msg.matchedSkills && msg.matchedSkills.length > 0);
    const isAgentV2 = hasAgentTools || agentThinkingTexts.length > 0 || agentProgressNotes.length > 0 || hasSkillFeedback;

    const handleApply = useCallback(async (filePathFromBlock, newContent) => {
        const fullPath = resolveFullPath(projectPath, filePathFromBlock);
        if (!fullPath) return;
        let oldContent = '';
        try {
            const raw = await window.electronAPI?.readFileContent?.(fullPath);
            if (raw && !raw.startsWith('// 无法读取') && !raw.startsWith('// [文件过大')) oldContent = raw;
        } catch (_) { }
        if (!autoExecute) {
            const confirmed = await dialog.confirmApply(fullPath, oldContent, newContent);
            if (!confirmed) return;
        }
        try {
            const result = await window.electronAPI?.writeFile?.(fullPath, newContent);
            if (result?.success) {
                onStepApplied?.(fullPath);
                if (!autoExecute) dialog.alert(`已写入：${fullPath}`, '应用成功');
            } else {
                dialog.alert(result?.error || '写入失败', '应用失败');
            }
        } catch (e) {
            dialog.alert(e?.message || '写入失败', '应用失败');
        }
    }, [projectPath, dialog, autoExecute, onStepApplied]);

    const [checkStates, setCheckStates] = useState({});
    const handleCheckToggle = useCallback((index) => {
        setCheckStates(prev => ({ ...prev, [index]: !prev[index] }));
    }, []);

    const handleStartImplementation = useCallback(() => {
        if (onModeSwitch) onModeSwitch('agent');
    }, [onModeSwitch]);

    // ── Agent V2 布局：[批次流: Thought→思考→工具(TodoPanel内联)] → 验收 → 结论 ──
    if (isAgentV2 && msgMode === 'agent') {
        const batchMap = {};
        agentToolCalls.forEach(tc => {
            const b = tc._batch ?? 0;
            if (!batchMap[b]) batchMap[b] = [];
            batchMap[b].push(tc);
        });
        const maxBatch = Math.max(
            agentThinkingTexts.length - 1,
            agentReasoningTexts.length - 1,
            ...agentToolCalls.map(tc => tc._batch ?? 0),
            -1,
        );

        // 判断 todo_write 首次出现的 batch，用于内联 TodoPanel
        let todoPanelRendered = false;
        const isTodoWriteCall = (tc) => {
            const name = tc?.function?.name;
            return name === 'todo_write';
        };
        // 检测方案评估文本（在 todo_write 之前的 thinking 中）
        const getEvaluationText = (thinkingText) => {
            if (!thinkingText) return null;
            const evalKeywords = ['评估', '自评', '打分', '方案评估', '评分'];
            if (evalKeywords.some(k => thinkingText.includes(k))) return thinkingText;
            return null;
        };

        return (
            <div className="ask-ai-group">
                {/* Skill 匹配激活反馈（有匹配时显示） */}
                {msg.matchedSkills && msg.matchedSkills.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 bg-indigo-900/20 border border-indigo-800/30 rounded-lg mb-2">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-indigo-400">
                            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                        </svg>
                        <span className="text-[10px] text-indigo-400 font-semibold">已激活技能：</span>
                        {msg.matchedSkills.map(s => (
                            <span key={s.name} className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${msg.usedSkills?.includes(s.name)
                                ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-700/40'
                                : 'bg-zinc-800 text-zinc-400 border border-zinc-700/40'
                                }`} title={s.summary || s.name}>
                                {s.name}{msg.usedSkills?.includes(s.name) ? ' ✓' : ''}
                            </span>
                        ))}
                        {msg.availableSkills && msg.availableSkills.length > msg.matchedSkills.length && (
                            <span className="text-[9px] text-zinc-600 ml-1">
                                ({msg.availableSkills.length} 个可用)
                            </span>
                        )}
                    </div>
                )}

                {/* 工作流执行面板 */}
                {activeWorkflow && activeWorkflow.steps && (
                    <WorkflowExecutionPanel
                        workflowName={activeWorkflow.name}
                        steps={activeWorkflow.steps}
                    />
                )}

                {/* Sticky 进度追踪器 — 滚动后悬停可查看 */}
                {agentTodos.length > 0 && !activeWorkflow && (
                    <StickyTodoTracker todos={agentTodos} />
                )}

                {/* 逐批次渲染 */}
                {Array.from({ length: maxBatch + 1 }, (_, batchIdx) => {
                    const reasoning = agentReasoningTexts[batchIdx];
                    const thinking = agentThinkingTexts[batchIdx];
                    const tools = batchMap[batchIdx] || [];
                    const hasTodoWrite = tools.some(isTodoWriteCall);
                    const evalText = getEvaluationText(thinking);

                    return (
                        <React.Fragment key={`batch-${batchIdx}`}>
                            {reasoning?.text && (
                                <InlineThoughtPanel
                                    reasoning={reasoning.text}
                                    durationMs={reasoning.durationMs}
                                />
                            )}
                            {thinking && !evalText && (
                                <AgentThinkingSegment text={thinking} />
                            )}
                            {evalText && (
                                <PlanEvaluationCard evaluationText={evalText} />
                            )}
                            {/* Cursor 风格工具分组渲染 */}
                            {(() => {
                                const EXPLORE_SET = new Set(['read_file', 'grep_search', 'file_search', 'list_dir', 'list_directory', 'search_files', 'glob_search', 'read_lints']);
                                const explorationTools = tools.filter(tc => EXPLORE_SET.has(tc?.function?.name));
                                const todoTools = tools.filter(tc => tc?.function?.name === 'todo_write');
                                const otherTools = tools.filter(tc => !EXPLORE_SET.has(tc?.function?.name) && tc?.function?.name !== 'todo_write');

                                return (
                                    <>
                                        {/* 探索工具 → "Explored X files" */}
                                        {explorationTools.length > 1 && (
                                            <ExploredFilesSummary tools={explorationTools} />
                                        )}
                                        {explorationTools.length === 1 && (
                                            <ToolCallCard
                                                toolCall={explorationTools[0]}
                                                status={explorationTools[0].status || 'pending'}
                                                result={explorationTools[0].result}
                                                elapsed={explorationTools[0].elapsed}
                                                onApprove={onAgentApprove}
                                                onDeny={onAgentDeny}
                                            />
                                        )}

                                        {/* 其他工具 → 单独 ToolCallCard */}
                                        {otherTools.map((tc, i) => (
                                            <ToolCallCard
                                                key={tc.id || `${batchIdx}-other-${i}`}
                                                toolCall={tc}
                                                status={tc.status || 'pending'}
                                                result={tc.result}
                                                elapsed={tc.elapsed}
                                                onApprove={onAgentApprove}
                                                onDeny={onAgentDeny}
                                            />
                                        ))}

                                        {/* Todo 工具 → TodoUpdateLine + TodoPanel */}
                                        {todoTools.map((tc, i) => {
                                            const showPanel = !todoPanelRendered && agentTodos.length > 0;
                                            if (showPanel) todoPanelRendered = true;
                                            return (
                                                <React.Fragment key={tc.id || `${batchIdx}-todo-${i}`}>
                                                    <TodoUpdateLine toolCall={tc} agentTodos={agentTodos} />
                                                    {showPanel && <TodoPanel todos={agentTodos} />}
                                                </React.Fragment>
                                            );
                                        })}
                                    </>
                                );
                            })()}
                        </React.Fragment>
                    );
                })}

                {/* 实时 reasoning（当前迭代正在思考） */}
                {isStreaming && agentCurrentReasoning && (
                    <InlineThoughtPanel
                        reasoning={agentCurrentReasoning}
                        streaming
                        startTime={agentReasoningStart}
                    />
                )}

                {/* 实时内容思考 */}
                {isStreaming && agentCurrentThinking && (
                    <AgentThinkingSegment text={agentCurrentThinking} streaming />
                )}

                {/* Cursor 风格进度状态行 */}
                {agentProgressNotes.length > 0 && (() => {
                    const HIDDEN_PATTERNS = [
                        '检测到文本停滞', 'tool_choice=required', 'Task complete',
                        'Task failed', 'Task cancelled', '强制重试第',
                        '还有', '项待完成', 'Planning next moves',
                        'Thinking...', 'Running tools...', 'Reviewing changes...',
                        'Tool retries exhausted',
                    ];
                    const visibleNotes = agentProgressNotes.slice(-8).filter(note => {
                        if (!note?.text) return false;
                        return !HIDDEN_PATTERNS.some(p => note.text.includes(p));
                    });
                    if (visibleNotes.length === 0) return null;
                    return (
                        <div className="flex flex-col gap-0.5 my-0.5">
                            {visibleNotes.map((note, i) => {
                                const t = note.text;

                                // 并行批次开始
                                if (t.startsWith('Running ') && t.includes('in parallel')) {
                                    const match = t.match(/Running (\d+) tools in parallel: (.+)/);
                                    if (match) {
                                        return (
                                            <div key={i} className="flex items-center gap-1.5 px-1 py-[3px]">
                                                <Loader2 size={12} className="animate-spin text-zinc-400 shrink-0" />
                                                <span className="text-[12px] text-zinc-400">
                                                    Parallel {match[1]} tools
                                                </span>
                                                <span className="text-[11px] text-zinc-600 font-mono truncate">
                                                    {match[2]}
                                                </span>
                                            </div>
                                        );
                                    }
                                }

                                // 并行批次完成
                                if (t.startsWith('Parallel batch done')) {
                                    const match = t.match(/(\d+) tools in (\d+)ms/);
                                    if (match) {
                                        const elapsed = parseInt(match[2]);
                                        return (
                                            <div key={i} className="flex items-center gap-1.5 px-1 py-[3px]">
                                                <Check size={12} className="text-zinc-500 shrink-0" />
                                                <span className="text-[12px] text-zinc-500">
                                                    Batch done: {match[1]} tools
                                                </span>
                                                <span className="text-[10px] text-zinc-600 tabular-nums flex items-center gap-0.5">
                                                    <Clock size={9} />
                                                    {elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`}
                                                </span>
                                            </div>
                                        );
                                    }
                                }

                                // 并行中的单个工具完成 (带进度)
                                if (/^\u2713 .+ \[\d+\/\d+\]$/.test(t)) {
                                    const match = t.match(/\u2713 (.+?) \((\d+)ms\) \[(\d+)\/(\d+)\]/);
                                    if (match) {
                                        const pct = Math.round((parseInt(match[3]) / parseInt(match[4])) * 100);
                                        return (
                                            <div key={i} className="flex items-center gap-1.5 px-1 py-[2px]">
                                                <Check size={11} className="text-zinc-600 shrink-0" />
                                                <span className="text-[11px] text-zinc-500 font-mono">{match[1]}</span>
                                                <span className="text-[10px] text-zinc-700 tabular-nums">{match[2]}ms</span>
                                                <span className="text-[10px] text-zinc-600 tabular-nums">[{match[3]}/{match[4]}]</span>
                                                <div className="w-[40px] h-[2px] bg-zinc-800 rounded-full overflow-hidden">
                                                    <div className="h-full bg-zinc-600 rounded-full transition-all duration-200" style={{ width: `${pct}%` }} />
                                                </div>
                                            </div>
                                        );
                                    }
                                }

                                if (t.includes('压缩') || t.includes('已压缩') || t.includes('Summarized')) {
                                    return <CursorStatusLine key={i} label="Summarized" text="Chat context summarized." />;
                                }
                                if (t.includes('验收未通过') || t.includes('Gate check failed')) {
                                    return <CursorStatusLine key={i} label="Gate check" text={t.replace(/^.*?:\s*/, '').substring(0, 60)} />;
                                }
                                if (t.includes('验收已尝试') || t.includes('Finalizing')) {
                                    return <CursorStatusLine key={i} label="Finalizing" text="Preparing conclusion..." />;
                                }
                                if (/^Explored \d+ files?$/.test(t)) {
                                    return <CursorStatusLine key={i} label="Explored" text={t.replace('Explored ', '')} />;
                                }
                                if (/^Edited \d+ files?$/.test(t)) {
                                    return <CursorStatusLine key={i} label="Edited" text={t.replace('Edited ', '')} />;
                                }
                                if (t.startsWith('Iteration ')) {
                                    return <CursorStatusLine key={i} label="Progress" text={t.replace('Iteration ', '')} />;
                                }
                                // 带耗时的完成行
                                if (t.startsWith('\u2713 ') && t.includes('ms)')) {
                                    const match = t.match(/\u2713 (.+?) \((\d+)ms\)/);
                                    if (match) {
                                        return (
                                            <div key={i} className="flex items-center gap-1.5 px-1 py-[2px]">
                                                <Check size={11} className="text-zinc-600 shrink-0" />
                                                <span className="text-[11px] text-zinc-500 font-mono">{match[1]}</span>
                                                <span className="text-[10px] text-zinc-700 tabular-nums">{match[2]}ms</span>
                                            </div>
                                        );
                                    }
                                }
                                return <CursorStatusLine key={i} label="" text={t.substring(0, 80)} />;
                            })}
                        </div>
                    );
                })()}

                {/* Cursor 风格状态指示 */}
                {isStreaming && !agentCurrentThinking && !agentCurrentReasoning && (
                    <div className="flex items-center gap-1.5 px-1 py-[3px] text-[13px] text-zinc-500 agent-status-indicator">
                        <Loader2 size={13} className="animate-spin text-zinc-500" />
                        <span>{
                            msg.agentState === 'executing_tools'
                                ? (msg.agentHeartbeat || 'Running tools...')
                                : msg.agentState === 'calling_llm'
                                    ? (msg.agentHeartbeat || 'Thinking...')
                                    : msg.agentState === 'planning'
                                        ? 'Planning next moves'
                                        : msg.agentState === 'reflecting'
                                            ? 'Reviewing changes...'
                                            : 'Planning next moves'
                        }</span>
                    </div>
                )}

                {/* 验收结果（执行完成后显示） */}
                {!isStreaming && agentToolCalls.length > 0 && (
                    <VerificationBadge
                        agentToolCalls={agentToolCalls}
                        agentTodos={agentTodos}
                    />
                )}

                {/* 结论 — 仅验收后显示 */}
                {!isStreaming && agentConclusion && (
                    <AgentConclusionBlock
                        text={agentConclusion}
                        mode={msgMode}
                        onCheckToggle={handleCheckToggle}
                        projectPath={projectPath}
                        onApply={handleApply}
                    />
                )}

                <TerminalStateBadge msg={msg} />
                <CitationPills citations={citations} />
            </div>
        );
    }

    // ── 非 Agent V2 模式（Ask/Plan/Debug/Agent V1）原有布局 ──
    return (
        <div className="ask-ai-group">
            {showThought && (
                <ThoughtPanel
                    thoughtText={thoughtText}
                    durationMs={durationMs}
                    isGenerating={isGenerating && !answerText}
                    generatingStartTime={generatingStartTime}
                />
            )}
            {agentTodos.length > 0 && (
                <TodoPanel todos={agentTodos} />
            )}
            <AiAnswerBlock
                text={answerText}
                streaming={isStreaming && isGenerating}
                mode={msgMode}
                onCheckToggle={handleCheckToggle}
                projectPath={projectPath}
                onApply={handleApply}
                resolveFullPath={resolveFullPath}
                onStepApplied={onStepApplied}
                autoExecute={autoExecute}
            />
            <TerminalStateBadge msg={msg} />
            <CitationPills citations={citations} />
            {isPlan && !isStreaming && answerText && (
                <PlanActions onStartImplementation={handleStartImplementation} />
            )}
        </div>
    );
}

export { ThoughtPanel, UserMessageCard, AiAnswerBlock, CitationPills, CodeBlockCard, PlanActions, CalloutBlock };
