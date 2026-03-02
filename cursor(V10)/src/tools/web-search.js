module.exports = {
  name: 'web_search',
  description: `Search the web for real-time information. Use when you need up-to-date documentation, solutions to specific errors, or current best practices. Returns titles, URLs, and snippets from multiple search providers.`,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query. Be specific, include version numbers or year if relevant.',
      },
    },
    required: ['query'],
  },
  riskLevel: 'safe',
  timeout: 20000,

  async handler(args) {
    const query = args.query;
    if (!query || !query.trim()) {
      return { success: false, error: 'Empty search query', code: 'E_EMPTY_QUERY' };
    }

    const providers = [
      () => this._searxng(query),
      () => this._duckduckgo(query),
      () => this._duckduckgoHtml(query),
    ];

    for (const provider of providers) {
      try {
        const results = await provider();
        if (results && results.length > 0) {
          return {
            success: true,
            query,
            results: results.slice(0, 8).map(r => ({
              title: r.title,
              url: r.url,
              snippet: (r.snippet || '').substring(0, 400),
            })),
          };
        }
      } catch (_) {
        continue;
      }
    }

    return { success: false, error: 'All search providers failed or returned no results.', code: 'E_SEARCH_FAILED' };
  },

  async _searxng(query) {
    const instances = [
      'https://search.inetol.net',
      'https://search.sapti.me',
      'https://searx.be',
    ];
    for (const base of instances) {
      try {
        const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&categories=general&language=auto`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch(url, {
          signal: controller.signal,
          headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        });
        clearTimeout(timeout);
        if (!resp.ok) continue;
        const data = await resp.json();
        const results = (data.results || []).slice(0, 10).map(r => ({
          title: r.title || '',
          url: r.url || '',
          snippet: r.content || '',
        })).filter(r => r.url && r.title);
        if (results.length > 0) return results;
      } catch (_) {
        continue;
      }
    }
    return null;
  },

  async _duckduckgo(query) {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      const data = await resp.json();

      const results = [];
      if (data.AbstractText) {
        results.push({ title: data.Heading || query, url: data.AbstractURL, snippet: data.AbstractText });
      }
      for (const topic of (data.RelatedTopics || []).slice(0, 8)) {
        if (topic.Text && topic.FirstURL) {
          results.push({ title: topic.Text.substring(0, 100), url: topic.FirstURL, snippet: topic.Text });
        }
      }
      return results.length > 0 ? results : null;
    } catch (e) {
      clearTimeout(timeout);
      return null;
    }
  },

  async _duckduckgoHtml(query) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      clearTimeout(timeout);
      const html = await resp.text();

      const results = [];
      const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      const urls = [];
      const titles = [];
      while ((match = linkRegex.exec(html)) !== null) {
        let href = match[1];
        if (href.startsWith('//duckduckgo.com/l/')) {
          const udMatch = /uddg=([^&]+)/.exec(href);
          if (udMatch) href = decodeURIComponent(udMatch[1]);
        }
        urls.push(href);
        titles.push(match[2].replace(/<[^>]+>/g, '').trim());
      }
      const snippets = [];
      while ((match = snippetRegex.exec(html)) !== null) {
        snippets.push(match[1].replace(/<[^>]+>/g, '').trim());
      }
      for (let i = 0; i < Math.min(urls.length, 10); i++) {
        results.push({ title: titles[i] || '', url: urls[i], snippet: snippets[i] || '' });
      }
      return results.length > 0 ? results : null;
    } catch (e) {
      clearTimeout(timeout);
      return null;
    }
  },
};
