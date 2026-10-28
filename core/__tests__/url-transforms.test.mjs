/**
 * F1 — url-transforms unit tests. Pure, offline, no network. Proves the generic
 * host-shape rules, the site-declared representation reader, and the combined
 * ordering/dedup — without touching any existing engine behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSFORMS, urlVariants, declaredRepresentations, alternativeRepresentations,
} from '../url-transforms.mjs';

// ── individual generic host transforms ───────────────────────────────────────
test('mobile_www: www. → m., preserves path/query/hash', () => {
  assert.equal(TRANSFORMS.mobile_www('https://www.example.com/p/1?a=2#x'), 'https://m.example.com/p/1?a=2#x');
  assert.equal(TRANSFORMS.mobile_www('https://example.com/p'), null);   // no www.
  assert.equal(TRANSFORMS.mobile_www('https://m.example.com/p'), null); // already m.
});
test('mobile_apex: apex host (1 dot) → m.', () => {
  assert.equal(TRANSFORMS.mobile_apex('https://example.com/p'), 'https://m.example.com/p');
  assert.equal(TRANSFORMS.mobile_apex('https://www.example.com/p'), null); // www handled elsewhere
  assert.equal(TRANSFORMS.mobile_apex('https://blog.example.com/p'), null); // subdomain → mobile_sub
});
test('mobile_sub: subdomained host (≥2 dots) → m.<host>', () => {
  assert.equal(TRANSFORMS.mobile_sub('https://blog.example.com/p'), 'https://m.blog.example.com/p');
  assert.equal(TRANSFORMS.mobile_sub('https://example.com/p'), null);
  assert.equal(TRANSFORMS.mobile_sub('https://m.blog.example.com/p'), null); // already m.
});
test('drop_www: www. → apex', () => {
  assert.equal(TRANSFORMS.drop_www('https://www.example.com/p?q=1'), 'https://example.com/p?q=1');
  assert.equal(TRANSFORMS.drop_www('https://example.com/p'), null);
});
test('port is preserved by host transforms', () => {
  assert.equal(TRANSFORMS.mobile_www('https://www.example.com:8443/p'), 'https://m.example.com:8443/p');
});

// ── urlVariants (ordered, applicable-only, deduped, device-aware) ─────────────
test('urlVariants: www host (auto) → m. then apex, in order', () => {
  const v = urlVariants('https://www.example.com/p');
  assert.deepEqual(v.map((x) => x.url), ['https://m.example.com/p', 'https://example.com/p']);
  assert.deepEqual(v.map((x) => x.name), ['mobile_www', 'drop_www']);
  assert.ok(v.every((x) => x.source === 'heuristic'));
});
test('urlVariants: apex host (auto) → single m. variant', () => {
  assert.deepEqual(urlVariants('https://example.com/p').map((x) => x.url), ['https://m.example.com/p']);
});
test('urlVariants: device filtering', () => {
  assert.deepEqual(urlVariants('https://www.example.com/p', { device: 'desktop' }).map((x) => x.name), ['drop_www']);
  assert.deepEqual(urlVariants('https://www.example.com/p', { device: 'mobile' }).map((x) => x.name), ['mobile_www']);
});
test('urlVariants: already-mobile / non-applicable → empty', () => {
  assert.deepEqual(urlVariants('https://m.example.com/p'), []);
  assert.deepEqual(urlVariants('https://example.com/p', { device: 'desktop' }), []); // no www to drop
});
test('urlVariants: invalid input → empty, no throw', () => {
  assert.deepEqual(urlVariants(''), []);
  assert.deepEqual(urlVariants(null), []);
  assert.deepEqual(urlVariants('not a url'), []); // host has no dot → no rule applies
});
test('urlVariants: ccTLD host is treated as subdomained (documented candidate)', () => {
  // 2-dot apex like example.co.uk → mobile_sub candidate m.example.co.uk (the
  // ladder validates it; a wrong guess simply fails validation, never used blindly).
  assert.deepEqual(urlVariants('https://example.co.uk/p').map((x) => x.url), ['https://m.example.co.uk/p']);
});

// ── declaredRepresentations (site-exposed, reliable) ─────────────────────────
const DECL_HTML = `<!doctype html><html><head>
<link rel="canonical" href="https://ex.com/p/1">
<link rel="amphtml" href="/amp/p/1">
<link rel="alternate" media="only screen and (max-width: 640px)" href="https://m.ex.com/p/1">
<link rel="alternate" type="application/rss+xml" href="/feed.rss">
<link rel="alternate" type="application/atom+xml" href="/feed.atom">
<link rel="alternate" type="application/json" href="/feed.json">
<meta property="og:url" content="https://ex.com/p/1">
</head><body></body></html>`;

test('declaredRepresentations: parses canonical/amphtml/mobile/feeds/og, resolves relative', () => {
  const d = declaredRepresentations(DECL_HTML, 'https://ex.com/p/1');
  const byKind = Object.fromEntries(d.map((x) => [x.kind, x.url]));
  assert.equal(byKind.canonical, 'https://ex.com/p/1');
  assert.equal(byKind.amphtml, 'https://ex.com/amp/p/1');   // relative → absolute
  assert.equal(byKind.mobile, 'https://m.ex.com/p/1');
  assert.equal(byKind.feed_rss, 'https://ex.com/feed.rss');
  assert.equal(byKind.feed_atom, 'https://ex.com/feed.atom');
  assert.equal(byKind.feed_json, 'https://ex.com/feed.json');
  assert.equal(byKind.og_url, 'https://ex.com/p/1');
  assert.ok(d.every((x) => x.source === 'declared'));
});
test('declaredRepresentations: empty/invalid html → empty', () => {
  assert.deepEqual(declaredRepresentations('', 'https://ex.com'), []);
  assert.deepEqual(declaredRepresentations('<html><body>no links</body></html>', 'https://ex.com'), []);
});

// ── alternativeRepresentations (combined, ordered, deduped) ──────────────────
test('alternativeRepresentations: declared first, original excluded, cross-source dedup', () => {
  const list = alternativeRepresentations({ url: 'https://ex.com/p/1', html: DECL_HTML });
  // canonical & og_url equal the original → dropped; declared distinct kept.
  const urls = list.map((x) => x.url);
  assert.ok(!urls.includes('https://ex.com/p/1'), 'original excluded');
  assert.equal(list[0].source, 'declared');
  assert.ok(urls.includes('https://ex.com/amp/p/1'));
  // heuristic mobile_apex would produce m.ex.com/p/1 — already declared as mobile → single entry.
  assert.equal(urls.filter((u) => u === 'https://m.ex.com/p/1').length, 1);
});
test('alternativeRepresentations: html omitted → heuristic host variants only', () => {
  const list = alternativeRepresentations({ url: 'https://www.example.com/p' });
  assert.deepEqual(list.map((x) => x.url), ['https://m.example.com/p', 'https://example.com/p']);
  assert.ok(list.every((x) => x.source === 'heuristic'));
});
test('alternativeRepresentations: includeOriginal puts the original first', () => {
  const list = alternativeRepresentations({ url: 'https://www.example.com/p', includeOriginal: true });
  assert.equal(list[0].url, 'https://www.example.com/p');
  assert.equal(list[0].source, 'original');
});
test('alternativeRepresentations: invalid input → empty', () => {
  assert.deepEqual(alternativeRepresentations({ url: '' }), []);
  assert.deepEqual(alternativeRepresentations({}), []);
});
