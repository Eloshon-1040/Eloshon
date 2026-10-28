/**
 * "Scraper via votre navigateur" — end-to-end flow, MOCKED ONLY (no network, no
 * real site): user launch → validated spec to a fake extension → progress /
 * challenge pause / resume / abandon / blocked / done → recorded as a normal job
 * in the Jobs history with the normal report. Uses the REAL controller on a temp
 * data dir and the REAL IPC handlers (not admin-gated). Two fake domains prove
 * the path is generic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../controller.mjs';
import { createYourBrowserService } from '../your-browser/integration.mjs';
import { createYourBrowserHandlers, YB_CHANNELS } from '../your-browser/ipc.mjs';
import { GATED, UNGATED } from '../admin/ipc.mjs';
import { ProviderRuntime } from '../../core/providers/runtime.mjs';
import * as P from '../../shared/protocol/messages.mjs';

const CFG = {
  yourBrowser: {
    pacing: { baseIntervalMs: 1500 },
    perDomain: {
      'boutique-alpha.test': { enabled: true, pacing: { baseIntervalMs: 2500 } },
      'magasin-beta.example': { enabled: true, limits: { maxProducts: 50 } },
    },
  },
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 3000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await fn()) return true; await wait(10); } return false; }

/** Fake HostBridge: captures what the app sends; lets the test play the extension. */
function fakeBridge() {
  const b = { sent: [], onStatus: null, onMessage: null, start() {}, stop() {}, send(m) { b.sent.push(m); } };
  return b;
}

function setup({ connect = true, config = CFG, hints = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-ybflow-'));
  const dirs = ensureDirs(appDirs(base));
  const events = [];
  const controller = createController({ dirs, emit: (t, p) => events.push({ t, p }) });
  const runtime = new ProviderRuntime({});
  const bridge = fakeBridge();
  let seq = 0;
  const svc = createYourBrowserService({
    config, readConfig: () => config, controller,
    emit: (t, p) => events.push({ t, p }),
    bridgeFactory: () => bridge,
    resolveRecipe: async (url) => hints[new URL(url).hostname.replace(/^www\./, '')] || null,
    recordRun: (e) => runtime.recordExternalRun(e),
    newJobId: () => `yb_test_${++seq}`,
    stopGraceMs: 30,
  });
  svc.start();
  bridge.onStatus('connected');
  if (connect) bridge.onMessage(P.capabilities(['internal_api', 'dom'], { browser: 'chrome' }));
  const ipc = createYourBrowserHandlers({ getService: () => svc, readConfig: () => config });
  const ext = {
    jobs: () => bridge.sent.filter((m) => m.type === P.MSG.JOB),
    sentTypes: () => bridge.sent.map((m) => m.type),
    reply: (m) => bridge.onMessage(m),
  };
  const jobStates = () => events.filter((e) => e.t === 'yourBrowser' && e.p.job).map((e) => e.p.job.phase);
  return { controller, events, svc, bridge, ext, ipc, runtime, jobStates };
}

const findJob = (controller, pred) => controller.listJobs().find(pred);

test('the your-browser channels are NOT admin-gated and do not need any admin session', () => {
  for (const c of YB_CHANNELS) {
    assert.ok(!GATED.includes(c), `${c} must not be admin-gated`);
    assert.ok(!UNGATED.includes(c), `${c} is not an admin channel at all`);
  }
});

test('two different domains run through the same path and land in the Jobs history with a normal report', async () => {
  const { controller, ext, ipc, runtime } = setup({ hints: { 'boutique-alpha.test': { internalApi: { type: 'internal_api', endpoint_tpl: 'https://api.boutique-alpha.test/p' } } } });
  const runs = [
    { url: 'https://boutique-alpha.test/rayon/lait', store: 'alpha', domain: 'boutique-alpha.test', kind: 'internal_api', products: [{ name: 'Lait 1L', price: 1.29, sku: 'A1', sourceUrl: 'https://boutique-alpha.test/p/A1' }] },
    { url: 'https://www.magasin-beta.example/cat/chaises', store: 'beta', domain: 'magasin-beta.example', kind: 'auto', products: [{ name: 'Chaise', price: 49, sku: 'B1', sourceUrl: 'https://magasin-beta.example/p/B1' }, { name: 'Table', price: 120, sku: 'B2', sourceUrl: 'https://magasin-beta.example/p/B2' }] },
  ];
  for (const [i, r] of runs.entries()) {
    const res = await ipc['yb:run']({ startUrl: r.url, store: r.store, limits: { maxProducts: 999999 } });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.domain, r.domain);
    assert.equal(res.recipeKind, r.kind);
    assert.ok(await until(() => ext.jobs().length === i + 1));
    const job = ext.jobs()[i].payload;
    assert.equal(job.job_id, res.jobId);
    assert.equal(job.domain, r.domain);
    assert.equal(job.start_url, r.url);
    assert.ok(job.limits.maxProducts <= 5000, 'bounded');
    assert.ok(job.pacing.baseIntervalMs >= 800, 'pacing forwarded + floored');
    ext.reply(P.progress(res.jobId, { done: 1, total: 2 }));
    ext.reply(P.result(res.jobId, P.JOB_STATUS.DONE, { products: r.products, counts: { products: r.products.length } }));
    assert.ok(await until(() => findJob(controller, (j) => j.store === r.store)), 'job recorded');
    const j = findJob(controller, (x) => x.store === r.store);
    assert.equal(j.via, 'your-browser');
    assert.equal(j.status, 'done');
    assert.equal(j.products, r.products.length);
    assert.equal(controller.jobProducts(j.id).length, r.products.length, 'Results view reads the persisted products');
    assert.equal(j.source, r.url);
    const rep = controller.jobReport(j.id);
    assert.equal(rep.ok, true);
    assert.match(rep.text, /executed in:\s+votre navigateur/);
    assert.doesNotMatch(rep.text, /extensionReason|pacing|baseIntervalMs/, 'technical detail stays in report.json');
  }
  assert.equal(ext.jobs()[0].payload.pacing.baseIntervalMs, 2500);
  assert.equal(ext.jobs()[1].payload.pacing.baseIntervalMs, 1500);
  assert.equal(ext.jobs()[1].payload.limits.maxProducts, 5000);
  // Admin journal: noted as "Votre navigateur", free, distinct from provider rows.
  const log = runtime.externalRuns();
  assert.equal(log.length, 2);
  assert.ok(log.every((e) => e.label === 'Votre navigateur' && e.paid === false));
  assert.ok(!runtime.adminLog(null).some((row) => /navigateur/i.test(row.label)), 'never mixed into paid-provider rows');
});

