/**
 * HTTP page-ENUMERATION pagination: a listing that yields products but exposes
 * NO rel=next / visible <a> pagination link (JS / infinite-scroll pagination)
 * is still crawled past page 1 by synthesizing ?page=N. Generic, bounded, and
 * self-correcting (dedup + no-new-products guard). Offline: pure + loopback HTTP.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { nextPageUrl } from '../pagination.mjs';
import { discoverProducts } from '../discover.mjs';
import { Fetcher } from '../http-fetcher.mjs';

test('nextPageUrl: increments an existing param / path, else starts at ?page=2, preserving other params', () => {
  assert.equal(nextPageUrl('https://s/shop'), 'https://s/shop?page=2');
  assert.equal(nextPageUrl('https://s/shop?page=2'), 'https://s/shop?page=3');
  assert.equal(nextPageUrl('https://s/c/cat?p=5&color=red'), 'https://s/c/cat?p=6&color=red');
  assert.equal(nextPageUrl('https://s/shop/page/2'), 'https://s/shop/page/3');
  assert.equal(nextPageUrl('not a url'), null);
});

// A listing paginated ONLY by ?page=N (no rel=next, no <a> pagination links).
function makeServer() {
  const page = (nums) => `<html><head><title>Shop</title></head><body><h1>Catalogue</h1>`
    + nums.map((n) => `<a href="/product/p${n}">Produit ${n}</a>`).join('') + `</body></html>`;
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/robots.txt' || u.pathname.includes('sitemap')) { res.statusCode = 404; return res.end(''); }
    if (u.pathname === '/shop') {
      const p = parseInt(u.searchParams.get('page') || '1', 10);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (p === 1) return res.end(page([1, 2, 3]));
      if (p === 2) return res.end(page([4, 5, 6]));
      return res.end(page([])); // page 3+ empty → enumeration stops
    }
    if (u.pathname.startsWith('/product/')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<html><head><title>P</title></head><body><h1>P</h1></body></html>');
    }
    res.statusCode = 404; res.end('');
  });
}

test('E2E: a JS-paginated listing (no next-page link) is enumerated past page 1', async () => {
  const server = makeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const fetcher = new Fetcher({ minDelayMs: 0, retries: 0 });
    const { urls, report } = await discoverProducts(fetcher, `http://127.0.0.1:${port}/shop`, { maxProducts: 50, maxPages: 20 });
    const paths = urls.map((u) => new URL(u).pathname).sort();
    // page 1 → p1..p3, enumerated page 2 → p4..p6, page 3 empty → stop
    assert.deepEqual(paths, ['/product/p1', '/product/p2', '/product/p3', '/product/p4', '/product/p5', '/product/p6']);
    assert.ok(report.enumeratedPages >= 1, 'enumeration actually fired');
  } finally { server.close(); }
});
