/**
 * Embedded product-state extractor (A1 "état intégré") — PORTABLE.
 *
 * Many SPA catalogues — Hybris/Levi's (window.__LSCO_INITIAL_STATE__),
 * Next/Nuxt/Apollo, PrestaShop, and most modern retailers (Adidas, Leroy Merlin,
 * Delhaize…) — hydrate the product grid from a JSON blob in the page source: an
 * array of products next to a `pagination` object. Reading it turns ONE unlocked
 * list page into all its products (name/price/sku/url), so fiches need not be
 * unlocked one by one. Fully generic: keyed on the SHAPE (products[] carrying a
 * price/sku/EAN/product-URL signal), never on a site name.
 *
 * This is the SINGLE source of truth for the standard engine (core re-exports it)
 * AND the "your browser" extension tier (it is vendored into extension/vendor and
 * run in the service worker on the live page's outerHTML). Keeping it here — with
 * zero Node built-ins and zero dependencies — is what lets both engines use the
 * exact same extractor instead of two diverging ones.
 *
 * The four primitives it needs (absoluteUrl, KNOWN_LANG, PRODUCT_RE, parseMoney)
 * are inlined below, byte-faithful to their core originals, so the module is
 * self-contained and portable. The core re-export means the existing
 * embedded-state / json-products tests exercise this code and guard the copies
 * against drift.
 */
import { extractProductsByShape, scanPrice, scanUrl, scanImage, isAssetUrl, isTreeNode, listingExtras, nestedEntityId, DEMOTE_CONTAINER } from './product-shape.mjs';
import { parseMoney, parseAmount } from './money.mjs';
import { ratingFromJson } from './stock.mjs';
import { parseDataLiteral } from './js-literal.mjs';

// The id of the ENTITY a listing card describes, when the card has no sku of its own:
// a top-level `propertyId` / `listingId` / `offerId`, else the id of its entity
// sub-object ({ listing:{ id } }). An accommodation, a vehicle or a job has no sku.
const ENTITY_ID_KEY_RE = /^(listing|property|offer|entity|unit|room|accommodation|advert|annonce|vehicle|job)id$/i;
function entityIdOf(o) {
  for (const [k, v] of Object.entries(o)) if (ENTITY_ID_KEY_RE.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).length <= 128) return String(v);
  return nestedEntityId(o);
}
// Rating stats kept one level down, under the entity / stats sub-object of the card
// ({ listing:{ ratingStats:{ ratingAverage, ratingCount } } }) — never from an
// unrelated sub-tree (a list of other products).
function nestedRating(o) {
  for (const [k, v] of Object.entries(o)) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || !/(rating|review|stats|listing|product|item|property|offer)/i.test(k)) continue;
    try { const r = ratingFromJson(v); if (r) return r; } catch { /* best effort */ }
  }
  return null;
}

// Rating + review count stated on the card itself ({ reviews:{ rating, count } },
// { rating, reviewCount }) — read only from review-named fields of this product.
function cardRating(o) {
  const own = {};
  for (const [k, v] of Object.entries(o)) if (/(review|rating|stars|avis)/i.test(k)) own[k] = v;
  if (!Object.keys(own).length) return null;
  try { const r = ratingFromJson(own); if (r) return r; } catch { /* best effort */ }
  // { reviews:{ rating:4.53, count:96 } } — a bare `count` is read only inside a
  // review-named object.
  for (const v of Object.values(own)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const rating = Number(v.rating ?? v.average ?? v.value); const count = Number(v.count ?? v.total);
    if (Number.isFinite(rating) && rating >= 0 && rating <= 5 && Number.isInteger(count) && count >= 0) return { rating: count > 0 ? Math.round(rating * 100) / 100 : null, count };
  }
  return null;
}

// ── Inlined portable primitives (copies of the core originals) ────────────────

/** core/url-utils.mjs absoluteUrl */
function absoluteUrl(href, base) {
  if (!href) return null;
  try { return new URL(href, base).toString(); } catch { return null; }
}

/** core/url-context.mjs KNOWN_LANG */
const KNOWN_LANG = new Set(['fr', 'en', 'nl', 'de', 'es', 'it', 'pt', 'pl', 'da', 'sv', 'fi', 'cs', 'nb', 'no', 'ro', 'hu', 'sk', 'bg', 'hr', 'sl', 'et', 'lt', 'lv', 'el', 'tr', 'ru', 'ja', 'zh', 'ko', 'ar']);

/** core/discover.mjs PRODUCT_RE */
const PRODUCT_RE = /(\/product\/|\/produit\/|\/products\/|\/produits\/[a-z0-9]|\/p\/(?!(?:wiki|video|guide|help|about|blog|faq|page|content|info|news|story|lookbook)\/)|-p-\d|\/dp\/|\/item\/|\/artikel\/|\/pd\/)/i;

// Money parsing: broad currency + locale-aware decimals, shared with every
// extractor (users are not only euro/French).

// ── Extraction (byte-faithful to core/embedded-state.mjs) ─────────────────────

const ARRAY_KEYS = ['products', 'productList', 'results', 'items', 'hits', 'collection'];

