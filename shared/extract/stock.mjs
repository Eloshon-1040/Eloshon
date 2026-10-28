/**
 * Stock and reviews, read by SHAPE from any JSON a page carries or loads (no site
 * rule): availability per product code (EAN / GTIN / UPC / SKU id), the product's
 * own availability, and its rating + number of reviews.
 *
 * Canonical availability: the schema.org terms 'InStock' | 'OutOfStock' | 'PreOrder'
 * | 'BackOrder' | 'Discontinued' (what JSON-LD pages state, and what the converter
 * reads to set a zero stock). A stock level, when given, is kept apart: 'high' | 'medium' |
 * 'low' | 'none'.
 */

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const lc = (s) => String(s == null ? '' : s).toLowerCase().replace(/^https?:\/\/schema\.org\//, '').replace(/[\s-]+/g, '_');

/** A value (schema.org URL, word, boolean) → canonical availability, or null. */
export function normAvailability(v) {
  if (v === true) return 'InStock';
  if (v === false) return 'OutOfStock';
  const s = lc(v);
  if (!s) return null;
  if (/^(instock|in_stock|available|is_available|onlineonly|instoreonly|limitedavailability|limited|high|medium|low|yes|true)$/.test(s)) return 'InStock';
  if (/^(outofstock|out_of_stock|oos|soldout|sold_out|unavailable|not_available|none|no|false|out)$/.test(s)) return 'OutOfStock';
  if (/^(preorder|pre_order|presale|pre_sale|coming_soon|comingsoon)$/.test(s)) return 'PreOrder';
  if (/^(backorder|back_order)$/.test(s)) return 'BackOrder';
  if (/^(discontinued)$/.test(s)) return 'Discontinued';
  return null;
}

/** A stock level word → 'high' | 'medium' | 'low' | 'none', or null. */
export function normLevel(v) {
  const s = lc(v);
  if (/^(high|plenty|many)$/.test(s)) return 'high';
  if (/^(medium|mid)$/.test(s)) return 'medium';
  if (/^(low|limited|limitedavailability|few|last_items?)$/.test(s)) return 'low';
  if (/^(oos|none|outofstock|out_of_stock|soldout|sold_out|zero)$/.test(s)) return 'none';
  return null;
}

const CODE_KEYS = ['gtin', 'gtin13', 'gtin14', 'gtin12', 'gtin8', 'ean', 'ean13', 'upc', 'barcode', 'skuid', 'sku_id', 'merchskuid', 'variantid', 'variant_id', 'sku'];
const BOOL_KEYS = ['available', 'isavailable', 'is_available', 'instock', 'in_stock', 'isinstock', 'is_in_stock', 'orderable', 'purchasable', 'buyable', 'sellable'];
const STATE_KEYS = ['availability', 'stockstatus', 'stock_status', 'inventorystatus', 'inventory_status', 'availabilitystatus', 'status'];
const LEVEL_KEYS = ['level', 'stocklevel', 'stock_level', 'ship', 'inventorylevel'];
const QTY_KEYS = ['quantity', 'qty', 'stock', 'stockquantity', 'stock_quantity', 'inventoryquantity', 'inventory_quantity', 'available_quantity', 'availablequantity'];
const NESTED_KEYS = ['availability', 'stock', 'inventory', 'stockinfo', 'availabilityinfo'];

const keyed = (o) => { const m = new Map(); for (const k of Object.keys(o)) m.set(k.toLowerCase(), o[k]); return m; };

/** Availability signal carried by ONE object (and its availability sub-object). */
function signalOf(o, depth = 0) {
  const m = keyed(o);
  let availability = null; let level = null;
  for (const k of BOOL_KEYS) if (typeof m.get(k) === 'boolean') { availability = m.get(k) ? 'InStock' : 'OutOfStock'; break; }
  for (const k of LEVEL_KEYS) { const l = normLevel(m.get(k)); if (l) { level = l; break; } }
  if (!availability) for (const k of STATE_KEYS) { const v = m.get(k); if (typeof v === 'string' || typeof v === 'boolean') { const a = normAvailability(v); if (a) { availability = a; break; } } }
  if (!availability) for (const k of QTY_KEYS) { const v = m.get(k); if (typeof v === 'number' && Number.isFinite(v)) { availability = v > 0 ? 'InStock' : 'OutOfStock'; break; } }
  if (depth < 1) for (const k of NESTED_KEYS) { const v = m.get(k); if (isObj(v)) { const s = signalOf(v, depth + 1); availability = availability || s.availability; level = level || s.level; } }
  if (!availability && level) availability = level === 'none' ? 'OutOfStock' : 'InStock';
  if (availability === 'OutOfStock' && !level) level = 'none';
  return { availability, level };
}

const codeOf = (o) => { const m = keyed(o); for (const k of CODE_KEYS) { const v = m.get(k); if ((typeof v === 'string' || typeof v === 'number') && String(v).trim()) return String(v).trim(); } return null; };
const digits = (s) => String(s).replace(/\D/g, '').replace(/^0+/, '');

/**
 * Availability per product code found anywhere in a JSON value.
 * @param {any} json
 * @returns {Map<string,{availability:string, level:string|null}>} code → signal
 */
export function availabilityByCode(json) {
  const out = new Map();
  const walk = (n, d) => {
    if (d > 12 || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) walk(x, d + 1); return; }
    const code = codeOf(n);
    if (code) { const s = signalOf(n); if (s.availability && !out.has(code)) out.set(code, s); }
    for (const v of Object.values(n)) walk(v, d + 1);
  };
  walk(json, 0);
  return out;
}

