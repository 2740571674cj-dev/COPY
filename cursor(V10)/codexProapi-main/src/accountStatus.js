/**
 * 记录因 401/403 被判为不可用的账号，模型页将显示其额度为 0%
 */
const unavailableIds = new Set();

export function markAccountUnavailable(accountId) {
  if (accountId) unavailableIds.add(String(accountId));
}

export function isAccountUnavailable(accountId) {
  return accountId ? unavailableIds.has(String(accountId)) : false;
}
