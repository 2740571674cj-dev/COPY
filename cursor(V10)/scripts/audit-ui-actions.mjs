import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const srcDir = path.join(rootDir, 'src');
const strictMode = process.argv.includes('--strict');
const targetExtensions = new Set(['.jsx', '.tsx']);

const INTERACTIVE_HANDLER_RE =
    /(onClick|onMouseDown|onMouseUp|onPointerDown|onPointerUp|onContextMenu|onDoubleClick|onKeyDown|onKeyUp|onChange|onSubmit)\s*=/;
const ROLE_BUTTON_RE = /role\s*=\s*(\{)?["']button["']/;
const HAS_HREF_RE = /\bhref\s*=/;
const HAS_TABINDEX_RE = /\btabIndex\s*=/;
const HAS_CURSOR_POINTER_RE = /cursor-pointer/;

const collectFiles = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectFiles(fullPath));
            continue;
        }
        if (targetExtensions.has(path.extname(entry.name))) {
            files.push(fullPath);
        }
    }
    return files;
};

const lineNumberAt = (text, index) => text.slice(0, index).split('\n').length;

const findIssuesInFile = (filePath) => {
    const content = fs.readFileSync(filePath, 'utf8');
    const issues = [];
    const tagRegex = /<(?!\/)([A-Za-z][A-Za-z0-9.]*)\b([\s\S]*?)>/g;
    let match;

    while ((match = tagRegex.exec(content)) !== null) {
        const fullTag = match[0];
        const tagName = match[1];
        const attrs = match[2] || '';

        if (fullTag.startsWith('<!') || fullTag.startsWith('<?')) continue;
        if (/data-ui-audit-ignore/.test(attrs)) continue;

        const isButton = tagName.toLowerCase() === 'button';
        const looksClickable =
            isButton ||
            HAS_CURSOR_POINTER_RE.test(attrs) ||
            ROLE_BUTTON_RE.test(attrs) ||
            HAS_TABINDEX_RE.test(attrs);

        if (!looksClickable) continue;

        const hasHandler = INTERACTIVE_HANDLER_RE.test(attrs);
        const hasHref = HAS_HREF_RE.test(attrs);
        const isSubmitButton = isButton && /type\s*=\s*["']submit["']/.test(attrs);

        if (hasHandler || hasHref || isSubmitButton) continue;

        issues.push({
            filePath,
            line: lineNumberAt(content, match.index),
            tagName,
            snippet: fullTag.replace(/\s+/g, ' ').trim().slice(0, 160),
        });
    }

    return issues;
};

if (!fs.existsSync(srcDir)) {
    console.error(`Cannot find src directory: ${srcDir}`);
    process.exit(1);
}

const files = collectFiles(srcDir);
const allIssues = files.flatMap(findIssuesInFile);

if (allIssues.length === 0) {
    console.log('UI action audit passed: no obvious clickable-without-handler elements found.');
    process.exit(0);
}

console.log(`UI action audit found ${allIssues.length} potential issue(s):`);
for (const issue of allIssues) {
    const relPath = path.relative(rootDir, issue.filePath);
    console.log(`- ${relPath}:${issue.line} <${issue.tagName}>`);
    console.log(`  ${issue.snippet}`);
}

console.log('\nTip: add `data-ui-audit-ignore` for intentional static elements.');

if (strictMode) {
    process.exit(1);
}
