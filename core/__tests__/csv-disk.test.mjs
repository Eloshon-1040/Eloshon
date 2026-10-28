/**
 * The product CSV, written to DISK exactly as the app writes it
 * (fs.writeFileSync(path, toImportCsv(products), 'utf8')), must re-read from the
 * file to exactly 21 columns on EVERY row — header AND data — and no data row
 * may start with a quote. This is the disk-level guard that would have caught a
 * whole-row-quoting regression that an in-memory check might miss.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toImportCsv, COLUMNS } from '../csv.mjs';
import { toNormalizedProduct } from '../normalize.mjs';

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

test('CSV written to disk re-reads to one fixed column count per row; no data row starts with a quote', () => {
  // Real product records (the shape the app produces), incl. a comma in a name,
  // a double-quote in a name, and an embedded-state card with a variants array.
  const raws = [
    { sourceUrl: 'https://shop/BE/fr_BE/p/1', name: 'Jean 502™ Taper', price: 99.95, currency: 'EUR', sku: '1', images: ['https://cdn/a.jpg?$q$'], category: 'vetements > homme > jeans', color: null, variants: [{ code: '1', type: 'couleur', name: null, image: 'https://cdn/sw.jpg' }] },
    { sourceUrl: 'https://shop/p/2', name: 'Chaise, pliante', price: 12.5, sku: '2' },
    { sourceUrl: 'https://shop/p/3', name: 'Écran 24" HD', price: 130, sku: '3' },
  ];
  const products = raws.map((r) => toNormalizedProduct(r, { storeSlug: 'demo', lang: 'fr' }));

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-csv-')), 'products.csv');
  fs.writeFileSync(file, toImportCsv(products, { storeSlug: 'demo' }), 'utf8');   // exact app write

  const buf = fs.readFileSync(file);
  assert.deepEqual([...buf.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM');
  const text = buf.toString('utf8');
  const dataLines = text.replace(/^﻿/, '').split('\r\n').filter(Boolean).slice(1);
  for (const line of dataLines) assert.notEqual(line[0], '"', `no data row may start with a quote: ${line.slice(0, 40)}`);

  const rows = parseCsv(text);
  assert.equal(rows.length, products.length + 1, 'header + one row per product');
  rows.forEach((r, i) => assert.equal(r.length, COLUMNS.length, `disk row ${i}: expected ${COLUMNS.length} columns, got ${r.length}`));

  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
