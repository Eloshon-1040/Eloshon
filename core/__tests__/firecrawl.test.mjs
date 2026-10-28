/**
 * Firecrawl escalation tier (v0.5.6, API v2 since v0.5.37) — offline. A fake fetchImpl
 * captures the request so we pin the wire shape (endpoint, auth, formats, maxAge, the
 * wait-for-selector hydration action) without a real key/network, plus config/env
 * resolution, the credits / cache facts read back, and the error policy (402 stops,
 * 429 / 5xx retried within the budget). Sleeps are injected: no test waits for real.
 * The response fixtures are hand-built from the v2 reference (docs.firecrawl.dev,
 * SDK @mendable/firecrawl-js 4.50.0 types), read on 2026-10-20.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  firecrawlConfig, firecrawlAvailable, firecrawlScrape, firecrawlMaxAge, retryAfterMs,
  FIRECRAWL_ENDPOINT, DEFAULT_MAX_AGE_MS,
} from '../unlock/firecrawl.mjs';

const ok = (data, extra = {}) => ({ status: 200, headers: new Headers(), json: async () => ({ success: true, data }), ...extra });
const err = (status, body = {}, headers = {}) => ({ status, headers: new Headers(headers), json: async () => body });
/** A scripted fetch: one reply per call, in order (the last one repeats). */
function scripted(...replies) {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts, body: JSON.parse(opts.body) }); return replies[Math.min(calls.length - 1, replies.length - 1)]; };
  return { calls, fetchImpl };
}
/** A fake clock whose sleep advances it, recording each wait. */
function clock(start = 1_000_000) {
  let t = start; const waits = [];
  return { now: () => t, sleepImpl: async (ms) => { waits.push(ms); t += ms; }, waits, advance: (ms) => { t += ms; } };
}
const PAGE = '<html>' + 'x'.repeat(400) + '</html>';

test('firecrawlConfig: reads key from config or env (plain + hyphenated); never throws', () => {
  assert.deepEqual(firecrawlConfig({ firecrawl: { apiKey: 'fc1' } }, {}), { apiKey: 'fc1', configured: true });
  assert.equal(firecrawlConfig({}, { FIRECRAWL_API_KEY: 'fc2' }).apiKey, 'fc2');
  assert.equal(firecrawlConfig({}, { 'FIRECRAWL-API-KEY': 'fc3' }).apiKey, 'fc3');
  assert.equal(firecrawlConfig({}, {}).configured, false);
  assert.equal(firecrawlAvailable({ firecrawl: { apiKey: 'x' } }, {}), true);
  assert.equal(firecrawlAvailable({}, {}), false);
});

