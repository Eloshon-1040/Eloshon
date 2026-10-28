/**
 * A page whose embedded state carries the site's mega-menu (hundreds of category
 * entries, each with a picture) next to the real product grid: the menu entries are
 * not products, a picture link is never a product URL, the grid wins. Plus the
 * nested "discount price", the card's own reviews and a category code in the URL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEmbeddedProducts } from '../extract/embedded-state.mjs';
import { isAssetUrl, isTreeNode, scanUrl } from '../extract/product-shape.mjs';

const CDN = 'https://cdn.shop.test/products';
const menu = Array.from({ length: 30 }, (_, i) => ({
  title: `Rayon ${i}`, icon: `//images.test/r${i}.jpg`, icon_url: `${CDN}/${5000 + i}/s00/424x424/origin.webp`,
  items: [{ title: `Sous-rayon ${i}`, icon_url: `${CDN}/${6000 + i}/s00/424x424/origin.webp` }],
}));
const products = Array.from({ length: 4 }, (_, i) => ({
  id: String(10141429 + i), title: `Salon de jardin ${i}`,
  link: `/fr/jardin/salons-de-jardin/salon-de-jardin-${i}/${10141429 + i}`,
  image: `${CDN}/${10141429 + i}/s01/424x424/origin.webp`, ean: `541462815014${i}`, currency: 'EUR',
  regular: { price: 599 }, discount: { price: 399 - i }, reviews: { rating: 4.53, count: 96 - i },
}));
const page = `<html><body><script>window.__LAYOUT__ = ${JSON.stringify({ menu: { items: menu } })};</script>
  <script>window.__STATE__ = ${JSON.stringify({ products: { quantity: 3788, collection: products } })};</script></body></html>`;
const base = 'https://www.shop.test/fr/jardin/salons-de-jardin/ga086/';

test('menu entries with pictures are not products; the product grid is read', () => {
  const { cards } = extractEmbeddedProducts(page, base);
  assert.equal(cards.length, 4);
  assert.ok(cards.every((c) => /\/salon-de-jardin-\d\/\d+$/.test(c.sourceUrl)), cards.map((c) => c.sourceUrl).join(' '));
  assert.ok(cards.every((c) => !isAssetUrl(c.sourceUrl)));
});

test('the discount price, the card reviews and a clean category', () => {
  const [c] = extractEmbeddedProducts(page, base).cards;
  assert.equal(c.price, 399);
  assert.equal(c.currency, 'EUR');
  assert.equal(c.gtin, '5414628150140');
  assert.equal(c.rating, 4.53);
  assert.equal(c.reviewCount, 96);
  assert.equal(c.category, 'jardin > salons de jardin', 'the category code "ga086" is not a name');
});

test('a discount stated as an amount is never read as the price', () => {
  const html = `<script>window.S = ${JSON.stringify({ products: [
    { title: 'A', link: '/p/a', regular: { price: 100 }, discount: { amount: 20, percent: 20 } },
    { title: 'B', link: '/p/b', regular: { price: 50 }, discount: { amount: 5 } },
  ] })};</script>`;
  const cards = extractEmbeddedProducts(html, 'https://shop.test/').cards;
  assert.deepEqual(cards.map((c) => c.price), [100, 50]);
});

test('helpers: file links, tree nodes, scanUrl skips pictures', () => {
  assert.equal(isAssetUrl('https://cdn.test/products/1/origin.webp'), true);
  assert.equal(isAssetUrl('https://shop.test/fr/salon/10141429'), false);
  assert.equal(isTreeNode({ title: 'Jardin', items: [{ title: 'Salons' }, { title: 'Abris' }] }), true);
  assert.equal(isTreeNode({ name: 'T-shirt', items: [{ size: 'M', price: 10 }] }), false, 'variant items are not menu entries');
  assert.equal(scanUrl({ icon_url: 'https://cdn.test/products/1/origin.webp', title: 'x' }, 'https://shop.test/'), null);
});
