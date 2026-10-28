/**
 * Read product rows from a page with a LEARNED card recipe — the same
 * `manual_selectors` shape the app stores (card + fields{selector, attr}) — on any
 * DOM: the live page (extension in-page runner) or a parsed one (linkedom, tests).
 * Generic: no site rule; the recipe is data.
 *
 * Field mapping matches the app's applySelectorRecipe: name, price (parsed money),
 * url → sourceUrl/canonicalUrl, image → images[], sku, ean → gtin; any other key
 * (a field the user added, e.g. "reduction") is kept as its text/attribute value.
 * A field selector ":card" means the card element itself.
 */
import { designatedPrice, joinCents, parseAmount, CUR, CUR_SYMBOL, MONEY_RE } from './money.mjs';
import { bestFromSrcset } from './images.mjs';

const abs = (v, base) => { if (!v) return null; try { return new URL(String(v).trim(), base).href; } catch { return null; } };

/** Best image URL of an element (live DOM: currentSrc; lazy: data-src / srcset — the largest candidate, parsed as the HTML spec says). */
function imageUrl(el, attr) {
  const img = el && el.tagName === 'IMG' ? el : (el && el.querySelector ? el.querySelector('img') : null);
  if (!img) return attr && el && el.getAttribute ? el.getAttribute(attr) : null;
  const own = attr ? (/srcset$/i.test(attr) ? bestFromSrcset(img.getAttribute(attr)) : img.getAttribute(attr)) : null;
  if (own && !/^data:/i.test(own)) return own;
  if (img.currentSrc && !/^data:/i.test(img.currentSrc)) return img.currentSrc;
  for (const a of ['src', 'data-src', 'data-original', 'data-lazy-src']) { const v = img.getAttribute(a); if (v && !/^data:/i.test(v)) return v; }
  return bestFromSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset'));
}

/**
 * The product's picture when the card read holds none (a card recipe that covers
 * only the title and price part of a tile): the card's own image, else, up to 3
 * levels above it, a block whose links all lead to this same product — the
 * thumbnail sits next to the title. Never an image of another product.
 */
