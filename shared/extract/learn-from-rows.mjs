/**
 * Learn a card recipe on the page from rows ALREADY READ CORRECTLY (structured data:
 * JSON-LD / embedded JSON — exact names, prices and links). Each example row is
 * located in the rendered page by its link; the repeated card around it is found
 * ("find similar"); inside the card, the element showing exactly the row's name and
 * the element showing its price give the field selectors. Selectors are voted
 * across the examples and the recipe is kept only if it reads the examples back
 * correctly. Then every card the page shows — including the ones loaded later by
 * scrolling, which structured data often does not describe — is read the same way.
 * Generic: no site rule; only the page's own data is used as the example.
 */
import { parseMoney } from './money.mjs';
import { deriveCardSelector, relativeSelector, fieldTarget } from './pick-selector.mjs';
import { readCards } from './card-recipe.mjs';

const bare = (u, base) => { try { const x = new URL(String(u), base); x.hash = ''; x.search = ''; return x.toString().replace(/\/$/, ''); } catch { return null; } };
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const textOf = (el) => norm(el && el.textContent);

// Whether an element shows this price somewhere in its text.
const hasPrice = (el, price) => {
  const want = Number(price); const t = String(el.textContent || '');
  const re = /\d{1,3}(?:[ ., ]\d{3})*(?:[.,]\d{1,2})?/g; let m;
  while ((m = re.exec(t))) { const v = parseMoney(`${m[0]} €`); if (v && Math.abs(v.price - want) < 0.005) return true; }
  return false;
};

// The innermost element of a list (one that contains no other element of the list).
const deepest = (list) => list.find((e) => !list.some((o) => o !== e && e.contains(o))) || null;

function vote(map, key) { if (key) map.set(key, (map.get(key) || 0) + 1); }
function winner(map) { let best = null; for (const [k, n] of map) if (!best || n > best[1]) best = [k, n]; return best ? best[0] : null; }

/**
 * @param {Document} doc       the rendered page
 * @param {object[]} rows      rows read correctly (name, price, sourceUrl[, images])
 * @param {string} baseUrl
 * @param {{maxExamples?:number, debug?:object}} [o]  debug (optional) receives the steps (counts and selectors only)
 * @returns {{card:string, fields:object}|null}
 */
export function learnRecipeFromRows(doc, rows, baseUrl, { maxExamples = 10, debug = null } = {}) {
  const dbg = debug || {};
  const examples = (rows || []).filter((r) => r && r.sourceUrl && r.name && r.price != null).slice(0, maxExamples);
  if (examples.length < 3) return null;
  const anchorsByUrl = new Map();
  for (const a of doc.querySelectorAll('a[href]')) { const k = bare(a.getAttribute('href'), baseUrl); if (k && !anchorsByUrl.has(k)) anchorsByUrl.set(k, a); }
  const located = examples.map((r) => ({ r, a: anchorsByUrl.get(bare(r.sourceUrl, baseUrl)) })).filter((x) => x.a);
  dbg.examples = examples.length; dbg.located = located.length;
  if (located.length < 3) return null;

  // 1) the repeated card (majority over the examples)
  // Start from the smallest ancestor of the link that also shows the row's name and
  // price (a full-card link overlay alone holds neither).
  const cardVotes = new Map();
  for (const x of located) {
    let el = x.a;
    while (el && el.parentElement && !(textOf(el).includes(norm(x.r.name)) && hasPrice(el, x.r.price))) el = el.parentElement;
    if (el && el.parentElement) vote(cardVotes, deriveCardSelector(el, doc, { maxClasses: 6 }));
  }
  const card = winner(cardVotes);
  dbg.cardVotes = [...cardVotes];
  if (!card) return null;

  // 2) field selectors inside the card, voted
  const votes = { name: new Map(), price: new Map(), url: new Map(), image: new Map() };
  for (const x of located) {
    let cardEl = null; try { cardEl = x.a.closest(card); } catch { cardEl = null; }
    if (!cardEl) continue;
    const els = [...cardEl.querySelectorAll('*')];
    const wanted = norm(x.r.name);
    // name: the smallest element whose whole text IS the name (else contains it, tightly)
    const exact = els.filter((e) => textOf(e) === wanted);
    const loose = exact.length ? exact : els.filter((e) => { const t = textOf(e); return t.includes(wanted) && t.length <= wanted.length + 12; });
    const nameEl = deepest(loose);
    if (nameEl) vote(votes.name, relativeSelector(cardEl, nameEl));
    // price: the deepest element whose text is a money amount equal to the row's price
    const priceEls = els.filter((e) => { const t = textOf(e); if (!t || t.length > 40) return false; const m = parseMoney(e.textContent); return m && Math.abs(m.price - Number(x.r.price)) < 0.005; });
    const priceEl = deepest(priceEls);
    if (priceEl) vote(votes.price, relativeSelector(cardEl, priceEl));
    // url: the example's own link
    vote(votes.url, cardEl.contains(x.a) ? relativeSelector(cardEl, x.a) : null);
    // image: the card's first image
    const img = cardEl.querySelector('img');
    if (img) { const t = fieldTarget(img, 'image'); vote(votes.image, `${relativeSelector(cardEl, t.el)}|${t.attr}`); }
  }
  dbg.votes = Object.fromEntries(Object.entries(votes).map(([k, m]) => [k, [...m]]));
  const fields = {};
  const n = winner(votes.name); if (n) fields.name = { selector: n, attr: null };
  const p = winner(votes.price); if (p) fields.price = { selector: p, attr: null };
  const u = winner(votes.url); if (u) fields.url = { selector: u, attr: 'href' };
  const im = winner(votes.image); if (im) { const [sel, attr] = im.split('|'); fields.image = { selector: sel, attr: attr === 'null' ? null : attr }; }
  if (!fields.name || !fields.price || !fields.url) return null;

  // 3) keep it only if it reads the examples back (name + price), ≥ 70 %
  const recipe = { card, fields };
  const read = readCards(doc, recipe, baseUrl);
  const byUrl = new Map(read.map((r) => [bare(r.sourceUrl, baseUrl), r]));
  const good = located.filter((x) => { const r = byUrl.get(bare(x.r.sourceUrl, baseUrl)); return r && norm(r.name) === norm(x.r.name) && Math.abs(Number(r.price) - Number(x.r.price)) < 0.005; }).length;
  dbg.readBack = good;
  return good >= Math.ceil(located.length * 0.7) ? recipe : null;
}
