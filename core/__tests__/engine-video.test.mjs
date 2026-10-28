/**
 * The engine in content type "video": a list page is harvested, each video page is
 * read by its own signals, rows are accepted without any price, deduplicated by page
 * URL (never by title), "sample first" delivers the rest from the list, and the
 * e-commerce path is untouched. Fake fetcher, fictitious pages, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScrape, formatReport } from '../engine.mjs';

const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const videoPage = (id, { title = `Conférence ${id}`, rich = true } = {}) => `<html><head><title>${title}</title>${ld({ '@context': 'https://schema.org', '@type': 'VideoObject', name: title, url: `https://videos.test/w/${id}`, thumbnailUrl: `https://cdn.videos.test/${id}.jpg`, duration: 'PT12M34S', ...(rich ? { description: `Résumé ${id}.`, uploadDate: '2026-09-01', embedUrl: `https://videos.test/embed/${id}`, publisher: { '@type': 'Organization', name: 'Chaîne' }, author: { '@type': 'Person', name: 'Jean Dupont' } } : {}) })}</head><body><h1>${title}</h1></body></html>`;
const card = (id, title) => `<article><a href="/w/${id}"><img src="/t/${id}.jpg" alt="${title}"></a><h3><a href="/w/${id}">${title}</a></h3><span class="duration">12:34</span></article>`;
const listPage = (ids) => `<html><head><title>Vidéos</title></head><body><main>${ids.map((id) => card(id, `Conférence ${id}`)).join('')}</main></body></html>`;

function fakeFetcher(pages) {
  const calls = [];
  return {
    calls, userAgent: 'test', stats: { bytes: 0 }, jar: null,
    async get(url) {
      calls.push(url);
      const body = pages[url];
      if (body == null) return { ok: false, status: 404, url, requestedUrl: url, body: '', headers: {}, error: 'HTTP 404' };
      return { ok: true, status: 200, url, requestedUrl: url, body, headers: { 'content-type': 'text/html' }, kind: 'html' };
    },
    async getText(url) { return this.get(url); },
  };
}

test('video run: the list page is harvested, 3 pages read, accepted without price, one duplicate URL dropped; report says the content type', async () => {
  const pages = {
    'https://videos.test/videos': listPage(['a', 'b', 'c']),
    'https://videos.test/w/a': videoPage('a'), 'https://videos.test/w/a?utm_source=x': videoPage('a'), 'https://videos.test/w/b': videoPage('b'), 'https://videos.test/w/c': videoPage('c'),
  };
  const f = fakeFetcher(pages);
  const { products, report } = await runScrape({
    store: { slug: '' }, urls: ['https://videos.test/videos', 'https://videos.test/w/a?utm_source=x'], fetcher: f, useBrowser: false, recovery: false,
    contentType: 'video', contentTypeRequested: 'auto', contentTypeDetected: 'video', defaultProductType: 'video',
  });
  assert.equal(report.contentType.type, 'video'); assert.equal(report.contentType.requested, 'auto');
  assert.equal(products.length, 3, 'three distinct videos');
  assert.equal(report.accepted, 3); assert.equal(report.toVerify, 0); assert.equal(report.excluded, 0);
  assert.equal(report.harvestedLinks, 2, 'the list page added the two pages not already queued');
  const p = products.find((x) => x.source_url === 'https://videos.test/w/a');
  assert.ok(p); assert.equal(p.name, 'Conférence a'); assert.equal(p.price, null); assert.equal(p.product_type, 'video');
  assert.equal(p.image_url, 'https://cdn.videos.test/a.jpg'); assert.equal(p.description, 'Résumé a.');
  assert.deepEqual(p.raw.columns, { duration: '12:34', published_at: '2026-09-01', embed_url: 'https://videos.test/embed/a' });
  assert.equal(p.source_category, 'Chaîne'); assert.equal(p.__eligibility.code, 'accepted_video');
  assert.ok(!JSON.stringify(products).includes('Dupont'), 'no person name in products');
  assert.match(formatReport(report), /content type:\s+video \(recognised automatically: video\)/);
  assert.match(formatReport(report), /liste de vidéos/);
});

test('sample first: the first seeded pages add nothing to their cards → the rest comes from the list without a request', async () => {
  const ids = ['s1', 's2', 's3', 's4', 's5'];
  const pages = Object.fromEntries(ids.map((id) => [`https://videos.test/w/${id}`, videoPage(id, { rich: false })]));
  const f = fakeFetcher(pages);
  const seeds = new Map(ids.map((id) => [`videos.test/w/${id}`, null]));
  // Seeds keyed like discovery does (dedupKey), built from the list's cards.
  const { dedupKey } = await import('../url-utils.mjs');
  seeds.clear();
  for (const id of ids) seeds.set(dedupKey(`https://videos.test/w/${id}`), { strategy: 'video-dom-grid', name: `Conférence ${id}`, images: [`https://cdn.videos.test/${id}.jpg`], sourceUrl: `https://videos.test/w/${id}`, canonicalUrl: `https://videos.test/w/${id}`, sku: id, columns: { duration: '12:34' } });
  const { products, report } = await runScrape({ store: { slug: '' }, urls: ids.map((id) => `https://videos.test/w/${id}`), seeds, fetcher: f, useBrowser: false, recovery: false, concurrency: 1, contentType: 'video', detailSample: 3 });
  assert.equal(products.length, 5);
  assert.equal(report.fetched, 3, 'three pages visited, then the list is trusted');
  assert.equal(report.detailPages.stoppedEarly, 'sample_no_data'); assert.equal(report.detailPages.skipped, 2); assert.equal(report.detailPages.visited, 3);
  assert.equal(report.accepted, 5);
  assert.match(formatReport(report), /stopped early: sample_no_data/);
});

test('sample first does not stop when pages add data (description, date) to their cards', async () => {
  const ids = ['r1', 'r2', 'r3', 'r4'];
  const pages = Object.fromEntries(ids.map((id) => [`https://videos.test/w/${id}`, videoPage(id)]));
  const { dedupKey } = await import('../url-utils.mjs');
  const seeds = new Map(ids.map((id) => [dedupKey(`https://videos.test/w/${id}`), { name: `Conférence ${id}`, images: [`https://cdn.videos.test/${id}.jpg`], sourceUrl: `https://videos.test/w/${id}`, canonicalUrl: `https://videos.test/w/${id}`, sku: id, columns: { duration: '12:34' } }]));
  const { report } = await runScrape({ store: { slug: '' }, urls: ids.map((id) => `https://videos.test/w/${id}`), seeds, fetcher: fakeFetcher(pages), useBrowser: false, recovery: false, concurrency: 1, contentType: 'video', detailSample: 2 });
  assert.equal(report.fetched, 4); assert.equal(report.detailPages.completed, 4); assert.equal(report.detailPages.stoppedEarly, null);
});

test('video quality rule inside the engine: a page with a title and an address but neither thumbnail nor description is kept "to verify"', async () => {
  const thin = `<html><head><title>Sans vignette</title><meta property="og:type" content="video.other"><meta property="og:title" content="Sans vignette"></head><body></body></html>`;
  const { products, report } = await runScrape({ store: { slug: '' }, urls: ['https://videos.test/w/thin'], fetcher: fakeFetcher({ 'https://videos.test/w/thin': thin }), useBrowser: false, recovery: false, contentType: 'video' });
  assert.equal(products.length, 1); assert.equal(report.toVerify, 1);
  assert.equal(products[0].__eligibility.code, 'to_verify_video_thin');
});

test('e-commerce unchanged: a product page is accepted with its price; a video page in product mode is not a product', async () => {
  const product = `<html><head><title>Perceuse</title>${ld({ '@context': 'https://schema.org', '@type': 'Product', name: 'Perceuse X', sku: 'PX1', image: 'https://cdn.shop.test/px1.jpg', offers: { '@type': 'Offer', price: 89.9, priceCurrency: 'EUR' } })}</head><body><h1>Perceuse X</h1></body></html>`;
  const pages = { 'https://shop.test/product/px1': product, 'https://shop.test/w/v1': videoPage('v1') };
  const { products, report } = await runScrape({ store: { slug: '' }, urls: ['https://shop.test/product/px1', 'https://shop.test/w/v1'], fetcher: fakeFetcher(pages), useBrowser: false, recovery: false });
  assert.equal(report.contentType.type, 'product');
  const accepted = products.filter((p) => p.__eligibility.status === 'accepted');
  assert.equal(accepted.length, 1); assert.equal(accepted[0].name, 'Perceuse X'); assert.equal(accepted[0].price, 89.9);
  // The video page carries no price and no product identity: never accepted as a product (at most "to verify", as any titled page without a price).
  assert.ok(products.every((p) => p.price != null || p.__eligibility.status !== 'accepted'));
  assert.ok(!products.some((p) => p.raw && p.raw.columns), 'no video column in product mode');
  assert.equal(report.detailPages, undefined, 'no sample-first on products');
});
