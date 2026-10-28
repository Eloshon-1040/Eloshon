/**
 * Generic DOM-grid heuristic — the LAST-RESORT extraction layer for a listing page
 * that carries NO structured data (no JSON-LD / microdata) and NO machine-readable
 * embedded state (no JSON island / hydration blob). Many catalogues still render the
 * grid as plain repeated HTML tiles; this reads them by STRUCTURE, never by a
 * per-site selector.
 *
 * How it stays generic AND low-false-positive:
 *   • a tile is anchored on a product-detail link (generic product-URL shape), so
 *     nav / footer / promo links are ignored;
 *   • each tile keeps its own region (this anchor → the next product anchor), so a
 *     price/image belongs to the right product;
 *   • a card is kept only with a name AND (a price OR an image) — a real product
 *     signal, never a bare link;
 *   • it fires only when several tiles repeat (a GRID), so a single product page or
 *     a stray "related" link never looks like a catalogue.
 *
 * PORTABLE: zero Node built-ins, zero dependencies (small primitives inlined, byte-
 * faithful to their core originals) — runs in Node and in the extension service
 * worker on the live page's outerHTML.
 */

// ── Inlined portable primitives ───────────────────────────────────────────────
import { parseMoney } from './money.mjs';
import { bestFromSrcset } from './images.mjs';
function absoluteUrl(href, base) { if (!href) return null; try { return new URL(href, base).toString(); } catch { return null; } }
// core/discover.mjs PRODUCT_RE — a generic product-detail URL shape.
const PRODUCT_RE = /(\/product\/|\/produit\/|\/products\/|\/produits\/[a-z0-9]|\/p\/(?!(?:wiki|video|guide|help|about|blog|faq|page|content|info|news|story|lookbook)\/)|-p-\d|\/dp\/|\/item\/|\/artikel\/|\/pd\/)/i;
const decode = (s) => String(s || '')
  .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;|&#x27;/gi, "'").replace(/&#0*32;/gi, ' ').replace(/\s+/g, ' ').trim();
const stripTags = (s) => decode(String(s || '').replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '));

// Attribute value from a tag string: attr="v" | attr='v' | attr=v.
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null;
}

// First real image URL in a tile region (src / data-src / data-srcset / srcset),
// skipping 1px trackers and inline data URIs.
function tileImage(region, baseUrl) {
  const imgs = region.match(/<img\b[^>]*>/gi) || [];
  for (const tag of imgs) {
    let src = attr(tag, 'src') || attr(tag, 'data-src') || attr(tag, 'data-original') || attr(tag, 'data-lazy');
    if (!src) src = bestFromSrcset(attr(tag, 'srcset') || attr(tag, 'data-srcset'));
    if (!src || /^data:/i.test(src) || /(^|\/)(1x1|pixel|blank|spacer|placeholder)\.(gif|png)/i.test(src)) continue;
    const abs = absoluteUrl(src, baseUrl);
    if (abs) return abs;
  }
  return null;
}

