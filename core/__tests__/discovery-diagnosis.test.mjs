/**
 * Generic discovery hardening (Levi's / index-heavy retailers as the real case):
 *  1) sitemap-index traversal is LEAF-FIRST — an index of many indexes no longer
 *     starves the product leaves (was: 40 index reads → 0 URLs).
 *  2) a 403/503 carrying the fetcher's synthetic `HTTP <status>` error string is
 *     classified by its STATUS (ACCESS_DENIED / BOT_CHALLENGE), not mislabelled
 *     NETWORK_ERROR — so the crawl avenue stops honestly and the ladder engages.
 *  3) discovery ends with an explicit `diagnosis` (blocked / needs-browser /
 *     structured-undetected / no-signal / ok), never a bare "none-found".
 * Offline: pure functions + a mock fetcher.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyResponse, STATUS } from '../detect.mjs';
import { discoverFromSitemaps } from '../sitemap.mjs';
import { discoverProducts, PRODUCT_RE } from '../discover.mjs';
import { runScrape } from '../engine.mjs';

// ── product-URL precision (content paths under /p/ are not products) ──────────
test('PRODUCT_RE: /p/<slug> is a product; /p/wiki|video|guide|... are not', () => {
  assert.ok(PRODUCT_RE.test('https://shop/p/black-shirt-123'));
  assert.ok(PRODUCT_RE.test('https://shop/p/produit-0/p100000'));
  assert.ok(!PRODUCT_RE.test('https://nl.aliexpress.com/p/wiki/home.html'));
  assert.ok(!PRODUCT_RE.test('https://nl.aliexpress.com/p/video/home.html'));
  assert.ok(!PRODUCT_RE.test('https://shop/p/guide/how-to'));
  assert.ok(PRODUCT_RE.test('https://shop/item/1005006123456789.html'));
});

// ── mock fetcher mirroring the REAL fetcher contract (non-2xx → error:`HTTP n`) ─
class Mock {
  constructor(map) { this.map = map; this.reads = []; this.stats = { requests: 0 }; this.userAgent = 't'; }
  async get(url) {
    this.reads.push(url); this.stats.requests++;
    const e = this.map[url] || { status: 404 };
    const status = e.status ?? 200;
    const ok = status >= 200 && status < 300;
    const body = ok ? (e.body ?? '') : '';
    return { ok, status, url, requestedUrl: url, contentType: e.ct || 'text/html', kind: 'html', body, bytes: null, headers: {}, error: ok ? null : `HTTP ${status}`, blocked: !ok };
  }
  async getText(url) { return this.get(url); }
}

const urlset = (urls) => `<?xml version="1.0"?><urlset>${urls.map((u) => `<loc>${u}</loc>`).join('')}</urlset>`;
const smindex = (locs) => `<?xml version="1.0"?><sitemapindex>${locs.map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join('')}</sitemapindex>`;

// ── 1) sitemap index starvation ──────────────────────────────────────────────
test('sitemap: an index of 50 country indexes still reaches product leaves (leaf-first, no starvation)', async () => {
  const map = {};
  const hints = [];
  for (let c = 0; c < 50; c++) {                       // 50 locale indexes, like a global retailer
    const idx = `https://x.com/C${c}/sitemap.xml`;
    hints.push(idx);
    const leaves = [];
    for (let p = 0; p < 5; p++) leaves.push(`https://x.com/C${c}/Product-${p}.xml`); // 5 product leaves each
    map[idx] = { body: smindex([`https://x.com/C${c}/pages.xml`, ...leaves]) };
    map[`https://x.com/C${c}/pages.xml`] = { body: urlset([`https://x.com/C${c}/about`]) };
    for (let p = 0; p < 5; p++) {
      // NOTE: product URLs here carry NO product keyword — they must still be
      // taken because they come from a product-named ("Product-*") leaf sitemap.
      map[`https://x.com/C${c}/Product-${p}.xml`] = { body: urlset([`https://x.com/C${c}/a-${p}`, `https://x.com/C${c}/b-${p}`]) };
    }
  }
  const f = new Mock(map);
  // maxSitemaps deliberately smaller than the 50 indexes → a BFS would read only
  // indexes and return 0. Leaf-first must still find URLs.
  const res = await discoverFromSitemaps(f, 'https://x.com', { max: 30, maxSitemaps: 20, hint: hints });
  assert.ok(res.urls.length >= 10, `expected product URLs, got ${res.urls.length}`);
  assert.ok(res.urls.every((u) => /\/(a|b)-\d$/.test(u)), 'only product-leaf URLs returned');
  assert.ok(res.sitemapsRead.some((s) => /Product-\d\.xml$/.test(s)), 'at least one product leaf was actually read');
});

// ── 2) status-aware classification (synthetic HTTP error must not shadow status) ─
test('detect: 403 with a synthetic "HTTP 403" error → ACCESS_DENIED (terminal), not NETWORK_ERROR', () => {
  const r = classifyResponse({ status: 403, error: 'HTTP 403', body: '', headers: {} });
  assert.equal(r.code, STATUS.ACCESS_DENIED);
  assert.equal(r.terminal, true);
});
test('detect: 503 with "HTTP 503" error → BOT_CHALLENGE; 404 → NOT_FOUND (non-terminal)', () => {
  assert.equal(classifyResponse({ status: 503, error: 'HTTP 503', body: '', headers: {} }).code, STATUS.BOT_CHALLENGE);
  const nf = classifyResponse({ status: 404, error: 'HTTP 404', body: '', headers: {} });
  assert.equal(nf.code, STATUS.NOT_FOUND); assert.equal(nf.terminal, false);
});
test('detect: a genuine transport failure (no status) is still NETWORK_ERROR', () => {
  assert.equal(classifyResponse({ status: 0, error: 'timeout' }).code, STATUS.NETWORK_ERROR);
  assert.equal(classifyResponse({ status: 0, error: 'getaddrinfo ENOTFOUND (ENOTFOUND)' }).code, STATUS.NETWORK_ERROR);
});

// ── 3) end-of-run diagnosis (never a bare none-found) ─────────────────────────
test('discovery diagnosis: entry blocked by 403 → diagnosis "blocked" (not none-found)', async () => {
  const f = new Mock({ 'https://shop.test': { status: 403 } }); // robots + sitemaps 404, entry 403
  const { urls, report } = await discoverProducts(f, 'https://shop.test', { maxProducts: 10 });
  assert.equal(urls.length, 0);
  assert.equal(report.diagnosis, 'blocked');
  assert.ok(report.stopped && report.stopped.code === STATUS.ACCESS_DENIED);
});

test('discovery diagnosis: reachable SSR page with only nav links → "no-signal"', async () => {
  const nav = `<html><body>${Array.from({ length: 12 }, (_, i) => `<a href="/section-${i}">S${i}</a>`).join('')}</body></html>`;
  const f = new Mock({ 'https://shop.test': { body: nav } });
  const { urls, report } = await discoverProducts(f, 'https://shop.test', { maxProducts: 10 });
  assert.equal(urls.length, 0);
  assert.equal(report.diagnosis, 'no-signal');
});

test('discovery diagnosis: page carries JSON-LD but no product URLs → "structured-undetected"', async () => {
  const ld = `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'Organization', name: 'X' })}</script></head><body><a href="/company/about">About</a></body></html>`;
  const f = new Mock({ 'https://shop.test': { body: ld } });
  const { urls, report } = await discoverProducts(f, 'https://shop.test', { maxProducts: 10 });
  assert.equal(urls.length, 0);
  assert.equal(report.diagnosis, 'structured-undetected');
});

test('engine: surfaces the discovery diagnosis + an actionable note when 0 products found', async () => {
  const f = new Mock({ 'https://shop.test': { status: 403 } });
  const { products, report } = await runScrape({ store: { slug: 't' }, origin: 'https://shop.test', concurrency: 1, defaultProductType: 'other', useBrowser: false, fetcher: f });
  assert.equal(products.length, 0);
  assert.equal(report.discoveryDiagnosis, 'blocked');
  assert.ok(report.notes.some((n) => /reason: blocked/.test(n)), 'a human-readable reason note is present');
});

test('discovery diagnosis: sitemap yields products → diagnosis "ok"', async () => {
  const f = new Mock({
    'https://shop.test/robots.txt': { body: 'Sitemap: https://shop.test/sitemap.xml' },
    'https://shop.test/sitemap.xml': { body: urlset(Array.from({ length: 8 }, (_, i) => `https://shop.test/product/p${i}`)) },
  });
  const { urls, report } = await discoverProducts(f, 'https://shop.test', { maxProducts: 50 });
  assert.ok(urls.length >= 5);
  assert.equal(report.method, 'sitemap');
  assert.equal(report.diagnosis, 'ok');
});
