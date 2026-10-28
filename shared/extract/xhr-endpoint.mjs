/**
 * XHR/GraphQL endpoint capture + replay — the "intercept the API, then replay it
 * for pagination" layer (Stage C of the 2026 extraction research). A rendered SPA
 * loads its grid from a JSON/GraphQL response that never lands in the HTML; once the
 * tab has captured those responses, this module:
 *   1. finds the response that best yields products (by SHAPE, extractProductsFromJson);
 *   2. derives a REPLAYABLE next-page request from that response's own request —
 *      GET query params (page / offset / cursor) or a POST JSON body / GraphQL
 *      `variables` — with no per-site knowledge.
 * The caller (the extension) replays via its page-context fetch so the site's own
 * cookies/session apply, exactly like the internal-api recipe lane — but discovered
 * automatically instead of hand-written.
 *
 * PORTABLE: zero Node built-ins, zero dependencies (URL is a web/Node global).
 */
import { extractProductsFromJson } from './embedded-state.mjs';
import { scanPrice, scanUrl, scanImage } from './product-shape.mjs';

const normk = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
const INDEX_KEYS = ['page', 'pagenumber', 'pageindex', 'currentpage', 'pageno', 'pg'];
const OFFSET_KEYS = ['offset', 'from', 'start', 'startindex', 'skip'];
const CURSOR_KEYS = ['after', 'cursor', 'aftercursor', 'endcursor', 'nextcursor', 'searchafter', 'nextpagetoken', 'pagetoken'];
const SIZE_KEYS = ['hitsperpage', 'pagesize', 'perpage', 'pagelimit', 'limit', 'size', 'count', 'rows', 'num'];

const isInt = (v) => /^\d+$/.test(String(v));
function tryParse(s) { if (s == null) return null; if (typeof s === 'object') return s; try { return JSON.parse(s); } catch { return null; } }
const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Pick the captured response that best yields products.
 * @param {Array<{url:string, method?:string, requestBody?:string|null, status?:number, body:string|object, headers?:object}>} captures
 * @param {string} baseUrl
 * @returns {{cards:object[], pagination:object|null, capture:{url:string, method:string, requestBody:string|null, headers:object}}|null}
 */
export function productsFromCaptures(captures, baseUrl) {
  let best = null;
  for (const c of (captures || [])) {
    if (!c || !c.body) continue;
    if (c.status != null && (c.status < 200 || c.status >= 300)) continue;
    const parsed = tryParse(c.body);
    if (!parsed || typeof parsed !== 'object') continue;
    const got = extractProductsFromJson(parsed, baseUrl);
    if (got.cards.length && (!best || got.cards.length > best.cards.length)) {
      best = { cards: got.cards, pagination: got.pagination, capture: { url: c.url, method: String(c.method || 'GET').toUpperCase(), requestBody: c.requestBody || null, headers: c.headers || {} } };
    }
  }
  return best;
}

// A URL-encoded params STRING ("query=x&hitsPerPage=20&page=0") — the shape Algolia
// (requests[].params) and some search SaaS nest inside a JSON body. Find its paging
// field, its size, and rebuild it with a new value.
function encodedPaging(str) {
  for (const p of String(str).split('&')) {
    const eq = p.indexOf('='); if (eq < 0) continue;
    let k, v; try { k = normk(decodeURIComponent(p.slice(0, eq))); v = decodeURIComponent(p.slice(eq + 1)); } catch { continue; }
    if (INDEX_KEYS.includes(k) && isInt(v)) return { rawKey: p.slice(0, eq), style: 'index', value: Number(v) };
    if (OFFSET_KEYS.includes(k) && isInt(v)) return { rawKey: p.slice(0, eq), style: 'offset', value: Number(v) };
    if (CURSOR_KEYS.includes(k)) return { rawKey: p.slice(0, eq), style: 'cursor', value: v };
  }
  return null;
}
function encodedSize(str) { for (const p of String(str).split('&')) { const eq = p.indexOf('='); if (eq < 0) continue; let k, v; try { k = normk(decodeURIComponent(p.slice(0, eq))); v = decodeURIComponent(p.slice(eq + 1)); } catch { continue; } if (SIZE_KEYS.includes(k) && isInt(v)) return Number(v); } return null; }
function bumpEncoded(str, rawKey, newVal) {
  return String(str).split('&').map((p) => { const eq = p.indexOf('='); if (eq < 0 || p.slice(0, eq) !== rawKey) return p; return `${rawKey}=${encodeURIComponent(String(newVal))}`; }).join('&');
}
const looksEncodedParams = (v) => typeof v === 'string' && v.includes('=') && /(?:^|&)[^&=]*(?:page|offset|start|from|cursor|after|hitsperpage|skip)=/i.test(v);

