/**
 * Fetcher regression: oversized response headers.
 *
 * Real cause found on a live run (Lidl/Akamai): the product pages return a
 * response header block larger than undici's default 16 KiB limit, so the global
 * fetch throws `UND_ERR_HEADERS_OVERFLOW` (surfaced as a generic "fetch failed")
 * and the page is lost → 0 products → empty CSV. The Fetcher now uses a
 * dispatcher with a larger, bounded maxHeaderSize. These tests use a local
 * loopback server (no network) that emits a big header, and assert:
 *   • the default Fetcher now parses it (before the fix this threw), and
 *   • a deliberately tiny cap still fails BUT with a diagnosable cause code
 *     (observability: no more opaque "fetch failed").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Fetcher } from '../http-fetcher.mjs';

const BIG = 'x'.repeat(40 * 1024); // 40 KiB — well over undici's 16 KiB default

async function withServer(run) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Big-Header', BIG); // oversized header block
    res.end('<html><body><h1>ok</h1></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try { await run(`http://127.0.0.1:${port}/`); }
  finally { await new Promise((r) => server.close(r)); }
}

test('fetcher tolerates oversized response headers (undici default 16 KiB would overflow)', async () => {
  await withServer(async (url) => {
    const f = new Fetcher({ minDelayMs: 0, retries: 0 });
    const r = await f.get(url);
    assert.equal(r.ok, true);          // before the fix: ok=false, error="fetch failed (UND_ERR_HEADERS_OVERFLOW)"
    assert.equal(r.status, 200);
    assert.match(r.body, /ok/);
  });
});

test('fetcher: a too-small maxHeaderSize still fails, but the cause is diagnosable (not opaque)', async () => {
  await withServer(async (url) => {
    const f = new Fetcher({ minDelayMs: 0, retries: 0, maxHeaderSize: 2048 });
    const r = await f.get(url);
    assert.equal(r.ok, false);
    assert.equal(r.status, 0);
    // The underlying undici cause code is preserved for diagnosis.
    assert.match(r.error, /UND_ERR|HEADERS|overflow/i);
  });
});

test('fetcher: normal small-header response is unaffected', async () => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html>hi</html>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const f = new Fetcher({ minDelayMs: 0, retries: 0 });
    const r = await f.get(`http://127.0.0.1:${port}/`);
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.match(r.body, /hi/);
  } finally { await new Promise((r) => server.close(r)); }
});
