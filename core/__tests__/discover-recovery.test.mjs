/**
 * F2 → discovery. Recovery ladder extended to the DISCOVERY phase, behind
 * opts.recovery. Flag OFF is covered byte-identically by the whole existing
 * suite; here we exercise flag ON: a BLOCKED catalogue fetch (Access Denied /
 * challenge) is offered alternative representations, accepted only when it truly
 * yields catalogue links + matches the requested resource, then fed to the SAME
 * discovery pipeline. Offline, deterministic. No browser, no site-specific logic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverProducts } from '../discover.mjs';
import { recoverDiscovery } from '../discover-recovery.mjs';

// Fetcher mock with finalUrl (redirect) support.
class Mock {
  constructor(map) { this.map = map; this.calls = []; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(url) {
    this.calls.push(url); this.stats.requests++;
    const e = this.map[url] || { status: 404, body: '' };
    const status = e.error ? 0 : (e.status ?? 200);
    const ok = !e.error && status >= 200 && status < 300;
    if (ok) this.stats.ok++; else this.stats.failed++;
    return { ok, status, url: e.finalUrl || url, requestedUrl: url, contentType: 'text/html', kind: 'html', body: e.body ?? '', bytes: null, headers: e.headers || {}, error: e.error ?? null, blocked: false };
  }
  async getText(url) { return this.get(url); }
}

// Generic edge/WAF blocks (Akamai / Cloudflare) — NO site-specific markers.
const ACCESS_DENIED = { status: 403, body: '<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1>'
  + "<p>You don't have permission to access this resource.</p><p>Reference&#32;#18.abcd1234</p></body></html>" };
const CHALLENGE = { status: 403, body: '<html><head><title>Just a moment...</title></head><body>Checking your browser. /cdn-cgi/challenge-platform ray id</body></html>' };
// A real catalogue page: enough visible text (not "empty") + product/listing links.
const catalogue = (links) => ({ status: 200, body:
  `<html><head><title>Jeans homme</title></head><body><h1>Catalogue</h1>`
  + `<p>${'nos produits en stock '.repeat(8)}</p>`
  + links.map((h) => `<a href="${h}">Voir le produit</a>`).join('') + `</body></html>` });
const NAV_ONLY = { status: 200, body:
  `<html><head><title>Accueil</title></head><body><h1>Bienvenue</h1>`
  + `<p>${'texte de presentation '.repeat(8)}</p>`
  + `<a href="/aide">Aide</a><a href="/contact">Contact</a></body></html>` };

// ── integration (via discoverProducts) ──────────────────────────────────────

test('discovery: Access Denied on the catalogue → recovered via an alternative representation (apex twin)', async () => {
  const shop = 'https://www.shop.be/cat/jeans';
  const f = new Mock({
    [shop]: ACCESS_DENIED,                                            // entry blocked
    'https://m.shop.be/cat/jeans': ACCESS_DENIED,                     // mobile twin also blocked
    'https://shop.be/cat/jeans': catalogue(['/product/a', '/product/b']), // apex twin serves the catalogue
  });
  const seen = [];
  const { urls, report } = await discoverProducts(f, shop, { recovery: true, onRecovery: (i) => seen.push(i) });
  assert.deepEqual(urls.map((u) => new URL(u).pathname).sort(), ['/product/a', '/product/b']);
  assert.equal(report.recovered, 1);
  assert.equal(report.stopped, null);
  assert.equal(seen.length, 1);                    // recovery attempted exactly once
  assert.ok(Array.isArray(seen[0].trace) && seen[0].trace.length >= 1); // explainable trace
  assert.equal(seen[0].via.url, 'https://shop.be/cat/jeans');
});

test('discovery: challenge on the catalogue → recovered via a mobile twin (crawl rebased to the twin host)', async () => {
  const shop = 'https://www.shop.be/cat/shoes';
  const f = new Mock({
    [shop]: CHALLENGE,
    'https://m.shop.be/cat/shoes': catalogue(['https://m.shop.be/product/x', 'https://m.shop.be/product/y']),
  });
  const { urls, report } = await discoverProducts(f, shop, { recovery: true });
  // Product links live on the m. host — only collected because the crawl rebased.
  assert.deepEqual(urls.map((u) => new URL(u).host).sort(), ['m.shop.be', 'm.shop.be']);
  assert.deepEqual(urls.map((u) => new URL(u).pathname).sort(), ['/product/x', '/product/y']);
  assert.equal(report.recovered, 1);
  assert.equal(report.stopped, null);
  assert.ok(!f.calls.includes('https://shop.be/cat/shoes')); // m. twin worked first → apex never tried
});

test('discovery: recovery impossible (every representation blocked/absent) → clean, resumable stop', async () => {
  const shop = 'https://www.shop.be/cat/x';
  const f = new Mock({
    [shop]: ACCESS_DENIED,
    'https://m.shop.be/cat/x': ACCESS_DENIED,
    'https://shop.be/cat/x': { status: 404, body: '' },
  });
  const { urls, report } = await discoverProducts(f, shop, { recovery: true });
  assert.equal(urls.length, 0);                    // nothing invented
  assert.ok(report.recovered === undefined || report.recovered === 0);
  assert.ok(report.stopped && report.stopped.code && report.stopped.url === shop); // diagnosed + resumable
});

test('discovery: flag OFF → strictly unchanged (blocked catalogue stops, recovery never runs)', async () => {
  const shop = 'https://www.shop.be/cat/x';
  const f = new Mock({
    [shop]: ACCESS_DENIED,
    'https://shop.be/cat/x': catalogue(['/product/a']), // would recover IF the flag were on
  });
  const seen = [];
  const { urls, report } = await discoverProducts(f, shop, { onRecovery: (i) => seen.push(i) }); // flag OFF (default)
  assert.equal(urls.length, 0);
  assert.equal(report.recovered, undefined);
  assert.equal(seen.length, 0);                    // recovery never invoked
  assert.ok(!f.calls.includes('https://shop.be/cat/x')); // alternative representation never fetched
  assert.ok(report.stopped && report.stopped.code);
});

test('discovery: a redirect-to-homepage representation is rejected (identity guard) — no invented URLs', async () => {
  const shop = 'https://www.shop.be/cat/x';
  const f = new Mock({
    [shop]: ACCESS_DENIED,
    'https://m.shop.be/cat/x': { finalUrl: 'https://m.shop.be/', ...catalogue(['/product/promo']) }, // redirected home
    'https://shop.be/cat/x': { status: 404, body: '' },
  });
  const seen = [];
  const { urls, report } = await discoverProducts(f, shop, { recovery: true, onRecovery: (i) => seen.push(i) });
  assert.equal(urls.length, 0);
  assert.ok(report.stopped);
  assert.ok(seen[0].trace.some((t) => t.reason === 'identity_mismatch'));
});

test('discovery: a representation with no product links is rejected (never a fake catalogue)', async () => {
  const shop = 'https://www.shop.be/cat/x';
  const f = new Mock({
    [shop]: CHALLENGE,
    'https://m.shop.be/cat/x': NAV_ONLY,                 // 200 but only nav links
    'https://shop.be/cat/x': NAV_ONLY,
  });
  const seen = [];
  const { urls, report } = await discoverProducts(f, shop, { recovery: true, onRecovery: (i) => seen.push(i) });
  assert.equal(urls.length, 0);
  assert.ok(report.stopped);
  assert.ok(seen[0].trace.some((t) => t.reason === 'no_catalogue_links'));
});

test('discovery: no double recovery — a second block after a successful recovery does NOT retry', async () => {
  const shop = 'https://www.shop.be/cat/x';
  const f = new Mock({
    [shop]: CHALLENGE,
    'https://m.shop.be/cat/x': catalogue(['/product/a', '/category/deeper']), // 1 product + 1 deeper listing
    'https://m.shop.be/category/deeper': CHALLENGE,                            // deeper page blocked too
  });
  const seen = [];
  const { urls, report } = await discoverProducts(f, shop, { recovery: true, onRecovery: (i) => seen.push(i) });
  assert.equal(seen.length, 1);                     // recovery fired ONCE, not again on the second block
  assert.ok(urls.some((u) => u.endsWith('/product/a'))); // the product found before the second block is kept
  assert.equal(report.recovered, 1);
  assert.ok(report.stopped && report.stopped.url === 'https://m.shop.be/category/deeper');
});

// ── unit (recoverDiscovery, pure) ───────────────────────────────────────────

test('recoverDiscovery: a block candidate is never accepted (challenge everywhere) → escalate browser', async () => {
  const url = 'https://www.shop.be/cat/x';
  const f = new Mock({ 'https://m.shop.be/cat/x': CHALLENGE, 'https://shop.be/cat/x': CHALLENGE });
  const r = await recoverDiscovery({ url, fetcher: f, html: CHALLENGE.body, accept: () => true });
  assert.equal(r.ok, false);
  assert.equal(r.escalate, 'browser');             // a challenge is browser-recoverable
  assert.ok(r.trace.length >= 1 && r.trace.every((t) => t.accepted === false));
});

test('recoverDiscovery: invalid args → safe failure', async () => {
  const r = await recoverDiscovery({ url: '', fetcher: null });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'invalid_args');
});

test('recoverDiscovery: bounded by maxAttempts', async () => {
  const url = 'https://www.shop.be/cat/x';
  const f = new Mock({
    'https://m.shop.be/cat/x': { status: 404, body: '' },        // first candidate fails
    'https://shop.be/cat/x': catalogue(['/product/a']),          // would work, but not reached
  });
  const r = await recoverDiscovery({ url, fetcher: f, maxAttempts: 1, accept: () => true });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 1);
  assert.ok(!f.calls.includes('https://shop.be/cat/x'));
});
