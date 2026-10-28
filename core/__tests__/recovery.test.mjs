/**
 * F2 — recovery ladder tests. Pure, offline (mock fetcher). Proves: alternative
 * representations are tried after a non-usable first attempt, each is validated,
 * product identity is re-checked before acceptance (incl. a redirect-to-homepage
 * guard), declared representations are trusted, feeds are skipped, escalation is
 * honest, and the ladder is bounded. It launches no browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recover } from '../recovery.mjs';
import { validate } from '../validate.mjs';

const ld = (obj) => `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head><body></body></html>`;
const productHtml = (name, price, extra = {}) => ld({ '@type': 'Product', name, ...extra, ...(price != null ? { offers: { price: String(price), priceCurrency: 'EUR' } } : {}) });
const CHALLENGE = '<html><head><title>Just a moment...</title></head><body>Checking your browser. /cdn-cgi/challenge-platform ray id</body></html>';
const SHELL = '<html><body><div id="root"></div></body></html>';
const LONG_NOPROD = `<html><body><h1>Accueil</h1><p>${'texte '.repeat(400)}</p></body></html>`;

class Mock {
  constructor(map) { this.map = map; this.calls = []; }
  async get(u) {
    this.calls.push(u);
    const e = this.map[u] || { status: 404, body: 'Not found' };
    const status = e.error ? 0 : (e.status ?? 200);
    const ok = !e.error && status >= 200 && status < 300;
    return { ok, status, url: e.finalUrl || u, requestedUrl: u, body: e.body ?? '', error: e.error ?? null, headers: e.headers || {}, kind: 'html' };
  }
}
const origOf = (o) => ({ result: o, verdict: validate(o) });
const result = (o) => ({ ok: o.ok ?? true, status: o.status ?? 200, url: o.url, requestedUrl: o.url, body: o.body, error: o.error ?? null, headers: {}, kind: 'html' });

test('recover: heuristic mobile twin rescues a blocked original (identity via same path)', async () => {
  const url = 'https://www.shop.com/p/1';
  const original = origOf({ ok: false, status: 403, url, requestedUrl: url, body: CHALLENGE, headers: {}, kind: 'html' });
  const f = new Mock({ 'https://m.shop.com/p/1': { body: productHtml('Chaise', 89.9) }, 'https://shop.com/p/1': { status: 404 } });
  const r = await recover({ url, fetcher: f, original });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'usable');
  assert.equal(r.via.url, 'https://m.shop.com/p/1');
  assert.equal(r.via.source, 'heuristic');
  assert.equal(r.product.name, 'Chaise');
  assert.equal(r.escalate, 'none');
});

test('recover: redirect-to-homepage is rejected by the identity guard', async () => {
  const url = 'https://www.shop.com/p/1';
  const original = origOf({ ok: false, status: 403, url, requestedUrl: url, body: CHALLENGE, headers: {}, kind: 'html' });
  const f = new Mock({
    'https://m.shop.com/p/1': { finalUrl: 'https://m.shop.com/', body: productHtml('Promo Accueil', 9.99) }, // redirected to homepage
    'https://shop.com/p/1': { status: 404 },
  });
  const r = await recover({ url, fetcher: f, original });
  assert.equal(r.ok, false);
  assert.equal(r.escalate, 'browser'); // original was a challenge → a browser could help
  assert.ok(r.trace.some((t) => t.reason === 'identity_mismatch'));
});

test('recover: site-declared amphtml is trusted (accepted without path check)', async () => {
  const url = 'https://ex.com/p/1';
  const body = '<html><head><link rel="amphtml" href="https://ex.com/amp/p/1"></head><body><div id="root"></div></body></html>';
  const original = origOf(result({ url, body }));
  const f = new Mock({ 'https://ex.com/amp/p/1': { finalUrl: 'https://ex.com/amp/p/1', body: productHtml('Table', 120) } });
  const r = await recover({ url, fetcher: f, original });
  assert.equal(r.ok, true);
  assert.equal(r.via.source, 'declared');
  assert.equal(r.via.kind, 'amphtml');
  assert.equal(r.product.name, 'Table');
});

test('recover: identity mismatch keeps the original incomplete product (never swaps)', async () => {
  const url = 'https://www.shop.com/p/1';
  const original = origOf(result({ url, body: productHtml('Chaise', null, { gtin13: '5410000000011' }) })); // incomplete, gtin 111…011
  const f = new Mock({
    'https://m.shop.com/p/1': { body: productHtml('Autre produit', 5, { gtin13: '5410000000022' }) }, // different GTIN
    'https://shop.com/p/1': { status: 404 },
  });
  const r = await recover({ url, fetcher: f, original });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'incomplete');
  assert.equal(r.product.gtin, '5410000000011'); // original kept, wrong candidate rejected
  assert.ok(r.trace.some((t) => t.reason === 'identity_mismatch'));
});

test('recover: js-shell original rescued by mobile SSR twin → browser avoided', async () => {
  const url = 'https://www.shop.com/p/1';
  const original = origOf(result({ url, body: SHELL }));
  assert.equal(original.verdict.verdict, 'js_not_rendered');
  const f = new Mock({ 'https://m.shop.com/p/1': { body: productHtml('Lampe', 39.9) } });
  const r = await recover({ url, fetcher: f, original });
  assert.equal(r.ok, true);
  assert.equal(r.escalate, 'none'); // recovered over HTTP, no browser needed
  assert.equal(r.product.name, 'Lampe');
});

test('recover: all representations definitively fail, no browser signal → escalate none', async () => {
  const url = 'https://www.shop.com/p/1';
  const original = origOf(result({ url, body: LONG_NOPROD })); // wrong_representation, not browser-recoverable
  const f = new Mock({ 'https://m.shop.com/p/1': { status: 404 }, 'https://shop.com/p/1': { status: 404 } });
  const r = await recover({ url, fetcher: f, original });
  assert.equal(r.ok, false);
  assert.equal(r.escalate, 'none');
});

test('recover: bounded by maxAttempts', async () => {
  const url = 'https://www.shop.com/p/1';
  const original = origOf({ ok: false, status: 403, url, requestedUrl: url, body: CHALLENGE, headers: {}, kind: 'html' });
  const f = new Mock({ 'https://m.shop.com/p/1': { status: 404 }, 'https://shop.com/p/1': { body: productHtml('X', 1) } });
  const r = await recover({ url, fetcher: f, original, maxAttempts: 1 });
  assert.equal(r.attempts, 1);
  assert.equal(f.calls.length, 1); // stopped after the first candidate despite a working second
});

test('recover: feed representations are skipped (not product HTML)', async () => {
  const url = 'https://ex.com/p/1';
  const body = '<html><head>'
    + '<link rel="alternate" type="application/rss+xml" href="https://ex.com/feed.rss">'
    + '<link rel="amphtml" href="https://ex.com/amp/p/1"></head><body><div id="root"></div></body></html>';
  const original = origOf(result({ url, body }));
  const f = new Mock({ 'https://ex.com/amp/p/1': { body: productHtml('Y', 2) } });
  const r = await recover({ url, fetcher: f, original });
  assert.equal(r.ok, true);
  assert.ok(!f.calls.includes('https://ex.com/feed.rss')); // feed never fetched
});

test('recover: invalid args → safe failure', async () => {
  const r = await recover({ url: '', fetcher: null });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'invalid_args');
});
