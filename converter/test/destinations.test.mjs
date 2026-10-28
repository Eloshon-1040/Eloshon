/**
 * Step 3 shows where each field lands in the target's product file. Those destinations are READ FROM THE SERIALISERS
 * (core/src/destinations.ts), never from a hand table: the hand tables had drifted (WooCommerce « handle → SKU
 * (parent) » after bb5f5df; barcodes, technical sheet, availability shown as « not carried »).
 *
 * The snapshot test/golden/destinations.json is the reviewed list. When a serialiser starts writing a field to other
 * columns, this test fails until the snapshot is regenerated and the change reviewed:
 *   UPDATE_DESTINATIONS=1 node --test test/destinations.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { productDestinations, PRODUCT_TARGETS, editableProductFields } from '../core/dist/destinations.mjs';
import { TARGET_FIELDS } from '../core/dist/mapping.mjs';
import { targetColumnsOf, columnEditChoices } from '../app/controller.mjs';
import { convertFromCanon } from '../core/dist/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAP = path.join(ROOT, 'test/golden/destinations.json');
const FORMAT = { shopify: 'shopify_products', woocommerce: 'woo_products_modern', wix: 'wix_products', bigcommerce: 'bigcommerce_products' };
const all = () => Object.fromEntries(PRODUCT_TARGETS.map((t) => [t, Object.fromEntries(Object.entries(productDestinations(t)).sort(([a], [b]) => a.localeCompare(b)))]));

test('what step 3 displays IS what the serialisers write (no hand table left)', () => {
  for (const t of PRODUCT_TARGETS) {
    const shown = TARGET_FIELDS[FORMAT[t]]; const written = productDestinations(t);
    assert.deepEqual(Object.fromEntries(Object.entries(shown).map(([k, v]) => [k, v.cols])), written, `${t}: TARGET_FIELDS ≠ serialiser`);
    assert.deepEqual(targetColumnsOf(FORMAT[t]), Object.fromEntries(columnEditChoices().map((c) => [c, written[c] ?? []])), `${t}: « Modifier » list ≠ serialiser`);
  }
  assert.deepEqual(columnEditChoices(), editableProductFields(), 'the app and the engine offer the same fields');
  const mapping = fs.readFileSync(path.join(ROOT, 'core/src/mapping.ts'), 'utf8');
  for (const name of ['T_SHOPIFY_P', 'T_WOO_MODERN_P', 'T_WIX_P', 'T_BC_P']) assert.ok(!mapping.includes(`const ${name}`), `hand table ${name} is back`);
});

test('the WooCommerce drift is gone: the handle is not written, the SKU goes to « SKU », the parent SKU is no handle', () => {
  const woo = productDestinations('woocommerce');
  assert.deepEqual(woo.handle, []);
  assert.deepEqual(woo.sku, ['SKU']);
  assert.ok(!Object.values(woo).flat().some((c) => /\(parent\)/.test(c)), 'no « (parent) » label');
  assert.equal(TARGET_FIELDS.woo_products_modern.handle.required, undefined, 'WooCommerce does not require a handle');
  // Known corrections the probe brought: barcodes and specifications are carried.
  assert.deepEqual(productDestinations('shopify')['identifiers.ean'], ['Variant Barcodes']);
  assert.deepEqual(productDestinations('woocommerce').specifications, ['Description']);
});

test('every displayed destination is a real column of a real conversion (a product with every field filled)', () => {
  const v = { optionValues: ['S'], sku: 'P-S', price: 10, compareAtPrice: 20, cost: 4, barcode: '4006381333931', grams: 500, lengthCm: 4, widthCm: 5, heightCm: 6, requiresShipping: true, taxable: true, inventoryQty: 3, imageSrc: 'https://probe.test/v.jpg' };
  const p = { handle: 'p', title: 'P', bodyHtml: '<p>x</p>', vendor: 'V', productType: 'T', tags: ['t'], published: true, options: [{ name: 'Taille', values: ['S', 'M'] }], variants: [v, { ...v, optionValues: ['M'], sku: 'P-M' }], images: [{ src: 'https://probe.test/a.jpg', position: 1, alt: '' }], categories: ['A > B'], metafields: [], seoTitle: 'S', seoDescription: 'D' };
  for (const t of PRODUCT_TARGETS) {
    const res = convertFromCanon([structuredClone(p)], { direction: `eloshon-to-${t}`, entity: 'products', expectPlatform: 'eloshon' });
    const headers = new Set(res.headers);
    for (const f of ['handle', 'title', 'bodyHtml', 'sku', 'price', 'compareAtPrice', 'barcode', 'grams', 'images', 'options']) {
      for (const col of productDestinations(t)[f] || []) assert.ok(headers.has(col), `${t}: ${f} → « ${col} » is not a column of the real output`);
    }
  }
});

test('the reviewed destination snapshot matches the serialisers', () => {
  const now = all();
  if (process.env.UPDATE_DESTINATIONS === '1' || !fs.existsSync(SNAP)) fs.writeFileSync(SNAP, JSON.stringify(now, null, 2) + '\n');
  assert.deepEqual(now, JSON.parse(fs.readFileSync(SNAP, 'utf8')), 'a serialiser now writes a field elsewhere: regenerate test/golden/destinations.json (UPDATE_DESTINATIONS=1) and review the diff');
});