// The locale prefix carried by a collection URL (/BE/fr_BE, /fr-BE, /fr) — so a
// root-relative product url ("/vtements/…/p/123") is rebuilt WITH the country/
// language segment instead of collapsing to the bare origin (the URL-country
// rule: the URL's locale is authoritative).
function localePrefix(baseUrl) {
  try {
    const p = new URL(baseUrl).pathname;
    let m = p.match(/^(\/[A-Za-z]{2}\/[a-z]{2}[-_][A-Za-z]{2})(?:\/|$)/); if (m) return m[1];
    m = p.match(/^(\/[a-z]{2}[-_][A-Za-z]{2})(?:\/|$)/i); if (m) return m[1];
    m = p.match(/^(\/([a-z]{2}))(?:\/|$)/i); if (m && KNOWN_LANG.has(m[2].toLowerCase())) return m[1];
    return '';
  } catch { return ''; }
}
// Full, functional absolute URL for a product: keep absolute URLs as-is; rebuild
// a root-relative one as origin + locale-prefix + path (no double locale).
function fullUrl(url, baseUrl) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  try {
    const origin = new URL(baseUrl).origin;
    const pref = localePrefix(baseUrl);
    let path = url.startsWith('/') ? url : '/' + url;
    if (pref && !(path.toLowerCase() + '/').startsWith(pref.toLowerCase() + '/')) path = pref + path;
    return origin + path;
  } catch { return absoluteUrl(url, baseUrl); }
}
// Readable category from the collection URL: segments after the locale prefix,
// dropping routing tokens (/c/, /shop, …). "/BE/fr_BE/vetements/homme/jeans/c/x"
// → "vetements > homme > jeans".
function categoryFromBase(baseUrl) {
  try {
    let p = new URL(baseUrl).pathname;
    const pref = localePrefix(baseUrl); if (pref) p = p.slice(pref.length);
    const segs = p.split('/').filter(Boolean);
    const out = [];
    for (const s of segs) {
      if (/^(c|shop|boutique|catalog|category|categorie|collections?)$/i.test(s)) break; if (/^p$/i.test(s)) break;
      if (/^[a-z]{0,4}\d+[a-z0-9]*$/i.test(s)) continue; // a category code ("ga086", "c123"), not a name
      out.push(decodeURIComponent(s).replace(/[-_]+/g, ' '));
    }
    return out.length ? out.join(' > ') : null;
  } catch { return null; }
}
function imagesOf(o, baseUrl) {
  let list = [];
  const g = o.galleryList;
  if (Array.isArray(g)) list = g;
  else if (g && Array.isArray(g.galleryImage)) list = g.galleryImage;
  else if (Array.isArray(o.images)) list = o.images;
  else if (Array.isArray(o.media)) list = o.media;
  let urls = list.map((x) => (typeof x === 'string' ? x : (x && (x.url || x.src || x.href)))).filter(Boolean);
  if (!urls.length && o.image) urls = [typeof o.image === 'string' ? o.image : (o.image.url || o.image.src)].filter(Boolean);
  urls = urls.filter((u) => !/_SW\?|\$swatch\$|swatch/i.test(u));   // drop colour swatches
  return [...new Set(urls.map((u) => fullUrl(String(u), baseUrl)).filter(Boolean))];
}

// Balanced [...] slice starting at `from` (index of the '['), string-aware.
function balancedArray(s, from) {
  let depth = 0, inStr = false, esc = false, q = '';
  for (let k = from; k < s.length; k++) {
    const c = s[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; q = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return s.slice(from, k + 1); }
  }
  return null;
}

function pickPrice(v) {
  if (v == null) return { price: null, currency: null };
  if (typeof v === 'number') return { price: v, currency: null };
  if (typeof v === 'string') {
    const m = parseMoney(v);
    if (m && m.price != null) return { price: m.price, currency: m.currency };
    // Bare numeric price field (no currency in the string): JSON-LD offers carry
    // plain-number prices — lowPrice:"37.9", price:"37.90", "1.299,00". parseMoney
    // needs a currency token and rejects these; here the KEY already says it is a
    // price, so parse the amount directly (currency comes from a sibling key).
    const n = parseAmount(v);
    return (n != null && n > 0 && n < 1e9) ? { price: n, currency: null } : { price: null, currency: null };
  }
  if (typeof v === 'object') {
    const txt = v.formattedValue || v.displayValue || v.formatted || v.formattedPrice || v.text || null;
    if (txt && typeof txt === 'string') { const m = parseMoney(String(txt)); if (m && m.price != null) return { price: m.price, currency: m.currency || v.currencyIso || v.currency || v.currencyCode || null }; }
    const major = v.value ?? v.amount ?? v.price ?? v.lowPrice ?? null;
    if (major != null && typeof major !== 'object') {
      const n = Number(major);
      if (Number.isFinite(n)) return { price: n, currency: v.currencyIso || v.currency || v.currencyCode || v.priceCurrency || null };
    }
    // Minor-unit amounts (Commercetools/Stripe-style: centAmount in cents).
    if (v.centAmount != null && typeof v.centAmount !== 'object') {
      const n = Number(v.centAmount) / (10 ** (v.fractionDigits == null ? 2 : Number(v.fractionDigits)));
      if (Number.isFinite(n)) return { price: n, currency: v.currencyIso || v.currency || v.currencyCode || null };
    }
    // Nested price shapes: {regular:{price}}, {current:{value}}, {sales:{amount}} …
    for (const nk of ['regular', 'current', 'sales', 'sale', 'final', 'now', 'value']) {
      const inner = v[nk];
      if (inner && typeof inner === 'object') { const got = pickPrice(inner); if (got.price != null) return { price: got.price, currency: got.currency || v.currencyIso || v.currency || v.currencyCode || null }; }
    }
  }
  return { price: null, currency: null };
}

