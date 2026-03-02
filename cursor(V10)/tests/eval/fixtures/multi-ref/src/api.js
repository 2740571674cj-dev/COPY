async function getUserName(userId) {
  const res = await fetch(`/api/users/${userId}`);
  const data = await res.json();
  return data.name;
}

module.exports = { getUserName };
