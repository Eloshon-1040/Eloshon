/**
 * XHR/GraphQL endpoint capture + replay (Stage C). Generic by construction: the
 * fixtures are NOT real sites; the same rules must serve any search/GraphQL API.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productsFromCaptures, nextPageRequest, isPaginatable, replayPaginate, enrichFromCaptures } from '../extract/xhr-endpoint.mjs';

const prod = (i) => ({ name: `Item ${i}`, sku: `S${i}`, price: 10 + i, url: `/product/item-${i}` });

test('productsFromCaptures: picks the response that yields products, ignores beacons/config', () => {
  const captures = [
    { url: 'https://s.test/analytics', status: 200, body: JSON.stringify({ event: 'view', ok: true }) },
    { url: 'https://s.test/config.json', status: 200, body: JSON.stringify({ theme: 'dark', locale: 'fr' }) },
    { url: 'https://api.s.test/search?page=0&hitsPerPage=3', status: 200, method: 'GET', body: JSON.stringify({ nbHits: 120, page: 0, hits: [prod(1), prod(2), prod(3)] }) },
    { url: 'https://s.test/reco', status: 200, body: JSON.stringify({ items: [prod(9)] }) }, // only 1 → not a grid
  ];
  const best = productsFromCaptures(captures, 'https://www.s.test/c/x');
  assert.ok(best);
  assert.equal(best.cards.length, 3);
  assert.equal(best.capture.url, 'https://api.s.test/search?page=0&hitsPerPage=3');
  assert.equal(best.pagination.totalResults, 120);
});

test('replay GET, page-index style: ?page=0 → page=1, page=2 …', () => {
  const cap = { url: 'https://api.s.test/search?page=0&hitsPerPage=24', method: 'GET' };
  assert.equal(new URL(nextPageRequest(cap, { iteration: 1 }).url).searchParams.get('page'), '1');
  assert.equal(new URL(nextPageRequest(cap, { iteration: 2 }).url).searchParams.get('page'), '2');
});

test('replay GET, offset style: ?offset=0&limit=24 → 24, 48 …', () => {
  const cap = { url: 'https://api.s.test/p?offset=0&limit=24', method: 'GET' };
  assert.equal(new URL(nextPageRequest(cap, { iteration: 1 }).url).searchParams.get('offset'), '24');
  assert.equal(new URL(nextPageRequest(cap, { iteration: 2 }).url).searchParams.get('offset'), '48');
});

test('replay GET, cursor style: uses the previous response cursor', () => {
  const cap = { url: 'https://api.s.test/p?after=AAA', method: 'GET' };
  const r = nextPageRequest(cap, { iteration: 1, cursor: 'BBB' });
  assert.equal(new URL(r.url).searchParams.get('after'), 'BBB');
  assert.equal(nextPageRequest(cap, { iteration: 1, cursor: null }), null, 'no cursor → cannot page');
});

test('replay POST GraphQL: increments variables.currentPage in the body, URL unchanged', () => {
  const cap = { url: 'https://s.test/graphql', method: 'POST', requestBody: JSON.stringify({ operationName: 'PLP', query: 'query PLP($p:Int){products(currentPage:$p){items{name}}}', variables: { currentPage: 1, pageSize: 24, categoryId: 'c1' } }) };
  const r = nextPageRequest(cap, { iteration: 1 });
  assert.equal(r.method, 'POST');
  assert.equal(r.url, 'https://s.test/graphql');
  const body = JSON.parse(r.body);
  assert.equal(body.variables.currentPage, 2);
  assert.equal(body.variables.categoryId, 'c1', 'other variables preserved');
  assert.equal(JSON.parse(nextPageRequest(cap, { iteration: 2 }).body).variables.currentPage, 3);
});

test('replay POST body, offset style with a size field', () => {
  const cap = { url: 'https://api.s.test/q', method: 'POST', requestBody: JSON.stringify({ query: 'shoes', from: 0, size: 20 }) };
  assert.equal(JSON.parse(nextPageRequest(cap, { iteration: 1 }).body).from, 20);
  assert.equal(JSON.parse(nextPageRequest(cap, { iteration: 2 }).body).from, 40);
});

test('replayPaginate: accumulates deduped products across pages, stops at the page cap', async () => {
  const first = productsFromCaptures([{ url: 'https://api.s.test/search?page=0&hitsPerPage=3', method: 'GET', body: JSON.stringify({ nbHits: 120, page: 0, hitsPerPage: 3, hits: [prod(1), prod(2), prod(3)] }) }], 'https://s.test/');
  const seenUrls = [];
  const fetchJson = async (url) => {
    seenUrls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    return { page, hits: [prod(page * 3 + 1), prod(page * 3 + 2), prod(page * 3 + 3)] };
  };
  const all = await replayPaginate({ capture: first.capture, firstCards: first.cards, firstPagination: first.pagination, baseUrl: 'https://s.test/', fetchJson, maxProducts: 1000, maxPages: 3 });
  assert.equal(all.length, 9, '3 pages × 3 = first + 2 replayed');
  assert.deepEqual(seenUrls.map((u) => new URL(u).searchParams.get('page')), ['1', '2']);
});

test('replayPaginate: stops early when a page brings no NEW products (site ignored the param)', async () => {
  const first = productsFromCaptures([{ url: 'https://api.s.test/p?offset=0&limit=3', method: 'GET', body: JSON.stringify({ results: [prod(1), prod(2), prod(3)] }) }], 'https://s.test/');
  let calls = 0;
  const fetchJson = async () => { calls++; return { results: [prod(1), prod(2), prod(3)] }; }; // same 3 every time
  const all = await replayPaginate({ capture: first.capture, firstCards: first.cards, firstPagination: first.pagination, baseUrl: 'https://s.test/', fetchJson, maxPages: 5 });
  assert.equal(all.length, 3, 'duplicates dropped, loop stopped');
  assert.equal(calls, 1, 'stopped after the first replayed page added nothing new');
});

test('replay Algolia: page lives in a URL-encoded params STRING nested in the JSON body', () => {
  // Algolia multi-query: requests[].params is "query=…&hitsPerPage=20&page=0".
  const cap = { url: 'https://APPID-dsn.algolia.net/1/indexes/*/queries', method: 'POST', headers: { 'x-algolia-api-key': 'SEARCHONLY', 'content-type': 'application/json' }, requestBody: JSON.stringify({ requests: [{ indexName: 'products', params: 'query=chaussures&hitsPerPage=20&page=0&facetFilters=%5B%22brand%3ANike%22%5D' }] }) };
  const r1 = nextPageRequest(cap, { iteration: 1 });
  assert.equal(r1.method, 'POST');
  assert.equal(r1.headers['x-algolia-api-key'], 'SEARCHONLY', 'search-only key carried on replay');
  const p1 = JSON.parse(r1.body).requests[0].params;
  assert.match(p1, /(^|&)page=1(&|$)/);
  assert.match(p1, /hitsPerPage=20/, 'other params preserved');
  assert.match(p1, /facetFilters=/, 'facet filters preserved');
  assert.match(JSON.parse(nextPageRequest(cap, { iteration: 2 }).body).requests[0].params, /(^|&)page=2(&|$)/);
});

