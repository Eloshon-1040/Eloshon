/**
 * Scraper unit tests — deterministic, no network. Run: `node --test scripts/scraper/`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractProductFromJsonLd, parseJsonLdBlocks, collectNodes } from '../jsonld.mjs';
import { extractFromMeta, needsBrowser, canonicalOf } from '../html-meta.mjs';
import { parseWeight } from '../weight.mjs';
import { dedupKey, cleanUrl, absoluteUrl } from '../url-utils.mjs';
import { parseLocs, isSitemapIndex } from '../sitemap.mjs';
import { extractProduct } from '../extract.mjs';
import { toNormalizedProduct } from '../normalize.mjs';
import { toImportCsv } from '../csv.mjs';
import { paginate } from '../pagination.mjs';
import { shopifyProductToRaw } from '../platform.mjs';
import { discoverProducts, SKIP_RE, PRODUCT_RE, LISTING_RE, PAGE_RE } from '../discover.mjs';

const wrap = (jsonld) => `<html><head><script type="application/ld+json">${JSON.stringify(jsonld)}</script></head><body></body></html>`;

// ── JSON-LD ────────────────────────────────────────────────────────────────
test('JSON-LD simple Product', () => {
  const p = extractProductFromJsonLd(wrap({ '@context': 'https://schema.org', '@type': 'Product', name: 'Café moulu 250g', gtin13: '5410000000029', brand: { name: 'Luna' }, image: 'https://x/y.jpg', offers: { '@type': 'Offer', price: '3.49', priceCurrency: 'EUR', availability: 'https://schema.org/InStock' } }));
  assert.equal(p.name, 'Café moulu 250g');
  assert.equal(p.price, 3.49);
  assert.equal(p.currency, 'EUR');
  assert.equal(p.gtin, '5410000000029');
  assert.equal(p.brand, 'Luna');
  assert.equal(p.availability, 'InStock');
  assert.deepEqual(p.images, ['https://x/y.jpg']);
});

test('JSON-LD @graph with Product + BreadcrumbList', () => {
  const p = extractProductFromJsonLd(wrap({ '@context': 'https://schema.org', '@graph': [
    { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', name: 'Épicerie' }, { '@type': 'ListItem', name: 'Café' }] },
    { '@type': 'Product', name: 'Thé vert', offers: { price: 2.5, priceCurrency: 'EUR' } },
  ] }));
  assert.equal(p.name, 'Thé vert');
  assert.deepEqual(p.breadcrumb, ['Épicerie', 'Café']);
});

test('JSON-LD offers as ARRAY → lowest price = current, highest = list', () => {
  const p = extractProductFromJsonLd(wrap({ '@type': 'Product', name: 'X', offers: [{ price: 5.0, priceCurrency: 'EUR' }, { price: 3.5, priceCurrency: 'EUR' }] }));
  assert.equal(p.price, 3.5);
  assert.equal(p.listPrice, 5.0);
});

test('JSON-LD AggregateOffer lowPrice', () => {
  const p = extractProductFromJsonLd(wrap({ '@type': 'Product', name: 'X', offers: { '@type': 'AggregateOffer', lowPrice: '1.99', priceCurrency: 'EUR' } }));
  assert.equal(p.price, 1.99);
});

test('JSON-LD image as ARRAY and as ImageObject', () => {
  const a = extractProductFromJsonLd(wrap({ '@type': 'Product', name: 'X', image: ['https://a/1.jpg', 'https://a/2.jpg'] }));
  assert.deepEqual(a.images, ['https://a/1.jpg', 'https://a/2.jpg']);
  const b = extractProductFromJsonLd(wrap({ '@type': 'Product', name: 'X', image: { '@type': 'ImageObject', url: 'https://a/3.jpg' } }));
  assert.deepEqual(b.images, ['https://a/3.jpg']);
});

test('JSON-LD price absent → null (never invented)', () => {
  const p = extractProductFromJsonLd(wrap({ '@type': 'Product', name: 'X' }));
  assert.equal(p.price, null);
});

test('JSON-LD barcode absent → gtin null (never invented)', () => {
  const p = extractProductFromJsonLd(wrap({ '@type': 'Product', name: 'X' }));
  assert.equal(p.gtin, null);
});

test('JSON-LD brand as string', () => {
  const p = extractProductFromJsonLd(wrap({ '@type': 'Product', name: 'X', brand: 'Delhaize' }));
  assert.equal(p.brand, 'Delhaize');
});

test('multiple ld+json blocks, only one is Product', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Organization', name: 'Shop' })}</script>` +
               `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Riz 1kg', offers: { price: 2.29, priceCurrency: 'EUR' } })}</script>`;
  const p = extractProductFromJsonLd(html);
  assert.equal(p.name, 'Riz 1kg');
});

test('malformed ld+json does not throw', () => {
  const blocks = parseJsonLdBlocks('<script type="application/ld+json">{ not valid json </script>');
  assert.ok(Array.isArray(blocks));
});

// ── meta / needsBrowser / canonical ─────────────────────────────────────────
test('HTML without JSON-LD → OpenGraph meta fallback', () => {
  const html = `<html><head>
    <meta property="og:title" content="Sauce tomate 350g">
    <meta property="og:image" content="https://x/i.jpg">
    <meta property="product:price:amount" content="1,29">
    <meta property="product:price:currency" content="EUR"></head><body></body></html>`;
  const m = extractFromMeta(html);
  assert.equal(m.name, 'Sauce tomate 350g');
  assert.equal(m.price, 1.29);
  assert.equal(m.currency, 'EUR');
});

test('needsBrowser true for empty SPA shell, false when JSON-LD present', () => {
  assert.equal(needsBrowser('<html><body><div id="root"></div></body></html>'), true);
  assert.equal(needsBrowser(wrap({ '@type': 'Product', name: 'X' })), false);
});

test('canonical extraction', () => {
  assert.equal(canonicalOf('<link rel="canonical" href="https://x/p/1">'), 'https://x/p/1');
});

// ── weight ───────────────────────────────────────────────────────────────────
test('weight parsing: mass → kg, volume kept but not converted', () => {
  assert.equal(parseWeight('500 g').weight_kg, 0.5);
  assert.equal(parseWeight('1 kg').weight_kg, 1);
  assert.equal(parseWeight('250g').weight_kg, 0.25);
  assert.equal(parseWeight('1,5 kg').weight_kg, 1.5);
  assert.equal(parseWeight('1 L').weight_kg, null);
  assert.equal(parseWeight('1 L').volume_l, 1);
  const multi = parseWeight('6 x 33 cl');
  assert.equal(multi.volume_l, 1.98);
  assert.equal(multi.count, 6);
  assert.equal(parseWeight('12 pièces').count, 12);
});

// ── url dedup ────────────────────────────────────────────────────────────────
test('dedupKey strips tracking params + trailing slash + www, keeps variant params', () => {
  const a = dedupKey('https://www.shop.be/p/1/?utm_source=x&color=red');
  const b = dedupKey('https://shop.be/p/1?color=red');
  assert.equal(a, b);
  assert.notEqual(dedupKey('https://shop.be/p/1?color=red'), dedupKey('https://shop.be/p/1?color=blue'));
});

test('cleanUrl removes only tracking params', () => {
  assert.equal(cleanUrl('https://shop.be/p?fbclid=abc&size=M'), 'https://shop.be/p?size=M');
});

test('absoluteUrl resolves relative', () => {
  assert.equal(absoluteUrl('/img/a.jpg', 'https://shop.be/p/1'), 'https://shop.be/img/a.jpg');
});

// ── sitemap ──────────────────────────────────────────────────────────────────
test('sitemap loc parsing + index detection', () => {
  const xml = '<sitemapindex><sitemap><loc>https://x/sm-products.xml.gz</loc></sitemap></sitemapindex>';
  assert.equal(isSitemapIndex(xml), true);
  assert.deepEqual(parseLocs(xml), ['https://x/sm-products.xml.gz']);
});

// ── extract orchestrator + normalize (identity priority) ─────────────────────
test('extract + normalize: gtin → barcode + source_product_id, weight → kg', () => {
  const html = wrap({ '@type': 'Product', name: 'Biscuits 300g', gtin13: '5410000001234', sku: 'SKU9', weight: '300 g', image: '/i/b.jpg', offers: { price: 1.49, priceCurrency: 'EUR' } });
  const { product } = extractProduct(html, 'https://shop.be/fr/biscuits-300g');
  const np = toNormalizedProduct(product, { storeSlug: 'demo', defaultProductType: 'food' });
  assert.equal(np.barcode, '5410000001234');
  assert.equal(np.source_product_id, '5410000001234'); // gtin wins
  assert.equal(np.weight_kg, 0.3);
  assert.equal(np.image_url, 'https://shop.be/i/b.jpg'); // relative resolved
  assert.equal(np.product_type, 'food');
  assert.equal(np.price, 1.49);
});

test('normalize: no gtin/sku → source_product_id falls back to URL segment', () => {
  const np = toNormalizedProduct({ name: 'X', images: [], breadcrumb: [], sourceUrl: 'https://shop.be/fr/produit-x', canonicalUrl: null, strategy: 'generic-meta', confidence: 0.4 }, { storeSlug: 'demo' });
  assert.equal(np.source_product_id, 'produit-x');
  assert.equal(np.barcode, null); // never invented
});

test('normalize: source_product_id skips generic /index.html segment', () => {
  const np = toNormalizedProduct({ name: 'X', images: [], breadcrumb: [], sourceUrl: 'https://shop.be/catalogue/mon-produit_42/index.html', strategy: 'x', confidence: 1 }, { storeSlug: 'demo' });
  assert.equal(np.source_product_id, 'mon-produit_42');
});

// ── csv ──────────────────────────────────────────────────────────────────────
test('CSV emits admin-import columns and escapes commas', () => {
  const np = toNormalizedProduct({ name: 'Sauce, tomate', images: [], breadcrumb: [], sourceUrl: 'https://s/p1', strategy: 'x', confidence: 1, price: 1.2 }, { storeSlug: 'demo', defaultProductType: 'food' });
  const csv = toImportCsv([np]);
  const header = csv.split('\r\n')[0].replace('﻿', '');
  assert.ok(header.startsWith('slug,name,description,price'));
  assert.ok(csv.includes('"Sauce, tomate"')); // comma escaped
  assert.ok(csv.includes('food'));
});

// ── pagination loop guard ────────────────────────────────────────────────────
test('paginate stops when pages repeat the same URLs (loop guard)', async () => {
  let calls = 0;
  const res = await paginate(async () => { calls++; return ['https://s/p/1', 'https://s/p/2']; }, { maxPages: 20 });
  assert.equal(res.stoppedBy, 'no-new-urls');
  assert.ok(calls <= 3);
});

test('paginate stops on empty page', async () => {
  const res = await paginate(async (n) => (n === 1 ? ['https://s/p/1'] : []), { maxPages: 20 });
  assert.equal(res.stoppedBy, 'empty-page');
  assert.deepEqual(res.urls, ['https://s/p/1']);
});

// ── shopify adapter ──────────────────────────────────────────────────────────
test('shopify product JSON → RawProduct', () => {
  const raw = shopifyProductToRaw({ product: { title: 'T-Shirt', vendor: 'Acme', product_type: 'Apparel', body_html: '<p>Nice</p>', variants: [{ price: '19.90', compare_at_price: '29.90', sku: 'TS-1', barcode: '3700000000001', available: true }], images: [{ src: 'https://cdn/x.jpg' }] } }, 'https://shop/products/t-shirt');
  assert.equal(raw.name, 'T-Shirt');
  assert.equal(raw.price, 19.9);
  assert.equal(raw.listPrice, 29.9);
  assert.equal(raw.gtin, '3700000000001');
  assert.equal(raw.brand, 'Acme');
  assert.deepEqual(raw.images, ['https://cdn/x.jpg']);
});

// ── discovery ─────────────────────────────────────────────────────────────────
test('discovery URL classifiers', () => {
  assert.ok(PRODUCT_RE.test('https://s/product/abc'));
  assert.ok(LISTING_RE.test('https://s/collections/men'));
  assert.ok(PAGE_RE.test('https://s/shop?page=2'));
  assert.ok(SKIP_RE.test('https://s/conditions-generales'));
  assert.ok(SKIP_RE.test('https://s/cart'));
  assert.ok(SKIP_RE.test('https://s/img/a.jpg'));
  assert.ok(!SKIP_RE.test('https://s/product/hoodie'));
});

class DiscMock {
  constructor(map) { this.map = map; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(url) { this.stats.requests++; const r = this.map[url] || { status: 404, body: '' }; return { ok: r.status >= 200 && r.status < 300, status: r.status, url, requestedUrl: url, body: r.body || '', kind: 'html', headers: {}, error: null }; }
  async getText(url) { return this.get(url); }
}
const page = (links) => ({ status: 200, body: `<html><body>${links.map((h) => `<a href="${h}">x</a>`).join('')}</body></html>` });

test('discovery crawls categories + pagination, skips junk, collects products', async () => {
  const f = new DiscMock({
    'https://shop.be/': page(['/category/food', '/product/a', '/conditions-generales', '/cart', '/blog/post-1']),
    'https://shop.be/category/food': page(['/product/b', '/product/c', '/category/food?page=2', '/login']),
    'https://shop.be/category/food?page=2': page(['/product/d', '/product/c']), // c repeats → dedup
  });
  const { urls, report } = await discoverProducts(f, 'https://shop.be/', { maxProducts: 100, maxPages: 50 });
  const paths = urls.map((u) => new URL(u).pathname).sort();
  assert.deepEqual(paths, ['/product/a', '/product/b', '/product/c', '/product/d']);
  assert.equal(report.method, 'crawl');
  assert.ok(!urls.some((u) => /conditions|cart|blog|login/.test(u))); // junk never crawled/collected
});

test('discovery respects maxProducts guardrail', async () => {
  const many = Array.from({ length: 50 }, (_, i) => `/product/p${i}`);
  const f = new DiscMock({ 'https://shop.be/': page(many) });
  const { urls } = await discoverProducts(f, 'https://shop.be/', { maxProducts: 10, maxPages: 50 });
  assert.equal(urls.length, 10);
});

test('discovery stops on a challenge during crawl (no infinite loop)', async () => {
  const CFbody = '<html>Just a moment... /cdn-cgi/challenge-platform</html>';
  const f = new DiscMock({ 'https://shop.be/': { status: 403, body: CFbody } });
  const { urls, report } = await discoverProducts(f, 'https://shop.be/', {});
  assert.equal(urls.length, 0);
  assert.ok(report.stopped && report.stopped.code);
});

// ── browser-discovery fallback (CSR) ─────────────────────────────────────────
const fakeBrowser = (map) => ({ calls: 0, async collectLinks(url) { this.calls++; return map[url] || { links: [], blocked: null }; } });

test('A: HTTP finds products (≥ csrFewThreshold) → browser-discovery NOT used', async () => {
  // 2a note: "found products" now means ≥ csrFewThreshold (default 2). A single
  // HTTP hit is treated as under-delivery and DOES render (see test A2); two clear
  // hits are a real result and must not trigger a wasted render.
  const f = new DiscMock({ 'https://shop.be/': page(['/product/a', '/product/b']) });
  const fb = fakeBrowser({});
  const { urls, report } = await discoverProducts(f, 'https://shop.be/', { getBrowser: async () => fb });
  assert.equal(fb.calls, 0);
  assert.equal(report.method, 'crawl');
  assert.ok(urls.some((u) => u.endsWith('/product/a')));
});

test('A2: HTTP finds only 1 product → browser-discovery DOES render (2a first-visit)', async () => {
  // The archetype-3 first-visit case: a reachable page yields ~1 over HTTP. Before
  // 2a this stopped at 1; now the render fires (fewHttp < csrFewThreshold) with no
  // profile hint. fakeBrowser has no collectListing here → collectLinks path.
  const f = new DiscMock({ 'https://shop.be/': page(['/product/a']) });
  const fb = fakeBrowser({ 'https://shop.be/': { links: ['/product/a', '/product/b', '/product/c'].map((p) => `https://shop.be${p}`), blocked: null } });
  const { urls } = await discoverProducts(f, 'https://shop.be/', { getBrowser: async () => fb });
  assert.equal(fb.calls, 1, 'HTTP found only 1 → render fires on first visit');
  assert.ok(urls.length >= 3, `render completed the catalogue, got ${urls.length}`);
});

test('B: CSR (HTTP finds 0) → browser-discovery finds products after render', async () => {
  const f = new DiscMock({ 'https://csr.shop/': page([]) }); // no links in initial HTML
  const fb = fakeBrowser({ 'https://csr.shop/': { links: ['https://csr.shop/product/a', 'https://csr.shop/product/b'], blocked: null } });
  const { urls, report } = await discoverProducts(f, 'https://csr.shop/', { getBrowser: async () => fb });
  assert.equal(fb.calls, 1);
  assert.equal(report.method, 'browser');
  assert.equal(report.httpProductUrls, 0);
  assert.equal(report.browserProductUrls, 2);
  assert.deepEqual(urls.map((u) => new URL(u).pathname).sort(), ['/product/a', '/product/b']);
});

test('C/E: browser-discovery (load-more results) respects max-products', async () => {
  const many = Array.from({ length: 50 }, (_, i) => `https://csr.shop/product/p${i}`);
  const f = new DiscMock({ 'https://csr.shop/': page([]) });
  const fb = fakeBrowser({ 'https://csr.shop/': { links: many, blocked: null } });
  const { urls } = await discoverProducts(f, 'https://csr.shop/', { maxProducts: 10, getBrowser: async () => fb });
  assert.equal(urls.length, 10);
});

test('D: HTTP + browser results are deduplicated (tracking/trailing variants)', async () => {
  const f = new DiscMock({ 'https://csr.shop/': page([]) });
  const fb = fakeBrowser({ 'https://csr.shop/': { links: ['https://csr.shop/product/a?utm_source=x', 'https://csr.shop/product/a/', 'https://csr.shop/product/b'], blocked: null } });
  const { urls } = await discoverProducts(f, 'https://csr.shop/', { getBrowser: async () => fb });
  assert.equal(urls.length, 2); // a (deduped) + b
});

test('F: browser-discovery challenge → stop, no products, no bypass', async () => {
  const f = new DiscMock({ 'https://csr.shop/': page([]) });
  const fb = fakeBrowser({ 'https://csr.shop/': { links: [], blocked: { code: 'BOT_CHALLENGE', reason: 'cf' } } });
  const { urls, report } = await discoverProducts(f, 'https://csr.shop/', { getBrowser: async () => fb });
  assert.equal(urls.length, 0);
  assert.ok(report.stopped && report.stopped.code === 'BOT_CHALLENGE');
});

// ── robustness: invalid page yields nothing, never throws ─────────────────────
test('extract on junk HTML returns no product, no throw', () => {
  const { product, needsBrowser: nb } = extractProduct('<html><body>oops</body></html>', 'https://s/x');
  assert.equal(product, null);
  assert.equal(typeof nb, 'boolean');
});
