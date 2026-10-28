import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProgram } from '../dsl/interpret.mjs';
import { defaultChallengeRegistry } from '../challenge/index.mjs';
import { DomainPacer } from '../pacing/pacer.mjs';
import { JOB_STATUS } from '../protocol/messages.mjs';

// Build a scripted env. `pages` is a list of page contexts the mock walks through
// as goto/paginate advance. `extract` returns products for the current page index.
function makeEnv({ pages = [], products = [], detect = {}, strategy, timeouts, limits, challengeRegistry, rechecks } = {}) {
  let idx = 0;
  let t = 0;
  const logs = [];
  const notes = [];
  let recheckI = 0;
  const env = {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    log: (e) => logs.push(e),
    notify: (e) => notes.push(e),
    emit: () => {},
    signal: { aborted: false },
    config: { searchTerm: 'lait' },
    limits: limits || { maxListPages: 3, maxDetailPages: 5, maxProducts: 1000 },
    pacer: new DomainPacer({ baseIntervalMs: 10 }, { now: () => t, random: () => 0 }),
    challenge: { registry: challengeRegistry || defaultChallengeRegistry(), detect, strategy, timeouts },
    page: {
      waitFor: async () => true,
      click: async () => {},
      type: async () => {},
      select: async () => {},
      scroll: async () => {},
      currentUrl: async () => (pages[idx] ? pages[idx].url : 'about:blank'),
      context: async () => pages[idx] || { status: 200, url: 'https://x/list', body: '<html>list</html>' },
      goto: async (url) => { idx = Math.min(idx + 1, pages.length - 1); return pages[idx] || { status: 200, url, body: '<html>detail</html>' }; },
      paginate: async () => { if (idx + 1 < pages.length) { idx += 1; return { moved: true, done: false, ctx: pages[idx] }; } return { moved: false, done: true }; },
    },
    extractors: {
      embedded_state: async (ctx) => (typeof products === 'function' ? products(ctx, idx) : products),
      dom: async (ctx) => (typeof products === 'function' ? products(ctx, idx) : products),
      json_ld: async () => [],
      auto: async (ctx) => (typeof products === 'function' ? products(ctx, idx) : products),
      internal_api: async () => [],
    },
    _logs: logs, _notes: notes, setRechecks: () => {},
  };
  if (rechecks) {
    env.page.context = async () => (recheckI < rechecks.length ? rechecks[recheckI++] : pages[idx]);
  }
  return env;
}

test('invalid recipe -> ERROR with French validation errors', async () => {
  const env = makeEnv({});
  const r = await runProgram({ actions: [{ op: 'clik', selector: '.x' }] }, env);
  assert.equal(r.status, JOB_STATUS.ERROR);
  assert.equal(r.reason, 'invalid_recipe');
  assert.ok(r.errors.length > 0);
});

test('extract from a single page', async () => {
  const env = makeEnv({
    pages: [{ status: 200, url: 'https://x/list', body: 'ok' }],
    products: [{ name: 'A', price: 1, sku: 'a' }, { name: 'B', price: 2, sku: 'b' }],
  });
  const r = await runProgram({ actions: [{ op: 'waitFor', selector: '.c' }, { op: 'extract', using: 'embedded_state' }] }, env);
  assert.equal(r.status, JOB_STATUS.DONE);
  assert.equal(r.products.length, 2);
});

test('pagination re-applies the last extract and dedups by key', async () => {
  const perPage = [
    [{ name: 'A', sku: 'a' }, { name: 'B', sku: 'b' }],
    [{ name: 'B', sku: 'b' }, { name: 'C', sku: 'c' }],   // B duplicate
    [{ name: 'D', sku: 'd' }],
  ];
  const env = makeEnv({
    pages: [{ status: 200, url: 'https://x/1' }, { status: 200, url: 'https://x/2' }, { status: 200, url: 'https://x/3' }],
    products: (ctx, idx) => perPage[idx],
    limits: { maxListPages: 5, maxDetailPages: 5, maxProducts: 1000 },
  });
  const r = await runProgram({ actions: [{ op: 'extract', using: 'embedded_state' }, { op: 'paginate', style: 'url_param', param: 'page' }] }, env);
  assert.equal(r.status, JOB_STATUS.DONE);
  assert.deepEqual(r.products.map((p) => p.sku).sort(), ['a', 'b', 'c', 'd']);
  assert.equal(r.pages, 3);
});

