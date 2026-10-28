// Canon population — Shopware Admin API (real payloads) and the parent →
// variant INHERITANCE mechanism declared as data (structure.inheritance).
// Cross-checked against WooCommerce's one-field sentinel (manage_stock:
// "parent") so the three real inheritance models are all under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWithKnowledge, validateFormatTransforms } from '../generic-parser.mjs';
import { loadReferenceFormatsSync } from '../reference.mjs';
import { makeValidator } from '../validator.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..', '..');
const LIVE = path.join(ROOT, 'test', 'fixtures', 'live', 'shopware-test');
const J = (n) => JSON.parse(fs.readFileSync(path.join(LIVE, n), 'utf8'));
const FMT = loadReferenceFormatsSync().find((f) => f.id === 'shopware.products.admin-api.v1');
const products = J('products.json');
const variations = J('variations.json');
const parse = () => parseWithKnowledge(FMT, products, { companions: { variations } });

test('format entry: schema-valid, transforms exist, every live key (product AND variant rows) has a declared fate', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(here, '..', 'schema.json'), 'utf8'));
  const r = makeValidator(schema, 'formatKnowledge')(FMT);
  assert.equal(r.ok, true, r.errors.map((e) => e.path + ' ' + e.msg).join('; '));
  assert.deepEqual(validateFormatTransforms(FMT), []);
  const { report } = parse();
  assert.deepEqual(report, { units: 3, variants: 11, unknownKeys: [], warnings: [] });
});

test('inheritance: a variant with null price/weight/tax/cover takes the parent value, provenance says so; own stock stays exact', () => {
  const { products: canon } = parse();
  const p = canon.find((x) => x.handle === 'SWDEMO10005');
  assert.equal(p.kind, 'variable');
  assert.equal(p.variants.length, 6);
  const raw = variations.find((v) => v.productNumber === 'SWDEMO10005.1');
  assert.equal(raw.price, null, 'fixture: the child really has no own price');
  assert.equal(raw.weight, null); assert.equal(raw.taxId, null); assert.equal(raw.cover, null);
  const v = p.variants.find((x) => x.sku === 'SWDEMO10005.1');
  assert.equal(v.price, 19.99);
  // Phase 6.2 — the typed marker replaces `structural` + a free-text note.
  assert.equal(v.provenance.price.method, 'inherited');
  assert.equal(v.provenance.price.note, undefined, 'no free-text note: the method IS the marker');
  assert.equal(v.grams, 500); assert.equal(v.provenance.grams.method, 'inherited');
  assert.equal(v.taxClass, 'Standard rate'); assert.equal(v.taxable, true); assert.equal(v.provenance.taxable.method, 'inherited');
  // Every provenance entry on the variant is either the child's own ('exact')
  // or the parent's ('inherited') — nothing in between, nothing in prose.
  for (const [k, pr] of Object.entries(v.provenance)) assert.ok(['exact', 'inherited'].includes(pr.method), `${k}: ${pr.method}`);
  assert.ok(v.imageSrc.endsWith('shirt_600x600.jpg?ts=1757935932'), 'cover inherited');
  assert.equal(v.inventoryQty, 50); assert.equal(v.provenance.inventoryQty.method, 'exact', 'stock is the variant\'s own');
  assert.equal(v.sku, 'SWDEMO10005.1'); assert.equal(v.provenance.sku.method, 'exact');
  assert.deepEqual(v.stockPolicy, { manageStock: true, backorders: 'yes', soldIndividually: false });
});

test('options: axis from the parent configurator, values aligned per variant from `variation` pairs', () => {
  const { products: canon } = parse();
  const p = canon.find((x) => x.handle === 'SWDEMO10005');
  assert.deepEqual(p.options, [{ name: 'Colour', values: ['Blue', 'Red', 'White'] }, { name: 'Size', values: ['M', 'XL'] }]);
  const combos = p.variants.map((v) => v.optionValues.join('|')).sort();
  assert.deepEqual(combos, ['Blue|M', 'Blue|XL', 'Red|M', 'Red|XL', 'White|M', 'White|XL']);
  // attributesRich keeps BOTH roles of the shared property-group entity
  const size = p.attributesRich.filter((a) => a.name === 'Size');
  assert.equal(size.length, 2);
  assert.deepEqual(size.find((a) => a.forVariation).values, ['M', 'XL']);
  assert.deepEqual(size.find((a) => !a.forVariation).values, ['M', 'XL'], 'same group referenced through the properties relation too');
  // SWDEMO10007: the SAME group "Size" is an axis with 4 values AND a filterable property with 4 values
  const q = canon.find((x) => x.handle === 'SWDEMO10007');
  assert.deepEqual(q.options, [{ name: 'Size', values: ['L', 'M', 'S', 'XL'] }]);
  assert.equal(q.attributesRich.filter((a) => a.name === 'Size').length, 2);
  assert.deepEqual(q.attributesRich.filter((a) => !a.forVariation).map((a) => a.name).sort(), ['Material', 'Size', 'Target group']);
});

