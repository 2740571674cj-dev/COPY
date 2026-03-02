const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INDEX_VERSION = 1;
const MIN_RESCAN_INTERVAL_MS = 5000;
const MAX_FILE_SIZE = 200 * 1024;
const MAX_FILES = 3000;
const MAX_DEPTH = 10;

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.cache', '__pycache__',
  '.next', '.nuxt', 'vendor', 'coverage', '.vscode', '.idea',
]);

const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java',
  '.c', '.cpp', '.h', '.cs', '.vue', '.svelte', '.php', '.swift',
  '.kt', '.scala', '.sh', '.bash', '.zsh', '.sql', '.graphql',
  '.css', '.scss', '.less', '.html', '.md', '.json', '.yaml', '.yml',
  '.toml', '.xml', '.env', '.config', '.conf',
]);

function normalizeRel(p) {
  return p.replace(/\\/g, '/');
}

function projectHash(projectRoot) {
  return crypto.createHash('sha1').update(String(projectRoot)).digest('hex').slice(0, 16);
}

function cacheDir(projectRoot) {
  const dir = path.join(projectRoot, '.agent-terminal', 'semantic-index');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function tokenize(text) {
  const out = [];
  if (!text) return out;
  const normalized = String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const lower = normalized.toLowerCase();
  const words = lower.split(/[^\w\u4e00-\u9fff]+/).filter(Boolean);
  for (const w of words) {
    if (w.length >= 2) out.push(w);
    if (/[\u4e00-\u9fff]/.test(w) && w.length >= 2) {
      for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
    }
  }
  return out;
}

function tokenFreq(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

function listCodeFiles(root, maxFiles = MAX_FILES, depth = 0) {
  if (depth > MAX_DEPTH) return [];
  const files = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return files;
  }
  for (const entry of entries) {
    if (files.length >= maxFiles) break;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(root, entry.name);
      files.push(...listCodeFiles(full, maxFiles - files.length, depth + 1));
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) continue;
    const full = path.join(root, entry.name);
    try {
      const st = fs.statSync(full);
      if (st.size <= MAX_FILE_SIZE) files.push(full);
    } catch (_) {}
  }
  return files;
}

function extractSignatureChunks(lines) {
  const chunks = [];
  const reFn = /^(export\s+)?(async\s+)?function\s+\w+/;
  const reClass = /^(export\s+)?(default\s+)?class\s+\w+/;
  const reMethod = /^\s*(static\s+)?(async\s+)?\w+\s*\([^)]*\)\s*\{/;
  const reVarFn = /^(const|let|var)\s+\w+\s*=\s*(async\s+)?(\(|function)/;
  const rePy = /^(def|class)\s+\w+/;
  const reImport = /^(import|from|require|export)\b/;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (reFn.test(t) || reClass.test(t) || reMethod.test(t) || reVarFn.test(t) || rePy.test(t) || reImport.test(t)) {
      const end = Math.min(lines.length, i + 8);
      chunks.push({
        startLine: i + 1,
        endLine: end,
        text: lines.slice(i, end).join('\n'),
        type: 'signature',
      });
    }
  }
  return chunks;
}

function extractWindowChunks(lines) {
  const chunks = [];
  const chunkSize = 60;
  const step = 45;
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + chunkSize);
    const text = lines.slice(start, end).join('\n').trim();
    if (!text) continue;
    chunks.push({
      startLine: start + 1,
      endLine: end,
      text,
      type: 'window',
    });
    if (end >= lines.length) break;
  }
  return chunks;
}

function compactLine(text, max = 140) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

class ProjectIndex {
  constructor(projectRoot) {
    this.projectRoot = path.resolve(projectRoot);
    this.indexPath = path.join(cacheDir(this.projectRoot), `${projectHash(this.projectRoot)}.json`);
    this.files = new Map(); // relPath -> { mtimeMs, size, chunkIds:number[] }
    this.chunks = new Map(); // id -> { id,file,startLine,endLine,text,type,tf:Object }
    this.postings = new Map(); // token -> Map<chunkId, tf>
    this.nextChunkId = 1;
    this.lastScanAt = 0;
    this.dirtyPaths = new Set();
    this._load();
  }

