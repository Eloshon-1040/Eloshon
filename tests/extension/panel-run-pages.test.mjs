/**
 * The panel goes to the NEXT page when the current one gives nothing more (load more / scroll exhausted),
 * up to the page limit; « Bouton suivant / Paramètre d'URL » go page by page; « Défilement infini » never
 * leaves the page. Offline (fake page functions).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPanelExtraction } from '../../extension/background/panel-run.mjs';

// A list of `pages` pages of `per` products each; nextPage() moves on while there is one.
function site(pages, per) {
  let page = 1; const visits = [];
  return {
    visits,
    read: async () => Array.from({ length: per }, (_, i) => ({ name: `P${page}-${i}`, price: 10, sourceUrl: `https://s.test/p/${page}-${i}` })),
    scroll: async () => {}, loadMore: async () => false,
    path: async () => `/c/list`,
    nextPage: async (mode) => { visits.push(mode); if (page >= pages) return false; page++; return true; },
    sleep: async () => {}, settleMs: 0,
  };
}

test('auto: when a page gives nothing more, the next page — until the last page', async () => {
  const s = site(4, 5);
  const res = await runPanelExtraction({ ...s, settings: { maxProducts: 500, maxPages: 10, pagination: 'auto' } });
  assert.equal(res.rows.length, 20); assert.equal(res.pages, 4); assert.equal(res.stoppedBy, 'end');
});

test('the page limit is honoured', async () => {
  const s = site(9, 5);
  const res = await runPanelExtraction({ ...s, settings: { maxProducts: 500, maxPages: 3, pagination: 'auto' } });
  assert.equal(res.pages, 3); assert.equal(res.rows.length, 15); assert.equal(res.stoppedBy, 'max_pages');
});

test('« Bouton suivant » goes page by page; « Défilement infini » never leaves the page; « Aucune » reads one page', async () => {
  const b = site(3, 4);
  const r1 = await runPanelExtraction({ ...b, settings: { maxProducts: 500, maxPages: 10, pagination: 'button' } });
  assert.equal(r1.rows.length, 12); assert.ok(b.visits.every((m) => m === 'button'));
  const i = site(3, 4);
  const r2 = await runPanelExtraction({ ...i, settings: { maxProducts: 500, maxPages: 10, pagination: 'infinite' } });
  assert.equal(r2.rows.length, 4); assert.equal(i.visits.length, 0);
  const n = site(3, 4);
  const r3 = await runPanelExtraction({ ...n, settings: { maxProducts: 500, maxPages: 10, pagination: 'none' } });
  assert.equal(r3.rows.length, 4); assert.equal(r3.stoppedBy, 'single_page');
});

test('a next page that repeats the same products twice stops the run (a site ignoring ?page=)', async () => {
  let moves = 0;
  const res = await runPanelExtraction({
    read: async () => [{ name: 'same', price: 1, sourceUrl: 'https://s.test/p/1' }], scroll: async () => {}, loadMore: async () => false,
    path: async () => '/c', nextPage: async () => { moves++; return true; }, sleep: async () => {}, settleMs: 0,
    settings: { maxProducts: 500, maxPages: 50, pagination: 'url' },
  });
  assert.equal(res.stoppedBy, 'no_new'); assert.ok(moves <= 3, `stopped after ${moves} useless pages`);
});

// A list of `total` products shown `per` at a time on ONE page: « charger plus » (a button) or scrolling adds `per`.
function onePage({ total = 60, per = 12, button = true } = {}) {
  const st = { shown: per, clicks: 0, scrolls: 0 };
  const grow = () => { st.shown = Math.min(total, st.shown + per); };
  return {
    st,
    read: async () => Array.from({ length: st.shown }, (_, i) => ({ name: `P${i}`, price: 10, sourceUrl: `https://s.test/p/${i}` })),
    // like the page: the control disappears once everything is shown
    loadMore: async () => { if (!button || st.shown >= total) return false; st.clicks++; grow(); return true; },
    scroll: async () => { st.scrolls++; if (!button) grow(); },
    path: async () => '/c', nextPage: async () => { throw new Error('never leaves the page'); },
    sleep: async () => {}, settleMs: 0,
  };
}

test('« Charger plus »: click after click, never a scroll; stops when the button is gone; each load counts as a page', async () => {
  const a = onePage({ total: 36, per: 12 });
  const r1 = await runPanelExtraction({ ...a, settings: { maxProducts: 500, maxPages: 10, pagination: 'load_more' } });
  assert.equal(r1.rows.length, 36); assert.equal(r1.stoppedBy, 'button_gone'); assert.equal(a.st.scrolls, 0); assert.equal(r1.loads, 2);
  const b = onePage({ total: 500, per: 12 });
  const r2 = await runPanelExtraction({ ...b, settings: { maxProducts: 500, maxPages: 3, pagination: 'load_more' } });
  assert.equal(r2.rows.length, 36, 'page 1 + 2 loads = 3 « pages »'); assert.equal(r2.stoppedBy, 'max_pages');
  const none = onePage({ button: false });
  const r3 = await runPanelExtraction({ ...none, settings: { maxProducts: 500, maxPages: 5, pagination: 'load_more' } });
  assert.equal(r3.stoppedBy, 'button_gone'); assert.equal(r3.rows.length, 12);
});

test('« Défilement infini »: scrolling only (no click); stops when nothing new comes', async () => {
  const s = onePage({ total: 30, per: 10, button: false });
  let clicks = 0;
  const r = await runPanelExtraction({ ...s, loadMore: async () => { clicks++; return false; }, settings: { maxProducts: 500, maxPages: 20, pagination: 'infinite' } });
  assert.equal(r.rows.length, 30); assert.equal(r.stoppedBy, 'no_new'); assert.equal(clicks, 0);
});

test('the announced total: reached → stop without opening one more page; the count is checked at the end', async () => {
  let page = 1; let opened = 0;
  const pages = {
    read: async () => Array.from({ length: page === 1 ? 24 : 8 }, (_, i) => ({ name: `P${page}-${i}`, price: 9, sourceUrl: `https://s.test/p/${page}-${i}` })),
    scroll: async () => {}, loadMore: async () => false, path: async () => '/c',
    nextPage: async () => { opened++; page++; return true; }, sleep: async () => {}, settleMs: 0,
  };
  const r = await runPanelExtraction({ ...pages, total: async () => ({ total: 32, kind: 'range', text: 'Résultats 1 - 24 sur 32.' }), settings: { maxProducts: 500, maxPages: 10, pagination: 'button' } });
  assert.equal(r.rows.length, 32); assert.equal(r.stoppedBy, 'total_reached'); assert.equal(opened, 1, 'no page 3 opened');
  assert.deepEqual(r.total, { announced: 32, text: 'Résultats 1 - 24 sur 32.', read: 32, ok: true, short: 0, explained: false });
});

test('a shortfall is reported, and told apart from the user\'s own limits; « 24 produits » equal to this page is no stop', async () => {
  const short = onePage({ total: 20, per: 10 });
  const r1 = await runPanelExtraction({ ...short, total: async () => ({ total: 32, kind: 'range' }), settings: { maxProducts: 500, maxPages: 10, pagination: 'load_more' } });
  assert.equal(r1.total.ok, false); assert.equal(r1.total.short, 12); assert.equal(r1.total.explained, false);
  const capped = onePage({ total: 100, per: 10 });
  const r2 = await runPanelExtraction({ ...capped, total: async () => ({ total: 100, kind: 'range' }), settings: { maxProducts: 30, maxPages: 10, pagination: 'load_more' } });
  assert.equal(r2.stoppedBy, 'max_products'); assert.equal(r2.total.explained, true);
  const perPage = onePage({ total: 48, per: 24 });
  const r3 = await runPanelExtraction({ ...perPage, total: async () => ({ total: 24, kind: 'count' }), settings: { maxProducts: 500, maxPages: 10, pagination: 'load_more' } });
  assert.equal(r3.rows.length, 48, '« 24 produits » counted this page only: the list went on');
});
