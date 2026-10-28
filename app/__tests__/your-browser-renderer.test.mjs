/**
 * "Scraper via votre navigateur" wired into the REAL renderer (app/renderer/app.js),
 * driven through a tiny DOM-free harness and a FAKE window.eloshon bridge (no
 * Electron, no network): New scrape → mode option → launch → running screen
 * (challenge pause, Reprendre, Abandonner) → completion → Jobs list badge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- minimal DOM stand-in: elements by id, innerHTML captured as strings ----
const els = new Map();
const el = (id) => { if (!els.has(id)) els.set(id, { id, value: '', innerHTML: '', textContent: '', classList: { add() {}, remove() {}, toggle() {} }, focus() {}, setSelectionRange() {} }); return els.get(id); };
const listeners = {};
globalThis.document = {
  getElementById: (id) => el(id),
  addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  body: { classList: { add() {} } },
  activeElement: null,
  createElement: () => el('x-' + Math.random()),
};
globalThis.requestAnimationFrame = (fn) => fn();

// ---- fake main-process bridge ----
const calls = [];
let eventCb = null;
const JOBS = [];
const AV_OK = { ok: true, code: null, domain: 'boutique-alpha.test', enabled: true, connected: true, browser: 'chrome', limits: { maxProducts: 500, maxListPages: 3, maxDetailPages: 5 }, bounds: { maxProducts: { min: 1, max: 5000 }, maxListPages: { min: 1, max: 50 }, maxDetailPages: { min: 0, max: 500 } } };
let avAnswer = AV_OK;
globalThis.window = {
  eloshon: {
    platform: 'win32', uiReady() {}, win: {},
    appInfo: async () => ({ version: 't', arch: 'x64', packaged: false }),
    settings: { get: async () => ({}), set: async (p) => p },
    jobs: { list: async () => JOBS, report: async () => ({ ok: true, text: 'r' }), products: async () => [] },
    accountStatus: async () => ({ rate: null }),
    onEvent: (cb) => { eventCb = cb; },
    scrape: { start: async (i) => { calls.push(['scrape.start', i]); return { ok: true }; } },
    yourBrowser: {
      availability: async (url) => { calls.push(['availability', url]); return avAnswer; },
      run: async (job) => { calls.push(['run', job]); return { ok: true, jobId: 'yb_1', domain: 'boutique-alpha.test', limits: job.limits }; },
      resume: async (id) => { calls.push(['resume', id]); return { ok: true }; },
      stop: async (id) => { calls.push(['stop', id]); return { ok: true }; },
      pause: async () => ({ ok: true }),
      status: async () => ({}),
    },
  },
};

const html = () => el('app').innerHTML;
const click = async (dataset) => { for (const fn of listeners.click || []) await fn({ target: { closest: () => ({ dataset }) } }); await tick(); };
const tick = () => new Promise((r) => setTimeout(r, 0));
const typeUrl = async (url) => { el('f-url').value = url; for (const fn of listeners.input || []) fn({ target: { id: 'f-url' } }); await new Promise((r) => setTimeout(r, 350)); await tick(); };

test('New scrape → "via votre navigateur" → running (challenge, Reprendre, Abandonner) → complete → Jobs badge', async () => {
  await import('../renderer/app.js');
  await tick(); await tick();

  // Open "Nouveau scraping": the mode picker is there, with both options.
  await click({ nav: 'new' });
  assert.match(html(), /data-mode="standard"/);
  assert.match(html(), /Scraper via votre navigateur/);

  // A site NOT configured: the option is greyed with the plain message.
  avAnswer = { ok: false, code: 'domain_not_enabled', domain: 'pas-configure.test', enabled: false, connected: true };
  await typeUrl('https://pas-configure.test/x');
  assert.match(el('yb-mode').innerHTML, /aria-disabled="true"/);
  assert.match(el('yb-mode').innerHTML, /Ce mode n’est pas encore configuré pour ce site\./);
  await click({ act: 'yb-mode', mode: 'yb' });
  assert.doesNotMatch(html(), /id="yb-maxp"/, 'cannot pick the mode for an unconfigured site');

  // A configured site: pick the mode → bounded limits appear, standard options hide.
  avAnswer = AV_OK;
  await typeUrl('https://boutique-alpha.test/rayon');
  await click({ act: 'yb-mode', mode: 'yb' });
  assert.match(html(), /id="yb-maxp" type="number" min="1" max="5000" value="500"/);
  assert.doesNotMatch(html(), /id="f-maxpg"/);
  assert.match(html(), /Démarrer via votre navigateur/);

  // Launch → the validated run call (only primitives), no standard scrape started.
  el('f-url').value = 'https://boutique-alpha.test/rayon'; el('f-store').value = 'alpha'; el('yb-maxp').value = '40';
  await click({ act: 'start' });
  const run = calls.find((c) => c[0] === 'run');
  assert.ok(run, 'run called');
  assert.equal(run[1].startUrl, 'https://boutique-alpha.test/rayon');
  assert.equal(run[1].store, 'alpha');
  assert.equal(run[1].limits.maxProducts, 40);
  assert.ok(!calls.some((c) => c[0] === 'scrape.start'), 'the standard engine is not started');
  assert.match(html(), /Scraping via votre navigateur/);
  assert.match(html(), /Connexion/);

  // Challenge pause → the action message + Reprendre.
  eventCb('yourBrowser', { kind: 'state', extension: 'connected', job: { id: 'yb_1', phase: 'paused', message: null } });
  assert.match(html(), /résolvez le défi dans l’onglet/);
  await click({ act: 'yb-resume' });
  assert.deepEqual(calls.find((c) => c[0] === 'resume'), ['resume', 'yb_1']);
  eventCb('yourBrowser', { kind: 'state', extension: 'connected', job: { id: 'yb_1', phase: 'running', done: 1, total: 2 } });
  assert.match(html(), /En cours/);
  // « Abandonner… » asks first (system.md §7.4): nothing is stopped until the user confirms.
  await click({ act: 'yb-stop' });
  assert.match(html(), /Abandonner le scraping \?/);
  assert.ok(!calls.some((c) => c[0] === 'stop'), 'no stop before the confirmation');
  await click({ act: 'stop-confirm' });
  assert.deepEqual(calls.find((c) => c[0] === 'stop'), ['stop', 'yb_1']);
  assert.match(html(), /Abandon en cours…/);

  // The job pipeline finishes the run → the normal completion screen.
  eventCb('done', { jobId: 'job-9', status: 'interrupted', stoppedByUser: true, method: 'your-browser', reason: 'Scraping abandonné à votre demande.', counts: { accepted: 1, toVerify: 0, excluded: 0, detected: 1 }, csvPath: 'C:/x.csv', reportPath: 'C:/x.txt' });
  assert.match(html(), /Scraping arrêté/);

  // Jobs history: the run is listed with the "Votre navigateur" badge, results + report, no engine "Reprendre".
  JOBS.push({ id: 'job-9', status: 'interrupted', source: 'https://boutique-alpha.test/rayon', store: 'alpha', createdAt: '2026-09-29T10:00:00Z', products: 1, discovered: 0, processed: 0, via: 'your-browser', isUrl: true });
  await click({ nav: 'jobs' });
  assert.match(html(), /Votre navigateur/);
  assert.match(html(), /data-act="view-results" data-job="job-9"/);
  assert.match(html(), /data-act="view-report" data-job="job-9"/);
  assert.doesNotMatch(html(), /data-act="resume-prompt" data-job="job-9"/);
});
