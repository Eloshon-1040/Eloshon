/**
 * Generic SPA-state product extractor (v0.5.6) — turns an UNLOCKED list page's
 * hydrated HTML into products by recognizing the embedded-state PATTERNS common
 * across frontend frameworks, then locating product-shaped data inside whichever
 * blob is present. NO per-site rules: it never branches on a domain — it matches
 * the SHAPE and scores arrays of objects by how product-shaped they are (a name-ish
 * field AND a price-ish field), mapping each item with a broad synonym set that digs
 * one level into nested value objects (e.g. Nike's copy.title / prices.currentPrice /
 * pdpUrl.url / colorwayImages.portraitURL).
 *
 * Recognized patterns: __NEXT_DATA__ (Next.js), __NUXT__ (Nuxt), __INITIAL_STATE__
 * (Redux convention), __APOLLO_STATE__ (Apollo/GraphQL cache), __PRELOADED_STATE__,
 * and bare <script type="application/json"> blobs. Complements core/embedded-state.mjs
 * (kept for the crawl lane's simpler product[]+pagination{} shapes); this is the more
 * aggressive matcher used on unlocked SPA payloads. When no state pattern matches, the
 * caller falls back to markdown via extractMarkdownProducts().
 */
import { absoluteUrl } from './url-utils.mjs';
import { parseMoney } from './dom-fallback.mjs';
import { parseDataLiteral } from '../shared/extract/js-literal.mjs';

const NAME_KEYS = ['name', 'title', 'fulltitle', 'producttitle', 'displayname', 'productname', 'label', 'heading', 'copy'];
const PRICE_KEYS = ['price', 'prices', 'pricing', 'msrp', 'amount', 'currentprice', 'saleprice', 'finalprice', 'listprice'];
const URL_KEYS = ['url', 'pdpurl', 'canonicalurl', 'detailurl', 'producturl', 'permalink', 'link', 'href', 'slug', 'path'];
const IMG_KEYS = ['image', 'images', 'img', 'thumbnail', 'photo', 'picture', 'colorwayimages', 'imageurl', 'media'];
const SKU_KEYS = ['sku', 'productcode', 'styleColor', 'stylecolor', 'code', 'pid', 'productid', 'id', 'gtin'];
const CUR_KEYS = ['currency', 'currencycode', 'currenccode'];

const lc = (s) => String(s).toLowerCase();
const NAME_SUBS = ['title', 'name', 'label', 'text', 'value', 'fulltitle', 'displayname'];
const URL_SUBS = ['url', 'path', 'href', 'canonical', 'slug'];
const IMG_SUBS = ['portraiturl', 'squarishurl', 'url', 'src', 'squarish', 'href', 'imageurl', 'landscapeurl', 'srcset'];

/** A string value, or a string dug one level out of a nested value object. */
function digString(v, subs) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return null;
  if (Array.isArray(v)) { for (const x of v) { const s = digString(x, subs); if (s) return s; } return null; }
  if (typeof v === 'object') { for (const k of Object.keys(v)) if (subs.includes(lc(k)) && typeof v[k] === 'string' && v[k].trim()) return v[k].trim(); }
  return null;
}

/** Best product name from an item (handles Nike's `copy: {title}` etc.). */
function pickName(o) {
  for (const k of Object.keys(o)) if (NAME_KEYS.includes(lc(k))) { const s = digString(o[k], NAME_SUBS); if (s) return s; }
  return null;
}

/** A numeric price from a number, a string with digits, or a nested price object. */
export function digPrice(v, depth = 0) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    // parseMoney handles localized formats (EU thousands/decimal, currency symbols);
    // fall back to a bare-number parse for a plain numeric string with no currency.
    const pm = parseMoney(v); if (pm && pm.price != null) return pm.price;
    const m = v.replace(/\s/g, '').match(/\d+(?:[.,]\d{1,2})?/); return m ? parseFloat(m[0].replace(',', '.')) : null;
  }
  if (v && typeof v === 'object' && depth < 3) {
    const prefer = ['currentprice', 'current', 'saleprice', 'finalprice', 'now', 'amount', 'value', 'price', 'min', 'low'];
    for (const want of prefer) for (const k of Object.keys(v)) if (lc(k) === want) { const p = digPrice(v[k], depth + 1); if (p != null) return p; }
  }
  return null;
}

