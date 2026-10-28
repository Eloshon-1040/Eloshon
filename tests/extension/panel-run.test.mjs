/**
 * Side-panel "Exécuter maintenant" loop (extension/background/panel-run.mjs):
 * reads, loads more (load-more control + scroll), reads again until the cap, the
 * end of the list, a navigation away, or the time budget. Offline: a fake page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPanelExtraction } from '../../extension/background/panel-run.mjs';

function fakePage({ perScroll = 24, total = 120, clickWorks = false, navigateAt = null } = {}) {
  const st = { shown: 24, scrolls: 0, clicks: 0, path: '/w/sale' };
  return {
    st,
    read: async () => Array.from({ length: Math.min(st.shown, total) }, (_, i) => ({ name: `P${i}`, sourceUrl: `https://shop.test/t/p-${i}` })),
    scroll: async () => { st.scrolls++; if (navigateAt != null && st.scrolls >= navigateAt) st.path = '/w/other'; else if (!clickWorks) st.shown += perScroll; },
    loadMore: async () => { st.clicks++; if (clickWorks) { st.shown += perScroll; return true; } return true; /* a matched control (e.g. a filter button) that loads nothing by itself */ },
    path: async () => st.path,
  };
}
const fast = { sleep: async () => {}, settleMs: 0 };

test('scrolls and reads until the cap; rows deduplicated; progress reported', async () => {
  const pg = fakePage();
  const seen = [];
  const r = await runPanelExtraction({ ...pg, ...fast, settings: { maxProducts: 60, pagination: 'auto' }, onProgress: (n) => seen.push(n) });
  assert.equal(r.rows.length, 60);
  assert.equal(new Set(r.rows.map((x) => x.sourceUrl)).size, 60);
  assert.equal(r.stoppedBy, 'max_products');
  assert.deepEqual(seen.slice(0, 2), [24, 48]);
});

test('end of the list: two rounds without a new row stop the loop; a useless "load more" is not clicked again', async () => {
  const pg = fakePage({ total: 72 });
  const r = await runPanelExtraction({ ...pg, ...fast, settings: { maxProducts: 500 } });
  assert.equal(r.rows.length, 72);
  assert.equal(r.stoppedBy, 'end');
  // rounds 1–2 grow (by scrolling), round 3 is the first without a new row → the
  // control is marked useless; round 4 scrolls only, then the loop ends.
  assert.equal(pg.st.clicks, 3);
  assert.equal(r.rounds, 4);
});

test('a real "load more" button is used', async () => {
  const pg = fakePage({ clickWorks: true, total: 1000 });
  const r = await runPanelExtraction({ ...pg, ...fast, settings: { maxProducts: 100 } });
  assert.equal(r.rows.length, 100);
  assert.ok(pg.st.clicks >= 3);
});

test('"Aucune (cette page)": the page is read once, nothing is loaded', async () => {
  const pg = fakePage();
  const r = await runPanelExtraction({ ...pg, ...fast, settings: { maxProducts: 500, pagination: 'none' } });
  assert.equal(r.rows.length, 24);
  assert.equal(pg.st.scrolls, 0);
  assert.equal(r.stoppedBy, 'single_page');
});

test('the page navigated away (a link was followed): stop, keep what the list gave', async () => {
  const pg = fakePage({ navigateAt: 2 });
  const r = await runPanelExtraction({ ...pg, ...fast, settings: { maxProducts: 500 } });
  assert.equal(r.stoppedBy, 'navigated');
  assert.equal(r.rows.length, 48);
});

test('time budget', async () => {
  let t = 0;
  const pg = fakePage({ total: 100000 });
  const r = await runPanelExtraction({ ...pg, sleep: async () => { t += 10000; }, settleMs: 0, now: () => t, budgetMs: 30000, settings: { maxProducts: 5000 } });
  assert.equal(r.stoppedBy, 'time');
  assert.ok(r.rows.length < 5000);
});

