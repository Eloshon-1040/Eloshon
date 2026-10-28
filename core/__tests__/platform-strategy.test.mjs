/**
 * Item 9(a) Tier 1 — built-in platform-default strategies. Pure lane: an injected
 * httpGet serves the platform's public feed; RawProduct[] out. Fail-safe: a miss
 * yields no products (the caller falls through to the generic ladder).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platformDefaultLane, wooStoreProductToRaw, PLATFORMS_WITH_DEFAULT } from '../platform-strategy.mjs';
import { shopifyProductToRaw } from '../platform.mjs';
import { toNormalizedProduct } from '../normalize.mjs';

const shopItem = (i) => ({ handle: `tee-${i}`, title: `Tee ${i}`, vendor: 'Acme', product_type: 'Shirts',
  variants: [{ price: `${10 + i}.00`, compare_at_price: `${20 + i}.00`, sku: `SKU${i}`, barcode: '', available: true }],
  images: [{ src: `https://cdn/${i}.jpg` }] });

test('shopify: /products.json is mapped + paginated to the short page', async () => {
  const pages = { 1: Array.from({ length: 250 }, (_, i) => shopItem(i)), 2: [shopItem(250), shopItem(251)] };
  const seen = [];
  const httpGet = async (url) => { seen.push(url); const p = Number(new URL(url).searchParams.get('page')); return { status: 200, body: { products: pages[p] || [] } }; };
  const r = await platformDefaultLane('https://shop.example.com/collections/all', { httpGet, platform: 'shopify' });
  assert.equal(r.ok, true);
  assert.equal(r.products.length, 252, 'both pages harvested, stopped on the short page');
  assert.equal(r.pages, 2);
  const p0 = r.products[0];
  assert.equal(p0.name, 'Tee 0'); assert.equal(p0.price, 10); assert.equal(p0.sku, 'SKU0');
  assert.equal(p0.sourceUrl, 'https://shop.example.com/products/tee-0', 'source URL built from origin + handle');
  assert.ok(seen[0].includes('/products.json?limit=250&page=1'));
});

test('woocommerce: Store API mapped, minor-unit price scaled', async () => {
  const items = [
    { id: 1, name: 'Perceuse', sku: 'P1', permalink: 'https://woo.example.com/p/perceuse', prices: { price: '4999', currency_minor_unit: 2, currency_code: 'EUR' }, images: [{ src: 'https://img/1.jpg' }], categories: [{ name: 'Outillage' }] },
    { id: 2, name: 'Visseuse', sku: 'P2', permalink: 'https://woo.example.com/p/visseuse', prices: { price: '8990', currency_minor_unit: 2, currency_code: 'EUR' } },
  ];
  const httpGet = async (url) => ({ status: 200, body: Number(new URL(url).searchParams.get('page')) === 1 ? items : [] });
  const r = await platformDefaultLane('https://woo.example.com/boutique', { httpGet, platform: 'woocommerce' });
  assert.equal(r.ok, true); assert.equal(r.products.length, 2);
  assert.equal(r.products[0].price, 49.99); assert.equal(r.products[0].currency, 'EUR');
  assert.equal(r.products[0].sourceUrl, 'https://woo.example.com/p/perceuse');
  assert.equal(r.products[1].price, 89.9);
});

test('wooStoreProductToRaw: minor-unit scaling + missing price → null price, never throws', () => {
  assert.equal(wooStoreProductToRaw({ name: 'X', prices: { price: '1999', currency_minor_unit: 2 } }, 'https://o').price, 19.99);
  assert.equal(wooStoreProductToRaw({ name: 'X', prices: { price: '500', currency_minor_unit: 3 } }, 'https://o').price, 0.5);
  assert.equal(wooStoreProductToRaw({ name: 'X' }, 'https://o').price, null);
  assert.equal(wooStoreProductToRaw({}, 'https://o'), null);
});

test('fail-safe: unknown platform / 404 / non-array body → no products', async () => {
  assert.equal((await platformDefaultLane('https://x.com', { httpGet: async () => ({ status: 200, body: {} }), platform: 'magento' })).ok, false);
  assert.equal((await platformDefaultLane('https://x.com', { httpGet: async () => ({ status: 404, body: null }), platform: 'shopify' })).ok, false);
  assert.equal((await platformDefaultLane('https://x.com', { httpGet: async () => ({ status: 200, body: { products: 'nope' } }), platform: 'shopify' })).ok, false);
  assert.ok(!PLATFORMS_WITH_DEFAULT.has('prestashop'), 'PrestaShop has no built-in default in v1 (uses the generic ladder)');
});

test('Item C: Shopify weight_kg comes from variant.grams, not the variant title', () => {
  const g = shopifyProductToRaw({ title: 'Tee', handle: 'tee', variants: [{ price: '19.00', grams: 500, title: 'Large' }], images: [] }, 'https://s/products/tee');
  assert.equal(g.weightText, '500 g');
  assert.equal(toNormalizedProduct(g).weight_kg, 0.5);
  // No grams + a non-weight title → no invented mass (fail-safe).
  const noGrams = shopifyProductToRaw({ title: 'Tee', handle: 'tee', variants: [{ price: '19.00', title: 'Large' }], images: [] }, 'https://s/products/tee');
  assert.equal(toNormalizedProduct(noGrams).weight_kg, null);
  // Title that genuinely carries a weight still parses via the fallback.
  const titled = shopifyProductToRaw({ title: 'Rice', handle: 'rice', variants: [{ price: '2.00', title: '500 g' }], images: [] }, 'https://s/products/rice');
  assert.equal(toNormalizedProduct(titled).weight_kg, 0.5);
});

test('Item B: WooCommerce Store API maps the CURRENT (sale) price, not the crossed-out regular', () => {
  // frenchtoday.com symptom: price captured the struck-through original (105.55)
  // instead of the sale price (84.43). The Store API `prices.price` IS the current
  // active price; the mapper uses it, so on-sale rows get the sale price.
  const onSale = wooStoreProductToRaw({
    name: 'À Moi Paris Method – Beginner', permalink: 'https://ft/p/beginner',
    prices: { price: '8443', regular_price: '10555', sale_price: '8443', currency_minor_unit: 2, currency_code: 'EUR' },
    images: [{ src: 'https://ft/img/beginner.jpg' }], short_description: '<p>Audio method</p>',
  }, 'https://ft');
  assert.equal(onSale.price, 84.43, 'current/sale price, not the regular 105.55');
  assert.equal(onSale.name, 'À Moi Paris Method – Beginner', 'clean name, not the concatenated card text');
  assert.equal(onSale.images[0], 'https://ft/img/beginner.jpg', 'real image, not a placeholder SVG');
  assert.equal(onSale.description, 'Audio method');
});
