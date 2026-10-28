/**
 * The controls that load more of a list — « page suivante », « charger plus » — pointed at once by the
 * user and found again on the next pages and the next runs. Several cues are kept, never a single
 * selector: a stable selector (the control itself, or a stable ancestor + the path below it), its text,
 * its label, its tag and role, the pagination block it sits in and its place there, and the page
 * parameter its link changes. A site that regenerates one of them still matches on the others.
 * Portable (browser + linkedom), no site rule.
 */
import { stableClasses, isUnstableClass } from './pick-selector.mjs';

export const CONTROL_KINDS = Object.freeze(['next', 'load_more']);
const CLICKABLE = 'a, button, [role="button"], [role="link"], input[type="submit"], input[type="button"], summary';
// An element that only LOOKS clickable (a styled div with a handler): accepted a few levels up when no real control is there.
const CLICKABLE_LOOK = '[onclick], [tabindex], [data-action], [class*="btn" i], [class*="button" i]';
const BLOCK = 'nav, [role="navigation"], [class*="pagin" i], [id*="pagin" i], [class*="pager" i], [aria-label*="pagin" i], [class*="load-more" i], [class*="loadmore" i], [class*="show-more" i], [class*="view-more" i]';
const CSS_SAFE = /^[A-Za-z][\w-]*$/;

/** Visible text, spaces collapsed; counts made generic so « Voir plus (48) » matches « Voir plus (24) ». */
export const normText = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 80);
const genericText = (s) => normText(s).toLowerCase().replace(/\d[\d\s.,]*/g, '#');
const textOf = (el) => normText(el && (el.textContent || (el.getAttribute && el.getAttribute('value'))));
const labelOf = (el) => normText(el && el.getAttribute ? (el.getAttribute('aria-label') || el.getAttribute('title') || '') : '');

/** A control that cannot be used now (the last page's « suivant », a spent « charger plus »). */
export function isDisabled(el) {
  if (!el || !el.getAttribute) return false;
  return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true'
    || /(^|[-_ ])(disabled|inactive|is-disabled)([-_ ]|$)/i.test(el.getAttribute('class') || '')
    || !!(el.closest && el.closest('[aria-disabled="true"], .disabled, [disabled]'));
}

/** The element the click really lands on: the link or button around what was pointed at. */
export function clickableOf(el) {
  if (!el || el.nodeType !== 1) return null;
  const real = el.closest && el.closest(CLICKABLE);
  if (real) return real;
  let cur = el;
  for (let i = 0; cur && i < 4; i++, cur = cur.parentElement) { if (cur.matches && cur.matches(CLICKABLE_LOOK)) return cur; }
  return el;
}

const uniqueAs = (doc, sel, el) => { try { const l = doc.querySelectorAll(sel); return l.length === 1 && l[0] === el; } catch { return false; } };
const firstIs = (doc, sel, el) => { try { const l = doc.querySelectorAll(sel); return l.length >= 1 && l[0] === el; } catch { return false; } };

/** A selector for this element ALONE, from its own stable marks (id, data / aria attributes, stable classes), else null. */
function ownSelector(el, doc, test = firstIs) {
  const tag = String(el.tagName).toLowerCase();
  const id = el.getAttribute('id');
  if (id && !isUnstableClass(id) && CSS_SAFE.test(id) && test(doc, `#${id}`, el)) return `#${id}`;
  for (const a of ['data-testid', 'data-test', 'data-qa', 'data-auto-id', 'aria-label', 'rel', 'title', 'name']) {
    const v = el.getAttribute(a);
    if (v && v.length <= 60 && !/["\\]/.test(v)) { const s = `${tag}[${a}="${v}"]`; if (test(doc, s, el)) return s; }
  }
  const cls = stableClasses(el, 3);
  if (cls.length) { const s = `${tag}.${cls.join('.')}`; if (test(doc, s, el)) return s; }
  return null;
}

/** The tag path from `anc` down to `el` (direct children, a position only where a sibling shares the tag). */
function pathBelow(anc, el) {
  const parts = [];
  for (let cur = el; cur && cur !== anc; cur = cur.parentElement) {
    const tag = String(cur.tagName).toLowerCase();
    const same = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName) : [cur];
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag);
  }
  return parts.join(' > ');
}

/**
 * A STABLE selector for a control, to keep for the site: its own marks, else a stable ancestor (up to
 * three levels: PrestaShop's `<li id="pagination_next_bottom"><a href>`) + the path below it. Null when
 * nothing stable is there (the other cues still find it).
 */
export function controlSelector(el, doc) {
  if (!el || el.nodeType !== 1) return null;
  const own = ownSelector(el, doc);
  if (own) return own;
  let anc = el.parentElement;
  for (let i = 0; anc && i < 3; i++, anc = anc.parentElement) {
    if (/^(html|body)$/i.test(anc.tagName)) break;
    const a = ownSelector(anc, doc, uniqueAs);
    if (a) { const s = `${a} > ${pathBelow(anc, el)}`; if (firstIs(doc, s, el)) return s; }
  }
  return null;
}

/** A selector for this element on THIS page (to click it now): stable when possible, else its full path. */
export function pathSelector(el, doc) {
  const stable = controlSelector(el, doc);
  if (stable) return stable;
  let anc = el.parentElement;
  while (anc && !/^html$/i.test(anc.tagName)) {
    const id = anc.getAttribute && anc.getAttribute('id');
    if (id && CSS_SAFE.test(id) && uniqueAs(doc, `#${id}`, anc)) return `#${id} > ${pathBelow(anc, el)}`;
    anc = anc.parentElement;
  }
  const root = doc.documentElement;
  return `${String(root.tagName).toLowerCase()} > ${pathBelow(root, el)}`;
}

