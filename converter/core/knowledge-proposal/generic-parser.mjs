// Phase 5.5 — Generic knowledge-driven parser (JSON medium).
//
// Reads a FormatKnowledge entry (its `fields[]` + `structure`) and turns a
// payload of source objects into CanonProduct[]. There is no per-site code
// here: WooCommerce REST, Shopify GraphQL or a Scraper JSON are all the same
// loop over data-declared field entries.
//
// Guarantees ("no silent data loss"):
//   – every source key a field entry reads is CONSUMED;
//   – every other top-level source key is preserved verbatim under
//     sourceExtension.<platform>._raw and listed in unmapped[] (reason
//     'unknown') — the user can see it, the mapper can later promote it;
//   – entries whose canon is `sourceExtension.<platform>.<key>` are kept with
//     their declared preservationReason ('platform-specific' by default);
//   – every canonical value written carries provenance (source path,
//     transform, method 'exact').
//
// Relations (concept-map) are reconstructed by transforms + `structure`:
//   product ↔ variants  : structure.variants (companion keyed by parent id,
//                         or the product itself when it has none)
//   parent → variant    : structure.inheritance { nullMeansParent } — a null
//                         on the child means "the parent's value" (Shopware
//                         DAL semantics); provenance says so with the typed
//                         marker method: 'inherited' (6.2)
//   variants ARE products: structure.variants.sameEntity — keys the product
//                         scope consumed are not "unknown" on a child
//   option ↔ value      : options_from_attributes / option_values_from_attributes
//   category hierarchy  : category_paths_from_terms (+ companion taxonomy)
//   price ↔ promo       : price_promo (multi-output)
//   stock per variant   : stock_policy with parent inheritance

import { applyTransform, hasTransform, getPath, toText } from './transforms.mjs';
import { scanForCardData } from './pci-scanner.mjs';
import { parseVariantText } from './variant-text.mjs';
import { rowMatches, unitsOfRows } from './legacy-units.mjs';

// Required shape of @eloshon/catalog (mirrors the type; keeps serialisers safe).
const PRODUCT_DEFAULTS = () => ({
  handle: '', title: '', bodyHtml: '', vendor: '', productType: '', tags: [], status: 'active',
  categories: [], published: true, options: [], variants: [], images: [], metafields: [], seoTitle: '', seoDescription: '',
});
const VARIANT_DEFAULTS = () => ({
  optionValues: [], sku: '', price: null, compareAtPrice: null, cost: null, barcode: '', grams: null,
  lengthCm: null, widthCm: null, heightCm: null, requiresShipping: true, taxable: true, inventoryQty: null, imageSrc: '',
});

// Phase 7 — the same loop reads ORDER and CUSTOMER payloads (format.entity):
// entries with scope 'item' apply to each order line (structure.items), the
// rest to the unit. Required shape of the pre-Phase-7 CanonOrder /
// CanonCustomer kept for the CSV serialisers; the typed Phase 7 blocks are
// optional and only emitted when the source carries them.
const ADDRESS_DEFAULTS = () => ({ company: '', address1: '', address2: '', city: '', province: '', provinceCode: '', country: '', zip: '', phone: '' });
const ORDER_DEFAULTS = () => ({
  number: '', email: '', createdAt: '', financialStatus: '', fulfillmentStatus: '', currency: '',
  subtotal: null, shipping: null, taxes: null, total: null, discountCode: '', discountAmount: null,
  paymentMethod: '', transactionId: '', note: '', billing: { name: '', ...ADDRESS_DEFAULTS() }, shipping_: { name: '', ...ADDRESS_DEFAULTS() }, lineItems: [],
});
const CUSTOMER_DEFAULTS = () => ({
  firstName: '', lastName: '', email: '', phone: '', address: ADDRESS_DEFAULTS(), shipping: null,
  acceptsEmail: null, acceptsSms: null, note: '', tags: [], taxExempt: false,
});
const ITEM_DEFAULTS = () => ({ name: '', sku: '', quantity: 1, unitPrice: null, total: null });

const MAX_PROVENANCE_VALUE = 200;

function slugify(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'product';
}

function setPath(obj, path, value) {
  const segs = path.split('.');
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (cur[s] === undefined || cur[s] === null || typeof cur[s] !== 'object') cur[s] = {};
    cur = cur[s];
  }
  cur[segs[segs.length - 1]] = value;
}

function provenanceValue(v) {
  if (v === undefined) return undefined;
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > MAX_PROVENANCE_VALUE ? v.slice(0, MAX_PROVENANCE_VALUE) + '…' : v;
  return undefined; // objects/arrays: too large, path is enough
}

const isNil = (v) => v === undefined || v === null;

