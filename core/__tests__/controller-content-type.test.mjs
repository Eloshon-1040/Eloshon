/**
 * The whole app path for a video site, "Type de contenu : Automatique": the entry page
 * is recognised as videos (one request, reused by discovery), the videos are read,
 * accepted without price, declared product_type "video", written to products.json
 * (duration, date, player as additive columns) and to the CSV, the ledger has its
 * free line, and the job list / product list carry the content type. Offline.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../../app/controller.mjs';
import { createLedger } from '../metering/ledger.mjs';
import { createMeter } from '../metering/meter.mjs';
import { queryLedger } from '../metering/reader.mjs';
import { ProviderRuntime } from '../providers/runtime.mjs';
import { isConfigured } from '../providers/registry.mjs';

const ORIGIN = 'https://videos.test/';
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const card = (id, title) => `<article><a href="/w/${id}"><img src="/t/${id}.jpg" alt="${title}"></a><h3><a href="/w/${id}">${title}</a></h3><span class="duration">12:34</span></article>`;
const HOME = `<html><head><title>Médiathèque</title></head><body><main>${['a', 'b', 'c', 'd'].map((id) => card(id, `Conférence ${id}`)).join('')}</main></body></html>`;
const videoPage = (id) => `<html><head><title>Conférence ${id}</title>${ld({ '@context': 'https://schema.org', '@type': 'VideoObject', name: `Conférence ${id}`, description: `Résumé ${id}.`, url: `https://videos.test/w/${id}`, thumbnailUrl: `https://cdn.videos.test/${id}.jpg`, duration: 'PT12M34S', uploadDate: '2026-09-01', embedUrl: `https://videos.test/embed/${id}`, publisher: { '@type': 'Organization', name: 'Chaîne' } })}</head><body><h1>Conférence ${id}</h1></body></html>`;

class Site {
  constructor() { this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; this.calls = []; }
  async get(u) {
    this.stats.requests++; this.calls.push(u);
    const pages = { [ORIGIN]: HOME, 'https://videos.test/w/a': videoPage('a'), 'https://videos.test/w/b': videoPage('b'), 'https://videos.test/w/c': videoPage('c'), 'https://videos.test/w/d': videoPage('d') };
    const body = pages[u];
    if (body == null) return { ok: false, status: 404, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: '', bytes: 0, headers: {}, error: 'HTTP 404' };
    this.stats.ok++; this.stats.bytes += body.length;
    return { ok: true, status: 200, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body, bytes: body.length, headers: { 'content-type': 'text/html' }, error: null };
  }
  async getText(u) { return this.get(u); }
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-video-'));
  made.push(root);
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 20 }, null, 2));
  const resolveIo = () => ({ secure: {}, config: JSON.parse(fs.readFileSync(dirs.configFile, 'utf8')), env: {} });
  const runtime = new ProviderRuntime({}, { isConfigured: (id) => isConfigured(id, resolveIo()) });
  const ledgerDir = path.join(root, 'usage-ledger');
  const meter = createMeter({ ledger: createLedger({ dir: ledgerDir }), runtime, readConfig: () => resolveIo().config });
  const events = [];
  const ctrl = createController({ dirs, emit: (t, p) => events.push({ t, p }), providerRuntime: runtime, meter });
  return { dirs, ledgerDir, ctrl, events, done: () => events.find((e) => e.t === 'done').p };
}

test('automatic content type on a video site: recognised, read, accepted, written, listed', async () => {
  const s = setup();
  const site = new Site();
  await s.ctrl.start({ origin: ORIGIN, store: 'mediatheque', browser: false, contentType: 'auto', fetcher: site });
  const d = s.done();
  assert.equal(d.status, 'done');
  assert.deepEqual(d.contentType, { requested: 'auto', type: 'video', detected: 'video' });
  assert.equal(d.counts.accepted, 4); assert.equal(d.counts.toVerify, 0);
  assert.ok(s.events.some((e) => e.t === 'contentType' && e.p.type === 'video'), 'the run announced the recognised type');
  // One request for the entry page: recognition and discovery shared it.
  assert.equal(site.calls.filter((u) => u === ORIGIN).length, 1);
  // products.json: no price, product_type "video", the additive columns, no person.
  const jobDir = path.join(s.dirs.data, 'jobs', d.jobId);
  const products = JSON.parse(fs.readFileSync(path.join(jobDir, 'products.json'), 'utf8'));
  const rows = Array.isArray(products) ? products : products.products;
  assert.equal(rows.length, 4);
  const p = rows.find((x) => x.source_url === 'https://videos.test/w/a');
  assert.equal(p.price, null); assert.equal(p.product_type, 'video'); assert.equal(p.name, 'Conférence a');
  assert.deepEqual(p.raw.columns, { duration: '12:34', published_at: '2026-09-01', embed_url: 'https://videos.test/embed/a' });
  assert.deepEqual(Object.keys(p.raw).sort(), ['availability', 'brand', 'breadcrumb', 'columns', 'confidence', 'currency', 'extractor', 'gtin', 'list_price', 'mpn', 'pack_count', 'rating', 'review_count', 'sku', 'volume_l', 'weight_estimated', 'weight_text'], 'the raw contract gains no key beyond weight_estimated (the marker of an estimated liquid weight)');
  // CSV written with the titles; report.txt says the content type.
  const csv = fs.readFileSync(d.csvPath, 'utf8');
  assert.match(csv, /Conférence a/); assert.match(csv, /,video,/);
  assert.match(fs.readFileSync(d.reportPath, 'utf8'), /content type:\s+video \(recognised automatically: video\)/);
  // Ledger: the free line only.
  const rowsL = (await queryLedger(s.ledgerDir, { jobId: d.jobId }, { limit: 50 })).rows;
  assert.deepEqual(rowsL.map((l) => [l.provider, l.outcome, l.products]), [['local', 'success', 4]]);
  // Job list + product list carry the content type and the video columns.
  const job = s.ctrl.listJobs().find((j) => j.id === d.jobId);
  assert.equal(job.contentType, 'video');
  const list = s.ctrl.jobProducts(d.jobId);
  assert.equal(list.find((x) => x.source_url === 'https://videos.test/w/a').duration, '12:34');
  assert.equal(list[0].published_at, '2026-09-01');
});

test('automatic on a client-rendered home page: the video sitemap decides, the videos are read without any browser render', async () => {
  const s = setup();
  const shell = '<!doctype html><html><head><title>Médiathèque</title><meta property="og:type" content="website"></head><body><app-root></app-root><script src="/main.js"></script></body></html>';
  const sitemap = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">${['a', 'b', 'c'].map((id) => `<url><loc>https://videos.test/w/${id}</loc><video:video><video:title>Conférence ${id}</video:title><video:thumbnail_loc>https://cdn.videos.test/${id}.jpg</video:thumbnail_loc><video:duration>754</video:duration></video:video></url>`).join('')}</urlset>`;
  const site = new Site();
  const base = site.get.bind(site);
  site.get = async (u) => {
    if (u === ORIGIN) { site.stats.requests++; site.calls.push(u); return { ok: true, status: 200, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: shell, bytes: shell.length, headers: {}, error: null }; }
    if (u === 'https://videos.test/robots.txt') return { ok: true, status: 200, url: u, requestedUrl: u, kind: 'text', body: 'Sitemap: https://videos.test/sitemap.xml', bytes: 10, headers: {}, error: null };
    if (u === 'https://videos.test/sitemap.xml') return { ok: true, status: 200, url: u, requestedUrl: u, kind: 'xml', body: sitemap, bytes: sitemap.length, headers: {}, error: null };
    return base(u);
  };
  await s.ctrl.start({ origin: ORIGIN, store: 'mediatheque', browser: false, contentType: 'auto', fetcher: site });
  const d = s.done();
  assert.equal(d.status, 'done');
  assert.deepEqual(d.contentType, { requested: 'auto', type: 'video', detected: 'video' });
  assert.equal(d.counts.accepted, 3);
  const rep = JSON.parse(fs.readFileSync(path.join(s.dirs.data, 'reports', `${d.jobId}.json`), 'utf8'));
  assert.equal(rep.browserUsed, 0, 'a video page stating its JSON-LD never needs a render');
  assert.match(rep.discovery.method, /^sitemap/);
  assert.deepEqual(rep.discovery.contentTypeDetected, { by: 'sitemap', entries: 3 });
});

test('forced "Produits" on the same site: no video is read as a product', async () => {
  const s = setup();
  await s.ctrl.start({ origin: ORIGIN, store: 'mediatheque', browser: false, contentType: 'product', fetcher: new Site() });
  const d = s.done();
  assert.equal(d.contentType.type, 'product'); assert.equal(d.contentType.requested, 'product');
  assert.equal(d.counts.accepted, 0);
});