test('challenge pause → Reprendre → done: state goes connecting → running → paused → running → done', async () => {
  const { svc, ext, ipc, jobStates } = setup();
  const res = await ipc['yb:run']({ startUrl: 'https://boutique-alpha.test/c' });
  await until(() => ext.jobs().length === 1);
  ext.reply(P.progress(res.jobId, { done: 0, total: 3 }));
  ext.reply(P.pause(res.jobId, 'challenge', { message: 'Action requise : vérification' }));
  assert.equal(svc.status().job.phase, 'paused');
  assert.equal(svc.status().job.message, 'Action requise : vérification');
  const r = await ipc['yb:resume'](res.jobId);
  assert.equal(r.ok, true);
  assert.ok(ext.sentTypes().includes(P.MSG.RESUME));
  assert.equal(svc.status().job.phase, 'running');
  ext.reply(P.result(res.jobId, P.JOB_STATUS.DONE, { products: [{ name: 'X', price: 1, sku: 'x' }] }));
  assert.ok(await until(() => svc.status().job.phase === 'done'));
  const seq = jobStates();
  for (const ph of ['connecting', 'running', 'paused', 'done']) assert.ok(seq.includes(ph), `saw ${ph}: ${seq}`);
  assert.ok(seq.indexOf('paused') < seq.lastIndexOf('running'), 'running again after resume');
});

test('Abandonner: stop is relayed; if the extension never confirms, the run still ends and is recorded', async () => {
  const { controller, svc, ext, ipc } = setup();
  const res = await ipc['yb:run']({ startUrl: 'https://boutique-alpha.test/c', store: 'abandon-me' });
  await until(() => ext.jobs().length === 1);
  const r = await ipc['yb:stop'](res.jobId);
  assert.equal(r.ok, true);
  assert.equal(svc.status().job.phase, 'stopping');
  assert.ok(ext.sentTypes().includes(P.MSG.STOP));
  assert.ok(await until(() => findJob(controller, (j) => j.store === 'abandon-me')), 'recorded after the grace period');
  const j = findJob(controller, (x) => x.store === 'abandon-me');
  assert.equal(j.status, 'interrupted');
  assert.equal(j.via, 'your-browser');
  assert.equal(svc.status().activeJob, null, 'slot released');
});

test('pause (API) is relayed for the active job; controls for an unknown job are refused', async () => {
  const { ext, ipc } = setup();
  const res = await ipc['yb:run']({ startUrl: 'https://boutique-alpha.test/c' });
  await until(() => ext.jobs().length === 1);
  assert.equal((await ipc['yb:pause'](res.jobId)).ok, true);
  assert.ok(ext.sentTypes().includes(P.MSG.PAUSE));
  for (const bad of ['nope', '', 42, null, { id: res.jobId }]) {
    const r = await ipc['yb:stop'](bad);
    assert.equal(r.ok, false); assert.equal(r.code, 'unknown_job');
  }
});

