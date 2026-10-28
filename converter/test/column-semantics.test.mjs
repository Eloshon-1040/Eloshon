/**
 * Column semantics — what a column MEANS, whatever its spelling.
 * The vocabulary the Scraper and the stores really use (title / brand / SKU /
 * weight / publication / variants / SEO), with `_`, `-`, spaces, case and
 * accents, through the shipped recogniser (canon catalogue + recognition
 * config, no test double). Plus the confidence contract: configurable
 * thresholds, ambiguous names presented, units that rule fields out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { semanticAnalyze, summarizeColumns } from '../core/dist/index.mjs';
import { recognizeColumns, normalizeColumnName, columnUnit, tokenKey } from '../core/knowledge-proposal/semantic.mjs';
import { loadCanonCatalogSync, loadRecognitionConfigSync } from '../core/knowledge-proposal/reference.mjs';
import { TRANSFORMS } from '../core/knowledge-proposal/transforms.mjs';

const config = loadRecognitionConfigSync();
const catalog = loadCanonCatalogSync();

// Realistic values per concept: names are the evidence, values only confirm.
const VALUES = {
  title: ['Chaussures Nike Air Max', 'Sac à dos Trek 30 L', 'Gourde isotherme', 'Lampe frontale 400 lm', 'Tente 2 places'],
  vendor: ['Nike', 'Quechua', 'Kalenji', 'Nike', 'Petzl'],
  sku: ['NK-AM-001', 'QC-SAC-30', 'KL-GD-75', 'PZ-LF-400', 'QC-TT-2P'],
  grams: ['0.45', '1.2', '0.35', '0.09', '2.8'],
  published: ['true', 'false', 'true', 'true', 'false'],
  options: ['Rouge', 'Bleu', 'Noir', 'Rouge', 'Bleu'],
  seoTitle: ['Nike Air Max | Boutique', 'Sac Trek 30 L | Boutique', 'Gourde | Boutique', 'Lampe | Boutique', 'Tente | Boutique'],
  seoDescription: ['Achetez la Nike Air Max en ligne.', 'Le sac Trek 30 L pour la randonnée.', 'Gourde isotherme 24 h.', 'Lampe frontale puissante.', 'Tente légère 2 places.'],
  handle: ['nike-air-max', 'sac-trek-30', 'gourde-isotherme', 'lampe-frontale', 'tente-2-places'],
  sku_variant: ['NK-AM-001-42', 'NK-AM-001-43', 'QC-SAC-30-B', 'KL-GD-75-R', 'PZ-LF-400-N'],
};
function recognise(header, values) {
  const rows = (values || []).map((v) => ({ [header]: v }));
  return semanticAnalyze([header], rows, 'products').columns[0];
}
function expectField(header, canon, values, { auto = true } = {}) {
  const c = recognise(header, values);
  assert.ok(c.best, `${header}: no candidate`);
  assert.equal(c.best.canon, canon, `${header} → ${c.best.canon} (${c.best.score}), expected ${canon}`);
  if (auto) assert.equal(c.status, 'auto', `${header} → ${canon} should be automatic (score ${c.best.score})`);
  assert.ok(c.best.score > 0 && c.best.score <= 1, 'score is a 0..1 confidence');
  return c;
}

test('normalisation: `_`, `-`, spaces, case and accents are separators, not different names', () => {
  const same = ['product_name', 'product-name', 'Product Name', 'PRODUCT_NAME', 'productName', '  product   name '];
  for (const h of same) assert.equal(normalizeColumnName(h), 'product name', h);
  assert.equal(normalizeColumnName('Référence'), 'reference');
  assert.equal(normalizeColumnName('Poids (kg)'), 'poids kg');
  assert.equal(tokenKey('nom_produit', config), tokenKey('Nom-Produit', config));
  assert.equal(tokenKey('nom_produit', config), 'name');
});

test('TITLE: title / name / product_name / nom / nom_produit … → title', () => {
  for (const h of ['title', 'Title', 'name', 'product_name', 'product-title', 'product title', 'nom', 'nom_produit', 'Nom du produit', 'PRODUCT_NAME', 'Product Name', 'product-name', 'nom-produit'])
    expectField(h, 'title', VALUES.title);
});

test('BRAND: brand / marque / manufacturer / vendor / product_brand / fabricant → brand (vendor)', () => {
  for (const h of ['brand', 'Brand', 'marque', 'manufacturer', 'vendor', 'product_brand', 'fabricant'])
    expectField(h, 'vendor', VALUES.vendor);
  // A foreign word (es: marca) found through the synonym dictionary is PROPOSED,
  // and once the user confirms it, the next file maps it automatically.
  const first = expectField('marca_producto', 'vendor', VALUES.vendor, { auto: false });
  assert.equal(first.status, 'suggest');
  const rows = VALUES.vendor.map((v) => ({ marca_producto: v }));
  const decisions = [{ at: '2026-10-25T10:00:00.000Z', by: 'user', formatId: 'unknown.csv.f00d01.v1', fieldPath: 'marca_producto', action: 'confirmed', canonCandidate: 'vendor', confidence: 'user-confirmed' }];
  const next = recognizeColumns({ headers: ['marca_producto'], rows, entity: 'products', catalog, config, formatId: 'unknown.csv.f00d01.v1', decisions }).columns[0];
  assert.equal(next.status, 'decided');
  assert.equal(next.best.canon, 'vendor');
});

test('SKU: sku / reference / référence / product_code / article_number … → sku', () => {
  for (const h of ['sku', 'SKU', 'product_sku', 'reference', 'référence', 'réf', 'product_code', 'article_number', 'Product Code'])
    expectField(h, 'sku', VALUES.sku);
});

test('WEIGHT: weight / poids / product_weight / shipping_weight / weight_kg / Poids (kg) → weight', () => {
  for (const h of ['weight', 'Weight', 'poids', 'product_weight', 'shipping_weight', 'weight_kg', 'Poids (kg)'])
    expectField(h, 'grams', VALUES.grams);
});

test('PUBLICATION: published / online / active / enabled / visible → published; status stays a status', () => {
  for (const h of ['published', 'online', 'active', 'enabled', 'visible', 'Is Visible']) expectField(h, 'published', VALUES.published);
  expectField('status', 'status', ['active', 'draft', 'active', 'archived', 'active', 'draft']);
});

test('VARIANTS: variant / option1 / option1_name / option1_value / size / color / couleur / taille → options; variant_sku → sku', () => {
  for (const h of ['variant', 'option1', 'size', 'color', 'couleur', 'taille']) expectField(h, 'options', VALUES.options, { auto: false });
  expectField('variant_sku', 'sku', VALUES.sku_variant);
  // A Name/Value PAIR is one option, recognised structurally (family + neighbour).
  const rows = VALUES.options.map((v) => ({ option1_name: 'Couleur', option1_value: v }));
  const r = semanticAnalyze(['option1_name', 'option1_value'], rows, 'products');
  for (const c of r.columns) {
    assert.equal(c.best.canon, 'options', c.column);
    assert.equal(c.context.family, 'options', `${c.column} belongs to the options family`);
    assert.equal(c.status, 'auto');
  }
});

test('SEO: seo_title / meta_title / meta_description / slug / handle', () => {
  expectField('seo_title', 'seoTitle', VALUES.seoTitle);
  expectField('meta_title', 'seoTitle', VALUES.seoTitle);
  expectField('meta_description', 'seoDescription', VALUES.seoDescription);
  expectField('slug', 'handle', VALUES.handle);
  expectField('handle', 'handle', VALUES.handle);
});

test('descriptive content: technical_specs / fiche technique / caractéristiques → specifications (part of the description)', () => {
  const specs = ['{"Poids":"450 g","Matière":"cuir"}', 'Poids : 450 g\nMatière : cuir', '{"Couleur":"noir"}', 'Semelle : caoutchouc', '{"Taille":"42"}'];
  for (const h of ['technical_specs', 'Fiche technique', 'Caractéristiques', 'features', 'Spécifications']) expectField(h, 'specifications', specs, { auto: false });
  // a single description column holding specs stays THE description (never cut into attributes)
  expectField('product_description', 'bodyHtml', ['Chaussure de sport légère.\n\nCaractéristiques :\nPoids : 450 g\nMatière : cuir\nTaille : 42', 'Sac à dos de randonnée, 30 L, poche à eau.', 'Gourde isotherme double paroi.', 'Lampe frontale 400 lumens, 3 modes.', 'Tente 2 places, montage rapide.']);
});

test('the source page link, the source id and the stock status get their own fields (not the handle / quantity)', () => {
  expectField('source_url', 'sourceUrl', ['https://shop.test/p/1', 'https://shop.test/p/2', 'https://shop.test/p/3', 'https://shop.test/p/4', 'https://shop.test/p/5']);
  expectField('Lien', 'sourceUrl', ['https://shop.test/p/1', 'https://shop.test/p/2', 'https://shop.test/p/3']);
  expectField('source_product_id', 'identity.sourceId', ['1001', '1002', '1003', '1004', '1005']);
  expectField('stock_status', 'stockStatus', ['instock', 'outofstock', 'instock', 'instock', 'outofstock']);
});

test('ambiguous name: `value` is decided by its values and only ever SUGGESTED', () => {
  const colours = recognise('value', ['Red', 'Blue', 'Black', 'Red', 'Blue', 'Black']);
  assert.equal(colours.best.canon, 'options');
  assert.equal(colours.status, 'suggest', 'presented to the user, never applied silently');
  const weights = recognise('value', ['500', '700', '1000', '850', '640', '720']);
  assert.notEqual(weights.best.canon, 'options', 'numbers are not an option value');
  assert.equal(weights.best.canon, 'grams');
  assert.equal(weights.status, 'suggest');
  assert.ok(weights.best.reasons.includes('name:ambiguous'));
  // "available": true/false is a publication flag, a count is stock
  assert.equal(recognise('available', ['true', 'false', 'true', 'true', 'false']).best.canon, 'published');
  assert.equal(recognise('available', ['12', '0', '5', '40', '3']).best.canon, 'inventoryQty');
});

test('a unit in the name rules out fields measured otherwise', () => {
  assert.deepEqual(columnUnit('Longueur (mm)', config), { unit: 'mm', kind: 'length', bare: 'Longueur' });
  assert.equal(columnUnit('weight_kg', config).kind, 'weight');
  assert.equal(columnUnit('Prix (EUR)', config).kind, 'currency');
  assert.equal(columnUnit('Title (fr)', config), null, 'a locale is not a unit');
  const ints = ['300', '250', '500', '200', '350'];
  expectField('Longueur (mm)', 'lengthCm', ints);
  expectField('Prix (EUR)', 'price', ['19,90', '24,50', '9,99', '120,00', '45,00']);
  const diam = recognise('Diamètre (mm)', ints);
  assert.notEqual(diam.status, 'auto');
  assert.ok(!diam.best || diam.best.canon !== 'inventoryQty' || diam.status === 'none', 'integers in mm are never proposed as a stock');
  assert.equal(recognise('Durée de vie (mois)', ['24', '36', '12', '24', '60']).status, 'none', 'no field measured in months: kept as an unknown column');
});

test('confidence thresholds are configuration: raising `auto` turns an automatic match into a suggestion', () => {
  const rows = VALUES.vendor.map((v) => ({ manufacturer: v }));
  const base = recognizeColumns({ headers: ['manufacturer'], rows, entity: 'products', catalog, config });
  assert.equal(base.columns[0].status, 'auto');
  assert.deepEqual(base.thresholds, config.thresholds);
  const strict = { ...config, thresholds: { auto: 0.99, grey: 0.4 } };
  const s = recognizeColumns({ headers: ['manufacturer'], rows, entity: 'products', catalog, config: strict });
  assert.equal(s.columns[0].status, 'suggest');
  const lax = { ...config, thresholds: { auto: 0.99, grey: 0.97 } };
  assert.equal(recognizeColumns({ headers: ['manufacturer'], rows, entity: 'products', catalog, config: lax }).columns[0].status, 'none');
});

test('a corrected custom field remembers the key the user typed (with `_`)', () => {
  const rows = [{ marca_origen: 'ES' }, { marca_origen: 'FR' }, { marca_origen: 'IT' }];
  const decisions = [{ at: '2026-10-25T10:00:00.000Z', by: 'user', formatId: 'unknown.csv.abc123.v1', fieldPath: 'marca_origen', action: 'corrected', canonCandidate: 'metafields', confidence: 'user-corrected', args: { key: 'brand_origin_country' } }];
  const r = recognizeColumns({ headers: ['marca_origen'], rows, entity: 'products', catalog, config, formatId: 'unknown.csv.abc123.v1', decisions });
  assert.equal(r.columns[0].status, 'decided');
  assert.deepEqual(r.columns[0].best.decision.args, { key: 'brand_origin_country' });
});

test('description_section: a JSON spec sheet becomes a list; text stays one block', () => {
  const [a] = TRANSFORMS.description_section('{"Poids":"450 g","Matière":"cuir"}', { args: { label: 'Caractéristiques techniques' } });
  assert.equal(a.html, '<h3>Caractéristiques techniques</h3><ul><li><strong>Poids</strong> : 450 g</li><li><strong>Matière</strong> : cuir</li></ul>');
  const [b] = TRANSFORMS.description_section('Poids : 450 g\nMatière : <cuir>', { field: { path: 'Fiche technique' } });
  assert.equal(b.html, '<h3>Fiche technique</h3><p>Poids : 450 g<br>Matière : &lt;cuir&gt;</p>');
  assert.equal(TRANSFORMS.description_section('', {}), undefined);
});

test('column summary: every column lands in exactly one bucket', () => {
  const headers = ['Nom', 'Prix', 'Marque', 'value', 'zz_interne'];
  const rows = [['Gourde', '19,90', 'Quechua', 'Rouge', 'x1'], ['Tente', '89,00', 'Quechua', 'Bleu', 'x2'], ['Lampe', '24,50', 'Petzl', 'Noir', 'x3']]
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
  const semantic = semanticAnalyze(headers, rows, 'products');
  const sum = summarizeColumns({ bindings: [], unused: headers.map((h) => ({ column: h, confidence: 'none', sample: '' })), semantic }, {}, { learn: true });
  assert.equal(sum.total, 5);
  assert.equal(sum.auto + sum.check + sum.manual + sum.ignored + sum.unknown + sum.notCarried, sum.total);
  assert.equal(sum.unknown, 1, 'zz_interne is not identified (and will be kept and listed)');
  assert.ok(sum.check >= 1, '`value` is to review');
});
