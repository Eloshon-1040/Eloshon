/**
 * URL representations for the recovery ladder (F1) — PURE, dependency-free,
 * offline-testable, GENERIC. Produces alternative *public representations of the
 * SAME resource* that a blocked/thin first fetch can be retried against.
 *
 * DORMANT by design: nothing imports this yet. The recovery ladder (F2) will
 * call it AFTER the normal HTTP attempt is judged not-exploitable, then
 * re-validate each candidate (incl. a product-identity re-check) before use.
 * Adding it changes NO current behaviour.
 *
 * Two kinds of representation, tagged by `source`:
 *   • 'declared'  — the site itself exposes it (<link rel=canonical|amphtml|
 *                   alternate>, og:url). RELIABLE, never invented.
 *   • 'heuristic' — a generic host-shape rule (e.g. www.→m.), a CANDIDATE that
 *                   may or may not exist. The ladder must validate it.
 *
 * NO-SITE-NAME rule (mirrors the engine's ethos): only domain-agnostic *rules*
 * live here — never a hardcoded domain, path, selector, or per-platform
 * endpoint guess (e.g. never fabricate "/products.json" or ".rss"). Platform
 * structured endpoints stay where a real signal proves them (platform.mjs).
 */
import { absoluteUrl } from './url-utils.mjs';

// ── Generic host-shape transforms (heuristic candidates) ─────────────────────
// Each returns a new URL string, or null when the rule does not apply to this
// host. Path / query / hash / port / scheme are always preserved. The four
// rules are mutually exclusive on host shape, so at most one mobile_* fires per
// host (drop_www additionally fires only on www. hosts).

function withHost(url, newHost) {
  try {
    const u = new URL(url);
    if (u.port) u.host = `${newHost}:${u.port}`; else u.hostname = newHost;
    return u.toString();
  } catch { return null; }
}
function hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } }
const dots = (h) => (h.match(/\./g) || []).length;

/** www.example.com → m.example.com */
function mobile_www(url) {
  const h = hostOf(url);
  return h.startsWith('www.') ? withHost(url, 'm.' + h.slice(4)) : null;
}
/** example.com → m.example.com (apex host only: exactly one dot, no www./m.) */
function mobile_apex(url) {
  const h = hostOf(url);
  if (h.startsWith('www.') || h.startsWith('m.')) return null;
  return dots(h) === 1 ? withHost(url, 'm.' + h) : null;
}
/** blog.example.com → m.blog.example.com (already-subdomained host, not www./m.) */
function mobile_sub(url) {
  const h = hostOf(url);
  if (h.startsWith('www.') || h.startsWith('m.')) return null;
  return dots(h) >= 2 ? withHost(url, 'm.' + h) : null;
}
/** www.example.com → example.com (some hosts gate www. but not the apex) */
function drop_www(url) {
  const h = hostOf(url);
  return h.startsWith('www.') ? withHost(url, h.slice(4)) : null;
}

/** Registry of generic transforms (name → fn). Extension rule: prove a new
 *  transform helps on ≥2 UNRELATED sites before adding it (cross-site, no bias). */
export const TRANSFORMS = {
  mobile_www, mobile_apex, mobile_sub, drop_www,
};

const MOBILE_ORDER = ['mobile_www', 'mobile_apex', 'mobile_sub'];
const DESKTOP_ORDER = ['drop_www'];
// Most-likely-to-help first: mobile twins (biggest empirical win on thin
// desktop shells), then the www→apex unblock.
const AUTO_ORDER = [...MOBILE_ORDER, 'drop_www'];

function orderFor(device) {
  if (device === 'desktop') return DESKTOP_ORDER;
  if (device === 'mobile') return MOBILE_ORDER;
  return AUTO_ORDER;
}

/**
 * Heuristic host-variant candidates for a URL, in priority order, applicable
 * only + deduped (never includes the original).
 * @param {string} url
 * @param {{device?: 'auto'|'desktop'|'mobile'}} [opts]
 * @returns {{name:string, url:string, source:'heuristic'}[]}
 */
