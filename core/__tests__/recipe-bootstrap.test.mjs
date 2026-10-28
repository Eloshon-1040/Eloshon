/**
 * v0.5.9 — internal-api recipe lane with a BROWSER BOOTSTRAP for dynamic headers,
 * field_map templates, and the repaired Colruyt recipe. All offline: httpGet and
 * headerBootstrap are injected, nothing touches the network or a billed session.
 *
 * Contract under test: the free HTTP header resolution runs FIRST; the (paid)
 * headerBootstrap runs ONCE, only when that fails (or always when so configured);
 * captured values reach every catalogue request and NEVER appear in the result's
 * vars / error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveHeaders, runRecipeLane, mapItem, estimateRecipeCost, resolveVars } from '../internal-api.mjs';
import { toNormalizedProduct } from '../normalize.mjs';

const KEY = 'TESTKEY-abc123XYZ';
const ITEMS = [{ n: 'A', id: '1' }, { n: 'B', id: '2' }, { n: 'C', id: '3' }];
const recipeWithKey = (extra = {}) => ({
  endpoint_tpl: 'https://api.s/list?size={size}&skip={skip}',
  static_headers: { 'User-Agent': 'UA', Accept: 'application/json' },
  headers: { 'X-Api-Key': { from: 'https://www.s/', pattern: 'X-Api-Key:\\s*([A-Za-z0-9-]+)' } },
  pagination: { type: 'offset', param: 'skip', size_param: 'size', size: 2, total_json_path: 'total' },
  json_path: 'items',
  field_map: { name: 'n', sku: 'id' },
  ...extra,
});
const keyOf = (headers) => { const hit = Object.entries(headers || {}).filter(([k]) => k.toLowerCase() === 'x-api-key'); return hit.length === 1 ? hit[0][1] : (hit.length ? 'DUPLICATE' : null); };
function makeGet({ sourceStatus = 200, sourceBody = `cfg "X-Api-Key: ${KEY}"`, apiThrows = null } = {}) {
  const calls = [];
  const get = async (url, { headers = {}, as } = {}) => {
    calls.push({ url, headers: { ...headers }, as });
    if (url === 'https://www.s/') return { status: sourceStatus, body: sourceStatus < 400 ? sourceBody : '' };
    if (apiThrows) throw new Error(apiThrows);
    if (keyOf(headers) !== KEY) return { status: 401, body: { error: 'unauthorized' } };
    const u = new URL(url); const skip = Number(u.searchParams.get('skip')); const size = Number(u.searchParams.get('size'));
    return { status: 200, body: { total: ITEMS.length, items: ITEMS.slice(skip, skip + size) } };
  };
  return { get, calls, api: () => calls.filter((c) => c.url.startsWith('https://api.s/')), source: () => calls.filter((c) => c.url === 'https://www.s/') };
}

test('resolveHeaders: a preset value is used without fetching; case variants never duplicate; extra preset names are added', async () => {
  const recipe = { static_headers: { 'x-api-key': 'STALE', Accept: 'a' }, headers: { 'X-Api-Key': { from: 'https://www.s/', pattern: 'k=(.+)' } } };
  const noFetch = async () => { throw new Error('must not fetch'); };
  const r = await resolveHeaders(recipe, noFetch, { preset: { 'x-api-key': KEY, 'X-Extra': 'e1' } });
  assert.equal(r.error, null);
  assert.equal(keyOf(r.headers), KEY, 'exactly one key header, the preset value (fetch would join case variants)');
  assert.equal(r.headers['X-Extra'], 'e1');
  assert.equal(r.headers.Accept, 'a');
});

test('runRecipeLane: free header resolution succeeds → the bootstrap is NEVER called, source fetched once', async () => {
  const g = makeGet();
  let boots = 0;
  const out = await runRecipeLane(recipeWithKey(), 'https://www.s/cat', { httpGet: g.get, headerBootstrap: async () => { boots += 1; return {}; } });
  assert.equal(out.ok, true);
  assert.equal(out.products.length, 3);
  assert.equal(boots, 0, 'free path first — no paid bootstrap');
  assert.equal(g.source().length, 1, 'the key source page is fetched once (the replay reuses it)');
  assert.ok(g.api().every((c) => keyOf(c.headers) === KEY), 'key on every catalogue page');
  assert.equal(out.usedHeaderBootstrap, undefined);
});

test('runRecipeLane: free header fails (456) → bootstrap ONCE → captured key on EVERY page; value never in vars/error/result', async () => {
  const g = makeGet({ sourceStatus: 456 });
  const seen = [];
  const headerBootstrap = async (arg) => { seen.push(arg); return { headers: { 'X-Api-Key': KEY } }; };
  const out = await runRecipeLane(recipeWithKey(), 'https://www.s/cat', { httpGet: g.get, headerBootstrap });
  assert.equal(out.ok, true);
  assert.equal(out.products.length, 3);
  assert.equal(seen.length, 1, 'bootstrap used exactly once for the whole catalogue');
  assert.deepEqual(seen[0].names, ['X-Api-Key']);
  assert.equal(seen[0].categoryUrl, 'https://www.s/cat');
  assert.equal(g.api().length, 2, '2 paginated catalogue calls over HTTP');
  assert.ok(g.api().every((c) => keyOf(c.headers) === KEY), 'captured key sent on every catalogue page');
  assert.equal(out.usedHeaderBootstrap, true);
  assert.equal(JSON.stringify(out).includes(KEY), false, 'the captured value never appears in the lane result');
});

test("runRecipeLane: mode 'always' skips the free source fetch entirely", async () => {
  const g = makeGet();
  let boots = 0;
  const out = await runRecipeLane(recipeWithKey(), 'https://www.s/cat', { httpGet: g.get, headerBootstrapMode: 'always', headerBootstrap: async () => { boots += 1; return { headers: { 'X-Api-Key': KEY } }; } });
  assert.equal(out.ok, true);
  assert.equal(boots, 1);
  assert.equal(g.source().length, 0, 'the free key source is never fetched in always-mode');
});

test('runRecipeLane: a failed or incomplete bootstrap is a clean failure — no catalogue call, no value in the error', async () => {
  let g = makeGet({ sourceStatus: 456 });
  let out = await runRecipeLane(recipeWithKey(), 'https://www.s/cat', { httpGet: g.get, headerBootstrap: async () => ({ error: 'no matching request observed' }) });
  assert.equal(out.ok, false);
  assert.match(out.error, /source https:\/\/www\.s\/ → 456/);
  assert.match(out.error, /no matching request observed/);
  assert.equal(g.api().length, 0, 'no catalogue request without the key');
  g = makeGet({ sourceStatus: 456 });
  out = await runRecipeLane(recipeWithKey(), 'https://www.s/cat', { httpGet: g.get, headerBootstrap: async () => ({ headers: { 'X-Other': 'v' } }) });
  assert.equal(out.ok, false);
  assert.match(out.error, /X-Api-Key not captured/);
  g = makeGet({ sourceStatus: 456 });
  out = await runRecipeLane(recipeWithKey(), 'https://www.s/cat', { httpGet: g.get, headerBootstrap: async () => { throw new Error('connect refused'); } });
  assert.equal(out.ok, false);
  assert.match(out.error, /header bootstrap failed: connect refused/);
});

test('runRecipeLane: an error that echoes the captured value (fetch invalid-header message) is redacted', async () => {
  const g = makeGet({ sourceStatus: 456, apiThrows: `Headers.append: "${KEY}" is an invalid header value.` });
  const out = await runRecipeLane(recipeWithKey(), 'https://www.s/cat', { httpGet: g.get, headerBootstrap: async () => ({ headers: { 'X-Api-Key': KEY } }) });
  assert.equal(out.ok, false);
  assert.equal(out.error.includes(KEY), false);
  assert.match(out.error, /\*\*\*/);
});

