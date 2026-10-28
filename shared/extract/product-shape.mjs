/**
 * Generic PRODUCT-SHAPE scorer — a standalone, name-agnostic detector that walks any
 * decoded JSON tree and finds the array most likely to be a product grid, by the
 * SHAPE of its objects (not the container name, not the field names we happen to
 * know). This is the fallback that makes an UNKNOWN site work even when its container
 * name AND its internal field names are ones we have never seen: as long as the
 * objects look like products (a name, a price, an image, a url, an id), the array is
 * found and mapped.
 *
 * The known formats (Apollo, Flight, the embedded-state names) remain FAST SHORTCUTS
 * to the right blobs; this scorer runs over everything else in the tree.
 *
 * For each array of ≥2 objects, anywhere in the tree, it scores each element by the
 * PRESENCE of product fields (name / price-with-currency / image / url / id), adds a
 * homogeneity bonus (elements share a key shape) and applies penalties for
 * nav / breadcrumb / review / cart / facet arrays. The highest-scoring array wins.
 *
 * PORTABLE: zero Node built-ins, zero dependencies (small primitives inlined).
 */

// ── Portable primitives ───────────────────────────────────────────────────────
import { parseMoney, parseAmount, moneyQualifier, CUR, MONEY_RE } from './money.mjs';
function absoluteUrl(href, base) { if (!href) return null; try { return new URL(String(href), base).toString(); } catch { return null; } }
const PRODUCT_RE = /(\/product\/|\/produit\/|\/products\/|\/produits\/[a-z0-9]|\/p\/(?!(?:wiki|video|guide|help|about|blog|faq|page|content|info|news|story|lookbook)\/)|-p-\d|\/dp\/|\/item\/|\/artikel\/|\/pd\/)/i;
/**
 * A file, not a page: an image, a style sheet, a script, a font, a video or a PDF.
 * Never a product's own page — an image CDN path like "/products/123/origin.webp"
 * must not pass for a product URL (a site's menu tiles carry such picture links).
 */