test('panelReader: a site recipe that no longer reads names / prices is replaced by the user fields alone, else the automatic detection', async () => {
  const { panelReader } = await import('../../extension/background/panel-run.mjs');
  const nameless = Array.from({ length: 10 }, (_, i) => ({ sourceUrl: `https://s.test/p/${i}`, price: 10 }));
  const good = Array.from({ length: 10 }, (_, i) => ({ name: `P${i}`, sourceUrl: `https://s.test/p/${i}`, price: 10 }));
  const fast = { sleep: async () => {}, settleMs: 0 };
  // 1) stored+user broken, user-only healthy → user-only kept for the run
  let calls = [];
  let r = panelReader({ ...fast, candidates: [{ recipe: 'A', method: 'a' }, { recipe: 'B', method: 'b' }], readRecipe: async (x) => { calls.push(x); return x === 'A' ? nameless : good; }, autoRead: async () => [] });
  assert.equal((await r.read()).length, 10); assert.deepEqual(r.info(), { method: 'b', weak: false });
  await r.read(); assert.equal(calls.at(-1), 'B', 'the choice holds for the next reads');
  // 2) all recipes broken, automatic detection healthy → automatic
  r = panelReader({ ...fast, candidates: [{ recipe: 'A', method: 'a' }], readRecipe: async () => nameless, autoRead: async () => good });
  assert.equal((await r.read())[0].name, 'P0'); assert.match(r.info().method, /détection automatique \(la recette du site ne lit plus/);
  // 3) nothing healthy → the read with the most rows, flagged weak (product pages can complete it)
  r = panelReader({ ...fast, candidates: [{ recipe: 'A', method: 'a' }], readRecipe: async () => nameless, autoRead: async () => good.slice(0, 2).map((x) => ({ ...x, price: null })) });
  assert.equal((await r.read()).length, 10); assert.deepEqual(r.info(), { method: 'a', weak: true });
  // 4) a recipe that reads nothing at first is re-read once after the settle
  let n = 0;
  r = panelReader({ ...fast, candidates: [{ recipe: 'A', method: 'a' }], readRecipe: async () => (n++ ? good : []), autoRead: async () => [] });
  assert.equal((await r.read()).length, 10); assert.equal(r.info().method, 'a');
});

test('panelReader: healthy structured rows are used to LEARN the cards; the learned recipe is kept when it reads at least as many', async () => {
  const { panelReader } = await import('../../extension/background/panel-run.mjs');
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, sourceUrl: `https://s.test/p/${i}`, price: 10 }));
  let learnedWith = null;
  const r = panelReader({ sleep: async () => {}, settleMs: 0, candidates: [], autoRead: async () => mk(24), readRecipe: async (x) => (x === 'LEARNED' ? mk(48) : []), learn: async (rows) => { learnedWith = rows.length; return 'LEARNED'; } });
  assert.equal((await r.read()).length, 48);
  assert.equal(learnedWith, 24);
  assert.match(r.info().method, /recette apprise sur cette page/);
  // learning failed → automatic detection kept
  const r2 = panelReader({ sleep: async () => {}, settleMs: 0, candidates: [], autoRead: async () => mk(24), readRecipe: async () => mk(5), learn: async () => 'X' });
  assert.equal((await r2.read()).length, 24); assert.equal(r2.info().method, 'détection automatique');
});

test('panelReader: the columns the user designated are kept even without a name or a price (a lodging card)', async () => {
  const { panelReader: reader, designatedFilled } = await import('../../extension/background/panel-run.mjs');
  const mine = [{ type: 'Chambre', city: 'Charleroi', sourceUrl: 'https://r.test/1' }, { type: 'Loft', city: 'Liège', sourceUrl: 'https://r.test/2' }];
  const auto = [{ name: 'Chambre · Charleroi', price: 116 }, { name: 'Loft · Liège', price: 291 }];
  assert.equal(designatedFilled(mine, ['type', 'city', 'url']), true);
  assert.equal(designatedFilled([{ type: 'Chambre' }, {}], ['type']), false);
  const r = reader({ candidates: [{ userKeys: ['type', 'city'], recipe: { card: '.c' }, method: 'vos champs désignés' }], readRecipe: async () => mine, autoRead: async () => auto, sleep: async () => {} });
  assert.deepEqual(await r.read(), mine);
  assert.equal(r.info().method, 'vos champs désignés');
});

test('panelReader: a page still drawing its skeletons (one hollow row) is read again before the weak result is accepted', async () => {
  const { panelReader } = await import('../../extension/background/panel-run.mjs');
  const hollow = [{ name: 'GSM', price: null }];
  const good = Array.from({ length: 10 }, (_, i) => ({ name: `P${i}`, sourceUrl: `https://s.test/p/${i}`, price: 10 }));
  const fast = { sleep: async () => {}, settleMs: 0 };
  // the skeletons give way to the real cards on the 3rd read
  let n = 0;
  let r = panelReader({ ...fast, candidates: [{ recipe: 'A', method: 'a' }], readRecipe: async () => (++n >= 3 ? good : hollow), autoRead: async () => [] });
  assert.equal((await r.read()).length, 10); assert.deepEqual(r.info(), { method: 'a', weak: false });
  // a page that never loads is still given up on (weak, bounded number of reads)
  n = 0;
  r = panelReader({ ...fast, candidates: [{ recipe: 'A', method: 'a' }], readRecipe: async () => { n++; return hollow; }, autoRead: async () => [] });
  assert.equal((await r.read()).length, 1); assert.equal(r.info().weak, true); assert.equal(n, 4);
});
