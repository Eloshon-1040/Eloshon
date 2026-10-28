/**
 * Side-panel "Exécuter maintenant" — the loop, kept free of chrome.* so it is
 * unit-testable in Node. It reads the page open in the user's tab, then loads more
 * products the way the user chose for the site:
 *   - « Automatique »: a real "load more" control and scrolling, and when the page
 *     gives nothing more, the NEXT page (learned button, rel=next, a « suivant »
 *     control, the next page number, a page parameter — `nextPage`);
 *   - « Bouton suivant » / « Numéro de page dans l'adresse »: page after page;
 *   - « Charger plus »: the load-more control only, click after click;
 *   - « Défilement infini »: scrolling only;
 *   - « Aucune »: this page.
 * Each mode stops on its own end: no new product, the control gone or disabled,
 * the total the list announces reached, the page (or load) limit — and always on
 * the product cap, a navigation away from the list that is not ours, the user's
 * stop or the time budget. Rows are deduplicated (URL, else name + price). The
 * reading itself (learned recipe or automatic detection) is injected.
 */
import { rowKey, rowsHealth } from '../vendor/shared/extract/card-recipe.mjs';

export const PANEL_MAX_ROWS = 5000;
// Stops that the user's own settings explain (a shorter list than announced is then expected).
const LIMIT_STOPS = new Set(['max_products', 'max_pages', 'max_rounds', 'time', 'stopped', 'single_page']);

/**
 * @param {{ read:()=>Promise<object[]>, scroll:()=>Promise<any>, loadMore:(mode?:string)=>Promise<boolean>,
 *   path:()=>Promise<string>, nextPage?:(mode:string)=>Promise<boolean>, total?:()=>Promise<{total:number, kind?:string, text?:string}|null>,
 *   settings?:{maxProducts?:number, maxPages?:number, pagination?:string},
 *   onProgress?:(n:number)=>void, sleep?:(ms:number)=>Promise<void>, now?:()=>number,
 *   budgetMs?:number, settleMs?:number, isStopped?:()=>boolean }} o
 * @returns {Promise<{ rows:object[], rounds:number, stoppedBy:string, pages:number, loads:number,
 *   total:{announced:number, text:string|null, read:number, ok:boolean, short:number, explained:boolean}|null }>}
 */
