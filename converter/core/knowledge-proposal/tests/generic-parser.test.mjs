// Phase 5.5 — Generic parser against REAL WooCommerce REST payloads
// (test/fixtures/live/woocommerce-test, captured 2026-09-21, PII pseudonymised).
// Asserts: extended canon populated, relations reconstructed, nothing lost.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWithKnowledge, validateFormatTransforms } from '../generic-parser.mjs';
import { TRANSFORMS } from '../transforms.mjs';
import { loadReferenceFormatsSync } from '../reference.mjs';
import { makeValidator } from '../validator.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..', '..');
const LIVE = path.join(ROOT, 'test', 'fixtures', 'live', 'woocommerce-test');
const J = (n) => JSON.parse(fs.readFileSync(path.join(LIVE, n), 'utf8'));
const FMT = loadReferenceFormatsSync().find((f) => f.id === 'woocommerce.products.rest.v1');
const products = J('products.json');
const variations = { '13': J('products-13-variations.json') };
const categories = J('categories.json');
const parse = (opts = {}) => parseWithKnowledge(FMT, products, { companions: { variations, categories }, ...opts });

test('format entry: schema-valid, every transform exists, every live key has a declared fate', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(here, '..', 'schema.json'), 'utf8'));
  const r = makeValidator(schema, 'formatKnowledge')(FMT);
  assert.equal(r.ok, true, r.errors.map((e) => e.path + ' ' + e.msg).join('; '));
  assert.deepEqual(validateFormatTransforms(FMT), []);
  const { report } = parse();
  assert.deepEqual(report.unknownKeys, [], 'a live key without a declared fate');
  assert.equal(report.units, 2); assert.equal(report.variants, 13);
  assert.deepEqual(report.warnings, []);
});

test('simple product: extended canon populated (identity, kind, visibility, merchandising, price/promo, GTIN, dims, stockPolicy)', () => {
  const p = parse().products.find((x) => x.identity.sourceId === '27');
  assert.equal(p.title, 'AC Infinity A8 - 200mm');
  assert.equal(p.handle, 'ac-infinity-a8-200mm');
  assert.equal(p.kind, 'simple');
  assert.equal(p.status, 'active'); assert.equal(p.published, true);
  assert.deepEqual(p.visibility, { featured: false, catalogVisibility: 'visible' });
  assert.equal(p.identity.timestamps.created, '2026-09-20T20:57:14.000Z');
  assert.equal(p.vendor, 'AC Infinity', 'brands taxonomy → vendor');
  assert.deepEqual(p.tags, ['200mm', 'extracteur', 'ventilation']);
  assert.deepEqual(p.categories, ['Ventilation > Extracteurs'], 'hierarchy rebuilt from the companion, ancestor subsumed');
  assert.deepEqual(p.merchandising, { related: ['13'], menuOrder: 0 });
  assert.equal(p.attributesRich.length, 2);
  assert.ok(p.attributesRich.every((a) => a.forVariation === false), 'descriptive attributes kept, not options');
  assert.deepEqual(p.options, []);
  assert.equal(p.images[0].alt, 'le logo de levis'); assert.equal(p.images[0].id, 28);
  assert.equal(p.variants.length, 1);
  const v = p.variants[0];
  assert.equal(v.sku, 'AC-INFA8');
  assert.equal(v.price, 150); assert.equal(v.compareAtPrice, 200, 'sale active → charged / was');
  assert.equal(v.barcode, '06735597626425', 'global_unique_id → barcode');
  assert.equal(v.grams, 14000); assert.equal(v.lengthCm, 45); assert.equal(v.widthCm, 24); assert.equal(v.heightCm, 56);
  assert.equal(v.inventoryQty, 6);
  assert.deepEqual(v.stockPolicy, { manageStock: true, backorders: 'no', soldIndividually: false });
  assert.equal(v.taxable, true); assert.equal(v.requiresShipping, true);
  assert.equal(v.imageSrc, p.images[0].src, 'simple product: first image is the variant image');
  assert.equal(v.salePeriod, undefined, 'no scheduled sale → absent, not {from:null,to:null}');
  assert.equal(p.external, undefined); assert.equal(p.notes, undefined, 'empty optional blocks are not emitted');
});

test('variable product: 12 variations, options axis, optionValues aligned, parent-inherited stock policy', () => {
  const p = parse().products.find((x) => x.identity.sourceId === '13');
  assert.equal(p.kind, 'variable');
  assert.deepEqual(p.options.map((o) => o.name), ['Couleur / variante', 'Taille']);
  assert.equal(p.variants.length, 12);
  const combos = new Set(p.variants.map((v) => v.optionValues.join('|')));
  assert.equal(combos.size, 12, 'every variation has a distinct option combination');
  for (const v of p.variants) {
    assert.equal(v.optionValues.length, 2);
    assert.ok(p.options[0].values.includes(v.optionValues[0]) && p.options[1].values.includes(v.optionValues[1]));
    assert.equal(v.price, 300); assert.equal(v.compareAtPrice, 400);
    assert.deepEqual(v.stockPolicy, { manageStock: true, backorders: 'notify' }, 'manage_stock:"parent" inherited');
    assert.equal(v.inventoryQty, -1, 'negative stock kept (backordered)');
    assert.equal(v.sourceExtension.woocommerce.stock_status, 'onbackorder');
    assert.ok(typeof v.sourceExtension.woocommerce.id === 'number');
    assert.equal(v.provenance.price.transform, 'price_promo');
    assert.equal(v.provenance.price.sourceField, 'regular_price + sale_price + on_sale');
  }
  assert.ok(p.attributesRich.every((a) => a.forVariation === true));
});