function nearbyImage(card, productUrl, baseUrl) {
  const own = imageUrl(card, null); if (own) return own;
  if (!productUrl) return null;
  const key = (u) => { const a = abs(u, baseUrl); return a ? a.replace(/[?#].*$/, '').replace(/\/$/, '') : null; };
  const target = key(productUrl);
  let n = card;
  for (let i = 0; i < 3 && n && n.parentElement; i++) {
    n = n.parentElement;
    if (/^(body|html|main)$/i.test(n.tagName)) break;
    const links = new Set([...n.querySelectorAll('a[href]')].map((a) => key(a.getAttribute('href'))).filter(Boolean));
    if (links.size > 1 || (links.size === 1 && !links.has(target))) break; // another product's block
    const img = imageUrl(n, null); if (img) return img;
  }
  return null;
}

/**
 * The text a reader sees in an element: style sheets, scripts and templates that
 * some sites render INSIDE their cards (CSS-in-JS) are not part of it.
 */
export function visibleText(el) {
  if (!el) return '';
  let out = '';
  const walk = (n) => {
    if (n.nodeType === 3) { out += n.textContent; return; }
    if (n.nodeType !== 1 || /^(style|script|noscript|template)$/i.test(n.tagName)) return;
    for (const c of n.childNodes || []) walk(c);
  };
  walk(el);
  return out.replace(/\s+/g, ' ').trim();
}
const text = visibleText;

// The text of `root` up to (not including) `stop`, skipping style/script — the EUROS
// written before a cents superscript.
function textBefore(root, stop) {
  let out = ''; let done = false;
  const walk = (n) => {
    if (done) return;
    if (n === stop) { done = true; return; }
    if (n.nodeType === 3) { out += n.textContent; return; }
    if (n.nodeType !== 1 || /^(style|script|noscript|template|svg)$/i.test(n.tagName)) return;
    for (const c of n.childNodes || []) { walk(c); if (done) return; }
  };
  walk(root);
  return out;
}
// A cents fragment set apart in a superscript / subscript: many price blocks render
// "10" + <sup>99</sup> or "0" + <sup>956</sup> with NO decimal separator, so the flat
// text "1099" / "0956" parses to a wrong integer. The FIRST sup/sub holding a bare
// 1–3 digit run. Generic markup signal, no site rule.
function supCents(el) {
  if (!el || !el.querySelectorAll) return null;
  let supers = []; try { supers = [...el.querySelectorAll('sup, sub')]; } catch { supers = []; }
  for (const s of supers) {
    const t = visibleText(s).replace(/\D/g, '');
    if (/^\d{1,3}$/.test(t)) return { cents: t, node: s };
  }
  return null;
}
const currencyIn = (s) => {
  const m = String(s || '').match(new RegExp(`(?:${CUR})`, 'i'));
  if (!m) return null;
  const c = m[0];
  return CUR_SYMBOL[c] || CUR_SYMBOL[c.toUpperCase()] || (/^[A-Z]{3}$/.test(c.toUpperCase()) ? c.toUpperCase() : null);
};
/**
 * Read a price from a DOM element, reconstructing a cents fragment split off in a
 * superscript, and keeping a per-unit price (€/l, /pce) out of the selling price.
 * Falls back to the string parser when the price is written in one piece.
 * @returns {{price:number, currency:string|null}|null}
 */
export function priceFromEl(el) {
  if (!el) return null;
  const flat = visibleText(el);
  if (!flat || !/\d/.test(flat)) return null;
  const sc = supCents(el);
  if (sc) {
    const before = textBefore(el, sc.node);
    const whole = parseAmount(before);
    // Only reconstruct when the euros before the superscript carry no decimal of
    // their own (else the price is already whole, e.g. "10,99" with a styled "99").
    if (whole != null && !/\d[.,]\d/.test(before)) {
      const price = joinCents(before, sc.cents);
      if (price != null && price > 0 && price < 1e9) return { price, currency: currencyIn(flat) };
    }
  }
  return designatedPrice(flat);
}

// A line that joins several values ("Chambre · Charleroi", "Noir | L 120 cm"): the
// separators recognised, most specific first. Dashes, slashes and commas only with
// spaces around, so "Charleroi-Marcinelle" or "2,5 kg" stay whole.
// The middle dots are one kind: sites write "·" (U+00B7), "⋅" (U+22C5, a rental
// site's "Appartement ⋅ Liège"), "∙", "‧" or "・" for the same separator.
const PART_SEPS = [
  ['·', /\s*[·⋅∙‧・]\s*/g], ['•', /\s*•\s*/g], ['|', /\s*\|\s*/g], ['–', /\s+–\s+/g], ['—', /\s+—\s+/g],
  ['-', /\s+-\s+/g], ['/', /\s+\/\s+/g], [',', /,\s+/g],
];
function segmentsOf(s, sep) {
  const entry = PART_SEPS.find(([k]) => k === sep); if (!entry) return null;
  const re = new RegExp(entry[1].source, 'g'); const out = []; let last = 0; let m;
  while ((m = re.exec(s))) { if (m[0].length === 0) { re.lastIndex++; continue; } out.push({ start: last, end: m.index }); last = m.index + m[0].length; }
  out.push({ start: last, end: s.length });
  return out.length >= 2 ? out : null;
}
/**
 * The part of a line the user clicked: which separator, which piece (counted from
 * the end when it is the last one: a city after a varying label), and its text.
 * @param {string} s the element's text  @param {number} offset the click position in it
 * `start` / `end` = where the piece sits in `s` (to highlight it while hovering).
 * @returns {{sep:string, index:number, value:string, start:number, end:number}|null}
 */
export function textPart(s, offset) {
  const str = String(s || '');
  if (!(offset >= 0) || offset > str.length) return null;
  for (const [sep] of PART_SEPS) {
    const segs = segmentsOf(str, sep); if (!segs) continue;
    const i = segs.findIndex((g) => offset >= g.start && offset <= g.end);
    if (i < 0) return null; // on the separator itself: the whole line
    const value = str.slice(segs[i].start, segs[i].end).replace(/\s+/g, ' ').trim();
    if (!value) return null;
    return { sep, index: i === segs.length - 1 ? -1 : i, value, start: segs[i].start, end: segs[i].end };
  }
  return null;
}
/** The same part of another card's line ({sep, index}; a negative index counts from the end). */
export function applyPart(s, part) {
  if (!part || !part.sep) return s;
  const str = String(s || ''); const segs = segmentsOf(str, part.sep);
  if (!segs) return part.index === 0 || part.index === -1 ? str.trim() : '';
  const g = segs[part.index < 0 ? segs.length + part.index : part.index];
  return g ? str.slice(g.start, g.end).replace(/\s+/g, ' ').trim() : '';
}

/** What one entry of a list shows: its text, else its label (a colour swatch, an icon). */
export function itemValue(n) {
  const t = visibleText(n); if (t) return t;
  for (const a of ['aria-label', 'title', 'data-value', 'value', 'alt']) { const v = n.getAttribute && n.getAttribute(a); if (v && v.trim()) return v.trim(); }
  const img = n.querySelector && n.querySelector('img[alt]');
  return img ? String(img.getAttribute('alt') || '').trim() : '';
}
/**
 * An entry that shows its own price (« 30 ML 77,70 € », « M — €12.99 ») as « 30 ML : 77.70 »: the value, then its price,
 * the form the Converter reads per value. Only an amount written with its currency is a price (« 38,5 » is a size).
 */
export function valueWithPrice(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const m = s.match(MONEY_RE);
  if (!m) return s;
  const name = s.replace(m[0], ' ').replace(/[\s:–—\-|/,(]+$/, '').replace(/^[\s:–—\-|/,)]+/, '').replace(/\(\s*\)/g, '').trim();
  const amount = parseAmount(m[2] || m[3]);
  return name && amount != null ? `${name} : ${amount.toFixed(2)}` : s;
}
/** The values of a list (sizes, lengths, colours): each entry once, in page order, with its price when it shows one. */
export function listValues(items) {
  const out = [];
  for (const n of items || []) { const v = valueWithPrice(itemValue(n)); if (v && v.length <= 60 && !out.includes(v)) out.push(v); }
  return out;
}

/**
 * Resolve a field selector inside a card. ":card" = the card itself; a positional
 * path ":scope > tag:nth-of-type(n) > …" is walked step by step (portable: some
 * DOM implementations lack :scope); anything else is a plain querySelector.
 */
export function queryInCard(card, selector) {
  if (!card || !selector) return null;
  if (selector === ':card') return card;
  if (selector.startsWith(':scope > ')) {
    let node = card;
    for (const step of selector.slice(9).split(' > ')) {
      const m = step.trim().match(/^([a-z0-9-]+):nth-of-type\((\d+)\)$/i);
      if (!m || !node) return null;
      node = [...node.children].filter((c) => c.tagName.toLowerCase() === m[1].toLowerCase())[Number(m[2]) - 1] || null;
    }
    return node;
  }
  try { return card.querySelector(selector); } catch { return null; }
}

/**
 * @param {Document|Element} root  the page (or a container) to read
 * @param {{card:string, fields:Object<string,{selector:string, attr?:string|null}>}} recipe
 * @param {string} baseUrl
 * @returns {object[]} raw product rows (one per card that yields a name or a URL)
 */
export function readCards(root, recipe, baseUrl) {
  if (!root || !recipe || !recipe.card) return [];
  let cards = [];
  try { cards = [...root.querySelectorAll(recipe.card)]; } catch { return []; }
  return readCardElements(cards, recipe, baseUrl);
}

/** The same read on cards already chosen (the kept cards of a learned card model: card-model.mjs). */
export function readCardElements(cards, recipe, baseUrl) {
  if (!recipe) return [];
  const out = [];
  for (const card of cards) {
    const row = { strategy: 'dom-selectors' };
    for (const [key, spec] of Object.entries(recipe.fields || {})) {
      if (!spec || !spec.selector) continue;
      if (spec.all) {
        // A list field (sizes, lengths, colours): every entry of the group, "28 | 29 | 30".
        const box = queryInCard(card, spec.selector); if (!box) continue;
        let items = []; try { items = [...box.children].filter((c) => c.matches(spec.all)); } catch { items = []; }
        const vals = listValues(items); if (vals.length) row[key] = vals.join(' | ');
        continue;
      }
      const el = queryInCard(card, spec.selector);
      if (!el) continue;
      const attr = spec.attr || null;
      if (key === 'image' || key === 'thumbnail') { const u = abs(imageUrl(el, attr), baseUrl); if (u) row[key === 'image' ? 'images' : key] = key === 'image' ? [u] : u; continue; }
      // Price fields are read from the ELEMENT (so a cents superscript and a per-unit
      // price are handled by structure, not from a flattened "1099/pce"); an attribute
      // price (rare) still parses from its string.
      if ((key === 'price' || key === 'list_price') && !attr) {
        const m = priceFromEl(el);
        if (m && m.price != null) { if (key === 'price') { row.price = m.price; if (m.currency) row.currency = m.currency; } else { row.listPrice = m.price; if (m.currency && !row.currency) row.currency = m.currency; } }
        continue;
      }
      let val = attr ? el.getAttribute(attr) : text(el);
      if (val == null || String(val).trim() === '') continue;
      val = String(val).trim();
      if (spec.part && !attr) { val = applyPart(val, spec.part); if (!val) continue; } // one piece of "Chambre · Charleroi"
      if (key === 'price') { const m = designatedPrice(val); if (m && m.price != null) { row.price = m.price; if (m.currency) row.currency = m.currency; } continue; }
      if (key === 'list_price') { const m = designatedPrice(val); if (m && m.price != null) row.listPrice = m.price; continue; }
      if (key === 'url') { const u = abs(val, baseUrl); if (u) { row.sourceUrl = u; row.canonicalUrl = u; } continue; }
      if (key === 'name' || key === 'title') { row.name = val.slice(0, 300); if (key === 'title') row.title = row.name; continue; }
      if (key === 'ean') { row.gtin = val; continue; }
      row[key] = attr === 'href' || attr === 'src' ? (abs(val, baseUrl) || val) : val.slice(0, 2000);
    }
    // The whole page as the card: a product page — the page itself is the product's page.
    if (recipe.card === 'body' && !row.sourceUrl && baseUrl) { row.sourceUrl = baseUrl; row.canonicalUrl = baseUrl; }
    if (!row.images && recipe.card !== 'body') { const u = abs(nearbyImage(card, row.sourceUrl, baseUrl), baseUrl); if (u && !/^data:/i.test(u)) row.images = [u]; }
    // A « prix barré » that is not above the price is the same price read twice (marshydro 28/10: 639.99 / 639.99).
    if (row.listPrice != null && row.price != null && Number(row.listPrice) <= Number(row.price)) delete row.listPrice;
    if (row.name || row.sourceUrl) out.push(row);
  }
  return out;
}

/** Dedup key of a row: its product URL (no hash, no trailing slash), else name + price. */
export function rowKey(row) {
  const u = row && (row.sourceUrl || row.canonicalUrl || row.url);
  if (u) { try { const x = new URL(u); x.hash = ''; return 'u:' + x.toString().replace(/\/$/, ''); } catch { /* fall through */ } }
  return `n:${(row && (row.name || row.title)) || ''}|${(row && row.price) ?? ''}`;
}

/**
 * Merge a stored recipe (from the app) with the fields the user designated in the
 * panel. The user's designations win field by field; a user card wins too.
 * @param {{card?:string, fields?:object}|null} base
 * @param {{card?:string|null, fields?:Array<{key:string, selector?:string, attr?:string|null}>}} user
 */
export function mergeRecipe(base, user) {
  const card = (user && user.card) || (base && base.card) || null;
  if (!card) return null;
  // The stored fields are relative to the stored card: usable only with that card.
  const fields = { ...((base && base.card === card && base.fields) || {}) };
  for (const f of (user && user.fields) || []) {
    if (!f || !f.key || !f.selector) continue;
    fields[f.key] = { selector: f.selector, attr: f.attr || null };
    if (f.part && f.part.sep) fields[f.key].part = { sep: String(f.part.sep), index: Number(f.part.index) || 0 };
    if (typeof f.all === 'string' && f.all) fields[f.key].all = f.all;
  }
  return Object.keys(fields).length ? { card, fields } : null;
}

/**
 * Do these rows look like a working read? Rows without a name or a price beyond
 * the quality gate's limits mean the recipe no longer matches the page (e.g. its
 * class names were regenerated). Same rule in the app and in the extension.
 * @param {object[]} rows
 * @param {{maxEmptyNameRatio?:number, maxEmptyPriceRatio?:number}} [q]
 */
export function rowsHealth(rows, q = {}) {
  const n = (rows || []).length;
  if (!n) return { ok: false, emptyNameRatio: 1, emptyPriceRatio: 1 };
  const noName = rows.filter((r) => !(r && String(r.name || '').trim())).length / n;
  const noPrice = rows.filter((r) => !(r && r.price != null && Number(r.price) > 0)).length / n;
  const maxN = q && q.maxEmptyNameRatio != null ? q.maxEmptyNameRatio : 0.3;
  const maxP = q && q.maxEmptyPriceRatio != null ? q.maxEmptyPriceRatio : 0.6;
  const r2 = (x) => Math.round(x * 100) / 100;
  return { ok: noName <= maxN && noPrice <= maxP, emptyNameRatio: r2(noName), emptyPriceRatio: r2(noPrice) };
}
