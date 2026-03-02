/**
 * Tracks read_file coverage by file fingerprint (mtime + size) and line ranges.
 */
class ReadCoverageIndex {
  constructor() {
    /** @type {Map<string, { mtimeMs: number, size: number, totalLines: number, coveredRanges: Array<{start:number, end:number}>, chunks: Array<{start:number, end:number, content:string}> }>} */
    this.index = new Map();
  }

  _normPath(p) {
    return (p || '').replace(/\\/g, '/').replace(/^([A-Z]):/, (_, d) => `${d.toLowerCase()}:`);
  }

  _mergeRanges(ranges) {
    if (ranges.length <= 1) return ranges;

    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    const merged = [{ ...sorted[0] }];

    for (let i = 1; i < sorted.length; i++) {
      const last = merged[merged.length - 1];
      const current = sorted[i];
      if (current.start <= last.end + 1) {
        last.end = Math.max(last.end, current.end);
      } else {
        merged.push({ ...current });
      }
    }

    return merged;
  }

  /**
   * @param {string} filePath
   * @param {{ mtimeMs: number, size: number, totalLines: number, startLine: number, endLine: number, content?: string }} info
   */
  recordRead(filePath, { mtimeMs, size, totalLines, startLine, endLine, content }) {
    const key = this._normPath(filePath);
    if (!key) return;

    const existing = this.index.get(key);
    if (existing && this._isFingerprintChanged(existing, { mtimeMs, size })) {
      this.index.delete(key);
    }

    const entry = this.index.get(key) || {
      mtimeMs,
      size,
      totalLines,
      coveredRanges: [],
      chunks: [],
    };

    entry.mtimeMs = mtimeMs;
    entry.size = size;
    entry.totalLines = totalLines;
    entry.coveredRanges.push({ start: startLine, end: endLine });
    entry.coveredRanges = this._mergeRanges(entry.coveredRanges);

    if (typeof content === 'string' && content.length > 0) {
      const chunk = { start: startLine, end: endLine, content };
      const idx = entry.chunks.findIndex((c) => c.start === startLine && c.end === endLine);
      if (idx >= 0) entry.chunks[idx] = chunk;
      else entry.chunks.push(chunk);

      if (entry.chunks.length > 50) {
        entry.chunks = entry.chunks.slice(entry.chunks.length - 50);
      }
    }

    this.index.set(key, entry);
  }

  _isFingerprintChanged(entry, { mtimeMs, size }) {
    return entry.mtimeMs !== mtimeMs || entry.size !== size;
  }

  isStale(filePath, { mtimeMs, size }) {
    const key = this._normPath(filePath);
    const entry = this.index.get(key);
    if (!entry) return false;
    return this._isFingerprintChanged(entry, { mtimeMs, size });
  }

  invalidate(filePath) {
    this.index.delete(this._normPath(filePath));
  }

  hasFullyCovered(filePath) {
    const key = this._normPath(filePath);
    const entry = this.index.get(key);
    if (!entry || entry.coveredRanges.length === 0) return false;

    const merged = this._mergeRanges(entry.coveredRanges);
    return merged.length === 1 && merged[0].start <= 1 && merged[0].end >= entry.totalLines;
  }

  getCoveredLineCount(filePath) {
    const key = this._normPath(filePath);
    const entry = this.index.get(key);
    if (!entry) return 0;
    return entry.coveredRanges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
  }

  _pickChunk(entry, start, end) {
    if (typeof end === 'number') {
      return entry.chunks.find((c) => c.start <= start && c.end >= end) || null;
    }

    const candidates = entry.chunks.filter((c) => c.start <= start && c.end >= start);
    if (candidates.length === 0) return null;

    return candidates.sort((a, b) => b.end - a.end)[0];
  }

  _pickCoveredRange(entry, start, end) {
    const merged = this._mergeRanges(entry.coveredRanges);

    if (typeof end === 'number') {
      return merged.find((r) => r.start <= start && r.end >= end) || null;
    }

    const candidates = merged.filter((r) => r.start <= start && r.end >= start);
    if (candidates.length === 0) return null;

    return candidates.sort((a, b) => b.end - a.end)[0];
  }

  /**
   * @returns {{ skip: boolean, message?: string, cachedContent?: string, totalLines?: number, range?: { start:number, end:number } }}
   */
  shouldShortCircuit(filePath, { mtimeMs, size, requestStart, requestEnd }) {
    const key = this._normPath(filePath);
    const entry = this.index.get(key);
    if (!entry) return { skip: false };

    if (this._isFingerprintChanged(entry, { mtimeMs, size })) {
      this.index.delete(key);
      return { skip: false };
    }

    const start = Number.isFinite(requestStart) ? Math.max(1, requestStart) : 1;
    const end = Number.isFinite(requestEnd) ? Math.max(start, requestEnd) : undefined;

    const chunk = this._pickChunk(entry, start, end);
    if (chunk) {
      const rangeEnd = typeof end === 'number' ? end : chunk.end;
      return {
        skip: true,
        range: { start, end: rangeEnd },
        totalLines: entry.totalLines,
        cachedContent: chunk.content,
        message: `Already read ${filePath} L${start}-${rangeEnd} in this session (${entry.totalLines} lines total).`,
      };
    }

    const covered = this._pickCoveredRange(entry, start, end);
    if (covered) {
      const rangeEnd = typeof end === 'number' ? end : covered.end;
      return {
        skip: true,
        range: { start, end: rangeEnd },
        totalLines: entry.totalLines,
        message: `Already read ${filePath} L${start}-${rangeEnd} in this session. Use force_refresh=true to re-read.`,
      };
    }

    return { skip: false };
  }

  formatSummaryFor(filePath) {
    const key = this._normPath(filePath);
    const entry = this.index.get(key);
    if (!entry) return '';

    const ranges = entry.coveredRanges.map((r) => `L${r.start}-${r.end}`).join(', ');
    const coverage = this.hasFullyCovered(filePath) ? 'full' : `partial (${ranges})`;
    return `[read_coverage] ${filePath}: ${coverage}, ${entry.totalLines} lines`;
  }

  getReadFiles() {
    return [...this.index.keys()];
  }

  clear() {
    this.index.clear();
  }
}

module.exports = { ReadCoverageIndex };
