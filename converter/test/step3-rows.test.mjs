/**
 * Step 3 « Correspondance »: one display model for the three cases (app/step3-rows.mjs). One row per column of the
 * FILE, real target columns read from the serialisers, three confidence levels plus « Vide », an alert when the
 * values contradict the destination. Real fixtures: a Scraper export (known format), a Shopify file with variants
 * (recognised platform), an unknown French supplier file (learn mode).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeMapping } from '../app/controller.mjs';
import { levelOf, fieldOfCanon, groupOf, GROUPS } from '../app/step3-rows.mjs';
import { parseCsv } from '../core/dist/index.mjs';
import { loadReferenceFormatsSync } from '../core/knowledge-proposal/reference.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const formats = loadReferenceFormatsSync();
const run = (rel, direction, overrides = {}) => analyzeMapping(read(rel), direction, overrides, { semantic: true, decisions: [], formats });
const rowOf = (s, col) => s.rows.find((r) => r.column === col);

test('levels: the 0.85 and 0.60 thresholds of eloshon-csv-mapping-expert', () => {
  assert.equal(levelOf(1), 'ok'); assert.equal(levelOf(0.85), 'ok'); assert.equal(levelOf(0.849), 'check');
  assert.equal(levelOf(0.6), 'check'); assert.equal(levelOf(0.59), 'uncertain');
});

test('Scraper export (known format) to Shopify: one row per file column, variants is ONE row with its destinations and an alert', async () => {
  const csv = 'test/fixtures/scraper/scraper_adidas_taught_swatches.csv';
  const s = (await run(csv, 'eloshon-to-shopify')).step3;
  const headers = parseCsv(read(csv)).headers;
  assert.equal(s.mode, 'knowledge');
  assert.deepEqual(s.rows.map((r) => r.column).sort(), [...headers].sort(), 'exactly the file columns, each once');
  const v = rowOf(s, 'variants');
  assert.equal(v.status, 'used');
  assert.ok(v.dests.some((d) => d.field === 'sku' && d.cols.includes('Variant SKU')), 'the SKU of the variants lands in « Variant SKU »');
  assert.ok(v.dests.some((d) => d.field === 'options'), 'and feeds the options');
  assert.equal(v.alert?.code, 'sku_label', 'labels « Couleur du produit : … » are not SKUs');
  assert.equal(v.level, 'check', 'an alert is at least « À vérifier »');
  assert.ok(v.samples.length && v.samples.every((x) => !x.startsWith('[')), 'the variants row shows the variants’ values, not raw JSON');
  assert.ok(rowOf(s, 'slug').dests.some((d) => d.field === 'handle' && d.cols.includes('Handle')));
  assert.deepEqual(rowOf(s, 'name').dests.map((d) => d.cols), [['Title']]);
  assert.equal(rowOf(s, 'name').origin, 'format');
  assert.equal(rowOf(s, 'name').level, 'ok');
  // the source URL travels as a metafield (read from the Shopify serialiser, not from a table)
  assert.ok(rowOf(s, 'source_url').dests[0].cols[0].includes('product.metafields.eloshon.source_url'));
  // a column empty on every row is « Vide », never « Sûr », and is not counted as safe
  for (const col of ['barcode', 'weight_kg', 'hs_code', 'product_type', 'net_content']) {
    const r = rowOf(s, col);
    assert.equal(r.level, 'empty', col); assert.equal(r.status, 'empty', col); assert.equal(r.filled, 0, col);
    assert.equal(r.reason.code, 'empty', col);
  }
  assert.equal(s.counts.ok + s.counts.check + s.counts.uncertain + s.counts.empty + s.counts.ignored, s.counts.all);
  assert.equal(s.counts.todo, s.counts.check + s.counts.uncertain);
  assert.ok(s.rows.every((r) => r.samples.length <= 3));
  // lowest confidence first: the alert row leads, empty rows close the list
  assert.equal(s.rows[0].column, 'variants');
  assert.equal(s.rows.at(-1).level, 'empty');
  // the barcode column is empty: the platform's barcode is listed as not fed
  assert.ok(s.unfed.some((u) => u.field === 'barcode' && u.cols.includes('Variant Barcodes')));
  assert.equal(s.memory, 'format');
});

test('Shopify file with variants to WooCommerce (recognised platform): every file column is a row, structural families included', async () => {
  const csv = 'test/fixtures/shopify_products.csv';
  const s = (await run(csv, 'shopify-to-woocommerce')).step3;
  const headers = parseCsv(read(csv)).headers;
  assert.equal(s.mode, 'plan');
  assert.equal(s.rows.length, headers.length, `${s.rows.length} rows for ${headers.length} columns`);
  assert.deepEqual(rowOf(s, 'Variant SKU').dests.map((d) => d.cols), [['SKU']]);
  assert.deepEqual(rowOf(s, 'Title').dests[0].cols, ['Name']);
  assert.deepEqual(rowOf(s, 'Vendor').dests[0].cols, ['Brands']);
  assert.deepEqual(rowOf(s, 'Handle').dests[0].cols, [], 'WooCommerce has no handle column: not carried');
  assert.equal(rowOf(s, 'Variant Compare At Price').reason.code, 'tricky');
  assert.equal(rowOf(s, 'Variant Compare At Price').level, 'check');
  const opt = rowOf(s, 'Option1 Value');
  assert.equal(opt.reason.code, 'structural'); assert.equal(opt.edit.canEdit, false);
  assert.equal(rowOf(s, 'Variant Grams').reason.params?.kind !== 'price', true, 'a weight is never said to hold prices');
  assert.equal(rowOf(s, 'Variant SKU').edit.canEdit, true);
  assert.deepEqual(rowOf(s, 'Variant SKU').edit.ruleIds, ['sku']);
  assert.equal(rowOf(s, 'Option3 Name').level, 'empty');
  assert.ok(s.choices.some((c) => c.field === 'sku' && c.ruleId === 'sku' && c.cols.includes('SKU')));
  // a rule set to « do not import » makes its column an ignored row, with what the user chose
  const b = (await run(csv, 'shopify-to-woocommerce', { vendor: { column: null } })).step3;
  const vendor = rowOf(b, 'Vendor');
  assert.equal(vendor.status, 'ignored'); assert.equal(vendor.reason.code, 'ignored_user'); assert.equal(vendor.edit.ignoredRule, 'vendor');
  assert.equal(b.counts.ignored, 1);
});

test('unknown French supplier file (learn mode): proposals with level, origin and the real target column', async () => {
  const s = (await run('test/fixtures/supplier_fr.csv', 'eloshon-to-shopify')).step3;
  assert.equal(s.mode, 'learn');
  assert.equal(s.rows.length, 10);
  const ref = rowOf(s, 'Référence');
  assert.deepEqual(ref.dests[0].cols, ['Variant SKU']);
  assert.equal(ref.origin, 'name'); assert.ok(ref.score >= 0.85 && ref.level === 'ok');
  assert.ok(ref.candidates.length >= 2, 'the alternatives travel with the row');
  assert.equal(rowOf(s, 'Code EAN').reason.code, 'values_are');
  assert.equal(rowOf(s, 'Code EAN').reason.params.kind, 'ean');
  const internal = rowOf(s, 'Colonne interne');
  assert.equal(internal.status, 'unknown'); assert.equal(internal.reason.code, 'no_destination');
  assert.ok(s.unfed.some((u) => u.field === 'handle' && u.required), 'Shopify requires a handle: listed');
  assert.equal(s.unfed[0].required, true, 'required fields first');
  assert.equal(s.memory, 'column');
  const woo = (await run('test/fixtures/supplier_fr.csv', 'eloshon-to-woocommerce')).step3;
  assert.deepEqual(rowOf(woo, 'Référence').dests[0].cols, ['SKU']);
});

test('the SKU generator set at step 3 reaches the conversion: before / after preview, generated SKUs listed', async () => {
  const { runConversion } = await import('../app/controller.mjs');
  const csvText = read('test/fixtures/supplier_fr.csv');
  const knowledge = { formats };
  // the unknown file is learned first (as « Mémoriser ce format » does), so it converts
  const { learnFormat, proposeFormatId, semanticAnalyze } = await import('../core/dist/index.mjs');
  const t = parseCsv(csvText);
  const id = proposeFormatId(t.headers, { provenance: 'unknown', hint: 'csv' });
  const fmt = learnFormat({ headers: t.headers, report: semanticAnalyze(t.headers, t.rows, 'products', { formatId: id, decisions: [] }), id, hint: 'test', provenance: 'unknown', platform: 'eloshon', by: 'user' });
  const input = { csvText, direction: 'eloshon-to-shopify', expectPlatform: 'eloshon', knowledge: { formats: [...knowledge.formats, fmt] } };
  const off = runConversion(input);
  assert.ok(off.ok);
  assert.equal(off.skus.generator, false);
  assert.equal(off.skus.preview, undefined, 'no preview while the generator is off');
  const on = runConversion({ ...input, skuGenerator: { enabled: true, source: 'title', prefix: 'EL', separator: '-', case: 'upper', maxLength: 24, transliterate: true } });
  assert.equal(on.skus.generator, true);
  assert.ok(on.skus.preview.length > 0 && on.skus.preview.length <= 6, 'before / after on 6 variants at most');
  // the file's own SKUs (Référence) are kept, never replaced
  assert.ok(on.skus.preview.every((r) => r.before === '' || r.after === r.before));
});

test('every field of the shipped product formats maps to a step-3 field and a theme', () => {
  const fields = new Set();
  for (const f of formats.filter((x) => x.entity === 'products')) for (const e of f.fields ?? []) if (e.canon) fields.add(fieldOfCanon(e.canon));
  for (const f of fields) assert.ok(GROUPS.includes(groupOf(f)), f);
  assert.equal(fieldOfCanon('variants[].sku'), 'sku');
  assert.equal(fieldOfCanon('variants[].imageSrc'), 'variantImage');
  assert.equal(fieldOfCanon('sourceExtension.eloshon.source_url'), 'sourceExtension');
  assert.equal(groupOf('price'), 'price'); assert.equal(groupOf('images'), 'images');
});