test('blocked by the extension (site not authorised in the popup) → recorded as blocked with a plain explanation', async () => {
  const { controller, ext, ipc, events } = setup();
  const res = await ipc['yb:run']({ startUrl: 'https://magasin-beta.example/cat', store: 'perm' });
  await until(() => ext.jobs().length === 1);
  ext.reply(P.result(res.jobId, P.JOB_STATUS.BLOCKED, { reason: 'permission_required', domain: 'magasin-beta.example' }));
  assert.ok(await until(() => findJob(controller, (j) => j.store === 'perm')));
  const j = findJob(controller, (x) => x.store === 'perm');
  assert.equal(j.status, 'stopped:permission_required');
  assert.match(j.reason, /Activer ce domaine/);
  const done = events.find((e) => e.t === 'done' && e.p.jobId === j.id);
  assert.ok(done.p.blocked, 'completion screen shows "bloqué"');
  assert.equal(done.p.method, 'your-browser');
  assert.match(controller.jobReport(j.id).text, /Activer ce domaine/);
});

test('a domain not authorized in the extension is refused before anything is sent (activate-in-extension)', async () => {
  const { ext, ipc } = setup();
  const r = await ipc['yb:run']({ startUrl: 'https://pas-autorise.test/x' });
  assert.deepEqual([r.ok, r.code], [false, 'domain_not_activated']);
  assert.match(r.message, /Activer ce domaine/);
  const av = await ipc['yb:availability']('https://pas-autorise.test/x');
  assert.equal(av.ok, false); assert.equal(av.enabled, false);
  assert.equal(ext.jobs().length, 0);
});

test('extension not connected → friendly message on availability and on launch; nothing sent', async () => {
  const { ext, ipc } = setup({ connect: false });
  const av = await ipc['yb:availability']('https://boutique-alpha.test/');
  assert.equal(av.enabled, true);
  assert.equal(av.code, 'extension_not_connected');
  const r = await ipc['yb:run']({ startUrl: 'https://boutique-alpha.test/' });
  assert.equal(r.ok, false);
  assert.equal(r.message, 'Installez et connectez l’extension Eloshon Scraper dans votre navigateur pour utiliser ce mode.');
  assert.equal(ext.jobs().length, 0);
});

test('one run at a time: a second launch while one is running is refused (no parallel hammering)', async () => {
  const { ext, ipc } = setup();
  const [a, b] = await Promise.all([ipc['yb:run']({ startUrl: 'https://boutique-alpha.test/1' }), ipc['yb:run']({ startUrl: 'https://magasin-beta.example/2' })]);
  assert.equal(a.ok, true);
  assert.deepEqual([b.ok, b.code], [false, 'busy']);
  await until(() => ext.jobs().length === 1);
  assert.equal(ext.jobs().length, 1);
});

test('extension disconnects mid-run → the run ends as failed (no hang, no auto-retry)', async () => {
  const { controller, bridge, ext, ipc, svc } = setup();
  const res = await ipc['yb:run']({ startUrl: 'https://boutique-alpha.test/c', store: 'lost' });
  await until(() => ext.jobs().length === 1);
  bridge.onStatus('disconnected');
  assert.ok(await until(() => findJob(controller, (j) => j.store === 'lost')));
  const j = findJob(controller, (x) => x.store === 'lost');
  assert.equal(j.status, 'error');
  assert.match(j.reason, /connexion avec l’extension/);
  assert.equal(ext.jobs().length, 1, 'no automatic retry');
  assert.equal(svc.status().activeJob, null);
  assert.equal(res.ok, true);
});

test('IPC input validation: malformed payloads get a French refusal, never a throw', async () => {
  const { ipc } = setup();
  for (const bad of [null, 'x', [], 5, { startUrl: 12 }]) {
    const r = await ipc['yb:run'](bad);
    assert.equal(r.ok, false);
    assert.ok(typeof r.message === 'string' && r.message.length > 5);
  }
  assert.equal((await ipc['yb:availability'](123)).code, 'invalid_url');
  const st = await ipc['yb:status']();
  assert.deepEqual(Object.keys(st).sort(), ['activeJob', 'bridge', 'browser', 'enabled', 'extension', 'job']);
});

test('no service at all (init failed) → handlers answer safely', async () => {
  const ipc = createYourBrowserHandlers({ getService: () => null, readConfig: () => CFG });
  assert.equal((await ipc['yb:status']()).enabled, false);
  // No service → the bridge is down, so the extension cannot be connected: the
  // honest next step is to connect it (not a config/restart message).
  assert.equal((await ipc['yb:availability']('https://boutique-alpha.test/')).code, 'extension_not_connected');
  assert.equal((await ipc['yb:run']({ startUrl: 'https://pas-configure.test/' })).code, 'extension_not_connected');
  assert.equal((await ipc['yb:stop']('x')).code, 'unknown_job');
});
