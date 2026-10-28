/**
 * BrowserSession.collectListing never hangs a job and never reads another page:
 *  - a page that stops answering (a call left bound to a document the page
 *    replaced, and a close() that never settles) → returns within the deadline
 *    with what was collected and error 'deadline';
 *  - a "load more" match that navigates to another page → collection stops and
 *    nothing from that page is kept;
 *  - a matched control that loads nothing is not clicked again; the page is
 *    scrolled on every step.
 * Offline: a fake Playwright page (no browser, no network).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSession } from '../browser.mjs';

// Fake page: dispatches page.evaluate by its argument shape (the recipe-card
// snapshot gets { card, urlSel }, the load-more matcher gets the regex source).
function fakePage({ url, cardsAt, onClick, hangAfterCalls = Infinity, closeHangs = false }) {
  const state = { url, scrolls: 0, clicks: 0, calls: 0 };
  const never = new Promise(() => {});
  const page = {
    state,
    route: async () => {}, goto: async () => {}, waitForLoadState: async () => {},
    waitForFunction: async () => { throw new Error('timeout'); }, waitForTimeout: async () => {},
    frames: () => [], url: () => state.url, click: async () => {},
    close: () => (closeHangs ? never : Promise.resolve()),
    evaluate: async (fn, arg) => {
      state.calls++;
      if (state.calls > hangAfterCalls) return never;
      const src = String(fn);
      if (arg && typeof arg === 'object' && 'card' in arg) return cardsAt(state).map((k) => ({ key: k, html: `<div class="c"><a href="${k}">${k}</a></div>` }));
      if (typeof arg === 'string') { const r = onClick ? onClick(state) : false; if (r) state.clicks++; return r; }
      if (src.includes('scrollTo')) { state.scrolls++; return undefined; }
      if (src.includes('outerHTML')) return '<html><body></body></html>';
      if (src.includes('.length')) return 0;
      return [];
    },
  };
  return page;
}
function sessionWith(page) {
  const s = new BrowserSession({ headless: true });
  s._ensure = async () => ({ newPage: async () => page });
  return s;
}
const L = 'https://shop.test/list';

test('a page that stops answering: collectListing returns by the deadline with what it had (error "deadline")', async () => {
  const page = fakePage({ url: L, cardsAt: () => [`${L}/a`, `${L}/b`], hangAfterCalls: 3, closeHangs: true });
  const t0 = Date.now();
  const r = await sessionWith(page).collectListing(L, { recipeCard: '.c', stopAt: 50, maxScrolls: 5, overallTimeoutMs: 400 });
  const ms = Date.now() - t0;
  assert.equal(r.error, 'deadline');
  assert.equal(r.recipeCardsHtml.length, 2, 'the cards read before the page stopped answering are kept');
  assert.ok(ms < 6000, `returned in ${ms} ms (close() is bounded too)`);
});

test('a "load more" match that leads to another page ends the collection; that page is not read', async () => {
  const page = fakePage({
    url: L,
    cardsAt: (st) => (st.url === L ? [`${L}/a`, `${L}/b`] : ['https://shop.test/other/x', 'https://shop.test/other/y']),
    onClick: (st) => { st.url = 'https://shop.test/other'; return true; }, // a menu link "Mehr"
  });
  const r = await sessionWith(page).collectListing(L, { recipeCard: '.c', stopAt: 50, maxScrolls: 5, overallTimeoutMs: 5000 });
  assert.equal(r.error, null);
  assert.deepEqual(r.recipeCardsHtml.map((h) => h.match(/href="([^"]+)"/)[1]), [`${L}/a`, `${L}/b`]);
  assert.equal(r.html, null, 'the other page HTML is not returned');
  assert.deepEqual(r.pageLinks, []);
});

test('scroll on every step; a control that loads nothing is not clicked again; the cap stops the loop', async () => {
  let n = 2;
  const page = fakePage({
    url: L,
    cardsAt: (st) => { n = 2 + st.scrolls * 3; return Array.from({ length: n }, (_, i) => `${L}/p${i}`); },
    onClick: () => true, // a "Weitere Filter" button: matches, loads nothing by itself
  });
  const r = await sessionWith(page).collectListing(L, { recipeCard: '.c', stopAt: 10, maxScrolls: 8, overallTimeoutMs: 5000 });
  assert.equal(r.error, null);
  assert.ok(r.recipeCardsHtml.length >= 10, `${r.recipeCardsHtml.length} cards`);
  assert.ok(page.state.scrolls >= 3, 'scrolled every step');
  assert.ok(page.state.clicks >= 1);
});

test('a matched control that loads nothing is clicked once only, and the loop stops on a stale list', async () => {
  const page = fakePage({ url: L, cardsAt: () => [`${L}/a`], onClick: () => true });
  const r = await sessionWith(page).collectListing(L, { recipeCard: '.c', stopAt: 10, maxScrolls: 8, overallTimeoutMs: 5000 });
  assert.equal(r.recipeCardsHtml.length, 1);
  assert.equal(page.state.clicks, 1);
  assert.equal(page.state.scrolls, 2, 'two stale rounds, then stop');
});
