import { readEloshon, CommandLog, ELOSHON_KIND } from '../vendor/eloshon-catalog/index.mjs';
import type { EloshonFile, EditCommand } from '../vendor/eloshon-catalog/index.mjs';
import type { CanonProduct, CanonVariant, CanonCustomer, CanonOrder, Entity, Warning } from './types';
import { scanForCardData } from '../knowledge-proposal/pci-scanner.mjs';

// ── .eloshon reader (Phase 2 Lot 2 — reader only, owner decision A) ──────────
// An .eloshon file is the suite's own versioned envelope around a catalogue
// that is ALREADY in the canon IR (@eloshon/catalog CatalogProduct = Canon +
// id / sourceUrl / sourceProductId / strategy / confidence). Reading it is not
// a field mapping, so there is no knowledge entry: the catalog's own
// readEloshon validates + migrates the envelope (unknown fields kept), the
// edit command log is replayed over the frozen source with CommandLog, and
// each applied edit becomes PROVENANCE on the field it changed.
//
// Nothing is dropped: the catalog extras land in sourceExtension.eloshon under
// the SAME keys the products.json entry uses (source_url, extractor,
// confidence), any other unknown product key is preserved + listed unknown,
// and every non-applied edit / removed product / unconverted entity / format
// migration is reported as a warning code (localised by the app).

export const ELOSHON_SOURCE_FORMAT = 'eloshon.catalog.v1';
export const ELOSHON_DISPLAY_NAME = 'Eloshon (.eloshon)';

const PLATFORM = 'eloshon';
const MAX_PROVENANCE_VALUE = 200;

// Every CanonProduct key (@eloshon/catalog). Anything else on a catalog
// product is an extra: mapped (the products.json overlap) or preserved.
const CANON_PRODUCT_KEYS = new Set([
  'handle', 'title', 'bodyHtml', 'vendor', 'productType', 'tags', 'status', 'categories', 'published', 'options',
  'variants', 'images', 'metafields', 'seoTitle', 'seoDescription', 'identity', 'kind', 'visibility', 'merchandising',
  'notes', 'external', 'digital', 'attributesRich', 'defaultOptionValues', 'translations', 'sourceExtension', 'unmapped', 'provenance',
]);

export type EloshonRead =
  | { ok: false; code: string; params?: Record<string, string | number> }
  | {
      ok: true;
      file: EloshonFile;
      entity: Entity | null;
      products: CanonProduct[];
      customers: CanonCustomer[];
      orders: CanonOrder[];
      warnings: Warning[];
    };

