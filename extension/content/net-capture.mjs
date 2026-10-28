/**
 * MAIN-world network interceptor — injected at document_start into the target tab.
 * It wraps window.fetch and XMLHttpRequest to record the JSON/GraphQL RESPONSES the
 * page's own scripts fetch (the product grid of a client-rendered SPA lives there,
 * not in the HTML), together with each request's method/body/headers so the endpoint
 * can be REPLAYED for pagination. It never blocks or alters a request, never handles
 * secrets beyond keeping captured bytes in memory, and hands them back only to this
 * extension's isolated content script over a same-window postMessage handshake.
 *
 * Classic IIFE (injected as a MAIN-world content script, not a module). Defensive:
 * every hook is wrapped so a failure can never break the page.
 */
(() => {
  if (window.__eloNetInstalled) return;
  window.__eloNetInstalled = true;

  const MAX = 60;              // cap stored responses
  const MAX_BYTES = 3_000_000; // cap each body
  const store = [];
  const MAX_LOG = 250;         // cap the unfiltered request trace
  const reqlog = [];           // EVERY response: method+url+status+contentType+head (no full body)

  const abs = (u) => { try { return new URL(String(u), location.href).href; } catch { return String(u || ''); } };
  const looksJson = (ct, url, body) => {
    if (/json|graphql/i.test(ct || '')) return true;
    if (/graphql|\/api\/|\/search|queries/i.test(url || '')) { const t = (body || '').trim()[0]; return t === '{' || t === '['; }
    const t = (body || '').trim()[0];
    return t === '{' || t === '[';
  };
  // Cheap prefilter: keep only bodies that could hold products OR their prices (avoid
  // analytics/config). Price lives under many key names across sites/locales
  // (sellingPrice, finalPrice, priceData, unitPrice, prix…), so match `price` as a
  // SUBSTRING of a key, and keep `amount`/`currency` — a separately-loaded pricing
  // response (tiles in HTML, prices from an API) must be captured to be merged.
  const productish = /"[a-z0-9_]*(?:price|prix)[a-z0-9_]*"|"(?:amount|currency|name|title|sku|gtin|ean|mpn|product[_a-z]*id|productname|offers|hits|products|items|results|variants|image|slug|handle)"/i;

  const add = (rec) => {
    try {
      // Unfiltered trace FIRST (before any JSON/product filter) so a price channel we
      // don't yet parse — an RSC flight (text/x-component, body "0:[…]"), a beacon, a
      // non-JSON pricing call — is still visible by URL. Head = first 200 chars only,
      // enough to identify the body format without storing the payload.
      if (reqlog.length < MAX_LOG) {
        reqlog.push({ method: rec.method || 'GET', url: rec.url, status: rec.status ?? null, contentType: rec.contentType || '', len: (rec.body && rec.body.length) || 0, head: rec.body ? String(rec.body).slice(0, 200) : '' });
      }
      if (store.length >= MAX || !rec.body || rec.body.length > MAX_BYTES) return;
      if (!looksJson(rec.contentType, rec.url, rec.body) || !productish.test(rec.body)) return;
      store.push(rec);
    } catch { /* never throw into the page */ }
  };
  const headersToObj = (h) => {
    const out = {};
    try {
      if (!h) return out;
      if (typeof h.forEach === 'function') h.forEach((v, k) => { out[k] = v; });
      else if (Array.isArray(h)) for (const [k, v] of h) out[k] = v;
      else if (typeof h === 'object') for (const k of Object.keys(h)) out[k] = h[k];
    } catch { /* */ }
    return out;
  };

  // ── fetch ──
  try {
    const of = window.fetch;
    if (typeof of === 'function') {
      window.fetch = function (...args) {
        const input = args[0]; const init = args[1] || {};
        const url = abs(typeof input === 'string' ? input : (input && input.url) || '');
        const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
        let reqBody = null; try { reqBody = typeof init.body === 'string' ? init.body : null; } catch { /* */ }
        const headers = headersToObj(init.headers || (input && input.headers));
        return of.apply(this, args).then((res) => {
          try {
            const ct = res.headers && res.headers.get ? res.headers.get('content-type') : '';
            res.clone().text().then((body) => add({ url, method, requestBody: reqBody, headers, status: res.status, contentType: ct, body })).catch(() => {});
          } catch { /* */ }
          return res;
        });
      };
    }
  } catch { /* leave fetch untouched */ }

  // ── XMLHttpRequest ──
  try {
    const X = window.XMLHttpRequest;
    if (X && X.prototype) {
      const open = X.prototype.open, send = X.prototype.send, setH = X.prototype.setRequestHeader;
      X.prototype.open = function (method, url) { try { this.__elo = { method: String(method || 'GET').toUpperCase(), url: abs(url), headers: {} }; } catch { /* */ } return open.apply(this, arguments); };
      X.prototype.setRequestHeader = function (k, v) { try { if (this.__elo) this.__elo.headers[k] = v; } catch { /* */ } return setH.apply(this, arguments); };
      X.prototype.send = function (body) {
        try { if (this.__elo) this.__elo.requestBody = typeof body === 'string' ? body : null; } catch { /* */ }
        try {
          this.addEventListener('load', () => {
            try {
              const rt = this.responseType;
              const txt = (rt === '' || rt === 'text') ? this.responseText : (rt === 'json' && this.response ? JSON.stringify(this.response) : null);
              const ct = this.getResponseHeader ? this.getResponseHeader('content-type') : '';
              if (txt && this.__elo) add({ url: this.__elo.url, method: this.__elo.method, requestBody: this.__elo.requestBody || null, headers: this.__elo.headers || {}, status: this.status, contentType: ct, body: txt });
            } catch { /* */ }
          });
        } catch { /* */ }
        return send.apply(this, arguments);
      };
    }
  } catch { /* leave XHR untouched */ }

  // Hand the captured responses to this extension's isolated content script on demand.
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.__eloNet === 'dump') {
      try { window.postMessage({ __eloNet: 'data', captures: store.slice(-MAX), requestLog: reqlog.slice(-MAX_LOG) }, '*'); } catch { /* */ }
    }
  });
})();
