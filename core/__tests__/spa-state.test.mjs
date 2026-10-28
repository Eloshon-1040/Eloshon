/**
 * Generic SPA-state extractor (v0.5.6) — offline. One test per recognized embedded
 * -state pattern (Next.js/Nuxt/Redux/Apollo), the nested-field digging that unlocked
 * Nike's shape, and the markdown fallback. Genericity: the matcher keys on the SHAPE
 * (array of objects with a name-ish + price-ish field), never on a domain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSpaProducts, extractMarkdownProducts, digPrice } from '../spa-state.mjs';

const wrapNext = (obj) => `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(obj)}</script></body></html>`;
const wrapVar = (name, obj) => `<html><body><script>window.${name}=${JSON.stringify(obj)};</script></body></html>`;

test('__NEXT_DATA__ (Next.js) — nested fields (copy.title / prices.currentPrice / pdpUrl.url) — the Nike shape', () => {
  const html = wrapNext({ props: { pageProps: { initialState: { Wall: { productGroupings: [
    { cardType: 'card', products: [
      { copy: { title: 'Nike Pegasus Premium', subTitle: "Men's" }, prices: { currency: 'USD', currentPrice: 220 }, pdpUrl: { url: 'https://www.nike.com/t/pegasus/HQ2592-023' }, productCode: 'HQ2592-023', colorwayImages: { portraitURL: 'https://static.nike.com/a/img.png' } },
      { copy: { title: 'Nike Vomero 18' }, prices: { currentPrice: 165 }, pdpUrl: { url: 'https://www.nike.com/t/vomero/IQ0458' }, productCode: 'IQ0458-001' },
      { copy: { title: 'Air Force 1' }, prices: { currentPrice: 115 }, pdpUrl: { url: 'https://www.nike.com/t/af1/FJ4146' }, productCode: 'FJ4146-126' },
    ] },
  ] } } } } });
  const { products, pattern } = extractSpaProducts(html, 'https://www.nike.com/w/mens-shoes');
  assert.equal(pattern, '__NEXT_DATA__');
  assert.equal(products.length, 3);
  assert.equal(products[0].name, 'Nike Pegasus Premium');
  assert.equal(products[0].price, 220);
  assert.equal(products[0].sourceUrl, 'https://www.nike.com/t/pegasus/HQ2592-023');
  assert.equal(products[0].sku, 'HQ2592-023');
  assert.deepEqual(products[0].images, ['https://static.nike.com/a/img.png']);
});

test('__NUXT__ (Nuxt) — array of flat product objects', () => {
  const html = wrapVar('__NUXT__', { data: [{ list: [
    { name: 'Café Moulu', price: 3.49, url: '/p/cafe-1', image: '/img/1.jpg' },
    { name: 'Thé Vert', price: 2.99, url: '/p/the-2', image: '/img/2.jpg' },
    { name: 'Chocolat', price: 4.5, url: '/p/choc-3', image: '/img/3.jpg' },
  ] }] });
  const { products, pattern } = extractSpaProducts(html, 'https://shop.example/fr');
  assert.equal(pattern, '__NUXT__');
  assert.equal(products.length, 3);
  assert.equal(products[1].name, 'Thé Vert');
  assert.equal(products[1].price, 2.99);
  assert.equal(products[1].sourceUrl, 'https://shop.example/p/the-2'); // relative → absolute
});

test('__INITIAL_STATE__ (Redux) — price as a formatted string is parsed', () => {
  const html = wrapVar('__INITIAL_STATE__', { catalog: { items: [
    { title: 'Widget A', price: '€ 12,95', link: '/a' },
    { title: 'Widget B', price: '€ 9,50', link: '/b' },
    { title: 'Widget C', price: '€ 21,00', link: '/c' },
  ] } });
  const { products, pattern } = extractSpaProducts(html, 'https://x.io');
  assert.equal(pattern, '__INITIAL_STATE__');
  assert.equal(products.length, 3);
  assert.equal(products[0].price, 12.95);
});

test('__APOLLO_STATE__ (Apollo cache) — product-shaped entries recovered', () => {
  const html = wrapVar('__APOLLO_STATE__', { ROOT: { list: [
    { displayName: 'Sneaker X', pricing: { amount: 89.99 }, canonicalUrl: 'https://x.io/p/x' },
    { displayName: 'Sneaker Y', pricing: { amount: 74.0 }, canonicalUrl: 'https://x.io/p/y' },
    { displayName: 'Sneaker Z', pricing: { amount: 99.0 }, canonicalUrl: 'https://x.io/p/z' },
  ] } });
  const { products, pattern } = extractSpaProducts(html, 'https://x.io');
  assert.equal(pattern, '__APOLLO_STATE__');
  assert.equal(products.length, 3);
  assert.equal(products[2].name, 'Sneaker Z');
  assert.equal(products[2].price, 99);
});

test('no state pattern → empty (caller falls back to markdown)', () => {
  const { products, pattern } = extractSpaProducts('<html><body><div>no data here</div></body></html>', 'https://x');
  assert.equal(products.length, 0);
  assert.equal(pattern, null);
});

test('markdown fallback — [name](url) followed by a nearby price token', () => {
  const md = [
    '## Results',
    '[Air Zoom Pegasus](https://nike.com/t/air-zoom/AB1)', 'Just In', "Men's Road Running Shoes", '$155',
    '[Vomero 18](https://nike.com/t/vomero/CD2)', '$220',
    '[Learn more.](https://nike.com/help)', 'Free delivery over $40',
    '[Not A Product](https://nike.com/help)', 'no price within range', '', '', '', '', '', '', '', 'far $999',
  ].join('\n');
  const { products } = extractMarkdownProducts(md, 'https://nike.com');
  assert.equal(products.length, 2);              // CTA "Learn more" + price-less "Not A Product" excluded
  assert.equal(products[0].name, 'Air Zoom Pegasus');
  assert.equal(products[0].price, 155);
  assert.equal(products[0].sourceUrl, 'https://nike.com/t/air-zoom/AB1');
  assert.equal(products[1].price, 220);
});

test('markdown fallback — nested image-link products (the PS Direct shape)', () => {
  // Real listing markdown wraps a product image in a product link: [![alt](img)](url).
  // The alt is the name (strip the leading ![), the image URL is skipped, the price
  // sits on a following line.
  const md = [
    "[![Marvel’s Wolverine - PS5](https://media.x/is/image/abc)](https://x/product/UP9000-1)", '$69.99',
    "[![Ghost of Yotei - PS5](https://media.x/is/image/def)](https://x/product/UP9000-2)", '$69.99',
  ].join('\n');
  const { products, pattern } = extractMarkdownProducts(md, 'https://direct.playstation.com');
  assert.equal(pattern, 'markdown');
  assert.equal(products.length, 2);
  assert.equal(products[0].name, 'Marvel’s Wolverine - PS5'); // no leading ![ or [
  assert.equal(products[0].price, 69.99);
  assert.equal(products[0].sourceUrl, 'https://x/product/UP9000-1'); // product url, not the image
});

test('digPrice: numbers, strings, and nested price objects', () => {
  assert.equal(digPrice(19.9), 19.9);
  assert.equal(digPrice('$155'), 155);
  assert.equal(digPrice('1 299,00 €'), 1299);
  assert.equal(digPrice({ currentPrice: 42 }), 42);
  assert.equal(digPrice({ amount: { value: 7.5 } }), 7.5);
  assert.equal(digPrice({ nope: 'x' }), null);
});

test('markdown fallback — a filter line with "0 €" nearby is not a product', () => {
  const md = ['[Big & Tall(7)](https://shop.test/c/jeans/facets/size/big)', '0,00 €', '[501 Original](https://shop.test/p/501)', '109,95 €'].join('\n');
  const { products } = extractMarkdownProducts(md, 'https://shop.test');
  assert.deepEqual(products.map((p) => p.name), ['501 Original']);
});
