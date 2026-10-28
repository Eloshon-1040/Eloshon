// Phase 5.5 — Transform registry.
// Named, GENERIC value transforms the generic parser applies as instructed by
// a FormatKnowledge field entry (`transform` + `args` + `inputs`). Nothing in
// here knows a platform: WooCommerce's `publish → active` lives in the JSON
// entry as an `enum_map`, not as a branch here.
//
// Signature: (value, ctx) => result
//   value : the source value at `path` (or [v1, v2, …] when `inputs` is set)
//   ctx   : { args, source, parent, product, companions, field, platform }
//           source  = the scope object (product or variation)
//           parent  = the source product when scope is a variant (else null)
//           product = the canon product being built (product fields already applied)
// Multi-output transforms return an ARRAY aligned with the `canon` parts
// (`variants[].price + variants[].compareAtPrice`).

import { cleanScalar, stripExcelGuard, parseConsent, stateToCode, numericTokens, parseNumberToken, splitUrlList, looksLikeUrl } from './values.mjs';

const isNil = (v) => v === undefined || v === null || v === '';

/** Tolerant number: the first numeric token of the cell, currency/unit/tax
 *  rate ignored, EU/US separators read (see values.mjs). opts.decimal = the
 *  column's decimal separator when known. */
export function toNumber(v, opts) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const tok = numericTokens(v)[0];
  return tok === undefined ? null : parseNumberToken(tok, opts?.decimal);
}

export function toBool(v, dflt = null) {
  if (typeof v === 'boolean') return v;
  if (v === undefined || v === null || v === '') return dflt;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'oui', 'on', 'vrai'].includes(s)) return true;
  if (['false', '0', 'no', 'n', 'non', 'off', 'faux'].includes(s)) return false;
  return dflt;
}

export function toText(v) { return v === undefined || v === null ? '' : String(v); }

