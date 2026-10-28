/**
 * Edge-function client: request shape, config gating, and the FR message mapping
 * for success / quota / blocked / all-failed / network. Offline: injected fetch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEdgeClient, describeUnlock, describeEstimate } from '../edge-client.mjs';

const fakeFetch = (handler) => {
  const calls = [];
  const f = async (url, opts) => { const body = JSON.parse(opts.body); calls.push({ url, opts, body }); const r = handler(body); return { status: r.status ?? 200, async json() { return r.json; } }; };
  f.calls = calls;
  return f;
};

test('sends licence + action + auth header to the right endpoint', async () => {
  const f = fakeFetch(() => ({ json: { ok: true, html: 'x', provider: 'firecrawl', mode: 'normal', eloshon_credits: 2 } }));
  const c = createEdgeClient({ baseUrl: 'https://p.supabase.co/', anonKey: 'anon', license: 'LIC', fetchImpl: f });
  assert.ok(c.isConfigured());
  await c.unlock('https://shop/x');
  const call = f.calls[0];
  assert.equal(call.url, 'https://p.supabase.co/functions/v1/firecrawl-unlock');
  assert.equal(call.opts.headers.Authorization, 'Bearer anon');
  assert.equal(call.body.license, 'LIC');
  assert.equal(call.body.action, 'unlock');
  assert.equal(call.body.url, 'https://shop/x');
});

test('2b sync: pushRecipe posts the recipe as a candidate; profile fetches a shared one', async () => {
  const f = fakeFetch((body) => body.action === 'recipe-push'
    ? { json: { ok: true, host: body.host, version: 1 } }
    : { json: { ok: true, host: body.host, recipe: { manual_selectors: { card: '.pc', fields: { name: { selector: '.t', attr: null } } } } } });
  const c = createEdgeClient({ baseUrl: 'https://p.supabase.co', anonKey: 'anon', license: 'LIC', fetchImpl: f });
  const push = await c.pushRecipe('shop.example.com', { manual_selectors: { card: '.pc', fields: {} } });
  assert.equal(push.ok, true); assert.equal(push.version, 1);
  assert.equal(f.calls[0].body.action, 'recipe-push');
  assert.equal(f.calls[0].body.host, 'shop.example.com');
  assert.equal(f.calls[0].body.recipe.manual_selectors.card, '.pc');
  const prof = await c.profile('shop.example.com');
  assert.equal(prof.ok, true);
  assert.equal(prof.recipe.manual_selectors.fields.name.selector, '.t');
  assert.equal(f.calls[1].body.action, 'profile');
});

test('2b sync: pushRecipe is a no-op when the Edge client is not configured', async () => {
  const c = createEdgeClient({ baseUrl: '', anonKey: '', license: '' });
  const res = await c.pushRecipe('shop.example.com', { manual_selectors: {} });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not_configured');
});

test('not configured → no network, clear reason', async () => {
  const c = createEdgeClient({ baseUrl: '', anonKey: '', license: '' });
  assert.ok(!c.isConfigured());
  const res = await c.unlock('https://shop/x');
  assert.equal(res.reason, 'not_configured');
  assert.equal(describeUnlock(res).ok, false);
  assert.match(describeUnlock(res).message, /non configuré/);
});

test('network error is caught and mapped, never thrown', async () => {
  const f = async () => { throw new Error('ECONNREFUSED'); };
  const c = createEdgeClient({ baseUrl: 'https://p.supabase.co', anonKey: 'a', license: 'L', fetchImpl: f });
  const res = await c.unlock('https://shop/x');
  assert.equal(res.reason, 'network_error');
  assert.equal(describeUnlock(res).fallbackLocal, true);
});

test('describeUnlock: success message names the result + origin, NEVER the provider/mode', () => {
  const d = describeUnlock({ ok: true, html: '…', provider: 'brightdata', mode: 'unlocker', eloshon_credits: 5, from_profile: true });
  assert.equal(d.ok, true);
  assert.match(d.message, /5 crédit/);
  assert.match(d.message, /site déjà connu/);
  assert.doesNotMatch(d.message, /brightdata|unlocker/i, 'no provider or technical mode in the user message');
  assert.equal(d.provider, 'brightdata'); // still present on the object for the local technical journal
});

test('describeUnlock: quota exhausted → local fallback with counts', () => {
  const d = describeUnlock({ ok: false, reason: 'quota_exceeded', quota: { used: 1000, quota: 1000 } });
  assert.equal(d.ok, false);
  assert.equal(d.fallbackLocal, true);
  assert.match(d.message, /Quota.*1000\/1000/);
});

test('describeUnlock: all providers failed → not a local-fallback case', () => {
  const d = describeUnlock({ ok: false, reason: 'all_providers_failed', attempts: [] });
  assert.equal(d.fallbackLocal, false);
  assert.match(d.message, /Aucun fournisseur/);
});

test('describeEstimate: origin wording only (known site vs first discovery), no provider leak', () => {
  const p = describeEstimate({ ok: true, provider: 'brightdata', mode: 'unlocker', credits_per_page: 5, pages: 3, estimated_total: 15, from_profile: true });
  assert.equal(p.total, 15);
  assert.match(p.message, /≈ 15 crédit.*site déjà connu/);
  assert.doesNotMatch(p.message, /brightdata|unlocker|datacenter|asp/i);
  const d = describeEstimate({ ok: true, provider: 'firecrawl', mode: 'normal', credits_per_page: 2, pages: 1, estimated_total: 2, from_profile: false });
  assert.match(d.message, /première découverte/);
  assert.doesNotMatch(d.message, /firecrawl/i, 'the exact leak the user reported: no "via firecrawl"');
});
