/**
 * Bright Data Scraping Browser tier (v0.5.7) — offline. The CDP connection is MOCKED
 * (a fake browser/context/page injected via `connect`), so no real, billed session is
 * ever opened. Pins the credential/CDP-URL resolution, the render happy path, the
 * hydration wait, byte + runtime tracking, and — critically — that the session is
 * ALWAYS closed (success AND error), since it is billed by the hour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrapingBrowserConfig, scrapingBrowserAvailable, scrapingBrowserRender, DEFAULT_BROWSER_ZONE, SUPERPROXY_HOST } from '../unlock/scraping-browser.mjs';

test('scrapingBrowserConfig: full browserAuth wins; else built from customerId+password; defaults', () => {
  const a = scrapingBrowserConfig({ brightData: { browserAuth: 'brd-customer-CID-zone-mcp_browser:PW' } }, {});
  assert.equal(a.configured, true);
  assert.equal(a.cdpUrl, `wss://brd-customer-CID-zone-mcp_browser:PW@${SUPERPROXY_HOST}:9222`);
  // Constructed from parts (zone defaults to mcp_browser).
  const b = scrapingBrowserConfig({ brightData: { customerId: 'hl_abc', browserPassword: 'secret' } }, {});
  assert.equal(b.zone, DEFAULT_BROWSER_ZONE);
  assert.equal(b.cdpUrl, `wss://brd-customer-hl_abc-zone-mcp_browser:secret@${SUPERPROXY_HOST}:9222`);
  // From env, incl. the hyphen-free names.
  const c = scrapingBrowserConfig({}, { BROWSER_AUTH: 'brd-customer-x-zone-mcp_browser:p' });
  assert.equal(c.configured, true);
  const d = scrapingBrowserConfig({}, { BRD_CUSTOMER_ID: 'cid', BRD_BROWSER_PASSWORD: 'pw', BRD_BROWSER_ZONE: 'mcp_browser' });
  assert.match(d.cdpUrl, /brd-customer-cid-zone-mcp_browser:pw@/);
  // Unconfigured → inert.
  assert.equal(scrapingBrowserConfig({}, {}).configured, false);
  assert.equal(scrapingBrowserAvailable({}, {}), false);
  assert.equal(scrapingBrowserAvailable({ brightData: { browserAuth: 'x:y' } }, {}), true);
});

test('scrapingBrowserConfig: per-call country adds the -country-xx username suffix (geo-targeting)', () => {
  const env = { BROWSER_AUTH: 'brd-customer-hl_x-zone-mcp_browser:pw' };
  const us = scrapingBrowserConfig({}, env, { country: 'US' });
  assert.equal(us.country, 'us');
  assert.equal(us.cdpUrl, `wss://brd-customer-hl_x-zone-mcp_browser-country-us:pw@${SUPERPROXY_HOST}:9222`);
  // No country → unchanged; an invalid code is ignored; a pinned country is not doubled.
  assert.equal(scrapingBrowserConfig({}, env).cdpUrl, `wss://brd-customer-hl_x-zone-mcp_browser:pw@${SUPERPROXY_HOST}:9222`);
  assert.equal(scrapingBrowserConfig({}, env, { country: 'belgium' }).country, null);
  const pinned = scrapingBrowserConfig({}, { BROWSER_AUTH: 'brd-customer-hl_x-zone-mcp_browser-country-be:pw' }, { country: 'us' });
  assert.match(pinned.cdpUrl, /-country-be:pw@/);
  assert.doesNotMatch(pinned.cdpUrl, /-country-us/);
});

// A minimal fake Playwright browser graph that records what happened.
function makeFakeBrowser({ throwOnGoto = false, html = '<html>' + 'x'.repeat(400) + '</html>', responses = [] } = {}) {
  const rec = { closed: false, gotoUrl: null, waited: null, newPages: 0 };
  const page = {
    goto: async (u) => { rec.gotoUrl = u; if (throwOnGoto) throw new Error('nav blocked'); },
    waitForSelector: async (sel) => { rec.waited = sel; },
    content: async () => html,
  };
  const ctx = { on: (evt, cb) => { for (const r of responses) cb(r); }, newPage: async () => { rec.newPages++; return page; } };
  const browser = { contexts: () => [ctx], newContext: async () => ctx, close: async () => { rec.closed = true; } };
  return { browser, rec };
}

test('scrapingBrowserRender: renders HTML, waits for the selector, tracks bytes + runtime, closes the session', async () => {
  const { browser, rec } = makeFakeBrowser({ responses: [{ headers: () => ({ 'content-length': '1024' }) }, { headers: () => ({ 'content-length': '2048' }) }] });
  let connectedTo = null;
  const connect = async (cdpUrl) => { connectedTo = cdpUrl; return browser; };
  const r = await scrapingBrowserRender('https://www.adidas.com/us/men-shoes', { cdpUrl: 'wss://auth@brd.superproxy.io:9222', waitSelector: '[data-testid="plp-product-card"]', connect });
  assert.equal(r.ok, true);
  assert.ok(r.html.includes('<html>'));
  assert.equal(r.bytes, 3072);                 // 1024 + 2048 from response content-length
  assert.ok(r.runtimeSec >= 0);
  assert.equal(connectedTo, 'wss://auth@brd.superproxy.io:9222');
  assert.equal(rec.gotoUrl, 'https://www.adidas.com/us/men-shoes');
  assert.equal(rec.waited, '[data-testid="plp-product-card"]');
  assert.equal(rec.closed, true);              // session released
});

test('scrapingBrowserRender: closes the session even when navigation throws (billed by the hour)', async () => {
  const { browser, rec } = makeFakeBrowser({ throwOnGoto: true });
  const r = await scrapingBrowserRender('https://x', { cdpUrl: 'wss://a@h:9222', connect: async () => browser });
  assert.equal(r.ok, false);
  assert.match(r.error, /nav blocked/);
  assert.equal(rec.closed, true);              // STILL closed on error
});

test('scrapingBrowserRender: aborts image/media/font (cost control), keeps document/script/xhr', async () => {
  const decisions = {};
  let routeHandler = null;
  const page = {
    route: async (_pattern, h) => { routeHandler = h; },
    goto: async () => {
      // Simulate the browser requesting sub-resources through the route handler.
      for (const t of ['document', 'script', 'xhr', 'fetch', 'stylesheet', 'image', 'media', 'font']) {
        routeHandler({ request: () => ({ resourceType: () => t }), abort: async () => { decisions[t] = 'abort'; }, continue: async () => { decisions[t] = 'continue'; } });
      }
    },
    waitForSelector: async () => {}, content: async () => 'z'.repeat(400),
  };
  const ctx = { on: () => {}, newPage: async () => page };
  const browser = { contexts: () => [ctx], close: async () => {} };
  const r = await scrapingBrowserRender('https://x', { cdpUrl: 'wss://a@h:9222', connect: async () => browser });
  assert.equal(r.ok, true);
  for (const t of ['image', 'media', 'font']) assert.equal(decisions[t], 'abort', `${t} must be aborted`);
  for (const t of ['document', 'script', 'xhr', 'fetch', 'stylesheet']) assert.equal(decisions[t], 'continue', `${t} must continue`);
});

test('scrapingBrowserRender: bytes come from CDP encodedDataLength when available; waits with state:attached', async () => {
  const handlers = {};
  let waitOpts = null;
  const cdp = { on: (evt, cb) => { handlers[evt] = cb; }, send: async () => {} };
  const page = {
    goto: async () => { handlers['Network.loadingFinished']({ encodedDataLength: 50000 }); handlers['Network.loadingFinished']({ encodedDataLength: 25000 }); },
    waitForSelector: async (_sel, opts) => { waitOpts = opts; }, content: async () => 'q'.repeat(400),
  };
  const ctx = { on: () => {}, newPage: async () => page, newCDPSession: async () => cdp };
  const browser = { contexts: () => [ctx], close: async () => {} };
  const r = await scrapingBrowserRender('https://x', { cdpUrl: 'wss://a@h:9222', waitSelector: 'script#__NEXT_DATA__', connect: async () => browser });
  assert.equal(r.bytes, 75000);
  assert.equal(r.bytesSource, 'cdp');
  assert.equal(waitOpts.state, 'attached');
});

test('scrapingBrowserRender: waits for Bright Data challenge solving (Captcha.solve) after navigation', async () => {
  const sent = [];
  const cdp = { on: () => {}, send: async (m, p) => { sent.push([m, p]); return m === 'Captcha.solve' ? { status: 'solve_finished' } : {}; } };
  const order = [];
  const page = { goto: async () => { order.push('goto'); }, waitForSelector: async () => { order.push('wait'); }, content: async () => 'w'.repeat(400) };
  const ctx = { on: () => {}, newPage: async () => page, newCDPSession: async () => cdp };
  const browser = { contexts: () => [ctx], close: async () => {} };
  const r = await scrapingBrowserRender('https://x', { cdpUrl: 'wss://a@h:9222', waitSelector: '#grid', connect: async () => browser });
  assert.equal(r.captcha, 'solve_finished');
  const solve = sent.find(([m]) => m === 'Captcha.solve');
  assert.ok(solve, 'Captcha.solve must be sent');
  // Live-verified 2026-09-28: Bright Data rejects any `timeout` key
  // ('Protocol error (Captcha.solve): "timeout" is not allowed') — detectTimeout only.
  assert.equal(solve[1].detectTimeout, 10000);
  assert.equal('timeout' in solve[1], false);
  assert.deepEqual(order, ['goto', 'wait']);   // solve happens between navigation and the element wait
  // Opt-out works (e.g. a site where the probe is unwanted).
  sent.length = 0;
  await scrapingBrowserRender('https://x', { cdpUrl: 'wss://a@h:9222', solveCaptcha: false, connect: async () => browser });
  assert.equal(sent.some(([m]) => m === 'Captcha.solve'), false);
});

test('scrapingBrowserRender: a failing Captcha.solve is recorded with its reason, and the render still completes', async () => {
  const cdp = { on: () => {}, send: async (m) => { if (m === 'Captcha.solve') throw new Error("'Captcha.solve' wasn't found"); return {}; } };
  const page = { goto: async () => {}, waitForSelector: async () => {}, content: async () => 'v'.repeat(400) };
  const ctx = { on: () => {}, newPage: async () => page, newCDPSession: async () => cdp };
  const r = await scrapingBrowserRender('https://x', { cdpUrl: 'wss://a@h:9222', connect: async () => ({ contexts: () => [ctx], close: async () => {} }) });
  assert.equal(r.ok, true);
  assert.match(r.captcha, /^unavailable: .*wasn't found/);
});

test('scrapingBrowserRender: a connect error never leaks the zone password (redacted)', async () => {
  const connect = async () => { throw new Error('browserType.connectOverCDP: WebSocket error: wss://brd-customer-hl_abc123-zone-mcp_browser:s3cr3tpw@brd.superproxy.io:9222 403 Forbidden'); };
  const r = await scrapingBrowserRender('https://x', { cdpUrl: 'wss://brd-customer-hl_abc123-zone-mcp_browser:s3cr3tpw@brd.superproxy.io:9222', connect });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error, /s3cr3tpw/);
  assert.doesNotMatch(r.error, /hl_abc123/);
  assert.match(r.error, /403 Forbidden/); // the useful part survives
});

test('scrapingBrowserRender: inert when unconfigured (no cdpUrl) — never connects', async () => {
  let connected = false;
  const r = await scrapingBrowserRender('https://x', { cdpUrl: null, connect: async () => { connected = true; return {}; } });
  assert.equal(r.ok, false);
  assert.equal(r.note, 'not_configured');
  assert.equal(connected, false);
});