export async function runPanelExtraction(o) {
  const s = o.settings || {};
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now || Date.now;
  const progress = (n) => { try { if (o.onProgress) o.onProgress(n); } catch { /* never break */ } };
  const isStopped = o.isStopped || (() => false);
  const cap = Math.max(1, Math.min(PANEL_MAX_ROWS, Number(s.maxProducts) || 500));
  const mode = s.pagination || 'auto'; // auto | none | button | url (next page) | load_more | infinite (same page)
  const follow = mode !== 'none';
  const inPage = mode === 'auto' || mode === 'infinite' || mode === 'load_more'; // more products on the same page
  const pages = mode === 'auto' || mode === 'button' || mode === 'url'; // go to the next page
  const useClick = mode === 'auto' || mode === 'load_more';
  const useScroll = mode === 'auto' || mode === 'infinite';
  const loadsArePages = mode === 'load_more' || mode === 'infinite'; // each load counts against « pages maximum »
  const maxPages = Math.max(1, Math.min(200, Number(s.maxPages) || 5));
  // Enough rounds for the cap at a small page size, never fewer than the user's
  // "max pages"; bounded so a list that never ends cannot run forever.
  const maxRounds = follow ? Math.min(80, Math.max(Number(s.maxPages) || 5, Math.ceil(cap / 12) + 4)) : 0;
  const budgetMs = o.budgetMs != null ? o.budgetMs : 240000;
  const settleMs = o.settleMs != null ? o.settleMs : 1500;
  const t0 = now();
  const rows = new Map();
  const add = (list) => { let n = 0; for (const r of list || []) { if (rows.size >= cap) break; const k = rowKey(r); if (rows.has(k)) continue; rows.set(k, r); n++; } return n; };

  let startPath = null; try { startPath = await o.path(); } catch { startPath = null; }
  add(await o.read()); progress(rows.size);
  // The total the list announces, read on its first page. « 1 - 24 sur 32 » is a total; « 24 produits » is
  // one only when it says more than this page shows (else it may count this page alone): only then a stop.
  let announced = null; try { announced = typeof o.total === 'function' ? await o.total() : null; } catch { announced = null; }
  const total = announced && Number.isInteger(announced.total) && announced.total > 0 ? announced.total : null;
  const totalStops = total != null && (announced.kind !== 'count' || total > rows.size);
  let rounds = 0; let stale = 0; let clickUseless = false; let stoppedBy = null; let pagesRead = 1; let pageMisses = 0; let loads = 0;
  // The next page, when this one gives nothing more: true when the tab is on a new page of the list.
  const goNext = async () => {
    if (!pages || typeof o.nextPage !== 'function' || pagesRead >= maxPages) return false;
    let moved = false; try { moved = !!(await o.nextPage(mode)); } catch { moved = false; }
    if (!moved) return false;
    pagesRead++; stale = 0; clickUseless = false;
    try { startPath = await o.path(); } catch { /* keep */ }
    return true;
  };
  while (follow && rounds < maxRounds) {
    if (rows.size >= cap) { stoppedBy = 'max_products'; break; }
    if (totalStops && rows.size >= total) { stoppedBy = 'total_reached'; break; }
    if (isStopped()) { stoppedBy = 'stopped'; break; }
    if (now() - t0 > budgetMs) { stoppedBy = 'time'; break; }
    rounds++;
    let clicked = false;
    if (!inPage) {
      // Next page only: one page, then the following one.
      if (!(await goNext())) { stoppedBy = pagesRead >= maxPages ? 'max_pages' : 'end'; break; }
      const fresh0 = add(await o.read()); progress(rows.size);
      if (!fresh0) { if (++pageMisses >= 2) { stoppedBy = 'no_new'; break; } } else pageMisses = 0;
      continue;
    }
    if (useClick && !clickUseless) { try { clicked = !!(await o.loadMore(mode)); } catch { clicked = false; } }
    // « Charger plus »: no control (or a disabled one) is the end of the list.
    if (mode === 'load_more' && !clicked) { stoppedBy = 'button_gone'; break; }
    if (useScroll) { try { await o.scroll(); } catch { /* keep reading */ } }
    await sleep(settleMs);
    let p = null; try { p = await o.path(); } catch { p = startPath; }
    if (startPath != null && p !== startPath) { stoppedBy = 'navigated'; break; }
    const fresh = add(await o.read()); progress(rows.size);
    if (!fresh) {
      if (clicked && mode === 'auto') clickUseless = true; // « Charger plus » mode keeps clicking a slow control, twice at most
      if (++stale >= 2) {
        // This page gives nothing more: the next page of the list, if there is one.
        if (await goNext()) { const f2 = add(await o.read()); progress(rows.size); if (!f2) { if (++pageMisses >= 2) { stoppedBy = 'no_new'; break; } } else pageMisses = 0; continue; }
        stoppedBy = !pages ? 'no_new' : (pagesRead >= maxPages ? 'max_pages' : 'end'); break;
      }
    } else {
      stale = 0;
      if (loadsArePages && ++loads + 1 >= maxPages) { stoppedBy = rows.size >= cap ? 'max_products' : 'max_pages'; break; }
    }
  }
  if (!stoppedBy) stoppedBy = !follow ? 'single_page' : (rows.size >= cap ? 'max_products' : (totalStops && rows.size >= total ? 'total_reached' : 'max_rounds'));
  // Does the count match what the list announced? A shortfall the user's own limits explain is not a miss.
  const check = total != null ? { announced: total, text: (announced && announced.text) || null, read: rows.size, ok: rows.size >= total, short: Math.max(0, total - rows.size), explained: rows.size < total && LIMIT_STOPS.has(stoppedBy) } : null;
  return { rows: [...rows.values()], rounds, stoppedBy, pages: pagesRead, loads, total: check };
}

