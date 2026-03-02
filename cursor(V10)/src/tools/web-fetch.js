const browserSession = require('./browser-session');

module.exports = {
  name: 'web_fetch',
  description: `Fetch content from a URL and return it as readable text. Use to read documentation, API references, or code examples. Only fetches public pages. Does not support authentication or binary content.`,
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Full URL to fetch (must start with http:// or https://).',
      },
    },
    required: ['url'],
  },
  riskLevel: 'safe',
  timeout: 20000,

  async handler(args) {
    const { url } = args;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { success: false, error: 'URL must start with http:// or https://', code: 'E_INVALID_URL' };
    }

    const blocked = /^https?:\/\/(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;
    if (blocked.test(url)) {
      return { success: false, error: 'Cannot fetch localhost or private network URLs', code: 'E_PRIVATE_URL' };
    }

    const browserLikeHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.7,*/*;q=0.5',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    };

    const isReadableType = (contentType) => {
      return contentType.includes('text/') || contentType.includes('application/json') || contentType.includes('application/xml');
    };

    const extractText = (raw, contentType) => {
      let text = raw || '';
      if (contentType.includes('text/html')) {
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<nav[\s\S]*?<\/nav>/gi, '')
          .replace(/<footer[\s\S]*?<\/footer>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\s+/g, ' ')
          .replace(/\n\s*\n\s*\n/g, '\n\n')
          .trim();
      }
      if (text.length > 30000) {
        text = text.substring(0, 30000) + '\n\n...(truncated, content too long)';
      }
      return text;
    };

    const looksLikeBotBlock = (raw, contentType) => {
      if (!raw) return false;
      if (!contentType.includes('text/html')) return false;
      const sample = raw.substring(0, 4000).toLowerCase();
      const indicators = [
        'cloudflare',
        'cf-chl',
        'captcha',
        'verify you are human',
        'access denied',
        'bot detection',
        'are you a robot',
        'security check',
        'ddos protection',
      ];
      return indicators.some(k => sample.includes(k));
    };

    const fetchWithTimeout = async (targetUrl, timeoutMs, headers) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(targetUrl, { signal: controller.signal, headers });
        const contentType = resp.headers.get('content-type') || '';
        const raw = await resp.text();
        return { ok: true, resp, raw, contentType };
      } finally {
        clearTimeout(timeout);
      }
    };

    const tryJinaFallback = async (targetUrl, reason) => {
      // r.jina.ai often works for pages protected by anti-bot JavaScript challenges.
      const noProtocol = targetUrl.replace(/^https?:\/\//i, '');
      const proxyUrl = `https://r.jina.ai/http://${noProtocol}`;
      try {
        const proxyResult = await fetchWithTimeout(proxyUrl, 18000, browserLikeHeaders);
        if (!proxyResult.resp.ok) {
          return null;
        }
        const text = extractText(proxyResult.raw, proxyResult.contentType || 'text/plain');
        if (!text || text.trim().length < 40) {
          return null;
        }
        const proxyDenied = /target url returned error\s*403|requiring captcha|please make sure you are authorized|access denied|just a moment/i.test(text);
        if (proxyDenied) {
          return {
            success: false,
            error: 'Blocked by anti-bot protection on target site (even via fallback proxy)',
            code: 'E_BOT_BLOCKED',
            url,
            fetchedVia: 'r.jina.ai',
          };
        }
        return {
          success: true,
          content: text,
          url,
          contentType: proxyResult.contentType || 'text/plain',
          fetchedVia: 'r.jina.ai',
          note: `Direct fetch fallback used (${reason})`,
        };
      } catch (_) {
        return null;
      }
    };

    const tryBrowserRenderFallback = async (targetUrl, reason) => {
      const nav = await browserSession.navigate(targetUrl, { owner: 'web_fetch', show: false, waitAfterLoadMs: 1400 });
      if (!nav?.success) return null;

      const extracted = await browserSession.extractText(null, 30000);
      if (!extracted?.success) return null;
      const text = extracted.text || '';

      const blockedByChallenge = /captcha|verify you are human|access denied|cloudflare|just a moment|security check/i
        .test(text.substring(0, 2400));
      if (!text || text.length < 80 || blockedByChallenge) {
        return {
          success: false,
          error: 'Blocked by anti-bot challenge page (browser render fallback)',
          code: 'E_BOT_BLOCKED',
          url,
          fetchedVia: 'browser_render',
        };
      }

      return {
        success: true,
        content: `Title: ${nav.title || ''}\n\n${text}`,
        url,
        contentType: 'text/plain',
        fetchedVia: 'browser_render',
        note: `Browser render fetch used (${reason})`,
      };
    };

    try {
      // Cursor-like path: prioritize browser-session rendering first.
      const browserPrimary = await tryBrowserRenderFallback(url, 'primary');
      if (browserPrimary?.success) return browserPrimary;

      const direct = await fetchWithTimeout(url, 15000, browserLikeHeaders);
      const { resp, raw, contentType } = direct;

      if (!resp.ok) {
        if ([403, 429, 503].includes(resp.status)) {
          const browserFallback = await tryBrowserRenderFallback(url, `HTTP ${resp.status}`);
          if (browserFallback) return browserFallback;
          const fallback = await tryJinaFallback(url, `HTTP ${resp.status}`);
          if (fallback) return fallback;
          if (resp.status === 403 || resp.status === 429) {
            return {
              success: false,
              error: `HTTP ${resp.status} (likely anti-bot protection)`,
              code: 'E_BOT_BLOCKED',
              url,
            };
          }
        }
        return { success: false, error: `HTTP ${resp.status}`, code: `E_HTTP_${resp.status}` };
      }

      if (!isReadableType(contentType)) {
        return { success: false, error: `Unsupported content type: ${contentType}`, code: 'E_UNSUPPORTED_TYPE' };
      }

      if (looksLikeBotBlock(raw, contentType)) {
        const browserFallback = await tryBrowserRenderFallback(url, 'bot/challenge page detected');
        if (browserFallback) return browserFallback;
        const fallback = await tryJinaFallback(url, 'bot/challenge page detected');
        if (fallback) return fallback;
        return {
          success: false,
          error: 'Blocked by anti-bot challenge page',
          code: 'E_BOT_BLOCKED',
          url,
        };
      }

      const text = extractText(raw, contentType);
      return { success: true, content: text, url, contentType };
    } catch (err) {
      if (err.name === 'AbortError') {
        const browserFallback = await tryBrowserRenderFallback(url, 'timeout');
        if (browserFallback) return browserFallback;
        const fallback = await tryJinaFallback(url, 'timeout');
        if (fallback) return fallback;
        return { success: false, error: 'Request timed out', code: 'E_TIMEOUT' };
      }
      const browserFallback = await tryBrowserRenderFallback(url, 'network failure');
      if (browserFallback) return browserFallback;
      const fallback = await tryJinaFallback(url, 'network failure');
      if (fallback) return fallback;
      return { success: false, error: err.message, code: 'E_FETCH_FAILED' };
    }
  },
};