/** Look a code up, tolerant of leading zeros (EAN-13 vs GTIN-14). */
export function signalFor(map, code) {
  if (!code || !map || !map.size) return null;
  if (map.has(String(code))) return map.get(String(code));
  const d = digits(code);
  if (!d) return null;
  for (const [k, v] of map) if (digits(k) === d) return v;
  return null;
}

/** A product's own availability from its sizes: in stock if any size is, else the most telling state. */
export function productAvailability(variants) {
  const states = (variants || []).map((v) => v && v.availability).filter(Boolean);
  if (!states.length) return null;
  if (states.includes('InStock')) return 'InStock';
  if (states.includes('PreOrder')) return 'PreOrder';
  if (states.includes('BackOrder')) return 'BackOrder';
  return states.every((s) => s === 'Discontinued') ? 'Discontinued' : 'OutOfStock';
}

const RATING_KEYS = ['averagerating', 'average_rating', 'avgrating', 'avg_rating', 'ratingvalue', 'rating_value', 'averagescore', 'average_score', 'averageoverallrating', 'overallrating', 'ratingaverage', 'rating_average', 'ratingavg', 'averagerate', 'avgrate', 'meanrating', 'rating', 'stars', 'score'];
const COUNT_KEYS = ['reviewcount', 'review_count', 'reviewscount', 'reviews_count', 'totalreviews', 'total_reviews', 'totalreviewcount', 'numreviews', 'num_reviews', 'numberofreviews', 'amountofreviews', 'reviewsamount', 'ratingcount', 'rating_count', 'ratingscount', 'totalratings', 'numberofratings', 'directreviewscount', 'totalresults', 'total_review_count'];

/**
 * Rating (0–5) and number of reviews from any JSON value (a reviews summary, an
 * aggregateRating). The object carrying both wins; a count of 0 means "no review".
 * @returns {{rating:number|null, count:number}|null}
 */
export function ratingFromJson(json) {
  let best = null;
  const walk = (n, d) => {
    if (d > 10 || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n.slice(0, 50)) walk(x, d + 1); return; }
    const m = keyed(n);
    let rating = null; let count = null;
    for (const k of RATING_KEYS) { const v = Number(m.get(k)); if (m.get(k) != null && m.get(k) !== '' && typeof m.get(k) !== 'object' && Number.isFinite(v) && v >= 0 && v <= 5) { rating = v; break; } }
    for (const k of COUNT_KEYS) { const v = Number(m.get(k)); if (m.get(k) != null && m.get(k) !== '' && typeof m.get(k) !== 'object' && Number.isInteger(v) && v >= 0) { count = v; break; } }
    if (rating != null && count != null) { const score = 10 - d; if (!best || score > best.score) best = { rating, count, score }; }
    for (const v of Object.values(n)) walk(v, d + 1);
  };
  walk(json, 0);
  if (!best) return null;
  return { rating: best.count > 0 ? Math.round(best.rating * 100) / 100 : null, count: best.count };
}
