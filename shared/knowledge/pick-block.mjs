/**
 * Designating a BLOCK on a product page (description, technical specifications…):
 * what the pointer should grow to, what to tell the user about it, and which other pages
 * of the site look like this one (to check the rule on them). Portable (browser + linkedom).
 */
import { visibleText } from '../extract/card-recipe.mjs';
import { readBlockText, readSpecPairs, MAX_DESCRIPTION, variantEntries, readVariants, readImages } from './readers.mjs';
import { PAIR_FIELDS, LIST_FIELDS, IMAGE_FIELDS, PRICE_FIELDS } from './rules.mjs';
import { designatedPrice } from '../extract/money.mjs';

const BODYISH = /^(body|html|main)$/i;
const TEXT_TAGS = new Set(['p', 'ul', 'ol', 'li', 'br', 'strong', 'b', 'em', 'i', 'u', 'span', 'a', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'div', 'section', 'article', 'small', 'sup', 'sub', 'mark', 'hr', 'font', 'img', 'picture', 'source', 'details', 'summary']);

/** Share of a block's text that sits in links (a menu or a related-products strip is mostly links). */
export function linkDensity(el) {
  const total = visibleText(el).length; if (!total) return 1;
  let inLinks = 0; try { for (const a of el.querySelectorAll('a')) inLinks += visibleText(a).length; } catch { /* none */ }
  return Math.min(1, inLinks / total);
}

/** Only text-ish markup inside: no table, form, heading 1, button, widget. */
function isTextBlock(el) {
  let imgs = 0;
  try {
    for (const n of el.querySelectorAll('*')) {
      const t = String(n.tagName).toLowerCase();
      if (!TEXT_TAGS.has(t)) return false;
      if (t === 'img' && ++imgs > 3) return false;
    }
  } catch { return false; }
  return true;
}

/**
 * The block the pointer should select for a field, starting from the element under it.
 * Specs: the smallest ancestor that reads as ≥ 2 label/value pairs (the table, the list).
 * Description: the widest text-only ancestor (all the paragraphs of the description, not one).
 * Anything else: the element itself.
 */
export function growBlock(el, field) {
  if (!el || el.nodeType !== 1) return el;
  if (PAIR_FIELDS.has(field)) {
    let n = el;
    for (let i = 0; i < 7 && n && !BODYISH.test(n.tagName); i++, n = n.parentElement) {
      const count = readSpecPairs(n).length;
      if (count < 2) continue;
      // Up to the wrapper that holds the same pairs and little else (the panel around the table,
      // not the whole page): that is the block with its own label, and it survives a table → list redesign.
      let best = n;
      for (let p = n.parentElement, k = 0; p && k < 3 && !BODYISH.test(p.tagName); k++, p = p.parentElement) {
        if (readSpecPairs(p).length !== count) break;
        if (visibleText(p).length > visibleText(best).length * 1.25 + 40) break;
        best = p;
      }
      return best;
    }
    return el;
  }
  if (IMAGE_FIELDS.has(field)) {
    // The picture under the pointer (an overlay or a link over it is not the picture); the wheel widens to the gallery.
    if (/^img$/i.test(el.tagName)) return el;
    const img = el.querySelector && el.querySelector('img'); if (img && readImages(el).length === 1) return img;
    return el;
  }
  if (LIST_FIELDS.has(field)) {
    // The smallest block around the click that holds ≥ 2 options of the same kind (the size buttons, the swatches).
    let n = el;
    for (let i = 0; i < 6 && n && !BODYISH.test(n.tagName); i++, n = n.parentElement) { if (variantEntries(n).length >= 2) return n; }
    return el;
  }
  if (PRICE_FIELDS.has(field)) {
    // The click often lands on a fragment (the cents in a superscript, the currency sign): up to the small
    // element that holds the whole amount, never further than a short price line.
    let best = el;
    for (let n = el.parentElement, i = 0; i < 3 && n && !BODYISH.test(n.tagName); i++, n = n.parentElement) {
      const t = visibleText(n);
      if (t.length > 40 || (t.match(/\d+(?:[.,]\d+)?/g) || []).length > 3) break;
      best = n;
    }
    // A click on a complete amount (decimals or a currency in it) keeps that element.
    const own = visibleText(el);
    return /\d/.test(own) && /[.,]\d|€|\$|£|\b[A-Z]{3}\b/.test(own) ? el : best;
  }
  if (field === 'description') {
    let best = el; let bestLen = readBlockText(el).length;
    for (let n = el.parentElement, i = 0; i < 5 && n && !BODYISH.test(n.tagName); i++, n = n.parentElement) {
      if (!isTextBlock(n) || linkDensity(n) > 0.3) break;
      const len = readBlockText(n).length;
      if (len > MAX_DESCRIPTION * 0.8) break;
      if (len >= bestLen) { best = n; bestLen = len; }
    }
    return best;
  }
  return el;
}

