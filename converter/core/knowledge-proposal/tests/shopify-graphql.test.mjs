// Phase 6.3 — canon population from the Shopify Admin GraphQL payload (real
// dev-store data: 3 products / 24 variants, captured 2026-09-21) through the
// generic parser. Covers P2 (namespaced, typed metafields + the D3 SEO rule),
// P3 (customs identifiers, native barcode untouched) and the third variant
// model (everything explicit, no inheritance).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWithKnowledge, validateFormatTransforms } from '../generic-parser.mjs';
import { loadReferenceFormatsSync, loadCanonCatalogSync } from '../reference.mjs';
import { makeValidator } from '../validator.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..', '..');
const LIVE = path.join(ROOT, 'test', 'fixtures', 'live', 'shopify-test');
const products = JSON.parse(fs.readFileSync(path.join(LIVE, 'products.json'), 'utf8'));
const FMT = loadReferenceFormatsSync().find((f) => f.id === 'shopify.products.admin-graphql.v1');
const parse = () => parseWithKnowledge(FMT, products, { companions: {}, canon: loadCanonCatalogSync() });
const byHandle = (canon, h) => canon.find((p) => p.handle === h);

test('format entry: schema-valid, transforms exist, every live key (product AND variant) has a declared fate', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(here, '..', 'schema.json'), 'utf8'));
  const r = makeValidator(schema, 'formatKnowledge')(FMT);
  assert.equal(r.ok, true, r.errors.map((e) => e.path + ' ' + e.msg).join('; '));
  assert.deepEqual(validateFormatTransforms(FMT), []);
  const { report } = parse();
  assert.deepEqual(report, { units: 3, variants: 24, unknownKeys: [], warnings: [] });
  // the fixture really carries the keys the entry declares (35 product keys, 27 variant keys)
  assert.equal(Object.keys(products[0]).length, 35);
  assert.equal(Object.keys(products[1].variants.nodes[0]).length, 27);
});

test('P2 + D3: metafields carry namespace and declared type; global.title_tag / description_tag are consumed by seo.*, app-injected namespaces are carried', () => {
  const { products: canon } = parse();
  const p = byHandle(canon, 'ac-infinity-ciseaux-secateur-droit');
  assert.equal(p.seoTitle, 'Ciseaux/sécateur droit en acier inoxydable AC Infinity');
  assert.ok(p.seoDescription.startsWith('Découvrez ce ciseaux'));
  // the SEO pair exists as metafields in the payload…
  assert.ok(products[0].metafields.nodes.some((m) => m.namespace === 'global' && m.key === 'title_tag'));
  // …and is carried exactly once (as seoTitle), never duplicated in metafields[]
  assert.ok(!p.metafields.some((m) => m.namespace === 'global'));
  assert.deepEqual(p.metafields, [
    { key: 'google_product_category', value: 'Home & Garden > Lawn & Garden > Gardening > Gardening Tools > Pruning Shears', namespace: 'mm-google-shopping', type: 'string' },
    { key: 'condition', value: 'new', namespace: 'mm-google-shopping', type: 'string' },
    { key: 'custom_product', value: 'true', namespace: 'mm-google-shopping', type: 'boolean' },
  ]);
  assert.equal(p.provenance.metafields.sourceField, 'metafields.nodes');
  // a product whose only metafields are the SEO pair ends with none
  assert.deepEqual(byHandle(canon, 'qnubu-sac-a-presse-de-11x11cm-10pcs').metafields, []);
});

test('P3: native barcode untouched and exact; customs identifiers absent when null (no empty identifiers block)', () => {
  const { products: canon } = parse();
  const v = byHandle(canon, 'ac-infinity-ciseaux-secateur-droit').variants[0];
  assert.equal(v.barcode, '819137021495');
  assert.deepEqual(v.provenance.barcode, { platform: 'shopify', sourceField: 'barcode', sourceValue: '819137021495', transform: 'text', method: 'exact' });
  assert.equal(v.identifiers, undefined, 'harmonizedSystemCode / countryCodeOfOrigin are null in the sample');
  for (const p of canon) for (const x of p.variants) assert.equal(x.identifiers, undefined);
});

