/**
 * The product card, learned from ONE click (Andy, 28/10/2026): the user points at a product card of the list; the
 * repeated pattern is deduced (the card selector), with the grid that holds it, the kind of link a product card
 * carries (« /products/* »), and what a card must show (title, link, price when the clicked one has a price).
 * Every candidate is then classified: KEPT, or REJECTED with its reason — a menu or header card, a carousel
 * (« vous aimerez aussi »), a banner whose link goes elsewhere, a card without title or price, a card the user
 * marked « pas un produit » (a negative signature). Nothing is dropped in silence: the rejected cards are listed.
 * Portable (browser + linkedom), no site rule.
 */
import { deriveCardSelector, stableClasses, relativeSelector } from './pick-selector.mjs';
import { priceFromEl, visibleText } from './card-recipe.mjs';
import { controlSelector } from './page-control.mjs';
import { batchKeyOf } from '../export/site-values.mjs';

export const REJECT_REASONS = {
  outside_list: 'hors de la liste (menu, en-tête, pied de page ou autre section)',
  carousel: 'dans un carrousel ou une suggestion (« vous aimerez aussi »)',
  marked_not_product: 'marqué « pas un produit »',
  no_link: 'sans lien vers une fiche',
  other_link: 'lien d’un autre type que celui de la carte apprise',
  no_title: 'sans titre',
  no_price: 'sans prix',
};
const CHROME = 'header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [class*="mega-menu" i], [class*="megamenu" i], [class*="main-menu" i], [class*="menu-item" i], [id*="menu" i]';
const SUGGEST = '[class*="related" i], [class*="recommend" i], [class*="upsell" i], [class*="up-sell" i], [class*="cross-sell" i], [class*="crosssell" i], [class*="recently" i], [class*="carousel" i], [class*="slider" i], [class*="swiper" i], [id*="related" i], [id*="recommend" i]';
const TITLE = 'h1, h2, h3, h4, h5, h6, [class*="title" i], [class*="name" i], [itemprop="name"]';
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const generic = (s) => norm(s).toLowerCase().replace(/\d[\d\s.,]*/g, '#').slice(0, 80);

/** The kind of address a link has: « /products/* », « /fr/*\/*.html » — a short first word kept, the rest generic. */
export function linkShape(href, base) {
  let u; try { u = new URL(href, base); } catch { return null; }
  const segs = u.pathname.split('/').filter(Boolean);
  if (!segs.length) return '/';
  const ext = (segs[segs.length - 1].match(/\.(html?|php|aspx?)$/i) || [''])[0].toLowerCase();
  return '/' + segs.map((s, i) => (i === 0 && s.length <= 12 && !/[-\d]/.test(s) ? s.toLowerCase() : `*${i === segs.length - 1 ? ext : ''}`)).join('/');
}