// Generic price resolution for a PRODUCT object. Platforms store the price under
// wildly different keys — flat `price`, `priceInclTax`, a `priceData`/`pricing`/
// `priceInformation` container, or a bare `currentPrice`+`currency` pair — so a
// single `o.price` read misses most of them. This scans a CONTROLLED allowlist of
// price-named keys (normalised, so sale_price / salePrice / current-price all
// match), prefers a sale/current price over the list/was price, recurses one
// level into price CONTAINERS, and falls back to the regular price. No site rule,
// no loose substring match (so priceRange / pricePerUnit / rating never leak in).
const normPriceKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
const CUR_KEYS = ['currency', 'currencyiso', 'currencycode', 'curr', 'currencysymbol', 'pricecurrency'];
const SALE_KEYS = ['saleprice', 'currentprice', 'finalprice', 'nowprice', 'offerprice', 'sellingprice', 'discountedprice', 'specialprice', 'promoprice', 'lowprice', 'current', 'sale', 'sales', 'final', 'now'];
const BASE_KEYS = ['price', 'priceincltax', 'pricewithtax', 'unitprice', 'pricevalue', 'grossprice', 'defaultprice'];
const REGULAR_KEYS = ['regularprice', 'listprice', 'standardprice', 'previousprice', 'wasprice', 'originalprice', 'baseprice', 'msrp', 'rrp', 'strikeprice', 'highprice', 'regular'];
// `offers` / `offer` are JSON-LD's price container (object or array of offers).
const PRICE_CONTAINER_KEYS = ['pricedata', 'priceinfo', 'priceinformation', 'pricing', 'prices', 'pricerange', 'pricedetails', 'pricemodel', 'pricinginfo', 'priceinformationdata', 'offers', 'offer'];

function siblingCurrency(o, normMap) {
  for (const ck of CUR_KEYS) {
    const rk = normMap[ck];
    if (rk == null) continue;
    const raw = o[rk];
    if (typeof raw !== 'string' || !raw) continue;
    const up = raw.toUpperCase();
    if (/^[A-Z]{3}$/.test(up)) return up;
    const sym = { '€': 'EUR', $: 'USD', '£': 'GBP' }[raw];
    if (sym) return sym;
  }
  return null;
}

// A price ARRAY: `prices: [{ type:'original', value:110 }, { type:'sale', value:80 }]`
// (Adidas, and many SAP-Commerce/Hybris catalogues). Each entry is a price object;
// pick the SALE/current entry over the original/list one, else the cheapest valid,
// else the first. A tagged sale always wins so a discounted product keeps its real
// price, not the struck-through one.
const SALE_TYPE_RE = /(sale|current|final|now|special|discount|promo|reduced|selling|offer)/i;
const LIST_TYPE_RE = /(original|regular|list|standard|previous|was|strike|old|rrp|msrp|base|before)/i;
function priceFromArray(arr) {
  const cands = [];
  for (const el of arr) {
    if (el == null) continue;
    const got = pickPrice(el);
    if (got.price == null || !(got.price > 0)) continue;
    const type = (el && typeof el === 'object') ? String(el.type || el.priceType || el.name || el.label || el.kind || '') : '';
    cands.push({ price: got.price, currency: got.currency, type });
  }
  if (!cands.length) return null;
  const sale = cands.find((c) => SALE_TYPE_RE.test(c.type));
  if (sale) return { price: sale.price, currency: sale.currency };
  const notList = cands.filter((c) => !LIST_TYPE_RE.test(c.type));
  const pool = notList.length ? notList : cands;
  // No sale tag → the lowest price is the one actually charged (a struck-through
  // "was" entry is always the higher number).
  return pool.reduce((a, b) => (b.price < a.price ? b : a));
}

// The price before reduction, when the card states one above the price charged:
// { regular:{price:599} } / { listPrice:599 } / prices:[{type:'original', value:110}].
function listPriceOf(o, price) {
  if (!o || typeof o !== 'object' || Array.isArray(o) || price == null) return null;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (REGULAR_KEYS.includes(normPriceKey(k))) {
      const got = Array.isArray(v) ? priceFromArray(v) : pickPrice(v);
      if (got && got.price != null && got.price > price) return got.price;
    } else if (Array.isArray(v) && /price|prix/i.test(k)) {
      for (const el of v) {
        const t = el && typeof el === 'object' ? String(el.type || el.priceType || el.name || el.label || el.kind || '') : '';
        if (!LIST_TYPE_RE.test(t)) continue;
        const g = pickPrice(el); if (g.price != null && g.price > price) return g.price;
      }
    }
  }
  return null;
}

function resolvePrice(o, depth = 0) {
  if (o == null) return { price: null, currency: null };
  if (Array.isArray(o)) { const a = priceFromArray(o); return a || { price: null, currency: null }; }
  if (typeof o === 'number' || typeof o === 'string') return pickPrice(o);
  if (typeof o !== 'object') return { price: null, currency: null };
  const normMap = {};
  for (const k of Object.keys(o)) { const nk = normPriceKey(k); if (!(nk in normMap)) normMap[nk] = k; }
  // Read a price-named key's value, whether it is a scalar, a price object, or an
  // array of price entries.
  const valPrice = (v) => (Array.isArray(v) ? priceFromArray(v) : pickPrice(v));
  const tryKeys = (keys) => {
    for (const nk of keys) {
      const rk = normMap[nk];
      if (rk == null) continue;
      const got = valPrice(o[rk]);
      if (got && got.price != null && got.price > 0) return got;
    }
    return null;
  };
  let got = tryKeys(SALE_KEYS) || tryKeys(BASE_KEYS);
  // The nested form of "discountPrice": { regular:{price:599}, discount:{price:399} }.
  // Only the inner key `price`, and only below the regular price, so a discount
  // stated as an amount ({ discount:{ amount, percent } }) is never read as a price.
  if (!got) {
    for (const nk of ['discount', 'discounted', 'promo', 'promotion', 'reduced', 'reduction']) {
      const rk = normMap[nk]; const d = rk != null ? o[rk] : null;
      if (!d || typeof d !== 'object' || Array.isArray(d) || d.price == null || typeof d.price === 'object') continue;
      const cand = pickPrice(d.price); const reg = tryKeys(REGULAR_KEYS);
      if (cand.price != null && cand.price > 0 && (!reg || cand.price < reg.price)) { got = { price: cand.price, currency: cand.currency || d.currency || null }; break; }
    }
  }
  if (!got && depth < 2) {
    for (const ck of PRICE_CONTAINER_KEYS) {
      const rk = normMap[ck];
      if (!rk || !o[rk] || typeof o[rk] !== 'object') continue;
      const g = Array.isArray(o[rk]) ? priceFromArray(o[rk]) : resolvePrice(o[rk], depth + 1);
      if (g && g.price != null) { got = g; break; }
    }
  }
  if (!got) got = tryKeys(REGULAR_KEYS);
  if (got && !got.currency) { const c = siblingCurrency(o, normMap); if (c) got.currency = c; }
  return got || { price: null, currency: null };
}

