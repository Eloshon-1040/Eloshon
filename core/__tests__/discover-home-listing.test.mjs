/**
 * A HOME page that is itself a listing (rows of priced cards in its inline state) is
 * read from the page: the whole-site sitemap of hub pages no longer replaces it, and
 * the cards without a link of their own come back as `cardsWithoutUrl` (nothing to
 * fetch). A shop whose sitemap lists its products keeps the sitemap-first path. Fake
 * fetcher, no network. Fixtures are fictitious.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverProducts } from '../discover.mjs';

const ORIGIN = 'https://stays.test';
const card = (i) => ({ title: `Chambre · Ville ${i}`, structuredDisplayPrice: { primaryLine: { price: `${100 + i} €`, qualifier: 'au total' } }, listing: { id: `${9000 + i}` }, contextualPictures: [{ picture: `https://img.stays.test/${i}.jpg` }] });
const homeHtml = (n) => `<html><head><title>Home</title></head><body><script>window.__STATE__ = ${JSON.stringify({ sections: [{ items: Array.from({ length: n }, (_, i) => card(i)) }] })};</script><nav><a href="/help">Aide</a></nav></body></html>`;
const sitemap = (urls) => `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;

function fakeFetcher(pages) {
  const calls = [];
  return {
    calls, userAgent: 'test', stats: { bytes: 0 }, jar: null,
    async get(url) {
      calls.push(url);
      const p = pages[url];
      if (!p) return { ok: false, status: 404, url, body: '', headers: {} };
      return { ok: true, status: 200, url, requestedUrl: url, body: p, headers: { 'content-type': url.endsWith('.xml') ? 'application/xml' : 'text/html' }, kind: url.endsWith('.xml') ? 'xml' : 'html' };
    },
    async getText(url) { return this.get(url); },
  };
}

test('home page with 8 priced id-only cards + a sitemap of hub pages → page-led, 8 cards without URL, no hub URL kept', async () => {
  const hubs = Array.from({ length: 30 }, (_, i) => `${ORIGIN}/city-${i}/stays/monthly`);
  const f = fakeFetcher({
    [`${ORIGIN}/robots.txt`]: `User-agent: *\nSitemap: ${ORIGIN}/sitemap.xml\n`,
    [`${ORIGIN}/sitemap.xml`]: sitemap(hubs),
    [`${ORIGIN}/`]: homeHtml(8),
  });
  const d = await discoverProducts(f, `${ORIGIN}/`, { maxProducts: 100, sitemapMin: 5 });
  assert.equal(d.report.entryListing, 8, 'the entry page was probed and read as a listing');
  assert.equal(d.cardsWithoutUrl.length, 8);
  assert.equal(d.cardsWithoutUrl[0].price, 100); assert.equal(d.cardsWithoutUrl[0].sku, '9000');
  assert.equal(d.urls.length, 0, 'hub pages of the sitemap are not products');
  assert.equal(d.report.diagnosis, 'ok');
  assert.equal(f.calls.filter((u) => u === `${ORIGIN}/`).length, 1, 'the entry page is fetched once (the probe is reused by the crawl)');
});

test('shop home page whose sitemap lists product pages → unchanged sitemap-first path, no entry probe', async () => {
  const products = Array.from({ length: 12 }, (_, i) => `${ORIGIN}/product/article-${i}`);
  const f = fakeFetcher({
    [`${ORIGIN}/robots.txt`]: `User-agent: *\nSitemap: ${ORIGIN}/sitemap.xml\n`,
    [`${ORIGIN}/sitemap.xml`]: sitemap(products),
    [`${ORIGIN}/`]: homeHtml(8),
  });
  const d = await discoverProducts(f, `${ORIGIN}/`, { maxProducts: 100, sitemapMin: 5 });
  assert.equal(d.report.method, 'sitemap');
  assert.equal(d.urls.length, 12);
  assert.ok(!f.calls.includes(`${ORIGIN}/`), 'a product sitemap: the home page is not even fetched');
  assert.equal((d.cardsWithoutUrl || []).length, 0);
});

test('home page without priced cards + a sitemap of hub pages → the historical sitemap path (probe found no listing)', async () => {
  const hubs = Array.from({ length: 10 }, (_, i) => `${ORIGIN}/guide-${i}`);
  const f = fakeFetcher({
    [`${ORIGIN}/robots.txt`]: `User-agent: *\nSitemap: ${ORIGIN}/sitemap.xml\n`,
    [`${ORIGIN}/sitemap.xml`]: sitemap(hubs),
    [`${ORIGIN}/`]: '<html><body><h1>Bienvenue</h1><a href="/guide-1">Guide</a></body></html>',
  });
  const d = await discoverProducts(f, `${ORIGIN}/`, { maxProducts: 100, sitemapMin: 5 });
  assert.equal(d.report.entryListing, undefined);
  assert.equal(d.report.method, 'sitemap');
  assert.equal(d.urls.length, 10);
});
