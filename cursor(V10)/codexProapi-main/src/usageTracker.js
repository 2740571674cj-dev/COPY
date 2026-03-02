/**
 * 按官方标准（token 计量）统计用量，持久化到 data/usage.json；账号不可用时清零该账号用量。
 * Token 估算：与 OpenAI 一致，约 4 字符 = 1 token。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.CODEX_DATA_DIR || join(__dirname, '..', 'data');
const USAGE_FILE = join(dataDir, 'usage.json');

const DEFAULT_QUOTA_TOKENS = 1_000_000;
const QUOTA = Number(process.env.USAGE_QUOTA_TOKENS) || DEFAULT_QUOTA_TOKENS;

function load() {
  if (!existsSync(USAGE_FILE)) return { byAccount: {} };
  try {
    const raw = readFileSync(USAGE_FILE, 'utf8');
    const data = JSON.parse(raw);
    return typeof data === 'object' && data !== null && Array.isArray(data.byAccount) === false
      ? { byAccount: data.byAccount || {} }
      : { byAccount: {} };
  } catch {
    return { byAccount: {} };
  }
}

function save(state) {
  try {
    const dir = dirname(USAGE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(USAGE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.error('usageTracker save failed:', e.message);
  }
}

function ensureAccount(state, accountId) {
  const id = String(accountId);
  if (!state.byAccount[id]) {
    state.byAccount[id] = { prompt_tokens: 0, completion_tokens: 0 };
  }
  return state.byAccount[id];
}

/**
 * 记录本次请求的 token 用量（与 OpenAI 标准一致：prompt_tokens + completion_tokens）
 */
export function recordUsage(accountId, { prompt_tokens = 0, completion_tokens = 0 }) {
  if (!accountId) return;
  const state = load();
  const acc = ensureAccount(state, accountId);
  acc.prompt_tokens += Number(prompt_tokens) || 0;
  acc.completion_tokens += Number(completion_tokens) || 0;
  save(state);
}

/**
 * 账号不可用时清零该账号的用量
 */
export function clearUsage(accountId) {
  if (!accountId) return;
  const state = load();
  state.byAccount[String(accountId)] = { prompt_tokens: 0, completion_tokens: 0 };
  save(state);
}

/**
 * 返回该账号已用 token 数（prompt + completion）
 */
export function getUsedTokens(accountId) {
  const state = load();
  const acc = state.byAccount[String(accountId)];
  return acc ? (acc.prompt_tokens + acc.completion_tokens) : 0;
}

/**
 * 返回该账号剩余额度百分比 0–100（基于已用 token 与配额计算）
 */
export function getRemainingPct(accountId) {
  const used = getUsedTokens(accountId);
  if (used >= QUOTA) return 0;
  return Math.min(100, Math.round(((QUOTA - used) / QUOTA) * 100));
}

export { QUOTA };