// The product's name kept one level down, in a small text sub-object
// ({ copy:{ title } }, { content:{ name } }, { info:{ displayName } }). Never the name
// of a brand, a category, a seller or a badge (those sub-objects describe something
// else). Generic, no site rule.
const NOT_PRODUCT_NAME_PARENT = /(brand|categor|seller|vendor|merchant|store|shop|manufacturer|collection|department|badge|promo|label|author|user|review|color|colour|size|image|media|price)/i;
function nestedName(o) {
  for (const [k, v] of Object.entries(o)) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || NOT_PRODUCT_NAME_PARENT.test(k) || Object.keys(v).length > 12) continue;
    const n = v.title || v.name || v.displayName;
    if (typeof n === 'string' && n.trim()) return n.trim();
  }
  return null;
}

// The card's own category / collection ({ category:{ title } }, category:"Jeans"),
// never a code ("ga0201", "c123").
function ownCategory(o) {
  const c = o.category;
  const v = typeof c === 'string' ? c : (c && typeof c === 'object' && !Array.isArray(c) ? (c.title || c.name || c.label) : null);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && /[a-zà-ÿ]{3}/i.test(t) && !/^[a-z]{0,4}\d+[a-z0-9]*$/i.test(t) && t.length <= 80 ? t : null;
}
// The card's brand: brand / brandName / manufacturer, a string or { name }, or the
// first of a brands list.
function brandOf(o) {
  const b = o.brand ?? o.brandName ?? o.manufacturer ?? (Array.isArray(o.brands) ? o.brands[0] : null);
  const v = typeof b === 'string' ? b : (b && typeof b === 'object' ? (b.name || b.title || b.label) : null);
  return typeof v === 'string' && v.trim() && v.length <= 80 ? v.trim() : null;
}

