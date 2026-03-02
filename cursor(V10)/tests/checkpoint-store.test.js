// tests/checkpoint-store.test.js
// CheckpointStore 单元测试

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Fix console encoding for Chinese characters on Windows
try { require('./_fix-console-encoding'); } catch (_) { }

const { CheckpointStore, CHECKPOINT_DIR_NAME } = require('../src/core/checkpoint-store');

let testDir;
let sessionId;
let passed = 0;
let failed = 0;

function setup() {
    testDir = path.join(os.tmpdir(), `checkpoint-test-${Date.now()}`);
    sessionId = `test-session-${Date.now()}`;
    fs.mkdirSync(testDir, { recursive: true });
    // Create a fake package.json so _guessProjectDir finds it
    fs.writeFileSync(path.join(testDir, 'package.json'), '{}', 'utf-8');
    // Clear any previous state
    CheckpointStore._snapshots.clear();
    CheckpointStore._gitignoreEnsured.clear();
}

function teardown() {
    try {
        fs.rmSync(testDir, { recursive: true, force: true });
    } catch (_) { }
}

function test(name, fn) {
    setup();
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}: ${err.message}`);
        failed++;
    } finally {
        teardown();
    }
}

console.log('\n=== CheckpointStore Tests ===\n');

// --- Test: save creates a snapshot ---
test('save() creates snapshot file', () => {
    const filePath = path.join(testDir, 'test.txt');
    fs.writeFileSync(filePath, 'Hello World', 'utf-8');

    const result = CheckpointStore.save(filePath, { toolName: 'edit_file', sessionId });
    assert.ok(result, 'save should return result');
    assert.ok(result.id, 'result should have id');
    assert.ok(fs.existsSync(result.snapshotPath), 'snapshot file should exist');

    const snapshotContent = fs.readFileSync(result.snapshotPath, 'utf-8');
    assert.strictEqual(snapshotContent, 'Hello World', 'snapshot content should match original');
});

// --- Test: restore recovers original content ---
test('restore() recovers original content after edit', () => {
    const filePath = path.join(testDir, 'restore-test.txt');
    fs.writeFileSync(filePath, 'Original Content', 'utf-8');

    CheckpointStore.save(filePath, { toolName: 'edit_file', sessionId });
    fs.writeFileSync(filePath, 'Modified Content', 'utf-8');

    const result = CheckpointStore.restore(filePath);
    assert.strictEqual(result.success, true, 'restore should succeed');

    const restored = fs.readFileSync(filePath, 'utf-8');
    assert.strictEqual(restored, 'Original Content', 'file should be restored to original');
});

// --- Test: restore with specific checkpoint_id ---
test('restore() with specific checkpoint_id', () => {
    const filePath = path.join(testDir, 'id-test.txt');
    fs.writeFileSync(filePath, 'Version 1', 'utf-8');
    const snap1 = CheckpointStore.save(filePath, { toolName: 'edit_file', sessionId });

    fs.writeFileSync(filePath, 'Version 2', 'utf-8');
    CheckpointStore.save(filePath, { toolName: 'edit_file', sessionId });

    fs.writeFileSync(filePath, 'Version 3', 'utf-8');

    const result = CheckpointStore.restore(filePath, snap1.id);
    assert.strictEqual(result.success, true);

    const content = fs.readFileSync(filePath, 'utf-8');
    assert.strictEqual(content, 'Version 1');
});

// --- Test: max snapshots limit ---
test('enforces max snapshots limit (20 for normal files)', () => {
    const filePath = path.join(testDir, 'limit-test.txt');

    for (let i = 0; i < 25; i++) {
        fs.writeFileSync(filePath, `Content ${i}`, 'utf-8');
        CheckpointStore.save(filePath, { toolName: 'edit_file', sessionId });
    }

    const snapshots = CheckpointStore.list(filePath);
    assert.ok(snapshots.length <= 20, `should have at most 20 snapshots, got ${snapshots.length}`);
});

// --- Test: skips files > 5MB ---
test('skips files larger than 5MB', () => {
    const filePath = path.join(testDir, 'huge.txt');
    const bigContent = Buffer.alloc(6 * 1024 * 1024, 'x'); // 6MB
    fs.writeFileSync(filePath, bigContent);

    const result = CheckpointStore.save(filePath, { toolName: 'edit_file', sessionId });
    assert.strictEqual(result, null, 'should return null for huge files');
});

// --- Test: large files (>1MB) limited to 2 snapshots ---
test('limits snapshots to 2 for files > 1MB', () => {
    const filePath = path.join(testDir, 'large.txt');
    const content = Buffer.alloc(1.5 * 1024 * 1024, 'y'); // 1.5MB

    for (let i = 0; i < 5; i++) {
        fs.writeFileSync(filePath, content);
        CheckpointStore.save(filePath, { toolName: 'edit_file', sessionId });
    }

    const snapshots = CheckpointStore.list(filePath);
    assert.ok(snapshots.length <= 2, `should have at most 2 snapshots for large files, got ${snapshots.length}`);
});

// --- Test: list returns snapshot metadata ---
test('list() returns correct metadata', () => {
    const filePath = path.join(testDir, 'meta-test.txt');
    fs.writeFileSync(filePath, 'Test content', 'utf-8');

    CheckpointStore.save(filePath, { toolName: 'write_file', sessionId });

    const list = CheckpointStore.list(filePath);
    assert.strictEqual(list.length, 1, 'should have 1 snapshot');
    assert.strictEqual(list[0].toolName, 'write_file');
    assert.ok(list[0].timestamp > 0);
    assert.strictEqual(list[0].exists, true);
});

// --- Test: getMetadata ---
test('getMetadata() returns aggregate info', () => {
    const filePath = path.join(testDir, 'metadata-test.txt');
    fs.writeFileSync(filePath, 'Hello', 'utf-8');

    CheckpointStore.save(filePath, { toolName: 'edit_file', sessionId });
    CheckpointStore.save(filePath, { toolName: 'write_file', sessionId });

    const meta = CheckpointStore.getMetadata(filePath);
    assert.strictEqual(meta.snapshotCount, 2);
    assert.ok(meta.oldestTimestamp <= meta.newestTimestamp);
});

// --- Test: cleanup removes session snapshots ---
test('cleanup() removes session snapshots', () => {
    const filePath = path.join(testDir, 'cleanup-test.txt');
    fs.writeFileSync(filePath, 'Data', 'utf-8');

    const snap = CheckpointStore.save(filePath, { toolName: 'edit_file', sessionId });
    assert.ok(fs.existsSync(snap.snapshotPath), 'snapshot should exist before cleanup');

    const result = CheckpointStore.cleanup(sessionId, testDir);
    assert.ok(result.cleaned >= 1, 'should clean at least 1 snapshot');
    assert.ok(!fs.existsSync(snap.snapshotPath), 'snapshot should be deleted after cleanup');
});

// --- Test: ensureGitignore ---
test('ensureGitignore() adds entry when .git exists', () => {
    // Create .git dir
    fs.mkdirSync(path.join(testDir, '.git'), { recursive: true });

    CheckpointStore.ensureGitignore(testDir);

    const gitignore = fs.readFileSync(path.join(testDir, '.gitignore'), 'utf-8');
    assert.ok(gitignore.includes('.agent-checkpoints/'), '.gitignore should contain .agent-checkpoints/');
});

test('ensureGitignore() does nothing without .git', () => {
    // No .git dir
    CheckpointStore._gitignoreEnsured.clear();
    CheckpointStore.ensureGitignore(testDir);

    assert.ok(!fs.existsSync(path.join(testDir, '.gitignore')), '.gitignore should not be created without .git');
});

test('ensureGitignore() does not duplicate entry', () => {
    fs.mkdirSync(path.join(testDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(testDir, '.gitignore'), '.agent-checkpoints/\n', 'utf-8');

    CheckpointStore.ensureGitignore(testDir);

    const content = fs.readFileSync(path.join(testDir, '.gitignore'), 'utf-8');
    const count = (content.match(/\.agent-checkpoints\//g) || []).length;
    assert.strictEqual(count, 1, 'should not duplicate .agent-checkpoints/ entry');
});

// --- Test: restore non-existent file ---
test('restore() returns error for no checkpoints', () => {
    const result = CheckpointStore.restore(path.join(testDir, 'nonexistent.txt'));
    assert.strictEqual(result.success, false);
});

// --- Test: multi-file concurrent snapshots ---
test('concurrent snapshots for different files do not interfere', () => {
    const file1 = path.join(testDir, 'a.txt');
    const file2 = path.join(testDir, 'b.txt');
    fs.writeFileSync(file1, 'File A', 'utf-8');
    fs.writeFileSync(file2, 'File B', 'utf-8');

    CheckpointStore.save(file1, { toolName: 'edit_file', sessionId });
    CheckpointStore.save(file2, { toolName: 'edit_file', sessionId });

    fs.writeFileSync(file1, 'Modified A', 'utf-8');
    fs.writeFileSync(file2, 'Modified B', 'utf-8');

    CheckpointStore.restore(file1);
    assert.strictEqual(fs.readFileSync(file1, 'utf-8'), 'File A');
    assert.strictEqual(fs.readFileSync(file2, 'utf-8'), 'Modified B'); // file2 unchanged
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
