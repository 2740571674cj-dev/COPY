const { ipcMain } = require('electron');
const { AgentLoopController } = require('../core/agent-loop-controller');
const { LLMGateway } = require('../core/llm-gateway');
const { createToolExecutor } = require('../tools/index');
const { PromptAssembler } = require('../prompts/prompt-assembler');
const { ContextEngine } = require('../core/context-engine');
const { AgentLoopFactory } = require('../core/agent-loop-factory');
const { TodoStore } = require('../core/todo-store');
const { WorkflowStore } = require('../core/workflow-store');
const { SessionMemoryStore } = require('../core/session-memory-store');
const { SuggestionStore } = require('../core/suggestion-store');
const { generateRuleBasedSuggestions } = require('../core/self-improve-pipeline');
const path = require('path');
const { app } = require('electron');
const { tracker: tokenTracker } = require('../core/token-tracker');
const { getRuntimeMonitor } = require('../core/runtime-monitor');
const { spawn } = require('child_process');
const http = require('http');

let activeAgents = new Map();
let monitorProcess = null;
let monitorEnabled = false; // IDE 设置：是否自启动监测器

// 检查监测服务器是否就绪
function checkMonitorReady(port = 19528, timeout = 8000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(`http://localhost:${port}/ready`, (res) => {
        let body = '';
        res.on('data', (d) => body += d);
        res.on('end', () => {
          try { resolve(JSON.parse(body).ready === true); } catch (_) { resolve(false); }
        });
      });
      req.on('error', () => {
        if (Date.now() - start < timeout) {
          setTimeout(check, 500);
        } else {
          resolve(false);
        }
      });
      req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    };
    check();
  });
}

// 启动监测程序（Electron 桌面应用）
function launchMonitor() {
  if (monitorProcess) return; // 已在运行
  const monitorDir = path.join(__dirname, '..', '..', 'monitor-app');
  const exePath = path.join(monitorDir, 'dist', 'agent-monitor.exe');
  const mainPath = path.join(monitorDir, 'main.js');
  const electronPath = path.join(monitorDir, 'node_modules', '.bin', 'electron.cmd');
  const fs = require('fs');

  try {
    if (fs.existsSync(exePath)) {
      // 优先用打包好的 EXE
      monitorProcess = spawn(exePath, [], { detached: true, stdio: 'ignore', windowsHide: false });
    } else if (fs.existsSync(mainPath) && fs.existsSync(electronPath)) {
      // 用本地 Electron 运行
      monitorProcess = spawn(electronPath, ['.'], { cwd: monitorDir, detached: true, stdio: 'ignore', windowsHide: false });
    } else if (fs.existsSync(mainPath)) {
      // 尝试全局 electron
      monitorProcess = spawn('npx', ['electron', '.'], { cwd: monitorDir, detached: true, stdio: 'ignore', shell: true, windowsHide: false });
    } else {
      console.warn('[AgentIPC] Monitor app not found at:', monitorDir);
      return;
    }
    monitorProcess.unref();
    monitorProcess.on('exit', () => { monitorProcess = null; });
    console.log('[AgentIPC] Monitor app launched, pid:', monitorProcess.pid);
  } catch (e) {
    console.error('[AgentIPC] Failed to launch monitor:', e.message);
    monitorProcess = null;
  }
}

// 停止监测服务器
function stopMonitor() {
  if (monitorProcess) {
    try { monitorProcess.kill(); } catch (_) { }
    monitorProcess = null;
  }
}


// 会话级 TodoStore Map：同 session 复用，跨 session 新建
const TODO_STORE_MAX = 20;
const sessionTodoStores = new Map(); // Map<sessionId, { store, lastUsed }>

function getOrCreateTodoStore(sessionId, mainWindow) {
  if (sessionTodoStores.has(sessionId)) {
    const entry = sessionTodoStores.get(sessionId);
    entry.lastUsed = Date.now();
    return entry.store;
  }

  // LRU 淘汰
  if (sessionTodoStores.size >= TODO_STORE_MAX) {
    let oldest = null;
    let oldestKey = null;
    for (const [key, entry] of sessionTodoStores) {
      if (!oldest || entry.lastUsed < oldest.lastUsed) {
        oldest = entry;
        oldestKey = key;
      }
    }
    if (oldestKey) sessionTodoStores.delete(oldestKey);
  }

  const store = new TodoStore();
  store.subscribe((todos) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:todo-update', { sessionId, todos });
    }
  });
  sessionTodoStores.set(sessionId, { store, lastUsed: Date.now() });
  return store;
}

function disposeSessionStore(sessionId) {
  sessionTodoStores.delete(sessionId);
}