/**
 * Pick how the panel reads this page, on the FIRST read, and keep it for the run:
 * the first recipe candidate whose rows look healthy (names and prices — the same
 * rule as the app), else the automatic detection when ITS rows look healthy, else
 * the read that gave the most rows (product pages can still complete names and
 * prices with "Sous-pages"). A recipe that reads nothing is re-read once after a
 * short wait (late-rendered grid).
 * @param {{ candidates:Array<{recipe:object, method:string}>, readRecipe:(r:object)=>Promise<object[]>,
 *   autoRead:()=>Promise<object[]>, learn?:(rows:object[])=>Promise<object|null>, sleep?:(ms:number)=>Promise<void>, settleMs?:number }} o
 * @returns {{ read:()=>Promise<object[]>, info:()=>({method:string, weak:boolean}) }}
 */
// The columns the user designated with the mouse are what they asked for: a read
// that fills most of them is kept even without a name or a price (a lodging, a
// directory). Row keys of the known roles: name, price, listPrice, sourceUrl, images, gtin.
const ROW_KEY = { price: 'price', list_price: 'listPrice', url: 'sourceUrl', image: 'images', ean: 'gtin', name: 'name' };
export function designatedFilled(rows, keys, min = 0.7) {
  if (!Array.isArray(keys) || !keys.length || !rows.length) return false;
  return keys.every((k) => rows.filter((r) => { const v = r && r[ROW_KEY[k] || k]; return v != null && v !== '' && !(Array.isArray(v) && !v.length); }).length / rows.length >= min);
}

export function panelReader(o) {
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const settleMs = o.settleMs != null ? o.settleMs : 1500;
  const safe = async (fn) => { try { return (await fn()) || []; } catch { return []; } };
  let chosen = null;
  // A page still drawing its skeletons reads as one hollow row (no price, no link): the weak result is
  // read again after a pause, a few times, before it is accepted — a loaded page never waits.
  const first = async () => {
    let rows = await firstTry();
    for (let i = 0; i < (o.patience != null ? o.patience : 3) && chosen && chosen.weak; i++) { await sleep(settleMs * 2); rows = await firstTry(); }
    return rows;
  };
  const firstTry = async () => {
    const tries = [];
    for (const c of o.candidates || []) {
      let rows = await safe(() => o.readRecipe(c.recipe));
      if (!rows.length && !tries.length) { await sleep(settleMs); rows = await safe(() => o.readRecipe(c.recipe)); }
      tries.push({ c, rows });
      if (rows.length && (rowsHealth(rows).ok || designatedFilled(rows, c.userKeys))) { chosen = { ...c, weak: false }; return rows; }
    }
    const auto = await safe(() => o.autoRead());
    const autoMethod = tries.length ? 'détection automatique (la recette du site ne lit plus les noms ou les prix)' : 'détection automatique';
    if (auto.length && rowsHealth(auto).ok) {
      // Structured data often describes only the first products, not the ones the
      // page loads later on scroll: learn the card from these correct rows and read
      // every card shown — kept only if it reads at least as many healthy rows.
      if (typeof o.learn === 'function') {
        let recipe = null; try { recipe = await o.learn(auto); } catch { recipe = null; }
        if (recipe) {
          const viaCards = await safe(() => o.readRecipe(recipe));
          if (viaCards.length >= auto.length && rowsHealth(viaCards).ok) { chosen = { recipe, method: 'recette apprise sur cette page (à partir de ses données)', weak: false, learned: recipe }; return viaCards; }
        }
      }
      chosen = { auto: true, method: autoMethod, weak: false }; return auto;
    }
    const best = [...tries, { c: { auto: true, method: autoMethod }, rows: auto }].reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
    chosen = { ...best.c, weak: true };
    return best.rows;
  };
  // A product page (card = the whole page): the user's columns + what the page's own
  // structured data gives (name, price, image), the user's columns winning.
  const withPage = async (rows) => {
    if (!(chosen && !chosen.auto && chosen.recipe && chosen.recipe.card === 'body' && rows.length === 1)) return rows;
    const auto = await safe(() => o.autoRead());
    return auto.length === 1 ? [{ ...auto[0], ...Object.fromEntries(Object.entries(rows[0]).filter(([, v]) => v != null && v !== '')) }] : rows;
  };
  return {
    read: async () => (chosen ? (chosen.auto ? safe(() => o.autoRead()) : withPage(await safe(() => o.readRecipe(chosen.recipe)))) : withPage(await first())),
    info: () => ({ method: chosen ? chosen.method : 'détection automatique', weak: !!(chosen && chosen.weak) }),
  };
}
