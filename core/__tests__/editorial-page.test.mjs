/**
 * Item 4b — defense-in-depth: an editorial page (blog / guide / FAQ / news) can
 * carry a stray price from a related-product widget and pass as a product. It is
 * dropped as notAProductPage UNLESS it has hard identity (gtin/sku) or declares
 * Product schema. Real leak: tournesols.com "Gazon et pelouse : quelles solutions
 * choisir ?" accepted as a product. Offline: pure function + mock-fetcher engine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEditorialPage } from '../html-meta.mjs';
import { runScrape } from '../engine.mjs';

test('isEditorialPage: detects article/blog/FAQ signals; product schema always wins', () => {
  assert.equal(isEditorialPage('<meta property="og:type" content="article">'), true);
  assert.equal(isEditorialPage('<meta content="article" property="og:type">'), true); // swapped attr order
  assert.equal(isEditorialPage('<script type="application/ld+json">{"@type":"BlogPosting"}</script>'), true);
  assert.equal(isEditorialPage('<script type="application/ld+json">{"@type":"FAQPage"}</script>'), true);
  // A page that declares Product/Offer schema is a product even if it also links an article.
  assert.equal(isEditorialPage('<meta property="og:type" content="article"><script type="application/ld+json">{"@type":"Product","name":"x"}</script>'), false);
  assert.equal(isEditorialPage('<script type="application/ld+json">{"@type":"Offer","price":9}</script>'), false);
  // A plain product-ish page with no editorial signal.
  assert.equal(isEditorialPage('<html><body><h1>Perceuse</h1></body></html>'), false);
  assert.equal(isEditorialPage(''), false);
  assert.equal(isEditorialPage(null), false);
});

class Mock {
  constructor(map) { this.map = map; this.calls = []; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(u) {
    this.calls.push(u); this.stats.requests++;
    const e = this.map[u] || { status: 404, body: '' };
    const status = e.error ? 0 : (e.status ?? 200);
    const ok = !e.error && status >= 200 && status < 300;
    if (ok) this.stats.ok++; else this.stats.failed++;
    return { ok, status, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: e.body ?? '', bytes: null, headers: {}, error: e.error ?? null, blocked: false };
  }
}
const run = (cfg) => runScrape({ store: { slug: 't' }, concurrency: 1, useBrowser: false, defaultProductType: null, lang: 'fr', ...cfg });

// A blog/guide page with a stray price from a widget, name from og:title — no product schema.
const BLOG = `<html><head>
  <meta property="og:type" content="article">
  <meta property="og:title" content="Gazon et pelouse : quelles solutions choisir ?">
  <meta property="product:price:amount" content="19.99">
  <meta property="product:price:currency" content="EUR">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Gazon et pelouse"}</script>
  </head><body><h1>Gazon</h1><p>gazon synth&#xE9;tique</p></body></html>`;
// A real product with the SAME price/name shape but Product schema declared.
const PRODUCT = `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Gazon synthétique 30mm","offers":{"@type":"Offer","price":"19.99","priceCurrency":"EUR"}}</script></head><body></body></html>`;

test('engine: an editorial page with a stray price is dropped, never emitted as a product', async () => {
  const url = 'https://tournesols.com/conseils/gazon-et-pelouse';
  const products = [];
  const { report } = await run({ urls: [url], fetcher: new Mock({ [url]: { body: BLOG } }), onProduct: (p) => products.push(p) });
  assert.equal(products.length, 0, 'the blog page was not emitted as a product');
  assert.equal(report.editorialDropped, 1, 'it was dropped by the editorial defense');
  assert.ok(report.notAProductPage >= 1);
});

test('engine: a real product with Product schema is NOT dropped by the editorial defense', async () => {
  const url = 'https://tournesols.com/produit/gazon-synthetique-30mm';
  const products = [];
  const { report } = await run({ urls: [url], fetcher: new Mock({ [url]: { body: PRODUCT } }), onProduct: (p) => products.push(p) });
  assert.equal(products.length, 1, 'the real product was emitted');
  assert.equal(report.editorialDropped || 0, 0, 'the editorial defense did not fire on a product-schema page');
  assert.equal(products[0].price, 19.99);
});
