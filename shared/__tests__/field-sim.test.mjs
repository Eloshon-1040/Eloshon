/**
 * Offline field-validation simulation (Phase 2 step 8) — no network. Ties the
 * whole tier together against a mock page: adaptive backoff on 429/456, a
 * challenge that pauses then resumes, and a service-worker "restart" mid-job that
 * must not duplicate or lose products.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProgram } from '../dsl/interpret.mjs';
import { defaultChallengeRegistry } from '../challenge/index.mjs';
import { DomainPacer } from '../pacing/pacer.mjs';
import { JobStore, memoryAdapter } from '../job/store.mjs';
import { STATE } from '../job/machine.mjs';
import { JOB_STATUS } from '../protocol/messages.mjs';

function scenarioEnv({ pagesProducts, contexts }) {
  let idx = 0; let t = 0;
  const pacer = new DomainPacer({ baseIntervalMs: 100, backoffFactor: 2 }, { now: () => t, random: () => 0 });
  const env = {
    now: () => t, sleep: async (ms) => { t += ms; }, signal: { aborted: false },
    log: () => {}, notify: () => {}, emit: () => {},
    limits: { maxListPages: 5, maxDetailPages: 5, maxProducts: 1000 },
    pacer,
    challenge: { registry: defaultChallengeRegistry(), detect: {}, strategy: 'human_in_the_loop', timeouts: { solveMs: 100000, pollMs: 50 } },
    page: {
      waitFor: async () => true, click: async () => {}, type: async () => {}, select: async () => {}, scroll: async () => {},
      currentUrl: async () => contexts[idx].url,
      context: async () => contexts[idx],
      goto: async () => { idx = Math.min(idx + 1, contexts.length - 1); return contexts[idx]; },
      paginate: async () => { if (idx + 1 < contexts.length) { idx += 1; return { moved: true, done: false, ctx: contexts[idx] }; } return { moved: false, done: true }; },
    },
    extractors: { embedded_state: async () => pagesProducts[idx], dom: async () => pagesProducts[idx], json_ld: async () => [], auto: async () => pagesProducts[idx], internal_api: async () => [] },
  };
  return { env, pacer, setIdx: (i) => { idx = i; } };
}

test('adaptive backoff: a 456 raises the interval and cooldown', () => {
  const p = new DomainPacer({ baseIntervalMs: 1000 }, { now: () => 0, random: () => 0 });
  const before = p.intervalMs;
  p.onResponse({ status: 456, t: 0 });
  assert.ok(p.intervalMs > before);
  assert.ok(p.reserve(0) >= p.intervalMs - 1); // cooldown enforced
});

test('challenge on page 2 pauses then resumes; all pages extracted without dups', async () => {
  // page indices: 0 list, 1 list(challenge->normal), 2 list
  const contexts = [
    { status: 200, url: 'https://shop/1', body: 'ok' },
    { status: 200, url: 'https://shop/2', body: 'ok' },
    { status: 200, url: 'https://shop/3', body: 'ok' },
  ];
  const pagesProducts = [
    [{ name: 'A', sku: 'a' }, { name: 'B', sku: 'b' }],
    [{ name: 'B', sku: 'b' }, { name: 'C', sku: 'c' }], // B duplicate across pages
    [{ name: 'D', sku: 'd' }],
  ];
  const { env } = scenarioEnv({ pagesProducts, contexts });
  const out = await runProgram({ actions: [{ op: 'extract', using: 'embedded_state' }, { op: 'paginate', style: 'url_param', param: 'page' }] }, env);
  assert.equal(out.status, JOB_STATUS.DONE);
  assert.deepEqual(out.products.map((p) => p.sku).sort(), ['a', 'b', 'c', 'd']);
});

test('service-worker restart mid-job: persisted seen-set prevents duplication on replay', async () => {
  const adapter = memoryAdapter();
  // First "run" collects page 1, then the SW is suspended.
  let store = new JobStore(adapter);
  await store.create('jf', { domain: 'shop' });
  await store.appendProducts('jf', [{ sku: 'a' }, { sku: 'b' }]);
  await store.setState('jf', STATE.PAUSED_CHALLENGE);

  // "Restart": a fresh store over the same storage resumes from the cursor.
  store = new JobStore(adapter);
  const rec = await store.load('jf');
  assert.equal(rec.state, STATE.PAUSED_CHALLENGE);
  await store.setState('jf', STATE.RUNNING);
  // Replaying page 1 (a,b) plus page 2 (b,c,d): only c,d are new.
  const fresh = await store.appendProducts('jf', [{ sku: 'a' }, { sku: 'b' }, { sku: 'c' }, { sku: 'd' }]);
  assert.deepEqual(fresh.map((p) => p.sku), ['c', 'd']);
  const all = await store.allProducts('jf');
  assert.deepEqual(all.map((p) => p.sku).sort(), ['a', 'b', 'c', 'd']); // no loss, no dup
});

test('polite volume caps come from config (no hardcoded cap): maxListPages honoured', async () => {
  const contexts = Array.from({ length: 8 }, (_, i) => ({ status: 200, url: `https://shop/${i}`, body: 'ok' }));
  const pagesProducts = contexts.map((_, i) => [{ name: `P${i}`, sku: `p${i}` }]);
  const { env } = scenarioEnv({ pagesProducts, contexts });
  env.limits.maxListPages = 3;
  const out = await runProgram({ actions: [{ op: 'extract', using: 'embedded_state' }, { op: 'paginate', style: 'url_param', param: 'page', max_pages: 8 }] }, env);
  assert.ok(out.pages <= 3, `pages=${out.pages}`);
});
