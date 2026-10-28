/**
 * Link scoping (collection scope) — classifies a listing page's links as
 * in-grid product links, off-grid links that still match the product URL
 * pattern (banners, cross-sell, nav to fiches), or other. Pure + offline
 * (linkedom, no network, no browser). Fail-open by design: when no confident
 * grid is found, classify() answers 'in_grid' for everything so callers keep
 * their current behaviour.
 *
 * Signals (field-measured — keep all of them, they only reach 100% together):
 *  S2 cards (primary): smallest non-anchor element holding ≥1 a[href] AND
 *     (≥1 img OR a price pattern); clustered by normalized structural
 *     signature; deepest cluster wins over its wrapper.
 *  S1 URL templates (confirmatory): slug-first templating; the retained
 *     pattern comes from the S2 grid hrefs, never from raw size dominance.
 *  S4 position: links under nav/header/footer/aside/[role=navigation]/
 *     breadcrumb are never 'in_grid'.
 *  JSON-LD is deliberately NOT used here: a single @type=Product on a listing
 *  describes the category, not the links.
 */
import { parseHTML } from 'linkedom';
import { absoluteUrl, dedupKey } from './url-utils.mjs';

// Same price pattern as recipe-producer.mjs PRICE_RE (kept in sync by test).
export const PRICE_RE = /\d+[.,]\d{2}\s*€|€\s*\d|\d+[.,]\d{2}\s*(?:eur|chf|£|\$)/i;

const MAX_HTML_BYTES = 3 * 1024 * 1024; // perf cap: beyond this, fail open
const MIN_ANCHORS = 5;                  // shell page: nothing to scope
const MIN_CLUSTER = 3;                  // a real grid repeats
const MAX_WALK_UP = 10;                 // card lives close above its anchor

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function isValidHref(h) {
  return !!h && h !== '#' && !/^(javascript:|mailto:|tel:)/i.test(h);
}

/** S4: element sits under a navigation/peripheral zone. */
function inNavZone(el) {
  for (let n = el; n; n = n.parentElement) {
    const tag = n.tagName;
    if (tag === 'NAV' || tag === 'HEADER' || tag === 'FOOTER' || tag === 'ASIDE') return true;
    if (!n.getAttribute) continue;
    if ((n.getAttribute('role') || '').toLowerCase() === 'navigation') return true;
    if (/breadcrumb/i.test(n.getAttribute('class') || '') || /breadcrumb/i.test(n.getAttribute('aria-label') || '')) return true;
  }
  return false;
}

// Hashed-looking class (CSS modules, styled-components): never a signature token.
const looksHashed = (c) => /^(?:css|sc|jss|jsx)-/.test(c) || /^_/.test(c) || (/^[a-z0-9]{8,}$/i.test(c) && /\d/.test(c));

/** Normalized structural signature tokens: BEM modifiers truncated, state/hashed classes dropped. */
function normClasses(el) {
  const out = new Set();
  for (const c of el.classList) {
    if (!c || /^(is-|has-|js-)/.test(c) || c === 'active') continue;
    const base = c.replace(/--.*$/, '');
    if (!base || looksHashed(base)) continue;
    out.add(base.toLowerCase());
  }
  return [...out].sort();
}

function depthOf(el) {
  let d = 0;
  for (let n = el; n; n = n.parentElement) d++;
  return d;
}

/**
 * S2 candidate: smallest NON-anchor ancestor holding ≥1 a[href] (the anchor
 * itself) AND (≥1 img OR a price). Without the img/price constraint the
 * mega-menu wins (measured 109-287 items) — never relax it.
 */
function cardCandidate(anchor, cache) {
  let hops = MAX_WALK_UP;
  for (let n = anchor.parentElement; n && hops-- > 0; n = n.parentElement) {
    const tag = n.tagName;
    if (tag === 'BODY' || tag === 'HTML') return null;
    if (tag === 'A') continue;
    let ok = cache.get(n);
    if (ok === undefined) {
      ok = !!n.querySelector('img') || PRICE_RE.test(n.textContent || '');
      cache.set(n, ok);
    }
    if (ok) return n;
  }
  return null;
}

