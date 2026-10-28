/**
 * JSON-LD extraction — the priority strategy. E-commerce sites very often
 * expose a schema.org Product as JSON-LD, which is far more reliable than CSS
 * selectors. Pure functions on an HTML string; zero dependencies.
 *
 * Handles: multiple <script type="application/ld+json"> blocks, @graph, arrays
 * of nodes, Product (and sub-types), offers as object OR array (+ AggregateOffer
 * with lowPrice), brand as object OR string, image as string OR array OR
 * ImageObject, sku / mpn / gtin(8|12|13|14)/gtin, category, availability.
 */

/** Extract and JSON.parse every ld+json block; tolerant of trailing junk. */
export function parseJsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let txt = m[1].trim();
    if (!txt) continue;
    // Some CMSs wrap JSON in CDATA or add HTML comments.
    txt = txt.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
    try {
      out.push(JSON.parse(txt));
    } catch {
      // Try to recover the first well-formed top-level JSON value.
      const recovered = tryRecover(txt);
      if (recovered !== undefined) out.push(recovered);
    }
  }
  return out;
}

function tryRecover(txt) {
  const start = txt.search(/[[{]/);
  if (start < 0) return undefined;
  for (let end = txt.length; end > start + 1; end--) {
    const slice = txt.slice(start, end);
    if (!/[\]}]$/.test(slice.trim())) continue;
    try { return JSON.parse(slice); } catch { /* keep shrinking */ }
  }
  return undefined;
}

// Properties whose value is a whole entity a page may wrap its product in: an
// Action's `object` (BuyAction → ProductGroup), a page's `mainEntity`, an Offer's
// `itemOffered`. Variants (`hasVariant`) are NOT unwrapped: they belong to their group.
const ENTITY_KEYS = ['object', 'mainEntity', 'itemOffered'];

/** Flatten JSON-LD roots into a flat list of nodes (unwraps @graph, arrays and wrapped entities). */
export function collectNodes(roots) {
  const nodes = [];
  const visit = (n, depth = 0) => {
    if (!n || typeof n !== 'object' || depth > 6) return;
    if (Array.isArray(n)) { n.forEach((x) => visit(x, depth)); return; }
    if (Array.isArray(n['@graph'])) n['@graph'].forEach((x) => visit(x, depth + 1));
    nodes.push(n);
    for (const k of ENTITY_KEYS) {
      const v = n[k];
      for (const e of (Array.isArray(v) ? v : [v])) if (e && typeof e === 'object' && e['@type']) visit(e, depth + 1);
    }
  };
  roots.forEach(visit);
  return nodes;
}

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function typeMatches(node, wanted) {
  const t = node['@type'];
  const types = asArray(t).map((x) => String(x).toLowerCase());
  return types.some((x) => wanted.includes(x));
}

/** Is this node a Product (or a product-ish subtype, a ProductGroup included)? */
export function isProductNode(node) {
  return typeMatches(node, ['product', 'productmodel', 'individualproduct', 'vehicle', 'book', 'foodproduct', 'productgroup']);
}

/** The page's product: a plain Product first, else a ProductGroup (the model with its variants). */
function mainProductNode(nodes) {
  const all = nodes.filter(isProductNode);
  return all.find((n) => !typeMatches(n, ['productgroup'])) || all[0] || null;
}

function pickImages(image) {
  const imgs = [];
  for (const i of asArray(image)) {
    if (typeof i === 'string') imgs.push(i);
    else if (i && typeof i === 'object') {
      if (typeof i.url === 'string') imgs.push(i.url);
      else if (typeof i.contentUrl === 'string') imgs.push(i.contentUrl);
    }
  }
  return imgs;
}

function pickBrand(brand) {
  for (const b of asArray(brand)) {
    if (typeof b === 'string') return b;
    if (b && typeof b === 'object' && typeof b.name === 'string') return b.name;
  }
  return null;
}

function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Extract price/listPrice/currency/availability from offers (object|array|AggregateOffer). */
function pickOffers(offers) {
  const res = { price: null, listPrice: null, currency: null, availability: null };
  const list = asArray(offers);
  const prices = [];
  for (const o of list) {
    if (!o || typeof o !== 'object') continue;
    // AggregateOffer
    const p = num(o.price ?? o.lowPrice ?? o.highPrice);
    if (p != null) prices.push(p);
    if (res.currency == null && typeof o.priceCurrency === 'string') res.currency = o.priceCurrency;
    if (res.availability == null && o.availability) res.availability = String(o.availability).split('/').pop();
    // PriceSpecification nesting
    const spec = o.priceSpecification;
    for (const s of asArray(spec)) {
      const sp = num(s?.price);
      if (sp != null) prices.push(sp);
      if (res.currency == null && typeof s?.priceCurrency === 'string') res.currency = s.priceCurrency;
    }
  }
  if (prices.length) {
    res.price = Math.min(...prices);                 // current/promo = lowest
    if (prices.length > 1) res.listPrice = Math.max(...prices);
  }
  return res;
}

/**
 * A GTIN field may be an ARRAY, or a separator-joined string, of several codes —
 * a multi-variant product (e.g. Lidl JSON-LD `"gtin13":["4023122153986",
 * "4023122153993"]`). `String(array)` used to join them with a comma, which a
 * later `digits()` collapsed into one 26-digit non-code. Return the FIRST token
 * that is a valid GTIN/EAN/UPC length (8/12/13/14 digits); fall back to the first
 * non-empty token so a single non-standard code still passes through unchanged.
 */
export function firstGtin(value) {
  if (value == null) return null;
  const tokens = (Array.isArray(value) ? value : String(value).split(/[^0-9A-Za-z]+/))
    .map((t) => String(t).trim()).filter(Boolean);
  for (const t of tokens) { const d = t.replace(/\D/g, ''); if ([8, 12, 13, 14].includes(d.length)) return d; }
  return tokens[0] || null;
}

