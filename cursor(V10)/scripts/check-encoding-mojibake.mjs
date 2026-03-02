#!/usr/bin/env node
/**
 * Detect likely mojibake (garbled UTF-8 text) in source files.
 *
 * Usage:
 *   node scripts/check-encoding-mojibake.mjs
 *   node scripts/check-encoding-mojibake.mjs --whitelist path/a.js,path/b.md
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { extname, join, relative } from 'path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

const SCAN_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md', '.ps1',
]);

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
]);

const DEFAULT_WHITELIST = new Set([
  'scripts/check-encoding-mojibake.mjs',
]);

// Repository-observed mojibake tokens and common UTF-8/GBK corruption markers.
const MOJIBAKE_PATTERNS = [
  /宸插惎鍔/,
  /璐﹀彿/,
  /妯″紡/,
  /璇婃柇/,
  /鍥炶皟/,
  /鍋ュ悍妫/,
  /寤鸿/,
  /鏈厤缃/,
  /浠ｇ爜[^\n]{0,20}楠岃瘉鐮/,
  /鈥\?/,
  /锛\?/,
  /銆\?/,
  /[\u00c2\u00c3][\u0080-\u00bf]/, // common malformed UTF-8 fragments
];

function parseArgs() {
  const args = process.argv.slice(2);
  const whitelist = new Set(DEFAULT_WHITELIST);

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--whitelist' && args[i + 1]) {
      for (const p of args[i + 1].split(',')) {
        const trimmed = p.trim();
        if (trimmed) whitelist.add(trimmed.replace(/\\/g, '/'));
      }
      i++;
    }
  }

  return { whitelist };
}

function collectFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) {
        collectFiles(fullPath, files);
      }
      continue;
    }

    if (SCAN_EXTENSIONS.has(extname(entry).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

function scanFile(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const hits = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of MOJIBAKE_PATTERNS) {
      const m = pattern.exec(line);
      if (!m) continue;
      hits.push({
        line: i + 1,
        col: m.index + 1,
        token: m[0].slice(0, 40),
      });
      break;
    }
  }

  return hits;
}

const { whitelist } = parseArgs();
const files = collectFiles(ROOT);
const findings = [];

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (whitelist.has(rel)) continue;
  const hits = scanFile(file);
  if (hits.length > 0) findings.push({ file: rel, hits });
}

if (findings.length === 0) {
  console.log('No mojibake detected. All scanned files look clean.');
  process.exit(0);
}

let total = 0;
console.error(`Found mojibake in ${findings.length} file(s):\n`);
for (const item of findings) {
  total += item.hits.length;
  console.error(`- ${item.file}`);
  for (const h of item.hits.slice(0, 8)) {
    console.error(`  L${h.line}:${h.col}  ${h.token}`);
  }
  if (item.hits.length > 8) {
    console.error(`  ... ${item.hits.length - 8} more hit(s)`);
  }
  console.error('');
}
console.error(`Total hits: ${total}`);
process.exit(1);
