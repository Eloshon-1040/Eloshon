/**
 * F2 wiring — recovery ladder integrated into runScrape behind config.recovery.
 * Flag OFF is covered by the whole existing suite (byte-identical goldens); here
 * we exercise flag ON end-to-end with a mock fetcher + a browser-session spy,
 * proving the ladder feeds the EXISTING pipeline and never launches the browser
 * needlessly. Offline, deterministic (concurrency 1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScrape } from '../engine.mjs';

const ld = (obj) => `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head><body></body></html>`;
const productHtml = (name, price, extra = {}) => ld({ '@type': 'Product', name, ...extra, ...(price != null ? { offers: { price: String(price), priceCurrency: 'EUR' } } : {}) });
const SHELL = '<html><body><div id="root"></div></body></html>';
const shellWithAmp = (amp) => `<html><head><link rel="amphtml" href="${amp}"></head><body><div id="root"></div></body></html>`;
const CHALLENGE = '<html><head><title>Just a moment...</title></head><body>Checking your browser. /cdn-cgi/challenge-platform ray id</body></html>';
// Generic edge/WAF "Access Denied" body (Akamai/edgesuite shape) — NO site-specific
// markers. Stands in for any 403-gated first response the ladder must diagnose.
const ACCESS_DENIED = '<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1>'
  + "<p>You don't have permission to access this resource.</p>"
  + '<p>Reference&#32;#18.abcd1234.1700000000.deadbeef</p></body></html>';
const LONG_NOPROD = `<html><body><h1>Accueil</h1><p>${'texte '.repeat(400)}</p></body></html>`;

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
const browserSpy = () => ({ renders: 0, async render() { this.renders++; return { html: null, status: 200, block: null, error: null }; }, async close() {} });
const run = (cfg) => runScrape({ store: { slug: 't' }, concurrency: 1, defaultProductType: null, lang: 'fr', ...cfg });

test('(a) declared representation (amphtml) is recovered → fed to the pipeline, no browser', async () => {
  const url = 'https://ex.com/p/1';
  const fetcher = new Mock({ [url]: { body: shellWithAmp('https://ex.com/amp/p/1') }, 'https://ex.com/amp/p/1': { body: productHtml('Table chêne', 120) } });
  const spy = browserSpy();
  const { products, report } = await run({ urls: [url], recovery: true, fetcher, browserSession: spy });
  assert.equal(products.length, 1);
  assert.equal(products[0].name, 'Table chêne');
  assert.equal(report.recovered, 1);
  assert.equal(spy.renders, 0);            // recovered over HTTP → browser untouched
  assert.equal(report.browserRequired, 0);
});

test('(b) heuristic representation (mobile twin) is recovered when actually better', async () => {
  const url = 'https://www.ex.com/p/1';
  const fetcher = new Mock({ [url]: { body: SHELL }, 'https://m.ex.com/p/1': { body: productHtml('Lampe LED', 39.9) }, 'https://ex.com/p/1': { status: 404 } });
  const spy = browserSpy();
  const { products, report } = await run({ urls: [url], recovery: true, fetcher, browserSession: spy });
  assert.equal(products.length, 1);
  assert.equal(products[0].name, 'Lampe LED');
  assert.equal(report.recovered, 1);
  assert.equal(spy.renders, 0);
});

test('(c) a wrong (non-product) representation is rejected — no product invented', async () => {
  const url = 'https://www.ex.com/p/1';
  const fetcher = new Mock({ [url]: { body: SHELL }, 'https://m.ex.com/p/1': { body: LONG_NOPROD }, 'https://ex.com/p/1': { status: 404 } });
  const { products, report } = await run({ urls: [url], recovery: true, fetcher, useBrowser: false });
  assert.equal(products.length, 0);
  assert.equal(report.recovered || 0, 0);
});

test('(d) a challenge candidate is never taken as a product', async () => {
  const url = 'https://www.ex.com/p/1';
  const fetcher = new Mock({ [url]: { body: SHELL }, 'https://m.ex.com/p/1': { status: 403, body: CHALLENGE }, 'https://ex.com/p/1': { status: 404 } });
  const { products, report } = await run({ urls: [url], recovery: true, fetcher, useBrowser: false });
  assert.equal(products.length, 0);       // no bogus "Just a moment" product
  assert.equal(report.recovered || 0, 0);
});

test('(e) a redirect to the homepage is not accepted (identity guard)', async () => {
  const url = 'https://www.ex.com/p/1';
  const fetcher = new Mock({ [url]: { body: SHELL }, 'https://m.ex.com/p/1': { finalUrl: 'https://m.ex.com/', body: productHtml('Promo Accueil', 9.99) }, 'https://ex.com/p/1': { status: 404 } });
  const { products, report } = await run({ urls: [url], recovery: true, fetcher, useBrowser: false });
  assert.equal(products.length, 0);
  assert.ok(!products.some((p) => p.name === 'Promo Accueil'));
  assert.equal(report.recovered || 0, 0);
});

test('(f) a non-recoverable page does NOT needlessly launch the browser', async () => {
  const url = 'https://www.ex.com/p/1';
  // OK page with no product (wrong_representation, not browser-recoverable); reps fail.
  const fetcher = new Mock({ [url]: { body: LONG_NOPROD }, 'https://m.ex.com/p/1': { status: 404 }, 'https://ex.com/p/1': { status: 404 } });
  const spy = browserSpy();
  const { products, report } = await run({ urls: [url], recovery: true, fetcher, browserSession: spy });
  assert.equal(products.length, 0);
  assert.equal(spy.renders, 0);            // browser not triggered for a non-recoverable OK page
  assert.equal(report.notAProductPage, 1);
});

test('(g) maxAttempts is respected (stops before trying a later working representation)', async () => {
  const url = 'https://www.ex.com/p/1';
  const fetcher = new Mock({
    [url]: { body: shellWithAmp('https://ex.com/amp/p/1') }, // declared amphtml first
    'https://ex.com/amp/p/1': { status: 404 },               // first candidate fails
    'https://m.ex.com/p/1': { body: productHtml('Would Work', 5) }, // would succeed, but not reached
    'https://ex.com/p/1': { status: 404 },
  });
  const { products } = await run({ urls: [url], recovery: true, recoveryMaxAttempts: 1, fetcher, useBrowser: false });
  assert.equal(products.length, 0);
  assert.ok(!fetcher.calls.includes('https://m.ex.com/p/1')); // stopped after 1 attempt
});

test('(h) flag OFF vs ON: OFF = current behaviour, ON recovers', async () => {
  const url = 'https://www.ex.com/p/1';
  const map = { [url]: { body: SHELL }, 'https://m.ex.com/p/1': { body: productHtml('Chaise', 49) }, 'https://ex.com/p/1': { status: 404 } };
  const off = await run({ urls: [url], fetcher: new Mock(map), useBrowser: false });                 // flag OFF (default)
  assert.equal(off.products.length, 0);   // JS shell + no browser → nothing (unchanged behaviour)
  const on = await run({ urls: [url], recovery: true, fetcher: new Mock(map), useBrowser: false });   // flag ON
  assert.equal(on.products.length, 1);
  assert.equal(on.products[0].name, 'Chaise');
});

test('(i) onRecovery observability hook receives an explainable trace', async () => {
  const url = 'https://www.ex.com/p/1';
  const fetcher = new Mock({ [url]: { body: SHELL }, 'https://m.ex.com/p/1': { body: productHtml('Sac', 25) }, 'https://ex.com/p/1': { status: 404 } });
  const seen = [];
  await run({ urls: [url], recovery: true, fetcher, useBrowser: false, onRecovery: (i) => seen.push(i) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ok, true);
  assert.ok(Array.isArray(seen[0].trace) && seen[0].trace.length >= 1);
  assert.equal(seen[0].via.url, 'https://m.ex.com/p/1');
});

// ── terminal-response recovery: a hard block (Access Denied / challenge) is now
//    ALSO offered the ladder before the engine gives up. Generic robustness — the
//    real-world "first fetch is 403 Access Denied" case (e.g. Akamai on a category
//    URL), proven with a local fixture and ZERO site-specific logic.

test('(j) a terminal Access-Denied response is diagnosed and recovered via an alternative representation (no browser, no bypass)', async () => {
  const url = 'https://www.shop.com/cat/p/1';
  const fetcher = new Mock({
    [url]: { status: 403, body: ACCESS_DENIED },                          // hard block on the first fetch
    'https://m.shop.com/cat/p/1': { body: productHtml('Jean 511', 89.9) }, // mobile twin not gated
    'https://shop.com/cat/p/1': { status: 404 },
  });
  const spy = browserSpy();
  const { products, report } = await run({ urls: [url], recovery: true, fetcher, browserSession: spy });
  assert.equal(products.length, 1);
  assert.equal(products[0].name, 'Jean 511');                          // real product from the alt representation
  assert.ok(!products.some((p) => /access denied/i.test(p.name || ''))); // the block page NEVER becomes a product
  assert.equal(report.recovered, 1);
  assert.equal(spy.renders, 0);                                           // recovered over HTTP → browser untouched
  assert.equal(report.browserRequired, 0);
});

test('(k) a terminal block with no working representation stops cleanly — diagnosed, never a bogus product', async () => {
  const url = 'https://www.shop.com/cat/p/1';
  const fetcher = new Mock({
    [url]: { status: 403, body: ACCESS_DENIED },
    'https://m.shop.com/cat/p/1': { status: 403, body: ACCESS_DENIED },   // twin also blocked
    'https://shop.com/cat/p/1': { status: 403, body: ACCESS_DENIED },     // apex too
  });
  const spy = browserSpy();
  const { products, report } = await run({ urls: [url], recovery: true, fetcher, browserSession: spy });
  assert.equal(products.length, 0);
  assert.equal(report.recovered || 0, 0);
  assert.ok(report.blocked);                     // surfaced as blocked, not silently empty
  assert.equal(report.status, report.blocked.code);
  assert.equal(spy.renders, 0);                  // non-interactive → no browser bypass attempted
});

test('(l) the same terminal path also recovers a challenge original (generic, not Access-Denied-specific)', async () => {
  const url = 'https://www.shop.com/p/9';
  const fetcher = new Mock({
    [url]: { status: 403, body: CHALLENGE },                    // Cloudflare "Just a moment"
    'https://m.shop.com/p/9': { body: productHtml('Sac à dos', 59) },
    'https://shop.com/p/9': { status: 404 },
  });
  const spy = browserSpy();
  const { products, report } = await run({ urls: [url], recovery: true, fetcher, browserSession: spy });
  assert.equal(products.length, 1);
  assert.equal(products[0].name, 'Sac à dos');
  assert.equal(report.recovered, 1);
  assert.equal(spy.renders, 0);                  // recovered over HTTP before any browser escalation
});

test('(m) flag OFF: a terminal Access-Denied stops exactly as today (no recovery, no browser)', async () => {
  const url = 'https://www.shop.com/cat/p/1';
  const map = {
    [url]: { status: 403, body: ACCESS_DENIED },
    'https://m.shop.com/cat/p/1': { body: productHtml('Jean 511', 89.9) }, // would recover IF the flag were on
    'https://shop.com/cat/p/1': { status: 404 },
  };
  const spy = browserSpy();
  const { products, report } = await run({ urls: [url], fetcher: new Mock(map), browserSession: spy }); // flag OFF (default)
  assert.equal(products.length, 0);              // unchanged behaviour: hard block → nothing
  assert.equal(report.recovered || 0, 0);        // recovery never runs
  assert.ok(report.blocked);                     // still diagnosed + resumable
  assert.equal(spy.renders, 0);
});
