/**
 * Product images — ONE contract for the app, the extension, the recipes, the panel preview and the
 * Converter pivot:
 *
 *   ProductImage = { url: string, alt?: string, width?: number, height?: number, position: number,
 *                    source: 'jsonld'|'microdata'|'og'|'dom'|'state'|'listing'|'rule'|'row', attr?: string }
 *
 * Rows (RawProduct / NormalizedProduct / products.json / CSV) carry the SERIALISED form `images: string[]`
 * (= imageUrls(ProductImage[]): ordered, deduplicated, absolute). Everything in between — extractors,
 * readers, the taught rules, the panel preview — handles ProductImage objects, so a preview never prints
 * a property that does not exist and a CSV never receives a piece of a URL.
 *
 * Rules that never change:
 *   • a `srcset` is parsed as the HTML specification says (a candidate = URL + descriptors; the separator
 *     is a comma followed by whitespace or a comma after a descriptor — never a comma inside a URL);
 *   • a string holding several URLs is split only before a new URL (scheme or "//"), on a newline, or on
 *     ";" / "|" / ", " between URLs — never on a bare comma (Cloudinary paths: "c_lpad,w_iw,h_ih");
 *   • a URL is absolute (resolved against the page), http(s) only, HTML entities decoded, commas kept;
 *   • the same picture in several sizes is ONE image (canonical key), the largest known size kept, in the
 *     order of first appearance, the main picture first;
 *   • an address that is not a usable image URL is rejected WITH a reason — never exported silently.
 *
 * PORTABLE: zero DOM, zero Node built-ins (the app, the extension and the tests share it as is).
 */

export const IMAGE_SOURCES = ['jsonld', 'microdata', 'og', 'dom', 'state', 'listing', 'rule', 'row'];
/** Reliability order of the sources when several give the same picture (first = most reliable). */
export const SOURCE_RANK = { jsonld: 0, microdata: 1, og: 2, dom: 3, state: 4, rule: 5, listing: 6, row: 7 };

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

// ---- srcset -----------------------------------------------------------------------------------------

/**
 * Parse a `srcset` attribute as the HTML specification does ("parse a srcset attribute"): a URL is a run of
 * non-whitespace characters (commas INSIDE it are part of it), a trailing comma ends it, else the descriptors
 * run until the next comma. "a.jpg 320w, b.jpg 640w" → two candidates; a Cloudinary URL with commas in its
 * path stays whole.
 * @param {string} input
 * @returns {Array<{url:string, w:number|null, x:number|null, h:number|null}>}
 */
export function parseSrcset(input) {
  const s = String(input == null ? '' : input);
  const out = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && (isSpace(s[i]) || s[i] === ',')) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !isSpace(s[i])) i++;
    let url = s.slice(start, i);
    let descriptors = '';
    if (/,$/.test(url)) url = url.replace(/,+$/, '');
    else {
      let inParen = false; let d = '';
      while (i < n) {
        const c = s[i];
        if (c === '(') inParen = true; else if (c === ')') inParen = false;
        if (c === ',' && !inParen) { i++; break; }
        d += c; i++;
      }
      descriptors = d;
    }
    if (!url) continue;
    const cand = { url, w: null, x: null, h: null };
    for (const tok of descriptors.trim().split(/\s+/).filter(Boolean)) {
      const m = /^(\d+(?:\.\d+)?)([wxh])$/i.exec(tok);
      if (!m) continue;
      const v = Number(m[1]); const k = m[2].toLowerCase();
      if (k === 'w') cand.w = v; else if (k === 'x') cand.x = v; else cand.h = v;
    }
    out.push(cand);
  }
  return out;
}

/** The URL of the largest candidate of a srcset (by width, else density, else height); null when none. */
export function bestFromSrcset(ss) {
  let best = null; let score = -1;
  for (const c of parseSrcset(ss)) {
    if (!c.url || /^data:/i.test(c.url)) continue;
    const sc = c.w != null ? c.w : (c.x != null ? c.x * 1000 : (c.h != null ? c.h : 0));
    if (sc > score) { best = c.url; score = sc; }
  }
  return best;
}