/**
 * S1 slug-first templating: wildcard the WHOLE slug segment first, then
 * letter-prefixed digit runs ≥4 in what remains (the reverse order fragments —
 * measured 89% recall).
 */
function templateSegment(seg) {
  const m = seg.match(/^(.*?)(\.[a-z0-9]{2,5})$/i);
  const core = m ? m[1] : seg;
  const ext = m ? m[2] : '';
  if (/^[a-z0-9%]+(?:[-_][a-z0-9%]+)+$/i.test(core)) return '*' + ext;
  return core.replace(/[a-z]?\d{4,}/gi, '*') + ext;
}

function templateOfUrl(abs) {
  let path;
  try { path = new URL(abs).pathname; } catch { return null; }
  return path.split('/').map(templateSegment).join('/') || '/';
}

function patternFromTemplate(template) {
  const regexSource = '^' + String(template).split('*').map(escapeRe).join('[^/]+') + '$';
  return { template: String(template), regexSource };
}

function compileMatchers(patterns) {
  const regs = [];
  for (const p of patterns) {
    try { regs.push(new RegExp(p.regexSource)); } catch { /* skip bad pattern */ }
  }
  return (abs) => {
    let path;
    try { path = new URL(abs).pathname; } catch { return false; }
    return regs.some((r) => r.test(path));
  };
}

