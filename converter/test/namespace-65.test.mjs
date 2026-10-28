// Phase 6.5 — metafield namespace filtering in the semantic recogniser.
// Rule: a metafield an APP injected (a namespace it owns) is carried as a
// metafield, never proposed as a mapping candidate. The mechanism is
// generalised (recognition.v1.json#metafieldOwnership): platform reservation
// grammar, tiny merchant / platform lists, prefix clustering, default-deny on
// unknown namespaces — `mm-*` and `app--*` are only instances. Merchant-owned
// metafields keep the normal scoring; Learned decisions override everything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../core/dist/index.mjs';
import { classifyMetafieldOwnership, metafieldColumn, prefixClusters, recognizeColumns, makeDecision } from '../core/knowledge-proposal/semantic.mjs';
import { loadCanonCatalogSync, loadRecognitionConfigSync } from '../core/knowledge-proposal/reference.mjs';
import { buildLearnedFormat } from '../core/knowledge-proposal/learn.mjs';
import { loadTransformAliasesSync } from '../core/knowledge-proposal/reference.mjs';
import { parseWithKnowledge } from '../core/knowledge-proposal/generic-parser.mjs';

const { semanticAnalyze, analyzePlan } = engine;
const cfg = loadRecognitionConfigSync();
const catalog = loadCanonCatalogSync();
const S = (ns, key, label = key) => `${label} (product.metafields.${ns}.${key})`;
const rows3 = (cols) => [0, 1, 2].map((i) => Object.fromEntries(Object.entries(cols).map(([k, vals]) => [k, vals[i]])));
const best = (rep, col) => rep.columns.find((c) => c.column === col);

test('ownership classifier (pure, data-driven): grammar > lists > cluster > default; not a metafield column → null', () => {
  const own = (col, headers = [col]) => classifyMetafieldOwnership(col, cfg, { headers });
  assert.equal(own('Title'), null);
  assert.equal(own('Variant Barcodes'), null);
  // Shopify: the platform's own app reservation grammar
  assert.deepEqual(own(S('app--12345--barcodes', 'ean', 'EAN')), { platform: 'shopify', namespace: 'app--12345--barcodes', key: 'ean', owner: 'thirdParty', via: 'grammar' });
  // Shopify lists
  assert.deepEqual(own(S('custom', 'matiere', 'Matiere')), { platform: 'shopify', namespace: 'custom', key: 'matiere', owner: 'merchant', via: 'list' });
  assert.equal(own(S('my_fields', 'ean', 'EAN')).owner, 'merchant');
  assert.deepEqual(own(S('global', 'title_tag', 'Title Tag')).owner, 'platform');
  assert.equal(own(S('shopify', 'color-pattern', 'Color')).owner, 'platform');
  // an unknown NAMESPACE is third-party by default — mm-google-shopping is only an instance
  assert.deepEqual(own(S('mm-google-shopping', 'condition', 'Condition')), { platform: 'shopify', namespace: 'mm-google-shopping', key: 'condition', owner: 'thirdParty', via: 'default' });
  assert.equal(own(S('judgeme', 'badge', 'Badge')).owner, 'thirdParty');
  assert.equal(own(S('specs', 'material', 'Material')).owner, 'thirdParty', 'a merchant namespace outside the lists is conservative by default — a decision or the merchantOwned list lifts it');
  // WooCommerce: protected `_` keys (WordPress grammar) — no namespace notion
  assert.deepEqual(own('Meta: _yoast_wpseo_title'), { platform: 'woocommerce', namespace: null, key: '_yoast_wpseo_title', owner: 'thirdParty', via: 'grammar' });
  // WooCommerce: a plain custom field is the merchant's…
  assert.deepEqual(own('Meta: material'), { platform: 'woocommerce', namespace: null, key: 'material', owner: 'merchant', via: 'default' });
  // …unless it belongs to a prefix cluster (one plugin's family in THIS file)
  const rm = ['Meta: rank_math_title', 'Meta: rank_math_description', 'Meta: rank_math_focus_keyword', 'Meta: material'];
  assert.deepEqual([...prefixClusters(rm, cfg)], ['rank']);
  assert.equal(own('Meta: rank_math_title', rm).owner, 'thirdParty'); assert.equal(own('Meta: rank_math_title', rm).via, 'cluster');
  assert.equal(own('Meta: material', rm).owner, 'merchant');
  // two keys are not a cluster; a generic first token (product_, price_) never is
  assert.deepEqual([...prefixClusters(['Meta: rank_math_title', 'Meta: rank_math_description'], cfg)], []);
  assert.deepEqual([...prefixClusters(['Meta: product_a', 'Meta: product_b', 'Meta: product_c', 'Meta: price_x', 'Meta: price_y', 'Meta: price_z'], cfg)], []);
  assert.deepEqual(metafieldColumn('Meta:   spaced key  ', cfg), { platform: 'woocommerce', namespace: null, key: 'spaced key' });
});

