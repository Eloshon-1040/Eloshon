// Phase 6.7 — what the mapping UI reads for the three new candidate kinds, at
// the engine level (the DOM walk lives in the Electron selftest, `npm run
// selftest` → contextWalk): translation columns resolve to a locale + field
// with a default-locale election, typed identifiers reach the barcode rule
// through the derivation bridge, metafield columns are visible on the
// structural rule with their ownership, and a learned format writes
// translations.<locale>.<field> that the generic parser populates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../core/dist/index.mjs';
import { translationColumn, translationFacts, recognizeColumns } from '../core/knowledge-proposal/semantic.mjs';
import { loadCanonCatalogSync, loadRecognitionConfigSync, loadTransformAliasesSync } from '../core/knowledge-proposal/reference.mjs';
import { buildLearnedFormat } from '../core/knowledge-proposal/learn.mjs';
import { parseWithKnowledge } from '../core/knowledge-proposal/generic-parser.mjs';

const { analyzePlan, semanticAnalyze, parseCsv } = engine;
const cfg = loadRecognitionConfigSync(), catalog = loadCanonCatalogSync();
const rows3 = (cols) => [0, 1, 2].map((i) => Object.fromEntries(Object.entries(cols).map(([k, vals]) => [k, vals[i]])));

test('translation columns: locale + field from data; units and non-translatable bases are never translations', () => {
  const tc = (c) => translationColumn(c, cfg);
  assert.deepEqual(tc('name_en'), { column: 'name_en', locale: 'en', field: 'title', base: 'name' });
  assert.deepEqual(tc('Title (fr)'), { column: 'Title (fr)', locale: 'fr', field: 'title', base: 'title' });
  assert.deepEqual(tc('description_nl-BE'), { column: 'description_nl-BE', locale: 'nl-BE', field: 'bodyHtml', base: 'description' });
  assert.equal(tc('Meta Title (de)').field, 'seoTitle');
  assert.equal(tc('slug_en').field, 'slug');
  for (const c of ['Weight (kg)', 'Prix (ht)', 'Variant Price', 'Option1 Name', 'Length (cm)', 'Image Src', 'Title']) assert.equal(tc(c), null, c);
});

test('default-locale election: a plain base column makes every suffixed column a translation; none → the first suffixed column is the default', () => {
  const withPlain = translationFacts(['Title', 'Title (en)', 'Title (nl)', 'Description (en)'], cfg);
  assert.deepEqual(withPlain.get('Title (en)'), { locale: 'en', field: 'title', flatField: 'title', isDefault: false });
  assert.deepEqual(withPlain.get('Title (nl)'), { locale: 'nl', field: 'title', flatField: 'title', isDefault: false });
  assert.equal(withPlain.get('Description (en)').isDefault, true, 'no plain Description column → the only suffixed one is the default');
  const noPlain = translationFacts(['ref', 'name_fr', 'name_en', 'description_fr', 'description_en'], cfg);
  assert.equal(noPlain.get('name_fr').isDefault, true); assert.equal(noPlain.get('name_en').isDefault, false);
  assert.equal(noPlain.get('description_fr').isDefault, true); assert.equal(noPlain.get('description_en').isDefault, false);
});

test('recogniser: the elected default column is the flat field, the other locale is `translations`, both carry context.translation', () => {
  const headers = ['ref', 'name_fr', 'name_en', 'prix'];
  const rows = rows3({ ref: ['A1', 'A2', 'A3'], name_fr: ['Tasse', 'Bol', 'Plat'], name_en: ['Mug', 'Bowl', 'Dish'], prix: ['12', '18', '29'] });
  const rep = semanticAnalyze(headers, rows, 'products', { formatId: 'unknown.x.000000.v1' });
  const col = (c) => rep.columns.find((x) => x.column === c);
  assert.equal(col('name_fr').best.canon, 'title'); assert.equal(col('name_fr').context.translation.isDefault, true);
  assert.equal(col('name_en').best.canon, 'translations'); assert.equal(col('name_en').status, 'auto');
  assert.deepEqual(col('name_en').context.translation, { locale: 'en', field: 'title', flatField: 'title', isDefault: false });
});

