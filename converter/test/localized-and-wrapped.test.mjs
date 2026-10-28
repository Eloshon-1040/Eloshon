/**
 * Two real-world damages seen on a client's WooCommerce export (audit): the store
 * speaks French ("UGS", "Tarif régulier", "Méta : x" instead of "SKU", "Regular
 * price", "Meta: x") and a spreadsheet re-saved the file with every line wrapped
 * into one quoted cell followed by empty columns. Both were `unrecognized`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, convert } from '../core/dist/index.mjs';

const FR_HEADER = 'ID,Type,UGS,Nom,"Description courte",Description,"Tarif promo","Tarif régulier",Catégories,Étiquettes,Marques,"Méta : _yoast_wpseo_focuskw"';
const FR_ROWS = [
  '10,simple,CH-1,Chaise en bois,"Courte, avec virgule",<p>Longue</p>,49.90,59.90,"Maison > Salon",bois,Ikea,chaise',
  '11,simple,TB-1,Table basse,,<p>Table</p>,,129.00,Maison,,Ikea,',
];
const FR_CSV = [FR_HEADER, ...FR_ROWS].join('\n');

// the same file as a spreadsheet wraps it: each line in one cell, then ";;;;" columns
const wrap = (text) => text.split('\n').map((l) => `"${l.replace(/"/g, '""')}"` + ';'.repeat(11)).join('\n');

test('a French WooCommerce export is read with English headers, nothing else changes', () => {
  const t = parseCsv(FR_CSV);
  assert.deepEqual(t.repaired, ['headers:woocommerce-fr']);
  assert.deepEqual(t.headers.slice(0, 8), ['ID', 'Type', 'SKU', 'Name', 'Short description', 'Description', 'Sale price', 'Regular price']);
  assert.ok(t.headers.includes('Meta: _yoast_wpseo_focuskw'));
  assert.equal(t.rows[0]['Regular price'], '59.90');
  assert.equal(t.rows[0]['Short description'], 'Courte, avec virgule');
});

test('a French WooCommerce export converts to Shopify (a store export has no Parent / Attribute columns)', () => {
  const r = convert(FR_CSV, { direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce' });
  assert.equal(r.ok, true);
  assert.equal(r.sourceFormat, 'woo_products_modern');
  assert.equal(r.counts.outputUnits, 2);
  assert.equal(r.rows[0]['Title'], 'Chaise en bois');
  assert.equal(r.rows[0]['Variant SKU'], 'CH-1');
});

test('headers of other files are never translated', () => {
  const t = parseCsv('Nom;Prix;UGS\nA;1;x\n');
  assert.deepEqual(t.headers, ['Nom', 'Prix', 'UGS'], 'no "Tarif régulier": not a WooCommerce export');
  assert.equal(t.repaired, undefined);
});

test('every line wrapped in one quoted cell is unwrapped, then read like the original', () => {
  const t = parseCsv(wrap(FR_CSV));
  assert.deepEqual(t.repaired, ['headers:woocommerce-fr', 'wrapped_rows']);
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0].SKU, 'CH-1');
  assert.equal(t.rows[0]['Short description'], 'Courte, avec virgule', 'the inner quoting survives');
  const r = convert(wrap(FR_CSV), { direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce' });
  assert.equal(r.ok, true);
  assert.equal(r.counts.outputUnits, 2);
});

test('an ordinary single-column file is not "unwrapped"', () => {
  const t = parseCsv('Nom\nA\nB\n');
  assert.deepEqual(t.headers, ['Nom']);
  assert.equal(t.rows.length, 2);
  assert.equal(t.repaired, undefined);
});
