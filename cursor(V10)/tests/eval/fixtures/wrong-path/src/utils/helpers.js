const MAX_RETRIES = 3;

function doSomething() {
  for (let i = 0; i < MAX_RETRIES; i++) {
    console.log('attempt', i);
  }
}

module.exports = { MAX_RETRIES, doSomething };
