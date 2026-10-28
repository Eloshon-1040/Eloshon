/**
 * Fallback extractors used when JSON-LD is absent or incomplete:
 *   - OpenGraph + product:* meta tags
 *   - schema.org microdata (itemprop=...)
 *   - <title> / <link rel=canonical>
 *   - embedded JSON blobs (__NEXT_DATA__, __NUXT__, preloaded state, Shopify)
 *
 * Regex-based (no DOM dependency). These are intentionally conservative: they
 * fill gaps left by JSON-LD rather than replace it.
 */
import { extractProductsFromJsonLd } from './jsonld.mjs';

/**
 * Clean a text field (typically a description) coming from any source: strip
 * HTML, decode common entities, collapse whitespace, and drop a stray leading
 * "null"/"undefined" token (a common upstream templating bug). Returns null when
 * nothing meaningful remains — so we never emit "<p>&nbsp;</p>" or "null <name>".
 */
export function cleanText(s) {
  if (s == null) return null;
  let t = String(s)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } }) // hex form (&#xE9; → é)
    .replace(/&#(\d{1,6});/g, (_m, n) => { try { return String.fromCodePoint(+n); } catch { return ' '; } })
    // HTML that was escaped in the source ("&lt;br&gt;") is only decoded above: its tags go too (known tags only).
    .replace(/<\/?(?:p|br|div|span|b|i|em|strong|u|ul|ol|li|h[1-6]|a|font|small|sup|sub|table|tbody|tr|td|th)\b[^<>]*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:null|undefined)(?=\s|$)\s*/i, '')
    .trim();
  return t.length ? t : null;
}

/**
 * Text that already has its structure (a description read from a block: one line per
 * paragraph / bullet): each line is cleaned like any text, the line breaks stay.
 */
export function cleanRichText(s) {
  if (s == null) return null;
  // Line breaks written as tags (raw or escaped) become real lines before each line is cleaned.
  const broken = String(s).replace(/&lt;(\/?(?:br|p|li|div|h[1-6])\b[^&]*?)&gt;/gi, '<$1>').replace(/<br\s*\/?>|<\/(?:p|li|div|h[1-6])>/gi, '\n');
  const lines = broken.split(/\r?\n/).map((l) => cleanText(l)).filter(Boolean);
  const t = lines.join('\n');
  return t.length ? t : null;
}

/**
 * Defense-in-depth: is this page editorial (a blog post / guide / FAQ / news
 * article) rather than a product? Such a page can carry a stray price from a
 * related-product widget and masquerade as a product (the tournesols "Gazon et
 * pelouse…" leak, same class as the earlier Lidl newsletter-page leak). A page
 * that DECLARES Product/Offer schema is always treated as a product (returns
 * false) — the editorial signal only wins when there is no product schema, so a
 * real product page with a breadcrumb article link is never dropped. Regex-based
 * (no parse), source-agnostic: JSON-LD editorial @type or og:type=article.
 * @param {string} html
 * @returns {boolean}
 */
