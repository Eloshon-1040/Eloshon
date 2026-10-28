/**
 * Click-to-learn (link_filter producer) — turns ONE user click captured by the
 * UI into a validated `link_filter` recipe: URL templates that recognise the
 * site's product links, plus an optional card/container scope, pagination and
 * consent rules captured in the same gesture. The UI only records the capture;
 * everything here is derivation + validation.
 *
 * The recipe is plain JSON (regexes are SOURCE STRINGS, never RegExp objects —
 * it is stored in a Supabase jsonb column and must survive JSON round-trips).
 * Consumers rebuild them with `new RegExp(template)` and test the URL PATHNAME
 * only (templates are anchored, path-only).
 *
 * Same contract as deriveSelectorRecipe: a validated recipe or null, NEVER a
 * wrong recipe (on null the caller keeps its normal ladder).
 *
 * Pure + offline: capture in, recipe out (linkedom, no network, no browser).
 */
import { parseHTML } from 'linkedom';
import { absoluteUrl, sameSite } from './url-utils.mjs';

// Same price token as recipe-producer — a card is link + (image OR price).
const PRICE_RE = /\d+[.,]\d{2}\s*€|€\s*\d|\d+[.,]\d{2}\s*(?:eur|chf|£|\$)/i;
// State/behaviour class prefixes — same filter as recipe-producer's leafSelector.
const MODIFIER_RE = /^(is-|has-|js-)/;
// Anchors under these never lead to products — free negative examples.
const NEGATIVE_ZONES = 'nav,header,footer';
// data-* names that are meant as stable hooks (test ids, component names) —
// preferred over classes because they survive CSS refactors.
const STABLE_DATA_RE = /^data-(testid|test|test-id|qa|cy|component|widget|selector)$/;
// A data value carrying a per-product id / uuid never repeats across cards.
const VOLATILE_VALUE_RE = /\d{4,}|^[0-9a-f]{8}-[0-9a-f]{4}/i;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// linkedom has no global CSS.escape — minimal one (class/id tokens only).
const cssEscape = (s) => String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
const pathnameOf = (absUrl) => { try { return new URL(absUrl).pathname; } catch { return null; } };

/**
 * One path segment → regex fragment. Slug-first, then ids: a hyphenated word
 * body becomes one slug class, a trailing digit run keeps an explicit \d+ so
 * `p10012345` / `promo-123` stay discriminating while `fr-BE` generalises to
 * any locale. Static words (pure letters) stay literal — they carry most of the
 * template's precision.
 */
function segmentPattern(seg) {
  if (/^\d+$/.test(seg)) return '\\d+';
  const em = seg.match(/^(.*?)(\.[a-zA-Z0-9]{2,5})$/);   // keep a file extension literal
  const body = em ? em[1] : seg;
  const ext = em ? escapeRe(em[2]) : '';
  if (/^[a-zA-Z]+$/.test(body)) return escapeRe(body) + ext;
  if (!/^[a-zA-Z0-9-]+$/.test(body)) return '[^/]+' + ext;
  if (/\d{2,}$/.test(body)) return '[a-zA-Z0-9-]*\\d+' + ext;
  return '[a-zA-Z0-9-]+' + ext;
}

/** Anchored, path-only template (regex SOURCE) for one product pathname. */
function templateFor(pathname) {
  const segs = String(pathname || '').split('/').filter(Boolean);
  if (!segs.length) return null;                          // "/" identifies nothing
  return '^/' + segs.map(segmentPattern).join('/') + '/?$';
}

function matchesTemplates(templates, pathname) {
  if (!pathname) return false;
  return (templates || []).some((t) => { try { return new RegExp(t).test(pathname); } catch { return false; } });
}

/** The clicked <a> inside the snapshot, by resolved href (anchorPath disambiguates twins). */
function findClickedAnchor(document, exampleHref, pageUrl, anchorPath) {
  const wanted = exampleHref.split('#')[0];
  const found = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const abs = absoluteUrl(a.getAttribute('href'), pageUrl);
    if (abs && abs.split('#')[0] === wanted) found.push(a);
  }
  if (found.length <= 1) return found[0] || null;
  const captured = (anchorPath && anchorPath[0] && anchorPath[0].classes) || [];
  return found.find((a) => captured.some((c) => a.classList.contains(c))) || found[0];
}

/**
 * The card: smallest NON-ANCHOR ancestor holding the anchor + (img OR price) —
 * same spirit as the in-page card climb of browser.mjs, bounded.
 */
function cardFor(anchor) {
  for (let el = anchor.parentElement, up = 0; el && el.tagName !== 'BODY' && el.tagName !== 'HTML' && up < 8; el = el.parentElement, up++) {
    if (el.tagName === 'A') continue;
    if (el.querySelector('img') || PRICE_RE.test(el.textContent || '')) return el;
  }
  return null;
}

