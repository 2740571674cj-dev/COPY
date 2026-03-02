const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// Agent IPC initialization flag
let agentIPCInitialized = false;

// --- ?---
const STORE_PATH = path.join(app.getPath('userData'), 'recent-projects.json');

function loadRecentProjects() {
    try {
        if (fs.existsSync(STORE_PATH)) {
            return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
        }
    } catch (e) {
        console.error('Failed to load recent projects:', e);
    }
    return [];
}

function saveRecentProjects(list) {
    try {
        fs.writeFileSync(STORE_PATH, JSON.stringify(list, null, 2), 'utf-8');
    } catch (e) {
        console.error('Failed to save recent projects:', e);
    }
}

// --- ?---
const MODELS_PATH = path.join(app.getPath('userData'), 'models.json');
const CODEX_PROXY_DIR = path.join(__dirname, 'codexProapi-main');
const CODEX_PROXY_ENTRY = path.join(CODEX_PROXY_DIR, 'src', 'index.js');

let codexProxyProcess = null;
let codexProxyExpectedExit = false;
let codexProxyState = {
    status: 'stopped', // stopped | starting | running | stopping | failed
    pid: null,
    port: 1455,
    lastError: '',
    startedAt: null,
    logs: [],
};

// --- Gemini ?---
const GEMINI_PROXY_DIR = path.join(__dirname, 'gemininixiang-main');
const GEMINI_PROXY_ENTRY = path.join(GEMINI_PROXY_DIR, 'server.py');

let geminiProxyProcess = null;
let geminiProxyExpectedExit = false;
let geminiProxyState = {
    status: 'stopped',
    pid: null,
    port: 8000,
    lastError: '',
    startedAt: null,
    logs: [],
};

function loadModels() {
    try {
        if (fs.existsSync(MODELS_PATH)) {
            const raw = fs.readFileSync(MODELS_PATH, 'utf-8');
            const normalized = String(raw || '').replace(/^\uFEFF/, '').trim();
            if (!normalized) return [];
            const models = JSON.parse(normalized);
            return models.map(m => ({
                ...m,
                apiKey: (m.apiKey || '').replace(/^\$\{(.+)\}$/, '$1').trim(),
            }));
        }
    } catch (e) {
        console.error('[Models] Failed to load:', e);
    }
    return [];
}

function saveModels(list) {
    try {
        fs.writeFileSync(MODELS_PATH, JSON.stringify(list, null, 2), 'utf-8');
    } catch (e) {
        console.error('[Models] Failed to save:', e);
    }
}

function buildApiUrl(baseUrl) {
    const trimmed = (baseUrl || '').trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
    if (/\/v1$/i.test(trimmed)) return trimmed + '/chat/completions';
    return trimmed + '/v1/chat/completions';
}

function appendCodexProxyLog(line) {
    if (!line) return;
    codexProxyState.logs.push({
        ts: new Date().toISOString(),
        line: String(line).trim(),
    });
    if (codexProxyState.logs.length > 200) {
        codexProxyState.logs.splice(0, codexProxyState.logs.length - 200);
    }
}

function updateGeminiProxyState(patch) {
    geminiProxyState = { ...geminiProxyState, ...patch };
}

function appendGeminiProxyLog(line) {
    if (!line) return;
    geminiProxyState.logs.push({
        ts: new Date().toISOString(),
        line: String(line).trim(),
    });
    if (geminiProxyState.logs.length > 200) {
        geminiProxyState.logs.splice(0, geminiProxyState.logs.length - 200);
    }
}

function getGeminiProxyConfig() {
    const cfg = loadModeConfig();
    const rawPort = Number(cfg?.geminiProxy?.port);
    return {
        port: Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 8000,
        apiKey: cfg?.geminiProxy?.apiKey || 'sk-geminixxxxx',
        adminUsername: cfg?.geminiProxy?.adminUsername || 'admin',
        adminPassword: cfg?.geminiProxy?.adminPassword || 'admin123',
    };
}