function pickPrice(o) {
  for (const k of Object.keys(o)) if (PRICE_KEYS.includes(lc(k)) || lc(k).includes('price')) { const p = digPrice(o[k]); if (p != null) return p; }
  return null;
}
function pickUrl(o) { for (const k of Object.keys(o)) if (URL_KEYS.includes(lc(k))) { const s = digString(o[k], URL_SUBS); if (s) return s; } return null; }
function pickImg(o) {
  for (const k of Object.keys(o)) if (IMG_KEYS.includes(lc(k)) || lc(k).includes('image')) {
    let v = o[k]; if (Array.isArray(v)) v = v[0];
    const s = digString(v, IMG_SUBS) || (typeof v === 'string' ? v.trim() : null);
    if (s && /^https?:|^\/\//.test(s)) return s;
    if (s && /\.(jpe?g|png|webp|avif)/i.test(s)) return s;
  }
  return null;
}
function pickSku(o) { for (const want of SKU_KEYS) for (const k of Object.keys(o)) if (lc(k) === lc(want)) { const v = o[k]; if (typeof v === 'string' || typeof v === 'number') return String(v); } return null; }
function pickCurrency(o) { for (const k of Object.keys(o)) if (CUR_KEYS.includes(lc(k)) && typeof o[k] === 'string') return o[k]; return null; }

/** Is this object shaped like a product (a name AND a price)? */
function isProductish(o) { return o && typeof o === 'object' && !Array.isArray(o) && !!pickName(o) && pickPrice(o) != null; }

/** Map a product-shaped object to a RawProduct card (embedded-state card shape). */
function mapItem(o, baseUrl) {
  const url = pickUrl(o);
  const abs = url ? absoluteUrl(url, baseUrl) : null;
  const img = pickImg(o);
  const card = { strategy: 'spa-state' };
  const name = pickName(o); if (name) card.name = name;
  const price = pickPrice(o); if (price != null) card.price = price;
  const cur = pickCurrency(o); if (cur) card.currency = cur;
  const sku = pickSku(o); if (sku) card.sku = sku;
  if (abs) { card.sourceUrl = abs; card.canonicalUrl = abs; }
  if (img) card.images = [absoluteUrl(img, baseUrl) || img];
  return card;
}

/** Recursively collect every product-shaped array of objects in a JSON value. */
export function findProductArrays(root, cap = 20000) {
  const out = []; let seen = 0;
  const walk = (o) => {
    if (seen++ > cap || out.length > 200) return;
    if (Array.isArray(o)) {
      const objs = o.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
      if (objs.length >= 3) { const p = objs.filter(isProductish); if (p.length >= Math.ceil(objs.length * 0.5)) out.push(p); }
      for (const v of o) walk(v);
    } else if (o && typeof o === 'object') { for (const k of Object.keys(o)) walk(o[k]); }
  };
  walk(root);
  return out;
}

/** The balanced {...} or [...] literal starting at/after `from` in `s`, or null. */
function balancedLiteral(s, from) {
  let i = from; while (i < s.length && s[i] !== '{' && s[i] !== '[') { if (/[;\n<]/.test(s[i])) return null; i++; }
  if (i >= s.length) return null;
  const open = s[i], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, q = '', esc = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; q = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return s.slice(i, j + 1); }
  }
  return null;
}