function getPath(obj, path) {
  if (obj === undefined || obj === null) return undefined;
  // A key present VERBATIM wins over dotted traversal: CSV columns may carry
  // dots ("Prix H.T.", "Condition (product.metafields.ns.key)") — 6.5.
  if (typeof obj === 'object' && typeof path === 'string' && path.includes('.') && Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
  let cur = obj;
  for (const seg of String(path).split('.')) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** ISO 8601 UTC when the value CARRIES its zone (Z / ±hh:mm / RFC 2822 zone).
 *  A value without a zone designator is kept VERBATIM — its zone is unknown
 *  and is never inferred (B1). The only exception is an entry that states
 *  `args.assumeUtc: true` because the FIELD itself is defined as UTC
 *  (WooCommerce *_gmt): that is an established fact, not a guess. */
export function hasZone(v) { return /Z$|[+-]\d{2}:?\d{2}$/.test(String(v ?? '').trim()); }
function toIsoDate(v, args = {}) {
  if (isNil(v)) return null;
  const s = String(v).trim();
  if (/^0000-00-00/.test(s)) return null; // MySQL zero date = "not set" (PrestaShop delivery_date, invoice_date…)
  if (hasZone(s)) { const d = new Date(s); return isNaN(d) ? s : d.toISOString(); }
  if (args.assumeUtc === true) { const d = new Date(s + 'Z'); return isNaN(d) ? s : d.toISOString(); }
  return s;
}

/** Phase 7 — resolve a value against a companion collection: the record(s)
 *  whose args.key equals the value (string compare). { in, key, multiple, where }.
 *  Optional `where` filters candidates by additional field equalities (compound
 *  keys: PrestaShop stock_availables { id_product, id_product_attribute }). */
function lookupIn(value, spec, companions) {
  if (!spec || !spec.in || isNil(value)) return spec?.multiple ? [] : undefined;
  const coll = companions?.[spec.in];
  if (!Array.isArray(coll)) return spec.multiple ? [] : undefined;
  const key = spec.key ?? 'id';
  const want = String(value);
  let hits = coll.filter((r) => r && typeof r === 'object' && String(getPath(r, key) ?? '') === want);
  if (spec.where) {
    hits = hits.filter((r) => Object.entries(spec.where).every(([k, val]) => String(getPath(r, k) ?? '') === String(val)));
  }
  return spec.multiple ? hits : hits[0];
}
/** PrestaShop-style multilingual field [{ id, value }] → the first value. */
function firstLangValue(v, valuePath = 'value') {
  if (Array.isArray(v)) return v.length ? getPath(v[0], valuePath) : undefined;
  return v;
}

/** Phase 7 — object_map / objects_map core: read args.fields off a source
 *  object into a canon object. A field spec is a path string or
 *  { path, as, map, default, value, join, fields (nested object_map),
 *  items (nested objects_map) }. Nil results are omitted; an object with
 *  nothing in it is undefined. */
function buildObject(src, args, ctx) {
  const specs = args?.fields || {};
  const out = {};
  let any = false;
  const put = (key, val) => {
    if (val === undefined || val === null || val === '' || (Array.isArray(val) && !val.length)) return;
    const segs = key.split('.'); let cur = out;
    for (let i = 0; i < segs.length - 1; i++) cur = cur[segs[i]] = cur[segs[i]] || {};
    cur[segs[segs.length - 1]] = val; any = true;
  };
  for (const [key, spec] of Object.entries(specs)) {
    const sp = typeof spec === 'string' ? { path: spec } : (spec || {});
    if (Object.prototype.hasOwnProperty.call(sp, 'value')) { put(key, sp.value); continue; }
    if (Array.isArray(sp.join)) { put(key, sp.join.map((pth) => toText(getPath(src, pth)).trim()).filter(Boolean).join(sp.sep ?? ' ')); continue; }
    if (Array.isArray(sp.paths)) { put(key, sp.paths.map((pth) => toText(getPath(src, pth)).trim()).filter(Boolean)); continue; }
    let raw = sp.path === '.' || sp.path === undefined ? src : getPath(src, sp.path);
    // ref: { in, key, pick } — resolve the raw value through a companion collection
    if (sp.ref && !isNil(raw)) { const hit = lookupIn(raw, sp.ref, ctx?.companions); raw = hit === undefined ? undefined : sp.ref.pick ? firstLangValue(getPath(hit, sp.ref.pick)) : hit; }
    if (sp.as === 'presence') { put(key, isNil(raw) || raw === false || raw === 0 ? sp.else : sp.then ?? true); continue; }
    if (sp.as === 'first_value') { put(key, toText(firstLangValue(raw, sp.valuePath)).trim()); continue; }
    if (sp.skipZero && toNumber(raw) === 0) continue;
    const as = sp.as ?? 'text';
    let val;
    if (raw === undefined || raw === null) val = sp.default;
    else if (as === 'number') val = toNumber(raw);
    else if (as === 'int') { const n = toNumber(raw); val = n === null ? null : Math.trunc(n); }
    else if (as === 'bool') val = toBool(raw, sp.default ?? null);
    else if (as === 'date') val = toIsoDate(raw, sp);
    else if (as === 'map') { const k = typeof raw === 'boolean' ? String(raw) : String(raw); val = sp.map && Object.prototype.hasOwnProperty.call(sp.map, k) ? sp.map[k] : sp.default; }
    else if (as === 'raw') val = raw;
    else if (as === 'object') val = buildObject(raw, { fields: sp.fields }, ctx);
    else if (as === 'objects') val = Array.isArray(raw) ? raw.map((o) => buildObject(o, { fields: sp.fields }, ctx)).filter((o) => o !== undefined) : undefined;
    else if (as === 'texts') val = Array.isArray(raw) ? raw.map(toText).filter(Boolean) : [toText(raw)].filter(Boolean);
    else val = toText(raw).trim();
    if (val === null && sp.keepNull) { out[key] = null; any = true; continue; }
    put(key, val);
  }
  return any ? out : undefined;
}

// Canonical measure symbols for a price per unit ("Prix au kilo", "price per litre").
const MEASURE_SYMBOL = {
  kg: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg', kilogramme: 'kg', kilogrammes: 'kg',
  g: 'g', gr: 'g', gram: 'g', grams: 'g', gramme: 'g', grammes: 'g',
  l: 'l', lt: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l', ml: 'ml', cl: 'cl',
  m: 'm', m2: 'm2', piece: 'unit', pieces: 'unit', pcs: 'unit', unit: 'unit', units: 'unit', unite: 'unit', stuk: 'unit', stuks: 'unit',
};
const CURRENCY_SYMBOL = { '€': 'EUR', '$': 'USD', '£': 'GBP', 'us$': 'USD', 'eur': 'EUR', 'usd': 'USD', 'gbp': 'GBP' };

const WEIGHT_TO_GRAMS = {
  g: 1, gr: 1, gram: 1, grams: 1, gramme: 1, grammes: 1, mg: 0.001,
  kg: 1000, kilo: 1000, kilos: 1000, kilogram: 1000, kilograms: 1000, kilogramme: 1000, kilogrammes: 1000,
  lbs: 453.59237, lb: 453.59237, pound: 453.59237, pounds: 453.59237, oz: 28.349523125, ounce: 28.349523125, ounces: 28.349523125,
};
const LENGTH_TO_CM = { cm: 1, mm: 0.1, m: 100, in: 2.54, yd: 91.44 };
// A unit written IN the cell ("500 g", "1,2 kg") wins over the column's unit.
const WEIGHT_UNIT_IN_CELL = /\d\s*(kg|kilos?|kilogrammes?|kilograms?|grammes?|grams?|gr|g|mg|lbs?|pounds?|oz|ounces?)\.?\s*$/i;
const LENGTH_UNIT_IN_CELL = /\d\s*(mm|cm|m|in)\.?\s*$/i;

export const TRANSFORMS = {
  copy: (v) => v,
  ignore: () => undefined,
  text: (v) => toText(v).trim(),
  html: (v) => toText(v),
  // args.decimal: the column's decimal separator, decided on all its values at learn time
  int: (v, { args }) => { const n = toNumber(v, args); return n === null ? null : Math.trunc(n); },
  float: (v, { args }) => toNumber(v, args),
  money: (v, { args }) => toNumber(v, args),
  bool: (v, { args }) => toBool(v, args?.default ?? null),
  bool_not: (v, { args }) => { const b = toBool(v, null); return b === null ? (args?.default ?? null) : !b; },
  string_id: (v) => (isNil(v) ? '' : String(v)),
  ids_to_strings: (v) => (Array.isArray(v) ? v.map((x) => String(x)) : []),
  /** args.map: { sourceValue: target }, args.default: fallback (may be undefined → skip). */
  enum_map: (v, { args }) => {
    const key = isNil(v) ? '' : String(v);
    if (args?.map && Object.prototype.hasOwnProperty.call(args.map, key)) return args.map[key];
    return args?.default;
  },
  date_iso: (v, { args }) => toIsoDate(v, args),
  list: (v, { args }) => (Array.isArray(v) ? v.map(toText) : toText(v).split(args?.sep ?? ',').map((s) => s.trim()).filter(Boolean)),
  /** array of objects → array of obj[args.key] */
  names_of: (v, { args }) => (Array.isArray(v) ? v.map((o) => toText(getPath(o, args?.key ?? 'name'))).filter(Boolean) : []),
  first: (v) => (Array.isArray(v) ? v[0] : v),
  /** number (unit from args.unit) or an object { value, unit } whose unit is
   *  read per value (args.valuePath / args.unitPath, default value/unit) —
   *  Shopify measures weight per VARIANT (GRAMS on one, KILOGRAMS on another). */
  weight_to_grams: (v, { args }) => {
    let unit = args?.unit || 'kg';
    if (v && typeof v === 'object' && !Array.isArray(v)) { const u = getPath(v, args?.unitPath ?? 'unit'); if (!isNil(u)) unit = String(u); v = getPath(v, args?.valuePath ?? 'value'); }
    const inCell = typeof v === 'string' ? v.match(WEIGHT_UNIT_IN_CELL) : null;
    if (inCell) unit = inCell[1];
    const n = toNumber(v, args); if (n === null) return null;
    const f = WEIGHT_TO_GRAMS[unit.toLowerCase()] ?? WEIGHT_TO_GRAMS[(args?.unit || 'kg').toLowerCase()] ?? 1000;
    return Math.round(n * f);
  },
  length_to_cm: (v, { args }) => {
    let unit = args?.unit || 'cm';
    const inCell = typeof v === 'string' ? v.match(LENGTH_UNIT_IN_CELL) : null;
    if (inCell) unit = inCell[1];
    const n = toNumber(v, args); if (n === null) return null;
    const f = LENGTH_TO_CM[unit.toLowerCase()] ?? LENGTH_TO_CM[(args?.unit || 'cm').toLowerCase()] ?? 1;
    return Math.round(n * f * 1000) / 1000;
  },

  /** images: array of objects → CanonImage[] (args: src, alt, id, position, width, height) */
  images_from_objects: (v, { args }) => {
    const a = { src: 'src', alt: 'alt', id: 'id', position: 'position', ...(args || {}) };
    if (v && !Array.isArray(v) && typeof v === 'object') v = [v];
    if (!Array.isArray(v)) return [];
    if (a.sortBy) v = [...v].sort((x, y) => (toNumber(getPath(x, a.sortBy)) ?? 0) - (toNumber(getPath(y, a.sortBy)) ?? 0));
    return v.map((o, i) => {
      const img = { src: toText(getPath(o, a.src)), position: i + 1, alt: toText(getPath(o, a.alt)) };
      const id = getPath(o, a.id); if (!isNil(id)) img.id = id;
      const w = toNumber(getPath(o, a.width)); if (w !== null) img.width = w;
      const h = toNumber(getPath(o, a.height)); if (h !== null) img.height = h;
      return img;
    }).filter((img) => img.src);
  },

  /** attributes: array of objects → CanonAttribute[] (all attributes, variation or not) */
  attributes_rich: (v, { args }) => {
    const a = { name: 'name', values: 'options', visible: 'visible', forVariation: 'variation', position: 'position', ...(args || {}) };
    if (!Array.isArray(v)) return [];
    return v.map((o) => {
      const vals = getPath(o, a.values);
      const out = { name: toText(getPath(o, a.name)), values: Array.isArray(vals) ? vals.map(toText) : isNil(vals) ? [] : [toText(vals)] };
      const pos = toNumber(getPath(o, a.position)); if (pos !== null) out.position = pos;
      const vis = toBool(getPath(o, a.visible), null); if (vis !== null) out.visible = vis;
      const fv = toBool(getPath(o, a.forVariation), null); if (fv !== null) out.forVariation = fv;
      return out;
    }).filter((x) => x.name);
  },

  /** attributes → options[] (axis of variation only: args.when = key that must be truthy) */
  options_from_attributes: (v, { args }) => {
    const a = { name: 'name', values: 'options', when: 'variation', ...(args || {}) };
    if (!Array.isArray(v)) return [];
    // args.dropIfValuesIn: an axis whose EVERY value is a sentinel is not an
    // axis (Shopify encodes "no variants" as Title = Default Title).
    const sentinels = new Set(Array.isArray(a.dropIfValuesIn) ? a.dropIfValuesIn : []);
    return v.filter((o) => (a.when ? toBool(getPath(o, a.when), false) : true))
      .map((o) => { const vals = getPath(o, a.values); return { name: toText(getPath(o, a.name)), values: Array.isArray(vals) ? vals.map(toText) : [] }; })
      .filter((o) => o.name && o.values.length && !(sentinels.size && o.values.every((x) => sentinels.has(x))));
  },

  /** variation attributes → optionValues aligned with the canon product's options order */
  option_values_from_attributes: (v, { args, product }) => {
    const a = { name: 'name', value: 'option', ...(args || {}) };
    const byName = new Map();
    for (const o of Array.isArray(v) ? v : []) byName.set(toText(getPath(o, a.name)).toLowerCase(), toText(getPath(o, a.value)));
    return (product?.options || []).map((opt) => byName.get(opt.name.toLowerCase()) ?? '');
  },

  /** VAT as a percent: 21, 6, 5.5. A fraction (0.21) is read as 21 %; "21%" and "21 %" too.
   *  Anything outside 0-100 is not a rate. */
  vat_rate: (v, { args }) => {
    const n = toNumber(v, args);
    if (n === null) return undefined; // no rate: the field stays absent
    const pct = n > 0 && n < 1 ? Math.round(n * 10000) / 100 : n;
    return pct >= 0 && pct <= 100 ? pct : undefined;
  },
  /** ISO 4217 code from a code or a symbol ("EUR", "eur", "€"); null when it is neither. */
  currency: (v) => {
    const s = toText(v).trim();
    if (!s) return undefined;
    const mapped = CURRENCY_SYMBOL[s.toLowerCase()];
    if (mapped) return mapped;
    return /^[A-Za-z]{3}$/.test(s) ? s.toUpperCase() : undefined;
  },
  /** A price per unit of measure → { amount, per, unit }. The unit is the column's
   *  (args.unit, from "Prix au kilo"), or written in the cell: "12,99 € / kg",
   *  "4,50 / 100 g". */
  unit_price: (v, { args }) => {
    const amount = toNumber(v, args);
    if (amount === null) return undefined;
    let per = 1;
    let unit = MEASURE_SYMBOL[String(args?.unit ?? 'kg').toLowerCase()] ?? String(args?.unit ?? 'kg');
    const cell = typeof v === 'string' ? v.match(/\/\s*(\d+(?:[.,]\d+)?)?\s*([A-Za-zµ²]+)\.?\s*$/) : null;
    if (cell && MEASURE_SYMBOL[cell[2].toLowerCase()]) {
      unit = MEASURE_SYMBOL[cell[2].toLowerCase()];
      if (cell[1]) per = toNumber(cell[1]) || 1;
    }
    return { amount, per, unit };
  },

  /** CSV with one ROW per variant: the option axes are COLUMNS (the header is the
   *  option name). inputs = those cells, args.names = their headers; the result is
   *  aligned with the options the product already carries. */
  option_values_from_columns: (v, { args, product }) => {
    const names = Array.isArray(args?.names) ? args.names : [];
    const cells = Array.isArray(v) ? v : [v];
    const byName = new Map(names.map((n, i) => [String(n).toLowerCase(), toText(cells[i]).trim()]));
    return (product?.options || []).map((opt) => byName.get(opt.name.toLowerCase()) ?? '');
  },

  /** default_attributes → { optionName: value } */
  default_option_values: (v, { args }) => {
    const a = { name: 'name', value: 'option', ...(args || {}) };
    const out = {};
    for (const o of Array.isArray(v) ? v : []) { const n = toText(getPath(o, a.name)); if (n) out[n] = toText(getPath(o, a.value)); }
    return Object.keys(out).length ? out : undefined;
  },

  /** category terms → hierarchy paths "Root > … > Leaf", ancestors subsumed.
   *  args.lookup names a companion collection ({id, name, parent}) used to
   *  climb the tree; without it, terms are emitted flat. */
  category_paths_from_terms: (v, { args, companions }) => {
    const a = { name: 'name', id: 'id', lookup: 'categories', lookupId: 'id', lookupName: 'name', lookupParent: 'parent', ...(args || {}) };
    if (!Array.isArray(v)) return [];
    const lookup = a.lookup ? companions?.[a.lookup] : null;
    if (!Array.isArray(lookup) || !lookup.length) return v.map((t) => toText(getPath(t, a.name))).filter(Boolean);
    const byId = new Map(lookup.map((c) => [String(getPath(c, a.lookupId)), c]));
    const pathOf = (id) => {
      const segs = []; let cur = byId.get(String(id)); let guard = 0;
      while (cur && guard++ < 32) { segs.unshift(toText(getPath(cur, a.lookupName))); const p = getPath(cur, a.lookupParent); cur = isNil(p) || String(p) === '0' ? null : byId.get(String(p)); }
      return segs;
    };
    const paths = v.map((t) => { const id = getPath(t, a.id); const segs = byId.has(String(id)) ? pathOf(id) : [toText(getPath(t, a.name))]; return segs.filter(Boolean).join(' > '); }).filter(Boolean);
    // drop a path that is a strict prefix of another (an ancestor listed alongside its leaf)
    return paths.filter((p, i) => !paths.some((q, j) => j !== i && q !== p && q.startsWith(p + ' > ')))
      .filter((p, i, arr) => arr.indexOf(p) === i);
  },

  /** inputs [regular, sale, on_sale?] → [price (charged), compareAtPrice ("was")] */
  price_promo: (v, ctx) => {
    const [regular, sale, onSale] = Array.isArray(v) ? v : [v];
    const r = toNumber(regular), s = toNumber(sale);
    const active = s !== null && r !== null && s < r && (onSale === undefined ? true : toBool(onSale, true) !== false);
    if (active) return [s, r];
    // args.noSaleFallback: without a regular price the price is unknown (a lone sale price is not a price)
    if (ctx?.args?.noSaleFallback) return [r, null];
    return [r !== null ? r : s, null];
  },
  /** inputs [from, to] → CanonSalePeriod | undefined */
  sale_period: (v, { args }) => {
    const [from, to] = Array.isArray(v) ? v : [v];
    const f = toIsoDate(from, args), t = toIsoDate(to, args);
    return f || t ? { from: f ?? null, to: t ?? null } : undefined;
  },
  /** inputs [manage, backorders, soldIndividually] → CanonStockPolicy. A
   *  `parent` literal (WC variations) inherits from the parent object via
   *  args.parentPath. */
  stock_policy: (v, { args, parent }) => {
    let [manage, back, sold] = Array.isArray(v) ? v : [v];
    if (manage === 'parent' && parent) manage = getPath(parent, args?.parentPath || 'manage_stock');
    const out = {};
    const m = toBool(manage, null); if (m !== null) out.manageStock = m;
    if (!isNil(back)) { const b = String(back).toLowerCase(); if (['no', 'notify', 'yes'].includes(b)) out.backorders = b; }
    const s = toBool(sold, null); if (s !== null) out.soldIndividually = s;
    return Object.keys(out).length ? out : undefined;
  },
  /** inputs [created, modified] → { created, modified } */
  timestamps: (v, { args }) => {
    const [c, m] = Array.isArray(v) ? v : [v];
    const out = {}; const ci = toIsoDate(c, args), mi = toIsoDate(m, args);
    if (ci) out.created = ci; if (mi) out.modified = mi;
    return Object.keys(out).length ? out : undefined;
  },
  /** downloads: array → CanonDownload[] */
  downloads: (v, { args }) => {
    const a = { name: 'name', file: 'file', ...(args || {}) };
    if (!Array.isArray(v) || !v.length) return undefined;
    return v.map((o) => ({ name: toText(getPath(o, a.name)), file: toText(getPath(o, a.file)) }));
  },
  /** meta_data: array of {key, value} → metafields[] (args.hiddenPrefix skips internal keys).
   *  Phase 6.3 (P2): args.namespace / args.type name the source paths of the
   *  namespace and the declared type (kept VERBATIM, absent when the source has
   *  none); args.drop = ['ns.key', …] CONSUMES pairs that another canon field
   *  already carries (Shopify `global.title_tag` is `seo.title`). */
  metafields_from_pairs: (v, { args }) => {
    const a = { key: 'key', value: 'value', hiddenPrefix: '_', ...(args || {}) };
    if (!Array.isArray(v)) return [];
    const drop = new Set(Array.isArray(a.drop) ? a.drop : []);
    return v.map((o) => {
      const m = { key: toText(getPath(o, a.key)), value: typeof getPath(o, a.value) === 'string' ? getPath(o, a.value) : JSON.stringify(getPath(o, a.value) ?? '') };
      if (a.namespace) { const ns = getPath(o, a.namespace); if (!isNil(ns)) m.namespace = toText(ns); }
      if (a.type) { const t = getPath(o, a.type); if (!isNil(t)) m.type = toText(t); }
      return m;
    }).filter((m) => m.key && !(a.hiddenPrefix && m.key.startsWith(a.hiddenPrefix)) && !drop.has(m.namespace ? `${m.namespace}.${m.key}` : m.key));
  },
  /** array of objects → obj[args.key] of the FIRST element (string) */
  name_of_first: (v, { args }) => (Array.isArray(v) && v.length ? toText(getPath(v[0], args?.key ?? 'name')) : ''),
  /** single image object → src */
  image_src: (v, { args }) => (v && typeof v === 'object' ? toText(getPath(v, args?.src ?? 'src')) : ''),
  /** array of image objects → first src */
  first_image_src: (v, { args }) => (Array.isArray(v) && v.length ? toText(getPath(v[0], args?.src ?? 'src')) : ''),
  /** sentinel (args.nullWhen) → null, else the value (as string when args.asString) */
  sentinel_to_null: (v, { args }) => { if (isNil(v)) return null; const n = toNumber(v); const hit = Array.isArray(args?.nullWhen) ? args.nullWhen.includes(n) : n === args?.nullWhen; if (hit) return null; return args?.asString ? String(v) : v; },
  /** JSON text → value (CSV cells carrying structures) */
  json_parse: (v) => { if (typeof v !== 'string') return v; const s = v.trim(); if (!s) return undefined; try { return JSON.parse(s); } catch { return undefined; } },
  /** value only when it differs from the value at args.other (multilingual duplicates) */
  differs_from: (v, { args, source }) => { if (isNil(v)) return undefined; const o = getPath(source, args?.other); return String(v) === String(o ?? '') ? undefined : v; },
  /** scalar → [{ key: args.key ?? path, value, namespace?: args.namespace }] for `metafields[]` */
  metafield_pair: (v, { args, field }) => (isNil(v) ? undefined : [{ key: args?.key ?? field?.path ?? 'value', value: toText(v), ...(args?.namespace ? { namespace: args.namespace } : {}) }]),
  /** Technical sheet / features → { label, html } for `descriptionSections[]`
   *  (the generic parser appends every section to bodyHtml). A JSON object
   *  `{"Poids":"450 g"}` or a list becomes an HTML list; text stays one block
   *  (line breaks kept) and is never cut into attributes. label = args.label,
   *  else the source column. */
  description_section: (v, { args, field }) => {
    if (isNil(v)) return undefined;
    let val = v;
    if (typeof val === 'string' && /^\s*[[{]/.test(val)) { try { val = JSON.parse(val); } catch { /* plain text */ } }
    // « Résolution : Full HD ; Taille : 55 » (args.pairSep / args.kv): name → value pairs, when every piece is one.
    if (typeof val === 'string' && args?.pairSep) {
      const kv = args.kv ?? ' : ';
      const pieces = val.split(args.pairSep).map((x) => x.trim()).filter(Boolean);
      if (pieces.length && pieces.every((x) => x.includes(kv))) val = Object.fromEntries(pieces.map((x) => { const i = x.indexOf(kv); return [x.slice(0, i).trim(), x.slice(i + kv.length).trim()]; }));
    }
    const label = toText(args?.label ?? field?.path ?? '').trim();
    const esc = (s) => toText(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let body;
    if (Array.isArray(val)) {
      const items = val.map((x) => (x && typeof x === 'object' ? [x.name ?? x.key ?? x.label, x.value ?? x.values] : [null, x])).filter(([, x]) => !isNil(x));
      if (!items.length) return undefined;
      body = `<ul>${items.map(([k, x]) => `<li>${k ? `<strong>${esc(k)}</strong> : ` : ''}${esc(Array.isArray(x) ? x.join(', ') : x)}</li>`).join('')}</ul>`;
    } else if (val && typeof val === 'object') {
      const items = Object.entries(val).filter(([, x]) => !isNil(x));
      if (!items.length) return undefined;
      body = `<ul>${items.map(([k, x]) => `<li><strong>${esc(k)}</strong> : ${esc(Array.isArray(x) ? x.join(', ') : typeof x === 'object' ? JSON.stringify(x) : x)}</li>`).join('')}</ul>`;
    } else {
      const text = toText(val).trim();
      if (!text) return undefined;
      // Already HTML only when it holds real markup tags; `<cuir>` in a text is data.
      body = /<\/?(p|br|ul|ol|li|div|span|strong|b|em|i|h[1-6]|table|tr|td|th|dl|dt|dd)\b[^>]*>/i.test(text) ? text : `<p>${esc(text).replace(/\r?\n/g, '<br>')}</p>`;
    }
    return [{ label, html: `${label ? `<h3>${esc(label)}</h3>` : ''}${body}` }];
  },
  /** scalar → [{ name: args.name, values: [v], forVariation: false }] for `attributesRich[]` */
  attribute_single: (v, { args }) => (isNil(v) ? undefined : [{ name: args?.name ?? 'attribute', values: [toText(v)], forVariation: false, ...(args?.visible !== undefined ? { visible: !!args.visible } : {}) }]),
  /** URL or separated list of URLs → CanonImage[]. A list is split only before a new URL, on a newline, or on
   *  the declared args.sep between two addresses — NEVER on a bare comma: a CDN path keeps its commas
   *  ("…/c_lpad,w_iw,h_ih/…"). A piece that is not an address is dropped (never written to a target). */
  images_from_urls: (v, { args }) => {
    if (isNil(v)) return [];
    const parts = (Array.isArray(v) ? v.flatMap((x) => (typeof x === 'string' ? splitUrlList(x, args?.sep ?? null) : [toText(x)])) : splitUrlList(toText(v), args?.sep ?? null)).map((s) => s.trim()).filter((s) => s && looksLikeUrl(s));
    const seen = new Set();
    return parts.filter((src) => (seen.has(src) ? false : (seen.add(src), true))).map((src, i) => ({ src, position: i + 1, alt: '' }));
  },
  /** "A > B > C" (and lists of them) → categories[] paths, trimmed/normalised */
  category_path_split: (v, { args }) => {
    if (isNil(v)) return [];
    const listSep = args?.listSep ?? ',';
    const pathSep = args?.sep ?? '>';
    const list = Array.isArray(v) ? v.map(toText) : toText(v).split(listSep).map((s) => s.trim()).filter(Boolean);
    // args.keepEmptySegments: "A > > B" keeps its empty level verbatim (a source's own path)
    if (args?.keepEmptySegments) return list.map((p) => p.split(pathSep).map((s) => s.trim()).join(' > '));
    return list.map((p) => p.split(pathSep).map((s) => s.trim()).filter(Boolean).join(' > ')).filter(Boolean);
  },
  /** bool-ish → tags[] entry (args.tag) when truthy */
  tag_when_true: (v, { args }) => (toBool(v, false) ? [args?.tag ?? 'true'] : undefined),
  /** child value, or the parent's args.parentPath when the child is empty;
   *  then converted with args.as (a registry transform id) + args.asArgs */
  inherit_from_parent: (v, ctx) => {
    const { args, parent } = ctx;
    const raw = isNil(v) && parent ? getPath(parent, args?.parentPath) : v;
    if (isNil(raw)) return undefined;
    const as = args?.as || 'copy';
    return TRANSFORMS[as] ? TRANSFORMS[as](raw, { ...ctx, args: args?.asArgs || {} }) : raw;
  },
  /** variant object with ONE typed option ({ type: 'couleur', name: 'Bleu' })
   *  → optionValues aligned with product.options; inputs = [type, name] or
   *  read from args on the source object */
  option_values_from_typed: (v, { args, source, product }) => {
    const type = toText(getPath(source, args?.name ?? 'type')).toLowerCase();
    const value = toText(getPath(source, args?.value ?? 'name'));
    return (product?.options || []).map((opt) => (opt.name.toLowerCase() === type ? value : ''));
  },
  /** A variant built from axis columns ({ Taille: '28', Couleur: 'Bleu' }): its value on each product option, by name. */
  option_values_by_name: (_v, { source, product }) => (product?.options || []).map((opt) => toText(source?.[opt.name] ?? '').trim()),
  /** a literal value from args.value (anchor path is irrelevant) */
  constant: (_v, { args }) => args?.value,
  /** number comparison → args.then / args.else (undefined = skip) */
  if_gt: (v, { args }) => { const n = toNumber(v); if (n === null) return args?.else; return n > (args?.than ?? 0) ? args?.then : args?.else; },
  /** equality → args.then / args.else (undefined = skip); compares as strings */
  equals_map: (v, { args }) => (isNil(v) ? args?.else : (String(v) === String(args?.value) ? args?.then : args?.else)),
  /** array contains args.includes → args.then, else args.else */
  includes_map: (v, { args }) => (Array.isArray(v) && v.includes(args?.includes) ? args?.then : args?.else),
  /** price arrays [{currencyId, gross, net, listPrice:{…}}] → one number.
   *  args: field ('gross'|'net'), sub ('listPrice'|'regulationPrice' — nested price object), currencyId (default: first) */
  price_pick: (v, { args }) => {
    if (!Array.isArray(v) || !v.length) return null;
    const entry = (args?.currencyId && v.find((x) => x && x.currencyId === args.currencyId)) || v[0];
    const obj = args?.sub ? getPath(entry, args.sub) : entry;
    if (!obj || typeof obj !== 'object') return null;
    return toNumber(getPath(obj, args?.field ?? 'gross'));
  },
  /** array of objects → the args.pick of the first one whose args.where fields all match */
  pick_where: (v, { args }) => {
    if (!Array.isArray(v)) return undefined;
    const where = args?.where || {};
    const hit = v.find((o) => Object.entries(where).every(([k, val]) => getPath(o, k) === val)) ?? (args?.fallbackFirst ? v[0] : undefined);
    return hit ? getPath(hit, args?.pick ?? 'id') : undefined;
  },
  /** plain object {k: v} → metafields[] pairs (args.hiddenPrefix skips keys).
   *  Phase 6.3 (P2): args.sets names a companion collection of typed field
   *  SETS ({ name, customFields: [{ name, type }] } — Shopware custom-field
   *  sets): a key found in a set gets namespace = the set's name and type =
   *  the field's declared type; keys outside every set stay untyped.
   *  args.setsName / setsFields / fieldName / fieldType override the paths. */
  metafields_from_object: (v, { args, companions }) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
    const hp = args?.hiddenPrefix ?? '_';
    const sets = args?.sets ? companions?.[args.sets] : null;
    const byField = new Map();
    if (Array.isArray(sets)) {
      const a = { setsName: 'name', setsFields: 'customFields', fieldName: 'name', fieldType: 'type', ...(args || {}) };
      for (const s of sets) for (const f of getPath(s, a.setsFields) || []) {
        const n = toText(getPath(f, a.fieldName)); if (n && !byField.has(n)) byField.set(n, { namespace: toText(getPath(s, a.setsName)), type: toText(getPath(f, a.fieldType)) });
      }
    }
    return Object.entries(v).filter(([k, val]) => k && !(hp && k.startsWith(hp)) && !isNil(val))
      .map(([k, val]) => {
        const m = { key: k, value: typeof val === 'string' ? val : JSON.stringify(val) };
        const def = byField.get(k);
        if (def) { if (def.namespace) m.namespace = def.namespace; if (def.type) m.type = def.type; }
        return m;
      });
  },
  /** category objects carrying a breadcrumb array → "Root > … > Leaf" paths; ancestors listed alongside a leaf are dropped */
  category_paths_from_breadcrumbs: (v, { args }) => {
    if (!Array.isArray(v)) return [];
    const bp = args?.breadcrumb ?? 'breadcrumb';
    const paths = v.map((c) => { const b = getPath(c, bp); return Array.isArray(b) ? b.map(toText).filter(Boolean).join(' > ') : toText(getPath(c, args?.name ?? 'name')); }).filter(Boolean);
    return paths.filter((p, i) => !paths.some((q, j) => j !== i && q !== p && q.startsWith(p + ' > '))).filter((p, i, a) => a.indexOf(p) === i);
  },
  /** configurator-style settings [{option:{name, group:{name,position}, position}}] → options[] (axis of variation)
   *  args: group (path to group name), value (path to option name), groupPosition, position */
  options_from_settings: (v, { args }) => {
    if (!Array.isArray(v)) return [];
    const a = { group: 'option.group.name', value: 'option.name', groupPosition: 'option.group.position', position: 'option.position', ...(args || {}) };
    const groups = new Map();
    for (const s of v) {
      const g = toText(getPath(s, a.group)); const val = toText(getPath(s, a.value));
      if (!g || !val) continue;
      if (!groups.has(g)) groups.set(g, { name: g, pos: toNumber(getPath(s, a.groupPosition)) ?? 0, values: [] });
      groups.get(g).values.push({ v: val, pos: toNumber(getPath(s, a.position)) ?? 0 });
    }
    return [...groups.values()].sort((x, y) => x.pos - y.pos || x.name.localeCompare(y.name))
      .map((g) => ({ name: g.name, values: g.values.sort((x, y) => x.pos - y.pos || x.v.localeCompare(y.v)).map((x) => x.v).filter((val, i, arr) => arr.indexOf(val) === i) }));
  },
  /** flat option objects [{name, group:{name}}] (properties / configurator options) → CanonAttribute[] grouped
   *  args: group, value, forVariation (bool), visible (path on group), position (path on group) */
  attributes_from_flat_options: (v, { args }) => {
    if (!Array.isArray(v)) return [];
    const a = { group: 'group.name', value: 'name', forVariation: false, ...(args || {}) };
    const groups = new Map();
    for (const o of v) {
      const g = toText(getPath(o, a.group)); const val = toText(getPath(o, a.value));
      if (!g || !val) continue;
      if (!groups.has(g)) {
        const attr = { name: g, values: [], forVariation: !!a.forVariation };
        const vis = a.visible ? toBool(getPath(o, a.visible), null) : null; if (vis !== null) attr.visible = vis;
        const pos = a.position ? toNumber(getPath(o, a.position)) : null; if (pos !== null) attr.position = pos;
        groups.set(g, attr);
      }
      const attr = groups.get(g);
      if (!attr.values.some((x) => x.v === val)) attr.values.push({ v: val, pos: a.valuePosition ? (toNumber(getPath(o, a.valuePosition)) ?? 0) : 0 });
    }
    // values: by declared position, then name — same order as options_from_settings
    return [...groups.values()].map((attr) => ({ ...attr, values: attr.values.sort((x, y) => x.pos - y.pos || x.v.localeCompare(y.v)).map((x) => x.v) }));
  },
  /** nullable int where a sentinel (args.nullWhen, e.g. -1) means "unknown" */
  int_or_null: (v, { args }) => { const n = toNumber(v); if (n === null) return null; if (Array.isArray(args?.nullWhen) ? args.nullWhen.includes(n) : args?.nullWhen === n) return null; return Math.trunc(n); },

  // ── Phase 6.3 ──────────────────────────────────────────────────────────────
  /** true when the source carries a value (non-null, non-empty), else false */
  is_set: (v, ctx) => (ctx?.args?.clean ? !isNil(v) && cleanScalar(String(v)) !== '' : !isNil(v) && !(Array.isArray(v) && !v.length)),
  /** the value itself, or nothing at all when it is null / '' / [] — for a
   *  sourceExtension copy that must not materialise an empty key */
  copy_present: (v) => (isNil(v) || (Array.isArray(v) && !v.length) ? undefined : v),
  /** inputs [a, b, c…] → the first non-empty one as text (barcode ← gtin/ean/upc/isbn) */
  /** first non-nil input as a NUMBER (canon derivations of numeric legacy fields — 7.2) */
  first_number: (v) => { for (const x of Array.isArray(v) ? v : [v]) if (!isNil(x)) { const n = toNumber(x); if (n !== null) return n; } return undefined; },
  first_non_empty: (v) => { for (const x of Array.isArray(v) ? v : [v]) if (!isNil(x)) return toText(x); return undefined; },

  /** P1 — per-language translation ENTITIES (Shopware product_translation rows)
   *  → { [locale]: CanonTranslation }. args:
   *    locale        path to the BCP-47 code on each entity ('language.locale.code')
   *    fields        { canonField: entityPath } — title: 'name', bodyHtml: 'description', seoTitle: 'metaTitle', seoDescription: 'metaDescription'
   *    defaultWhere  { path: value } — the entity of the DEFAULT locale (already in the flat fields) is skipped
   *    slugs         with inputs [entities, seoUrls]: { locale, path, where } picks the canonical slug per locale
   *  A locale with no non-empty translated field is not emitted; nothing → undefined. */
  translations_from_entities: (v, { args }) => {
    // args.slugs requires `inputs: [entities, seoUrls]` → v is that pair.
    const [entities, urls] = args?.slugs ? (Array.isArray(v) ? v : [v, undefined]) : [v, undefined];
    const a = { locale: 'language.locale.code', fields: { title: 'name', bodyHtml: 'description', seoTitle: 'metaTitle', seoDescription: 'metaDescription' }, ...(args || {}) };
    const isDefault = (o) => a.defaultWhere && Object.entries(a.defaultWhere).every(([k, val]) => getPath(o, k) === val);
    const out = {};
    for (const e of Array.isArray(entities) ? entities : []) {
      const loc = toText(getPath(e, a.locale)); if (!loc || isDefault(e)) continue;
      const t = {};
      for (const [canon, p] of Object.entries(a.fields)) { const val = getPath(e, p); if (!isNil(val)) t[canon] = toText(val); }
      if (Object.keys(t).length) out[loc] = { ...(out[loc] || {}), ...t };
    }
    if (a.slugs && Array.isArray(urls)) {
      const s = { locale: a.locale, path: 'seoPathInfo', where: { isCanonical: true }, ...a.slugs };
      for (const u of urls) {
        const loc = toText(getPath(u, s.locale)); if (!loc || isDefault(u)) continue;
        if (s.where && !Object.entries(s.where).every(([k, val]) => getPath(u, k) === val)) continue;
        const slug = getPath(u, s.path); if (isNil(slug)) continue;
        out[loc] = { ...(out[loc] || {}), slug: toText(slug) };
      }
    }
    return Object.keys(out).length ? out : undefined;
  },

  /** 6.4 — bundle composition: array of component objects → CanonBundleComponent[].
   *  args.refs = [{ path, kind }, …] tried in order for `ref` (first non-empty,
   *  values in args.emptyValues such as 0 count as empty — PrestaShop
   *  id_product_attribute = 0 means "the product itself"); args.productRef /
   *  productRefKind the component's product; args.quantity (default 1 when
   *  missing); args.title. Shopify: refs [productVariant.sku, productVariant.id],
   *  productRef productVariant.product.handle. PrestaShop: refs
   *  [id_product_attribute, id], productRef id. Nothing → undefined. */
  bundle_components: (v, { args }) => {
    if (!Array.isArray(v) || !v.length) return undefined;
    const a = { refs: [{ path: 'id', kind: 'sourceId' }], quantity: 'quantity', emptyValues: [0, '0'], ...(args || {}) };
    const empty = new Set((a.emptyValues || []).map(String));
    const pick = (o, path) => { const x = getPath(o, path); return isNil(x) || empty.has(String(x)) ? undefined : toText(x); };
    const out = [];
    for (const o of v) {
      let ref, refKind;
      for (const r of a.refs) { const x = pick(o, r.path); if (x !== undefined) { ref = x; refKind = r.kind; break; } }
      if (ref === undefined) continue;
      const q = toNumber(getPath(o, a.quantity));
      const c = { ref, ...(refKind ? { refKind } : {}), quantity: q === null || q < 1 ? 1 : Math.trunc(q) };
      if (a.productRef) { const pr = pick(o, a.productRef); if (pr !== undefined) { c.productRef = pr; if (a.productRefKind) c.productRefKind = a.productRefKind; } }
      if (a.title) { const t = pick(o, a.title); if (t !== undefined) c.title = t; }
      out.push(c);
    }
    return out.length ? out : undefined;
  },

  /** C1 — quantity / rule price tiers: array of source rows → CanonPriceTier[].
   *  args (paths on each row; every one optional except min):
   *    min, max                    quantity bounds; a max in args.emptyValues (0, null, '') = open-ended
   *    price                       absolute unit price path (a value in args.emptyValues = not fixed, e.g. PrestaShop -1)
   *    reduction: { type, value, taxIncluded, typeMap }   reduction paths; typeMap maps source words to amount | percentage
   *    typed: { type, amount, map: { <sourceType>: 'price' | 'amount' | 'percentage' } }
   *                                one amount whose meaning depends on a type (BigCommerce price / percent / fixed)
   *    scope: { ruleRef, customerGroupRef, customerRef, currency, country, storeRef }   opaque refs (emptyValues ignored)
   *    period: { from, to }        zero dates (0000-00-00…) ignored
   *    requireTierOrScope          (default true) a row with min <= 1, no max and no scope is the ordinary
   *                                price / promo — not a tier — and is skipped
   *  Nothing → undefined. */
  price_tiers: (v, { args }) => {
    if (!Array.isArray(v) || !v.length) return undefined;
    const a = { min: 'quantityStart', max: 'quantityEnd', emptyValues: [0, '0', -1, '-1', '', null], requireTierOrScope: true, ...(args || {}) };
    const empty = new Set((a.emptyValues || []).map((x) => String(x)));
    const pick = (o, p) => { if (!p) return undefined; const x = getPath(o, p); return x === undefined || x === null || empty.has(String(x)) ? undefined : x; };
    const zeroDate = (d) => isNil(d) || /^0000-00-00/.test(String(d));
    const out = [];
    for (const o of v) {
      const minQ = toNumber(pick(o, a.min)) ?? 1;
      const maxRaw = toNumber(pick(o, a.max));
      const tier = { minQuantity: Math.max(1, Math.trunc(minQ)) };
      if (maxRaw !== null && maxRaw >= tier.minQuantity) tier.maxQuantity = Math.trunc(maxRaw);
      const price = toNumber(pick(o, a.price));
      if (price !== null) tier.price = price;
      if (a.reduction) {
        const val = toNumber(pick(o, a.reduction.value));
        if (val !== null && val !== 0) {
          const rawType = a.reduction.type ? toText(getPath(o, a.reduction.type)) : 'amount';
          const type = (a.reduction.typeMap || {})[rawType] ?? rawType;
          if (type === 'amount' || type === 'percentage') {
            tier.reduction = { type, value: val };
            const ti = a.reduction.taxIncluded ? toBool(getPath(o, a.reduction.taxIncluded), null) : null;
            if (ti !== null) tier.reduction.taxIncluded = ti;
          }
        }
      }
      if (a.typed) {
        const kind = (a.typed.map || {})[toText(getPath(o, a.typed.type))];
        const amount = toNumber(pick(o, a.typed.amount));
        if (kind && amount !== null) {
          if (kind === 'price') tier.price = amount;
          else tier.reduction = { type: kind, value: amount };
        }
      }
      if (a.scope) {
        const scope = {};
        for (const [k, p] of Object.entries(a.scope)) { const x = pick(o, p); if (x !== undefined) scope[k] = toText(x); }
        if (Object.keys(scope).length) tier.scope = scope;
      }
      if (a.period) {
        const from = pick(o, a.period.from), to = pick(o, a.period.to);
        const f = zeroDate(from) ? null : toIsoDate(from, a.period), t = zeroDate(to) ? null : toIsoDate(to, a.period);
        if (f || t) tier.period = { from: f ?? null, to: t ?? null };
      }
      if (tier.price === undefined && !tier.reduction) continue;              // a row that changes nothing is not a tier
      const isTier = tier.minQuantity > 1 || tier.maxQuantity !== undefined;
      if (a.requireTierOrScope && !isTier && !tier.scope) continue;          // the ordinary price / promo
      out.push(tier);
    }
    return out.length ? out : undefined;
  },

  /** P1 — translation PAIRS [{ locale, key, value }] (Shopify translations(locale:))
   *  → { [locale]: CanonTranslation }. args.keyMap maps source keys to canon
   *  translation fields (title, body_html → bodyHtml, meta_title → seoTitle,
   *  meta_description → seoDescription, handle → slug); pairs whose key is not
   *  mapped are left to a sourceExtension copy of the raw surface. */
  translations_from_pairs: (v, { args }) => {
    const a = { locale: 'locale', key: 'key', value: 'value', keyMap: { title: 'title', body_html: 'bodyHtml', meta_title: 'seoTitle', meta_description: 'seoDescription', handle: 'slug' }, ...(args || {}) };
    const out = {};
    for (const p of Array.isArray(v) ? v : []) {
      const loc = toText(getPath(p, a.locale)); const canon = a.keyMap[toText(getPath(p, a.key))]; const val = getPath(p, a.value);
      if (!loc || !canon || isNil(val)) continue;
      (out[loc] = out[loc] || {})[canon] = toText(val);
    }
    return Object.keys(out).length ? out : undefined;
  },

  // ── Phase 7 (orders / customers / payments / consent / numbering) ─────────
  /** A value (or an object) → ONE canon object built from args.fields
   *  ({ canonKey: sourcePath | { path, as, map, default, value, join } }).
   *  `as`: 'text' (default) | 'number' | 'int' | 'bool' | 'date' | 'map' (args.map
   *  + default) | 'raw'. `value`: a constant. `join`: [paths] joined by ' '.
   *  Dotted canonKeys nest. Empty results (every field nil) → undefined, so an
   *  optional block is only emitted when the source carries something. */
  object_map: (v, ctx) => { const o = buildObject(ctx.args?.fromSource ? ctx.source : v, ctx.args, ctx); const req = Array.isArray(ctx.args?.require) ? ctx.args.require : []; return o !== undefined && req.every((k) => getPath(o, k) !== undefined) ? o : undefined; },
  /** Array of objects → array of canon objects, one per element (object_map
   *  each). args.where filters ({ path: value }); args.skipEmpty drops elements
   *  that produced nothing. [] / null → undefined. */
  objects_map: (v, ctx) => {
    if (!Array.isArray(v) || !v.length) return undefined;
    // args.flatMap: 'a.b' — the objects to map are the arrays found at that path in each element, flattened (nested lists)
    if (ctx.args?.flatMap) { const segs = String(ctx.args.flatMap).split('.'); let cur = v; for (const seg of segs) cur = cur.flatMap((o) => { const x = o && typeof o === 'object' ? o[seg] : undefined; return Array.isArray(x) ? x : []; }); v = cur; if (!v.length) return undefined; }
    const where = ctx.args?.where || {};
    const req = Array.isArray(ctx.args?.require) ? ctx.args.require : [];
    const out = v.filter((o) => o && typeof o === 'object' && Object.entries(where).every(([k, val]) => getPath(o, k) === val))
      .map((o) => buildObject(o, ctx.args, ctx)).filter((o) => o !== undefined && req.every((k) => getPath(o, k) !== undefined));
    return out.length ? out : undefined;
  },
  /** 7.3 — inputs [statement, timestamp, level?] → CanonMarketingConsent.
   *  'opted_in' ONLY when the statement is in args.optedIn AND the source
   *  carries its own timestamp; a statement without timestamp → 'pending';
   *  args.optedOut → 'opted_out'; args.pending → 'pending'; anything else
   *  → 'unknown'. No statement at all → undefined. requiresReconfirmation is
   *  always true: a source consent is never a target consent. */
  marketing_consent: (v, { args, platform, field, companions }) => {
    let [statement, at, level] = Array.isArray(v) ? v : [v];
    // args.lookup { in, key, statement, at, level, presence }: the statement
    // lives in a companion collection keyed by this value (e-mail →
    // newsletter recipient / subscriber); presence = being listed IS the statement.
    if (args?.lookup) {
      const hit = lookupIn(statement, args.lookup, companions);
      if (!hit) return undefined;
      at = args.lookup.at ? getPath(hit, args.lookup.at) : undefined;
      level = args.lookup.level ? getPath(hit, args.lookup.level) : undefined;
      statement = args.lookup.presence ? 'listed' : getPath(hit, args.lookup.statement ?? 'status');
    }
    if (isNil(statement)) return undefined;
    // args.trimRaw: the recorded raw statement is trimmed and a blank one is no
    // statement at all; args.ignoreCase: the state lists match regardless of case.
    if (args?.trimRaw && typeof statement === 'string') { statement = statement.trim(); if (statement === '') return undefined; }
    const fold = (x) => (args?.ignoreCase ? String(x).toLowerCase() : String(x));
    const key = fold(typeof statement === 'boolean' ? String(statement) : String(statement).trim());
    const list = (name) => (Array.isArray(args?.[name]) ? args[name].map(fold) : []);
    // B1: the SOURCE's own timestamp, normalised to UTC only when it carries a zone; otherwise verbatim (zone unknown, never inferred)
    const stamp = toIsoDate(at, args?.assumeUtc === true ? { assumeUtc: true } : {}); const hasStamp = !!stamp && !/^0000-00-00/.test(String(at));
    let state = 'unknown';
    if (list('optedIn').includes(key)) state = hasStamp ? 'opted_in' : 'pending';
    else if (list('optedOut').includes(key)) state = 'opted_out';
    else if (list('pending').includes(key)) state = 'pending';
    const out = { state, channel: args?.channel === 'sms' ? 'sms' : 'email', source: { platform, field: args?.lookup ? `${args.lookup.in}[${args.lookup.statement ?? (args.lookup.presence ? 'listed' : 'status')}]` : field?.inputs?.[0] ?? field?.path ?? '', raw: statement } };
    if (hasStamp) out.at = stamp;
    const lv = !isNil(level) && args?.levelMap && Object.prototype.hasOwnProperty.call(args.levelMap, String(level)) ? args.levelMap[String(level)] : args?.level;
    if (lv) out.level = lv;
    out.requiresReconfirmation = true;
    return out;
  },
  /** 7.4 — a numeric sequence value → its formatted reference ("#IN000001").
   *  args.prefix / suffix / pad. 0 / null / '' → undefined (no number assigned). */
  format_number: (v, { args }) => {
    if (isNil(v)) return undefined;
    const n = toNumber(v);
    if (n === 0 && args?.zeroIsNone !== false) return undefined;
    const core = n === null ? String(v).trim() : String(Math.trunc(n));
    if (!core) return undefined;
    const padded = args?.pad ? core.padStart(Number(args.pad), '0') : core;
    return (args?.prefix ?? '') + padded + (args?.suffix ?? '');
  },
  /** An address object → CanonAddress (& name). args.fields maps canon keys to
   *  source paths; the unmapped canon keys are ''. args.nameFrom joins paths. */
  address_from: (v, ctx) => {
    const { args, companions, source } = ctx;
    // args.lookup { in, key, multiple }: the value is an id (or a key) into a companion collection
    if (args?.lookup) v = lookupIn(v, args.lookup, companions);
    // args.each: every element becomes an address (customer address book)
    if (Array.isArray(v) && args?.each) { const list = v.map((o) => TRANSFORMS.address_from(o, { ...ctx, args: { ...args, each: false, lookup: undefined } })).filter(Boolean); return list.length ? list : undefined; }
    // args.select { where: { path: value }, whereFrom: { path: sourcePath } }: pick ONE element of an array
    if (Array.isArray(v)) {
      const sel = args?.select || {};
      const hit = v.find((o) => Object.entries(sel.where || {}).every(([k, val]) => getPath(o, k) === val) && Object.entries(sel.whereFrom || {}).every(([k, sp]) => String(getPath(o, k) ?? '') === String(getPath(source, sp) ?? ''))) ?? (sel.where || sel.whereFrom ? undefined : v[0]);
      v = hit;
    }
    if (!v || typeof v !== 'object') return undefined;
    const f = args?.fields || {};
    const read = (k, dflt = '') => { const pth = f[k]; if (!pth) return dflt; return toText(getPath(v, pth)).trim(); };
    const out = { company: read('company'), address1: read('address1'), address2: read('address2'), city: read('city'), province: read('province'), provinceCode: read('provinceCode'), country: read('country'), zip: read('zip'), phone: read('phone') };
    if (args?.withName !== false) out.name = Array.isArray(args?.nameFrom) ? args.nameFrom.map((pth) => toText(getPath(v, pth)).trim()).filter(Boolean).join(' ') : read('name');
    for (const k of ['firstName', 'lastName', 'label', 'kind', 'vatNumber', 'sourceId']) if (f[k]) { const t = read(k); if (t) out[k] = t; }
    for (const k of ['isDefaultBilling', 'isDefaultShipping']) if (f[k]) { const b = toBool(getPath(v, f[k]), null); if (b !== null) out[k] = b; }
    // args.defaults { isDefaultBilling: sourcePath, isDefaultShipping: sourcePath }: this address is the default when its id (fields.sourceId) equals the id the SOURCE unit points at
    for (const [k, sp] of Object.entries(args?.defaults || {})) { const want = getPath(source, sp); if (isNil(want) || !out.sourceId) continue; out[k] = String(want) === String(out.sourceId); }
    // args.kindMap { TAG: 'billing' | 'shipping' | 'both' }: the source's address tag (fields.kind) → canon kind; an unmapped tag is dropped
    if (args?.kindMap && out.kind !== undefined) { const m = args.kindMap[out.kind]; if (m) out.kind = m; else delete out.kind; }
    if (args?.countryMap && out.country && Object.prototype.hasOwnProperty.call(args.countryMap, out.country)) out.country = args.countryMap[out.country];
    // args.refs { country: { in, key, pick }, province: …, provinceCode: … }: a numeric id resolved through a companion collection
    for (const [k, ref] of Object.entries(args?.refs || {})) {
      if (!out[k]) continue;
      const hit = lookupIn(out[k], ref, companions);
      out[k] = hit === undefined ? (ref.keepUnresolved ? out[k] : '') : toText(firstLangValue(getPath(hit, ref.pick ?? 'iso_code'))).trim();
    }
    return Object.values(out).some((x) => x !== '' && x !== undefined) ? out : undefined;
  },
  /** "Product name - Color : White, Size : S" → [name, options[]] (multi-output
   *  `name + options`). args.sep (' - '), args.pairSep (', '), args.kv (' : '). */
  split_name_options: (v, { args }) => {
    const s = toText(v).trim();
    const sep = args?.sep ?? ' - ';
    const i = s.lastIndexOf(sep);
    if (i < 0) return [s, undefined];
    const tail = s.slice(i + sep.length);
    const kv = args?.kv ?? ' : ';
    const pairs = tail.split(args?.pairSep ?? ', ').map((x) => x.split(kv)).filter((x) => x.length === 2);
    if (!pairs.length || pairs.length !== tail.split(args?.pairSep ?? ', ').length) return [s, undefined];
    return [s.slice(0, i).trim(), pairs.map(([name, value]) => ({ name: name.trim(), value: value.trim() }))];
  },
  /** Companion join: the record whose args.key equals the value (args.in
   *  names the companion), or all of them (args.multiple). args.pick reads a
   *  path off the hit (a [{id,value}] multilingual list yields its first value);
   *  args.map / args.default then re-map the picked value; args.fields builds
   *  object(s) (object_map semantics) instead. Nothing found → undefined. */
  lookup: (v, ctx) => {
    const { args, companions } = ctx;
    const hit = lookupIn(Object.prototype.hasOwnProperty.call(args || {}, 'equals') ? args.equals : v, args, companions);
    if (args?.multiple) {
      if (!Array.isArray(hit) || !hit.length) return undefined;
      if (args.fields) { const req = Array.isArray(args.require) ? args.require : []; const out = hit.map((o) => buildObject(o, args, ctx)).filter((o) => o !== undefined && req.every((k) => getPath(o, k) !== undefined)); return out.length ? out : undefined; }
      return args.pick ? hit.map((o) => toText(firstLangValue(getPath(o, args.pick))).trim()).filter(Boolean) : hit;
    }
    if (hit === undefined) return undefined;
    if (args?.fields) return buildObject(hit, args, ctx);
    let picked = args?.pick ? firstLangValue(getPath(hit, args.pick)) : hit;
    if (args?.map) { const k = isNil(picked) ? '' : String(picked); picked = Object.prototype.hasOwnProperty.call(args.map, k) ? args.map[k] : args.default; }
    else if (typeof picked === 'string') picked = picked.trim();
    return picked;
  },
  /** inputs [a, b] → a − b (numbers tolerant); either missing → undefined. */
  subtract: (v) => { const [a, b] = Array.isArray(v) ? v : [v]; const x = toNumber(a), y = toNumber(b); if (x === null || y === null) return undefined; return Math.round((x - y) * 1e6) / 1e6; },
  /** an id as string, or nothing when it is 0 / '' / null (args.none extends the list) */
  id_or_none: (v, { args }) => { if (isNil(v)) return undefined; const none = ['0', ...(Array.isArray(args?.none) ? args.none.map(String) : [])]; const t = String(v).trim(); return none.includes(t) ? undefined : t; },
  /** true when the value is absent / empty (a guest = no member id) */
  is_unset: (v, { args, source }) => { if (args?.requireParent && isNil(getPath(source, args.requireParent))) return undefined; return isNil(v) || (Array.isArray(v) && !v.length); },
  /** ISO date, or nothing (never null) when the source has none / a zero date — for optional canon dates */
  date_present: (v, { args }) => { const d = toIsoDate(v, args); return d === null ? undefined : d; },
  /** number, or nothing (never null) when the source has none — optional canon amounts */
  money_present: (v) => { const n = toNumber(v); return n === null ? undefined : n; },
  /** number, or nothing when the source has none OR zero — optional amounts where 0 means "none" (discount, refund) */
  money_nonzero: (v) => { const n = toNumber(v); return n === null || n === 0 ? undefined : n; },
  /** trimmed text, or nothing (never '') when the source has none — optional canon strings */
  text_present: (v) => { const t = toText(v).trim(); return t ? t : undefined; },
  /** PrestaShop-style multilingual [{ id, value }] → the first non-empty value
   *  as trimmed text. Scalar in → scalar out. args.valuePath overrides 'value'. */
  first_lang_value: (v, { args }) => {
    if (v === undefined || v === null) return '';
    if (Array.isArray(v)) {
      const path = args?.valuePath ?? 'value';
      for (const o of v) { const t = toText(getPath(o, path)).trim(); if (t) return t; }
      return '';
    }
    return toText(v).trim();
  },

  /** Read a field off ctx.parent (source parent, when we are on a variant /
   *  item). args.field = path on the parent; args.as = one of the registry ids
   *  (default 'text') applied to the read value. Undefined on the root scope. */
  parent_field: (_v, ctx) => {
    const { args, parent } = ctx;
    if (!parent || !args?.field) return undefined;
    const raw = getPath(parent, args.field);
    if (raw === undefined || raw === null) return undefined;
    const as = args.as || 'text';
    return TRANSFORMS[as] ? TRANSFORMS[as](raw, { ...ctx, args: args.asArgs || {} }) : raw;
  },

  /** Sum of args.path over an array (numbers tolerant); [] → undefined. */
  sum_of: (v, { args }) => {
    if (!Array.isArray(v) || !v.length) return undefined;
    let total = 0; let any = false;
    for (const o of v) { const n = toNumber(getPath(o, args?.path ?? 'amount')); if (n !== null) { total += n; any = true; } }
    return any ? Math.round(total * 1e6) / 1e6 : undefined;
  },

  /** PrestaShop parent scope — derive product.options[] by walking every
   *  combination of this product through the two-companion axis resolution:
   *  combinations.associations.product_option_values[].id → productOptionValues
   *  (id_attribute_group + multilingual name) → productOptions (multilingual
   *  name + position). Groups by axis, dedupes values, orders by declared
   *  positions (axis position then value position). `v` is the product id.
   *
   *  args (all optional, defaults match the PS Webservice shape):
   *    combinations         companion of combinations (default 'variations')
   *    combinationsParentId path on each combination that links to product ('id_product')
   *    combinationValueIds  path on each combination to the option-value id list ('associations.product_option_values')
   *    valueIdPath          path on each id-holder to the id itself ('id')
   *    values               companion of option values (default 'productOptionValues')
   *    valueKey             key in values companion matched by the id ('id')
   *    valueAxisId          path on a value pointing at its axis id ('id_attribute_group')
   *    valueLabelPath       multilingual label path on a value ('name')
   *    valuePositionPath    numeric position on a value ('position')
   *    axes                 companion of axes (default 'productOptions')
   *    axisKey              key in axes companion ('id')
   *    axisLabelPath        multilingual label path on an axis ('name')
   *    axisPositionPath     numeric position on an axis ('position') */
  prestashop_product_options: (v, { args, companions }) => {
    const a = {
      combinations: 'variations', combinationsParentId: 'id_product',
      combinationValueIds: 'associations.product_option_values', valueIdPath: 'id',
      values: 'productOptionValues', valueKey: 'id', valueAxisId: 'id_attribute_group',
      valueLabelPath: 'name', valuePositionPath: 'position',
      axes: 'productOptions', axisKey: 'id', axisLabelPath: 'name', axisPositionPath: 'position',
      ...(args || {}),
    };
    const productId = String(v ?? '');
    if (!productId) return [];
    const combos = Array.isArray(companions?.[a.combinations]) ? companions[a.combinations] : [];
    const mine = combos.filter((c) => String(getPath(c, a.combinationsParentId) ?? '') === productId);
    if (!mine.length) return [];
    const values = Array.isArray(companions?.[a.values]) ? companions[a.values] : [];
    const axes = Array.isArray(companions?.[a.axes]) ? companions[a.axes] : [];
    const valueById = new Map(values.map((x) => [String(getPath(x, a.valueKey) ?? ''), x]));
    const axisById = new Map(axes.map((x) => [String(getPath(x, a.axisKey) ?? ''), x]));

    const grouped = new Map(); // axisName → { pos, values: Map<value,valPos> }
    for (const c of mine) {
      const ids = getPath(c, a.combinationValueIds);
      if (!Array.isArray(ids)) continue;
      for (const idObj of ids) {
        const id = String(getPath(idObj, a.valueIdPath) ?? '');
        const val = valueById.get(id); if (!val) continue;
        const axisId = String(getPath(val, a.valueAxisId) ?? '');
        const axis = axisById.get(axisId); if (!axis) continue;
        const axisName = firstLangValue(getPath(axis, a.axisLabelPath));
        const valueLabel = firstLangValue(getPath(val, a.valueLabelPath));
        if (!axisName || !valueLabel) continue;
        const axisPos = toNumber(getPath(axis, a.axisPositionPath)) ?? 0;
        const valPos = toNumber(getPath(val, a.valuePositionPath)) ?? 0;
        if (!grouped.has(axisName)) grouped.set(axisName, { pos: axisPos, values: new Map() });
        const g = grouped.get(axisName);
        if (!g.values.has(valueLabel)) g.values.set(valueLabel, valPos);
      }
    }
    return [...grouped.entries()]
      .sort(([an, ag], [bn, bg]) => ag.pos - bg.pos || an.localeCompare(bn))
      .map(([name, g]) => ({
        name: String(name),
        values: [...g.values.entries()].sort(([av, ap], [bv, bp]) => ap - bp || av.localeCompare(bv)).map(([val]) => String(val)),
      }));
  },

  /** PrestaShop variant scope — aligned optionValues[] for the current
   *  combination. Reads the same two companions as prestashop_product_options,
   *  resolves each id in the combination's associations.product_option_values
   *  to an axis-name → value-label map, then reads the parent product's
   *  options[] (already built by the parent transform) and emits one value per
   *  axis in the SAME order. Values missing on this combination surface as an
   *  empty string, matching how Shopify/Wix/BC serializers expect the array.
   *
   *  args (same defaults as prestashop_product_options minus the parent-scope
   *  ones). `v` is the list of {id} objects on this combination. */
  prestashop_variant_option_values: (v, { args, product, companions }) => {
    const a = {
      values: 'productOptionValues', valueKey: 'id', valueAxisId: 'id_attribute_group', valueLabelPath: 'name',
      axes: 'productOptions', axisKey: 'id', axisLabelPath: 'name',
      valueIdPath: 'id',
      ...(args || {}),
    };
    if (!Array.isArray(v) || !v.length) return [];
    const productOpts = (product && Array.isArray(product.options)) ? product.options : [];
    if (!productOpts.length) return [];
    const values = Array.isArray(companions?.[a.values]) ? companions[a.values] : [];
    const axes = Array.isArray(companions?.[a.axes]) ? companions[a.axes] : [];
    const valueById = new Map(values.map((x) => [String(getPath(x, a.valueKey) ?? ''), x]));
    const axisById = new Map(axes.map((x) => [String(getPath(x, a.axisKey) ?? ''), x]));

    const byAxis = new Map(); // axisName → valueLabel (first hit wins for this combination)
    for (const idObj of v) {
      const id = String(getPath(idObj, a.valueIdPath) ?? '');
      const val = valueById.get(id); if (!val) continue;
      const axisId = String(getPath(val, a.valueAxisId) ?? '');
      const axis = axisById.get(axisId); if (!axis) continue;
      const axisName = firstLangValue(getPath(axis, a.axisLabelPath));
      const valueLabel = firstLangValue(getPath(val, a.valueLabelPath));
      if (axisName && valueLabel && !byAxis.has(axisName)) byAxis.set(axisName, valueLabel);
    }
    return productOpts.map((opt) => String(byAxis.get(opt.name) ?? ''));
  },

  // ── Phase 2 (format adaptation) — generic, format-agnostic helpers ─────────
  /** a scalar cell, cleaned like the engine's CSV parsers do (values.mjs
   *  cleanScalar: smart punctuation repaired, embedded line breaks / tabs /
   *  double spaces collapsed, trimmed); args.stripExcelGuard drops the leading
   *  apostrophe spreadsheets add to keep long numbers as text */
  clean_text: (v, { args }) => {
    let s = cleanScalar(v === undefined || v === null ? '' : String(v));
    // args.lastSegmentOf: only the leaf of a path ("Parent > Brand" → "Brand")
    if (args?.lastSegmentOf) s = (s.split(args.lastSegmentOf).pop() ?? '').trim();
    return args?.stripExcelGuard ? stripExcelGuard(s) : s;
  },
  /** a column family { "<prefix><name>": "a|b" } → options [{ name, values }]:
   *  the name is the column minus args.stripPrefix, values split on args.sep
   *  (default ','), trimmed, blanks dropped; an option with no value is dropped */
  options_from_columns: (v, { args }) => {
    if (!v || typeof v !== 'object') return [];
    const prefix = args?.stripPrefix ?? '';
    return Object.entries(v).map(([col, cell]) => ({
      name: prefix && col.startsWith(prefix) ? col.slice(prefix.length) : col,
      values: String(cell ?? '').split(args?.sep ?? ',').map((s) => s.trim()).filter((s) => s.length > 0),
    })).filter((o) => o.values.length);
  },
  /** inputs [value, text] → the value verbatim when present, else a slug of the
   *  text (args.maxLen, default 80; args.fallback, default 'product') */
  value_or_slug: (v, { args }) => {
    const [value, text] = Array.isArray(v) ? v : [v, ''];
    if (!isNil(value)) return String(value);
    const src = isNil(text) ? (args?.fallback ?? 'product') : String(text);
    return src.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, args?.maxLen ?? 80) || (args?.fallback ?? 'product');
  },
  /** a consent / yes-no literal (values.mjs parseConsent: yes/true/1/subscribed,
   *  no/false/0/unsubscribed/not subscribed) → true / false / null;
   *  args.strict → exactly true or false (unknown counts as false) */
  consent_bool: (v, { args }) => {
    const b = parseConsent(v === undefined || v === null ? undefined : String(v));
    return args?.strict ? b === true : b;
  },
  /** a cleaned cell → a list: [] when blank, [cell] as one item, or split on
   *  args.sep (each part cleaned, blanks dropped) — a group name is ONE tag */
  clean_list: (v, { args }) => {
    const t = cleanScalar(v === undefined || v === null ? '' : String(v));
    if (!t) return [];
    return args?.sep ? t.split(args.sep).map((p) => cleanScalar(p)).filter(Boolean) : [t];
  },
  /** inputs [a, b, …] → the cleaned parts that say something, each with its
   *  args.parts[i] { prefix, skip: [values meaning "nothing"] }, joined with
   *  args.sep (e.g. a note + "Store credit: 25.00" unless the credit is "0") */
  join_parts: (v, { args }) => {
    const vals = Array.isArray(v) ? v : [v];
    const out = [];
    vals.forEach((x, i) => {
      const spec = args?.parts?.[i] || {};
      const t = cleanScalar(x === undefined || x === null ? '' : String(x));
      if (!t || (spec.skip || []).map(String).includes(t)) return;
      out.push((spec.prefix ?? '') + t);
    });
    return out.join(args?.sep ?? ' ');
  },
  /** inputs [state, country] → the state as a code where the country has a
   *  known table (US names → USPS codes), else the cleaned state (values.mjs) */
  state_code: (v) => {
    const [state, country] = Array.isArray(v) ? v : [v, ''];
    const clean = (x) => cleanScalar(x === undefined || x === null ? '' : String(x));
    return stateToCode(clean(state), clean(country));
  },
  /** a whole CanonAddress read from flat columns of the source row:
   *  args.fields { company, address1, address2, city, province, zip, phone,
   *  country } (column names, cleaned; an unmapped key is ''),
   *  args.provinceCode { state, country } → state_code of those columns,
   *  args.nullWhenEmpty [keys] → null when every listed key is blank (a
   *  shipping address the source left empty is no address, not a blank one) */
  address_block: (_v, { args, source }) => {
    const f = args?.fields || {};
    const cell = (col) => (col ? cleanScalar(String(getPath(source, col) ?? '')) : '');
    const out = {
      company: cell(f.company), address1: cell(f.address1), address2: cell(f.address2), city: cell(f.city),
      province: cell(f.province), provinceCode: '', country: cell(f.country), zip: cell(f.zip), phone: cell(f.phone),
    };
    const pc = args?.provinceCode;
    out.provinceCode = pc ? stateToCode(cell(pc.state), cell(pc.country)) : out.province;
    if (Array.isArray(args?.nullWhenEmpty) && args.nullWhenEmpty.every((k) => !out[k])) return null;
    return out;
  },
  /** inputs [a, b, …] → the FIRST present input (non-nil; a non-empty array),
   *  verbatim, then converted with args.as (+ args.asArgs) like
   *  inherit_from_parent. A list wins over a scalar fallback only when it has
   *  entries: e.g. [images[], image_url] → the full list, or the single URL
   *  when the list is missing / empty (historical files). */
  first_present: (v, ctx) => {
    const { args } = ctx;
    const hit = (Array.isArray(v) ? v : [v]).find((x) => !isNil(x) && !(Array.isArray(x) && !x.length));
    if (hit === undefined) return undefined;
    const as = args?.as || 'copy';
    return TRANSFORMS[as] ? TRANSFORMS[as](hit, { ...ctx, args: args?.asArgs || {} }) : hit;
  },
  /** A parent-derived value for a child that does NOT carry its own input:
   *  the child's value at the entry path is nil → read args.parentInputs (paths
   *  on the parent, in order) and convert them with args.as (+ args.asArgs).
   *  A child with its own value gets nothing from here (e.g. a variant priced on
   *  its own never inherits the parent's crossed-out price). */
  parent_when_absent: (v, ctx) => {
    const { args, parent } = ctx;
    if (!isNil(v) || !parent) return undefined;
    const paths = args?.parentInputs || [];
    const read = paths.map((p) => getPath(parent, p));
    const as = args?.as || 'copy';
    const input = paths.length === 1 ? read[0] : read;
    return TRANSFORMS[as] ? TRANSFORMS[as](input, { ...ctx, args: args?.asArgs || {} }) : input;
  },
  /** inputs [candidate, reference] → candidate as a number when it is strictly
   *  ABOVE reference (a crossed-out "was" price must exceed the charged price),
   *  else nothing. A missing reference means nothing to compare against → nothing. */
  money_if_above: (v) => {
    const [candidate, reference] = Array.isArray(v) ? v : [v];
    const c = toNumber(candidate), r = toNumber(reference);
    return c !== null && r !== null && c > r ? c : undefined;
  },
  /** text when it matches args.pattern (RegExp source, args.flags), else nothing */
  text_matching: (v, { args }) => {
    if (isNil(v)) return undefined;
    const t = toText(v).trim();
    return new RegExp(args?.pattern ?? '.*', args?.flags ?? '').test(t) ? t : undefined;
  },
  /** ordered regex rules → the value of the first rule matching the text:
   *  args.rules [{ pattern, flags?, value }], args.default when none matches
   *  (undefined = skip). A verbatim statement ("OutOfStock", "Rupture de
   *  stock") becomes a canonical fact without a per-site table. */
  regex_map: (v, { args }) => {
    if (isNil(v)) return args?.default;
    const t = toText(v);
    for (const rule of args?.rules || []) if (new RegExp(rule.pattern, rule.flags ?? '').test(t)) return rule.value;
    return args?.default;
  },
  /** inputs [base…, id…] → "<slug(first base)>-<hash36(first id)>": the
   *  slug-plus-short-hash handle convention. args.baseInputs = how many leading
   *  inputs are base-text candidates (default 1); the rest are id candidates.
   *  args.maxLen (default 60) caps the slug, args.fallback ('produit') names an
   *  empty one, args.hashLen (6) caps the 31-polynomial base-36 hash. */
  slug_hash: (v, { args }) => {
    const list = Array.isArray(v) ? v : [v];
    const nBase = args?.baseInputs ?? 1;
    const firstText = (xs) => { for (const x of xs) if (!isNil(x)) return toText(x); return ''; };
    const base = firstText(list.slice(0, nBase));
    const slug = base.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, args?.maxLen ?? 60) || (args?.fallback ?? 'produit');
    const basis = firstText(list.slice(nBase));
    let h = 0;
    for (let i = 0; i < basis.length; i++) h = (h * 31 + basis.charCodeAt(i)) >>> 0;
    return `${slug}-${h.toString(36).slice(0, args?.hashLen ?? 6)}`;
  },
};

export function hasTransform(id) { return Object.prototype.hasOwnProperty.call(TRANSFORMS, id); }
export function applyTransform(id, value, ctx) {
  const fn = TRANSFORMS[id];
  if (!fn) throw new Error(`unknown transform: ${id}`);
  return fn(value, ctx);
}
export { getPath };
