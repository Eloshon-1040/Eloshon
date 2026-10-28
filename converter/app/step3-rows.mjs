/**
 * Step 3 « Correspondance » — ONE display model for the three cases the analysis returns (a known format, a
 * recognised platform, an unknown file). Pure: plain data in, plain data out; the renderer only draws it.
 *
 * One row = one column of the FILE (never one internal entry of a format: the `variants` column of a Scraper export
 * is one row whose destinations are the SKU, the option values, the variant image…). Each row carries:
 *   • up to 3 real sample values and the fill rate (N/M rows);
 *   • a status: used / ignored / unknown (no destination) / empty (empty on every row);
 *   • its destinations: the field (a human label key on the renderer side), the REAL columns of the target file,
 *     read from the serialisers (core/src/destinations.ts), and the transformation id (a plain-language label key);
 *   • a level Sûr / À vérifier / Incertain / Vide (thresholds 0.85 / 0.60 of eloshon-csv-mapping-expert), its score,
 *     a reason code (+ params) and an origin: name / user / format / values;
 *   • an alert when the values contradict the destination (sku.mjs skuVerdict, value profiles): at least « À vérifier »;
 *   • what « Modifier » acts on (the EXISTING mode-specific actions: overrides, kb:editColumn, kb:decide);
 *   • technical details (internal field paths, transformation ids) for the folded « Détails techniques ».
 * Nothing here changes the conversion: it only describes it.
 */
import { skuVerdict, DEFAULT_SKU_GENERATOR, SKU_SOURCES, SKU_MIN_LENGTH, SKU_MAX_LENGTH, SKU_PREFIX_MAX, SKU_SEPARATORS, SKU_CASES } from '../core/knowledge-proposal/sku.mjs';
import { profileValues } from '../core/knowledge-proposal/semantic.mjs';
import { loadCanonCatalogSync, loadRecognitionConfigSync } from '../core/knowledge-proposal/reference.mjs';
import { productDestinations, entryDestinations } from '../core/dist/destinations.mjs';
import { TARGET_FIELDS, SOURCE_FIELDS, structuralColumns } from '../core/dist/index.mjs';

export const THRESHOLD_SAFE = 0.85;
export const THRESHOLD_CHECK = 0.60;
/** Display order of the levels: the lowest confidence first (system.md §5.6). */
export const LEVEL_ORDER = ['uncertain', 'check', 'ok', 'empty'];
export const levelOf = (score) => (score == null ? 'ok' : score >= THRESHOLD_SAFE ? 'ok' : score >= THRESHOLD_CHECK ? 'check' : 'uncertain');
const worst = (a, b) => (LEVEL_ORDER.indexOf(a) <= LEVEL_ORDER.indexOf(b) ? a : b);

/** Every code the renderer turns into text (i18n prefixes s3r_, s3a_, s3o_, s3k_, s3g_, s3u_, tr_): the ui-keys test
 *  checks each one has a French and an English text. */
export const REASON_CODES = ['values_are', 'name_known', 'name_close', 'format_rule', 'user_choice', 'values_only', 'weak',
  'proposal', 'tricky', 'empty', 'no_destination', 'ignored_user', 'ignored_format', 'third_party', 'structural'];