// Find the FIRST paging field in a parsed body (recursive: GraphQL variables, and a
// URL-encoded params string à la Algolia).
function findBodyPaging(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 5) return null;
  if (Array.isArray(node)) { for (const v of node) { const r = findBodyPaging(v, depth + 1); if (r) return r; } return null; }
  for (const k of Object.keys(node)) {
    const nk = normk(k); const v = node[k];
    if (typeof v === 'number' || typeof v === 'string') {
      if (INDEX_KEYS.includes(nk) && isInt(v)) return { container: node, key: k, style: 'index', value: Number(v) };
      if (OFFSET_KEYS.includes(nk) && isInt(v)) return { container: node, key: k, style: 'offset', value: Number(v) };
      if (CURSOR_KEYS.includes(nk)) return { container: node, key: k, style: 'cursor', value: v };
    }
    if (typeof v === 'string' && looksEncodedParams(v)) { const inner = encodedPaging(v); if (inner) return { container: node, key: k, style: 'encoded', value: v, inner }; }
  }
  for (const k of Object.keys(node)) { const r = findBodyPaging(node[k], depth + 1); if (r) return r; }
  return null;
}
function findBodySize(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 5) return null;
  for (const k of Object.keys(node)) { if (SIZE_KEYS.includes(normk(k)) && isInt(node[k])) return Number(node[k]); }
  for (const k of Object.keys(node)) { const r = findBodySize(node[k], depth + 1); if (r) return r; }
  return null;
}

// Query-string paging style for a URL, or null.
function queryPaging(u) {
  for (const [k, v] of u.searchParams) {
    const nk = normk(k);
    if (INDEX_KEYS.includes(nk) && isInt(v)) return { key: k, style: 'index', value: Number(v) };
    if (OFFSET_KEYS.includes(nk) && isInt(v)) return { key: k, style: 'offset', value: Number(v) };
    if (CURSOR_KEYS.includes(nk)) return { key: k, style: 'cursor', value: v };
  }
  return null;
}
function querySize(u) { for (const [k, v] of u.searchParams) if (SIZE_KEYS.includes(normk(k)) && isInt(v)) return Number(v); return null; }

// The paged value for extra-page `iteration` (1 = the page AFTER the captured one).
function pagedValue(paging, iteration, pageSize, cursor) {
  if (paging.style === 'index') return paging.value + iteration;
  if (paging.style === 'offset') return paging.value + (pageSize || 0) * iteration;
  return cursor != null ? cursor : null; // cursor comes from the previous response
}

/**
 * Build the request for extra page `iteration` (1-based) from a captured request.
 * @param {{url:string, method:string, requestBody:string|null, headers:object}} capture
 * @param {{iteration:number, pageSize?:number|null, cursor?:string|number|null}} opts
 * @returns {{url:string, method:string, headers:object, body:string|null}|null}
 */
export function nextPageRequest(capture, { iteration, pageSize = null, cursor = null } = {}) {
  if (!capture || !capture.url || !Number.isInteger(iteration) || iteration < 1) return null;
  const method = String(capture.method || 'GET').toUpperCase();
  let u; try { u = new URL(capture.url); } catch { return null; }

  // POST/PUT with a JSON body — GraphQL or a search API. Page inside the body first.
  if (method !== 'GET' && method !== 'HEAD' && capture.requestBody) {
    const body = tryParse(capture.requestBody);
    if (body && typeof body === 'object') {
      const paging = findBodyPaging(body);
      if (paging) {
        const next = clone(body);
        const target = findBodyPaging(next); // same field in the clone
        if (!target) return null;
        if (paging.style === 'encoded') {
          // A URL-encoded params string (Algolia requests[].params, etc.).
          const size = pageSize || encodedSize(paging.value) || findBodySize(body);
          const nv = pagedValue(paging.inner, iteration, size, cursor);
          if (nv == null) return null;
          target.container[target.key] = bumpEncoded(target.value, target.inner.rawKey, nv);
        } else {
          const size = pageSize || findBodySize(body);
          const nv = pagedValue(paging, iteration, size, cursor);
          if (nv == null) return null;
          target.container[target.key] = paging.style === 'cursor' ? nv : (typeof paging.value === 'number' ? nv : String(nv));
        }
        return { url: capture.url, method, headers: capture.headers || {}, body: JSON.stringify(next) };
      }
    }
    // A POST with no pageable body can still page via its query string (below).
  }

  // GET (or POST whose query string carries the paging).
  const paging = queryPaging(u);
  if (!paging) return null;
  const size = pageSize || querySize(u);
  const nv = pagedValue(paging, iteration, size, cursor);
  if (nv == null) return null;
  u.searchParams.set(paging.key, String(nv));
  return { url: u.toString(), method, headers: capture.headers || {}, body: capture.requestBody || null };
}

const productIds = (p) => [p && p.sku, p && p.gtin, p && p.id, p && p.source_product_id].filter((v) => v != null && v !== '').map(String);

