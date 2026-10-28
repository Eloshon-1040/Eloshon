/**
 * Phase 5.5 — WooCommerce REST → canon → target CSV through the engine.
 * Real payloads (test/fixtures/live/woocommerce-test). The canon-first path
 * (convertFromCanon) reuses the same finishing pipeline as CSV sources.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWooRestJson, convertFromCanon, parseCsv, serializeCsv, convert } from '../core/dist/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = path.join(ROOT, 'test', 'fixtures', 'live', 'woocommerce-test');
const J = (n) => JSON.parse(fs.readFileSync(path.join(LIVE, n), 'utf8'));
const input = { products: J('products.json'), variations: { '13': J('products-13-variations.json') }, categories: J('categories.json') };

test('parseWooRestJson: 2 products / 13 variants, nothing unknown', () => {
  const { products, report } = parseWooRestJson(input);
  assert.equal(products.length, 2);
  assert.deepEqual(report, { units: 2, variants: 13, unknownKeys: [], warnings: [] });
});

test('WC REST → Shopify CSV: variant rows, options, charged/was prices, GTIN, weight in grams', () => {
  const { products } = parseWooRestJson(input);
  const res = convertFromCanon(products, { direction: 'woocommerce-to-shopify', entity: 'products', expectPlatform: 'woocommerce' }, 'woocommerce.products.rest.v1');
  assert.equal(res.ok, true);
  assert.equal(res.sourceFormat, 'woocommerce.products.rest.v1');
  assert.equal(res.targetFormat, 'shopify_products');
  assert.equal(res.counts.inputUnits, 2); assert.equal(res.counts.outputUnits, 2);
  const rows = res.rows;
  const a7 = rows.filter((r) => r['Handle'] === 'ac-infinity-a7-150mm');
  assert.equal(a7.length, 12, 'one Shopify row per variation');
  assert.equal(a7[0]['Option1 Name'], 'Couleur / variante'); assert.equal(a7[0]['Option2 Name'], 'Taille');
  assert.equal(a7[0]['Variant Price'], '300.00'); assert.equal(a7[0]['Variant Compare At Price'], '400.00');
  assert.equal(a7[0]['Variant Grams'], '12000');
  const a8 = rows.filter((r) => r['Handle'] === 'ac-infinity-a8-200mm');
  assert.equal(a8.length, 1);
  assert.equal(a8[0]['Variant Barcodes'], '06735597626425');
  assert.equal(a8[0]['Variant Price'], '150.00'); assert.equal(a8[0]['Variant Compare At Price'], '200.00');
  assert.equal(a8[0]['Vendor'], 'AC Infinity');
  assert.equal(a8[0]['Tags'], '200mm, extracteur, ventilation');
  assert.equal(a8[0]['Image Alt Text'], 'le logo de levis');
  assert.ok(serializeCsv(res.headers, res.rows).length > 0);
});

test('WC REST → WooCommerce CSV → re-parse (CSV parser): carried fields survive the round trip', () => {
  const { products } = parseWooRestJson(input);
  const res = convertFromCanon(products, { direction: 'woocommerce-to-woocommerce', entity: 'products', expectPlatform: 'woocommerce' }, 'woocommerce.products.rest.v1');
  assert.equal(res.ok, true);
  const csv = serializeCsv(res.headers, res.rows);
  const back = convert(csv, { direction: 'woocommerce-to-shopify', entity: 'products', expectPlatform: 'woocommerce' });
  assert.equal(back.ok, true, JSON.stringify(back.errors));
  // Compare through a common projection: what the WC CSV can carry.
  const direct = convertFromCanon(products, { direction: 'woocommerce-to-shopify', entity: 'products', expectPlatform: 'woocommerce' });
  // Handles: the WC CSV parser keys on SKU (shared across variations here) — compare everything but the handle.
  const proj = (rows) => rows.map((r) => [r['Option1 Value'], r['Option2 Value'], r['Variant SKU'], r['Variant Price'], r['Variant Compare At Price'], r['Variant Grams'], r['Variant Inventory Qty'], r['Title'], r['Tags']].join('|')).sort();
  const pd = proj(direct.rows), pb = proj(back.rows);
  assert.equal(pb.length, pd.length);
  assert.deepEqual(pb, pd);
});
