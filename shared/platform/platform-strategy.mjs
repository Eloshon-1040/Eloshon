/**
 * Item 9(a) Tier 1 — built-in PLATFORM-DEFAULT strategies (cross-site method
 * reuse, no persistence). Some platforms expose a deterministic, public,
 * structured product feed that every store on them shares — a fact of the
 * platform, not of the domain. When an UNKNOWN host (no learned recipe) is
 * detected as one of these, we can try that feed FIRST, for free, before the
 * generic discovery crawl. This is pure routing to existing adapters; nothing is
 * stored, and it is strictly fail-safe: a miss (wrong guess, empty feed, 404,
 * non-JSON) returns no products and the caller falls through to the normal ladder.
 *
 * Covered in v1:
 *   • Shopify      → GET /products.json?limit=250&page=N  (mapped by shopifyProductToRaw)
 *   • WooCommerce  → GET /wp-json/wc/store/v1/products?per_page=100&page=N (Store API, public)
 * PrestaShop / Magento already route through the generic JSON-LD / listing ladder,
 * so they get no separate default here (Tier 2 — learned cross-host reuse — is deferred).
 *
 * Pure + offline: an injected `httpGet(url,{as}) → {status, body}` (JSON when
 * as:'json') does all I/O; HTML/JSON in, RawProduct[] out.
 */
import { shopifyProductToRaw } from './platform.mjs';

/** Platforms that have a built-in default strategy here. */
export const PLATFORMS_WITH_DEFAULT = new Set(['shopify', 'woocommerce']);

const originOf = (u) => { try { const x = new URL(u); return `${x.protocol}//${x.host}`; } catch { return null; } };

/**
 * Map one WooCommerce Store-API product to a RawProduct. Prices are minor units
 * (integer string) scaled by currency_minor_unit. Never throws; null when it is
 * not a usable product.
 */
