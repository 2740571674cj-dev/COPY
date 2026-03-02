function capitalize(str) { return str.charAt(0).toUpperCase() + str.slice(1); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
module.exports = { capitalize, sleep };
