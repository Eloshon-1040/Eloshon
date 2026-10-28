/**
 * "Désigner à la souris": from ONE element the user clicked, derive
 *   - the repeated product CARD it belongs to (a selector matching every card), and
 *   - a selector RELATIVE to that card for the clicked field (+ which attribute to
 *     read: text, href or an image source),
 * so the same field can be read on every card of the list. Generic "find similar":
 * no site rule, works on any DOM (live page or linkedom in tests).
 */

import { visibleText, textPart, listValues } from './card-recipe.mjs';

// Fields whose value is always the whole element, never one piece of a line.
const WHOLE_ROLES = /^(name|title|price|list_price|prix|prix_barre|tarif|url|link|lien|image|thumbnail|description|sku|ean)$/i;
/** Is this field always read whole (never one piece of a line)? */
export const isWholeRole = (key) => WHOLE_ROLES.test(String(key || ''));
/** An element's text as the page holds it (scripts and style sheets excluded). */
export function rawText(el) {
  let out = '';
  const walk = (n) => { if (n.nodeType === 3) { out += n.textContent; return; } if (n.nodeType !== 1 || /^(style|script|noscript|template)$/i.test(n.tagName)) return; for (const c of n.childNodes || []) walk(c); };
  if (el) walk(el);
  return out;
}
/** Position, in `el`'s text, of a point inside one of its text nodes (-1 when outside). */
export function offsetIn(el, node, nodeOffset) {
  let pos = 0; let found = -1;
  const walk = (n) => {
    if (found >= 0) return;
    if (n.nodeType === 3) { if (n === node) { found = pos + Math.min(nodeOffset, n.textContent.length); return; } pos += n.textContent.length; return; }
    if (n.nodeType !== 1 || /^(style|script|noscript|template)$/i.test(n.tagName)) return;
    for (const c of n.childNodes || []) walk(c);
  };
  if (el && node) walk(el);
  return found;
}