test('pricing: gross of the first currency; rule × tier matrix → priceTiers (C1) with the raw matrix kept; categories from breadcrumb; dimensions mm → cm', () => {
  const { products: canon } = parse();
  const p = canon.find((x) => x.handle === 'SWDEMO10002');
  assert.equal(p.kind, 'simple'); assert.equal(p.variants.length, 1);
  const v = p.variants[0];
  assert.equal(v.price, 950); assert.equal(v.compareAtPrice, null);
  assert.equal(v.provenance.price.method, 'exact');
  assert.equal(v.sourceExtension.shopware.price[0].net, 798.3199999999999, 'net kept verbatim in the variant extension');
  const prices = p.sourceExtension.shopware.prices;
  assert.equal(prices.length, 2);
  assert.ok(prices.every((x) => x.ruleId && x.quantityStart), 'rule + quantity tiers');
  // C1: the matrix has a canon home now — no longer "promotable", and never an unmapped entry
  assert.ok(!(p.unmapped || []).some((u) => u.sourceField === 'prices'), 'prices is canonical (priceTiers), not unmapped');
  assert.equal(v.priceTiers.length, 2); assert.equal(v.priceTiers[0].scope.ruleRef, prices[0].ruleId);
  assert.deepEqual(p.categories, ['Catalogue #1 > Free time & electronics']);
  assert.deepEqual([v.lengthCm, v.widthCm, v.heightCm], [84, 59, 60]);
  assert.equal(v.grams, 45000);
  assert.equal(v.sourceExtension.shopware.tax.rules.length > 20, true, 'per-country tax rules preserved');
});

test('identity & merchandising: sourceId, canonical SEO slug, timestamps, vendor, featured, sales counter promotable', () => {
  const { products: canon } = parse();
  const p = canon.find((x) => x.handle === 'SWDEMO10007');
  assert.equal(p.identity.sourceId, 'c7bca22753c84d08b6178a50052b4146');
  assert.equal(p.identity.slug, 'Main-product-with-properties/SWDEMO10007');
  assert.match(p.identity.timestamps.created, /^2025-09-15T11:32:13/);
  assert.equal(p.vendor, 'Shopware Fashion');
  assert.deepEqual(p.visibility, { featured: false });
  assert.equal(p.status, 'active'); assert.equal(p.published, true);
  assert.ok('sales' in p.sourceExtension.shopware);
  assert.equal(p.sourceExtension.shopware.versionId, '0fa91ce3e96a4bc2be4bd9ce752c3425');
});

test('inheritance is data: switching nullMeansParent off leaves child fields empty (provenance absent)', () => {
  const noInherit = { ...FMT, structure: { ...FMT.structure, inheritance: { nullMeansParent: false } } };
  const { products: canon } = parseWithKnowledge(noInherit, products, { companions: { variations } });
  const v = canon.find((x) => x.handle === 'SWDEMO10005').variants.find((x) => x.sku === 'SWDEMO10005.1');
  assert.equal(v.price, null); assert.equal(v.grams, null); assert.equal(v.imageSrc, '');
  assert.equal(v.provenance.price.method, 'exact', 'faithful: the source said null');
  assert.equal(v.provenance.price.sourceValue, null);
  assert.equal(v.inventoryQty, 50);
});

test('cross-platform: WooCommerce inherits ONE field by sentinel (manage_stock: "parent"), Shopware inherits by null — both land on the same canon', () => {
  const WC = loadReferenceFormatsSync().find((f) => f.id === 'woocommerce.products.rest.v1');
  const wcLive = path.join(ROOT, 'test', 'fixtures', 'live', 'woocommerce-test');
  const wcProducts = JSON.parse(fs.readFileSync(path.join(wcLive, 'products.json'), 'utf8'));
  const wcVariations = { 13: JSON.parse(fs.readFileSync(path.join(wcLive, 'products-13-variations.json'), 'utf8')) };
  const wc = parseWithKnowledge(WC, wcProducts, { companions: { variations: wcVariations } }).products.find((p) => p.identity.sourceId === '13');
  const sw = parse().products.find((p) => p.handle === 'SWDEMO10005');
  // WooCommerce: the variation carries its OWN price (explicit), stock policy inherited through the sentinel
  assert.equal(wcVariations[13][0].manage_stock, 'parent');
  assert.equal(wc.variants[0].stockPolicy.manageStock, true);
  assert.equal(wc.variants[0].provenance.price.method, 'exact');
  // Shopware: the variation carries NO price (null) — inherited from the parent (typed marker, 6.2)
  assert.equal(sw.variants[0].provenance.price.method, 'inherited');
  // same canon shape either way: every variant has a materialised price and stock policy
  for (const v of [...wc.variants, ...sw.variants]) {
    assert.equal(typeof v.price, 'number');
    assert.equal(typeof v.stockPolicy.manageStock, 'boolean');
  }
});
