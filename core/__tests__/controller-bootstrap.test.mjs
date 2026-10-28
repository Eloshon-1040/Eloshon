/**
 * v0.5.9 — the Scraping Browser as a BROWSER BOOTSTRAP for an internal-api recipe,
 * through the REAL controller (temp app-data, injected recipeHttpGet + a fake CDP
 * `connect` — never the network, never a billed session). Pins:
 *   - free header resolution first; the bootstrap only when it fails (or 'always');
 *   - the store comes from siteContext (config), not from the captured request;
 *   - bytes + runtime of the remote session are reported on the scrapingBrowser lane;
 *   - at most ONE billed Scraping Browser session per job (no render tier after it);
 *   - no captured value / credential in any file the job writes, nor in UI events.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../../app/controller.mjs';

const KEY = 'TESTKEY-abc123XYZ';
const ZONE_PW = 'S3CRETPW', CID = 'TESTCID';
const ORIGIN = 'https://www.shop.test/cat';
const ITEMS = [{ n: 'Tee', p: 19, id: 't1' }, { n: 'Cap', p: 9, id: 'c1' }, { n: 'Mug', p: 7, id: 'm1' }];

class Mock {
  constructor() { this.calls = []; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(u) { this.calls.push(u); this.stats.requests++; return { ok: false, status: 404, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: '', bytes: null, headers: {}, error: null, blocked: false }; }
  async getText(u) { return this.get(u); }
}

function setup({ bootstrap = {}, sourceHasKey = false, emptyApi = false, onSource = null, connectError = null, fakeCookies = [], blockTypes = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-bootstrap-'));
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({
    workers: 1, recovery: false, maxProducts: 50,
    brightData: {
      browserAuth: `brd-customer-${CID}-zone-mcp_browser:${ZONE_PW}`,
      scrapingBrowserBootstrap: { 'shop.test': { requestUrlPattern: '^https://api[.]shop[.]test/', headers: ['X-Api-Key'], ...bootstrap } },
      scrapingBrowserCountry: { 'shop.test': 'be' },
      scrapingBrowserDomains: ['shop.test'], // also armed for the HTML render tier → the one-session guard must hold
      ...(blockTypes ? { scrapingBrowserBlock: { 'shop.test': blockTypes } } : {}),
    },
    siteContext: { 'shop.test': { placeId: '77' } },
  }), 'utf8');
  const recipe = {
    endpoint_tpl: 'https://api.shop.test/search?place={placeId}&size={size}&skip={skip}',
    static_headers: { 'User-Agent': 'Mozilla/5.0 Chrome' },
    headers: { 'X-Api-Key': { from: 'https://www.shop.test/', pattern: 'X-Api-Key:\\s*([A-Za-z0-9-]+)' } },
    vars: { placeId: { source: 'config', key: 'placeId', default: '1' } },
    pagination: { type: 'offset', param: 'skip', size_param: 'size', size: 2, total_json_path: 'total' },
    json_path: 'items',
    field_map: { name: 'n', price: 'p', sku: 'id', url: { template: 'https://www.shop.test/p/{id}' } },
  };
  fs.writeFileSync(path.join(dirs.data, 'domain-profiles.json'), JSON.stringify({
    'shop.test': { internal_api: recipe, internalApiMeta: { status: 'candidate', version: 1, success_count: 0, fail_count: 0, consecutive_fails: 0, last_verified: new Date().toISOString() }, runs: 1 },
  }), 'utf8');

  const http = { source: 0, api: [], cookies: [] };
  let ctrl = null;
  const recipeHttpGet = async (url, { headers = {} } = {}) => {
    if (url === 'https://www.shop.test/') { http.source += 1; if (onSource) onSource(ctrl); return sourceHasKey ? { status: 200, body: `cfg "X-Api-Key: ${KEY}"` } : { status: 456, body: '' }; }
    http.api.push(url); http.cookies.push(headers.Cookie || null);
    const key = Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-api-key');
    if (!key || key[1] !== KEY) return { status: 401, body: { error: 'unauthorized' } };
    if (emptyApi) return { status: 200, body: { total: 0, items: [] } };
    const u = new URL(url); const skip = Number(u.searchParams.get('skip')); const size = Number(u.searchParams.get('size'));
    return { status: 200, body: { total: ITEMS.length, items: ITEMS.slice(skip, skip + size) } };
  };

  // Fake remote browser: the page's own app fires an API call carrying the key —
  // on the ANONYMOUS store (place=1), which must not override the configured one.
  const sb = { connects: 0, closed: 0, gotoUrls: [], cdpUrls: [], routed: [] };
  const scrapingBrowserConnect = async (cdpUrl) => {
    sb.connects += 1; sb.cdpUrls.push(cdpUrl);
    if (connectError) throw new Error(connectError);
    const L = {}; const cdpL = {}; let routeHandler = null;
    const cdp = { on: (e, cb) => { (cdpL[e] = cdpL[e] || []).push(cb); }, send: async () => ({}) };
    const page = {
      route: async (_p, h) => { routeHandler = h; },
      goto: async (u) => {
        sb.gotoUrls.push(u);
        for (const cb of (cdpL['Network.loadingFinished'] || [])) cb({ encodedDataLength: 120000 });
        const img = { url: () => 'https://www.shop.test/hero.png', method: () => 'GET', resourceType: () => 'image', headers: () => ({}) };
        const api = { url: () => 'https://api.shop.test/search?place=1&size=2&skip=0', method: () => 'GET', resourceType: () => 'fetch', headers: () => ({ 'x-api-key': KEY }) };
        for (const r of [img, api]) {
          if (routeHandler) routeHandler({ request: () => r, abort: async () => { sb.routed.push(['abort', r.url()]); }, continue: async () => { sb.routed.push(['continue', r.url()]); } });
          for (const cb of (L.request || [])) await cb(r);
        }
        return { status: () => 200, content: async () => '<html></html>' };
      },
      content: async () => '<html><body>no products</body></html>',
      waitForSelector: async () => {},
    };
    const ctx = { on: (e, cb) => { (L[e] = L[e] || []).push(cb); }, newPage: async () => page, newCDPSession: async () => cdp, cookies: async () => fakeCookies };
    return { contexts: () => [ctx], close: async () => { sb.closed += 1; } };
  };
  const events = [];
  ctrl = createController({ dirs, emit: (t, p) => events.push({ t, p }) });
  const run = () => ctrl.start({ origin: ORIGIN, store: 'demo', browser: false, fetcher: new Mock(), recipeHttpGet, scrapingBrowserConnect });
  return { root, dirs, ctrl, run, http, sb, events };
}

function allFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...allFiles(p)); else out.push(p);
  }
  return out;
}

test('controller: free header fails → ONE short remote bootstrap → catalogue over HTTP with the configured store', async () => {
  const s = setup();
  await s.run();
  const done = s.events.find((e) => e.t === 'done').p;
  const j = s.ctrl.listJobs()[0];
  assert.equal(j.products, 3);
  assert.equal(done.method, 'internal-api', 'neutral strategy on the completion screen (no provider name)');
  assert.equal(s.http.source, 1, 'free key source tried first');
  assert.equal(s.sb.connects, 1, 'exactly one billed session');
  assert.equal(s.sb.closed, 1, 'and it was closed');
  assert.deepEqual(s.sb.gotoUrls, [ORIGIN], 'bootstrap opens the job URL (one navigation)');
  assert.ok(s.http.api.length >= 2 && s.http.api.every((u) => u.includes('place=77&')), 'store from siteContext, never the anonymous one seen in the browser');
  assert.equal(done.bytesDownloaded.scrapingBrowser, 120000, 'remote session bytes on the scrapingBrowser lane');
  assert.equal(s.sb.cdpUrls.length, 1);
  assert.match(s.sb.cdpUrls[0], /-country-be:/, 'per-host geo (scrapingBrowserCountry) reaches the session');
  assert.equal(typeof done.scrapingBrowser.runtimeSec, 'number', 'runtime survives the ingest report rebuild');

  const report = JSON.parse(fs.readFileSync(done.reportPath.replace(/\.txt$/, '.json'), 'utf8'));
  assert.equal(report.recipeBootstrap.ok, true);
  assert.deepEqual(report.recipeBootstrap.captured, { url: 'https://api.shop.test/search', headerNames: ['X-Api-Key'], cookieNames: [] });
  assert.equal(report.recipeLane.usedHeaderBootstrap, true);

  // Leak sweep: every file the job/app wrote (except the user's own config.json).
  const files = allFiles(s.root).filter((f) => path.resolve(f) !== path.resolve(s.dirs.configFile));
  assert.ok(files.length >= 5);
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    for (const secret of [KEY, ZONE_PW, CID]) assert.equal(txt.includes(secret), false, `${secret} leaked into ${path.relative(s.root, f)}`);
  }
  const evTxt = JSON.stringify(s.events);
  assert.equal(evTxt.includes(KEY), false, 'no captured value in UI events');
  const stepCodes = s.events.filter((e) => e.t === 'step').map((e) => e.p.code);
  assert.ok(stepCodes.includes('browserStart'), 'the bootstrap shows the neutral, translated step');
  assert.ok(!stepCodes.some((c) => /scrapingBrowser|webUnlocker|firecrawl/.test(c)), 'no provider step code');

  // Ingested products are marked processed: a resume must not re-scrape them.
  const jobDir = path.dirname(files.find((f) => f.endsWith('job.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(jobDir, 'discovered.json'), 'utf8')).length, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(jobDir, 'processed.json'), 'utf8')).length, 3);
});

test('controller: a bootstrap that still yields nothing is NOT followed by a second billed render session', async () => {
  const s = setup({ emptyApi: true });
  await s.run();
  assert.equal(s.ctrl.listJobs()[0].products, 0);
  assert.equal(s.sb.connects, 1, 'the HTML render tier did not open a second session');
  const done = s.events.find((e) => e.t === 'done').p;
  const report = JSON.parse(fs.readFileSync(done.reportPath.replace(/\.txt$/, '.json'), 'utf8'));
  assert.equal(report.recipeLane.ok, false);
  assert.equal(report.recipeLane.usedHeaderBootstrap, true);
});

test('controller: when the free header resolution works, no remote session is opened at all', async () => {
  const s = setup({ sourceHasKey: true });
  await s.run();
  const done = s.events.find((e) => e.t === 'done').p;
  assert.equal(s.ctrl.listJobs()[0].products, 3);
  assert.equal(s.sb.connects, 0);
  assert.equal(done.bytesDownloaded.scrapingBrowser, 0);
  assert.equal(done.scrapingBrowser, null);
  const recipeEv = s.events.find((e) => e.t === 'recipe').p;
  assert.equal(recipeEv.free, true);
});

test("controller: mode 'always' skips the free key source and labels the start as paid (provider-free)", async () => {
  const s = setup({ bootstrap: { mode: 'always' }, sourceHasKey: true });
  await s.run();
  assert.equal(s.ctrl.listJobs()[0].products, 3);
  assert.equal(s.http.source, 0, 'free key source never fetched');
  assert.equal(s.sb.connects, 1);
  const recipeEv = s.events.find((e) => e.t === 'recipe').p;
  assert.equal(recipeEv.free, false);
  assert.match(recipeEv.cost, /crédit/);
  assert.doesNotMatch(recipeEv.cost, /bright|scraping|browser api/i);
});

test('controller: a Stop during the free key fetch opens NO billed session (bootstrap or render tier) and is not a recipe failure', async () => {
  const s = setup({ onSource: (ctrl) => ctrl.stop() });
  await s.run();
  assert.equal(s.sb.connects, 0, 'no remote session after Stop — neither the bootstrap nor the HTML render tier');
  assert.equal(s.ctrl.listJobs()[0].status, 'interrupted');
  const profs = JSON.parse(fs.readFileSync(path.join(s.dirs.data, 'domain-profiles.json'), 'utf8'));
  assert.equal(profs['shop.test'].internalApiMeta.consecutive_fails, 0, 'a Stop does not push the recipe towards deprecation');
});

test('controller: a failing connect (error echoing the endpoint) leaks no credential into any written file or event', async () => {
  const s = setup({ connectError: `WebSocket error: wss://brd-customer-${CID}-zone-mcp_browser:${ZONE_PW}@brd.superproxy.io:9222/ 403 Forbidden` });
  await s.run();
  assert.equal(s.ctrl.listJobs()[0].products, 0);
  assert.equal(s.sb.connects, 1, 'one attempt, then no second session from the render tier');
  const done = s.events.find((e) => e.t === 'done').p;
  const report = JSON.parse(fs.readFileSync(done.reportPath.replace(/\.txt$/, '.json'), 'utf8'));
  assert.equal(report.recipeBootstrap.note, 'error');
  assert.match(report.recipeBootstrap.error, /403 Forbidden/);
  const files = allFiles(s.root).filter((f) => path.resolve(f) !== path.resolve(s.dirs.configFile));
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    for (const secret of [ZONE_PW, CID]) assert.equal(txt.includes(secret), false, `${secret} leaked into ${path.relative(s.root, f)}`);
  }
  assert.equal(JSON.stringify(s.events).includes(ZONE_PW), false);
});

test('controller: per-host bootstrap config is honoured — url, flags, named cookies, resource blocking', async () => {
  const s = setup({
    bootstrap: { url: 'https://www.shop.test/start', cookies: ['sid'], flags: 'i', requestUrlPattern: '^HTTPS://API[.]SHOP[.]TEST/' },
    fakeCookies: [{ name: 'sid', value: 'SIDVAL-9' }, { name: 'other', value: 'x' }],
    blockTypes: ['image'],
  });
  await s.run();
  assert.equal(s.ctrl.listJobs()[0].products, 3);
  assert.deepEqual(s.sb.gotoUrls, ['https://www.shop.test/start'], 'bootstrap URL from config');
  assert.ok(s.http.cookies.length >= 2 && s.http.cookies.every((c) => c === 'sid=SIDVAL-9'), 'only the named cookie rides on the catalogue calls');
  assert.deepEqual(s.sb.routed, [['abort', 'https://www.shop.test/hero.png'], ['continue', 'https://api.shop.test/search?place=1&size=2&skip=0']], 'per-host blocking applied, capture target always allowed');
  const files = allFiles(s.root).filter((f) => path.resolve(f) !== path.resolve(s.dirs.configFile));
  for (const f of files) assert.equal(fs.readFileSync(f, 'utf8').includes('SIDVAL-9'), false, `cookie value leaked into ${path.relative(s.root, f)}`);
});

test('controller: when the fallback bootstrap actually ran, the cost is re-stated as a paid start (note + event, provider-free)', async () => {
  const s = setup();
  await s.run();
  const recipeEvents = s.events.filter((e) => e.t === 'recipe').map((e) => e.p);
  assert.equal(recipeEvents[0].free, true, 'the up-front estimate is free-first');
  assert.equal(recipeEvents[recipeEvents.length - 1].free, false, 'then corrected once the paid bootstrap was used');
  const done = s.events.find((e) => e.t === 'done').p;
  const report = JSON.parse(fs.readFileSync(done.reportPath.replace(/\.txt$/, '.json'), 'utf8'));
  assert.match(report.notes[0], /crédit/);
  assert.doesNotMatch(report.notes[0], /bright|scraping|browser api/i);
});
