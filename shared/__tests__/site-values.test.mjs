/**
 * Fixed values on two levels (shared/export/site-values.mjs): the SITE profile (brand) and one BATCH per list page
 * (collection, type, tags, status, attributes), so the men's, women's and kids' scrapes of a site never mix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchKeyOf, batchLabelOf, splitConstants, joinConstants, sameConstants, storedConstantsFor, putBatch, sanitizeSiteProfile, sanitizeBatch, levelOf } from '../export/site-values.mjs';

test('a batch is a list page: paging, sorting and tracking parameters do not make another batch; a category facet does', () => {
  assert.equal(batchKeyOf('https://www.adidas.be/fr/chaussures-hommes'), 'adidas.be/fr/chaussures-hommes');
  assert.equal(batchKeyOf('https://www.adidas.be/fr/chaussures-hommes?start=48&utm_source=x'), 'adidas.be/fr/chaussures-hommes');
  assert.notEqual(batchKeyOf('https://www.adidas.be/fr/chaussures-femmes'), batchKeyOf('https://www.adidas.be/fr/chaussures-hommes'));
  assert.equal(batchKeyOf('https://www.colruyt.be/fr/produits/toutes-les-categories/boissons?categories=412&page=1'), 'colruyt.be/fr/produits/toutes-les-categories/boissons?categories=412');
  assert.equal(batchKeyOf('https://marshydro.eu/collections/led-grow-light-fr/page/5/?lang=fr'), 'marshydro.eu/collections/led-grow-light-fr');
  assert.equal(batchKeyOf('https://www.hydrozone.fr/755-ph-perfect-base-nutrients?p=2'), 'hydrozone.fr/755-ph-perfect-base-nutrients');
  assert.equal(batchKeyOf('chrome://extensions'), null);
  assert.equal(batchLabelOf('https://www.adidas.be/fr/chaussures-hommes?start=48'), 'adidas / chaussures-hommes');
  assert.equal(batchLabelOf('https://www.colruyt.be/fr/produits/toutes-les-categories/boissons?categories=412'), 'colruyt / boissons (categories=412)');
});

test('the brand is the site\'s; collection, type, tags, status and attributes are the batch\'s', () => {
  const { site, batch } = splitConstants([
    { role: 'brand', value: 'Adidas' }, { role: 'category', value: 'Chaussures' }, { role: 'product_type', value: 'Chaussures hommes' },
    { role: 'tags', value: 'soldes' }, { role: 'status', value: 'draft' }, { role: 'attribute', term: 'genre', value: 'Homme' }, { role: 'category', value: '' },
  ]);
  assert.deepEqual(site.map((c) => c.key), ['brand']);
  assert.deepEqual(batch.map((c) => c.key), ['category', 'product_type', 'tags', 'status', 'genre']);
  assert.equal(levelOf({ role: 'attribute' }), 'batch');
  assert.ok(sameConstants([{ role: 'brand', value: 'Adidas' }, { role: 'category', value: '' }], [{ role: 'brand', value: 'Adidas', mode: 'always' }]));
  assert.ok(!sameConstants([{ role: 'brand', value: 'Adidas' }], [{ role: 'brand', value: 'adidas' }]));
});

test('the app gives a job the values of ITS page only: hommes and femmes never share a type; a type typed in the app wins', () => {
  const now = '2026-10-28T12:00:00.000Z';
  const H = 'https://www.adidas.be/fr/chaussures-hommes'; const F = 'https://www.adidas.be/fr/chaussures-femmes';
  const site = sanitizeSiteProfile({ constants: [{ role: 'brand', value: 'Adidas' }, { role: 'product_type', value: 'not a site value' }], fields: [{ key: 'name', label: 'Nom', role: 'title' }, { key: 'bad key!' }] }, now);
  assert.deepEqual(site.constants.map((c) => c.key), ['brand'], 'a batch value is never kept at the site level');
  assert.deepEqual(site.fields, [{ key: 'name', label: 'Nom', role: 'title' }]);
  let batches = putBatch({}, batchKeyOf(H), sanitizeBatch({ constants: [{ role: 'category', value: 'Chaussures' }, { role: 'product_type', value: 'Chaussures hommes' }] }, H, now));
  batches = putBatch(batches, batchKeyOf(F), sanitizeBatch({ constants: [{ role: 'product_type', value: 'Chaussures femmes' }] }, F, now));
  const of = (u, o) => Object.fromEntries(storedConstantsFor({ site, batches }, u, o).map((c) => [c.key, c.value]));
  assert.deepEqual(of(`${H}?start=48`), { brand: 'Adidas', category: 'Chaussures', product_type: 'Chaussures hommes' });
  assert.deepEqual(of(F), { brand: 'Adidas', product_type: 'Chaussures femmes' });
  assert.deepEqual(of('https://www.adidas.be/fr/chaussures-enfants'), { brand: 'Adidas' }, 'a page with no saved batch: the site values only');
  assert.deepEqual(of(H, { productType: 'Baskets' }), { brand: 'Adidas', category: 'Chaussures' });
  assert.equal(sanitizeBatch({ constants: [{ role: 'brand', value: 'x' }] }, H, now), null, 'a batch holds no site value');
  assert.deepEqual(joinConstants(site.constants, batches[batchKeyOf(F)].constants).map((c) => c.key), ['brand', 'product_type']);
  assert.equal(Object.keys(putBatch(batches, batchKeyOf(F), null)).length, 1);
});
