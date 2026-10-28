/**
 * Locating a block of a product page again, on ANOTHER page of the same site —
 * the part a bare CSS selector cannot do (generated classes, a re-ordered DOM, a
 * tab that moved). A rule keeps a FINGERPRINT of the element the user designated
 * (tag, stable classes and attributes, parents, the label of its tab / accordion /
 * heading, the shape of its content) and `resolveRule` tries, in order:
 *   1. the stored selector (best-scoring match, never a blind first match),
 *   2. its stable attributes (id, itemprop, data-testid…),
 *   3. its LABEL ("Caractéristiques techniques" → the block that label opens),
 *   4. a structural similarity search over the page.
 * Portable: only DOM APIs shared by browsers and linkedom (no :scope, no layout).
 */
import { isUnstableClass, isUtilityClass, relativeSelector } from '../extract/pick-selector.mjs';
import { visibleText, queryInCard } from '../extract/card-recipe.mjs';

const strip = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
/** A label as compared across pages: no case, accents, punctuation or extra spaces. */
export const normLabel = (s) => strip(s).replace(/[^a-z0-9]+/g, ' ').trim();

const STABLE_ATTRS = ['id', 'itemprop', 'role', 'data-testid', 'data-test', 'data-qa', 'data-cy', 'data-section', 'data-tab', 'data-component', 'aria-label'];
const HEADING_TAGS = /^(h[1-6]|summary|button|legend|dt|strong|b)$/i;
const HEADINGISH_CLASS = /(^|[-_ ])(title|heading|header|label|tab|accordion)([-_ ]|$)/i;
const SKIP = /^(script|style|noscript|template|svg)$/i;

const tagOf = (el) => String(el.tagName || '').toLowerCase();
// A taught block is named by what it IS: generated classes (build hashes, states) and utility classes (how it
// looks, shared by many blocks) are left out of its selector and fingerprint, and ignored in old fingerprints.
const blockClass = (c) => !!c && !isUnstableClass(c) && !isUtilityClass(c);
const stableClasses = (el, max = 2) => [...((el && el.classList) || [])].filter(blockClass).slice(0, max);
const cssEsc = (s) => String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
const nodeSelector = (el, max = 2) => tagOf(el) + stableClasses(el, max).map((c) => '.' + cssEsc(c)).join('');
const hasText = (el, min = 10) => visibleText(el).length >= min;

/** A short text element that names the block next to it (heading, tab, accordion trigger). */
function isHeadingLike(el) {
  if (!el || el.nodeType !== 1 || SKIP.test(el.tagName)) return false;
  const t = visibleText(el);
  if (t.length < 2 || t.length > 80) return false;
  if (HEADING_TAGS.test(el.tagName) || el.getAttribute('role') === 'heading' || el.getAttribute('role') === 'tab') return true;
  return HEADINGISH_CLASS.test(el.getAttribute('class') || '') && el.children.length <= 3;
}

/**
 * What names this block on the page: the summary of its <details>, the trigger that
 * controls it (aria-controls / aria-labelledby), the heading right before it (or
 * before one of its ancestors), or the heading it opens with.
 * @returns {{text:string, rel:string, up?:number, inner?:string}|null}
 */
export function findAnchor(el, doc) {
  if (!el || el.nodeType !== 1) return null;
  // The block itself, or the panel / accordion item it sits in (up to 3 levels): its summary,
  // the trigger that controls it, the element that labels it.
  let node = el;
  for (let up = 0; up <= 3 && node && node.nodeType === 1 && !/^(body|html)$/i.test(node.tagName); up++, node = node.parentElement) {
    const withInner = (a) => { const o = { ...a, up }; if (up > 0) { const inner = relativeSelector(node, el); if (inner) o.inner = inner; else return null; } return o; };
    if (tagOf(node) === 'details') {
      const s = [...node.children].find((c) => tagOf(c) === 'summary');
      if (s && visibleText(s)) { const o = withInner({ text: visibleText(s), rel: 'details' }); if (o) return o; }
    }
    const id = node.getAttribute('id');
    if (id && doc) {
      let trig = null; try { trig = [...doc.querySelectorAll('[aria-controls]')].find((t) => t.getAttribute('aria-controls') === id); } catch { trig = null; }
      if (trig && visibleText(trig)) { const o = withInner({ text: visibleText(trig), rel: 'controls' }); if (o) return o; }
    }
    const lb = node.getAttribute('aria-labelledby');
    if (lb && doc) {
      const l = doc.getElementById ? doc.getElementById(lb.split(/\s+/)[0]) : null;
      if (l && visibleText(l)) { const o = withInner({ text: visibleText(l), rel: 'labelledby' }); if (o) return o; }
    }
  }
  // The heading right before the block, or before one of its ancestors (the block sits
  // inside the panel that follows the heading).
  let anc = el;
  for (let up = 0; up <= 3 && anc && anc.parentElement; up++, anc = anc.parentElement) {
    let prev = anc.previousElementSibling;
    for (let k = 0; k < 2 && prev; k++, prev = prev.previousElementSibling) {
      if (isHeadingLike(prev)) {
        const out = { text: visibleText(prev), rel: 'after-heading', up };
        if (up > 0) { const inner = relativeSelector(anc, el); if (inner) out.inner = inner; }
        return out;
      }
      if (hasText(prev, 30)) break; // another content block in between: not this block's heading
    }
  }
  // The block that opens with its own heading ("<section><h2>Description</h2>…").
  const first = el.firstElementChild;
  if (first && isHeadingLike(first) && /^(h[1-6]|legend|summary)$/i.test(first.tagName) && hasText(el, visibleText(first).length + 20)) return { text: visibleText(first), rel: 'wraps-heading' };
  return null;
}

