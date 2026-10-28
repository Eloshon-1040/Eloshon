/**
 * Real Eloshon Scraper CSVs → recognition → canon → every target platform.
 * Fixtures are cut from real exports (header + at most 5 rows):
 *   panel-export-fr.csv          results-panel export, French headers
 *   alchimiaweb-catalog.csv      a shop catalogue scraped as-is (`;`, Catalan)
 *   Thunderbit_…csv              third-party scraper, units in the headers
 *   scraper-writer-2026-10.csv   written by the Scraper's own core/csv.mjs,
 *                                with brand / availability / technical_specs
 * Each test checks what the columns MEAN, that the conversion runs for every
 * target, and that no column disappears silently (mapped, or kept + listed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectFormat, parseCsv, convert, semanticAnalyze, learnFormat } from '../core/dist/index.mjs';
import { loadReferenceFormatsSync } from '../core/knowledge-proposal/reference.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (n) => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'scraper', n), 'utf8');
const TARGETS = ['shopify', 'woocommerce', 'wix', 'bigcommerce'];

/** Unknown file → recognition → learned format (the step-3 "remember this format" path). */
function learn(csv) {
  const t = parseCsv(csv);
  assert.equal(detectFormat(t.headers).format, 'unknown');
  const report = semanticAnalyze(t.headers, t.rows, 'products');
  const fmt = learnFormat({ headers: t.headers, report, provenance: 'unknown', platform: 'eloshon', by: 'user:test' });
  return { t, report, fmt, by: Object.fromEntries(report.columns.map((c) => [c.column, c])), field: Object.fromEntries(fmt.fields.map((f) => [f.path, f])) };
}
function convertAll(csv, formats) {
  const out = {};
  for (const tgt of TARGETS) {
    const res = convert(csv, { direction: `eloshon-to-${tgt}`, entity: 'products', expectPlatform: 'eloshon', knowledge: { formats } });
    assert.equal(res.ok, true, `${tgt}: ${JSON.stringify(res.errors)}`);
    assert.ok(res.counts.outputUnits > 0, `${tgt}: products written`);
    out[tgt] = res;
  }
  return out;
}
/** Zero silent loss: every source column is mapped by the format, or listed as unknown. */
function assertNoColumnDropped(t, fmt) {
  const mapped = new Set(fmt.fields.map((f) => f.path));
  const unknown = new Set((fmt.unknownFields || []).map((u) => u.path));
  for (const h of t.headers) if (h) assert.ok(mapped.has(h) || unknown.has(h), `column "${h}" is neither mapped nor listed`);
}
const expectCanon = (by, col, canon, status = 'auto') => {
  assert.equal(by[col].best?.canon, canon, `${col} → ${by[col].best?.canon}`);
  if (status) assert.equal(by[col].status, status, `${col}: ${by[col].status} (${by[col].best?.score})`);
};

test('results-panel export (French headers): every column understood, converted to all 4 platforms', () => {
  const csv = read('panel-export-fr.csv');
  const { t, by, fmt } = learn(csv);
  expectCanon(by, 'Nom', 'title'); expectCanon(by, 'Prix', 'price'); expectCanon(by, 'Prix barré', 'compareAtPrice');
  expectCanon(by, 'Marque', 'vendor'); expectCanon(by, 'Collection', 'categories'); expectCanon(by, 'Image', 'images');
  expectCanon(by, 'Lien', 'sourceUrl'); expectCanon(by, 'Référence', 'sku'); expectCanon(by, 'Slug', 'handle');
  // "Stock" holds "Épuisé": a stock STATUS, not a quantity — the values decide.
  expectCanon(by, 'Stock', 'stockStatus');
  assertNoColumnDropped(t, fmt);
  const res = convertAll(csv, [...loadReferenceFormatsSync(), fmt]);
  const first = t.rows[0];
  assert.equal(res.shopify.rows[0]['Title'], first['Nom']);
  assert.equal(res.shopify.rows[0]['Vendor'], first['Marque']);
  assert.equal(res.woocommerce.rows[0]['Name'], first['Nom']);
  assert.equal(res.wix.rows[0]['name'], first['Nom']);
  assert.equal(res.bigcommerce.rows.find((r) => r['Item'] === 'Product')['Name'], first['Nom']);
});