function setupAgentIPC({ loadModels, mainWindow, skillMatcher, loadSkillsForMatcher }) {
  const llmGateway = new LLMGateway({ loadModels });
  const toolExecutor = createToolExecutor();
  const promptAssembler = new PromptAssembler();
  const contextEngine = new ContextEngine();
  const wfStorePath = path.join(app.getPath('userData'), 'workflows.json');
  const workflowStore = new WorkflowStore(wfStorePath);
  const memoryBaseDir = path.join(app.getPath('userData'), 'session-memory');
  const sessionMemoryStore = new SessionMemoryStore(memoryBaseDir);
  const suggestionStore = new SuggestionStore(app.getPath('userData'));

  const agentLoopFactory = new AgentLoopFactory({
    llmGateway,
    toolExecutor,
    promptAssembler,
    contextEngine,
  });

  ipcMain.handle('agent:start', async (_event, params) => {
    const { sessionId, chatSessionId, modelId, userMessage, projectPath, mode, openFiles, autoApprove, webSearchEnabled, evalPassScore, compressThreshold, autoAgent, origin } = params;
    const execOrigin = origin || 'user';

    if (activeAgents.has(sessionId)) {
      const oldAgent = activeAgents.get(sessionId);
      oldAgent.cancel();
      try { oldAgent.destroy(); } catch (_) { }
      activeAgents.delete(sessionId);
    }

    // 同 session 复用 store（支持"继续执行"），跨 session 新建
    const todoStore = getOrCreateTodoStore(sessionId, mainWindow);
    // 仅在没有未完成项时 reset（继续执行场景保留 pending 项）
    const progress = todoStore.getProgress();
    if (progress.pending === 0 && progress.inProgress === 0) {
      todoStore.reset();
    }

    // 加载会话记忆并注入到 userMessage 中
    let enrichedMessage = userMessage;
    const memorySessionId = chatSessionId || sessionId;
    try {
      let memoryContext = sessionMemoryStore.formatForPrompt(memorySessionId);
      if (memoryContext) {
        const MAX_MEMORY_CHARS = 8000;
        if (memoryContext.length > MAX_MEMORY_CHARS) {
          memoryContext = memoryContext.substring(0, MAX_MEMORY_CHARS) + '\n...(memory truncated)';
        }
        enrichedMessage = `${memoryContext}\n\n---\n\n${userMessage}`;
      }
    } catch (e) {
      console.error('[AgentIPC] Load session memory failed:', e.message);
    }

    // --- SKILL 自动匹配 ---
    let matchedSkills = [];
    let skillCatalog = [];
    if (skillMatcher) {
      try {
        const matchResult = await skillMatcher(userMessage);
        if (matchResult?.success) {
          if (matchResult.data?.length > 0) matchedSkills = matchResult.data;
          if (matchResult.catalog?.length > 0) skillCatalog = matchResult.catalog;
        }
      } catch (e) {
        console.error('[AgentIPC] Skill match failed:', e.message);
      }
    }

    const agent = new AgentLoopController({
      llmGateway,
      toolExecutor,
      promptAssembler,
      contextEngine,
      config: {
        maxIterations: 60,
        agentLoopFactory,
        todoStore,
        matchedSkills, // 将匹配到的 SKILL 传给控制器
        skillCatalog,  // 全局技能目录（始终注入）
        allSkills: typeof loadSkillsForMatcher === 'function' ? loadSkillsForMatcher() : [], // 完整 skills 数据（含 detail），供动态注入用
        evalPassScore: typeof evalPassScore === 'number' ? evalPassScore : 75,
        compressThreshold: typeof compressThreshold === 'number' ? compressThreshold : 60,
        workflowMatcher: async (userMsg) => {
          const wf = workflowStore.matchWorkflow(userMsg);
          if (!wf) return null;
          const steps = workflowStore.getActiveSteps(wf.id);
          return { id: wf.id, name: wf.name, description: wf.description, steps };
        },
      },
    });

    agent.setEmitter((event, data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(`agent:${event}`, data);
      }
    });

    activeAgents.set(sessionId, agent);

    // 接入运行监测器
    const monitor = getRuntimeMonitor();
    monitor.init(sessionId, projectPath, modelId);
    monitor.attach(agent);

    // 自动启动外部监测程序（如果已启用）
    if (monitorEnabled) {
      launchMonitor();
      const ready = await checkMonitorReady();
      if (ready) {
        console.log('[AgentIPC] Monitor server is ready');
        // 打开仪表板
        try { require('electron').shell.openExternal('http://localhost:19528'); } catch (_) { }
      } else {
        console.warn('[AgentIPC] Monitor server not ready, continuing without it');
      }
    }

    try {
      const result = await agent.start({
        sessionId, modelId, userMessage: enrichedMessage, projectPath,
        mode: mode || 'agent',
        openFiles: openFiles || [],
        autoApprove: autoApprove || false,
        webSearchEnabled: webSearchEnabled || false,
        evalPassScore: typeof evalPassScore === 'number' ? evalPassScore : 75,
        compressThreshold: typeof compressThreshold === 'number' ? compressThreshold : 60,
        autoAgent: autoAgent || false,
      });

      // Agent 完成后，更新会话记忆
      let completedTasks = [];
      try {
        const todos = todoStore.get();
        completedTasks = todos.filter(t => t.status === 'completed').map(t => t.content);
        const pendingIssues = todos.filter(t => t.status !== 'completed' && t.status !== 'cancelled').map(t => t.content);

        // 从 agent 消息中提取文件变更
        const fileChanges = new Set();
        for (const msg of (agent.messages || [])) {
          if (msg.role === 'assistant' && msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              if (['write_file', 'edit_file', 'create_file', 'delete_file'].includes(tc.function?.name)) {
                try {
                  const args = JSON.parse(tc.function.arguments);
                  if (args.path || args.file_path) fileChanges.add(args.path || args.file_path);
                } catch (_) { }
              }
            }
          }
        }

        // 提取关键发现
        const keyFindings = [];
        for (const msg of (agent.messages || [])) {
          if (msg.role === 'assistant' && msg.content && !msg.tool_calls && msg.content.length > 30) {
            keyFindings.push(msg.content.substring(0, 200));
            if (keyFindings.length >= 3) break;
          }
        }

        const rawRequest = (userMessage || '').replace(/\[会话记忆\][\s\S]*---\s*\n\n/, '').substring(0, 500);

        // Collect files that were read during this execution for memory
        const readFiles = [];
        for (const msg of (agent.messages || [])) {
          if (msg.role === 'assistant' && msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              if (tc.function?.name === 'read_file') {
                try {
                  const a = JSON.parse(tc.function.arguments);
                  if (a.path) readFiles.push(a.path);
                } catch (_) { }
              }
            }
          }
        }

        sessionMemoryStore.appendExecution(memorySessionId, {
          userRequest: rawRequest,
          completedTasks,
          fileChanges: [...fileChanges],
          keyFindings,
          pendingIssues,
        });

        if (readFiles.length > 0) {
          sessionMemoryStore.appendReadFiles(memorySessionId, readFiles);
        }
      } catch (e) {
        console.error('[AgentIPC] Update session memory failed:', e.message);
      }

      // --- IDE 自我迭代：成功路径 + 非自迭代源 → 生成改进建议 ---
      if (result?.success === true && agent.iteration > 0 && execOrigin !== 'self-improve') {
        try {
          const metrics = agent._metrics || {};
          const hasMeaningfulData = agent.toolCallCount > 0 || completedTasks.length > 0;
          if (hasMeaningfulData) {
            const existingSuggestions = suggestionStore.list();
            const suggestions = generateRuleBasedSuggestions({
              metrics,
              iterations: agent.iteration,
              toolCallCount: agent.toolCallCount,
            }, existingSuggestions);
            if (suggestions.length > 0) {
              const batchResult = await suggestionStore.addBatch(suggestions);
              if (batchResult?._queueError) {
                console.error('[SelfImprove] addBatch failed:', batchResult.message);
              } else {
                console.log(`[SelfImprove] Generated ${suggestions.length} suggestion(s)`);
              }
            }
          }
        } catch (e) {
          console.error('[SelfImprove] Suggestion generation failed:', e.message);
        }
      }

      return result;
    } finally {
      activeAgents.delete(sessionId);
      try { agent.destroy(); } catch (_) { }
    }
  });

  ipcMain.handle('agent:cancel', async (_event, sessionId) => {
    const agent = activeAgents.get(sessionId);
    if (agent) {
      agent.cancel();
      activeAgents.delete(sessionId);
      try { agent.destroy(); } catch (_) { }
      return { success: true };
    }
    return { success: false, error: 'No active agent for this session' };
  });

  ipcMain.on('agent:approve', (_event, { sessionId, toolCallId, approved }) => {
    const agent = activeAgents.get(sessionId);
    if (agent) {
      agent.handleApproval(toolCallId, approved);
    }
  });

  ipcMain.on('agent:question-response', (_event, { sessionId, toolCallId, answers }) => {
    const agent = activeAgents.get(sessionId);
    if (agent) {
      agent.handleQuestionResponse(toolCallId, answers);
    }
  });

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

  // [Agent Monitor] IPC: 开关监测器
  ipcMain.handle('monitor:toggle', async (_event, enabled) => {
    monitorEnabled = !!enabled;
    if (monitorEnabled) {
      launchMonitor();
      const ready = await checkMonitorReady();
      return { success: true, enabled: true, ready };
    } else {
      stopMonitor();
      return { success: true, enabled: false };
    }
  });

  ipcMain.handle('monitor:status', async () => {
    const ready = monitorProcess ? await checkMonitorReady(19528, 2000) : false;
    return { enabled: monitorEnabled, running: !!monitorProcess, ready, pid: monitorProcess?.pid || null };
  });
}

module.exports = { setupAgentIPC, disposeSessionStore };
