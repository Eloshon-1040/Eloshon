/**
 * Recipe PRODUCER (Étape 2b) — NO AI. Derives a reusable `manual_selectors`
 * recipe from a page the free mechanisms already extracted, and replays that
 * recipe over any page's HTML. This is the "understand once, replay for free"
 * engine: the producer runs a handful of times per site (discovery / a user
 * click / later the AI), the replay runs for the whole catalogue with zero cost.
 *
 * The produced recipe is the SAME `manual_selectors` shape the domain profile and
 * Supabase already store (card + fields{selector,attr} + pagination) — no second
 * structure. Internal-API sites keep using the `internal_api` recipe instead.
 *
 * Pure + offline: HTML in, recipe/products out (linkedom, no network, no browser).
 */
import { parseHTML } from 'linkedom';
import { absoluteUrl } from './url-utils.mjs';
import { paginateListing } from './listing-pagination.mjs';
import { extractProductsFromJson } from './embedded-state.mjs';
import { stableClasses, relativeSelector } from '../shared/extract/pick-selector.mjs';
import { queryInCard, rowsHealth, visibleText, priceFromEl } from '../shared/extract/card-recipe.mjs';
import { designatedPrice } from '../shared/extract/money.mjs';

const PRICE_RE = /\d+[.,]\d{2}\s*€|€\s*\d|\d+[.,]\d{2}\s*(?:eur|chf|£|\$)/i;

/**
 * Selector for an element RELATIVE to its card, built only from STABLE class names
 * (never a generated hash such as "tw-4m0ihd" / "css-8f3k2a", which changes with
 * every build of the site): its first stable class when that finds it in the card,
 * else the shortest stable path, else a positional path from the card.
 */