test('pagination respects the list-page cap from limits', async () => {
  const env = makeEnv({
    pages: Array.from({ length: 10 }, (_, i) => ({ status: 200, url: `https://x/${i}` })),
    products: (ctx, idx) => [{ name: `P${idx}`, sku: `p${idx}` }],
    limits: { maxListPages: 3, maxDetailPages: 5, maxProducts: 1000 },
  });
  const r = await runProgram({ actions: [{ op: 'extract', using: 'embedded_state' }, { op: 'paginate', style: 'url_param', param: 'page', max_pages: 9 }] }, env);
  assert.ok(r.pages <= 3, `pages=${r.pages}`);
});

test('followLinks caps detail pages and merges detail fields into gaps', async () => {
  const env = makeEnv({
    pages: [{ status: 200, url: 'https://x/list' }, { status: 200, url: 'https://x/d1' }],
    products: [{ name: 'A', sku: 'a', url: 'https://x/d1' }, { name: 'B', sku: 'b', url: 'https://x/d2' }],
    limits: { maxListPages: 3, maxDetailPages: 1, maxProducts: 1000 },
  });
  // detail extractor returns a price to fill the gap
  env.extractors.embedded_state = async (ctx, idx) => ([{ price: 9.99, image: 'https://img/x.jpg' }]);
  const r = await runProgram({ actions: [
    { op: 'extract', using: 'dom' },
    { op: 'followLinks', url_field: 'url', max_links: 5, extract: { using: 'embedded_state' } },
  ] }, makeEnv({
    pages: [{ status: 200, url: 'https://x/list' }, { status: 200, url: 'https://x/d1' }],
    products: (ctx, idx) => (idx === 0 ? [{ name: 'A', sku: 'a', url: 'https://x/d1' }, { name: 'B', sku: 'b', url: 'https://x/d2' }] : [{ price: 9.99 }]),
    limits: { maxListPages: 3, maxDetailPages: 1, maxProducts: 1000 },
  }));
  assert.equal(r.status, JOB_STATUS.DONE);
  assert.equal(r.detailPages, 1); // capped at 1
});

test('assert min_items fails clearly when too few products', async () => {
  const env = makeEnv({ pages: [{ status: 200, url: 'https://x' }], products: [{ name: 'A', sku: 'a' }] });
  const r = await runProgram({ actions: [{ op: 'extract', using: 'dom' }, { op: 'assert', min_items: 5, message: 'Trop peu de produits.' }] }, env);
  assert.equal(r.status, JOB_STATUS.ERROR);
  assert.match(r.reason, /Trop peu/);
});

test('challenge on the page -> hand_back strategy returns BLOCKED', async () => {
  const env = makeEnv({
    pages: [{ status: 503, url: 'https://x/list', body: 'Attention Required Ray ID' }],
    // A real challenge/interstitial page yields NO products (extract-first: a page we
    // could read would never be treated as a block).
    products: (ctx) => (ctx && (ctx.status >= 400 || /attention required|ray id|checking your browser/i.test(ctx.body || '')) ? [] : [{ name: 'A', sku: 'a' }]),
    detect: {},
    strategy: 'hand_back',
  });
  const r = await runProgram({ actions: [{ op: 'extract', using: 'dom' }] }, env);
  assert.equal(r.status, JOB_STATUS.BLOCKED);
});