/** The text that names a block now (to compare with a stored anchor). */
export function anchorTextOf(el, doc) { const a = findAnchor(el, doc); return a ? a.text : null; }

/** A CSS selector for `el`, unique on its page when possible, else the positional fallback. */
export function pageSelector(el, doc) {
  const body = doc.body || doc.documentElement;
  const uniq = (sel) => { try { const l = doc.querySelectorAll(sel); return l.length === 1 && l[0] === el; } catch { return false; } };
  const tag = tagOf(el);
  const id = el.getAttribute('id');
  if (id && /^[A-Za-z][\w-]*$/.test(id) && !isUnstableClass(id)) { const s = `#${id}`; if (uniq(s)) return s; }
  for (const a of ['itemprop', 'data-testid', 'data-test', 'data-qa', 'data-cy']) {
    const v = el.getAttribute(a);
    if (v && /^[\w -]{1,50}$/.test(v)) { const s = `${tag}[${a}="${v}"]`; if (uniq(s)) return s; }
  }
  const leaf = nodeSelector(el, 3);
  if (stableClasses(el).length && uniq(leaf)) return leaf;
  let chain = leaf;
  let p = el.parentElement;
  for (let i = 0; p && p !== body && i < 4; p = p.parentElement, i++) {
    if (!stableClasses(p).length && !p.getAttribute('id')) continue;
    chain = `${nodeSelector(p, 2)} ${chain}`;
    if (uniq(chain)) return chain;
  }
  return relativeSelector(body, el);
}

const SIG_TAGS = ['p', 'li', 'tr', 'dt', 'table', 'ul', 'a', 'img', 'br', 'h2', 'h3', 'h4'];
function childSig(el) {
  const sig = {};
  for (const t of SIG_TAGS) { let n = 0; try { n = Math.min(el.querySelectorAll(t).length, 99); } catch { n = 0; } if (n) sig[t] = n; }
  return sig;
}

/**
 * Everything worth remembering of an element, to recognise its counterpart on another page.
 * @param {Element} el  @param {Document} doc
 */
export function fingerprintOf(el, doc) {
  const attrs = {};
  for (const a of STABLE_ATTRS) {
    const v = el.getAttribute(a);
    if (!v || v.length > 60) continue;
    if (a === 'id' && (isUnstableClass(v) || /\d{3,}/.test(v))) continue;
    attrs[a] = v;
  }
  const parents = [];
  for (let p = el.parentElement, i = 0; p && i < 3 && !/^(body|html)$/i.test(p.tagName); p = p.parentElement, i++) parents.push({ tag: tagOf(p), classes: stableClasses(p, 3) });
  const text = visibleText(el);
  return {
    tag: tagOf(el), classes: stableClasses(el, 4), attrs, parents,
    anchor: findAnchor(el, doc),
    textLen: text.length, textHead: text.slice(0, 60), sig: childSig(el),
  };
}

const jacc = (a, b) => { const A = new Set(a); const B = new Set(b); if (!A.size && !B.size) return null; let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); };

/**
 * How much `el` looks like the fingerprinted element, 0..1 — only the features the
 * fingerprint actually has count, so a block without classes is not punished.
 */