// HTML entities the Store API leaves in its texts (« Système d&rsquo;éclairage », « marché &#8211; »).
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', deg: '°', times: '×', micro: 'µ' };
const decode = (s) => String(s).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
const plain = (html) => decode(String(html).replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|li|div|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');

export function wooStoreProductToRaw(p, origin) {
  if (!p || typeof p !== 'object' || !p.name) return null;
  const pr = p.prices || {};
  const minor = pr.currency_minor_unit == null ? 2 : Number(pr.currency_minor_unit);
  const money = (v) => ((v != null && v !== '') && Number.isFinite(Number(v)) ? Number(v) / Math.pow(10, Number.isFinite(minor) ? minor : 2) : null);
  const price = money(pr.price);
  const regular = money(pr.regular_price);
  const imgs = (Array.isArray(p.images) ? p.images : []).map((i) => i && i.src).filter((s) => typeof s === 'string' && s).slice(0, 20);
  // Attributes that are not a choice of the product (its characteristics) → specifications; the choices (variations)
  // are named, not priced here (the list API does not give a variation's price).
  const attrs = Array.isArray(p.attributes) ? p.attributes : [];
  const specs = attrs.filter((a) => a && a.name && !a.has_variations && Array.isArray(a.terms) && a.terms.length).map((a) => ({ group: null, name: decode(a.name), value: a.terms.map((t) => decode(t.name)).join(', ') }));
  const choices = attrs.filter((a) => a && a.name && a.has_variations && Array.isArray(a.terms) && a.terms.length).map((a) => `${decode(a.name)} : ${a.terms.map((t) => decode(t.name)).join(' | ')}`);
  return {
    name: plain(p.name).replace(/\n/g, ' '),
    description: p.short_description ? plain(p.short_description) : null,
    price: Number.isFinite(price) ? price : null,
    ...(regular != null && price != null && regular > price ? { listPrice: regular } : {}),
    ...(specs.length ? { specs } : {}),
    ...(choices.length ? { options: choices.join(' ; ').slice(0, 500) } : {}),
    ...(Array.isArray(p.categories) && p.categories.length > 1 ? { productCategories: p.categories.map((c) => decode(c.name)).join(', ') } : {}),
    currency: pr.currency_code || null,
    sku: p.sku ? String(p.sku).trim() : null,
    gtin: null,
    images: imgs, // the whole gallery, main picture first
    ...(Array.isArray(p.tags) && p.tags.length ? { tags: p.tags.map((t) => t && t.name).filter(Boolean).join(', ') } : {}),
    category: Array.isArray(p.categories) && p.categories[0] ? p.categories[0].name : null,
    sourceUrl: p.permalink || null,
    canonicalUrl: p.permalink || null,
    strategy: 'adapter-woocommerce',
    confidence: 0.9,
  };
}

/**
 * Run the built-in default feed for `platform` over HTTP. Paginates until an empty
 * or short page. Fail-safe: returns { ok:false, products:[] } on any miss.
 * @param {string} entryUrl
 * @param {{ httpGet:Function, platform:string, maxProducts?:number, maxPages?:number, onStep?:Function }} opts
 * @returns {Promise<{ ok:boolean, products:object[], pages:number, platform:string, error:string|null }>}
 */
/**
 * What the entry address is on this platform: the whole store (home, shop, « /collections/all »), ONE collection
 * (Shopify « /collections/<handle> », a WooCommerce category page — whatever its base, « /collections/x/ » on
 * marshydro), or another page (a product, a search): never the whole store for a collection (28/10: every product
 * of marshydro read for its LED collection).
 */
export function collectionScope(entryUrl, platform) {
  let u; try { u = new URL(entryUrl); } catch { return { kind: 'other' }; }
  const path = u.pathname.replace(/\/page\/\d+\/?$/i, '').replace(/\/+$/, '') || '/';
  const home = path === '/' || /^\/[a-z]{2}(-[a-z]{2})?$/i.test(path);
  if (platform === 'shopify') {
    const m = path.match(/^(.*?)\/collections\/([^/]+)$/);
    if (m) return m[2] === 'all' ? { kind: 'store' } : { kind: 'collection', handle: m[2], prefix: m[1] };
    return home ? { kind: 'store' } : { kind: 'other' };
  }
  if (home || /^(\/[a-z]{2})?\/(shop|boutique|winkel|tienda|negozio|store|produits|products)$/i.test(path)) return { kind: 'store' };
  return { kind: 'category', path, lang: u.searchParams.get('lang') };
}
/** Is a Store API product in the category `id`? (its own `categories`; a product that does not list them by id is kept) */
const inWooCategory = (p, id) => {
  const ids = (Array.isArray(p && p.categories) ? p.categories : []).map((c) => c && c.id).filter((x) => x != null);
  return !ids.length || ids.some((x) => Number(x) === Number(id));
};
const samePage = (a, b) => { try { const x = new URL(a); const y = new URL(b); const p = (z) => z.pathname.replace(/\/page\/\d+\/?$/i, '').replace(/\/+$/, ''); return x.host === y.host && p(x) === p(y); } catch { return false; } };

/** The WooCommerce category whose page is `entryUrl` (Store API categories, in the page's language): its id, or null. */
async function wooCategoryOf(origin, entryUrl, lang, httpGet) {
  for (let page = 1; page <= 5; page++) {
    let r; try { r = await httpGet(`${origin}/wp-json/wc/store/v1/products/categories?per_page=100&page=${page}${lang ? `&lang=${encodeURIComponent(lang)}` : ''}`, { as: 'json' }); } catch { return null; }
    if (!r || r.status >= 400 || !Array.isArray(r.body) || !r.body.length) return null;
    const hit = r.body.find((c) => c && c.permalink && samePage(c.permalink, entryUrl));
    if (hit) return { id: hit.id, name: hit.name || null, count: Number(hit.count) || null };
    if (r.body.length < 100) return null;
  }
  return null;
}

export async function platformDefaultLane(entryUrl, { httpGet, platform, maxProducts = 1000, maxPages = 60, onStep } = {}) {
  const origin = originOf(entryUrl);
  if (!origin || typeof httpGet !== 'function' || !PLATFORMS_WITH_DEFAULT.has(platform)) {
    return { ok: false, products: [], pages: 0, platform, error: 'no built-in default for platform' };
  }
  const step = (m, e) => { try { if (onStep) onStep(m, e || {}); } catch { /* never break the lane */ } };
  const products = []; const seen = new Set();
  // Products the shop returned for the category without being in it (their own categories say so): never taken as the
  // collection, listed (`outside`). When they are most of the answer, the shop did not filter: no feed at all.
  const outside = []; let outsideMore = 0;
  const push = (raw) => { if (!raw) return; const k = raw.sourceUrl || raw.canonicalUrl || `${raw.name}|${raw.price}`; if (seen.has(k)) return; seen.add(k); products.push(raw); };
  const pageSize = platform === 'shopify' ? 250 : 100;
  // The feed of THIS collection when the address is one; the whole store only for the store's own pages.
  const scope = collectionScope(entryUrl, platform);
  if (scope.kind === 'other') return { ok: false, products: [], pages: 0, platform, error: 'not_a_collection' };
  let wooCat = null;
  if (platform === 'woocommerce' && scope.kind === 'category') {
    wooCat = await wooCategoryOf(origin, entryUrl, scope.lang, httpGet);
    if (!wooCat) return { ok: false, products: [], pages: 0, platform, error: 'collection_not_resolved' };
  }
  const lang = scope.lang ? `&lang=${encodeURIComponent(scope.lang)}` : '';
  const urlFor = (page) => (platform === 'shopify'
    ? (scope.kind === 'collection' ? `${origin}${scope.prefix}/collections/${scope.handle}/products.json?limit=${pageSize}&page=${page}` : `${origin}/products.json?limit=${pageSize}&page=${page}`)
    : `${origin}/wp-json/wc/store/v1/products?per_page=${pageSize}&page=${page}${wooCat ? `&category=${wooCat.id}` : ''}${lang}`);
  let pages = 0;
  try {
    for (let page = 1; page <= maxPages && products.length < maxProducts; page++) {
      let r; try { r = await httpGet(urlFor(page), { as: 'json' }); } catch { break; }
      if (!r || r.status >= 400 || r.body == null) break;
      const items = platform === 'shopify' ? (r.body && Array.isArray(r.body.products) ? r.body.products : null) : (Array.isArray(r.body) ? r.body : null);
      if (!items || !items.length) break;
      for (const it of items) {
        if (platform === 'shopify') { const su = it.handle ? `${origin}/products/${it.handle}` : origin; push(shopifyProductToRaw(it, su)); }
        else if (wooCat && !inWooCategory(it, wooCat.id)) { if (outside.length < 200) outside.push({ name: decode(it.name || ''), url: it.permalink || null }); else outsideMore += 1; }
        else push(wooStoreProductToRaw(it, origin));
        if (products.length >= maxProducts) break;
      }
      pages += 1;
      step(page === 1 ? 'firstPage' : 'paginate', { page, found: products.length });
      if (items.length < pageSize) break;                 // last (short) page
    }
  } catch (e) {
    return { ok: products.length > 0, products, pages, platform, error: String((e && e.message) || e) };
  }
  // Every product of a collection carries the collection read (« Lampe de culture LED »), never its first category of
  // the store (« Hot Sale »: marshydro 28/10); its own categories stay in `productCategories`.
  if (wooCat && wooCat.name) for (const p of products) p.category = decode(wooCat.name);
  const outsideCount = outside.length + outsideMore;
  if (outsideCount && outsideCount >= products.length) {
    return { ok: false, products: [], pages, platform, scope: scope.kind, outside, outsideCount, error: 'collection_mismatch' };
  }
  return { ok: products.length > 0, products, pages, platform, scope: scope.kind, collection: wooCat ? { id: wooCat.id, name: wooCat.name, announced: wooCat.count } : (scope.kind === 'collection' ? { handle: scope.handle } : null), ...(outsideCount ? { outside, outsideCount } : {}), error: products.length ? null : 'no products' };
}