export const ALERT_CODES = ['sku_label', 'sku_phrase', 'sku_too_long', 'sku_option_name', 'sku_no_identifier', 'values_mismatch'];
export const ORIGINS = ['name', 'user', 'format', 'values'];
export const VALUE_KINDS = ['price', 'ean', 'imageUrl', 'url', 'int', 'float', 'bool', 'date', 'email', 'phone', 'html', 'path', 'list', 'text'];
const KIND_PRECEDENCE = ['ean', 'imageUrl', 'url', 'email', 'phone', 'date', 'html', 'price', 'float', 'int', 'bool'];
/** Each transformation id of the engine and the formats, in plain words (i18n tr_<key>); unknown ids → `converted`. */
const TRANSFORM_PLAIN = {
  text: 'as_is', copy: 'as_is', clean_text: 'as_is', text_present: 'as_is', copy_present: 'as_is', first_lang_value: 'as_is', string_id: 'as_is', text_matching: 'as_is', ids_to_strings: 'as_is', constant: 'converted',
  html: 'html', money: 'price', price_pick: 'price', money_if_above: 'compare', price_promo: 'price_promo', price_tiers: 'price',
  int: 'number', float: 'number', int_or_null: 'number', bool: 'yes_no', bool_not: 'yes_no', is_set: 'yes_no',
  enum: 'value_list', enum_map: 'value_list', equals_map: 'value_list', includes_map: 'value_list', regex_map: 'value_list', lookup: 'value_list', state: 'value_list', order_status: 'value_list',
  list: 'list', category_path: 'category', category_path_split: 'category', category_paths_from_breadcrumbs: 'category', category_paths_from_terms: 'category',
  images: 'images', images_from_urls: 'images', images_from_objects: 'images', image_src: 'images', first_image_src: 'images', url: 'url', source_url: 'url',
  options: 'options', options_from_attributes: 'options', options_from_columns: 'options', options_from_settings: 'options', option_values_from_typed: 'options', option_values_from_attributes: 'options', default_option_values: 'options',
  metafields: 'custom_field', metafield_pair: 'custom_field', metafields_from_object: 'custom_field', metafields_from_pairs: 'custom_field',
  weight_to_grams: 'weight', grams_from_kg: 'weight', kg_from_grams: 'weight', length_to_cm: 'length', tag_when_true: 'tag',
  attribute_single: 'attribute', attributes_rich: 'attribute', attributes_from_flat_options: 'attribute', description_section: 'description_section',
  slug_hash: 'slug', value_or_slug: 'slug', differs_from: 'translation', translations: 'translation', translations_from_entities: 'translation', translations_from_pairs: 'translation',
  vat_rate: 'vat', currency: 'currency', unit_price: 'unit_price', date_iso: 'date', timestamps: 'date', sale_period: 'date', stock_policy: 'stock',
  first_non_empty: 'first_present', first_present: 'first_present', parent_field: 'from_parent', parent_when_absent: 'from_parent', inherit_from_parent: 'from_parent',
};
export const TRANSFORM_KEYS = [...new Set([...Object.values(TRANSFORM_PLAIN), 'converted'])];
export const plainTransform = (id) => TRANSFORM_PLAIN[id] ?? 'converted';
export const GROUPS = ['identity', 'price', 'stock', 'images', 'variants', 'description', 'seo', 'other'];
export const UNFED_CODES = ['title', 'handle', 'sku', 'images', 'empty', 'required'];

const GROUP_FIELDS = {
  identity: ['title', 'handle', 'slug', 'sku', 'barcode', 'identifiers.gtin', 'identifiers.ean', 'identifiers.upc', 'identifiers.isbn', 'identifiers.mpn', 'identity.sourceId', 'parentRef', 'sourceUrl'],
  price: ['price', 'compareAtPrice', 'cost', 'vatRate', 'currency', 'unitPrice', 'taxable', 'priceTiers', 'taxClass', 'salePeriod'],
  stock: ['inventoryQty', 'stockStatus', 'stockPolicy', 'requiresShipping', 'shippingClass', 'grams', 'lengthCm', 'widthCm', 'heightCm'],
  images: ['images', 'variantImage'],
  variants: ['options', 'attributes', 'defaultOptionValues', 'kind', 'components'],
  description: ['bodyHtml', 'shortDescription', 'specifications', 'vendor', 'productType'],
  seo: ['seoTitle', 'seoDescription', 'tags', 'categories', 'visibility'],
};
export function groupOf(field) { for (const [g, fs] of Object.entries(GROUP_FIELDS)) if (fs.includes(field)) return g; return 'other'; }