// The product name for a tile: the anchor's own text, else its title/aria-label,
// else the tile's first image alt, else a heading in the region.
function tileName(region, anchorTag, innerText) {
  const t = decode(innerText || '');
  if (t && t.length >= 2 && t.length <= 200 && !/^\d+([.,]\d+)?\s*(€|\$|£|eur|usd)?$/i.test(t)) return t;
  const a = decode(attr(anchorTag, 'title') || attr(anchorTag, 'aria-label') || '');
  if (a && a.length >= 2 && a.length <= 200) return a;
  const img = (region.match(/<img\b[^>]*>/i) || [])[0];
  const alt = img && decode(attr(img, 'alt') || '');
  if (alt && alt.length >= 2 && alt.length <= 200) return alt;
  const h = region.match(/<(h[1-6]|[^>]*itemprop=["']name["'][^>]*)>([\s\S]*?)<\//i);
  const ht = h && stripTags(h[2]);
  return ht && ht.length >= 2 && ht.length <= 200 ? ht : null;
}

const isJunkHref = (h) => !h || h.startsWith('#') || /^(javascript:|mailto:|tel:|data:)/i.test(h);

// An address template: the path with every segment that carries digits (an id, a page number) as « # ».
const pathShape = (u) => { try { const x = new URL(u); return x.host + '/' + x.pathname.split('/').filter(Boolean).map((seg) => (/\d/.test(seg) ? '#' : seg)).join('/'); } catch { return null; } };
const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return null; } };

/**
 * The anchors of the repeated, priced tiles of a grid whose product links have no recognisable shape: the
 * same-site links grouped by address template; the template must vary per tile (a digit segment), repeat on
 * at least `minTiles` distinct addresses, and most of its tiles must show a price before the next one.
 */
function repeatedPricedAnchors(s, all, baseUrl, minTiles) {
  const host = hostOf(baseUrl); const here = (() => { try { const x = new URL(baseUrl); return x.origin + x.pathname; } catch { return ''; } })();
  const groups = new Map();
  for (const a of all) {
    if (hostOf(a.href) !== host) continue;
    const shape = pathShape(a.href); if (!shape || !shape.includes('#')) continue;
    let bare; try { const x = new URL(a.href); bare = x.origin + x.pathname; } catch { continue; }
    if (bare === here) continue;
    const g = groups.get(shape) || { anchors: [], urls: new Set() };
    g.anchors.push(a); g.urls.add(bare); groups.set(shape, g);
  }
  let best = null;
  for (const g of groups.values()) {
    if (g.urls.size < minTiles) continue;
    // A price between this tile's first link and the next tile's: a product tile, not a menu or a pager.
    const firsts = []; const seen = new Set();
    for (const a of g.anchors) { const k = a.href.split('#')[0]; if (!seen.has(k)) { seen.add(k); firsts.push(a); } }
    let priced = 0;
    for (let i = 0; i < firsts.length; i++) { const next = firsts[i + 1] ? firsts[i + 1].at : Math.min(s.length, firsts[i].end + 1500); if (parseMoney(stripTags(s.slice(firsts[i].at, next)))) priced++; }
    if (priced / firsts.length < 0.6) continue;
    if (!best || g.urls.size > best.urls.size) best = g;
  }
  return best ? best.anchors.slice(0, 600) : [];
}

/**
 * @param {string} html   listing-page HTML (outerHTML in the extension)
 * @param {string} baseUrl
 * @param {{minTiles?:number, maxTiles?:number}} [opts]
 * @returns {{cards:object[], pagination:null}}
 */
export function extractDomGrid(html, baseUrl, opts = {}) {
  const minTiles = opts.minTiles || 3;
  const maxTiles = opts.maxTiles || 200;
  const s = String(html || '');
  if (!s) return { cards: [], pagination: null };

  // 1) Product-detail anchors, in document order, with their tag + position.
  let anchors = [];
  const all = [];
  const aRe = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  let m;
  while ((m = aRe.exec(s)) && all.length < 1500) {
    const href = m[2] ?? m[3] ?? m[4];
    if (isJunkHref(href)) continue;
    const abs = absoluteUrl(href, baseUrl) || href;
    const a = { tag: m[0], href: abs, at: m.index, end: aRe.lastIndex };
    all.push(a);
    if (PRODUCT_RE.test(abs) && anchors.length < 600) anchors.push(a);
  }
  // 1b) No link has a product-URL shape: the tiles are recognised by their REPETITION instead — the links of
  //     this site that share one address template (« /catalogue/<slug>_981/index.html »), repeated at least
  //     `minTiles` times, most of them with a price right after. Generic: no word of the URL is assumed.
  if (anchors.length < minTiles) anchors = repeatedPricedAnchors(s, all, baseUrl, minTiles);
  if (anchors.length < minTiles) return { cards: [], pagination: null };

  // 2) One region per tile: from just before the anchor (image often precedes it)
  //    to the next product anchor. Merge tiles that share a product URL (an image
  //    link + a title link for the same product).
  const key = (u) => { try { const x = new URL(u); return (x.origin + x.pathname).toLowerCase().replace(/\/$/, ''); } catch { return String(u).toLowerCase(); } };
  const byUrl = new Map();
  for (let i = 0; i < anchors.length && i < maxTiles; i++) {
    const a = anchors[i];
    const next = anchors[i + 1] ? anchors[i + 1].at : Math.min(s.length, a.end + 1500);
    const region = s.slice(Math.max(0, a.at - 300), next);
    const innerText = stripTags(s.slice(a.end, s.indexOf('</a>', a.end) >= 0 ? Math.min(s.indexOf('</a>', a.end), a.end + 400) : a.end + 400));
    const k = key(a.href);
    const card = byUrl.get(k) || { strategy: 'dom-grid', sourceUrl: a.href, canonicalUrl: a.href };
    const name = tileName(region, a.tag, innerText);
    if (name && (!card.name || card.name.length < name.length)) card.name = name;
    // The price that FOLLOWS this tile's link first: the 300 characters before it may end with the previous
    // tile's price. The wider region (price written before the link) is the fallback, after every link is seen.
    if (card.price == null) { const mo = parseMoney(stripTags(s.slice(a.at, next))); if (mo) { card.price = mo.price; if (mo.currency) card.currency = mo.currency; } }
    if (!card._region) Object.defineProperty(card, '_region', { value: region, enumerable: false, writable: true });
    if (!card.images) { const img = tileImage(region, baseUrl); if (img) card.images = [img]; }
    // A product id/sku from a data-attribute is far more reliable than parsed text.
    if (!card.sku) { const sm = region.match(/\bdata-(?:sku|product-id|productid|pid|item-id|itemid|article(?:-?id)?)\s*=\s*("([^"]+)"|'([^']+)')/i); if (sm) card.sku = (sm[2] || sm[3]).trim(); }
    byUrl.set(k, card);
  }

  for (const card of byUrl.values()) { if (card.price == null && card._region) { const mo = parseMoney(stripTags(card._region)); if (mo) { card.price = mo.price; if (mo.currency) card.currency = mo.currency; } } }

  // 3) Keep only real product tiles (name + price|image) and require a GRID.
  const cards = [...byUrl.values()].filter((c) => c.name && (c.price != null || (c.images && c.images.length)));
  if (cards.length < minTiles) return { cards: [], pagination: null };
  return { cards, pagination: null };
}