/**
 * Stabilised signature selector for an element: stable data-* attribute first,
 * else tag + first non-modifier class; a lone BEM modifier is truncated to its
 * block (`card--sale` → `[class*="card--"]`). Simple tag/class/attribute
 * selectors only (linkedom has no :has). Null when nothing distinguishes it.
 */
function signatureSelector(el) {
  const tag = el.tagName.toLowerCase();
  const names = typeof el.getAttributeNames === 'function' ? el.getAttributeNames() : [];
  for (const n of names) {
    if (!STABLE_DATA_RE.test(n)) continue;
    const v = el.getAttribute(n) || '';
    if (!v || v.length > 60 || VOLATILE_VALUE_RE.test(v)) continue;
    return `${tag}[${n}="${v.replace(/(["\\])/g, '\\$1')}"]`;
  }
  const classes = [...el.classList].filter((c) => c && !MODIFIER_RE.test(c));
  const base = classes.find((c) => !c.includes('--'));
  if (base) return `${tag}.${cssEscape(base)}`;
  if (classes.length) return `${tag}[class*="${classes[0].split('--')[0]}--"]`;
  return null;
}

/** Smallest ancestor holding ≥3 same-signature cards (the clicked one + ≥2 brothers). */
function containerFor(cardEl, cardSel) {
  for (let el = cardEl.parentElement; el && el.tagName !== 'HTML'; el = el.parentElement) {
    let n = 0;
    try { n = el.querySelectorAll(cardSel).length; } catch { return null; }
    if (n >= 3) return el;
  }
  return null;
}

/** Selector for a captured anchorPath entry (id → class → null; no bare tags). */
function capturedSelector(anchorPath) {
  const e = anchorPath && anchorPath[0];
  if (!e || !e.tag) return null;
  if (e.id) return '#' + cssEscape(e.id);
  const classes = (e.classes || []).filter((c) => c && !MODIFIER_RE.test(c));
  const base = classes.find((c) => !c.includes('--'));
  if (base) return `${String(e.tag).toLowerCase()}.${cssEscape(base)}`;
  if (classes.length) return `${String(e.tag).toLowerCase()}[class*="${classes[0].split('--')[0]}--"]`;
  return null;
}

/** Same vocabulary as recipe-producer's derivePagination (url-param → next-link → load-more). */
function paginationFromClick(pg) {
  if (!pg) return null;
  if (pg.href) {
    const m = String(pg.href).match(/[?&](p|page|pageNumber|start|offset)=(\d+)/i);
    if (m) return { mode: 'url-param', param: m[1], start: 1, max_pages: null };
    return { mode: 'next-link', selector: capturedSelector(pg.anchorPath) || 'a[rel="next"]', max_pages: null };
  }
  const sel = capturedSelector(pg.anchorPath);              // a button — no href
  return sel ? { mode: 'load-more', selector: sel, max_pages: null } : null;
}

function consentFromClick(c) {
  if (!c) return null;
  const sel = capturedSelector(c.anchorPath);
  return sel ? { selector: sel, action: 'click' } : null;
}

/** What the recipe would SELECT on this snapshot: [{href, el}] (el = negative-zone probe). */
function selectLinks(document, recipe, pageUrl) {
  const out = [];
  if (recipe.card) {
    let cards;
    try { cards = [...document.querySelectorAll(recipe.container ? `${recipe.container} ${recipe.card}` : recipe.card)]; } catch { return null; }
    for (const cardEl of cards) {
      const anchors = [...cardEl.querySelectorAll(`${recipe.link.selector}[href]`)]
        .filter((a) => { const h = a.getAttribute('href') || ''; return h && h !== '#' && !/^javascript:/i.test(h); });
      if (!anchors.length) continue;
      const pick = anchors.find((a) => matchesTemplates(recipe.url_templates, pathnameOf(absoluteUrl(a.getAttribute(recipe.link.attr), pageUrl)))) || anchors[0];
      const abs = absoluteUrl(pick.getAttribute(recipe.link.attr), pageUrl);
      if (abs) out.push({ href: abs.split('#')[0], el: cardEl });
    }
    return out;
  }
  // url-only: every same-site anchor whose pathname matches a template.
  for (const a of document.querySelectorAll('a[href]')) {
    const abs = absoluteUrl(a.getAttribute('href'), pageUrl);
    if (!abs || !sameSite(abs, pageUrl)) continue;
    if (!matchesTemplates(recipe.url_templates, pathnameOf(abs))) continue;
    out.push({ href: abs.split('#')[0], el: a });
  }
  return out;
}

/**
 * Validation on the snapshot — all four gates, else the recipe is not emitted:
 * ≥3 distinct links, the clicked example included, ≥80% matching the templates,
 * and ZERO selections under nav/header/footer (free negatives).
 */
