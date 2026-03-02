const { getUserName } = require('../api');

function Profile({ userId }) {
  const name = getUserName(userId);
  return <div>{name}</div>;
}

module.exports = { Profile };
