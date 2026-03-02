const fs = require('fs');
const fp = 'e:/COPY/cursor(V10)/src/main-process/agent-ipc.js';
let src = fs.readFileSync(fp, 'utf8');

// 问题：TokenTracker 初始化和 IPC handler 放在了 setupAgentIPC 函数外面
// 解决：移到函数内部（在 } 闭合前）

// 1. 删除函数外部的代码块
const outsideCode = `}

  // [Token Dashboard] 初始化 TokenTracker 存储路径
  const tokenStorePath = require('path').join(app.getPath('userData'), 'token-usage.jsonl');
  tokenTracker.setStorePath(tokenStorePath);

  // [Token Dashboard] IPC: 查询 token 消耗统计
  ipcMain.handle('get-token-stats', async (_event, params = {}) => {
    try {
      const result = tokenTracker.query({
        startTime: params.startTime,
        endTime: params.endTime,
      });
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

}`;

const insideCode = `
  // [Token Dashboard] 初始化 TokenTracker 存储路径
  const tokenStorePath = require('path').join(app.getPath('userData'), 'token-usage.jsonl');
  tokenTracker.setStorePath(tokenStorePath);

  // [Token Dashboard] IPC: 查询 token 消耗统计
  ipcMain.handle('get-token-stats', async (_event, params = {}) => {
    try {
      const result = tokenTracker.query({
        startTime: params.startTime,
        endTime: params.endTime,
      });
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}`;

if (src.includes(outsideCode)) {
    src = src.replace(outsideCode, insideCode);
    fs.writeFileSync(fp, src, 'utf8');
    console.log('[OK] Token Dashboard \u4ee3\u7801\u5df2\u79fb\u5165 setupAgentIPC \u51fd\u6570\u5185\u90e8');
} else {
    console.log('[SKIP] \u672a\u627e\u5230\u76ee\u6807\u4ee3\u7801\u5757\uff0c\u53ef\u80fd\u5df2\u4fee\u590d');
}