/** Dominant template among a set of absolute URLs; null when empty. */
function dominantTemplate(absUrls) {
  const counts = new Map();
  for (const u of absUrls) {
    const t = templateOfUrl(u);
    if (!t) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  let best = null;
  for (const [t, n] of counts) if (!best || n > best.n) best = { t, n };
  return best; // { t, n } | null
}

const failOpen = (stats) => ({
  confident: false,
  gridSelector: null,
  cardCount: 0,
  urlPattern: null,
  classify: () => 'in_grid',
  stats,
});

/**
 * Scope a listing page's links to its product grid.
 * @param {string} html
 * @param {string} baseUrl
 * @param {{ productReSource?:string,
 *          learned?:{ container:string, card?:string,
 *                     link?:{selector?:string, attr?:string},
 *                     url_templates?:Array<string|{template:string, regexSource?:string}> } }} [opts]
 *   `productReSource`: PRODUCT_RE.source from discover.mjs — confirmatory only.
 *   `learned`: a stored link_filter recipe; a matching container DOMINATES the
 *   heuristics, a dead container falls back to url_templates then heuristics.
 * @returns {{ confident:boolean, gridSelector:string|null, cardCount:number,
 *            urlPattern:{template:string, regexSource:string}|null,
 *            classify:(href:string)=>'in_grid'|'pattern_off_grid'|'other',
 *            stats:{anchors:number, inGrid:number, offGrid:number} }}
 */
export function scopeLinks(html, baseUrl, { productReSource, learned } = {}) {
  if (!html || html.length > MAX_HTML_BYTES) return failOpen({ anchors: 0, inGrid: 0, offGrid: 0 });

  const { document } = parseHTML(html);
  const anchors = [...document.querySelectorAll('a[href]')].filter((a) => isValidHref(a.getAttribute('href')));
  if (anchors.length < MIN_ANCHORS) return failOpen({ anchors: anchors.length, inGrid: 0, offGrid: 0 });

  const keyOf = (href) => {
    const abs = absoluteUrl(href, baseUrl);
    return abs ? dedupKey(abs) : null;
  };

  const learnedPatterns = compileLearnedPatterns(learned);

  // learned recipe: a matching container dominates every heuristic.
  if (learned && learned.container) {
    let containers = [];
    try { containers = [...document.querySelectorAll(learned.container)]; } catch { containers = []; }
    if (containers.length >= 1) {
      const gridAnchors = collectLearnedAnchors(containers, learned);
      return buildResult({
        anchors, gridAnchors, keyOf, baseUrl,
        gridSelector: learned.container,
        cardCount: countLearnedCards(containers, learned),
        patterns: learnedPatterns,
      });
    }
    // dead container → url_templates alone, then heuristics (below).
    const heuristic = heuristicGrid(document, anchors, keyOf, productReSource, baseUrl, learnedPatterns);
    if (heuristic) return heuristic;
    if (learnedPatterns.length) return patternOnlyResult(anchors, keyOf, baseUrl, learnedPatterns);
    return failOpen({ anchors: anchors.length, inGrid: 0, offGrid: 0 });
  }

  const heuristic = heuristicGrid(document, anchors, keyOf, productReSource, baseUrl, null);
  if (heuristic) return heuristic;
  return failOpen({ anchors: anchors.length, inGrid: 0, offGrid: 0 });
}

function compileLearnedPatterns(learned) {
  const out = [];
  for (const t of (learned && learned.url_templates) || []) {
    if (!t) continue;
    if (typeof t === 'string') out.push(patternFromTemplate(t));
    else if (t.regexSource) out.push({ template: t.template || '', regexSource: t.regexSource });
    else if (t.template) out.push(patternFromTemplate(t.template));
  }
  return out;
}

function collectLearnedAnchors(containers, learned) {
  const out = [];
  for (const c of containers) {
    const scopes = learned.card ? safeQueryAll(c, learned.card) : [c];
    for (const s of scopes) {
      const links = learned.link && learned.link.selector ? safeQueryAll(s, learned.link.selector) : [...s.querySelectorAll('a[href]')];
      const attr = (learned.link && learned.link.attr) || 'href';
      for (const l of links) {
        const href = l.getAttribute(attr);
        if (isValidHref(href)) out.push({ el: l, href });
      }
    }
  }
  return out;
}

function countLearnedCards(containers, learned) {
  if (!learned.card) return containers.length;
  let n = 0;
  for (const c of containers) n += safeQueryAll(c, learned.card).length;
  return n;
}

function safeQueryAll(root, selector) {
  try { return [...root.querySelectorAll(selector)]; } catch { return []; }
}

/** S2 + S1 + S4: returns a confident result, or null when no grid emerges. */
function heuristicGrid(document, anchors, keyOf, productReSource, baseUrl, learnedPatterns) {
  const cache = new Map();
  const clusters = new Map(); // sig → { cards:[], depthSum }
  const seenCards = new Set();
  for (const a of anchors) {
    if (inNavZone(a)) continue; // S4: never a grid member
    const card = cardCandidate(a, cache);
    if (!card || seenCards.has(card)) continue;
    seenCards.add(card);
    const sig = card.tagName + '|' + normClasses(card).join('.');
    let c = clusters.get(sig);
    if (!c) { c = { cards: [], depthSum: 0 }; clusters.set(sig, c); }
    c.cards.push(card);
    c.depthSum += depthOf(card);
  }

  let winner = null;
  for (const c of clusters.values()) {
    if (c.cards.length < MIN_CLUSTER) continue;
    const hrefs = gridHrefs(c.cards, keyOf);
    if (hrefs.keys.size < MIN_CLUSTER) continue; // ≥3 unique product links after dedup
    const depth = c.depthSum / c.cards.length;
    // tie-break MAX depth: the deepest repeated element is the card, not its wrapper
    if (!winner || c.cards.length > winner.count || (c.cards.length === winner.count && depth > winner.depth)) {
      winner = { count: c.cards.length, depth, cards: c.cards, hrefs };
    }
  }
  if (!winner) return null;

  const gridAnchors = winner.hrefs.anchors;
  const patterns = (learnedPatterns && learnedPatterns.length)
    ? learnedPatterns
    : derivePatterns(winner.hrefs.abs, anchors, keyOf, productReSource, baseUrl);

  return buildResult({
    anchors, gridAnchors, keyOf, baseUrl,
    gridSelector: cardSelector(winner.cards),
    cardCount: winner.count,
    patterns,
  });
}

function gridHrefs(cards, keyOf) {
  const keys = new Set();
  const abs = [];
  const out = [];
  for (const card of cards) {
    for (const a of card.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (!isValidHref(href) || inNavZone(a)) continue;
      out.push({ el: a, href });
      const k = keyOf(href);
      if (k && !keys.has(k)) { keys.add(k); abs.push(k); }
    }
  }
  return { anchors: out, keys, abs };
}

/** Selector for the repeated card: tag + classes common to ALL members. */
function cardSelector(cards) {
  let common = null;
  for (const c of cards) {
    const set = new Set([...c.classList]);
    common = common === null ? set : new Set([...common].filter((x) => set.has(x)));
  }
  const tag = cards[0].tagName.toLowerCase();
  if (!common || !common.size) return tag;
  return tag + '.' + [...common].map((x) => x.replace(/([^a-zA-Z0-9_-])/g, '\\$1')).join('.');
}

/**
 * S1: pattern = dominant template of the GRID hrefs; when too heterogeneous,
 * fall back to a template cluster carrying a product marker (productReSource)
 * — never plain size dominance over the whole page.
 */
function derivePatterns(gridAbsUrls, allAnchors, keyOf, productReSource, baseUrl) {
  const top = dominantTemplate(gridAbsUrls);
  if (top && top.n / Math.max(1, gridAbsUrls.length) >= 0.5) return [patternFromTemplate(top.t)];
  if (productReSource) {
    let productRe = null;
    try { productRe = new RegExp(productReSource, 'i'); } catch { /* confirmatory only */ }
    if (productRe) {
      const byTemplate = new Map();
      for (const a of allAnchors) {
        const abs = absoluteUrl(a.getAttribute('href'), baseUrl);
        if (!abs) continue;
        const t = templateOfUrl(abs);
        if (!t) continue;
        let e = byTemplate.get(t);
        if (!e) { e = { n: 0, marked: false }; byTemplate.set(t, e); }
        e.n += 1;
        if (productRe.test(abs)) e.marked = true;
      }
      let best = null;
      for (const [t, e] of byTemplate) {
        if (!e.marked) continue;
        if (!best || e.n > best.n) best = { t, n: e.n };
      }
      if (best) return [patternFromTemplate(best.t)];
    }
  }
  return top ? [patternFromTemplate(top.t)] : [];
}

function buildResult({ anchors, gridAnchors, keyOf, baseUrl, gridSelector, cardCount, patterns }) {
  const inGridKeys = new Set();
  for (const { href } of gridAnchors) {
    const k = keyOf(href);
    if (k) inGridKeys.add(k);
  }
  if (!inGridKeys.size) return failOpen({ anchors: anchors.length, inGrid: 0, offGrid: anchors.length });

  let effective = patterns;
  if (!effective || !effective.length) {
    const top = dominantTemplate([...inGridKeys]);
    effective = top ? [patternFromTemplate(top.t)] : [];
  }
  const matches = compileMatchers(effective);
  const inGrid = gridAnchors.length;
  const stats = { anchors: anchors.length, inGrid, offGrid: anchors.length - inGrid };

  return {
    confident: true,
    gridSelector,
    cardCount,
    urlPattern: effective.length ? effective[0] : null,
    classify(href) {
      const abs = absoluteUrl(href, baseUrl);
      if (!abs) return 'other';
      if (inGridKeys.has(dedupKey(abs))) return 'in_grid';
      if (matches(abs)) return 'pattern_off_grid';
      return 'other';
    },
    stats,
  };
}

/** Dead learned container but stored url_templates: templates alone drive scoping. */
function patternOnlyResult(anchors, keyOf, baseUrl, patterns) {
  const matches = compileMatchers(patterns);
  let inGrid = 0;
  for (const a of anchors) {
    const abs = absoluteUrl(a.getAttribute('href'), baseUrl);
    if (abs && matches(abs)) inGrid += 1;
  }
  return {
    confident: true,
    gridSelector: null,
    cardCount: 0,
    urlPattern: patterns[0],
    classify(href) {
      const abs = absoluteUrl(href, baseUrl);
      if (!abs) return 'other';
      return matches(abs) ? 'in_grid' : 'other';
    },
    stats: { anchors: anchors.length, inGrid, offGrid: anchors.length - inGrid },
  };
}
