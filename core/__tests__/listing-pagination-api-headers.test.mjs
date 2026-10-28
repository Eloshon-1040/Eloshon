/**
 * paginateListing + API headers (chantier B1): when the first internal-API request is
 * refused (400 / 401 / 403), the injected `discoverApiHeaders` runs once; a header it
 * finds is sent on the retry and on every next page, and its specs travel in the memo
 * (`api_headers`) so the next run re-reads them through `resolveApiHeaders` before the
 * first request. Nothing is stored when the found header does not open the API. A 404
 * (dead URL, not a refusal) and an old memo without specs behave exactly as before.
 * Hand-built pages, fake fetchers — no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginateListing } from '../listing-pagination.mjs';

const BASE = 'https://shop.test/c/shoes';
const card = (i) => `<div class="pc"><a class="t" href="/p/item-${i}">Item ${i}</a><span class="pr">${i},00 €</span></div>`;
const extractCards = (html, url) => [...String(html).matchAll(/href="\/p\/item-(\d+)">Item \d+<\/a><span class="pr">([\d,]+)/g)].map((m) => ({ name: `Item ${m[1]}`, price: Number(m[2].replace(',', '.')), sourceUrl: new URL(`/p/item-${m[1]}`, url).toString() }));
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const API_PAGE = (ids, next, total) => ({ data: { products: ids.map((i) => ({ name: `Item ${i}`, price: 10 + i, url: `https://shop.test/p/item-${i}` })), pages: { next, totalResources: total } } });
const jsonCards = (json) => ((json && json.data && json.data.products) || []).map((p) => ({ name: p.name, price: p.price, sourceUrl: p.url }));
const stateHtml = (ids, next, total) => `<html><head><link rel="dns-prefetch" href="https://api.shop.test"><script src="https://static.shop.test/js/wall.js"></script></head><body>${ids.map(card).join('')}<script id="__STATE__" type="application/json">${JSON.stringify({ wall: { pageData: { next, prev: '', totalResources: total } } })}</script></body></html>`;
const HEADERS = { 'shop-api-caller-id': 'com.shop.web' };
const SPECS = { 'shop-api-caller-id': { from: 'https://static.shop.test/js/wall.js', pattern: '["\']shop-api-caller-id["\']\\s*:\\s*["\']([^"\']+)["\']', flags: 'i' } };

/** An API that answers only with the caller-id header: 400 without it, pages with it. */
function apiFetcher() {
  const calls = [];
  const api = {
    'https://api.shop.test/listing/v1?anchor=3&count=3': API_PAGE(range(4, 6), '/listing/v1?anchor=6&count=3', 8),
    'https://api.shop.test/listing/v1?anchor=6&count=3': API_PAGE(range(7, 8), null, 8),
  };
  const fetchJson = async (u, headers) => {
    calls.push({ u, headers: headers || null });
    if (!u.startsWith('https://api.')) return { ok: false, status: 404, json: { errors: [{ code: 310 }] } };
    if (!headers || headers['shop-api-caller-id'] !== 'com.shop.web') return { ok: false, status: 400, json: { errors: [{ code: 'CALLER_ID_HEADER_NOT_PRESENT', message: 'Request header must be present' }] } };
    return api[u] ? { ok: true, json: api[u], status: 200 } : { ok: false, status: 404 };
  };
  return { calls, fetchJson };
}
const run = (first, o) => paginateListing({ entryUrl: BASE, firstHtml: first, firstCards: extractCards(first, BASE), extractCards, fetchHtml: async () => ({ ok: false, status: 404 }), extractJsonCards: jsonCards, maxProducts: 100, maxPages: 50, ...o });

test('refused → discovery → retried with the found header → every page read; the memo carries the specs', async () => {
  const first = stateHtml(range(1, 3), '/listing/v1?anchor=3&count=3', 8);
  const f = apiFetcher();
  const seen = [];
  const discoverApiHeaders = async (args) => { seen.push(args); return { found: true, headers: HEADERS, specs: SPECS, summary: { found: true, names: ['shop-api-caller-id'], filesListed: 1, filesRead: 1 } }; };
  const r = await run(first, { fetchJson: f.fetchJson, discoverApiHeaders });
  assert.equal(r.stoppedBy, 'total_reached'); assert.equal(r.cards.length, 8); assert.deepEqual(r.warnings, []);
  assert.equal(seen.length, 1, 'discovery runs once');
  assert.equal(seen[0].apiUrl, 'https://api.shop.test/listing/v1?anchor=3&count=3'); assert.equal(seen[0].pageUrl, BASE); assert.equal(seen[0].status, 400); assert.equal(seen[0].errorText, 'CALLER_ID_HEADER_NOT_PRESENT');
  assert.ok(seen[0].html.includes('wall.js'), 'the page html is handed over (its scripts)');
  const apiCalls = f.calls.filter((c) => c.u.startsWith('https://api.'));
  assert.deepEqual(apiCalls.map((c) => !!c.headers), [false, true, true], 'plain request refused, then the retry and the next page carry the header');
  assert.deepEqual(r.memo, { mode: 'api-next', api_host: 'https://api.shop.test', api_headers: SPECS });
  assert.deepEqual(r.apiHeaders, { source: 'public-js', found: true, names: ['shop-api-caller-id'], filesListed: 1, filesRead: 1, retried: true, accepted: true });
  assert.equal(JSON.stringify(r.apiHeaders).includes('com.shop.web'), false, 'no value in the report');
});

