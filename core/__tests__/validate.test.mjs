/**
 * F2 — enriched validator tests. Pure, offline. Proves each verdict the recovery
 * ladder acts on, built on the UNCHANGED classifyResponse + extractProduct.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, VERDICT } from '../validate.mjs';

const ld = (obj) => `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head><body></body></html>`;
const productHtml = (name, price) => ld({ '@type': 'Product', name, ...(price != null ? { offers: { price: String(price), priceCurrency: 'EUR' } } : {}) });
const CHALLENGE = '<html><head><title>Just a moment...</title></head><body>Checking your browser. /cdn-cgi/challenge-platform ray id</body></html>';
const CAPTCHA = '<html><body><div class="g-recaptcha"></div> verify you are human</body></html>';
const res = (o = {}) => ({
  status: o.status ?? 200, url: o.url ?? 'https://x/p/1', requestedUrl: o.requestedUrl ?? (o.url ?? 'https://x/p/1'),
  body: o.body ?? '', error: o.error ?? null, headers: o.headers ?? {},
  ok: o.ok ?? ((o.status ?? 200) >= 200 && (o.status ?? 200) < 300 && !o.error),
});

test('validate: usable (name + price)', () => {
  const v = validate(res({ body: productHtml('Chaise', 89.9) }));
  assert.equal(v.verdict, VERDICT.USABLE);
  assert.equal(v.usable, true);
  assert.equal(v.product.name, 'Chaise');
});
test('validate: incomplete (name, no price)', () => {
  const v = validate(res({ body: '<html><head><meta property="og:title" content="Produit X"></head><body></body></html>' }));
  assert.equal(v.verdict, VERDICT.INCOMPLETE);
  assert.equal(v.incomplete, true);
  assert.equal(v.product.name, 'Produit X');
});
test('validate: wrong_representation (200, real content, no product, no title)', () => {
  const body = `<html><body><h1>Nos magasins</h1><p>${'texte '.repeat(400)}</p></body></html>`;
  const v = validate(res({ body }));
  assert.equal(v.verdict, VERDICT.WRONG_REPRESENTATION);
  assert.equal(v.product, null);
});
test('validate: empty (blank 200 body)', () => {
  const v = validate(res({ body: '   ' }));
  assert.equal(v.verdict, VERDICT.EMPTY);
  assert.equal(v.product, null);
});
test('validate: js_not_rendered (SPA shell) → browserRecoverable', () => {
  const v = validate(res({ body: '<html><body><div id="root"></div></body></html>' }));
  assert.equal(v.verdict, VERDICT.JS_NOT_RENDERED);
  assert.equal(v.browserRecoverable, true);
});
test('validate: challenge (Cloudflare body wins over any title)', () => {
  const v = validate(res({ status: 403, ok: false, body: CHALLENGE }));
  assert.equal(v.verdict, VERDICT.CHALLENGE);
  assert.equal(v.browserRecoverable, true);
});
test('validate: captcha', () => {
  const v = validate(res({ body: CAPTCHA }));
  assert.equal(v.verdict, VERDICT.CAPTCHA);
  assert.equal(v.browserRecoverable, true);
});
test('validate: auth_required (401) is definitive', () => {
  const v = validate(res({ status: 401, ok: false, body: '' }));
  assert.equal(v.verdict, VERDICT.AUTH_REQUIRED);
  assert.equal(v.authRequired, true);
  assert.equal(v.definitive, true);
  assert.equal(v.browserRecoverable, false);
});
test('validate: http_temporary (429 + timeout) is retriable, not browser-recoverable', () => {
  const a = validate(res({ status: 429, ok: false, body: '' }));
  assert.equal(a.verdict, VERDICT.HTTP_TEMPORARY);
  assert.equal(a.retriable, true);
  assert.equal(a.browserRecoverable, false);
  const b = validate(res({ status: 0, ok: false, error: 'timeout' }));
  assert.equal(b.verdict, VERDICT.HTTP_TEMPORARY);
});
test('validate: http_definitive (403 plain)', () => {
  const v = validate(res({ status: 403, ok: false, body: 'Forbidden' }));
  assert.equal(v.verdict, VERDICT.HTTP_DEFINITIVE);
  assert.equal(v.definitive, true);
});
test('validate: opts.product override skips extraction', () => {
  const v = validate(res({ body: 'ignored' }), { product: { name: 'Y', price: 5 } });
  assert.equal(v.verdict, VERDICT.USABLE);
  assert.equal(v.product.name, 'Y');
});