test('runRecipeLane: captured cookies ride on every catalogue call; lower-cased captured names still match', async () => {
  const cookies = [];
  const g = makeGet({ sourceStatus: 456 });
  const get = async (url, o = {}) => { if (url.startsWith('https://api.s/')) cookies.push((o.headers || {}).Cookie); return g.get(url, o); };
  const out = await runRecipeLane(recipeWithKey(), 'https://www.s/cat', { httpGet: get, headerBootstrap: async () => ({ headers: { 'x-api-key': KEY }, cookie: 'sid=S1' }) });
  assert.equal(out.ok, true);
  assert.ok(cookies.length === 2 && cookies.every((c) => c === 'sid=S1'));
  assert.ok(g.api().every((c) => keyOf(c.headers) === KEY), 'no case-variant duplicate of the key header');
});

test('runRecipeLane: redaction also covers captured COOKIE values and the bootstrap-failure path', async () => {
  let g = makeGet({ sourceStatus: 456, apiThrows: `invalid values "${KEY}" / "COOKIEVAL123"` });
  let out = await runRecipeLane(recipeWithKey(), 'https://www.s/cat', { httpGet: g.get, headerBootstrap: async () => ({ headers: { 'X-Api-Key': KEY }, cookie: 'sid=COOKIEVAL123' }) });
  assert.equal(out.ok, false);
  assert.equal(out.error.includes(KEY), false);
  assert.equal(out.error.includes('COOKIEVAL123'), false, 'a captured cookie value is a secret too');
  g = makeGet({ sourceStatus: 456 });
  out = await runRecipeLane(recipeWithKey(), 'https://www.s/cat', { httpGet: g.get, headerBootstrap: async () => ({ headers: { 'X-Other': KEY }, error: `boom ${KEY}` }) });
  assert.equal(out.ok, false);
  assert.equal(out.error.includes(KEY), false, 'the failure path redacts what was captured');
});

