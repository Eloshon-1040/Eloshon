/**
 * What the page DECLARES about its product, per field — schema.org JSON-LD (Product, ProductGroup and its
 * variants, a product inside an action), microdata (the Product item around the page's <h1>, its offers)
 * and the product meta tags. These are the steadiest strategies a rule can hold: they survive a redesign
 * of the markup, need no browser, and mean the same thing on every product page of a site.
 *
 *   structuredOf(html, url)   → { name:{value,kind}, price:{value:{price,currency},kind}, variants:…, … }
 *   matchesStructured(field, designated, structured) → the source that holds what the user designated
 *
 * Portable (no DOM, no Node): the app and the extension read the same values.
 */
import { extractProductFromJsonLd, parseJsonLdBlocks, collectNodes, isProductNode, firstGtin } from '../extract/jsonld.mjs';
import { microdataItems } from '../extract/microdata.mjs';
import { isValidGtin } from '../extract/product-group.mjs';
import { imageUrls, imageKey } from '../extract/images.mjs';

const str = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
// A declared text may carry escaped markup ("&lt;p&gt;…"): decoded, tags dropped, paragraphs kept as lines.
const plainText = (v) => {
  let s = String(v == null ? '' : v);
  for (let i = 0; i < 2 && /&(lt|gt|amp|quot|#0*39|apos|nbsp);/i.test(s); i++) s = s.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'").replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&');
  return s.replace(/<\s*(br|\/p|\/li|\/div|\/h\d)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
};
const num = (v) => { if (v == null || v === '') return null; if (typeof v === 'number') return Number.isFinite(v) ? v : null; const n = parseFloat(String(v).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const asArray = (v) => (v == null ? [] : (Array.isArray(v) ? v : [v]));
const bare = (u) => { try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/$/, '').toLowerCase(); } catch { return String(u || '').toLowerCase(); } };
const typeIs = (n, t) => asArray(n && n['@type']).some((x) => String(x).toLowerCase() === t);

function metaContent(html, key) {
  const re = new RegExp(`<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${key.replace(/[.:]/g, (c) => `\\${c}`)}["'][^>]*>`, 'i');
  const tag = (String(html).match(re) || [])[0]; if (!tag) return null;
  const m = tag.match(/\scontent\s*=\s*("([^"]*)"|'([^']*)')/i);
  return m ? str((m[2] ?? m[3] ?? '').replace(/&amp;/g, '&').replace(/&#0*39;|&apos;/g, "'").replace(/&quot;/g, '"')) : null;
}

const offerPrice = (offers) => {
  for (const o of asArray(offers)) {
    if (!o || typeof o !== 'object') continue;
    const p = num(o.price ?? o.lowPrice ?? (o.priceSpecification && asArray(o.priceSpecification)[0] && asArray(o.priceSpecification)[0].price));
    if (p != null) return { price: p, currency: o.priceCurrency || (asArray(o.priceSpecification)[0] || {}).priceCurrency || null, availability: o.availability ? String(o.availability).split('/').pop() : null };
  }
  return null;
};

/**
 * A ProductGroup's variants (hasVariant), each named by what it varies by (colour, size…).
 * A group can also list entries that miss an axis the others have: adidas declares, besides the 22 sizes of the page's
 * colourway (« Earth Strata / Off White / Gum » + size), one entry per OTHER colourway — a link to its own product
 * page, with no size. Those are other products, not variants of this one: when complete entries exist they are left
 * out. An axis with one value across the variants (that colourway) names nothing, so the names are the sizes alone
 * (before: « Earth Strata / Off White / Gum, …, Earth Strata / Off White / Gum / 36, … »).
 */
function groupVariants(group) {
  const varies = asArray(group.variesBy).map((v) => String(v).split('/').pop().toLowerCase());
  const entries = asArray(group.hasVariant).filter((v) => v && typeof v === 'object')
    .map((v) => ({ v, vals: Object.fromEntries(varies.map((k) => [k, str(v[k] || (k === 'size' && v.size && v.size.name))])) }));
  const complete = entries.filter((e) => varies.length && varies.every((k) => e.vals[k]));
  const kept = complete.length && complete.length < entries.length ? complete : entries;
  const naming = varies.filter((k) => new Set(kept.map((e) => e.vals[k])).size > 1);
  const out = [];
  for (const { v, vals } of kept) {
    const parts = (naming.length ? naming : varies).map((k) => vals[k]).filter(Boolean);
    const name = parts.join(' / ') || str(v.size && (v.size.name || v.size)) || str(v.color) || str(v.name);
    if (!name) continue;
    const o = offerPrice(v.offers);
    out.push({ name, ...(v.sku ? { code: str(v.sku) } : {}), ...(o ? { price: o.price, ...(o.currency ? { currency: o.currency } : {}), ...(o.availability ? { availability: o.availability } : {}) } : {}), ...(typeof v.url === 'string' ? { url: v.url } : {}), ...(firstGtin(v.gtin13 || v.gtin || v.gtin14 || v.gtin12) ? { gtin: firstGtin(v.gtin13 || v.gtin || v.gtin14 || v.gtin12) } : {}) });
  }
  return out;
}

/** The microdata Product item of the page (the one around its <h1>, else the first top-level one). */
function microdataProduct(html) {
  let parsed; try { parsed = microdataItems(html); } catch { return null; }
  const { items, h1At } = parsed;
  const isP = (it) => /^(product|productgroup|productmodel|individualproduct)$/i.test(it.type);
  const top = items.filter((it) => isP(it) && !(it.parent >= 0 && isP(items[it.parent])));
  const main = (h1At >= 0 && top.find((it) => it.start < h1At && h1At < it.end)) || top[0];
  if (!main) return null;
  const child = (ref) => { const m = /^#item(\d+)$/.exec(ref || ''); return m ? items[Number(m[1])] : null; };
  const first = (it, k) => { const v = it && it.props[k]; return v && v.length ? v[0] : null; };
  const textOf = (it, k) => { const v = first(it, k); const c = child(v); return c ? (first(c, 'name') || null) : v; };
  const offers = (main.props.offers || []).map(child).filter(Boolean);
  const offerRows = offers.map((o) => ({ name: str(first(o, 'name') || first(o, 'sku') || ''), price: num(first(o, 'price') || first(o, 'lowPrice')), currency: first(o, 'priceCurrency') || null, availability: first(o, 'availability') ? String(first(o, 'availability')).split('/').pop() : null, sku: first(o, 'sku') })).filter((o) => o.price != null);
  return {
    name: str(first(main, 'name')), brand: str(textOf(main, 'brand')), description: str(first(main, 'description')),
    sku: str(first(main, 'sku') || first(main, 'productID') || first(main, 'productid')), gtin: firstGtin(first(main, 'gtin13') || first(main, 'gtin') || first(main, 'gtin14')),
    image: asArray(main.props.image || []).filter((u) => /^https?:|^\//.test(u)), offers: offerRows,
  };
}

/**
 * Every field the page declares, with where it comes from (jsonld | microdata | meta). Never throws.
 * @param {string} html  @param {string} [url] the page's address (picks the current variant of a group)
 */
export function structuredOf(html, url = '') {
  const out = {};
  const put = (field, value, kind) => { if (out[field] || value == null || value === '' || (Array.isArray(value) && !value.length)) return; out[field] = { value, kind }; };
  const h = String(html || '');
  // 1. JSON-LD.
  let ld = null; try { ld = extractProductFromJsonLd(h); } catch { ld = null; }
  let group = null;
  try { group = collectNodes(parseJsonLdBlocks(h)).find((n) => isProductNode(n) && typeIs(n, 'productgroup') && n.hasVariant) || null; } catch { group = null; }
  const variants = group ? groupVariants(group) : [];
  if (ld) {
    put('name', str(ld.name), 'jsonld'); put('brand', str(ld.brand), 'jsonld'); put('description', plainText(ld.description), 'jsonld');
    put('sku', str(ld.sku), 'jsonld'); if (ld.gtin && isValidGtin(ld.gtin)) put('ean', ld.gtin, 'jsonld');
    put('image', ld.images, 'jsonld'); put('availability', ld.availability, 'jsonld');
    // The trail without its « home » step, and without the product itself when the trail ends with it.
    const trail = Array.isArray(ld.breadcrumb) ? ld.breadcrumb.map(str).filter((x) => x && !/^(accueil|home|startseite|inicio)$/i.test(x)) : [];
    if (trail.length > 1 && norm(trail[trail.length - 1]) === norm(ld.name)) trail.pop();
    if (trail.length) put('category', trail.join(' > '), 'jsonld');
    else put('category', str(ld.category), 'jsonld');
    if (Array.isArray(ld.specs) && ld.specs.length >= 2) put('technical_specs', ld.specs, 'jsonld');
    if (ld.price != null) put('price', { price: ld.price, currency: ld.currency || null }, 'jsonld');
    if (ld.listPrice != null && ld.listPrice !== ld.price) put('list_price', { price: ld.listPrice, currency: ld.currency || null }, 'jsonld');
  }
  if (variants.length) {
    put('variants', variants, 'jsonld');
    // The group has no price of its own: the variant of THIS page, else the lowest one.
    const here = url ? variants.find((v) => v.url && bare(v.url) === bare(url)) : null;
    const priced = variants.filter((v) => v.price != null);
    const pick = (here && here.price != null) ? here : (priced.length ? priced.reduce((a, b) => (b.price < a.price ? b : a)) : null);
    if (pick) put('price', { price: pick.price, currency: pick.currency || null }, 'jsonld');
  }
  // 2. Microdata (the Product item around the page's title).
  const md = microdataProduct(h);
  if (md) {
    put('name', md.name, 'microdata'); put('brand', md.brand, 'microdata'); put('description', plainText(md.description), 'microdata');
    put('sku', md.sku, 'microdata'); if (md.gtin && isValidGtin(md.gtin)) put('ean', md.gtin, 'microdata'); put('image', md.image, 'microdata');
    if (md.offers.length) {
      const o = md.offers[0]; put('price', { price: o.price, currency: o.currency }, 'microdata');
      if (o.availability) put('availability', o.availability, 'microdata');
      // Several offers of one product = its options (sizes, volumes), each with its own price.
      // An offer named « <product name> - 30 ml » is the option « 30 ml ».
      const own = (n) => { const s = str(n); return md.name && s.toLowerCase().startsWith(md.name.toLowerCase()) ? s.slice(md.name.length).replace(/^[\s\-–—:|,/]+/, '') || s : s; };
      if (md.offers.length >= 2) put('variants', md.offers.map((x, i) => ({ name: own(x.name) || x.sku || `Option ${i + 1}`, price: x.price, ...(x.currency ? { currency: x.currency } : {}), ...(x.availability ? { availability: x.availability } : {}), ...(x.sku ? { code: x.sku } : {}) })), 'microdata');
    }
  }
  // 3. Product meta tags.
  const mp = num(metaContent(h, 'product:price:amount') || metaContent(h, 'og:price:amount'));
  if (mp != null) put('price', { price: mp, currency: metaContent(h, 'product:price:currency') || metaContent(h, 'og:price:currency') }, 'meta');
  put('brand', metaContent(h, 'product:brand'), 'meta');
  const ogd = metaContent(h, 'og:description'); if (ogd && ogd.length >= 120) put('description', ogd, 'meta');
  const ogi = metaContent(h, 'og:image'); if (ogi) put('image', [ogi], 'meta');
  // A price without a currency takes the currency the page declares elsewhere.
  if (out.price && !out.price.value.currency) {
    const cur = (ld && ld.currency) || (md && md.offers[0] && md.offers[0].currency) || metaContent(h, 'product:price:currency');
    if (cur) out.price = { ...out.price, value: { ...out.price.value, currency: cur } };
  }
  return out;
}

/**
 * Does the page declare the very value the user designated? Then that declaration is the rule's best
 * strategy (it will read the same field on every product page, whatever the markup becomes).
 * @returns {string|null} the source kind (jsonld | microdata | meta), or null
 */
export function matchesStructured(field, designated, structured) {
  const s = structured && structured[field]; if (!s || designated == null) return null;
  const v = s.value;
  if (field === 'price' || field === 'list_price') return designated && v && Math.abs(Number(designated.price) - Number(v.price)) < 0.005 ? s.kind : null;
  if (field === 'variants') {
    if (!Array.isArray(designated) || !Array.isArray(v) || !designated.length) return null;
    const a = new Set(designated.map((x) => norm(x.name))); const hit = v.filter((x) => a.has(norm(x.name))).length;
    return hit >= Math.min(2, designated.length) || (Math.abs(v.length - designated.length) <= 1 && hit >= 1) ? s.kind : null;
  }
  if (field === 'image' || field === 'images' || field === 'gallery') {
    // The designated pictures (ProductImage[] or addresses) against the declared addresses: the same picture, whatever its size.
    const keys = new Set(imageUrls(Array.isArray(designated) ? designated : []).map(imageKey));
    return keys.size && Array.isArray(v) && imageUrls(v).some((x) => keys.has(imageKey(x))) ? s.kind : null;
  }
  if (Array.isArray(v) || typeof v === 'object') return null;
  const a = norm(Array.isArray(designated) ? designated.join(' ') : designated); const b = norm(v);
  if (!a || !b) return null;
  if (a === b) return s.kind;
  if (field === 'description') return a.slice(0, 60) === b.slice(0, 60) || (a.length > 80 && b.includes(a.slice(0, 80))) || (b.length > 80 && a.includes(b.slice(0, 80))) ? s.kind : null;
  if (field === 'category') return a.endsWith(b) || b.endsWith(a) ? s.kind : null;
  return null;
}