/** Does a string look like a srcset rather than one URL? ("a.jpg 320w, b.jpg 640w", "a.jpg 1x, b.jpg 2x") */
export const looksLikeSrcset = (s) => /\S\s+\d+(?:\.\d+)?[wxh](?:\s*,|\s*$)/i.test(String(s || ''));

// ---- lists of URLs ----------------------------------------------------------------------------------

const URL_START = /(?:https?:\/\/|\/\/[^/\s])/i;
const SCHEME_SPLIT = /(?:^|[\s,;|]+)(?=(?:https?:\/\/|\/\/[^/\s]))/i;
const PATH_SPLIT = /\s*[;|]\s*(?=\/|\.\/)|,\s+(?=\/|\.\/)/;

/**
 * The URLs of a string that holds several (a CSV cell, a feed field): split only before a new URL, on a
 * newline, or on ";" / "|" / ", " when the next part is a path — never on a bare comma inside a URL.
 * With `sep` (a format's declared separator), that separator splits only when the next part starts a URL
 * or a path, so a Cloudinary path never breaks on its commas.
 * @param {string|string[]} value  @param {{sep?:string}} [o]
 * @returns {string[]}
 */
export function splitUrlList(value, { sep = null } = {}) {
  if (Array.isArray(value)) return value.flatMap((v) => splitUrlList(v, { sep }));
  const s = String(value == null ? '' : value).trim();
  if (!s) return [];
  const out = [];
  const push = (p) => { const t = String(p).trim().replace(/^[\s,;|]+|[\s,;|]+$/g, ''); if (t) out.push(t); };
  for (const line of s.split(/\r?\n/)) {
    for (const part of line.split(SCHEME_SPLIT)) {
      if (!part.trim()) continue;
      const pieces = PATH_SPLIT.test(part) ? part.split(PATH_SPLIT) : [part];
      for (const piece of pieces) {
        if (sep && sep !== ',' && sep !== '\n') {
          // The format's own separator between two paths (";" in a Wix cell): a path never contains it.
          const esc = sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`\\s*${esc}\\s*(?=\\/|\\.\\/|${URL_START.source})`, 'i');
          for (const q of piece.split(re)) push(q);
        } else push(piece);
      }
    }
  }
  return out;
}

// ---- normalisation ----------------------------------------------------------------------------------

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** HTML entities in an attribute value or a JSON string ("&amp;" → "&", "&#x2F;" → "/"). */
export function decodeEntities(s) {
  let v = String(s == null ? '' : s);
  for (let i = 0; i < 2 && /&(?:#x?[0-9a-f]+|[a-z]+);/i.test(v); i++) {
    v = v.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') { const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m; }
      const k = e.toLowerCase(); return k in ENTITY ? ENTITY[k] : m;
    });
  }
  return v;
}

/**
 * One usable image URL from a value: trimmed, entities decoded, resolved against `base` (relative and
 * protocol-relative), http(s) only, fragment dropped, spaces and unicode percent-encoded by the URL parser,
 * commas kept. null when it is not an http(s) address (data:, blob:, empty, unparsable).
 * @param {string} value  @param {string|null} [base]
 */
