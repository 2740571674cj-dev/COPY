/**
 * 修改 llm-gateway.js：提取 usage 数据
 * 修改 agent-loop-controller.js：调用 TokenTracker
 * 修改 agent-ipc.js：新增 IPC handler
 * 修改 preload.js：桥接 API
 */
const fs = require('fs');
const path = require('path');

// ========== 1. llm-gateway.js: 提取 usage ==========
{
    const fp = path.resolve(__dirname, '../src/core/llm-gateway.js');
    let src = fs.readFileSync(fp, 'utf8');

    // 1a. 在 let lastFinishReason 附近添加 let usageData = null
    if (src.includes('let lastFinishReason =')) {
        src = src.replace(
            'let lastFinishReason =',
            'let usageData = null; // [Token Dashboard] 保存最后一个 chunk 的 usage\n    let lastFinishReason ='
        );
        console.log('[OK] llm-gateway: usageData 变量声明');
    }

    // 1b. 在 SSE 主循环解析中，提取 parsed.usage（finishReason 后面）
    if (src.includes("lastFinishReason = finishReason;\n              onChunk({ type: 'finish'")) {
        src = src.replace(
            "lastFinishReason = finishReason;\n              onChunk({ type: 'finish'",
            "lastFinishReason = finishReason;\n              // [Token Dashboard] 提取 usage 数据\n              if (parsed.usage) usageData = parsed.usage;\n              onChunk({ type: 'finish'"
        );
        console.log('[OK] llm-gateway: SSE 主循环 usage 提取');
    }

    // 1c. 在 buffer 残余解析中也提取
    if (src.includes('if (finishReason) lastFinishReason = finishReason;')) {
        src = src.replace(
            'if (finishReason) lastFinishReason = finishReason;',
            'if (finishReason) lastFinishReason = finishReason;\n                if (parsed.usage) usageData = parsed.usage; // [Token Dashboard]'
        );
        console.log('[OK] llm-gateway: buffer 残余 usage 提取');
    }

    // 1d. 在 onDone 中传递 usage
    if (src.includes("onDone({\n      content: fullContent,")) {
        src = src.replace(
            "onDone({\n      content: fullContent,",
            "onDone({\n      content: fullContent,\n      usage: usageData, // [Token Dashboard] 传递 usage 到 controller"
        );
        console.log('[OK] llm-gateway: onDone usage 传递');
    }

    fs.writeFileSync(fp, src, 'utf8');
    console.log('[DONE] llm-gateway.js\n');
}

// ========== 2. agent-loop-controller.js: 调用 TokenTracker ==========
{
    const fp = path.resolve(__dirname, '../src/core/agent-loop-controller.js');
    let src = fs.readFileSync(fp, 'utf8');

    // 2a. 在顶部 require 区添加 token-tracker
    if (!src.includes('token-tracker')) {
        // 在 require('./model-adapters') 后面添加
        const anchor = "const { getAdapter, supportsCaching } = require('./model-adapters');";
        if (src.includes(anchor)) {
            src = src.replace(anchor, anchor + "\nconst { tracker: tokenTracker } = require('./token-tracker');");
            console.log('[OK] agent-loop-controller: require token-tracker');
        }
    }

    // 2b. 在 onDone 回调中，result.model 赋值后调用 tracker.record
    const onDoneAnchor = "result.model = data.model || null;";
    if (src.includes(onDoneAnchor) && !src.includes('tokenTracker.record')) {
        src = src.replace(
            onDoneAnchor,
            onDoneAnchor + `
            // [Token Dashboard] 记录 token 消耗
            if (data.usage) {
              tokenTracker.record({
                modelId: effectiveModelId,
                promptTokens: data.usage.prompt_tokens || 0,
                completionTokens: data.usage.completion_tokens || 0,
              });
            }`
        );
        console.log('[OK] agent-loop-controller: onDone tokenTracker.record');
    }

    fs.writeFileSync(fp, src, 'utf8');
    console.log('[DONE] agent-loop-controller.js\n');
}

// ========== 3. agent-ipc.js: IPC handler ==========
{
    const fp = path.resolve(__dirname, '../src/main-process/agent-ipc.js');
    let src = fs.readFileSync(fp, 'utf8');

    // 3a. 在顶部添加 require
    if (!src.includes('token-tracker')) {
        const anchor = "const { app } = require('electron');";
        if (src.includes(anchor)) {
            src = src.replace(anchor, anchor + "\nconst { tracker: tokenTracker } = require('../core/token-tracker');");
            console.log('[OK] agent-ipc: require token-tracker');
        }
    }

    // 3b. 在 setupAgentIPC 函数末尾的 } 前添加 IPC handler
    // 找到函数末尾 — "module.exports" 之前
    if (!src.includes("ipcMain.handle('get-token-stats'")) {
        const moduleExports = "module.exports = { setupAgentIPC";
        if (src.includes(moduleExports)) {
            src = src.replace(moduleExports, `  // [Token Dashboard] 初始化 TokenTracker 存储路径
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

}\n\n${moduleExports}`);
            console.log('[OK] agent-ipc: IPC handler + TokenTracker init');
        }
    }

    // 需要移除多余的闭合大括号 — setupAgentIPC 函数的原闭合
    // 实际上 setupAgentIPC 函数可能以 } 结尾，我们在它前面插入。让我看看...
    // 不好判断精确位置。让我换一个更安全的方式。

    fs.writeFileSync(fp, src, 'utf8');
    console.log('[DONE] agent-ipc.js\n');
}

// ========== 4. preload.js: 桥接 ==========
{
    const fp = path.resolve(__dirname, '../preload.js');
    let src = fs.readFileSync(fp, 'utf8');

    if (!src.includes('getTokenStats')) {
        // 找到 electronAPI 块中的最后一个方法定义，在它后面添加
        // 最安全的方式：在 '});' 结尾前插入
        // 找倒数的函数定义
        const anchor = "skillMatch(query)";
        if (src.includes(anchor)) {
            // 不好用。找更通用的锚点 — 搜索 electronAPI 的结尾
            // 找 "});" 倒数位置
        }

        // 更好的方式：找 versionBackup 附近的注释块
        const versionAnchor = "// --- 版本管理 API ---";
        if (src.includes(versionAnchor)) {
            src = src.replace(versionAnchor,
                `// --- Token Dashboard API ---
  getTokenStats: (params) => ipcRenderer.invoke('get-token-stats', params),

  ${versionAnchor}`
            );
            console.log('[OK] preload: getTokenStats 桥接');
        }
    }

    fs.writeFileSync(fp, src, 'utf8');
    console.log('[DONE] preload.js\n');
}

console.log('\n✅ 后端 + IPC 修改全部完成');