test('scoring: an app-injected Shopify metafield keeps ONLY the metafields carry — the categories / status / barcode look-alikes are never proposed', () => {
  const headers = ['Handle', 'Title', 'Variant Price', S('mm-google-shopping', 'google_product_category', 'Google Product Category'), S('mm-google-shopping', 'condition', 'Condition'), S('app--777--gtin', 'barcode', 'Barcode'), S('custom', 'ean', 'EAN')];
  const rows = rows3({
    Handle: ['a', 'b', 'c'], Title: ['A', 'B', 'C'], 'Variant Price': ['1.00', '2.00', '3.00'],
    [headers[3]]: ['Home & Garden > Tools', 'Home & Garden > Tools', 'Apparel > Shoes'], [headers[4]]: ['new', 'new', 'used'],
    [headers[5]]: ['4006381333931', '4006381333932', '4006381333933'], [headers[6]]: ['5400141000016', '5400141000023', '5400141000030'],
  });
  const rep = semanticAnalyze(headers, rows, 'products', { formatId: 'shopify.products.csv.v1' });
  for (const col of [headers[3], headers[4], headers[5]]) {
    const c = best(rep, col);
    assert.equal(c.context.metafield.owner, 'thirdParty', col);
    assert.deepEqual(c.candidates.map((x) => x.canon), ['metafields'], `${col}: only the carry`);
    assert.equal(c.status, 'auto'); assert.equal(c.best.canon, 'metafields');
    assert.ok(!c.candidates.some((x) => x.reasons.includes('namespace:third-party')), 'the suppressed candidates are gone, not shown with a penalty');
  }
  // the merchant-owned metafield with an EAN profile still gets its identifier candidate
  const mine = best(rep, headers[6]);
  assert.equal(mine.context.metafield.owner, 'merchant');
  assert.ok(mine.candidates.some((x) => x.canon === 'identifiers.ean' || x.canon === 'barcode'), 'custom.ean is a real barcode candidate');
  // control: the SAME column outside a namespace WOULD have been proposed (proof the rule did the work)
  const ctl = semanticAnalyze(['Handle', 'Barcode'], rows3({ Handle: ['a', 'b', 'c'], Barcode: ['4006381333931', '4006381333932', '4006381333933'] }), 'products');
  assert.ok(best(ctl, 'Barcode').candidates.some((x) => x.canon === 'barcode'));
});

test('scoring: WooCommerce — a plugin family (prefix cluster) and protected keys are carried, a plain custom field is still suggested', () => {
  const headers = ['SKU', 'Name', 'Regular price', 'Meta: rank_math_title', 'Meta: rank_math_description', 'Meta: rank_math_focus_keyword', 'Meta: _yoast_wpseo_metadesc', 'Meta: ean'];
  const rows = rows3({
    SKU: ['S1', 'S2', 'S3'], Name: ['A', 'B', 'C'], 'Regular price': ['1', '2', '3'],
    'Meta: rank_math_title': ['Buy A', 'Buy B', 'Buy C'], 'Meta: rank_math_description': ['A is great', 'B is great', 'C is great'], 'Meta: rank_math_focus_keyword': ['a', 'b', 'c'],
    'Meta: _yoast_wpseo_metadesc': ['A desc', 'B desc', 'C desc'], 'Meta: ean': ['5400141000016', '5400141000023', '5400141000030'],
  });
  const rep = semanticAnalyze(headers, rows, 'products', { formatId: 'woocommerce.products.csv.modern.v1' });
  for (const col of ['Meta: rank_math_title', 'Meta: rank_math_description', 'Meta: rank_math_focus_keyword', 'Meta: _yoast_wpseo_metadesc']) {
    const c = best(rep, col);
    assert.equal(c.context.metafield.owner, 'thirdParty', col);
    assert.deepEqual(c.candidates.map((x) => x.canon), ['metafields'], col);
  }
  const ean = best(rep, 'Meta: ean');
  assert.equal(ean.context.metafield.owner, 'merchant');
  assert.ok(ean.candidates.some((x) => x.canon === 'identifiers.ean'));
});