  _load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));
    } catch (_) {
      return;
    }
    if (!raw || raw.version !== INDEX_VERSION) return;
    if (path.resolve(raw.projectRoot || '') !== this.projectRoot) return;

    this.nextChunkId = Number(raw.nextChunkId || 1);
    for (const [k, v] of Object.entries(raw.files || {})) {
      this.files.set(k, {
        mtimeMs: Number(v.mtimeMs || 0),
        size: Number(v.size || 0),
        chunkIds: Array.isArray(v.chunkIds) ? v.chunkIds.map(Number) : [],
      });
    }
    const chunkList = Array.isArray(raw.chunks) ? raw.chunks : [];
    for (const c of chunkList) {
      if (!c || typeof c.id !== 'number') continue;
      this.chunks.set(c.id, {
        id: c.id,
        file: c.file,
        startLine: c.startLine,
        endLine: c.endLine,
        text: c.text || '',
        type: c.type || 'window',
        tf: c.tf || {},
      });
    }
    this._rebuildPostings();
  }

  _save() {
    const filesObj = {};
    for (const [k, v] of this.files.entries()) filesObj[k] = v;
    const chunksArr = Array.from(this.chunks.values()).map(c => ({
      id: c.id,
      file: c.file,
      startLine: c.startLine,
      endLine: c.endLine,
      text: c.text,
      type: c.type,
      tf: c.tf,
    }));
    const payload = {
      version: INDEX_VERSION,
      projectRoot: this.projectRoot,
      updatedAt: new Date().toISOString(),
      nextChunkId: this.nextChunkId,
      files: filesObj,
      chunks: chunksArr,
    };
    const tmp = this.indexPath + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
      fs.renameSync(tmp, this.indexPath);
    } catch (_) {
      try { fs.writeFileSync(this.indexPath, JSON.stringify(payload), 'utf-8'); } catch (__) {}
      try { fs.unlinkSync(tmp); } catch (__) {}
    }
  }

  _rebuildPostings() {
    this.postings.clear();
    for (const c of this.chunks.values()) {
      for (const [tok, tf] of Object.entries(c.tf || {})) {
        let m = this.postings.get(tok);
        if (!m) {
          m = new Map();
          this.postings.set(tok, m);
        }
        m.set(c.id, tf);
      }
    }
  }

  markDirty(relPath) {
    if (!relPath) return;
    this.dirtyPaths.add(normalizeRel(relPath));
  }

  _removeFile(relPath) {
    const cur = this.files.get(relPath);
    if (!cur) return;
    for (const id of cur.chunkIds || []) {
      const chunk = this.chunks.get(id);
      if (!chunk) continue;
      for (const tok of Object.keys(chunk.tf || {})) {
        const m = this.postings.get(tok);
        if (!m) continue;
        m.delete(id);
        if (m.size === 0) this.postings.delete(tok);
      }
      this.chunks.delete(id);
    }
    this.files.delete(relPath);
  }

  _indexFile(relPath, fullPath, st) {
    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch (_) {
      this._removeFile(relPath);
      return;
    }
    this._removeFile(relPath);
    const lines = content.split('\n');
    const chunks = [
      ...extractSignatureChunks(lines),
      ...extractWindowChunks(lines),
    ];
    const chunkIds = [];
    for (const ch of chunks) {
      const text = ch.text.slice(0, 2400);
      const tfMap = tokenFreq(tokenize(text));
      if (tfMap.size === 0) continue;
      const tfObj = {};
      for (const [k, v] of tfMap.entries()) tfObj[k] = v;
      const id = this.nextChunkId++;
      const entry = {
        id,
        file: relPath,
        startLine: ch.startLine,
        endLine: ch.endLine,
        text,
        type: ch.type,
        tf: tfObj,
      };
      this.chunks.set(id, entry);
      chunkIds.push(id);
      for (const [tok, tf] of Object.entries(tfObj)) {
        let m = this.postings.get(tok);
        if (!m) {
          m = new Map();
          this.postings.set(tok, m);
        }
        m.set(id, tf);
      }
    }
    this.files.set(relPath, {
      mtimeMs: Number(st.mtimeMs || 0),
      size: Number(st.size || 0),
      chunkIds,
    });
  }

  ensureFresh() {
    const now = Date.now();
    if (now - this.lastScanAt < MIN_RESCAN_INTERVAL_MS && this.dirtyPaths.size === 0) return { rescanned: false, updated: 0 };

    const absFiles = listCodeFiles(this.projectRoot, MAX_FILES);
    const seen = new Set();
    let updated = 0;

    for (const full of absFiles) {
      const rel = normalizeRel(path.relative(this.projectRoot, full));
      seen.add(rel);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      const meta = this.files.get(rel);
      const dirty = this.dirtyPaths.has(rel);
      const changed = !meta || meta.mtimeMs !== Number(st.mtimeMs || 0) || meta.size !== Number(st.size || 0);
      if (dirty || changed) {
        this._indexFile(rel, full, st);
        updated++;
      }
    }

    const toDelete = [];
    for (const rel of this.files.keys()) {
      if (!seen.has(rel)) toDelete.push(rel);
    }
    for (const rel of toDelete) {
      this._removeFile(rel);
      updated++;
    }

    this.lastScanAt = now;
    this.dirtyPaths.clear();
    if (updated > 0) this._save();
    return { rescanned: true, updated };
  }

  search(query, opts = {}) {
    const q = String(query || '').trim();
    if (q.length < 2) return { results: [], stats: { totalChunks: this.chunks.size, candidates: 0 } };

    this.ensureFresh();

    const queryTokens = tokenize(q);
    const qTf = tokenFreq(queryTokens);
    const totalChunks = Math.max(1, this.chunks.size);
    const qTerms = Array.from(qTf.keys());
    if (qTerms.length === 0) return { results: [], stats: { totalChunks, candidates: 0 } };

    const candidate = new Map(); // chunkId -> score
    for (const term of qTerms) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const df = posting.size;
      const idf = Math.log((totalChunks + 1) / (df + 1)) + 1;
      for (const [chunkId, tf] of posting.entries()) {
        const prev = candidate.get(chunkId) || 0;
        candidate.set(chunkId, prev + (1 + Math.log(1 + tf)) * idf);
      }
    }

    const prefix = opts.pathPrefix ? normalizeRel(opts.pathPrefix).replace(/\/+$/, '') : '';
    const chunks = [];
    for (const [chunkId, baseScore] of candidate.entries()) {
      const ch = this.chunks.get(chunkId);
      if (!ch) continue;
      if (prefix && !(ch.file === prefix || ch.file.startsWith(prefix + '/'))) continue;

      let score = baseScore;
      const lowerFile = ch.file.toLowerCase();
      for (const term of qTerms) {
        if (lowerFile.includes(term)) score += 2.5;
      }
      if (ch.type === 'signature') score += 1.5;
      chunks.push({ chunk: ch, score });
    }

    chunks.sort((a, b) => b.score - a.score);
    const top = chunks.slice(0, opts.maxChunks || 60);

    const byFile = new Map();
    for (const item of top) {
      const ch = item.chunk;
      const row = byFile.get(ch.file) || { file: ch.file, score: 0, lines: [] };
      row.score = Math.max(row.score, item.score);
      row.lines.push({
        line: ch.startLine,
        content: compactLine(ch.text.split('\n')[0] || ch.text),
      });
      byFile.set(ch.file, row);
    }

    const results = Array.from(byFile.values())
      .map(r => ({ ...r, lines: r.lines.slice(0, 12) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.maxResults || 10);

    return {
      results,
      stats: {
        totalChunks,
        candidates: candidate.size,
        scannedFiles: this.files.size,
      },
    };
  }
}

class SemanticIndexService {
  constructor() {
    this._projects = new Map(); // projectRoot -> ProjectIndex
  }

  _get(projectRoot) {
    const root = path.resolve(projectRoot);
    let idx = this._projects.get(root);
    if (!idx) {
      idx = new ProjectIndex(root);
      this._projects.set(root, idx);
    }
    return idx;
  }

  markDirty(projectRoot, relPath) {
    try {
      this._get(projectRoot).markDirty(relPath);
    } catch (_) {}
  }

  search(projectRoot, query, opts = {}) {
    return this._get(projectRoot).search(query, opts);
  }
}

let singleton = null;
function getSemanticIndexService() {
  if (!singleton) singleton = new SemanticIndexService();
  return singleton;
}

module.exports = {
  getSemanticIndexService,
};