/** Read the entry's input(s) from the source object. With
 *  structure.inheritance.nullMeansParent and a real child, a null/undefined
 *  child value falls back to the parent's value at the same path — returns
 *  `inherited: true` so provenance can say where the value came from. */
function readInputs(source, entry, ctx) {
  const inh = ctx?.format?.structure?.inheritance;
  const canInherit = !!(inh && inh.nullMeansParent && ctx.parent && !(inh.exclude || []).includes(entry.path));
  const read = (p) => {
    const own = getPath(source, p);
    if (!canInherit || !isNil(own) || (inh.exclude || []).includes(p)) return { v: own, inherited: false };
    const pv = getPath(ctx.parent, p);
    return { v: pv, inherited: !isNil(pv) };
  };
  // A column FAMILY (pathPattern): the value is { column: cell } for every
  // source key the pattern matches, in source order (Phase 2).
  if (entry.pathPattern) {
    const re = new RegExp(entry.pathPattern);
    return { raw: Object.fromEntries(Object.entries(source || {}).filter(([k]) => re.test(k))), inherited: false };
  }
  if (entry.inputs && entry.inputs.length) {
    const parts = entry.inputs.map(read);
    return { raw: parts.map((x) => x.v), inherited: parts.some((x) => x.inherited) };
  }
  const r = read(entry.path);
  return { raw: r.v, inherited: r.inherited };
}

function scopeOf(entry) {
  if (entry.scope) return entry.scope;
  if (typeof entry.canon === 'string' && entry.canon.startsWith('items[].')) return 'item';
  if (entry.when === 'child' || entry.when === 'self') return 'variant';
  return typeof entry.canon === 'string' && entry.canon.startsWith('variants[].') ? 'variant' : 'product';
}

// Optional nested blocks (identity.*, merchandising.*, external.*, digital.*…)
// are only worth emitting when they carry something: '' / null / [] are the
// source saying "nothing here", not a value. Top-level required canon fields
// keep their defaults ('' / []) so serialisers stay safe.
function isEmptyOptional(v) {
  return v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0);
}

/** Apply one field entry to a target (product or variant). */
function applyEntry(entry, target, ctx, trace) {
  const { source, platform, unmapped, ext } = ctx;
  // `when`: 'child' = only on a real variation object, 'self' = only when the
  // product stands as its own variant, 'always' (default) = both.
  if (entry.when === 'child' && ctx.parent === null) return;
  if (entry.when === 'self' && ctx.parent !== null) return;
  const { raw, inherited } = readInputs(source, entry, ctx);
  if (entry.transform === 'ignore' || entry.canon === null) return;
  if (!hasTransform(entry.transform)) throw new Error(`format ${ctx.format.id}: field "${entry.path}" uses unknown transform "${entry.transform}"`);
  const value = applyTransform(entry.transform, raw, ctx);
  const canon = String(entry.canon);

  // unmapped: declared preservation with a reason (value goes to sourceExtension too)
  if (canon === 'unmapped') {
    if (raw === undefined) return;
    if (isEmptyOptional(raw)) return; // nothing to preserve
    unmapped.push({ platform, sourceField: entry.path, sourceValue: raw, reason: entry.preservationReason || 'no-canon-field', ...(entry.notes ? { note: entry.notes } : {}) });
    ext[entry.path] = raw;
    return;
  }
  // sourceExtension.<platform>.<key>: platform-specific keep
  if (canon.startsWith('sourceExtension.')) {
    if (raw === undefined) return;
    // A transform that yields nothing on an ABSENT source (null, or an array
    // with nothing in it) has nothing to preserve — no key is materialised
    // (6.3, copy_present & co.). An empty STRING is still a source value.
    if (value === undefined && (raw === null || (Array.isArray(raw) && raw.every((x) => x === null || x === undefined || (Array.isArray(x) && !x.length))))) return;
    const key = canon.split('.').slice(2).join('.');
    ext[key] = value === undefined ? raw : value;
    // A declared "promotable" field only counts as unmapped DATA when the
    // source actually carries a value ('' / [] / null is not a loss).
    if (entry.preservationReason && entry.preservationReason !== 'platform-specific' && !isEmptyOptional(raw) && !(Array.isArray(raw) && raw.every(isEmptyOptional))) {
      unmapped.push({ platform, sourceField: entry.path, sourceValue: raw, reason: entry.preservationReason, ...(entry.notes ? { note: entry.notes } : {}) });
    }
    return;
  }

  const parts = canon.split('+').map((s) => s.trim()).filter(Boolean);
  const values = parts.length > 1 ? (Array.isArray(value) ? value : [value]) : [value];
  parts.forEach((part, i) => {
    let local = part.startsWith('variants[].') ? part.slice('variants[].'.length) : part.startsWith('items[].') ? part.slice('items[].'.length) : part;
    const v = values[i];
    if (v === undefined) return;
    // `metafields[]` / `attributesRich[]` / `tags[]`: APPEND to the array
    // (several source columns may feed one canon list).
    if (local.endsWith('[]')) {
      local = local.slice(0, -2);
      if (isEmptyOptional(v)) return;
      const arr = Array.isArray(target[local]) ? target[local] : (target[local] = []);
      for (const item of Array.isArray(v) ? v : [v]) arr.push(item);
      trace[local + '[' + (arr.length - 1) + ']'] = { platform, sourceField: entry.path, transform: entry.transform, method: 'exact' };
      return;
    }
    if (local.includes('.') && isEmptyOptional(v)) return;
    setPath(target, local, v);
    const pv = provenanceValue(Array.isArray(raw) && entry.inputs ? raw[i] ?? raw[0] : raw);
    // Phase 6.2 — an inherited value carries the TYPED marker 'inherited'
    // (CanonProvenanceMethod), not 'structural' + a free-text note: a
    // write-adapter can re-emit null or materialise it without parsing prose.
    trace[local] = { platform, sourceField: entry.inputs ? entry.inputs.join(' + ') : entry.path, ...(pv !== undefined ? { sourceValue: pv } : {}), transform: entry.transform,
      method: inherited ? 'inherited' : 'exact' };
  });
}