export const ASSET_URL_RE = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|heic|css|m?js|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|pdf)(\?|#|$)/i;
export const isAssetUrl = (u) => typeof u === 'string' && ASSET_URL_RE.test(u);
/**
 * A tree node (menu / category tree): it holds a list of child objects under a
 * children-like key. With no price of its own it is a category, never a product.
 */
const CHILD_KEYS = ['items', 'children', 'subcategories', 'subCategories', 'categories', 'nodes', 'subItems', 'subitems', 'menu', 'columns'];
// A child that is a labelled entry with no commercial field (a variant or a bundle
// item carries a price / sku / size / stock and is not a menu entry).
const isMenuEntry = (e) => !!e && typeof e === 'object' && !Array.isArray(e)
  && ['title', 'name', 'label', 'text', 'displayName'].some((k) => typeof e[k] === 'string' && e[k].trim())
  && !Object.keys(e).some((k) => /(price|prix|amount|sku|gtin|ean|size|stock|qty|quantity|variant)/i.test(k));
export function isTreeNode(o) {
  if (!o || typeof o !== 'object') return false;
  return CHILD_KEYS.some((k) => { const a = o[k]; return Array.isArray(a) && a.length > 0 && a.filter(isMenuEntry).length >= Math.max(1, a.length * 0.5); });
}

// ── Field detection: name-driven by PATTERN, broadly MULTILINGUAL (the software's
// users are not only French/English). Covers EN/FR/DE/NL/ES/IT/PT/PL/scandinavian
// and common e-commerce variants. ──────────────────────────────────────────────
const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
// NAME / ID are ANCHORED (^…$) — exact key match, so short multilingual words are
// safe. URL / IMG / PRICE are SUBSTRING — restricted to distinctive tokens (no
// ultra-short ones) so they never match an unrelated key (no "ar"→"cart",
// "cover"→"discover", "uri"→"security"). norm() strips non-Latin, and product JSON
// keys are Latin in practice even on non-Latin sites; the site's language shows in
// the VALUES + currency, which money.mjs handles broadly.
const NAME_RE = /^(name|title|productname|producttitle|displayname|shortname|label|heading|caption|titre|nom|titel|naam|bezeichnung|nombre|titulo|nome|nazwa|tytul|navn|namn|nimi|cim|nev|urunadi)$/;
const URL_RE = /(producturl|producturi|productlink|pdpurl|canonicalurl|detailurl|weblink|deeplink|hyperlink|permalink|canonical|slug|handle|^url$|^uri$|^href$|^link$|^path$|^lien$|^enlace$|^collegamento$|^lenke$)/;
const IMG_RE = /(image|img|photo|thumb|picture|visual|imageurl|mediaurl|vignette|afbeelding|imagen|immagine|foto|obraz|zdjecie|gorsel|resim|billede|artworkurl)/;
// …plus the id of the ENTITY a listing card describes (propertyId, listingId, offerId):
// the card of an accommodation, a vehicle or a job carries no sku, its id is the key.
const ID_RE = /^(id|sku|code|ref|reference|itemid|productid|productcode|prodcode|mastercode|masterid|pid|gtin\d*|ean\d*|upc|mpn|asin|objectid|artikelnr|artikelnummer|produktnr|produktnummer|codigo|codice|kod|articulo|artikel|urunkodu|(?:listing|property|offer|entity|unit|room|accommodation|advert|annonce|vehicle|job)id)$/;
// A sub-object that IS the entity the card describes ({ listing:{ id } }, { property:{ id } }).
const ENTITY_SUB_RE = /(listing|product|item|property|offer|entity|accommodation|unit|room|hotel|vehicle|annonce|advert)/i;

/**
 * A GraphQL Relay "global id" (base64 of "Type:123") → its id part ("123"); any other
 * value is returned as is. Generic: the Relay convention, not a site rule.
 */
export function decodeRelayId(s) {
  const v = String(s == null ? '' : s);
  if (!/^[A-Za-z0-9+/]{8,}={0,2}$/.test(v)) return v;
  try {
    const txt = typeof atob === 'function' ? atob(v) : (typeof Buffer !== 'undefined' ? Buffer.from(v, 'base64').toString('utf8') : null);
    const m = txt && txt.match(/^[A-Za-z_][\w]*:([A-Za-z0-9_-]{1,64})$/);
    return m ? m[1] : v;
  } catch { return v; }
}
/**
 * The id carried by the entity sub-object of a card ({ demandListing:{ id:"…" } }) when
 * the card itself has none. Relay global ids are decoded to their id part.
 * @returns {string|null}
 */
export function nestedEntityId(o) {
  if (!o || typeof o !== 'object') return null;
  for (const [k, v] of Object.entries(o)) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || !ENTITY_SUB_RE.test(k)) continue;
    const id = v.id ?? v.ID ?? v.uuid ?? v.code;
    if ((typeof id === 'string' || typeof id === 'number') && String(id).length >= 1 && String(id).length <= 128) return decodeRelayId(String(id));
  }
  return null;
}
const PRICE_RE = /(price|amount|prix|prijs|preis|precio|prezzo|preco|montant|tarif|tarifa|bedrag|betrag|importe|importo|valor|cena|kwota|hinta|fiyat|tutar|costprice|unitprice|salesprice|listprice)/;
const CURRENCY_STR = new RegExp(`^\\s*(?:${CUR})\\s*\\d|\\d[\\d .,]*\\s*(?:${CUR})\\s*$`, 'i');