/** The parts of one card: its main link, its title, its price, its picture (elements and values). */
export function cardParts(card, base) {
  const links = [...card.querySelectorAll('a[href]')].concat(card.matches && card.matches('a[href]') ? [card] : [])
    .filter((a) => { const h = (a.getAttribute('href') || '').trim(); return h && !/^(#|javascript:|mailto:|tel:)/i.test(h); });
  // The main link: the one most links of the card point to (picture + title), else the first.
  const counts = new Map(); for (const a of links) { const k = a.getAttribute('href'); counts.set(k, (counts.get(k) || 0) + 1); }
  const link = links.sort((a, b) => counts.get(b.getAttribute('href')) - counts.get(a.getAttribute('href')))[0] || null;
  let url = null; try { url = link ? new URL(link.getAttribute('href'), base).href : null; } catch { url = null; }
  const titleEl = [...card.querySelectorAll(TITLE)].find((el) => norm(visibleText(el)).length >= 2 && !/^\d/.test(norm(visibleText(el)))) || null;
  const name = norm(titleEl ? visibleText(titleEl) : (link && (norm(visibleText(link)) || link.getAttribute('title') || link.getAttribute('aria-label')))) || '';
  // The price: the smallest element whose text reads as an amount.
  let priceEl = null; let price = null;
  for (const el of card.querySelectorAll('*')) {
    if (el.children.length > 4) continue;
    const t = norm(el.textContent); if (!t || t.length > 40 || !/\d/.test(t)) continue;
    const m = priceFromEl(el); if (m && m.price != null && m.currency) { if (!priceEl || priceEl.contains(el)) { priceEl = el; price = m.price; } }
  }
  const img = card.querySelector('img');
  return { link, url, titleEl, name, priceEl, price, img };
}

const inZone = (el, sel, stop) => { for (let cur = el; cur && cur !== stop; cur = cur.parentElement) { if (cur.matches && cur.matches(sel)) return true; } return false; };

/** The grid of a card: the first wrapper holding several cards, grown while it holds the same set (never the page). */
function gridOf(cardEl, card) {
  let grid = null; let n = 0;
  for (let cur = cardEl.parentElement; cur && !/^(html|body)$/i.test(cur.tagName); cur = cur.parentElement) {
    const c = cur.querySelectorAll(card).length;
    if (!grid) { if (c >= 2) { grid = cur; n = c; } continue; }
    if (c === n) grid = cur; else break;
  }
  return grid;
}
/** A selector for the grid of a card: its widest wrapper that has one, else the first wrapper (a bare <main> has none). */
function gridSelector(cardEl, card, doc) {
  const wide = gridOf(cardEl, card); if (!wide) return null;
  const sel = controlSelector(wide, doc); if (sel) return sel;
  for (let cur = cardEl.parentElement; cur && cur !== wide; cur = cur.parentElement) { if (cur.querySelectorAll(card).length >= 2) { const s2 = controlSelector(cur, doc); if (s2) return s2; } }
  return null;
}

/**
 * Learn the card from the element the user clicked. With `previous` (the card already learned), a click on a card
 * of ANOTHER section of the same list adds that section (a page that groups its products by series).
 * @returns {{ok:true, model:object, count:number, added?:boolean}|{ok:false, reason:string}}
 */
export function learnCardModel(el, doc, pageUrl, { previous = null } = {}) {
  if (!el || el.nodeType !== 1) return { ok: false, reason: 'rien sous le pointeur' };
  if (previous && previous.card) {
    const again = el.closest(previous.card);
    if (again) {
      const sel = gridSelector(again, previous.card, doc);
      const scopes = [...new Set([...(previous.scopes || []), ...(sel ? [sel] : [])])].slice(0, 20);
      const model = { ...previous, scopes, learnedOn: batchKeyOf(pageUrl) };
      return { ok: true, model, added: scopes.length > (previous.scopes || []).length, count: classifyCards(doc, model, pageUrl).kept.length };
    }
  }
  const card = deriveCardSelector(el, doc, { min: 2 });
  if (!card) return { ok: false, reason: 'aucune carte répétée autour de ce clic : cliquez au milieu d’une carte produit de la liste' };
  const cardEl = el.closest(card) || el;
  const parts = cardParts(cardEl, pageUrl);
  if (!parts.url) return { ok: false, reason: 'cette carte n’a pas de lien vers une fiche produit' };
  const rel = (x) => (x ? relativeSelector(cardEl, x) : null);
  const fields = {};
  if (parts.titleEl) fields.name = { selector: rel(parts.titleEl) };
  fields.url = { selector: rel(parts.link), attr: 'href' };
  if (parts.priceEl) fields.price = { selector: rel(parts.priceEl) };
  if (parts.img) fields.image = { selector: rel(parts.img) };
  const scope = gridSelector(cardEl, card, doc);
  const model = {
    v: 1, card, scopes: scope ? [scope] : [], learnedOn: batchKeyOf(pageUrl), // its sections are this page's
    cardClasses: stableClasses(cardEl, 8),
    linkShape: linkShape(parts.url, pageUrl),
    needs: { title: !!parts.name, price: parts.price != null },
    inSuggest: inZone(cardEl, SUGGEST, null), // a list that IS a carousel stays readable
    fields, negatives: [], sample: { name: parts.name.slice(0, 80), price: parts.price },
  };
  return { ok: true, model, count: classifyCards(doc, model, pageUrl).kept.length };
}

/** « Pas un produit »: the signature of a false card (what it has that the learned card has not). */
export function negativeSignature(el, doc, model, pageUrl) {
  const card = (model && el.closest(model.card)) || el;
  const parts = cardParts(card, pageUrl);
  const extra = stableClasses(card, 8).filter((c) => !(model.cardClasses || []).includes(c));
  // Its own section when it is not the learned grid (a banner row, a promo block).
  let zone = null;
  const grids = resolveScopes(doc, model, pageUrl);
  for (let cur = card.parentElement, i = 0; cur && i < 6 && !/^(html|body)$/i.test(cur.tagName); cur = cur.parentElement, i++) {
    if (grids.some((g) => cur.contains(g))) break; // never the list itself
    if (stableClasses(cur).length) { zone = controlSelector(cur, doc); if (zone) break; }
  }
  return { name: generic(parts.name) || null, linkShape: parts.url ? linkShape(parts.url, pageUrl) : null, classes: extra, zone };
}
function isNegative(card, sig, doc, parts, base) {
  if (sig.zone) { let z = null; try { z = doc.querySelector(sig.zone); } catch { z = null; } if (z && z.contains(card)) return true; }
  if (sig.classes && sig.classes.length && sig.classes.every((c) => card.classList.contains(c))) return true;
  return !!(sig.name && generic(parts.name) === sig.name && (!sig.linkShape || linkShape(parts.url || '', base) === sig.linkShape));
}

/**
 * Every candidate of the page, kept or rejected with its reason.
 * @returns {{kept:Element[], rejected:Array<{el:Element, reason:string, name:string, url:string|null}>, byReason:Object<string,number>}}
 */
/** The list's sections on the page they were learned on (its other pages share its layout: ?p=2). Another page of
 *  the site (a sub-collection, a landing page built card by card) has none: its whole content is the list there,
 *  the header, menus, footer and suggestions excepted. */
function resolveScopes(doc, model, pageUrl) {
  const found = [];
  const here = !model.learnedOn || !pageUrl || batchKeyOf(pageUrl) === model.learnedOn;
  if (here) for (const s of model.scopes || (model.scope ? [model.scope] : [])) { let g = null; try { g = doc.querySelector(s); } catch { g = null; } if (g && g.querySelector(model.card)) found.push(g); }
  return found;
}

export function classifyCards(doc, model, pageUrl) {
  let all = []; try { all = [...doc.querySelectorAll(model.card)]; } catch { all = []; }
  all = all.filter((c) => !all.some((o) => o !== c && o.contains(c))); // a card inside a card is one card
  const grids = resolveScopes(doc, model, pageUrl);
  const kept = []; const rejected = []; const byReason = {};
  const reject = (el, reason, parts) => { rejected.push({ el, reason, name: parts ? parts.name.slice(0, 80) : '', url: parts ? parts.url : null }); byReason[reason] = (byReason[reason] || 0) + 1; };
  for (const c of all) {
    const parts = cardParts(c, pageUrl);
    const grid = grids.find((g) => g.contains(c)) || null;
    if (grids.length ? !grid : inZone(c, CHROME, null)) { reject(c, 'outside_list', parts); continue; }
    if (!model.inSuggest && inZone(c, SUGGEST, grid)) { reject(c, 'carousel', parts); continue; }
    if ((model.negatives || []).some((s) => isNegative(c, s, doc, parts, pageUrl))) { reject(c, 'marked_not_product', parts); continue; }
    if (!parts.url) { reject(c, 'no_link', parts); continue; }
    if (model.linkShape && linkShape(parts.url, pageUrl) !== model.linkShape) { reject(c, 'other_link', parts); continue; }
    if (model.needs && model.needs.title && !parts.name) { reject(c, 'no_title', parts); continue; }
    if (model.needs && model.needs.price && parts.price == null) { reject(c, 'no_price', parts); continue; }
    kept.push(c);
  }
  return { kept, rejected, byReason };
}

/** A card model as stored (validated, bounded): null when unusable. */
export function sanitizeCardModel(m) {
  if (!m || typeof m !== 'object' || typeof m.card !== 'string' || !m.card.trim()) return null;
  const s = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  const fields = {};
  for (const k of ['name', 'url', 'price', 'image']) { const f = m.fields && m.fields[k]; if (f && s(f.selector, 300)) fields[k] = { selector: s(f.selector, 300), ...(s(f.attr, 20) ? { attr: s(f.attr, 20) } : {}) }; }
  const negatives = (Array.isArray(m.negatives) ? m.negatives : []).slice(0, 30).map((n) => ({ name: s(n && n.name, 80), linkShape: s(n && n.linkShape, 120), classes: Array.isArray(n && n.classes) ? n.classes.filter((c) => typeof c === 'string').slice(0, 8).map((c) => c.slice(0, 60)) : [], zone: s(n && n.zone, 300) })).filter((n) => n.name || n.classes.length || n.zone);
  return {
    v: 1, card: m.card.trim().slice(0, 300), learnedOn: s(m.learnedOn, 300), scopes: (Array.isArray(m.scopes) ? m.scopes : (m.scope ? [m.scope] : [])).map((x) => s(x, 300)).filter(Boolean).slice(0, 20), cardClasses: Array.isArray(m.cardClasses) ? m.cardClasses.filter((c) => typeof c === 'string').slice(0, 8) : [],
    linkShape: s(m.linkShape, 120), needs: { title: !!(m.needs && m.needs.title), price: !!(m.needs && m.needs.price) }, inSuggest: m.inSuggest === true,
    fields, negatives, ...(m.sample && typeof m.sample === 'object' ? { sample: { name: s(m.sample.name, 80), price: Number.isFinite(Number(m.sample.price)) ? Number(m.sample.price) : null } } : {}),
  };
}