// The target fields a merchant expects filled, after the platform's required ones (the « not fed » panel).
const IMPORTANT = ['sku', 'price', 'images', 'bodyHtml', 'inventoryQty', 'barcode', 'vendor', 'categories'];
// Structured values that are never judged by their profile (a JSON list, a family of columns, kept data).
const NO_PROFILE_CHECK = new Set(['metafields', 'options', 'translations', 'specifications', 'tags', 'sourceExtension', 'attributes', 'categories', 'bodyHtml', 'shortDescription']);

/** A format entry's canon path → the step-3 field it describes (variants[].price → price, tags[] → tags…). */
const VARIANT_FIELD = { imageSrc: 'variantImage', optionValues: 'options' };
const FAMILY_PREFIX = { 'stockPolicy.': 'stockPolicy', 'visibility.': 'visibility', 'digital.': 'digital', 'external.': 'external', 'merchandising.': 'merchandising', 'notes.': 'notes' };
export function fieldOfCanon(canon) {
  const c = String(canon || '').trim();
  if (c.startsWith('meta:')) return 'sourceExtension';
  if (c === 'identity.timestamps') return 'timestamps';
  if (c === 'attributesRich') return 'attributes';
  for (const [p, f] of Object.entries(FAMILY_PREFIX)) if (c.startsWith(p)) return f;
  if (c.startsWith('sourceExtension.')) return 'sourceExtension';
  if (c.startsWith('translations')) return 'translations';
  if (c === 'identity.slug') return 'slug';
  if (c === 'descriptionSections[]') return 'specifications';
  if (c === 'attributesRich[]' || c === 'attributes[]') return 'attributes';
  const v = c.match(/^variants\[\]\.(.+)$/);
  if (v) return VARIANT_FIELD[v[1]] ?? fieldOfCanon(v[1]);
  return c.replace(/\[\]$/, '');
}

const productTargetOf = (targetFormat) => ({ shopify_products: 'shopify', woo_products_modern: 'woocommerce', wix_products: 'wix', bigcommerce_products: 'bigcommerce' })[targetFormat] ?? null;

