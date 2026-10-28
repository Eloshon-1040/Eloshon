/**
 * Generic DOM-grid heuristic — the last-resort layer for listing pages with no
 * structured data and no readable embedded JSON. Generic by construction: the
 * fixtures below are NOT real sites; the same structural rules must serve any grid.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDomGrid } from '../extract/dom-grid.mjs';

const tile = (id, name, price, img) => `
  <li class="card">
    <a class="ph" href="/product/${id}"><img src="/img/${id}.jpg" alt="${name}"></a>
    <a class="title" href="/product/${id}">${name}</a>
    <span class="price">${price}</span>
  </li>`;
const grid = (tiles) => `<!doctype html><html><head><title>Liste</title></head><body><nav><a href="/">Accueil</a><a href="/c/soldes">Soldes</a></nav><ul class="grid">${tiles.join('')}</ul><footer><a href="/aide">Aide</a></footer></body></html>`;

test('plain-HTML grid: repeated tiles → products (name, price, image, url), nav/footer links ignored', () => {
  const html = grid([
    tile('blue-shirt-101', 'Chemise Bleue', '29,99 €', '101'),
    tile('red-shirt-102', 'Chemise Rouge', '34,50 €', '102'),
    tile('green-shirt-103', 'Chemise Verte', '19,99 €', '103'),
    tile('black-shirt-104', 'Chemise Noire', '49,00 €', '104'),
  ]);
  const { cards } = extractDomGrid(html, 'https://shop.test/c/chemises');
  assert.equal(cards.length, 4);
  const c = cards.find((x) => /Bleue/.test(x.name));
  assert.equal(c.price, 29.99);
  assert.equal(c.currency, 'EUR');
  assert.equal(c.sourceUrl, 'https://shop.test/product/blue-shirt-101');
  assert.equal(c.images[0], 'https://shop.test/img/blue-shirt-101.jpg');
  assert.equal(c.strategy, 'dom-grid');
});

test('a product id is read from a data-attribute (more reliable than text)', () => {
  const t = (id, sku, name, price) => `<li data-sku="${sku}"><a href="/product/${id}"><img src="/i/${id}.jpg" alt="${name}"></a><span>${price}</span></li>`;
  const html = `<html><body><ul>${t('a-1', 'SKU-A', 'Article A', '10,00 €')}${t('b-2', 'SKU-B', 'Article B', '12,00 €')}${t('c-3', 'SKU-C', 'Article C', '14,00 €')}</ul></body></html>`;
  const { cards } = extractDomGrid(html, 'https://shop.test/c/x');
  assert.equal(cards.length, 3);
  assert.ok(cards.some((c) => c.sku === 'SKU-A'));
});

test('image-link + title-link for the SAME product are merged, not double-counted', () => {
  const html = grid([tile('a-1', 'Article A', '10,00 €', 'a'), tile('b-2', 'Article B', '12,00 €', 'b'), tile('c-3', 'Article C', '14,00 €', 'c')]);
  const { cards } = extractDomGrid(html, 'https://shop.test/c/x');
  assert.equal(cards.length, 3, 'two anchors per product → one card each');
});

test('name from the image alt when the anchor has no text', () => {
  const t = (id, alt, price) => `<div class="p"><a href="/product/${id}"><img src="/i/${id}.jpg" alt="${alt}"></a><span>${price}</span></div>`;
  const html = `<html><body><section>${t('x1', 'Sac Cabas', '39,90 €')}${t('x2', 'Sac Bandoulière', '59,90 €')}${t('x3', 'Sac à Dos', '79,90 €')}</section></body></html>`;
  const { cards } = extractDomGrid(html, 'https://shop.test/c/sacs');
  assert.equal(cards.length, 3);
  assert.ok(cards.some((c) => c.name === 'Sac Cabas' && c.price === 39.9));
});

test('NOT a grid: a single product page (one product link) yields nothing', () => {
  const html = `<html><body><h1>Chemise Bleue</h1><a href="/product/blue-101">Voir</a><span>29,99 €</span><a href="/panier">Panier</a></body></html>`;
  assert.deepEqual(extractDomGrid(html, 'https://shop.test/product/blue-101'), { cards: [], pagination: null });
});

test('NOT a grid: a page of nav/editorial links (no product URLs) yields nothing', () => {
  const html = `<html><body><nav><a href="/c/femme">Femme</a><a href="/c/homme">Homme</a><a href="/blog/mode">Blog</a><a href="/aide">Aide</a><a href="/magasins">Magasins</a></nav></body></html>`;
  assert.deepEqual(extractDomGrid(html, 'https://shop.test/').cards, []);
});

test('tiles with a product link but no price AND no image are dropped (no bare links)', () => {
  const t = (id, name) => `<li><a href="/product/${id}">${name}</a></li>`;
  const html = `<html><body><ul>${t('n1', 'Truc 1')}${t('n2', 'Truc 2')}${t('n3', 'Truc 3')}${t('n4', 'Truc 4')}</ul></body></html>`;
  assert.deepEqual(extractDomGrid(html, 'https://shop.test/c/x').cards, []);
});
