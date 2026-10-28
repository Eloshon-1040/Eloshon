/**
 * Sub-pages read in the user's browser: each product page once, a couple of tabs at a time, a pause
 * between pages, failures counted, the tabs closed, a time budget. Offline (fake tab functions).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSubpages, subpageUrls } from '../../extension/background/subpages.mjs';

test('subpageUrls: each row\'s own page once, on the list\'s site only, in list order, capped', () => {
  const rows = [
    { sourceUrl: 'https://www.shop.test/p/1#reviews' }, { sourceUrl: 'https://www.shop.test/p/1' }, { url: 'https://shop.test/p/2' },
    { sourceUrl: 'https://tracker.other.test/p/3' }, { name: 'no link' }, { sourceUrl: 'javascript:void(0)' },
  ];
  assert.deepEqual(subpageUrls(rows, 'https://www.shop.test/c/phones'), ['https://www.shop.test/p/1', 'https://shop.test/p/2']);
  assert.equal(subpageUrls(Array.from({ length: 10 }, (_, i) => ({ sourceUrl: `https://shop.test/p/${i}` })), 'https://shop.test/', 4).length, 4);
});

test('readSubpages: every page visited once, two tabs at a time, a failure counted, the tabs closed', async () => {
  const urls = Array.from({ length: 7 }, (_, i) => `https://shop.test/p/${i}`);
  const opened = []; const closed = []; const visited = []; const sent = []; let inFlight = 0; let maxInFlight = 0; const pauses = [];
  const rep = await readSubpages(urls, {
    open: async () => { const id = opened.length + 1; opened.push(id); return id; },
    visit: async (w, url) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; visited.push(url); return url.endsWith('/3') ? null : { html: `<html>${url}</html>` }; },
    close: async (w) => { closed.push(w); },
    send: async (url, html) => { sent.push([url, html.length > 0]); return true; },
    sleep: async (ms) => { pauses.push(ms); }, random: () => 0.5, pauseMs: [700, 1500], retries: 0,
  });
  assert.deepEqual([...visited].sort(), [...urls].sort());
  assert.equal(rep.read, 6); assert.equal(rep.failed, 1); assert.equal(rep.sent, 6);
  assert.equal(opened.length, 2); assert.deepEqual(closed.sort(), [1, 2]);
  assert.equal(maxInFlight, 2, 'two pages at a time, never more');
  assert.ok(pauses.every((ms) => ms === 1100), 'an irregular pause between pages (here the middle of the range)');
});

test('readSubpages: a failed page never stops the others; it is tried once more at the end, and why it failed is kept', async () => {
  const urls = Array.from({ length: 5 }, (_, i) => `https://shop.test/p/${i}`);
  const visits = new Map(); const outcomes = [];
  const rep = await readSubpages(urls, {
    open: async () => 1, close: async () => {}, sleep: async () => {}, concurrency: 1,
    // p/1 is slow the first time only; p/3 never renders; the app refuses p/4 (too large)
    visit: async (w, url) => { const n = (visits.get(url) || 0) + 1; visits.set(url, n); if (url.endsWith('/1') && n === 1) return { error: 'chargement trop long' }; if (url.endsWith('/3')) return null; return { html: `<html>${url}</html>` }; },
    send: async (url) => (url.endsWith('/4') ? 'page_too_large' : true),
    onOutcome: (u, o, why) => outcomes.push([u.slice(-1), o, why]),
  });
  assert.deepEqual([...visits.values()], [1, 2, 1, 2, 2], 'only the failed pages are opened again, once');
  assert.equal(rep.read, 3); assert.equal(rep.sent, 3); assert.equal(rep.failed, 2); assert.equal(rep.retried, 3);
  assert.equal(rep.outcomes.get('https://shop.test/p/1'), 'read', 'the slow page was read on its second try');
  assert.equal(rep.reasons.get('https://shop.test/p/3'), 'la page n’a rien rendu de lisible');
  assert.equal(rep.reasons.get('https://shop.test/p/4'), 'page_too_large');
  assert.deepEqual(rep.notOpened, []);
  assert.deepEqual(outcomes.slice(0, 2), [['0', 'read', null], ['1', 'failed', 'chargement trop long']]);
  const human = await readSubpages(['https://shop.test/p/9'], { open: async () => 1, close: async () => {}, sleep: async () => {}, visit: async () => ({ challenge: true }), send: async () => true });
  assert.equal(human.retried, 0, 'a human check is never retried behind the user\'s back');
});

test('readSubpages: stops on the time budget or when stopped, and says why', async () => {
  let t = 0;
  const io = { open: async () => 1, close: async () => {}, send: async () => true, sleep: async () => {}, visit: async () => { t += 60000; return { html: 'x' }; }, now: () => t };
  const rep = await readSubpages(Array.from({ length: 10 }, (_, i) => `https://s.test/p/${i}`), { ...io, concurrency: 1, budgetMs: 120000 });
  assert.equal(rep.stoppedBy, 'time'); assert.ok(rep.read < 10);
  let n = 0;
  const rep2 = await readSubpages(['https://s.test/a', 'https://s.test/b', 'https://s.test/c'], { ...io, now: () => 0, concurrency: 1, isStopped: () => n++ >= 1 });
  assert.equal(rep2.stoppedBy, 'stopped'); assert.equal(rep2.read, 1);
});