test('generic shop catalogue (`;`, Catalan): ids, links, both prices and the spec sheet', () => {
  const csv = read('alchimiaweb-catalog.csv');
  const { t, by, fmt, field } = learn(csv);
  expectCanon(by, 'id', 'identity.sourceId'); expectCanon(by, 'name', 'title'); expectCanon(by, 'url', 'sourceUrl');
  expectCanon(by, 'list_price', 'compareAtPrice'); expectCanon(by, 'current_price', 'price');
  expectCanon(by, 'description', 'bodyHtml'); expectCanon(by, 'category', 'categories'); expectCanon(by, 'tags', 'tags');
  expectCanon(by, 'propietats', 'specifications');
  // Two image sizes: both are images, the user picks — presented, not guessed.
  expectCanon(by, 'image_300px', 'images', 'suggest');
  assert.equal(by['name_complete'].status, 'none');
  assertNoColumnDropped(t, fmt);
  assert.equal(field['propietats'].canon, 'descriptionSections[]');
  assert.equal(field['url'].canon, 'sourceExtension.eloshon.source_url');
  const res = convertAll(csv, [...loadReferenceFormatsSync(), fmt]);
  // The spec sheet is part of the description on every platform, after the commercial text.
  const body = res.shopify.rows[0]['Body (HTML)'];
  assert.ok(body.includes('<h3>propietats</h3>'), 'spec sheet appended as a titled section');
  assert.ok(body.indexOf('<h3>propietats</h3>') > 0, 'after the description');
  assert.ok(res.woocommerce.rows[0]['Description'].includes('<h3>propietats</h3>'));
  assert.ok(res.wix.rows[0]['plainDescription'].includes('<h3>propietats</h3>'));
  // Not identified ≠ dropped: name_complete is kept and listed in the report.
  assert.ok(res.shopify.preserved.fields.some((f) => f.field === 'name_complete'), 'unknown column listed in the report');
});

test('Thunderbit export: units in headers are read, mm → cm, unknown measures kept and listed', () => {
  const csv = read('Thunderbit_5dad1f_20251112_233804.csv');
  const { t, by, fmt, field } = learn(csv);
  expectCanon(by, 'Nom du produit', 'title'); expectCanon(by, 'URL du produit', 'sourceUrl');
  expectCanon(by, 'Image du produit', 'images'); expectCanon(by, 'Prix (EUR)', 'price');
  expectCanon(by, 'Poids (kg)', 'grams'); expectCanon(by, 'Longueur (mm)', 'lengthCm');
  // Two brand-like and two category-like columns: one each is applied, the other presented.
  expectCanon(by, 'Marque', 'vendor'); expectCanon(by, 'Vendeur', 'vendor', 'suggest');
  for (const c of ['Diamètre (mm)', 'Durée de vie (mois)', "Débit d'air (m3/h)", 'Accessoires inclus']) assert.equal(by[c].status, 'none', c);
  assert.equal(field['Longueur (mm)'].transform, 'length_to_cm'); assert.deepEqual(field['Longueur (mm)'].args, { unit: 'mm' });
  assert.equal(field['Poids (kg)'].transform, 'weight_to_grams'); assert.deepEqual(field['Poids (kg)'].args, { unit: 'kg', decimal: '.' });
  assertNoColumnDropped(t, fmt);
  const res = convertAll(csv, [...loadReferenceFormatsSync(), fmt]);
  const listed = new Set(res.shopify.preserved.fields.map((f) => f.field));
  for (const c of ['Diamètre (mm)', 'Durée de vie (mois)']) assert.ok(listed.has(c), `${c} listed in the report`);
  const row = t.rows.find((r) => r['Longueur (mm)']);
  const out = res.woocommerce.rows.find((r) => r['Name'] === row['Nom du produit']);
  assert.equal(Number(out['Length (cm)']), Number(row['Longueur (mm)']) / 10, 'mm converted to cm');
});

test('current Scraper writer (2026-10 columns): brand → vendor, specs → description, the rest carried', () => {
  const csv = read('scraper-writer-2026-10.csv');
  const t = parseCsv(csv);
  const det = detectFormat(t.headers);
  assert.equal(det.format, 'knowledge'); assert.equal(det.knowledgeId, 'scraper.eloshon-export.v1');
  for (const c of ['brand', 'availability', 'rating', 'review_count', 'net_content', 'technical_specs', 'weight_estimated']) {
    assert.ok(loadReferenceFormatsSync().find((f) => f.id === det.knowledgeId).fields.some((f) => f.path === c), `${c} is described by the Scraper format`);
  }
  const res = convertAll(csv, loadReferenceFormatsSync());
  const shop = res.shopify.rows.find((r) => r['Title'] === 'Chaussure de sport Trail 2');
  assert.equal(shop['Vendor'], 'Kalenji');
  const body = shop['Body (HTML)'];
  assert.ok(body.startsWith('Chaussure de sport légère pour les sentiers.'), 'commercial text first');
  assert.ok(body.includes('<h3>Caractéristiques techniques</h3><ul><li><strong>Poids</strong> : 450 g</li><li><strong>Matière</strong> : cuir</li>'), 'spec sheet merged into the description');
  assert.ok(res.shopify.headers.some((h) => /availability/.test(h)), 'availability carried as a custom field column');
  assert.ok(res.wix.rows.find((r) => r['name'] === 'Chaussure de sport Trail 2')['plainDescription'].includes('Matière'));
  assert.equal(res.woocommerce.rows.find((r) => r['Name'] === 'Chaussure de sport Trail 2')['Brands'], 'Kalenji');
  // Nothing of the new columns is reported as unknown any more.
  const unknown = new Set((res.shopify.preserved?.fields ?? []).filter((f) => f.reason === 'unknown').map((f) => f.field));
  for (const c of ['brand', 'technical_specs', 'availability', 'rating', 'review_count', 'net_content', 'weight_estimated']) assert.ok(!unknown.has(c), `${c} must not be unknown`);
});
