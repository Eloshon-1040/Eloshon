/**
 * Phase 2 Lot 2 — the .eloshon READER (owner decision A: reader only; the
 * Scraper keeps writing products.json). Envelopes are built with the catalog's
 * own writer (newEloshon / CommandLog, vendored byte-identical) — never
 * hand-rolled: test/fixtures/eloshon/catalog-edited.eloshon comes from
 * scripts/gen-eloshon-fixture.mjs; the edge cases below build theirs in memory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert, readEloshonText, isEloshonText, analyzeProblems } from '../core/dist/index.mjs';
import { newEloshon, stringifyEloshon, CommandLog, ELOSHON_VERSION } from '../core/vendor/eloshon-catalog/index.mjs';
import { analyzeMapping } from '../app/controller.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'eloshon', 'catalog-edited.eloshon'), 'utf8');
const toShopify = (text) => convert(text, { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' });
const codes = (r) => r.warnings.map((w) => w.code);

// A minimal canon product, the same helper shape the catalog's own tests use.
const product = (id, over = {}) => ({
  id, handle: `p-${id}`, title: `Product ${id}`, bodyHtml: '', vendor: '', productType: '',
  tags: [], status: 'active', categories: [], published: true, options: [],
  variants: [{ optionValues: [], sku: `SKU-${id}`, price: 9.99, compareAtPrice: null, cost: null, barcode: '', grams: null, lengthCm: null, widthCm: null, heightCm: null, requiresShipping: true, taxable: true, inventoryQty: null, imageSrc: '' }],
  images: [], metafields: [], seoTitle: '', seoDescription: '', ...over,
});

test('detection: an .eloshon envelope is recognised; products.json / CSV are not', () => {
  assert.equal(isEloshonText(FIXTURE), true);
  assert.equal(isEloshonText('[{"name_fr":"x"}]'), false);
  assert.equal(isEloshonText('Handle,Title\n'), false);
});

test('round trip: a fresh newEloshon catalogue converts with its canon intact', () => {
  const text = stringifyEloshon(newEloshon({ products: [product('1'), product('2', { vendor: 'Acme', tags: ['a', 'b'] })], source: { type: 'import' } }));
  const r = toShopify(text);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.sourceFormat, 'eloshon.catalog.v1');
  assert.equal(r.counts.outputUnits, 2);
  assert.deepEqual(r.warnings, [], 'no edits, nothing removed, nothing to report');
  const row = r.rows.find((x) => x['Handle'] === 'p-2');
  assert.equal(row['Vendor'], 'Acme');
  assert.equal(row['Variant SKU'], 'SKU-2');
  assert.equal(row['Tags'], 'a, b');
});

test('the edit log is replayed over the frozen source and each edit becomes provenance', () => {
  const read = readEloshonText(FIXTURE);
  assert.equal(read.ok, true);
  assert.equal(read.entity, 'products');
  assert.equal(read.products.length, 3, '4 source products, 1 removed by the edit log');
  const [p1, p2] = read.products;
  assert.equal(p1.title, 'Housse de coussin en lin lavé — bleu');
  assert.equal(p1.provenance.title.method, 'override');
  assert.equal(p1.provenance.title.sourceField, 'edits.commands[0]');
  assert.match(p1.provenance.title.note, /Titre retravaillé/);
  assert.equal(p2.vendor, 'Lin & Co (Belgique)');
  assert.equal(p2.provenance.vendor.transform, 'bulk-set-field');
  // untouched fields keep the provenance the source carried (the products.json mapping)
  assert.equal(p2.provenance.title.sourceField, 'name_fr');
  assert.equal(p1.variants[0].provenance.price.sourceField, 'price');

  const r = toShopify(FIXTURE);
  assert.equal(r.ok, true);
  assert.deepEqual(codes(r), ['eloshon_edits_applied', 'eloshon_products_removed', 'eloshon_other_entities']);
  assert.equal(r.warnings[0].params.count, 3);
  assert.equal(r.warnings[1].params.count, 1);
  assert.deepEqual(r.warnings[2].params, { products: 0, customers: 1, orders: 0 });
  assert.equal(r.rows.find((x) => x['Variant SKU'] === 'HC-100-BL')['Title'], 'Housse de coussin en lin lavé — bleu');
  assert.equal(r.rows.some((x) => x['Variant SKU'] === 'BG-310'), false, 'the removed product is not exported');
});

test('catalog extras reuse the products.json keys; unknown product keys are preserved and listed', () => {
  const text = stringifyEloshon(newEloshon({ products: [product('7', { sourceUrl: 'https://shop.example/p/7', sourceProductId: 'SRC-7', strategy: 'generic-jsonld', confidence: 0.9, futureField: { a: 1 } })] }));
  const [p] = readEloshonText(text).products;
  const ext = p.sourceExtension.eloshon;
  assert.equal(ext.eloshon_id, '7');
  assert.equal(ext.source_url, 'https://shop.example/p/7');
  assert.equal(ext.extractor, 'generic-jsonld');
  assert.equal(ext.confidence, 0.9);
  assert.equal(p.identity.sourceId, 'SRC-7');
  assert.equal(p.provenance['identity.sourceId'].sourceField, 'sourceProductId');
  assert.deepEqual(ext._raw.futureField, { a: 1 });
  assert.deepEqual(p.unmapped, [{ platform: 'eloshon', sourceField: 'futureField', sourceValue: { a: 1 }, reason: 'unknown' }]);
  for (const k of ['id', 'sourceUrl', 'sourceProductId', 'strategy', 'confidence', 'futureField']) assert.equal(k in p, false, `${k} moved out of the canon product`);
});

test('an edit that cannot apply is skipped and reported — never silent, never fatal', () => {
  const file = newEloshon({ products: [product('1'), product('2')] });
  const log = CommandLog.fromFile(file);
  log.setField('1', 'title', 'Edited');
  const out = log.writeInto(file);
  out.edits.commands.push({ id: 'x1', at: '2026-10-04T00:00:00Z', kind: 'restore', productId: '9' });           // declared EditKind, no CommandLog handler
  out.edits.commands.push({ id: 'x2', at: '2026-10-04T00:00:00Z', kind: 'set-field', productId: 'nope', field: 'title', value: 'X' }); // unknown product
  const r = toShopify(stringifyEloshon(out));
  assert.equal(r.ok, true);
  const skipped = r.warnings.find((w) => w.code === 'eloshon_edits_skipped');
  assert.deepEqual(skipped.params, { count: 2, kinds: 'restore, set-field' });
  assert.equal(r.warnings.find((w) => w.code === 'eloshon_edits_applied').params.count, 1);
  assert.equal(r.rows.find((x) => x['Handle'] === 'p-1')['Title'], 'Edited');
});

test('review fixes: card data never preserved; bulk edits on unknown ids reported; edit provenance on the real canon path', () => {
  const file = newEloshon({ products: [product('1', { cardNumber: '4111111111111111', sourceUrl: 'https://a' }), product('2')] });
  const log = CommandLog.fromFile(file);
  log.bulkSetField(['1', '2', 'gone'], 'vendor', 'Acme');
  log.setField('1', 'sourceUrl', 'https://b');
  const read = readEloshonText(stringifyEloshon(log.writeInto(file)));
  assert.ok(read.warnings.some((w) => w.code === 'pci_card_data_stripped'), 'the card column is detected');
  const p1 = read.products[0];
  assert.equal(JSON.stringify(p1).includes('4111111111111111'), false, 'the card number reaches neither the canon nor _raw / unmapped');
  assert.deepEqual(read.warnings.find((w) => w.code === 'eloshon_edits_skipped').params, { count: 1, kinds: 'bulk-set-field' });
  assert.equal(p1.provenance['sourceExtension.eloshon.source_url'].method, 'override');
  assert.equal(p1.provenance.sourceUrl, undefined);
});

test('an older envelope is migrated (reported); a newer one is refused with its own code', () => {
  const legacy = JSON.stringify({ eloshon: { kind: 'catalog', version: 0, generator: 'old', createdAt: 'x' }, source: { type: 'import' }, catalog: { products: [product('9')] } });
  const r = toShopify(legacy);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings.find((w) => w.code === 'eloshon_migrated').params, { from: 0, to: ELOSHON_VERSION });

  const future = JSON.stringify({ eloshon: { kind: 'catalog', version: ELOSHON_VERSION + 1 }, catalog: { products: [product('1')] } });
  const f = toShopify(future);
  assert.equal(f.ok, false);
  assert.equal(f.errors[0].code, 'eloshon_too_new');
  const gate = analyzeProblems(future, { direction: 'eloshon-to-shopify' });
  assert.equal(gate.canExport, false);

  const notCatalog = toShopify(JSON.stringify({ eloshon: { kind: 'project', version: 1 } }));
  assert.equal(notCatalog.errors[0].code, 'eloshon_unreadable');
});

test('customers-only catalogue converts through the customers pipeline; impossible targets are refused', () => {
  const cust = { firstName: 'A', lastName: 'B', email: 'a@example.com', phone: '', note: '', tags: [], taxExempt: false, address: { company: '', address1: '', address2: '', city: 'Paris', province: '', provinceCode: '', country: 'FR', zip: '', phone: '' }, shipping: null, acceptsEmail: null, acceptsSms: null };
  const text = stringifyEloshon(newEloshon({ products: [], customers: [cust] }));
  const r = convert(text, { direction: 'eloshon-to-woocommerce', expectPlatform: 'eloshon' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.targetFormat, 'woo_customers');
  const wix = convert(text, { direction: 'eloshon-to-wix', expectPlatform: 'eloshon' });
  assert.equal(wix.errors[0].code, 'impossible_wix_customers');
});

test('the wizard surfaces: wrong page redirect, step-4 gate, step-2/3 analysis', async () => {
  const wrong = convert(FIXTURE, { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' });
  assert.equal(wrong.errors[0].code, 'wrong_platform');
  const gate = analyzeProblems(FIXTURE, { direction: 'eloshon-to-shopify' });
  assert.equal(gate.ok, true);
  assert.equal(gate.canExport, true);
  const a = await analyzeMapping(FIXTURE, 'eloshon-to-shopify');
  assert.equal(a.detection.knowledgeId, 'eloshon.catalog.v1');
  assert.equal(a.detection.platform, 'eloshon');
  assert.equal(a.knowledge.canonNative, true);
  assert.equal(a.rowCount, 3);
});