export function urlVariants(url, opts = {}) {
  if (!url || typeof url !== 'string') return [];
  const order = orderFor(opts.device || 'auto');
  const out = [];
  const seen = new Set([url]);
  for (const name of order) {
    const next = TRANSFORMS[name](url);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push({ name, url: next, source: 'heuristic' });
  }
  return out;
}

// ── Site-declared representations (reliable, never invented) ──────────────────
// Parsed from the HTML the site already returned: <link rel=...> and og:url.
// Regex-based (no DOM dependency), matching the engine's existing html-meta style.

function parseLinkTags(html) {
  const tags = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const attr = (name) => tag.match(new RegExp(`${name}=["']([^"']*)["']`, 'i'))?.[1] || '';
    const rel = attr('rel').toLowerCase();
    if (!rel) continue;
    tags.push({ rel, href: attr('href'), media: attr('media').toLowerCase(), type: attr('type').toLowerCase() });
  }
  return tags;
}

function ogUrl(html) {
  const tag = html.match(/<meta\b[^>]*property=["']og:url["'][^>]*>/i)?.[0]
    || html.match(/<meta\b[^>]*name=["']og:url["'][^>]*>/i)?.[0];
  return tag ? (tag.match(/content=["']([^"']*)["']/i)?.[1] || '') : '';
}

/**
 * Representations the site itself declares. RELIABLE (not guessed).
 * @param {string} html
 * @param {string} baseUrl  the URL the HTML was fetched from (for relative hrefs)
 * @returns {{kind:string, url:string, source:'declared'}[]}
 *   kind ∈ canonical | amphtml | mobile | feed_rss | feed_atom | feed_json | og_url
 */
export function declaredRepresentations(html, baseUrl) {
  if (!html || typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  const push = (kind, href) => {
    const abs = absoluteUrl(href, baseUrl);
    if (!abs) return;
    const k = kind + '|' + abs;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ kind, url: abs, source: 'declared' });
  };

  for (const t of parseLinkTags(html)) {
    if (!t.href) continue;
    const rels = t.rel.split(/\s+/);
    if (rels.includes('canonical')) push('canonical', t.href);
    if (rels.includes('amphtml')) push('amphtml', t.href);
    if (rels.includes('alternate')) {
      if (/max-width|handheld|only screen/i.test(t.media)) push('mobile', t.href);
      if (/rss\+xml/.test(t.type)) push('feed_rss', t.href);
      else if (/atom\+xml/.test(t.type)) push('feed_atom', t.href);
      else if (/json/.test(t.type)) push('feed_json', t.href);
    }
  }
  const og = ogUrl(html);
  if (og) push('og_url', og);
  return out;
}

/**
 * Ordered candidate representations to try for a resource: site-declared first
 * (most reliable), then generic heuristic host variants. Deduped by absolute
 * URL; the original is excluded unless `includeOriginal` is set. Each item keeps
 * its `source` so the ladder can re-check identity more strictly on heuristics.
 *
 * Pure: pass `html` (already fetched) to include declared representations;
 * omit it for URL-only variants. No network here.
 *
 * @param {{url:string, html?:string|null, device?:'auto'|'desktop'|'mobile', includeOriginal?:boolean}} args
 * @returns {{url:string, source:'declared'|'heuristic'|'original', name?:string, kind?:string}[]}
 */
export function alternativeRepresentations({ url, html = null, device = 'auto', includeOriginal = false } = {}) {
  if (!url || typeof url !== 'string') return [];
  const out = [];
  const seen = new Set();
  const add = (item) => {
    if (!item.url) return;
    if (!includeOriginal && item.url === url) return;
    if (seen.has(item.url)) return;
    seen.add(item.url);
    out.push(item);
  };
  if (includeOriginal) add({ url, source: 'original', name: 'original' });
  if (html) for (const d of declaredRepresentations(html, url)) add(d);
  for (const v of urlVariants(url, { device })) add(v);
  return out;
}