test('runRecipeLane: a Stop before the session is passed through as `stopped` (not a bootstrap use, no catalogue call)', async () => {
  const g = makeGet({ sourceStatus: 456 });
  const out = await runRecipeLane(recipeWithKey(), 'https://www.s/cat', { httpGet: g.get, headerBootstrap: async () => ({ error: 'stopped before the bootstrap', stopped: true }) });
  assert.equal(out.ok, false);
  assert.equal(out.stopped, true);
  assert.equal(out.usedHeaderBootstrap, undefined);
  assert.equal(g.api().length, 0);
});

test('runRecipeLane: no endpoint for this URL → the (paid) bootstrap is never called', async () => {
  const g = makeGet({ sourceStatus: 456 });
  let boots = 0;
  const recipe = recipeWithKey({ endpoint_variants: [{ require: 'campaign', endpoint_tpl: 'https://api.s/c/{campaign}?size={size}&skip={skip}' }], vars: { campaign: { source: 'url', pattern: '/a([0-9]+)$', optional: true } } });
  const out = await runRecipeLane(recipe, 'https://www.s/cat', { httpGet: g.get, headerBootstrapMode: 'always', headerBootstrap: async () => { boots += 1; return { headers: { 'X-Api-Key': KEY } }; } });
  assert.equal(out.ok, false);
  assert.match(out.error, /no endpoint variant matched/);
  assert.equal(boots, 0);
});

test('runRecipeLane: a free-path key replaces a case-variant static header (no joined duplicate), with or without a bootstrap', async () => {
  for (const withBoot of [false, true]) {
    const g = makeGet();
    const recipe = recipeWithKey({ static_headers: { 'User-Agent': 'UA', 'x-api-key': 'STALE' } });
    const out = await runRecipeLane(recipe, 'https://www.s/cat', { httpGet: g.get, ...(withBoot ? { headerBootstrap: async () => ({}) } : {}) });
    assert.equal(out.ok, true, `withBoot=${withBoot}: ${out.error}`);
    assert.ok(g.api().every((c) => keyOf(c.headers) === KEY));
  }
});

test('runRecipeLane: the var-bootstrap cookie and the header-bootstrap cookie are BOTH sent', async () => {
  const seen = [];
  const g = makeGet({ sourceStatus: 456 });
  const get = async (url, o = {}) => { if (url.startsWith('https://api.s/')) seen.push((o.headers || {}).Cookie); return g.get(url, o); };
  const recipe = recipeWithKey({ endpoint_tpl: 'https://api.s/list?cat={cat}&size={size}&skip={skip}', vars: { cat: { source: 'page', json_path: 'x', needs_browser: true } } });
  const out = await runRecipeLane(recipe, 'https://www.s/cat', {
    httpGet: get,
    browserBootstrap: async () => ({ vars: { cat: '9' }, cookie: 'a=1' }),
    headerBootstrap: async () => ({ headers: { 'X-Api-Key': KEY }, cookie: 'b=2' }),
  });
  assert.equal(out.ok, true, out.error);
  assert.ok(seen.length === 2 && seen.every((c) => c === 'a=1; b=2'));
});

