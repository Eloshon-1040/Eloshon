/**
 * The product CSV is the FINAL deliverable — it must re-read to exactly the
 * declared number of columns on EVERY row, including adversarial content
 * (a name with a comma, a name with a double-quote, a variants JSON blob with
 * commas + quotes). Parses the written string with an RFC-4180 reader, not the
 * in-memory object.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toImportCsv, COLUMNS } from '../csv.mjs';

// Minimal RFC-4180 parser: fields quoted with "", doubled "" is a literal quote.
function parseCsv(text) {
  const rows = []; let f = '', row = [], q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c === '\r') { /* skip */ }
    else f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}

test('every row re-reads to the declared column count, even with nasty fields', () => {
  const products = [
    { name: 'Jean 502™ Taper', price: 99.95, image_url: 'https://x/a.jpg?$q$', source_url: 'https://x/BE/fr_BE/p/1', source_product_id: '1', source_category: 'vetements > homme > jeans', color: null, variants: [{ code: '1', type: 'couleur', name: null, image: 'https://x/sw.jpg' }, { code: '2', type: 'couleur', name: null }] },
    { name: 'Chaise, pliante', price: 12.5, source_url: 'https://x/p/2', source_product_id: '2' },        // comma in name
    { name: 'Écran 24" HD', price: 130, source_url: 'https://x/p/3', source_product_id: '3' },                 // double-quote in name
    { name: 'Sans variantes', price: 5, source_url: 'https://x/p/4', source_product_id: '4', variants: null },
  ];
  const csv = toImportCsv(products, { storeSlug: 'demo' });
  const rows = parseCsv(csv);
  assert.equal(rows[0].length, COLUMNS.length, 'header column count');
  assert.equal(rows.length, products.length + 1, 'one header + one row per product');
  rows.forEach((r, i) => assert.equal(r.length, COLUMNS.length, `row ${i} must have ${COLUMNS.length} columns, got ${r.length}`));
  // header names round-trip
  assert.deepEqual(rows[0], COLUMNS);
  // a data value with a comma survives intact in its own column
  const nameIdx = COLUMNS.indexOf('name');
  assert.equal(rows[2][nameIdx], 'Chaise, pliante');
  assert.equal(rows[3][nameIdx], 'Écran 24" HD');
  // variants JSON round-trips to valid JSON in its own column
  const vIdx = COLUMNS.indexOf('variants');
  const parsed = JSON.parse(rows[1][vIdx]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].type, 'couleur');
});