/**
 * The block the control sits in: a pagination / « load more » area holding other controls too (not the
 * control's own wrapper, e.g. `<li id="pagination_next">`), else the nearest small group of controls.
 */
export function blockOf(el) {
  let cur = el && el.parentElement;
  for (let i = 0; cur && i < 6; i++, cur = cur.parentElement) {
    if (/^(html|body)$/i.test(cur.tagName)) break;
    if (cur.matches && cur.matches(BLOCK) && cur.querySelectorAll(CLICKABLE).length >= 2) return cur;
  }
  cur = el && el.parentElement;
  for (let i = 0; cur && i < 4; i++, cur = cur.parentElement) {
    if (/^(html|body|main)$/i.test(cur.tagName)) break;
    const n = cur.querySelectorAll(CLICKABLE).length;
    if (n >= 2 && n <= 30) return cur;
  }
  return null;
}

/** The page parameter the control's link changes (?p=2, ?page=3, ?start=48), when it has one. */
function hrefParam(el, pageUrl) {
  const h = el.getAttribute && el.getAttribute('href');
  if (!h || !pageUrl) return null;
  let to; let from; try { to = new URL(h, pageUrl); from = new URL(pageUrl); } catch { return null; }
  for (const [k, v] of to.searchParams) {
    if (!/^\d{1,6}$/.test(v) || from.searchParams.get(k) === v) continue;
    return { name: k.slice(0, 40), kind: /^(start|offset|from|skip|startindex)$/i.test(k) ? 'offset' : 'page' };
  }
  return null;
}

/**
 * The cues kept for a control the user pointed at.
 * @returns {{v:1, kind:string, selector:string|null, text:string, label:string, tag:string, role:string|null,
 *   block:string|null, fromEnd:number|null, param:{name:string, kind:string}|null}}
 */
export function controlCues(el, doc, { kind = 'next', pageUrl = null } = {}) {
  const ctl = clickableOf(el);
  if (!ctl) return null;
  const block = blockOf(ctl);
  let fromEnd = null;
  if (block) { const all = [...block.querySelectorAll(CLICKABLE)]; const i = all.indexOf(ctl); if (i >= 0) fromEnd = all.length - 1 - i; }
  return {
    v: 1, kind: CONTROL_KINDS.includes(kind) ? kind : 'next',
    selector: controlSelector(ctl, doc),
    text: textOf(ctl).slice(0, 60), label: labelOf(ctl).slice(0, 80),
    tag: String(ctl.tagName).toLowerCase(), role: ctl.getAttribute('role') || null,
    block: block ? (ownSelector(block, doc, uniqueAs) || controlSelector(block, doc)) : null,
    fromEnd, param: hrefParam(ctl, pageUrl),
  };
}

/** Does a cues object carry enough to find a control again? */
export const usableCues = (c) => !!(c && typeof c === 'object' && (c.selector || c.text || c.label));

/**
 * Find the control again on this page from its cues: the selector, else the same text / label inside the
 * same block, else the same text / label anywhere (one candidate, or the one in a pagination block).
 * A match that is disabled says « last page » / « nothing more to load ».
 * @param {Document} doc @param {object|string} cues  a cues object, or a selector kept by an older version
 * @param {{visible?:(el:Element)=>boolean}} [o]
 * @returns {{el:Element, how:string, disabled:boolean}|null}
 */
export function findControl(doc, cues, { visible = () => true } = {}) {
  const c = typeof cues === 'string' ? { selector: cues } : cues;
  if (!c || typeof c !== 'object') return null;
  const hit = (el, how) => ({ el, how, disabled: isDisabled(el) });
  if (c.selector) { let el = null; try { el = doc.querySelector(c.selector); } catch { el = null; } if (el && (visible(el) || isDisabled(el))) return hit(el, 'selector'); }
  const want = c.text ? genericText(c.text) : '';
  const wantLabel = c.label ? genericText(c.label) : '';
  if (!want && !wantLabel) return null;
  const same = (el) => (want && genericText(textOf(el)) === want) || (wantLabel && genericText(labelOf(el)) === wantLabel);
  let block = null; if (c.block) { try { block = doc.querySelector(c.block); } catch { block = null; } }
  const scopes = block ? [block, doc] : [doc];
  for (const scope of scopes) {
    const matches = [...scope.querySelectorAll(CLICKABLE)].filter(same);
    const usable = matches.filter((el) => visible(el) || isDisabled(el));
    if (usable.length) {
      // Several « Suivant » (top and bottom pagination): the same place from the end of the block, else the first.
      const pick = usable.length > 1 && c.fromEnd != null ? (usable.find((el) => { const b = blockOf(el); if (!b) return false; const all = [...b.querySelectorAll(CLICKABLE)]; return all.length - 1 - all.indexOf(el) === c.fromEnd; }) || usable[0]) : usable[0];
      return hit(pick, scope === block ? 'block-text' : 'text');
    }
    // The control lost its link (PrestaShop's last page: « Suivant » is a <span> inside a disabled <li>).
    if (scope === block && want) {
      const ghost = [...block.querySelectorAll('span, li, div, b, strong')].find((el) => genericText(textOf(el)) === want && isDisabled(el));
      if (ghost) return { el: ghost, how: 'block-text', disabled: true };
    }
  }
  return null;
}
