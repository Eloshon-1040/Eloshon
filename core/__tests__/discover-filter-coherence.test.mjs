/**
 * Filter coherence in the crawl (H2): when the entry URL carries a facet filter
 * (?categories=412 = a sub-category) and a later, paginated page comes back on a URL
 * that DROPPED the filter — the site clamped an out-of-range page to the unfiltered
 * list — its products are OUT of the filter and are not harvested. Generic, driven by
 * the URL, no site name. Query-param preservation across pages is checked too. Offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverProducts } from '../discover.mjs';
import { nextPageUrl } from '../pagination.mjs';

const ENTRY = 'https://s.test/boissons?categories=412';
// Page 1: four in-filter products, no visible next link → the crawl synthesizes page 2.
const page1 = `<html><body><main>${[1, 2, 3, 4].map((i) => `<a href="/product/spirit-${i}">Spirit ${i}</a>`).join('')}</main></body></html>`;
// Page 2 (out of range): the server served the UNFILTERED list (no categories=412) with
// other products — water/sodas that must NOT be harvested.
const page2 = `<html><body><main>${[1, 2, 3].map((i) => `<a href="/product/water-${i}">Water ${i}</a>`).join('')}</main></body></html>`;

function fetcher(onGet) {
  return {
    calls: [], userAgent: 'test', stats: { bytes: 0 }, jar: null,
    async get(url) { this.calls.push(url); return onGet(url); },
    async getText(url) { return this.get(url); },
  };
}
const ok = (finalUrl, body) => ({ ok: true, status: 200, url: finalUrl, requestedUrl: finalUrl, body, headers: { 'content-type': 'text/html' }, kind: 'html' });
const miss = (url) => ({ ok: false, status: 404, url, requestedUrl: url, body: '', headers: {}, error: 'HTTP 404' });

test('nextPageUrl preserves every query parameter (the filter is never dropped)', () => {
  assert.equal(nextPageUrl('https://s.test/boissons?categories=412&page=8'), 'https://s.test/boissons?categories=412&page=9');
  assert.equal(nextPageUrl('https://s.test/boissons?categories=412'), 'https://s.test/boissons?categories=412&page=2');
});

test('a paginated page that dropped the entry facet is not harvested', async () => {
  const f = fetcher((url) => {
    if (url === ENTRY) return ok(ENTRY, page1);
    if (/[?&]categories=412&page=2/.test(url)) return ok('https://s.test/boissons?page=2', page2); // server clamped: facet gone
    if (/robots\.txt|sitemap/.test(url)) return miss(url);
    return miss(url);
  });
  const d = await discoverProducts(f, ENTRY, { maxProducts: 50, maxPages: 6 });
  const slugs = d.urls.map((u) => u.split('/product/')[1]).sort();
  assert.deepEqual(slugs, ['spirit-1', 'spirit-2', 'spirit-3', 'spirit-4'], 'only the in-filter products are kept');
  assert.ok(!d.urls.some((u) => /water-/.test(u)), 'the unfiltered page past the end is not harvested');
  assert.equal(d.report.filterDropped, 1);
  assert.ok((d.report.notes || []).some((n) => /dropped the entry filter/.test(n)));
});

test('no false positive: when later pages keep the facet, their products ARE harvested', async () => {
  const more = `<html><body><main>${[5, 6].map((i) => `<a href="/product/spirit-${i}">Spirit ${i}</a>`).join('')}</main></body></html>`;
  const f = fetcher((url) => {
    if (url === ENTRY) return ok(ENTRY, page1);
    if (/[?&]categories=412&page=2/.test(url)) return ok('https://s.test/boissons?categories=412&page=2', more); // facet kept
    if (/[?&]categories=412&page=3/.test(url)) return ok('https://s.test/boissons?categories=412&page=3', '<html><body><main></main></body></html>');
    return miss(url);
  });
  const d = await discoverProducts(f, ENTRY, { maxProducts: 50, maxPages: 6 });
  const slugs = d.urls.map((u) => u.split('/product/')[1]).sort();
  assert.deepEqual(slugs, ['spirit-1', 'spirit-2', 'spirit-3', 'spirit-4', 'spirit-5', 'spirit-6']);
  assert.ok(!d.report.filterDropped);
});