test('v2 request: endpoint, auth, formats, full page, wait-for-selector action, upper-case country, maxAge, server timeout', async () => {
  const s = scripted(ok({ rawHtml: PAGE, markdown: '# List\n[A](https://s/p/1)\n$10' }));
  const r = await firecrawlScrape('https://shop/cat', { apiKey: 'K', waitSelector: '.card--article', country: 'be', waitMs: 1500, maxAge: 600000, timeoutMs: 120000, fetchImpl: s.fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(FIRECRAWL_ENDPOINT, 'https://api.firecrawl.dev/v2/scrape');
  assert.equal(s.calls[0].url, FIRECRAWL_ENDPOINT);
  assert.equal(s.calls[0].opts.method, 'POST');
  assert.equal(s.calls[0].opts.headers.Authorization, 'Bearer K');
  const body = s.calls[0].body;
  assert.equal(body.url, 'https://shop/cat');
  assert.deepEqual(body.formats, ['rawHtml', 'markdown']); // the page as served: its scripts hold the product state
  assert.equal(body.onlyMainContent, false);                // v2 default is true: the lane wants the whole page
  assert.deepEqual(body.actions, [{ type: 'wait', selector: '.card--article' }, { type: 'wait', milliseconds: 1500 }]);
  assert.deepEqual(body.location, { country: 'BE' });       // v2 pattern ^[A-Z]{2}$
  assert.equal(body.maxAge, 600000);
  // Real clock: a millisecond may pass between the deadline and the request.
  assert.ok(body.timeout <= 118000 && body.timeout >= 117000, `Firecrawl stops just inside the route budget (${body.timeout})`);
  assert.equal(body.proxy, undefined, 'no proxy sent: the v2 default (auto) applies');
  assert.equal(body.storeInCache, undefined, 'storeInCache keeps its default (true): a retry can reuse the page');
});

test('maxAge: the lane always sends one — default 1 h, 0 forces a fresh page, a bad value falls back', async () => {
  const s = scripted(ok({ rawHtml: PAGE }));
  await firecrawlScrape('https://s', { apiKey: 'K', fetchImpl: s.fetchImpl });
  assert.equal(s.calls[0].body.maxAge, DEFAULT_MAX_AGE_MS);
  assert.equal(DEFAULT_MAX_AGE_MS, 3600000);
  await firecrawlScrape('https://s', { apiKey: 'K', maxAge: 0, fetchImpl: s.fetchImpl });
  assert.equal(s.calls[1].body.maxAge, 0);
  await firecrawlScrape('https://s', { apiKey: 'K', maxAge: -5, fetchImpl: s.fetchImpl });
  assert.equal(s.calls[2].body.maxAge, DEFAULT_MAX_AGE_MS);
  // config.firecrawl.maxAgeMs
  assert.equal(firecrawlMaxAge({}), DEFAULT_MAX_AGE_MS);
  assert.equal(firecrawlMaxAge({ firecrawl: { maxAgeMs: 0 } }), 0);
  assert.equal(firecrawlMaxAge({ firecrawl: { maxAgeMs: 172800000 } }), 172800000);
  assert.equal(firecrawlMaxAge({ firecrawl: { maxAgeMs: 'abc' } }), DEFAULT_MAX_AGE_MS);
  assert.equal(firecrawlMaxAge({ firecrawl: { maxAgeMs: -1 } }), DEFAULT_MAX_AGE_MS);
});

test('credits and cache read back from data.metadata (creditsUsed, cacheState, cachedAt)', async () => {
  const hit = scripted(ok({ rawHtml: PAGE, metadata: { statusCode: 200, creditsUsed: 1, cacheState: 'hit', cachedAt: '2026-10-20T09:00:00.000Z' } }));
  const a = await firecrawlScrape('https://s', { apiKey: 'K', fetchImpl: hit.fetchImpl });
  assert.equal(a.credits, 1); assert.equal(a.cacheState, 'hit'); assert.equal(a.cachedAt, '2026-10-20T09:00:00.000Z'); assert.equal(a.attempts, 1);
  const miss = scripted(ok({ rawHtml: PAGE, metadata: { creditsUsed: 1, cacheState: 'miss' } }));
  const b = await firecrawlScrape('https://s', { apiKey: 'K', fetchImpl: miss.fetchImpl });
  assert.equal(b.cacheState, 'miss'); assert.equal(b.cachedAt, undefined);
  // Not reported (maxAge 0 has no cacheState; an answer may omit creditsUsed) → null, never guessed.
  const none = scripted(ok({ rawHtml: PAGE, metadata: { statusCode: 200 } }));
  const c = await firecrawlScrape('https://s', { apiKey: 'K', maxAge: 0, fetchImpl: none.fetchImpl });
  assert.equal(c.credits, null); assert.equal(c.cacheState, null);
  const odd = scripted(ok({ rawHtml: PAGE, metadata: { cacheState: 'stale', creditsUsed: 'n/a' } }));
  const d = await firecrawlScrape('https://s', { apiKey: 'K', fetchImpl: odd.fetchImpl });
  assert.equal(d.cacheState, null); assert.equal(d.credits, null);
});

test('result shape for the controller is unchanged: ok, status, html, markdown, bytes, error (+ credits, cacheState, attempts)', async () => {
  const s = scripted(ok({ rawHtml: PAGE, markdown: '# m', metadata: { creditsUsed: 1, cacheState: 'miss' } }));
  const r = await firecrawlScrape('https://s', { apiKey: 'K', fetchImpl: s.fetchImpl });
  for (const k of ['ok', 'status', 'html', 'markdown', 'bytes', 'error', 'credits', 'cacheState', 'attempts']) assert.ok(k in r, k);
  assert.equal(r.ok, true); assert.equal(r.status, 200); assert.equal(r.error, null); assert.equal(r.html, PAGE); assert.equal(r.markdown, '# m');
  assert.equal(r.bytes, Buffer.byteLength(PAGE) + 3);
});

test('per-host headers (e.g. a session/store Cookie) are forwarded; an empty object is not sent', async () => {
  const s = scripted(ok({ rawHtml: 'h'.repeat(300) }));
  await firecrawlScrape('https://shop.test/fr/produits', { apiKey: 'K', headers: { Cookie: 'store=eyJpZCI6NjA0fQ==' }, fetchImpl: s.fetchImpl });
  assert.deepEqual(s.calls[0].body.headers, { Cookie: 'store=eyJpZCI6NjA0fQ==' });
  await firecrawlScrape('https://x', { apiKey: 'K', headers: {}, fetchImpl: s.fetchImpl });
  assert.equal(s.calls[1].body.headers, undefined);
});

test('explicit actions array + proxy override are passed verbatim', async () => {
  const s = scripted(ok({ rawHtml: 'y'.repeat(300) }));
  await firecrawlScrape('https://s', { apiKey: 'K', actions: [{ type: 'click', selector: '#store' }, { type: 'wait', milliseconds: 2000 }], proxy: 'enhanced', fetchImpl: s.fetchImpl });
  assert.equal(s.calls[0].body.actions[0].type, 'click');
  assert.equal(s.calls[0].body.proxy, 'enhanced');
});

test('the raw page wins over the cleaned one (the product state lives in scripts)', async () => {
  const raw = `<html><body><script>window.__S__ = {"products":[{"name":"501","price":99}]}</script>${'x'.repeat(300)}</body></html>`;
  const s = scripted(ok({ html: '<html><body>cleaned</body></html>', rawHtml: raw, markdown: '# m' }));
  const r = await firecrawlScrape('https://shop/cat', { apiKey: 'K', fetchImpl: s.fetchImpl });
  assert.equal(r.html, raw);
});

test('errors — no key (no request), HTTP error, success:false, empty page', async () => {
  const s0 = scripted(ok({ rawHtml: 'z'.repeat(300) }));
  const r0 = await firecrawlScrape('https://s', { fetchImpl: s0.fetchImpl });
  assert.equal(r0.ok, false); assert.equal(r0.note, 'not_configured'); assert.equal(s0.calls.length, 0);
  const r1 = await firecrawlScrape('https://s', { apiKey: 'K', fetchImpl: scripted(err(403, { success: false, error: 'This website is not supported' })).fetchImpl });
  assert.equal(r1.ok, false); assert.equal(r1.note, 'http_error'); assert.equal(r1.status, 403); assert.match(r1.error, /not supported/);
  const r2 = await firecrawlScrape('https://s', { apiKey: 'K', fetchImpl: scripted({ status: 200, json: async () => ({ success: false, error: 'blocked' }) }).fetchImpl });
  assert.equal(r2.ok, false); assert.equal(r2.note, 'api_error');
  const r3 = await firecrawlScrape('https://s', { apiKey: 'K', fetchImpl: scripted(ok({ metadata: { creditsUsed: 1, cacheState: 'hit' } })).fetchImpl });
  assert.equal(r3.ok, false); assert.equal(r3.note, 'empty'); assert.equal(r3.credits, 1); assert.equal(r3.cacheState, 'hit');
});

test('402 (no credits left): stops at once, never retried, named reason', async () => {
  const c = clock();
  const s = scripted(err(402, { success: false, error: 'Payment required to access this resource.', code: 'insufficient_credits' }));
  const r = await firecrawlScrape('https://s', { apiKey: 'K', fetchImpl: s.fetchImpl, ...c });
  assert.equal(s.calls.length, 1, 'one request, no retry');
  assert.deepEqual(c.waits, []);
  assert.equal(r.ok, false); assert.equal(r.status, 402); assert.equal(r.note, 'no_credits'); assert.match(r.error, /no credits left/);
});

test('429 with Retry-After: waits exactly that long, then succeeds', async () => {
  const c = clock();
  const s = scripted(err(429, { error: 'Request rate limit exceeded. Please wait and try again later.' }, { 'Retry-After': '7' }), ok({ rawHtml: PAGE, metadata: { creditsUsed: 1 } }));
  const r = await firecrawlScrape('https://s', { apiKey: 'K', fetchImpl: s.fetchImpl, ...c });
  assert.equal(s.calls.length, 2);
  assert.deepEqual(c.waits, [7000]);
  assert.equal(r.ok, true); assert.equal(r.attempts, 2); assert.equal(r.credits, 1);
  // The second attempt's server timeout reflects the budget already spent.
  assert.equal(s.calls[1].body.timeout, 120000 - 7000 - 2000);
});

test('429 Retry-After as an HTTP date is honoured too', () => {
  const now = Date.parse('2026-10-20T10:00:00Z');
  assert.equal(retryAfterMs('Tue, 20 Oct 2026 10:00:30 GMT', now), 30000);
  assert.equal(retryAfterMs('3', now), 3000);
  assert.equal(retryAfterMs('', now), null);
  assert.equal(retryAfterMs('soon', now), null);
});

test('429 whose Retry-After exceeds the route budget: no wait, no second request, rate_limited', async () => {
  const c = clock();
  const s = scripted(err(429, { error: 'Request rate limit exceeded.' }, { 'Retry-After': '300' }));
  const r = await firecrawlScrape('https://s', { apiKey: 'K', timeoutMs: 120000, fetchImpl: s.fetchImpl, ...c });
  assert.equal(s.calls.length, 1); assert.deepEqual(c.waits, []);
  assert.equal(r.ok, false); assert.equal(r.status, 429); assert.equal(r.note, 'rate_limited'); assert.match(r.error, /exceeds the route budget/);
});

test('5xx without Retry-After: exponential backoff (1 s, 2 s), at most 3 attempts, then the last error', async () => {
  const c = clock();
  const s = scripted(err(503, { success: false, error: 'Service Unavailable' }));
  const r = await firecrawlScrape('https://s', { apiKey: 'K', fetchImpl: s.fetchImpl, ...c });
  assert.equal(s.calls.length, 3); assert.deepEqual(c.waits, [1000, 2000]);
  assert.equal(r.ok, false); assert.equal(r.status, 503); assert.equal(r.note, 'http_error'); assert.equal(r.attempts, 3);
  const c2 = clock();
  const s2 = scripted(err(500, { success: false, code: 'UNKNOWN_ERROR', error: 'An unexpected error occurred on the server.' }), ok({ rawHtml: PAGE }));
  const r2 = await firecrawlScrape('https://s', { apiKey: 'K', fetchImpl: s2.fetchImpl, ...c2 });
  assert.equal(r2.ok, true); assert.equal(s2.calls.length, 2); assert.deepEqual(c2.waits, [1000]);
});

test('retries stay inside the route budget: no retry starts with less than 5 s left', async () => {
  const c = clock();
  const s = scripted(err(502, { success: false, error: 'Bad Gateway' }));
  // Each attempt "takes" 3 s on the fake clock; budget 8 s → attempt 1 (t=3), wait 1 s (t=4), 4 s left < 5 s → stop.
  const slow = async (u, o) => { c.advance(3000); return s.fetchImpl(u, o); };
  const r = await firecrawlScrape('https://s', { apiKey: 'K', timeoutMs: 8000, fetchImpl: slow, now: c.now, sleepImpl: c.sleepImpl });
  assert.equal(s.calls.length, 1); assert.deepEqual(c.waits, []);
  assert.equal(r.ok, false); assert.equal(r.status, 502);
});

test('a small route budget still sends the request (Firecrawl minimum timeout 1 s)', async () => {
  const s = scripted(ok({ rawHtml: PAGE }));
  const r = await firecrawlScrape('https://s', { apiKey: 'K', timeoutMs: 1000, fetchImpl: s.fetchImpl });
  assert.equal(r.ok, true); assert.equal(s.calls[0].body.timeout, 1000);
});

test('a network error is not retried (the request may have reached Firecrawl)', async () => {
  let n = 0;
  const r = await firecrawlScrape('https://s', { apiKey: 'K', fetchImpl: async () => { n++; throw new Error('ECONNRESET'); }, sleepImpl: async () => { throw new Error('no sleep expected'); } });
  assert.equal(n, 1); assert.equal(r.ok, false); assert.match(r.error, /request failed/);
});
