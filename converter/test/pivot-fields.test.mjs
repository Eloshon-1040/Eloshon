/**
 * The pivot had no place for a short description, a VAT rate, a price currency or a
 * price per unit of measure (audit): they were unrecognised, or worse recognised as
 * something else (MwSt → stock, PU HT → was-price). Each is now a canonical field,
 * recognised in every language, read, carried where the target can hold it and
 * DECLARED lost where it cannot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, semanticAnalyze, learnFormat, proposeFormatId, convert, parseCsvWithKnowledge } from '../core/dist/index.mjs';
import { loadReferenceFormatsSync } from '../core/knowledge-proposal/reference.mjs';
import { TRANSFORMS } from '../core/knowledge-proposal/transforms.mjs';

const run = (name, v, args) => TRANSFORMS[name](v, { args, source: {}, parent: null, product: {}, companions: {}, field: null, platform: 'x' });

test('transforms: VAT as a percent, currency as ISO code, price per unit with its measure', () => {
  assert.equal(run('vat_rate', '21'), 21);
  assert.equal(run('vat_rate', '21 %'), 21);
  assert.equal(run('vat_rate', '0,21'), 21, 'a fraction is a percent');
  assert.equal(run('vat_rate', '5,5'), 5.5);
  assert.equal(run('vat_rate', '150'), undefined);
  assert.equal(run('currency', '€'), 'EUR');
  assert.equal(run('currency', 'usd'), 'USD');
  assert.equal(run('currency', 'euros'), undefined);
  assert.deepEqual(run('unit_price', '25,98', { unit: 'kilo' }), { amount: 25.98, per: 1, unit: 'kg' });
  assert.deepEqual(run('unit_price', '12,99 € / 500 g'), { amount: 12.99, per: 500, unit: 'g' });
  assert.deepEqual(run('unit_price', '3,40', { unit: 'litre' }), { amount: 3.4, per: 1, unit: 'l' });
});

function teach(csv) {
  const table = parseCsv(csv);
  const id = proposeFormatId(table.headers, { provenance: 'unknown', hint: 'csv' });
  const report = semanticAnalyze(table.headers, table.rows, 'products', { formatId: id, decisions: [] });
  const learned = learnFormat({ headers: table.headers, report, id, hint: 'Client', provenance: 'unknown', platform: 'eloshon', by: 'user' });
  const formats = [...loadReferenceFormatsSync(), learned];
  return { report, parsed: parseCsvWithKnowledge(id, csv, { formats }), formats };
}
const canonOf = (report, column) => report.columns.find((c) => c.column === column)?.best?.canon;

const CSV = [
  'Désignation;Description courte;TVA;Devise;Prix au kilo;Prix de vente',
  'Fromage;Un fromage doux;6;EUR;25,98;12,99',
  'Pain;Pain complet;6;EUR;4,50;2,25',
  'Savon;Savon au miel;21;EUR;;3,50',
].join('\n');

test('a file with these columns is recognised and read into the pivot', () => {
  const { report, parsed } = teach(CSV);
  assert.equal(canonOf(report, 'Description courte'), 'shortDescription');
  assert.equal(canonOf(report, 'TVA'), 'vatRate');
  assert.equal(canonOf(report, 'Devise'), 'currency');
  assert.equal(canonOf(report, 'Prix au kilo'), 'unitPrice');
  assert.equal(canonOf(report, 'Prix de vente'), 'price');
  const [fromage, pain, savon] = parsed.products;
  assert.equal(fromage.shortDescription, 'Un fromage doux');
  assert.equal(fromage.currency, 'EUR');
  assert.equal(fromage.variants[0].vatRate, 6);
  assert.deepEqual(fromage.variants[0].unitPrice, { amount: 25.98, per: 1, unit: 'kg' });
  assert.equal(fromage.variants[0].price, 12.99);
  assert.equal(savon.variants[0].vatRate, 21);
  assert.equal(savon.variants[0].unitPrice, undefined, 'an empty cell is no unit price');
  assert.equal(pain.title, 'Pain');
});

test('VAT columns are a rate in every language, never a stock quantity', () => {
  for (const [header, values] of [['BTW', ['21', '6', '21']], ['MwSt', ['19', '7', '19']], ['IVA', ['21', '10', '21']], ['Taux de TVA', ['21', '6', '12']]]) {
    const csv = [`Naam;${header};Prijs`, `A;${values[0]};5`, `B;${values[1]};6`, `C;${values[2]};7`].join('\n');
    const { report } = teach(csv);
    assert.equal(canonOf(report, header), 'vatRate', header);
  }
});

function viaEngine(direction, expectPlatform) {
  const { formats } = teach(CSV);
  return convert(CSV, { direction, expectPlatform, knowledge: { formats } });
}
const lossCodes = (r) => r.losses.map((l) => l.code);

test('Shopify: VAT carried as the vat_rate metafield; short description, currency and unit price declared lost', () => {
  const r = viaEngine('eloshon-to-shopify', 'eloshon');
  assert.equal(r.ok, true);
  const col = r.headers.find((h) => h.startsWith('vat_rate'));
  assert.ok(col, 'vat_rate metafield column');
  assert.deepEqual(r.rows.map((x) => x[col]), ['6', '6', '21']);
  assert.ok(['loss_short_description', 'loss_currency', 'loss_unit_price'].every((c) => lossCodes(r).includes(c)));
  assert.ok(!lossCodes(r).includes('loss_vat_rate'));
});

test('WooCommerce: the short description has its own column, VAT travels as Meta: vat_rate', () => {
  const r = viaEngine('eloshon-to-woocommerce', 'eloshon');
  assert.equal(r.ok, true);
  assert.equal(r.rows[0]['Short description'], 'Un fromage doux');
  assert.equal(r.rows[0]['Meta: vat_rate'], '6');
  assert.ok(!lossCodes(r).includes('loss_short_description'));
  assert.ok(lossCodes(r).includes('loss_currency') && lossCodes(r).includes('loss_unit_price'));
});

test('Wix and BigCommerce cannot take the VAT rate: declared, with the number of products', () => {
  for (const direction of ['eloshon-to-wix', 'eloshon-to-bigcommerce']) {
    const r = viaEngine(direction, 'eloshon');
    assert.equal(r.ok, true, direction);
    const vat = r.losses.find((l) => l.code === 'loss_vat_rate');
    assert.ok(vat, direction);
    assert.equal(vat.params.count, 3);
  }
});

test('a WooCommerce short description survives Woo → Woo and is declared lost towards Shopify', () => {
  const csv = ['Type,SKU,Name,Short description,Description,Regular price', 'simple,A1,Chaise,"Courte",<p>Longue</p>,59.90'].join('\n');
  const woo = convert(csv, { direction: 'woocommerce-to-woocommerce', expectPlatform: 'woocommerce' });
  if (woo.ok) assert.equal(woo.rows[0]['Short description'], 'Courte');
  const shopify = convert(csv, { direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce' });
  assert.equal(shopify.ok, true);
  assert.ok(lossCodes(shopify).includes('loss_short_description'));
  assert.equal(shopify.rows[0]['SEO Description'], '', 'a teaser is not an SEO description');
});
