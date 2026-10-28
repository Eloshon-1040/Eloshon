/**
 * Headless check: the extracted converter engine runs end-to-end with ZERO
 * Homie Book / browser / Supabase dependency, and the free-tier cap works.
 */
import assert from 'node:assert/strict';
import { convert, detectFormat, serializeCsv } from '../core/dist/index.mjs';
import { DIRECTIONS, DEFAULT_FREE_LIMIT } from '../core/directions.mjs';

// A minimal but valid Shopify products export (Handle + Variant Price = the spine).
const HEADERS = ['Handle', 'Title', 'Body (HTML)', 'Vendor', 'Type', 'Tags', 'Published', 'Variant SKU', 'Variant Price', 'Variant Inventory Qty', 'Image Src'];
const N = 14;
const rows = Array.from({ length: N }, (_, i) => {
  const v = ['prod-' + (i + 1), 'Product ' + (i + 1), '<p>desc</p>', 'Acme', 'Widget', 'a,b', 'TRUE', 'SKU' + (i + 1), (9 + i).toFixed(2), '5', 'https://x/' + (i + 1) + '.jpg'];
  return Object.fromEntries(HEADERS.map((h, j) => [h, v[j]]));
});
const csv = serializeCsv(HEADERS, rows);

// detection
assert.equal(detectFormat(HEADERS).format, 'shopify_products');
console.log('✓ detect: shopify_products');

// full conversion Shopify → WooCommerce
const full = convert(csv, { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' });
assert.equal(full.ok, true, 'conversion ok');
assert.equal(full.sourceFormat, 'shopify_products');
assert.ok(full.targetFormat.startsWith('woo'), 'target is WooCommerce');
assert.equal(full.counts.inputUnits, N, 'all input units seen');
assert.ok(full.rows.length >= N, 'full output rows');
console.log(`✓ convert Shopify→WooCommerce: ${full.counts.inputUnits} units → ${full.rows.length} rows`);

// free-tier cap (the "10 lines then paid" model): output capped to freeLimit
const cap = convert(csv, { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify', limitUnits: DEFAULT_FREE_LIMIT });
assert.ok(cap.ok, 'capped conversion ok');
assert.ok(cap.rows.length < full.rows.length, 'free cap reduces the downloadable output');
assert.equal(cap.counts.inputUnits, N, 'preview still reports the full count');
console.log(`✓ free cap (${DEFAULT_FREE_LIMIT}): ${cap.rows.length} rows written vs ${full.rows.length} full — preview count still ${cap.counts.inputUnits}`);

// wrong-file guard (a Woo file into a Shopify-source direction → clean failure, no bad output)
const wrong = convert(csv, { direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce' });
assert.equal(wrong.ok, false, 'wrong platform → ok:false (no silent bad conversion)');
console.log('✓ wrong-file guard: clean failure code =', wrong.errors[0]?.code);

// catalog sanity
assert.ok(DIRECTIONS.length >= 12 && DIRECTIONS.every((d) => d.freeLimit === 10 && d.priceEur === 19));
console.log(`✓ catalog: ${DIRECTIONS.length} directions, freeLimit 10 / 19€`);

console.log('\nCONVERTER CORE OK — standalone, no Homie Book dependency.');
