/**
 * Internal-API replay (2b) — pure, offline. A fake httpGet serves canned pages so
 * pagination, dynamic-header resolution and field mapping are tested without a net.
 * Also covers the domain-profile internal_api lifecycle (store == column, demotion).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPath, fillTemplate, mapItem, resolveHeaders, replayInternalApi } from '../internal-api.mjs';
import { mergeProfile, profileHints, recordInternalApiOutcome, internalApiUsable, internalApiStale, INTERNAL_API_MAX_FAILS,
  manualSelectorsUsable, recordManualSelectorsOutcome, MANUAL_SELECTORS_MAX_FAILS } from '../domain-profile.mjs';

test('getPath / fillTemplate / mapItem', () => {
  assert.equal(getPath({ a: { b: 2 } }, 'a.b'), 2);
  assert.equal(getPath({ a: null }, 'a.b'), undefined);
  assert.equal(fillTemplate('x?s={size}&k={skip}&c={cat}', { size: 22, skip: 44, cat: 'a b' }), 'x?s=22&k=44&c=a%20b');
  assert.deepEqual(mapItem({ name: 'X', price: { basicPrice: 1.5 }, ref: '9' }, { name: 'name', price: 'price.basicPrice', sku: 'ref' }), { strategy: 'internal-api', name: 'X', price: 1.5, sku: '9' });
});

test('resolveHeaders: re-reads a dynamic key from the page, merges static', async () => {
  const httpGet = async (url, { as } = {}) => (as === 'text'
    ? { status: 200, body: 'noise X-Api-Key: a8ylmv13-b285-4788-9e14-0f79b7ed2411 more' }
    : { status: 200, body: {} });
  const recipe = {
    static_headers: { Origin: 'https://s' },
    headers: { 'X-Api-Key': { from: 'https://s/', pattern: 'X-Api-Key:\\s*([a-z0-9-]{36})' } },
  };
  const { headers, error } = await resolveHeaders(recipe, httpGet);
  assert.equal(error, null);
  assert.equal(headers.Origin, 'https://s');
  assert.equal(headers['X-Api-Key'], 'a8ylmv13-b285-4788-9e14-0f79b7ed2411');
});

test('resolveHeaders: missing key → error (recipe unusable this run)', async () => {
  const httpGet = async () => ({ status: 200, body: 'no token here' });
  const { error } = await resolveHeaders({ headers: { K: { from: 'u', pattern: '(ZZZ)' } } }, httpGet);
  assert.match(error, /not found/);
});

test('replayInternalApi: offset pagination stops at total, maps fields', async () => {
  const TOTAL = 5;
  const all = Array.from({ length: TOTAL }, (_, i) => ({ name: 'p' + i, price: { basicPrice: i }, ref: 'r' + i }));
  const httpGet = async (url, { as } = {}) => {
    if (as === 'text') return { status: 200, body: 'X-Api-Key: a8ylmv13-b285-4788-9e14-0f79b7ed2411' };
    const skip = Number(new URL(url).searchParams.get('skip'));
    const size = Number(new URL(url).searchParams.get('size'));
    return { status: 200, body: { totalProductsFound: TOTAL, products: all.slice(skip, skip + size) } };
  };
  const recipe = {
    endpoint_tpl: 'https://s/api?size={size}&skip={skip}&cat={categoryId}',
    method: 'GET',
    headers: { 'X-Api-Key': { from: 'https://s/', pattern: 'X-Api-Key:\\s*([a-z0-9-]{36})' } },
    pagination: { type: 'offset', param: 'skip', size_param: 'size', size: 2, total_json_path: 'totalProductsFound' },
    json_path: 'products',
    field_map: { name: 'name', price: 'price.basicPrice', sku: 'ref' },
  };
  const out = await replayInternalApi(recipe, { httpGet, vars: { categoryId: '1684' } });
  assert.equal(out.ok, true);
  assert.equal(out.total, TOTAL);
  assert.equal(out.products.length, TOTAL);      // 2+2+1, stops cleanly
  assert.equal(out.pages, 3);
  assert.deepEqual(out.products[0], { strategy: 'internal-api', name: 'p0', price: 0, sku: 'r0' });
});

test('replayInternalApi: a bad recipe / HTTP error never throws', async () => {
  assert.equal((await replayInternalApi(null, {})).ok, false);
  const httpGet = async (url, { as } = {}) => (as === 'text' ? { status: 200, body: 'X-Api-Key: a8ylmv13-b285-4788-9e14-0f79b7ed2411' } : { status: 500, body: null });
  const r = await replayInternalApi({ endpoint_tpl: 'https://s/api?skip={skip}&size={size}', headers: { 'X-Api-Key': { from: 'u', pattern: '([a-z0-9-]{36})' } }, pagination: { type: 'offset', param: 'skip', size_param: 'size', size: 2 }, json_path: 'products' }, { httpGet });
  assert.equal(r.ok, false); assert.match(r.error, /HTTP 500/);
});

test('domain-profile: internal_api stored verbatim, lifecycle demotes then revives', () => {
  const recipe = { endpoint_tpl: 'https://s/api?skip={skip}&size={size}', method: 'GET', pagination: { type: 'offset', param: 'skip', size: 22 }, json_path: 'products', field_map: { name: 'name' } };
  let p = mergeProfile(null, { method: 'internal-api', productCount: 22, internalApi: recipe }, '2026-09-19T10:00:00Z');
  assert.deepEqual(p.internal_api, recipe);                 // == column value, no conversion
  assert.equal(p.internalApiMeta.status, 'candidate');
  assert.equal(p.internalApiMeta.version, 1);
  assert.equal(internalApiUsable(p), true);
  assert.equal(profileHints(p).internalApi, recipe);

  // repeated failures deprecate → hints stop offering it (fall back to discovery)
  for (let i = 0; i < INTERNAL_API_MAX_FAILS; i++) p = recordInternalApiOutcome(p, false, '2026-09-19T11:00:00Z');
  assert.equal(p.internalApiMeta.status, 'deprecated');
  assert.equal(internalApiUsable(p), false);
  assert.equal(profileHints(p).internalApi, null);

  // a real success revives it and clears the streak
  p = recordInternalApiOutcome(p, true, '2026-09-19T12:00:00Z');
  assert.equal(p.internalApiMeta.status, 'candidate');
  assert.equal(p.internalApiMeta.consecutive_fails, 0);
  assert.equal(internalApiUsable(p), true);
});

test('domain-profile: manual_selectors stored verbatim next to internal_api, same lifecycle', () => {
  const sel = {
    card: '.product-card',
    fields: { name: { selector: '.title', attr: null }, price: { selector: '.price', attr: null }, image: { selector: 'img', attr: 'src' } },
    pagination: { mode: 'load-more', selector: 'button.more', max_pages: null },
    origin: 'manual', sample_url: 'https://s/cat',
  };
  let p = mergeProfile(null, { manualSelectors: sel }, '2026-09-19T10:00:00Z');
  assert.deepEqual(p.manual_selectors, sel);                  // == column value, no conversion
  assert.equal(p.manualSelectorsMeta.status, 'candidate');
  assert.equal(manualSelectorsUsable(p), true);
  assert.equal(profileHints(p).manualSelectors, sel);
  // a card with no fields is not usable
  const empty = mergeProfile(null, { manualSelectors: { card: '.x', fields: {} } }, '2026-09-19T10:00:00Z');
  assert.equal(manualSelectorsUsable(empty), false);
  // demotion after repeated failures, independent of internal_api
  for (let i = 0; i < MANUAL_SELECTORS_MAX_FAILS; i++) p = recordManualSelectorsOutcome(p, false, '2026-09-19T11:00:00Z');
  assert.equal(p.manualSelectorsMeta.status, 'deprecated');
  assert.equal(manualSelectorsUsable(p), false);
  assert.equal(profileHints(p).manualSelectors, null);
});

test('domain-profile: a changed endpoint resets the lifecycle; stale after TTL', () => {
  const r1 = { endpoint_tpl: 'https://s/v1?skip={skip}', pagination: { type: 'offset', param: 'skip', size: 10 }, json_path: 'products' };
  let p = mergeProfile(null, { internalApi: r1 }, '2000-01-01T00:00:00Z');
  assert.equal(internalApiStale(p), true);                  // last_verified is ancient
  const r2 = { ...r1, endpoint_tpl: 'https://s/v2?skip={skip}' };
  p = mergeProfile(p, { internalApi: r2 }, new Date().toISOString());
  assert.equal(p.internalApiMeta.version, 2);               // bumped on endpoint change
  assert.equal(internalApiStale(p), false);
});
