/**
 * edit-file.test.js — edit_file regression tests
 * Covers: E_MULTIPLE_MATCHES, CRLF preservation, basic edit, line-number stripping
 */
require('./_fix-console-encoding');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const editFile = require('../src/tools/edit-file');

const tmpDir = path.join(os.tmpdir(), 'edit-file-test-' + Date.now());

function setup() {
    fs.mkdirSync(tmpDir, { recursive: true });
}

function teardown() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

function writeFile(name, content) {
    fs.writeFileSync(path.join(tmpDir, name), content, 'utf-8');
}

function readFile(name) {
    return fs.readFileSync(path.join(tmpDir, name), 'utf-8');
}

const tests = [];
let passed = 0, failed = 0;

function test(name, fn) { tests.push({ name, fn }); }

async function runTests() {
    for (const t of tests) {
        try { await t.fn(); passed++; console.log(`  PASS ${t.name}`); }
        catch (e) { failed++; console.log(`  FAIL ${t.name}`); console.log(`    ${e.message}`); }
    }
    console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);
    process.exit(failed > 0 ? 1 : 0);
}

test('basic edit replaces content', async () => {
    writeFile('basic.txt', 'hello world\n');
    const result = await editFile.handler(
        { path: 'basic.txt', old_string: 'hello', new_string: 'goodbye' },
        tmpDir
    );
    assert.strictEqual(result.success, true);
    assert.strictEqual(readFile('basic.txt'), 'goodbye world\n');
});

test('E_MULTIPLE_MATCHES returned for duplicate content', async () => {
    writeFile('dup.txt', 'AAA\nBBB\nAAA\n');
    const result = await editFile.handler(
        { path: 'dup.txt', old_string: 'AAA', new_string: 'CCC' },
        tmpDir
    );
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'E_MULTIPLE_MATCHES');
});

test('replace_all replaces all occurrences', async () => {
    writeFile('all.txt', 'AAA\nBBB\nAAA\n');
    const result = await editFile.handler(
        { path: 'all.txt', old_string: 'AAA', new_string: 'CCC', replace_all: true },
        tmpDir
    );
    assert.strictEqual(result.success, true);
    assert.strictEqual(readFile('all.txt'), 'CCC\nBBB\nCCC\n');
});

test('CRLF file stays CRLF after edit', async () => {
    writeFile('crlf.txt', 'line1\r\nline2\r\nline3\r\n');
    const result = await editFile.handler(
        { path: 'crlf.txt', old_string: 'line2', new_string: 'modified' },
        tmpDir
    );
    assert.strictEqual(result.success, true);
    const content = readFile('crlf.txt');
    assert.ok(!content.includes('\n') || content.includes('\r\n'), 'should still use CRLF');
    // Verify no bare LF exists
    const bareLfCount = (content.match(/(?<!\r)\n/g) || []).length;
    assert.strictEqual(bareLfCount, 0, 'should have no bare LF in CRLF file');
    assert.ok(content.includes('modified'), 'edit should be applied');
    assert.strictEqual(result.eolNormalized, true);
});

test('LF file stays LF after edit', async () => {
    writeFile('lf.txt', 'line1\nline2\nline3\n');
    const result = await editFile.handler(
        { path: 'lf.txt', old_string: 'line2', new_string: 'modified' },
        tmpDir
    );
    assert.strictEqual(result.success, true);
    const content = readFile('lf.txt');
    assert.ok(!content.includes('\r'), 'should not introduce CRLF');
    assert.strictEqual(result.eolNormalized, false);
});

test('E_MATCH_NOT_FOUND for missing content', async () => {
    writeFile('missing.txt', 'hello world\n');
    const result = await editFile.handler(
        { path: 'missing.txt', old_string: 'nonexistent', new_string: 'replacement' },
        tmpDir
    );
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'E_MATCH_NOT_FOUND');
});

test('fuzzy matcher preserves E_MULTIPLE_MATCHES across strategies', async () => {
    // Content with duplicate indented lines (exact match fails, but indent-agnostic should detect)
    writeFile('fuzzy_multi.txt', '  AAA\n  BBB\n  AAA\n');
    const result = await editFile.handler(
        { path: 'fuzzy_multi.txt', old_string: 'AAA', new_string: 'CCC' },
        tmpDir
    );
    // Should get E_MULTIPLE_MATCHES, not E_MATCH_NOT_FOUND
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'E_MULTIPLE_MATCHES');
});

test('line-number stripping retries match', async () => {
    writeFile('linenum.txt', 'function hello() {\n  return 1;\n}\n');
    const result = await editFile.handler(
        { path: 'linenum.txt', old_string: '1|function hello() {', new_string: 'function goodbye() {' },
        tmpDir
    );
    assert.strictEqual(result.success, true);
    assert.ok(readFile('linenum.txt').includes('goodbye'));
});

test('E_MATCH_NOT_FOUND includes suggestReadBack', async () => {
    writeFile('nf.txt', 'hello world\n');
    const result = await editFile.handler(
        { path: 'nf.txt', old_string: 'nonexistent', new_string: 'x' },
        tmpDir
    );
    assert.strictEqual(result.suggestReadBack, true);
    assert.ok(result.hint);
});

test('E_MULTIPLE_MATCHES includes suggestMoreContext', async () => {
    writeFile('mc.txt', 'AAA\nBBB\nAAA\n');
    const result = await editFile.handler(
        { path: 'mc.txt', old_string: 'AAA', new_string: 'X' },
        tmpDir
    );
    assert.strictEqual(result.suggestMoreContext, true);
    assert.ok(result.hint);
});

test('successful edit returns diff field', async () => {
    writeFile('diff.txt', 'line1\nline2\nline3\n');
    const result = await editFile.handler(
        { path: 'diff.txt', old_string: 'line2', new_string: 'CHANGED' },
        tmpDir
    );
    assert.strictEqual(result.success, true);
    assert.ok(result.diff, 'diff field should be present');
    assert.ok(result.diff.includes('-line2'), 'diff should show removed line');
    assert.ok(result.diff.includes('+CHANGED'), 'diff should show added line');
});

test('CRLF file diff only shows changed line, not entire file', async () => {
    // Write CRLF file
    const crlfContent = 'alpha\r\nbeta\r\ngamma\r\ndelta\r\n';
    writeFile('crlf.txt', crlfContent);
    const result = await editFile.handler(
        { path: 'crlf.txt', old_string: 'beta', new_string: 'BETA_NEW' },
        tmpDir
    );
    assert.strictEqual(result.success, true);
    assert.ok(result.diff, 'diff field should be present');
    // Count removed/added lines by regex (^-X and ^+X where X is not - or +)
    const removedCount = (result.diff.match(/^-[^-]/gm) || []).length;
    const addedCount = (result.diff.match(/^\+[^+]/gm) || []).length;
    assert.strictEqual(removedCount, 1, `Expected 1 removed line, got ${removedCount}`);
    assert.strictEqual(addedCount, 1, `Expected 1 added line, got ${addedCount}`);
    // Verify actual content in diff
    assert.ok(result.diff.includes('-beta'), 'diff should show removed beta line');
    assert.ok(result.diff.includes('+BETA_NEW'), 'diff should show added BETA_NEW line');
    // Verify file content is correct CRLF
    const final = readFile('crlf.txt');
    assert.ok(final.includes('\r\n'), 'file should still have CRLF');
    assert.ok(final.includes('BETA_NEW'), 'file should contain the change');
});

console.log('edit-file.test.js\n');
setup();
runTests().finally(teardown);
