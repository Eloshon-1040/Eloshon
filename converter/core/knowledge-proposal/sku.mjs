/**
 * SKU — the Scraper's rule (shared/extract/sku.mjs, mirrored here: same cases in both test suites) and the
 * optional SKU generator.
 *
 * Rule: a SKU is an identifier the SOURCE declares. A value that reads as a label (« : » or « / »), a phrase, a
 * repeat of an option / colour / product name, longer than 64 characters or without any letter or digit is never
 * written as a SKU: it is removed (the SKU stays empty) and reported.
 *
 * Generator (OFF by default, the user turns it on at the « Correspondance » step):
 *   • sources: the product's reference from the source (`identity.sourceId`), the title's slug, or the title's
 *     slug + the variant's option values. A barcode (EAN) only when chosen explicitly (`source: 'barcode'`).
 *     The variant name alone is not offered: two products' « Bleu / 42 » collide;
 *   • settings: prefix, separator, case, maximum length, accents transliterated;
 *   • a real SKU is never overwritten; uniqueness guaranteed by a DETERMINISTIC suffix (a short hash of the
 *     product + options), so the same input gives the same SKU from one import to the next;
 *   • every generated SKU is listed (product, variant, SKU) for the report.
 */

export const SKU_MAX_LENGTH = 64;

const fold = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** @returns {{ok:true, value:string} | {ok:false, reason:'empty'|'label'|'phrase'|'option_name'|'too_long'|'no_identifier'}} */
export function skuVerdict(value, { names = [] } = {}) {
  const v = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!v) return { ok: false, reason: 'empty' };
  if (v.length > SKU_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  if (/[:/]/.test(v)) return { ok: false, reason: 'label' };
  if (!/[\p{L}\p{N}]/u.test(v)) return { ok: false, reason: 'no_identifier' };
  const f = fold(v);
  if (f && names.some((n) => n != null && fold(n) === f)) return { ok: false, reason: 'option_name' };
  const words = v.split(' ');
  if (words.length >= 3 && words.filter((w) => !/\d/.test(w)).length >= 2) return { ok: false, reason: 'phrase' };
  if (words.length === 2 && words.every((w) => /^\p{L}{2,}$/u.test(w))) return { ok: false, reason: 'phrase' };
  return { ok: true, value: v };
}

/**
 * Remove the SKUs that are not SKUs, in place. Names checked against: the variant's option values and the
 * product's option names (a SKU may well read like the title: « GUIDE-PDF » for « Guide PDF »).
 * @returns {Array<{product:string, variant:string, value:string, reason:string}>}
 */
export function guardSkus(products) {
  const out = [];
  for (const p of products || []) {
    const optionNames = (p.options || []).map((o) => o && o.name);
    for (const v of p.variants || []) {
      const raw = v && v.sku;
      if (raw == null || String(raw).trim() === '') continue;
      const r = skuVerdict(raw, { names: [...(v.optionValues || []), ...optionNames] });
      if (r.ok) { v.sku = r.value; continue; }
      out.push({ product: p.handle || p.title || '', variant: (v.optionValues || []).filter(Boolean).join(' / '), value: String(raw).slice(0, 120), reason: r.reason });
      v.sku = '';
    }
  }
  return out;
}

// ── Generator ──────────────────────────────────────────────────────────────────────────────────────
export const SKU_SOURCES = ['reference', 'title', 'title_options', 'barcode'];
// The generator's bounds (step 3 shows them as the fields' rules).
export const SKU_MIN_LENGTH = 8;
export const SKU_PREFIX_MAX = 12;
export const SKU_SEPARATORS = ['-', '_', '.'];
export const SKU_CASES = ['upper', 'lower', 'keep'];
export const DEFAULT_SKU_GENERATOR = Object.freeze({ enabled: false, source: 'reference', prefix: '', separator: '-', case: 'upper', maxLength: 32, transliterate: true });

const LIGATURES = { ß: 'ss', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ø: 'o', Ø: 'O', ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', þ: 'th', Þ: 'TH' };
function piece(s, o) {
  let t = String(s == null ? '' : s);
  if (o.transliterate) t = t.replace(/[ßæÆœŒøØłŁđĐþÞ]/g, (c) => LIGATURES[c]).normalize('NFD').replace(/[̀-ͯ]/g, '');
  t = t.replace(/[^\p{L}\p{N}]+/gu, o.separator);
  if (o.separator) t = t.replace(new RegExp(`^${esc(o.separator)}+|${esc(o.separator)}+$`, 'g'), '').replace(new RegExp(`${esc(o.separator)}{2,}`, 'g'), o.separator);
  return o.case === 'upper' ? t.toUpperCase() : (o.case === 'lower' ? t.toLowerCase() : t);
}
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// FNV-1a 32 bits → 4 base-36 characters: short, stable, the same for the same product + options.
function shortHash(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36).toUpperCase().padStart(4, '0').slice(-4); }

