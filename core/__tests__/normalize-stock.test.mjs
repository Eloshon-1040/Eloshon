/**
 * Normalisation of the new rich fields: category path (trail + own category, the
 * "Home" step dropped), stock state (schema.org term, from the sizes first, an
 * unknown statement kept verbatim), rating + review count.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toNormalizedProduct, categoryPath } from '../normalize.mjs';

test('categoryPath: trail then own category, no "Home", no repeated last step', () => {
  assert.equal(categoryPath(['Home', 'Homme'], 'Sneakers', 'https://eu.puma.test/be/fr/pd/x'), 'Homme > Sneakers');
  assert.equal(categoryPath(['Kinder', 'Hoodies'], 'hoodies'), 'Kinder > Hoodies');
  assert.equal(categoryPath([], 'Schuh (Damen)'), 'Schuh (Damen)');
  assert.equal(categoryPath(null, null), null);
});

test('toNormalizedProduct: stock from sizes first, verbatim fallback, rating only with reviews', () => {
  const base = { name: 'Model', price: 10, sourceUrl: 'https://s.test/p/1' };
  const a = toNormalizedProduct({ ...base, availability: 'InStock', variants: [{ name: 'S', availability: 'OutOfStock' }, { name: 'M', availability: 'OutOfStock' }], rating: 4.2, reviewCount: 9 });
  assert.equal(a.raw.availability, 'OutOfStock', 'the sizes are more precise than the page state');
  assert.equal(a.raw.rating, 4.2); assert.equal(a.raw.review_count, 9);
  const b = toNormalizedProduct({ ...base, availability: 'http://schema.org/InStock' });
  assert.equal(b.raw.availability, 'InStock');
  const c = toNormalizedProduct({ ...base, availability: 'Livré en 3 semaines' });
  assert.equal(c.raw.availability, 'Livré en 3 semaines', 'an unknown statement is kept verbatim');
  const d = toNormalizedProduct({ ...base, rating: 0, reviewCount: 0 });
  assert.equal(d.raw.rating, null); assert.equal(d.raw.review_count, 0);
  const e = toNormalizedProduct({ ...base, breadcrumb: ['Accueil', 'Femme'], category: 'Robes' });
  assert.equal(e.source_category, 'Femme > Robes');
});