function priceFromValue(v, depth = 0) {
  if (v == null || depth > 3) return null;
  if (typeof v === 'number') return v > 0 && v < 1e6 ? v : null;
  if (typeof v === 'string') {
    const m = parseMoney(v); if (m) return m.price;
    // Bare numeric price field (JSON-LD lowPrice:"37.9", price:"37.90"): the key is
    // already a price, so parse the amount even without a currency token in the string.
    const n = parseAmount(v); return (n != null && n > 0 && n < 1e6) ? n : null;
  }
  if (typeof v === 'object') {
    if (Array.isArray(v)) { for (const e of v) { const p = priceFromValue(e, depth + 1); if (p != null) return p; } return null; }
    for (const k of ['value', 'amount', 'price', 'centamount', 'formattedvalue', 'displayvalue', 'current', 'sales', 'final', 'now', 'min', 'minvariantprice']) {
      const rk = Object.keys(v).find((x) => norm(x) === k);
      if (rk != null) { let p = priceFromValue(v[rk], depth + 1); if (p != null) { if (k === 'centamount' && v.fractionDigits == null) p = p / 100; return p; } }
    }
    // A DISPLAY-LINE price object: the amount sits under a line / component key we do
    // not list ({ primaryLine:{ price:"116 €", qualifier:"au total" } },
    // { line:{ components:[{ discountedPrice:"839 €" }] } }) — the shape of a listing
    // card. Read depth-first: a money string or number under a price-named key first,
    // else the first money-formatted string (an accessibility label repeats the amount).
    const deep = deepMoney(v, depth);
    return deep ? deep.price : null;
  }
  return null;
}
const DEEP_SKIP_RE = /(logging|tracking|analytics|metadata|typename|style|position|colou?r|icon|id$)/;
/** @returns {{price:number, currency:string|null}|null} */
function deepMoney(v, depth) {
  if (!v || typeof v !== 'object' || depth > 3) return null;
  const entries = Array.isArray(v) ? v.slice(0, 6).map((x, i) => [String(i), x]) : Object.entries(v).slice(0, 40);
  let fallback = null;
  for (const [k, x] of entries) {
    const nk = norm(k);
    if (DEEP_SKIP_RE.test(nk)) continue;
    if (typeof x === 'string') {
      // The amount may be followed by its basis ("839 € au total"): an unanchored match.
      if (x.length > 80 || !MONEY_RE.test(x)) continue;
      const m = parseMoney(x); if (!m || !(m.price > 0)) continue;
      if (/price|amount|prix|total|value/.test(nk)) return { price: m.price, currency: m.currency || null };
      if (!fallback) fallback = { price: m.price, currency: m.currency || null };
    } else if (typeof x === 'number') {
      // A number is a price only under a price-named key that is not a secondary one
      // (a discount AMOUNT is skipped; a "discountedPrice" IS the price charged).
      if (/price|amount|prix|total/.test(nk) && (nk.endsWith('price') || !PRICE_SKIP_RE.test(nk)) && x > 0 && x < 1e6) return { price: x, currency: null };
    } else if (x && typeof x === 'object') {
      const p = deepMoney(x, depth + 1); if (p) return p;
    }
  }
  return fallback;
}

// A price-named key that is really a SECONDARY price (per-unit, range, was/old, tax,
// shipping, min/max…) — skipped by the broad fallback so the wrong number is not read.
const PRICE_SKIP_RE = /(per[a-z]|range|[^a-z]min|[^a-z]max|from|was|old|previous|strike|rrp|msrp|tax|vat|^fee|deposit|shipping|deliver|discount|saving|percent|^pct|rating|score|review|count|qty|quantity|stock|weight)/;
const CUR_KEY_RE = /^(currency|currencycode|currencyiso|pricecurrency|devise|waluta|valuta|moneda|moeda)$/;

/**
 * Broad, MULTILINGUAL last-resort scans of ONE product object — used to FILL a field
 * the keyed mapper (embedded-state) missed, so a site with an unusual price/url/image
 * key still yields a COMPLETE product without a per-site rule. Each returns null when
 * nothing plausible is found.
 */
export function scanPrice(o) {
  if (!o || typeof o !== 'object') return null;
  let currency = null;
  for (const k of Object.keys(o)) { if (CUR_KEY_RE.test(norm(k)) && typeof o[k] === 'string') { const up = o[k].toUpperCase(); if (/^[A-Z]{3}$/.test(up)) { currency = up; break; } } }
  for (const k of Object.keys(o)) {
    const nk = norm(k);
    const named = PRICE_RE.test(nk) && !PRICE_SKIP_RE.test(nk);
    const strMoney = typeof o[k] === 'string' && CURRENCY_STR.test(o[k]);
    if (!named && !strMoney) continue;
    const p = priceFromValue(o[k]);
    if (p != null && p > 0) {
      let cur = currency; const v = o[k];
      if (typeof v === 'string') { const m = parseMoney(v); if (m && m.currency) cur = m.currency; }
      else if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const ck of Object.keys(v)) { if (CUR_KEY_RE.test(norm(ck)) && typeof v[ck] === 'string' && /^[A-Z]{3}$/.test(v[ck].toUpperCase())) { cur = v[ck].toUpperCase(); break; } }
        // A display-line object: the currency is in the money string that gave the amount.
        if (!cur) { const d = deepMoney(v, 0); if (d && d.currency) cur = d.currency; }
      }
      return { price: p, currency: cur };
    }
  }
  return null;
}
/**
 * An image value: a string, { url } / { src }, an array (first entry), or an object of
 * named renditions ({ portraitURL, squarishURL, … }) — the first URL-like value.
 */
