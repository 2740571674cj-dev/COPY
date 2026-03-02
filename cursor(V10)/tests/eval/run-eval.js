/**
 * Agent 评测脚本
 *
 * 使用方法：
 *   node tests/eval/run-eval.js [--case E01] [--model <modelId>]
 *
 * 需要先确保模型配置存在。
 */

const path = require('path');
const fs = require('fs');
const { CASES } = require('./test-cases');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const RESULTS_DIR = path.join(__dirname, 'results');

async function setupFixture(fixtureName) {
  const fixtureSource = path.join(FIXTURES_DIR, fixtureName);
  if (!fs.existsSync(fixtureSource)) {
    console.warn(`[WARN] Fixture "${fixtureName}" not found, creating empty project.`);
    const tmpDir = path.join(RESULTS_DIR, `tmp_${fixtureName}_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: fixtureName, version: '1.0.0' }, null, 2));
    return tmpDir;
  }

  const tmpDir = path.join(RESULTS_DIR, `tmp_${fixtureName}_${Date.now()}`);
  copyDirSync(fixtureSource, tmpDir);
  return tmpDir;
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function cleanupFixture(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
}

async function runSingleCase(testCase, agentRunner, options = {}) {
  const startTime = Date.now();
  console.log(`\n=== [${testCase.id}] ${testCase.name} ===`);

  const projectPath = await setupFixture(testCase.fixture);
  console.log(`  Fixture: ${projectPath}`);

  let agentResult;
  try {
    agentResult = await agentRunner({
      userMessage: testCase.input,
      projectPath,
      modelId: options.modelId,
    });
  } catch (err) {
    agentResult = { success: false, error: err.message, iteration: 0, toolCallCount: 0, finalContent: '' };
  }

  const duration = Date.now() - startTime;
  console.log(`  Duration: ${duration}ms | Iterations: ${agentResult.iteration || 0} | Tools: ${agentResult.toolCallCount || 0}`);

  const scores = {};

  scores.completion = await testCase.verify(projectPath, agentResult);

  const iterRatio = (agentResult.iteration || 0) / testCase.maxExpectedIterations;
  scores.efficiency = Math.max(0, 10 - Math.floor(iterRatio * 10));

  scores.security = 10;
  if (testCase.securityCheck) {
    scores.security = (await testCase.securityCheck(projectPath)) ? 10 : 0;
  }

  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0) / Object.keys(scores).length;
  const pass = totalScore >= testCase.passThreshold;

  console.log(`  Scores: completion=${scores.completion} efficiency=${scores.efficiency} security=${scores.security}`);
  console.log(`  Total: ${totalScore.toFixed(1)} | Pass: ${pass ? '✅' : '❌'} (threshold: ${testCase.passThreshold})`);

  if (!options.keepFixtures) {
    cleanupFixture(projectPath);
  }

  return {
    id: testCase.id,
    name: testCase.name,
    category: testCase.category,
    duration,
    iteration: agentResult.iteration || 0,
    toolCallCount: agentResult.toolCallCount || 0,
    scores,
    totalScore,
    pass,
  };
}

async function runAllCases(agentRunner, options = {}) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const filterCase = options.caseId;
  const casesToRun = filterCase
    ? CASES.filter(c => c.id === filterCase)
    : CASES;

  if (casesToRun.length === 0) {
    console.error(`No test case found with id: ${filterCase}`);
    return;
  }

  console.log(`\n🚀 Running ${casesToRun.length} evaluation cases...\n`);

  const results = [];
  for (const tc of casesToRun) {
    const result = await runSingleCase(tc, agentRunner, options);
    results.push(result);
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 EVALUATION SUMMARY');
  console.log('='.repeat(60));

  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  const avgScore = results.reduce((a, r) => a + r.totalScore, 0) / total;

  console.log(`Pass rate: ${passed}/${total} (${((passed / total) * 100).toFixed(0)}%)`);
  console.log(`Average score: ${avgScore.toFixed(1)}/10`);
  console.log(`Target: ≥85% pass rate (${Math.ceil(total * 0.85)}/${total})\n`);

  const categories = {};
  for (const r of results) {
    if (!categories[r.category]) categories[r.category] = [];
    categories[r.category].push(r);
  }

  for (const [cat, items] of Object.entries(categories)) {
    const catPassed = items.filter(i => i.pass).length;
    const catAvg = items.reduce((a, i) => a + i.totalScore, 0) / items.length;
    console.log(`  ${cat}: ${catPassed}/${items.length} passed, avg ${catAvg.toFixed(1)}`);
  }

  // Save results
  const resultPath = path.join(RESULTS_DIR, `eval_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(resultPath, JSON.stringify({ timestamp: new Date().toISOString(), results, summary: { passed, total, avgScore } }, null, 2));
  console.log(`\nResults saved to: ${resultPath}`);

  return { results, summary: { passed, total, avgScore } };
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const caseIdx = args.indexOf('--case');
  const modelIdx = args.indexOf('--model');

  const options = {};
  if (caseIdx >= 0 && args[caseIdx + 1]) options.caseId = args[caseIdx + 1];
  if (modelIdx >= 0 && args[modelIdx + 1]) options.modelId = args[modelIdx + 1];

  console.log('⚠️  This script requires an agentRunner function.');
  console.log('   Use it programmatically:');
  console.log('');
  console.log('   const { runAllCases } = require("./run-eval");');
  console.log('   runAllCases(myAgentRunner, { modelId: "my-model" });');
  console.log('');
  console.log(`   Defined ${CASES.length} test cases.`);
  CASES.forEach(c => console.log(`   - [${c.id}] ${c.name} (${c.category})`));
}

module.exports = { runAllCases, runSingleCase, setupFixture, cleanupFixture };
