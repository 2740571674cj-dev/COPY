// Intentionally broken build script
const config = require('./src/config');
if (!config.API_KEY) {
  throw new Error('Missing API_KEY in config. Please set config.API_KEY before building.');
}
console.log('Build complete');