/** Cheap shape test: a JSON object whose `eloshon` header names a catalog. */
function envelopeOf(text: string): Record<string, unknown> | null {
  const t = (text || '').replace(/^﻿/, '').trimStart();
  if (!t.startsWith('{')) return null;
  let obj: unknown;
  try { obj = JSON.parse(t); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const head = (obj as Record<string, unknown>).eloshon;
  if (!head || typeof head !== 'object') return null;
  return obj as Record<string, unknown>;
}

/** Is this text an .eloshon envelope (readable or not)? */
export function isEloshonText(text: string): boolean {
  return envelopeOf(text) !== null;
}

function slugify(s: string): string {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'product';
}
function provenanceValue(v: unknown): unknown {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > MAX_PROVENANCE_VALUE ? v.slice(0, MAX_PROVENANCE_VALUE) + '…' : v;
  return undefined;
}
const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const asString = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

function canonVariant(v: Record<string, unknown>): CanonVariant {
  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  return {
    ...v,
    optionValues: asArray<string>(v.optionValues).map(asString),
    sku: asString(v.sku), price: num(v.price), compareAtPrice: num(v.compareAtPrice), cost: num(v.cost),
    barcode: asString(v.barcode), grams: num(v.grams), lengthCm: num(v.lengthCm), widthCm: num(v.widthCm), heightCm: num(v.heightCm),
    requiresShipping: v.requiresShipping !== false, taxable: v.taxable !== false, inventoryQty: num(v.inventoryQty), imageSrc: asString(v.imageSrc),
  } as CanonVariant;
}

/** One catalog product → a CanonProduct: required fields defaulted (the CSV
 *  serialisers need them), catalog extras mapped or preserved. */
function canonProduct(cp: Record<string, unknown>): CanonProduct {
  const p: Record<string, unknown> = {};
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cp)) (CANON_PRODUCT_KEYS.has(k) ? p : extras)[k] = v;
  const product = {
    ...p,
    handle: asString(p.handle), title: asString(p.title), bodyHtml: asString(p.bodyHtml), vendor: asString(p.vendor), productType: asString(p.productType),
    tags: asArray<string>(p.tags).map(asString),
    status: p.status === 'draft' || p.status === 'archived' ? p.status : 'active',
    categories: asArray<string>(p.categories).map(asString),
    published: p.published !== false,
    options: asArray<{ name: string; values: string[] }>(p.options),
    variants: asArray<Record<string, unknown>>(p.variants).map(canonVariant),
    images: asArray<CanonProduct['images'][number]>(p.images),
    metafields: asArray<CanonProduct['metafields'][number]>(p.metafields),
    seoTitle: asString(p.seoTitle), seoDescription: asString(p.seoDescription),
  } as CanonProduct;
  const provenance: Record<string, unknown> = { ...((product.provenance as Record<string, unknown> | undefined) ?? {}) };
  if (!product.handle) {
    product.handle = slugify(product.variants[0]?.sku || product.title || 'product');
    provenance.handle = { platform: PLATFORM, sourceField: product.variants[0]?.sku ? 'variants[0].sku' : 'title', transform: 'slugify', method: 'default' };
  }
  // A product with no variant at all still needs one (every target writes a row per variant).
  if (product.variants.length === 0) product.variants = [canonVariant({})];

  const ns: Record<string, unknown> = { ...(((product.sourceExtension as Record<string, Record<string, unknown>> | undefined) ?? {})[PLATFORM] ?? {}) };
  const unmapped = [...(product.unmapped ?? [])];
  const keep = (key: string, value: unknown) => { if (value !== undefined && value !== null && value !== '') ns[key] = value; };
  for (const [k, v] of Object.entries(extras)) {
    if (k === 'id') keep('eloshon_id', v);
    else if (k === 'sourceUrl') keep('source_url', v);
    else if (k === 'strategy') keep('extractor', v);
    else if (k === 'confidence') keep('confidence', v);
    else if (k === 'sourceProductId') {
      if (!product.identity?.sourceId && v != null && v !== '') {
        product.identity = { ...(product.identity ?? {}), sourceId: asString(v) };
        provenance['identity.sourceId'] = { platform: PLATFORM, sourceField: 'sourceProductId', sourceValue: provenanceValue(v), transform: 'string_id', method: 'exact' };
      } else keep('source_product_id', v);
    } else {
      const raw = (ns._raw as Record<string, unknown> | undefined) ?? {};
      raw[k] = v; ns._raw = raw;
      unmapped.push({ platform: PLATFORM, sourceField: k, sourceValue: v, reason: 'unknown' });
    }
  }
  if (Object.keys(ns).length) product.sourceExtension = { ...(product.sourceExtension ?? {}), [PLATFORM]: ns };
  if (unmapped.length) product.unmapped = unmapped;
  if (Object.keys(provenance).length) product.provenance = provenance as CanonProduct['provenance'];
  return product;
}

// Where an edited top-level field lives on the canon product: a canon key stays
// itself; a catalog extra lands under sourceExtension (canonProduct below).
const EXTRA_PATHS: Record<string, string> = {
  id: 'sourceExtension.eloshon.eloshon_id', sourceUrl: 'sourceExtension.eloshon.source_url',
  strategy: 'sourceExtension.eloshon.extractor', confidence: 'sourceExtension.eloshon.confidence',
  sourceProductId: 'identity.sourceId',
};
function canonPathOf(field: string): string {
  if (CANON_PRODUCT_KEYS.has(field)) return field;
  return EXTRA_PATHS[field] ?? `sourceExtension.eloshon._raw.${field}`;
}

/** Replay the edit log over the frozen source, one command at a time: an edit
 *  that cannot apply (unknown product, unsupported kind such as 'restore') is
 *  SKIPPED and reported, never silently dropped and never fatal. Returns the
 *  edited products and, per product id, the provenance of each edited field. */