function imageValue(v, depth = 0) {
  if (typeof v === 'string') return v;
  if (!v || typeof v !== 'object' || depth > 2) return null;
  // An array of picture OBJECTS ([{ picture:"https://…" }, …]) — the first usable one.
  if (Array.isArray(v)) { for (const e of v.slice(0, 3)) { const s = imageValue(e, depth + 1); if (s) return s; } return null; }
  if (typeof v.url === 'string' || typeof v.src === 'string') return v.url || v.src;
  // The URL under another picture-named key ({ picture:"…" }, { imageUrl:"…" }).
  for (const [k, x] of Object.entries(v)) if (typeof x === 'string' && /(url|src|picture|image|photo)/i.test(k) && /^(https?:)?\/\//i.test(x)) return x;
  // One level down ({ large:{ url } }, { image:{ src } }).
  for (const [k, x] of Object.entries(v)) if (x && typeof x === 'object' && /(picture|image|photo|url|src|large|medium|small|default|original)/i.test(k)) { const s = imageValue(x, depth + 1); if (s) return s; }
  return null;
}
export function scanUrl(o, baseUrl) {
  if (!o || typeof o !== 'object') return null;
  let first = null;
  for (const k of Object.keys(o)) {
    const nk = norm(k);
    if (IMG_RE.test(nk)) continue;
    if (!URL_RE.test(nk) && !/(url|uri|link)$/.test(nk)) continue;
    let v = o[k];
    // A link object ({ url, path } / { href }) instead of a string.
    if (v && typeof v === 'object' && !Array.isArray(v)) v = [v.url, v.href, v.uri, v.path].find((x) => typeof x === 'string' && x) || null;
    if (typeof v !== 'string' || !v) continue;
    const abs = absoluteUrl(v, baseUrl);
    if (!abs || isAssetUrl(abs)) continue;
    if (PRODUCT_RE.test(abs)) return abs;
    if (!first) first = abs;
  }
  return first;
}
export function scanImage(o, baseUrl) {
  if (!o || typeof o !== 'object') return null;
  for (const k of Object.keys(o)) {
    if (!IMG_RE.test(norm(k))) continue;
    const v = o[k];
    const s = imageValue(v);
    if (s && typeof s === 'string') { const abs = absoluteUrl(s, baseUrl); if (abs) return abs; }
  }
  return null;
}

/**
 * Analyse ONE object for product signals. Returns booleans + a numeric score and the
 * normalised key set (for homogeneity).
 */
export function analyzeObject(o) {
  const out = { name: false, price: false, image: false, url: false, id: false, review: false, nav: false, keys: [] };
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ...out, score: 0, signal: false };
  let productUrl = false;
  for (const k of Object.keys(o)) {
    const nk = norm(k); out.keys.push(nk);
    const v = o[k];
    if (!out.name && NAME_RE.test(nk) && typeof v === 'string' && v.trim().length >= 2 && v.length <= 300) out.name = true;
    if (!out.id && ID_RE.test(nk) && (typeof v === 'string' || typeof v === 'number') && String(v).length >= 1 && String(v).length <= 64) out.id = true;
    if (!out.url && URL_RE.test(nk) && typeof v === 'string' && v.length >= 1 && !isAssetUrl(v)) { out.url = true; if (PRODUCT_RE.test(v)) productUrl = true; }
    if (!out.image && IMG_RE.test(nk)) {
      const s = imageValue(v);
      if (s && typeof s === 'string' && (/\.(jpe?g|png|webp|avif|gif)(\?|$)/i.test(s) || /\/(images?|media|photos?|cdn)/i.test(s) || /^https?:/i.test(s))) out.image = true;
    }
    if (!out.price && (PRICE_RE.test(nk) || (typeof v === 'string' && CURRENCY_STR.test(v)))) { if (priceFromValue(v) != null) out.price = true; }
    if (/^(rating|stars?|score|reviewcount|author|comment|review|note|avis)$/.test(nk)) out.review = true;
  }
  if (!out.id && nestedEntityId(o)) out.id = true;
  // A nav/breadcrumb/menu node: a label + a url and nothing else product-like, or
  // a category-tree node (child list, no price).
  out.nav = ((out.name || out.url) && !out.price && !out.id && !out.image && out.keys.length <= 4) || (!out.price && isTreeNode(o));
  out.productUrl = productUrl;
  const score = (out.name ? 2 : 0) + (out.price ? 3 : 0) + (out.image ? 2 : 0) + (out.url ? 2 : 0) + (out.id ? 1 : 0);
  // A product SIGNAL is STRONG: a price, a product-detail URL, or an image. A bare
  // `id` or a lone `name` is NOT a product — every tracking / config record has an id
  // (hydrozone's {id, url:"use.typekit.net/…"}) and font families have just a name
  // ("Archivo", "Anton"…). Requiring price/url/image keeps the detector off those
  // arrays. Generic, no site rule.
  const signal = out.price || productUrl || out.image;
  return { ...out, score, signal };
}