test('mapItem: hyphenated placeholders resolve; an unknown one drops the field (never a literal "{…}")', () => {
  const out = mapItem({ 'product-id': '7' }, { url: { template: 'https://s/p/{product-id}' }, other: { template: 'https://s/{no-such-key}' } });
  assert.equal(out.url, 'https://s/p/7');
  assert.equal(out.other, undefined);
});

test('runRecipeLane without a headerBootstrap is unchanged: a header failure ends the lane', async () => {
  const g = makeGet({ sourceStatus: 456 });
  const out = await runRecipeLane(recipeWithKey(), 'https://www.s/cat', { httpGet: g.get });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'header X-Api-Key: source https://www.s/ → 456');
});

test('mapItem: {template} fields are filled from the item; an absolute url becomes the source URL; relative urls are untouched', () => {
  const it = { id: 'A 1', meta: { slug: 'x' }, n: 'N', obj: { a: 1 } };
  const fm = { name: 'n', url: { template: 'https://s/p/{id}/{meta.slug}' }, bad: { template: 'https://s/{nope}' }, objy: { template: 'https://s/{obj}' } };
  const out = mapItem(it, fm);
  assert.equal(out.url, 'https://s/p/A%201/x');
  assert.equal(out.sourceUrl, out.url);
  assert.equal(out.canonicalUrl, out.url);
  assert.equal(out.bad, undefined, 'an unresolved placeholder drops the field, never a half-built value');
  assert.equal(out.objy, undefined);
  const rel = mapItem({ u: '/p/abc' }, { url: 'u' });
  assert.deepEqual(rel, { strategy: 'internal-api', url: '/p/abc' }, 'relative url (Lidl) keeps the previous shape');
  const np = toNormalizedProduct(mapItem({ id: '7', n: 'Seven' }, { name: 'n', sku: 'id', url: { template: 'https://s/p/{id}' } }), { storeSlug: 's', lang: 'fr' });
  assert.equal(np.source_url, 'https://s/p/7', 'the recipe URL reaches the normalized product');
});

test('estimateRecipeCost: a host configured to ALWAYS bootstrap is labelled as a paid start, provider-free', () => {
  const c = estimateRecipeCost({}, {}, 0, { paidBootstrap: true });
  assert.equal(c.free, false);
  assert.equal(c.bootstrap, 'paid-unlock');
  assert.equal(c.catalog, 'free');
  assert.doesNotMatch(c.label, /bright|scraping|browser api|firecrawl/i);
  assert.equal(estimateRecipeCost({}, {}).label, 'gratuit (site connu)');
});

// ── the repaired Colruyt recipe (data only) ─────────────────────────────────────
const colruyt = JSON.parse(fs.readFileSync(new URL('../recipes/colruyt-be.json', import.meta.url), 'utf8'));

test('colruyt recipe: free-first (no browser trigger var, no stale category_map), key pattern reads the entity-encoded page config', () => {
  assert.equal(Object.values(colruyt.vars).some((v) => v && v.needs_browser), false);
  assert.equal(colruyt.category_map, undefined);
  assert.equal(estimateRecipeCost(colruyt, {}).label, 'gratuit (site connu)');
  const spec = colruyt.headers['X-CG-APIKey'];
  const re = new RegExp(spec.pattern, spec.flags || '');
  const encoded = `<div data-cfg="{&quot;url&quot;:&quot;https://apip.colruyt.be/x&quot;,&quot;headers&quot;:[&quot;X-CG-APIKey: ${KEY}&quot;]}"></div>`;
  assert.equal(encoded.match(re)[1], KEY, 'stops at the &quot; entity');
  assert.equal(`{"headers":["X-CG-APIKey: ${KEY}"]}`.match(re)[1], KEY, 'and at a raw quote (model.json)');
  // categoryId tries the URL facet first (?categories=<id>), else the page model id.
  const src = colruyt.vars.categoryId.sources;
  assert.equal(src[0].source, 'url');
  const facet = new RegExp(src[0].pattern);
  assert.equal('https://www.colruyt.be/fr/produits/toutes-les-categories/boissons?categories=412&page=8'.match(facet)[1], '412', 'the URL sub-category filter is read');
  const cat = new RegExp(src[1].pattern);
  assert.equal('/content/clp/fr/producten/alle-categorieen/354/jcr:content/root'.match(cat)[1], '354');
  assert.equal('/content/clp/fr/producten/alle-categorieen/354/379/jcr:content/root'.match(cat)[1], '379', 'the LAST (deepest) id wins');
});