// GS1 check-digit validation lives with the other portable product readers (the extension uses it too).
export { isValidGtin } from './product-group.mjs';

function pickGtin(node) {
  const keys = ['gtin13', 'gtin14', 'gtin12', 'gtin8', 'gtin', 'ean', 'barcode'];
  for (const k of keys) {
    if (node[k] == null) continue;
    const g = firstGtin(node[k]);
    if (g) return g;
  }
  return null;
}

function pickCategory(node) {
  const c = node.category;
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object' && typeof c.name === 'string') return c.name;
  return null;
}

/**
 * Build a RawProduct-ish object from JSON-LD nodes. Returns null if no Product
 * node is present. Also pulls a BreadcrumbList when available.
 * @returns {import('../../core/types.mjs').RawProduct | null}
 */
/**
 * schema.org aggregateRating → { rating (0–5), reviewCount }. A rating on another
 * scale (bestRating 10 / 100) is brought to 5. No review → rating null, count 0.
 */
function pickRating(ar) {
  const a = Array.isArray(ar) ? ar[0] : ar;
  if (!a || typeof a !== 'object') return {};
  const value = Number(a.ratingValue);
  const best = Number(a.bestRating) > 0 ? Number(a.bestRating) : 5;
  const count = [a.reviewCount, a.ratingCount].map(Number).find((n) => Number.isInteger(n) && n >= 0);
  if (!Number.isFinite(value) && count == null) return {};
  const rating = Number.isFinite(value) && value >= 0 && value <= best ? Math.round((value / best) * 5 * 100) / 100 : null;
  return { rating: count === 0 ? null : rating, reviewCount: count != null ? count : null };
}

import { specsFromJsonLd } from './specs.mjs';

/** Map ONE JSON-LD Product node → RawProduct-ish (shared by single + list). */
function productFromNode(product, nodes) {
  const offers = pickOffers(product.offers);
  const desc = typeof product.description === 'string' ? product.description : null;
  const name = typeof product.name === 'string' ? product.name
    : (typeof product.title === 'string' ? product.title : null);
  return {
    name: name ? name.trim() : null,
    description: desc ? desc.trim() : null,
    price: offers.price,
    listPrice: offers.listPrice,
    currency: offers.currency,
    availability: offers.availability,
    ...pickRating(product.aggregateRating),
    gtin: pickGtin(product),
    sku: product.sku != null ? String(product.sku).trim() : null,
    mpn: product.mpn != null ? String(product.mpn).trim() : null,
    brand: pickBrand(product.brand),
    images: pickImages(product.image),
    category: pickCategory(product),
    breadcrumb: extractBreadcrumb(nodes),
    weightText: pickWeightText(product),
    specs: specsFromJsonLd(product),
    sourceUrl: null,
    canonicalUrl: typeof product.url === 'string' ? product.url : null,
    strategy: 'generic-jsonld',
    confidence: 0.9,
  };
}

export function extractProductFromJsonLd(html) {
  const nodes = collectNodes(parseJsonLdBlocks(html));
  const product = mainProductNode(nodes);
  return product ? productFromNode(product, nodes) : null;
}

/**
 * Extract EVERY product a JSON-LD block describes (a listing page): standalone
 * Product nodes + ItemList itemListElement (inline Product, or a bare {url}
 * reference kept as a URL-only card). Deduped. For listing extraction.
 * @returns {import('../../core/types.mjs').RawProduct[]}
 */
export function extractProductsFromJsonLd(html) {
  const nodes = collectNodes(parseJsonLdBlocks(html));
  const out = [];
  const seen = new Set();
  const push = (p) => {
    if (!p) return;
    const k = p.canonicalUrl || p.gtin || p.sku || p.name;
    if (!k || seen.has(k)) { if (!k) out.push(p); return; }
    seen.add(k); out.push(p);
  };
  for (const n of nodes) if (isProductNode(n)) push(productFromNode(n, nodes));
  for (const n of nodes) {
    if (!typeMatches(n, ['itemlist']) || !Array.isArray(n.itemListElement)) continue;
    for (const el of n.itemListElement) {
      const item = el && typeof el === 'object' ? (el.item || el) : null;
      if (item && typeof item === 'object' && isProductNode(item)) { push(productFromNode(item, nodes)); continue; }
      const url = (item && typeof item.url === 'string' && item.url) || (el && typeof el.url === 'string' && el.url) || null;
      if (url) push({ name: null, description: null, price: null, listPrice: null, currency: null, availability: null, gtin: null, sku: null, mpn: null, brand: null, images: [], category: null, breadcrumb: [], weightText: null, sourceUrl: null, canonicalUrl: url, strategy: 'generic-jsonld-itemlist', confidence: 0.3 });
    }
  }
  return out;
}

function pickWeightText(node) {
  const w = node.weight ?? node.size;
  if (typeof w === 'string') return w;
  if (w && typeof w === 'object') {
    const val = w.value ?? w.name;
    const unit = w.unitText ?? w.unitCode ?? '';
    if (val != null) return `${val} ${unit}`.trim();
  }
  return null;
}

function extractBreadcrumb(nodes) {
  const bc = nodes.find((n) => typeMatches(n, ['breadcrumblist']));
  if (!bc || !Array.isArray(bc.itemListElement)) return [];
  return bc.itemListElement
    .map((el) => {
      const item = el?.item;
      const name = el?.name ?? (item && typeof item === 'object' ? item.name : null);
      return typeof name === 'string' ? name.trim() : null;
    })
    .filter(Boolean);
}
