/**
 * Embedded product-state (A1 "état intégré"): read products[] + pagination{}
 * from a hydration JSON blob. Generic — keyed on shape, not site name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEmbeddedProducts } from '../embedded-state.mjs';

test('reads products[] with name/price/sku + pagination from an embedded blob', () => {
  const html = `<html><body><script>window.__X_STATE__ = {"grid":{"pageSize":36,"currentPage":0,"totalPages":3,"totalResults":102,"products":[`
    + `{"code":"295070053","name":"Jean 502","url":"/p/295070053","price":{"formattedValue":"99,95 €","currencyIso":"EUR"}},`
    + `{"code":"005010114","name":"501 Original","url":"/p/005010114","price":{"value":109.95,"currencyIso":"EUR"}}]}}</script></body></html>`;
  const { cards, pagination } = extractEmbeddedProducts(html, 'https://shop.com/BE/fr_BE/');
  assert.equal(cards.length, 2);
  assert.equal(pagination.totalResults, 102);
  assert.equal(pagination.totalPages, 3);
  assert.equal(cards[0].name, 'Jean 502');
  assert.equal(cards[0].sku, '295070053');
  assert.equal(cards[0].price, 99.95);
  assert.equal(cards[0].currency, 'EUR');
  assert.ok(cards[0].sourceUrl.endsWith('/p/295070053'));
  assert.equal(cards[1].price, 109.95);
});

test('no embedded product blob → empty, no throw', () => {
  const { cards, pagination } = extractEmbeddedProducts('<html><body><p>rien</p></body></html>', 'https://shop.com/');
  assert.equal(cards.length, 0);
  assert.equal(pagination, null);
});

test('picks the LARGER product array when several blobs exist (recommended vs grid)', () => {
  const html = `<script>a={"items":[{"name":"reco","url":"/product/r"}]}</script>`
    + `<script>b={"products":[{"name":"p1","url":"/product/1"},{"name":"p2","url":"/product/2"},{"name":"p3","url":"/product/3"}]}</script>`;
  const { cards } = extractEmbeddedProducts(html, 'https://s.com/');
  assert.equal(cards.length, 3);
});

test('ignores a non-product array (facets/brands: a name but no price, sku or product URL)', () => {
  const html = `<script>x={"items":[{"name":"4Goodz"},{"name":"Bosch"},{"name":"En promo","url":"/c/all?filter=promo"}]}</script>`;
  const { cards } = extractEmbeddedProducts(html, 'https://s.com/');
  assert.equal(cards.length, 0, 'brands/filters are not products');
});