// Jaccard similarity of two normalised key sets.
function jaccard(a, b) { const A = new Set(a); const B = new Set(b); let inter = 0; for (const x of A) if (B.has(x)) inter++; const uni = A.size + B.size - inter; return uni ? inter / uni : 0; }

export const DEMOTE_CONTAINER = /(recommend|recentlyviewed|crosssell|upsell|related|similar|review|breadcrumb|suggest|facet|filter|menu|nav|banner|promo|story|lookbook|wishlist|cart|basket|recentlysearched|youmayalsolike)/;

// ── Listing-card extras ───────────────────────────────────────────────────────
// What a LISTING card (an accommodation, a vehicle, a job…) states besides name /
// price / image / link: its secondary lines (sub-title, dates, host type), its rating
// as the site writes it ("4,75", "4.6 (134)"), and the BASIS of its price ("au total",
// "par nuit"). Read by SHAPE: short strings under sub-title keys, short `{ body|text }`
// entries of line arrays, a rating string that is a number ≤ 5 with an optional count,
// the qualifier key or the words right after the amount. Never a site rule.
const SUBTITLE_KEY_RE = /^(subtitle|subtitel|sub_title|secondarytext|secondary_text|secondaryline|tagline|caption|kicker|strapline|shortdescription|short_description|summary)$/;
const LINES_KEY_RE = /(lines?|messages?)$/;
const RATING_STR_RE = /(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:\(\s*(\d[\d\s.,]*)\s*\))?/;
const QUALIFIER_KEY_RE = /^(qualifier|pricequalifier|unit|priceunit|period|suffix|basis|per|pricesuffix)$/;
// A secondary line is a short text without a price in it (a "+ 10 € credit" promo
// message or a struck price is not a line of the card's description).
function lineText(e) {
  let s = null;
  if (typeof e === 'string') s = e;
  else if (e && typeof e === 'object' && !Array.isArray(e)) {
    const keys = Object.keys(e).filter((k) => k !== '__typename');
    if (keys.length > 3) return null;
    s = e.body ?? e.text ?? e.message;
  }
  if (typeof s !== 'string') return null;
  s = s.trim();
  return s && s.length <= 80 && !MONEY_RE.test(s) ? s : null;
}
// Containers whose lines are never a description: payment / promo / badge messages.
const NOT_LINES_RE = /(payment|promo|badge|discount|logging|tracking|legal|disclaimer)/;
function priceNoteIn(v, depth) {
  if (v == null || depth > 3) return null;
  if (typeof v === 'string') { const q = moneyQualifier(v); return q ? { note: q, text: v.trim() } : null; }
  if (typeof v !== 'object') return null;
  const entries = Array.isArray(v) ? v.slice(0, 6).map((x) => ['', x]) : Object.entries(v).slice(0, 40);
  // An explicit qualifier next to the amount wins ({ price:"116 €", qualifier:"au total" }).
  let amount = null; let qual = null;
  for (const [k, x] of entries) {
    if (typeof x !== 'string' || !x.trim()) continue;
    const nk = norm(k);
    if (QUALIFIER_KEY_RE.test(nk) && x.trim().length <= 40) qual = x.trim();
    else if (/price|amount|prix|total/.test(nk) && CURRENCY_STR.test(x) && !amount) amount = x.trim();
  }
  if (qual) return { note: qual, text: amount ? `${amount} ${qual}` : null };
  for (const [, x] of entries) { if (typeof x === 'string' && x.length <= 80 && MONEY_RE.test(x)) { const q = moneyQualifier(x); if (q) return { note: q, text: x.trim() }; } }
  for (const [, x] of entries) { if (x && typeof x === 'object') { const r = priceNoteIn(x, depth + 1); if (r) return r; } }
  return null;
}
/**
 * @returns {{ description:string|null, rating:number|null, reviewCount:number|null, priceNote:string|null, priceText:string|null }}
 */
