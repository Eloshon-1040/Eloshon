/**
 * The embedded-state extractor now lives in shared/ (one source of truth for the
 * standard engine AND the "your browser" extension tier). These tests pin the
 * SHARED module directly on realistic SPA shapes, and prove the extension ships a
 * byte-identical vendored copy (so the two engines can never diverge). The full
 * behavioural coverage lives in core/__tests__/embedded-state.test.mjs + json-
 * products.test.mjs, which run against this code through the core re-export.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractEmbeddedProducts, extractProductsFromJson } from '../extract/embedded-state.mjs';

test('SPA listing (Next/Redux-style hydration): reads the product grid from the page HTML', () => {
  // The shape an unknown SPA catalogue exposes on its list page: a products[]
  // array in an embedded JSON blob, next to pagination. No site name, no recipe.
  const state = {
    props: { pageProps: { data: {
      products: [
        { name: 'Baskets Alpha', price: { value: 89.95, currencyIso: 'EUR' }, url: '/fr/baskets-alpha/ABC123.html', code: 'ABC123', images: [{ url: 'https://cdn.test/a.jpg' }] },
        { name: 'Baskets Beta', price: { value: 119.99, currencyIso: 'EUR' }, url: '/fr/baskets-beta/DEF456.html', code: 'DEF456', images: [{ url: 'https://cdn.test/b.jpg' }] },
        { name: 'Baskets Gamma', price: { value: 74.5, currencyIso: 'EUR' }, url: '/fr/baskets-gamma/GHI789.html', code: 'GHI789' },
      ],
      pagination: { currentPage: 0, totalPages: 5, totalResults: 120, pageSize: 24 },
    } } },
  };
  const html = `<!doctype html><html><head><title>Baskets Hommes</title></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(state)}</script></body></html>`;
  const { cards, pagination } = extractEmbeddedProducts(html, 'https://www.shop.test/fr/baskets-hommes');
  assert.equal(cards.length, 3);
  const a = cards[0];
  assert.equal(a.name, 'Baskets Alpha');
  assert.equal(a.price, 89.95);
  assert.equal(a.currency, 'EUR');
  assert.equal(a.sku, 'ABC123');
  assert.equal(a.sourceUrl, 'https://www.shop.test/fr/baskets-alpha/ABC123.html');
  assert.equal(a.images[0], 'https://cdn.test/a.jpg');
  assert.equal(a.strategy, 'embedded-state');
  assert.equal(pagination.totalResults, 120);
});

test('Levi\'s __LSCO_INITIAL_STATE__ (8th embedded-state form): products read from the named state global', () => {
  // Captured live from levi.com/BE: the product grid lives under the Levi Strauss
  // state global, not a bare top-level products[]. Generic: only the container
  // NAME is known; the array is found + mapped by shape like every other form.
  const lsco = { plp: { pageData: {
    products: [
      { code: 'A1234', name: '501® Original', url: '/BE/fr_BE/p/A1234', price: { value: 109.95, currencyIso: 'EUR', formattedValue: '109,95 €' }, galleryList: { galleryImage: [{ url: 'https://cdn.levi.com/a.jpg' }] } },
      { code: 'B5678', name: '511™ Slim', url: '/BE/fr_BE/p/B5678', price: { value: 99.95, currencyIso: 'EUR', formattedValue: '99,95 €' } },
      { code: 'C9012', name: '512™ Slim Taper', url: '/BE/fr_BE/p/C9012', price: { value: 89.95, currencyIso: 'EUR' } },
    ],
    pagination: { totalResults: 120, currentPage: 0, totalPages: 5, pageSize: 24 },
  } } };
  const html = `<!doctype html><html><head><title>Jeans Homme | Levi's BE</title></head><body><div id="app"></div><script>window.__LSCO_INITIAL_STATE__ = ${JSON.stringify(lsco)};</script></body></html>`;
  const { cards, pagination } = extractEmbeddedProducts(html, 'https://www.levi.com/BE/fr_BE/vetements/homme/jeans/c/levi_clothing_men_jeans');
  assert.equal(cards.length, 3);
  const a = cards[0];
  assert.equal(a.name, '501® Original');
  assert.equal(a.price, 109.95);
  assert.equal(a.currency, 'EUR');
  assert.equal(a.sku, 'A1234');
  assert.equal(a.sourceUrl, 'https://www.levi.com/BE/fr_BE/p/A1234');
  assert.equal(a.images[0], 'https://cdn.levi.com/a.jpg');
  assert.equal(pagination.totalResults, 120);
});

test('a __NEXT_DATA__ script blob is also mined via the state-global path (same result as the marker scan)', () => {
  const data = { props: { pageProps: { products: [ { name: 'X', sku: 'X1', price: 9.9, url: '/product/x-1' }, { name: 'Y', sku: 'Y1', price: 5, url: '/product/y-1' } ] } } };
  const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
  assert.equal(extractEmbeddedProducts(html, 'https://s.test/c/x').cards.length, 2);
});

// ── NAME-AGNOSTIC embedded-JSON scan: the site's state container / array key are
// UNKNOWN to us, yet the grid is still read by shape. This is the generalization
// that stops the "one new name per site" trap. ──────────────────────────────────
test('unknown global NAME + unknown array KEY: products still read by shape', () => {
  // A container we have never seen ("__ACME_BOOT_42"), products under an arbitrary
  // key ("catalogEntries") — nothing here is in any known-name list.
  const state = { region: 'be', data: { grid: { catalogEntries: [
    { title: 'Sneaker One', priceData: { prices: [{ type: 'sale', value: 59.99 }] }, url: '/product/one-1', code: 'ONE1' },
    { title: 'Sneaker Two', priceData: { prices: [{ type: 'original', value: 79.99 }] }, url: '/product/two-2', code: 'TWO2' },
    { title: 'Sneaker Three', priceData: { prices: [{ type: 'original', value: 49.99 }] }, url: '/product/three-3', code: 'THREE3' },
  ] } } };
  const html = `<html><body><div id="root"></div><script>window.__ACME_BOOT_42 = ${JSON.stringify(state)};window.other=1;</script></body></html>`;
  const { cards } = extractEmbeddedProducts(html, 'https://shop.test/c/sneakers');
  assert.equal(cards.length, 3);
  assert.equal(cards[0].name, 'Sneaker One');
  assert.equal(cards[0].price, 59.99);
  assert.equal(cards[0].sku, 'ONE1');
});

test('arbitrary JSON island id + JSON.parse("…") SSR state are both mined by shape', () => {
  const island = { page: { tiles: [ { name: 'A', sku: 'A1', price: 3.2, url: '/product/a-1' }, { name: 'B', sku: 'B1', price: 4.1, url: '/product/b-1' } ] } };
  const htmlIsland = `<html><body><script id="totally-custom-state" type="application/json">${JSON.stringify(island)}</script></body></html>`;
  assert.equal(extractEmbeddedProducts(htmlIsland, 'https://s.test/c/x').cards.length, 2);

  const inner = { results: [ { name: 'C', sku: 'C1', price: 5, url: '/product/c-1' }, { name: 'D', sku: 'D1', price: 6, url: '/product/d-1' } ] };
  const htmlParse = `<html><body><script>self.__APP = JSON.parse(${JSON.stringify(JSON.stringify(inner))});</script></body></html>`;
  assert.equal(extractEmbeddedProducts(htmlParse, 'https://s.test/c/x').cards.length, 2);
});

// ── Modern headless-storefront shapes (per the 2026 extraction research): Apollo/
// urql normalized cache, Next.js App-Router Flight rows, double-encoded JSON. ──────
test('Apollo/urql normalized cache: product entities keyed by Typename:id are collected', () => {
  const cache = {
    ROOT_QUERY: { 'search({"q":"x"})': { __typename: 'SearchResult', items: [{ __ref: 'Product:1' }, { __ref: 'Product:2' }, { __ref: 'Product:3' }] } },
    'Product:1': { __typename: 'Product', name: 'Alpha', sku: 'A1', price: 19.99, url: '/product/alpha-1' },
    'Product:2': { __typename: 'Product', name: 'Beta', sku: 'B1', price: 29.99, url: '/product/beta-2' },
    'Product:3': { __typename: 'Product', name: 'Gamma', sku: 'G1', price: 39.99, url: '/product/gamma-3' },
    'Category:9': { __typename: 'Category', name: 'Shoes' },
  };
  const html = `<html><body><script>window.__APOLLO_STATE__ = ${JSON.stringify(cache)};</script></body></html>`;
  const { cards } = extractEmbeddedProducts(html, 'https://shop.test/c/x');
  assert.equal(cards.length, 3, 'three Product:* entities, the Category is dropped');
  assert.ok(cards.some((c) => c.name === 'Alpha' && c.price === 19.99));
});

test('Next.js App-Router Flight rows (self.__next_f.push) are decoded and mined by shape', () => {
  const rowData = { items: [ { name: 'Flight A', sku: 'FA', price: 12.5, url: '/product/fa-1' }, { name: 'Flight B', sku: 'FB', price: 14.5, url: '/product/fb-2' } ] };
  const row = JSON.stringify('2:' + JSON.stringify(rowData)); // "2:{...}" as a JS string literal
  const html = `<html><body><script>self.__next_f=self.__next_f||[];self.__next_f.push([1,"1:HL"]);self.__next_f.push([1,${row}]);</script></body></html>`;
  const { cards } = extractEmbeddedProducts(html, 'https://shop.test/c/x');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].name, 'Flight A');
});

test('double-encoded JSON string assignment (window.X = "{…}") is read', () => {
  const inner = { products: [ { name: 'S1', sku: 'S1', price: 7, url: '/product/s-1' }, { name: 'S2', sku: 'S2', price: 8, url: '/product/s-2' } ] };
  const html = `<html><body><script>window.__STATE__ = ${JSON.stringify(JSON.stringify(inner))};</script></body></html>`;
  assert.equal(extractEmbeddedProducts(html, 'https://shop.test/c/x').cards.length, 2);
});

test('generic field-fill: a product with an UNUSUAL/multilingual price/url/image key is COMPLETE (the Leroy Merlin pattern)', () => {
  // The keyed mapper does not list these keys; the broad multilingual scanners fill
  // them so the product is accepted, not "to verify" — no per-site rule.
  const p = (i) => ({ sku: `R${i}`, name: `Produit ${i}`, montantTTC: `${19 + i},90 €`, productPageUrl: `/produits/peinture/prod-${i}`, visualUrl: `https://media.adeo.com/i${i}.jpg` });
  const html = `<html><body><script>window.__DATA={"products":${JSON.stringify([p(1), p(2), p(3)])}}</script></body></html>`;
  const { cards } = extractEmbeddedProducts(html, 'https://www.leroymerlin.fr/produits/peinture-droguerie/peinture-interieure/');
  assert.equal(cards.length, 3);
  const c = cards[0];
  assert.equal(c.price, 20.9, 'price filled from the unlisted "montantTTC" key');
  assert.equal(c.sku, 'R1');
  assert.equal(c.sourceUrl, 'https://www.leroymerlin.fr/produits/peinture/prod-1', 'url filled from "productPageUrl"');
  assert.equal(c.images[0], 'https://media.adeo.com/i1.jpg', 'image filled from "visualUrl"');
});

test('never locks onto a non-product array: a menu / facet list yields 0', () => {
  const html = `<script>window.__DATA__=${JSON.stringify({ items: [{ name: 'Homme' }, { name: 'Femme' }, { name: 'Enfant' }] })}</script>`;
  assert.equal(extractEmbeddedProducts(html, 'https://shop.test/fr').cards.length, 0);
});

test('never locks onto a FONT-FAMILY array: {id,name} objects with no price/url/image yield 0 (hydrozone Adobe Typekit)', () => {
  // Typekit injects the loaded font families as {id, name:"Archivo"} objects. They
  // have a name (so the nameless guard passes) but no price, url or image — not
  // products. A lone name+id must never be mistaken for a product grid.
  const fonts = { fontVariations: [
    { id: 'archivo', name: 'Archivo' }, { id: 'archivo-cond', name: 'Archivo Condensed' },
    { id: 'anton', name: 'Anton' }, { id: 'archivo-exp', name: 'Archivo Expanded' },
  ] };
  const html = `<script>window.Typekit=${JSON.stringify(fonts)}</script>`;
  assert.equal(extractEmbeddedProducts(html, 'https://www.hydrozone.fr/235-engrais').cards.length, 0);
});

test('never emits a NAMELESS + PRICELESS record: an id+asset-url array (hydrozone typekit) yields 0', () => {
  // The junk hydrozone locked onto: objects with an id (→ sku) and a font-CDN url,
  // but no name and no price. An id alone must not mint a product.
  const junk = { fonts: [
    { id: 1913751, url: 'https://use.typekit.net/txm8akw' },
    { id: 1913752, url: 'https://use.typekit.net/abc9def' },
    { id: 1913753, url: 'https://use.typekit.net/ghi0jkl' },
  ] };
  const html = `<script>window.__STATE__=${JSON.stringify(junk)}</script>`;
  assert.equal(extractEmbeddedProducts(html, 'https://www.hydrozone.fr/235-engrais').cards.length, 0);
});

test('wrapper shapes: JSON-LD ItemList entries and GraphQL relay edges are unwrapped generically', () => {
  // JSON-LD ItemList on a listing page (script type=application/ld+json island).
  const ld = { '@type': 'ItemList', itemListElement: [
    { '@type': 'ListItem', position: 1, item: { '@type': 'Product', name: 'P1', sku: 'S1', offers: { price: 19.99, priceCurrency: 'EUR' }, url: 'https://s.test/product/p-1' } },
    { '@type': 'ListItem', position: 2, item: { '@type': 'Product', name: 'P2', sku: 'S2', offers: { price: 29.99, priceCurrency: 'EUR' }, url: 'https://s.test/product/p-2' } },
  ] };
  const html = `<html><body><script type="application/ld+json">${JSON.stringify(ld)}</script></body></html>`;
  const { cards } = extractEmbeddedProducts(html, 'https://s.test/c/x');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].name, 'P1');
  assert.equal(cards[0].price, 19.99, 'JSON-LD offers.price is read');
  assert.equal(cards[0].currency, 'EUR');
  // GraphQL relay edges { node: {...} }.
  const gql = { data: { search: { edges: [
    { node: { name: 'G1', sku: 'G1', price: 5, url: '/product/g-1' } },
    { node: { name: 'G2', sku: 'G2', price: 6, url: '/product/g-2' } },
  ] } } };
  assert.equal(extractProductsFromJson(gql, 'https://s.test/').cards.length, 2);
});

test('extractProductsFromJson: reads a product array out of any parsed XHR/JSON value', () => {
  const api = { data: { results: [ { name: 'X', sku: 'X1', price: 3.2 }, { name: 'Y', sku: 'Y1', price: 4.1 } ], meta: { total: 2 } } };
  const { cards } = extractProductsFromJson(api, 'https://shop.test/');
  assert.equal(cards.length, 2);
});

// ── Generic price resolution across platform shapes (regression for the Adidas
// "price null" bug: the grid extracted but every price was null). The price can
// live under many keys; the resolver must read a reasonably broad, controlled set
// without ever leaking a non-price number. ─────────────────────────────────────
const priceOf = (product) => {
  const html = `<script>window.__S={"products":[${JSON.stringify(product)},${JSON.stringify({ ...product, url: '/product/second-2' })}]}</script>`;
  return extractEmbeddedProducts(html, 'https://shop.test/fr/liste').cards[0];
};

test('price shapes: flat number, incl-tax, and Hybris/Levi value/formatted objects', () => {
  assert.equal(priceOf({ name: 'A', url: '/product/a-1', price: 49 }).price, 49);
  assert.equal(priceOf({ name: 'B', url: '/product/b-1', priceInclTax: 89 }).price, 89);
  assert.equal(priceOf({ name: 'C', url: '/product/c-1', price: { value: 109.95, currencyIso: 'EUR' } }).price, 109.95);
  const d = priceOf({ name: 'D', url: '/product/d-1', price: { formattedValue: '99,95 €', currencyIso: 'EUR' } });
  assert.equal(d.price, 99.95); assert.equal(d.currency, 'EUR');
});

test('price shapes: a priceInformation / priceData container with a currentPrice sub-key + separate currency', () => {
  // Adidas-plausible SPA shape: neither a top-level numeric `price` nor a
  // pickPrice-readable object — the price sits under a named sub-key of a container.
  const a = priceOf({ name: 'Samba', url: '/product/samba-1', priceInformation: { currentPrice: 119.99, standardPrice: 119.99, currencyCode: 'EUR' } });
  assert.equal(a.price, 119.99); assert.equal(a.currency, 'EUR');
  const b = priceOf({ name: 'Gazelle', url: '/product/gazelle-1', priceData: { price: 100, salePrice: 69.99, currency: 'EUR' } });
  assert.equal(b.price, 69.99, 'the sale price wins over the base price'); assert.equal(b.currency, 'EUR');
});

test('price shapes: bare currentPrice / salePrice keys with a sibling currency', () => {
  const a = priceOf({ name: 'X', url: '/product/x-1', currentPrice: 74.5, currency: 'EUR' });
  assert.equal(a.price, 74.5); assert.equal(a.currency, 'EUR');
  const b = priceOf({ name: 'Y', url: '/product/y-1', salePrice: 24.99, listPrice: 49.99, currencyCode: 'USD' });
  assert.equal(b.price, 24.99, 'sale beats list'); assert.equal(b.currency, 'USD');
});

test('price shapes: falls back to the regular/list price when there is no sale price', () => {
  assert.equal(priceOf({ name: 'Z', url: '/product/z-1', listPrice: 39.9, currency: 'EUR' }).price, 39.9);
  assert.equal(priceOf({ name: 'W', url: '/product/w-1', pricing: { was: 59, now: 42 } }).price, 42);
});

test('price shapes: JSON-LD AggregateOffer with a BARE-numeric lowPrice string (real Leroy Merlin PLP shape)', () => {
  // The jsonld_PLP ItemList each site ships: the price is a plain numeric STRING
  // inside an AggregateOffer ("lowPrice":"37.9") with no currency symbol. parseMoney
  // rejects a currency-less string, so this used to yield price:null even though the
  // product (sku/name/image) extracted fine. The key says "price", so the amount is
  // parsed directly and the currency comes from priceCurrency. Generic schema.org.
  const a = priceOf({ '@type': 'Product', name: 'Grillage', sku: '92735466', image: 'https://m/1.jpg', offers: { priceCurrency: 'EUR', lowPrice: '37.9', '@type': 'AggregateOffer' } });
  assert.equal(a.price, 37.9); assert.equal(a.currency, 'EUR');
  const b = priceOf({ '@type': 'Product', name: 'Autre', sku: 'X2', image: 'https://m/2.jpg', offers: { priceCurrency: 'USD', price: '1,299.00', '@type': 'Offer' } });
  assert.equal(b.price, 1299); assert.equal(b.currency, 'USD');
});

test('price shapes: Adidas priceData.prices[] array (real live shape) → the price is read', () => {
  // Captured live from adidas.be/fr/baskets-hommes: the price is an ARRAY of
  // {type, value} entries under priceData.prices — the shape that made every price
  // null before this fix.
  const adidas = {
    id: 'IF6490', title: 'Chaussure Handball Spezial',
    url: 'https://www.adidas.be/fr/chaussure-handball-spezial/IF6490.html',
    image: 'https://assets.adidas.com/x.jpg',
    priceData: { prices: [{ type: 'original', value: 110, valueNoVat: 90.91 }], isSoldOut: false },
  };
  const c = priceOf(adidas);
  assert.equal(c.price, 110);
  assert.equal(c.sku, 'IF6490');
  assert.equal(c.name, 'Chaussure Handball Spezial');
});

test('price shapes: a prices[] array with a sale entry → the sale price wins over the original', () => {
  const c = priceOf({ name: 'Promo', url: '/product/promo-1', priceData: { prices: [{ type: 'original', value: 110 }, { type: 'sale', value: 79.99 }] } });
  assert.equal(c.price, 79.99);
  // With no sale tag, the lowest of the array is the one actually charged.
  const d = priceOf({ name: 'TwoNumbers', url: '/product/two-1', prices: [{ value: 60 }, { value: 42 }] });
  assert.equal(d.price, 42);
});

test('price shapes: a non-price number (rating, quantity, priceRange) is never mistaken for a price', () => {
  // Only a product URL gives the signal; rating/stock/priceRange must NOT become a price.
  const c = priceOf({ name: 'NoPrice', url: '/product/np-1', rating: 4.7, reviewCount: 220, stock: 12, priceRange: { min: 10, max: 20 } });
  assert.equal(c.price, undefined, 'no scalar price key → price stays absent');
});

test('the extension ships a byte-identical vendored copy of the shared extractor', () => {
  const a = fs.readFileSync(new URL('../extract/embedded-state.mjs', import.meta.url), 'utf8');
  const b = fs.readFileSync(new URL('../../extension/vendor/shared/extract/embedded-state.mjs', import.meta.url), 'utf8');
  assert.equal(a, b);
});

test('the extension ships a byte-identical vendored copy of the empty-diagnosis module', () => {
  const a = fs.readFileSync(new URL('../classify/empty-diagnosis.mjs', import.meta.url), 'utf8');
  const b = fs.readFileSync(new URL('../../extension/vendor/shared/classify/empty-diagnosis.mjs', import.meta.url), 'utf8');
  assert.equal(a, b);
});
