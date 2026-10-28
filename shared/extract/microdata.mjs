/**
 * schema.org MICRODATA read by scope (itemscope / itemtype / itemprop) — PORTABLE.
 *
 * A regex "first itemprop=name on the page" read cannot tell the page's own product
 * from the related products shown below it, nor read a listing whose tiles are each
 * a microdata Product. This walks the tags once, keeps the nesting of the itemscope
 * elements, and gives every itemprop to the item it belongs to:
 *   • `microdataItems(html)`      every item: type, its props, its position;
 *   • `mainMicrodataProduct(html)` is the page's <h1> inside a Product item?
 *     (a product page with a "related products" block of microdata tiles);
 *   • `microdataProducts(html, baseUrl)` the top-level Product items as listing
 *     cards (name, url, image, price, currency, availability, sku, gtin, brand).
 *
 * Generic (schema.org vocabulary only, no site rule), zero dependencies, zero Node
 * built-ins: it runs in Node and in the extension service worker.
 */
import { bestFromSrcset, looksLikeSrcset } from './images.mjs';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'template', 'noscript', 'textarea', 'svg']);
const PRODUCT_TYPES = /^(product|productgroup|productmodel|individualproduct|someproducts|vehicle|book|foodproduct)$/i;

const decode = (s) => String(s || '')
  .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;|&#x27;/gi, "'")
  .replace(/&#(\d+);/g, (m, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : m; })
  .replace(/\s+/g, ' ').trim();
const stripTags = (s) => decode(String(s || '').replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '));

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
}
const hasAttr = (tag, name) => new RegExp(`\\s${name}(\\s|=|>|/)`, 'i').test(tag);
const typeName = (t) => String(t || '').trim().split(/\s+/)[0].replace(/^.*[/#]/, '');

// The value an itemprop element carries without reading its text.
function attrValue(tagName, tag) {
  const content = attr(tag, 'content');
  if (content != null) return decode(content);
  if (/^(a|area|link)$/.test(tagName)) return attr(tag, 'href');
  if (/^(img|source|audio|video|iframe|embed|track)$/.test(tagName)) return attr(tag, 'src') || attr(tag, 'data-src') || attr(tag, 'srcset');
  if (tagName === 'meta') return '';
  if (tagName === 'time') { const d = attr(tag, 'datetime'); if (d != null) return d; }
  if (/^(data|meter)$/.test(tagName)) { const v = attr(tag, 'value'); if (v != null) return v; }
  return null; // read from the text, when the element closes
}

/**
 * Every microdata item on the page.
 * @returns {{items:Array<{type:string, start:number, end:number, parent:number, prop:string|null, props:Object<string,string[]>}>, h1At:number}}
 */
export function microdataItems(html) {
  const s = String(html || '');
  const items = [];
  const stack = []; // { tag, item (index|-1), propNames, textFrom, owner }
  let h1At = -1;
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m;
  const ownerOf = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].item >= 0) return stack[i].item; return -1; };
  const addProp = (owner, names, value) => {
    if (owner < 0 || value == null) return;
    for (const n of names) { const p = items[owner].props; (p[n] = p[n] || []).push(value); }
  };
  const close = (entry, at) => {
    if (entry.pendingText) addProp(entry.owner, entry.propNames, stripTags(s.slice(entry.textFrom, at)));
    if (entry.item >= 0) items[entry.item].end = at;
  };
  while ((m = re.exec(s))) {
    if (m[0].startsWith('<!--')) continue;
    const closing = m[1] === '/';
    const tagName = m[2].toLowerCase();
    const tag = m[0];
    if (closing) {
      let i = stack.length - 1;
      while (i >= 0 && stack[i].tag !== tagName) i--;
      if (i < 0) continue; // stray closing tag
      while (stack.length > i) close(stack.pop(), m.index);
      continue;
    }
    if (tagName === 'h1' && h1At < 0) h1At = m.index;
    const selfClosing = /\/\s*>$/.test(tag) || VOID.has(tagName);
    const propAttr = /itemprop/i.test(tag) ? attr(tag, 'itemprop') : null;
    const propNames = propAttr ? propAttr.trim().split(/\s+/).filter(Boolean) : [];
    const owner = ownerOf();
    const isScope = hasAttr(tag, 'itemscope');
    let itemIdx = -1;
    if (isScope) {
      itemIdx = items.length;
      items.push({ type: typeName(attr(tag, 'itemtype')), start: m.index, end: s.length, parent: owner, prop: propNames[0] || null, props: {} });
      if (propNames.length) addProp(owner, propNames, `#item${itemIdx}`);
    }
    let pendingText = false;
    if (propNames.length && !isScope) {
      const v = attrValue(tagName, tag);
      if (v != null) addProp(owner, propNames, v); else pendingText = !selfClosing;
    }
    if (RAW_TEXT.has(tagName) && !selfClosing) {
      const endRe = new RegExp(`</${tagName}\\s*>`, 'ig');
      endRe.lastIndex = re.lastIndex;
      const e = endRe.exec(s);
      if (pendingText) addProp(owner, propNames, stripTags(s.slice(re.lastIndex, e ? e.index : s.length)));
      if (itemIdx >= 0) items[itemIdx].end = e ? e.index : s.length;
      re.lastIndex = e ? endRe.lastIndex : s.length;
      continue;
    }
    if (selfClosing) { if (itemIdx >= 0) items[itemIdx].end = re.lastIndex; continue; }
    stack.push({ tag: tagName, item: itemIdx, propNames, textFrom: re.lastIndex, owner, pendingText });
  }
  while (stack.length) close(stack.pop(), s.length);
  return { items, h1At };
}

