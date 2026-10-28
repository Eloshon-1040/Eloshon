/**
 * Bright Data Web Unlocker tier (v0.5.5) — offline. A fake fetchImpl captures the
 * request so we pin the wire shape (endpoint, auth, zone/url/format, and the
 * x-unblock-expect hydration header) without a real key or network. Also pins the
 * config/env resolution and the explicit "Manual expect not enabled" surfacing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webUnlockerConfig, webUnlockerAvailable, webUnlockerFetch, WEB_UNLOCKER_ENDPOINT, DEFAULT_ZONE } from '../unlock/web-unlocker.mjs';

test('webUnlockerConfig: reads key/zone from config or env; default zone; never throws', () => {
  // From config.brightData
  const a = webUnlockerConfig({ brightData: { apiKey: 'k1', zone: 'z1', country: 'be' } }, {});
  assert.deepEqual(a, { apiKey: 'k1', zone: 'z1', country: 'be', configured: true });
  // From env (both the plain and the hyphenated .env.local name)
  const b = webUnlockerConfig({}, { 'BRIGHTDATA_API_KEY': 'k2' });
  assert.equal(b.apiKey, 'k2'); assert.equal(b.zone, DEFAULT_ZONE); assert.equal(b.configured, true);
  const c = webUnlockerConfig({}, { 'BRIGHT-DATA-API-KEY': 'k3', 'BRIGHTDATA_UNLOCKER_ZONE': 'zx' });
  assert.equal(c.apiKey, 'k3'); assert.equal(c.zone, 'zx');
  // Unconfigured → inert
  const d = webUnlockerConfig({}, {});
  assert.equal(d.configured, false); assert.equal(d.apiKey, null); assert.equal(d.zone, DEFAULT_ZONE);
  assert.equal(webUnlockerAvailable({ brightData: { apiKey: 'x' } }, {}), true);
  assert.equal(webUnlockerAvailable({}, {}), false);
});

test('webUnlockerFetch: builds the correct request and returns unlocked HTML', async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return { status: 200, text: async () => '<html>' + 'x'.repeat(500) + '</html>' }; };
  const r = await webUnlockerFetch('https://shop/cat', { apiKey: 'KEY', zone: 'mcp_unlocker', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.ok(r.html.startsWith('<html>'));
  assert.ok(r.bytes > 500);
  // Wire shape
  assert.equal(seen.url, WEB_UNLOCKER_ENDPOINT);
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers.Authorization, 'Bearer KEY');
  const body = JSON.parse(seen.opts.body);
  assert.deepEqual(body, { zone: 'mcp_unlocker', url: 'https://shop/cat', format: 'raw' });
  assert.equal(body.headers, undefined); // no expect header unless asked
});

test('webUnlockerFetch: x-unblock-expect selector is sent for hydration waits', async () => {
  let body = null;
  const fetchImpl = async (_u, o) => { body = JSON.parse(o.body); return { status: 200, text: async () => 'y'.repeat(400) }; };
  await webUnlockerFetch('https://shop/cat', { apiKey: 'K', expect: '.card--article', country: 'be', fetchImpl });
  assert.deepEqual(body.headers, { 'x-unblock-expect': '.card--article' });
  assert.equal(body.country, 'be');
});

test('webUnlockerFetch: "Manual expect not enabled" is a clear error, not a silent empty page', async () => {
  const fetchImpl = async () => ({ status: 200, text: async () => 'Manual expect is not enabled for this zone' });
  const r = await webUnlockerFetch('https://shop/cat', { apiKey: 'K', expect: '.grid', fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.note, 'zone_manual_expect_disabled');
  assert.match(r.error, /Manual expect/i);
});

test('webUnlockerFetch: errors — no key, HTTP 4xx, empty body', async () => {
  const r0 = await webUnlockerFetch('https://s', { fetchImpl: async () => ({ status: 200, text: async () => 'z'.repeat(400) }) });
  assert.equal(r0.ok, false); assert.equal(r0.note, 'not_configured');
  const r1 = await webUnlockerFetch('https://s', { apiKey: 'K', fetchImpl: async () => ({ status: 401, text: async () => 'Unauthorized' }) });
  assert.equal(r1.ok, false); assert.equal(r1.status, 401); assert.equal(r1.note, 'http_error');
  const r2 = await webUnlockerFetch('https://s', { apiKey: 'K', fetchImpl: async () => ({ status: 200, text: async () => '' }) });
  assert.equal(r2.ok, false); assert.equal(r2.note, 'empty');
});