/**
 * Fill a MISSING price (and url/image) on products from SEPARATELY-loaded XHR/GraphQL
 * responses — the very common "the grid tiles are in the page, the prices come from a
 * pricing API" split (Leroy Merlin / Adeo, many marketplaces). Generic: it joins by
 * the product's own id/sku, handling BOTH an array of `{id, price}` objects and an
 * id-keyed map `{ "SKU": {price…} }`. No per-site rule.
 * @param {object[]} products cards already extracted (may lack price)
 * @param {Array} captures    intercepted responses [{url, body, …}]
 * @param {string} baseUrl
 * @returns {object[]} products with prices filled where a match was found
 */
export function enrichFromCaptures(products, captures, baseUrl) {
  if (!Array.isArray(products) || !products.length || !Array.isArray(captures) || !captures.length) return products || [];
  const need = new Set();
  for (const p of products) if (p && p.price == null) for (const id of productIds(p)) need.add(id);
  if (!need.size) return products;

  const found = new Map(); // id → {price, currency, url, image}
  const consider = (id, src) => {
    const key = String(id);
    if (!need.has(key) || found.has(key) || !src || typeof src !== 'object') return;
    const pr = scanPrice(src);
    if (pr && pr.price != null) found.set(key, { price: pr.price, currency: pr.currency, url: scanUrl(src, baseUrl), image: scanImage(src, baseUrl) });
  };
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) { for (const v of node) walk(v, depth + 1); return; }
    const keys = Object.keys(node);
    // (a) an object that carries one of our ids in an id-ish field → its price is ours.
    for (const k of keys) { const v = node[k]; if ((typeof v === 'string' || typeof v === 'number') && /(^|[_-])(id|sku|code|ref|reference|productid|itemid|ean|gtin|article|model)([_-]|$)/i.test(k) && need.has(String(v))) consider(v, node); }
    // (b) an id-keyed map: { "92735466": { price… } }.
    for (const k of keys) { if (need.has(String(k)) && node[k] && typeof node[k] === 'object' && !Array.isArray(node[k])) consider(k, node[k]); }
    for (const k of keys) walk(node[k], depth + 1);
  };
  for (const c of captures) { if (!c || !c.body) continue; const parsed = tryParse(c.body); if (parsed) walk(parsed, 0); }
  if (!found.size) return products;

  return products.map((p) => {
    if (!p || p.price != null) return p;
    for (const id of productIds(p)) {
      const f = found.get(id);
      if (f) {
        const np = { ...p, price: f.price };
        if (f.currency && !np.currency) np.currency = f.currency;
        if (!np.sourceUrl && f.url) { np.sourceUrl = f.url; np.canonicalUrl = f.url; }
        if ((!np.images || !np.images.length) && f.image) np.images = [f.image];
        return np;
      }
    }
    return p;
  });
}

/** Does a captured response look paginatable at all (so the caller can decide to loop)? */
export function isPaginatable(capture) {
  return !!nextPageRequest(capture, { iteration: 1, pageSize: 24, cursor: 'x' });
}

const keyOf = (c) => (c && (c.sku || c.gtin || c.sourceUrl || c.canonicalUrl || (c.name && c.price != null ? `${c.name}|${c.price}` : c.name))) || null;

/**
 * Replay the discovered endpoint for extra pages, accumulating deduped products.
 * `fetchJson(url,{method,headers,body})` is injected (the extension supplies a
 * page-context fetch so the site's own session applies). Stops at the page/product
 * cap, when a page adds nothing new (site ignored the param), or when a fetch fails.
 * @returns {Promise<object[]>} all product cards (first page + replayed pages)
 */
export async function replayPaginate({ capture, firstCards = [], firstPagination = null, baseUrl, fetchJson, maxProducts = 1000, maxPages = 3 } = {}) {
  const cards = [...firstCards];
  const seen = new Set(cards.map(keyOf).filter(Boolean));
  let cursor = firstPagination && firstPagination.nextCursor != null ? firstPagination.nextCursor : null;
  const pageSize = (firstPagination && firstPagination.pageSize) || (firstCards.length || null);
  for (let it = 1; it < maxPages && cards.length < maxProducts; it++) {
    const req = nextPageRequest(capture, { iteration: it, pageSize, cursor });
    if (!req) break;
    let json;
    try { json = await fetchJson(req.url, { method: req.method, headers: req.headers, body: req.body }); } catch { break; }
    if (!json || typeof json !== 'object') break;
    const got = extractProductsFromJson(json, baseUrl);
    if (!got.cards.length) break;
    let added = 0;
    for (const c of got.cards) { const k = keyOf(c); if (k && seen.has(k)) continue; if (k) seen.add(k); cards.push(c); added++; if (cards.length >= maxProducts) break; }
    if (!added) break; // no new products → the site ignored the page param; stop
    cursor = got.pagination && got.pagination.nextCursor != null ? got.pagination.nextCursor : cursor;
  }
  return cards.slice(0, maxProducts);
}
