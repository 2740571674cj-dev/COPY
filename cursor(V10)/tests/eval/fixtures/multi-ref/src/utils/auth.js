const { getUserName } = require('../api');

async function isAuthorized(userId) {
  const name = await getUserName(userId);
  return name !== 'anonymous';
}

module.exports = { isAuthorized };
