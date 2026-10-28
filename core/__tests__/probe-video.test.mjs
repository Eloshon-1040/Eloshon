/**
 * The analysis (Analyser) recognises a video site on the pasted page and reports the
 * video fields it reads for free; forced to "products", the same page is a no-signal.
 * No network: fake fetcher.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeSource, formatProbe } from '../probe.mjs';

class Mock {
  constructor(map) { this.map = map; this.stats = { requests: 0, ok: 0, blocked: 0 }; this.userAgent = 't'; }
  async get(url) {
    this.stats.requests++;
    const e = this.map[url] || { status: 404 };
    const status = e.status ?? 200; const ok = status < 400; if (ok) this.stats.ok++;
    return { ok, status, url, requestedUrl: url, body: ok ? (e.body ?? '') : '', headers: {}, error: ok ? null : `HTTP ${status}` };
  }
  async getText(url) { return this.get(url); }
}
const card = (id, title) => `<article><a href="/w/${id}"><img src="/t/${id}.jpg" alt="${title}"></a><h3><a href="/w/${id}">${title}</a></h3><span class="duration">12:34</span><time datetime="2026-09-01">1 sept.</time></article>`;
const LIST = `<html><head><title>Vidéos</title></head><body><main>${['a', 'b', 'c', 'd'].map((id) => card(id, `Vidéo ${id}`)).join('')}</main></body></html>`;
const entry = 'https://videos.test/videos/recent';

test('auto: a page that lists videos → content type video, free video lane, video fields', async () => {
  const p = await probeSource(entry, { fetcher: new Mock({ 'https://videos.test/robots.txt': { body: '' }, [entry]: { body: LIST } }) });
  assert.equal(p.content_type.requested, 'auto'); assert.equal(p.content_type.detected, 'video'); assert.equal(p.content_type.type, 'video');
  assert.equal(p.best_path, 'video-list'); assert.equal(p.diagnosis, 'ok'); assert.equal(p.product_count, 4);
  assert.deepEqual(p.fields, ['name', 'url', 'image', 'description', 'duration', 'published', 'views', 'embed']);
  for (const k of ['name', 'url', 'image', 'duration', 'published']) assert.equal(p.field_status[k], 'free', k);
  assert.equal(p.field_status.views, 'absent');
  assert.match(p.headline, /vidéo\(s\) détectée\(s\)/);
  const txt = formatProbe(p);
  assert.match(txt, /type de contenu :\s+vidéos \(reconnu automatiquement\)/);
  assert.match(txt, /titre :/);
});

test('auto on a client-rendered shell: the video sitemap decides (free), the sample is its first entry', async () => {
  const shell = '<!doctype html><html><head><title>Médiathèque</title><meta property="og:type" content="website"></head><body><app-root></app-root><script src="/main.js"></script></body></html>';
  const sitemap = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">${['x1', 'x2', 'x3'].map((id) => `<url><loc>https://videos.test/w/${id}</loc><video:video><video:title>Vidéo ${id}</video:title><video:thumbnail_loc>https://videos.test/t/${id}.jpg</video:thumbnail_loc><video:description>Résumé.</video:description><video:duration>61</video:duration><video:publication_date>2026-09-01</video:publication_date></video:video></url>`).join('')}</urlset>`;
  const p = await probeSource('https://videos.test/', { fetcher: new Mock({ 'https://videos.test/robots.txt': { body: `Sitemap: https://videos.test/sitemap.xml` }, 'https://videos.test/sitemap.xml': { body: sitemap }, 'https://videos.test/': { body: shell } }) });
  assert.equal(p.content_type.type, 'video'); assert.deepEqual(p.content_type.signals, ['sitemap_videos:3']);
  assert.equal(p.best_path, 'video-list'); assert.equal(p.coverage_source, 'video-sitemap'); assert.equal(p.product_count, 3); assert.equal(p.diagnosis, 'ok');
  for (const k of ['name', 'url', 'image', 'description', 'duration', 'published']) assert.equal(p.field_status[k], 'free', k);
});

test('forced to products, the same page gives no product signal; forced to videos, a single video page is read', async () => {
  const p = await probeSource(entry, { fetcher: new Mock({ 'https://videos.test/robots.txt': { body: '' }, [entry]: { body: LIST } }), contentType: 'product' });
  assert.equal(p.content_type.type, 'product'); assert.equal(p.content_type.detected, 'video');
  assert.notEqual(p.best_path, 'video-list'); assert.notEqual(p.diagnosis, 'ok', 'no product reachable on a video list');
  assert.deepEqual(p.fields.slice(0, 2), ['name', 'price'], 'product fields');
  const single = `<html><head><title>Clip</title><meta property="og:type" content="video.other"><meta property="og:title" content="Clip du festival"><meta property="og:image" content="https://cdn.videos.test/og.jpg"><meta property="og:video" content="https://videos.test/embed/og1"></head><body></body></html>`;
  const q = await probeSource('https://videos.test/w/og1', { fetcher: new Mock({ 'https://videos.test/robots.txt': { body: '' }, 'https://videos.test/w/og1': { body: single } }), contentType: 'video' });
  assert.equal(q.best_path, 'video-page'); assert.equal(q.product_count, 1); assert.equal(q.field_status.embed, 'free');
});