// --- cURL / Python ?---
function parseCurl(raw) {
    const result = { baseUrl: '', apiKey: '', modelName: '', headers: {}, extraBody: {} };
    try {
        // ?URL
        const urlMatch = raw.match(/curl\s+(?:--[^\s]+\s+)*['"]?(https?:\/\/[^\s'"]+)['"]?/i)
            || raw.match(/(https?:\/\/[^\s'"\\]+)/);
        if (urlMatch) result.baseUrl = urlMatch[1].replace(/\/chat\/completions\/?$/, '').replace(/\/v1\/?$/, '').replace(/\/$/, '');

        // ?-H headers
        const headerRegex = /-H\s+['"]([^'"]+)['"]/gi;
        let hm;
        while ((hm = headerRegex.exec(raw)) !== null) {
            const colonIdx = hm[1].indexOf(':');
            if (colonIdx > 0) {
                const key = hm[1].substring(0, colonIdx).trim();
                const val = hm[1].substring(colonIdx + 1).trim();
                if (key.toLowerCase() === 'authorization') {
                    result.apiKey = val.replace(/^Bearer\s+/i, '');
                } else if (key.toLowerCase() !== 'content-type') {
                    result.headers[key] = val;
                }
            }
        }

        // ?-d / --data body
        const bodyMatch = raw.match(/-d\s+['"]({[\s\S]*?})['"]/i)
            || raw.match(/--data(?:-raw)?\s+['"]({[\s\S]*?})['"]/i)
            || raw.match(/--data(?:-raw)?\s+\$'({[\s\S]*?})'/i);
        if (bodyMatch) {
            try {
                const body = JSON.parse(bodyMatch[1].replace(/\\n/g, '').replace(/\\'/g, "'"));
                if (body.model) result.modelName = body.model;
                const { model, messages, stream, ...rest } = body;
                if (Object.keys(rest).length > 0) result.extraBody = rest;
            } catch (_) { /* body parse fail, ok */ }
        }
    } catch (e) {
        console.error('[Models] cURL parse error:', e);
    }
    return result;
}

function parsePython(raw) {
    const result = { baseUrl: '', apiKey: '', modelName: '', headers: {}, extraBody: {} };
    try {
        // api_key= (handle os.environ.get('key'), os.getenv('key'), and plain string)
        const keyMatch = raw.match(/api_key\s*=\s*(?:os\.(?:environ\.get|getenv)\s*\(\s*)?['"]([^'"]+)['"]/);
        if (keyMatch) result.apiKey = keyMatch[1].replace(/^\$\{(.+)\}$/, '$1').trim();

        // base_url=
        const urlMatch = raw.match(/base_url\s*=\s*['"]([^'"]+)['"]/);
        if (urlMatch) result.baseUrl = urlMatch[1].replace(/\/v1\/?$/, '').replace(/\/$/, '');

        // model=
        const modelMatch = raw.match(/model\s*=\s*['"]([^'"]+)['"]/);
        if (modelMatch) result.modelName = modelMatch[1];

        // headers dict
        const headersMatch = raw.match(/headers\s*=\s*({[^}]+})/);
        if (headersMatch) {
            try { result.headers = JSON.parse(headersMatch[1].replace(/'/g, '"')); } catch (_) { }
        }
    } catch (e) {
        console.error('[Models] Python parse error:', e);
    }
    return result;
}

function generateId() {
    return 'mdl_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
}

function normalizeBaseUrl(url) {
    return String(url || '')
        .trim()
        .replace(/\/+$/, '')
        .replace(/\/v1$/, '');
}

function parseCodexModelsFromSource() {
    try {
        const src = fs.readFileSync(CODEX_PROXY_ENTRY, 'utf-8');
        const found = new Set();
        const re = /id:\s*'([^']+)'/g;
        let m;
        while ((m = re.exec(src)) !== null) {
            if (m[1]) found.add(m[1]);
        }
        return Array.from(found);
    } catch (e) {
        return [];
    }
}

function getCodexProxyConfig() {
    const cfg = loadModeConfig();
    const rawPort = Number(cfg?.codexProxy?.port);
    return {
        port: Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 1455,
        apiKey: cfg?.codexProxy?.apiKey || '',
    };
}

function isPortAvailable(port) {
    return new Promise((resolve) => {
        const tester = net.createServer();
        tester.once('error', () => resolve(false));
        tester.once('listening', () => {
            tester.close(() => resolve(true));
        });
        tester.listen(port, '0.0.0.0');
    });
}

async function findAvailablePort(startPort, maxAttempts = 20) {
    const base = Number(startPort) > 0 ? Number(startPort) : 1455;
    for (let i = 0; i < maxAttempts; i++) {
        const candidate = base + i;
        if (await isPortAvailable(candidate)) return candidate;
    }
    return null;
}

function updateCodexProxyState(patch) {
    codexProxyState = { ...codexProxyState, ...patch };
}

async function ensureCodexProxyDependencies() {
    const expressPath = path.join(CODEX_PROXY_DIR, 'node_modules', 'express');
    if (fs.existsSync(expressPath)) return { success: true };
    if (!fs.existsSync(path.join(CODEX_PROXY_DIR, 'package.json'))) {
        return { success: false, error: `codexProapi project not found: ${CODEX_PROXY_DIR}` };
    }
    try {
        await execAsync('npm install --no-audit --no-fund', {
            cwd: CODEX_PROXY_DIR,
            timeout: 5 * 60 * 1000,
        });
        return { success: true };
    } catch (e) {
        return { success: false, error: `Dependency install failed: ${e.message}` };
    }
}

async function waitForCodexProxyHealth(port, timeoutMs = 15000) {
    const start = Date.now();
    const url = `http://127.0.0.1:${port}/health`;
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(url, { method: 'GET' });
            if (res.ok) {
                const data = await res.json().catch(() => ({}));
                if (data?.service === 'codex-proapi' || data?.status === 'ok') return true;
            }
        } catch (_) { }
        await new Promise(r => setTimeout(r, 500));
    }
    return false;
}

async function startCodexProxyService({ port, apiKey, _retryCount } = {}) {
    const retryCount = Number(_retryCount) || 0;
    if (codexProxyProcess && !codexProxyProcess.killed) {
        updateCodexProxyState({ status: 'running' });
        return { success: true, data: codexProxyState };
    }
    if (!fs.existsSync(CODEX_PROXY_ENTRY)) {
        updateCodexProxyState({ status: 'failed', lastError: `Entry file not found: ${CODEX_PROXY_ENTRY}` });
        return { success: false, error: codexProxyState.lastError };
    }

    const cfg = getCodexProxyConfig();
    const requestedPort = Number(port) > 0 ? Number(port) : cfg.port;
    const existingHealthy = await waitForCodexProxyHealth(requestedPort, 1200);
    if (existingHealthy) {
        updateCodexProxyState({ status: 'running', port: requestedPort, pid: null, lastError: '' });
        appendCodexProxyLog(`[OK] Existing codexProapi detected on port ${requestedPort}`);
        return { success: true, data: codexProxyState };
    }

    const targetPort = await findAvailablePort(requestedPort, 200);
    if (!targetPort) {
        const err = `No available port found from ${requestedPort} to ${requestedPort + 199}`;
        updateCodexProxyState({ status: 'failed', lastError: err });
        appendCodexProxyLog(`[ERROR] ${err}`);
        return { success: false, error: err };
    }
    const targetApiKey = typeof apiKey === 'string' ? apiKey : cfg.apiKey;

    updateCodexProxyState({ status: 'starting', port: targetPort, lastError: '' });
    appendCodexProxyLog(`[START] Starting codexProapi on port ${targetPort}`);
    appendCodexProxyLog(`[INFO] Requested port=${requestedPort}, selected port=${targetPort}`);
    if (retryCount > 0) {
        appendCodexProxyLog(`[INFO] Retry attempt ${retryCount}`);
    }
    if (targetPort !== requestedPort) {
        appendCodexProxyLog(`[WARN] Port ${requestedPort} is busy, switched to ${targetPort}`);
    }

    const dep = await ensureCodexProxyDependencies();
    if (!dep.success) {
        updateCodexProxyState({ status: 'failed', lastError: dep.error });
        appendCodexProxyLog(`[ERROR] ${dep.error}`);
        return { success: false, error: dep.error };
    }

    const modeCfg = loadModeConfig();
    modeCfg.codexProxy = { ...(modeCfg.codexProxy || {}), port: targetPort, apiKey: targetApiKey || '' };
    saveModeConfig(modeCfg);

    codexProxyExpectedExit = false;
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npmCmd, ['start'], {
        cwd: CODEX_PROXY_DIR,
        env: {
            ...process.env,
            PORT: String(targetPort),
        },
        windowsHide: true,
    });
    codexProxyProcess = child;
    updateCodexProxyState({ pid: child.pid || null, startedAt: new Date().toISOString() });

    let sawAddrInUse = false;
    const codexStdoutDecoder = new TextDecoder('utf-8');
    const codexStderrDecoder = new TextDecoder('utf-8');
    child.stdout.on('data', (buf) => appendCodexProxyLog(codexStdoutDecoder.decode(buf, { stream: true })));
    child.stderr.on('data', (buf) => {
        const line = codexStderrDecoder.decode(buf, { stream: true });
        if (line.includes('EADDRINUSE')) sawAddrInUse = true;
        appendCodexProxyLog(line);
    });
    child.on('exit', (code, signal) => {
        codexProxyProcess = null;
        const normalStop = codexProxyExpectedExit;
        codexProxyExpectedExit = false;
        if (!normalStop && codexProxyState.status !== 'stopping') {
            const err = `Service exited, code=${code ?? 'null'}, signal=${signal ?? 'null'}`;
            updateCodexProxyState({ status: 'failed', pid: null, lastError: err });
            appendCodexProxyLog(`[EXIT] ${err}`);
        } else {
            updateCodexProxyState({ status: 'stopped', pid: null });
            appendCodexProxyLog('[STOP] Service stopped');
        }
    });

    const healthy = await waitForCodexProxyHealth(targetPort, 15000);
    if (!healthy) {
        codexProxyExpectedExit = true;
        try { child.kill(); } catch (_) { }
        codexProxyProcess = null;
        if (sawAddrInUse && retryCount < 5) {
            appendCodexProxyLog(`[WARN] EADDRINUSE detected on ${targetPort}, retrying with next port`);
            return await startCodexProxyService({
                port: targetPort + 1,
                apiKey: targetApiKey,
                _retryCount: retryCount + 1,
            });
        }
        const err = 'Service startup timed out: /health not ready in 15s';
        updateCodexProxyState({ status: 'failed', pid: null, lastError: err });
        appendCodexProxyLog(`[ERROR] ${err}`);
        return { success: false, error: err };
    }

    updateCodexProxyState({ status: 'running', lastError: '' });
    appendCodexProxyLog('[OK] codexProapi started');
    return { success: true, data: codexProxyState };
}

async function stopCodexProxyService() {
    if (!codexProxyProcess || codexProxyProcess.killed) {
        updateCodexProxyState({ status: 'stopped', pid: null });
        return { success: true, data: codexProxyState };
    }
    updateCodexProxyState({ status: 'stopping' });
    codexProxyExpectedExit = true;

    const pid = codexProxyProcess.pid;
    try {
        if (process.platform === 'win32' && pid) {
            await execAsync(`taskkill /PID ${pid} /T /F`, { windowsHide: true });
        } else {
            codexProxyProcess.kill('SIGTERM');
        }
    } catch (_) {
        try { codexProxyProcess.kill(); } catch (_) { }
    }

    codexProxyProcess = null;
    updateCodexProxyState({ status: 'stopped', pid: null, lastError: '' });
    appendCodexProxyLog('[STOP] Stop requested for codexProapi');
    return { success: true, data: codexProxyState };
}

function getCodexProxyHomeUrl(port) {
    const cfg = getCodexProxyConfig();
    const targetPort = Number(port) > 0 ? Number(port) : (codexProxyState.port || cfg.port);
    return `http://127.0.0.1:${targetPort}/`;
}

async function openCodexProxyHomeInBrowser(port) {
    const url = getCodexProxyHomeUrl(port);
    try {
        await shell.openExternal(url);
        appendCodexProxyLog(`[INFO] Opened browser: ${url}`);
        return { success: true, data: { url } };
    } catch (e) {
        const err = `Failed to open browser: ${e.message}`;
        appendCodexProxyLog(`[WARN] ${err}`);
        return { success: false, error: err };
    }
}

// --- Gemini ?---
async function findPythonCommand() {
    for (const cmd of ['python', 'python3', 'py']) {
        try {
            const { stdout, stderr } = await execAsync(`${cmd} --version`, { windowsHide: true, timeout: 5000 });
            const output = `${stdout || ''}${stderr || ''}`;
            if (output.includes('Python')) return cmd;
        } catch (_) { }
    }
    return null;
}

async function ensureGeminiProxyDependencies() {
    if (!fs.existsSync(GEMINI_PROXY_ENTRY)) {
        return { success: false, error: `Gemini proxy entry not found: ${GEMINI_PROXY_ENTRY}` };
    }
    const reqFile = path.join(GEMINI_PROXY_DIR, 'requirements.txt');
    if (!fs.existsSync(reqFile)) {
        return { success: true };
    }
    const pythonCmd = await findPythonCommand();
    if (!pythonCmd) {
        return { success: false, error: 'Python not found. Please install Python 3.8+ and ensure it is in PATH.' };
    }
    try {
        await execAsync(`${pythonCmd} -m pip install -r requirements.txt --quiet`, {
            cwd: GEMINI_PROXY_DIR,
            timeout: 5 * 60 * 1000,
            windowsHide: true,
        });
        return { success: true, pythonCmd };
    } catch (e) {
        return { success: false, error: `Dependency install failed: ${e.message}`, pythonCmd };
    }
}

async function waitForGeminiProxyHealth(port, apiKey, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const headers = {};
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
            const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers, signal: AbortSignal.timeout(3000) });
            if (res.ok) return true;
        } catch (_) { }
        await new Promise(r => setTimeout(r, 800));
    }
    return false;
}

async function startGeminiProxyService({ port, apiKey, adminUsername, adminPassword } = {}) {
    if (geminiProxyProcess && !geminiProxyProcess.killed) {
        updateGeminiProxyState({ status: 'running' });
        return { success: true, data: geminiProxyState };
    }
    if (!fs.existsSync(GEMINI_PROXY_ENTRY)) {
        updateGeminiProxyState({ status: 'failed', lastError: `Entry not found: ${GEMINI_PROXY_ENTRY}` });
        return { success: false, error: geminiProxyState.lastError };
    }

    const cfg = getGeminiProxyConfig();
    const targetPort = Number(port) > 0 ? Number(port) : cfg.port;
    const targetApiKey = typeof apiKey === 'string' ? apiKey : cfg.apiKey;

    try {
        const headers = {};
        if (targetApiKey) headers['Authorization'] = `Bearer ${targetApiKey}`;
        const res = await fetch(`http://127.0.0.1:${targetPort}/v1/models`, { headers, signal: AbortSignal.timeout(2000) });
        if (res.ok) {
            updateGeminiProxyState({ status: 'running', port: targetPort, pid: null, lastError: '' });
            appendGeminiProxyLog(`[OK] Existing Gemini proxy detected on port ${targetPort}`);
            return { success: true, data: geminiProxyState };
        }
    } catch (_) { }

    const available = await isPortAvailable(targetPort);
    let finalPort = targetPort;
    if (!available) {
        const altPort = await findAvailablePort(targetPort + 1, 50);
        if (!altPort) {
            const err = `Port ${targetPort} is busy and no alternative found`;
            updateGeminiProxyState({ status: 'failed', lastError: err });
            return { success: false, error: err };
        }
        finalPort = altPort;
        appendGeminiProxyLog(`[WARN] Port ${targetPort} busy, using ${altPort}`);
    }

    updateGeminiProxyState({ status: 'starting', port: finalPort, lastError: '' });
    appendGeminiProxyLog(`[START] Starting Gemini proxy on port ${finalPort}`);

    const dep = await ensureGeminiProxyDependencies();
    const pythonCmd = dep.pythonCmd || await findPythonCommand();
    if (!pythonCmd) {
        const err = 'Python not found. Install Python 3.8+ and add to PATH.';
        updateGeminiProxyState({ status: 'failed', lastError: err });
        appendGeminiProxyLog(`[ERROR] ${err}`);
        return { success: false, error: err };
    }
    if (!dep.success) {
        appendGeminiProxyLog(`[WARN] Dependency issue: ${dep.error} ?attempting to start anyway`);
    }

    const modeCfg = loadModeConfig();
    modeCfg.geminiProxy = {
        ...(modeCfg.geminiProxy || {}),
        port: finalPort,
        apiKey: targetApiKey || cfg.apiKey,
        adminUsername: adminUsername || cfg.adminUsername,
        adminPassword: adminPassword || cfg.adminPassword,
    };
    saveModeConfig(modeCfg);

    geminiProxyExpectedExit = false;
    const child = spawn(pythonCmd, ['server.py'], {
        cwd: GEMINI_PROXY_DIR,
        env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1',
            GEMINI_PORT: String(finalPort),
            GEMINI_API_KEY: targetApiKey || cfg.apiKey,
            GEMINI_ADMIN_USERNAME: adminUsername || cfg.adminUsername,
            GEMINI_ADMIN_PASSWORD: adminPassword || cfg.adminPassword,
        },
        windowsHide: true,
    });
    geminiProxyProcess = child;
    updateGeminiProxyState({ pid: child.pid || null, startedAt: new Date().toISOString() });

    const geminiStdoutDecoder = new TextDecoder('utf-8');
    const geminiStderrDecoder = new TextDecoder('utf-8');
    child.stdout.on('data', (buf) => appendGeminiProxyLog(geminiStdoutDecoder.decode(buf, { stream: true })));
    child.stderr.on('data', (buf) => appendGeminiProxyLog(geminiStderrDecoder.decode(buf, { stream: true })));
    child.on('exit', (code, signal) => {
        geminiProxyProcess = null;
        const normalStop = geminiProxyExpectedExit;
        geminiProxyExpectedExit = false;
        if (!normalStop && geminiProxyState.status !== 'stopping') {
            const err = `Service exited, code=${code ?? 'null'}, signal=${signal ?? 'null'}`;
            updateGeminiProxyState({ status: 'failed', pid: null, lastError: err });
            appendGeminiProxyLog(`[EXIT] ${err}`);
        } else {
            updateGeminiProxyState({ status: 'stopped', pid: null });
            appendGeminiProxyLog('[STOP] Service stopped');
        }
    });

    const healthy = await waitForGeminiProxyHealth(finalPort, targetApiKey, 20000);
    if (!healthy) {
        if (geminiProxyProcess && !geminiProxyProcess.killed) {
            appendGeminiProxyLog('[WARN] Health check timeout, but process is alive ?marking as running');
            updateGeminiProxyState({ status: 'running', lastError: 'Health check timed out, service may still be starting' });
        } else {
            const err = 'Service startup failed: process exited before health check passed';
            updateGeminiProxyState({ status: 'failed', pid: null, lastError: err });
            appendGeminiProxyLog(`[ERROR] ${err}`);
            return { success: false, error: err };
        }
    } else {
        updateGeminiProxyState({ status: 'running', lastError: '' });
        appendGeminiProxyLog('[OK] Gemini proxy started');
    }

    return { success: true, data: geminiProxyState };
}

async function stopGeminiProxyService() {
    if (!geminiProxyProcess || geminiProxyProcess.killed) {
        updateGeminiProxyState({ status: 'stopped', pid: null });
        return { success: true, data: geminiProxyState };
    }
    updateGeminiProxyState({ status: 'stopping' });
    geminiProxyExpectedExit = true;

    const pid = geminiProxyProcess.pid;
    try {
        if (process.platform === 'win32' && pid) {
            await execAsync(`taskkill /PID ${pid} /T /F`, { windowsHide: true });
        } else {
            geminiProxyProcess.kill('SIGTERM');
        }
    } catch (_) {
        try { geminiProxyProcess.kill(); } catch (_) { }
    }

    geminiProxyProcess = null;
    updateGeminiProxyState({ status: 'stopped', pid: null, lastError: '' });
    appendGeminiProxyLog('[STOP] Stop requested for Gemini proxy');
    return { success: true, data: geminiProxyState };
}

async function openGeminiProxyAdmin(opts) {
    const cfg = getGeminiProxyConfig();
    const port = Number(opts?.port) > 0 ? Number(opts.port) : (geminiProxyState.port || cfg.port);
    const username = opts?.username || cfg.adminUsername || 'admin';
    const password = opts?.password || cfg.adminPassword || 'admin123';
    const qs = `?u=${encodeURIComponent(username)}&p=${encodeURIComponent(password)}`;
    const url = `http://127.0.0.1:${port}/admin/login${qs}`;
    try {
        await shell.openExternal(url);
        appendGeminiProxyLog(`[INFO] Opened browser: http://127.0.0.1:${port}/admin`);
        return { success: true, data: { url } };
    } catch (e) {
        return { success: false, error: `Failed to open browser: ${e.message}` };
    }
}

async function fetchCodexProxyModelIds(baseUrl, apiKey) {
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/models`, { headers });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`?/v1/models ? HTTP ${res.status} ${text.slice(0, 120)}`);
    }
    const data = await res.json();
    const ids = (data?.data || []).map(m => m?.id).filter(Boolean);
    return Array.from(new Set(ids));
}

// --- ?---
let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 750,
        minWidth: 800,
        minHeight: 600,
        frame: false, // ?
        backgroundColor: '#0b0b0b',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    // Development uses Vite dev server; production loads built index.html
    if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
        mainWindow.loadURL('http://localhost:5173');
    } else {
        mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
    }
}

app.whenReady().then(() => {
    createWindow();

    // ?Agent IPC ?
    if (!agentIPCInitialized) {
        try {
            const { setupAgentIPC } = require('./src/main-process/agent-ipc');
            setupAgentIPC({
                loadModels,
                mainWindow,
                loadSkillsForMatcher,
                skillMatcher: async (query) => {
                    try {
                        const skills = loadSkillsForMatcher();
                        // 始终返回轻量目录（含 tags），供系统提示词全局注入
                        const catalog = skills.map(s => ({ name: s.name, summary: s.summary || '', tags: s.tags || [] }));
                        if (!query || typeof query !== 'string' || skills.length === 0) {
                            console.log(`[SkillMatch] Skip: query=${!!query}, skills=${skills.length}`);
                            return { success: true, data: [], catalog };
                        }
                        const scored = rankSkillsForQuery(skills, query, { minScore: 0.12, limit: 3 });

                        console.log(`[SkillMatch] Query: "${query.substring(0, 60)}", Matched: ${scored.length > 0 ? scored.map(s => `${s.name}(${s.score.toFixed(2)},${s.matchLayer})`).join(', ') : 'none'}`);
                        let totalLen = 0;
                        const DETAIL_LIMIT = 6000;
                        const result = [];
                        for (const s of scored) {
                            const detailLen = (s.detail || '').length;
                            if (totalLen + detailLen > DETAIL_LIMIT) {
                                result.push({ ...s, detail: s.detail.substring(0, DETAIL_LIMIT - totalLen) + '...(truncated)' });
                                break;
                            }
                            result.push(s);
                            totalLen += detailLen;
                        }
                        return { success: true, data: result, catalog };
                    } catch (e) {
                        console.error('[SkillMatch] Error:', e.message);
                        return { success: false, error: e.message };
                    }
                },
            });
            agentIPCInitialized = true;
            console.log('[Agent] IPC system initialized');
        } catch (e) {
            console.error('[Agent] Failed to initialize IPC:', e.message);
            if (e && e.stack) console.error(e.stack);
        }
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    if (codexProxyProcess && !codexProxyProcess.killed) {
        codexProxyExpectedExit = true;
        try {
            if (process.platform === 'win32' && codexProxyProcess.pid) {
                exec(`taskkill /PID ${codexProxyProcess.pid} /T /F`);
            } else {
                codexProxyProcess.kill('SIGTERM');
            }
        } catch (_) { }
    }
    if (geminiProxyProcess && !geminiProxyProcess.killed) {
        geminiProxyExpectedExit = true;
        try {
            if (process.platform === 'win32' && geminiProxyProcess.pid) {
                exec(`taskkill /PID ${geminiProxyProcess.pid} /T /F`);
            } else {
                geminiProxyProcess.kill('SIGTERM');
            }
        } catch (_) { }
    }
});

// ========================================
// IPC ????
// ========================================

// 1. Open native folder picker
ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Select project folder',
    });
    if (result.canceled) return null;
    const folderPath = result.filePaths[0];
    const folderName = path.basename(folderPath);
    return { name: folderName, path: folderPath };
});

// 2. ?
ipcMain.handle('fs:readDir', async (_event, dirPath) => {
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        return entries
            .filter(entry => !entry.name.startsWith('.'))
            .map(entry => ({
                name: entry.name,
                isDirectory: entry.isDirectory(),
                path: path.join(dirPath, entry.name),
            }))
            .sort((a, b) => {
                // ?
                if (a.isDirectory && !b.isDirectory) return -1;
                if (!a.isDirectory && b.isDirectory) return 1;
                return a.name.localeCompare(b.name);
            });
    } catch (e) {
        console.error('Failed to read directory:', e);
        return [];
    }
});

// 3. Open project folder in Cursor/Code
ipcMain.handle('shell:openInCursor', async (_event, folderPath) => {
    return new Promise((resolve) => {
        // ?cursor ?
        exec(`cursor "${folderPath}"`, (error) => {
            if (error) {
                console.warn('cursor command failed, trying code...', error.message);
                // ?VS Code ?
                exec(`code "${folderPath}"`, (error2) => {
                    if (error2) {
                        // ?
                        shell.openPath(folderPath);
                    }
                    resolve(true);
                });
            } else {
                resolve(true);
            }
        });
    });
});

// 4. ?
ipcMain.handle('shell:showInExplorer', async (_event, folderPath) => {
    shell.showItemInFolder(folderPath);
    return true;
});

// 5. Read recent projects
ipcMain.handle('store:getRecent', async () => {
    return loadRecentProjects();
});

// 6. Save recent projects
ipcMain.handle('store:saveRecent', async (_event, list) => {
    saveRecentProjects(list);
    return true;
});

// 7. ?
ipcMain.on('window:minimize', () => {
    mainWindow?.minimize();
});

ipcMain.on('window:toggleMaximize', () => {
    if (mainWindow?.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow?.maximize();
    }
});

ipcMain.on('window:close', () => {
    mainWindow?.close();
});

// 8. ?
ipcMain.handle('window:isMaximized', () => {
    return mainWindow?.isMaximized() ?? false;
});

// 9. ?
ipcMain.handle('fs:readFileTree', async (_event, rootPath, maxDepth = 4) => {
    const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', '__pycache__', '.vscode', '.idea']);

    function buildTree(dirPath, depth) {
        if (depth > maxDepth) return [];
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            return entries
                .filter(e => !e.name.startsWith('.') || e.name === '.gitignore' || e.name === '.env')
                .filter(e => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
                .map(e => {
                    const fullPath = path.join(dirPath, e.name);
                    if (e.isDirectory()) {
                        return {
                            id: fullPath,
                            name: e.name,
                            type: 'folder',
                            path: fullPath,
                            isOpen: depth === 0, // ?
                            children: buildTree(fullPath, depth + 1),
                        };
                    }
                    return {
                        id: fullPath,
                        name: e.name,
                        type: 'file',
                        path: fullPath,
                        language: getLanguageFromExt(e.name),
                    };
                })
                .sort((a, b) => {
                    if (a.type === 'folder' && b.type === 'file') return -1;
                    if (a.type === 'file' && b.type === 'folder') return 1;
                    return a.name.localeCompare(b.name);
                });
        } catch (e) {
            return [];
        }
    }

    function getLanguageFromExt(filename) {
        const ext = path.extname(filename).toLowerCase();
        const map = {
            '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
            '.json': 'json', '.html': 'html', '.css': 'css', '.scss': 'scss',
            '.md': 'markdown', '.py': 'python', '.yaml': 'yaml', '.yml': 'yaml',
            '.xml': 'xml', '.svg': 'xml', '.sh': 'shell', '.bat': 'batch',
            '.txt': 'plaintext', '.gitignore': 'plaintext', '.env': 'plaintext',
        };
        return map[ext] || 'plaintext';
    }

    const rootName = path.basename(rootPath);
    return [{
        id: rootPath,
        name: rootName,
        type: 'folder',
        path: rootPath,
        isOpen: true,
        children: buildTree(rootPath, 0),
    }];
});

// 10. ?
ipcMain.handle('fs:readFileContent', async (_event, filePath) => {
    try {
        // Limit file size to avoid very large file rendering issues
        const stat = fs.statSync(filePath);
        if (stat.size > 2 * 1024 * 1024) { // 2MB ?
            return '// [File too large; preview supports up to 2MB]';
        }
        return fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
        return `// ? ${e.message}`;
    }
});

