/**
 * Robustness tests: the engine must DETECT protections/abnormal responses,
 * never treat a challenge as a product, stop the source cleanly, keep recovered
 * products, and never bypass anything. Deterministic, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyResponse, STATUS } from '../detect.mjs';
import { runScrape } from '../engine.mjs';

const product = (name) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name, offers: { price: 1.5, priceCurrency: 'EUR' } })}</script></head><body>ok</body></html>`;
const CF = '<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing. /cdn-cgi/challenge-platform ray id</body></html>';

// ── classifier fixtures ──────────────────────────────────────────────────────
test('403 plain → ACCESS_DENIED (terminal)', () => {
  const v = classifyResponse({ status: 403, body: 'Forbidden' });
  assert.equal(v.code, STATUS.ACCESS_DENIED); assert.equal(v.terminal, true);
});
test('403 + Cloudflare body → BOT_CHALLENGE', () => {
  assert.equal(classifyResponse({ status: 403, body: CF }).code, STATUS.BOT_CHALLENGE);
});
test('503 → BOT_CHALLENGE', () => {
  assert.equal(classifyResponse({ status: 503, body: '' }).code, STATUS.BOT_CHALLENGE);
});
test('429 + Retry-After → RATE_LIMITED with retryAfter', () => {
  const v = classifyResponse({ status: 429, body: '', headers: { 'retry-after': '120' } });
  assert.equal(v.code, STATUS.RATE_LIMITED); assert.equal(v.retryAfter, 120); assert.equal(v.terminal, true);
});
test('200 "just a moment" → BOT_CHALLENGE', () => {
  assert.equal(classifyResponse({ status: 200, body: CF }).code, STATUS.BOT_CHALLENGE);
});
test('200 checking your browser → BOT_CHALLENGE', () => {
  assert.equal(classifyResponse({ status: 200, body: '<html>Checking your browser…</html>' }).code, STATUS.BOT_CHALLENGE);
});
test('reCAPTCHA page → CAPTCHA', () => {
  assert.equal(classifyResponse({ status: 200, body: '<div class="g-recaptcha"></div> verify you are human' }).code, STATUS.CAPTCHA);
});
test('hCaptcha page → CAPTCHA', () => {
  assert.equal(classifyResponse({ status: 200, body: '<script src="https://hcaptcha.com/1/api.js"></script>' }).code, STATUS.CAPTCHA);
});
test('401 → AUTH_REQUIRED', () => {
  assert.equal(classifyResponse({ status: 401, body: '' }).code, STATUS.AUTH_REQUIRED);
});
test('redirect to /cdn-cgi/challenge → BOT_CHALLENGE', () => {
  const v = classifyResponse({ status: 200, requestedUrl: 'https://s/p/1', url: 'https://s/cdn-cgi/challenge', body: 'x' });
  assert.equal(v.code, STATUS.BOT_CHALLENGE);
});
test('empty 200 body → NOT_A_PRODUCT_PAGE, or JS_REQUIRED when SPA', () => {
  assert.equal(classifyResponse({ status: 200, body: '   ' }).code, STATUS.NOT_A_PRODUCT_PAGE);
  assert.equal(classifyResponse({ status: 200, body: '   ', needsBrowser: true }).code, STATUS.JAVASCRIPT_REQUIRED);
});
test('timeout / network error → NETWORK_ERROR (not terminal)', () => {
  const v = classifyResponse({ status: 0, error: 'timeout' });
  assert.equal(v.code, STATUS.NETWORK_ERROR); assert.equal(v.terminal, false);
});
test('unexpected JSON on a product URL is not a challenge/captcha', () => {
  const v = classifyResponse({ status: 200, contentType: 'application/json', body: '{"foo":1,"bar":' + '"x"'.padEnd(500, 'x') + '}' });
  assert.notEqual(v.code, STATUS.BOT_CHALLENGE);
  assert.notEqual(v.code, STATUS.CAPTCHA);
});
test('valid product page → OK', () => {
  assert.equal(classifyResponse({ status: 200, body: product('X') }).code, STATUS.OK);
});

// ── engine-level: stop cleanly on a challenge, keep recovered products ────────
class MockFetcher {
  constructor(map) { this.map = map; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 'test'; }
  async get(url) {
    this.stats.requests++;
    const r = this.map[url] || { status: 404, body: '' };
    const ok = r.status >= 200 && r.status < 300;
    return { ok, status: r.status, url: r.url || url, requestedUrl: url, contentType: 'text/html', kind: 'html', body: r.body || '', bytes: null, headers: r.headers || {}, error: r.error || null, blocked: false };
  }
  async getText(url) { return this.get(url); }
}

test('engine stops safely on BOT_CHALLENGE, keeps products, reports remaining, no false product', async () => {
  const urls = ['https://s/p/1', 'https://s/p/2', 'https://s/p/3'];
  const fetcher = new MockFetcher({
    'https://s/p/1': { status: 200, body: product('Café 250g') },
    'https://s/p/2': { status: 403, body: CF },       // challenge → stop
    'https://s/p/3': { status: 200, body: product('Riz 1kg') },
  });
  const { products, report } = await runScrape({
    store: { slug: 'test' }, urls, concurrency: 1, defaultProductType: 'other', fetcher,
  });
  assert.equal(report.status, STATUS.BOT_CHALLENGE);
  assert.ok(report.blocked && report.blocked.code === STATUS.BOT_CHALLENGE);
  assert.equal(products.length, 1);               // only p/1 recovered before the block
  assert.equal(products[0].name, 'Café 250g'); // the challenge page did NOT become a product
  assert.ok(report.remaining >= 1);               // p/3 left for resume
  assert.ok(report.resumeUrls.includes('https://s/p/3'));
});

test('engine: network error on one URL does not stop the source', async () => {
  const urls = ['https://s/p/1', 'https://s/p/2'];
  const fetcher = new MockFetcher({
    'https://s/p/1': { status: 0, error: 'timeout' },
    'https://s/p/2': { status: 200, body: product('Thé vert') },
  });
  const { products, report } = await runScrape({ store: { slug: 'test' }, urls, concurrency: 1, defaultProductType: 'other', fetcher });
  assert.equal(report.status, STATUS.OK);
  assert.equal(report.networkErrors, 1);
  assert.equal(products.length, 1);
});

test('engine: circuit breaker stops after repeated network failures (no hammering)', async () => {
  const urls = Array.from({ length: 20 }, (_, i) => `https://s/p/${i}`);
  const map = {}; urls.forEach((u) => { map[u] = { status: 0, error: 'timeout' }; });
  const fetcher = new MockFetcher(map);
  const { report } = await runScrape({ store: { slug: 'test' }, urls, concurrency: 1, breaker: 6, fetcher });
  assert.equal(report.status, STATUS.NETWORK_ERROR);
  assert.ok(report.blocked && /circuit breaker/.test(report.blocked.reason));
  assert.ok(fetcher.stats.requests <= 7);   // stopped ~breaker, did not hit all 20
  assert.ok(report.remaining > 0);
});

test('engine: CSR page (empty shell) → browser fallback renders + extracts product', async () => {
  const shell = '<html><body><div id="root"></div></body></html>';
  const fetcher = new MockFetcher({ 'https://s/product/x': { status: 200, body: shell } });
  const fakeSession = { calls: 0, async render() { this.calls++; return { html: product('Rendered Product'), status: 200, block: null, error: null }; }, async close() {} };
  const { products, report } = await runScrape({ store: { slug: 'test' }, urls: ['https://s/product/x'], concurrency: 1, defaultProductType: 'other', fetcher, browserSession: fakeSession });
  assert.equal(fakeSession.calls, 1);
  assert.equal(report.browserUsed, 1);
  assert.equal(products.length, 1);
  assert.equal(products[0].name, 'Rendered Product');
});

test('engine: challenge detected UNDER the browser → stop, no bypass', async () => {
  const shell = '<html><body><div id="app"></div></body></html>';
  const fetcher = new MockFetcher({ 'https://s/product/1': { status: 200, body: shell }, 'https://s/product/2': { status: 200, body: shell } });
  const blockedSession = { async render() { return { html: null, status: 403, block: { code: STATUS.BOT_CHALLENGE, reason: 'cf under browser', terminal: true, retryAfter: null }, error: null }; }, async close() {} };
  const { products, report } = await runScrape({ store: { slug: 'test' }, urls: ['https://s/product/1', 'https://s/product/2'], concurrency: 1, defaultProductType: 'other', fetcher, browserSession: blockedSession });
  assert.equal(report.status, STATUS.BOT_CHALLENGE);
  assert.equal(products.length, 0);
});

test('engine: OK page with no product → not-a-product, not an error, not a product', async () => {
  const fetcher = new MockFetcher({ 'https://s/x': { status: 200, body: '<html><body><h1>About us</h1><p>' + 'x '.repeat(1200) + '</p></body></html>' } });
  const { products, report } = await runScrape({ store: { slug: 'test' }, urls: ['https://s/x'], concurrency: 1, fetcher });
  assert.equal(products.length, 0);
  assert.equal(report.notAProductPage, 1);
  assert.equal(report.status, STATUS.OK);
});
