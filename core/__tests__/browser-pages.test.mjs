/**
 * Pages read in the local browser after a site refused plain HTTP: spaced, bounded,
 * and the FIRST human check the site asks for stops the reader for the run (no
 * intervention prompt, no retry). Offline: fake session + clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserPageReader } from '../browser-pages.mjs';

const fakeClock = () => { let t = 1000; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

test('spaced pages; the render never asks for an intervention', async () => {
  const clock = fakeClock(); const seen = [];
  const session = { render: async (u, o) => { seen.push({ u, at: clock.now(), intervene: o && o.intervene }); return { html: `<h1>${u}</h1>`, status: 200, block: null }; } };
  const r = browserPageReader({ getSession: async () => session, minGapMs: 3000, ...clock });
  for (const u of ['a', 'b', 'c']) assert.equal((await r.read(u)).ok, true);
  assert.deepEqual(seen.map((x) => x.at), [1000, 4000, 7000]);
  assert.ok(seen.every((x) => x.intervene === false));
  assert.equal(r.stats.pages, 3);
});

test('the first human check stops the reader for the rest of the run', async () => {
  let n = 0;
  const session = { render: async () => (++n === 3 ? { html: '<title>Just a moment...</title>', status: 403, block: { code: 'BOT_CHALLENGE', terminal: true } } : { html: '<p>ok</p>', status: 200, block: null }) };
  const r = browserPageReader({ getSession: async () => session, minGapMs: 0 });
  assert.equal((await r.read('1')).ok, true);
  assert.equal((await r.read('2')).ok, true);
  assert.deepEqual(await r.read('3'), { ok: false, status: 403, blocked: true });
  assert.equal(await r.read('4'), null);
  assert.equal(n, 3, 'no page asked after the check');
  // 2 read; page 3 (the check) and page 4 (asked after it) not re-read: the report says so.
  const { ms, ...counts } = r.stats; assert.ok(ms >= 0);
  assert.deepEqual(counts, { pages: 3, ok: 2, notRead: 2, stoppedBy: 'human_check' });
});

test('budget and missing browser', async () => {
  const session = { render: async () => ({ html: 'x', status: 200 }) };
  const r = browserPageReader({ getSession: async () => session, minGapMs: 0, budget: 2 });
  await r.read('1'); await r.read('2');
  assert.equal(await r.read('3'), null);
  assert.equal(r.stats.stoppedBy, 'budget');
  const none = browserPageReader({ getSession: async () => null });
  assert.equal(await none.read('1'), null);
  assert.equal(none.stats.stoppedBy, 'browser_unavailable');
});