export function listingExtras(o) {
  const out = { description: null, rating: null, reviewCount: null, priceNote: null, priceText: null };
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  const parts = [];
  for (const [k, v] of Object.entries(o)) {
    const nk = norm(k);
    if (NOT_LINES_RE.test(nk)) continue;
    if (typeof v === 'string') { if (SUBTITLE_KEY_RE.test(nk) && v.trim() && v.trim().length <= 120 && !MONEY_RE.test(v)) parts.push(v.trim()); continue; }
    if (Array.isArray(v)) { if (LINES_KEY_RE.test(nk)) for (const e of v.slice(0, 4)) { const t = lineText(e); if (t) parts.push(t); } continue; }
    if (v && typeof v === 'object' && /(content|structured|lines?)$/.test(nk)) {
      for (const [k2, arr] of Object.entries(v)) if (Array.isArray(arr) && LINES_KEY_RE.test(norm(k2)) && !NOT_LINES_RE.test(norm(k2))) for (const e of arr.slice(0, 4)) { const t = lineText(e); if (t) parts.push(t); }
    }
  }
  if (parts.length) out.description = [...new Set(parts)].join(' · ').slice(0, 300);
  for (const [k, v] of Object.entries(o)) {
    const nk = norm(k);
    if (!/rating|stars|avis|^note$/.test(nk) || /a11y|label|accessib|count|total|number/.test(nk)) continue;
    if (typeof v === 'string') {
      const m = v.match(RATING_STR_RE); if (!m) continue;
      const r = parseFloat(m[1].replace(',', '.'));
      if (!(r >= 0 && r <= 5)) continue;
      out.rating = r;
      if (m[2]) { const c = parseInt(m[2].replace(/[\s.,]/g, ''), 10); if (Number.isFinite(c)) out.reviewCount = c; }
      break;
    }
    if (typeof v === 'number' && v >= 0 && v <= 5 && /rating|stars/.test(nk)) { out.rating = v; break; }
  }
  for (const [k, v] of Object.entries(o)) {
    const nk = norm(k);
    if (!PRICE_RE.test(nk) || PRICE_SKIP_RE.test(nk)) continue;
    const got = priceNoteIn(v, 0);
    if (got) { out.priceNote = got.note; out.priceText = got.text; break; }
  }
  return out;
}

/**
 * Score an array as a product grid. Returns { count, score } — score 0 means "not a
 * product grid". `containerKey` is the key the array sat under (for a demotion).
 */
export function scoreArray(arr, containerKey = '') {
  if (!Array.isArray(arr)) return { count: 0, score: 0 };
  const objs = arr.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
  if (objs.length < 2) return { count: 0, score: 0 };
  const infos = objs.map(analyzeObject);
  const products = infos.filter((i) => i.signal);
  const productFraction = products.length / objs.length;
  if (products.length < 2 || productFraction < 0.5) return { count: products.length, score: 0 };
  // Review / nav arrays: reject even if they carry a stray number.
  const reviewFrac = infos.filter((i) => i.review && !i.price && !i.id).length / objs.length;
  const navFrac = infos.filter((i) => i.nav).length / objs.length;
  if (reviewFrac >= 0.5 || navFrac >= 0.5) return { count: products.length, score: 0 };
  // Homogeneity: how alike the element key-sets are (sampled).
  const sample = products.slice(0, 8);
  let hom = 1;
  if (sample.length >= 2) { let s = 0, n = 0; for (let i = 0; i < sample.length; i++) for (let j = i + 1; j < sample.length; j++) { s += jaccard(sample[i].keys, sample[j].keys); n++; } hom = n ? s / n : 1; }
  const avgScore = products.reduce((a, i) => a + i.score, 0) / products.length;
  const demote = DEMOTE_CONTAINER.test(norm(containerKey)) ? 0.35 : 1;
  // Score rewards: real product signals (avgScore), a predominantly-product array,
  // homogeneous shape, and size (log). Demoted for reco/nav/review containers.
  const score = avgScore * productFraction * (0.4 + 0.6 * hom) * (1 + Math.log10(1 + products.length)) * demote;
  return { count: products.length, score, homogeneity: hom, productFraction };
}

