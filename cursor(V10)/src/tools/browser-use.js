const path = require('path');
const os = require('os');
const browserSession = require('./browser-session');

function getBrowserWindow() {
  try {
    const { BrowserWindow } = require('electron');
    return BrowserWindow;
  } catch (_) {
    return null;
  }
}

module.exports = {
  name: 'browser_use',
  description: `Open a browser window to navigate web pages, interact with elements, and take screenshots. Use for testing web applications, verifying UI changes, checking page rendering. Actions: navigate, click, type, screenshot, get_text, wait, close.`,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['navigate', 'click', 'type', 'screenshot', 'get_text', 'wait', 'close'],
        description: 'Browser action to perform.',
      },
      url: { type: 'string', description: 'URL to navigate to (for "navigate" action).' },
      selector: { type: 'string', description: 'CSS selector for click/type/get_text actions.' },
      text: { type: 'string', description: 'Text to type (for "type" action).' },
      waitMs: { type: 'number', description: 'Milliseconds to wait (for "wait" action). Max 10000.' },
    },
    required: ['action'],
  },
  riskLevel: 'medium',
  timeout: 30000,

  async handler(args, projectPath, context) {
    const BW = getBrowserWindow();
    if (!BW) {
      return { success: false, error: 'BrowserWindow not available in this context', code: 'E_NO_BROWSER' };
    }

    const sessionId = (context && context.sessionId) || '_default';

    switch (args.action) {
      case 'navigate': {
        if (!args.url) return { success: false, error: 'URL required for navigate' };
        return browserSession.navigate(args.url, { owner: sessionId, show: false, waitAfterLoadMs: 600 });
      }

      case 'screenshot': {
        const win = browserSession.getWindow();
        if (!win) {
          return { success: false, error: 'No browser open. Navigate first.' };
        }
        try {
          const tmpPath = path.join(os.tmpdir(), `screenshot_${Date.now()}.png`);
          const result = await browserSession.screenshotTo(tmpPath);
          if (!result.success) return result;
          return { success: true, screenshotPath: tmpPath, size: result.size };
        } catch (e) {
          return { success: false, error: `Screenshot failed: ${e.message}` };
        }
      }

      case 'click': {
        const win = browserSession.getWindow();
        if (!win) return { success: false, error: 'No browser open' };
        if (!args.selector) return { success: false, error: 'Selector required' };
        try {
          const escaped = args.selector.replace(/'/g, "\\'");
          await win.webContents.executeJavaScript(
            `document.querySelector('${escaped}')?.click()`
          );
          return { success: true };
        } catch (e) {
          return { success: false, error: `Click failed: ${e.message}` };
        }
      }

      case 'type': {
        const win = browserSession.getWindow();
        if (!win) return { success: false, error: 'No browser open' };
        if (!args.selector || !args.text) return { success: false, error: 'Selector and text required' };
        try {
          const escaped = args.selector.replace(/'/g, "\\'");
          const textEscaped = args.text.replace(/'/g, "\\'");
          await win.webContents.executeJavaScript(`
            const el = document.querySelector('${escaped}');
            if (el) { el.focus(); el.value = '${textEscaped}'; el.dispatchEvent(new Event('input', {bubbles:true})); }
          `);
          return { success: true };
        } catch (e) {
          return { success: false, error: `Type failed: ${e.message}` };
        }
      }

      case 'get_text': {
        const win = browserSession.getWindow();
        if (!win) return { success: false, error: 'No browser open' };
        try {
          const selector = args.selector || 'body';
          const extracted = await browserSession.extractText(selector, 10000);
          if (!extracted.success) return extracted;
          return { success: true, text: extracted.text };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }

      case 'wait': {
        const ms = Math.min(args.waitMs || 1000, 10000);
        await new Promise(r => setTimeout(r, ms));
        return { success: true, waited: ms };
      }

      case 'close': {
        browserSession.closeWindow();
        return { success: true };
      }

      default:
        return { success: false, error: `Unknown action: ${args.action}` };
    }
  },
};