test('variants: no inheritance — every variant explicit; option axis without the Default Title sentinel; per-variant weight unit', () => {
  const { products: canon } = parse();
  const simple = byHandle(canon, 'ac-infinity-ciseaux-secateur-droit');
  assert.equal(simple.kind, 'simple');
  assert.deepEqual(simple.options, [], 'Title = Default Title is not an axis');
  assert.deepEqual(simple.variants[0].optionValues, []);
  assert.equal(simple.variants[0].price, 15.5); assert.equal(simple.variants[0].compareAtPrice, 19, 'promo: charged 15.50, was 19.00 — no swap needed');
  assert.equal(simple.variants[0].grams, 150, 'GRAMS');
  assert.deepEqual(simple.sourceExtension.shopify.options[0].optionValues[0].name, 'Default Title', 'the sentinel stays in the raw copy');

  const qnubu = byHandle(canon, 'qnubu-sac-a-presse-de-11x11cm-10pcs');
  assert.equal(qnubu.kind, 'variable');
  assert.deepEqual(qnubu.options.map((o) => [o.name, o.values.length]), [['Taille', 2], ['Taille des mailles', 7]]);
  assert.equal(qnubu.variants.length, 14);
  assert.deepEqual(qnubu.variants[13].optionValues, ['11x11cm', '160 microns']);
  assert.equal(qnubu.variants[13].price, 13);
  for (const v of qnubu.variants) assert.equal(v.provenance.price.method, 'exact', 'nothing inherited on Shopify');

  const pack = byHandle(canon, 'pack-advanced-nutrients');
  assert.equal(pack.variants[0].grams, 10000, 'KILOGRAMS 10 → 10000 g, unit read per variant');
  assert.equal(pack.variants[5].grams, 5500, '5.5 kg');
  // mixed stock tracking within ONE product (observed): variant 7 untracked
  assert.deepEqual(pack.variants.map((v) => v.stockPolicy.manageStock), [true, true, true, true, true, true, false, true, true]);
  assert.equal(pack.variants[6].stockPolicy.backorders, 'no', 'DENY');
  assert.equal(pack.variants[6].sourceExtension.shopify.availableForSale, true);
});

test('categories from collections (flat, one per collection); the closed taxonomy node stays in sourceExtension (D1)', () => {
  const { products: canon } = parse();
  const p = byHandle(canon, 'pack-advanced-nutrients');
  assert.deepEqual(p.categories, ['Engrais']);
  assert.equal(p.sourceExtension.shopify.category.fullName, 'Maison et jardin > Pelouses et jardins > Jardinage > Engrais');
  assert.equal(p.sourceExtension.shopify.collections[0].ruleSet.rules[0].column, 'TAG', 'automatic collection rule kept');
  assert.equal(p.productType, 'engrais');
  assert.equal(p.identity.sourceId, 'gid://shopify/Product/10480216867149');
  assert.equal(p.published, true);
  assert.deepEqual(p.images.length, 3);
  assert.equal(p.images[0].width, 1200);
});

test('P1: translations(locale: en) is [] on this store → no translations block (default locale is the flat fields); shape stays exercised synthetically', () => {
  const { products: canon } = parse();
  for (const p of canon) assert.equal(p.translations, undefined);
  // same payload with an English translation registered, as the API returns it
  const withEn = JSON.parse(JSON.stringify(products[0]));
  withEn.translations = [
    { key: 'title', value: 'AC Infinity - straight stainless steel scissors 16.8cm', locale: 'en', outdated: false, updatedAt: '2026-09-21T00:00:00Z' },
    { key: 'meta_title', value: 'Straight stainless steel scissors AC Infinity', locale: 'en', outdated: false, updatedAt: '2026-09-21T00:00:00Z' },
    { key: 'handle', value: 'ac-infinity-straight-scissors', locale: 'en', outdated: false, updatedAt: '2026-09-21T00:00:00Z' },
    { key: 'product_type', value: 'pruner', locale: 'en', outdated: false, updatedAt: '2026-09-21T00:00:00Z' },
  ];
  const [p] = parseWithKnowledge(FMT, [withEn], { companions: {}, canon: loadCanonCatalogSync() }).products;
  assert.deepEqual(p.translations, { en: { title: 'AC Infinity - straight stainless steel scissors 16.8cm', seoTitle: 'Straight stainless steel scissors AC Infinity', slug: 'ac-infinity-straight-scissors' } });
  assert.equal(p.title, 'AC Infinity - ciseaux/sécateur droit en acier inoxydable 16,8cm', 'the primary locale stays in the flat fields');
  assert.equal(p.sourceExtension.shopify.translations.length, 4, 'raw surface kept — product_type has no canon translation field');
  assert.equal(p.provenance.translations.sourceField, 'translations');
});
