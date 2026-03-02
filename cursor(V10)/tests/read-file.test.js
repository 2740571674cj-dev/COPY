/**
 * read-file.test.js
 * Updated for DEFAULT_MAX_LINES=2000 full-read strategy.
 */
require('./_fix-console-encoding');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const readFile = require('../src/tools/read-file');

const tmpDir = path.join(os.tmpdir(), 'read-file-test-' + Date.now());
const projectPath = tmpDir;

function setup() {
  fs.mkdirSync(tmpDir, { recursive: true });
}

function teardown() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function createTestFile(name, lines) {
  const content = lines.join('\n');
  fs.writeFileSync(path.join(tmpDir, name), content, 'utf-8');
}

async function test1_fullRead_under2000() {
  console.log('[Test 1] files under 2000 lines read fully, no truncation');
  const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
  createTestFile('short_lines.txt', lines);

  const result = await readFile.handler({ path: 'short_lines.txt' }, projectPath);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.totalLines, 500);
  assert.strictEqual(result.startLine, 1);
  assert.strictEqual(result.endLine, 500);
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.nextOffset, undefined);
  console.log('  PASS');
}

async function test2_fullRead_largeFile() {
  console.log('[Test 2] files over 2000 lines truncated with pagination info');
  const lines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`);
  createTestFile('large_file.txt', lines);

  const result = await readFile.handler({ path: 'large_file.txt' }, projectPath);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.totalLines, 2500);
  assert.strictEqual(result.startLine, 1);
  assert.strictEqual(result.endLine, 2000);
  assert.strictEqual(result.truncated, true);
  assert.strictEqual(result.nextOffset, 2001);
  assert.strictEqual(result.remainingLines, 500);
  assert.ok(result.note && result.note.includes('500'));
  console.log('  PASS');
}

async function test3_longLines_lineTruncation() {
  console.log('[Test 3] long lines are truncated at MAX_LINE_CHARS');
  const longLine = 'x'.repeat(6000);
  createTestFile('long_line.txt', [longLine, 'normal']);

  const result = await readFile.handler({ path: 'long_line.txt' }, projectPath);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.totalLines, 2);
  const firstLine = result.content.split('\n')[0];
  assert.ok(firstLine.includes('[truncated'));
  assert.strictEqual(result.truncated, true);
  console.log('  PASS');
}

async function test4_shortFile() {
  console.log('[Test 4] short file has truncated=false');
  createTestFile('short.txt', ['hello', 'world']);

  const result = await readFile.handler({ path: 'short.txt' }, projectPath);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.nextOffset, undefined);
  console.log('  PASS');
}

async function test5_offsetPagination() {
  console.log('[Test 5] offset + limit pagination');
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
  createTestFile('medium.txt', lines);

  const result = await readFile.handler({ path: 'medium.txt', offset: 101, limit: 100 }, projectPath);
  assert.strictEqual(result.startLine, 101);
  assert.strictEqual(result.endLine, 200);
  assert.strictEqual(result.truncated, true);
  assert.strictEqual(result.nextOffset, 201);
  console.log('  PASS');
}

async function test6_lineNumberFormat() {
  console.log('[Test 6] line numbers use padded format');
  createTestFile('numbered.txt', ['alpha', 'beta', 'gamma']);

  const result = await readFile.handler({ path: 'numbered.txt' }, projectPath);
  assert.strictEqual(result.success, true);
  const firstLine = result.content.split('\n')[0];
  // Format: "     1|alpha"
  assert.ok(firstLine.includes('|alpha'));
  assert.ok(firstLine.trim().startsWith('1|'));
  console.log('  PASS');
}

async function test7_emptyFile() {
  console.log('[Test 7] empty file');
  fs.writeFileSync(path.join(tmpDir, 'empty.txt'), '', 'utf-8');

  const result = await readFile.handler({ path: 'empty.txt' }, projectPath);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.truncated, false);
  console.log('  PASS');
}

async function test8_mtimeAndSize() {
  console.log('[Test 8] mtimeMs and size are returned');
  createTestFile('meta.txt', ['hello']);

  const result = await readFile.handler({ path: 'meta.txt' }, projectPath);
  assert.strictEqual(result.success, true);
  assert.strictEqual(typeof result.mtimeMs, 'number');
  assert.strictEqual(typeof result.size, 'number');
  assert.ok(result.size > 0);
  console.log('  PASS');
}

async function test9_charLimitTruncation() {
  console.log('[Test 9] character limit truncation for very long content');
  // 40 lines of 6000 chars each = 240000 chars, just under MAX_TOTAL_CHARS (250000)
  // But with line numbers it will exceed
  const lines = Array.from({ length: 50 }, (_, i) => 'x'.repeat(5500) + i);
  createTestFile('char_heavy.txt', lines);

  const result = await readFile.handler({ path: 'char_heavy.txt' }, projectPath);
  assert.strictEqual(result.success, true);
  // Lines are within 2000 limit so endLine = 50
  assert.strictEqual(result.endLine, 50);
  // But the long lines get truncated individually and total char limit may kick in
  assert.strictEqual(result.truncated, true);
  console.log('  PASS');
}

async function test10_fileNotFound() {
  console.log('[Test 10] non-existent file returns error');

  const result = await readFile.handler({ path: 'nonexistent.txt' }, projectPath);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.code, 'E_FILE_NOT_FOUND');
  console.log('  PASS');
}

(async () => {
  console.log('=== read-file.test.js ===\n');
  setup();
  let passed = 0;
  let failed = 0;

  const tests = [
    test1_fullRead_under2000,
    test2_fullRead_largeFile,
    test3_longLines_lineTruncation,
    test4_shortFile,
    test5_offsetPagination,
    test6_lineNumberFormat,
    test7_emptyFile,
    test8_mtimeAndSize,
    test9_charLimitTruncation,
    test10_fileNotFound,
  ];

  for (const fn of tests) {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      console.error(`  FAIL: ${e.message}`);
    }
    console.log();
  }

  teardown();
  console.log(`=== Results: ${passed}/${passed + failed} passed ===`);
  if (failed > 0) process.exit(1);
})();
