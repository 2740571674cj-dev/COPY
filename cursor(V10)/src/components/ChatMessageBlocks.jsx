import React, { useState } from 'react';
import { FileText, Copy, Check } from 'lucide-react';

// ============================================================
// 纯文本轻量解析器 — 将原始 AI 文本解析为 blocks
// 支持：段落、代码块（```）、diff 块、列表、标题、表格、引用块
// ============================================================
export function parseTextToBlocks(text) {
    if (!text || typeof text !== 'string') return [];

    const lines = text.split('\n');
    const blocks = [];
    let i = 0;

    const isTableLine = (l) => {
        if (!l || !l.trim()) return false;
        const t = l.trim();
        if (/^\|/.test(t)) return true;
        const pipeCount = (t.match(/(?<!\|)\|(?!\|)/g) || []).length;
        return pipeCount >= 2;
    };
    const isTableSeparator = (l) => {
        if (!l) return false;
        const t = l.trim();
        return /^[\s|:\-]+$/.test(t) && /--/.test(t) && t.includes('|');
    };

    while (i < lines.length) {
        const line = lines[i];

        // --- 代码块 / diff 块 ---
        if (line.trimStart().startsWith('```')) {
            const langMatch = line.trimStart().match(/^```(\w*)/);
            const lang = langMatch?.[1] || '';
            const isDiff = lang === 'diff';
            const codeLines = [];
            i++;
            while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
                codeLines.push(lines[i]);
                i++;
            }
            i++; // skip closing ```

            if (isDiff) {
                blocks.push({ type: 'diff', lines: codeLines });
            } else {
                blocks.push({ type: 'code', language: lang, code: codeLines.join('\n') });
            }
            continue;
        }

        // --- 表格（在空行/分隔线检查之前） ---
        if (isTableLine(line)) {
            const tableLines = [];
            const origI = i;
            while (i < lines.length) {
                const cur = lines[i];
                if (isTableLine(cur) || isTableSeparator(cur)) {
                    tableLines.push(cur);
                    i++;
                } else if (cur.trim() === '' && i + 1 < lines.length && (isTableLine(lines[i + 1]) || isTableSeparator(lines[i + 1]))) {
                    i++;
                } else {
                    break;
                }
            }
            if (tableLines.length >= 2) {
                const splitRow = (row) => {
                    let r = row.trim();
                    if (r.startsWith('|')) r = r.slice(1);
                    if (r.endsWith('|')) r = r.slice(0, -1);
                    return r.split('|').map(c => c.trim());
                };
                const headers = splitRow(tableLines[0]);
                const colCount = headers.length;
                let dataStartIdx = 1;
                if (tableLines.length > 1) {
                    const sepCells = splitRow(tableLines[1]);
                    const isSep = sepCells.every(c => /^[:\-\s]+$/.test(c) && c.replace(/[:\s]/g, '').length > 0);
                    if (isSep) {
                        // 提取对齐信息
                        const aligns = sepCells.map(c => {
                            const t = c.trim();
                            if (t.startsWith(':') && t.endsWith(':')) return 'center';
                            if (t.endsWith(':')) return 'right';
                            return 'left';
                        });
                        dataStartIdx = 2;
                        const dataRows = tableLines.slice(dataStartIdx).map(r => {
                            const cells = splitRow(r);
                            while (cells.length < colCount) cells.push('');
                            return cells.slice(0, colCount);
                        });
                        blocks.push({ type: 'table', headers, rows: dataRows, aligns });
                        continue;
                    }
                }
                const dataRows = tableLines.slice(dataStartIdx).map(r => {
                    const cells = splitRow(r);
                    while (cells.length < colCount) cells.push('');
                    return cells.slice(0, colCount);
                });
                blocks.push({ type: 'table', headers, rows: dataRows });
                continue;
            }
            i = origI;
        }

        // --- 分隔线（排除含 | 的表格分隔行） ---
        if (/^[-=]{3,}$/.test(line.trim()) && !line.includes('|')) {
            blocks.push({ type: 'divider' });
            i++;
            continue;
        }

        // --- 空行 ---
        if (line.trim() === '') {
            i++;
            continue;
        }

        // --- 标题 ---
        const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
        if (headingMatch) {
            blocks.push({ type: 'heading', level: headingMatch[1].length, content: headingMatch[2].trim() });
            i++;
            continue;
        }

        // --- 引用块 ---
        if (/^\s*>/.test(line)) {
            const quoteLines = [];
            while (i < lines.length && /^\s*>/.test(lines[i])) {
                quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
                i++;
            }
            blocks.push({ type: 'blockquote', content: quoteLines.join('\n') });
            continue;
        }

        // --- 无序列表 ---
        if (/^\s*[-*]\s/.test(line) && !/^\s*[-*]\s*\[[ x]\]/i.test(line)) {
            const items = [];
            while (i < lines.length && /^\s*[-*]\s/.test(lines[i]) && !/^\s*[-*]\s*\[[ x]\]/i.test(lines[i])) {
                items.push(lines[i].replace(/^\s*[-*]\s/, ''));
                i++;
            }
            blocks.push({ type: 'list', items, ordered: false });
            continue;
        }

        // --- 有序列表 ---
        if (/^\s*\d+\.\s/.test(line)) {
            const items = [];
            while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
                items.push(lines[i].replace(/^\s*\d+\.\s/, ''));
                i++;
            }
            blocks.push({ type: 'list', items, ordered: true });
            continue;
        }

        // --- 收集连续文本行（段落，遇到特殊行时停止） ---
        const paraLines = [];
        while (i < lines.length
            && lines[i].trim() !== ''
            && !lines[i].trimStart().startsWith('```')
            && !/^[-=]{3,}$/.test(lines[i].trim())
            && !/^#{1,6}\s/.test(lines[i])
            && !/^\s*>/.test(lines[i])
            && !/^\s*[-*]\s/.test(lines[i])
            && !/^\s*\d+\.\s/.test(lines[i])
            && !isTableLine(lines[i])
        ) {
            paraLines.push(lines[i]);
            i++;
        }
        if (paraLines.length > 0) {
            blocks.push({ type: 'text', content: paraLines.join('\n') });
        }
    }

    return blocks;
}

