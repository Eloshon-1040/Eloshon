/**
 * Discovery in content type "video": a video sitemap gives the pages and their
 * cards as seeds; without a sitemap the crawl reads the repeated cards of the entry
 * page, follows the next page and the listing links, and queues video-page URLs —
 * never product-shaped ones. Product discovery is untouched. Fake fetcher, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverProducts } from '../discover.mjs';
import { dedupKey } from '../url-utils.mjs';

const ORIGIN = 'https://videos.test';
const card = (id, title) => `<article><a href="/w/${id}"><img src="/t/${id}.jpg" alt="${title}"></a><h3><a href="/w/${id}">${title}</a></h3><span class="duration">12:34</span></article>`;
const page = (ids, { next = null, extra = '' } = {}) => `<html><head><title>Vidéos</title>${next ? `<link rel="next" href="${next}">` : ''}</head><body><nav><a href="/videos/trending">Tendances</a><a href="/about">À propos</a></nav><main>${ids.map((id) => card(id, `Vidéo ${id}`)).join('')}${extra}</main>${next ? `<a href="${next}" rel="next">Suivant</a>` : ''}</body></html>`;

function fakeFetcher(pages) {
  const calls = [];
  return {
    calls, userAgent: 'test', stats: { bytes: 0 }, jar: null,
    async get(url) {
      calls.push(url);
      const p = pages[url];
      if (p == null) return { ok: false, status: 404, url, body: '', headers: {} };
      return { ok: true, status: 200, url, requestedUrl: url, body: p, headers: { 'content-type': url.endsWith('.xml') ? 'application/xml' : 'text/html' }, kind: url.endsWith('.xml') ? 'xml' : 'html' };
    },
    async getText(url) { return this.get(url); },
  };
}

test('video sitemap: the pages it describes are the items, their cards are seeds (title, thumbnail, duration)', async () => {
  const sitemap = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">${['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => `<url><loc>${ORIGIN}/w/${id}</loc><video:video><video:title>Vidéo ${id}</video:title><video:thumbnail_loc>${ORIGIN}/t/${id}.jpg</video:thumbnail_loc><video:duration>754</video:duration></video:video></url>`).join('')}<url><loc>${ORIGIN}/about</loc></url></urlset>`;
  const f = fakeFetcher({ [`${ORIGIN}/robots.txt`]: `User-agent: *\nSitemap: ${ORIGIN}/sitemap-video.xml\n`, [`${ORIGIN}/sitemap-video.xml`]: sitemap });
  const d = await discoverProducts(f, `${ORIGIN}/`, { maxProducts: 50, contentType: 'video' });
  assert.equal(d.report.contentType, 'video');
  assert.equal(d.report.method, 'sitemap');
  assert.deepEqual(d.urls.sort(), ['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => `${ORIGIN}/w/${id}`).sort());
  const seed = d.seeds.get(dedupKey(`${ORIGIN}/w/s1`));
  assert.ok(seed); assert.equal(seed.name, 'Vidéo s1'); assert.deepEqual(seed.images, [`${ORIGIN}/t/s1.jpg`]); assert.equal(seed.columns.duration, '12:34');
  assert.ok(!d.urls.includes(`${ORIGIN}/about`));
});

test('no sitemap: the entry page lists videos → crawl, next page followed, listing link crawled, only video-page URLs queued', async () => {
  const f = fakeFetcher({
    [`${ORIGIN}/videos/recent`]: page(['a1', 'a2', 'a3', 'a4'], { next: `${ORIGIN}/videos/recent?page=2`, extra: `<a href="/product/not-a-video">Boutique</a>` }),
    [`${ORIGIN}/videos/recent?page=2`]: page(['b1', 'b2', 'b3']),
    [`${ORIGIN}/videos/trending`]: page(['c1', 'c2', 'c3']),
  });
  const d = await discoverProducts(f, `${ORIGIN}/videos/recent`, { maxProducts: 50, maxPages: 10, contentType: 'video' });
  assert.equal(d.report.contentType, 'video');
  const ids = d.urls.map((u) => u.split('/w/')[1]).sort();
  assert.deepEqual(ids, ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'c1', 'c2', 'c3']);
  assert.ok(d.report.pagesCrawled >= 3, 'entry, page 2 and the trending listing were read');
  assert.ok(!d.urls.some((u) => /\/product\//.test(u)), 'a product-shaped link is not a video');
  assert.equal(d.seeds.get(dedupKey(`${ORIGIN}/w/a1`)).name, 'Vidéo a1');
});

test('home page without a video sitemap: read as a listing of videos (page-led), hub pages of the sitemap not taken as items', async () => {
  const hubs = Array.from({ length: 20 }, (_, i) => `${ORIGIN}/section-${i}/overview`);
  const f = fakeFetcher({
    [`${ORIGIN}/robots.txt`]: `User-agent: *\nSitemap: ${ORIGIN}/sitemap.xml\n`,
    [`${ORIGIN}/sitemap.xml`]: `<?xml version="1.0"?><urlset>${hubs.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`,
    [`${ORIGIN}/`]: page(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']),
  });
  const d = await discoverProducts(f, `${ORIGIN}/`, { maxProducts: 50, sitemapMin: 5, contentType: 'video' });
  assert.equal(d.report.entryListing, 6);
  assert.deepEqual(d.urls.map((u) => u.split('/w/')[1]).sort(), ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
});

test('"auto" on a client-rendered shell: the video sitemap switches discovery to videos (its entries are the items, with their cards)', async () => {
  const sitemap = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"><url><loc>${ORIGIN}/about</loc></url>${['x1', 'x2', 'x3', 'x4'].map((id) => `<url><loc>${ORIGIN}/w/${id}</loc><video:video><video:title>Vidéo ${id}</video:title><video:thumbnail_loc>${ORIGIN}/t/${id}.jpg</video:thumbnail_loc><video:duration>61</video:duration></video:video></url>`).join('')}</urlset>`;
  const shell = '<!doctype html><html><head><title>Médiathèque</title><meta property="og:type" content="website"></head><body><app-root></app-root><script src="/main.js"></script></body></html>';
  const f = fakeFetcher({ [`${ORIGIN}/robots.txt`]: '', [`${ORIGIN}/sitemap.xml`]: sitemap, [`${ORIGIN}/`]: shell });
  const d = await discoverProducts(f, `${ORIGIN}/`, { maxProducts: 50, contentType: 'auto' });
  assert.equal(d.report.contentType, 'video');
  assert.deepEqual(d.report.contentTypeDetected, { by: 'sitemap', entries: 4 });
  assert.deepEqual(d.urls.sort(), ['x1', 'x2', 'x3', 'x4'].map((id) => `${ORIGIN}/w/${id}`));
  assert.equal(d.seeds.get(dedupKey(`${ORIGIN}/w/x1`)).columns.duration, '1:01');
  // "auto" on a shop: products, no switch.
  const shop = fakeFetcher({ [`${ORIGIN}/c/shoes`]: `<html><body><ul>${[1, 2, 3, 4, 5, 6].map((i) => `<li><a href="/product/shoe-${i}">Shoe ${i}</a> <b>${50 + i},90 €</b></li>`).join('')}</ul></body></html>` });
  const s = await discoverProducts(shop, `${ORIGIN}/c/shoes`, { maxProducts: 50, contentType: 'auto' });
  assert.equal(s.report.contentType, 'product'); assert.equal(s.urls.length, 6);
});

test('product discovery untouched: default content type is product and product links are still the items', async () => {
  const f = fakeFetcher({
    [`${ORIGIN}/c/shoes`]: `<html><body><ul>${[1, 2, 3, 4, 5, 6].map((i) => `<li><a href="/product/shoe-${i}">Shoe ${i}</a> <b>${50 + i},90 €</b></li>`).join('')}</ul></body></html>`,
  });
  const d = await discoverProducts(f, `${ORIGIN}/c/shoes`, { maxProducts: 50 });
  assert.equal(d.report.contentType, 'product');
  assert.equal(d.urls.length, 6);
  assert.ok(d.urls.every((u) => /\/product\//.test(u)));
});
