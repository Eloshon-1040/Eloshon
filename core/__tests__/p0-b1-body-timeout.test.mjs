/**
 * P0 / B1 — a request's deadline covers the BODY, not only the headers. A server
 * that sends its headers and then stalls the body used to hold the caller
 * forever (the timer was cleared once the headers arrived). Loopback server and
 * fake fetch implementations only: no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Fetcher } from '../http-fetcher.mjs';
import { firecrawlScrape, firecrawlCreditUsage } from '../unlock/firecrawl.mjs';
import { webUnlockerFetch } from '../unlock/web-unlocker.mjs';
import { createAnthropicAsker } from '../../app/ai/provider.mjs';
import { fetchWithin, withinDeadline } from '../../shared/net/deadline.mjs';

const T = { timeout: 8000 }; // a test that hangs fails instead of blocking the suite

/** Headers + the first bytes of the body, then silence. */
async function stallingServer() {
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.write('<html><body>partial');
    // never ends
  });
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/p`, close: () => { for (const s of sockets) s.destroy(); srv.close(); } };
}
/** A fake response whose body read never settles (and ignores the abort signal). */
const hangingBody = (status = 200) => ({ status, ok: status < 400, headers: new Headers(), json: () => new Promise(() => {}), text: () => new Promise(() => {}) });

test('Fetcher: a body that stalls after the headers ends as a timeout, within the deadline', T, async () => {
  const s = await stallingServer();
  try {
    const f = new Fetcher({ timeoutMs: 400, retries: 0, minDelayMs: 0 });
    const t0 = Date.now();
    const r = await f.get(s.url);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'timeout');
    assert.ok(Date.now() - t0 < 3000, `returned after ${Date.now() - t0} ms`);
  } finally { s.close(); }
});

test('Firecrawl scrape and credit check: a stalled body ends within the budget', T, async () => {
  const t0 = Date.now();
  const r = await firecrawlScrape('https://shop.test/c', { apiKey: 'K', timeoutMs: 1500, retries: 0, fetchImpl: async () => hangingBody() });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 4000);
  const c = await firecrawlCreditUsage('K', { timeoutMs: 500, fetchImpl: async () => hangingBody() });
  assert.equal(c.ok, false);
});

test('Web Unlocker: a stalled body ends within the budget', T, async () => {
  const t0 = Date.now();
  const r = await webUnlockerFetch('https://shop.test/c', { apiKey: 'K', zone: 'z', timeoutMs: 500, fetchImpl: async () => hangingBody() });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 3000);
});

test('AI provider: a request that never answers is bounded', T, async () => {
  const ask = createAnthropicAsker({ apiKey: 'K', timeoutMs: 400, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(ask('hi'), /timeout/);
  const ask2 = createAnthropicAsker({ apiKey: 'K', timeoutMs: 400, fetchImpl: async () => hangingBody() });
  await assert.rejects(ask2('hi'), /timeout/);
});

test('fetchWithin / withinDeadline: timeout, caller abort, normal answer', T, async () => {
  const slow = await fetchWithin(async () => hangingBody(), 'https://x.test', {}, { timeoutMs: 200 });
  assert.deepEqual([slow.ok, slow.error], [false, 'timeout']);
  const ac = new AbortController(); setTimeout(() => ac.abort(), 50);
  const stopped = await fetchWithin(async () => hangingBody(), 'https://x.test', {}, { timeoutMs: 5000, signal: ac.signal });
  assert.deepEqual([stopped.ok, stopped.error], [false, 'aborted']);
  const good = await fetchWithin(async () => ({ status: 200, headers: new Headers(), json: async () => ({ a: 1 }) }), 'https://x.test', {}, { as: 'json' });
  assert.deepEqual([good.ok, good.body], [true, { a: 1 }]);
  await assert.rejects(withinDeadline(() => new Promise(() => {}), { timeoutMs: 100 }), /timeout/);
});
