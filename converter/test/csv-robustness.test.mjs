/**
 * Real exports break the textbook CSV rules in four silent, destructive ways
 * (audit): the delimiter was guessed from the header line alone, a lone quote
 * swallowed the rest of the file, a repeated header overwrote its twin, and
 * empty tail rows such as ";;;;" became failing products.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../core/dist/index.mjs';

test('delimiter: records vote, a header full of commas does not beat the real ";"', () => {
  const csv = ['Nom;Prix (EUR, TTC, hors promo);Description, courte, longue', 'Chaise;59,00;Bois, naturel', 'Table;129,90;Chêne, massif'].join('\n');
  const t = parseCsv(csv);
  assert.deepEqual(t.headers, ['Nom', 'Prix (EUR, TTC, hors promo)', 'Description, courte, longue']);
  assert.equal(t.rows[1]['Prix (EUR, TTC, hors promo)'], '129,90');
});

test('delimiter: tab and plain comma files are still recognised', () => {
  assert.deepEqual(parseCsv('a\tb\tc\n1\t2\t3').headers, ['a', 'b', 'c']);
  assert.deepEqual(parseCsv('a,b,c\n1,2,3').headers, ['a', 'b', 'c']);
});

test('a lone quote inside an unquoted cell is an inch mark, not the start of a quoted field', () => {
  const t = parseCsv('Nom,Prix\n12" tuyau,5\nRaccord,3\n');
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0].Nom, '12" tuyau');
  assert.equal(t.rows[1].Nom, 'Raccord');
});

test('a quoted cell may still hold doubled quotes, commas and line breaks', () => {
  const t = parseCsv('Nom,Note\n"Vis ""inox""","a, b\nc"\nClou,x\n');
  assert.equal(t.rows[0].Nom, 'Vis "inox"');
  assert.equal(t.rows[0].Note, 'a, b\nc');
  assert.equal(t.rows[1].Nom, 'Clou');
});

test('duplicated headers are all kept, the 2nd and later suffixed', () => {
  const t = parseCsv('Image,Image,Image,Prix\na.jpg,b.jpg,c.jpg,10\n');
  assert.deepEqual(t.headers, ['Image', 'Image__2', 'Image__3', 'Prix']);
  assert.deepEqual([t.rows[0].Image, t.rows[0].Image__2, t.rows[0].Image__3], ['a.jpg', 'b.jpg', 'c.jpg']);
});

test('Excel tail rows made only of delimiters are skipped', () => {
  const t = parseCsv('Nom;Prix\nA;1\nB;2\n;\n;\n');
  assert.equal(t.rows.length, 2);
});