test('no silent loss: promotable fields listed in unmapped[] with a reason, platform-specific kept in sourceExtension only', () => {
  const p = parse().products.find((x) => x.identity.sourceId === '27');
  const reasons = Object.fromEntries((p.unmapped || []).map((u) => [u.sourceField, u.reason]));
  assert.equal(reasons.total_sales, 'no-canon-field');
  assert.equal(reasons.average_rating, 'no-canon-field');
  assert.equal(reasons.low_stock_amount, 'no-canon-field');
  assert.ok(!('permalink' in reasons), 'platform-specific is not reported as a loss');
  assert.equal(p.sourceExtension.woocommerce.permalink, 'http://localhost:8881/product/ac-infinity-a8-200mm/');
  assert.equal(p.sourceExtension.woocommerce._raw, undefined, 'nothing unknown on a fully described format');
  // a variant with an EMPTY description is not a loss; one with content is
  const variable = parse().products.find((x) => x.identity.sourceId === '13');
  const v14 = variable.variants.find((v) => v.sourceExtension.woocommerce.id === 14);
  assert.ok(v14.unmapped.some((u) => u.sourceField === 'description' && u.reason === 'no-canon-field'));
  const v15 = variable.variants.find((v) => v.sourceExtension.woocommerce.id === 15);
  assert.ok(!(v15.unmapped || []).some((u) => u.sourceField === 'description'));
});

test('unknown source keys are preserved verbatim under _raw and flagged unknown', () => {
  const extra = products.map((p) => ({ ...p, some_plugin_field: { a: 1 }, wc_future_key: 'x' }));
  const { products: out, report } = parseWithKnowledge(FMT, extra, { companions: { variations, categories } });
  assert.deepEqual(report.unknownKeys, ['some_plugin_field', 'wc_future_key']);
  assert.deepEqual(out[0].sourceExtension.woocommerce._raw, { some_plugin_field: { a: 1 }, wc_future_key: 'x' });
  assert.ok(out[0].unmapped.some((u) => u.sourceField === 'wc_future_key' && u.reason === 'unknown'));
});

test('missing companions: flat categories, self-variant fallback + warning for declared variations', () => {
  const { products: out, report } = parseWithKnowledge(FMT, products, { companions: {} });
  const variable = out.find((x) => x.identity.sourceId === '13');
  assert.equal(variable.variants.length, 1, 'falls back to the product as its own variant');
  assert.deepEqual(report.warnings, [{ code: 'variants_missing_companion', unit: '13', expected: 12 }]);
  const simple = out.find((x) => x.identity.sourceId === '27');
  assert.deepEqual(simple.categories, ['Extracteurs', 'Ventilation'], 'flat names without the taxonomy');
});

test('provenance on every canonical value written', () => {
  const p = parse().products[0];
  for (const k of ['title', 'handle', 'bodyHtml', 'vendor', 'tags', 'categories', 'kind', 'status', 'published', 'images', 'attributesRich', 'identity.sourceId']) {
    assert.ok(p.provenance[k], 'missing provenance for ' + k);
    assert.equal(p.provenance[k].platform, 'woocommerce');
    assert.equal(p.provenance[k].method, 'exact');
  }
  assert.equal(p.provenance.title.sourceValue, p.title);
});

test('transforms: units, sentinels, price/promo edge cases, category subsumption', () => {
  const ctx = (args) => ({ args, source: {}, parent: null, product: {}, companions: {}, field: null, platform: 't' });
  assert.equal(TRANSFORMS.weight_to_grams('1.5', ctx({ unit: 'kg' })), 1500);
  assert.equal(TRANSFORMS.weight_to_grams('2', ctx({ unit: 'lbs' })), 907);
  assert.equal(TRANSFORMS.length_to_cm('10', ctx({ unit: 'in' })), 25.4);
  assert.equal(TRANSFORMS.int_or_null(-1, ctx({ nullWhen: -1 })), null);
  assert.equal(TRANSFORMS.sentinel_to_null(30, ctx({ nullWhen: -1, asString: true })), '30');
  assert.deepEqual(TRANSFORMS.price_promo(['200', '150', true], ctx()), [150, 200]);
  assert.deepEqual(TRANSFORMS.price_promo(['200', '150', false], ctx()), [200, null], 'on_sale=false → no promo even if sale_price set');
  assert.deepEqual(TRANSFORMS.price_promo(['200', '', undefined], ctx()), [200, null]);
  assert.deepEqual(TRANSFORMS.price_promo(['', '150', true], ctx()), [150, null], 'no regular price → sale is the price');
  assert.deepEqual(TRANSFORMS.enum_map('publish', ctx({ map: { publish: 'active' }, default: 'draft' })), 'active');
  assert.deepEqual(TRANSFORMS.enum_map('weird', ctx({ map: { publish: 'active' }, default: 'draft' })), 'draft');
  const terms = [{ id: 21, name: 'Extracteurs' }, { id: 16, name: 'Ventilation' }];
  assert.deepEqual(TRANSFORMS.category_paths_from_terms(terms, { ...ctx({ lookup: 'categories' }), companions: { categories } }), ['Ventilation > Extracteurs']);
  assert.deepEqual(TRANSFORMS.stock_policy(['parent', 'notify', undefined], { ...ctx({ parentPath: 'manage_stock' }), parent: { manage_stock: false } }), { manageStock: false, backorders: 'notify' });
});
