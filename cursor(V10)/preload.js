const { contextBridge, ipcRenderer } = require('electron');

// 安全地将主进程功能暴露给网页（渲染进程）
// 网页中可以通过 window.electronAPI.xxx() 来调用这些功能
contextBridge.exposeInMainWorld('electronAPI', {
    // 打开系统文件夹选择对话框，返回 { name, path } 或 null
    openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),

    // 读取指定路径下的文件/文件夹列表
    readDir: (dirPath) => ipcRenderer.invoke('fs:readDir', dirPath),

    // 递归读取整个项目文件树
    readFileTree: (rootPath) => ipcRenderer.invoke('fs:readFileTree', rootPath),

    // 读取单个文件内容
    readFileContent: (filePath) => ipcRenderer.invoke('fs:readFileContent', filePath),

    // 用 Cursor 编辑器打开指定文件夹
    openInCursor: (folderPath) => ipcRenderer.invoke('shell:openInCursor', folderPath),

    // 在文件管理器中显示文件夹
    showInExplorer: (folderPath) => ipcRenderer.invoke('shell:showInExplorer', folderPath),

    // 获取持久化的最近项目列表
    getRecentProjects: () => ipcRenderer.invoke('store:getRecent'),

    // 保存最近项目列表
    saveRecentProjects: (list) => ipcRenderer.invoke('store:saveRecent', list),

    // 窗口控制
    windowMinimize: () => ipcRenderer.send('window:minimize'),
    windowToggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
    windowClose: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),

    // --- 文件操作 API（右键菜单功能） ---
    createFile: (filePath) => ipcRenderer.invoke('fs:createFile', filePath),
    createFolder: (folderPath) => ipcRenderer.invoke('fs:createFolder', folderPath),
    rename: (oldPath, newPath) => ipcRenderer.invoke('fs:rename', oldPath, newPath),
    deleteItem: (targetPath) => ipcRenderer.invoke('fs:delete', targetPath),
    openTerminal: (dirPath) => ipcRenderer.invoke('shell:openTerminal', dirPath),
    writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', filePath, content),

    // --- Agent 模式：在项目目录执行命令并返回输出 ---
    agentRunCommand: (params) => ipcRenderer.invoke('agent:runCommand', params),

    // --- 模型管理 API ---
    modelList: () => ipcRenderer.invoke('model:list'),
    modelCreate: (data) => ipcRenderer.invoke('model:create', data),
    modelUpdate: (id, updates) => ipcRenderer.invoke('model:update', id, updates),
    modelDelete: (id) => ipcRenderer.invoke('model:delete', id),
    modelParse: (raw, type) => ipcRenderer.invoke('model:parse', raw, type),
    modelDuplicate: (id) => ipcRenderer.invoke('model:duplicate', id),
    codexProxyStatus: () => ipcRenderer.invoke('codexProxy:status'),
    codexProxyStart: (opts) => ipcRenderer.invoke('codexProxy:start', opts),
    codexProxyOpen: (opts) => ipcRenderer.invoke('codexProxy:open', opts),
    codexProxyStop: () => ipcRenderer.invoke('codexProxy:stop'),
    codexProxyImportModels: (opts) => ipcRenderer.invoke('codexProxy:importModels', opts),
    codexProxyAddAccountManual: (body) => ipcRenderer.invoke('codexProxy:addAccountManual', body),
    codexProxyGetAuthDebug: () => ipcRenderer.invoke('codexProxy:getAuthDebug'),

    // --- SKILL 技能管理 API ---
    skillList: () => ipcRenderer.invoke('skill:list'),
    skillCreate: (data) => ipcRenderer.invoke('skill:create', data),
    skillUpdate: (id, updates) => ipcRenderer.invoke('skill:update', id, updates),
    skillDelete: (id) => ipcRenderer.invoke('skill:delete', id),
    skillExport: (id) => ipcRenderer.invoke('skill:export', id),
    skillImport: (conflictStrategy) => ipcRenderer.invoke('skill:import', conflictStrategy),
    skillGenerate: (params) => ipcRenderer.invoke('skill:generate', params),
    skillOptimize: (params) => ipcRenderer.invoke('skill:optimize', params),
    skillConvert: (params) => ipcRenderer.invoke('skill:convert', params),
    skillMatch: (query) => ipcRenderer.invoke('skill:match', query),

    // --- Token Dashboard API ---
    getTokenStats: (params) => ipcRenderer.invoke('get-token-stats', params),

    // --- Agent Monitor API ---
    monitorToggle: (enabled) => ipcRenderer.invoke('monitor:toggle', enabled),
    monitorStatus: () => ipcRenderer.invoke('monitor:status'),

    // --- 版本管理 API ---
    versionBackup: (opts) => ipcRenderer.invoke('version:backup', opts),
    versionList: () => ipcRenderer.invoke('version:list'),
    versionRollback: (id) => ipcRenderer.invoke('version:rollback', id),
    versionDelete: (id) => ipcRenderer.invoke('version:delete', id),

    // --- 自我迭代建议 API ---
    suggestionList: (status) => ipcRenderer.invoke('suggestion:list', status),
    suggestionApprove: (id) => ipcRenderer.invoke('suggestion:approve', id),
    suggestionReject: (id) => ipcRenderer.invoke('suggestion:reject', id),
    suggestionApply: (id) => ipcRenderer.invoke('suggestion:apply', id),
    suggestionPreview: (id) => ipcRenderer.invoke('suggestion:preview', id),
    suggestionCancel: (id) => ipcRenderer.invoke('suggestion:cancel', id),
    suggestionAuditLog: (count) => ipcRenderer.invoke('suggestion:audit-log', count),

    // --- Gemini 逆向代理 API ---
    geminiProxyStatus: () => ipcRenderer.invoke('geminiProxy:status'),
    geminiProxyStart: (opts) => ipcRenderer.invoke('geminiProxy:start', opts),
    geminiProxyStop: () => ipcRenderer.invoke('geminiProxy:stop'),
    geminiProxyOpenAdmin: (opts) => ipcRenderer.invoke('geminiProxy:openAdmin', opts),
    geminiProxyImportModels: (opts) => ipcRenderer.invoke('geminiProxy:importModels', opts),

    // --- 会话管理 API ---
    chatList: (opts) => ipcRenderer.invoke('chat:list', opts),
    chatGet: (id) => ipcRenderer.invoke('chat:get', id),
    chatCreate: (data) => ipcRenderer.invoke('chat:create', data),
    chatUpdate: (id, updates) => ipcRenderer.invoke('chat:update', id, updates),
    chatDelete: (id) => ipcRenderer.invoke('chat:delete', id),
    chatExport: (id, format) => ipcRenderer.invoke('chat:export', id, format),

    // --- LLM 统一网关 ---
    llmChat: (params) => ipcRenderer.invoke('llm:chat', params),

    // --- LLM 流式网关 ---
    llmStream: (params) => ipcRenderer.send('llm:stream', params),
    llmStreamAbort: (requestId) => ipcRenderer.send('llm:stream-abort', { requestId }),
    onStreamChunk: (callback) => {
        const handler = (_e, data) => callback(data);
        ipcRenderer.on('llm:stream-chunk', handler);
        return handler;
    },
    onStreamDone: (callback) => {
        const handler = (_e, data) => callback(data);
        ipcRenderer.on('llm:stream-done', handler);
        return handler;
    },
    onStreamError: (callback) => {
        const handler = (_e, data) => callback(data);
        ipcRenderer.on('llm:stream-error', handler);
        return handler;
    },
    removeStreamListener: (channel, handler) => {
        ipcRenderer.removeListener(channel, handler);
    },
    removeAllStreamListeners: () => {
        ipcRenderer.removeAllListeners('llm:stream-chunk');
        ipcRenderer.removeAllListeners('llm:stream-done');
        ipcRenderer.removeAllListeners('llm:stream-error');
    },

    // --- 模式配置 ---
    modeConfigGet: () => ipcRenderer.invoke('modeConfig:get'),
    modeConfigSave: (config) => ipcRenderer.invoke('modeConfig:save', config),

    // --- 会话记忆 ---
    memorySummary: (sessionId) => ipcRenderer.invoke('memory:getSummary', sessionId),
    memoryPromptContext: (sessionId) => ipcRenderer.invoke('memory:getPromptContext', sessionId),
    memoryDelete: (sessionId) => ipcRenderer.invoke('memory:deleteSession', sessionId),

    // --- 对话标题生成 ---
    chatGenerateTitle: (params) => ipcRenderer.invoke('chat:generateTitle', params),

    // --- 工作流管理 ---
    workflowList: () => ipcRenderer.invoke('workflow:list'),
    workflowGet: (id) => ipcRenderer.invoke('workflow:get', id),
    workflowCreate: (data) => ipcRenderer.invoke('workflow:create', data),
    workflowUpdate: (id, updates) => ipcRenderer.invoke('workflow:update', id, updates),
    workflowDelete: (id) => ipcRenderer.invoke('workflow:delete', id),
    workflowUpdateActiveVersion: (wfId, data) => ipcRenderer.invoke('workflow:updateActiveVersion', wfId, data),
    workflowSaveVersion: (wfId, data) => ipcRenderer.invoke('workflow:saveVersion', wfId, data),
    workflowDeleteVersion: (wfId, verId) => ipcRenderer.invoke('workflow:deleteVersion', wfId, verId),
    workflowMatch: (taskDesc) => ipcRenderer.invoke('workflow:match', taskDesc),

    // --- 文件系统监听（实时同步） ---
    fsWatchStart: (projectPath) => ipcRenderer.invoke('fs:watchStart', projectPath),
    fsWatchStop: (projectPath) => ipcRenderer.invoke('fs:watchStop', projectPath),
    onFsChanged: (callback) => {
        const handler = (_e, data) => callback(data);
        ipcRenderer.on('fs:changed', handler);
        return handler;
    },
    removeFsChangedListener: () => {
        ipcRenderer.removeAllListeners('fs:changed');
    },

    // --- Linter 集成 ---
    linterRun: (projectPath, targetFiles, options) => ipcRenderer.invoke('linter:run', projectPath, targetFiles, options),
    linterDetect: (projectPath) => ipcRenderer.invoke('linter:detect', projectPath),

    // --- 项目只读检索 API（Ask 模式） ---
    projectSearch: (projectPath, query) => ipcRenderer.invoke('project:search', projectPath, query),
    projectReadSnippet: (filePath, startLine, endLine) => ipcRenderer.invoke('project:readSnippet', filePath, startLine, endLine),
    projectListFiles: (projectPath) => ipcRenderer.invoke('project:listFiles', projectPath),
    projectStatPath: (projectPath, targetPath) => ipcRenderer.invoke('project:statPath', projectPath, targetPath),

    // --- Agent Loop 系统 ---
    agentStart: (params) => ipcRenderer.invoke('agent:start', params),
    agentCancel: (sessionId) => ipcRenderer.invoke('agent:cancel', sessionId),
    agentApprove: (data) => ipcRenderer.send('agent:approve', data),
    agentQuestionResponse: (data) => ipcRenderer.send('agent:question-response', data),

    onAgentEvent: (eventName, callback) => {
        const handler = (_e, data) => callback(data);
        ipcRenderer.on(`agent:${eventName}`, handler);
        return handler;
    },
    removeAgentListener: (eventName, handler) => {
        ipcRenderer.removeListener(`agent:${eventName}`, handler);
    },
    removeAllAgentListeners: () => {
        const events = [
            'state-change', 'started', 'complete', 'incomplete', 'error', 'cancelled',
            'stream-content', 'stream-reasoning', 'tool-calls-received',
            'tool-call-delta', 'tool-executing', 'tool-result',
            'tools-executed', 'approval-needed', 'max-iterations',
            'todo-update', 'progress-note', 'gate-failed',
            'workflow-matched', 'workflow-step-update',
            'ask-question', 'mode-switch-request', 'mode-switched', 'mode-switch-declined', 'mode-switch-failed', 'agent-metrics',
            'skills-matched', 'skill-injected', 'skill-used',
        ];
        for (const evt of events) {
            ipcRenderer.removeAllListeners(`agent:${evt}`);
        }
    },
});