/** The settings, completed and bounded. */
export function skuGeneratorOptions(o = {}) {
  const x = { ...DEFAULT_SKU_GENERATOR, ...(o || {}) };
  if (!SKU_SOURCES.includes(x.source)) x.source = DEFAULT_SKU_GENERATOR.source;
  x.separator = typeof x.separator === 'string' ? x.separator.replace(/[^-_.]/g, '').slice(0, 1) : '-';
  x.case = SKU_CASES.includes(x.case) ? x.case : 'upper';
  x.maxLength = Math.max(SKU_MIN_LENGTH, Math.min(SKU_MAX_LENGTH, Math.trunc(Number(x.maxLength)) || DEFAULT_SKU_GENERATOR.maxLength));
  x.prefix = String(x.prefix || '').slice(0, SKU_PREFIX_MAX);
  x.transliterate = x.transliterate !== false;
  x.enabled = x.enabled === true;
  return x;
}

/**
 * The product's reference from the source (`identity.sourceId`) when it reads as one: an article code such as
 * « IF6490 ». A platform's internal record id is not a product reference: only digits (« 13 »), a Shopify global
 * id (« gid://shopify/Product/… »), a UUID or a 32-character hex key (Shopware) → null.
 */
export function referenceOf(p) {
  const ref = String((p && p.identity && p.identity.sourceId) || '').trim();
  if (!ref || /^\d+$/.test(ref) || /^gid:\/\//i.test(ref) || /^[0-9a-f]{32}$/i.test(ref) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return null;
  return ref;
}

function baseOf(p, v, o, withOptions) {
  const opts = withOptions ? (v && v.optionValues || []).filter(Boolean) : [];
  if (o.source === 'barcode') return v && v.barcode ? piece(v.barcode, o) : '';
  if (o.source === 'reference') { const ref = referenceOf(p); return ref ? [piece(ref, o), ...opts.map((x) => piece(x, o))].filter(Boolean).join(o.separator) : ''; }
  const title = piece(p.title, o);
  return o.source === 'title_options' || withOptions ? [title, ...opts.map((x) => piece(x, o))].filter(Boolean).join(o.separator) : title;
}
function fit(base, o, room = 0) {
  const pre = o.prefix ? piece(o.prefix, o) : '';
  const max = o.maxLength - room - (pre ? pre.length + o.separator.length : 0);
  let cut = base.slice(0, Math.max(1, max));
  // Cut between two words when that keeps at least half of the room (« …-DE-11X5CM » rather than « …-DE-11X5CM-11 »).
  if (o.separator && cut.length < base.length && base[cut.length] !== o.separator) { const at = cut.lastIndexOf(o.separator); if (at >= Math.ceil(max / 2)) cut = cut.slice(0, at); }
  if (o.separator) cut = cut.replace(new RegExp(`${esc(o.separator)}+$`), '');
  return pre ? `${pre}${o.separator}${cut}` : cut;
}

/**
 * Plan the SKUs (nothing is changed). Variants with a real SKU keep it. A variable product (several variants)
 * also gets a parent SKU (WooCommerce links its variations by the parent's SKU).
 * @returns {{ variants: Array<{product:string, variant:string, sku:string, p:number, vi:number}>, parents: Array<{product:string, sku:string, p:number}>, keptReal:number, noSource:number }}
 */
// The SKUs already in the file (variants, parents the source declared): a generated one never takes them.
function takenSet(products, reserved = []) {
  const taken = new Set();
  for (const p of products || []) for (const v of p.variants || []) if (v && v.sku) taken.add(String(v.sku).toUpperCase());
  for (const s of reserved) if (s) taken.add(String(s).toUpperCase());
  return taken;
}
// Unique SKU from a base: as is when free, else + a short hash of the product (+ options) — stable from one
// import to the next —, else + a counter.
function makeClaim(o, taken) {
  return (base, identity) => {
    if (!base) return '';
    let s = fit(base, o);
    if (!taken.has(s.toUpperCase())) { taken.add(s.toUpperCase()); return s; }
    const h = shortHash(identity);
    s = `${fit(base, o, h.length + o.separator.length)}${o.separator}${o.case === 'lower' ? h.toLowerCase() : h}`;
    for (let n = 2; taken.has(s.toUpperCase()); n++) s = `${fit(base, o, h.length + String(n).length + 2 * o.separator.length)}${o.separator}${h}${o.separator}${n}`;
    taken.add(s.toUpperCase()); return s;
  };
}
const identityOf = (p) => `${p.handle || ''}|${p.title || ''}|${(p.identity && p.identity.sourceId) || ''}`;
const isVariable = (p) => (p.variants || []).length > 1 && (p.options || []).length > 0;

/**
 * PARENT SKUs only, for the variable products that have none (WooCommerce links variations to their parent by
 * the parent's SKU — a new product cannot be given an ID). Used by default for WooCommerce, generator on or off:
 * the source's reference, else the title's slug; variations are left as they are.
 * @param {object[]} products  @param {{ skip?: (p:object, i:number) => boolean, reserved?: string[], options?: object }} [o]
 * @returns {Map<number, string>}
 */
export function parentSkus(products, { skip = () => false, reserved = [], options = {} } = {}) {
  const o = skuGeneratorOptions({ ...options, enabled: true });
  const claim = makeClaim(o, takenSet(products, reserved));
  const out = new Map();
  (products || []).forEach((p, pi) => {
    if (!isVariable(p) || skip(p, pi)) return;
    const base = baseOf(p, null, { ...o, source: o.source === 'barcode' ? 'reference' : o.source }, false) || baseOf(p, null, { ...o, source: 'title' }, false);
    const sku = claim(base, `${identityOf(p)}|parent`);
    if (sku) out.set(pi, sku);
  });
  return out;
}

export function planSkus(products, options) {
  const o = skuGeneratorOptions(options);
  const claim = makeClaim(o, takenSet(products));
  const plan = { variants: [], parents: [], keptReal: 0, noSource: 0 };
  (products || []).forEach((p, pi) => {
    const variants = p.variants || [];
    const several = variants.length > 1;
    const id = identityOf(p);
    if (several && p.options && p.options.length) {
      const sku = o.source === 'barcode' ? '' : claim(baseOf(p, null, o, false), `${id}|parent`);
      if (sku) plan.parents.push({ product: p.handle || p.title || '', sku, p: pi });
    }
    variants.forEach((v, vi) => {
      if (v && v.sku) { plan.keptReal++; return; }
      const sku = claim(baseOf(p, v, o, several), `${id}|${(v && v.optionValues || []).join('|')}|${vi}`);
      if (!sku) { plan.noSource++; return; }
      plan.variants.push({ product: p.handle || p.title || '', variant: (v && v.optionValues || []).filter(Boolean).join(' / '), sku, p: pi, vi });
    });
  });
  return plan;
}

/**
 * Apply the generator when it is ON. Variant SKUs are written in place; parent SKUs are returned (the caller
 * hands them to the serialiser that needs them).
 * @returns {{ enabled:boolean, generated:Array<{product:string, variant:string, sku:string}>, parents:Map<number,string>, keptReal:number, noSource:number }}
 */
export function generateSkus(products, options) {
  const o = skuGeneratorOptions(options);
  if (!o.enabled) return { enabled: false, generated: [], parents: new Map(), keptReal: 0, noSource: 0 };
  const plan = planSkus(products, o);
  for (const g of plan.variants) products[g.p].variants[g.vi].sku = g.sku;
  return {
    enabled: true,
    generated: [...plan.parents.map((x) => ({ product: x.product, variant: '', sku: x.sku, scope: 'parent' })), ...plan.variants.map((x) => ({ product: x.product, variant: x.variant, sku: x.sku, scope: 'variant' }))],
    parents: new Map(plan.parents.map((x) => [x.p, x.sku])),
    keptReal: plan.keptReal,
    noSource: plan.noSource,
  };
}

/** Before / after on the first `limit` variants, for the « Correspondance » step (nothing is changed). */
export function previewSkus(products, options, limit = 6) {
  const plan = planSkus(products, { ...options, enabled: true });
  const byKey = new Map(plan.variants.map((g) => [`${g.p}:${g.vi}`, g.sku]));
  const rows = [];
  (products || []).some((p, pi) => (p.variants || []).some((v, vi) => {
    rows.push({ product: p.title || p.handle || '', variant: (v.optionValues || []).filter(Boolean).join(' / '), before: v.sku || '', after: v.sku || byKey.get(`${pi}:${vi}`) || '', generated: !v.sku && byKey.has(`${pi}:${vi}`) });
    return rows.length >= limit;
  }));
  return rows;
}
