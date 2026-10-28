/**
 * Product GROUP extractor — reads, from the JSON a product page embeds (hydration
 * state, JSON islands, JSON-LD), the SHAPE of a product sold in several colours
 * and sizes:
 *
 *   colourway = { colour code, colour name, sizes[{label, EAN?}], images[], prices }
 *
 * plus the model's description, brand, gender/category labels and product type.
 * It keys on the shape (synonym lists for each role), never on a site: any page
 * whose state carries "a colour-coded object with a colour name and a list of
 * sized items" is recognised, whatever its framework or field spelling.
 *
 * Also reads schema.org `ProductGroup` / `Product.hasVariant` (JSON-LD), grouping
 * the variants by colour.
 *
 * Nothing is invented: a field absent from the data stays absent. Sizes carry an
 * EAN only when the page states a valid one (8/12/13/14 digits).
 *
 * PORTABLE: zero Node built-ins, zero dependencies.
 */

import { parseDataLiteral } from './js-literal.mjs';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : (typeof v === 'number' && Number.isFinite(v) ? String(v) : null));
const lc = (k) => String(k).toLowerCase();

// ---- role synonyms (lower-case keys) ----
const CODE_KEYS = ['stylecolor', 'stylecolour', 'colorcode', 'colourcode', 'colorwaycode', 'colorwayid', 'colourwaycode', 'variantcode', 'colorid', 'colourid', 'swatchcode'];
const COLOR_KEYS = ['colordescription', 'colourdescription', 'colorname', 'colourname', 'colorlabel', 'colourlabel', 'colordisplayname', 'color', 'colour', 'couleur', 'farbe', 'kleur'];
const SIZE_LIST_KEYS = ['sizes', 'availablesizes', 'sizeoptions', 'sizelist', 'skus', 'size_variants', 'sizevariants'];
const SIZE_LABEL_KEYS = ['localizedlabel', 'label', 'size', 'sizelabel', 'sizename', 'displaysize', 'name', 'value', 'taille'];
const GTIN_KEYS = ['gtin', 'gtin13', 'gtin14', 'gtin12', 'gtin8', 'ean', 'ean13', 'barcode', 'upc'];

/**
 * GS1 mod-10 check-digit validation for an EAN/UPC/GTIN (8/12/13/14 digits). A barcode is NEVER
 * invented, only accepted when it checksums. Weights the rightmost DATA digit by 3, alternating
 * outward, so one routine covers every GTIN length. Portable: the app and the extension share it.
 * @param {string|number} value
 * @returns {boolean}
 */
export function isValidGtin(value) {
  const d = String(value == null ? '' : value).replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(d.length)) return false;
  const nums = d.split('').map(Number);
  const check = nums.pop();
  let sum = 0;
  for (let i = nums.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += nums[i] * w;
  return ((10 - (sum % 10)) % 10) === check;
}
const IMAGE_KEYS = /(image|images|media|gallery|photo|picture|contentimages|assets)$/i;
const IMAGE_URL_KEYS = ['squarish', 'square', 'url', 'src', 'href', 'portrait', 'large', 'zoom', 'original', 'full'];
const CURRENT_PRICE_KEYS = ['currentprice', 'saleprice', 'finalprice', 'offerprice', 'sellingprice', 'price', 'value', 'amount'];
const INITIAL_PRICE_KEYS = ['initialprice', 'fullprice', 'listprice', 'originalprice', 'regularprice', 'compareatprice', 'wasprice', 'retailprice', 'strikethroughprice'];
const DESC_KEYS = ['productdescription', 'longdescription', 'description', 'descriptionlong', 'detaileddescription'];
const TITLE_KEYS = ['title', 'name', 'productname', 'displayname'];
const SUBTITLE_KEYS = ['subtitle', 'subheading', 'tagline'];
const BRAND_KEYS = ['brand', 'brandname', 'brands', 'manufacturer'];
const GENDER_KEYS = ['genders', 'gender', 'genre', 'targetgroup', 'department'];

/** First value of `o` whose key (case-insensitive) is in `keys`, in `keys` order. */
function pickKey(o, keys) {
  if (!isObj(o)) return undefined;
  const map = new Map(Object.keys(o).map((k) => [lc(k), k]));
  for (const k of keys) if (map.has(k)) { const v = o[map.get(k)]; if (v != null && v !== '') return v; }
  return undefined;
}