test('replay encoded-params, offset style inside the body string', () => {
  const cap = { url: 'https://s.test/search', method: 'POST', requestBody: JSON.stringify({ q: 'query=jeans&offset=0&limit=24' }) };
  assert.match(JSON.parse(nextPageRequest(cap, { iteration: 1 }).body).q, /offset=24/);
  assert.match(JSON.parse(nextPageRequest(cap, { iteration: 2 }).body).q, /offset=48/);
});

test('enrichFromCaptures: fills a MISSING price from a separate pricing response — array of {id,price} (Leroy Merlin pattern)', () => {
  const products = [
    { name: 'Grillage A', sku: '92735466', price: null, strategy: 'embedded-state' },
    { name: 'Grillage B', sku: '92735467', price: null, strategy: 'embedded-state' },
  ];
  const captures = [
    { url: 'https://www.leroymerlin.fr/api/pricing', status: 200, body: JSON.stringify({ prices: [
      { productId: '92735466', price: { value: 24.9, currency: 'EUR' } },
      { productId: '92735467', sellingPriceTTC: '39,90 €' },
    ] }) },
  ];
  const out = enrichFromCaptures(products, captures, 'https://www.leroymerlin.fr/');
  assert.equal(out[0].price, 24.9);
  assert.equal(out[0].currency, 'EUR');
  assert.equal(out[1].price, 39.9);
});

test('enrichFromCaptures: fills price from an id-KEYED map { "SKU": {price} }', () => {
  const products = [{ name: 'X', sku: 'A1', price: null }, { name: 'Y', sku: 'A2', price: null }];
  const captures = [{ url: 'https://s/prices', body: JSON.stringify({ data: { A1: { grossPrice: 12.5, currencyCode: 'EUR' }, A2: { grossPrice: 9 } } }) }];
  const out = enrichFromCaptures(products, captures, 'https://s/');
  assert.equal(out[0].price, 12.5);
  assert.equal(out[1].price, 9);
});

test('enrichFromCaptures: leaves products with a price untouched; no match → unchanged', () => {
  const products = [{ name: 'A', sku: 'A1', price: 5 }, { name: 'B', sku: 'ZZ', price: null }];
  const out = enrichFromCaptures(products, [{ url: 'x', body: JSON.stringify({ prices: [{ productId: 'A1', price: 999 }] }) }], 'https://s/');
  assert.equal(out[0].price, 5, 'existing price never overwritten');
  assert.equal(out[1].price, null, 'no match for ZZ → still null (to verify)');
});

test('not paginatable: no page/offset/cursor anywhere → null', () => {
  assert.equal(nextPageRequest({ url: 'https://api.s.test/all', method: 'GET' }, { iteration: 1 }), null);
  assert.equal(isPaginatable({ url: 'https://api.s.test/all', method: 'GET' }), false);
  assert.equal(isPaginatable({ url: 'https://api.s.test/s?page=0', method: 'GET' }), true);
});
