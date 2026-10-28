/**
 * P0 / B8 — a 429 is retried after the delay the site asks for (Retry-After, else
 * 1 s then 2 s), within the limits: never longer than `maxRetryAfterMs`, never past
 * the job's deadline. The wait moves the host's slot for every parallel caller.
 * Before: a 429 was never retried (only 5xx were). Loopback server only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Fetcher } from '../http-fetcher.mjs';
import { STATUS } from '../detect.mjs';

/** Answers 429 (with `retryAfter` when given) to the first `limited` requests, then 200. */
async function limitedServer({ limited = 1, retryAfter = null } = {}) {
  const arrivals = []; let n = 0;
  const srv = http.createServer((req, res) => {
    arrivals.push({ at: Date.now(), path: req.url });
    n += 1;
    if (n <= limited) { res.writeHead(429, { 'content-type': 'text/plain', ...(retryAfter != null ? { 'retry-after': String(retryAfter) } : {}) }); return res.end('slow down'); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>ok</html>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, arrivals, close: () => srv.close() };
}

test('429 with Retry-After: 1 → waits about 1 s, retries, succeeds', { timeout: 10000 }, async () => {
  const s = await limitedServer({ limited: 1, retryAfter: 1 });
  try {
    const f = new Fetcher({ minDelayMs: 0, retries: 2, timeoutMs: 5000 });
    const r = await f.get(`${s.base}/p`);
    assert.equal(r.ok, true, `status ${r.status}`);
    assert.equal(s.arrivals.length, 2);
    assert.ok(s.arrivals[1].at - s.arrivals[0].at >= 900, `retried after ${s.arrivals[1].at - s.arrivals[0].at} ms`);
  } finally { s.close(); }
});

test('429 without Retry-After → backs off (about 1 s) and retries', { timeout: 10000 }, async () => {
  const s = await limitedServer({ limited: 1 });
  try {
    const f = new Fetcher({ minDelayMs: 0, retries: 2, timeoutMs: 5000 });
    const r = await f.get(`${s.base}/p`);
    assert.equal(r.ok, true);
    assert.ok(s.arrivals[1].at - s.arrivals[0].at >= 900);
  } finally { s.close(); }
});

test('429 asking for longer than maxRetryAfterMs, or past the job deadline → no wait, the 429 is reported', { timeout: 10000 }, async () => {
  const s = await limitedServer({ limited: 5, retryAfter: 120 });
  try {
    const t0 = Date.now();
    const f = new Fetcher({ minDelayMs: 0, retries: 2, timeoutMs: 5000, maxRetryAfterMs: 60000 });
    const r = await f.get(`${s.base}/p`);
    assert.equal(r.status, 429); assert.equal(r.block.code, STATUS.RATE_LIMITED);
    assert.equal(s.arrivals.length, 1); assert.ok(Date.now() - t0 < 2000);
    const g = new Fetcher({ minDelayMs: 0, retries: 2, timeoutMs: 5000, deadlineAt: () => Date.now() + 500 });
    const s2 = await limitedServer({ limited: 5, retryAfter: 2 });
    try { const r2 = await g.get(`${s2.base}/p`); assert.equal(r2.status, 429); assert.equal(s2.arrivals.length, 1); } finally { s2.close(); }
  } finally { s.close(); }
});

test('a 429 pushes the host back for parallel requests too', { timeout: 10000 }, async () => {
  const s = await limitedServer({ limited: 1, retryAfter: 1 });
  try {
    const f = new Fetcher({ minDelayMs: 0, retries: 2, timeoutMs: 5000 });
    const first = f.get(`${s.base}/a`);
    await new Promise((r) => setTimeout(r, 150)); // the 429 has been answered by now
    const second = f.get(`${s.base}/b`);
    await Promise.all([first, second]);
    const b = s.arrivals.find((x) => x.path === '/b');
    assert.ok(b.at - s.arrivals[0].at >= 900, `the parallel request waited ${b.at - s.arrivals[0].at} ms`);
  } finally { s.close(); }
});