function digitsGtin(v) {
  const s = String(v == null ? '' : v).replace(/\D/g, '');
  return [8, 12, 13, 14].includes(s.length) ? s : null;
}
function gtinOf(o) {
  if (!isObj(o)) return null;
  const direct = pickKey(o, GTIN_KEYS);
  if (direct != null && typeof direct !== 'object') return digitsGtin(direct);
  for (const k of Object.keys(o)) {
    if (!/^(gtins|eans|barcodes|upcs)$/i.test(k) || !Array.isArray(o[k])) continue;
    for (const g of o[k]) { const d = isObj(g) ? digitsGtin(pickKey(g, GTIN_KEYS)) : digitsGtin(g); if (d) return d; }
  }
  return null;
}

/** "EU 35.5" when the size carries a localized label + prefix, else its plain label. */
function sizeLabel(s) {
  if (!isObj(s)) return str(s);
  const loc = str(pickKey(s, ['localizedlabel', 'localizedsize']));
  const pre = str(pickKey(s, ['localizedlabelprefix', 'sizeprefix', 'sizesystem']));
  if (loc) return pre ? `${pre} ${loc}` : loc;
  const v = pickKey(s, SIZE_LABEL_KEYS.filter((k) => k !== 'localizedlabel'));
  return isObj(v) ? str(pickKey(v, ['name', 'label', 'value'])) : str(v);
}

