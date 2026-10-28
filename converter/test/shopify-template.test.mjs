/**
 * Shopify's current product CSV (a real store export, 2026) has 43 columns, among
 * them `Variant Inventory Tracker` (without `shopify` there, an import ignores the
 * stock quantity) and `Variant Barcodes`. The converter wrote the older 30-column
 * layout. The BigCommerce writer is checked against its official template too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, convert } from '../core/dist/index.mjs';
import { serializeShopifyProducts } from '../core/dist/products.mjs';
import { serializeBigCommerceProducts } from '../core/dist/bigcommerce.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const headerOf = (rel) => parseCsv(fs.readFileSync(path.join(ROOT, rel), 'utf8') + '\n').headers;

const variant = (o) => ({
  optionValues: [], sku: 'S1', price: 10, compareAtPrice: null, cost: null, barcode: '', grams: 500, lengthCm: null, widthCm: null, heightCm: null,
  requiresShipping: true, taxable: true, inventoryQty: 4, imageSrc: '', ...o,
});
const product = (o) => ({
  handle: 'sac', title: 'Sac', bodyHtml: '', vendor: 'V', productType: '', tags: [], status: 'active', categories: [], published: true,
  options: [], variants: [variant({})], images: [], metafields: [], seoTitle: '', seoDescription: '', ...o,
});

test('Shopify output starts with exactly the official 43 columns, in order', () => {
  const official = headerOf('test/fixtures/templates/shopify/products_export.header.csv');
  assert.equal(official.length, 43);
  assert.deepEqual(serializeShopifyProducts([product({})]).headers, official);
});

test('a tracked quantity is written with Variant Inventory Tracker = shopify, otherwise the variant is untracked', () => {
  const { rows } = serializeShopifyProducts([product({ variants: [variant({ sku: 'A', inventoryQty: 4 }), variant({ sku: 'B', inventoryQty: null })], options: [{ name: 'Taille', values: ['S', 'M'] }] })]);
  assert.equal(rows[0]['Variant Inventory Tracker'], 'shopify');
  assert.equal(rows[0]['Variant Inventory Qty'], '4');
  assert.equal(rows[0]['Variant Inventory Policy'], 'deny');
  assert.equal(rows[0]['Variant Fulfillment Service'], 'manual');
  assert.equal(rows[0]['Gift Card'], 'false');
  assert.equal(rows[1]['Variant Inventory Tracker'], '', 'no quantity, no tracking');
});

test('backorders allowed → inventory policy "continue"', () => {
  const { rows } = serializeShopifyProducts([product({ variants: [variant({ stockPolicy: { backorders: 'yes' } })] })]);
  assert.equal(rows[0]['Variant Inventory Policy'], 'continue');
});

test('the barcode is written to "Variant Barcodes" and read back from either spelling', () => {
  const out = serializeShopifyProducts([product({ variants: [variant({ barcode: '5412345678900' })] })]);
  assert.equal(out.rows[0]['Variant Barcodes'], '5412345678900');
  const csv = ['Handle,Title,Variant SKU,Variant Price,Variant Barcode', 'a,A,S1,10,5412345678900'].join('\n');
  const legacy = convert(csv, { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' });
  assert.equal(legacy.ok, true);
  const current = convert(['Handle,Title,Variant SKU,Variant Price,Variant Barcodes', 'a,A,S1,10,5412345678900'].join('\n'), { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' });
  assert.equal(current.ok, true);
  const gtin = (r) => r.rows[0]['GTIN, UPC, EAN, or ISBN'];
  assert.equal(gtin(legacy), '5412345678900');
  assert.equal(gtin(current), '5412345678900');
});

test('BigCommerce output only uses columns of the official import template', () => {
  const official = new Set(headerOf('test/fixtures/templates/bigcommerce/product-import-template.header.csv'));
  const { headers } = serializeBigCommerceProducts([product({ options: [{ name: 'Taille', values: ['S', 'M'] }], variants: [variant({ optionValues: ['S'], sku: 'A', barcode: '5412345678900' }), variant({ optionValues: ['M'], sku: 'B' })], images: [{ src: 'https://x/a.jpg', position: 1, alt: 'a' }] })]);
  assert.deepEqual(headers.filter((h) => !official.has(h)), []);
});