export function scoreElement(fp, el, doc) {
  if (!fp || !el || tagOf(el) !== fp.tag) return 0;
  let got = 0; let max = 0;
  const add = (w, v) => { if (v == null) return; max += w; got += w * v; };
  // A fingerprint stored before a class was known to be generated keeps it: such classes are ignored now
  // (they change with each build of the site), on both sides of the comparison.
  const fpClasses = (fp.classes || []).filter(blockClass);
  const cj = jacc(fpClasses, stableClasses(el, 4)); if (fpClasses.length) add(0.25, cj == null ? 0 : cj);
  const ak = Object.keys(fp.attrs || {}).filter((k) => !(k === 'id' && isUnstableClass(fp.attrs[k])));
  if (ak.length) add(0.25, ak.filter((k) => el.getAttribute(k) === fp.attrs[k]).length / ak.length);
  if (fp.parents && fp.parents.length) {
    let ok = 0; let p = el.parentElement;
    for (const fpp of fp.parents) { const pc = (fpp.classes || []).filter(blockClass); if (p && tagOf(p) === fpp.tag && (!pc.length || (jacc(pc, stableClasses(p, 3)) || 0) >= 0.5)) ok++; p = p && p.parentElement; }
    add(0.15, ok / fp.parents.length);
  }
  if (fp.anchor && fp.anchor.text) { const t = anchorTextOf(el, doc); add(0.25, t && normLabel(t) === normLabel(fp.anchor.text) ? 1 : 0); }
  const sk = Object.keys(fp.sig || {});
  if (sk.length) { const now = childSig(el); add(0.1, sk.filter((k) => now[k]).length / sk.length); }
  return max ? got / max : 0;
}

const ACCEPT = 0.5;
const matches = (doc, sel) => {
  if (!sel) return [];
  if (sel.startsWith(':scope > ')) { const n = queryInCard(doc.body || doc.documentElement, sel); return n ? [n] : []; }
  try { return [...doc.querySelectorAll(sel)].slice(0, 25); } catch { return []; }
};
function best(fp, els, doc, min = ACCEPT) {
  let top = null; let s = 0;
  for (const e of els) { const v = scoreElement(fp, e, doc); if (v > s) { s = v; top = e; } }
  return top && s >= min ? { el: top, score: s } : null;
}

