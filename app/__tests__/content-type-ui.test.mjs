/**
 * "Type de contenu" in the REAL renderer (app/renderer/app.js) through the DOM-free
 * harness and a fake bridge: the choice is in Nouveau scraping, it travels with the
 * launch and the analysis, the completion screen and the Jobs list say "vidéos", the
 * Results table shows the duration in place of the price. No Electron, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const els = new Map();
const el = (id) => { if (!els.has(id)) els.set(id, { id, value: '', innerHTML: '', textContent: '', classList: { add() {}, remove() {}, toggle() {} }, focus() {}, setSelectionRange() {}, remove() {}, appendChild() {} }); return els.get(id); };
const listeners = {};
globalThis.document = {
  getElementById: (id) => el(id),
  addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  body: { classList: { add() {} } },
  activeElement: null,
  createElement: () => el('x-' + Math.random()),
};
globalThis.requestAnimationFrame = (fn) => fn();

const calls = [];
let eventCb = null;
const JOBS = [];
let PRODUCTS = [];
globalThis.window = {
  eloshon: {
    platform: 'win32', uiReady() {}, win: {},
    appInfo: async () => ({ version: 't', arch: 'x64', packaged: false }),
    settings: { get: async () => ({}), set: async (p) => p },
    jobs: { list: async () => JOBS, report: async () => ({ ok: true, text: 'r' }), products: async () => PRODUCTS },
    accountStatus: async () => ({ rate: null }),
    onEvent: (cb) => { eventCb = cb; },
    scrape: { start: async (i) => { calls.push(['scrape.start', i]); return { ok: true }; } },
    probe: async (url, opts) => { calls.push(['probe', url, opts]); return { diagnosis: 'ok', best_path: 'video-list', product_count: 4, free_fields: ['name', 'url', 'image', 'duration'], absent_fields: ['views'], content_type: { requested: 'auto', type: 'video', detected: 'video' } }; },
    yourBrowser: { availability: async () => ({ ok: false, code: 'domain_not_enabled', enabled: false, connected: false }), run: async () => ({ ok: false }), resume: async () => ({}), stop: async () => ({}), pause: async () => ({}), status: async () => ({}) },
  },
};

const html = () => el('app').innerHTML;
const tick = () => new Promise((r) => setTimeout(r, 0));
const click = async (dataset) => { for (const fn of listeners.click || []) await fn({ target: { closest: () => ({ dataset }) } }); await tick(); };

test('Nouveau scraping → Type de contenu → launch, analysis, completion, Jobs badge, Results columns', async () => {
  await import('../renderer/app.js');
  await tick(); await tick();
  await click({ nav: 'new' });
  assert.match(html(), /id="f-ctype"/);
  assert.match(html(), /<option value="auto" selected>Automatique<\/option>/);
  assert.match(html(), /<option value="product">Produits<\/option>/);
  assert.match(html(), /<option value="video">Vidéos<\/option>/);
  assert.match(html(), /reconnaît une boutique ou un site de vidéos à partir de la première page et du plan du site/);

  // The analysis sends the choice and reads the video verdict.
  el('f-url').value = 'https://videos.test/videos/recent'; el('f-ctype').value = 'video';
  await click({ act: 'probe' });
  const probe = calls.find((c) => c[0] === 'probe');
  assert.deepEqual(probe[2], { contentType: 'video' });
  assert.match(el('probe-out').innerHTML, /4 vidéo\(s\) détectée\(s\)/);
  assert.match(el('probe-out').innerHTML, /nom, adresse, image, durée/);
  assert.match(el('probe-out').innerHTML, /absent : vues/);

  // The launch carries the content type.
  await click({ act: 'start' });
  const start = calls.find((c) => c[0] === 'scrape.start');
  assert.ok(start, 'the engine was started');
  assert.equal(start[1].contentType, 'video');
  assert.equal(start[1].origin, 'https://videos.test/videos/recent');

  // Completion: "vidéos traitées" and the content-type line.
  eventCb('done', { jobId: 'job-v', status: 'done', method: 'crawl', counts: { accepted: 4, toVerify: 0, excluded: 0, detected: 4 }, durationMs: 12000, csvPath: 'C:/v.csv', reportPath: 'C:/v.txt', contentType: { requested: 'auto', type: 'video', detected: 'video' } });
  assert.match(html(), /4 vidéos traitées en 12 s/);
  assert.match(html(), /Type de contenu : vidéos \(reconnu automatiquement\)/);

  // Jobs: the badge; Results: the "Vidéo" column and the duration in place of the price.
  JOBS.push({ id: 'job-v', status: 'done', source: 'https://videos.test/', store: 'mediatheque', createdAt: '2026-10-09T10:00:00Z', products: 4, discovered: 4, processed: 4, isUrl: true, contentType: 'video' });
  PRODUCTS = [{ key: 'https://videos.test/w/a', name: 'Conférence a', price: null, status: 'accepted', code: 'accepted_video', reason: '', image_url: 'https://cdn.videos.test/a.jpg', source_url: 'https://videos.test/w/a', source_category: 'Chaîne', duration: '12:34', views: '980', published_at: '2026-09-01', embed_url: 'https://videos.test/embed/a' }];
  await click({ nav: 'jobs' });
  assert.match(html(), /chip-note[^>]*>Vidéos<\/span>/);
  await click({ act: 'view-results', job: 'job-v' });
  assert.match(html(), /<th>Vidéo<\/th>/);
  assert.match(html(), /Durée<\/th>/);
  assert.match(html(), /12:34/);
  assert.doesNotMatch(html(), /—\s*€/);
  await click({ act: 'detail', key: 'https://videos.test/w/a' });
  assert.match(html(), /Vues<\/span>[\s\S]*980/);
  assert.match(html(), /Publiée le<\/span>[\s\S]*2026-09-01/);
  assert.match(html(), /Vidéo valide : titre, adresse de page, et vignette ou description\./);
});