// Map one object → a product card using the BROAD field detection (independent of
// embedded-state's mapProduct key lists), so unusual/non-English field names work.
function cardFromObject(o, baseUrl) {
  let src = o;
  if (o && typeof o === 'object' && !o.name && !o.title && (o.item || o.node)) src = o.item || o.node;
  const pick = (re, pred) => { for (const k of Object.keys(src)) if (re.test(norm(k))) { const v = src[k]; if (pred(v)) return v; } return null; };
  const name = pick(NAME_RE, (v) => typeof v === 'string' && v.trim().length >= 2);
  const rawUrl = pick(URL_RE, (v) => typeof v === 'string' && v.length >= 1);
  let price = null; let currency = null;
  for (const k of Object.keys(src)) { if (PRICE_RE.test(norm(k)) || (typeof src[k] === 'string' && CURRENCY_STR.test(src[k]))) { const p = priceFromValue(src[k]); if (p != null) { price = p; const m = typeof src[k] === 'string' ? parseMoney(src[k]) : null; if (m && m.currency) currency = m.currency; break; } } }
  if (!currency) { const c = pick(/^(currency|currencycode|currencyiso|pricecurrency)$/, (v) => typeof v === 'string'); if (c && /^[A-Z]{3}$/.test(c.toUpperCase())) currency = c.toUpperCase(); }
  const id = pick(ID_RE, (v) => (typeof v === 'string' || typeof v === 'number') && String(v).length >= 1 && String(v).length <= 64) ?? nestedEntityId(src);
  let image = null;
  for (const k of Object.keys(src)) { if (IMG_RE.test(norm(k))) { const v = src[k]; const s = imageValue(v); if (s && typeof s === 'string') { image = s; break; } } }
  const absUrl = rawUrl ? absoluteUrl(rawUrl, baseUrl) : null;
  const url = absUrl && !isAssetUrl(absUrl) ? absUrl : null;
  // A product has at least a name or a price — an id+url record with neither is a
  // font/tracking/config object, not a product (hydrozone typekit pattern).
  if (name == null && price == null) return null;
  if (price == null && isTreeNode(src)) return null; // a category-tree node
  // …and a STRONG signal (price / product-URL / image). A bare id or lone name is not
  // a product (font families "Archivo"/"Anton" have only a name).
  const hasSignal = price != null || image != null || (url && PRODUCT_RE.test(url));
  if (!hasSignal || (!name && !url)) return null;
  const card = { strategy: 'shape' };
  if (url) { card.sourceUrl = url; card.canonicalUrl = url; }
  if (name) card.name = String(name).trim();
  if (price != null) card.price = price;
  if (currency) card.currency = currency;
  if (id != null) card.sku = String(id);
  const img = image ? absoluteUrl(image, baseUrl) : null;
  if (img) card.images = [img];
  // Listing-card extras: secondary lines + the price with its basis as the description,
  // the rating as stated. Never for a product with a real EAN (an e-commerce card).
  const ex = listingExtras(src);
  const line = ex.priceText && !card.gtin ? ex.priceText : null;
  if (ex.description || line) card.description = [ex.description, line].filter(Boolean).join(' · ');
  if (ex.rating != null) { card.rating = ex.rating; if (ex.reviewCount != null) card.reviewCount = ex.reviewCount; }
  return card;
}

/**
 * Walk any decoded JSON value, score every array by SHAPE, and extract the best
 * product grid with the broad mapper. Name-agnostic end to end.
 * @returns {{cards:object[], pagination:null, score:number}}
 */
export function extractProductsByShape(value, baseUrl) {
  let best = { arr: null, container: null, score: 0, count: 0 };
  const walk = (node, containerKey) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      const r = scoreArray(node, containerKey);
      if (r.score > 0 && (r.score > best.score || (r.score === best.score && r.count > best.count))) best = { arr: node, container: containerKey, score: r.score, count: r.count };
      for (const v of node) walk(v, containerKey);
      return;
    }
    for (const k of Object.keys(node)) walk(node[k], k);
  };
  walk(value, '');
  if (!best.arr) return { cards: [], pagination: null, score: 0 };
  const cards = best.arr.map((o) => cardFromObject(o, baseUrl)).filter(Boolean);
  return { cards, pagination: null, score: best.score };
}
