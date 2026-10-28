/**
 * Discovery must START from the pasted URL, and respect its language — the two
 * defects seen from the app (a Belgian-French collection returning a Dutch page /
 * an off-category product came from collapsing the URL to its origin and letting
 * the whole-site sitemap win). Offline: pure functions + a mock fetcher.
 *   req#1 listing URL leads (sitemap never overrides)
 *   req#2 a product fiche URL is analysed directly
 *   req#3 the language filter never empties the result (warns + lists languages)
 *   req#5 sitemap absent/empty is handled
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverProducts } from '../discover.mjs';

class Mock {
  constructor(map) { this.map = map; this.reads = []; this.stats = { requests: 0 }; this.userAgent = 't'; }
  async get(url) {
    this.reads.push(url); this.stats.requests++;
    const e = this.map[url] || { status: 404 };
    const status = e.status ?? 200;
    const ok = status >= 200 && status < 300;
    const body = ok ? (e.body ?? '') : '';
    return { ok, status, url, requestedUrl: url, contentType: 'text/html', kind: 'html', body, bytes: null, headers: {}, error: ok ? null : `HTTP ${status}`, blocked: !ok };
  }
  async getText(url) { return this.get(url); }
}
const urlset = (urls) => `<?xml version="1.0"?><urlset>${urls.map((u) => `<loc>${u}</loc>`).join('')}</urlset>`;
const links = (hrefs) => `<html><body>${hrefs.map((h) => `<a href="${h}">x</a>`).join('')}</body></html>`;

test('req#1/#2 — a specific collection URL LEADS; the whole-site sitemap never overrides it', async () => {
  const shop = 'https://shop.be';
  const url = `${shop}/fr/collections/jeans`;
  const map = {
    [`${shop}/robots.txt`]: { body: 'Sitemap: https://shop.be/sitemap.xml' },
    ['https://shop.be/sitemap.xml']: { body: urlset(Array.from({ length: 10 }, (_, i) => `${shop}/fr/products/shoe-${i}`)) },
    [url]: { body: links(Array.from({ length: 6 }, (_, i) => `/fr/products/jean-${i}`)) },
  };
  const { urls, report } = await discoverProducts(new Mock(map), url, {});
  assert.equal(report.context.pageType, 'collection');
  assert.equal(report.context.language, 'fr');
  assert.equal(report.context.country, 'BE');               // from ccTLD .be
  assert.notEqual(report.method, 'sitemap');                // sitemap did NOT win
  assert.equal(urls.length, 6);
  assert.ok(urls.every((u) => u.includes('/products/jean-')), 'only the pasted category, no shoes from sitemap');
});

test('req#2 — a product fiche URL is analysed directly, without touching robots/sitemap', async () => {
  const url = 'https://shop.com/fr/products/cool-jean';
  const mock = new Mock({});
  const { urls, report } = await discoverProducts(mock, url, {});
  assert.equal(report.method, 'direct-product');
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes('/products/cool-jean'));
  assert.equal(mock.reads.length, 0, 'no network for a direct fiche');
});

test('req#3 — language filter keeps the URL language and drops the others', async () => {
  const shop = 'https://shop.com';
  const url = `${shop}/fr/collections/all`;
  const map = {
    [`${shop}/robots.txt`]: { status: 404 },
    [url]: { body: links(['/fr/products/a', '/fr/products/b', '/fr/products/c', '/nl/products/d', '/nl/products/e']) },
  };
  const { urls, report } = await discoverProducts(new Mock(map), url, {});
  assert.equal(report.context.language, 'fr');
  assert.equal(report.context.languageFilter, 'applied');
  assert.equal(urls.length, 3);
  assert.ok(urls.every((u) => u.includes('/fr/')), 'no /nl/ URLs survive');
});

test('req#3 — language filter NEVER empties: warns + lists available languages instead', async () => {
  const shop = 'https://shop.com';
  const url = `${shop}/fr/collections/all`;
  const map = {
    [`${shop}/robots.txt`]: { status: 404 },
    [url]: { body: links(['/nl/products/d', '/nl/products/e', '/nl/products/f']) },
  };
  const { urls, report } = await discoverProducts(new Mock(map), url, {});
  assert.equal(urls.length, 3, 'result not emptied');
  assert.equal(report.context.languageFilter, 'skipped-would-empty');
  assert.ok(report.context.languageWarning);
  assert.deepEqual(report.context.availableLanguages, ['nl']);
});

test('req#5 — sitemap absent/empty: the pasted listing still drives discovery', async () => {
  const shop = 'https://shop.io';
  const url = `${shop}/c/tools`;
  const map = {
    [`${shop}/robots.txt`]: { status: 404 },
    [url]: { body: links(['/product/hammer', '/product/wrench']) },
  };
  const { urls, report } = await discoverProducts(new Mock(map), url, {});
  assert.equal(report.context.pageType, 'collection');
  assert.equal(urls.length, 2);
  assert.ok(urls.some((u) => u.includes('hammer')));
});

test('req#5 — empty listing over HTTP yields an honest diagnosis, never a crash', async () => {
  const shop = 'https://spa.shop';
  const url = `${shop}/fr/c/grid`;
  const map = {
    [`${shop}/robots.txt`]: { status: 404 },
    [url]: { body: '<html><body><div id="app"></div></body></html>' },   // empty CSR shell
  };
  const { urls, report } = await discoverProducts(new Mock(map), url, {});
  assert.equal(urls.length, 0);
  assert.ok(['no-signal', 'needs-browser'].includes(report.diagnosis), `honest diagnosis, got ${report.diagnosis}`);
});

// ── nested-category-trail veto (colruyt.be shape) ───────────────────────────
// The whole category tree lives under /fr/produits/… — PRODUCT_RE's /produits/
// marker used to queue every category page as a "product". They must be crawled
// as LISTINGS instead, and a real fiche (id-carrying slug) found deeper must be
// the only thing queued as a product.
test('a nested /produits/ category tree is crawled as listings, never queued as products', async () => {
  const shop = 'https://grocer.be';
  const entry = `${shop}/fr/produits/toutes-les-categories/boissons`;
  const map = {
    [`${shop}/robots.txt`]: { body: '' },
    [entry]: { body: links([
      '/fr/produits/toutes-les-categories/boissons/eaux',
      '/fr/produits/toutes-les-categories/boissons/jus',
    ]) },
    [`${shop}/fr/produits/toutes-les-categories/boissons/eaux`]: { body: links([
      '/fr/produits/eau-plate-6x1l-cnk123',   // fiche: id-carrying slug under the root
    ]) },
    [`${shop}/fr/produits/toutes-les-categories/boissons/jus`]: { body: links([]) },
  };
  const { urls, report } = await discoverProducts(new Mock(map), entry, {});
  assert.equal(report.context.pageType, 'collection', 'entry is a collection, not a fiche');
  assert.deepEqual(urls, [`${shop}/fr/produits/eau-plate-6x1l-cnk123`]);
  assert.ok(report.pagesCrawled >= 3, `sub-categories crawled as listings (crawled ${report.pagesCrawled})`);
});
