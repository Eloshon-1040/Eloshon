/**
 * dedupeRepeatedName: collapse a name that is one phrase repeated twice — a
 * generic artifact of listing card + fiche echoing the title (measured on
 * 2ememain: "Vélo vélo de ville Kalkhoff Vélo Vélo de Ville Kalkhoff"). Must NOT
 * touch legitimate names that merely repeat a word.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeRepeatedName, toNormalizedProduct } from '../normalize.mjs';

test('collapses an exact case-insensitive doubled phrase', () => {
  assert.equal(dedupeRepeatedName('Vélo vélo de ville Kalkhoff Vélo Vélo de Ville Kalkhoff'), 'Vélo vélo de ville Kalkhoff');
  assert.equal(dedupeRepeatedName('Nike Air Max Nike Air Max'), 'Nike Air Max');
});

test('collapses across separators ("Name - Name")', () => {
  assert.equal(dedupeRepeatedName('Chaise Design - Chaise Design'), 'Chaise Design');
});

test('leaves a genuine name that merely repeats a word', () => {
  assert.equal(dedupeRepeatedName('New York New York Bag'), 'New York New York Bag'); // odd word count
  assert.equal(dedupeRepeatedName('Table Basse'), 'Table Basse');
  assert.equal(dedupeRepeatedName('Sac à main noir cuir'), 'Sac à main noir cuir');
});

test('empty / falsy in → safe', () => {
  assert.equal(dedupeRepeatedName(''), '');
  assert.equal(dedupeRepeatedName(null), '');
});

test('applied through toNormalizedProduct.name', () => {
  const p = toNormalizedProduct({ name: 'Kalkhoff Vélo Kalkhoff Vélo', canonicalUrl: 'https://x.be/v/1' });
  assert.equal(p.name, 'Kalkhoff Vélo');
  assert.equal(p.name_en, undefined, 'one language only: no mirrored _en copy');
});