/** Technical sheet / features columns (`descriptionSections[]`, transform
 *  description_section) are part of the description: appended to bodyHtml in
 *  column order, after the commercial text, so every target carries them.
 *  The temporary list never reaches the canon. */
/** Several source columns may feed one list (Photo 1, Photo 2… → images[]; Tags,
 *  Labels → tags[]). Each column was appended in order; here the union is cleaned:
 *  a URL that appears twice is kept once (first position wins) and the image
 *  positions are renumbered 1..n. Only touches lists that were actually appended
 *  to, so a Reference format's own positions are left alone. */
function mergeAppendedLists(product, trace) {
  const appended = (name) => Object.keys(trace).some((k) => k.startsWith(name + '['));
  if (appended('images') && Array.isArray(product.images)) {
    const seen = new Set();
    product.images = product.images
      .filter((im) => { const k = String(im?.src ?? '').trim(); if (!k || seen.has(k)) return false; seen.add(k); return true; })
      .map((im, i) => ({ ...im, position: i + 1 }));
  }
  if (appended('tags') && Array.isArray(product.tags)) {
    const seen = new Set();
    product.tags = product.tags.filter((t) => { const k = String(t).trim().toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  }
}

function mergeDescriptionSections(product, trace, platform) {
  const sections = product.descriptionSections;
  delete product.descriptionSections;
  if (!Array.isArray(sections) || !sections.length) return;
  const fromCols = [];
  for (let i = 0; i < sections.length; i++) { const t = trace['descriptionSections[' + i + ']']; if (t) { fromCols.push(t.sourceField); delete trace['descriptionSections[' + i + ']']; } }
  const base = String(product.bodyHtml ?? '');
  product.bodyHtml = [base, ...sections.map((s) => s.html)].filter((x) => x.trim()).join('\n');
  const prev = trace.bodyHtml;
  trace.bodyHtml = { platform, sourceField: [prev?.sourceField, ...fromCols].filter(Boolean).join(' + '), transform: prev ? prev.transform + ' + description_section' : 'description_section', method: 'structural' };
}

function consumedKeys(entries) {
  const keys = new Set();
  keys.patterns = [];
  for (const e of entries) {
    // a column family consumes every key its pattern matches (Phase 2)
    if (e.pathPattern) { keys.patterns.push(new RegExp(e.pathPattern)); continue; }
    // the top-level key of a dotted JSON path AND the verbatim path (a CSV column with dots — 6.5)
    for (const p of [e.path, ...(e.inputs || [])]) if (p) { keys.add(String(p).split('.')[0].replace(/\[\]$/, '')); keys.add(String(p)); }
    for (const k of e.consumes || []) keys.add(k);
  }
  return keys;
}
const isConsumed = (consumed, key) => consumed.has(key) || (consumed.patterns || []).some((re) => re.test(key));

function preserveUnknown(source, consumed, platform, ext, unmapped) {
  for (const key of Object.keys(source || {})) {
    if (isConsumed(consumed, key)) continue;
    if (!ext._raw) ext._raw = {};
    ext._raw[key] = source[key];
    unmapped.push({ platform, sourceField: key, sourceValue: source[key], reason: 'unknown' });
  }
}

/** structure.preserveNested = ['raw', …]: a nested object whose top-level key
 *  an entry consumes (any `raw.x` path consumes `raw`) is NOT consumed
 *  wholesale — each of its own keys no entry reads is preserved like an
 *  unknown top-level key, under its dotted path (`raw.newKey`). Without it, a
 *  key added to that object later would be swallowed silently. */
function preserveNestedUnknown(source, entries, nested, platform, ext, unmapped) {
  for (const base of nested || []) {
    const obj = getPath(source, base);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    const prefix = base + '.';
    const read = new Set();
    for (const e of entries) for (const p of [e.path, ...(e.inputs || []), ...(e.consumes || [])]) {
      if (p === base) { read.add('*'); continue; }
      if (p && String(p).startsWith(prefix)) read.add(String(p).slice(prefix.length).split('.')[0]);
    }
    if (read.has('*')) continue;
    for (const key of Object.keys(obj)) {
      if (read.has(key)) continue;
      if (!ext._raw) ext._raw = {};
      ext._raw[prefix + key] = obj[key];
      unmapped.push({ platform, sourceField: prefix + key, sourceValue: obj[key], reason: 'unknown' });
    }
  }
}

/** structure.customColumns = 'raw.columns': the user's own columns (a Scraper job's « Taille », « Sous-titre »…)
 *  that no entry reads become descriptive attributes { name, values, forVariation:false } — the step-3 « cases
 *  personnalisées » placed per target (custom-fields.ts). One level only consumed the whole object before (28/10:
 *  `raw.columns.taille` was lost on every target). */
function customColumnsOf(source, entries, base, product) {
  const obj = getPath(source, base);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  const prefix = base + '.';
  const read = new Set();
  for (const e of entries) for (const p of [e.path, ...(e.inputs || []), ...(e.consumes || [])]) if (p && String(p).startsWith(prefix)) read.add(String(p).slice(prefix.length).split('.')[0]);
  const rich = product.attributesRich || [];
  for (const [key, v] of Object.entries(obj)) {
    if (read.has(key) || v == null || typeof v === 'object' || String(v).trim() === '') continue;
    const name = key.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
    if (rich.some((a) => a.name.toLowerCase() === name.toLowerCase())) continue;
    rich.push({ name, values: [String(v).trim()], forVariation: false, visible: true, key });
  }
  if (rich.length) product.attributesRich = rich;
}

/** Find the variation objects of a product per `structure.variants`. */
function variantsOf(product, structure, companions) {
  return childrenOf(product, structure?.variants || {}, companions);
}
/** The child objects of a unit per a structure spec (variants / items):
 *  companion keyed by parent id (object) or flat (childParentPath), or an
 *  inline array (inlinePath, optionally JSON text). */
function childrenOf(product, sv, companions) {
  const companion = sv.companion ? companions?.[sv.companion] : null;
  const key = String(getPath(product, sv.keyedBy || 'id'));
  let kids = [];
  if (companion) {
    if (Array.isArray(companion)) kids = companion.filter((v) => String(getPath(v, sv.childParentPath || 'parent_id')) === key);
    else if (companion && typeof companion === 'object') kids = companion[key] || [];
  } else if (sv.inlinePath) {
    let inline = getPath(product, sv.inlinePath);
    // The « Variantes » text cell of an Eloshon export ("30 ML : 77.7 | 50 ML : 115.5 (épuisé)"): one child per value.
    if (sv.parseText && typeof inline === 'string' && inline.trim() && !/^\s*[[{]/.test(inline)) {
      inline = parseVariantText(inline, sv.parseText === true ? {} : sv.parseText);
    }
    // CSV cells carry nested structures as JSON text (Scraper `variants` column).
    if (sv.parseJson && typeof inline === 'string' && inline.trim()) {
      try { inline = JSON.parse(inline); } catch { inline = null; }
    }
    if (Array.isArray(inline) && inline.length && typeof inline[0] === 'object') kids = inline;
  }
  // structure.variants.axes = [{ path, name }]: one product row whose columns each list the values of one axis
  // (« Taille » = "28 | 29 | 30", « Couleur » = "Bleu, Noir"). Every combination is a variant (the site's
  // availability per combination is not known): { __kid: true, Taille: '28', Couleur: 'Bleu' }.
  if (!kids.length && Array.isArray(sv.axes) && sv.axes.length) {
    const lists = sv.axes.map((a) => ({ name: a.name, values: [...new Set(parseVariantText(toText(getPath(product, a.path))).map((o) => o.name))] })).filter((l) => l.values.length);
    if (lists.length) {
      kids = [{ __kid: true }];
      for (const l of lists) kids = kids.flatMap((k) => l.values.map((v) => ({ ...k, [l.name]: v })));
    }
  }
  return kids;
}

/** structure.options.fromVariants = { name, value }: derive the product's
 *  options axis from its children when the source only types them there
 *  (e.g. [{type:'couleur', name:'Bleu'}] on each variant). */
function optionsFromVariants(kids, spec) {
  const byName = new Map();
  for (const k of kids) {
    const items = Array.isArray(k) ? k : [k];
    // spec.columns: the axes are columns of the variant row (header = option name)
    if (Array.isArray(spec.columns)) {
      for (const it of items) for (const col of spec.columns) {
        const v = getPath(it, col);
        if (v === undefined || v === null || String(v).trim() === '') continue;
        if (!byName.has(col)) byName.set(col, new Set());
        byName.get(col).add(String(v).trim());
      }
      continue;
    }
    for (const it of items) {
      const n = getPath(it, spec.name); const v = getPath(it, spec.value);
      if (n === undefined || n === null || n === '' || v === undefined || v === null || v === '') continue;
      if (!byName.has(String(n))) byName.set(String(n), new Set());
      byName.get(String(n)).add(String(v));
    }
  }
  return [...byName].map(([name, vals]) => ({ name, values: [...vals] }));
}

/**
 * Phase 6.3 — canon derivation rules, DATA in the canon catalogue
 * (`canon/fields.v1.json#derivations`): a canonical field filled from OTHER
 * canonical fields when the source left it empty — e.g. `barcode` ← the first
 * of identifiers.gtin → ean → upc → isbn. Applied per product / per variant
 * after the format's own entries ran; provenance names the canonical source
 * path and the rule's transform, method 'structural'.
 *
 * applyCanonDerivations(products, catalog) — idempotent (only empty targets).
 */
export function applyCanonDerivations(products, catalog, entity = 'products') {
  // Phase 7: a rule's scope names its entity — product / variant (products),
  // order, customer. Only the rules of the units' entity run.
  const ofEntity = (r) => (entity === 'orders' ? r.scope === 'order' : entity === 'customers' ? r.scope === 'customer' : !r.scope || r.scope === 'product' || r.scope === 'variant');
  const rules = Array.isArray(catalog?.derivations) ? catalog.derivations.filter(ofEntity) : [];
  if (!rules.length) return products;
  for (const product of products) {
    for (const rule of rules) {
      const targets = rule.scope === 'variant' ? product.variants || [] : [product];
      for (const t of targets) {
        const cur = getPath(t, rule.path);
        if (!(cur === undefined || cur === null || cur === '')) continue;
        const from = (rule.from || []).find((p) => { const v = getPath(t, p); return !(v === undefined || v === null || v === ''); });
        if (!from) continue;
        const value = applyTransform(rule.transform || 'first_non_empty', [getPath(t, from)], { args: rule.args });
        if (value === undefined) continue;
        setPath(t, rule.path, value);
        const src = t.provenance?.[from];
        t.provenance = t.provenance || {};
        t.provenance[rule.path] = { platform: src?.platform ?? 'canon', sourceField: src?.sourceField ?? from, ...(src?.sourceValue !== undefined ? { sourceValue: src.sourceValue } : {}), transform: rule.transform || 'first_non_empty', method: 'structural' };
      }
    }
  }
  return products;
}

/**
 * parseWithKnowledge(format, payload, { companions, platform, canon })
 *   format     : FormatKnowledge (Reference ⊕ Learned overlay is fine)
 *   payload    : array of source product objects (or a single object)
 *   companions : { variations: { [parentId]: [...] } | [...], categories: [...] }
 *   canon      : the canon catalogue (fields.v1.json) — its `derivations` run
 *                after the entries (6.3); absent = no derivation
 * → { products: CanonProduct[], report: { units, variants, unknownKeys, warnings } }
 */
export function parseWithKnowledge(format, payload, { companions = {}, platform, canon, pci = true } = {}) {
  const plat = platform || format.platformHint || format.id.split('.')[0];
  let items = Array.isArray(payload) ? payload : payload ? [payload] : [];
  // 7.7 — the card-data scanner runs on every ingested object BEFORE any entry
  // reads it: a hit never reaches the canon, sourceExtension._raw or unmapped[].
  const pciFindings = [];
  if (pci) {
    const scanned = scanForCardData(items);
    items = scanned.value; pciFindings.push(...scanned.findings);
    const comp = {};
    for (const [k, v] of Object.entries(companions || {})) { const r = scanForCardData(v); comp[k] = r.value; pciFindings.push(...r.findings.map((f) => ({ ...f, path: f.path.startsWith('[') ? `${k}${f.path}` : `${k}.${f.path}` }))); }
    companions = comp;
  }
  // structure.rows.groupBy on a CSV whose variants are its own rows (variants.inlinePath
  // "__rows"): rows sharing the group key become ONE product — the first row is the
  // product, every row is a variant. The row list rides on the item as a
  // non-enumerable property so it never shows up as an unknown column.
  if (format.structure?.rows?.groupBy && format.structure?.variants?.inlinePath === '__rows' && Array.isArray(items)) {
    const rows = items;
    items = unitsOfRows(format.structure.rows, rows).map((u) => {
      const head = { ...rows[u.head] };
      Object.defineProperty(head, '__rows', { value: (u.children.length ? u.children : u.rows).map((i) => rows[i]), enumerable: false });
      return head;
    });
  }
  // structure.rows.include (Phase 2): the units are the source rows matching
  // this data condition (e.g. only WordPress users with the customer role);
  // the others are counted in report.excluded, never silently dropped.
  const include = format.structure?.rows?.include;
  let excluded = 0;
  if (include) { const kept = items.filter((it) => rowMatches(it, include)); excluded = items.length - kept.length; items = kept; }
  if (format.entity === 'orders' || format.entity === 'customers') {
    const r = parseEntities(format, items, { companions, plat, canon, pciFindings, entity: format.entity });
    if (excluded) r.report.excluded = excluded;
    return r;
  }
  const entries = format.fields || [];
  const productEntries = entries.filter((e) => scopeOf(e) === 'product');
  const variantEntries = entries.filter((e) => scopeOf(e) === 'variant');
  const consumedProduct = consumedKeys(productEntries);
  const consumedVariant = consumedKeys(variantEntries);
  const structure = format.structure || {};
  const unknownKeys = new Set();
  const warnings = [];
  const products = [];

  // structure.variants.siblingsWhen = { childPath, matches }: a "variant" whose
  // childPath value is the identifier (matches path) of ANY unit in the payload
  // is a SIBLING product (a colourway listed on each family member), not a
  // variant → merchandising.related, never a duplicate variant.
  const sw = structure?.variants?.siblingsWhen;
  const unitIds = sw ? new Set(items.map((u) => String(getPath(u, sw.matches) ?? '')).filter(Boolean)) : null;

  for (const src of items) {
    const product = PRODUCT_DEFAULTS();
    const ext = {};
    const unmapped = [];
    const trace = {};
    const ctx = { format, platform: plat, source: src, parent: null, product, companions, unmapped, ext, args: undefined, field: null };
    for (const e of productEntries) { ctx.args = e.args; ctx.field = e; applyEntry(e, product, ctx, trace); }
    mergeDescriptionSections(product, trace, plat);
    mergeAppendedLists(product, trace);

    // ── variants ──
    let kids = variantsOf(src, structure, companions);
    let siblingsConsumed = false;
    if (sw && kids.length) {
      const own = String(getPath(src, sw.matches) ?? '');
      const codeOf = (k) => String(getPath(k, sw.childPath) ?? '');
      // A list that contains the unit ITSELF is a list of peers (colourways of
      // the family): every entry is a sibling. Otherwise only entries that are
      // other units of the payload are siblings.
      const containsSelf = own && kids.some((k) => codeOf(k) === own);
      // Peers are the entries of the same kind as the unit's own entry (its colourways): the sizes listed beside
      // them (another type) stay this unit's variants.
      const typePath = structure?.options?.fromVariants?.name || 'type';
      const typeOf = (k) => String(getPath(k, typePath) ?? '');
      const selfType = containsSelf ? typeOf(kids.find((k) => codeOf(k) === own)) : '';
      // A list that holds the unit's own code is a list of PEER PAGES only when its entries are colours, or most of
      // them lead to another page. A size list whose first size carries the page's reference (ICI Paris XL: the
      // product id is the 30 ml code) is the unit's own variants: never turned into sibling products.
      // The same page with a selection parameter (« ?varSel=1430015 »), or written without its language segment
      // (« /fr/… » and « /… »), is not another page: a page is its host and the last segment of its path.
      const pageOf = (u) => { try { const x = new URL(String(u ?? '')); const segs = x.pathname.split('/').filter(Boolean); return `${x.hostname.replace(/^www\./, '')}/${(segs[segs.length - 1] || '').toLowerCase()}`; } catch { return ''; } };
      const ownUrl = pageOf(getPath(src, 'source_url') ?? getPath(src, 'url'));
      const elsewhere = kids.filter((k) => { const u = pageOf(getPath(k, 'url')); return u && u !== ownUrl; }).length;
      const peers = containsSelf && (/^(couleur|coloris|colou?rs?|kleur|farbe|colorway|colourway)$/i.test(selfType) || elsewhere * 2 >= kids.length);
      const siblings = peers ? kids.filter((k) => !selfType || typeOf(k) === selfType || unitIds.has(codeOf(k))) : kids.filter((k) => codeOf(k) !== own && unitIds.has(codeOf(k)));
      if (siblings.length) {
        siblingsConsumed = siblings.length === kids.length;
        kids = kids.filter((k) => !siblings.includes(k));
        const related = siblings.map((k) => String(getPath(k, sw.childPath))).filter((c) => c && c !== own);
        if (related.length) {
          product.merchandising = product.merchandising || {};
          product.merchandising.related = [...new Set([...(product.merchandising.related || []), ...related])];
          trace['merchandising.related'] = { platform: plat, sourceField: structure.variants.inlinePath || structure.variants.companion || 'variants', transform: 'siblings', method: 'structural', note: 'children whose ' + sw.childPath + ' is a unit id are sibling products' };
        }
        ext.siblings = siblings.map((k) => Object.fromEntries(Object.entries(k).filter(([key]) => key !== sw.childPath || true)));
      }
    }
    let declared = structure?.variants?.inlinePath ? getPath(src, structure.variants.inlinePath) : undefined;
    if (typeof declared === 'string') { try { declared = JSON.parse(declared); } catch { declared = undefined; } }
    if (!kids.length && !siblingsConsumed && Array.isArray(declared) && declared.length) {
      warnings.push({ code: 'variants_missing_companion', unit: String(getPath(src, structure?.variants?.keyedBy || 'id')), expected: declared.length });
    }
    const selfVariant = !kids.length && (structure?.variants?.selfWhenNone ?? true);
    const variantSources = kids.length ? kids : selfVariant ? [src] : [];
    if (kids.length && structure?.options?.fromVariants && !product.options.length) {
      product.options = optionsFromVariants(kids, structure.options.fromVariants);
      if (product.options.length) trace.options = { platform: plat, sourceField: structure.variants.inlinePath || structure.variants.companion || 'variants', transform: 'options_from_variants', method: 'structural' };
    }
    // On the self-variant, product-scope entries already consumed the keys;
    // variant entries read the SAME object, so nothing is "unknown" twice.
    // With structure.variants.sameEntity (variants are products: Shopware),
    // the same holds for real children.
    const allConsumed = new Set([...consumedProduct, ...consumedVariant]);
    allConsumed.patterns = [...consumedProduct.patterns, ...consumedVariant.patterns];
    const consumedForChild = structure?.variants?.sameEntity ? allConsumed : consumedVariant;
    product.variants = variantSources.map((vs) => {
      const variant = VARIANT_DEFAULTS();
      const vext = {}; const vunmapped = []; const vtrace = {};
      const vctx = { format, platform: plat, source: vs, parent: vs === src ? null : src, product, companions, unmapped: vunmapped, ext: vext, args: undefined, field: null };
      for (const e of variantEntries) { vctx.args = e.args; vctx.field = e; applyEntry(e, variant, vctx, vtrace); }
      if (vs !== src) {
        preserveUnknown(vs, consumedForChild, plat, vext, vunmapped);
        for (const u of vunmapped) if (u.reason === 'unknown') unknownKeys.add('variant:' + u.sourceField);
      }
      if (Object.keys(vext).length) variant.sourceExtension = { [plat]: vext };
      if (vunmapped.length) variant.unmapped = vunmapped;
      if (Object.keys(vtrace).length) variant.provenance = vtrace;
      return variant;
    });

    // Canon hygiene: a product needs a non-empty handle (grouping key, URL).
    // Same fallback as the CSV parsers: sku, else a slug of the title.
    if (!product.handle) {
      // A product with several variants is not named after one variant's SKU: its group
      // key (parent id of a one-row-per-variant file), else its title.
      const several = product.variants.length > 1;
      const groupKey = several ? String(src[structure?.rows?.groupBy?.column] ?? '').trim() : '';
      const basis = groupKey || (several ? product.title : (product.variants[0]?.sku || product.title));
      product.handle = slugify(basis || 'product');
      trace.handle = { platform: plat, sourceField: groupKey ? structure.rows.groupBy.column : (!several && product.variants[0]?.sku) ? 'sku' : 'title', transform: 'slugify', method: 'default' };
    }
    preserveUnknown(src, allConsumed, plat, ext, unmapped);
    if (structure.preserveNested) preserveNestedUnknown(src, entries, structure.preserveNested, plat, ext, unmapped);
    if (structure.customColumns) customColumnsOf(src, entries, structure.customColumns, product);
    for (const u of unmapped) if (u.reason === 'unknown') unknownKeys.add(u.sourceField);
    if (Object.keys(ext).length) product.sourceExtension = { [plat]: ext };
    if (unmapped.length) product.unmapped = unmapped;
    if (Object.keys(trace).length) product.provenance = trace;
    products.push(product);
  }

  if (canon) applyCanonDerivations(products, canon);
  if (pciFindings.length) warnings.push({ code: 'pci_card_data_stripped', count: pciFindings.length, kinds: [...new Set(pciFindings.map((f) => f.kind))].sort() });
  return { products, report: { units: items.length, variants: products.reduce((a, p) => a + p.variants.length, 0), unknownKeys: [...unknownKeys].sort(), warnings, ...(pciFindings.length ? { pciFindings } : {}), ...(excluded ? { excluded } : {}) } };
}

/**
 * Phase 7.2 — orders / customers through the same knowledge-driven loop.
 *   unit entries (scope 'product' by default) → CanonOrder / CanonCustomer
 *   item entries (scope 'item' or canon 'items[].…') → CanonOrderLineItem[]
 *     from structure.items (inline array or companion keyed by the order id)
 *   lineItems[] (the pre-Phase-7 simple view) is derived from items[] when
 *     no entry filled it; canon derivations of scope 'order' / 'customer'
 *     (fields.v1.json) then fill the flat legacy fields from the typed blocks.
 * Same guarantees as products: consumed / preserved / listed, provenance.
 */
function parseEntities(format, items, { companions, plat, canon, pciFindings, entity }) {
  const entries = format.fields || [];
  const unitEntries = entries.filter((e) => scopeOf(e) !== 'item');
  const itemEntries = entries.filter((e) => scopeOf(e) === 'item');
  const consumedUnit = consumedKeys(unitEntries);
  const consumedItem = consumedKeys(itemEntries);
  const structure = format.structure || {};
  if (structure.items?.inlinePath) consumedUnit.add(String(structure.items.inlinePath).split('.')[0]); // the line array is consumed by the item scope
  const unknownKeys = new Set();
  const warnings = [];
  const units = [];
  for (const src of items) {
    const unit = entity === 'orders' ? ORDER_DEFAULTS() : CUSTOMER_DEFAULTS();
    const ext = {}; const unmapped = []; const trace = {};
    const ctx = { format, platform: plat, source: src, parent: null, product: unit, companions, unmapped, ext, args: undefined, field: null };
    for (const e of unitEntries) { ctx.args = e.args; ctx.field = e; applyEntry(e, unit, ctx, trace); }
    if (entity === 'orders' && structure.items) {
      const kids = childrenOf(src, structure.items, companions);
      const lines = kids.map((ks) => {
        const item = ITEM_DEFAULTS();
        const iext = {}; const iunmapped = []; const itrace = {};
        const ictx = { format, platform: plat, source: ks, parent: src, product: unit, companions, unmapped: iunmapped, ext: iext, args: undefined, field: null };
        for (const e of itemEntries) { ictx.args = e.args; ictx.field = e; applyEntry(e, item, ictx, itrace); }
        preserveUnknown(ks, consumedItem, plat, iext, iunmapped);
        for (const u of iunmapped) if (u.reason === 'unknown') unknownKeys.add('item:' + u.sourceField);
        if (Object.keys(iext).length) item.sourceExtension = { [plat]: iext };
        if (iunmapped.length) item.unmapped = iunmapped;
        if (Object.keys(itrace).length) item.provenance = itrace;
        return item;
      });
      if (lines.length) {
        unit.items = lines;
        trace.items = { platform: plat, sourceField: structure.items.inlinePath || structure.items.companion || 'items', transform: 'items', method: 'structural' };
        if (!unit.lineItems.length) {
          unit.lineItems = lines.map((it) => ({ name: it.name, sku: it.sku, quantity: it.quantity, price: it.unitPrice }));
          trace.lineItems = { platform: plat, sourceField: 'items', transform: 'line_items_from_items', method: 'structural' };
        }
      }
    }
    preserveUnknown(src, consumedUnit, plat, ext, unmapped);
    for (const u of unmapped) if (u.reason === 'unknown') unknownKeys.add(u.sourceField);
    if (Object.keys(ext).length) unit.sourceExtension = { [plat]: ext };
    if (unmapped.length) unit.unmapped = unmapped;
    if (Object.keys(trace).length) unit.provenance = trace;
    units.push(unit);
  }
  if (canon) applyCanonDerivations(units, canon, entity);
  if (pciFindings.length) warnings.push({ code: 'pci_card_data_stripped', count: pciFindings.length, kinds: [...new Set(pciFindings.map((f) => f.kind))].sort() });
  return { products: units, report: { units: items.length, variants: 0, items: units.reduce((a, u) => a + (u.items?.length ?? 0), 0), unknownKeys: [...unknownKeys].sort(), warnings, ...(pciFindings.length ? { pciFindings } : {}) } };
}

/** Static check: every transform a format references exists. */
export function validateFormatTransforms(format) {
  const missing = [];
  for (const e of format.fields || []) if (e.transform !== 'ignore' && !hasTransform(e.transform)) missing.push(`${e.path} → ${e.transform}`);
  return missing;
}
