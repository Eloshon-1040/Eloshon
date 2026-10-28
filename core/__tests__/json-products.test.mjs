/**
 * XHR-grid archetype (Colruyt / Leroy Merlin / SPA retailers): products are not
 * in the HTML, they arrive as a JSON API/XHR response. extractProductsFromJson
 * finds the product array inside ANY parsed JSON — generic, keyed on shape
 * (a product SIGNAL: price/sku/EAN/product URL), never on a site name.
 *
 * Off-site behaviour: on a JSON response that is a list of categories, facets or
 * suggestions (name only, no price/sku/url), it returns 0 — same guard as the
 * embedded-state path, so it never mistakes a menu for a grid.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractProductsFromJson } from '../embedded-state.mjs';

test('flat API response: {page,totalPages,products:[...]}', () => {
  const api = { page: 1, pageSize: 24, totalPages: 5, totalResults: 118, products: [
    { code: '10023', name: 'Café moulu 250g', url: '/p/10023', price: { value: 3.49, currencyIso: 'EUR' } },
    { code: '10024', name: 'Café grains 1kg', url: '/p/10024', price: { value: 12.9, currencyIso: 'EUR' } },
  ] };
  const { cards, pagination } = extractProductsFromJson(api, 'https://shop.be/fr/');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].sku, '10023');
  assert.equal(cards[0].price, 3.49);
  assert.ok(cards[0].sourceUrl.endsWith('/p/10023'));
  assert.equal(pagination.totalPages, 5);
  assert.equal(pagination.totalResults, 118);
  assert.equal(pagination.currentPage, 1);
});

test('nested pagination + array under a different key: {pagination:{...}, results:[...]}', () => {
  const api = { pagination: { pageNumber: 2, pageCount: 8, totalCount: 190, pageSize: 24 }, results: [
    { id: 'A1', title: 'Perceuse', href: '/produit/a1', priceInclTax: 89.0 },
    { id: 'A2', title: 'Visseuse', href: '/produit/a2', priceInclTax: 59.0 },
    { id: 'A3', title: 'Meuleuse', href: '/produit/a3', priceInclTax: 74.0 },
  ] };
  const { cards, pagination } = extractProductsFromJson(api, 'https://lm.fr/');
  assert.equal(cards.length, 3);
  assert.equal(pagination.totalPages, 8);
  assert.equal(pagination.currentPage, 2);
  assert.equal(pagination.totalResults, 190);
});

test('deeply nested: product array buried under data.catalog.grid.items', () => {
  const api = { data: { catalog: { grid: { total: 2, items: [
    { sku: 'X', name: 'Chaise', canonicalUrl: '/p/x', price: 49 },
    { sku: 'Y', name: 'Table', canonicalUrl: '/p/y', price: 149 },
  ] } } } };
  const { cards } = extractProductsFromJson(api, 'https://s.com/');
  assert.equal(cards.length, 2);
  assert.equal(cards[1].name, 'Table');
});

test('picks the GRID over a small "recommended" array in the same payload', () => {
  const api = {
    recommended: [{ sku: 'r1', name: 'reco', url: '/p/r1', price: 5 }],
    listing: { products: Array.from({ length: 6 }, (_, i) => ({ sku: `g${i}`, name: `grid ${i}`, url: `/p/g${i}`, price: 10 + i })) },
  };
  const { cards } = extractProductsFromJson(api, 'https://s.com/');
  assert.equal(cards.length, 6, 'the 6-item grid wins over the 1-item reco');
});

test('a category/facet menu (name only, no price/sku/url) → 0, not mistaken for a grid', () => {
  const api = { menu: [
    { name: 'Boissons' }, { name: 'Épicerie' }, { name: 'Frais' }, { name: 'Surgelés' },
  ] };
  const { cards, pagination } = extractProductsFromJson(api, 'https://s.com/');
  assert.equal(cards.length, 0);
  assert.equal(pagination, null);
});

test('an array where only a couple of items are product-like stays rejected (mostly-products rule)', () => {
  const api = { blocks: [
    { name: 'Bannière' }, { name: 'Promo du jour' }, { name: 'Newsletter' },
    { sku: 'p1', name: 'Un produit', url: '/p/p1', price: 9 },
  ] };
  const { cards } = extractProductsFromJson(api, 'https://s.com/');
  assert.equal(cards.length, 0, '1 product among 4 mixed blocks is not a grid');
});

test('cursor/offset paging is read so the next call can be chained (Algolia/GraphQL-style)', () => {
  const api = { nbHits: 640, offset: 40, limit: 20, nextCursor: 'eyJwIjoz', hits: [
    { objectID: 's1', name: 'Article 1', url: '/p/s1', price: 12 },
    { objectID: 's2', name: 'Article 2', url: '/p/s2', price: 15 },
  ] };
  const { cards, pagination } = extractProductsFromJson(api, 'https://s.com/');
  assert.equal(cards.length, 2);
  assert.equal(pagination.totalResults, 640);
  assert.equal(pagination.offset, 40);
  assert.equal(pagination.pageSize, 20);
  assert.equal(pagination.nextCursor, 'eyJwIjoz');
});

test('non-object input never throws', () => {
  assert.deepEqual(extractProductsFromJson(null, 'https://s.com/'), { cards: [], pagination: null });
  assert.deepEqual(extractProductsFromJson('x', 'https://s.com/'), { cards: [], pagination: null });
  assert.deepEqual(extractProductsFromJson(42, 'https://s.com/'), { cards: [], pagination: null });
});
