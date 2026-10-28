/**
 * The category trail of a page (typically the listing the products come from), read
 * on any DOM (live page in the extension, linkedom in the app). Generic, in order:
 *   1. a schema.org BreadcrumbList in JSON-LD;
 *   2. a microdata BreadcrumbList;
 *   3. a breadcrumb navigation block (aria-label / class / id / data-* "breadcrumb");
 *   4. the page title (h1) — never on the site's home page.
 * The leading "Home" step (or the site's own name) is dropped.
 */

const ROOT = /^(home|accueil|startseite|start|inicio|p[aá]gina inicial|homepage|home page|hoofdpagina|index|welkom|bienvenue|willkommen)$/i;
// A step's text, with the HTML entities a page may leave in its structured data
// ("Extracteurs d&#039;air") decoded.
const clean = (s) => String(s == null ? '' : s)
  .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
  .replace(/&#(\d+);/g, (m, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : m; })
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => { const c = parseInt(h, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : m; })
  .replace(/\s+/g, ' ').trim();

function siteName(pageUrl) {
  try { const h = new URL(pageUrl).hostname.replace(/^www\./, '').split('.'); return h.length >= 2 ? h[h.length - 2] : h[0]; } catch { return ''; }
}

function isHomePath(pageUrl) {
  try { const p = new URL(pageUrl).pathname.replace(/\/+$/, ''); return !p || /^\/[a-z]{2}(?:[-_][a-z]{2})?(?:\/[a-z]{2})?$/i.test(p); } catch { return false; }
}

/** A trail cleaned: blank / repeated steps removed, the leading "Home" step (or the site's own name) dropped. */
export function tidyTrail(names, pageUrl) { return tidy(Array.isArray(names) ? names : [], pageUrl || ''); }

function tidy(names, pageUrl) {
  const site = siteName(pageUrl).toLowerCase();
  const out = [];
  for (const n of names.map(clean)) {
    if (!n || n.length > 80) continue;
    if (out.length && out[out.length - 1].toLowerCase() === n.toLowerCase()) continue;
    out.push(n);
  }
  while (out.length && (ROOT.test(out[0]) || out[0].toLowerCase() === site)) out.shift();
  return out.slice(0, 8);
}

function fromJsonLd(doc) {
  const nodes = [];
  const walk = (v) => { if (!v || typeof v !== 'object') return; if (Array.isArray(v)) { v.forEach(walk); return; } nodes.push(v); if (v['@graph']) walk(v['@graph']); };
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) { try { walk(JSON.parse(s.textContent)); } catch { /* skip */ } }
  const bc = nodes.find((n) => [].concat(n['@type'] || []).some((t) => /^BreadcrumbList$/i.test(String(t))));
  if (!bc || !Array.isArray(bc.itemListElement)) return [];
  return bc.itemListElement
    .map((e) => ({ pos: Number(e && e.position) || 0, name: (e && (e.name || (e.item && typeof e.item === 'object' && e.item.name))) || '' }))
    .sort((a, b) => a.pos - b.pos).map((e) => e.name);
}

function fromMicrodata(doc) {
  // microdata (itemtype / itemprop) or RDFa (typeof / property: adidas)
  const list = doc.querySelector('[itemtype*="BreadcrumbList"], [typeof*="BreadcrumbList"]');
  if (!list) return [];
  return [...list.querySelectorAll('[itemprop="itemListElement"], [property="itemListElement"]')].map((li) => { const n = li.querySelector('[itemprop="name"], [property="name"]'); return n ? (n.getAttribute('content') || n.textContent) : ''; });
}

function fromNav(doc) {
  const el = [...doc.querySelectorAll('nav, ol, ul, div')].find((e) => ['aria-label', 'class', 'id', 'data-test-id', 'data-testid'].some((a) => /breadcrumb|fil[-_ ]d.?ariane|brotkr|kruimel/i.test(e.getAttribute(a) || '')));
  if (!el) return [];
  const items = [...el.querySelectorAll('li')];
  const nodes = items.length ? items : [...el.querySelectorAll('a')];
  return nodes.map((n) => n.textContent);
}

/**
 * @param {Document} doc
 * @param {string} pageUrl
 * @returns {{ trail:string[], source:'jsonld'|'microdata'|'nav'|'title'|null }}
 */
export function trailFromDocument(doc, pageUrl) {
  if (!doc) return { trail: [], source: null };
  for (const [source, fn] of [['jsonld', fromJsonLd], ['microdata', fromMicrodata], ['nav', fromNav]]) {
    let t = []; try { t = tidy(fn(doc), pageUrl); } catch { t = []; }
    if (t.length) return { trail: t, source };
  }
  if (!isHomePath(pageUrl)) {
    const h1 = clean(doc.querySelector('h1') && doc.querySelector('h1').textContent);
    if (h1 && h1.length <= 60) return { trail: [h1], source: 'title' };
  }
  return { trail: [], source: null };
}
