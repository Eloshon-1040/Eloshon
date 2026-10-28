/**
 * Increment 1 — embedded-JSON extraction (Next/Nuxt/Apollo/SSR hydration).
 * Product data that lives only in a state blob is now extracted over plain HTTP
 * (no browser). Structured sources (JSON-LD/microdata/meta) still take priority;
 * embedded JSON only fills gaps. Pure, offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractProduct } from '../extract.mjs';
import { extractProductFromEmbeddedJson } from '../html-meta.mjs';

const nextData = (obj) => `<html><head><title>Shop</title></head><body><div id="__next"></div>`
  + `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(obj)}</script></body></html>`;
const nuxt = (obj) => `<html><body><div id="__nuxt"></div><script>window.__NUXT__=${JSON.stringify(obj)};</script></body></html>`;
const apollo = (obj) => `<html><body><script id="__APOLLO_STATE__" type="application/json">${JSON.stringify(obj)}</script></body></html>`;

test('embedded: Next.js __NEXT_DATA__ product extracted over HTTP (no browser)', () => {
  const html = nextData({ props: { pageProps: { product: {
    '@type': 'Product', name: 'Perceuse XR 18V', sku: 'DCD778', gtin13: '5035048731123',
    brand: { name: 'DeWalt' }, image: ['https://x/img1.jpg'],
    offers: { price: 129.99, priceCurrency: 'EUR', availability: 'InStock' },
    description: 'Perceuse sans fil',
  } } } });
  const { product, needsBrowser, strategies } = extractProduct(html, 'https://shop/p/1');
  assert.ok(product);
  assert.equal(product.name, 'Perceuse XR 18V');
  assert.equal(product.price, 129.99);
  assert.equal(product.currency, 'EUR');
  assert.equal(product.sku, 'DCD778');
  assert.equal(product.gtin, '5035048731123');
  assert.equal(product.brand, 'DeWalt');
  assert.ok(product.images.includes('https://x/img1.jpg'));
  assert.equal(needsBrowser, false);                 // data found → no browser needed
  assert.ok(strategies.includes('generic-embedded-json'));
});

test('embedded: Nuxt window.__NUXT__ product with nested price object', () => {
  const html = nuxt({ state: { product: { title: 'T-shirt coton', productCode: 'TS-01',
    price: { amount: '19.90', currency: 'EUR' }, images: [{ url: 'https://x/t.jpg' }] } } });
  const { product } = extractProduct(html, 'https://shop/p/2');
  assert.equal(product.name, 'T-shirt coton');
  assert.equal(product.price, 19.9);
  assert.equal(product.currency, 'EUR');
  assert.equal(product.sku, 'TS-01');
});

test('embedded: Apollo cache product by __typename', () => {
  const html = apollo({ 'Product:42': { __typename: 'Product', name: 'Écouteurs BT',
    sku: 'EC-42', price: 49, currency: 'EUR', imageUrl: 'https://x/e.jpg' } });
  const { product, strategies } = extractProduct(html, 'https://shop/p/3');
  assert.equal(product.name, 'Écouteurs BT');
  assert.equal(product.price, 49);
  assert.ok(strategies.includes('generic-embedded-json'));
});

test('embedded: RICH JSON-LD (name+price+gtin+image) wins and the blob is not parsed (perf guard)', () => {
  // A complete JSON-LD leaves no gap worth a (possibly large) blob parse → skipped.
  const ld = { '@context': 'https://schema.org', '@type': 'Product', name: 'Nom Officiel',
    gtin13: '5410000000017', image: 'https://x/a.jpg', offers: { price: '10.00', priceCurrency: 'EUR' } };
  const html = `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head>`
    + `<body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ product: { '@type': 'Product', name: 'Nom Blob', price: 999 } })}</script></body></html>`;
  const { product, strategies } = extractProduct(html, 'https://shop/p/4');
  assert.equal(product.name, 'Nom Officiel');        // JSON-LD wins
  assert.equal(product.price, 10);
  assert.ok(!strategies.includes('generic-embedded-json')); // rich fiche → blob not consulted
});

test('embedded: JSON-LD with name+price but GAPS still consults the blob (gap-fill, no override)', () => {
  // The user's rule: a "recommended" extractor must not stop the engine looking
  // for absent fields elsewhere. name+price win, but gtin/image come from the blob.
  const ld = { '@context': 'https://schema.org', '@type': 'Product', name: 'Nom Officiel',
    offers: { price: '10.00', priceCurrency: 'EUR' } };
  const html = `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head>`
    + `<body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ product: { '@type': 'Product', name: 'Nom Blob', price: 999, gtin13: '5410000000017', image: 'https://x/b.jpg' } })}</script></body></html>`;
  const { product, strategies } = extractProduct(html, 'https://shop/p/4b');
  assert.equal(product.name, 'Nom Officiel');        // JSON-LD still wins
  assert.equal(product.price, 10);                   // not overridden by the blob's 999
  assert.equal(product.gtin, '5410000000017');       // gap filled from the blob
  assert.ok(product.images.includes('https://x/b.jpg'));
  assert.ok(strategies.includes('generic-embedded-json'));
});

test('embedded: INCOMPLETE JSON-LD (name, no price) is enriched from the blob', () => {
  // Common real case: partial JSON-LD → the blob fills price/sku.
  const ld = { '@context': 'https://schema.org', '@type': 'Product', name: 'Nom Officiel' };
  const html = `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head>`
    + `<body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ product: { '@type': 'Product', name: 'Nom Blob', price: 12.5, sku: 'ABC', image: 'https://x/b.jpg' } })}</script></body></html>`;
  const { product, strategies } = extractProduct(html, 'https://shop/p/5');
  assert.equal(product.name, 'Nom Officiel');        // JSON-LD name still wins
  assert.equal(product.price, 12.5);                 // price filled from embedded
  assert.equal(product.sku, 'ABC');                  // sku filled from embedded
  assert.ok(product.images.includes('https://x/b.jpg'));
  assert.ok(strategies.includes('generic-embedded-json'));
});

test('embedded: non-product state blob is not mistaken for a product', () => {
  const html = nextData({ props: { pageProps: { config: { siteName: 'MyShop', theme: 'dark', locale: 'fr' },
    cart: { items: [], total: 0 } } } });
  const r = extractProductFromEmbeddedJson(html);
  assert.equal(r, null);
});

test('embedded: best candidate wins among several product-ish nodes', () => {
  const html = nextData({ related: [{ name: 'Related', price: 5 }], product: {
    '@type': 'Product', name: 'Main', price: 20, sku: 'M1', brand: 'B', image: 'https://x/m.jpg', description: 'd' } });
  const r = extractProductFromEmbeddedJson(html);
  assert.equal(r.name, 'Main');                      // typed + richer → higher score
  assert.equal(r.price, 20);
});

test('embedded: page without any embedded blob → null (unchanged path)', () => {
  assert.equal(extractProductFromEmbeddedJson('<html><body><h1>hi</h1></body></html>'), null);
});
