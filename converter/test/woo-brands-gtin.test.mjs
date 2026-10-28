/**
 * Phase 6 — `vendor` → WooCommerce `Brands` (WC 9.6+ core brands taxonomy) and
 * `barcode` → `GTIN, UPC, EAN, or ISBN` (WC 9.2+). Both were honest losses
 * before; column names verified against the live WC 11.1 exporter/importer.
 * The WC CSV parser reads both back (first brand's leaf = vendor, every brand
 * kept), so a WooCommerce → WooCommerce trip loses nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert, convertFromCanon, serializeCsv } from '../core/dist/index.mjs';

const WOO_HEAD = ['Type', 'SKU', 'Name', 'Published', 'Regular price', 'Categories', 'Parent', 'Brands', 'GTIN, UPC, EAN, or ISBN'];
const wooCsv = (rows) => serializeCsv(WOO_HEAD, rows.map((r) => ({ Parent: '', ...r })));

const variant = (over = {}) => ({
  optionValues: [], sku: 'A-1', price: 10, compareAtPrice: null, cost: null, barcode: '', grams: null,
  lengthCm: null, widthCm: null, heightCm: null, requiresShipping: true, taxable: true, inventoryQty: 1, imageSrc: '', ...over,
});
const product = (over = {}) => ({
  handle: 'a', title: 'A', bodyHtml: '', vendor: '', productType: '', tags: [], status: 'active', categories: [],
  published: true, options: [], variants: [variant()], images: [], metafields: [], seoTitle: '', seoDescription: '', ...over,
});
const toWoo = (products) => convertFromCanon(products, { direction: 'shopify-to-woocommerce', entity: 'products', expectPlatform: 'shopify' });

test('WC CSV parser: `Brands` → vendor (leaf of the first brand), every brand kept, `\\,` honoured', () => {
  const csv = wooCsv([
    { Type: 'simple', SKU: 'B-1', Name: 'One brand', Published: '1', 'Regular price': '5', Categories: '', Brands: 'Acme', 'GTIN, UPC, EAN, or ISBN': '4006381333931' },
    { Type: 'simple', SKU: 'B-2', Name: 'Hierarchy', Published: '1', 'Regular price': '5', Categories: '', Brands: 'Group > Sub Brand', 'GTIN, UPC, EAN, or ISBN': '' },
    { Type: 'simple', SKU: 'B-3', Name: 'Several', Published: '1', 'Regular price': '5', Categories: '', Brands: 'Smith\\, Jones & Co, Acme', 'GTIN, UPC, EAN, or ISBN': '' },
  ]);
  const res = convert(csv, { direction: 'woocommerce-to-shopify', entity: 'products', expectPlatform: 'woocommerce' });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  const bySku = Object.fromEntries(res.rows.map((r) => [r['Variant SKU'], r]));
  assert.equal(bySku['B-1']['Vendor'], 'Acme');
  assert.equal(bySku['B-1']['Variant Barcodes'], '4006381333931');
  assert.equal(bySku['B-2']['Vendor'], 'Sub Brand');
  // Escaped comma is part of the name, not a separator; the extra brand is not lost.
  assert.equal(bySku['B-3']['Vendor'], 'Smith, Jones & Co');
  const metaCol = res.headers.find((h) => /brands/i.test(h));
  assert.ok(metaCol, 'extra brands preserved as a custom field');
  assert.equal(bySku['B-3'][metaCol], 'Smith, Jones & Co, Acme');
});

test('WC serializer: `Brands` and GTIN columns appear only when a product carries the value', () => {
  const none = toWoo([product()]);
  assert.equal(none.ok, true);
  assert.ok(!none.headers.includes('Brands'), 'no vendor anywhere → no Brands column (byte-identical default)');
  assert.ok(!none.headers.includes('GTIN, UPC, EAN, or ISBN'));
  assert.ok(!none.losses.some((l) => l.code === 'loss_woo_barcode'), 'loss_woo_barcode is retired');

  const some = toWoo([
    product({ handle: 'a', vendor: 'Smith, Jones & Co', variants: [variant({ sku: 'A-1', barcode: '4006381333931' })] }),
    product({ handle: 'b', title: 'B', variants: [variant({ sku: 'B-1' })] }),
  ]);
  assert.equal(some.ok, true);
  assert.ok(some.headers.includes('Brands'));
  assert.ok(some.headers.includes('GTIN, UPC, EAN, or ISBN'));
  const a = some.rows.find((r) => r['SKU'] === 'A-1'), b = some.rows.find((r) => r['SKU'] === 'B-1');
  assert.equal(a['Brands'], 'Smith\\, Jones & Co', 'comma escaped the way the WC importer expects');
  assert.equal(a['GTIN, UPC, EAN, or ISBN'], '4006381333931');
  assert.equal(b['Brands'], '');
  assert.equal(b['GTIN, UPC, EAN, or ISBN'], '');
  assert.ok(!some.losses.some((l) => l.code === 'loss_woo_barcode'));
});

test('WooCommerce → WooCommerce: vendor and barcode survive the CSV round trip', () => {
  const out = toWoo([product({ handle: 'a', vendor: 'Acme', variants: [variant({ sku: 'A-1', barcode: '4006381333931' })] })]);
  const back = convert(serializeCsv(out.headers, out.rows), { direction: 'woocommerce-to-shopify', entity: 'products', expectPlatform: 'woocommerce' });
  assert.equal(back.ok, true, JSON.stringify(back.errors));
  assert.equal(back.rows[0]['Vendor'], 'Acme');
  assert.equal(back.rows[0]['Variant Barcodes'], '4006381333931');
});