function leafSelector(el, card) {
  if (!el) return null;
  const cls = stableClasses(el, 1)[0];
  if (cls) {
    const sel = '.' + CSS.escape(cls);
    if (!card) return sel;
    let hit = null; try { hit = card.querySelector(sel); } catch { hit = null; }
    if (hit === el) return sel;
  }
  return card ? relativeSelector(card, el) : el.tagName.toLowerCase();
}
// linkedom has no global CSS.escape — provide a minimal one (class tokens only).
const CSS = { escape: (s) => String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1') };

/** Derive the pagination rule generically (URL param → next-link → load-more → none). */
function derivePagination(document) {
  const next = document.querySelector('a[rel="next"], link[rel="next"]');
  if (next) {
    const href = next.getAttribute('href') || '';
    const m = href.match(/[?&](p|page|pageNumber|start|offset)=(\d+)/i);
    if (m) return { mode: 'url-param', param: m[1], start: 1, max_pages: null }; // entry = page 1; param drives pages ≥ 2
    return { mode: 'next-link', selector: 'a[rel="next"]', max_pages: null };
  }
  for (const a of document.querySelectorAll('a[href]')) {
    const h = a.getAttribute('href') || '';
    const m = h.match(/[?&](p|page)=(\d+)/i);
    if (m) return { mode: 'url-param', param: m[1], start: 1, max_pages: null };
  }
  for (const b of document.querySelectorAll('button, a')) {
    if (/voir plus|charger plus|afficher plus|load more|show more|plus de produits/i.test(b.textContent || '')) return { mode: 'load-more', selector: null, max_pages: null };
  }
  return { mode: 'none', max_pages: null };
}

/**
 * Derive a `manual_selectors` recipe from a listing page's HTML. Finds the
 * repeated product card (an element carrying a price + a link, recurring ≥3×),
 * then the field selectors within it. Returns null when no repeated priced card
 * is found (the caller then keeps the normal ladder — never a wrong recipe).
 * @param {string} html
 * @param {string} baseUrl
 * @param {'auto-discovery'|'manual'|'ai-assisted'} [origin]
 */
export function deriveSelectorRecipe(html, baseUrl, origin = 'auto-discovery') {
  if (!html) return null;
  const { document } = parseHTML(html);
  // 1) repeated card: class signature carrying a price + a link, most frequent.
  const counts = new Map();
  for (const el of document.querySelectorAll('*[class]')) {
    if (!PRICE_RE.test(el.textContent || '')) continue;
    if (!el.querySelector('a[href]')) continue;
    // Stable class names only: a card known by a generated hash breaks at the
    // site's next build. No stable class → this element is not a card candidate.
    const sig = stableClasses(el, 6).map((c) => CSS.escape(c)).join('.');
    if (!sig) continue;
    const cur = counts.get(sig) || { count: 0, sample: el };
    cur.count += 1; counts.set(sig, cur);
  }
  let best = null;
  for (const [sig, v] of counts) {
    if (v.count < 3) continue;                       // a real grid repeats
    if (!best || v.count > best.count || (v.count === best.count && sig.length < best.sig.length)) best = { sig, ...v };
  }
  if (!best) return null;
  const card = best.sample;

  // 2) field selectors, scoped inside the card.
  const anchors = [...card.querySelectorAll('a[href]')].filter((a) => { const h = a.getAttribute('href') || ''; return h && h !== '#' && !/^javascript:/i.test(h); });
  const nameAnchor = anchors.find((a) => (a.textContent || '').trim().length > 4) || anchors[0] || null;
  const priceEl = [...card.querySelectorAll('*')].find((e) => e.children.length === 0 && PRICE_RE.test(e.textContent || ''));
  const img = card.querySelector('img');

  const fields = {};
  if (nameAnchor) fields.name = { selector: leafSelector(nameAnchor, card), attr: null };
  if (priceEl) fields.price = { selector: leafSelector(priceEl, card), attr: null };
  if (img) fields.image = { selector: 'img', attr: img.getAttribute('src') ? 'src' : (img.getAttribute('data-src') ? 'data-src' : 'src') };
  if (nameAnchor) fields.url = { selector: leafSelector(nameAnchor, card), attr: 'href' };
  if (!fields.name || !fields.name.selector || !fields.price || !fields.price.selector) return null; // not enough to be worth a recipe

  return { card: '.' + best.sig, fields, pagination: derivePagination(document), origin, sample_url: baseUrl };
}

/**
 * Replay a `manual_selectors` recipe over one page's HTML → partial RawProduct[]
 * (the SAME shape core/normalize.mjs consumes: name / price / sku / gtin /
 * images[] / sourceUrl). Pure: HTML in, products out; the caller owns fetching
 * (HTTP or browser) and pagination.
 */
export function applySelectorRecipe(html, recipe, baseUrl) {
  if (!html || !recipe || !recipe.card) return [];
  const { document } = parseHTML(html);
  const out = [];
  for (const cardEl of document.querySelectorAll(recipe.card)) {
    const raw = { strategy: 'dom-selectors' };
    for (const [field, spec] of Object.entries(recipe.fields || {})) {
      if (!spec || !spec.selector) continue;
      const el = queryInCard(cardEl, spec.selector); // ":card" / positional paths included
      if (!el) continue;
      // Price read from the element (cents superscript + per-unit price handled by
      // structure — same as the extension), not from a flattened "1099/pce".
      if (field === 'price' && !spec.attr) { const m = priceFromEl(el); if (m && m.price != null) { raw.price = m.price; if (m.currency) raw.currency = m.currency; } continue; }
      let val = spec.attr ? el.getAttribute(spec.attr) : visibleText(el);
      if (val == null || val === '') continue;
      if (field === 'price') { const m = designatedPrice(val); if (m && m.price != null) { raw.price = m.price; if (m.currency) raw.currency = m.currency; } continue; }
      if (field === 'name') raw.name = val;
      else if (field === 'url') { const u = absoluteUrl(val, baseUrl); if (u) { raw.sourceUrl = u; raw.canonicalUrl = u; } }
      else if (field === 'image') { const u = absoluteUrl(val, baseUrl); if (u) raw.images = [u]; }
      else if (field === 'sku') raw.sku = String(val);
      else if (field === 'ean') raw.gtin = String(val);
      else raw[field] = val;
    }
    if (raw.name || raw.sourceUrl) out.push(raw);
  }
  return out;
}

/** Set/replace a query param on a URL (for url-param pagination). */
function setUrlParam(url, param, value) {
  try { const u = new URL(url); u.searchParams.set(param, String(value)); return u.toString(); } catch { return url; }
}

/**
 * Replay a `manual_selectors` recipe across a catalogue over HTTP — NO AI, NO
 * per-product cost. `fetchHtml(url) → {ok, html, status}` is injected (the caller
 * uses the polite fetcher, or the browser for a protected site). Paginates by URL
 * param and stops on Skyvern's rules: an empty page, the first product repeating
 * page 1's, or all-duplicates. next-link / load-more recipes replay page 1 only
 * here (a browser-driven follow comes with the manual-designation step).
 * @returns {{ ok, products, pages, total, error }}
 */
export async function replaySelectorLane(recipe, entryUrl, { fetchHtml, maxProducts = 1000, maxPages = 100, onStep } = {}) {
  const step = (m, e) => { try { if (onStep) onStep(m, e || {}); } catch { /* never break the lane */ } };
  if (!recipe || !recipe.card || typeof fetchHtml !== 'function') return { ok: false, products: [], pages: 0, total: null, error: 'bad recipe or fetchHtml' };
  const pg = recipe.pagination || { mode: 'none' };
  const products = []; const seen = new Set();
  let pages = 0; let firstKey = null;
  let nextPage = 2;            // the entry URL IS page 1; the param drives pages ≥ 2
  let url = entryUrl;

  while (pages < maxPages && products.length < maxProducts) {
    let res;
    try { res = await fetchHtml(url); } catch (e) { return { ok: products.length > 0, products, pages, total: null, error: `fetch failed: ${e.message}` }; }
    if (!res || !res.ok || !res.html) { if (pages === 0) return { ok: false, products, pages, total: null, error: `fetch ${url} → ${res && res.status}` }; break; }
    const cards = applySelectorRecipe(res.html, recipe, url);
    if (!cards.length) break;                                  // no more products
    const key0 = cards[0].sourceUrl || cards[0].name || null;
    if (pages > 0 && key0 && key0 === firstKey) break;         // page repeats page 1 → stop
    if (pages === 0) firstKey = key0;
    let added = 0;
    for (const c of cards) { const k = c.sourceUrl || `${c.name}|${c.price}`; if (seen.has(k)) continue; seen.add(k); products.push(c); added += 1; if (products.length >= maxProducts) break; }
    pages += 1;
    step(pages === 1 ? 'firstPage' : 'paginate', { page: pages, found: products.length });
    if (added === 0) break;                                    // all duplicates → end
    if (pg.mode !== 'url-param') break;                        // only url-param paginates over HTTP
    url = setUrlParam(entryUrl, pg.param, nextPage); nextPage += 1;
  }
  return { ok: products.length > 0, products, pages, total: null, error: products.length ? null : 'no products' };
}

/**
 * Replay a `manual_selectors` recipe with GENERIC pagination (core/listing-
 * pagination.mjs): page 1 through `fetchHtml` (the caller's usual fetch, which
 * may fall back to the local browser), every further page over free HTTP only
 * (`fetchPageHtml` / `fetchJson`). Follows rel=next, "next" links, an observed
 * page/offset parameter, or an embedded internal-API "next" request; reports a
 * load-more / infinite scroll it cannot follow instead of guessing. The recipe's
 * stored `pagination` acts as a memo (old recipes keep working: an unknown or
 * 'none' mode just means "detect again").
 * @returns {Promise<{ ok, products, pages, total, error, pagination }>}
 */
export async function replaySelectorLaneGeneric(recipe, entryUrl, { fetchHtml, fetchPageHtml, fetchJson, maxProducts = 1000, maxPages = 50, onStep, isStopped, discoverApiHeaders, resolveApiHeaders } = {}) {
  const step = (m, e) => { try { if (onStep) onStep(m, e || {}); } catch { /* never break the lane */ } };
  if (!recipe || !recipe.card || typeof fetchHtml !== 'function') return { ok: false, products: [], pages: 0, total: null, error: 'bad recipe or fetchHtml', pagination: null };
  let res;
  try { res = await fetchHtml(entryUrl); } catch (e) { return { ok: false, products: [], pages: 0, total: null, error: `fetch failed: ${e.message}`, pagination: null }; }
  if (!res || !res.ok || !res.html) return { ok: false, products: [], pages: 0, total: null, error: `fetch ${entryUrl} → ${res && res.status}`, pagination: null };
  const first = applySelectorRecipe(res.html, recipe, entryUrl);
  if (!first.length) return { ok: false, products: [], pages: 1, total: null, error: 'no products', pagination: null };
  step('firstPage', { page: 1, found: first.length });
  const pg = await paginateListing({
    entryUrl, firstHtml: res.html, firstCards: first,
    extractCards: (html, url) => applySelectorRecipe(html, recipe, url),
    extractJsonCards: (json, url) => extractProductsFromJson(json, url).cards,
    fetchHtml: fetchPageHtml || fetchHtml, fetchJson,
    maxProducts, maxPages, memo: recipe.pagination, onStep, isStopped,
    // API headers: re-read from the recipe's stored specs, or found in the page's
    // public scripts when the API refuses (both optional, both free HTTP).
    discoverApiHeaders, resolveApiHeaders,
  });
  return { ok: pg.cards.length > 0, products: pg.cards, pages: pg.pages, total: pg.totalAnnounced, error: null, pagination: pg };
}

/**
 * Is a learned selector recipe still reading this site? Rows without a name or a
 * price beyond the quality gate's own limits mean the page changed (e.g. its class
 * names were regenerated): the caller then counts a failure for the recipe and
 * uses the other methods instead of keeping nameless / priceless rows.
 * @param {object[]} rows raw rows from applySelectorRecipe
 * @param {{maxEmptyNameRatio?:number, maxEmptyPriceRatio?:number}} [q] cfg.quality
 */
export function selectorRowsHealth(rows, q = {}) {
  return rowsHealth(rows, q);
}