/**
 * Open the sections a product page keeps folded (accordions, <details>), so their content is in the page
 * read: many shops build a tab's text only when it is opened. Only toggles that open a panel of this page
 * (aria-controls / details) — never a link that leaves the page, never in a menu, header, footer, form or
 * dialog, never a panel that already holds text. SELF-CONTAINED (no import, no closure): the extension calls
 * it in the page, the app's browser injects its source as is. Returns how many sections were opened.
 * @param {Document} doc  @param {number} [max]
 */
export function expandFoldedSections(doc, max = 12) {
  let n = 0;
  const outside = 'nav, header, footer, form, [role="dialog"], [role="menu"], [role="menubar"], [role="listbox"]';
  for (const d of doc.querySelectorAll('details:not([open])')) { if (n >= max) break; if (d.closest(outside)) continue; d.setAttribute('open', ''); n++; }
  for (const b of doc.querySelectorAll('[aria-expanded="false"][aria-controls]')) {
    if (n >= max) break;
    const tag = String(b.tagName).toLowerCase();
    if (!/^(button|summary|h[1-6]|div|span|a|li)$/.test(tag)) continue;
    if (tag === 'a' && b.getAttribute('href') && !/^#/.test(b.getAttribute('href'))) continue;
    if (b.closest(outside)) continue;
    const target = doc.getElementById(b.getAttribute('aria-controls'));
    if (target && String(target.textContent || '').trim().length > 40) continue;
    try { b.click(); n++; } catch { /* not clickable */ }
  }
  return n;
}

/** What a selected block holds, for the live hint ("4 paragraphes · 812 caractères"). */
export function describeBlock(el, field) {
  if (!el) return '';
  if (PAIR_FIELDS.has(field)) { const n = readSpecPairs(el).length; return n ? `${n} caractéristique(s)` : 'aucune caractéristique lisible ici'; }
  if (IMAGE_FIELDS.has(field)) { const n = readImages(el).length; return n ? `${n} image(s)${n === 1 ? ' — molette vers le haut pour prendre toute la galerie' : ''}` : 'aucune image ici'; }
  if (LIST_FIELDS.has(field)) { const v = readVariants(el, { parsePrice: designatedPrice }); return v.length ? `${v.length} variante(s) : ${v.slice(0, 4).map((x) => x.name).join(', ')}${v.length > 4 ? '…' : ''}` : 'aucune variante lisible ici'; }
  if (PRICE_FIELDS.has(field)) { const m = designatedPrice(visibleText(el)); return m ? `montant lu : ${m.price}${m.currency ? ` ${m.currency}` : ' (devise prise sur la page)'}` : 'aucun montant lisible ici'; }
  const t = readBlockText(el); const lines = t ? t.split('\n').length : 0;
  return t ? `${lines} ligne(s) · ${t.length} caractères` : 'bloc vide';
}

const bare = (u) => { try { const x = new URL(u); x.hash = ''; x.search = ''; return x.toString().replace(/\/$/, ''); } catch { return null; } };
const norm = (s) => (/^\d+$/.test(s) ? '#' : (/\d/.test(s) && /[a-z]/i.test(s) ? '#-slug' : s.toLowerCase()));

/** Do two product-page URLs look like siblings: same depth, same directory, or the same id-slug shape? */
export function sameKind(a, b) {
  try {
    const A = new URL(a); const B = new URL(b);
    if (A.hostname.replace(/^www\./, '') !== B.hostname.replace(/^www\./, '')) return false;
    const sa = A.pathname.split('/').filter(Boolean); const sb = B.pathname.split('/').filter(Boolean);
    if (!sa.length || sa.length !== sb.length) return false;
    const shape = (s) => s.map(norm).join('/');
    if (shape(sa) === shape(sb)) return true;
    const dir = (s) => s.slice(0, -1).map(norm).join('/');
    return dir(sa) === dir(sb) && /[-_\d]/.test(sb[sb.length - 1]);
  } catch { return false; }
}

/**
 * Links of this page that look like other product pages of the site (carousels of similar
 * products, "you may also like"), most product-like first (with a picture next to them).
 * @param {Document} doc @param {string} pageUrl
 */
export function sameShapeLinks(doc, pageUrl, { max = 8 } = {}) {
  const here = bare(pageUrl); const seen = new Set([here]); const out = [];
  let anchors = []; try { anchors = [...doc.querySelectorAll('a[href]')]; } catch { anchors = []; }
  for (const a of anchors) {
    let abs; try { abs = new URL(a.getAttribute('href'), pageUrl).href; } catch { continue; }
    const k = bare(abs); if (!k || seen.has(k) || !sameKind(pageUrl, abs)) continue;
    seen.add(k);
    const pic = !!(a.querySelector('img') || (a.parentElement && a.parentElement.querySelector('img')));
    out.push({ url: abs, pic });
  }
  out.sort((x, y) => Number(y.pic) - Number(x.pic));
  return out.slice(0, max).map((x) => x.url);
}
