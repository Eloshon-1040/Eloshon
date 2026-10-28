/**
 * A file taught to the converter (unknown supplier / client export) used to lose
 * its structure (audit): several image columns kept only the last one, and a
 * one-row-per-variant file became as many products with `options: []`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, semanticAnalyze, learnFormat, proposeFormatId, convert, parseCsvWithKnowledge } from '../core/dist/index.mjs';
import { loadReferenceFormatsSync } from '../core/knowledge-proposal/reference.mjs';

function teach(csv) {
  const table = parseCsv(csv);
  const id = proposeFormatId(table.headers, { provenance: 'unknown', hint: 'csv' });
  const report = semanticAnalyze(table.headers, table.rows, 'products', { formatId: id, decisions: [] });
  const learned = learnFormat({ headers: table.headers, report, id, hint: 'Client', provenance: 'unknown', platform: 'eloshon', by: 'user' });
  const formats = [...loadReferenceFormatsSync(), learned];
  return { learned, formats, parsed: parseCsvWithKnowledge(id, csv, { formats }), res: convert(csv, { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon', knowledge: { formats } }) };
}

const ROW_VARIANTS = [
  'Parent SKU;Désignation;Couleur;Taille;SKU;Prix de vente;Stock;Photo 1;Photo 2',
  'P1;Pull laine;Rouge;S;P1-R-S;59,90;4;https://x/a.jpg;https://x/b.jpg',
  'P1;Pull laine;Rouge;M;P1-R-M;59,90;2;https://x/a.jpg;https://x/b.jpg',
  'P1;Pull laine;Bleu;S;P1-B-S;54,90;0;https://x/a.jpg;https://x/b.jpg',
  'P2;Bonnet;Noir;U;P2-N-U;19,90;9;https://x/d.jpg;',
].join('\n');

test('one row per variant: rows sharing the parent id become ONE product with its options and variants', () => {
  const { parsed, res } = teach(ROW_VARIANTS);
  assert.equal(parsed.products.length, 2);
  const [pull, bonnet] = parsed.products;
  assert.equal(pull.handle, 'p1', 'named after the group key, not after one variant SKU');
  assert.deepEqual(pull.options, [{ name: 'Couleur', values: ['Rouge', 'Bleu'] }, { name: 'Taille', values: ['S', 'M'] }]);
  assert.equal(pull.variants.length, 3);
  assert.deepEqual(pull.variants.map((v) => v.optionValues), [['Rouge', 'S'], ['Rouge', 'M'], ['Bleu', 'S']]);
  assert.deepEqual(pull.variants.map((v) => v.sku), ['P1-R-S', 'P1-R-M', 'P1-B-S']);
  assert.deepEqual(pull.variants.map((v) => v.price), [59.9, 59.9, 54.9], 'each variant keeps its own price');
  assert.deepEqual(pull.variants.map((v) => v.inventoryQty), [4, 2, 0]);
  assert.equal(bonnet.variants.length, 1);

  assert.equal(res.ok, true);
  assert.equal(res.counts.outputUnits, 2, '2 products, not 4');
  assert.deepEqual(res.rows.map((r) => r['Variant SKU']), ['P1-R-S', 'P1-R-M', 'P1-B-S', 'P2-N-U']);
  assert.equal(res.rows[0]['Option1 Name'], 'Couleur');
});

test('rows with an empty parent id each stay their own product', () => {
  const csv = ['Parent SKU;Désignation;SKU;Prix de vente', 'P1;Pull;P1-A;10', 'P1;Pull;P1-B;10', ';Echarpe;E1;5', ';Gants;G1;7'].join('\n');
  const { parsed } = teach(csv);
  assert.deepEqual(parsed.products.map((p) => p.title), ['Pull', 'Echarpe', 'Gants']);
  assert.equal(parsed.products[0].variants.length, 2);
});

test('one row per product stays one product per row (a Couleur column is not an option axis)', () => {
  const csv = ['Désignation;Couleur;SKU;Prix de vente', 'Pull;Rouge;A;10', 'Bonnet;Noir;B;5', 'Echarpe;Gris;C;7'].join('\n');
  const { learned, parsed } = teach(csv);
  assert.equal(learned.structure.rows, undefined);
  assert.equal(parsed.products.length, 3);
});

test('several image columns are ALL kept, in order, without duplicates', () => {
  const csv = ['Désignation;Photo 1;Photo 2;Photo 3;Prix de vente', 'Chaise;https://x/1.jpg;https://x/2.jpg;https://x/1.jpg;59,90', 'Table;https://x/3.jpg;;;129,00', 'Banc;https://x/4.jpg;https://x/5.jpg;https://x/6.jpg;89,50'].join('\n');
  const { parsed } = teach(csv);
  assert.deepEqual(parsed.products[0].images.map((i) => [i.src, i.position]), [['https://x/1.jpg', 1], ['https://x/2.jpg', 2]]);
  assert.deepEqual(parsed.products[1].images.map((i) => i.src), ['https://x/3.jpg']);
  assert.equal(parsed.products[2].images.length, 3);
});

test('Shopify export of a taught file carries every image', () => {
  const csv = ['Désignation;Photo 1;Photo 2;Prix de vente', 'Chaise;https://x/1.jpg;https://x/2.jpg;59,90', 'Table;https://x/3.jpg;https://x/4.jpg;129,00', 'Banc;https://x/5.jpg;https://x/6.jpg;89,50'].join('\n');
  const { res } = teach(csv);
  assert.equal(res.ok, true);
  assert.equal(res.rows.filter((r) => r['Image Src']).length, 6, '2 images × 3 products');
});
