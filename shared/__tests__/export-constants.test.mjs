// Fixed values for a whole scrape (shared/export/constants.mjs): typed once, given to every product.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConstants, applyConstantsToRow, applyConstantsToProduct, constantColumns, tagList } from '../export/constants.mjs';

const C = normalizeConstants([
  { role: 'brand', value: ' adidas ', mode: 'empty' },
  { role: 'category', value: 'Homme > Chaussures', mode: 'always' },
  { role: 'product_type', value: 'Chaussures' },
  { role: 'tags', value: 'soldes, Été 2026' },
  { role: 'attribute', term: 'matiere', value: 'Cuir' },
  { role: 'attribute', label: 'Couleur préférée', value: 'x' }, // not an established term: dropped
  { role: 'status', value: 'Brouillon' },
  { role: 'brand', value: '' }, // empty: dropped
  { role: 'nope', value: 'x' }, // unknown role: dropped
]);

test('values are validated: empty and unknown dropped, a free attribute keyed by its name', () => {
  assert.deepEqual(C.map((c) => [c.role, c.key, c.mode]), [['brand', 'brand', 'empty'], ['category', 'category', 'always'], ['product_type', 'product_type', 'always'], ['tags', 'tags', 'always'], ['attribute', 'matiere', 'always'], ['status', 'status', 'always']]);
  assert.equal(C[0].value, 'adidas');
  assert.equal(C.find((c) => c.role === 'status').value, 'draft', 'the status word becomes its code');
});

test('on a row: « empty » keeps what the page read, « always » replaces, tags are added', () => {
  const r = applyConstantsToRow({ name: 'Samba', brand: 'Adidas Originals', category: 'Homme', tags: 'soldes, nouveau' }, C);
  assert.equal(r.brand, 'Adidas Originals', 'the page gave a brand: kept');
  assert.equal(r.category, 'Homme > Chaussures', 'always: replaced');
  assert.equal(r.product_type, 'Chaussures');
  assert.equal(r.tags, 'soldes, nouveau, Été 2026', 'added, no duplicate');
  assert.equal(r.matiere, 'Cuir');
  assert.equal(applyConstantsToRow({ name: 'X' }, C).brand, 'adidas', 'no brand on the page: the fixed one');
});

test('on a recorded product (products.json fields)', () => {
  const np = applyConstantsToProduct({ name: 'Samba', source_category: 'Chaussures', product_type: null, raw: { brand: null } }, C);
  assert.equal(np.raw.brand, 'adidas'); assert.equal(np.source_category, 'Homme > Chaussures'); assert.equal(np.product_type, 'Chaussures');
  assert.deepEqual(np.raw.columns, { tags: 'soldes, Été 2026', matiere: 'Cuir', status: 'draft' });
});

test('the export columns carry their role for the Converter; tags split on , ; |', () => {
  assert.deepEqual(constantColumns(C).map((c) => `${c.label}:${c.role}`), ['Marque:brand', 'Collection:category', 'Type de produit:product_type', 'Étiquettes:tags', 'Matière:attribute', 'Statut à l’import:status']);
  assert.deepEqual(tagList('a, b ; A | c'), ['a', 'b', 'c']);
});