function mapProduct(o, baseUrl, contextCategory) {
  if (!o || typeof o !== 'object') return null;
  // Unwrap common list WRAPPERS so the same mapper reads JSON-LD ItemList entries
  // ({position, item:{Product}}) and GraphQL relay edges ({node:{…}}) — generic, no
  // site rule. Only when the wrapper itself carries no product fields.
  if (!o.name && !o.title && !o.price && !o.url) {
    const inner = (o.item && typeof o.item === 'object' && o.item) || (o.node && typeof o.node === 'object' && o.node);
    if (inner) o = inner;
  }
  const name = o.name || o.title || o.displayName || o.label || nestedName(o);
  const rawUrl = o.url || o.link || o.href || o.canonicalUrl || o.productUrl || null;
  let url = rawUrl ? fullUrl(String(rawUrl), baseUrl) : null;
  if (url && isAssetUrl(url)) url = null; // a picture / file link is never the product's page
  // The card's identifier (it matches the card to its product page, keeps an id-only card…). It is a SKU only when
  // the state declares it under that name; a code, a reference, an id is the product's REFERENCE: `skuIsReference`
  // tells the normaliser to write it as `reference`, never as SKU (shared/extract/sku.mjs).
  const declaredSku = o.sku || o.skuId || null;
  const sku = o.code || declaredSku || o.productCode || o.id || o.reference || entityIdOf(o) || null;
  const gtin = o.gtin || o.ean || o.barcode || null;
  let { price, currency } = resolvePrice(o);
  let images = imagesOf(o, baseUrl);
  // Generic, MULTILINGUAL last-resort fill: if the keyed mapper missed a field because
  // this site names it unusually (the Leroy Merlin / Adidas "price is null" pattern),
  // the broad shape scanners recover it — so a site is COMPLETE without a per-site rule.
  if (price == null) { const sp = scanPrice(o); if (sp && sp.price != null) { price = sp.price; currency = currency || sp.currency; } }
  if (!url) { const su = scanUrl(o, baseUrl); if (su) url = su; }
  if (!images.length) { const si = scanImage(o, baseUrl); if (si) images = [si]; }
  const color = o.colorName || o.color || (Array.isArray(o.variantOptions) && o.variantOptions[0] && o.variantOptions[0].colorName) || null;
  const bc = Array.isArray(o.lscoBreadcrumbs) ? o.lscoBreadcrumbs.map((b) => (typeof b === 'string' ? b : (b && (b.name || b.label)))).filter(Boolean) : null;
  const category = (bc && bc.length ? bc.join(' > ') : null) || ownCategory(o) || o.department || contextCategory || null;
  const brand = brandOf(o);
  // Variants — future-proof shape (colour today, sizes/per-variant price tomorrow):
  // { code, type:'couleur'|'taille'|'autre', name, price?, image?, availability?, url? }.
  const variants = Array.isArray(o.variantOptions)
    ? o.variantOptions.map((v) => {
        if (!v || typeof v !== 'object') return null;
        const code = v.code || v.sku || null;
        const sizeVal = v.size || v.sizeName || v.sizeValue || v.value || null;
        const isColour = v.colorName != null || v.colorGroup != null || v.swatchUrl != null;
        const type = sizeVal ? 'taille' : (isColour ? 'couleur' : 'autre');
        const vname = v.colorName || v.swatchAltText || sizeVal || null;
        const vp = resolvePrice(v).price;
        const vimg = v.swatchUrl ? fullUrl(v.swatchUrl, baseUrl) : ((v.galleryList && !Array.isArray(v.galleryList) && v.galleryList.galleryImage && v.galleryList.galleryImage[0] && fullUrl(v.galleryList.galleryImage[0].url, baseUrl)) || null);
        const vurl = v.url ? fullUrl(v.url, baseUrl) : null;
        const avail = v.soldOutForever ? 'soldout' : (v.comingSoon ? 'coming_soon' : (v.availability || null));
        const out = { code, type, name: vname };
        if (vp != null && vp !== price) out.price = vp;
        if (vimg) out.image = vimg;
        if (avail) out.availability = avail;
        if (vurl && vurl !== url) out.url = vurl;
        return (code || vname) ? out : null;
      }).filter(Boolean)
    : [];
  if (!url && !name) return null;
  // A real product has at least a NAME or a PRICE. An object with neither — only an
  // id and some url — is a tracking / font / config / asset record (e.g. hydrozone
  // locking onto {id, url:"use.typekit.net/…"}), never a product. `id` alone is the
  // weakest possible signal (everything has one), so it must not, by itself, mint a
  // product. Generic, no site rule.
  if (name == null && price == null) return null;
  // A category-tree / menu node (a list of labelled child entries, no price of its
  // own) is a category tile, never a product — a site's mega-menu state carries
  // hundreds of them, each with a picture.
  if (price == null && gtin == null && isTreeNode(o)) return null;
  // A real product carries a STRONG signal — a price, an image, a real EAN/GTIN, or a
  // URL that points at a product detail page. A bare `id`/`sku` or a lone `name` is
  // NOT enough: arrays of {id, name} are font families (Adobe Typekit "Archivo",
  // "Anton"…), facets, brands or categories, which otherwise get mistaken for a
  // product grid. Generic, no site rule.
  const hasSignal = price != null || gtin != null || images.length > 0 || (url && !url.includes('?') && PRODUCT_RE.test(url));
  if (!hasSignal) return null;
  const card = { strategy: 'embedded-state' };
  if (url) { card.sourceUrl = url; card.canonicalUrl = url; }
  if (name) card.name = name;
  if (price != null) card.price = price;
  if (currency) card.currency = currency;
  if (sku != null) { card.sku = String(sku); if (declaredSku == null || String(declaredSku) !== card.sku) { card.skuIsReference = true; if (declaredSku != null) card.declaredSku = String(declaredSku); } }
  if (gtin) card.gtin = String(gtin);
  if (images.length) card.images = images;
  if (category) card.category = category;
  if (brand) card.brand = brand;
  if (color) card.color = color;
  if (variants.length) card.variants = variants;
  const listPrice = listPriceOf(o, price);
  if (listPrice != null) card.listPrice = listPrice;
  const rv = cardRating(o) || nestedRating(o);
  if (rv) { if (rv.rating != null) card.rating = rv.rating; card.reviewCount = rv.count; }
  // Listing-card extras (an accommodation, a vehicle, a job…): the rating as the site
  // writes it ("4,6 (134)"), the card's secondary lines (sub-title, dates, host type)
  // and the price with its basis ("116 € au total") kept together as the description.
  // Never the price line for a product with a real EAN (an e-commerce card).
  const ex = listingExtras(o);
  if (card.rating == null && ex.rating != null) { card.rating = ex.rating; if (ex.reviewCount != null) card.reviewCount = ex.reviewCount; }
  const line = ex.priceText && !gtin ? ex.priceText : null;
  if (ex.description || line) card.description = [ex.description, line].filter(Boolean).join(' · ');
  return card;
}

// Pagination read from a JSON object: flat numeric fields OR a nested
// pagination/meta/paging/page sub-object. Generic synonyms across frameworks.
function readPaginationObj(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const numOf = (o, keys) => { if (!o || typeof o !== 'object') return null; for (const k of Object.keys(o)) { const lk = k.toLowerCase(); if (typeof o[k] === 'number') for (const s of keys) if (lk === s) return o[k]; } return null; };
  const sub = ['pagination', 'meta', 'paging', 'page', 'pageInfo', 'metadata'].map((k) => obj[k]).find((v) => v && typeof v === 'object') || null;
  const pick = (keys) => numOf(obj, keys) ?? numOf(sub, keys);
  // A cursor is a string/number token, not a count — read it separately.
  const cursor = (o, keys) => { if (!o || typeof o !== 'object') return null; for (const k of Object.keys(o)) { const lk = k.toLowerCase(); const v = o[k]; if ((typeof v === 'string' && v) || typeof v === 'number') for (const s of keys) if (lk === s) return v; } return null; };
  const pag = {
    currentPage: pick(['currentpage', 'pagenumber', 'pageindex', 'page']),
    totalPages: pick(['totalpages', 'pagecount', 'numberofpages', 'nbpages', 'pagestotal']),
    totalResults: pick(['totalresults', 'totalnumberofresults', 'numberofresults', 'totalcount', 'resultcount', 'nbresults', 'numberofproducts', 'hitcount', 'nbhits', 'total', 'count']),
    pageSize: pick(['pagesize', 'perpage', 'itemsperpage', 'viewsize', 'size', 'limit']),
    // Cursor / offset paging (Algolia, GraphQL relay, Elasticsearch-style APIs):
    // these let the caller chain the next request straight from the response.
    offset: pick(['offset', 'from', 'start', 'startindex', 'skip']),
    nextCursor: cursor(obj, ['nextcursor', 'endcursor', 'aftercursor', 'next', 'nextpagetoken', 'cursor', 'after', 'searchafter']) ?? cursor(sub, ['nextcursor', 'endcursor', 'aftercursor', 'next', 'nextpagetoken', 'cursor', 'after', 'searchafter']),
  };
  const has = pag.currentPage != null || pag.totalPages != null || pag.totalResults != null || pag.pageSize != null || pag.offset != null || pag.nextCursor != null;
  return has ? pag : null;
}