// Class names that change between builds or states are not usable in a selector:
// CSS-in-JS hashes (css-1x2y3z, sc-…), long hex/digit runs, state flags.
// A generated hash segment ("tw-4m0ihd", "css-8f3k2a", "x1y2z3"): a 5–10 character
// segment mixing letters and digits at the end of the class.
const UNSTABLE = /^(css|sc|jsx|emotion|styled|svelte)-|^_|[0-9a-f]{6,}|\d{3,}|^(is|has|js|ng)-|--(active|selected|hover|focus|open|opened|expanded|collapsed|current|checked|disabled|visible)$|(^|[-_])(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{5,10}$/i;
// Build hashes the pattern above misses (measured on real shops, 25/10/2026): CSS-modules suffixes after
// "__" that are not a lower-case word ("accordion__content__dWvE_", "name__sg_q8", "section___rDRL"), a short
// mixed-case segment of CSS-in-JS ("mms-ui-cBWQP", "brREjs"), and React's generated ids (":r2:", "«r1»").
const BUILD_HASH = /__(?![a-z]+$)[A-Za-z0-9_-]{4,6}$|(^|[-_])(?=[A-Za-z]*[a-z])(?=[A-Za-z]*[A-Z])(?![A-Z][a-z]+$)[A-Za-z]{3,7}$|[-_][A-Z]{4,7}$|^:r[0-9a-z]+:$|«r[0-9a-z]+»/;

/** Whether a class name (or id) looks generated or state-dependent (never used in a selector). */
export function isUnstableClass(c) { return !c || c.length > 60 || UNSTABLE.test(c) || BUILD_HASH.test(c); }

// Utility classes (Tailwind and the like) say how an element LOOKS, not what it is: shared by many blocks
// of a page, they make a product-page block selector match the wrong element. Excluded from the selectors
// of a taught block (a list card may still use them: a card is found by repetition, not uniqueness).
const UTILITY = /^(?:[a-z0-9]+:)*-?(?:flex|grid|block|inline|inline-block|inline-flex|hidden|contents|relative|absolute|fixed|sticky|static|truncate|underline|uppercase|lowercase|capitalize|italic|visible|invisible|sr-only|container|grow|shrink|transition|transform|border|rounded|shadow|outline|ring)(?:-.*)?$|^(?:[a-z0-9]+:)*-?(?:gap|space|[pm][trblxyse]?|w|h|min|max|size|text|font|leading|tracking|break|whitespace|bg|from|to|via|opacity|z|order|col|row|overflow|object|cursor|duration|ease|delay|translate|rotate|scale|skew|basis|aspect|inset|top|right|bottom|left|line-clamp|decoration|fill|stroke|divide|indent|pointer-events|tw)-.|^(?:[a-z0-9]+:)*(?:items|self|place-items|place-self)-(?:start|end|center|baseline|stretch|auto)$|^(?:[a-z0-9]+:)*(?:justify|content|place-content)-(?:start|end|center|between|around|evenly|stretch|normal)$|^(?:[a-z0-9]+:)*list-(?:none|disc|decimal|inside|outside)$|^(?:[a-z0-9]+:)*select-(?:none|text|all|auto)$/;
export function isUtilityClass(c) { return UTILITY.test(String(c || '')); }
const esc = (s) => String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1');

/** Stable class tokens of an element (at most `max`). */
export function stableClasses(el, max = 2) {
  return [...((el && el.classList) || [])].filter((c) => !isUnstableClass(c)).slice(0, max);
}

/** tag + up to `maxClasses` stable classes, e.g. "div.product-card__body". */
export function nodeSelector(el, maxClasses = 2) {
  return el.tagName.toLowerCase() + stableClasses(el, maxClasses).map((c) => '.' + esc(c)).join('');
}

const countIn = (doc, sel) => { try { return doc.querySelectorAll(sel).length; } catch { return 0; } };
const hasLink = (el) => !!(el.querySelector('a[href]') || (el.closest && el.closest('a[href]')));

/**
 * The repeated card around `el`: the first ancestor (from the element up) whose
 * class selector repeats ≥ `min` times on the page and holds a link, then the
 * HIGHEST ancestor that still repeats exactly as often (the full card wrapper).
 * `maxClasses`: how many stable classes the card selector may use (more = more
 * specific, useful when utility class names are shared by other blocks).
 * @returns {string|null}
 */
export function deriveCardSelector(el, doc, { min = 3, maxClasses = 2 } = {}) {
  const body = doc.body || doc.documentElement;
  let found = null; let n = 0;
  for (let node = el; node && node !== body && node.nodeType === 1; node = node.parentElement) {
    if (!stableClasses(node).length) continue;
    const sel = nodeSelector(node, maxClasses);
    const c = countIn(doc, sel);
    if (!found) { if (c >= min && hasLink(node)) { found = sel; n = c; } continue; }
    if (c === n) found = sel; // same multiplicity, larger wrapper
    else if (c < n) break;    // fewer: we left the repeated unit
  }
  return found;
}

/**
 * Selector of `el` relative to `card`, as short as possible but resolving to `el`
 * inside its own card: the leaf alone, then with its ancestors, else a positional
 * path (tag:nth-of-type) from the card down. ":card" = the card itself.
 */
export function relativeSelector(card, el) {
  if (card === el) return ':card';
  if (!card.contains(el)) return null;
  const chain = [];
  for (let n = el; n && n !== card; n = n.parentElement) chain.unshift(n);
  const q = (sel) => { try { return card.querySelector(sel); } catch { return null; } };
  const leaf = nodeSelector(el);
  if (q(leaf) === el) return leaf;
  for (let i = chain.length - 2; i >= 0; i--) {
    const sel = `${nodeSelector(chain[i])} ${leaf}`;
    if (q(sel) === el) return sel;
  }
  const nth = (n) => { const same = [...n.parentElement.children].filter((s) => s.tagName === n.tagName); return `${n.tagName.toLowerCase()}:nth-of-type(${same.indexOf(n) + 1})`; };
  return ':scope > ' + chain.map(nth).join(' > ');
}

/**
 * What to read for a field: a link's href for "url", an image source for
 * "image"/"thumbnail", the text otherwise. Returns the element to target and the
 * attribute (null = text).
 */
export function fieldTarget(el, fieldKey) {
  const k = String(fieldKey || '').toLowerCase();
  if (k === 'url' || k === 'link' || k === 'lien') {
    const a = (el.closest && el.closest('a[href]')) || el.querySelector('a[href]');
    if (a) return { el: a, attr: 'href' };
  }
  if (k === 'image' || k === 'thumbnail' || el.tagName === 'IMG') {
    const img = el.tagName === 'IMG' ? el : el.querySelector('img');
    if (img) return { el: img, attr: img.getAttribute('src') && !/^data:/i.test(img.getAttribute('src')) ? 'src' : (img.getAttribute('data-src') ? 'data-src' : 'src') };
  }
  if (PRICE_ROLE.test(k)) return { el: wholeAmountElement(el), attr: null }; // "649," + "99" → the whole price
  return { el, attr: null };
}

const ownText = (el) => { let s = ''; for (const n of el.childNodes || []) if (n.nodeType === 3) s += n.textContent; return s.replace(/\s+/g, ' ').trim(); };

// A price is often split over several elements ("649," + <sup>99</sup>, "29€" +
// <sup>20</sup>): the element under the pointer holds only a part of it. Text of an
// element with a "|" between its child elements, and the amounts it holds — the
// decimals may sit after a separator, a currency sign or a "-" ("399,-").
const PRICE_ROLE = /^(price|list_price|prix|prix_barre|tarif)$/i;
function markedText(el, max = 160) {
  let out = '';
  const walk = (n) => {
    if (out.length > max) return;
    if (n.nodeType === 3) { out += n.textContent; return; }
    if (n.nodeType !== 1 || /^(script|style|svg|noscript|template)$/i.test(n.tagName)) return;
    out += '|'; for (const c of n.childNodes || []) walk(c); out += '|';
  };
  walk(el);
  return out.replace(/\s+/g, ' ');
}
const AMOUNT_RE = /\d+(?:[ . ]\d{3})*(?:\s*(?:[,.]|€|\$|£)(?:\s|\|)*(?:\d{2}(?!\d)|\d(?!\d)|-{1,2}))?/g;
// How complete an amount is: its digits, plus a half point when its decimal part is
// there ("399,-" is more complete than "399,", "649,|99" than "649,").
const digitsOf = (s) => String(s || '').replace(/\D/g, '').length + (/(?:[,.]|€|\$|£)(?:\s|\|)*(?:\d|-)/.test(String(s || '')) ? 0.5 : 0);
/**
 * The smallest element above `el` holding the WHOLE amount: climbs while the parent
 * still holds exactly one amount, with more digits (the cents), in a short text.
 * Stops before an element holding two amounts (old and new price) or a sentence.
 */
export function wholeAmountElement(el, maxUp = 4) {
  if (!el || el.nodeType !== 1) return el;
  const first = (markedText(el).match(AMOUNT_RE) || [])[0];
  let best = el; let bestLen = digitsOf(first); let cur = el;
  for (let i = 0; i < maxUp && cur.parentElement; i++) {
    const p = cur.parentElement;
    if (/^(body|html)$/i.test(p.tagName)) break;
    const t = markedText(p);
    if (t.replace(/\|/g, '').trim().length > 40) break;
    const ms = t.match(AMOUNT_RE) || [];
    if (ms.length !== 1) break;
    if (digitsOf(ms[0]) > bestLen) { best = p; bestLen = digitsOf(ms[0]); }
    cur = p;
  }
  return best;
}
const areaOf = (el) => { try { const r = el.getBoundingClientRect(); const a = r.width * r.height; return a > 0 ? a : Infinity; } catch { return Infinity; } };

/**
 * The element the user MEANT under the pointer, from the stack of elements at that
 * point (document.elementsFromPoint, top first). Many listings lay a transparent
 * full-card link over the card, so the top element is rarely the price or the
 * title: for a link field take the first link, for an image field the first image,
 * otherwise the SMALLEST element carrying its own text (the price, not the card).
 */
export function chooseFromStack(stack, fieldKey) {
  const els = (stack || []).filter((e) => e && e.nodeType === 1 && !/^(HTML|BODY)$/i.test(e.tagName));
  const k = String(fieldKey || '').toLowerCase();
  if (k === 'url' || k === 'link' || k === 'lien') {
    const a = els.find((e) => e.tagName === 'A' && e.getAttribute('href')) || els.map((e) => e.closest && e.closest('a[href]')).find(Boolean);
    if (a) return a;
  }
  if (k === 'image' || k === 'thumbnail') { const img = els.find((e) => e.tagName === 'IMG'); if (img) return img; }
  const withText = els.filter((e) => ownText(e));
  const smallest = withText.length ? withText.reduce((best, e) => (areaOf(e) < areaOf(best) ? e : best)) : (els[0] || null);
  return smallest && PRICE_ROLE.test(k) ? wholeAmountElement(smallest) : smallest;
}

/**
 * Full pick: card + relative selector + attribute + a sample value.
 * @param {Element} clicked
 * @param {{doc:Document, card?:string|null, fieldKey?:string}} o  `card` = a known card selector (kept when it contains the element)
 * @returns {{ok:true, card:string, selector:string, attr:string|null, sample:string, cards:number}|{ok:false, reason:string}}
 */
/**
 * The group of same-kind entries an element belongs to (the sizes of a size picker,
 * the swatches of a colour list): from the element up to 3 levels, the first node
 * that has at least one sibling with the same tag and the same stable classes.
 * @returns {{item:Element, container:Element, itemSel:string, items:Element[]}|null}
 */
export function sameKindGroup(el, maxUp = 3) {
  let n = el;
  for (let i = 0; i <= maxUp && n && n.parentElement; i++, n = n.parentElement) {
    const p = n.parentElement;
    if (/^(body|html)$/i.test(p.tagName)) break;
    const sig = nodeSelector(n);
    const items = [...p.children].filter((c) => c.tagName === n.tagName && nodeSelector(c) === sig);
    if (items.length < 2) continue;
    // Entries of a picker are small (a size, a swatch): repeated product cards or
    // sections are not a list of values — no group then.
    const small = (it) => it.querySelectorAll('*').length <= 4 && visibleText(it).length <= 40;
    return items.every(small) ? { item: n, container: p, itemSel: sig, items } : null;
  }
  return null;
}

// An entry of a picker the shopper clicks to choose (a size button, a colour swatch, a radio, a listbox option).
const CHOICE_ROLE = /^(radio|option|menuitemradio|tab|switch)$/i;
const CHOICE_WORD = /(swatch|size|taille|pointure|variant|variation|option|colou?r|couleur|coloris|maat|kleur|talla|chip|pill)/i;
function looksLikeChoice(el) {
  for (let n = el, i = 0; n && n.nodeType === 1 && i < 3; n = n.parentElement, i++) {
    if (CHOICE_ROLE.test(n.getAttribute('role') || '') || /^(BUTTON|OPTION|LABEL)$/.test(n.tagName) || (n.tagName === 'INPUT' && /radio|checkbox/i.test(n.type || ''))) return true;
    if (n.hasAttribute('aria-pressed') || n.hasAttribute('aria-checked') || n.hasAttribute('aria-selected')) return true;
    if (CHOICE_WORD.test(String(n.className && n.className.baseVal != null ? n.className.baseVal : n.className || '')) || CHOICE_WORD.test(Object.keys(n.dataset || {}).join(' '))) return true;
  }
  return false;
}
/**
 * The name of an option axis, as the page writes it next to its picker: the group's aria-label (or aria-labelledby),
 * its fieldset legend, else the short heading or label just before it (« Taille : », « Couleur », « Choose a size »).
 */
export function groupAxisName(container, doc) {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/[:*]+\s*$/, '').replace(/^(choisir|choisissez|sélectionner|sélectionnez|select|choose|kies|elige)\s+(une?|la|le|a|an|your|uw|su|el|la)?\s*/i, '').trim();
  const ok = (s) => { const c = clean(s); return c && c.length <= 30 && !/\d{2,}/.test(c) ? c : ''; };
  for (let n = container, i = 0; n && n.nodeType === 1 && i < 3; n = n.parentElement, i++) {
    const al = ok(n.getAttribute('aria-label')); if (al) return al;
    const by = n.getAttribute('aria-labelledby');
    if (by && doc) { const t = by.split(/\s+/).map((id) => { const e = doc.getElementById(id); return e ? visibleText(e) : ''; }).join(' '); const c = ok(t); if (c) return c; }
    if (n.tagName === 'FIELDSET') { const lg = n.querySelector('legend'); const c = lg ? ok(visibleText(lg)) : ''; if (c) return c; }
    // The element just before (a label, a heading, a line of text), skipping the selected-value line it may hold.
    let prev = n.previousElementSibling;
    for (let k = 0; prev && k < 2; prev = prev.previousElementSibling, k++) {
      const txt = visibleText(prev); const first = txt.split(/[:\n]/)[0];
      const c = ok(first); if (c) return c;
    }
  }
  return '';
}

