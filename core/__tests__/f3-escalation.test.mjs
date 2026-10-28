/**
 * F3.1 — browser escalation driven by the F2 `escalate` signal.
 *
 * The ladder: HTTP → validate → F1/F2 recovery → if still unrecoverable AND the
 * recovery verdict is escalate:'browser' → a BOUNDED Playwright escalation →
 * validate → back into the EXISTING pipeline. The browser is never the default
 * path (only after HTTP + recovery fail), never auto-solves a challenge, and a
 * block page is never turned into a product/discovery result.
 *
 * Offline: a Mock fetcher + injected browser spies (no real Playwright, no site).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScrape } from '../engine.mjs';
import { discoverProducts } from '../discover.mjs';

const ld = (o) => `<html><head><script type="application/ld+json">${JSON.stringify(o)}</script></head><body></body></html>`;
const productHtml = (name, price) => ld({ '@type': 'Product', name, offers: { price: String(price), priceCurrency: 'EUR' } });
const SHELL = '<html><body><div id="root"></div></body></html>';                       // JS shell (needsBrowser)
const CHALLENGE = { status: 403, body: '<html><head><title>Just a moment...</title></head><body>Checking your browser. /cdn-cgi/challenge-platform ray id</body></html>' };
const ACCESS_DENIED = { status: 403, body: '<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1><p>You don\'t have permission.</p></body></html>' };
const NOPROD = { status: 200, body: `<html><body><h1>Nos magasins</h1><p>${'texte '.repeat(400)}</p></body></html>` }; // wrong_representation, not JS, not terminal

class Mock {
  constructor(map) { this.map = map; this.calls = []; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(u) {
    this.calls.push(u); this.stats.requests++;
    const e = this.map[u] || { status: 404, body: '' };
    const status = e.error ? 0 : (e.status ?? 200);
    const ok = !e.error && status >= 200 && status < 300;
    if (ok) this.stats.ok++; else this.stats.failed++;
    return { ok, status, url: e.finalUrl || u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: e.body ?? '', bytes: null, headers: e.headers || {}, error: e.error ?? null, blocked: false };
  }
  async getText(u) { return this.get(u); }
}
// Extraction browser spy: render() returns a fixed result (per the browser.mjs contract).
const renderSpy = (result) => ({ renders: 0, async render() { this.renders++; return typeof result === 'function' ? result() : result; }, async close() {} });
const RENDER_OK = (name, price) => ({ html: productHtml(name, price), status: 200, block: null, error: null });
const RENDER_CHALLENGE = { html: null, status: 403, block: { code: 'BOT_CHALLENGE', reason: 'cf', terminal: true, retryAfter: null }, error: null };
const RENDER_TIMEOUT = { html: null, status: 0, block: { code: 'NETWORK_ERROR', reason: 'request timed out', terminal: false }, error: 'timeout' };
// Discovery browser spy: collectLinks() returns links/blocked.
const fakeBrowser = (map) => ({ calls: 0, async collectLinks(u) { this.calls++; return map[u] || { links: [], blocked: null }; } });

const run = (cfg) => runScrape({ store: { slug: 't' }, concurrency: 1, defaultProductType: null, lang: 'fr', ...cfg });

// ── extraction ──────────────────────────────────────────────────────────────

test('extraction: HTTP fails → recovery fails → browser escalates → product back in the pipeline', async () => {
  const url = 'https://www.ex.com/p/1';
  const fetcher = new Mock({ [url]: NOPROD, 'https://m.ex.com/p/1': CHALLENGE, 'https://ex.com/p/1': { status: 404 } });
  const spy = renderSpy(RENDER_OK('Chaise Browser', 59));
  const seen = [];
  const { products, report } = await run({ urls: [url], recovery: true, fetcher, browserSession: spy, onEscalation: (i) => seen.push(i) });
  assert.equal(spy.renders, 1);                         // browser WAS used (as escalation)
  assert.equal(products.length, 1);
  assert.equal(products[0].name, 'Chaise Browser');  // browser result flowed into the pipeline
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ok, true);                       // escalation trace
});

test('extraction: HTTP succeeds → browser never used', async () => {
  const url = 'https://www.ex.com/p/1';
  const fetcher = new Mock({ [url]: { body: productHtml('Direct', 20) } });
  const spy = renderSpy(RENDER_OK('X', 1));
  const { products } = await run({ urls: [url], recovery: true, fetcher, browserSession: spy });
  assert.equal(spy.renders, 0);
  assert.equal(products[0].name, 'Direct');
});

test('extraction: recovery succeeds → browser never used', async () => {
  const url = 'https://www.ex.com/p/1';
  const fetcher = new Mock({ [url]: { body: SHELL }, 'https://m.ex.com/p/1': { body: productHtml('Recovered', 30) }, 'https://ex.com/p/1': { status: 404 } });
  const spy = renderSpy(RENDER_OK('X', 1));
  const { products } = await run({ urls: [url], recovery: true, fetcher, browserSession: spy });
  assert.equal(spy.renders, 0);
  assert.equal(products[0].name, 'Recovered');
});

test('extraction: escalate absent → browser never used', async () => {
  const url = 'https://www.ex.com/p/1';
  // wrong_representation + all reps definitively 404 → escalate:'none'
  const fetcher = new Mock({ [url]: NOPROD, 'https://m.ex.com/p/1': { status: 404 }, 'https://ex.com/p/1': { status: 404 } });
  const spy = renderSpy(RENDER_OK('X', 1));
  const { products, report } = await run({ urls: [url], recovery: true, fetcher, browserSession: spy });
  assert.equal(spy.renders, 0);
  assert.equal(products.length, 0);
  assert.equal(report.notAProductPage, 1);
});

test('extraction: terminal + escalate → challenge under browser is never accepted → clean, resumable stop', async () => {
  const url = 'https://www.ex.com/p/1';
  const url2 = 'https://www.ex.com/p/2';
  const fetcher = new Mock({
    [url]: ACCESS_DENIED, 'https://m.ex.com/p/1': CHALLENGE, 'https://ex.com/p/1': { status: 404 },
    [url2]: { body: productHtml('Later', 9) },
  });
  const spy = renderSpy(RENDER_CHALLENGE);
  const { products, report } = await run({ urls: [url, url2], recovery: true, fetcher, browserSession: spy });
  assert.equal(spy.renders, 1);                         // escalated automatically…
  assert.equal(products.length, 0);                     // …but the challenge is never a product
  assert.ok(report.blocked && report.blocked.code === 'BOT_CHALLENGE');
  assert.ok(report.resumeUrls.includes(url2));          // resumable: url2 not processed
});

test('extraction: browser timeout during escalation → clean diagnostic, no crash, no product', async () => {
  const url = 'https://www.ex.com/p/1';
  const fetcher = new Mock({ [url]: NOPROD, 'https://m.ex.com/p/1': CHALLENGE, 'https://ex.com/p/1': { status: 404 } });
  const spy = renderSpy(RENDER_TIMEOUT);
  const { products, report } = await run({ urls: [url], recovery: true, fetcher, browserSession: spy });
  assert.equal(spy.renders, 1);
  assert.equal(products.length, 0);
  assert.equal(report.status, 'OK');                    // a browser timeout is not a source block
  assert.ok(report.errors.some((e) => /browser escalation: timeout/.test(e)));
});

test('extraction: flag OFF → escalation never happens (byte-identical path)', async () => {
  const url = 'https://www.ex.com/p/1';
  const fetcher = new Mock({ [url]: NOPROD, 'https://m.ex.com/p/1': CHALLENGE, 'https://ex.com/p/1': { status: 404 } });
  const spy = renderSpy(RENDER_OK('X', 1));
  const { products } = await run({ urls: [url], fetcher, browserSession: spy }); // recovery OFF
  assert.equal(spy.renders, 0);                         // no recovery → no escalate → no browser for a non-JS page
  assert.equal(products.length, 0);
});

// ── discovery ─────────────────────────────────────────────────────────────

test('discovery: blocked catalogue → recovery fails (escalate) → browser escalation → products in the pipeline', async () => {
  const shop = 'https://www.shop.be/c/cat';
  const f = new Mock({ [shop]: CHALLENGE, 'https://m.shop.be/c/cat': CHALLENGE, 'https://shop.be/c/cat': { status: 404 } });
  const fb = fakeBrowser({ [shop]: { links: ['https://www.shop.be/product/a', 'https://www.shop.be/product/b'], blocked: null } });
  const seen = [];
  const { urls, report } = await discoverProducts(f, shop, { recovery: true, getBrowser: async () => fb, onRecovery: (i) => seen.push(i) });
  assert.deepEqual(urls.map((u) => new URL(u).pathname).sort(), ['/product/a', '/product/b']);
  assert.equal(report.stopped, null);                  // browser escalation succeeded → not a stop
  assert.equal(report.browserProductUrls, 2);
  assert.ok(seen.some((s) => s.escalate === 'browser')); // the signal was produced + consumed
});

test('discovery: escalate but the browser is blocked too → clean stop, no fake results', async () => {
  const shop = 'https://www.shop.be/c/cat';
  const f = new Mock({ [shop]: CHALLENGE, 'https://m.shop.be/c/cat': CHALLENGE, 'https://shop.be/c/cat': { status: 404 } });
  const fb = fakeBrowser({ [shop]: { links: [], blocked: { code: 'BOT_CHALLENGE', reason: 'cf' } } });
  const { urls, report } = await discoverProducts(f, shop, { recovery: true, getBrowser: async () => fb });
  assert.equal(urls.length, 0);
  assert.ok(report.stopped && report.stopped.code === 'BOT_CHALLENGE');
});

test('discovery: flag OFF → recovery/escalation never runs (alt representations not fetched)', async () => {
  const shop = 'https://www.shop.be/c/cat';
  const f = new Mock({ [shop]: CHALLENGE, 'https://m.shop.be/c/cat': { body: '<html><body><a href="/product/a">a</a></body></html>' } });
  const { urls, report } = await discoverProducts(f, shop, {}); // recovery OFF, no getBrowser
  assert.equal(urls.length, 0);
  assert.ok(report.stopped && report.stopped.code);
  assert.ok(!f.calls.includes('https://m.shop.be/c/cat')); // no alternative representation was tried
});