/** Parse the known embedded-state blobs out of HTML → [{pattern, json}]. */
export function parseStateBlobs(html) {
  const blobs = []; const src = String(html || '');
  const nd = src.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nd) { try { blobs.push({ pattern: '__NEXT_DATA__', json: JSON.parse(nd[1]) }); } catch { /* skip */ } }
  for (const name of ['__NUXT__', '__INITIAL_STATE__', '__APOLLO_STATE__', '__PRELOADED_STATE__', '__REDUX_STATE__']) {
    const idx = src.indexOf(name);
    if (idx < 0) continue;
    const eq = src.indexOf('=', idx);
    if (eq < 0 || eq - idx > name.length + 4) continue;
    const lit = balancedLiteral(src, eq + 1);
    if (!lit) continue;
    try { blobs.push({ pattern: name, json: parseDataLiteral(lit) }); } catch { /* often an IIFE/non-JSON → skip */ }
  }
  // Bare application/json blocks (some SPAs, e.g. Apollo/Relay) — only parse the big ones.
  for (const m of src.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    if (m[1].length < 200 || /id=["']__NEXT_DATA__["']/i.test(m[0])) continue;
    try { const j = JSON.parse(m[1]); blobs.push({ pattern: 'application/json', json: j }); } catch { /* skip */ }
    if (blobs.length > 12) break;
  }
  return blobs;
}

/**
 * Extract products from a hydrated SPA page. Returns { products, pattern } where
 * `pattern` names the embedded-state shape that matched (or null). Deduped by URL
 * (falling back to name) and capped.
 */
export function extractSpaProducts(html, baseUrl, { max = 500 } = {}) {
  const blobs = parseStateBlobs(html);
  const seen = new Set(); const products = []; let pattern = null;
  for (const b of blobs) {
    const arrays = findProductArrays(b.json);
    if (!arrays.length) continue;
    for (const arr of arrays) for (const it of arr) {
      const card = mapItem(it, baseUrl);
      if (!card.name || card.price == null) continue;
      const key = card.sourceUrl || card.name;
      if (seen.has(key)) continue; seen.add(key);
      products.push(card);
      if (!pattern) pattern = b.pattern;
      if (products.length >= max) return { products, pattern };
    }
  }
  return { products, pattern };
}

/**
 * Markdown fallback — when no state pattern matched, parse a provider's markdown
 * listing (Bright Data data_format:'markdown' / Firecrawl `markdown`). Generic: a
 * product is a `[name](url)` link followed within a few lines by a price token
 * ($/€/£ + digits). Deduped by URL, capped.
 */
export function extractMarkdownProducts(markdown, baseUrl, { max = 500 } = {}) {
  const lines = String(markdown || '').split('\n');
  const products = []; const seen = new Set();
  // A markdown link OR image-link on the line: `[text](url)` / `![alt](img)`.
  const linkRe = /(!)?\[([^\]]{2,140})\]\(([^)\s]+)/g;
  const priceRe = /(?:[$€£]\s?|\bEUR\b|\bUSD\b|\bGBP\b)\s?(\d{1,5}(?:[.,]\d{2})?)|(\d{1,5}(?:[.,]\d{2}))\s?(?:€|EUR|USD|GBP|\$)/;
  const CTA = /^(learn more|shop now|see more|view (all|more)|read more|add to (cart|bag)|free delivery|sign in|log ?in|register|buy now|discover|explore|next|previous|home|menu|search|filter|sort)\b/i;
  const isImg = (u) => /\.(jpe?g|png|webp|avif|gif|svg)(\?|$)|\/is\/image|\/image[s]?\//i.test(u);
  const urlRe = /\]\(([^)\s]+)\)/g; // any ](url) — also catches the outer link of [![alt](img)](producturl)
  for (let i = 0; i < lines.length && products.length < max; i++) {
    let mm, name = null, url = null;
    linkRe.lastIndex = 0;
    while ((mm = linkRe.exec(lines[i]))) {
      const alt = mm[2].replace(/^[![\s]+/, '').replace(/[\]\s]+$/, '').trim();
      if (alt && alt.length >= 3 && /[a-zA-Z]/.test(alt) && !CTA.test(alt) && !/^https?:\/\//i.test(alt)) { name = alt; break; }
    }
    if (!name) continue;
    urlRe.lastIndex = 0; let um;
    while ((um = urlRe.exec(lines[i]))) { const u = um[1]; if (/^(https?:|\/)/.test(u) && !isImg(u)) { url = u; break; } } // first non-image product URL
    let price = null;
    for (let j = i; j <= i + 6 && j < lines.length; j++) { const pm = lines[j].match(priceRe); if (pm) { price = parseFloat((pm[1] || pm[2]).replace(',', '.')); break; } }
    if (price == null || !(price > 0)) continue; // "0 €" next to a filter is not a product price
    const abs = url ? (absoluteUrl(url, baseUrl) || url) : null;
    const key = abs || 'name:' + name.toLowerCase();
    if (seen.has(key)) continue; seen.add(key);
    const card = { strategy: 'spa-markdown', name, price };
    if (abs) { card.sourceUrl = abs; card.canonicalUrl = abs; }
    products.push(card);
  }
  return { products, pattern: products.length ? 'markdown' : null };
}