function getPath(obj, path) {
  if (obj == null) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
const asText = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * @param {object} a  the analysis (analyzeMapping's result, before `step3` is attached)
 * @param {{ headers: string[], rows: object[], fmt?: object|null, overrides?: object, direction?: string }} ctx
 */
const COUNT_ROWS = 20000;   // rows counted per column (beyond: spread over the file)
const PROFILE_VALUES = 200; // filled values a column's type is read on
/** `n` items spread evenly over the list (start, middle, end), in order. */
function spread(list, n) {
  if (list.length <= n) return list;
  return Array.from({ length: n }, (_, i) => list[Math.floor((i * list.length) / n)]);
}

export function buildStep3(a, ctx) {
  const headers = (ctx.headers || []).filter((h) => h !== '');
  // Every row is counted (a column filled only after row 200 is not « Vide »); a very large file is read on rows
  // spread over the whole file, and the screen says so (analysedRows / totalRows).
  const allRows = ctx.rows || [];
  const rows = allRows.length > COUNT_ROWS ? spread(allRows, COUNT_ROWS) : allRows;
  const cfg = loadRecognitionConfigSync();
  const catalog = loadCanonCatalogSync();
  const specOf = (field) => catalog.fields.find((f) => f.entity === 'products' && f.path === field);
  const strong = new Set(cfg.profiles.strongTyped || []);
  const targetFormat = a.targetFormat ?? a.learn?.targetFormat ?? null;
  const productTarget = productTargetOf(targetFormat);
  const table = targetFormat ? (TARGET_FIELDS[targetFormat] ?? {}) : {};
  const prodDest = productTarget ? productDestinations(productTarget) : null;
  const mode = a.learn ? 'learn' : a.knowledge ? 'knowledge' : 'plan';
  const sourceFormat = a.detection?.format;
  const entity = a.detection?.entity ?? 'products';

  // ── values of a column ────────────────────────────────────────────────────
  const valuesOf = (col) => rows.map((r) => asText(getPath(r, col)).trim());
  const info = new Map();
  for (const h of headers) {
    const vals = valuesOf(h);
    const nonEmpty = vals.filter(Boolean);
    const samples = [...new Set(nonEmpty)].slice(0, 3).map((v) => (v.length > 300 ? v.slice(0, 300) + '…' : v));
    // The type is read on the FILLED values (spread over the file), even when only one or two rows hold one.
    const sampled = spread(nonEmpty, PROFILE_VALUES);
    const profile = profileValues(sampled, { ...cfg, profiles: { ...cfg.profiles, sampleRows: PROFILE_VALUES, minNonEmpty: Math.max(1, Math.min(cfg.profiles.minNonEmpty || 3, nonEmpty.length)) } });
    info.set(h, { vals, filled: nonEmpty.length, total: vals.length, samples, profile, profiledOn: sampled.length });
  }
  // ── destinations ─────────────────────────────────────────────────────────
  const colsFor = (field, { key, entry, value } = {}) => {
    if (prodDest) {
      if (field === 'metafields') return (prodDest.metafields || []).map((c) => c.replace(/\*/g, key || '*'));
      if (Object.prototype.hasOwnProperty.call(prodDest, field)) return prodDest[field];
      if (entry) return entryDestinations(productTarget, entry, value);
      return [];
    }
    const tf = table[field];
    return tf ? tf.cols : null; // null = the target table does not describe this field
  };
  const dest = (field, o = {}) => {
    const cols = colsFor(field, o);
    const transform = o.transform ?? specOf(field)?.transform ?? null;
    return { field, cols: cols ?? [], known: cols != null, carried: !!(cols && cols.length), transform, transformKey: transform ? plainTransform(transform) : null,
      internal: o.internal ?? field, key: o.key ?? null, label: o.label ?? null };
  };

  // ── alerts: the values contradict the destination ────────────────────────
  const alertFor = (field, vals, profile) => {
    const ne = vals.filter(Boolean);
    if (!ne.length) return null;
    if (field === 'sku') {
      const bad = ne.map((v) => ({ v, r: skuVerdict(v) })).filter((x) => !x.r.ok);
      if (bad.length && bad.length * 2 >= ne.length) {
        const r = bad[0].r.reason;
        return { code: ALERT_CODES.includes('sku_' + r) ? 'sku_' + r : 'sku_label', params: { example: bad[0].v.length > 60 ? bad[0].v.slice(0, 60) + '…' : bad[0].v } };
      }
      return null;
    }
    if (NO_PROFILE_CHECK.has(field) || ne.length < 3) return null;
    const spec = specOf(field);
    if (!spec || !Array.isArray(spec.accepts) || !spec.accepts.length) return null;
    const found = (profile.profiles || []).filter((k) => strong.has(k));
    if (!found.length || found.some((k) => spec.accepts.includes(k))) return null;
    const kind = found.find((k) => VALUE_KINDS.includes(k));
    return kind ? { code: 'values_mismatch', params: { kind } } : null;
  };

  // A reason that states what the values are, when the profile is sure and agrees with the field.
  const valuesReason = (field, profile) => {
    if (NO_PROFILE_CHECK.has(field)) return null;
    const spec = specOf(field);
    const p = profile.profiles?.length ? profile.profiles : [];
    const kind = KIND_PRECEDENCE.find((k) => p.includes(k) && strong.has(k) && (!spec?.accepts || spec.accepts.includes(k)));
    return kind ? { code: 'values_are', params: { kind } } : null;
  };

  const out = [];
  const pushRow = (r) => {
    const i = info.get(r.column);
    const row = { column: r.column, samples: r.samples ?? i.samples, filled: i.filled, total: i.total, status: r.status, dests: r.dests || [],
      level: r.level ?? null, score: r.score ?? null, reason: r.reason ?? null, origin: r.origin ?? null, alert: null,
      proposal: !!r.proposal, candidates: r.candidates || [], edit: r.edit || { mode, canEdit: false }, tech: r.tech || { internal: [], transforms: [] }, context: r.context ?? null };
    // the values against each destination (child values for a column of nested variants)
    if (row.status === 'used') {
      for (const d of row.dests) {
        if (d.structural) continue;
        const vals = d.childValues ?? i.vals;
        const prof = d.childValues ? profileValues(d.childValues, cfg) : i.profile;
        const al = alertFor(d.field, vals, prof);
        if (al) { row.alert = al; d.alert = true; break; }
      }
      if (row.alert) row.level = worst(row.level || 'ok', 'check');
    }
    for (const d of row.dests) delete d.childValues;
    if (i.filled === 0) { row.status = row.status === 'ignored' || row.status === 'unknown' ? row.status : 'empty'; row.level = 'empty'; row.reason = { code: 'empty' }; row.alert = null; }
    if (row.status === 'ignored' || row.status === 'unknown') row.level = row.filled === 0 ? 'empty' : null;
    out.push(row);
  };

  // ── 1. recognised platform (a plan of rules) ─────────────────────────────
  if (mode === 'plan' && a.plan) {
    const plan = a.plan;
    const rules = SOURCE_FIELDS[sourceFormat] ?? [];
    const overrides = ctx.overrides || {};
    const sem = new Map((plan.semantic?.columns ?? []).map((c) => [c.column, c]));
    const byCol = new Map();
    const add = (col, item) => { if (!headers.includes(col)) return; if (!byCol.has(col)) byCol.set(col, []); byCol.get(col).push(item); };
    for (const b of plan.bindings) {
      if (b.editable) { if (b.resolvedColumn) add(b.resolvedColumn, { b, structural: false }); continue; }
      const fam = new Set(structuralColumns(b.transform, headers));
      if (b.resolvedColumn && headers.includes(b.resolvedColumn)) fam.add(b.resolvedColumn);
      for (const col of fam) add(col, { b, structural: true });
    }
    // a rule the user set to « do not import »: its column is ignored
    const ignoredBy = new Map();
    for (const r of rules) {
      if (!r.editable || overrides[r.id] === undefined || overrides[r.id].column !== null) continue;
      const col = headers.includes(r.column) ? r.column : (r.aliases || []).find((x) => headers.includes(x));
      if (col && !byCol.has(col)) ignoredBy.set(col, r.id);
    }
    const labelOf = (b) => (specOf(b.canon) ? null : { fr: firstSentence(b.descFr), en: firstSentence(b.descEn) });
    for (const h of headers) {
      const i = info.get(h);
      const items = byCol.get(h);
      if (items) {
        let level = 'ok', score = 1, origin = 'name', reason = null;
        const structuralOnly = items.every((x) => x.structural);
        const dests = items.map(({ b, structural }) => ({ ...dest(b.canon, { transform: b.transform, internal: b.canon, label: labelOf(b) }), ...(structural ? { structural: true } : {}) }));
        for (const { b, structural } of items) {
          if (structural) continue;
          const userOwn = b.overridden && !b.prefilled;
          if (userOwn) { origin = 'user'; reason = reason ?? { code: 'user_choice' }; continue; }
          const s = b.score ?? 1;
          score = Math.min(score, s);
          let l = levelOf(s);
          if (b.confidence === 'check') l = worst(l, 'check');
          if (b.confidence === 'low') l = worst(l, 'uncertain');
          level = worst(level, l);
          const c = sem.get(h);
          if (b.prefilled && c?.best && c.best.name?.via === 'none') origin = 'values';
          if (SOURCE_FIELDS[sourceFormat]?.find((r) => r.id === b.id)?.reviewAlways) reason = { code: 'tricky' };
          else if (b.prefilled || !b.applied) reason = reason ?? { code: 'name_close' };
        }
        if (structuralOnly) {
          const sem1 = sem.get(h);
          reason = sem1?.context?.metafield?.owner === 'thirdParty' ? { code: 'third_party' } : { code: 'structural' };
        }
        if (!reason) reason = valuesReason(dests[0].field, i.profile) ?? { code: 'name_known' };
        const ruleIds = items.filter((x) => !x.structural).map((x) => x.b.id);
        pushRow({ column: h, status: 'used', dests, level, score: structuralOnly ? null : score, origin: reason.code === 'user_choice' ? 'user' : origin, reason,
          edit: { mode, canEdit: !structuralOnly, ruleIds, semantic: false }, context: ctxOf(sem.get(h)),
          tech: { internal: items.map((x) => x.b.canon), transforms: items.map((x) => x.b.transform), rules: items.map((x) => x.b.id) } });
        continue;
      }
      if (ignoredBy.has(h)) {
        pushRow({ column: h, status: 'ignored', reason: { code: 'ignored_user' }, origin: 'user', edit: { mode, canEdit: true, ignoredRule: ignoredBy.get(h), ruleIds: [] }, tech: { internal: [], transforms: [], rules: [ignoredBy.get(h)] } });
        continue;
      }
      pushRow(semanticRow(h, sem.get(h), { mode, proposal: true }));
    }
  }

  // ── 2. a known format (knowledge entries) ─────────────────────────────────
  if (mode === 'knowledge' && !a.knowledge.canonNative) {
    const K = a.knowledge;
    const fmt = ctx.fmt;
    const entries = (fmt?.fields ?? K.fields ?? []).map((e) => ({ ...e }));
    const inline = fmt?.structure?.variants?.inlinePath ?? null;
    const learned = K.origin !== 'reference';
    const edited = K.edited || {};
    const byCol = new Map();
    const add = (col, e) => { if (!headers.includes(col)) return; if (!byCol.has(col)) byCol.set(col, []); byCol.get(col).push(e); };
    for (const e of entries) {
      if (e.when === 'child') { if (inline) add(inline, e); continue; }
      for (const col of new Set([e.path, ...(e.inputs ?? []), ...(e.consumes ?? [])])) add(col, e);
    }
    // the values of one key inside a column of nested variants (JSON list)
    const childValues = (col, key) => {
      const out2 = [];
      for (const v of info.get(col)?.vals ?? []) {
        if (!v || !/^[[{]/.test(v)) continue;
        try { const arr = JSON.parse(v); for (const x of Array.isArray(arr) ? arr : [arr]) { const c = x && x[key]; if (c != null && String(c).trim()) out2.push(String(c).trim()); } } catch { /* not JSON: no child values */ }
      }
      return out2;
    };
    for (const h of headers) {
      const es = byCol.get(h);
      const mine = Object.prototype.hasOwnProperty.call(edited, h);
      if (!es || !es.length) { pushRow({ column: h, status: 'unknown', reason: { code: 'no_destination' }, edit: { mode, canEdit: !learned, edited: mine ? edited[h] : null }, tech: { internal: [], transforms: [] } }); continue; }
      const real = es.filter((e) => e.canon != null && e.transform !== 'ignore' && e.transform !== 'inherit_from_parent');
      if (!real.length) {
        pushRow({ column: h, status: 'ignored', reason: { code: mine ? 'ignored_user' : 'ignored_format' }, origin: mine ? 'user' : 'format',
          edit: { mode, canEdit: !learned, edited: mine ? edited[h] : null }, tech: { internal: es.map((e) => e.canon ?? '—'), transforms: es.map((e) => e.transform) } });
        continue;
      }
      const first = info.get(h).vals.find(Boolean);
      const seen = new Set();
      const dests = [];
      for (const e of real.flatMap((x) => String(x.canon).split('+').map((c) => ({ ...x, canon: c.trim() })))) {
        const field = fieldOfCanon(e.canon);
        const key = field === 'metafields' ? (e.args?.key ?? e.path) : null;
        const k = field + '|' + (key ?? '');
        if (seen.has(k)) continue; seen.add(k);
        const d = dest(field, { key, transform: e.transform, internal: e.canon, entry: e, value: e.when === 'child' ? undefined : first });
        if (e.when === 'child') d.childValues = childValues(h, e.path);
        dests.push(d);
      }
      // a column of nested variants shows the variants' own values, not the raw JSON
      const shown = h === inline ? [...new Set(childValues(h, fmt?.structure?.options?.fromVariants?.value ?? 'name'))].slice(0, 3) : null;
      const userOwn = mine || learned;
      const reason = mine ? { code: 'user_choice' } : (valuesReason(dests[0].field, info.get(h).profile) ?? { code: 'format_rule' });
      pushRow({ column: h, status: 'used', dests, level: 'ok', score: 1, origin: userOwn ? 'user' : 'format', reason, ...(shown && shown.length ? { samples: shown } : {}),
        edit: { mode, canEdit: !learned, edited: mine ? edited[h] : null },
        tech: { internal: real.map((e) => e.canon + (e.when ? ` (${e.when === 'child' ? e.path : e.when})` : '')), transforms: [...new Set(real.map((e) => e.transform))] } });
    }
  }

  // ── 3. an unknown file (learn mode: every column is a proposal) ───────────
  if (mode === 'learn') {
    const sem = new Map(a.learn.semantic.columns.map((c) => [c.column, c]));
    for (const h of headers) pushRow(semanticRow(h, sem.get(h), { mode, proposal: false }));
  }

  function ctxOf(c) { return c?.context ? { owner: c.context.metafield?.owner ?? null, locale: c.context.translation?.locale ?? null } : null; }
  // A column the semantic recogniser read (learn mode, or a platform file's column no rule reads).
  function semanticRow(h, c, { mode: m, proposal }) {
    const edit = { mode: m, canEdit: true, semantic: true, status: c?.status ?? 'none', best: c?.best?.canon ?? null, ruleIds: [] };
    const candidates = (c?.candidates ?? []).filter((x) => x.score >= 0.3 || x.decision).slice(0, 3).map((x) => ({ field: x.canon, score: x.score }));
    const tech = { internal: c?.best ? [c.best.canon] : [], transforms: [], reasons: c?.best?.reasons ?? [] };
    const context = ctxOf(c);
    if (!c || c.status === 'none' || !c.best) {
      return { column: h, status: 'unknown', reason: { code: c?.context?.metafield?.owner === 'thirdParty' ? 'third_party' : 'no_destination' }, candidates, edit, tech, context };
    }
    if (c.status === 'ignored') return { column: h, status: 'ignored', reason: { code: 'ignored_user' }, origin: 'user', candidates, edit, tech, context };
    const key = c.best.canon === 'metafields' ? (c.best.decision?.args?.key ?? null) : null;
    const d = dest(c.best.canon, { key: key ?? h, internal: c.best.canon });
    if (c.status === 'decided') return { column: h, status: 'used', dests: [d], level: 'ok', score: 1, origin: 'user', reason: { code: 'user_choice' }, candidates, edit, tech, context };
    const via = c.best.name?.via ?? 'none';
    const origin = via === 'none' ? 'values' : 'name';
    const score = c.best.score;
    const level = levelOf(score);
    const vr = valuesReason(c.best.canon, info.get(h).profile);
    const reason = proposal ? { code: 'proposal' }
      : origin === 'values' ? { code: 'values_only' }
      : level === 'uncertain' ? { code: 'weak' }
      : level === 'check' ? (vr ?? { code: 'name_close' })
      : (vr ?? { code: 'name_known' });
    return { column: h, status: 'used', dests: [d], level, score, origin, reason, proposal, candidates, edit, tech, context };
  }

  // ── the platform's fields no column feeds (required first, then important) ──
  const fed = new Set(out.filter((r) => r.status === 'used' || r.status === 'empty').flatMap((r) => (r.status === 'used' ? r.dests.map((d) => d.field) : [])));
  // a typed identifier feeds the barcode (catalogue derivation)
  if (['identifiers.gtin', 'identifiers.ean', 'identifiers.upc', 'identifiers.isbn'].some((f) => fed.has(f))) fed.add('barcode');
  const unfed = [];
  if (targetFormat && entity === 'products' && prodDest) {
    const required = Object.entries(table).filter(([, v]) => v.required).map(([k]) => k);
    for (const f of required) if (!fed.has(f)) unfed.push({ field: f, cols: table[f].cols, required: true, consequence: f === 'title' ? 'title' : f === 'handle' ? 'handle' : 'required' });
    for (const f of IMPORTANT) {
      if (fed.has(f) || required.includes(f) || !(table[f]?.cols?.length)) continue;
      unfed.push({ field: f, cols: table[f].cols, required: false, consequence: f === 'sku' ? 'sku' : f === 'images' ? 'images' : 'empty' });
    }
  } else if (targetFormat) {
    for (const [f, v] of Object.entries(table)) if (v.required && !fed.has(f)) unfed.push({ field: f, cols: v.cols, required: true, consequence: 'required' });
  }

  // ── what « Modifier » offers (the existing actions of each mode) ─────────
  let choices = [];
  if (mode === 'plan') {
    const seen = new Set();
    for (const r of SOURCE_FIELDS[sourceFormat] ?? []) {
      if (!r.editable || seen.has(r.canon)) continue; seen.add(r.canon);
      const cols = colsFor(r.canon);
      choices.push({ field: r.canon, ruleId: r.id, cols: cols ?? [], carried: !!(cols && cols.length), group: groupOf(r.canon), label: specOf(r.canon) ? null : { fr: firstSentence(r.descFr), en: firstSentence(r.descEn) } });
    }
  } else if (mode === 'learn' || (mode === 'knowledge' && a.knowledge.origin === 'reference')) {
    for (const f of (a.knowledge?.choices?.length ? a.knowledge.choices : ctx.editChoices ?? [])) {
      const cols = colsFor(f);
      choices.push({ field: f, cols: cols ?? [], carried: !!(cols && cols.length), group: groupOf(f), label: null });
    }
  }
  const customCols = prodDest ? (prodDest.metafields || []) : [];

  // ── order: the lowest confidence first, ignored and unknown last; file order inside ──
  const rank = (r) => (r.level ? LEVEL_ORDER.indexOf(r.level) : LEVEL_ORDER.length);
  const sorted = out.map((r, i) => ({ r, i })).sort((x, y) => rank(x.r) - rank(y.r) || x.i - y.i).map((x) => x.r);

  const counts = { todo: 0, all: sorted.length, ok: 0, check: 0, uncertain: 0, empty: 0, ignored: 0 };
  for (const r of sorted) {
    if (r.status === 'ignored' || r.status === 'unknown') { if (r.level === 'empty') counts.empty++; else counts.ignored++; continue; }
    if (r.level) counts[r.level]++;
  }
  counts.todo = counts.check + counts.uncertain;

  const memory = mode === 'knowledge' ? (a.knowledge.origin === 'reference' ? 'format' : 'learned') : 'column';
  // The SKU generator's real rules (core/knowledge-proposal/sku.mjs), for its settings at step 3 (products only).
  const sku = entity === 'products' && productTarget ? { defaults: { ...DEFAULT_SKU_GENERATOR }, sources: SKU_SOURCES, separators: SKU_SEPARATORS, cases: SKU_CASES,
    minLength: SKU_MIN_LENGTH, maxLength: SKU_MAX_LENGTH, prefixMax: SKU_PREFIX_MAX, parentByDefault: productTarget === 'woocommerce' } : null;
  return { sku, mode, target: productTarget ?? (targetFormat ? String(targetFormat).split('_')[0] : null), targetFormat, entity, rows: sorted, counts, unfed,
    choices, customCols, memory, rowCount: allRows.length, analysedRows: rows.length };
}

function firstSentence(s) { const t = String(s || '').trim(); const m = t.match(/^(.+?)[.:](\s|$)/); return (m ? m[1] : t).trim(); }
