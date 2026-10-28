/**
 * API headers found in a site's PUBLIC JavaScript (core/api-header-discovery.mjs) —
 * hand-built pages and scripts, a fake fetchText: no network. Pins: a static header
 * written next to the API path is found and its spec round-trips through
 * resolveHeaders; nothing is found when the scripts hold no such pair; a dynamic or
 * token-like value is refused and reported; the file cap and the byte cap hold; only
 * the page's own scripts (or a declared host) are read; the error code of the refusal
 * narrows the choice; an old recipe without specs keeps working.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverApiHeaders, discoverySummary, pageScriptUrls, headerCandidates, valueVerdict, isHeaderName, apiAnchors, patternFor, hintTokens, nameMatchesHint, DISCOVERY_DEFAULTS } from '../api-header-discovery.mjs';
import { resolveHeaders } from '../../shared/internal-api.mjs';

const PAGE = 'https://www.shop.test/fr/w/shoes';
const API = 'https://api.shop.test/discover/product_wall/v1/marketplace/BE?anchor=24&count=24';
const scripts = (srcs, head = '') => `<html><head>${head}${srcs.map((s) => `<script src="${s}"></script>`).join('')}<script type="application/json" src="/x.json"></script></head><body><script>var inline = 1;</script></body></html>`;
// A minified-looking bundle: the header pair sits a few hundred characters from the API path.
const FILLER = (n) => 'var _f=' + '"x".repeat(1);'.repeat(Math.max(0, Math.floor(n / 14)));
const BUNDLE_OK = `${FILLER(300)}const u=e=>"https://api.shop.test/discover/product_wall/v1/marketplace/"+e;${FILLER(400)}fetch(u(m),{headers:{"accept":"application/json","shop-api-caller-id":"com.shop.web.catalog","x-request-source":"web"}})${FILLER(200)}`;
const BUNDLE_DYNAMIC = `${FILLER(100)}const p="/discover/product_wall/v1/";${FILLER(50)}r.setRequestHeader("shop-api-caller-id", callerId());r.setRequestHeader("shop-session-token","eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig");r.setRequestHeader("x-trace","${'a1b2c3d4'.repeat(6)}");`;
const BUNDLE_FAR = `fetch("https://api.shop.test/discover/product_wall/v1/x")${FILLER(20000)}var h={headers:{"shop-api-caller-id":"com.shop.web.far"}};`;
// A React-like bundle: DOM props and class names written as hyphenated object keys next to the API path — never request headers.
const BUNDLE_PROPS = `${FILLER(200)}const wall="https://api.shop.test/discover/product_wall/v1/marketplace/";${FILLER(100)}e("div",{"aria-hidden":"true","data-group-type":"wall","banner-container":"mini-wall","mini-wall":"true"});${FILLER(100)}`;

const fetcherOf = (files, { log = [] } = {}) => async (url, { maxBytes } = {}) => {
  log.push(url);
  const t = files[url];
  if (t == null) return { ok: false, text: '', status: 404 };
  if (maxBytes && Buffer.byteLength(t) > maxBytes) return { ok: false, text: '', status: 200, tooLarge: true };
  return { ok: true, text: t, status: 200 };
};

test('isHeaderName / valueVerdict / apiAnchors / hintTokens — the shape rules', () => {
  assert.equal(isHeaderName('shop-api-caller-id'), true);
  assert.equal(isHeaderName('X-Requested-With'), true);
  assert.equal(isHeaderName('accept'), false, 'no hyphen → not a custom header');
  assert.equal(isHeaderName('authorization'), false); assert.equal(isHeaderName('content-type'), false); assert.equal(isHeaderName('sec-ch-ua'), false);
  assert.equal(isHeaderName('aria-hidden'), false); assert.equal(isHeaderName('data-group-type'), false, 'DOM attributes are never request headers');
  assert.equal(nameMatchesHint('shop-api-caller-id', ['caller', 'id']), true); assert.equal(nameMatchesHint('shop-api-caller-id', ['nike', 'api', 'caller', 'id']), false); assert.equal(nameMatchesHint('x-id-caller', ['caller', 'id']), false, 'the words must follow each other in that order');
  assert.deepEqual(valueVerdict('com.shop.web.catalog'), { ok: true });
  assert.deepEqual(valueVerdict('3fa85f64-5717-4562-b3fc-2c963f66afa6'), { ok: true }, 'a uuid-shaped app id is a literal shared by every visitor');
  assert.equal(valueVerdict('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig').reason, 'jwt');
  assert.equal(valueVerdict('a1b2c3d4'.repeat(6)).reason, 'hex_digest');
  assert.equal(valueVerdict('Qz9'.repeat(15)).reason, 'opaque_token', '45 base64-like characters without a separator');
  assert.equal(valueVerdict('Bearer abc').reason, 'credential');
  assert.equal(valueVerdict('${token}').reason, 'template');
  assert.equal(valueVerdict('').reason, 'empty');
  const a = apiAnchors(API);
  assert.ok(a.includes('/discover/product_wall/v1/marketplace/BE') && a.includes('api.shop.test') && a.includes('product_wall') && a.includes('marketplace'));
  assert.deepEqual(hintTokens('CALLER_ID_HEADER_NOT_PRESENT'), ['caller', 'id']);
});

test('pageScriptUrls: same-site scripts and declared hosts only, JSON islands skipped, API-named files first, vendor files last', () => {
  const html = scripts(['/static/vendor/react.min.js', 'https://static.shop.test/js/pages/wall.js', 'https://cdn.other.net/lib.js', 'https://edge.declared.net/app.js', '/static/main.js'], '<link rel="preconnect" href="https://edge.declared.net">');
  const urls = pageScriptUrls(html, PAGE, { allowedOrigins: ['https://edge.declared.net'], anchors: apiAnchors(API) });
  assert.deepEqual(urls, ['https://static.shop.test/js/pages/wall.js', 'https://edge.declared.net/app.js', 'https://www.shop.test/static/main.js', 'https://www.shop.test/static/vendor/react.min.js']);
  assert.ok(!urls.some((u) => u.includes('cdn.other.net')), 'a foreign CDN the page does not declare is never read');
});

test('found: a static header written next to the API path → value, spec, and the spec re-reads the same value through resolveHeaders', async () => {
  const files = { 'https://static.shop.test/js/pages/wall.js': BUNDLE_OK };
  const log = [];
  const d = await discoverApiHeaders({ html: scripts(['https://static.shop.test/js/pages/wall.js']), pageUrl: PAGE, apiUrl: API, fetchText: fetcherOf(files, { log }), errorText: 'CALLER_ID_HEADER_NOT_PRESENT' });
  assert.equal(d.found, true);
  assert.deepEqual(d.headers, { 'shop-api-caller-id': 'com.shop.web.catalog' }, 'the error code names the header: only that one is kept');
  assert.equal(d.filesRead, 1); assert.equal(d.filesListed, 1);
  const spec = d.specs['shop-api-caller-id'];
  assert.equal(spec.from, 'https://static.shop.test/js/pages/wall.js'); assert.equal(spec.flags, 'i'); assert.match(spec.pattern, /shop-api-caller-id/);
  // Round trip through the existing resolver (what the next run does with the recipe).
  const r = await resolveHeaders({ headers: d.specs }, async (u) => ({ status: 200, body: files[u] }));
  assert.equal(r.error, null); assert.deepEqual(r.headers, { 'shop-api-caller-id': 'com.shop.web.catalog' });
  // Without a hint, every static header near the path is returned (bounded).
  const d2 = await discoverApiHeaders({ html: scripts(['https://static.shop.test/js/pages/wall.js']), pageUrl: PAGE, apiUrl: API, fetchText: fetcherOf(files) });
  assert.deepEqual(d2.headers, { 'shop-api-caller-id': 'com.shop.web.catalog', 'x-request-source': 'web' });
  const s = discoverySummary(d);
  assert.deepEqual(s.names, ['shop-api-caller-id']); assert.equal(JSON.stringify(s).includes('com.shop.web.catalog'), false, 'the summary never carries a value');
});

test('absent: scripts without a header pair near the API path → nothing found, files counted', async () => {
  const files = { 'https://www.shop.test/a.js': `${FILLER(500)}fetch("https://api.shop.test/discover/product_wall/v1/x")`, 'https://www.shop.test/b.js': 'var noise = {"x-other-thing":"1"};' };
  const d = await discoverApiHeaders({ html: scripts(['/a.js', '/b.js']), pageUrl: PAGE, apiUrl: API, fetchText: fetcherOf(files) });
  assert.equal(d.found, false); assert.deepEqual(d.headers, {}); assert.equal(d.filesRead, 2); assert.deepEqual(d.rejected, []);
  const far = await discoverApiHeaders({ html: scripts(['/far.js']), pageUrl: PAGE, apiUrl: API, fetchText: fetcherOf({ 'https://www.shop.test/far.js': BUNDLE_FAR }) });
  assert.equal(far.found, false, 'a pair 20 000 characters away from the API path is not "next to" it');
  // Measured on a real shop (09/10/2026): DOM props and class names next to the API path
  // used to pass as headers; they are object keys outside any headers object.
  const props = await discoverApiHeaders({ html: scripts(['/props.js']), pageUrl: PAGE, apiUrl: API, fetchText: fetcherOf({ 'https://www.shop.test/props.js': BUNDLE_PROPS }) });
  assert.equal(props.found, false); assert.deepEqual(props.headers, {}); assert.equal(props.candidates, 0);
});

test('the refusal names the header: only a name carrying those words counts, wherever it is in the file; none → not found, no guess', async () => {
  // The pair is far from the API path, but the error code names it → found.
  const far = await discoverApiHeaders({ html: scripts(['/far.js']), pageUrl: PAGE, apiUrl: API, fetchText: fetcherOf({ 'https://www.shop.test/far.js': BUNDLE_FAR }), errorText: 'SHOP_API_CALLER_ID_HEADER_NOT_PRESENT' });
  assert.equal(far.found, true); assert.deepEqual(far.headers, { 'shop-api-caller-id': 'com.shop.web.far' });
  // Other static headers in the headers object are NOT taken when the site named one.
  const named = await discoverApiHeaders({ html: scripts(['https://static.shop.test/js/pages/wall.js']), pageUrl: PAGE, apiUrl: API, fetchText: fetcherOf({ 'https://static.shop.test/js/pages/wall.js': BUNDLE_OK }), errorText: 'SHOP_API_CALLER_ID_HEADER_NOT_PRESENT' });
  assert.deepEqual(Object.keys(named.headers), ['shop-api-caller-id']);
  // Named, but no script holds it as a literal: nothing is sent, the name looked for is reported.
  const none = await discoverApiHeaders({ html: scripts(['https://static.shop.test/js/pages/wall.js']), pageUrl: PAGE, apiUrl: API, fetchText: fetcherOf({ 'https://static.shop.test/js/pages/wall.js': BUNDLE_OK }), errorText: 'VENDOR_TOKEN_HEADER_NOT_PRESENT' });
  assert.equal(none.found, false); assert.deepEqual(none.headers, {}); assert.deepEqual(none.rejected, [{ name: 'vendor-token', reason: 'not_found_named' }]);
  const empty = await discoverApiHeaders({ html: scripts(['/props.js']), pageUrl: PAGE, apiUrl: API, fetchText: fetcherOf({ 'https://www.shop.test/props.js': BUNDLE_PROPS }), errorText: 'VENDOR_TOKEN_HEADER_NOT_PRESENT' });
  assert.deepEqual(empty.rejected, [{ name: 'vendor-token', reason: 'not_found' }]);
});

test('dynamic refused: a computed value is not a literal; a JWT and a hex digest are refused and reported by name', async () => {
  // The site names the header; its value is computed (callerId()), not a literal → not found, nothing sent.
  const named = await discoverApiHeaders({ html: scripts(['/dyn.js']), pageUrl: PAGE, apiUrl: API, fetchText: fetcherOf({ 'https://www.shop.test/dyn.js': BUNDLE_DYNAMIC }), errorText: 'CALLER_ID_HEADER_NOT_PRESENT' });
  assert.equal(named.found, false); assert.deepEqual(named.headers, {}); assert.deepEqual(named.rejected, [{ name: 'caller-id', reason: 'not_found_named' }]);
  // No usable hint: the token-like literals next to the API path are refused by name.
  const d = await discoverApiHeaders({ html: scripts(['/dyn.js']), pageUrl: PAGE, apiUrl: API, fetchText: fetcherOf({ 'https://www.shop.test/dyn.js': BUNDLE_DYNAMIC }), errorText: 'FORBIDDEN' });
  assert.equal(d.found, false);
  assert.deepEqual(d.headers, {});
  assert.deepEqual(d.rejected.map((r) => `${r.name}:${r.reason}`).sort(), ['shop-session-token:jwt', 'x-trace:hex_digest']);
  const amb = await discoverApiHeaders({ html: scripts(['/a.js', '/b.js']), pageUrl: PAGE, apiUrl: API, fetchText: fetcherOf({ 'https://www.shop.test/a.js': BUNDLE_OK, 'https://www.shop.test/b.js': BUNDLE_OK.replace('com.shop.web.catalog', 'com.shop.web.other') }), errorText: 'CALLER_ID_HEADER_NOT_PRESENT' });
  assert.equal(amb.found, false);
  assert.deepEqual(amb.rejected, [{ name: 'shop-api-caller-id', reason: 'ambiguous' }], 'two different values for one name: not static');
});

test('caps: at most maxFiles scripts are read (the rest is counted), a file over the byte cap is skipped', async () => {
  const srcs = Array.from({ length: 14 }, (_, i) => `/chunk-${i}.js`);
  const files = Object.fromEntries(srcs.map((s) => [`https://www.shop.test${s}`, 'var x = 1;']));
  files['https://www.shop.test/chunk-13.js'] = BUNDLE_OK; // beyond the cap → never read
  const log = [];
  const d = await discoverApiHeaders({ html: scripts(srcs), pageUrl: PAGE, apiUrl: API, fetchText: fetcherOf(files, { log }), maxFiles: 10 });
  assert.equal(log.length, 10); assert.equal(d.filesRead, 10); assert.equal(d.filesListed, 14); assert.equal(d.filesBeyondCap, 4); assert.equal(d.found, false);
  const big = await discoverApiHeaders({ html: scripts(['/big.js']), pageUrl: PAGE, apiUrl: API, fetchText: fetcherOf({ 'https://www.shop.test/big.js': BUNDLE_OK + FILLER(5000) }), maxBytesPerFile: 1000 });
  assert.equal(big.filesRead, 0); assert.deepEqual(big.filesSkipped, [{ url: 'https://www.shop.test/big.js', reason: 'too_large' }]); assert.equal(big.found, false);
  assert.equal(DISCOVERY_DEFAULTS.maxFiles, 10); assert.equal(DISCOVERY_DEFAULTS.maxBytesPerFile, 2 * 1024 * 1024);
});

test('headerCandidates / patternFor: object and call forms, distance to the nearest anchor, patterns round-trip', () => {
  const text = 'const base="https://api.shop.test/discover/product_wall/v1";' + 'x'.repeat(100) + 'h.set("x-app-id", "web-1");' + 'y'.repeat(7000) + '{"x-far-away":"v"}';
  const c = headerCandidates(text, apiAnchors(API), { window: 6000 });
  assert.deepEqual(c.map((x) => [x.name, x.value, x.form]), [['x-app-id', 'web-1', 'call']]);
  assert.ok(c[0].distance > 0 && c[0].distance < 200);
  assert.equal(text.match(new RegExp(patternFor(c[0]), 'i'))[1], 'web-1');
  const obj = headerCandidates('"https://api.shop.test/discover/product_wall/v1" headers:{"X-Client-Name":"catalog"}', apiAnchors(API), {});
  assert.equal(obj[0].name, 'x-client-name'); assert.equal(obj[0].hinted, false);
  assert.equal('{"X-Client-Name":"catalog"}'.match(new RegExp(patternFor(obj[0]), 'i'))[1], 'catalog');
  assert.deepEqual(headerCandidates('"https://api.shop.test/discover/product_wall/v1" x={"X-Client-Name":"catalog"}', apiAnchors(API), {}), [], 'an object key outside a headers object is a prop');
  const hinted = headerCandidates('var a = {headers:{"shop-api-caller-id":"com.shop.web"}};', [], { hints: ['caller', 'id'] });
  assert.equal(hinted.length, 1); assert.equal(hinted[0].hinted, true); assert.equal(hinted[0].distance, 0, 'a hinted name needs no API anchor nearby');
});

test('no fetch function, no html, or a page without scripts → an empty result, never a throw', async () => {
  assert.equal((await discoverApiHeaders({ html: '', pageUrl: PAGE, apiUrl: API, fetchText: async () => ({ ok: true, text: '' }) })).found, false);
  assert.equal((await discoverApiHeaders({ html: '<html></html>', pageUrl: PAGE, apiUrl: API, fetchText: async () => ({ ok: true, text: '' }) })).filesListed, 0);
  assert.equal((await discoverApiHeaders({ html: scripts(['/a.js']), pageUrl: PAGE, apiUrl: API })).found, false);
  const thrower = await discoverApiHeaders({ html: scripts(['/a.js']), pageUrl: PAGE, apiUrl: API, fetchText: async () => { throw new Error('boom'); } });
  assert.deepEqual(thrower.filesSkipped, [{ url: 'https://www.shop.test/a.js', reason: 'http_0' }]);
});
