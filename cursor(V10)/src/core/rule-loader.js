const fs = require('fs');
const path = require('path');

const RULE_FILES = [
  '.cursorrules',
  '.cursor/rules',
  'AGENTS.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md',
];

const MAX_SINGLE_FILE = 5000;
const MAX_DIR_FILE = 2000;
const MAX_DIR_FILES = 5;
const MAX_TOTAL = 15000;

async function loadProjectRules(projectPath) {
  if (!projectPath) return [];
  const rules = [];

  for (const rf of RULE_FILES) {
    const fullPath = path.join(projectPath, rf);
    try {
      if (!fs.existsSync(fullPath)) continue;
      const stat = fs.statSync(fullPath);

      if (stat.isFile()) {
        const content = fs.readFileSync(fullPath, 'utf-8').substring(0, MAX_SINGLE_FILE);
        rules.push({ source: rf, content: content.trim() });
      } else if (stat.isDirectory()) {
        const files = fs.readdirSync(fullPath)
          .filter(f => f.endsWith('.md') || f.endsWith('.txt'))
          .slice(0, MAX_DIR_FILES);
        for (const f of files) {
          const filePath = path.join(fullPath, f);
          const fStat = fs.statSync(filePath);
          if (!fStat.isFile()) continue;
          const content = fs.readFileSync(filePath, 'utf-8').substring(0, MAX_DIR_FILE);
          rules.push({ source: `${rf}/${f}`, content: content.trim() });
        }
      }
    } catch (_) { /* skip unreadable */ }
  }

  return rules;
}

function formatRulesForPrompt(rules) {
  if (!rules || rules.length === 0) return '';

  const parts = ['## Project Rules\n'];
  let totalLen = 0;

  for (const rule of rules) {
    const block = `### ${rule.source}\n${rule.content}\n`;
    if (totalLen + block.length > MAX_TOTAL) break;
    parts.push(block);
    totalLen += block.length;
  }

  return parts.join('\n');
}

module.exports = { loadProjectRules, formatRulesForPrompt };
