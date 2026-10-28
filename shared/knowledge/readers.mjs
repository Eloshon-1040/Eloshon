/**
 * Reading the VALUE of a designated block: a description keeps its paragraphs and
 * bullet lines (no 2000-character one-liner), technical specifications are read as
 * label → value PAIRS from whatever shape the page uses (table rows, <dl>, list
 * items with two parts, rows of two cells made of <div>/<span>, "Label : value"
 * lines) — never as one flat text. Portable (browser + linkedom), no site rule.
 */
import { visibleText } from '../extract/card-recipe.mjs';
import { bestFromSrcset, normalizeImageUrl, validateImageUrl, imageSize, productImage, dedupeImages, imageUrls } from '../extract/images.mjs';
import { splitSharedLabel } from '../extract/sku.mjs';

export const MAX_DESCRIPTION = 12000;
const MAX_NAME = 80; const MAX_VALUE = 500; const MAX_PAIRS = 300;
const SKIP = /^(script|style|noscript|template|svg|iframe|select|option)$/i;
const BLOCK = /^(p|div|section|article|ul|ol|li|h[1-6]|table|tr|blockquote|dl|dt|dd|pre|header|footer|figure|figcaption|details|summary|aside|main|hr|form|fieldset)$/i;
const NOISE_LINE = /^(lire la suite|lire plus|voir plus|voir moins|afficher plus|afficher moins|read more|read less|show more|show less|meer lezen|minder lezen|mehr lesen|weniger)$/i;

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * The text of a block with its structure kept: one line per paragraph / list item /
 * heading, "• " before list items, table rows joined by " : ". Hidden accordion and
 * tab content counts (it is in the DOM); buttons, scripts and styles do not.
 * @param {Element} el
 * @param {{dropLabel?:string|null, max?:number}} [o]  dropLabel: the block's own title, removed when it opens the text
 */
export function readBlockText(el, { dropLabel = null, max = MAX_DESCRIPTION } = {}) {
  if (!el) return '';
  let out = '';
  const brk = () => { if (!out.endsWith('\n')) out += '\n'; };
  const walk = (n) => {
    if (out.length > max * 2) return;
    if (n.nodeType === 3) { out += String(n.textContent).replace(/\s+/g, ' '); return; }
    if (n.nodeType !== 1) return;
    const tag = String(n.tagName).toLowerCase();
    if (SKIP.test(tag) || tag === 'button' || tag === 'input') return;
    if (tag === 'br') { brk(); return; }
    if (tag === 'tr') { brk(); const cells = [...n.children].map((c) => oneLine(visibleText(c))).filter(Boolean); out += cells.join(cells.length === 2 ? ' : ' : ' | '); brk(); return; }
    if (tag === 'li') { brk(); out += '• '; for (const c of n.childNodes) walk(c); brk(); return; }
    const block = BLOCK.test(tag);
    if (block) brk();
    for (const c of n.childNodes) walk(c);
    if (block) brk();
  };
  walk(el);
  const want = dropLabel ? oneLine(dropLabel).toLowerCase() : null;
  const lines = out.split('\n').map(oneLine).filter(Boolean).filter((l) => !NOISE_LINE.test(l));
  if (want && lines.length > 1 && lines[0].toLowerCase().replace(/[:：]$/, '') === want) lines.shift();
  const text = lines.join('\n');
  return text.length > max ? text.slice(0, max).replace(/\s+\S*$/, '') : text;
}

/**
 * A block that is only a group of short choices (size buttons « 35 1/2 » « 36 » « 36 2/3 », options, chips) read as
 * a list « 35 1/2 | 36 | 36 2/3 » — its plain text glues them (« 35 1/23636 2/3 », adidas 28/10). Null when the block
 * holds anything else.
 */
export function groupedText(el) {
  if (!el || !el.querySelectorAll) return null;
  let leaves = [];
  try { leaves = [...el.querySelectorAll('button, li, option, label, a, [role="radio"], [role="option"], [role="button"]')].filter((n) => !n.querySelector('button, li, option, label, a, [role="radio"], [role="option"], [role="button"]')); } catch { return null; }
  const parts = leaves.map((n) => oneLine(visibleText(n))).filter(Boolean);
  if (parts.length < 3 || parts.some((p) => p.length > 24)) return null;
  const squash = (s) => String(s).replace(/\s+/g, '');
  return squash(parts.join('')) === squash(visibleText(el)) ? parts.join(' | ') : null;
}

