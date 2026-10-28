/**
 * Phase 5.4 — analyzePlan with recognize:'semantic' (opt-in).
 * Default path: no `semantic` key, identical plan. Semantic path: report
 * attached, unresolved rules pre-filled from AUTO columns (suggestion only).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, detectFormat, analyzePlan, semanticAnalyze, convert, serializeCsv } from '../core/dist/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (n) => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', n), 'utf8');

test('default analyzePlan has no semantic report and is unchanged by the option type', () => {
  const t = parseCsv(read('shopify_products.csv'));
  const a = analyzePlan(t.headers, 'shopify_products', 'woo_products_modern', 'products');
  const b = analyzePlan(t.headers, 'shopify_products', 'woo_products_modern', 'products', {}, { recognize: 'exact', rows: t.rows });
  assert.equal(a.semantic, undefined);
  // Sample rows only add the example values step 3 shows; the plan itself is identical.
  const noSamples = (p) => ({ ...p, bindings: p.bindings.map(({ sample, ...x }) => x), unused: p.unused.map(({ sample, ...x }) => x) });
  assert.deepEqual(noSamples(a), noSamples(b));
  assert.ok(a.bindings.every((x) => x.sample === ''), 'no rows → no samples');
  assert.equal(b.bindings.find((x) => x.id === 'title').sample, t.rows.find((r) => r['Title']).Title);
});

test('semantic: report attached; every exact-bound column agrees with the parser rule', () => {
  const t = parseCsv(read('woo_products_modern.csv'));
  const det = detectFormat(t.headers);
  const plan = analyzePlan(t.headers, det.format, 'shopify_products', 'products', {}, { recognize: 'semantic', rows: t.rows, formatId: det.knowledgeId });
  assert.ok(plan.semantic);
  assert.equal(plan.semantic.columns.length, t.headers.length);
  // A column may feed several rules (WC: `SKU` is both the grouping key and
  // the variant sku) — the semantic best must be ONE of them.
  const rulesByColumn = new Map();
  for (const b of plan.bindings.filter((x) => x.applied && x.editable)) rulesByColumn.set(b.resolvedColumn, [...(rulesByColumn.get(b.resolvedColumn) ?? []), b.canon]);
  for (const [column, canons] of rulesByColumn) {
    const col = plan.semantic.columns.find((c) => c.column === column);
    assert.ok(canons.includes(col?.best?.canon), `${column}: semantic says ${col?.best?.canon}, rules say ${canons}`);
  }
  assert.deepEqual(plan.suggestedOverrides, {}, 'nothing to suggest when every rule bound exactly');
});

test('semantic: a French-headed Shopify-shaped file gets pre-filled suggestions, never silent application', () => {
  // Same spine as the Shopify export (Handle + Variant Price → detected) but the
  // editable scalar columns carry French names the parser does not know.
  const headers = ['Handle', 'Libellé', 'Fabricant', 'Étiquettes', 'Variant SKU', 'Variant Price', 'Code EAN', 'Quantité en stock'];
  const rows = [
    ['t-shirt', 'T-shirt bio', 'Eloshon', 'coton, bio', 'TS-S', '19.90', '3701234567890', '10'],
    ['t-shirt', '', '', '', 'TS-M', '19.90', '3701234567906', '4'],
    ['mug', 'Mug émaillé', 'Lumo', 'cuisine', 'MUG-1', '12.00', '3701234567913', '25'],
    ['cap', 'Casquette', 'Lumo', 'été', 'CAP-1', '15.50', '3701234567920', '0'],
  ].map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
  const csv = serializeCsv(headers, rows);
  const det = detectFormat(headers);
  assert.equal(det.format, 'shopify_products');

  const plain = analyzePlan(headers, det.format, 'woo_products_modern', 'products');
  assert.ok(plain.missingRequiredSource.some((b) => b.id === 'title'), 'without semantics the title is missing');

  const plan = analyzePlan(headers, det.format, 'woo_products_modern', 'products', {}, { recognize: 'semantic', rows, formatId: det.knowledgeId });
  assert.equal(plan.suggestedOverrides.title?.column, 'Libellé');
  assert.equal(plan.suggestedOverrides.vendor?.column, 'Fabricant');
  assert.equal(plan.suggestedOverrides.tags?.column, 'Étiquettes');
  assert.equal(plan.suggestedOverrides.barcode?.column, 'Code EAN');
  assert.equal(plan.suggestedOverrides.inventoryQty?.column, 'Quantité en stock');
  // still only suggestions: the bare conversion (no overrides) behaves as before
  const before = convert(csv, { direction: 'shopify-to-woocommerce', entity: 'products', expectPlatform: 'shopify' });
  const after = convert(csv, { direction: 'shopify-to-woocommerce', entity: 'products', expectPlatform: 'shopify', mapping: { overrides: plan.suggestedOverrides } });
  assert.notEqual(serializeCsv(before.headers, before.rows), serializeCsv(after.headers, after.rows), 'accepting the suggestions changes the output');
  assert.ok(after.rows.some((r) => r['Name'] === 'T-shirt bio'), 'title flows through once accepted');
});

test('semanticAnalyze works on an undetectable header set (the Scraper case)', () => {
  const headers = ['ref', 'libelle', 'prix_ttc', 'ean', 'url_image', 'categorie'];
  const rows = [
    { ref: 'A1', libelle: 'Lait demi-écrémé 1L', prix_ttc: '1,09', ean: '5400141000016', url_image: 'https://img.example/a.jpg', categorie: 'Frais > Lait' },
    { ref: 'A2', libelle: 'Beurre doux 250g', prix_ttc: '2,49', ean: '5400141000023', url_image: 'https://img.example/b.jpg', categorie: 'Frais > Beurre' },
    { ref: 'A3', libelle: 'Yaourt nature x4', prix_ttc: '1,79', ean: '5400141000030', url_image: 'https://img.example/c.jpg', categorie: 'Frais > Yaourts' },
  ];
  assert.equal(detectFormat(headers).format, 'unknown');
  const rep = semanticAnalyze(headers, rows, 'products', { formatId: 'scraper.demo.000000.v1' });
  const best = Object.fromEntries(rep.columns.map((c) => [c.column, c.best?.canon]));
  // 6.3 (P3): a column literally named EAN is the TYPED identifier; the canon
  // catalogue's derivation rule (barcode ← gtin/ean/upc/isbn) fills barcode.
  assert.deepEqual(best, { ref: 'sku', libelle: 'title', prix_ttc: 'price', ean: 'identifiers.ean', url_image: 'images', categorie: 'categories' });
  assert.ok(rep.columns.find((c) => c.column === 'ean').candidates.some((c) => c.canon === 'barcode'), 'barcode stays a candidate of the same column');
});