/** A list of sized items (≥1 item with a size label). */
function sizeListOf(o) {
  if (!isObj(o)) return null;
  for (const k of Object.keys(o)) {
    if (!SIZE_LIST_KEYS.includes(lc(k))) continue;
    const arr = o[k];
    if (!Array.isArray(arr) || !arr.length) continue;
    const sizes = [];
    for (const it of arr) {
      const label = sizeLabel(it);
      if (!label || label.length > 40) continue;
      const out = { label };
      const g = gtinOf(it); if (g) out.gtin = g;
      // Stock is NOT read from a lifecycle status ("ACTIVE"): only an explicit flag.
      if (isObj(it)) {
        const av = pickKey(it, ['available', 'instock', 'isavailable', 'availability', 'stockstatus']);
        if (typeof av === 'boolean') out.available = av;
        else if (typeof av === 'string' && /^(in_?stock|instock|available|out_?of_?stock|outofstock|soldout|sold_out)$/i.test(av.replace(/^https?:\/\/schema\.org\//i, ''))) out.available = /^(in_?stock|instock|available)$/i.test(av.replace(/^https?:\/\/schema\.org\//i, ''));
      }
      sizes.push(out);
    }
    if (sizes.length) {
      // Dedupe by label (a size listed twice).
      const seen = new Set(); return sizes.filter((s) => (seen.has(s.label) ? false : (seen.add(s.label), true)));
    }
  }
  return null;
}

const IMG_URL_RE = /^https?:\/\/[^\s"']+$/i;
const looksImage = (u) => IMG_URL_RE.test(u) && (/\.(jpe?g|png|webp|avif|gif)(\?|$)/i.test(u) || /\/(images?|img|media|photos?|assets?)\//i.test(u));
/** The best single image URL inside one gallery entry (string or object). */
function imageFromEntry(e, depth = 0) {
  if (typeof e === 'string') return looksImage(e) ? e : null;
  if (!isObj(e) || depth > 4) return null;
  for (const k of IMAGE_URL_KEYS) {
    const v = pickKey(e, [k]);
    if (typeof v === 'string' && looksImage(v)) return v;
    if (isObj(v)) { const u = imageFromEntry(v, depth + 1); if (u) return u; }
  }
  for (const k of Object.keys(e)) { if (/video|thumbnail|swatch|icon|logo/i.test(k)) continue; const v = e[k]; if (isObj(v)) { const u = imageFromEntry(v, depth + 1); if (u) return u; } }
  return null;
}
/** Gallery of one colourway: one URL per entry, in order, deduped. */
function galleryOf(o) {
  const out = [];
  if (!isObj(o)) return out;
  for (const k of Object.keys(o)) {
    if (!IMAGE_KEYS.test(k) || /swatch|thumbnail|icon|logo/i.test(k)) continue;
    const v = o[k];
    const list = Array.isArray(v) ? v : (isObj(v) ? [v] : (typeof v === 'string' ? [v] : []));
    for (const e of list) {
      if (isObj(e) && /video/i.test(String(pickKey(e, ['cardtype', 'type', 'mediatype']) || ''))) continue;
      const u = imageFromEntry(e); if (u && !out.includes(u)) out.push(u);
      if (out.length >= 20) return out;
    }
  }
  return out;
}

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\s*\d+(?:[.,]\d+)?\s*$/.test(v)) return Number(v.replace(',', '.'));
  return null;
}
/** {price, listPrice, currency} from a prices sub-object or the object itself. */
function pricesOf(o) {
  if (!isObj(o)) return {};
  const sub = pickKey(o, ['prices', 'pricing', 'price', 'priceinfo']);
  const src = isObj(sub) ? sub : o;
  const cur = (() => { const v = pickKey(src, CURRENT_PRICE_KEYS); return isObj(v) ? num(pickKey(v, ['value', 'amount'])) : num(v); })();
  const ini = (() => { const v = pickKey(src, INITIAL_PRICE_KEYS); return isObj(v) ? num(pickKey(v, ['value', 'amount'])) : num(v); })();
  const currency = str(pickKey(src, ['currency', 'currencycode', 'pricecurrency'])) || str(pickKey(o, ['currency', 'currencycode', 'pricecurrency']));
  const out = {};
  if (cur != null) out.price = cur;
  if (ini != null && cur != null && ini > cur) out.listPrice = ini; // a real reduction only
  if (currency && /^[A-Z]{3}$/.test(currency)) out.currency = currency;
  return out;
}

const stripHtml = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
/** A shallow search (depth ≤ 3) for the first string under any of `keys`. */
function deepStr(o, keys, { min = 1, depth = 3 } = {}) {
  if (!isObj(o) || depth < 0) return null;
  const v = pickKey(o, keys);
  if (typeof v === 'string' && v.trim().length >= min) return v.trim();
  for (const k of Object.keys(o)) { const c = o[k]; if (isObj(c)) { const r = deepStr(c, keys, { min, depth: depth - 1 }); if (r) return r; } }
  return null;
}
/** Strings from a value that may be a string, an array of strings, or an array of {name|label}. */
function labels(v) {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'string' ? x.trim() : (isObj(x) ? str(pickKey(x, ['name', 'label', 'value', 'displayname'])) : null))).filter(Boolean);
}
function deepLabels(o, keys, depth = 2) {
  if (!isObj(o) || depth < 0) return [];
  const v = pickKey(o, keys);
  const got = labels(v);
  if (got.length) return got;
  for (const k of Object.keys(o)) { const c = o[k]; if (isObj(c)) { const r = deepLabels(c, keys, depth - 1); if (r.length) return r; } }
  return [];
}

/** Is `o` a colourway (code + colour name + sizes or images)? → normalized colourway. */
function asColourway(o) {
  if (!isObj(o)) return null;
  const code = str(pickKey(o, CODE_KEYS));
  const colorRaw = pickKey(o, COLOR_KEYS);
  const color = typeof colorRaw === 'string' ? colorRaw.trim() : (isObj(colorRaw) ? str(pickKey(colorRaw, ['name', 'label', 'description'])) : null);
  if (!code || !color || /^#?[0-9a-f]{6}$/i.test(color)) return null;
  const sizes = sizeListOf(o);
  const images = galleryOf(o);
  if (!sizes && !images.length) return null;
  const cw = { code, color, sizes: sizes || [], images, ...pricesOf(o) };
  const desc = deepStr(o, DESC_KEYS, { min: 20 }); if (desc) cw.description = stripHtml(desc);
  const title = deepStr(o, TITLE_KEYS, { min: 2, depth: 2 }); if (title) cw.title = title;
  const sub = deepStr(o, SUBTITLE_KEYS, { min: 2, depth: 2 }); if (sub) cw.subtitle = sub;
  const brands = deepLabels(o, BRAND_KEYS); if (brands.length) cw.brand = brands[0];
  const genders = deepLabels(o, GENDER_KEYS).filter((g) => !/^\d+$/.test(g)); if (genders.length) cw.genders = genders;
  const type = str(pickKey(o, ['producttype', 'type', 'category'])); if (type && !/^(image|video|product)$/i.test(type)) cw.productType = type;
  const url = str(pickKey(o, ['url', 'pdpurl', 'producturl', 'link'])) || (isObj(pickKey(o, ['pdpurl'])) ? str(pickKey(pickKey(o, ['pdpurl']), ['url', 'path'])) : null);
  if (url) cw.url = url;
  return cw;
}

/** Walk a JSON value; collect every colourway (deduped by code; richest wins) + a "selected" hint. */
export function colourwaysFromJson(value) {
  const found = new Map(); let selected = null; let visits = 0;
  const richness = (c) => c.sizes.length * 2 + c.images.length + (c.description ? 3 : 0) + (c.price != null ? 1 : 0);
  const walk = (node, key, depth) => {
    if (node == null || typeof node !== 'object' || depth > 14 || ++visits > 60000) return;
    if (Array.isArray(node)) { for (const v of node) walk(v, key, depth + 1); return; }
    const cw = asColourway(node);
    if (cw) {
      const prev = found.get(cw.code);
      if (!prev || richness(cw) > richness(prev)) found.set(cw.code, { ...(prev || {}), ...cw });
      if (/^(selected|current|active|default)/i.test(String(key || '')) && !selected) selected = cw.code;
    }
    for (const k of Object.keys(node)) walk(node[k], k, depth + 1);
  };
  walk(value, null, 0);
  return { colourways: [...found.values()], selected };
}

// ---- schema.org ProductGroup / Product.hasVariant (JSON-LD) ----
function ldNodes(v) {
  const out = [];
  // @graph, plus an entity wrapped in an Action's `object`, a page's `mainEntity` or an
  // Offer's `itemOffered` (BuyAction → ProductGroup); variants stay inside their group.
  const walk = (n, d = 0) => {
    if (d > 6) return;
    if (Array.isArray(n)) { n.forEach((x) => walk(x, d)); return; }
    if (!isObj(n)) return;
    out.push(n);
    if (Array.isArray(n['@graph'])) n['@graph'].forEach((x) => walk(x, d + 1));
    for (const k of ['object', 'mainEntity', 'itemOffered']) for (const e of [].concat(n[k] || [])) if (isObj(e) && e['@type']) walk(e, d + 1);
  };
  walk(v); return out;
}
const ldType = (n) => [].concat(n && n['@type'] || []).map(String);
function ldOffer(o) { const of = Array.isArray(o.offers) ? o.offers[0] : o.offers; return isObj(of) ? of : {}; }
/** The schema.org property a group varies by ("size", "https://schema.org/material" → "material"). */
const variesByOf = (g) => [].concat(g.variesBy || []).map((x) => String(x).replace(/^.*[/#]/, '')).filter(Boolean);
/** A variant's option label: its size, else the first `variesBy` property it states. */
function optionLabel(v, by) {
  const s = str(isObj(v.size) ? v.size.name : v.size); if (s) return s;
  for (const k of by) { if (k === 'color') continue; const x = v[k]; const t = str(isObj(x) ? (x.name || x.value) : x); if (t) return t; }
  return null;
}
/**
 * Colourways from a JSON-LD ProductGroup (variants grouped by `color`). A group whose
 * variants carry no colour (a TV sold in several screen sizes) is ONE colourway with
 * `color: null`; each option then keeps its own price, link and sku when stated.
 */
export function colourwaysFromJsonLd(value) {
  const groups = ldNodes(value).filter((n) => ldType(n).some((t) => /ProductGroup/i.test(t)) || (ldType(n).some((t) => /^Product$/i.test(t)) && Array.isArray(n.hasVariant)));
  const out = [];
  for (const g of groups) {
    const variants = (Array.isArray(g.hasVariant) ? g.hasVariant : []).filter(isObj);
    if (!variants.length) continue;
    const by = variesByOf(g);
    const anyColour = variants.some((v) => str(v.color)) || !!str(g.color);
    const byColour = new Map();
    for (const v of variants) {
      const colour = str(v.color) || str(g.color);
      if (!colour && anyColour) continue;
      const size = optionLabel(v, by);
      const of = ldOffer(v);
      const key = colour || '';
      const c = byColour.get(key) || { code: null, color: colour || null, sizes: [], images: [] };
      if (size && !c.sizes.some((s) => s.label === size)) {
        const s = { label: size }; const gt = gtinOf(v); if (gt) s.gtin = gt; const av = str(of.availability); if (av) s.available = /InStock/i.test(av);
        if (!colour) { // options that are products of their own: their price, page and sku
          const p = num(of.price); if (p != null) s.price = p;
          const u = str(of.url) || str(v.url); if (u) s.url = u;
          if (str(v.sku)) s.sku = str(v.sku);
        }
        c.sizes.push(s);
      }
      // A colourless option is another product (another screen size): its pictures are not this one's.
      if (colour) for (const im of [].concat(v.image || [])) { const u = typeof im === 'string' ? im : (isObj(im) ? str(im.url || im.contentUrl) : null); if (u && !c.images.includes(u)) c.images.push(u); }
      const p = num(of.price); if (p != null && c.price == null) c.price = p;
      if (!c.currency && str(of.priceCurrency)) c.currency = str(of.priceCurrency);
      if (!c.url && str(v.url)) c.url = str(v.url);
      if (!c.sku && str(v.sku)) c.sku = str(v.sku);
      // The colourway's article code (schema.org `productID`, often written `productId`): its reference, not a SKU.
      if (!c.code && colour && (str(v.productID) || str(v.productId))) c.code = str(v.productID) || str(v.productId);
      byColour.set(key, c);
    }
    const desc = str(g.description);
    const brand = isObj(g.brand) ? str(g.brand.name) : str(g.brand);
    for (const c of byColour.values()) { if (desc) c.description = stripHtml(desc); if (brand) c.brand = brand; if (str(g.name)) c.title = str(g.name); out.push(c); }
  }
  return out;
}

// ---- JSON payloads embedded in a page ----
function balancedSlice(s, from) {
  const open = s[from]; const close = open === '{' ? '}' : (open === '[' ? ']' : null);
  if (!close) return null;
  let depth = 0, inStr = false, esc = false, q = '';
  for (let k = from; k < s.length; k++) {
    const c = s[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; q = c; continue; }
    if (c === open) depth++; else if (c === close) { depth--; if (depth === 0) return s.slice(from, k + 1); }
  }
  return null;
}
/**
 * Every JSON payload of a page, named or not: `<script type="application/json">` /
 * `ld+json` islands (any id) and `window.X = {…}` style assignments. Bounded.
 * @returns {{ json:any[], jsonLd:any[] }}
 */
export function pageJsonPayloads(html, { max = 40 } = {}) {
  const json = []; const jsonLd = []; const src = String(html || '');
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi; let m; let n = 0;
  while ((m = re.exec(src)) && n < max) {
    const attrs = m[1] || ''; const body = (m[2] || '').trim();
    if (!body) continue;
    if (/type\s*=\s*["']application\/ld\+json["']/i.test(attrs)) { n++; try { jsonLd.push(JSON.parse(body)); } catch { /* malformed */ } continue; }
    if (/type\s*=\s*["'](application\/json|application\/x-json|text\/json)["']/i.test(attrs)) { if (body.length < 40) continue; n++; try { json.push(JSON.parse(body)); } catch { /* malformed */ } continue; }
    if (/type\s*=\s*["']/.test(attrs) && !/type\s*=\s*["'](text\/javascript|module|application\/javascript)["']/i.test(attrs)) continue;
    // window.__X__ = {…} / var x = {…} assignments holding pure JSON.
    const as = /(?:window\.|self\.|var\s+|let\s+|const\s+)[\w$.]+\s*=\s*(?=[{[])/g; let a;
    while ((a = as.exec(body)) && n < max) {
      const lit = balancedSlice(body, a.index + a[0].length);
      if (!lit || lit.length < 100) continue;
      n++; try { json.push(parseDataLiteral(lit)); } catch { /* code, not a data literal */ }
      as.lastIndex = a.index + a[0].length + lit.length;
    }
  }
  return { json, jsonLd };
}

/**
 * The product group of a product page.
 * @param {string} html
 * @returns {{ colourways: Array<{code:string|null,color:string,sizes:Array<{label:string,gtin?:string,available?:boolean}>,images:string[],price?:number,listPrice?:number,currency?:string,description?:string,title?:string,subtitle?:string,brand?:string,genders?:string[],productType?:string,url?:string,sku?:string}>, selected:string|null, source:'embedded'|'json-ld'|null }}
 */
export function extractProductGroup(html, { payloads = null } = {}) {
  const { json, jsonLd } = payloads || pageJsonPayloads(html);
  let best = { colourways: [], selected: null, source: null };
  for (const j of json) {
    const r = colourwaysFromJson(j);
    if (r.colourways.length > best.colourways.length) best = { ...r, source: 'embedded' };
  }
  if (!best.colourways.length) {
    for (const j of jsonLd) { const cws = colourwaysFromJsonLd(j); if (cws.length > best.colourways.length) best = { colourways: cws, selected: null, source: 'json-ld' }; }
  }
  return best;
}

const filled = (v) => v != null && v !== '' && !(Array.isArray(v) && !v.length);

/** Option A variants: the colourway's sizes ({code, type:'taille', name, gtin?, availability?}). */
export function sizeVariants(cw) {
  return ((cw && cw.sizes) || []).map((s) => {
    const v = { code: s.gtin || null, type: 'taille', name: s.label };
    if (s.gtin) v.gtin = s.gtin;
    if (typeof s.available === 'boolean') v.availability = s.available ? 'InStock' : 'OutOfStock';
    if (s.price != null) v.price = s.price;
    if (s.url) v.url = s.url;
    if (s.sku) v.sku = s.sku;
    return v;
  });
}

/**
 * Merge one colourway into a raw product (option A: one row per colourway, its
 * sizes as variants). Only fills what is empty — except the gallery (the
 * colourway's images go first) and a description flagged `weakDescription`
 * (a <meta> marketing line), which the colourway's real description replaces.
 * @returns {string[]} the fields it added or improved
 */
export function mergeColourway(card, cw, { weakDescription = false } = {}) {
  const added = [];
  if (!card || !cw) return added;
  const set = (k, v) => { if (filled(v) && !filled(card[k])) { card[k] = v; added.push(k); } };
  set('color', cw.color);
  if (!filled(card.variants) && cw.sizes && cw.sizes.length) { card.variants = sizeVariants(cw); added.push('variants'); }
  // One product-level EAN only when the colourway has exactly one sized EAN.
  const eans = (cw.sizes || []).map((s) => s.gtin).filter(Boolean);
  if (!filled(card.gtin) && eans.length === 1) { card.gtin = eans[0]; added.push('gtin'); }
  if (cw.images && cw.images.length) {
    const cur = Array.isArray(card.images) ? card.images : [];
    const merged = [...cw.images, ...cur.filter((u) => !cw.images.includes(u))];
    if (merged.length > cur.length) { card.images = merged; added.push('images'); }
  }
  if (cw.description && (weakDescription || !filled(card.description))) { if (card.description !== cw.description) { card.description = cw.description; added.push('description'); } }
  set('brand', cw.brand);
  const cat = cw.subtitle || (cw.genders && cw.genders.length ? cw.genders.join(', ') : null);
  if (!filled(card.category) && !filled(card.breadcrumb)) set('category', cat);
  if (cw.listPrice != null && card.listPrice == null && (card.price == null || cw.listPrice > card.price)) { card.listPrice = cw.listPrice; added.push('listPrice'); }
  if (card.price == null && cw.price != null) { card.price = cw.price; added.push('price'); }
  set('currency', cw.currency);
  return added;
}

/** Find the colourway of a listed product: by its code (sku) or a code in its URL path. */
export function matchColourway(group, { sku = null, url = null } = {}) {
  const cws = (group && group.colourways) || [];
  if (!cws.length) return null;
  const norm = (s) => String(s || '').toLowerCase();
  if (sku) { const c = cws.find((x) => x.code && norm(x.code) === norm(sku)) || cws.find((x) => x.sku && norm(x.sku) === norm(sku)); if (c) return c; }
  if (url) {
    let segs = [];
    try { segs = new URL(url).pathname.split('/').filter(Boolean).map((s) => norm(decodeURIComponent(s))); } catch { segs = []; }
    const c = cws.find((x) => x.code && segs.includes(norm(x.code)));
    if (c) return c;
    // A colourway that states its own page (JSON-LD variant `url`): the one whose page is this one.
    const bare = (u) => { try { const x = new URL(u); return `${x.origin}${x.pathname}`.replace(/\/$/, '').toLowerCase(); } catch { return null; } };
    const here = bare(url);
    const byUrl = here ? cws.find((x) => x.url && bare(x.url) === here) : null;
    if (byUrl) return byUrl;
    // Else a colourway whose own sku / code ends the page's path ("…/IF6490.html").
    const last = segs.length ? segs[segs.length - 1].replace(/\.[a-z0-9]{2,5}$/i, '') : '';
    const bySku = last ? cws.find((x) => (x.sku && norm(x.sku) === last) || (x.code && norm(x.code) === last)) : null;
    if (bySku) return bySku;
  }
  if (cws.length === 1) return cws[0];
  return null;
}
