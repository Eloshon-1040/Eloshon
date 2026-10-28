/**
 * Prices and weights were wrong without any error (audit): "12,99 € / 500 g" read
 * as 12.995, "12.99 EUR (TVA 21%)" as 12.9921, "1,234" always as 1.234, and a
 * weight column of 500 was assumed to be kilograms (500 000 g).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toNumber } from '../core/knowledge-proposal/transforms.mjs';
import { decimalSeparatorOf } from '../core/knowledge-proposal/values.mjs';
import { parseCsv, semanticAnalyze, learnFormat, proposeFormatId, convert } from '../core/dist/index.mjs';
import { loadReferenceFormatsSync } from '../core/knowledge-proposal/reference.mjs';

test('toNumber reads the amount, never glues a unit, a tax rate or a second price onto it', () => {
  const cases = [
    ['12,99 € / 500 g', 12.99], ['12.99 EUR (TVA 21%)', 12.99], ['12,50€ 15,00€', 12.5],
    ['1 234,50', 1234.5], ['1 234,50 €', 1234.5], ["1'234.50", 1234.5], ['1.234,56', 1234.56], ['1,234.56', 1234.56],
    ['1.234.567', 1234567], ['$9.99', 9.99], ['€ 9', 9], ['.5', 0.5], ['-3,5', -3.5], ['0,125', 0.125], ['abc', null], ['', null],
  ];
  for (const [input, expected] of cases) assert.equal(toNumber(input), expected, JSON.stringify(input));
});

test('a lone "1,234" follows the column\'s decimal separator when it is known', () => {
  assert.equal(toNumber('1,234', { decimal: '.' }), 1234);
  assert.equal(toNumber('1,234', { decimal: ',' }), 1.234);
  assert.equal(toNumber('1.234', { decimal: ',' }), 1234);
  assert.equal(toNumber('0,125', { decimal: '.' }), 0.125, 'a leading zero is always a decimal');
});

test('the decimal separator is decided on the whole column', () => {
  assert.deepEqual(decimalSeparatorOf(['12,99', '5,50', '1,234']), { decimal: ',', ambiguous: 1 });
  assert.deepEqual(decimalSeparatorOf(['1,234', '12.50', '3.99']), { decimal: '.', ambiguous: 1 });
  assert.deepEqual(decimalSeparatorOf(['1,234', '2,345']), { decimal: null, ambiguous: 2 });
  assert.deepEqual(decimalSeparatorOf(['1.234,56', '2.000,00']), { decimal: ',', ambiguous: 0 });
});

function learnAndConvert(csv) {
  const table = parseCsv(csv);
  const id = proposeFormatId(table.headers, { provenance: 'unknown', hint: 'csv' });
  const report = semanticAnalyze(table.headers, table.rows, 'products', { formatId: id, decisions: [] });
  const learned = learnFormat({ headers: table.headers, report, id, hint: 'Fournisseur', provenance: 'unknown', platform: 'eloshon', by: 'user' });
  const res = convert(csv, { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon', knowledge: { formats: [...loadReferenceFormatsSync(), learned] } });
  return { learned, res };
}

test('a weight column of 500, 750, 1200 is grams, not 500 000 g', () => {
  const { learned, res } = learnAndConvert(['Désignation;Poids;Prix de vente', 'Chaise;500;59,90', 'Table;750;129,00', 'Armoire;1200;249,00', 'Banc;640;89,50'].join('\n'));
  const e = learned.fields.find((f) => f.path === 'Poids');
  assert.equal(e.args.unit, 'g');
  assert.match(e.notes, /inferred from the values/);
  assert.equal(res.ok, true);
  assert.deepEqual(res.rows.map((r) => r['Variant Grams']), ['500', '750', '1200', '640']);
});

test('a weight column of 0.5, 1.2, 2 is kilograms', () => {
  const { res } = learnAndConvert(['Désignation;Poids;Prix de vente', 'Chaise;0,5;59,90', 'Table;1,2;129,00', 'Armoire;2;249,00', 'Banc;0,8;89,50'].join('\n'));
  assert.deepEqual(res.rows.map((r) => r['Variant Grams']), ['500', '1200', '2000', '800']);
});

test('a unit written in the column name wins, wherever it sits ("Weight_g", "Gewicht in g")', () => {
  for (const header of ['Weight_g', 'Grams', 'Gewicht in g']) {
    const { learned } = learnAndConvert([`Désignation;${header};Prix de vente`, 'Chaise;500;59,90', 'Table;750;129,00', 'Banc;640;89,50'].join('\n'));
    assert.equal(learned.fields.find((f) => f.path === header).args.unit, header === 'Grams' ? 'grams' : 'g', header);
  }
});

test('a price column mixing "1,234" with "12.50" reads 1,234 as one thousand two hundred thirty-four', () => {
  const { res } = learnAndConvert(['Désignation;Prix de vente;Poids', 'Chaise;1,234;500', 'Table;12.50;750', 'Banc;3.99;640'].join('\n'));
  assert.deepEqual(res.rows.map((r) => r['Variant Price']), ['1234.00', '12.50', '3.99']);
});