/**
 * Find a product array inside ANY already-parsed JSON value — an XHR/fetch API
 * response, a __NEXT_DATA__ blob, a fragment. Generic (no site rules): recursively
 * walks the value, and keeps the largest array whose objects carry a product
 * SIGNAL (price / sku / EAN / product-detail URL), reading pagination from the
 * object that CONTAINS that array. This is the core of the XHR-grid archetype
 * (Colruyt / Leroy Merlin / SPA retailers whose products are not in the HTML).
 * @returns {{ cards: object[], pagination: object|null }}
 */
const GROUP_KEYS = ['products', 'items', 'productList', 'results'];

export function extractProductsFromJson(value, baseUrl) {
  let best = null;
  // Every array that reads as a grid, with the shape of its cards and the key it sat
  // under — so rows / carousels of the same cards can be read as ONE grid below.
  const found = [];
  const sigOf = (arr) => { const f = arr.find((x) => x && typeof x === 'object' && !Array.isArray(x)); return f ? Object.keys(f).filter((k) => k !== '__typename').sort().join(',') : ''; };
  const note = (cards, arr, container, containerKey) => { found.push({ cards, sig: sigOf(arr), containerKey: containerKey || '', pagination: readPaginationObj(container) }); };
  const walk = (node, container, containerKey) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      // A GROUPED grid: one entry per card, each holding its product(s) in a small
      // list ([{…, products:[p]}, {…, products:[p1, p2]}]). Flatten one level so the
      // grid is read as a whole (each inner list alone may hold a single product).
      const groupKey = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? GROUP_KEYS.find((k) => Array.isArray(x[k]) && x[k].length && x[k].every((e) => e && typeof e === 'object' && !Array.isArray(e))) : null);
      // Only groups whose inner lists hold the SAME card shape are one grid: a page's
      // sections (destination tiles, then rows of listing cards) are not flattened
      // together — each row is read on its own and merged with its siblings below.
      const groupSigs = node.length >= 2 ? node.map((x) => { const k = groupKey(x); return k ? sigOf(x[k]) : null; }).filter(Boolean) : [];
      const sameShape = groupSigs.length >= 2 && groupSigs.every((s) => s === groupSigs[0]);
      if (sameShape && node.filter(groupKey).length >= node.length * 0.5) {
        const flat = node.flatMap((x) => { const k = groupKey(x); return k ? x[k] : []; });
        const cards = flat.map((o) => mapProduct(o, baseUrl, null)).filter(Boolean);
        if (cards.length >= 2 && cards.length >= flat.length * 0.5) {
          note(cards, flat, container, containerKey);
          if (!best || cards.length > best.cards.length) best = { cards, pagination: readPaginationObj(container) };
        }
      }
      if (node.length >= 2 && node.some((x) => x && typeof x === 'object' && !Array.isArray(x))) {
        const cards = node.map((o) => mapProduct(o, baseUrl, null)).filter(Boolean);
        // Require most of the array to be product-like, so a list of 2 products
        // among 50 facets doesn't win — a real grid is predominantly products.
        if (cards.length >= 2 && cards.length >= node.length * 0.5) {
          note(cards, node, container, containerKey);
          if (!best || cards.length > best.cards.length) best = { cards, pagination: readPaginationObj(container) };
        }
      }
      for (const v of node) walk(v, container, containerKey);
      return;
    }
    // Normalized GraphQL cache (Apollo / urql): the product ENTITIES are values keyed
    // by `Typename:id` ("Product:123", "ROOT_QUERY", …), not an array. Collect the
    // product-shaped values so a headless GraphQL storefront works like any grid.
    const keys = Object.keys(node);
    const typed = keys.filter((k) => /^[A-Za-z][\w]*:[^\s]/.test(k) && node[k] && typeof node[k] === 'object' && !Array.isArray(node[k]));
    if (typed.length >= 3) {
      const cards = typed.map((k) => mapProduct(node[k], baseUrl, null)).filter(Boolean);
      if (cards.length >= 3) {
        note(cards, typed.map((k) => node[k]), null, 'apollo');
        if (!best || cards.length > best.cards.length) best = { cards, pagination: null };
      }
    }
    for (const k of keys) walk(node[k], node, k);
  };
  walk(value, null, '');
  // ROWS AND CAROUSELS: the same card shape repeated in several arrays under the same
  // key (a home page's sections of 8 cards each) is ONE grid — read as a whole, deduped
  // by link / id / name, never only the biggest row. Among the grids found, one WITH
  // prices beats any tile array without (destination or category tiles carry a name
  // and a picture, never a price), whatever their sizes; and a recommendations /
  // recently-viewed container never beats the page's own grid. Generic, no site rule.
  if (found.length) {
    const keyOf = (c) => c.sourceUrl || (c.sku ? `sku:${c.sku}` : (c.gtin ? `gtin:${c.gtin}` : `name:${c.name}`));
    const groups = new Map();
    for (const f of found) {
      const ck = normPriceKey(f.containerKey);
      const gk = `${f.sig}|${ck}`;
      const g = groups.get(gk) || { byKey: new Map(), demoted: DEMOTE_CONTAINER.test(ck), pagination: null };
      for (const c of f.cards) { const k = keyOf(c); if (!g.byKey.has(k)) g.byKey.set(k, c); }
      g.pagination = g.pagination || f.pagination;
      groups.set(gk, g);
    }
    let pick = null;
    for (const g of groups.values()) {
      const cards = [...g.byKey.values()];
      const pricedFrac = cards.filter((c) => c.price != null).length / cards.length;
      const rank = (g.demoted ? 0 : 2) + (pricedFrac >= 0.5 ? 1 : 0);
      if (!pick || rank > pick.rank || (rank === pick.rank && cards.length > pick.cards.length)) pick = { cards, rank, pagination: g.pagination };
    }
    if (pick) best = { cards: pick.cards, pagination: pick.pagination || (best && best.pagination) || null };
  }
  // Complementary generic SHAPE scorer (product-shape.mjs): runs over the whole tree
  // and detects a product array by the shape of its objects even when their field
  // names are unusual / non-English — names the keyed mapper above does not list. The
  // keyed walk stays primary (richer fields for known shapes); the scorer is used only
  // when it finds MORE products, so known shapes (Colruyt/Adidas) are unchanged.
  try {
    const byShape = extractProductsByShape(value, baseUrl);
    if (byShape.cards.length >= 2 && byShape.cards.length > (best ? best.cards.length : 0)) {
      return { cards: byShape.cards, pagination: best ? best.pagination : null };
    }
  } catch { /* scorer is best-effort */ }
  return best || { cards: [], pagination: null };
}