function validateRecipe(document, recipe, exampleHref, pageUrl) {
  const sel = selectLinks(document, recipe, pageUrl);
  if (!sel) return false;
  const hrefs = new Set(sel.map((s) => s.href));
  if (hrefs.size < 3) return false;
  if (!hrefs.has(exampleHref.split('#')[0])) return false;
  let matched = 0;
  for (const h of hrefs) if (matchesTemplates(recipe.url_templates, pathnameOf(h))) matched += 1;
  if (matched / hrefs.size < 0.8) return false;
  for (const s of sel) if (s.el.closest && s.el.closest(NEGATIVE_ZONES)) return false;
  return true;
}

/**
 * Derive a validated `link_filter` recipe from one captured product-link click.
 * @param {{ role?:'product-link'|'pagination'|'consent', pageUrl:string, href:string,
 *           anchorPath?:Array<{tag:string,id?:string,classes?:string[]}>, domSnapshot:string,
 *           pagination?:{href?:string,anchorPath?:Array}, consent?:{anchorPath?:Array} }} capture
 *   `pagination`/`consent` are optional secondary clicks recorded in the same
 *   gesture (a « suivant »/« charger plus » link or button, a consent button).
 * @returns {object|null} `{container, card, link, url_templates, pagination?,
 *   consent?, origin:'manual', sample_url, learned_at}` — or null (never a
 *   wrong recipe). `container`/`card` are null on the degraded url-only form
 *   (no ≥3 same-signature brothers around the clicked card).
 */
export function deriveLinkFilter(capture) {
  if (!capture || !capture.href || !capture.pageUrl || !capture.domSnapshot) return null;
  if (capture.role && capture.role !== 'product-link') return null; // the recipe grows from a product click only
  const exampleHref = absoluteUrl(capture.href, capture.pageUrl);
  if (!exampleHref) return null;
  const template = templateFor(pathnameOf(exampleHref));
  if (!template) return null;
  let document;
  try { ({ document } = parseHTML(capture.domSnapshot)); } catch { return null; }
  const anchor = findClickedAnchor(document, exampleHref, capture.pageUrl, capture.anchorPath);
  if (!anchor) return null;                                 // snapshot doesn't carry the click → nothing to validate

  const cardEl = cardFor(anchor);
  const cardSel = cardEl ? signatureSelector(cardEl) : null;
  const containerEl = cardSel ? containerFor(cardEl, cardSel) : null;
  let card = null, container = null;
  if (cardSel && containerEl) {
    card = cardSel;
    // an unnameable container (bare <main>/<body>) → document-wide scope; the
    // negative-zone gate below still guards it.
    container = containerEl.id ? '#' + cssEscape(containerEl.id) : signatureSelector(containerEl);
  }
  // no ≥3 same-signature brothers (banner click) → degraded url-only recipe.

  const recipe = { container, card, link: { selector: 'a', attr: 'href' }, url_templates: [template] };
  const pagination = paginationFromClick(capture.pagination);
  if (pagination) recipe.pagination = pagination;
  const consent = consentFromClick(capture.consent);
  if (consent) recipe.consent = consent;
  recipe.origin = 'manual';
  recipe.sample_url = exampleHref;
  recipe.learned_at = new Date().toISOString();

  return validateRecipe(document, recipe, exampleHref, capture.pageUrl) ? recipe : null;
}

/**
 * One click = BOTH recipes, silently, best-effort: the link_filter above plus a
 * `manual_selectors` attempt via the injected deriveSelectorRecipe (from
 * recipe-producer) replayed over the same snapshot. Each side is nullable and
 * one failing never blocks the other.
 * @returns {{ linkFilter: object|null, manualSelectors: object|null }}
 */
export function learnFromClick(capture, { deriveSelectorRecipe } = {}) {
  let linkFilter = null;
  try { linkFilter = deriveLinkFilter(capture); } catch { linkFilter = null; }
  let manualSelectors = null;
  if (capture && capture.domSnapshot && typeof deriveSelectorRecipe === 'function') {
    try { manualSelectors = deriveSelectorRecipe(capture.domSnapshot, capture.pageUrl, 'manual') || null; } catch { manualSelectors = null; }
  }
  return { linkFilter, manualSelectors };
}

/**
 * How many DISTINCT product links a derived `link_filter` recipe recognises on
 * the captured snapshot — the honest "N products recognised on the page" signal
 * for the teach-flow success confirmation. Pure + offline; reuses the exact same
 * selection logic the validation gate ran, so the count matches what a run would
 * actually harvest from this page. Zero on a null recipe or an unparseable
 * snapshot (never throws — feedback is best-effort, it must not break the flow).
 * @param {{ pageUrl?:string, domSnapshot?:string }} capture
 * @param {object|null} recipe  a `link_filter` recipe (container/card/link/url_templates)
 * @returns {number}
 */
export function recognizedCount(capture, recipe) {
  if (!capture || !capture.domSnapshot || !recipe) return 0;
  let document;
  try { ({ document } = parseHTML(capture.domSnapshot)); } catch { return 0; }
  const sel = selectLinks(document, recipe, capture.pageUrl);
  if (!sel) return 0;
  return new Set(sel.map((s) => s.href)).size;
}