const isProduct = (it) => PRODUCT_TYPES.test(it.type);

/** Is the page's first <h1> inside a microdata Product item (the page's own product)? */
export function mainMicrodataProduct(html, parsed) {
  const { items, h1At } = parsed || microdataItems(html);
  if (h1At < 0) return false;
  return items.some((it) => isProduct(it) && it.start < h1At && h1At < it.end);
}

function first(it, name) { const v = it.props[name]; return v && v.length ? v[0] : null; }
function childItem(items, ref) { const m = /^#item(\d+)$/.exec(ref || ''); return m ? items[Number(m[1])] : null; }
function absoluteUrl(href, base) { if (!href) return null; try { return new URL(href, base).toString(); } catch { return null; } }

/**
 * Top-level microdata Product items as listing cards. A Product nested inside
 * another Product (an accessory, a variant) is not a separate card.
 */
export function microdataProducts(html, baseUrl, parsed) {
  const { items } = parsed || microdataItems(html);
  const cards = [];
  for (const it of items) {
    if (!isProduct(it)) continue;
    let p = it.parent; let nested = false;
    while (p >= 0) { if (isProduct(items[p])) { nested = true; break; } p = items[p].parent; }
    if (nested) continue;
    const name = first(it, 'name');
    const url = absoluteUrl(first(it, 'url'), baseUrl);
    const card = { strategy: 'listing-microdata' };
    if (name && !name.startsWith('#item')) card.name = name;
    if (url) { card.sourceUrl = url; card.canonicalUrl = url; }
    const img = (it.props.image || []).find((v) => v && !v.startsWith('#item'));
    // An itemprop="image" may be an <img srcset>: its largest candidate (parsed as the HTML spec says), never a split on a comma.
    if (img) { const abs = absoluteUrl(looksLikeSrcset(img) ? bestFromSrcset(img) : img.trim(), baseUrl); if (abs) card.images = [abs]; }
    const desc = first(it, 'description'); if (desc && !desc.startsWith('#item')) card.description = desc;
    const sku = first(it, 'sku') || first(it, 'productID'); if (sku && !sku.startsWith('#item')) card.sku = sku;
    const gtin = first(it, 'gtin13') || first(it, 'gtin') || first(it, 'gtin14') || first(it, 'gtin12') || first(it, 'gtin8') || first(it, 'ean');
    if (gtin && /^\d{8,14}$/.test(gtin)) card.gtin = gtin;
    const brandRef = first(it, 'brand'); const brandItem = childItem(items, brandRef);
    const brand = brandItem ? first(brandItem, 'name') : brandRef; if (brand && !brand.startsWith('#item')) card.brand = brand;
    // Price: the item's own, else its offer(s) (lowest price).
    const offers = (it.props.offers || []).map((r) => childItem(items, r)).filter(Boolean);
    const priceOf = (x) => { const v = first(x, 'price') || first(x, 'lowPrice'); const n = v != null ? Number(String(v).replace(/\s/g, '').replace(',', '.')) : NaN; return Number.isFinite(n) && n > 0 ? n : null; };
    let price = priceOf(it); let src = it;
    for (const o of offers) { const n = priceOf(o); if (n != null && (price == null || n < price)) { price = n; src = o; } }
    if (price != null) { card.price = price; const cur = first(src, 'priceCurrency') || first(it, 'priceCurrency'); if (cur && /^[A-Za-z]{3}$/.test(cur)) card.currency = cur.toUpperCase(); }
    const avail = (offers.length ? first(offers[0], 'availability') : null) || first(it, 'availability');
    if (avail && !avail.startsWith('#item')) card.availability = avail.replace(/^.*[/#]/, '');
    if (card.name || card.sourceUrl) cards.push(card);
  }
  return cards;
}

/**
 * Listing cards read from microdata — none on a product page (its <h1> sits inside
 * a Product item: the other items are related products) or with fewer than 2.
 */
export function listingMicrodata(html, baseUrl) {
  if (!/itemscope/i.test(String(html || ''))) return [];
  const parsed = microdataItems(html);
  if (mainMicrodataProduct(html, parsed)) return [];
  const cards = microdataProducts(html, baseUrl, parsed);
  return cards.length >= 2 ? cards : [];
}