export function isEditorialPage(html) {
  if (!html) return false;
  const s = String(html);
  // Explicit product schema anywhere → a product, never editorial.
  if (/"@type"\s*:\s*"(?:Product|ProductGroup|Offer|AggregateOffer)"/i.test(s)) return false;
  if (/<meta[^>]+property=["']og:type["'][^>]+content=["']article["']/i.test(s)) return true;
  if (/<meta[^>]+content=["']article["'][^>]+property=["']og:type["']/i.test(s)) return true; // attribute order swapped
  if (/"@type"\s*:\s*"(?:Article|NewsArticle|BlogPosting|LiveBlogPosting|TechArticle|FAQPage|QAPage)"/i.test(s)) return true;
  return false;
}

function metaContent(html, attr, value) {
  // matches <meta property="og:title" content="..."> in any attribute order
  const re = new RegExp(
    `<meta[^>]*(?:${attr})=["']${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
    'i',
  );
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  return tag.match(/content=["']([\s\S]*?)["']/i)?.[1]?.trim() || null;
}

function num(v) {
  if (v == null) return null;
  const c = String(v).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
  const n = parseFloat(c);
  return Number.isFinite(n) ? n : null;
}

/** Every <meta> of a property, in page order (a page may declare several og:image). */
function metaAll(html, attr, value) {
  const re = new RegExp(`<meta[^>]*(?:${attr})=["']${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'gi');
  const out = [];
  for (const tag of html.match(re) || []) { const c = tag.match(/content=["']([\s\S]*?)["']/i)?.[1]?.trim(); if (c) out.push(c); }
  return out;
}

/** OpenGraph + product meta. */
export function extractFromMeta(html) {
  const title = metaContent(html, 'property', 'og:title') || metaContent(html, 'name', 'twitter:title');
  const desc = metaContent(html, 'property', 'og:description') || metaContent(html, 'name', 'description');
  // Every declared picture, in order: og:image (several allowed), its secure form, twitter:image, link[rel=image_src].
  const images = [...new Set([
    ...metaAll(html, 'property', 'og:image'), ...metaAll(html, 'property', 'og:image:secure_url'), ...metaAll(html, 'property', 'og:image:url'),
    ...metaAll(html, 'name', 'twitter:image'),
    ...(html.match(/<link[^>]*rel=["']image_src["'][^>]*>/i)?.[0]?.match(/href=["']([^"']+)["']/i)?.[1]?.trim() ? [html.match(/<link[^>]*rel=["']image_src["'][^>]*>/i)[0].match(/href=["']([^"']+)["']/i)[1].trim()] : []),
  ])];
  const image = images[0] || null;
  const price = num(
    metaContent(html, 'property', 'product:price:amount') ||
    metaContent(html, 'property', 'og:price:amount') ||
    metaContent(html, 'itemprop', 'price'),
  );
  const currency =
    metaContent(html, 'property', 'product:price:currency') ||
    metaContent(html, 'property', 'og:price:currency') || null;
  const availability = metaContent(html, 'property', 'product:availability');
  const brand = metaContent(html, 'property', 'product:brand') || metaContent(html, 'property', 'og:brand');
  return {
    name: title || null,
    description: desc || null,
    price,
    currency,
    availability: availability ? String(availability).split('/').pop() : null,
    brand: brand || null,
    images: image ? images : [],
    ogUrl: metaContent(html, 'property', 'og:url') || null,
    strategy: 'generic-meta',
    confidence: title ? 0.5 : 0.2,
  };
}

/**
 * Value of an `itemprop="image"` element. Unlike text/`content` props, an image
 * URL usually lives in `src` (<img>), `content` (<meta>) or `href` (<link>/<a>),
 * so `prop()` cannot read it. Takes the FIRST such element (the main product
 * image in document order; related-product thumbnails come after).
 */
function microImage(html) {
  const tag = html.match(/<(?:img|meta|link|a)\b[^>]*itemprop=["']image["'][^>]*>/i)?.[0];
  if (!tag) return null;
  const v = tag.match(/\b(?:content|src|href)=["']([^"']+)["']/i)?.[1];
  return v ? v.trim() : null;
}

/**
 * Ordered breadcrumb trail from a microdata BreadcrumbList (schema.org ListItem
 * items). Common on SSR platforms with no JSON-LD (PrestaShop, Magento). Ordered
 * by itemprop="position" when present, else document order. Feeds `category`.
 */
export function extractBreadcrumbFromDom(html) {
  if (!html || typeof html !== 'string') return [];
  const items = [];
  // microdata (itemprop=…) or RDFa (property=…, adidas: <li property="itemListElement"><span property="name">)
  const liRe = /<li[^>]*(?:itemprop|property)=["']itemListElement["'][\s\S]*?<\/li>/gi;
  let m;
  while ((m = liRe.exec(html))) {
    const li = m[0];
    const raw = li.match(/(?:itemprop|property)=["']name["'][^>]*>\s*([^<]{1,120})/i)?.[1]
      || li.match(/(?:itemprop|property)=["']item["'][^>]*\btitle=["']([^"']{1,120})["']/i)?.[1]
      || li.match(/<a[^>]*\btitle=["']([^"']{1,120})["']/i)?.[1] || '';
    const name = cleanText(raw);
    const pos = parseInt(li.match(/(?:itemprop|property)=["']position["'][^>]*content=["'](\d+)["']/i)?.[1] || '0', 10);
    if (name) items.push({ name, pos });
  }
  if (!items.length) return [];
  if (items.every((x) => x.pos)) items.sort((a, b) => a.pos - b.pos);
  return items.map((x) => x.name);
}

/** schema.org microdata via itemprop attributes (best-effort). */
export function extractFromMicrodata(html) {
  // Breadcrumb ListItems carry their OWN itemprop="name"/"item" — the first
  // itemprop="name" on many SSR pages is the top breadcrumb category, not the
  // product. Exclude those blocks so product fields come from the product scope
  // (the breadcrumb trail is parsed separately by extractBreadcrumbFromDom).
  const scoped = (html || '').replace(/<li[^>]*itemprop=["']itemListElement["'][\s\S]*?<\/li>/gi, ' ');
  const prop = (name) => {
    const re = new RegExp(`itemprop=["']${name}["'][^>]*?(?:content=["']([^"']+)["']|>\\s*([^<]{1,200}))`, 'i');
    const m = scoped.match(re);
    return (m && (m[1] || m[2]) || '').trim() || null;
  };
  const name = prop('name');
  const price = num(prop('price'));
  const gtin = prop('gtin13') || prop('gtin') || prop('gtin8') || prop('ean');
  const sku = prop('sku');
  const brand = prop('brand');
  if (!name && price == null && !gtin && !sku) return null;
  const img = microImage(scoped) || prop('image');
  return {
    name, price, gtin, sku, brand,
    mpn: prop('mpn'),
    category: prop('category'),
    weightText: prop('weight'),
    description: prop('description'),
    currency: prop('priceCurrency'),
    availability: prop('availability') ? String(prop('availability')).split('/').pop() : null,
    images: img ? [img] : [], strategy: 'generic-microdata', confidence: 0.4,
  };
}

export function titleOf(html) {
  const raw = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  return raw ? stripSiteSuffix(raw) : (raw || null);
}

/**
 * Strip a trailing site-name suffix from a page <title> — "Product | Shop",
 * "Product – Brand", "Product :: Store" → "Product". Only STRONG separators
 * (| – — :: · ›), never a plain hyphen (real names contain " - ", e.g. "Colnago
 * V4 - état neuf"), and only the LAST segment (the site name sits at the end), and
 * only when the remaining part stays substantial. Generic; used for the last-resort
 * <title> name so a shop that omits h1/og/JSON-LD doesn't leak its name into data.
 * @param {string} s
 * @returns {string}
 */
export function stripSiteSuffix(s) {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  const m = str.match(/^(.*\S)\s*[|–—·›]\s*[^|–—·›]+$/) || str.match(/^(.*\S)\s*::\s*[^:]+$/);
  if (m && m[1].trim().length >= 3) return m[1].trim();
  return str;
}

export function canonicalOf(html) {
  const tag = html.match(/<link[^>]*rel=["']canonical["'][^>]*>/i)?.[0];
  return tag ? (tag.match(/href=["']([^"']+)["']/i)?.[1] || null) : null;
}

/** Detect embedded JSON state blobs that often carry product data on SPA/SSR sites. */
export function extractEmbeddedJson(html) {
  const blobs = [];
  const patterns = [
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
    /window\.__NUXT__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
    /window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
    /<script[^>]*id=["']__APOLLO_STATE__["'][^>]*>([\s\S]*?)<\/script>/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      try { blobs.push(JSON.parse(m[1].trim())); } catch { /* ignore malformed */ }
    }
  }
  return blobs;
}

// ── Embedded-JSON product extraction ────────────────────────────────────────
// Many modern storefronts (Next.js/Nuxt/Apollo/SSR-hydrated) ship the full
// product as JSON inside the HTML (__NEXT_DATA__, __NUXT__, preloaded/Apollo
// state) even when there is NO JSON-LD/microdata/meta. This maps that JSON into
// product fields over plain HTTP — avoiding a browser render. Conservative:
// a node must have a NAME and (a PRICE or a GTIN/SKU) plus one more product-ish
// field, so cart/shipping/config objects are not mistaken for products.
const EJ_NAME_KEYS = ['name', 'title', 'productName', 'displayName'];
const EJ_PRICE_KEYS = ['price', 'salePrice', 'currentPrice', 'finalPrice', 'sellingPrice', 'lowPrice', 'amount', 'value'];

function ejNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const c = v.replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
  const n = parseFloat(c);
  return Number.isFinite(n) ? n : null;
}
const ejStr = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const ejArr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const ejName = (o) => { for (const k of EJ_NAME_KEYS) { const s = ejStr(o[k]); if (s) return s; } return null; };

function ejPrice(o) {
  for (const k of EJ_PRICE_KEYS) {
    if (o[k] == null) continue;
    if (typeof o[k] === 'object') { const n = ejNum(o[k].amount ?? o[k].value ?? o[k].current ?? o[k].min); if (n != null) return n; }
    else { const n = ejNum(o[k]); if (n != null) return n; }
  }
  for (const off of ejArr(o.offers)) if (off && typeof off === 'object') { const n = ejNum(off.price ?? off.lowPrice); if (n != null) return n; }
  return null;
}
function ejGtin(o) {
  for (const k of ['gtin13', 'gtin14', 'gtin12', 'gtin8', 'gtin', 'ean', 'barcode', 'upc']) {
    if (o[k] == null) continue;
    const s = String(o[k]).trim();
    if (s && /^\d{6,14}$/.test(s.replace(/\s/g, ''))) return s;
  }
  return null;
}
const ejSku = (o) => ejStr(o.sku) || ejStr(o.SKU) || ejStr(o.productCode) || ejStr(o.mpn);
function ejBrand(o) {
  const b = o.brand ?? o.manufacturer ?? o.vendor;
  if (typeof b === 'string') return b.trim() || null;
  if (b && typeof b === 'object') return ejStr(b.name);
  return null;
}
function ejCurrency(o) {
  const c = o.currency ?? o.priceCurrency ?? o.currencyCode;
  if (typeof c === 'string' && c.trim()) return c.trim();
  for (const off of ejArr(o.offers)) if (off && typeof off === 'object' && typeof off.priceCurrency === 'string') return off.priceCurrency;
  if (o.price && typeof o.price === 'object' && typeof o.price.currency === 'string') return o.price.currency;
  return null;
}
function ejImages(o) {
  const out = [];
  for (const key of ['image', 'images', 'imageUrl', 'imageURL', 'thumbnail', 'mainImage', 'picture']) {
    for (const i of ejArr(o[key])) {
      if (typeof i === 'string' && i) out.push(i);
      else if (i && typeof i === 'object') { const u = i.url || i.src || i.contentUrl || i.image; if (typeof u === 'string') out.push(u); }
    }
  }
  return [...new Set(out)];
}
function ejAvailability(o) {
  const a = o.availability ?? o.stockStatus ?? o.inStock ?? o.available;
  if (typeof a === 'string') return a.split('/').pop();
  if (typeof a === 'boolean') return a ? 'InStock' : 'OutOfStock';
  return null;
}
const ejDescription = (o) => ejStr(o.description) || ejStr(o.shortDescription) || ejStr(o.longDescription) || ejStr(o.summary);
function ejWeight(o) {
  const w = o.weight ?? o.netWeight ?? o.grossWeight ?? o.contenance ?? o.volume ?? o.size;
  if (typeof w === 'number' && Number.isFinite(w)) return String(w);
  if (typeof w === 'string' && /\d/.test(w)) return w.trim();
  if (w && typeof w === 'object') { const v = w.value ?? w.amount; const u = w.unitText ?? w.unit ?? w.unitCode; if (v != null) return `${v}${u ? ` ${u}` : ''}`.trim(); }
  return null;
}
function ejCategory(o) {
  const c = o.category ?? o.categoryName ?? o.productType;
  if (typeof c === 'string' && c.trim()) return c.trim();
  if (Array.isArray(o.categories) && o.categories.length) { const last = o.categories[o.categories.length - 1]; return ejStr(typeof last === 'string' ? last : (last?.name ?? last?.title)); }
  if (c && typeof c === 'object') return ejStr(c.name ?? c.title);
  return null;
}
const ejMpn = (o) => ejStr(o.mpn) || ejStr(o.manufacturerPartNumber) || ejStr(o.partNumber);
const ejTyped = (o) => /product/i.test(String(o['@type'] || o.type || o.__typename || ''));
const ejUrl = (o) => { for (const k of ['url', 'canonicalUrl', 'productUrl', 'link', 'href', 'slug', 'path']) { const s = ejStr(o[k]); if (s) return s; } return null; };
function ejListPrice(o) {
  for (const k of ['compareAtPrice', 'regularPrice', 'listPrice', 'oldPrice', 'wasPrice', 'priceBeforeDiscount', 'strikePrice', 'rrp']) {
    if (o[k] == null) continue;
    const n = typeof o[k] === 'object' ? ejNum(o[k].amount ?? o[k].value) : ejNum(o[k]);
    if (n != null) return n;
  }
  for (const off of ejArr(o.offers)) if (off && typeof off === 'object') { const n = ejNum(off.compareAtPrice ?? off.highPrice); if (n != null) return n; }
  return null;
}

/** Map one embedded-JSON product node → RawProduct-ish (shared single + list). */
function ejToProduct(node) {
  return {
    name: ejName(node), description: ejDescription(node),
    price: ejPrice(node), listPrice: ejListPrice(node), currency: ejCurrency(node),
    availability: ejAvailability(node), gtin: ejGtin(node), sku: ejSku(node),
    mpn: ejMpn(node), brand: ejBrand(node), images: ejImages(node),
    category: ejCategory(node), weightText: ejWeight(node), canonicalUrl: ejUrl(node),
    strategy: 'generic-embedded-json', confidence: 0.6,
  };
}

function ejIsProduct(o) {
  if (!ejName(o)) return false;
  const hasPrice = ejPrice(o) != null;
  const hasId = !!(ejGtin(o) || ejSku(o));
  if (!hasPrice && !hasId) return false;
  const extras = ejImages(o).length + (ejBrand(o) ? 1 : 0) + (ejDescription(o) ? 1 : 0) + (ejCurrency(o) ? 1 : 0);
  return ejTyped(o) || hasId ? true : extras >= 1; // price alone needs one more product-ish field
}
function ejScore(o) {
  let s = 0;
  if (ejPrice(o) != null) s += 2;
  if (ejGtin(o)) s += 2;
  if (ejSku(o)) s += 1;
  if (ejImages(o).length) s += 1;
  if (ejBrand(o)) s += 1;
  if (ejDescription(o)) s += 1;
  if (ejCurrency(o)) s += 1;
  if (ejTyped(o)) s += 3;
  return s;
}

/**
 * Find the best product-shaped object inside embedded JSON state blobs and map
 * it to a RawProduct-ish object. Returns null when no plausible product is found.
 * Pure; bounded traversal.
 * @returns {import('./types.mjs').RawProduct|null}
 */
export function extractProductFromEmbeddedJson(html) {
  let blobs;
  try { blobs = extractEmbeddedJson(html); } catch { return null; }
  if (!blobs || !blobs.length) return null;
  let best = null, bestScore = -1, seen = 0;
  const MAX_NODES = 20000;
  const stack = [...blobs];
  while (stack.length && seen < MAX_NODES) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    seen++;
    if (Array.isArray(n)) { for (const x of n) if (x && typeof x === 'object') stack.push(x); continue; }
    try { if (ejIsProduct(n)) { const sc = ejScore(n); if (sc > bestScore) { bestScore = sc; best = n; } } } catch { /* skip node */ }
    for (const k in n) { const v = n[k]; if (v && typeof v === 'object') stack.push(v); }
  }
  if (!best) return null;
  return ejToProduct(best);
}

/**
 * Extract EVERY product-shaped node from embedded JSON state (a listing page:
 * Next/Nuxt/Apollo product arrays, search results…). Deduped, bounded. For
 * listing extraction. Returns [] when none is found.
 * @returns {import('./types.mjs').RawProduct[]}
 */
export function extractProductsFromEmbeddedJson(html) {
  let blobs;
  try { blobs = extractEmbeddedJson(html); } catch { return null; }
  if (!blobs || !blobs.length) return [];
  const out = [];
  const seen = new Set();
  let visited = 0;
  const MAX_NODES = 40000;
  const stack = [...blobs];
  while (stack.length && visited < MAX_NODES && out.length < 2000) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    visited++;
    if (Array.isArray(n)) { for (const x of n) if (x && typeof x === 'object') stack.push(x); continue; }
    try {
      if (ejIsProduct(n)) {
        const p = ejToProduct(n);
        const k = p.canonicalUrl || p.gtin || p.sku || p.name;
        if (k && !seen.has(k)) { seen.add(k); out.push(p); }
      }
    } catch { /* skip node */ }
    for (const k in n) { const v = n[k]; if (v && typeof v === 'object') stack.push(v); }
  }
  return out;
}

/**
 * Heuristic: does the initial HTML look like it needs a browser to render
 * product data? (SPA shell with an empty root and no product data in the HTML.)
 * Structured data only rules the browser out when it actually YIELDS a product:
 * a CSR shell shipping an empty __NUXT__ blob, or a non-product JSON-LD
 * (Organization/WebSite), still needs a render.
 */
export function needsBrowser(html) {
  const hasProductMeta = /property=["']product:price:amount["']/i.test(html) || /property=["']og:type["'][^>]*content=["']product["']/i.test(html);
  if (hasProductMeta) return false;
  if (/application\/ld\+json/i.test(html)) {
    try { if (extractProductsFromJsonLd(html).length) return false; } catch { /* no product in JSON-LD */ }
  }
  if (/__NEXT_DATA__|__NUXT__|__PRELOADED_STATE__|__INITIAL_STATE__/.test(html)) {
    try { const found = extractProductsFromEmbeddedJson(html); if (found && found.length) return false; } catch { /* no product in state */ }
    // A CSR hydration marker whose state carries NO product (often a bare
    // `window.__NUXT__={}`): the grid renders client-side even when the page
    // ships a full SSR header/footer — so the visible-markup size test below
    // never sees the shell. No product meta / JSON-LD / state product reached
    // this point, so the render is the only lane left that could yield one.
    return true;
  }
  const emptyRoot = /<div[^>]*id=["'](root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(html);
  // Measure the body WITHOUT script blobs: a CSR shell carrying a huge state
  // blob is still a shell — the visible markup is what a no-JS fetch can read.
  const body = html.match(/<body[\s\S]*<\/body>/i)?.[0] || html;
  const tinyBody = body.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ').length < 1500;
  return emptyRoot || tinyBody;
}