// 11. ?
ipcMain.handle('fs:createFile', async (_event, filePath) => {
    try {
        if (fs.existsSync(filePath)) return { success: false, error: 'File already exists' };
        fs.writeFileSync(filePath, '', 'utf-8');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 12. Create folder
ipcMain.handle('fs:createFolder', async (_event, folderPath) => {
    try {
        if (fs.existsSync(folderPath)) return { success: false, error: 'Folder already exists' };
        fs.mkdirSync(folderPath, { recursive: true });
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 13. Rename file/folder
ipcMain.handle('fs:rename', async (_event, oldPath, newPath) => {
    try {
        if (!fs.existsSync(oldPath)) return { success: false, error: 'Source file not found', code: 'E_NOT_FOUND' };
        if (fs.existsSync(newPath)) return { success: false, error: 'Target already exists', code: 'E_EXISTS' };
        fs.renameSync(oldPath, newPath);
        return { success: true };
    } catch (e) {
        const code = e.code === 'EBUSY' || e.code === 'EPERM' ? 'E_LOCKED' : 'E_UNKNOWN';
        return { success: false, error: e.message, code };
    }
});

// 14. Delete file/folder
ipcMain.handle('fs:delete', async (_event, targetPath) => {
    try {
        const stat = fs.statSync(targetPath);
        if (stat.isDirectory()) {
            fs.rmSync(targetPath, { recursive: true, force: true });
        } else {
            fs.unlinkSync(targetPath);
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 15. ?
ipcMain.handle('shell:openTerminal', async (_event, dirPath) => {
    try {
        if (process.platform === 'win32') {
            exec(`start cmd /K "cd /d ${dirPath}"`, { cwd: dirPath });
        } else if (process.platform === 'darwin') {
            exec(`open -a Terminal "${dirPath}"`);
        } else {
            exec(`x-terminal-emulator --working-directory="${dirPath}"`, (err) => {
                if (err) exec(`gnome-terminal --working-directory="${dirPath}"`);
            });
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 15b. Agent ?Cursor ?
ipcMain.handle('agent:runCommand', async (_event, { projectPath, command }) => {
    try {
        if (!projectPath || !fs.existsSync(projectPath)) {
            return { success: false, error: '', stdout: '', stderr: '' };
        }
        const cwd = projectPath;
        const opts = {
            cwd,
            maxBuffer: 2 * 1024 * 1024,
            timeout: 120000,
            encoding: 'utf-8',
            windowsHide: true,
        };
        if (process.platform === 'win32') {
            opts.shell = 'powershell.exe';
            opts.windowsVerbatimArguments = false;
            opts.env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
        }
        const { stdout, stderr } = await execAsync(command, opts);
        return { success: true, stdout: stdout || '', stderr: stderr || '', code: 0 };
    } catch (e) {
        const stdout = e.stdout || '';
        const stderr = e.stderr || e.message || '';
        const code = e.code !== undefined ? e.code : -1;
        return { success: false, stdout, stderr, code, error: e.message };
    }
});

// 16. ?
ipcMain.handle('fs:writeFile', async (_event, filePath, content) => {
    try {
        fs.writeFileSync(filePath, content, 'utf-8');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ========================================
// ?IPC?+ ?// ========================================

// M1. ?
ipcMain.handle('model:list', async () => {
    try {
        return { success: true, data: loadModels() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M2. ?
ipcMain.handle('model:create', async (_event, modelData) => {
    try {
        const models = loadModels();
        const newModel = {
            id: generateId(),
            displayName: modelData.displayName || 'Untitled Model',
            apiKey: modelData.apiKey || '',
            baseUrl: modelData.baseUrl || '',
            modelName: modelData.modelName || '',
            sourceType: modelData.sourceType || 'manual',
            rawSource: modelData.rawSource || '',
            headers: modelData.headers || {},
            extraBody: modelData.extraBody || {},
            enabled: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        models.push(newModel);
        saveModels(models);
        return { success: true, data: newModel };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M3. ?
ipcMain.handle('model:update', async (_event, id, updates) => {
    try {
        const models = loadModels();
        const idx = models.findIndex(m => m.id === id);
        if (idx === -1) return { success: false, error: 'Model not found', code: 'E_NOT_FOUND' };
        models[idx] = { ...models[idx], ...updates, updatedAt: new Date().toISOString() };
        saveModels(models);
        return { success: true, data: models[idx] };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M4. ?
ipcMain.handle('model:delete', async (_event, id) => {
    try {
        let models = loadModels();
        const before = models.length;
        models = models.filter(m => m.id !== id);
        if (models.length === before) return { success: false, error: 'Model not found', code: 'E_NOT_FOUND' };
        saveModels(models);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M5. ?cURL / Python ?
ipcMain.handle('model:parse', async (_event, raw, type) => {
    try {
        if (!raw || !raw.trim()) return { success: false, error: 'Input is empty' };
        const parsed = type === 'python' ? parsePython(raw) : parseCurl(raw);
        return { success: true, data: parsed };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M6. ?
ipcMain.handle('model:duplicate', async (_event, id) => {
    try {
        const models = loadModels();
        const source = models.find(m => m.id === id);
        if (!source) return { success: false, error: 'Model not found', code: 'E_NOT_FOUND' };
        const dup = {
            ...source,
            id: generateId(),
            displayName: source.displayName + ' (Copy)',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        models.push(dup);
        saveModels(models);
        return { success: true, data: dup };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M7. Codex proxy service status
ipcMain.handle('codexProxy:status', async () => {
    try {
        const cfg = getCodexProxyConfig();
        return {
            success: true,
            data: {
                ...codexProxyState,
                port: codexProxyState.port || cfg.port,
                configuredApiKey: !!cfg.apiKey,
                running: codexProxyState.status === 'running',
                logs: codexProxyState.logs.slice(-80),
            },
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M8. ?Codex ?
ipcMain.handle('codexProxy:start', async (_event, opts) => {
    try {
        const r = await startCodexProxyService(opts || {});
        if (r?.success && (opts?.openBrowser ?? true)) {
            const openRes = await openCodexProxyHomeInBrowser(r?.data?.port || opts?.port);
            if (openRes?.success) {
                r.data = { ...(r.data || {}), browserOpened: true, browserUrl: openRes.data?.url || '' };
            } else {
                r.data = { ...(r.data || {}), browserOpened: false, browserOpenError: openRes?.error || 'unknown error' };
            }
        }
        return r;
    } catch (e) {
        updateCodexProxyState({ status: 'failed', lastError: e.message });
        return { success: false, error: e.message };
    }
});

ipcMain.handle('codexProxy:open', async (_event, opts) => {
    try {
        return await openCodexProxyHomeInBrowser(opts?.port);
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M9. ?Codex ?
ipcMain.handle('codexProxy:stop', async () => {
    try {
        return await stopCodexProxyService();
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M10. ?codexProapi ?IDE ?
ipcMain.handle('codexProxy:importModels', async (_event, opts) => {
    try {
        const cfg = getCodexProxyConfig();
        const targetPort = Number(opts?.port) > 0 ? Number(opts.port) : cfg.port;
        const baseUrl = normalizeBaseUrl(opts?.baseUrl || `http://127.0.0.1:${targetPort}`);
        const apiKey = typeof opts?.apiKey === 'string' ? opts.apiKey : cfg.apiKey;

        let ids = [];
        let source = 'endpoint';
        try {
            ids = await fetchCodexProxyModelIds(baseUrl, apiKey);
        } catch (_) {
            ids = parseCodexModelsFromSource();
            source = 'source';
        }

        if (!ids || ids.length === 0) {
            return { success: false, error: 'No models available to import. Start the proxy or check codexProapi source.' };
        }

        const models = loadModels();
        const now = new Date().toISOString();
        let created = 0;
        let updated = 0;

        for (const modelId of ids) {
            const idx = models.findIndex(m =>
                normalizeBaseUrl(m.baseUrl) === baseUrl &&
                String(m.modelName || '').trim() === modelId
            );

            if (idx >= 0) {
                models[idx] = {
                    ...models[idx],
                    apiKey: apiKey ?? models[idx].apiKey ?? '',
                    baseUrl,
                    sourceType: 'codex-proxy',
                    rawSource: 'codexProapi-main:/v1/models',
                    updatedAt: now,
                };
                updated++;
            } else {
                models.push({
                    id: generateId(),
                    displayName: `Codex ${modelId}`,
                    apiKey: apiKey || '',
                    baseUrl,
                    modelName: modelId,
                    sourceType: 'codex-proxy',
                    rawSource: 'codexProapi-main:/v1/models',
                    headers: {},
                    extraBody: {},
                    enabled: true,
                    createdAt: now,
                    updatedAt: now,
                });
                created++;
            }
        }

        saveModels(models);
        return {
            success: true,
            data: {
                source,
                baseUrl,
                importedModelIds: ids,
                created,
                updated,
                total: ids.length,
            },
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M11. ?codexProapi
ipcMain.handle('codexProxy:addAccountManual', async (_event, body) => {
    try {
        const cfg = getCodexProxyConfig();
        const targetPort = codexProxyState?.port || cfg.port || 1455;
        const url = `http://127.0.0.1:${targetPort}/api/accounts`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) return { success: false, error: data.error || `HTTP ${res.status}` };
        return { success: true, data };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M12. ?OAuth ?
ipcMain.handle('codexProxy:getAuthDebug', async () => {
    try {
        const cfg = getCodexProxyConfig();
        const statusPort = Number(codexProxyState?.port);
        const cfgPort = Number(cfg?.port) > 0 ? Number(cfg.port) : 1455;
        const candidatePorts = Array.from(new Set([statusPort, cfgPort].filter(p => Number.isFinite(p) && p > 0)));
        const candidateHosts = ['127.0.0.1', 'localhost'];

        let lastProbeError = '';
        for (const port of candidatePorts) {
            for (const host of candidateHosts) {
                const url = `http://${host}:${port}/auth/debug`;
                try {
                    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
                    if (!res.ok) {
                        lastProbeError = `HTTP ${res.status} @ ${url}`;
                        continue;
                    }
                    const data = await res.json();
                    return { success: true, data: { ...data, _debugUrl: url } };
                } catch (e) {
                    lastProbeError = `${e.message} @ ${url}`;
                }
            }
        }

        const serviceStatus = codexProxyState?.status || 'stopped';
        const isRunning = serviceStatus === 'running' || serviceStatus === 'starting';
        if (!isRunning) {
            return {
                success: false,
                code: 'SERVICE_NOT_RUNNING',
                error: `Service is not running (status=${serviceStatus}). Please start service first. ${lastProbeError ? `Last probe: ${lastProbeError}` : ''}`.trim(),
                data: { status: serviceStatus, candidatePorts },
            };
        }
        return {
            success: false,
            code: 'AUTH_DEBUG_UNREACHABLE',
            error: `Auth debug endpoint unreachable. ${lastProbeError ? `Last probe: ${lastProbeError}` : ''}`.trim(),
            data: { status: serviceStatus, candidatePorts },
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ============================================================
// ?IPC??// ============================================================
const VERSIONS_DIR = path.join(app.getPath('userData'), 'versions');
const VERSION_EXCLUDE = new Set(['node_modules', 'dist', '.git', '.tmp-edit-repro', '.tmp-edit-repro2', '.tmp-edit-repro3', '.agent-terminal', 'eval']);
const crypto = require('crypto');

function sha256File(filePath) {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
}

function collectProjectFiles(rootPath, relativeTo = rootPath) {
    const results = [];
    function walk(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const entry of entries) {
            if (VERSION_EXCLUDE.has(entry.name)) continue;
            if (entry.name.startsWith('.tmp-')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            } else {
                const rel = path.relative(relativeTo, fullPath).replace(/\\/g, '/');
                try {
                    const stat = fs.statSync(fullPath);
                    results.push({ relativePath: rel, size: stat.size, fullPath });
                } catch (_) { }
            }
        }
    }
    walk(rootPath);
    return results;
}

// V1. ?
ipcMain.handle('version:backup', async (_event, opts) => {
    try {
        const projectPath = opts?.projectPath || __dirname;
        const label = opts?.label || 'manual-backup';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = path.join(VERSIONS_DIR, timestamp);
        fs.mkdirSync(backupDir, { recursive: true });

        const files = collectProjectFiles(projectPath);
        const manifestFiles = [];

        for (const f of files) {
            const destPath = path.join(backupDir, f.relativePath);
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(f.fullPath, destPath);
            const hash = sha256File(destPath);
            manifestFiles.push({ relativePath: f.relativePath, size: f.size, sha256: hash });
        }

        const manifest = {
            timestamp: new Date().toISOString(),
            label,
            projectPath,
            fileCount: manifestFiles.length,
            files: manifestFiles,
        };
        fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

        return { success: true, data: { backupDir, fileCount: manifestFiles.length, timestamp: manifest.timestamp } };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// V2. ?
ipcMain.handle('version:list', async () => {
    try {
        if (!fs.existsSync(VERSIONS_DIR)) return { success: true, data: [] };
        const dirs = fs.readdirSync(VERSIONS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
        const versions = [];
        for (const d of dirs) {
            const manifestPath = path.join(VERSIONS_DIR, d.name, 'manifest.json');
            if (fs.existsSync(manifestPath)) {
                try {
                    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                    versions.push({
                        id: d.name,
                        timestamp: manifest.timestamp,
                        label: manifest.label,
                        fileCount: manifest.fileCount || manifest.files?.length || 0,
                    });
                } catch (_) { }
            }
        }
        versions.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
        return { success: true, data: versions };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// V3. ?
ipcMain.handle('version:rollback', async (_event, versionId) => {
    try {
        const backupDir = path.join(VERSIONS_DIR, versionId);
        const manifestPath = path.join(backupDir, 'manifest.json');
        if (!fs.existsSync(manifestPath)) return { success: false, error: 'Snapshot not found' };
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const projectPath = manifest.projectPath || __dirname;

        // Step 1: Safety net ?backup current state
        const safetyTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safetyDir = path.join(VERSIONS_DIR, `safety-${safetyTimestamp}`);
        fs.mkdirSync(safetyDir, { recursive: true });

        const currentFiles = collectProjectFiles(projectPath);
        const safetyManifestFiles = [];
        for (const f of currentFiles) {
            const destPath = path.join(safetyDir, f.relativePath);
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(f.fullPath, destPath);
            const hash = sha256File(destPath);
            safetyManifestFiles.push({ relativePath: f.relativePath, size: f.size, sha256: hash });
        }
        fs.writeFileSync(path.join(safetyDir, 'manifest.json'), JSON.stringify({
            timestamp: new Date().toISOString(),
            label: 'rollback-safety-net',
            projectPath,
            fileCount: safetyManifestFiles.length,
            files: safetyManifestFiles,
        }, null, 2), 'utf-8');

        // Step 2: Restore files from snapshot
        const snapshotFileSet = new Set(manifest.files.map(f => f.relativePath));
        const restored = [];
        const failed = [];
        for (const f of manifest.files) {
            const srcPath = path.join(backupDir, f.relativePath);
            const destPath = path.join(projectPath, f.relativePath);
            try {
                fs.mkdirSync(path.dirname(destPath), { recursive: true });
                fs.copyFileSync(srcPath, destPath);
                // Verify sha256
                const actualHash = sha256File(destPath);
                if (f.sha256 && actualHash !== f.sha256) {
                    failed.push({ file: f.relativePath, reason: `sha256 mismatch: expected ${f.sha256.slice(0, 8)}..., got ${actualHash.slice(0, 8)}...` });
                } else {
                    restored.push(f.relativePath);
                }
            } catch (e) {
                failed.push({ file: f.relativePath, reason: e.message });
            }
        }

        // Step 3: Delete orphan files (exist in current but NOT in snapshot)
        const deleted = [];
        for (const f of currentFiles) {
            if (!snapshotFileSet.has(f.relativePath)) {
                try {
                    fs.unlinkSync(f.fullPath);
                    deleted.push(f.relativePath);
                } catch (e) {
                    failed.push({ file: f.relativePath, reason: `delete failed: ${e.message}` });
                }
            }
        }

        // Step 4: On failure, auto-restore from safety net
        if (failed.length > 0) {
            console.warn(`[Version] Rollback had ${failed.length} failures, auto-restoring from safety net...`);
            let autoRecoverOk = true;
            for (const sf of safetyManifestFiles) {
                const srcPath = path.join(safetyDir, sf.relativePath);
                const destPath = path.join(projectPath, sf.relativePath);
                try {
                    fs.mkdirSync(path.dirname(destPath), { recursive: true });
                    fs.copyFileSync(srcPath, destPath);
                } catch (_) {
                    autoRecoverOk = false;
                }
            }
            // Delete files that were in snapshot but not in safety (newly created during rollback)
            for (const f of manifest.files) {
                const inSafety = safetyManifestFiles.some(sf => sf.relativePath === f.relativePath);
                if (!inSafety) {
                    const destPath = path.join(projectPath, f.relativePath);
                    try { fs.unlinkSync(destPath); } catch (_) { }
                }
            }
            return {
                success: false,
                error: autoRecoverOk
                    ? `Rollback failed (${failed.length} errors), auto-recovered to pre-rollback state`
                    : `Rollback failed (${failed.length} errors), auto-recovery also partially failed. Safety backup: ${safetyDir}`,
                data: { restored, deleted, failed, safetyBackup: `safety-${safetyTimestamp}`, autoRecovered: autoRecoverOk },
            };
        }

        return { success: true, data: { restored: restored.length, deleted: deleted.length, safetyBackup: `safety-${safetyTimestamp}` } };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// V4. ?
ipcMain.handle('version:delete', async (_event, versionId) => {
    try {
        const targetDir = path.join(VERSIONS_DIR, versionId);
        if (!fs.existsSync(targetDir)) return { success: false, error: 'Version not found' };
        fs.rmSync(targetDir, { recursive: true, force: true });
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});
// ============================================================
// ???IPC
// ============================================================
const { SuggestionStore } = require('./src/core/suggestion-store');
const { validateTargetFiles, applySuggestion, retryApply, scoreSuggestion, dryRunPreview, FAIL_CATEGORIES } = require('./src/core/self-improve-pipeline');
const { AuditLogger } = require('./src/core/audit-logger');
const suggestionStore = new SuggestionStore(app.getPath('userData'));
const auditLogger = new AuditLogger(app.getPath('userData'));
const activeApplyAborts = new Map(); // #4: ?

// _queueError ?3?
function handleSuggestionResult(result) {
    if (result?._queueError) return { success: false, error: result.message || 'Internal queue error' };
    return result;
}

// ?implementing ?4?
try {
    const stale = suggestionStore.list('implementing');
    for (const s of stale) {
        const enteredAt = s.statusUpdatedAt || s.createdAt; // ?implementing ?
        const age = Date.now() - new Date(enteredAt).getTime();
        if (age > 10 * 60_000) { // ?10 ?
            suggestionStore.updateStatus(s.id, 'failed', { failReason: 'Process exited unexpectedly during apply; auto-marked as failed' });
        }
    }
    if (stale.length > 0) console.log(`[SelfImprove] Recovered ${stale.length} stale implementing suggestion(s)`);
} catch (_) { }

// ?6?50 ?
try {
    if (fs.existsSync(VERSIONS_DIR)) {
        const dirs = fs.readdirSync(VERSIONS_DIR)
            .filter(d => fs.statSync(path.join(VERSIONS_DIR, d)).isDirectory())
            .sort();
        if (dirs.length > 50) {
            const toDelete = dirs.slice(0, dirs.length - 50);
            for (const d of toDelete) {
                fs.rmSync(path.join(VERSIONS_DIR, d), { recursive: true, force: true });
            }
            console.log(`[Version] Cleaned up ${toDelete.length} old snapshot(s), keeping 50`);
        }
    }
} catch (_) { }

// SI-1. ?
ipcMain.handle('suggestion:list', async (_event, statusFilter) => {
    try {
        let data = suggestionStore.list(statusFilter || null);
        // #6: ?
        data = data.map(s => ({ ...s, score: scoreSuggestion(s) })).sort((a, b) => b.score - a.score);
        const stats = suggestionStore.getStats();
        return { success: true, data, stats };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// SI-2. ?
ipcMain.handle('suggestion:approve', async (_event, id) => {
    try {
        const raw = await suggestionStore.updateStatus(id, 'approved');
        const item = handleSuggestionResult(raw);
        if (item?.success === false) return item; // _queueError
        if (!item) return { success: false, error: 'Suggestion not found' };
        return { success: true, data: item };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// SI-3. ?
ipcMain.handle('suggestion:reject', async (_event, id) => {
    try {
        const raw = await suggestionStore.updateStatus(id, 'rejected');
        const item = handleSuggestionResult(raw);
        if (item?.success === false) return item;
        if (!item) return { success: false, error: 'Suggestion not found' };
        return { success: true, data: item };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// SI-4. ?+ allowlist + ?+ ?
ipcMain.handle('suggestion:apply', async (_event, id) => {
    try {
        const allSuggestions = suggestionStore.list();
        const suggestion = allSuggestions.find(s => s.id === id);
        if (!suggestion) return { success: false, error: 'Suggestion not found' };
        if (suggestion.status !== 'approved') return { success: false, error: '? ' + suggestion.status };

        const result = await suggestionStore.applyWithRateLimit(async () => {
            const ac = new AbortController();
            activeApplyAborts.set(id, ac);
            try {
                return retryApply(suggestion, {
                    suggestionStore,
                    projectRoot: __dirname,
                    signal: ac.signal,
                    auditLogger,
                    versionBackup: async (opts) => {
                        // ?
                        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                        const backupDir = path.join(VERSIONS_DIR, timestamp);
                        fs.mkdirSync(backupDir, { recursive: true });
                        const files = collectProjectFiles(__dirname);
                        const manifestFiles = [];
                        for (const f of files) {
                            const destPath = path.join(backupDir, f.relativePath);
                            fs.mkdirSync(path.dirname(destPath), { recursive: true });
                            fs.copyFileSync(f.fullPath, destPath);
                            manifestFiles.push({ relativePath: f.relativePath, size: f.size, sha256: sha256File(destPath) });
                        }
                        fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({
                            timestamp: new Date().toISOString(),
                            label: opts?.label || 'self-improve',
                            projectPath: __dirname,
                            fileCount: manifestFiles.length,
                            files: manifestFiles,
                        }, null, 2), 'utf-8');
                        return { success: true, data: { backupDir } };
                    },
                    versionRollback: async (versionId) => {
                        // ?version:rollback ?
                        const backupDir = typeof versionId === 'string' && path.isAbsolute(versionId) ? versionId : path.join(VERSIONS_DIR, versionId);
                        const manifestPath = path.join(backupDir, 'manifest.json');
                        if (!fs.existsSync(manifestPath)) return;
                        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                        const projectPath = manifest.projectPath || __dirname;

                        // Safety net
                        const safetyTs = new Date().toISOString().replace(/[:.]/g, '-');
                        const safetyDir = path.join(VERSIONS_DIR, `safety-si-${safetyTs}`);
                        fs.mkdirSync(safetyDir, { recursive: true });
                        const currentFiles = collectProjectFiles(projectPath);
                        const sfFiles = [];
                        for (const f of currentFiles) {
                            const dp = path.join(safetyDir, f.relativePath);
                            fs.mkdirSync(path.dirname(dp), { recursive: true });
                            fs.copyFileSync(f.fullPath, dp);
                            sfFiles.push({ relativePath: f.relativePath, size: f.size, sha256: sha256File(dp) });
                        }
                        fs.writeFileSync(path.join(safetyDir, 'manifest.json'), JSON.stringify({
                            timestamp: new Date().toISOString(), label: 'self-improve-safety',
                            projectPath, fileCount: sfFiles.length, files: sfFiles,
                        }, null, 2), 'utf-8');

                        // Restore + SHA256 verify
                        const snapshotFileSet = new Set(manifest.files.map(f => f.relativePath));
                        const failed = [];
                        for (const f of manifest.files) {
                            const src = path.join(backupDir, f.relativePath);
                            const dst = path.join(projectPath, f.relativePath);
                            try {
                                fs.mkdirSync(path.dirname(dst), { recursive: true });
                                fs.copyFileSync(src, dst);
                                if (f.sha256 && sha256File(dst) !== f.sha256) {
                                    failed.push(f.relativePath);
                                }
                            } catch (_) { failed.push(f.relativePath); }
                        }

                        // Delete orphans
                        for (const f of currentFiles) {
                            if (!snapshotFileSet.has(f.relativePath)) {
                                try { fs.unlinkSync(f.fullPath); } catch (_) { }
                            }
                        }

                        // Auto-recover on failure
                        if (failed.length > 0) {
                            for (const sf of sfFiles) {
                                const src = path.join(safetyDir, sf.relativePath);
                                const dst = path.join(projectPath, sf.relativePath);
                                try { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); } catch (_) { }
                            }
                            for (const f of manifest.files) {
                                if (!sfFiles.some(sf => sf.relativePath === f.relativePath)) {
                                    try { fs.unlinkSync(path.join(projectPath, f.relativePath)); } catch (_) { }
                                }
                            }
                        }
                    },
                });
            } finally {
                activeApplyAborts.delete(id);
            }
        });
        return handleSuggestionResult(result);
    } catch (e) {
        return { success: false, error: e.message };
    }
});
// ============================================================
// SI-5. Dry-Run ?3?
ipcMain.handle('suggestion:preview', async (_event, id) => {
    try {
        const all = suggestionStore.list();
        const s = all.find(x => x.id === id);
        if (!s) return { success: false, error: 'Suggestion not found' };
        const preview = dryRunPreview(s, __dirname);
        return { success: true, data: preview };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// SI-6. ?4?
ipcMain.handle('suggestion:cancel', async (_event, id) => {
    const ac = activeApplyAborts.get(id);
    if (!ac) return { success: false, error: 'No applying task is currently running' };
    ac.abort();
    auditLogger.log({ action: 'cancel', suggestionId: id });
    return { success: true };
});

// SI-7. ?8?
ipcMain.handle('suggestion:audit-log', async (_event, count) => {
    try {
        const records = auditLogger.recent(count || 50);
        return { success: true, data: records };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ============================================================
// SKILL ?IPC
// ============================================================
const SKILLS_PATH = path.join(app.getPath('userData'), 'skills.json');
const { randomUUID } = require('crypto');
let codexSkillsCache = { ts: 0, data: [] };

let localSkillsCache = { ts: 0, data: [] };

function loadSkills() {
    // 30 秒内存缓存，避免反复读磁盘
    const now = Date.now();
    if (now - localSkillsCache.ts < 30000 && localSkillsCache.data.length > 0) {
        return localSkillsCache.data;
    }
    try {
        if (fs.existsSync(SKILLS_PATH)) {
            const data = JSON.parse(fs.readFileSync(SKILLS_PATH, 'utf-8'));
            localSkillsCache = { ts: now, data };
            return data;
        }
    } catch (e) {
        console.error('[Skills] Failed to load:', e);
    }
    return [];
}

function saveSkills(list) {
    try {
        fs.writeFileSync(SKILLS_PATH, JSON.stringify(list, null, 2), 'utf-8');
        // 写入后立即刷新缓存
        localSkillsCache = { ts: Date.now(), data: list };
    } catch (e) {
        console.error('[Skills] Failed to save:', e);
    }
}

function parseSkillMarkdown(filePath, raw) {
    const lines = String(raw || '').split(/\r?\n/);
    const titleLine = lines.find(l => /^#\s+/.test(l));
    const fallbackName = path.basename(path.dirname(filePath));
    const name = (titleLine ? titleLine.replace(/^#\s+/, '').trim() : fallbackName).trim();

    let summary = '';
    for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        if (/^#/.test(s)) continue;
        if (/^```/.test(s)) continue;
        summary = s.replace(/^[-*]\s+/, '').slice(0, 120);
        break;
    }

    const detail = String(raw || '').slice(0, 12000);
    return {
        name: name || fallbackName,
        summary,
        detail,
        tags: ['codex-skill'],
        source: 'codex',
    };
}

function findSkillMarkdownFiles(rootDir, maxDepth = 3) {
    const results = [];
    const visited = new Set();

    function walk(dir, depth) {
        if (depth > maxDepth || visited.has(dir)) return;
        visited.add(dir);
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (_) {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const subDir = path.join(dir, entry.name);
            const skillMd = path.join(subDir, 'SKILL.md');
            if (fs.existsSync(skillMd)) {
                results.push(skillMd);
                continue;
            }
            walk(subDir, depth + 1);
        }
    }

    walk(rootDir, 0);
    return results;
}

function loadCodexSkills() {
    const now = Date.now();
    if (now - codexSkillsCache.ts < 30000) {
        return codexSkillsCache.data;
    }

    const roots = [];
    if (process.env.CODEX_HOME) {
        roots.push(path.join(process.env.CODEX_HOME, 'skills'));
    }
    roots.push(path.join(app.getPath('home'), '.codex', 'skills'));

    const files = [];
    const seen = new Set();
    for (const root of roots) {
        if (!root || !fs.existsSync(root)) continue;
        for (const md of findSkillMarkdownFiles(root, 3)) {
            const key = md.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            files.push(md);
        }
    }

    const codexSkills = [];
    for (const filePath of files) {
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const skill = parseSkillMarkdown(filePath, raw);
            if (skill.name) codexSkills.push(skill);
        } catch (e) {
            console.warn('[Skills] Failed to parse codex skill:', filePath, e.message);
        }
    }

    codexSkillsCache = { ts: now, data: codexSkills };
    return codexSkills;
}

function loadSkillsForMatcher() {
    const localSkills = loadSkills().map(s => ({
        ...s,
        name: (s.name || '').trim(),
        summary: s.summary || '',
        detail: s.detail || '',
        tags: Array.isArray(s.tags) ? s.tags : [],
        source: s.source || 'local',
    })).filter(s => s.name);

    const codexSkills = loadCodexSkills();
    const merged = new Map();
    for (const s of codexSkills) {
        merged.set(s.name.toLowerCase(), s);
    }
    for (const s of localSkills) {
        merged.set(s.name.toLowerCase(), s);
    }
    return [...merged.values()];
}

function validateSkillName(name) {
    if (!name || typeof name !== 'string') return '\u6280\u80fd\u540d\u4e0d\u80fd\u4e3a\u7a7a';
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 80) return '\u6280\u80fd\u540d\u957f\u5ea6\u9700\u5728 1-80 \u5b57\u4e4b\u95f4';
    if (/[\r\n\t]/.test(trimmed)) return '\u6280\u80fd\u540d\u4e0d\u80fd\u5305\u542b\u63a7\u5236\u5b57\u7b26';
    if (!/[A-Za-z0-9\u4e00-\u9fff_-]/.test(trimmed)) return '\u6280\u80fd\u540d\u81f3\u5c11\u9700\u5305\u542b\u5b57\u6bcd\u3001\u6570\u5b57\u6216\u4e2d\u6587';
    return null;
}

function make2Grams(text) {
    if (!text || text.length < 2) return new Set(text ? [text] : []);
    const grams = new Set();
    for (let i = 0; i < text.length - 1; i++) {
        grams.add(text.substring(i, i + 2));
    }
    return grams;
}

function jaccardSimilarity(setA, setB) {
    if (setA.size === 0 && setB.size === 0) return 0;
    let intersection = 0;
    for (const g of setA) {
        if (setB.has(g)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

function normalizeSkillText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/<[^>]*>/g, ' ')
        .replace(/[`"'()[\]{}.,:;!?/\\|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractSkillKeywords(text) {
    const normalized = normalizeSkillText(text);
    if (!normalized) return [];

    const baseTokens = normalized.match(/[\u4e00-\u9fff]{2,}|[a-z0-9][a-z0-9_-]{1,}/g) || [];
    const keywords = new Set();

    for (const token of baseTokens) {
        const t = token.trim();
        if (t.length < 2) continue;
        keywords.add(t);

        if (/^[\u4e00-\u9fff]+$/.test(t) && t.length >= 4) {
            for (let i = 0; i < t.length - 1; i++) keywords.add(t.substring(i, i + 2));
            if (t.length >= 6) {
                for (let i = 0; i < t.length - 2; i++) keywords.add(t.substring(i, i + 3));
            }
        } else if (/^[a-z0-9_-]+$/.test(t)) {
            const parts = t.split(/[_-]+/).filter(p => p.length >= 2);
            for (const p of parts) keywords.add(p);
        }
    }

    return [...keywords].filter(k => k.length >= 2 && k.length <= 24).slice(0, 200);
}

function buildSkillTriggerWords(skill) {
    const triggerSet = new Set();
    const rawTriggers = [skill?.name || '', ...(Array.isArray(skill?.tags) ? skill.tags : [])];

    for (const raw of rawTriggers) {
        const normalized = normalizeSkillText(raw);
        if (normalized.length >= 2) triggerSet.add(normalized);
        for (const kw of extractSkillKeywords(normalized)) {
            triggerSet.add(kw);
        }
    }

    return [...triggerSet];
}

function extractPrimaryUserRequest(query) {
    const raw = String(query || '');
    const marker = '\u5f53\u524d\u7528\u6237\u8bf7\u6c42:';
    const idx = raw.lastIndexOf(marker);
    if (idx >= 0) {
        return raw.substring(idx + marker.length).trim();
    }
    return raw;
}

function rankSkillsForQuery(skills, query, { minScore = 0.12, limit = 3 } = {}) {
    const primaryQuery = extractPrimaryUserRequest(query);
    const queryText = normalizeSkillText(primaryQuery || query);
    if (!queryText) return [];

    const queryKeywords = extractSkillKeywords(queryText);
    const queryKeywordSet = new Set(queryKeywords);
    const queryGrams = make2Grams(queryText);

    return skills.map(skill => {
        let score = 0;
        let matchLayer = 'none';

        const triggerWords = buildSkillTriggerWords(skill);
        const triggerHit = triggerWords.some(kw => queryText.includes(kw) || (queryText.length <= 4 && kw.includes(queryText)));
        if (triggerHit) {
            score = 1.0;
            matchLayer = 'trigger';
        }

        if (score < 0.95) {
            const kwSource = `${skill.summary || ''} ${(skill.detail || '').substring(0, 600)}`;
            const skillKeywords = extractSkillKeywords(kwSource);
            const skillKeywordSet = new Set(skillKeywords);
            const containsHits = skillKeywords.filter(kw => queryText.includes(kw)).length;
            let overlapHits = 0;
            for (const kw of queryKeywordSet) {
                if (skillKeywordSet.has(kw)) overlapHits++;
            }

            if (containsHits >= 2 || overlapHits >= 1) {
                const keywordScore = containsHits >= 2
                    ? 0.66 + Math.min(containsHits * 0.04, 0.24)
                    : 0.55 + Math.min(overlapHits * 0.05, 0.15);
                if (keywordScore > score) {
                    score = keywordScore;
                    matchLayer = 'keyword';
                }
            }
        }

        if (score < 0.5) {
            const skillText = normalizeSkillText(`${skill.name || ''} ${skill.summary || ''} ${(skill.tags || []).join(' ')}`);
            const skillGrams = make2Grams(skillText);
            const jScore = jaccardSimilarity(queryGrams, skillGrams);
            if (jScore > score) {
                score = jScore;
                matchLayer = 'jaccard';
            }
        }

        return { ...skill, score, matchLayer };
    }).filter(s => s.score > minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}

// S1. \u5217\u51fa\u5168\u90e8 SKILL
ipcMain.handle('skill:list', async () => {
    try {
        return { success: true, data: loadSkills() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// S2. \u521b\u5efa SKILL
ipcMain.handle('skill:create', async (_event, data) => {
    try {
        const nameErr = validateSkillName(data?.name);
        if (nameErr) return { success: false, error: nameErr, code: 'E_INVALID_NAME' };
        const skills = loadSkills();
        if (skills.some(s => s.name === data.name.trim())) {
            return { success: false, error: '\u5df2\u5b58\u5728\u540c\u540d\u6280\u80fd', code: 'E_DUPLICATE' };
        }
        const skill = {
            id: randomUUID(),
            name: data.name.trim(),
            summary: (data.summary || '').trim(),
            detail: (data.detail || '').trim(),
            tags: Array.isArray(data.tags) ? data.tags : [],
            source: data.source || 'manual',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        skills.push(skill);
        saveSkills(skills);
        return { success: true, data: skill };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// S3. \u66f4\u65b0 SKILL
ipcMain.handle('skill:update', async (_event, id, updates) => {
    try {
        if (updates?.name) {
            const nameErr = validateSkillName(updates.name);
            if (nameErr) return { success: false, error: nameErr, code: 'E_INVALID_NAME' };
        }
        const skills = loadSkills();
        const idx = skills.findIndex(s => s.id === id);
        if (idx === -1) return { success: false, error: '\u6280\u80fd\u4e0d\u5b58\u5728', code: 'E_NOT_FOUND' };
        if (updates?.name && updates.name.trim() !== skills[idx].name) {
            if (skills.some(s => s.name === updates.name.trim() && s.id !== id)) {
                return { success: false, error: '\u5df2\u5b58\u5728\u540c\u540d\u6280\u80fd', code: 'E_DUPLICATE' };
            }
        }
        skills[idx] = { ...skills[idx], ...updates, updatedAt: new Date().toISOString() };
        saveSkills(skills);
        return { success: true, data: skills[idx] };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// S4. \u5220\u9664 SKILL
ipcMain.handle('skill:delete', async (_event, id) => {
    try {
        let skills = loadSkills();
        const before = skills.length;
        skills = skills.filter(s => s.id !== id);
        if (skills.length === before) return { success: false, error: '\u6280\u80fd\u4e0d\u5b58\u5728', code: 'E_NOT_FOUND' };
        saveSkills(skills);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// S5. \u5bfc\u51fa SKILL
ipcMain.handle('skill:export', async (_event, id) => {
    try {
        const skills = loadSkills();
        const skill = skills.find(s => s.id === id);
        if (!skill) return { success: false, error: '\u6280\u80fd\u4e0d\u5b58\u5728', code: 'E_NOT_FOUND' };
        const result = await dialog.showSaveDialog(mainWindow, {
            title: '\u5bfc\u51fa SKILL \u6280\u80fd',
            defaultPath: `${skill.name}.json`,
            filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (result.canceled) return { success: false, error: '\u7528\u6237\u53d6\u6d88' };
        fs.writeFileSync(result.filePath, JSON.stringify(skill, null, 2), 'utf-8');
        return { success: true, data: { path: result.filePath } };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// S6. \u5bfc\u5165 SKILL
ipcMain.handle('skill:import', async (_event, conflictStrategy) => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: '\u5bfc\u5165 SKILL \u6280\u80fd',
            filters: [
                { name: 'SKILL files', extensions: ['json', 'md'] },
            ],
            properties: ['openFile', 'multiSelections'],
        });
        if (result.canceled) return { success: false, error: '\u7528\u6237\u53d6\u6d88' };

        const skills = loadSkills();
        const imported = [];
        const conflicts = [];
        const skipped = [];

        for (const filePath of result.filePaths) {
            const raw = fs.readFileSync(filePath, 'utf-8');
            let skillData;

            if (filePath.endsWith('.json')) {
                skillData = JSON.parse(raw);
            } else if (filePath.endsWith('.md')) {
                // Parse SKILL.md format: extract name from first # heading, rest is detail
                const lines = raw.split('\n');
                const titleLine = lines.find(l => l.startsWith('# '));
                const name = titleLine ? titleLine.replace(/^#\s+/, '').trim() : path.basename(filePath, '.md');
                skillData = { name, summary: '', detail: raw, tags: ['imported-md'] };
            } else {
                continue;
            }

            const nameErr = validateSkillName(skillData.name);
            if (nameErr) {
                conflicts.push({ file: filePath, error: nameErr });
                continue;
            }

            const existing = skills.find(s => s.name === skillData.name);
            const strategy = conflictStrategy || 'rename';

            if (existing) {
                if (strategy === 'skip') {
                    skipped.push({ file: filePath, name: skillData.name });
                    continue;
                } else if (strategy === 'overwrite') {
                    Object.assign(existing, {
                        summary: skillData.summary || existing.summary,
                        detail: skillData.detail || existing.detail,
                        tags: skillData.tags || existing.tags,
                        source: 'imported',
                        updatedAt: new Date().toISOString(),
                    });
                    imported.push(existing);
                    continue;
                } else {
                    // rename: append timestamp
                    skillData.name = `${skillData.name}_${Date.now()}`;
                }
            }

            const newSkill = {
                id: randomUUID(),
                name: skillData.name,
                summary: skillData.summary || '',
                detail: skillData.detail || '',
                tags: skillData.tags || [],
                source: 'imported',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            skills.push(newSkill);
            imported.push(newSkill);
        }

        saveSkills(skills);
        return { success: true, data: { imported, conflicts, skipped } };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// S7. AI \u751f\u6210 SKILL
ipcMain.handle('skill:generate', async (_event, params) => {
    try {
        const { modelId, description } = params || {};
        if (!description) return { success: false, error: '\u8bf7\u63d0\u4f9b\u6280\u80fd\u63cf\u8ff0' };
        const models = loadModels();
        const model = modelId ? models.find(m => m.id === modelId) : models.find(m => m.enabled);
        if (!model) return { success: false, error: '\u672a\u627e\u5230\u53ef\u7528\u6a21\u578b' };

        const systemPrompt = `\u4f60\u662f\u4e00\u4e2a SKILL \u6280\u80fd\u751f\u6210\u5668\u3002\u6839\u636e\u7528\u6237\u63cf\u8ff0\u751f\u6210 SKILL \u914d\u7f6e\u3002
\u8f93\u51fa\u4e25\u683c\u7684 JSON \u683c\u5f0f\uff0c\u5305\u542b\u4ee5\u4e0b\u5b57\u6bb5\uff1a
- name: \u4e2d\u6587\u6280\u80fd\u540d\uff08\u5fc5\u987b\u5305\u542b\u4e2d\u6587\uff0c1-50\u5b57\uff09
- summary: \u6280\u80fd\u7b80\u8ff0\uff081-2\u53e5\u8bdd\uff09
- detail: \u6280\u80fd\u8be6\u7ec6\u5185\u5bb9\uff08Markdown \u683c\u5f0f\uff0c\u5305\u542b\u5177\u4f53\u6307\u5bfc\u548c\u6700\u4f73\u5b9e\u8df5\uff09
- tags: \u6807\u7b7e\u6570\u7ec4\uff08\u4e2d\u6587\uff0c2-5\u4e2a\uff09
\u53ea\u8f93\u51fa JSON\uff0c\u4e0d\u8981\u5176\u4ed6\u5185\u5bb9\u3002`;

        const result = await _callLLMForSkill(model, systemPrompt, description, 2);
        if (!result.success) return result;

        const nameErr = validateSkillName(result.data.name);
        if (nameErr) return { success: false, error: `\u751f\u6210\u7684\u6280\u80fd\u540d\u4e0d\u5408\u89c4: ${nameErr}`, rawOutput: result.rawOutput };

        return { success: true, data: { ...result.data, source: 'ai-generated' } };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// S8. AI \u4f18\u5316 SKILL
ipcMain.handle('skill:optimize', async (_event, params) => {
    try {
        const { modelId, skillId, instruction } = params || {};
        const skills = loadSkills();
        const skill = skills.find(s => s.id === skillId);
        if (!skill) return { success: false, error: '\u6280\u80fd\u4e0d\u5b58\u5728' };
        if (!instruction) return { success: false, error: '\u8bf7\u63d0\u4f9b\u4f18\u5316\u6307\u4ee4' };

        const models = loadModels();
        const model = modelId ? models.find(m => m.id === modelId) : models.find(m => m.enabled);
        if (!model) return { success: false, error: '\u672a\u627e\u5230\u53ef\u7528\u6a21\u578b' };

        const systemPrompt = `\u4f60\u662f\u4e00\u4e2a SKILL \u6280\u80fd\u4f18\u5316\u5668\u3002\u6839\u636e\u7528\u6237\u7684\u4f18\u5316\u6307\u4ee4\uff0c\u6539\u8fdb\u73b0\u6709\u6280\u80fd\u3002
\u5f53\u524d\u6280\u80fd\u5185\u5bb9\uff1a
\u540d\u79f0: ${skill.name}
\u7b80\u8ff0: ${skill.summary}
\u8be6\u60c5: ${skill.detail}
\u6807\u7b7e: ${(skill.tags || []).join(', ')}

\u8f93\u51fa\u4f18\u5316\u540e\u7684\u5b8c\u6574 JSON\uff0c\u5305\u542b name\u3001summary\u3001detail\u3001tags \u5b57\u6bb5\u3002\u53ea\u8f93\u51fa JSON\u3002`;

        const result = await _callLLMForSkill(model, systemPrompt, instruction, 2);
        if (!result.success) return result;

        const nameErr = validateSkillName(result.data.name);
        if (nameErr) return { success: false, error: `\u4f18\u5316\u540e\u7684\u6280\u80fd\u540d\u4e0d\u5408\u89c4: ${nameErr}`, rawOutput: result.rawOutput };

        return { success: true, data: result.data };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// S9. \u8f6c\u6362\u5916\u90e8 IDE \u7684 SKILL
ipcMain.handle('skill:convert', async (_event, params) => {
    try {
        const { modelId, content, sourceFormat } = params || {};
        if (!content) return { success: false, error: '\u8bf7\u63d0\u4f9b\u5f85\u8f6c\u6362\u7684 SKILL \u5185\u5bb9' };

        const models = loadModels();
        const model = modelId ? models.find(m => m.id === modelId) : models.find(m => m.enabled);
        if (!model) return { success: false, error: '\u672a\u627e\u5230\u53ef\u7528\u6a21\u578b' };

        const systemPrompt = `\u4f60\u662f\u4e00\u4e2a SKILL \u683c\u5f0f\u8f6c\u6362\u5668\u3002\u5c06\u5176\u4ed6 IDE\uff08\u5982 Cursor\u3001Windsurf\u3001Cline \u7b49\uff09\u7684 SKILL \u8f6c\u6362\u4e3a\u672c\u9879\u76ee\u683c\u5f0f\u3002
\u6e90\u683c\u5f0f: ${sourceFormat || '\u81ea\u52a8\u68c0\u6d4b'}

\u8f93\u51fa\u4e25\u683c JSON\uff0c\u5305\u542b\uff1a
- name: \u4e2d\u6587\u6280\u80fd\u540d\uff08\u5fc5\u987b\u5305\u542b\u4e2d\u6587\uff09
- summary: \u6280\u80fd\u7b80\u8ff0
- detail: \u8be6\u7ec6\u5185\u5bb9\uff08Markdown\uff09
- tags: \u6807\u7b7e\u6570\u7ec4
\u53ea\u8f93\u51fa JSON\u3002`;

        const result = await _callLLMForSkill(model, systemPrompt, content, 2);
        if (!result.success) return result;

        const nameErr = validateSkillName(result.data.name);
        if (nameErr) return { success: false, error: `\u8f6c\u6362\u540e\u7684\u6280\u80fd\u540d\u4e0d\u5408\u89c4: ${nameErr}`, rawOutput: result.rawOutput };

        return { success: true, data: { ...result.data, source: 'converted' } };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// S10. 2-gram \u5339\u914d SKILL
ipcMain.handle('skill:match', async (_event, query) => {
    try {
        if (!query || typeof query !== 'string') return { success: true, data: [] };
        const skills = loadSkills();
        if (skills.length === 0) return { success: true, data: [] };
        const scored = rankSkillsForQuery(skills, query, { minScore: 0.1, limit: 3 });

        // Enforce detail total char limit of 3000
        let totalLen = 0;
        const result = [];
        for (const s of scored) {
            const detailLen = (s.detail || '').length;
            if (totalLen + detailLen > 3000) {
                result.push({ ...s, detail: s.detail.substring(0, 3000 - totalLen) + '...(truncated)' });
                break;
            }
            result.push(s);
            totalLen += detailLen;
        }

        return { success: true, data: result };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// --- LLM helper for SKILL generation/optimization/conversion ---
async function _callLLMForSkill(model, systemPrompt, userMessage, maxRetries = 2) {
    const baseUrl = normalizeBaseUrl(model.baseUrl);
    const headers = {
        'Content-Type': 'application/json',
        ...(model.apiKey ? { 'Authorization': `Bearer ${model.apiKey}` } : {}),
        ...(model.headers || {}),
    };

    let lastError = '';
    let rawOutput = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: attempt === 0 ? userMessage : `${userMessage}\n\n[Previous attempt failed: ${lastError}. Output valid JSON only.]` },
        ];

        try {
            const res = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: model.modelName || model.displayName,
                    messages,
                    temperature: 0.7,
                    max_tokens: 4096,
                    ...(model.extraBody || {}),
                }),
                signal: AbortSignal.timeout(60000),
            });

            if (!res.ok) {
                lastError = `HTTP ${res.status}`;
                continue;
            }

            const data = await res.json();
            rawOutput = data?.choices?.[0]?.message?.content || '';

            // Extract JSON from response (handle markdown code blocks)
            let jsonStr = rawOutput;
            const jsonMatch = rawOutput.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) jsonStr = jsonMatch[1];
            jsonStr = jsonStr.trim();

            const parsed = JSON.parse(jsonStr);
            // Strict schema validation: name, summary, detail required strings; tags required string array
            if (!parsed.name || !parsed.detail || !parsed.summary) {
                lastError = 'Missing required fields (name, summary, or detail)';
                continue;
            }
            if (typeof parsed.name !== 'string' || typeof parsed.detail !== 'string' || typeof parsed.summary !== 'string') {
                lastError = 'name/summary/detail must all be strings';
                continue;
            }
            if (parsed.name.trim().length < 2) {
                lastError = 'name too short (min 2 chars)';
                continue;
            }
            if (parsed.detail.trim().length < 10) {
                lastError = 'detail too short (min 10 chars)';
                continue;
            }
            // tags: must be array of strings, filter invalid items
            if (!Array.isArray(parsed.tags)) {
                parsed.tags = [];
            } else {
                parsed.tags = parsed.tags.filter(t => typeof t === 'string' && t.trim().length > 0).map(t => t.trim());
            }

            return {
                success: true,
                data: {
                    name: parsed.name.trim(),
                    summary: parsed.summary.trim(),
                    detail: parsed.detail.trim(),
                    tags: parsed.tags,
                },
                rawOutput,
            };
        } catch (e) {
            lastError = e.message;
        }
    }

    return {
        success: false,
        error: `\u6a21\u578b\u8f93\u51fa\u683c\u5f0f\u4e0d\u5408\u89c4\uff0c\u8bf7\u624b\u52a8\u7f16\u8f91\u3002\u6700\u540e\u9519\u8bef: ${lastError}`,
        rawOutput,
    };
}

// ============================================================
// Gemini ?IPC
// ============================================================
ipcMain.handle('geminiProxy:status', async () => {
    try {
        const cfg = getGeminiProxyConfig();
        return {
            success: true,
            data: {
                ...geminiProxyState,
                port: geminiProxyState.port || cfg.port,
                configuredApiKey: !!cfg.apiKey,
                running: geminiProxyState.status === 'running',
                logs: geminiProxyState.logs.slice(-80),
            },
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('geminiProxy:start', async (_event, opts) => {
    try {
        const r = await startGeminiProxyService(opts || {});
        if (r?.success && (opts?.openBrowser ?? true)) {
            await openGeminiProxyAdmin({
                port: r?.data?.port || opts?.port,
                username: opts?.adminUsername,
                password: opts?.adminPassword,
            });
        }
        return r;
    } catch (e) {
        updateGeminiProxyState({ status: 'failed', lastError: e.message });
        return { success: false, error: e.message };
    }
});

ipcMain.handle('geminiProxy:stop', async () => {
    try {
        return await stopGeminiProxyService();
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('geminiProxy:openAdmin', async (_event, opts) => {
    try {
        return await openGeminiProxyAdmin(opts);
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('geminiProxy:importModels', async (_event, opts) => {
    try {
        const cfg = getGeminiProxyConfig();
        const targetPort = Number(opts?.port) > 0 ? Number(opts.port) : (geminiProxyState.port || cfg.port);
        const baseUrl = opts?.baseUrl || `http://127.0.0.1:${targetPort}`;
        const apiKey = typeof opts?.apiKey === 'string' ? opts.apiKey : cfg.apiKey;

        const headers = {};
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        const res = await fetch(`${baseUrl}/v1/models`, { headers, signal: AbortSignal.timeout(5000) });
        if (!res.ok) {
            return { success: false, error: `Failed to fetch models: HTTP ${res.status}` };
        }
        const body = await res.json();
        const modelData = body?.data || [];
        if (!modelData.length) {
            return { success: false, error: 'No models returned from Gemini proxy' };
        }

        const models = loadModels();
        const now = new Date().toISOString();
        let created = 0, updated = 0;

        for (const m of modelData) {
            const modelId = m.id || m.name;
            if (!modelId) continue;
            const normalizedBase = baseUrl.replace(/\/+$/, '');
            const idx = models.findIndex(existing =>
                existing.baseUrl?.replace(/\/+$/, '') === normalizedBase &&
                String(existing.modelName || '').trim() === modelId
            );

            if (idx >= 0) {
                models[idx] = {
                    ...models[idx],
                    apiKey: apiKey ?? models[idx].apiKey ?? '',
                    baseUrl: normalizedBase,
                    sourceType: 'gemini-proxy',
                    rawSource: 'gemininixiang-main:/v1/models',
                    updatedAt: now,
                };
                updated++;
            } else {
                models.push({
                    id: generateId(),
                    displayName: `Gemini ${modelId}`,
                    apiKey: apiKey || '',
                    baseUrl: normalizedBase,
                    modelName: modelId,
                    sourceType: 'gemini-proxy',
                    rawSource: 'gemininixiang-main:/v1/models',
                    headers: {},
                    extraBody: {},
                    enabled: true,
                    createdAt: now,
                    updatedAt: now,
                });
                created++;
            }
        }

        saveModels(models);
        return {
            success: true,
            data: {
                baseUrl,
                importedModelIds: modelData.map(m => m.id || m.name).filter(Boolean),
                created,
                updated,
                total: modelData.length,
            },
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ============================================================
// ?(chat-sessions.json)
// ============================================================
const SESSIONS_PATH = path.join(app.getPath('userData'), 'chat-sessions.json');

function loadSessions() {
    try {
        if (fs.existsSync(SESSIONS_PATH)) {
            return JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf-8'));
        }
    } catch (e) {
        console.error('[Chat] Failed to load sessions:', e);
    }
    return [];
}

function saveSessions(list) {
    try {
        fs.writeFileSync(SESSIONS_PATH, JSON.stringify(list, null, 2), 'utf-8');
    } catch (e) {
        console.error('[Chat] Failed to save sessions:', e);
    }
}

// C1. ?projectPath ?
ipcMain.handle('chat:list', async (_event, opts) => {
    try {
        let sessions = loadSessions();
        const filterPath = opts?.projectPath;
        if (filterPath) {
            const norm = filterPath.replace(/[\\/]+$/, '').toLowerCase();
            sessions = sessions.filter(s => {
                const sp = (s.projectPath || '').replace(/[\\/]+$/, '').toLowerCase();
                return sp === norm;
            });
        }
        const meta = sessions.map(s => ({
            id: s.id,
            title: s.title,
            messageCount: (s.messages || []).length,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            projectPath: s.projectPath || '',
        }));
        return { success: true, data: meta };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// C2. ?
ipcMain.handle('chat:get', async (_event, id) => {
    try {
        const sessions = loadSessions();
        const session = sessions.find(s => s.id === id);
        if (!session) return { success: false, error: 'Session not found', code: 'E_NOT_FOUND' };
        return { success: true, data: session };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// C3. ?
ipcMain.handle('chat:create', async (_event, data) => {
    try {
        const sessions = loadSessions();
        const now = new Date().toISOString();
        const newSession = {
            id: generateId(),
            title: (data && data.title) || ('?' + new Date().toLocaleString('zh-CN')),
            messages: (data && data.messages) || [],
            projectPath: (data && data.projectPath) || '',
            createdAt: now,
            updatedAt: now,
        };
        sessions.unshift(newSession); // ?
        saveSessions(sessions);
        return { success: true, data: newSession };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// C4. ?/ ?/ ?
ipcMain.handle('chat:update', async (_event, id, updates) => {
    try {
        const sessions = loadSessions();
        const idx = sessions.findIndex(s => s.id === id);
        if (idx === -1) return { success: false, error: 'Session not found', code: 'E_NOT_FOUND' };
        sessions[idx] = { ...sessions[idx], ...updates, updatedAt: new Date().toISOString() };
        saveSessions(sessions);
        return { success: true, data: sessions[idx] };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// C5. ?
ipcMain.handle('chat:delete', async (_event, id) => {
    try {
        let sessions = loadSessions();
        const before = sessions.length;
        sessions = sessions.filter(s => s.id !== id);
        if (sessions.length === before) return { success: false, error: 'Session not found', code: 'E_NOT_FOUND' };
        saveSessions(sessions);
        // ?session ?todoStore
        try {
            const { disposeSessionStore } = require('./src/main-process/agent-ipc');
            disposeSessionStore(id);
        } catch (_) { }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// C6. ?
ipcMain.handle('chat:export', async (_event, id, format) => {
    try {
        const sessions = loadSessions();
        const session = sessions.find(s => s.id === id);
        if (!session) return { success: false, error: 'Session not found', code: 'E_NOT_FOUND' };

        let content, ext;
        if (format === 'json') {
            content = JSON.stringify(session, null, 2);
            ext = 'json';
        } else if (format === 'md') {
            // Markdown format with rich formatting
            const lines = [
                `# ${session.title}`,
                '',
                `> Created: ${session.createdAt}  `,
                `> Messages: ${(session.messages || []).length}`,
                '',
                '---',
                '',
            ];
            (session.messages || []).forEach(m => {
                const role = m.role === 'user' ? 'User' : 'AI';
                const time = new Date(m.id).toLocaleString('zh-CN');
                lines.push(`### ${role} @ ${time}`);
                lines.push('');
                if (m.text) lines.push(m.text);
                if (m.answerText) lines.push(m.answerText);
                // Tool calls
                if (m.toolCalls && m.toolCalls.length > 0) {
                    lines.push('');
                    lines.push('<details><summary>Tool Calls</summary>');
                    lines.push('');
                    m.toolCalls.forEach(tc => {
                        lines.push(`- **${tc.toolName || tc.name || 'tool'}**`);
                        if (tc.args) lines.push(`  \`\`\`json\n  ${JSON.stringify(tc.args, null, 2)}\n  \`\`\``);
                    });
                    lines.push('</details>');
                }
                lines.push('');
                lines.push('---');
                lines.push('');
            });
            content = lines.join('\n');
            ext = 'md';
        } else if (format === 'pdf') {
            // PDF: generate Markdown first, then render to HTML, then use Electron's printToPDF
            const mdLines = [`# ${session.title}\n\n`];
            (session.messages || []).forEach(m => {
                const role = m.role === 'user' ? 'User' : 'AI';
                const time = new Date(m.id).toLocaleString('zh-CN');
                mdLines.push(`### ${role} @ ${time}\n\n`);
                if (m.text) mdLines.push(`${m.text}\n\n`);
                if (m.answerText) mdLines.push(`${m.answerText}\n\n`);
                mdLines.push('---\n\n');
            });
            const mdContent = mdLines.join('');
            // Simple markdown-to-HTML conversion
            const htmlBody = mdContent
                .replace(/### (.*)/g, '<h3>$1</h3>')
                .replace(/## (.*)/g, '<h2>$1</h2>')
                .replace(/# (.*)/g, '<h1>$1</h1>')
                .replace(/---/g, '<hr>')
                .replace(/\n\n/g, '<br><br>')
                .replace(/`([^`]+)`/g, '<code>$1</code>');
            const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
              body { font-family: -apple-system, 'Segoe UI', sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #333; font-size: 14px; line-height: 1.6; }
              h1 { color: #1a1a1a; border-bottom: 2px solid #eee; padding-bottom: 8px; }
              h3 { color: #555; margin-top: 20px; }
              code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
              hr { border: none; border-top: 1px solid #eee; margin: 16px 0; }
            </style></head><body>${htmlBody}</body></html>`;

            const { BrowserWindow } = require('electron');
            const pdfWin = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { nodeIntegration: false } });
            await pdfWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
            const pdfBuffer = await pdfWin.webContents.printToPDF({ pageSize: 'A4', margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 } });
            pdfWin.destroy();

            const { dialog: dlg } = require('electron');
            const pdfResult = await dlg.showSaveDialog({
                title: '?PDF',
                defaultPath: path.join(app.getPath('documents'), `${session.title}.pdf`),
                filters: [{ name: 'PDF', extensions: ['pdf'] }],
            });
            if (pdfResult.canceled || !pdfResult.filePath) return { success: false, error: 'Save cancelled by user' };
            fs.writeFileSync(pdfResult.filePath, pdfBuffer);
            return { success: true, filePath: pdfResult.filePath };
        } else {
            // TXT format (default)
            const lines = [`# ${session.title}`, `? ${session.createdAt}`, ''];
            (session.messages || []).forEach(m => {
                lines.push(`[${m.role === 'user' ? 'User' : 'AI'}] ${new Date(m.id).toLocaleString('zh-CN')}`);
                lines.push(m.text || m.answerText || '');
                lines.push('');
            });
            content = lines.join('\n');
            ext = 'txt';
        }

        const { dialog } = require('electron');
        const result = await dialog.showSaveDialog({
            title: 'Export session to PDF',
            defaultPath: path.join(app.getPath('documents'), `${session.title}.${ext}`),
            filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
        });

        if (result.canceled || !result.filePath) return { success: false, error: 'Save cancelled by user' };

        fs.writeFileSync(result.filePath, content, 'utf-8');
        return { success: true, filePath: result.filePath };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// C7. AI ?
ipcMain.handle('chat:generateTitle', async (_event, { modelId, userMessage }) => {
    try {
        const models = loadModels();
        const model = models.find(m => m.id === modelId);
        if (!model || !model.baseUrl || !model.modelName) {
            // ?
            const title = (userMessage || '').replace(/\\n/g, ' ').substring(0, 30).trim() || 'New Chat';
            return { success: true, data: title };
        }

        const url = buildApiUrl(model.baseUrl);
        const headers = { 'Content-Type': 'application/json' };
        if (model.apiKey) headers['Authorization'] = `Bearer ${model.apiKey}`;

        const body = {
            model: model.modelName,
            messages: [
                {
                    role: 'system',
                    content: 'Generate a concise Chinese chat title (8-20 chars), plain text only, no punctuation.',
                },
                { role: 'user', content: (userMessage || '').substring(0, 500) },
            ],
            max_tokens: 50,
            temperature: 0.3,
        };

        const resp = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10000),
        });

        if (resp.ok) {
            const json = await resp.json();
            let title = (json.choices?.[0]?.message?.content || '').trim();
            // ?
            title = title.replace(/^["'\](){}<>]+|["'\](){}<>]+$/g, '').trim();
            if (title.length >= 4 && title.length <= 30) {
                return { success: true, data: title };
            }
        }

        // ?25 ?
        const fallback = (userMessage || '').replace(/\\n/g, ' ').substring(0, 25).trim() || 'New Chat';
        return { success: true, data: fallback };
    } catch (e) {
        const fallback = (userMessage || '').replace(/\\n/g, ' ').substring(0, 25).trim() || 'New Chat';
        return { success: true, data: fallback };
    }
});

// ============================================================
// ?(session-memory/)
// ============================================================
const { SessionMemoryStore } = require('./src/core/session-memory-store');
const sessionMemoryStore = new SessionMemoryStore(path.join(app.getPath('userData'), 'session-memory'));

ipcMain.handle('memory:getSummary', async (_event, sessionId) => {
    try {
        const summary = sessionMemoryStore.getSummary(sessionId);
        return { success: true, data: summary };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('memory:getPromptContext', async (_event, sessionId) => {
    try {
        const ctx = sessionMemoryStore.formatForPrompt(sessionId);
        return { success: true, data: ctx };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('memory:deleteSession', async (_event, sessionId) => {
    try {
        sessionMemoryStore.deleteSession(sessionId);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ============================================================
// ?(mode-config.json)
// ============================================================
const MODE_CONFIG_PATH = path.join(app.getPath('userData'), 'mode-config.json');

function loadModeConfig() {
    const defaults = {
        defaultMode: 'chat',
        modeModels: {},
        taskExecution: { autoExecute: false },
        codexProxy: { port: 1455, apiKey: '' },
        geminiProxy: { port: 8000, apiKey: 'sk-geminixxxxx', adminUsername: 'admin', adminPassword: 'admin123' },
    };
    try {
        if (fs.existsSync(MODE_CONFIG_PATH)) {
            const raw = JSON.parse(fs.readFileSync(MODE_CONFIG_PATH, 'utf-8'));
            // ?
            if (!raw.taskExecution) raw.taskExecution = { ...defaults.taskExecution };
            if (!raw.codexProxy) raw.codexProxy = { ...defaults.codexProxy };
            const parsedPort = Number(raw.codexProxy.port);
            raw.codexProxy.port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 1455;
            if (typeof raw.codexProxy.apiKey !== 'string') raw.codexProxy.apiKey = '';
            if (!raw.geminiProxy) raw.geminiProxy = { ...defaults.geminiProxy };
            const geminiPort = Number(raw.geminiProxy.port);
            raw.geminiProxy.port = Number.isFinite(geminiPort) && geminiPort > 0 ? geminiPort : 8000;
            if (typeof raw.geminiProxy.apiKey !== 'string') raw.geminiProxy.apiKey = defaults.geminiProxy.apiKey;
            return raw;
        }
    } catch (e) {
        console.error('[ModeConfig] Failed to load:', e);
    }
    return defaults;
}

function saveModeConfig(config) {
    try {
        fs.writeFileSync(MODE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    } catch (e) {
        console.error('[ModeConfig] Failed to save:', e);
    }
}

ipcMain.handle('modeConfig:get', async () => {
    try {
        return { success: true, data: loadModeConfig() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('modeConfig:save', async (_event, config) => {
    try {
        saveModeConfig(config);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ============================================================
// ?// ============================================================
const { WorkflowStore } = require('./src/core/workflow-store');
const WORKFLOWS_PATH = path.join(app.getPath('userData'), 'workflows.json');
const workflowStore = new WorkflowStore(WORKFLOWS_PATH);

ipcMain.handle('workflow:list', async () => workflowStore.list());
ipcMain.handle('workflow:get', async (_event, id) => workflowStore.get(id));
ipcMain.handle('workflow:create', async (_event, data) => workflowStore.create(data));
ipcMain.handle('workflow:update', async (_event, id, updates) => workflowStore.update(id, updates));
ipcMain.handle('workflow:delete', async (_event, id) => workflowStore.delete(id));
ipcMain.handle('workflow:updateActiveVersion', async (_event, wfId, data) => workflowStore.updateActiveVersion(wfId, data));
ipcMain.handle('workflow:saveVersion', async (_event, wfId, versionData) => workflowStore.saveVersion(wfId, versionData));
ipcMain.handle('workflow:deleteVersion', async (_event, wfId, versionId) => workflowStore.deleteVersion(wfId, versionId));
ipcMain.handle('workflow:match', async (_event, taskDesc) => {
    const wf = workflowStore.matchWorkflow(taskDesc);
    if (!wf) return null;
    const steps = workflowStore.getActiveSteps(wf.id);
    return { id: wf.id, name: wf.name, description: wf.description, steps };
});

// ============================================================
// LLM I-compatible??// ============================================================
ipcMain.handle('llm:chat', async (_event, { modelId, messages }) => {
    const startTime = Date.now();
    const logTag = '[LLM:Chat]';

    try {
        // 1) ?
        const models = loadModels();
        const model = models.find(m => m.id === modelId);
        if (!model) {
            console.error(logTag, 'Model not found:', modelId);
            return { success: false, error: 'Model config not found. Add model in Settings first', code: 'E_MODEL_NOT_FOUND' };
        }

        if (!model.baseUrl || !model.modelName) {
            return { success: false, error: 'Model config incomplete (missing baseUrl or modelName)', code: 'E_CONFIG_INCOMPLETE' };
        }

        // 2) ?
        const url = buildApiUrl(model.baseUrl);
        const headers = {
            'Content-Type': 'application/json',
            ...(model.apiKey ? { 'Authorization': `Bearer ${model.apiKey}` } : {}),
            ...(model.headers || {})
        };

        const body = {
            model: model.modelName,
            messages: messages.map(m => ({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.text || m.content || '' })),
            ...(model.extraBody || {})
        };

        // ?
        const maskedKey = model.apiKey ? model.apiKey.substring(0, 4) + '****' + model.apiKey.slice(-4) : 'none';
        console.log(logTag, 'Request:', {
            url,
            model: model.modelName,
            messageCount: messages.length,
            apiKey: maskedKey,
            extraHeaders: Object.keys(model.headers || {}),
        });

        // 3) Request (30s timeout)
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: controller.signal
            });
        } catch (fetchErr) {
            clearTimeout(timeout);
            if (fetchErr.name === 'AbortError') {
                console.error(logTag, 'Timeout after 30s');
                return { success: false, error: 'Request timed out after 30s', code: 'E_TIMEOUT' };
            }
            console.error(logTag, 'Network error:', fetchErr.message);
            return { success: false, error: `Network error: ${fetchErr.message}`, code: 'E_NETWORK' };
        }
        clearTimeout(timeout);

        // 4) ?HTTP ?
        if (!response.ok) {
            let errorBody = '';
            try { errorBody = await response.text(); } catch (e) { /* ignore */ }
            const errorSummary = errorBody.substring(0, 200);
            console.error(logTag, `HTTP ${response.status}:`, errorSummary);

            const statusMessages = {
                401: `Authentication failed (invalid or expired API key). [Debug] URL=${url}, Key=${maskedKey}`,
                403: 'Forbidden (insufficient permission)',
                404: 'Endpoint not found (check baseUrl)',
                429: 'Rate limited (too many requests)',
                500: 'Model service internal error',
                502: 'Bad gateway',
                503: 'Service unavailable',
            };
            const readableError = statusMessages[response.status] || `HTTP ${response.status} request failed`;
            return {
                success: false,
                error: `${readableError}\n${errorSummary}`,
                code: `E_HTTP_${response.status}`,
                httpStatus: response.status
            };
        }

        // 5) ?
        const data = await response.json();
        const elapsed = Date.now() - startTime;

        const choice = data.choices?.[0];
        const content = choice?.message?.content || '';
        const reasoningContent = choice?.message?.reasoning_content || '';
        const usage = data.usage || {};

        // Detect reasoning model
        const REASONING_KEYWORDS = /reasoning|thinking|o1|o3|r1|deepseek-r/i;
        const isReasoning = model.isReasoningModel === true ||
            (model.isReasoningModel !== false && REASONING_KEYWORDS.test(model.modelName || ''));

        console.log(logTag, 'Response:', {
            elapsed: `${elapsed}ms`,
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
            contentLength: content.length,
            reasoningLength: reasoningContent.length,
            isReasoning,
            finishReason: choice?.finish_reason
        });

        return {
            success: true,
            data: {
                content,
                answerText: content,
                thoughtSummaryZh: reasoningContent || '',
                thoughtDurationMs: elapsed,
                isReasoningModel: isReasoning,
                model: data.model,
                usage,
                finishReason: choice?.finish_reason,
                elapsed
            }
        };

    } catch (e) {
        console.error(logTag, 'Unexpected error:', e.message);
        return { success: false, error: `? ${e.message}`, code: 'E_UNKNOWN' };
    }
});

// ============================================================
// ?API??
// ============================================================

// ?node_modules, .git ?
function collectFiles(dir, maxDepth = 5, currentDepth = 0) {
    if (currentDepth >= maxDepth) return [];
    const IGNORE = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.cache', 'coverage', '.vscode'];
    const TEXT_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.scss', '.html', '.md', '.txt', '.yaml', '.yml', '.toml', '.env', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.vue', '.svelte'];
    let files = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (IGNORE.includes(entry.name)) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                files = files.concat(collectFiles(fullPath, maxDepth, currentDepth + 1));
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (TEXT_EXTS.includes(ext)) {
                    files.push({ name: entry.name, path: fullPath, ext });
                }
            }
        }
    } catch (e) { /* ignore permission errors */ }
    return files;
}

// project:search ??
ipcMain.handle('project:search', async (_event, projectPath, query) => {
    try {
        if (!projectPath || !query) return { success: false, error: 'Missing required parameters' };
        if (!fs.existsSync(projectPath)) return { success: false, error: 'Project path does not exist' };

        const files = collectFiles(projectPath);
        const results = [];
        const seen = new Set(); // ?key: file.path:line

        // ?
        const keywords = query
            .split(/[,\s]+/)
            .map(k => k.trim().toLowerCase())
            .filter(k => k.length > 1);
        if (keywords.length === 0) keywords.push(query.toLowerCase());

        const EXT_LANG = { '.js': 'javascript', '.jsx': 'jsx', '.ts': 'typescript', '.tsx': 'tsx', '.json': 'json', '.css': 'css', '.html': 'html', '.md': 'markdown', '.py': 'python', '.java': 'java', '.go': 'go', '.rs': 'rust' };

        for (const file of files) {
            if (results.length >= 30) break;

            // ?
            const nameMatched = keywords.some(k => file.name.toLowerCase().includes(k));
            if (nameMatched) {
                const key = `${file.path}:1`;
                if (!seen.has(key)) {
                    seen.add(key);
                    try {
                        const content = fs.readFileSync(file.path, 'utf-8');
                        const lines = content.split('\n');
                        const relPath = path.relative(projectPath, file.path).replace(/\\/g, '/');
                        results.push({
                            file: file.name,
                            path: file.path,
                            relativePath: relPath,
                            line: 1,
                            language: EXT_LANG[file.ext] || 'text',
                            snippet: lines.slice(0, 10).join('\n'),
                            matchType: 'filename',
                            matchedKeyword: keywords.find(k => file.name.toLowerCase().includes(k))
                        });
                    } catch (e) { /* skip */ }
                }
            }

            // ??500KB?2 ?
            try {
                const stat = fs.statSync(file.path);
                if (stat.size > 500 * 1024) continue;
                const content = fs.readFileSync(file.path, 'utf-8');
                const lines = content.split('\n');
                const relPath = path.relative(projectPath, file.path).replace(/\\/g, '/');
                let fileHits = 0;

                for (let li = 0; li < lines.length && fileHits < 2; li++) {
                    const lineLower = lines[li].toLowerCase();
                    const matchedKw = keywords.find(k => lineLower.includes(k));
                    if (matchedKw) {
                        const key = `${file.path}:${li + 1}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            const snippetStart = Math.max(0, li - 2);
                            const snippetEnd = Math.min(lines.length, li + 5);
                            results.push({
                                file: file.name,
                                path: file.path,
                                relativePath: relPath,
                                line: li + 1,
                                language: EXT_LANG[file.ext] || 'text',
                                snippet: lines.slice(snippetStart, snippetEnd).join('\n'),
                                matchType: 'content',
                                matchedKeyword: matchedKw
                            });
                            fileHits++;
                        }
                    }
                }
            } catch (e) { /* skip */ }
        }

        return { success: true, data: results, fileCount: files.length, keywords };
    } catch (e) {
        return { success: false, error: e.message };
    }
});


// project:readSnippet - read specific line range from file
ipcMain.handle('project:readSnippet', async (_event, filePath, startLine, endLine) => {
    try {
        if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'File does not exist' };
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const start = Math.max(0, (startLine || 1) - 1);
        const end = Math.min(lines.length, endLine || start + 20);
        return {
            success: true,
            data: {
                content: lines.slice(start, end).join('\n'),
                totalLines: lines.length,
                startLine: start + 1,
                endLine: end
            }
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// project:listFiles ??
ipcMain.handle('project:listFiles', async (_event, projectPath) => {
    try {
        if (!projectPath || !fs.existsSync(projectPath)) return { success: false, error: 'Project path does not exist' };
        const files = collectFiles(projectPath);
        return { success: true, data: files.map(f => f.name) };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// project:statPath - secure path stat within project root
ipcMain.handle('project:statPath', async (_event, projectPath, targetPath) => {
    try {
        if (!projectPath || !fs.existsSync(projectPath)) {
            return { success: false, error: 'Invalid project path' };
        }
        const projectRoot = path.resolve(projectPath);
        const candidate = path.resolve(projectRoot, targetPath || '.');
        const rel = path.relative(projectRoot, candidate);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            return { success: false, error: 'Path escapes project root' };
        }
        if (!fs.existsSync(candidate)) {
            return {
                success: true,
                exists: false,
                absPath: candidate,
                relativePath: rel.replace(/\\/g, '/'),
            };
        }
        const st = fs.statSync(candidate);
        return {
            success: true,
            exists: true,
            isFile: st.isFile(),
            isDirectory: st.isDirectory(),
            size: st.size,
            mtimeMs: st.mtimeMs,
            absPath: candidate,
            relativePath: rel.replace(/\\/g, '/'),
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ============================================================
// ?
// ============================================================
const activeWatchers = new Map();

ipcMain.handle('fs:watchStart', async (_event, projectPath) => {
    if (activeWatchers.has(projectPath)) return { success: true, already: true };
    try {
        const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', '__pycache__']);
        let debounceTimer = null;
        const { getSemanticIndexService } = require('./src/core/semantic-index');
        const semanticIndex = getSemanticIndexService();

        const watcher = fs.watch(projectPath, { recursive: true }, (eventType, filename) => {
            if (!filename) return;
            const parts = filename.replace(/\\/g, '/').split('/');
            if (parts.some(p => SKIP.has(p))) return;
            try {
                semanticIndex.markDirty(projectPath, filename.replace(/\\/g, '/'));
            } catch (_) { }

            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('fs:changed', {
                        projectPath,
                        eventType,
                        filename: filename.replace(/\\/g, '/'),
                    });
                }
            }, 300);
        });

        activeWatchers.set(projectPath, watcher);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('fs:watchStop', async (_event, projectPath) => {
    const watcher = activeWatchers.get(projectPath);
    if (watcher) {
        watcher.close();
        activeWatchers.delete(projectPath);
    }
    return { success: true };
});

// ============================================================
// Linter ?
// ============================================================
ipcMain.handle('linter:run', async (_event, projectPath, targetFiles, options) => {
    try {
        const { getLinterErrors } = require('./src/core/linter-runner');
        return await getLinterErrors(projectPath, targetFiles, options || {});
    } catch (e) {
        return { success: false, diagnostics: [], error: e.message };
    }
});

ipcMain.handle('linter:detect', async (_event, projectPath) => {
    try {
        const { detectAvailableEngines } = require('./src/core/linter-runner');
        return { success: true, engines: detectAvailableEngines(projectPath) };
    } catch (e) {
        return { success: false, engines: ['builtin'], error: e.message };
    }
});

// ============================================================
// LLM  streaming?/ ============================================================
const activeStreams = new Map();

ipcMain.on('llm:stream', (event, { modelId, messages, requestId }) => {
    const logTag = '[LLM:Stream]';
    const startTime = Date.now();

    (async () => {
        try {
            const models = loadModels();
            const model = models.find(m => m.id === modelId);
            if (!model) {
                event.reply('llm:stream-error', { requestId, error: 'Model config not found', code: 'E_MODEL_NOT_FOUND' });
                return;
            }
            if (!model.baseUrl || !model.modelName) {
                event.reply('llm:stream-error', { requestId, error: 'Model config incomplete', code: 'E_CONFIG_INCOMPLETE' });
                return;
            }

            const url = buildApiUrl(model.baseUrl);
            const headers = {
                'Content-Type': 'application/json',
                ...(model.apiKey ? { 'Authorization': `Bearer ${model.apiKey}` } : {}),
                ...(model.headers || {})
            };

            const { stream: _s, ...streamSafeExtra } = model.extraBody || {};
            const body = {
                model: model.modelName,
                messages: messages.map(m => ({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.text || m.content || '' })),
                stream: true,
                ...streamSafeExtra
            };

            const REASONING_KEYWORDS = /reasoning|thinking|o1|o3|r1|deepseek-r/i;
            const isReasoning = model.isReasoningModel === true ||
                (model.isReasoningModel !== false && REASONING_KEYWORDS.test(model.modelName || ''));

            console.log(logTag, 'Stream start:', { url, model: model.modelName, requestId });

            const controller = new AbortController();
            activeStreams.set(requestId, controller);
            const timeout = setTimeout(() => controller.abort(), 120000);

            let response;
            try {
                response = await fetch(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                    signal: controller.signal
                });
            } catch (fetchErr) {
                clearTimeout(timeout);
                activeStreams.delete(requestId);
                if (fetchErr.name === 'AbortError') {
                    event.reply('llm:stream-error', { requestId, error: 'Request aborted or timed out', code: 'E_ABORTED' });
                } else {
                    event.reply('llm:stream-error', { requestId, error: `Network error: ${fetchErr.message}`, code: 'E_NETWORK' });
                }
                return;
            }

            if (!response.ok) {
                clearTimeout(timeout);
                activeStreams.delete(requestId);
                let errorBody = '';
                try { errorBody = await response.text(); } catch (e) { }
                const statusMessages = {
                    401: `Authentication failed (invalid or expired API key). [Debug] URL=${url}, Key=${model.apiKey ? model.apiKey.substring(0, 6) + '****' + model.apiKey.slice(-4) : '(none)'}`,
                    403: 'Forbidden',
                    404: 'Endpoint not found (check baseUrl)',
                    429: 'Rate limited',
                    500: 'Model service internal error',
                    502: 'Bad gateway',
                    503: 'Service unavailable',
                };
                const msg = statusMessages[response.status] || `HTTP ${response.status}`;
                event.reply('llm:stream-error', { requestId, error: `${msg}\n${errorBody.substring(0, 200)}`, code: `E_HTTP_${response.status}` });
                return;
            }

            let fullContent = '';
            let fullReasoning = '';
            let buffer = '';

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    // Flush TextDecoder internal buffer (may hold incomplete multi-byte chars)
                    const remaining = decoder.decode();
                    if (remaining) buffer += remaining;
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === 'data: [DONE]') continue;
                    if (!trimmed.startsWith('data: ')) continue;

                    try {
                        const parsed = JSON.parse(trimmed.slice(6));
                        const delta = parsed.choices?.[0]?.delta;
                        const message = parsed.choices?.[0]?.message;
                        const src = delta || message;
                        if (!src) continue;

                        if (src.content) {
                            fullContent += src.content;
                            event.reply('llm:stream-chunk', {
                                requestId,
                                content: src.content,
                                fullContent,
                                isReasoning
                            });
                        }
                        if (src.reasoning_content) {
                            fullReasoning += src.reasoning_content;
                            event.reply('llm:stream-chunk', {
                                requestId,
                                reasoning: src.reasoning_content,
                                fullReasoning,
                                isReasoning: true
                            });
                        }
                        if (src.tool_calls && Array.isArray(src.tool_calls)) {
                            event.reply('llm:stream-chunk', {
                                requestId,
                                toolCalls: src.tool_calls,
                                isReasoning
                            });
                        }
                    } catch (e) { }
                }
            }

            // Process any remaining data in buffer after stream ends
            if (buffer.trim()) {
                const trimmed = buffer.trim();
                if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
                    try {
                        const parsed = JSON.parse(trimmed.slice(6));
                        const src = parsed.choices?.[0]?.delta || parsed.choices?.[0]?.message;
                        if (src?.content) {
                            fullContent += src.content;
                        }
                        if (src?.reasoning_content) {
                            fullReasoning += src.reasoning_content;
                        }
                    } catch (_) { }
                }
            }

            clearTimeout(timeout);
            activeStreams.delete(requestId);
            const elapsed = Date.now() - startTime;

            console.log(logTag, 'Stream done:', { requestId, elapsed: `${elapsed}ms`, contentLen: fullContent.length, reasoningLen: fullReasoning.length });

            event.reply('llm:stream-done', {
                requestId,
                content: fullContent,
                reasoning: fullReasoning,
                isReasoningModel: isReasoning || fullReasoning.length > 0,
                elapsed,
                model: model.modelName,
            });

        } catch (e) {
            activeStreams.delete(requestId);
            console.error(logTag, 'Unexpected error:', e.message);
            event.reply('llm:stream-error', { requestId, error: `? ${e.message}`, code: 'E_UNKNOWN' });
        }
    })();
});

ipcMain.on('llm:stream-abort', (_event, { requestId }) => {
    const controller = activeStreams.get(requestId);
    if (controller) {
        console.log('[LLM:Stream] Abort:', requestId);
        controller.abort();
        activeStreams.delete(requestId);
    }
});

