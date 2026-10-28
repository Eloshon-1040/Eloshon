/**
 * RawProduct → NormalizedProduct (the project's canonical shape).
 *
 * Identity priority (§6): GTIN/EAN → SKU → MPN → source id in URL → canonical
 * URL. Barcodes/SKUs are NEVER invented: barcode is set only from a real GTIN
 * that looks like an EAN/UPC (8/12/13/14 digits).
 *
 * product_type is a SOURCE DECLARATION, not an inference: the admin declares it
 * when configuring the source (opts.defaultProductType). If unknown, it stays
 * null and the eligibility filter returns "to_verify" — the scraper never
 * decides eligibility.
 */
import { normAvailability, productAvailability } from '../shared/extract/stock.mjs';
import { tidyTrail } from '../shared/extract/listing-trail.mjs';
import { parseWeight, netQuantityText, estimateWeightKg } from './weight.mjs';
import { absoluteUrl, cleanUrl } from './url-utils.mjs';
import { cleanText, cleanRichText } from './html-meta.mjs';
import { toProductImages, dedupeImages, imageUrls } from '../shared/extract/images.mjs';
import { skuVerdict, SKU_REASON_TEXT } from '../shared/extract/sku.mjs';
import { specsToObject } from '../shared/knowledge/readers.mjs';
import { firstGtin, isValidGtin } from './jsonld.mjs';
import { parseMoney, parseAmount } from '../shared/extract/money.mjs';

const digits = (s) => String(s).replace(/[^\d]/g, '');

// Coerce a price to { price:number|null, currency:string|null }. A DOM/recipe
// source can deliver the price as a FORMATTED STRING ("72,90 €", "1.299,00"),
// but eligibility needs a real number (Number("72,90 €") is NaN → dropped). Parse
// with the shared money parser (currency-less strings included); a numeric stays
// as-is. The single funnel so no string price ever reaches the eligibility gate.
function coerceMoney(v) {
  if (v == null) return { price: null, currency: null };
  if (typeof v === 'number') return { price: Number.isFinite(v) ? v : null, currency: null };
  if (typeof v === 'string') {
    const m = parseMoney(v);
    if (m && m.price != null) return { price: m.price, currency: m.currency || null };
    const n = parseAmount(v);
    return { price: (n != null && n > 0 && n < 1e9) ? n : null, currency: null };
  }
  return { price: null, currency: null };
}

/**
 * Collapse a name that is one phrase immediately repeated — a generic artifact of
 * cards/fiches that echo the title (listing card name + fiche <h1>, a doubled
 * `alt`, a title shown twice): "Vélo de ville Kalkhoff Vélo de Ville Kalkhoff" →
 * "Vélo de ville Kalkhoff". Compares the two halves case/punctuation-insensitively
 * so "Name - Name" collapses too. Only exact full duplication; a real name that
 * merely contains a repeated word (e.g. "New York New York Bag") is not an even
 * two-way split of equal halves, so it is left intact.
 * @param {string} s
 * @returns {string}
 */
// The colour a product page states in its technical specs ("Couleur (selon le fabriquant)": "Bleu"),
// used only when no other reader gave one. A name has to START with a colour word, so "Écran couleur"
// or "Nombre de couleurs" never match; a yes/no or unknown value is no colour.
const COLOR_SPEC_NAME = /^(couleur|coloris|color|colour|kleur|farbe)\b/i;
const NOT_A_COLOR = /^(oui|non|yes|no|ja|nee|n\/a|inconnu|unknown|-|—)$/i;
export function colorFromSpecs(specs, technicalSpecs) {
  const pairs = [];
  if (Array.isArray(specs)) {
    for (const s of specs) if (s) pairs.push([s.name, s.value]);
  } else if (technicalSpecs && typeof technicalSpecs === 'object') {
    for (const [k, v] of Object.entries(technicalSpecs)) pairs.push([k, v]);
  }
  const found = new Map();
  for (const [name, value] of pairs) {
    const v = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    if (COLOR_SPEC_NAME.test(String(name || '').trim()) && v && v.length <= 40 && !NOT_A_COLOR.test(v) && !found.has(v.toLowerCase())) found.set(v.toLowerCase(), v);
  }
  // A bundle states one colour per item (a phone AND its case): two different colours name no single one.
  return found.size === 1 ? [...found.values()][0] : null;
}