// Balanced {…} or […] slice starting at the opening char at `from`, string-aware.
function balancedSlice(s, from) {
  const open = s[from];
  const close = open === '{' ? '}' : (open === '[' ? ']' : null);
  if (!close) return null;
  let depth = 0, inStr = false, esc = false, q = '';
  for (let k = from; k < s.length; k++) {
    const c = s[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; q = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return s.slice(from, k + 1); }
  }
  return null;
}
// Balanced "…" / '…' slice starting at the quote at `from` (escape-aware).
function balancedString(s, from) {
  const q = s[from];
  if (q !== '"' && q !== "'") return null;
  let esc = false;
  for (let k = from + 1; k < s.length; k++) {
    const c = s[k];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === q) return s.slice(from, k + 1);
  }
  return null;
}

const MAX_JSON_BLOBS = 80;      // cap on JSON.parse attempts per page (huge SPAs)
const MIN_BLOB_LEN = 40;        // ignore tiny {}/[] literals

/**
 * NAME-AGNOSTIC embedded-JSON scan — the core generalization that stops the "one
 * new state-container name per site" trap. Instead of matching a fixed list of
 * globals (__NEXT_DATA__ / __NUXT__ / __LSCO_INITIAL_STATE__ / …), it parses EVERY
 * JSON payload the page carries and mines each by SHAPE:
 *   1. every `<script type="application/json|ld+json">` island (any id/name);
 *   2. every inline-script `<lhs> = {…}` / `= […]` assignment (any variable name);
 *   3. every inline-script `= JSON.parse("…")` and `= "{…}"` double-encoded state;
 *   4. Next.js App-Router "Flight" rows (self.__next_f.push([1,"id:json"])).
 * extractProductsFromJson also reads a normalized GraphQL cache (Apollo/urql,
 * `Typename:id` keyed entities).
 * Each parsed value goes through the same extractProductsFromJson (largest array of
 * product-shaped objects wins), so an UNKNOWN site whose state lives under a name we
 * have never seen still yields its grid. Bounded for performance.
 * @returns {{cards:object[], pagination:object|null}|null}
 */
