/**
 * P0 / B2 — a job stopped by the watchdog says so, in the REAL renderer: the end
 * screen reads "Scraping arrêté : plus aucune progression" with what happened and
 * what to do, never "Scraping arrêté" (a user stop); the Jobs list shows "Sans
 * progression", not "Bloqué". DOM-free harness, fake bridge, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const els = new Map();
const el = (id) => { if (!els.has(id)) els.set(id, { id, value: '', innerHTML: '', textContent: '', classList: { add() {}, remove() {}, toggle() {} }, focus() {}, setSelectionRange() {}, remove() {}, appendChild() {} }); return els.get(id); };
const listeners = {};
globalThis.document = { getElementById: (id) => el(id), addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); }, body: { classList: { add() {} } }, activeElement: null, createElement: () => el('x-' + Math.random()) };
globalThis.requestAnimationFrame = (fn) => fn();
let eventCb = null;
const JOBS = [{ id: 'job-s', status: 'stopped:stalled', source: 'https://shop.test/c', store: 'demo', createdAt: '2026-10-21T10:00:00Z', products: 1, discovered: 1, processed: 1, isUrl: true }];
globalThis.window = { eloshon: {
  platform: 'win32', uiReady() {}, win: {}, appInfo: async () => ({ version: 't', arch: 'x64', packaged: false }),
  settings: { get: async () => ({}), set: async (p) => p },
  jobs: { list: async () => JOBS, report: async () => ({ ok: true, text: 'r' }), products: async () => [] },
  accountStatus: async () => ({ rate: null }), onEvent: (cb) => { eventCb = cb; },
  yourBrowser: { availability: async () => ({ ok: false, code: 'domain_not_enabled', enabled: false, connected: false }), run: async () => ({ ok: false }), resume: async () => ({}), stop: async () => ({}), pause: async () => ({}), status: async () => ({}) },
} };
const html = () => el('app').innerHTML;
const tick = () => new Promise((r) => setTimeout(r, 0));
const click = async (dataset) => { for (const fn of listeners.click || []) await fn({ target: { closest: () => ({ dataset }) } }); await tick(); };

test('a stalled job: exact title, what happened, what to do; the Jobs list says "Sans progression"', async () => {
  await import('../renderer/app.js');
  await tick(); await tick();
  eventCb('done', { jobId: 'job-s', status: 'stopped:stalled', stoppedByUser: false, stalled: true, stallMs: 120000, error: null, counts: { accepted: 1, toVerify: 0, excluded: 0, detected: 1 }, durationMs: 130000 });
  await tick();
  assert.match(html(), /Scraping arrêté : plus aucune progression/);
  assert.match(html(), /Rien n’a avancé pendant 120 s : le job a été arrêté\. Les produits déjà lus sont gardés\. Pour continuer, cliquez sur Reprendre dans Jobs\./);
  await click({ nav: 'jobs' });
  assert.match(html(), /Sans progression/);
  assert.doesNotMatch(html(), /Bloqué/);
  assert.doesNotMatch(html(), /data-tone="danger"/, 'a stall is not shown in red');
});
