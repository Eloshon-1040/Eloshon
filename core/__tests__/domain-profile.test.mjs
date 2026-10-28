/**
 * Domain profiles — persistent per-host memory of what worked. Pure logic +
 * an injected store; ADDITIVE hints only (never a rigid rule). Offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hostKey, mergeProfile, profileHints, urlShapeOf, createProfileStore,
  linkFilterUsable, linkFilterStale, recordLinkFilterOutcome, LINK_FILTER_TTL_MS,
} from '../domain-profile.mjs';

test('hostKey: www-insensitive, lowercased', () => {
  assert.equal(hostKey('https://www.Microfluo.net/fr/x'), 'microfluo.net');
  assert.equal(hostKey('https://microfluo.net'), 'microfluo.net');
});

test('mergeProfile: records meaningful fields, counts runs, dates success only on a yield', () => {
  const t1 = '2026-09-18T10:00:00Z';
  let p = mergeProfile(null, { method: 'unlock', browser: 'nodriver', blockedBy: 'BOT_CHALLENGE', productCount: 25, urlShape: '/#-slug.html', needsUnlock: true }, t1);
  assert.equal(p.method, 'unlock'); assert.equal(p.browser, 'nodriver'); assert.equal(p.blockedBy, 'BOT_CHALLENGE');
  assert.equal(p.lastProductCount, 25); assert.equal(p.needsUnlock, true); assert.equal(p.runs, 1); assert.equal(p.lastSuccess, t1);
  // a later run with 0 products keeps the last known-good method and does NOT bump lastSuccess
  const t2 = '2026-09-18T12:00:00Z';
  p = mergeProfile(p, { productCount: 0 }, t2);
  assert.equal(p.method, 'unlock'); assert.equal(p.runs, 2); assert.equal(p.lastSuccess, t1); assert.equal(p.updatedAt, t2);
});

test('profileHints: additive hints only (sitemaps + advisory flags), never rigid', () => {
  const h = profileHints({ sitemaps: ['https://x/sitemap.xml'], needsBrowser: true, needsUnlock: true, method: 'sitemap' });
  assert.deepEqual(h.sitemapHints, ['https://x/sitemap.xml']);
  assert.equal(h.preferBrowser, true); assert.equal(h.preferUnlock, true); assert.equal(h.knownMethod, 'sitemap');
  const none = profileHints(null);
  assert.deepEqual(none.sitemapHints, []); assert.equal(none.preferBrowser, false);
});

test('urlShapeOf: generic product-URL shape (host-agnostic)', () => {
  assert.equal(urlShapeOf('https://microfluo.net/fr/463-testeurs/5471-92458-bubble.html'), '/fr/#-slug');
  assert.equal(urlShapeOf('https://shop/products/mens-runner'), '/products/mens-runner');
  assert.equal(urlShapeOf('https://shop/p/005010101'), '/p/#');
});

test('createProfileStore: record → get → hints round-trip via an in-memory store', () => {
  let mem = {};
  const store = createProfileStore({ read: () => mem, write: (m) => { mem = m; } });
  store.record('https://www.microfluo.net/fr/463-testeurs', { method: 'unlock', browser: 'nodriver', productCount: 25, needsUnlock: true, sitemaps: ['https://microfluo.net/sitemap.xml'] });
  const p = store.get('https://microfluo.net/anything');   // same host key
  assert.equal(p.method, 'unlock'); assert.equal(p.lastProductCount, 25);
  assert.equal(store.hints('https://microfluo.net/x').preferUnlock, true);
  assert.ok(mem['microfluo.net']); // persisted through the injected writer
});

// ---- link_filter (3rd learned artifact, same lifecycle as manual_selectors) ----

const LF = { container: 'main .product-grid', url_templates: ['/products/'] };

test('link_filter: stored verbatim, offered as a hint, round-trips through the store', () => {
  const t1 = '2026-09-25T10:00:00Z';
  let mem = {};
  const store = createProfileStore({ read: () => mem, write: (m) => { mem = m; } });
  store.record('https://www.shop.example/collections/all', { linkFilter: LF }, t1);
  const p = store.get('https://shop.example/x');
  assert.deepEqual(p.link_filter, LF); // verbatim == Supabase recipes.link_filter column
  assert.equal(p.linkFilterMeta.status, 'candidate'); assert.equal(p.linkFilterMeta.version, 1);
  assert.deepEqual(store.hints('https://shop.example/x').linkFilter, LF);
});

test('link_filter outcome: failure counts the streak, success clears it and re-verifies', () => {
  const t1 = '2026-09-25T10:00:00Z', t2 = '2026-09-25T11:00:00Z', t3 = '2026-09-25T12:00:00Z';
  let p = mergeProfile(null, { linkFilter: LF }, t1);
  p = mergeProfile(p, { linkFilterOutcome: false }, t2);
  assert.equal(p.linkFilterMeta.fail_count, 1); assert.equal(p.linkFilterMeta.consecutive_fails, 1);
  p = mergeProfile(p, { linkFilterOutcome: true }, t3);
  assert.equal(p.linkFilterMeta.success_count, 1); assert.equal(p.linkFilterMeta.consecutive_fails, 0);
  assert.equal(p.linkFilterMeta.last_verified, t3);
  // outcome without a stored filter is a no-op (nothing to bump)
  const bare = mergeProfile(null, { linkFilterOutcome: true }, t1);
  assert.equal(bare.linkFilterMeta, undefined);
});

test('link_filter lifecycle: 3 consecutive fails deprecate, a later success revives', () => {
  const t = (h) => `2026-09-25T0${h}:00:00Z`;
  let p = mergeProfile(null, { linkFilter: LF }, t(1));
  for (const h of [2, 3, 4]) p = mergeProfile(p, { linkFilterOutcome: false }, t(h));
  assert.equal(p.linkFilterMeta.status, 'deprecated');
  assert.equal(linkFilterUsable(p), false);
  assert.equal(profileHints(p).linkFilter, null); // deprecated ⇒ not offered
  // a success (e.g. opportunistic re-verify) resurrects it
  p = recordLinkFilterOutcome(p, true, t(5));
  assert.equal(p.linkFilterMeta.status, 'candidate');
  assert.equal(linkFilterUsable(p), true);
  assert.deepEqual(profileHints(p).linkFilter, LF);
});

test('link_filter TTL: stale after ~60 days without verification', () => {
  const t1 = '2026-01-01T00:00:00Z';
  const p = mergeProfile(null, { linkFilter: LF }, t1);
  assert.equal(linkFilterStale(p, Date.parse(t1) + LINK_FILTER_TTL_MS - 1000), false);
  assert.equal(linkFilterStale(p, Date.parse(t1) + LINK_FILTER_TTL_MS + 1000), true);
  // hints surface the flag (very old designation ⇒ stale by wall clock)
  const old = mergeProfile(null, { linkFilter: LF }, '2020-01-01T00:00:00Z');
  assert.equal(profileHints(old).linkFilterStale, true);
  // no profile ⇒ base hints only, same contract as the other recipe avenues
  assert.equal(profileHints(null).linkFilter, undefined);
});

test('link_filter meta: version resets when container OR url_templates change, kept otherwise', () => {
  const t = (h) => `2026-09-25T0${h}:00:00Z`;
  let p = mergeProfile(null, { linkFilter: { container: '#a', url_templates: ['/p/'] } }, t(1));
  p = mergeProfile(p, { linkFilterOutcome: true }, t(2));
  // same designation re-captured → meta (counters) kept
  p = mergeProfile(p, { linkFilter: { container: '#a', url_templates: ['/p/'] } }, t(3));
  assert.equal(p.linkFilterMeta.version, 1); assert.equal(p.linkFilterMeta.success_count, 1);
  // container changed → fresh meta, version bumped
  p = mergeProfile(p, { linkFilter: { container: '#b', url_templates: ['/p/'] } }, t(4));
  assert.equal(p.linkFilterMeta.version, 2); assert.equal(p.linkFilterMeta.success_count, 0);
  // url_templates changed → same reset
  p = mergeProfile(p, { linkFilter: { container: '#b', url_templates: ['/q/'] } }, t(5));
  assert.equal(p.linkFilterMeta.version, 3);
});

test('link_filter: an observation without one (or an empty one) never erases the stored filter', () => {
  const t1 = '2026-09-25T10:00:00Z', t2 = '2026-09-25T11:00:00Z', t3 = '2026-09-25T12:00:00Z';
  let p = mergeProfile(null, { linkFilter: LF }, t1);
  p = mergeProfile(p, { productCount: 12 }, t2);          // unrelated observation
  assert.deepEqual(p.link_filter, LF); assert.equal(p.linkFilterMeta.version, 1);
  p = mergeProfile(p, { linkFilter: {} }, t3);            // unusable designation ignored
  assert.deepEqual(p.link_filter, LF); assert.equal(p.linkFilterMeta.version, 1);
});

test('link_filter: url_templates with backslashes survive the JSON round-trip (Supabase column)', () => {
  const lf = { container: 'main', url_templates: ['^/products/\\d+-[a-z\\-]+$'] };
  const p = mergeProfile(null, { linkFilter: lf }, '2026-09-25T10:00:00Z');
  const revived = JSON.parse(JSON.stringify(p)); // == persist to jsonb and read back
  assert.deepEqual(revived.link_filter.url_templates, lf.url_templates);
  assert.equal(typeof revived.link_filter.url_templates[0], 'string'); // never a RegExp object
  assert.ok(new RegExp(revived.link_filter.url_templates[0]).test('/products/42-blue-mug'));
  assert.ok(!new RegExp(revived.link_filter.url_templates[0]).test('/collections/all'));
});
