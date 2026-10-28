/**
 * v0.5.9 — scrapingBrowserBootstrap(): the remote Scraping Browser used only as a
 * short BOOTSTRAP that observes the app's own API request and captures configured
 * header/cookie values. Fully mocked through the injectable `connect` — no test
 * opens a real (billed) session. The fake dispatches events BY NAME (the older
 * makeFakeBrowser in scraping-browser.test.mjs replays to any listener).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrapingBrowserBootstrap } from '../unlock/scraping-browser.mjs';

const KEY = 'TESTKEY-abc123XYZ';
const CDP = 'wss://brd-customer-hl_test-zone-mcp_browser:s3cr3tpw@brd.superproxy.io:9222';
const req = (url, headers, { method = 'GET', type = 'fetch' } = {}) => ({ url: () => url, method: () => method, resourceType: () => type, headers: () => headers });

const never = () => new Promise(() => {});
function makeFake({ requests = [], gotoThrows = null, cookies = [], cdpBytes = 0, captchaStatus = 'not_detected', captcha = 'ok', hang = {} } = {}) {
  const rec = { closed: false, gotoUrl: null, routed: [], connects: 0, captchaSent: 0 };
  const listeners = {}; const cdpL = {}; const pendingOnClose = [];
  const fire = async (evt, arg) => { for (const cb of (listeners[evt] || [])) await cb(arg); };
  let routeHandler = null;
  const cdp = { on: (e, cb) => { (cdpL[e] = cdpL[e] || []).push(cb); }, send: async (m, params) => {
    if (m === 'Network.enable' && hang.enable) return never();
    if (m === 'Captcha.solve') {
      rec.captchaSent += 1;
      rec.captchaParams = params;
      if (captcha === 'throw') throw new Error(`Captcha.solve failed on ${CDP}`);
      if (captcha === 'pending') return new Promise((_r, rej) => pendingOnClose.push(rej)); // rejected only by close()
      return { status: captchaStatus };
    }
    return {};
  } };
  const page = {
    route: async (_p, h) => { routeHandler = h; },
    goto: async (url) => {
      rec.gotoUrl = url;
      if (cdpBytes) for (const cb of (cdpL['Network.loadingFinished'] || [])) cb({ encodedDataLength: cdpBytes });
      for (const r of requests) {
        if (routeHandler) routeHandler({ request: () => r, abort: async () => { rec.routed.push(['abort', r.url()]); }, continue: async () => { rec.routed.push(['continue', r.url()]); } });
        await fire('request', r);
      }
      if (gotoThrows) throw new Error(gotoThrows);
    },
  };
  const ctx = {
    on: (evt, cb) => { (listeners[evt] = listeners[evt] || []).push(cb); },
    newPage: async () => (hang.newPage ? never() : page),
    newCDPSession: async () => cdp,
    cookies: async (urls) => { rec.cookieUrls = urls; return hang.cookies ? never() : cookies; },
  };
  const browser = { contexts: () => [ctx], close: async () => { rec.closed = true; for (const rej of pendingOnClose.splice(0)) rej(new Error('Target page, context or browser has been closed')); } };
  return { rec, connect: async () => { rec.connects += 1; return browser; } };
}
const CAP = { urlPattern: '^https://api[.]shop[.]test/', headers: ['X-Api-Key'] };

test('bootstrap: captures the configured header from the first matching non-OPTIONS request, then closes', async () => {
  const f = makeFake({ cdpBytes: 150000, requests: [
    req('https://api.shop.test/search?q=1', { 'x-api-key': 'PREFLIGHT-VAL', 'access-control-request-headers': 'x-api-key' }, { method: 'OPTIONS' }),
    req('https://cdn.shop.test/app.js', { 'x-api-key': 'NOT-THIS-ONE' }, { type: 'script' }),
    req('https://api.shop.test/search?q=1&token=zz', { 'x-api-key': KEY, accept: 'application/json' }),
  ] });
  const r = await scrapingBrowserBootstrap('https://www.shop.test/cat', { cdpUrl: CDP, capture: CAP, connect: f.connect, captureTimeoutMs: 500 });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.headers, { 'X-Api-Key': KEY }, 'configured casing, value read case-insensitively');
  assert.deepEqual(r.captured, { url: 'https://api.shop.test/search', headerNames: ['X-Api-Key'], cookieNames: [] }, 'origin+path only — never the query');
  assert.equal(r.bytes, 150000); assert.equal(r.bytesSource, 'cdp');
  assert.equal(typeof r.runtimeSec, 'number');
  assert.equal(f.rec.gotoUrl, 'https://www.shop.test/cat');
  assert.equal(f.rec.connects, 1);
  assert.equal(f.rec.closed, true, 'session closed right after the capture');
  assert.equal(f.rec.captchaSent, 0, 'no captcha wait once captured');
  const { headers, ...rest } = r;
  assert.equal(JSON.stringify(rest).includes(KEY), false, 'no captured value outside `headers`');
});

test('bootstrap: the capture target passes the resource blocking even when its type is blocked', async () => {
  const f = makeFake({ requests: [req('https://www.shop.test/logo.png', {}, { type: 'image' }), req('https://api.shop.test/x', { 'x-api-key': KEY }, { type: 'image' })] });
  const r = await scrapingBrowserBootstrap('https://www.shop.test/cat', { cdpUrl: CDP, capture: CAP, connect: f.connect, captureTimeoutMs: 500 });
  assert.equal(r.ok, true);
  assert.deepEqual(f.rec.routed, [['abort', 'https://www.shop.test/logo.png'], ['continue', 'https://api.shop.test/x']]);
});

test('bootstrap: only the named cookies are returned, auth-looking cookies never; a missing required cookie fails', async () => {
  const jar = [{ name: 'sid', value: 'S-VAL-1' }, { name: 'auth_token', value: 'NEVER' }, { name: 'other', value: 'o' }];
  let f = makeFake({ cookies: jar, requests: [req('https://api.shop.test/x', { 'x-api-key': KEY })] });
  let r = await scrapingBrowserBootstrap('https://www.shop.test/cat', { cdpUrl: CDP, capture: { ...CAP, cookies: ['sid', 'auth_token'] }, connect: f.connect, captureTimeoutMs: 500 });
  assert.equal(r.ok, false, 'auth_token is denylisted, so the required set could never be complete');
  assert.equal(r.note, 'bad_capture_spec', 'refused before paying for a session');
  assert.equal(f.rec.connects, 0);
  f = makeFake({ cookies: jar, requests: [req('https://api.shop.test/x', { 'x-api-key': KEY })] });
  r = await scrapingBrowserBootstrap('https://www.shop.test/cat', { cdpUrl: CDP, capture: { ...CAP, cookies: ['sid', 'missing_one'] }, connect: f.connect, captureTimeoutMs: 500 });
  assert.equal(r.ok, false);
  assert.equal(r.note, 'cookies_missing');
  assert.deepEqual(r.headers, {}); assert.equal(r.cookie, '');
  f = makeFake({ cookies: jar, requests: [req('https://api.shop.test/x', { 'x-api-key': KEY })] });
  r = await scrapingBrowserBootstrap('https://www.shop.test/cat', { cdpUrl: CDP, capture: { ...CAP, cookies: ['sid'] }, connect: f.connect, captureTimeoutMs: 500 });
  assert.equal(r.ok, true);
  assert.equal(r.cookie, 'sid=S-VAL-1');
  assert.deepEqual(f.rec.cookieUrls, ['https://api.shop.test/x'], 'cookies scoped to the captured request URL');
  assert.equal(JSON.stringify(r.captured).includes('S-VAL-1'), false);
});

test('bootstrap: no matching request → no_match; a match without the header → headers_missing; both close the session', async () => {
  let f = makeFake({ requests: [req('https://cdn.shop.test/a.js', { 'x-api-key': KEY })] });
  let r = await scrapingBrowserBootstrap('https://www.shop.test/cat', { cdpUrl: CDP, capture: CAP, connect: f.connect, captureTimeoutMs: 200 });
  assert.equal(r.ok, false); assert.equal(r.note, 'no_match'); assert.equal(f.rec.closed, true);
  assert.equal(f.rec.captchaSent, 1, 'nothing captured after navigation → the challenge solver gets its chance');
  assert.deepEqual(f.rec.captchaParams, { detectTimeout: 10000 }, 'Bright Data rejects a `timeout` key live');
  f = makeFake({ requests: [req('https://api.shop.test/x', { accept: 'json' })] });
  r = await scrapingBrowserBootstrap('https://www.shop.test/cat', { cdpUrl: CDP, capture: CAP, connect: f.connect, captureTimeoutMs: 200 });
  assert.equal(r.ok, false); assert.equal(r.note, 'headers_missing'); assert.match(r.error, /lacked: X-Api-Key/); assert.equal(f.rec.closed, true);
});

test('bootstrap: a navigation failure before any capture closes the session and redacts credentials', async () => {
  const f = makeFake({ gotoThrows: `net::ERR_TUNNEL ${CDP}` });
  const r = await scrapingBrowserBootstrap('https://www.shop.test/cat', { cdpUrl: CDP, capture: CAP, connect: f.connect, captureTimeoutMs: 500 });
  assert.equal(r.ok, false); assert.equal(r.note, 'nav_failed'); assert.equal(f.rec.closed, true);
  assert.doesNotMatch(r.error, /s3cr3tpw|hl_test/);
});

test('bootstrap: not configured / bad capture spec never connect (no billed session)', async () => {
  const connect = async () => { throw new Error('must not connect'); };
  let r = await scrapingBrowserBootstrap('https://www.shop.test/cat', { cdpUrl: null, capture: CAP, connect });
  assert.equal(r.note, 'not_configured');
  r = await scrapingBrowserBootstrap('https://www.shop.test/cat', { cdpUrl: CDP, capture: { urlPattern: '(', headers: ['X'] }, connect });
  assert.equal(r.note, 'bad_capture_spec');
  r = await scrapingBrowserBootstrap('https://www.shop.test/cat', { cdpUrl: CDP, capture: { urlPattern: 'x' }, connect });
  assert.equal(r.note, 'bad_capture_spec', 'nothing to capture');
});

test('bootstrap: a hung connect hits the overall deadline, and a late connect is closed — never leaked', async () => {
  const rec = { closed: false };
  const late = { contexts: () => [], close: async () => { rec.closed = true; } };
  const connect = () => new Promise((res) => setTimeout(() => res(late), 1500));
  const t0 = Date.now();
  const r = await scrapingBrowserBootstrap('https://www.shop.test/cat', { cdpUrl: CDP, capture: CAP, connect, timeoutMs: 1000 });
  assert.equal(r.ok, false); assert.equal(r.note, 'timeout');
  assert.ok(Date.now() - t0 < 1400, 'returns at the deadline, not when the connect finally lands');
  await new Promise((res) => setTimeout(res, 700));
  assert.equal(rec.closed, true, 'the late session is closed as soon as it arrives');
});

test('bootstrap: a spec requiring an auth-looking cookie is refused BEFORE connecting (it could never succeed)', async () => {
  const r = await scrapingBrowserBootstrap('https://www.shop.test/cat', { cdpUrl: CDP, capture: { ...CAP, cookies: ['remember_me'] }, connect: async () => { throw new Error('must not connect'); } });
  assert.equal(r.note, 'bad_capture_spec');
  assert.match(r.error, /remember_me/);
});

for (const [what, hang, extra] of [
  ['page creation', { newPage: true }, {}],
  ['CDP Network.enable', { enable: true }, {}],
  ['the cookie read after a capture', { cookies: true }, { requests: [req('https://api.shop.test/x', { 'x-api-key': KEY })], cookieCap: ['sid'] }],
]) {
  test(`bootstrap: a remote call that never answers (${what}) hits the overall deadline and the session is closed`, async () => {
    const f = makeFake({ hang, requests: extra.requests || [] });
    const t0 = Date.now();
    const r = await scrapingBrowserBootstrap('https://www.shop.test/cat', { cdpUrl: CDP, capture: { ...CAP, ...(extra.cookieCap ? { cookies: extra.cookieCap } : {}) }, connect: f.connect, timeoutMs: 1000, captureTimeoutMs: 500 });
    assert.equal(r.ok, false);
    assert.equal(r.note, 'timeout');
    assert.ok(Date.now() - t0 < 1600, `returned in ${Date.now() - t0} ms`);
    assert.equal(f.rec.closed, true, 'billed session closed even though a remote call is still pending');
    assert.deepEqual(r.headers, {});
  });
}

test('bootstrap: the capture window never outlives the overall deadline', async () => {
  const f = makeFake();
  const slow = async () => { await new Promise((res) => setTimeout(res, 700)); return f.connect(); };
  const t0 = Date.now();
  const r = await scrapingBrowserBootstrap('https://www.shop.test/cat', { cdpUrl: CDP, capture: CAP, connect: slow, timeoutMs: 1000, captureTimeoutMs: 5000 });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 1500, `returned in ${Date.now() - t0} ms, not after the 5 s capture window`);
  assert.equal(f.rec.closed, true);
});

test('bootstrap: a connect error or a captcha error never leaks the zone credentials', async () => {
  let r = await scrapingBrowserBootstrap('https://www.shop.test/cat', { cdpUrl: CDP, capture: CAP, connect: async () => { throw new Error(`WebSocket error: ${CDP}/ 403 Forbidden`); } });
  assert.equal(r.ok, false); assert.equal(r.note, 'error');
  assert.doesNotMatch(r.error, /s3cr3tpw|hl_test/); assert.match(r.error, /403 Forbidden/);
  const f = makeFake({ captcha: 'throw' });
  r = await scrapingBrowserBootstrap('https://www.shop.test/cat', { cdpUrl: CDP, capture: CAP, connect: f.connect, captureTimeoutMs: 200 });
  assert.match(String(r.captcha), /^unavailable: /);
  assert.doesNotMatch(String(r.captcha), /s3cr3tpw|hl_test/);
});

test('bootstrap: a captcha solve still running when OUR capture window ends is reported as pending, not "unavailable"', async () => {
  const f = makeFake({ captcha: 'pending' });
  const r = await scrapingBrowserBootstrap('https://www.shop.test/cat', { cdpUrl: CDP, capture: CAP, connect: f.connect, captureTimeoutMs: 200 });
  assert.equal(r.note, 'no_match');
  assert.equal(r.captcha, 'pending_at_close');
  assert.equal(f.rec.closed, true);
});
