let connected = false;
async function connect() { connected = true; return { connected }; }
async function query(sql) { if (!connected) throw new Error('Not connected'); return []; }
module.exports = { connect, query };