test('learned format: name_en → translations.en.title; the generic parser populates translations[en] and the flat title', () => {
  const headers = ['ref', 'name_fr', 'name_en', 'description_fr', 'description_en', 'prix'];
  const rows = rows3({ ref: ['A1', 'A2', 'A3'], name_fr: ['Tasse', 'Bol', 'Plat'], name_en: ['Mug', 'Bowl', 'Dish'], description_fr: ['<p>fr</p>', '<p>fr2</p>', '<p>fr3</p>'], description_en: ['<p>en</p>', '<p>en2</p>', '<p>en3</p>'], prix: ['12', '18', '29'] });
  const report = recognizeColumns({ headers, rows, entity: 'products', catalog, config: cfg, formatId: 'unknown.x.000000.v1' });
  const fmt = buildLearnedFormat({ headers, report, catalog, aliases: loadTransformAliasesSync(), platform: 'eloshon' });
  const f = (p) => fmt.fields.find((x) => x.path === p);
  assert.equal(f('name_fr').canon, 'title');
  assert.deepEqual([f('name_en').canon, f('name_en').transform], ['translations.en.title', 'text']);
  assert.deepEqual([f('description_en').canon, f('description_en').transform], ['translations.en.bodyHtml', 'html']);
  const { products } = parseWithKnowledge(fmt, rows, { companions: {}, canon: catalog });
  assert.equal(products[0].title, 'Tasse');
  assert.deepEqual(products[0].translations, { en: { title: 'Mug', bodyHtml: '<p>en</p>' } });
  assert.equal(products[0].provenance['translations.en.title'].sourceField, 'name_en');
});

test('plan (known Shopify format): EAN pre-fills the barcode rule (alias) and the semantic report bridges identifiers.ean to it; metafield columns appear on the structural rule row', () => {
  const csv = ['Handle,Title,Title (en),Variant SKU,Variant Price,EAN,Condition (product.metafields.mm-google-shopping.condition),Matiere (product.metafields.custom.matiere)',
    'tasse,Tasse émaillée,Enamel mug,TS-1,12.00,4006381333931,new,acier',
    'bol,Bol en grès,Stoneware bowl,BL-1,18.00,4006381333948,new,grès',
    'plat,Plat à four,Oven dish,PL-1,29.00,4006381333955,new,fonte'].join('\n');
  const table = parseCsv(csv);
  const plan = analyzePlan(table.headers, 'shopify_products', 'woo_products_modern', 'products', {}, { recognize: 'semantic', rows: table.rows, formatId: 'shopify.products.csv.v1' });
  assert.equal(plan.suggestedOverrides.barcode?.column, 'EAN');
  const sem = Object.fromEntries(plan.semantic.columns.map((c) => [c.column, c]));
  assert.equal(sem['EAN'].best.canon, 'identifiers.ean');
  assert.equal(plan.ruleByCanon['identifiers.ean'], 'barcode', 'derivation bridge');
  // the structural metafields rule is PRESENT (pattern column, family matched) — before 6.7 the consumed columns were invisible
  const mf = plan.bindings.find((b) => b.id === 'metafields');
  assert.ok(mf && mf.present, 'metafields rule row present');
  assert.equal(mf.resolvedColumn, '(product.metafields.*)');
  assert.equal(sem['Condition (product.metafields.mm-google-shopping.condition)'].context.metafield.owner, 'thirdParty');
  assert.equal(sem['Matiere (product.metafields.custom.matiere)'].context.metafield.owner, 'merchant');
  assert.ok(!plan.unused.some((u) => /metafields/.test(u.column)), 'still consumed, never "unused"');
  // the translation column is unused for the rules (structural) → a candidate row with its locale
  assert.ok(plan.unused.some((u) => u.column === 'Title (en)'));
  assert.deepEqual(sem['Title (en)'].context.translation, { locale: 'en', field: 'title', flatField: 'title', isDefault: false });
  assert.equal(sem['Title (en)'].best.canon, 'translations');
});

test('plan: a structural rule stays absent when no column of its family exists (no phantom binding)', () => {
  const headers = ['Handle', 'Title', 'Variant Price'];
  const plan = analyzePlan(headers, 'shopify_products', 'woo_products_modern', 'products');
  assert.ok(!plan.bindings.some((b) => b.id === 'metafields'));
  assert.ok(!plan.bindings.some((b) => b.id === 'images'));
});
