const fs = require('fs');
const fp = 'e:/COPY/cursor(V10)/src/core/agent-loop-controller.js';
let src = fs.readFileSync(fp, 'utf8');
if (!src.includes('token-tracker')) {
    src = src.replace(
        "const { getAdapter } = require('./model-adapters');",
        "const { getAdapter } = require('./model-adapters');\nconst { tracker: tokenTracker } = require('./token-tracker');"
    );
    fs.writeFileSync(fp, src, 'utf8');
    console.log('[OK] require token-tracker 已添加');
} else {
    console.log('[SKIP] 已存在');
}