function replayEdits(source: Record<string, unknown>[], commands: EditCommand[]) {
  // The source products are untyped JSON until canonProduct() normalises them.
  const log = new CommandLog(source as unknown as ConstructorParameters<typeof CommandLog>[0]);
  const skipped: { kind: string; reason: string }[] = [];
  const touched = new Map<string, Record<string, unknown>>();
  commands.forEach((cmd, i) => {
    // a bulk edit naming products that are not (or no longer) in the catalogue
    // applies to the others silently in CommandLog: report the missing targets
    const present = new Set((log.products as Record<string, unknown>[]).map((p) => asString(p.id)));
    const missing = cmd?.kind === 'bulk-set-field' ? asArray<string>(cmd.productIds).filter((id) => !present.has(asString(id))) : [];
    try {
      log.apply({ ...cmd });
    } catch (err) {
      skipped.push({ kind: asString(cmd?.kind) || '?', reason: String((err as Error)?.message || err) });
      return;
    }
    for (const id of missing) skipped.push({ kind: 'bulk-set-field', reason: `unknown productId ${asString(id)}` });
    if ((cmd.kind === 'set-field' || cmd.kind === 'bulk-set-field') && cmd.field) {
      const ids = cmd.kind === 'set-field' ? [cmd.productId] : asArray<string>(cmd.productIds).filter((id) => present.has(asString(id)));
      for (const id of ids) {
        if (id == null) continue;
        const map = touched.get(String(id)) ?? {};
        map[canonPathOf(cmd.field)] = {
          platform: PLATFORM, sourceField: `edits.commands[${i}]`,
          ...(provenanceValue(cmd.value) !== undefined ? { sourceValue: provenanceValue(cmd.value) } : {}),
          transform: cmd.kind, method: 'override',
          note: `user edit${cmd.label ? ': ' + asString(cmd.label) : ''}${cmd.at ? ' (' + asString(cmd.at) + ')' : ''}`,
        };
        touched.set(String(id), map);
      }
    }
  });
  return { products: log.products as Record<string, unknown>[], applied: log.count, skipped, touched };
}

/**
 * Read an .eloshon text into canon units. Returns null when the text is not
 * an .eloshon envelope at all (the caller tries the other paths), { ok:false,
 * code } when it IS one but cannot be read (not a catalog, newer version, no
 * migration path, malformed), else the canon units of the entity converted.
 */
export function readEloshonText(text: string): EloshonRead | null {
  const env = envelopeOf(text);
  if (!env) return null;
  const head = env.eloshon as Record<string, unknown>;
  if (head.kind !== ELOSHON_KIND) return { ok: false, code: 'eloshon_unreadable', params: { detail: `kind ${asString(head.kind) || '?'}` } };
  let file: EloshonFile, migratedFrom: number | null;
  try {
    ({ file, migratedFrom } = readEloshon(env));
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    if (/newer than supported/.test(msg)) return { ok: false, code: 'eloshon_too_new', params: { version: asString(head.version) } };
    return { ok: false, code: 'eloshon_unreadable', params: { detail: msg.replace(/^readEloshon:\s*/, '') } };
  }
  const warnings: Warning[] = [];
  if (migratedFrom !== null) warnings.push({ code: 'eloshon_migrated', params: { from: migratedFrom, to: Number(file.eloshon.version) } });

  const sourceProducts = asArray<Record<string, unknown>>(file.catalog.products);
  const commands = asArray<EditCommand>(file.edits?.commands);
  const { products: edited, applied, skipped, touched } = replayEdits(sourceProducts, commands);
  if (applied) warnings.push({ code: 'eloshon_edits_applied', params: { count: applied } });
  if (skipped.length) warnings.push({ code: 'eloshon_edits_skipped', params: { count: skipped.length, kinds: [...new Set(skipped.map((s) => s.kind))].join(', ') } });
  const removed = sourceProducts.length - edited.length;
  if (removed > 0) warnings.push({ code: 'eloshon_products_removed', params: { count: removed } });

  // 7.7 — the card-data scanner runs on every ingested object BEFORE anything
  // reads or preserves it, like every other source path.
  const sp = scanForCardData(edited), sc = scanForCardData(asArray<CanonCustomer>(file.catalog.customers)), so = scanForCardData(asArray<CanonOrder>(file.catalog.orders));
  const findings = [...sp.findings, ...sc.findings, ...so.findings];
  if (findings.length) warnings.unshift({ code: 'pci_card_data_stripped', params: { count: findings.length, columns: [...new Set(findings.map((f) => f.path))].join(', ') } });
  const products = sp.value.map((cp) => {
    const p = canonProduct(cp);
    const edits = touched.get(asString(cp.id));
    if (edits) p.provenance = { ...(p.provenance ?? {}), ...edits } as CanonProduct['provenance'];
    return p;
  });
  const customers = sc.value;
  const orders = so.value;

  // One entity per conversion run: products first, then customers, then orders.
  const entity: Entity | null = products.length ? 'products' : customers.length ? 'customers' : orders.length ? 'orders' : null;
  const others = { products: entity === 'products' ? 0 : products.length, customers: entity === 'customers' ? 0 : customers.length, orders: entity === 'orders' ? 0 : orders.length };
  if (others.products + others.customers + others.orders > 0) warnings.push({ code: 'eloshon_other_entities', params: others });
  return { ok: true, file, entity, products, customers, orders, warnings };
}
