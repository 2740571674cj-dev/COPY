// TODO: Add more utility functions

function formatDate(date, format = 'YYYY-MM-DD') {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return format.replace('YYYY', y).replace('MM', m).replace('DD', d);
}

const MAX_RETRIES = 3;

function retry(fn, retries = MAX_RETRIES) {
  // TODO: Implement retry logic
  return fn();
}

module.exports = { formatDate, retry, MAX_RETRIES };