export function pickField(clicked, { doc, card = null, fieldKey = '', offset = null, list = false, page = false } = {}) {
  if (!clicked || clicked.nodeType !== 1) return { ok: false, reason: 'élément invalide' };
  const t = fieldTarget(clicked, fieldKey);
  // A list field (sizes, lengths, colours): the whole group of entries around the click. A picker the shopper
  // clicks to choose (buttons, swatches, radios) is a list too, whatever the field's name: an option axis.
  const chooser = !list && looksLikeChoice(clicked);
  const group = list || chooser ? sameKindGroup(t.el) : null;
  // No group around the click ("Taille de la chambre: 18 m²"): the element alone, as any field.
  const anchor = group ? group.container : t.el;
  const body = doc.body || doc.documentElement;
  let cardSel = null; let cardEl = null;
  if (page || card === 'body') { cardSel = 'body'; cardEl = body; } // a product page: the page is the card
  else {
    if (card) { try { cardEl = anchor.closest(card); } catch { cardEl = null; } if (cardEl) cardSel = card; }
    if (!cardEl) {
      cardSel = deriveCardSelector(anchor, doc);
      if (!cardSel) return { ok: false, reason: 'cet élément ne fait pas partie d’une liste répétée (fiche produit)' };
      try { cardEl = anchor.closest(cardSel); } catch { cardEl = null; }
      if (!cardEl) return { ok: false, reason: 'fiche introuvable autour de cet élément' };
    }
  }
  if (group) {
    const selector = relativeSelector(cardEl, group.container);
    if (!selector) return { ok: false, reason: 'sélecteur introuvable' };
    const values = listValues(group.items);
    const axis = groupAxisName(group.container, doc);
    return { ok: true, card: cardSel, selector, attr: null, all: group.itemSel, values: values.length, sample: values.join(' | ').slice(0, 120), cards: countIn(doc, cardSel), ...(axis ? { axis } : {}), ...(chooser ? { chooser: true } : {}) };
  }
  const selector = relativeSelector(cardEl, t.el);
  if (!selector) return { ok: false, reason: 'sélecteur introuvable' };
  const sample = t.attr ? (t.el.getAttribute(t.attr) || '') : visibleText(t.el);
  // A free column clicked on one piece of a line ("Charleroi" in "Chambre · Charleroi"):
  // only that piece, on every card. `offset` = the click position in the element's text.
  const part = (!t.attr && t.el === clicked && offset != null && offset >= 0 && !WHOLE_ROLES.test(String(fieldKey || ''))) ? textPart(rawText(t.el), offset) : null;
  return {
    ok: true, card: cardSel, selector, attr: t.attr, sample: (part ? part.value : sample).slice(0, 120), cards: countIn(doc, cardSel),
    ...(part ? { part: { sep: part.sep, index: part.index }, whole: sample.slice(0, 120) } : {}),
  };
}