const cleanName = (s) => oneLine(s).replace(/[:：]\s*$/, '').trim();
const okPair = (n, v) => n && v && n.length <= MAX_NAME && n.toLowerCase() !== v.toLowerCase();
const first = (el, sel) => { try { return el.querySelector(sel); } catch { return null; } };

/**
 * Label → value pairs of a block.
 * @param {Element} root
 * @returns {Array<{group:string|null, name:string, value:string}>}
 */
export function readSpecPairs(root) {
  const out = []; let group = null; const groups = [];
  const push = (name, value) => {
    const n = cleanName(name); const v = oneLine(value).slice(0, MAX_VALUE);
    if (!okPair(n, v) || out.length >= MAX_PAIRS) return false;
    out.push({ group, name: n, value: v }); return true;
  };
  const setGroup = (t) => { const g = oneLine(t); if (g && g.length <= 80) { group = g; groups.push(g); } };
  const kids = (el) => [...el.children].filter((c) => !SKIP.test(c.tagName));
  const txt = (el) => oneLine(visibleText(el));

  function table(t) {
    const cap = first(t, 'caption'); if (cap && txt(cap)) setGroup(txt(cap));
    for (const tr of t.querySelectorAll('tr')) {
      if (tr.closest('table') !== t) continue;
      const cells = kids(tr).filter((c) => /^(td|th)$/i.test(c.tagName));
      if (cells.length === 1) { if (txt(cells[0])) setGroup(txt(cells[0])); continue; }
      if (cells.length === 2) push(txt(cells[0]), txt(cells[1]));
      else if (cells.length > 2) push(txt(cells[0]), cells.slice(1).map(txt).filter(Boolean).join(' | '));
    }
  }
  function dl(d) {
    for (const dt of d.querySelectorAll('dt')) {
      let v = ''; let s = dt.nextElementSibling;
      while (s && /^dd$/i.test(s.tagName)) { v += `${v ? ' ; ' : ''}${txt(s)}`; s = s.nextElementSibling; }
      if (!v && dt.parentElement && !/^dl$/i.test(dt.parentElement.tagName)) { const dd = first(dt.parentElement, 'dd'); if (dd) v = txt(dd); }
      push(txt(dt), v);
    }
  }
  // One entry of a list as a pair: two element parts, a label element + the rest, or "Label : value".
  function liPair(li) {
    const parts = kids(li).filter((c) => txt(c));
    if (parts.length === 2) return [txt(parts[0]), txt(parts[1])];
    if (parts.length >= 2 && /^(strong|b|label|dt|th)$/i.test(parts[0].tagName)) return [txt(parts[0]), parts.slice(1).map(txt).join(' ')];
    const t = txt(li); const m = t.match(/^([^:：]{2,60}?)\s*[:：]\s*(.+)$/);
    if (m) return [m[1], m[2]];
    if (parts.length === 1 && /^(strong|b|label)$/i.test(parts[0].tagName)) { const lab = txt(parts[0]); const rest = t.slice(lab.length).replace(/^[\s:：-]+/, ''); if (rest) return [lab, rest]; }
    return null;
  }
  function listPairs(list) {
    const lis = kids(list).filter((c) => /^li$/i.test(c.tagName));
    if (lis.length < 2) return false;
    const pairs = lis.map(liPair);
    if (pairs.filter(Boolean).length < Math.max(2, Math.ceil(lis.length * 0.6))) return false;
    for (const p of pairs) if (p) push(p[0], p[1]);
    return true;
  }
  // A container whose children are rows of exactly two parts (label + value), whatever the tags.
  function rowPairs(c) {
    const rows = kids(c); if (rows.length < 2) return false;
    const two = rows.map((r) => { const p = kids(r).filter((x) => txt(x)); return p.length === 2 ? [txt(p[0]), txt(p[1])] : null; });
    if (two.filter(Boolean).length < Math.max(2, Math.ceil(rows.length * 0.7))) return false;
    for (const p of two) if (p) push(p[0], p[1]);
    return true;
  }

  const walk = (n) => {
    if (!n || n.nodeType !== 1 || SKIP.test(n.tagName)) return;
    const tag = String(n.tagName).toLowerCase();
    if (/^h[1-6]$/.test(tag) || tag === 'legend') { setGroup(txt(n)); return; }
    if (tag === 'table') { table(n); return; }
    if (tag === 'dl') { dl(n); return; }
    if ((tag === 'ul' || tag === 'ol') && listPairs(n)) return;
    if (rowPairs(n)) return;
    for (const c of n.children) walk(c);
  };
  walk(root);
  // Last resort: "Label : value" lines of the block's text.
  if (out.length < 2) {
    out.length = 0; group = null;
    for (const line of readBlockText(root).split('\n')) {
      const m = line.replace(/^•\s*/, '').match(/^([^:：]{2,60}?)\s*[:：]\s*(.{1,})$/);
      if (m) push(m[1], m[2]);
    }
    if (out.length < 2) out.length = 0;
  }
  // Group titles only matter when there are several: one title is the block's own heading.
  if (new Set(out.map((p) => p.group).filter(Boolean)).size < 2) for (const p of out) p.group = null;
  const seen = new Set();
  return out.filter((p) => { const k = `${p.group}|${p.name}|${p.value}`.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Pairs → { name: value } (a repeated name keeps its group: "Écran · Taille"). */
export function specsToObject(pairs) {
  const obj = {};
  for (const p of pairs || []) {
    let k = p.name;
    if (k in obj && p.group) k = `${p.group} · ${p.name}`;
    obj[k] = k in obj && obj[k] !== p.value ? `${obj[k]} ; ${p.value}` : p.value;
  }
  return obj;
}

/** "Marque : Apple" → "Apple" when the element carries its own short label. */
export function stripLabel(value, labelHint) {
  const v = oneLine(value);
  const m = v.match(/^([^:：]{2,30})\s*[:：]\s*(.+)$/);
  if (!m) return v;
  if (!labelHint) return m[2];
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
  const a = norm(m[1]); const b = norm(labelHint);
  return a && b && (a.includes(b) || b.includes(a)) ? m[2] : v;
}

// ── Variants (sizes, volumes, colours…) ─────────────────────────────────────────────
// A product's options as the page lists them: buttons / swatches / list entries / <option>s.
// Each entry: its label, and when the entry says it, its price, link, code and stock.
const OUT_OF_STOCK = /(out-of-stock|outofstock|unavailable|sold-?out|disabled|epuise|uitverkocht|ausverkauft|indisponible|not-available)/i;
const SELECTED = /(^|[-_ ])(active|selected|current|checked|is-selected|is-active)([-_ ]|$)/i;
const CODE_ATTRS = ['data-sku', 'data-code', 'data-variant-id', 'data-variant', 'data-product-code', 'data-ean', 'data-gtin', 'data-value', 'data-id', 'value'];
const signature = (el) => `${String(el.tagName).toLowerCase()}.${[...(el.classList || [])].filter((c) => !/\d{3,}|[0-9a-f]{6,}/i.test(c) && !SELECTED.test(c) && !OUT_OF_STOCK.test(c)).sort().join('.')}`;

// What an entry says: its text, else the label of the entry or of what it holds (a swatch: aria-label, title, image alt).
function entryLabel(c) {
  const t = oneLine(visibleText(c)); if (t) return t;
  for (const n of [c, ...(c.querySelectorAll ? c.querySelectorAll('[aria-label], [title], img[alt]') : [])]) {
    const v = n.getAttribute('aria-label') || n.getAttribute('title') || (/^img$/i.test(n.tagName) ? n.getAttribute('alt') : '');
    if (v && v.trim()) return oneLine(v);
  }
  return '';
}

/** The repeated entries of a block: its children of the most common kind (≥ 2), else those of the first descendant that has some. */
export function variantEntries(root) {
  if (!root || root.nodeType !== 1) return [];
  if (/^select$/i.test(root.tagName)) return [...root.querySelectorAll('option')];
  const sel = root.querySelector && root.querySelector('select');
  if (sel && sel.querySelectorAll('option').length >= 2) return [...sel.querySelectorAll('option')];
  const queue = [root]; let guard = 0;
  while (queue.length && guard++ < 200) {
    const n = queue.shift();
    const kids = [...n.children].filter((c) => !SKIP.test(c.tagName));
    const groups = new Map();
    for (const c of kids) { const s = signature(c); if (!groups.has(s)) groups.set(s, []); groups.get(s).push(c); }
    const best = [...groups.values()].sort((a, b) => b.length - a.length)[0];
    if (best && best.length >= 2 && best.every((c) => { const t = entryLabel(c); return t.length > 0 && t.length <= 140; })) return best;
    queue.push(...kids);
  }
  return [];
}

/**
 * The variants of a block, page order, each label once.
 * @param {Element} root  @param {{parsePrice?:(text:string)=>{price:number,currency?:string}|null}} [o]
 * @returns {Array<{name:string, price?:number, currency?:string, url?:string, code?:string, availability?:string, selected?:boolean}>}
 */
export function readVariants(root, { parsePrice = null } = {}) {
  const out = []; const seen = new Set();
  for (const it of variantEntries(root)) {
    const isOption = /^option$/i.test(it.tagName);
    const raw = entryLabel(it);
    if (!raw || (isOption && (!it.getAttribute('value') && /choisi|choose|select|kies|wähle/i.test(raw)))) continue;
    // The price part of the entry, read from a price-looking element, else from the text itself.
    let priceEl = null; try { priceEl = [...it.querySelectorAll('*')].find((n) => /price|prix|prijs|preis/i.test(n.getAttribute('class') || '') || n.getAttribute('itemprop') === 'price') || null; } catch { priceEl = null; }
    const priceText = priceEl ? oneLine(visibleText(priceEl)) : '';
    // In a line such as "30 ML - 77,70 €" the price is the amount written WITH its currency, not the volume.
    const withCurrency = priceText ? null : (raw.match(/(?:€|EUR|\$|£)\s*\d[\d.,\s]*\d|\d[\d.,\s]*\s*(?:€|EUR|\$|£)/i) || [])[0];
    const money = parsePrice ? (parsePrice(priceText || withCurrency || '') || null) : null;
    let name = raw;
    if (priceText) name = oneLine(name.replace(priceText, ''));
    else if (money && withCurrency) name = oneLine(name.replace(withCurrency, '').replace(/\s*[-–|·:]\s*$/, ''));
    name = name.replace(/[-–|·:]\s*$/, '').trim() || raw;
    if (seen.has(name.toLowerCase())) continue; seen.add(name.toLowerCase());
    const v = { name: name.slice(0, 80) };
    if (money && money.price > 0) { v.price = money.price; if (money.currency) v.currency = money.currency; }
    const a = /^a$/i.test(it.tagName) ? it : (it.querySelector && it.querySelector('a[href]'));
    if (a && a.getAttribute('href') && !/^(#|javascript:)/i.test(a.getAttribute('href'))) v.url = a.getAttribute('href');
    for (const at of CODE_ATTRS) { const c = it.getAttribute(at); if (c && c.length <= 40 && !/^(true|false|on|off)$/i.test(c) && (isOption || c !== raw)) { v.code = c; break; } }
    const cls = `${it.getAttribute('class') || ''} ${it.getAttribute('data-state') || ''}`;
    if (it.hasAttribute('disabled') || it.getAttribute('aria-disabled') === 'true' || OUT_OF_STOCK.test(cls)) v.availability = 'OutOfStock';
    if (it.hasAttribute('selected') || it.getAttribute('aria-checked') === 'true' || it.getAttribute('aria-selected') === 'true' || it.getAttribute('aria-pressed') === 'true' || SELECTED.test(it.getAttribute('class') || '')) v.selected = true;
    out.push(v);
    if (out.length >= 100) break;
  }
  // Swatches labelled « Couleur du produit : Aurora Coffee / Gum »: the shared « Couleur du produit » names the
  // option (its type), the rest is the value. A code equal to the label is no code (shared/extract/sku.mjs).
  const shared = splitSharedLabel(out.map((v) => v.name));
  if (shared.label) out.forEach((v, i) => { v.name = shared.names[i].slice(0, 80); v.group = shared.label; });
  return out;
}

// ── Images (one picture or a whole gallery) ───────────────────────────────────────────
// The contract is shared/extract/images.mjs (ProductImage): what is read here is what the panel preview
// shows, what the rule stores as its strategy (the attribute that gave full addresses) and what the row
// serialises as `images: string[]`.
export { bestFromSrcset };

const IMG_FILE = /\.(jpe?g|png|webp|gif|avif|bmp|svg)(?:[?#]|$)/i;
// Pictures that are never a product's: icons, logos, sprites, flags, badges, loaders, trackers, avatars, payment marks.
const NOISE_FILE = /(^|[/_.-])(icon|icons|logo|logos|sprite|sprites|flag|flags|badge|badges|loader|loading|spinner|placeholder|blank|1x1|pixel|avatar|payment|trust|rating|stars?)([/_.-]|$)/i;
const ZOOM_ATTRS = ['data-zoom-image', 'data-zoom', 'data-large', 'data-large_image', 'data-full', 'data-hires', 'data-high-res'];
const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-image', 'data-img'];

const bareOf = (u) => { try { const x = new URL(u); return `${x.origin}${x.pathname}`.replace(/\/$/, '').toLowerCase(); } catch { return null; } };
/** The link an element sits in (itself or an ancestor <a href>), or null. */
function linkOf(n) {
  let a = n;
  for (let i = 0; a && i < 12; i++, a = a.parentElement) if (a.tagName && /^a$/i.test(a.tagName) && a.getAttribute('href')) return a.getAttribute('href');
  return null;
}
/**
 * Does this link lead to ANOTHER page of the site (a related product, a colour swatch's product page)?
 * A picture inside such a link belongs to that other page, never to this product's gallery. A link to the
 * picture itself (the large file), an anchor or a script link is not a page.
 */
export function leavesPage(href, pageUrl) {
  if (!href || /^\s*(#|javascript:|mailto:|tel:)/i.test(href)) return false;
  let u; try { u = new URL(href, pageUrl || 'https://page.invalid/'); } catch { return false; }
  if (IMG_FILE.test(u.pathname)) return false;
  if (!pageUrl) return false;
  const here = bareOf(pageUrl); const there = bareOf(u.href);
  return !!here && !!there && here !== there;
}

/** The image addresses an element offers, [attribute, value], preferred attribute first, then zoom, srcset (largest), lazy, live, src. */
function candidatesOf(n, attr = null) {
  const get = (a) => (n.getAttribute ? n.getAttribute(a) : null);
  const val = (a) => (/srcset$/i.test(a) ? bestFromSrcset(get(a)) : get(a));
  const list = [];
  if (attr) list.push([attr, val(attr)]);
  for (const a of ZOOM_ATTRS) list.push([a, get(a)]);
  list.push(['srcset', bestFromSrcset(get('srcset'))], ['data-srcset', bestFromSrcset(get('data-srcset'))]);
  for (const a of LAZY_ATTRS) list.push([a, get(a)]);
  list.push(['currentSrc', n.currentSrc || null], ['src', get('src')]);
  // The <source> of the <picture> around an <img> (its own srcset is often the larger one).
  const pic = n.parentElement && /^picture$/i.test(n.parentElement.tagName) ? n.parentElement : null;
  if (pic) for (const s of pic.querySelectorAll('source')) list.push(['source@srcset', bestFromSrcset(s.getAttribute('srcset') || s.getAttribute('data-srcset'))]);
  return list.filter(([, v]) => v && !/^\s*data:/i.test(v));
}

/** One ProductImage for an <img> (or a <picture>'s img): the largest usable address among its attributes. */
function imageOf(n, { pageUrl = null, attr = null } = {}) {
  let best = null;
  for (const [a, v] of candidatesOf(n, attr)) {
    const url = normalizeImageUrl(v, pageUrl || undefined);
    if (!url || !validateImageUrl(url).ok) continue;
    // Icons, logos, badges… and vector drawings are never a product's photograph.
    const file = (() => { try { return new URL(url).pathname.split('/').pop() || ''; } catch { return ''; } })();
    if (NOISE_FILE.test(file) || /\.svg(?:$|[?#])/i.test(file)) continue;
    const size = imageSize(url);
    if (!best || size > best.size) best = { url, size, attr: a };
  }
  if (!best) return null;
  const wAttr = Number(n.getAttribute('width')); const hAttr = Number(n.getAttribute('height'));
  if (Number.isFinite(wAttr) && Number.isFinite(hAttr) && wAttr > 0 && hAttr > 0 && wAttr < 50 && hAttr < 50) return null; // an icon
  return productImage({ url: best.url, alt: n.getAttribute('alt'), width: n.naturalWidth || (wAttr > 0 ? wAttr : null), height: n.naturalHeight || (hAttr > 0 ? hAttr : null), source: 'dom', attr: best.attr });
}

/**
 * The picture(s) of a block, as ProductImage[]: an <img> (its largest address: zoom / srcset / lazy / src,
 * the <picture>'s sources included), or every picture of a gallery block, plus CSS background images.
 * Page order, each picture once (same picture, other size = one image, the largest kept). A picture inside
 * a link to ANOTHER page (a related product, a colour swatch leading to its own page) is not this product's.
 * @param {Element} el
 * @param {{pageUrl?:string|null, attr?:string|null, max?:number}} [o]  attr: the attribute the rule learned
 * @returns {import('../extract/images.mjs').ProductImage[]}
 */
export function readImages(el, { pageUrl = null, attr = null, max = 30 } = {}) {
  if (!el || el.nodeType !== 1) return [];
  // The page's address resolves relative pictures: the caller's, else the document's own (base / location).
  if (!pageUrl) { try { const d = el.ownerDocument; pageUrl = (d && (d.baseURI || (d.location && d.location.href))) || null; if (pageUrl && !/^https?:/i.test(pageUrl)) pageUrl = null; } catch { pageUrl = null; } }
  const out = [];
  const isImg = /^img$/i.test(el.tagName);
  let nodes = [];
  if (isImg) nodes = [el];
  else { try { nodes = [...el.querySelectorAll('img')]; } catch { nodes = []; } }
  // A <picture> designated without an <img>: its sources.
  if (!nodes.length && /^picture$/i.test(el.tagName)) {
    const srcs = [...el.querySelectorAll('source')].map((s) => bestFromSrcset(s.getAttribute('srcset') || s.getAttribute('data-srcset'))).filter(Boolean);
    for (const v of srcs) { const url = normalizeImageUrl(v, pageUrl || undefined); if (url && validateImageUrl(url).ok) out.push(productImage({ url, source: 'dom', attr: 'source@srcset' }, out.length + 1)); }
  }
  for (const n of nodes) {
    if (out.length >= max) break;
    if (!isImg && leavesPage(linkOf(n), pageUrl)) continue;
    const im = imageOf(n, { pageUrl, attr });
    if (im) out.push({ ...im, position: out.length + 1 });
  }
  // CSS background pictures on the block or its descendants.
  const styled = [];
  try { if (el.getAttribute('style')) styled.push(el); styled.push(...el.querySelectorAll('[style*="background"]')); } catch { /* none */ }
  for (const s of styled) {
    if (out.length >= max) break;
    if (s !== el && leavesPage(linkOf(s), pageUrl)) continue;
    const bg = String(s.getAttribute('style') || '').match(/background(?:-image)?\s*:[^;]*url\((['"]?)([^'")]+)\1\)/i);
    const url = bg ? normalizeImageUrl(bg[2], pageUrl || undefined) : null;
    if (url && validateImageUrl(url).ok) out.push(productImage({ url, source: 'dom', attr: 'style' }, out.length + 1));
  }
  return dedupeImages(out);
}

/** The same, as the row's serialised form (URLs). */
export const readImageUrls = (el, o) => imageUrls(readImages(el, o));