test("colruyt recipe: field_map follows today's API (LongName, basicPrice, article number, URL template)", () => {
  const item = { commercialArticleNumber: '5125', retailProductNumber: '99', name: 'Eau plate', LongName: 'EVERYDAY Eau plate 2L', brand: 'EVERYDAY', fullImage: 'https://static.colruytgroup.com/images/500x500/a.jpg', price: { basicPrice: 0.38 }, topCategoryName: 'Boissons', content: '2L', GTIN: ['25400141541643', '05400141541649'] };
  const p = mapItem(item, colruyt.field_map);
  assert.equal(p.name, 'EVERYDAY Eau plate 2L');
  assert.equal(p.price, 0.38);
  assert.equal(p.sku, '5125');
  assert.deepEqual(p.images, ['https://static.colruytgroup.com/images/500x500/a.jpg']);
  assert.equal(p.url, 'https://www.colruyt.be/fr/produits/5125');
  assert.equal(p.sourceUrl, 'https://www.colruyt.be/fr/produits/5125');
  assert.equal(p.brand, 'EVERYDAY');
  assert.equal(p.category, 'Boissons');
  assert.equal(p.weightText, '2L');
  assert.equal(p.gtin, undefined, 'GTIN intentionally unmapped (the array may lead with a case/pack GTIN)');
});

test('colruyt recipe end-to-end (offline): key from /fr, category id from the page, store from siteContext', async () => {
  const cat = 'https://www.colruyt.be/fr/produits/toutes-les-categories/boissons/eau';
  const apiCalls = [];
  const httpGet = async (url, { headers = {} } = {}) => {
    if (url === 'https://www.colruyt.be/fr') return { status: 200, body: `x &quot;headers&quot;:[&quot;X-CG-APIKey: ${KEY}&quot;] y` };
    if (url === cat) return { status: 200, body: '<div data-model-url="/content/clp/fr/producten/alle-categorieen/354/379/jcr:content/root"></div>' };
    apiCalls.push({ url, key: headers['X-CG-APIKey'], ua: headers['User-Agent'] });
    return { status: 200, body: { totalProductsFound: 1, products: [{ commercialArticleNumber: '5336', LongName: 'EVERYDAY Eau plate 50cl', price: { basicPrice: 0.149 }, fullImage: 'https://i/x.jpg' }] } };
  };
  const out = await runRecipeLane(colruyt, cat, { httpGet, siteConfig: { placeId: '886' }, maxProducts: 10 });
  assert.equal(out.ok, true, out.error);
  assert.equal(apiCalls.length, 1);
  assert.match(apiCalls[0].url, /placeId=886&/);
  assert.match(apiCalls[0].url, /categoryIds=379$/);
  assert.equal(apiCalls[0].key, KEY);
  assert.match(apiCalls[0].ua, /Chrome/, 'a browser User-Agent is sent (the gateway answers 456 without one)');
  assert.equal(out.products[0].url, 'https://www.colruyt.be/fr/produits/5336');
  const rv = await resolveVars(colruyt, 'https://www.colruyt.be/fr/produits?page=1', { httpGet: async () => ({ status: 200, body: '<html>no category</html>' }) });
  assert.match(rv.error, /categoryId: not found/, 'a non-category listing fails cleanly (falls back to the normal ladder)');
});
