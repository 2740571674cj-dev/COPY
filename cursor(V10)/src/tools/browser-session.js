const PERSIST_PARTITION = 'persist:cursor-agent-web';

let sharedWindow = null;
let sharedOwner = null;

function getBrowserWindowCtor() {
  try {
    return require('electron').BrowserWindow;
  } catch (_) {
    return null;
  }
}

function getWindow() {
  if (!sharedWindow || sharedWindow.isDestroyed()) return null;
  return sharedWindow;
}

function _createWindow({ owner = null, show = false, width = 1280, height = 800 } = {}) {
  const BrowserWindowCtor = getBrowserWindowCtor();
  if (!BrowserWindowCtor) return null;

  if (sharedWindow && !sharedWindow.isDestroyed()) {
    return sharedWindow;
  }

  sharedWindow = new BrowserWindowCtor({
    width,
    height,
    show,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      partition: PERSIST_PARTITION,
    },
  });
  sharedOwner = owner;
  return sharedWindow;
}

async function navigate(url, { owner = null, show = false, waitAfterLoadMs = 1200 } = {}) {
  const win = _createWindow({ owner, show });
  if (!win) {
    return { success: false, error: 'BrowserWindow not available', code: 'E_NO_BROWSER' };
  }
  try {
    await win.loadURL(url);
    if (waitAfterLoadMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitAfterLoadMs));
    }
    return { success: true, title: win.getTitle() || '', url };
  } catch (e) {
    return { success: false, error: `Failed to load URL: ${e.message}`, code: 'E_NAVIGATE_FAILED' };
  }
}

async function extractText(selector = null, maxLen = 30000) {
  const win = getWindow();
  if (!win) {
    return { success: false, error: 'No browser open', code: 'E_NO_BROWSER_WINDOW' };
  }

  try {
    const cssSelector = selector && String(selector).trim() ? String(selector).trim() : null;
    const text = await win.webContents.executeJavaScript(
      `(function () {
        const sel = ${JSON.stringify(cssSelector)};
        const root = sel
          ? document.querySelector(sel)
          : (document.querySelector('main') || document.body || document.documentElement);
        return (root && root.innerText) ? root.innerText : '';
      })();`,
      true
    );
    const normalized = String(text || '')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { success: true, text: normalized.slice(0, Math.max(1, maxLen)) };
  } catch (e) {
    return { success: false, error: `Extract text failed: ${e.message}`, code: 'E_EXTRACT_FAILED' };
  }
}

async function screenshotTo(path) {
  const win = getWindow();
  if (!win) {
    return { success: false, error: 'No browser open', code: 'E_NO_BROWSER_WINDOW' };
  }
  try {
    const image = await win.webContents.capturePage();
    require('fs').writeFileSync(path, image.toPNG());
    return { success: true, size: image.getSize(), path };
  } catch (e) {
    return { success: false, error: `Screenshot failed: ${e.message}`, code: 'E_SCREENSHOT_FAILED' };
  }
}

function closeWindow() {
  try {
    if (sharedWindow && !sharedWindow.isDestroyed()) {
      sharedWindow.close();
    }
  } catch (_) { }
  sharedWindow = null;
  sharedOwner = null;
}

function getMeta() {
  return {
    partition: PERSIST_PARTITION,
    owner: sharedOwner,
    hasWindow: !!getWindow(),
  };
}

module.exports = {
  PERSIST_PARTITION,
  getWindow,
  navigate,
  extractText,
  screenshotTo,
  closeWindow,
  getMeta,
};
