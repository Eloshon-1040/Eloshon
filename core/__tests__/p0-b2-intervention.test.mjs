/**
 * P0 / B2 follow-up — found by the real Adidas check of 2026-10-21: the controller
 * handed the "manual intervention" wait to the local browser even when the run was
 * NOT in intervention mode. A 403 met by a HEADLESS browser then waited forever for
 * a human who could not see anything, and that wait ignored the job's stop — the
 * watchdog fired at 124 s but the job never ended (killed after 15 min).
 * Now: no intervention handler outside intervention mode; in intervention mode the
 * wait ends with the job's signal (as 'skip'). No browser, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interventionHandler } from '../../app/controller.mjs';
import { manualProvider } from '../../app/providers/index.mjs';

test('outside intervention mode: no handler, so no human wait can start', () => {
  assert.equal(interventionHandler({ provider: manualProvider(), interactive: false, signal: new AbortController().signal }), undefined);
});

test('in intervention mode: the wait is the provider\'s, and the job signal ends it as skip', { timeout: 5000 }, async () => {
  const provider = manualProvider(); const ac = new AbortController(); const events = [];
  const h = interventionHandler({ provider, interactive: true, signal: ac.signal, emit: (t, p) => events.push([t, p]) });
  const p = h({ url: 'https://shop.test/c', code: 'ACCESS_DENIED', reason: 'HTTP 403' });
  assert.equal(provider.waiting, true);
  setTimeout(() => ac.abort(), 50);
  assert.equal(await p, 'skip');
  assert.equal(events[0][0], 'intervention');
  // A human answer still works when the job is not stopped.
  const ac2 = new AbortController();
  const h2 = interventionHandler({ provider, interactive: true, signal: ac2.signal });
  const p2 = h2({ url: 'https://shop.test/c', code: 'CAPTCHA', reason: 'captcha' });
  provider.continue();
  assert.equal(await p2, 'retry');
});

test('an already stopped job never starts a wait', async () => {
  const provider = manualProvider(); const ac = new AbortController(); ac.abort();
  const h = interventionHandler({ provider, interactive: true, signal: ac.signal });
  assert.equal(await h({ url: 'https://shop.test/c', code: 'CAPTCHA', reason: 'x' }), 'skip');
  assert.equal(provider.waiting, false);
});