export function dedupeRepeatedName(s) {
  const str = String(s || '').trim();
  if (!str) return str;
  const words = str.split(/[\s\-–—:|]+/).filter(Boolean); // a lone separator is a delimiter, not a word
  const n = words.length;
  if (n < 2 || n % 2 !== 0) return str;
  const half = n / 2;
  const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const a = norm(words.slice(0, half).join(' '));
  const b = norm(words.slice(half).join(' '));
  if (a && a === b && a.length >= 3) return words.slice(0, half).join(' ');
  return str;
}

function gtinToBarcode(gtin) {
  if (!gtin) return null;
  // firstGtin unmashes a multi-variant value ("a,b" / ["a","b"]) to the first
  // valid EAN; then keep it only when it really is an EAN/UPC length.
  const d = firstGtin(gtin);
  return d && [8, 12, 13, 14].includes(digits(d).length) ? digits(d) : null;
}

/**
 * Last-resort barcode recovery: some sites embed the EAN in the product URL slug
 * (e.g. microfluo.net `/vents-vk-125-355mh-4823016208033.html`). When normal
 * extraction found no GTIN, scan the URL PATH for a standalone 8/12/13/14-digit
 * run and accept it ONLY if it passes the GS1 check digit — never invent one.
 * A trailing number that is not a valid EAN (a product id, a size code) is
 * ignored. Prefers the longest valid candidate (EAN-13/14 over a stray 8).
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
function barcodeFromUrl(url) {
  if (!url) return null;
  let path;
  try { path = decodeURIComponent(new URL(url, 'https://x/').pathname); } catch { path = String(url); }
  path = path.replace(/\.(html?|php|aspx?)$/i, '');
  const runs = (path.match(/\d{8,14}/g) || []).filter((r) => [8, 12, 13, 14].includes(r.length) && isValidGtin(r));
  if (!runs.length) return null;
  runs.sort((a, b) => b.length - a.length);
  return runs[0];
}

/** source_product_id from the most reliable identifier available. */
function sourceProductId(raw) {
  // A real EAN is the strongest id — but only a SINGLE valid one, never a
  // multi-variant concatenation (that used to leak a 26-digit non-id here).
  if (raw.gtin) { const d = firstGtin(raw.gtin); if (d && [8, 12, 13, 14].includes(digits(d).length)) return digits(d); }
  if (raw.sku) return String(raw.sku).trim();
  if (raw.reference) return String(raw.reference).trim();
  if (raw.mpn) return String(raw.mpn).trim();
  const url = raw.canonicalUrl || raw.sourceUrl;
  if (url) {
    // last meaningful path segment or an explicit ?p=/?id= token
    try {
      const u = new URL(url);
      const idParam = u.searchParams.get('id') || u.searchParams.get('p') || u.searchParams.get('productId');
      if (idParam) return idParam;
      // Use the last MEANINGFUL path segment (skip generic index.* / empty),
      // so sites like /catalogue/<slug>/index.html don't collapse to "index.html".
      const segs = u.pathname.split('/').filter(Boolean);
      while (segs.length && /^index\.(html?|php|aspx?)$/i.test(segs[segs.length - 1])) segs.pop();
      const seg = segs.pop();
      if (seg) return decodeURIComponent(seg);
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * The category a product sits in, as one " > " path: its trail (breadcrumb — its page's,
 * or the listing's) followed by its own category when that is not already the last step.
 * @param {string[]|null|undefined} trail
 * @param {string|null|undefined} own
 * @returns {string|null}
 */
export function categoryPath(trail, own, pageUrl = '', productName = '') {
  const t = tidyTrail(trail, pageUrl);
  // A product page's breadcrumb often ends with the product itself: not a category.
  const same = (a, b) => String(a || '').toLowerCase().replace(/\s+/g, ' ').trim() === String(b || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (productName && t.length && same(t[t.length - 1], productName)) t.pop();
  const o = own ? String(own).trim() : '';
  if (!o) return t.length ? t.join(' > ') : null;
  if (!t.length) return o;
  // Own category steps appended only when new: a step already in the trail is not
  // repeated (compared without case, accents or punctuation: "salons meubles de
  // jardin" = "Salons & meubles de jardin").
  const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&|\band\b|\bet\b|\bund\b|\ben\b|\by\b/g, ' ').replace(/[^a-z0-9]+/g, '');
  const steps = new Set(t.map(slug));
  const path = [...t];
  for (const s of o.split(/\s>\s/).map((x) => x.trim()).filter(Boolean)) if (!steps.has(slug(s))) { path.push(s); steps.add(slug(s)); }
  return path.join(' > ');
}

// Size words in an image path ("1625-home_default", "large", "800x800"): two URLs that
// differ only by these are the same picture in two sizes.
const SIZE_TOKEN = /(^|[-_.])(thumbnail|thumbs?|small|medium|large|big|home|cart|zoom|default|mini|xs|sm|md|lg|xl|xxl|original|full|hd|\d{2,4}x\d{2,4})(?=$|[-_.])/gi;
const SIZE_RANK = [[/original|full|zoom|hd|xxl/i, 5], [/\bxl\b|large|big|lg/i, 4], [/medium|md|home|default/i, 2], [/small|thumb|mini|cart|xs|sm/i, 1]];
function renditionKey(u) {
  try {
    const x = new URL(u);
    const segs = x.pathname.split('/').map((s) => s.replace(SIZE_TOKEN, '').replace(/^[-_.]+|[-_.]+$/g, ''));
    return `${x.host}/${segs.join('/')}`.toLowerCase();
  } catch { return String(u); }
}
function renditionRank(u) {
  let path = ''; try { path = new URL(u).pathname; } catch { path = String(u); }
  const dims = path.match(/(\d{2,4})x(\d{2,4})/); if (dims) return 3 + Number(dims[1]) / 10000;
  for (const [re, r] of SIZE_RANK) if (re.test(path.replace(/[-_]/g, ' '))) return r;
  return 3;
}
/**
 * One URL per picture: the same image listed in several sizes ("…-home_default/x.jpg"
 * and "…-large_default/x.jpg") is kept once, in its largest size, at the place of
 * its first appearance. Different pictures are never merged.
 * Since the image contract (shared/extract/images.mjs) this is dedupeImages on the
 * serialised form: the historical size words are a subset of the shared key, and
 * an address the contract rejects (data:, truncated) is dropped here too.
 */
export function dedupeRenditions(urls) {
  const list = (urls || []).filter(Boolean);
  if (list.length < 2) return [...new Set(list)];
  const at = new Map(); const out = [];
  for (const u of list) {
    const k = renditionKey(u);
    if (!at.has(k)) { at.set(k, out.length); out.push(u); continue; }
    const i = at.get(k);
    if (renditionRank(u) > renditionRank(out[i])) out[i] = u;
  }
  return imageUrls(dedupeImages(toProductImages(out).images));
}

/**
 * @param {import('./types.mjs').RawProduct} raw
 * @param {{ storeSlug?:string, defaultProductType?:string|null, categorySlug?:string|null }} [opts]
 * @returns {import('./types.mjs').NormalizedProduct}
 */
export function toNormalizedProduct(raw, opts = {}) {
  const name = dedupeRepeatedName(cleanText(raw.name) || raw.name || '');
  // Clean descriptions from any source: strip HTML/entities, drop empty/garbage
  // (e.g. "<p>&nbsp;</p>" → null, "null Ierse ribeye" → "Ierse ribeye").
  const desc = raw.richText ? cleanRichText(raw.description) : cleanText(raw.description);
  // Net quantity: what the source stated, else a labelled weight in the description,
  // else a unit-anchored quantity in the name (gap fillers only — never invented).
  const w = parseWeight(netQuantityText({ weightText: raw.weightText, description: raw.description, name }));
  // A liquid with a volume but no mass gets an ESTIMATED weight (marked raw.weight_estimated);
  // a real mass is never replaced.
  const estimatedKg = w.weight_kg == null ? estimateWeightKg(w.volume_l) : null;
  const imageBase = raw.sourceUrl || raw.canonicalUrl || undefined;
  // Phase 0 (products.json contract): retain the FULL image list. The CSV
  // keeps its single image_url cell, but the rich JSON must not discard
  // images[1..n] — they used to be lost right here, not even kept in `raw`.
  // Image contract (shared/extract/images.mjs): every address absolute and usable,
  // one image per picture in its largest size, order kept; a rejected address goes
  // to the run's diagnostics (opts.diag) with its reason — never dropped silently.
  const imgRead = toProductImages(Array.isArray(raw.images) ? raw.images : [], { base: imageBase, source: 'row' });
  const images = imageUrls(dedupeImages(imgRead.images));
  const image = images.length ? images[0] : null;
  const diag = opts.diag && typeof opts.diag === 'object' ? opts.diag : null;
  const productRef = raw.sku || raw.reference || raw.gtin || raw.name || raw.sourceUrl || null;
  // SKU contract (shared/extract/sku.mjs): only an identifier the source declares; a label (« Couleur du produit :
  // … »), a phrase, an option name is removed and reported — the SKU then stays empty, never invented.
  const variantNames = Array.isArray(raw.variants) ? raw.variants.map((v) => v && v.name) : [];
  const skuNames = [...variantNames, raw.color]; // not the title: a real SKU may read like it (« GUIDE-PDF »)
  const rejectedSkus = [];
  const keepSku = (value, where) => {
    if (value == null || value === '') return null;
    const r = skuVerdict(value, { names: skuNames });
    if (r.ok) return r.value;
    rejectedSkus.push({ product: productRef ? String(productRef).slice(0, 80) : null, value: String(value).slice(0, 120), field: where, reason: r.reason, label: SKU_REASON_TEXT[r.reason] });
    return null;
  };
  // A listing card's identifier that the page does not declare as SKU (a code, an id): the product's reference.
  const skuIsReference = raw.skuIsReference === true;
  const sku = skuIsReference ? keepSku(raw.declaredSku, 'sku') : keepSku(raw.sku, 'sku');
  const reference = raw.reference || (skuIsReference && raw.sku) || null;
  const variantsIn = (Array.isArray(raw.variants) && raw.variants.length) ? raw.variants.map((v) => {
    if (!v || typeof v !== 'object' || v.code == null || v.code === '') return v;
    const code = keepSku(v.code, 'variants.code');
    if (code) return code === v.code ? v : { ...v, code };
    const { code: _drop, ...rest } = v;
    return rest;
  }) : null;
  if (diag) {
    if (rejectedSkus.length) (diag.rejectedSkus = diag.rejectedSkus || []).push(...rejectedSkus);
    diag.rejectedImages = diag.rejectedImages || [];
    for (const r of [...imgRead.rejected, ...(Array.isArray(raw.imagesRejected) ? raw.imagesRejected : [])]) diag.rejectedImages.push({ product: productRef ? String(productRef).slice(0, 80) : null, url: String(r.url || '').slice(0, 300), reason: r.reason, label: r.label || r.reason, ...(r.source ? { source: r.source } : {}) });
  }
  const category = categoryPath(raw.breadcrumb, raw.category, raw.canonicalUrl || raw.sourceUrl, name);
  const money = coerceMoney(raw.price);
  const listMoney = coerceMoney(raw.listPrice);
  // The product's address: canonical when the page gave one, else the visited one — absolute, tracking
  // parameters dropped, locale kept. A change from what was read is counted (report "urls corrected").
  const rawUrl = raw.canonicalUrl || raw.sourceUrl || null;
  const sourceUrl = rawUrl ? (cleanUrl(absoluteUrl(rawUrl, raw.sourceUrl || undefined) || rawUrl) || rawUrl) : null;
  if (diag && sourceUrl && rawUrl && sourceUrl !== rawUrl) { diag.urlsCorrected = (diag.urlsCorrected || 0) + 1; (diag.urlSamples = diag.urlSamples || []).length < 10 && diag.urlSamples.push({ from: String(rawUrl).slice(0, 300), to: sourceUrl }); }

  // Store the volume/textual contenance when we could not derive a mass, so the
  // information is not lost (kept in `raw`, and volume noted in storage-ish).
  const normalized = {
    store_slug: opts.storeSlug || null,
    source_url: sourceUrl,
    source_product_id: sourceProductId({ ...raw, sku, reference }),
    source_category: category,
    product_type: opts.defaultProductType ?? null,
    name: name, // the language of the URL that was pasted — a single language, never mirrored
    description: desc,
    storage_info: null,
    is_alcoholic: undefined, // let the eligibility filter detect from name/keywords
    price: money.price,
    weight_kg: w.weight_kg ?? estimatedKg,
    barcode: gtinToBarcode(raw.gtin) || barcodeFromUrl(raw.canonicalUrl || raw.sourceUrl),
    hs_code: null,
    images,
    image_url: image,
    category_slug: opts.categorySlug ?? null,
    color: raw.color || colorFromSpecs(raw.specs, raw.technical_specs),
    // A variant's own page link (an option sold as its own product) is made absolute.
    variants: variantsIn
      ? variantsIn.map((v) => (v && typeof v.url === 'string' && v.url ? { ...v, url: absoluteUrl(v.url, imageBase) || v.url } : v))
      : null,
    raw: {
      brand: raw.brand || null,
      currency: raw.currency || money.currency || listMoney.currency || null,
      // A price "before reduction" is one only above the price charged (the listing's
      // struck price can equal the product page's current price).
      list_price: listMoney.price != null && (money.price == null || listMoney.price > money.price) ? listMoney.price : null,
      // schema.org term when recognised (InStock / OutOfStock / PreOrder / BackOrder /
      // Discontinued) — the sizes decide when they carry a state — else the statement verbatim.
      availability: productAvailability(raw.variants) || normAvailability(raw.availability) || (raw.availability != null && raw.availability !== '' ? String(raw.availability) : null),
      // A rating with a known count of 0 is no rating; a rating stated without any
      // count (a listing card shows "4,75" alone) is kept.
      rating: raw.rating != null && !(raw.reviewCount != null && Number(raw.reviewCount) <= 0) ? Number(raw.rating) : null,
      review_count: raw.reviewCount != null ? Number(raw.reviewCount) : null,
      weight_text: w.text,
      weight_estimated: estimatedKg != null,
      volume_l: w.volume_l,
      pack_count: w.count,
      breadcrumb: raw.breadcrumb || [],
      sku: sku || null,
      // The product's reference (article code of its colourway / URL), kept apart from the SKU: the user decides.
      reference: reference ? String(reference).trim().slice(0, 64) : undefined,
      mpn: raw.mpn || null,
      gtin: raw.gtin || null,
      extractor: raw.strategy,
      confidence: raw.confidence,
      // The columns the user added in the extension panel ("Ville", "Tailles"…), kept
      // as read: { key: text }. Absent (JSON-dropped) on every other lane.
      columns: raw.columns && typeof raw.columns === 'object' && Object.keys(raw.columns).length ? { ...raw.columns } : undefined,
      // Technical specifications as the product page states them: [{ group, name, value }].
      // Absent (JSON-dropped) when the page has none.
      specs: Array.isArray(raw.specs) && raw.specs.length ? raw.specs.map((x) => ({ group: x.group ?? null, name: x.name, value: x.value })) : undefined,
      // The same specifications as { name: value } (a name repeated in two groups keeps its group).
      technical_specs: raw.technical_specs && typeof raw.technical_specs === 'object' && Object.keys(raw.technical_specs).length ? { ...raw.technical_specs } : (Array.isArray(raw.specs) && raw.specs.length ? specsToObject(raw.specs) : undefined),
    },
  };
  return normalized;
}
