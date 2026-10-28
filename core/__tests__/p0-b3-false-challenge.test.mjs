/**
 * P0 / B3 — a normal page of a protected site is not a challenge. The app's detector
 * matched bare anti-bot SDK names (datadome, _px, perimeterx, incapsula, imperva) in
 * the first 6,000 characters, BEFORE looking for structured product data, so a real
 * product or listing page loading those SDKs became a terminal BOT_CHALLENGE and
 * stopped the source. It now uses the challenge-PAGE markers of
 * shared/challenge/detect.mjs (one source for app and extension) and checks the
 * structured product data of a 2xx page first. Hand-built pages, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyResponse, STATUS } from '../detect.mjs';

const SDK_HEAD = `<head><title>Chaussures</title>
<script src="https://js.datadome.co/tags.js"></script><script>window.ddjskey="k";window._pxAppId="PXabc";</script>
<script src="https://cdn.imperva.test/incapsula-check.js"></script><!-- protected by perimeterx --></head>`;
const PRODUCT = `<!doctype html><html>${SDK_HEAD}<body><h1>Runner</h1>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Runner","offers":{"@type":"Offer","price":"59.90","priceCurrency":"EUR"}}</script>
${'<p>description</p>'.repeat(40)}</body></html>`;
const LISTING = `<!doctype html><html>${SDK_HEAD}<body><ul>${Array.from({ length: 12 }, (_, i) => `<li><a href="/p/${i}">Runner ${i}</a> <span>59,90 €</span></li>`).join('')}</ul>${'<p>texte</p>'.repeat(40)}</body></html>`;
const ok = (body, status = 200) => classifyResponse({ status, url: 'https://shop.test/p', requestedUrl: 'https://shop.test/p', contentType: 'text/html', body });

test('a product page loading DataDome / PerimeterX / Imperva SDKs is content, not a challenge', () => {
  const r = ok(PRODUCT);
  assert.equal(r.code, STATUS.OK, r.reason);
  assert.equal(r.terminal, false);
});

test('a listing page loading the same SDKs (no structured data) is content, not a challenge', () => {
  const r = ok(LISTING);
  assert.notEqual(r.code, STATUS.BOT_CHALLENGE, r.reason);
  assert.equal(r.terminal, false);
});

test('real challenge pages are still recognised', () => {
  const cf = `<!doctype html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cvId:'3'};</script><div>Checking your browser before accessing shop.test.</div></body></html>`;
  assert.equal(ok(cf, 403).code, STATUS.BOT_CHALLENGE);
  assert.equal(ok(cf, 200).code, STATUS.BOT_CHALLENGE, 'a 200 interstitial is a challenge too');
  const dd = `<!doctype html><html><body><iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=x"></iframe></body></html>`;
  assert.equal(ok(dd, 403).code, STATUS.CAPTCHA);
  const imp = `<!doctype html><html><head><title>Pardon Our Interruption</title></head><body>As you were browsing something about your browser made us think you were a bot.</body></html>`;
  assert.equal(ok(imp, 403).code, STATUS.BOT_CHALLENGE);
  const px = `<!doctype html><html><body><h1>Access to this page has been denied.</h1><div id="px-captcha"></div></body></html>`;
  assert.equal(ok(px, 403).code, STATUS.CAPTCHA);
});

test('a 403 with structured data is still a refusal (only a 2xx page is rescued as content)', () => {
  assert.equal(ok(PRODUCT, 403).code, STATUS.ACCESS_DENIED);
});
