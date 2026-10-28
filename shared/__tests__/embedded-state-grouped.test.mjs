/**
 * Generic JSON product reading, one level deeper (no site rule):
 *  - a GROUPED grid ([{…, products:[p]}, …]) is read as a whole, even when each
 *    group holds a single product;
 *  - the name may sit in a small text sub-object ({ copy:{ title } }) — never the
 *    name of a brand / category sub-object;
 *  - the product link may be an object ({ url, path }); the image an object of
 *    named renditions ({ portraitURL, … }).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractProductsFromJson } from '../extract/embedded-state.mjs';

const BASE = 'https://www.shop.test/w/sale';
const product = (i) => ({
  productCode: `AB${100 + i}-00${i}`,
  copy: { title: `Model ${i}`, subTitle: 'Shoe' },
  brand: { name: 'BrandCo' },
  prices: { currency: 'EUR', currentPrice: 50 + i, initialPrice: 80 + i },
  colorwayImages: { portraitURL: `https://img.shop.test/p/${i}.png`, squarishURL: `https://img.shop.test/s/${i}.png` },
  pdpUrl: { url: `https://www.shop.test/t/model-${i}/AB${100 + i}-00${i}`, path: `/t/model-${i}` },
});
const wall = { productGroupings: [{ cardType: 'default', products: [product(1)] }, { cardType: 'default', products: [product(2), product(3)] }, { cardType: 'default', products: [product(4)] }], pages: { next: '/api/wall?anchor=24', totalResources: 300 } };

test('grouped grid with one product per group → every product, name from copy.title, link + image objects read', () => {
  const r = extractProductsFromJson(wall, BASE);
  assert.equal(r.cards.length, 4);
  const c = r.cards[1];
  assert.equal(c.name, 'Model 2');
  assert.equal(c.price, 52); assert.equal(c.currency, 'EUR');
  assert.equal(c.sourceUrl, 'https://www.shop.test/t/model-2/AB102-002');
  assert.deepEqual(c.images, ['https://img.shop.test/p/2.png']);
  assert.equal(c.sku, 'AB102-002');
});

test('the brand sub-object never becomes the product name', () => {
  const r = extractProductsFromJson({ items: [1, 2, 3].map((i) => ({ brand: { name: 'BrandCo' }, price: 10 + i, url: `/p/item-${i}` })) }, BASE);
  assert.ok(r.cards.length >= 2);
  assert.ok(r.cards.every((c) => c.name !== 'BrandCo'));
});

test('a list of plain groups without products is not mistaken for a grid', () => {
  const r = extractProductsFromJson({ facets: [{ name: 'Size', items: [{ label: '40' }, { label: '41' }] }, { name: 'Colour', items: [{ label: 'Red' }] }] }, BASE);
  assert.equal(r.cards.length, 0);
});