// Label → block. The block a tab / accordion trigger / heading opens.
function labelCandidates(doc, label) {
  const want = normLabel(label); if (!want) return [];
  const out = [];
  let nodes = []; try { nodes = [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6,summary,button,legend,dt,strong,b,[role=tab],[role=heading],a,span,div,p')].slice(0, 4000); } catch { nodes = []; }
  for (const n of nodes) {
    if (SKIP.test(n.tagName) || n.children.length > 3) continue;
    const t = visibleText(n); if (!t || t.length > 90) continue;
    if (normLabel(t) === want) out.push(n);
  }
  return out;
}
function blockForAnchor(doc, anchor, h) {
  const blk = baseBlock(doc, anchor, h);
  if (blk && anchor.rel !== 'after-heading' && anchor.up > 0 && anchor.inner) return queryInCard(blk, anchor.inner);
  return blk;
}
function baseBlock(doc, anchor, h) {
  const rel = anchor.rel;
  if (rel === 'details') { const d = h.closest && h.closest('details'); return d || null; }
  if (rel === 'controls') { const id = h.getAttribute('aria-controls') || (h.closest && h.closest('[aria-controls]') && h.closest('[aria-controls]').getAttribute('aria-controls')); return id && doc.getElementById ? doc.getElementById(id) : null; }
  if (rel === 'labelledby') { const id = h.getAttribute('id'); if (!id) return null; return [...doc.querySelectorAll('[aria-labelledby]')].find((e) => e.getAttribute('aria-labelledby').split(/\s+/).includes(id)) || null; }
  if (rel === 'wraps-heading') return h.parentElement || null;
  if (rel === 'after-heading') {
    let n = h; const up = anchor.up || 0;
    // The block sits `up` levels under the sibling that follows the heading: climb the
    // heading the same number of levels is not needed — the sibling follows the heading.
    let sib = n.nextElementSibling; let k = 0;
    while (sib && !hasText(sib, 5) && k < 3) { sib = sib.nextElementSibling; k++; }
    if (!sib) return null;
    if (up > 0 && anchor.inner) return queryInCard(sib, anchor.inner);
    return sib;
  }
  return null;
}

/**
 * Find the element of a rule on `doc`.
 * @param {Document} doc
 * @param {{selector?:string, fingerprint?:object}} rule
 * @returns {{el:Element, strategy:'selector'|'attr'|'label'|'structure', score:number}|null}
 */
export function resolveRule(doc, rule) {
  if (!doc || !rule) return null;
  const fp = rule.fingerprint || null;
  // 1) the stored selector — the best-scoring match, accepted only when it still looks like the block
  const bySel = matches(doc, rule.selector);
  if (bySel.length) {
    if (!fp) return { el: bySel[0], strategy: 'selector', score: 1 };
    const b = best(fp, bySel, doc); if (b) return { ...b, strategy: 'selector' };
  }
  if (!fp) return null;
  // 2) the stable attributes
  const keys = Object.keys(fp.attrs || {}).filter((k) => k !== 'role' && k !== 'aria-label' && !(k === 'id' && isUnstableClass(fp.attrs[k])));
  for (const k of keys) {
    const v = fp.attrs[k]; if (!/^[\w -]{1,60}$/.test(v)) continue;
    const found = matches(doc, `${fp.tag}[${k}="${v}"]`);
    const b = best(fp, found, doc, 0.4); if (b) return { ...b, strategy: 'attr' };
  }
  // 3) its label
  if (fp.anchor && fp.anchor.text) {
    for (const h of labelCandidates(doc, fp.anchor.text)) {
      const blk = blockForAnchor(doc, fp.anchor, h);
      if (blk && blk.nodeType === 1 && hasText(blk, 5)) return { el: blk, strategy: 'label', score: Math.max(0.5, scoreElement(fp, blk, doc)) };
    }
  }
  // 4) structure: the most similar element of the same tag, clearly ahead of the next one — only when the
  // fingerprint holds something distinctive (a stable class or attribute of the block or of its parents):
  // a bare tag + shape would match any block of the page (an account menu taken for a size list).
  const distinctive = (fp.classes || []).some(blockClass) || keys.length || (fp.parents || []).some((p) => (p.classes || []).some(blockClass));
  if (!distinctive) return null;
  let pool = [];
  const firstStable = (fp.classes || []).find(blockClass);
  try { pool = [...doc.querySelectorAll(firstStable ? `${fp.tag}.${firstStable.replace(/([^a-zA-Z0-9_-])/g, '\\$1')}` : fp.tag)].slice(0, 3000); } catch { pool = []; }
  const scored = pool.map((e) => ({ e, s: scoreElement(fp, e, doc) })).sort((a, b) => b.s - a.s);
  if (scored.length && scored[0].s >= 0.6 && (scored.length === 1 || scored[0].s - scored[1].s >= 0.05)) return { el: scored[0].e, strategy: 'structure', score: scored[0].s };
  return null;
}

/**
 * The block a label node opens, whatever the page's pattern: the panel its tab / accordion
 * trigger controls (aria-controls), the <details> it summarises, or the content that follows
 * a heading. Used without any learned rule, to read a page that labels its blocks.
 * @returns {Element|null}
 */
export function blockOfLabel(doc, node) {
  const ctl = node.getAttribute('aria-controls') || (node.closest && node.closest('[aria-controls]') && node.closest('[aria-controls]').getAttribute('aria-controls'));
  if (ctl && doc.getElementById) { const t = doc.getElementById(ctl); if (t && hasText(t, 5)) return t; }
  const det = node.closest && node.closest('details');
  if (det && tagOf(node) === 'summary' && hasText(det, visibleText(node).length + 10)) return det;
  const id = node.getAttribute('id');
  if (id) { const t = [...doc.querySelectorAll('[aria-labelledby]')].find((e) => e.getAttribute('aria-labelledby').split(/\s+/).includes(id)); if (t && hasText(t, 5)) return t; }
  let sib = node.nextElementSibling; let k = 0;
  while (sib && !hasText(sib, 5) && k < 3) { sib = sib.nextElementSibling; k++; }
  if (sib) return sib;
  // The label is the only thing in its wrapper: the wrapper's next sibling is the content.
  const w = node.parentElement;
  if (w && w.children.length === 1 && w.nextElementSibling && hasText(w.nextElementSibling, 5)) return w.nextElementSibling;
  return null;
}

/**
 * The blocks of a page whose label matches `labelRe` (tested on the normalised label text).
 * @param {Document} doc @param {RegExp} labelRe
 * @returns {Element[]} in page order, duplicates removed
 */
export function labelledBlocks(doc, labelRe) {
  const out = []; let nodes = [];
  try { nodes = [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6,summary,button,legend,dt,strong,b,[role=tab],[role=heading],a,span,div,p,li')].slice(0, 5000); } catch { nodes = []; }
  for (const n of nodes) {
    if (SKIP.test(n.tagName) || n.children.length > 3) continue;
    const t = visibleText(n); if (!t || t.length > 60) continue;
    if (!labelRe.test(normLabel(t))) continue;
    let b = null; try { b = blockOfLabel(doc, n); } catch { b = null; }
    if (b && b !== n && !b.contains(n) && !out.includes(b)) out.push(b);
  }
  return out;
}