test('found header that the API still refuses → nothing stored, the refusal is reported as before', async () => {
  const first = stateHtml(range(1, 3), '/listing/v1?anchor=3&count=3', 120);
  const f = apiFetcher();
  const r = await run(first, { fetchJson: f.fetchJson, discoverApiHeaders: async () => ({ found: true, headers: { 'shop-api-caller-id': 'wrong' }, specs: SPECS }) });
  assert.equal(r.stoppedBy, 'api_refused');
  assert.deepEqual(r.warnings.sort(), ['api_refused', 'scroll_not_followable', 'total_not_reached']);
  assert.equal(r.memo, null, 'no host worked, so no memo at all');
  assert.equal(r.apiHeaders.retried, true); assert.equal(r.apiHeaders.accepted, false);
  assert.equal(f.calls.filter((c) => c.u.startsWith('https://api.')).length, 2, 'one plain request, one retry — then stop');
});

test('nothing found → exactly the old refusal (warnings, detail); discovery is not retried', async () => {
  const first = stateHtml(range(1, 3), '/listing/v1?anchor=3&count=3', 120);
  const f = apiFetcher(); let n = 0;
  const r = await run(first, { fetchJson: f.fetchJson, discoverApiHeaders: async () => { n++; return { found: false, headers: {}, specs: {}, summary: { found: false, names: [], filesListed: 3, filesRead: 3, rejected: ['x-trace:hex_digest'] } }; } });
  assert.equal(n, 1);
  assert.equal(r.stoppedBy, 'api_refused'); assert.equal(r.cards.length, 3);
  assert.deepEqual(r.detail, { status: 400, error: 'CALLER_ID_HEADER_NOT_PRESENT' });
  assert.deepEqual(r.apiHeaders, { source: 'public-js', found: false, names: [], filesListed: 3, filesRead: 3, rejected: ['x-trace:hex_digest'] });
});

test('a 404 is a dead URL, not a refusal: discovery does not run; without discoverApiHeaders nothing changes', async () => {
  const first = stateHtml(range(1, 3), '/listing/v1?anchor=3&count=3', 120);
  let n = 0;
  const r = await run(first, { fetchJson: async () => ({ ok: false, status: 404, json: { errors: [{ code: 310 }] } }), discoverApiHeaders: async () => { n++; return { found: true, headers: HEADERS, specs: SPECS }; } });
  assert.equal(n, 0); assert.equal(r.stoppedBy, 'api_refused'); assert.equal(r.apiHeaders, null);
  const f = apiFetcher();
  const r2 = await run(first, { fetchJson: f.fetchJson });
  assert.equal(r2.stoppedBy, 'api_refused'); assert.equal(r2.apiHeaders, null); assert.deepEqual(r2.detail, { status: 400, error: 'CALLER_ID_HEADER_NOT_PRESENT' });
});

test('old recipe: a memo with api_headers resolves them FIRST (no refusal, no discovery); a memo without specs works as before', async () => {
  const first = stateHtml(range(1, 3), '/listing/v1?anchor=3&count=3', 8);
  const f = apiFetcher(); let discovered = 0; const resolved = [];
  const r = await run(first, {
    fetchJson: f.fetchJson, memo: { mode: 'api-next', api_host: 'https://api.shop.test', api_headers: SPECS },
    resolveApiHeaders: async (specs) => { resolved.push(specs); return { headers: HEADERS }; },
    discoverApiHeaders: async () => { discovered++; return { found: false, headers: {}, specs: {} }; },
  });
  assert.deepEqual(resolved, [SPECS]); assert.equal(discovered, 0);
  assert.equal(r.cards.length, 8); assert.equal(r.stoppedBy, 'total_reached');
  assert.ok(f.calls.filter((c) => c.u.startsWith('https://api.')).every((c) => c.headers && c.headers['shop-api-caller-id']), 'every API request carried the header from the first one');
  assert.deepEqual(r.memo, { mode: 'api-next', api_host: 'https://api.shop.test', api_headers: SPECS });
  assert.deepEqual(r.apiHeaders, { source: 'recipe', found: true, names: ['shop-api-caller-id'] });
  // Specs that no longer resolve (the file moved): the refusal triggers the discovery again.
  const f2 = apiFetcher(); let d2 = 0;
  const r2 = await run(first, { fetchJson: f2.fetchJson, memo: { mode: 'api-next', api_host: 'https://api.shop.test', api_headers: SPECS }, resolveApiHeaders: async () => ({ headers: null, error: 'header shop-api-caller-id: source https://static.shop.test/js/wall.js → 404' }), discoverApiHeaders: async () => { d2++; return { found: true, headers: HEADERS, specs: { 'shop-api-caller-id': { ...SPECS['shop-api-caller-id'], from: 'https://static.shop.test/js/wall-v2.js' } } }; } });
  assert.equal(d2, 1); assert.equal(r2.cards.length, 8);
  assert.equal(r2.memo.api_headers['shop-api-caller-id'].from, 'https://static.shop.test/js/wall-v2.js', 'the memo now points at the new file');
  // An old memo (no specs): unchanged behaviour.
  const f3 = apiFetcher();
  const r3 = await run(first, { fetchJson: f3.fetchJson, memo: { mode: 'api-next', api_host: 'https://api.shop.test' } });
  assert.equal(r3.stoppedBy, 'api_refused'); assert.equal(r3.cards.length, 3);
});
