/**
 * P0 / B6 — per-host spacing holds under concurrency. The throttle used to read the
 * host's "last request" time, sleep, then write it: concurrent workers read the same
 * value and fired together (about `workers` requests per `rateLimitMs`). The slot is
 * now reserved before waiting. Loopback server only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Fetcher } from '../http-fetcher.mjs';
import { HostPacer } from '../../shared/net/deadline.mjs';

test('Fetcher: 4 parallel requests to one host arrive at least minDelayMs apart', { timeout: 10000 }, async () => {
  const arrivals = [];
  const srv = http.createServer((req, res) => { arrivals.push(Date.now()); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>ok</html>'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const f = new Fetcher({ minDelayMs: 300, retries: 0, timeoutMs: 5000 });
    // Warm-up: open the connection first, so arrival times measure the spacing of
    // the sends, not the first connection's set-up time.
    await f.get(`${base}/warm`); arrivals.length = 0;
    await new Promise((r) => setTimeout(r, 350));
    await Promise.all([1, 2, 3, 4].map((i) => f.get(`${base}/p${i}`)));
    arrivals.sort((a, b) => a - b);
    const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]);
    assert.equal(arrivals.length, 4);
    assert.ok(gaps.every((g) => g >= 220), `gaps between requests: ${gaps.join(', ')} ms (expected ≥ 300 ms, 80 ms timer slack)`);
  } finally { srv.close(); }
});

test('HostPacer: slots are booked one delay apart per host; hosts are independent; pushBack moves the next slot', () => {
  let t = 1000;
  const p = new HostPacer({ minDelayMs: 200, now: () => t });
  assert.deepEqual([p.reserve('https://a.test/1'), p.reserve('https://a.test/2'), p.reserve('https://a.test/3')], [0, 200, 400]);
  assert.equal(p.reserve('https://b.test/1'), 0, 'another host is not delayed');
  t += 1000;
  assert.equal(p.reserve('https://a.test/4'), 0, 'past slots are not owed');
  p.pushBack('https://a.test/x', 5000);
  assert.equal(p.reserve('https://a.test/5'), 5000, 'a Retry-After moves the host for every caller');
});