function scanEmbeddedJson(html, baseUrl, visit = null) {
  let best = null;
  let attempts = 0;
  const consider = (parsed) => {
    if (!parsed || typeof parsed !== 'object') return;
    if (visit) { visit(parsed); return; }
    const got = extractProductsFromJson(parsed, baseUrl);
    if (got.cards.length && (!best || got.cards.length > best.cards.length)) best = got;
  };
  // Inline JS: pull each `= {…}` / `= […]` / `= JSON.parse("…")` value, no name needed.
  const scanAssignments = (js) => {
    let i = 0;
    while (i < js.length && attempts < MAX_JSON_BLOBS) {
      const eq = js.indexOf('=', i);
      if (eq < 0) break;
      let k = eq + 1;
      while (k < js.length && (js[k] === ' ' || js[k] === '\t' || js[k] === '\n' || js[k] === '\r')) k++;
      if (js.startsWith('JSON.parse(', k)) {
        let p = k + 11;
        while (p < js.length && /\s/.test(js[p])) p++;
        const strRaw = balancedString(js, p);
        if (strRaw) {
          attempts++;
          try { const inner = JSON.parse(strRaw); if (typeof inner === 'string') consider(JSON.parse(inner)); } catch { /* not a JSON string */ }
          i = p + strRaw.length; continue;
        }
      }
      if (js[k] === '{' || js[k] === '[') {
        const raw = balancedSlice(js, k);
        if (raw && raw.length >= MIN_BLOB_LEN) {
          attempts++;
          try { consider(parseDataLiteral(raw)); } catch { /* not a data literal (code, unquoted keys) */ }
          i = k + raw.length; continue;
        }
      }
      // `= "{…}"` — a JSON payload double-encoded as a string literal (Pinia/vite-ssg
      // and many SSR setups do this).
      if (js[k] === '"' || js[k] === "'") {
        const strRaw = balancedString(js, k);
        if (strRaw && strRaw.length >= MIN_BLOB_LEN) {
          attempts++;
          try { const inner = JSON.parse(strRaw); if (typeof inner === 'string' && /[{[]/.test(inner)) consider(JSON.parse(inner)); } catch { /* not a JSON string */ }
          i = k + strRaw.length; continue;
        }
      }
      i = eq + 1;
    }
  };
  // Next.js App Router streams React-Server-Components "Flight" rows as
  // self.__next_f.push([1,"<id>:<json>"]). Decode each row's JSON payload (the rows
  // that are plain JSON — most data rows are) and mine them by shape.
  const flightRe = /__next_f\.push\(\s*\[\s*\d+\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\s*\)/g;
  let fm;
  while ((fm = flightRe.exec(html)) && attempts < MAX_JSON_BLOBS) {
    let payload;
    try { payload = JSON.parse(fm[1]); } catch { continue; }
    if (typeof payload !== 'string') continue;
    const colon = payload.indexOf(':');
    const body = (colon > 0 && colon < 12) ? payload.slice(colon + 1) : payload;
    const t = body.trim();
    if (t[0] === '{' || t[0] === '[') { attempts++; try { consider(JSON.parse(t)); } catch { /* Flight $-refs / partial row */ } }
  }
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html)) && attempts < MAX_JSON_BLOBS) {
    const attrs = m[1] || '';
    const body = (m[2] || '').trim();
    if (!body) continue;
    if (/type\s*=\s*["'](application\/(ld\+)?json|application\/x-json|text\/json)["']/i.test(attrs)) {
      attempts++;
      try { consider(JSON.parse(body)); } catch { /* malformed island */ }
      continue;
    }
    // A typed script that is NOT javascript (e.g. text/template) carries no state.
    if (/type\s*=\s*["']/.test(attrs) && !/type\s*=\s*["'](text\/javascript|module|application\/javascript)["']/i.test(attrs)) continue;
    scanAssignments(body);
  }
  return best;
}

/**
 * @returns {{ cards: object[], pagination: {currentPage:number|null,totalPages:number|null,totalResults:number|null,pageSize:number|null}|null }}
 */
export function extractEmbeddedProducts(html, baseUrl) {
  if (!html) return { cards: [], pagination: null };
  const contextCategory = categoryFromBase(baseUrl);
  let best = null;
  for (const key of ARRAY_KEYS) {
    const marker = `"${key}":[`;
    let idx = html.indexOf(marker);
    while (idx >= 0) {
      const raw = balancedArray(html, idx + marker.length - 1);
      if (raw) {
        try {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr) && arr.length && typeof arr[0] === 'object') {
            const cards = arr.map((o) => mapProduct(o, baseUrl, contextCategory)).filter(Boolean);
            if (cards.length && (!best || cards.length > best.cards.length)) {
              // Pagination metadata sits near the array (before or after, same
              // hydration object). Generic across frameworks: try common key
              // synonyms in a window around the array, most specific first so a
              // bare "count"/"total" is only a last resort.
              const win = html.slice(Math.max(0, idx - 2000), Math.min(html.length, idx + 4000));
              const pick = (keys) => { for (const k of keys) { const m = win.match(new RegExp(`"${k}"\\s*:\\s*(\\d+)`, 'i')); if (m) return Number(m[1]); } return null; };
              best = { cards, pagination: {
                currentPage: pick(['currentPage', 'pageNumber', 'pageIndex', 'activePage', 'page']),
                totalPages: pick(['totalPages', 'pageCount', 'numberOfPages', 'nbPages', 'pagesTotal', 'maxPage']),
                totalResults: pick(['totalResults', 'totalNumberOfResults', 'numberOfResults', 'totalCount', 'resultCount', 'nbResults', 'numberOfProducts', 'hitCount', 'nbHits', 'total', 'count']),
                pageSize: pick(['pageSize', 'perPage', 'itemsPerPage', 'viewSize', 'size', 'limit']),
              } };
            }
          }
        } catch { /* not JSON here; keep scanning */ }
      }
      idx = html.indexOf(marker, idx + marker.length);
    }
  }
  // Then the NAME-AGNOSTIC scan: parse every JSON island / inline-script state on the
  // page and mine it by shape — so a site whose product array lives under a container
  // name we have never seen (Levi's __LSCO_INITIAL_STATE__, or any future SPA) still
  // works, with no per-site name to add. Largest product array wins.
  const viaScan = scanEmbeddedJson(html, baseUrl);
  if (viaScan && viaScan.cards.length && (!best || viaScan.cards.length > best.cards.length)) best = viaScan;
  return best || { cards: [], pagination: null };
}

/**
 * Every JSON value the page carries (JSON islands, inline-script state assignments,
 * JSON.parse strings, Next.js flight rows), parsed — the same scan the extractor
 * uses, for a caller that needs the raw data (the AI assist). Bounded.
 * @returns {any[]}
 */
export function embeddedJsonValues(html, { max = 40 } = {}) {
  const out = [];
  if (!html) return out;
  const s = String(html);
  scanEmbeddedJson(s, '', (v) => { if (out.length < max) out.push(v); });
  // + the arrays found by their key inside a blob that is not parsed whole
  // ("products":{"collection":[…]} in a large JS state object).
  for (const key of ARRAY_KEYS) {
    const marker = `"${key}":[`;
    let idx = s.indexOf(marker); let n = 0;
    while (idx >= 0 && n < 10 && out.length < max + 20) {
      const raw = balancedArray(s, idx + marker.length - 1);
      if (raw) { try { const arr = JSON.parse(raw); if (Array.isArray(arr) && arr.length && arr[0] && typeof arr[0] === 'object') { out.push({ [key]: arr }); n++; } } catch { /* not JSON here */ } }
      idx = s.indexOf(marker, idx + marker.length);
    }
  }
  return out;
}
