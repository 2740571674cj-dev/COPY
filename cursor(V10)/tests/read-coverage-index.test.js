/**
 * read-coverage-index.test.js
 */
require('./_fix-console-encoding');
const assert = require('assert');
const { ReadCoverageIndex } = require('../src/core/read-coverage-index');

function test1_recordAndQuery() {
  console.log('[Test 1] record + full coverage query');
  const idx = new ReadCoverageIndex();

  idx.recordRead('src/foo.js', { mtimeMs: 1000, size: 500, totalLines: 100, startLine: 1, endLine: 50, content: 'foo' });
  assert.strictEqual(idx.hasFullyCovered('src/foo.js'), false);

  idx.recordRead('src/foo.js', { mtimeMs: 1000, size: 500, totalLines: 100, startLine: 51, endLine: 100, content: 'bar' });
  assert.strictEqual(idx.hasFullyCovered('src/foo.js'), true);
  console.log('  PASS');
}

function test2_fingerprintInvalidation() {
  console.log('[Test 2] fingerprint change invalidates cache');
  const idx = new ReadCoverageIndex();

  idx.recordRead('a.js', { mtimeMs: 1000, size: 500, totalLines: 50, startLine: 1, endLine: 50, content: 'x' });
  assert.strictEqual(idx.hasFullyCovered('a.js'), true);

  idx.recordRead('a.js', { mtimeMs: 2000, size: 510, totalLines: 52, startLine: 1, endLine: 20, content: 'y' });
  assert.strictEqual(idx.hasFullyCovered('a.js'), false);
  assert.strictEqual(idx.getCoveredLineCount('a.js'), 20);
  console.log('  PASS');
}

function test3_writeInvalidation() {
  console.log('[Test 3] invalidate after write');
  const idx = new ReadCoverageIndex();

  idx.recordRead('b.js', { mtimeMs: 1000, size: 300, totalLines: 30, startLine: 1, endLine: 30, content: 'x' });
  assert.strictEqual(idx.hasFullyCovered('b.js'), true);

  idx.invalidate('b.js');
  assert.strictEqual(idx.hasFullyCovered('b.js'), false);
  assert.strictEqual(idx.getCoveredLineCount('b.js'), 0);
  console.log('  PASS');
}

function test4_shortCircuitWithCache() {
  console.log('[Test 4] shouldShortCircuit hits cached chunk');
  const idx = new ReadCoverageIndex();

  idx.recordRead('c.js', {
    mtimeMs: 1000,
    size: 200,
    totalLines: 40,
    startLine: 1,
    endLine: 40,
    content: 'cached-content',
  });

  const r = idx.shouldShortCircuit('c.js', { mtimeMs: 1000, size: 200, requestStart: 1, requestEnd: 40 });
  assert.strictEqual(r.skip, true);
  assert.strictEqual(r.cachedContent, 'cached-content');
  console.log('  PASS');
}

function test5_shortCircuitFingerprintChanged() {
  console.log('[Test 5] shouldShortCircuit bypasses when fingerprint changed');
  const idx = new ReadCoverageIndex();

  idx.recordRead('d.js', { mtimeMs: 1000, size: 200, totalLines: 40, startLine: 1, endLine: 40, content: 'x' });

  const r = idx.shouldShortCircuit('d.js', { mtimeMs: 2000, size: 200, requestStart: 1, requestEnd: 40 });
  assert.strictEqual(r.skip, false);
  assert.strictEqual(idx.hasFullyCovered('d.js'), false);
  console.log('  PASS');
}

function test6_rangeMerge() {
  console.log('[Test 6] overlapping/adjacent ranges are merged');
  const idx = new ReadCoverageIndex();

  idx.recordRead('e.js', { mtimeMs: 100, size: 100, totalLines: 100, startLine: 1, endLine: 30, content: 'a' });
  idx.recordRead('e.js', { mtimeMs: 100, size: 100, totalLines: 100, startLine: 20, endLine: 60, content: 'b' });
  idx.recordRead('e.js', { mtimeMs: 100, size: 100, totalLines: 100, startLine: 61, endLine: 100, content: 'c' });

  assert.strictEqual(idx.hasFullyCovered('e.js'), true);
  assert.strictEqual(idx.getCoveredLineCount('e.js'), 100);
  console.log('  PASS');
}

function test7_formatSummary() {
  console.log('[Test 7] formatSummaryFor');
  const idx = new ReadCoverageIndex();

  idx.recordRead('f.js', { mtimeMs: 100, size: 100, totalLines: 50, startLine: 1, endLine: 25, content: 'a' });
  const s = idx.formatSummaryFor('f.js');
  assert.ok(s.includes('[read_coverage]'), 'should include summary prefix');
  assert.ok(s.includes('partial'), 'partial coverage should be labeled');
  console.log('  PASS');
}

function test8_pathNormalization() {
  console.log('[Test 8] path normalization');
  const idx = new ReadCoverageIndex();

  idx.recordRead('src\\foo.js', { mtimeMs: 100, size: 100, totalLines: 10, startLine: 1, endLine: 10, content: 'x' });
  assert.strictEqual(idx.hasFullyCovered('src/foo.js'), true);
  console.log('  PASS');
}

function test9_shortCircuitWithoutRequestEndUsesCoveredRange() {
  console.log('[Test 9] no requestEnd uses best covered range');
  const idx = new ReadCoverageIndex();

  idx.recordRead('g.js', { mtimeMs: 100, size: 100, totalLines: 500, startLine: 1, endLine: 200 });
  const r = idx.shouldShortCircuit('g.js', { mtimeMs: 100, size: 100, requestStart: 1 });

  assert.strictEqual(r.skip, true);
  assert.deepStrictEqual(r.range, { start: 1, end: 200 });
  assert.strictEqual(typeof r.cachedContent, 'undefined');
  console.log('  PASS');
}

const tests = [
  test1_recordAndQuery,
  test2_fingerprintInvalidation,
  test3_writeInvalidation,
  test4_shortCircuitWithCache,
  test5_shortCircuitFingerprintChanged,
  test6_rangeMerge,
  test7_formatSummary,
  test8_pathNormalization,
  test9_shortCircuitWithoutRequestEndUsesCoveredRange,
];

console.log('=== read-coverage-index.test.js ===\n');
let passed = 0;
let failed = 0;
for (const fn of tests) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${e.message}`);
  }
  console.log();
}

console.log(`=== Results: ${passed}/${passed + failed} passed ===`);
if (failed > 0) process.exit(1);