export function normalizeImageUrl(value, base = null) {
  if (value == null) return null;
  let s = decodeEntities(String(value)).trim().replace(/[\u0000-\u001f]/g, '');
  if (!s) return null;
  if (/^(data|blob|javascript|about|mailto|tel):/i.test(s)) return null;
  if (s.startsWith('//')) s = 'https:' + s;
  let url;
  try { url = base ? new URL(s, base) : new URL(s); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  return url.href;
}

// ---- canonical key (same picture, other size = same key) ----------------------------------------------

const IMG_EXT = /\.(jpe?g|png|webp|gif|avif|bmp|tiff?|svg)$/i;
// A path segment made only of transformation tokens, the way image CDNs write a rendition in the path
// ("c_fill,w_500,q_auto", "e_trim:EAEEEF", "fee_786_587_png"): neither a directory nor a file name.
const TOKEN = '(?:[a-z]{1,3}_[a-z0-9:._-]+|[a-z]{1,3}:[a-z0-9:._-]+)';
const TRANSFORM_SEGMENT = new RegExp(`^${TOKEN}(?:,${TOKEN})*$`, 'i');
export const isTransformSegment = (seg) => !!seg && !IMG_EXT.test(seg) && TRANSFORM_SEGMENT.test(seg);
// Size words and dimensions in a file or directory name ("…-home_default", "-large", "800x800").
const SIZE_WORD = /(^|[-_.])(thumbnail|thumbs?|small|medium|large|big|home|cart|zoom|default|mini|xs|sm|md|lg|xl|xxl|original|full|hd|\d{2,4}x\d{2,4})(?=$|[-_.])/gi;
// Shopify's size suffix before the extension ("foo_600x600.jpg", "foo_1024x.jpg", "foo_large.jpg", "foo_600x_crop_center.jpg").
const SHOPIFY_SIZE = /_(?:\d{1,4}x\d{0,4}|x\d{1,4}|pico|icon|thumb|small|compact|medium|large|grande|original|master)(?:_crop_[a-z]+)?(?=\.[a-z0-9]{2,5}$)/i;
// Query parameters that only choose a rendition (size, format, quality, cache version), never the picture.
const SIZE_PARAMS = /^(?:w|h|width|height|size|sz|dim|format|fm|fmt|quality|q|v|ver|version|dpr|fit|crop|scale|scalewidth|scaleheight|scalemode|x|y|ex|ey|resize|imwidth|imheight|im|auto|resizesource|unsharp|sharpen|strip|trim|align|sp|bg|bgcolor|cs|ch|cache|t|ts|_|wid|hei|qlt|op_sharpen|fmt|impolicy|imdensity|ixlib|fill|f|s|imgeng|anchor|mode|upscale|rect|zoom)$/i;

/**
 * The identity of a picture whatever its rendition: host + path without transformation segments, size
 * words and Shopify suffixes; the query dropped when the path names a file, else kept without its size
 * parameters (an image served by id: "/image?id=42&w=500" keeps id).
 */
export function imageKey(u) {
  let x; try { x = new URL(String(u)); } catch { return String(u || '').trim().toLowerCase(); }
  const raw = x.pathname.split('/').filter(Boolean);
  const file = raw.length ? raw[raw.length - 1] : '';
  const segs = raw.filter((s) => !isTransformSegment(s)).map((s) => s.replace(SHOPIFY_SIZE, '').replace(SIZE_WORD, '').replace(/^[-_.]+|[-_.]+$/g, '')).filter(Boolean);
  let query = '';
  if (!IMG_EXT.test(file)) {
    const kept = [...x.searchParams.entries()].filter(([k]) => !SIZE_PARAMS.test(k)).sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
    if (kept.length) query = '?' + kept.map(([k, v]) => `${k}=${v}`).join('&');
  }
  return `${x.host.replace(/^www\./, '')}/${segs.join('/')}${query}`.toLowerCase();
}

/**
 * The largest rendition an address is KNOWN to have: a Shopify-shaped file ("…/files/…/pull_600x600.jpg",
 * "…/products/…/pull_large.jpg") always exists without its size suffix — that is the original. Nothing else
 * is rewritten: a query-driven resizer (w=, width=) may require its parameter, so the largest candidate seen
 * is kept instead (dedupeImages).
 */
export function upgradeRendition(u) {
  const s = String(u || '');
  if (!/\/(?:files|products|collections)\//i.test(s)) return s;
  try {
    const x = new URL(s);
    const segs = x.pathname.split('/');
    const file = segs[segs.length - 1] || '';
    if (!SHOPIFY_SIZE.test(file)) return s;
    segs[segs.length - 1] = file.replace(SHOPIFY_SIZE, '');
    x.pathname = segs.join('/');
    return x.href;
  } catch { return s; }
}

const SIZE_RANK = [[/original|full|zoom|hd|xxl|master|grande/i, 4000], [/\bxl\b|large|big|lg/i, 1600], [/medium|md|home|default|compact/i, 700], [/small|thumb|mini|cart|xs|sm|pico|icon|plp/i, 200]];
/**
 * How large a rendition is, as far as its address says (pixels of the longest side): explicit dimensions in
 * the path or the query, else a size word, else 1000 (unknown = neither small nor large).
 */
export function imageSize(u) {
  const s = String(u || '');
  let path = s; let query = '';
  try { const x = new URL(s); path = decodeURIComponent(x.pathname); query = x.search; } catch { /* keep the string */ }
  let best = 0;
  const take = (n) => { const v = Number(n); if (Number.isFinite(v) && v > best) best = v; };
  for (const m of path.matchAll(/(\d{2,4})x(\d{2,4})/g)) take(Math.max(Number(m[1]), Number(m[2])));
  for (const m of path.matchAll(/(?:^|[/,_-])(?:w|h|width|height)_(\d{2,5})(?=$|[/,._-])/gi)) take(m[1]);
  for (const m of path.matchAll(/_(\d{2,4})x(?=\.|_crop)/gi)) take(m[1]);
  for (const m of query.matchAll(/[?&](?:w|h|width|height|scalewidth|scaleheight|wid|hei|imwidth|imheight|x|y|size|ex|ey)=(\d{2,5})(?=&|$)/gi)) take(m[1]);
  if (best) return best;
  const words = path.replace(/[-_]/g, ' ');
  for (const [re, r] of SIZE_RANK) if (re.test(words)) return r;
  return 1000;
}

// ---- validation -------------------------------------------------------------------------------------

export const REJECT_LABEL = {
  invalid_url: 'adresse invalide',
  scheme: 'adresse qui n’est pas en http(s)',
  data_uri: 'image incorporée (data:), pas une adresse',
  no_path: 'adresse sans chemin d’image',
  transform_segment: 'adresse tronquée : elle s’arrête sur un segment de transformation',
  video_poster: 'image d’aperçu d’une vidéo, pas une photo du produit (le produit a ses photos)',
};

/**
 * Is this a usable image address? Parsable, http(s), with a path, and not cut on a transformation segment
 * (".../e_trim:EAEEEF/c_lpad" is the beginning of a Cloudinary address, not an image).
 * @returns {{ok:true}|{ok:false, reason:string, label:string}}
 */
export function validateImageUrl(u) {
  const bad = (reason) => ({ ok: false, reason, label: REJECT_LABEL[reason] });
  if (typeof u !== 'string' || !u.trim()) return bad('invalid_url');
  if (/^data:/i.test(u.trim())) return bad('data_uri');
  let x; try { x = new URL(u.trim()); } catch { return bad('invalid_url'); }
  if (x.protocol !== 'http:' && x.protocol !== 'https:') return bad('scheme');
  const segs = x.pathname.split('/').filter(Boolean);
  if (!segs.length && !x.search) return bad('no_path');
  const last = segs[segs.length - 1] || '';
  // A path that ENDS on a transformation list without any content segment before it ("…/images/e_trim:X/c_lpad")
  // is the beginning of an address, cut. A rendition segment AFTER a content id ("…/ASSET_123456/fee_786_587_png")
  // is a complete address: the id names the picture.
  if (isTransformSegment(last) || /,$/.test(last)) {
    const content = segs.slice(0, -1).some((s) => !isTransformSegment(s) && (IMG_EXT.test(s) || (/\d/.test(s) && s.length >= 6)));
    if (!content) return bad('transform_segment');
  }
  return { ok: true };
}

/** A still frame of a video ("/videos/…", "…_video.jpg"): a picture, but not a product photograph. */
export const isVideoPoster = (u) => { try { const p = new URL(u).pathname; return /\/videos?\//i.test(p) || /[_-]video(?:[_-]?\d+)?\.[a-z0-9]{2,5}$/i.test(p); } catch { return false; } };

// ---- the contract ----------------------------------------------------------------------------------

/**
 * One ProductImage. `url` is already normalised (see normalizeImageUrl); other fields optional.
 * @param {{url:string, alt?:string|null, width?:number|null, height?:number|null, source?:string, attr?:string|null}} o
 * @param {number} position 1-based
 */
export function productImage(o, position = 1) {
  const out = { url: String(o.url), position: Number(position) || 1, source: IMAGE_SOURCES.includes(o.source) ? o.source : 'row' };
  if (o.alt != null && String(o.alt).trim()) out.alt = String(o.alt).replace(/\s+/g, ' ').trim().slice(0, 300);
  const w = Number(o.width); const h = Number(o.height);
  if (Number.isFinite(w) && w > 0) out.width = Math.round(w);
  if (Number.isFinite(h) && h > 0) out.height = Math.round(h);
  if (o.attr) out.attr = String(o.attr).slice(0, 40);
  return out;
}

/** A ProductImage of this contract (url + position + source); a schema.org ImageObject with a `url` is not one. */
export const isProductImage = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.url === 'string' && typeof v.position === 'number' && typeof v.source === 'string';
const hasUrl = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.url === 'string';

const OBJ_URL_KEYS = ['url', 'src', 'contentUrl', 'href', 'image', 'imageUrl', 'thumbnailUrl', 'large', 'zoom', 'original', 'full', 'squarish', 'portrait'];
const OBJ_ALT_KEYS = ['alt', 'altText', 'caption', 'name', 'description', 'title'];

/**
 * ProductImage[] from whatever a source gives: a string (one URL, a srcset, or several URLs), an object
 * (schema.org ImageObject, {src}, {href}, a CDN entry), an array of those, or ProductImage objects already.
 * Every URL is normalised against `base`; what is not a usable image address is listed in `rejected` with
 * its reason (never dropped silently).
 * @param {any} input  @param {{base?:string|null, source?:string}} [o]
 * @returns {{ images: ProductImage[], rejected: Array<{url:string, reason:string, label:string}> }}
 */
export function toProductImages(input, { base = null, source = 'row' } = {}) {
  const images = []; const rejected = [];
  const seen = new Set();
  const add = (raw, meta = {}) => {
    const str = typeof raw === 'string' ? raw : '';
    const normalised = normalizeImageUrl(str, base);
    const norm = normalised ? upgradeRendition(normalised) : null;
    const v = norm ? validateImageUrl(norm) : { ok: false, reason: /^data:/i.test(str.trim()) ? 'data_uri' : 'invalid_url', label: REJECT_LABEL[/^data:/i.test(str.trim()) ? 'data_uri' : 'invalid_url'] };
    if (!v.ok) { rejected.push({ url: String(str).slice(0, 500), reason: v.reason, label: v.label }); return; }
    if (seen.has(norm)) return; seen.add(norm);
    images.push(productImage({ ...meta, url: norm, source: meta.source || source }, images.length + 1));
  };
  const walk = (v, depth) => {
    if (v == null || depth > 4) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === 'string') {
      const s = v.trim(); if (!s) return;
      if (looksLikeSrcset(s)) { const b = bestFromSrcset(s); if (b) add(b); return; }
      const parts = splitUrlList(s);
      if (parts.length > 1) { for (const p of parts) add(p); return; }
      add(s); return;
    }
    if (typeof v !== 'object') return;
    if (isProductImage(v)) { add(v.url, { alt: v.alt, width: v.width, height: v.height, source: IMAGE_SOURCES.includes(v.source) ? v.source : source, attr: v.attr }); return; }
    const alt = OBJ_ALT_KEYS.map((k) => v[k]).find((x) => typeof x === 'string' && x.trim()) || null;
    for (const k of OBJ_URL_KEYS) {
      const x = v[k];
      if (typeof x === 'string' && x.trim()) { add(x, { alt, width: v.width, height: v.height }); return; }
      if (x && typeof x === 'object' && !Array.isArray(x)) { const before = images.length + rejected.length; walk(x, depth + 1); if (images.length + rejected.length > before) return; }
    }
    if (Array.isArray(v.images)) walk(v.images, depth + 1);
  };
  walk(input, 0);
  return { images, rejected };
}

/** The serialised form: the URLs, in order. Accepts ProductImage[] or string[] (older rows). */
export function imageUrls(images) {
  if (!Array.isArray(images)) return [];
  return images.map((i) => (typeof i === 'string' ? i : (hasUrl(i) ? i.url : null))).filter(Boolean);
}

/**
 * One image per picture: the same picture in several sizes (canonical key) is kept once, at the place of
 * its first appearance, in its largest known size (a larger rendition replaces the URL, the first source's
 * alt and source are kept); positions renumbered. Different pictures are never merged.
 * @param {ProductImage[]} images
 */
export function dedupeImages(images) {
  const at = new Map(); const out = [];
  for (const im of images || []) {
    if (!hasUrl(im)) continue;
    const k = imageKey(im.url);
    if (!at.has(k)) { at.set(k, out.length); out.push({ ...im }); continue; }
    const i = at.get(k); const cur = out[i];
    if (imageSize(im.url) > imageSize(cur.url)) out[i] = { ...cur, url: im.url, ...(im.width ? { width: im.width } : {}), ...(im.height ? { height: im.height } : {}), ...(!cur.alt && im.alt ? { alt: im.alt } : {}) };
    else if (!cur.alt && im.alt) out[i] = { ...cur, alt: im.alt };
  }
  return out.map((im, i) => ({ ...im, position: i + 1 }));
}

/**
 * Merge the images of several sources in reliability order (JSON-LD, then microdata and og:image, then the
 * DOM gallery, then the embedded state…): each source's list is normalised and validated, the union is
 * deduplicated by picture, and the main picture (first of the most reliable source) stays first.
 * @param {Array<{source:string, items:any}>} sources  @param {{base?:string|null}} [o]
 * @returns {{ images: ProductImage[], rejected: Array<{source:string, url:string, reason:string, label:string}>, bySource: Object<string,number> }}
 */
export function mergeImageSources(sources, { base = null } = {}) {
  const all = []; const rejected = []; const bySource = {};
  const ordered = [...(sources || [])].filter((s) => s && s.items != null).sort((a, b) => (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9));
  for (const s of ordered) {
    const r = toProductImages(s.items, { base, source: s.source });
    bySource[s.source] = r.images.length;
    all.push(...r.images);
    rejected.push(...r.rejected.map((x) => ({ source: s.source, ...x })));
  }
  let images = dedupeImages(all);
  // A video's still frame is not a product photograph: set aside (listed, with its reason) when the product has photos.
  const posters = images.filter((im) => isVideoPoster(im.url));
  if (posters.length && posters.length < images.length) {
    images = images.filter((im) => !isVideoPoster(im.url)).map((im, i) => ({ ...im, position: i + 1 }));
    rejected.push(...posters.map((im) => ({ source: im.source, url: im.url, reason: 'video_poster', label: REJECT_LABEL.video_poster })));
  }
  return { images, rejected, bySource };
}

/** The string[] of a row (any of the accepted shapes) normalised, validated and deduplicated — plus the rejections. */
export function normalizeRowImages(list, { base = null, source = 'row' } = {}) {
  const r = toProductImages(list, { base, source });
  return { urls: imageUrls(dedupeImages(r.images)), rejected: r.rejected };
}
