/**
 * Chantier B1 through the REAL controller (temp app-data, a map-backed fake fetcher —
 * no network): a learned manual_selectors recipe whose listing API refuses the plain
 * request. With the local browser NOT allowed, the page's public scripts are read
 * over the same fetcher (byte cap), the static header found next to the API path is
 * sent on the retry and the next pages, the recipe stores its spec ({from, pattern},
 * never the value), and the next run re-reads it before the first API request. With
 * the browser allowed, the discovery does not run (the scroll path keeps the lead).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../../app/controller.mjs';

const ORIGIN = 'https://www.shop.test/c/shoes';
const SCRIPT = 'https://static.shop.test/js/pages/wall.js';
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const card = (code, name, price) => `<div class="pc"><a class="t" href="/t/${name.toLowerCase().replace(/\s+/g, '-')}/${code}">${name}</a><span class="pr">${price},00 €</span></div>`;
const listing = (cards, next, total) => `<html><head><link href="https://api.shop.test" rel="dns-prefetch"><script src="${SCRIPT}"></script><script src="https://cdn.other.net/tracker.js"></script></head><body>${cards.join('')}<script id="__STATE__" type="application/json">${JSON.stringify({ wall: { pageData: { next, prev: '', totalResources: total } } })}</script></body></html>`;
const page = (ids, next, total) => ({ data: { products: ids.map((i) => ({ name: `Item ${i}`, price: 10 + i, url: `https://www.shop.test/t/item/${i}` })), pages: { next, totalResources: total } } });
const BUNDLE = `var _f="${'x'.repeat(300)}";const base="https://api.shop.test/listing/v1";${'y'.repeat(200)}fetch(base+q,{headers:{"accept":"application/json","shop-api-caller-id":"com.shop.web.catalog"}});`;

/** Pages, API and scripts behind one fetcher. The API answers only with the caller-id header. */
class SiteFetcher {
  constructor() { this.calls = []; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; this.scriptBytes = BUNDLE; }
  async get(u, o = {}) {
    this.calls.push({ u, o }); this.stats.requests++;
    const res = (status, body, ct) => ({ ok: status < 400, status, url: u, requestedUrl: u, contentType: ct, kind: ct.includes('json') ? 'json' : 'html', body, bytes: null, headers: {}, error: status < 400 ? null : `HTTP ${status}`, blocked: status >= 400, block: { code: status === 404 ? 'NOT_FOUND' : 'BLOCKED', terminal: false } });
    if (u === ORIGIN) return res(200, listing([card('AA1000-001', 'Runner Alpha', 90), card('BB2000-001', 'Trail Beta', 110)], '/listing/v1?anchor=2&count=2', 6), 'text/html');
    if (u === SCRIPT) return o.maxBytes && Buffer.byteLength(this.scriptBytes) > o.maxBytes ? { ...res(200, '', 'text/javascript'), ok: false, error: 'too_large', tooLarge: true } : res(200, this.scriptBytes, 'text/javascript');
    const m = u.match(/^https:\/\/(api|www)\.shop\.test\/listing\/v1\?anchor=(\d+)&count=2$/);
    if (m) {
      if (m[1] === 'www') return res(404, JSON.stringify({ errors: [{ code: 310 }] }), 'application/json');
      const h = (o.headers || {})['shop-api-caller-id'];
      if (h !== 'com.shop.web.catalog') return res(400, JSON.stringify({ errors: [{ code: 'CALLER_ID_HEADER_NOT_PRESENT' }] }), 'application/json');
      const a = Number(m[2]);
      return res(200, JSON.stringify(page([a + 1, a + 2], a + 2 < 6 ? `/listing/v1?anchor=${a + 2}&count=2` : null, 6)), 'application/json');
    }
    return res(404, '', 'text/html');
  }
  async getText(u) { return this.get(u); }
}

function setup(recipePagination = { mode: 'none' }, cfg = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-apih-'));
  made.push(root);
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 30, detailPages: { enabled: false }, ...cfg }));
  const recipe = { card: '.pc', fields: { name: { selector: '.t', attr: null }, price: { selector: '.pr', attr: null }, url: { selector: '.t', attr: 'href' } }, pagination: recipePagination };
  fs.writeFileSync(path.join(dirs.data, 'domain-profiles.json'), JSON.stringify({ 'shop.test': { manual_selectors: recipe, manualSelectorsMeta: { status: 'candidate', version: 1, success_count: 1, fail_count: 0, consecutive_fails: 0, last_verified: new Date().toISOString() }, runs: 1 } }));
  const fetcher = new SiteFetcher();
  const events = [];
  const ctrl = createController({ dirs, emit: (t, p) => events.push({ t, p }) });
  const profile = () => JSON.parse(fs.readFileSync(path.join(dirs.data, 'domain-profiles.json'), 'utf8'))['shop.test'];
  return { dirs, fetcher, events, ctrl, profile, run: (extra = {}) => ctrl.start({ origin: ORIGIN, store: 'demo', browser: false, fetcher, ...extra }) };
}
const done = (s) => s.events.find((e) => e.t === 'done').p;

