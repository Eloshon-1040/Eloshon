/**
 * A grid whose product links have no recognisable product-URL shape (« /catalogue/<slug>_981/index.html »):
 * the tiles are found by REPETITION — same-site links sharing one address template, each with a price —
 * never by a word of the URL. Menus, category links and pagers (no price per link) are left out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDomGrid } from '../extract/dom-grid.mjs';

const BASE = 'https://books.example/catalogue/category/travel_2/index.html';
const tile = (slug, id, price) => `<article class="pod"><a href="../../${slug}_${id}/index.html"><img src="/media/${id}.jpg" alt="${slug}"></a><h3><a href="../../${slug}_${id}/index.html" title="${slug}">${slug}</a></h3><p class="price">£${price}</p></article>`;
const page = `<html><body><nav><a href="../../category/travel_2/index.html">Travel</a><a href="../../category/poetry_23/index.html">Poetry</a><a href="../../category/music_14/index.html">Music</a></nav>
  ${tile('mountains', 981, '45.17')}${tile('full-moon', 811, '49.43')}${tile('see-america', 732, '48.87')}${tile('vagabonding', 552, '36.94')}
  <ul class="pager"><a href="page-2.html">next</a></ul></body></html>`;

test('product tiles found by repetition when their links have no product shape', () => {
  const { cards } = extractDomGrid(page, BASE);
  assert.equal(cards.length, 4);
  assert.deepEqual(cards.map((c) => c.price), [45.17, 49.43, 48.87, 36.94]);
  assert.equal(cards[0].sourceUrl, 'https://books.example/catalogue/mountains_981/index.html');
  assert.equal(cards[0].name, 'mountains');
  assert.ok(!cards.some((c) => /category|page-2/.test(c.sourceUrl)), 'menus and pagers are not products');
});

test('repeated links WITHOUT a price are not taken for products', () => {
  const noPrice = page.replace(/<p class="price">£[\d.]+<\/p>/g, '');
  const { cards } = extractDomGrid(noPrice.replace(/<img[^>]*>/g, ''), BASE);
  assert.equal(cards.length, 0);
});