test('decisions override: a confirmed decision maps an app-namespaced column anyway (the user owns the last word); the plan bridge honours it', () => {
  const col = S('app--42--seo', 'meta_title', 'Meta Title');
  const headers = ['Handle', 'Title', 'Variant Price', col];
  const rows = rows3({ Handle: ['a', 'b', 'c'], Title: ['A', 'B', 'C'], 'Variant Price': ['1', '2', '3'], [col]: ['A | Shop', 'B | Shop', 'C | Shop'] });
  const before = semanticAnalyze(headers, rows, 'products', { formatId: 'shopify.products.csv.v1' });
  assert.deepEqual(best(before, col).candidates.map((x) => x.canon), ['metafields']);
  const d = makeDecision({ formatId: 'shopify.products.csv.v1', column: col, action: 'confirmed', canon: 'seoTitle' });
  const after = semanticAnalyze(headers, rows, 'products', { formatId: 'shopify.products.csv.v1', decisions: [d] });
  assert.equal(best(after, col).status, 'decided'); assert.equal(best(after, col).best.canon, 'seoTitle');
  const plan = analyzePlan(headers, 'shopify_products', 'woo_products_modern', 'products', {}, { recognize: 'semantic', rows, formatId: 'shopify.products.csv.v1', decisions: [d] });
  assert.equal(plan.suggestedOverrides.seoTitle?.column, col);
});

test('the metafields carry is the default output, so nothing is lost: a Shopify export with app namespaces converts with every metafield column kept', () => {
  const headers = ['Handle', 'Title', 'Variant Price', S('mm-google-shopping', 'condition', 'Condition'), S('custom', 'matiere', 'Matiere')];
  const csv = [headers.join(','), 'h1,T1,9.99,new,coton'].join('\n');
  const res = engine.convert(csv, { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' });
  assert.equal(res.ok, true);
  assert.equal(res.rows[0]['Meta: condition'], 'new');
  assert.equal(res.rows[0]['Meta: matiere'], 'coton');
});

test('Learned writer: a recognised metafield column is written with its source key + namespace (P2), an app-owned one with a note — and the generic parser carries it typed by namespace', () => {
  const headers = ['ref', 'libelle', S('mm-google-shopping', 'condition', 'Condition'), S('custom', 'matiere', 'Matière')];
  const rows = rows3({ ref: ['A1', 'A2', 'A3'], libelle: ['Lait', 'Beurre', 'Yaourt'], [headers[2]]: ['new', 'new', 'new'], [headers[3]]: ['coton', 'lin', 'soie'] });
  const report = recognizeColumns({ headers, rows, entity: 'products', catalog, config: cfg, formatId: 'unknown.x.000000.v1' });
  const fmt = buildLearnedFormat({ headers, report, catalog, aliases: loadTransformAliasesSync(), platform: 'eloshon' });
  const cond = fmt.fields.find((f) => f.path === headers[2]);
  assert.deepEqual({ canon: cond.canon, transform: cond.transform, args: cond.args }, { canon: 'metafields[]', transform: 'metafield_pair', args: { key: 'condition', namespace: 'mm-google-shopping' } });
  assert.match(cond.notes, /app-owned \(default\)/);
  const mat = fmt.fields.find((f) => f.path === headers[3]);
  assert.deepEqual(mat.args, { key: 'matiere', namespace: 'custom' }); assert.equal(mat.notes, undefined);
  const { products } = parseWithKnowledge(fmt, rows, { companions: {} });
  assert.deepEqual(products[0].metafields, [{ key: 'condition', value: 'new', namespace: 'mm-google-shopping' }, { key: 'matiere', value: 'coton', namespace: 'custom' }]);
});