test('browser not allowed, API refused: the header is found in the page\'s public script, the list is read to its end, the recipe keeps the spec', async () => {
  const s = setup();
  await s.run();
  const d = done(s);
  assert.equal(d.counts.detected, 6, 'page 1 (2) + API pages (4)');
  assert.equal(d.pagination.mechanism, 'api-next'); assert.equal(d.pagination.stoppedBy, 'total_reached'); assert.deepEqual(d.pagination.warnings, []);
  assert.deepEqual(d.pagination.apiHeaders, { source: 'public-js', found: true, names: ['shop-api-caller-id'], filesListed: 1, filesRead: 1, filesBeyondCap: 0, filesSkipped: [], rejected: [], retried: true, accepted: true });
  const scripts = s.fetcher.calls.filter((c) => c.u === SCRIPT);
  assert.equal(scripts.length, 1, 'the script is read once'); assert.equal(scripts[0].o.maxBytes, 2 * 1024 * 1024, 'with the 2 MiB cap');
  assert.equal(s.fetcher.calls.some((c) => c.u.includes('cdn.other.net')), false, 'a foreign script the page does not declare is never read');
  const apiCalls = s.fetcher.calls.filter((c) => c.u.startsWith('https://api.shop.test/'));
  assert.deepEqual(apiCalls.map((c) => !!(c.o.headers && c.o.headers['shop-api-caller-id'])), [false, true, true], 'plain request refused, then the retry and the last page carry the header');
  const pg = s.profile().manual_selectors.pagination;
  assert.equal(pg.mode, 'api-next'); assert.equal(pg.api_host, 'https://api.shop.test');
  assert.deepEqual(Object.keys(pg.api_headers), ['shop-api-caller-id']);
  assert.equal(pg.api_headers['shop-api-caller-id'].from, SCRIPT);
  assert.equal(JSON.stringify(s.profile()).includes('com.shop.web.catalog'), false, 'the recipe stores where to read the value, never the value');
  const txt = fs.readFileSync(d.reportPath, 'utf8');
  assert.match(txt, /api headers: +found in the page's public scripts \(1 of 1 file\(s\) read\): shop-api-caller-id — the API accepted them/);
  assert.equal(txt.includes('com.shop.web.catalog'), false);
});

test('next run: the stored spec is re-read before the first API request (no refusal, no discovery), and an old recipe without spec still works', async () => {
  const s = setup();
  await s.run();
  const specs = s.profile().manual_selectors.pagination.api_headers;
  const s2 = setup({ mode: 'api-next', api_host: 'https://api.shop.test', api_headers: specs });
  await s2.run();
  const d = done(s2);
  assert.equal(d.counts.detected, 6);
  assert.deepEqual(d.pagination.apiHeaders, { source: 'recipe', found: true, names: ['shop-api-caller-id'] });
  const apiCalls = s2.fetcher.calls.filter((c) => c.u.startsWith('https://api.shop.test/'));
  assert.ok(apiCalls.length === 2 && apiCalls.every((c) => c.o.headers && c.o.headers['shop-api-caller-id']), 'two API pages, both with the header: no plain (refused) request at all');
  assert.equal(s2.fetcher.calls.filter((c) => c.u === SCRIPT).length, 1, 'the script is read once to resolve the spec');
  // Old recipe: a memo without api_headers → the refusal → the discovery, as on a first run.
  const s3 = setup({ mode: 'api-next', api_host: 'https://api.shop.test' });
  await s3.run();
  assert.equal(done(s3).counts.detected, 6); assert.equal(done(s3).pagination.apiHeaders.source, 'public-js');
});

test('browser allowed: the discovery does not run (the scroll step owns that case); the refusal is reported as before', async () => {
  const s = setup();
  const browserSession = { collectListing: async () => ({ recipeCardsHtml: [], blocked: null, error: null, cards: [], links: [] }), render: async () => ({ html: null }), close: async () => {} };
  await s.run({ browser: true, browserSession });
  const d = done(s);
  assert.equal(s.fetcher.calls.filter((c) => c.u === SCRIPT).length, 0, 'no script read');
  assert.equal(d.pagination.apiHeaders, undefined);
  assert.equal(d.counts.detected, 2);
});

test('limits: a script over the byte cap is skipped (reported), the setting listPagination.jsHeaders=false turns the discovery off', async () => {
  const s = setup();
  s.fetcher.scriptBytes = BUNDLE + 'z'.repeat(3 * 1024 * 1024);
  await s.run();
  const d = done(s);
  assert.equal(d.counts.detected, 2);
  assert.equal(d.pagination.stoppedBy, 'api_refused');
  assert.deepEqual(d.pagination.apiHeaders, { source: 'public-js', found: false, names: [], filesListed: 1, filesRead: 0, filesBeyondCap: 0, filesSkipped: ['too_large'], rejected: ['caller-id:not_found'] }, 'the header the site named was looked for; no file could be read');
  assert.match(fs.readFileSync(d.reportPath, 'utf8'), /api headers: +not found in the page's public scripts \(0 of 1 file\(s\) read\)/);
  const off = setup({ mode: 'none' }, { listPagination: { jsHeaders: false } });
  await off.run();
  assert.equal(off.fetcher.calls.filter((c) => c.u === SCRIPT).length, 0);
  assert.equal(done(off).pagination.apiHeaders, undefined);
});
