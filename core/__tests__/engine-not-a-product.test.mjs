/**
 * 4a — a fetched "product" URL with NO price, NO sku, NO gtin is not a product:
 *  - if it exposes a GRID of same-host product links it is a LISTING → its links
 *    are harvested into the queue and the page is dropped (never emitted);
 *  - a real product (has a price) is untouched;
 *  - a data-less page with only a few product links (a genuine on-request /
 *    "sur devis" product) is KEPT as a product, never dropped.
 * Generic — no site rules. Offline: mock fetcher.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScrape } from '../engine.mjs';

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
}
const run = (cfg) => runScrape({ store: { slug: 't' }, concurrency: 2, useBrowser: false, defaultProductType: null, lang: 'fr', ...cfg });
const fiche = (name, price) => `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"${name}","offers":{"@type":"Offer","price":"${price}","priceCurrency":"EUR"}}</script>`;

test('a category (no price, many product links) → reclassified, links harvested, page not a product', async () => {
  const cat = 'https://s.com/category/jeans';
  const hrefs = Array.from({ length: 8 }, (_, i) => `/product/p${i}`);
  const map = { [cat]: { body: `<html><head><meta property="og:title" content="Jeans"></head><body>${hrefs.map((h) => `<a href="${h}">x</a>`).join('')}</body></html>` } };
  for (const h of hrefs) map[`https://s.com${h}`] = { body: fiche(`Jean ${h}`, 49.9) };
  const products = [];
  const { report } = await run({ urls: [cat], fetcher: new Mock(map), onProduct: (p) => products.push(p) });
  assert.equal(report.reclassifiedListings, 1, 'the category was reclassified as a listing');
  assert.equal(report.harvestedLinks, 8);
  assert.equal(products.length, 8, 'the 8 harvested fiches, never the category page');
  assert.ok(products.every((p) => p.price != null));
  assert.ok(!products.some((p) => (p.name || '') === 'Jeans'), 'the category is not among the products');
});

test('a real product (has a price) is kept and emitted, not reclassified', async () => {
  const u = 'https://s.com/product/x';
  const products = [];
  const { report } = await run({ urls: [u], fetcher: new Mock({ [u]: { body: fiche('Jean X', 59) } }), onProduct: (p) => products.push(p) });
  assert.ok(!report.reclassifiedListings);
  assert.equal(report.detected, 1);
  assert.equal(products.length, 1);
});

test('a data-less page with only a few product links (sur devis) is KEPT, not dropped', async () => {
  const u = 'https://s.com/product/on-quote';
  const body = `<html><head><meta property="og:title" content="Machine industrielle sur devis"></head><body><a href="/product/r1">x</a><a href="/product/r2">x</a></body></html>`;
  const products = [];
  const { report } = await run({ urls: [u], fetcher: new Mock({ [u]: { body }, 'https://s.com/product/r1': { body: '' }, 'https://s.com/product/r2': { body: '' } }), onProduct: (p) => products.push(p) });
  assert.ok(!report.reclassifiedListings, 'few links → not a listing → not reclassified');
  assert.equal(products.length, 1, 'kept as a product (to_verify), never dropped');
});