// ============================================================
// Diff 行解析
// ============================================================
function parseDiffLines(rawLines) {
    // 从 diff 行中提取文件名
    let fileName = null;
    let addCount = 0;
    let delCount = 0;
    const parsed = [];

    for (const raw of rawLines) {
        if (raw.startsWith('---') || raw.startsWith('+++')) {
            // 文件头
            const fMatch = raw.match(/^[+-]{3}\s+[ab]\/(.+)/);
            if (fMatch) fileName = fMatch[1];
            continue;
        }
        if (raw.startsWith('@@')) {
            // hunk header
            parsed.push({ type: 'hunk', text: raw });
            continue;
        }
        if (raw.startsWith('+')) {
            addCount++;
            parsed.push({ type: 'add', text: raw.substring(1) });
        } else if (raw.startsWith('-')) {
            delCount++;
            parsed.push({ type: 'del', text: raw.substring(1) });
        } else {
            parsed.push({ type: 'neutral', text: raw.startsWith(' ') ? raw.substring(1) : raw });
        }
    }

    return { fileName, addCount, delCount, lines: parsed };
}

// ============================================================
// 内联格式渲染
// ============================================================
export function renderInline(text) {
    if (!text) return null;
    const parts = [];
    let key = 0;
    const regex = /(\*\*(.+?)\*\*)|(`([^`]+)`)|(~~(.+?)~~)|(\[([^\]]+)\]\(([^)]+)\))|(\*([^*]+)\*)/g;
    let lastIdx = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIdx) {
            parts.push(<span key={key++}>{text.slice(lastIdx, match.index)}</span>);
        }
        if (match[1]) {
            parts.push(<strong key={key++}>{match[2]}</strong>);
        } else if (match[3]) {
            parts.push(<span key={key++} className="chat-inline-code">{match[4]}</span>);
        } else if (match[5]) {
            parts.push(<del key={key++} style={{ color: '#888' }}>{match[6]}</del>);
        } else if (match[7]) {
            parts.push(<span key={key++} style={{ color: '#4ca0e0', textDecoration: 'underline' }}>{match[8]}</span>);
        } else if (match[10]) {
            parts.push(<em key={key++}>{match[11]}</em>);
        }
        lastIdx = match.index + match[0].length;
    }
    if (lastIdx < text.length) {
        parts.push(<span key={key++}>{text.slice(lastIdx)}</span>);
    }
    return parts.length > 0 ? parts : text;
}

// ============================================================
// MessageTextBlock
// ============================================================
export const MessageTextBlock = ({ content }) => (
    <div className="chat-text-block">{renderInline(content)}</div>
);

// ============================================================
// MessageCodeBlock
// ============================================================
export const MessageCodeBlock = ({ language, code }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        navigator.clipboard?.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    return (
        <div className="chat-code-block">
            <div className="chat-code-header">
                <span className="chat-code-lang">{language || 'code'}</span>
                <button className="chat-code-copy" onClick={handleCopy}>
                    {copied ? <><Check size={9} className="inline mr-0.5" />Copied</> : <><Copy size={9} className="inline mr-0.5" />Copy</>}
                </button>
            </div>
            <div className="chat-code-body">
                <pre><code>{code}</code></pre>
            </div>
        </div>
    );
};

// ============================================================
// DiffFileCard — 文件变更卡片（增删行高亮）
// ============================================================
export const DiffFileCard = ({ rawLines }) => {
    const { fileName, addCount, delCount, lines } = parseDiffLines(rawLines);
    let lineNum = 0;

    return (
        <div className="diff-card">
            <div className="diff-card-header">
                <FileText className="diff-card-file-icon" size={14} />
                <span className="diff-card-filename">{fileName || 'file'}</span>
                <div className="diff-card-stat">
                    {addCount > 0 && <span className="diff-stat-add">+{addCount}</span>}
                    {delCount > 0 && <span className="diff-stat-del">-{delCount}</span>}
                </div>
            </div>
            <div className="diff-card-body">
                {lines.map((dl, i) => {
                    if (dl.type === 'hunk') {
                        const hunkMatch = dl.text.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
                        if (hunkMatch) lineNum = parseInt(hunkMatch[1], 10) - 1;
                        return (
                            <div key={i} className="diff-line diff-line--neutral" style={{ background: 'var(--code-header-bg)' }}>
                                <div className="diff-gutter" style={{ width: '52px' }}>···</div>
                                <div className="diff-content" style={{ color: 'var(--chat-text-dim)', fontSize: '10px' }}>{dl.text}</div>
                            </div>
                        );
                    }
                    if (dl.type !== 'del') lineNum++;
                    const lineClass = dl.type === 'add' ? 'diff-line--add' : dl.type === 'del' ? 'diff-line--del' : 'diff-line--neutral';
                    const marker = dl.type === 'add' ? '+' : dl.type === 'del' ? '-' : ' ';
                    return (
                        <div key={i} className={`diff-line ${lineClass}`}>
                            <div className="diff-gutter">{dl.type !== 'del' ? lineNum : ''}</div>
                            <div className="diff-marker">{marker}</div>
                            <div className="diff-content">{dl.text}</div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

// ============================================================
// SectionDivider
// ============================================================
export const SectionDivider = ({ label }) => (
    <div className="chat-section-divider">
        {label && <span className="chat-section-divider-label">{label}</span>}
    </div>
);

// ============================================================
// ChatMessageRenderer — 完整消息渲染器
// 输入: msg 对象 (可含 .blocks 或 .text)
// ============================================================
export default function ChatMessageRenderer({ msg, chatMode }) {
    const isAI = msg.role === 'ai';

    // 确定渲染的 blocks
    let blocks;
    if (msg.blocks) {
        // 已有结构化 blocks（来自 RichAnswerRenderer 等）
        blocks = null; // 用 RichAnswerRenderer 处理
    } else if (msg.text) {
        blocks = parseTextToBlocks(msg.text);
    } else {
        blocks = [];
    }

    return (
        <div className="chat-message chat-message-enter">
            <div className="chat-message-header">
                <div className={`chat-avatar ${isAI ? 'chat-avatar--ai' : 'chat-avatar--user'}`}>
                    {isAI ? 'AI' : 'U'}
                </div>
                <span className="chat-role-label">{isAI ? 'Cursor' : 'You'}</span>
                {isAI && chatMode === 'chat' && (
                    <span style={{
                        fontSize: '9px',
                        color: 'var(--callout-success-text)',
                        background: 'var(--callout-success-bg)',
                        border: '1px solid var(--callout-success-border)',
                        borderRadius: '3px',
                        padding: '0 4px',
                        lineHeight: '16px'
                    }}>Ask</span>
                )}
            </div>
            <div className="chat-message-body">
                {/* 已有 blocks 的消息由外层 RichAnswerRenderer 处理 */}
                {msg.blocks ? null : (
                    blocks.map((block, i) => {
                        switch (block.type) {
                            case 'text':
                                return <MessageTextBlock key={i} content={block.content} />;
                            case 'code':
                                return <MessageCodeBlock key={i} language={block.language} code={block.code} />;
                            case 'diff':
                                return <DiffFileCard key={i} rawLines={block.lines} />;
                            case 'divider':
                                return <SectionDivider key={i} />;
                            case 'heading':
                                return (
                                    <div key={i} style={{
                                        fontSize: `${Math.max(18 - (block.level - 1) * 2, 12)}px`,
                                        fontWeight: 600,
                                        color: '#e0e0e0',
                                        margin: `${block.level <= 2 ? '16px' : '10px'} 0 6px 0`,
                                        lineHeight: 1.3,
                                    }}>
                                        {renderInline(block.content)}
                                    </div>
                                );
                            case 'list': {
                                const Tag = block.ordered ? 'ol' : 'ul';
                                return (
                                    <Tag key={i} style={{
                                        margin: '6px 0',
                                        paddingLeft: '20px',
                                        listStyleType: block.ordered ? 'decimal' : 'disc',
                                        color: '#ccc',
                                        fontSize: '13px',
                                        lineHeight: '1.6',
                                    }}>
                                        {block.items.map((item, j) => (
                                            <li key={j} style={{ marginBottom: '2px' }}>{renderInline(item)}</li>
                                        ))}
                                    </Tag>
                                );
                            }
                            case 'table':
                                return (
                                    <div key={i} style={{
                                        margin: '8px 0 14px 0',
                                        overflowX: 'auto',
                                        borderRadius: '8px',
                                        border: '1px solid #2d2d3d',
                                        background: '#141418',
                                    }}>
                                        <table style={{
                                            width: '100%',
                                            borderCollapse: 'collapse',
                                            fontSize: '12.5px',
                                            lineHeight: '1.55',
                                        }}>
                                            <thead>
                                                <tr style={{ background: '#1a1a24', borderBottom: '1px solid #2d2d3d' }}>
                                                    {block.headers.map((h, hi) => (
                                                        <th key={hi} style={{
                                                            textAlign: block.aligns?.[hi] || 'left',
                                                            padding: '8px 12px',
                                                            color: '#aab',
                                                            fontWeight: 600,
                                                            fontSize: '11.5px',
                                                        }}>
                                                            {renderInline(h)}
                                                        </th>
                                                    ))}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {block.rows.map((row, ri) => (
                                                    <tr key={ri} style={{ borderTop: ri > 0 ? '1px solid #232330' : 'none' }}>
                                                        {row.map((cell, ci) => (
                                                            <td key={ci} style={{
                                                                padding: '7px 12px',
                                                                color: '#ccc',
                                                                textAlign: block.aligns?.[ci] || 'left',
                                                            }}>
                                                                {renderInline(cell)}
                                                            </td>
                                                        ))}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                );
                            case 'blockquote':
                                return (
                                    <div key={i} style={{
                                        borderLeft: '3px solid #4a4a5a',
                                        paddingLeft: '12px',
                                        margin: '6px 0',
                                        color: '#999',
                                        fontSize: '12px',
                                        lineHeight: '1.6',
                                    }}>
                                        {renderInline(block.content)}
                                    </div>
                                );
                            default:
                                return <MessageTextBlock key={i} content={block.content || ''} />;
                        }
                    })
                )}
            </div>
        </div>
    );
}
