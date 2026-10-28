// Phase 6.3 — P1 / P2 / P3 on the Shopware Admin API (re-extracted with the
// translations / locale / custom-field-set associations from the local test
// instance, one seeded product family — see test/fixtures/live/shopware-test/README.md).
// The 5.x fixtures (products.json / variations.json) are untouched: they
// predate the associations and prove the entries emit nothing without them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWithKnowledge } from '../generic-parser.mjs';
import { loadReferenceFormatsSync, loadCanonCatalogSync } from '../reference.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..', '..');
const LIVE = path.join(ROOT, 'test', 'fixtures', 'live', 'shopware-test');
const J = (n) => JSON.parse(fs.readFileSync(path.join(LIVE, n), 'utf8'));
const FMT = loadReferenceFormatsSync().find((f) => f.id === 'shopware.products.admin-api.v1');
const canon = loadCanonCatalogSync();
const parseI18n = () => parseWithKnowledge(FMT, J('products-i18n.json'), { companions: { variations: J('variations-i18n.json'), customFieldSets: J('custom-field-sets.json') }, canon });
const parseOld = () => parseWithKnowledge(FMT, J('products.json'), { companions: { variations: J('variations.json') }, canon });

test('nothing unknown on the richer payload; 1 parent / 6 variants', () => {
  const { report } = parseI18n();
  assert.deepEqual(report, { units: 1, variants: 6, unknownKeys: [], warnings: [] });
});

test('P1: the de-DE translation row lands in translations["de-DE"]; the system language (en-GB = translated.*) stays in the flat fields; child rows (null) emit nothing', () => {
  const raw = J('products-i18n.json')[0];
  assert.equal(raw.translations.length, 2, 'fixture: both language rows loaded');
  const { products } = parseI18n();
  const p = products[0];
  assert.equal(p.title, 'Variant product');
  assert.deepEqual(Object.keys(p.translations), ['de-DE']);
  assert.equal(p.translations['de-DE'].title, 'Variantenprodukt');
  assert.ok(p.translations['de-DE'].bodyHtml.startsWith('Lorem ipsum'), 'the DE row carries its own description (equal to EN in the demo data — kept as the source says)');
  assert.equal(p.translations['de-DE'].seoTitle, undefined, 'null metaTitle → not emitted');
  assert.equal(p.translations['de-DE'].slug, undefined, 'only the en-GB seoUrl exists (no DE domain on the test channel)');
  assert.equal(p.sourceExtension.shopware.translations.length, 2, 'raw per-language rows kept (keywords, packUnit, customFields per locale)');
  assert.equal(p.provenance.translations.sourceField, 'translations + seoUrls');
  for (const v of p.variants) assert.equal(v.translations, undefined);
  // a slug for the other locale IS picked up when a canonical seoUrl carries that language
  const clone = JSON.parse(JSON.stringify(raw));
  clone.seoUrls.push({ ...raw.seoUrls[0], id: 'x', languageId: raw.translations.find((t) => t.language.locale.code === 'de-DE').languageId, seoPathInfo: 'Variantenprodukt/SWDEMO10005', language: { locale: { code: 'de-DE' } } });
  const [q] = parseWithKnowledge(FMT, [clone], { companions: { variations: [] }, canon }).products;
  assert.equal(q.translations['de-DE'].slug, 'Variantenprodukt/SWDEMO10005');
});

test('P2: custom fields get namespace = set name and the declared type through the custom-field-set companion', () => {
  const { products } = parseI18n();
  assert.deepEqual(products[0].metafields, [
    { key: 'eloshon_specs_fragile', value: 'false', namespace: 'eloshon_specs', type: 'bool' },
    { key: 'eloshon_specs_material', value: 'Cotton', namespace: 'eloshon_specs', type: 'text' },
    { key: 'eloshon_specs_warranty_months', value: '24', namespace: 'eloshon_specs', type: 'int' },
  ]);
  // without the companion the values are still carried — untyped, no namespace (no loss, less knowledge)
  const [p] = parseWithKnowledge(FMT, J('products-i18n.json'), { companions: { variations: J('variations-i18n.json') }, canon }).products;
  assert.deepEqual(p.metafields.map((m) => [m.key, m.namespace, m.type]), [['eloshon_specs_fragile', undefined, undefined], ['eloshon_specs_material', undefined, undefined], ['eloshon_specs_warranty_months', undefined, undefined]]);
});

test('P3: ean → identifiers.ean + barcode (direct), manufacturerNumber → identifiers.mpn; a child with no own ean INHERITS the parent\'s (typed marker), one with its own is exact', () => {
  const { products } = parseI18n();
  const p = products[0];
  const own = p.variants.find((v) => v.sku === 'SWDEMO10005.1');
  assert.deepEqual(own.identifiers, { ean: '2000000000022', mpn: 'MPN-SWDEMO10005' });
  assert.equal(own.barcode, '2000000000022');
  assert.equal(own.provenance['identifiers.ean'].method, 'exact');
  assert.equal(own.provenance.barcode.method, 'exact');
  assert.equal(own.provenance['identifiers.mpn'].method, 'inherited');
  for (const v of p.variants.filter((x) => x.sku !== 'SWDEMO10005.1')) {
    assert.deepEqual(v.identifiers, { ean: '2000000000015', mpn: 'MPN-SWDEMO10005' }, v.sku);
    assert.equal(v.barcode, '2000000000015');
    assert.equal(v.provenance['identifiers.ean'].method, 'inherited');
    assert.equal(v.provenance.barcode.method, 'inherited');
  }
});

test('5.x payload (associations not loaded, nulls everywhere): the 6.3 entries emit nothing — no translations, no identifiers, no ext.translations key', () => {
  const { products, report } = parseOld();
  assert.deepEqual(report.unknownKeys, []);
  for (const p of products) {
    assert.equal(p.translations, undefined);
    assert.ok(!('translations' in (p.sourceExtension.shopware)), 'copy_present materialises nothing for null');
    for (const v of p.variants) assert.equal(v.identifiers, undefined);
  }
});