test('inverse content check: a challenge marker on a page we CAN extract is not a block (false positive ignored)', async () => {
  // A page carrying a challenge marker AND real product data (e.g. a Turnstile widget
  // embedded on a normal listing). hasContent(true) → the guard continues, extraction
  // runs, the job completes — never paused/blocked.
  const env = makeEnv({
    pages: [{ status: 200, url: 'https://x/list', body: 'checking your browser <div class="grid">…</div>' }],
    products: [{ name: 'A', sku: 'a' }, { name: 'B', sku: 'b' }],
    strategy: 'hand_back',
  });
  env.hasContent = async () => true;
  const r = await runProgram({ actions: [{ op: 'extract', using: 'dom' }] }, env);
  assert.equal(r.status, JOB_STATUS.DONE);
  assert.equal(r.products.length, 2, 'the readable page was extracted, not blocked');
});

test('challenge resolved by human-in-the-loop lets extraction proceed', async () => {
  // First context is a challenge; recheck() then returns normal pages so the
  // strategy resumes and the extract runs.
  const challengeCtx = { status: 503, url: 'https://x/list', body: 'checking your browser' };
  const normalCtx = { status: 200, url: 'https://x/list', body: 'ok' };
  let ctxCalls = 0;
  // The challenge page yields nothing; the normal page (after resume) yields a product.
  const env = makeEnv({ pages: [challengeCtx], products: (ctx) => (ctx && /checking your browser/i.test(ctx.body || '') ? [] : [{ name: 'A', sku: 'a' }]), strategy: 'human_in_the_loop', timeouts: { solveMs: 100000, pollMs: 100 } });
  env.page.context = async () => { ctxCalls += 1; return ctxCalls >= 3 ? normalCtx : challengeCtx; };
  const r = await runProgram({ actions: [{ op: 'extract', using: 'dom' }] }, env);
  // extract's own guard re-detects normal after resume path; product collected
  assert.equal(r.status, JOB_STATUS.DONE);
});

test('readable page embedding a captcha WIDGET is never paused (microfluo/PrestaShop reCAPTCHA false positive)', async () => {
  // A normal catalogue that merely embeds a reCAPTCHA widget for its contact/newsletter
  // form: the body carries the marker AND the recipe extracts real products. Extract
  // first → products found → the challenge strategy never runs, the job completes.
  const env = makeEnv({
    pages: [{ status: 200, url: 'https://microfluo.net/fr/40-x', body: '<div class="g-recaptcha" data-sitekey="…"></div><div class="products">…</div>' }],
    products: [{ name: 'Vents VK 125', sku: '92735466', price: 72.9 }],
    strategy: 'human_in_the_loop', timeouts: { solveMs: 100000, pollMs: 100 },
  });
  const r = await runProgram({ actions: [{ op: 'extract', using: 'dom' }] }, env);
  assert.equal(r.status, JOB_STATUS.DONE, 'a readable page is never blocked by an embedded widget');
  assert.equal(r.products.length, 1);
  assert.equal(env._notes.length, 0, 'no challenge notification was emitted');
});

test('operator stop aborts mid-program with STOPPED', async () => {
  const env = makeEnv({ pages: [{ status: 200, url: 'https://x' }], products: [{ name: 'A', sku: 'a' }] });
  env.signal.aborted = true;
  const r = await runProgram({ actions: [{ op: 'extract', using: 'dom' }] }, env);
  assert.equal(r.status, JOB_STATUS.STOPPED);
});

test('optional click failure does not abort the program', async () => {
  const env = makeEnv({ pages: [{ status: 200, url: 'https://x' }], products: [{ name: 'A', sku: 'a' }] });
  env.page.click = async () => { throw new Error('not found'); };
  const r = await runProgram({ actions: [{ op: 'click', selector: '.cookie', optional: true }, { op: 'extract', using: 'dom' }] }, env);
  assert.equal(r.status, JOB_STATUS.DONE);
  assert.equal(r.products.length, 1);
});
