import type { ConvertResult, Direction, Platform, Entity, CanonProduct, CanonCustomer, RowError, Warning } from './types';
import { parseCsv } from './csv';
import { detectFormat, extractJsonItems, matchJsonFormat, jsonFormatPlatform } from './detect';
import type { Detection } from './detect';
import type { FormatKnowledge } from '../knowledge-proposal/schema';
import { parseWithKnowledge, applyCanonDerivations } from '../knowledge-proposal/generic-parser.mjs';
import { scanTable } from '../knowledge-proposal/pci-scanner.mjs';
import { loadReferenceFormatsSync, loadCanonCatalogSync } from '../knowledge-proposal/reference.mjs';
import { applyOverridesToTable } from './mapping';
import { guardSkus, generateSkus, parentSkus, previewSkus } from '../knowledge-proposal/sku.mjs';
import type { SkuGeneratorOptions } from '../knowledge-proposal/sku.mjs';
import type { MappingOverrides } from './mapping';
import { applyCorrectionsToTable } from './problems';
import type { Corrections } from './problems';
import {
  parsePrestaCategories, parseBigBuyStandard, parseBigBuyPresta, mergeLanguage, bigbuyLosses,
} from './bigbuy';
import {
  parseShopifyProducts, parseWooModern,
  serializeShopifyProducts, serializeWooModern,
  productLossesToWoo, productLossesToShopify, carryPivotExtras,
  dedupeHandles, duplicateSkuWarnings, wooParentSkuWarnings, parentSkuFromSource, buildRedirects,
} from './products';
import type { Table, Row } from './csv';
import { serializeProductsFor, noSerializer } from './serialize';

// Column-shift heads-up shared by every products path.
function malformedWarning(table: Table): Warning[] {
  const out: Warning[] = [];
  // lines a spreadsheet had pasted whole into their first cell, split back into columns
  if (table.unwrappedLines?.length) out.push({ code: 'rows_unwrapped', params: { count: table.unwrappedLines.length, rows: table.unwrappedLines.slice(0, 10).join(', ') + (table.unwrappedLines.length > 10 ? '…' : '') } });
  if (!table.malformed.length) return out;
  const rows = table.malformed.slice(0, 10).join(', ') + (table.malformed.length > 10 ? '…' : '');
  return [...out, { code: 'malformed_rows', params: { rows } }];
}

// WooCommerce and BigCommerce both read the ID column as their own database key,
// so a carried-over ID overwrites an existing product. We drop it and say so —
// especially for supplier feeds or a file exported from another store.
function idRemovedNote(target: Platform): Warning {
  return { code: target === 'bigcommerce' ? 'id_removed_bc' : 'id_removed_woo' };
}
import {
  serializeShopifyCustomers, serializeWooCustomers,
  customerWarnings, customerLossesToShopify, customerLossesToWoo,
} from './customers';
import {
  parseWooOrders, parseShopifyOrders,
  serializeShopifyOrders, serializeWooOrders,
  orderLossesToShopify, orderLossesToWoo,
} from './orders';
import { parseWixProducts, serializeWixProducts, wixSourceLosses, wixTargetLosses } from './wix';
import { stockModeFor, applyStockMode, platformLimitLosses, isScrapedFormat } from './variant-policy';
import { nameGenericAxes, groupColourFamilies, combineFlatAxes } from './families';
import type { StockMode } from './variant-policy';
import {
  parseBigCommerceProducts, parseBigCommerceOrders,
  serializeBigCommerceProducts, serializeBigCommerceCustomers,
  bcProductSourceLosses, bcProductTargetLosses, bcCustomerTargetLosses, bcOrderSourceLosses,
} from './bigcommerce';
import { capabilityFor } from './capability';
import { readEloshonText, ELOSHON_SOURCE_FORMAT, ELOSHON_DISPLAY_NAME } from './eloshon';
import { annotateUnits } from '../knowledge-proposal/legacy-units.mjs';
import { parseCustomersTable, parseProductsTable, isGenericParsed } from './units';
import { overrideColumnsFor } from './mapping';
import { placeCustomFields } from './custom-fields';
export { placeCustomFields, CUSTOM_CHOICES, TYPE_KEY } from './custom-fields';
import type { PreservedReport, UnmappedEntry } from './types';

// ── Phase 2 Lot 3 — uniform preservation + provenance ────────────────────────
// A CSV format whose canon values come from a bespoke parser is still
// DESCRIBED by its knowledge entry (fields + structure.rows). Once the entry
// carries that description (data), the generic pass annotates the parser's
// units: undeclared columns preserved + listed, declared columns traced. The
// serialisers ignore both channels, so the exported files are unchanged.
function annotateLegacy(det: Detection, opts: ConvertOptions, table: Table, units: object[], childKey: 'variants' | 'lineItems', warnings: Warning[]): void {
  const format = (opts.knowledge?.formats ?? loadReferenceFormatsSync()).find((f) => f.id === det.knowledgeId);
  // a format the generic parser reads preserves and traces by itself
  if (!format || !format.fields?.length || isGenericParsed(format)) return;
  const r = annotateUnits(format, table, units, { childKey, overrideColumns: overrideColumnsFor(det.format, opts.mapping?.overrides) });
  if (!r.aligned) warnings.push({ code: 'preservation_unaligned', params: { format: format.displayName || det.format } });
}

// What the canon kept outside its own fields, summarised for the user (every
// source path: legacy CSV, knowledge CSV/JSON, products.json, .eloshon).
type Preservable = { unmapped?: UnmappedEntry[]; variants?: { unmapped?: UnmappedEntry[] }[]; items?: { unmapped?: UnmappedEntry[] }[] };
export function preservedReportOf(units: object[]): PreservedReport | undefined {
  const byField = new Map<string, { field: string; reason: string; units: Set<number> }>();
  let carrying = 0;
  units.forEach((raw, i) => {
    const u = raw as Preservable;
    // a blank cell is not data: only entries that actually carry a value count
    const blank = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.every(blank));
    const all = [...(u.unmapped ?? []), ...(u.variants ?? []).flatMap((v) => v.unmapped ?? []), ...(u.items ?? []).flatMap((it) => it.unmapped ?? [])]
      .filter((e) => !blank(e.sourceValue));
    if (!all.length) return;
    carrying++;
    for (const e of all) {
      const reason = String(e.reason ?? 'unknown');
      const key = `${e.sourceField}\u0000${reason}`;
      if (!byField.has(key)) byField.set(key, { field: e.sourceField, reason, units: new Set() });
      byField.get(key)!.units.add(i);
    }
  });
  if (!carrying) return undefined;
  return { units: carrying, fields: [...byField.values()].map((x) => ({ field: x.field, reason: x.reason, units: x.units.size })) };
}
import type { CanonOrder, FormatId, Loss, DiagParams, ConsentReport, NumberingReport } from './types';
import type { DateOrder } from './normalize';

// A direction is "<from>-to-<to>"; the target platform is the second half.
function targetPlatformOf(direction: Direction): Platform {
  return direction.split('-to-')[1] as Platform;
}
function platformName(p: Platform): string {
  switch (p) {
    case 'shopify': return 'Shopify';
    case 'woocommerce': return 'WooCommerce';
    case 'wix': return 'Wix';
    case 'bigcommerce': return 'BigCommerce';
    case 'bigbuy': return 'BigBuy';
    case 'eloshon': return 'Eloshon Scraper';
    case 'shopware': return 'Shopware';
    case 'prestashop': return 'PrestaShop';
  }
}
// The short target tag the uniform loss codes use (loss_<target>_<concept>).
function lossTag(target: Platform): 'shopify' | 'woo' | 'wix' | 'bc' {
  return target === 'woocommerce' ? 'woo' : target === 'bigcommerce' ? 'bc' : target === 'wix' ? 'wix' : 'shopify';
}

// ── Target-platform dispatch (products / customers / orders) ──────────────────
// Products: core/src/serialize.ts (shared with the destination probe of step 3, core/src/destinations.ts).
function productFormatOf(target: Platform): FormatId {
  switch (target) {
    case 'shopify': return 'shopify_products';
    case 'woocommerce': return 'woo_products_modern';
    case 'wix': return 'wix_products';
    case 'bigcommerce': return 'bigcommerce_products';
    default: return noSerializer(target);
  }
}
function productLossesFor(source: Platform, target: Platform, products: CanonProduct[]): Loss[] {
  const targetLosses = target === 'woocommerce' ? productLossesToWoo(products)
    : target === 'wix' ? wixTargetLosses(products)
    : target === 'bigcommerce' ? bcProductTargetLosses(products)
    : productLossesToShopify(products);
  const sourceLosses = source === 'wix' ? wixSourceLosses(products)
    : source === 'bigcommerce' ? bcProductSourceLosses(products)
    : [];
  return [...sourceLosses, ...targetLosses];
}

function serializeCustomersFor(target: Platform, customers: CanonCustomer[]): { headers: string[]; rows: Row[] } {
  switch (target) {
    case 'shopify': return serializeShopifyCustomers(customers);
    case 'woocommerce': return serializeWooCustomers(customers);
    case 'bigcommerce': return serializeBigCommerceCustomers(customers);
    default: return noSerializer(target);
  }
}
function customerFormatOf(target: Platform): FormatId {
  switch (target) {
    case 'shopify': return 'shopify_customers';
    case 'woocommerce': return 'woo_customers';
    case 'bigcommerce': return 'bigcommerce_customers';
    default: return noSerializer(target);
  }
}
function customerLossesFor(target: Platform, customers: CanonCustomer[]): Loss[] {
  return target === 'woocommerce' ? customerLossesToWoo()
    : target === 'bigcommerce' ? bcCustomerTargetLosses()
    : customerLossesToShopify(customers);
}

function serializeOrdersFor(target: Platform, orders: CanonOrder[]): { headers: string[]; rows: Row[] } {
  return target === 'woocommerce' ? serializeWooOrders(orders) : serializeShopifyOrders(orders);
}
function orderFormatOf(target: Platform): FormatId {
  return target === 'woocommerce' ? 'woo_orders' : 'shopify_orders';
}
function orderLossesFor(source: Platform, target: Platform, orders: CanonOrder[] = []): Loss[] {
  const targetLosses = target === 'woocommerce' ? orderLossesToWoo() : orderLossesToShopify(orders);
  const sourceLosses = source === 'bigcommerce' ? bcOrderSourceLosses() : [];
  return [...sourceLosses, ...targetLosses];
}

export { parseCsv, serializeCsv } from './csv';
export { parseJsonWithKnowledge, parseWooRestJson, parseShopwareAdminJson, parseShopifyAdminJson, parseCsvWithKnowledge, learnFormat, proposeFormatId, parseOrdersJson, parseCustomersJson } from './adapters';
export type { JsonCompanions, ParsedCanon, ParsedOrders, ParsedCustomers } from './adapters';
export { detectFormat, matchesExpected, detectJson, extractJsonItems, matchJsonFormat, jsonFormatPlatform, jsonShapePaths } from './detect';
export type { JsonDetection } from './detect';
export { readEloshonText, isEloshonText, ELOSHON_SOURCE_FORMAT, ELOSHON_DISPLAY_NAME } from './eloshon';
export type { EloshonRead } from './eloshon';
export {
  analyzePlan, validatePlan, hasMappingPlan, applyOverridesToTable, semanticAnalyze, summarizeColumns, structuralColumns,
  SOURCE_FIELDS, TARGET_FIELDS, MAPPING_RULES_VERSION,
} from './mapping';
export type {
  MappingOverrides, MappingOverride, AnalyzedPlan, FieldBinding, UnusedColumn,
  SourceField, TargetField, Confidence, PlanValidation, ColumnSummary,
} from './mapping';
export { applyEdits, applyEditsToText, previewEdits, expandPreset, suggestEdits, ALL_COLUMNS } from './edits';
export type { EditHint, Edit, EditCondition, EditResult, EditOutcome, EditArg } from './edits';
export { EDIT_CATALOG, EDIT_GROUPS, EDIT_PRESETS } from './edit-catalog';
export type { EditCatalogEntry, EditArgSpec, EditGroup, EditPreset } from './edit-catalog';
export { analyzeProblems, applyCorrectionsToTable } from './problems';
export type { Problem, Severity, ProblemReport, ProblemCounts, Corrections, ProblemOptions } from './problems';
export type { ConvertResult, Direction, ConsentReport, NumberingReport } from './types';

export type ConvertOptions = {
  direction: Direction;
  // Shopify has no collection column in its product CSV: write each category (and each level of
  // a hierarchical one) as a tag, so automated collections ("Tag is equal to …") can be built.
  categoriesAsTags?: boolean;
  // Variant stock: 'untracked' (default for a scraped Eloshon source: always sellable), 'continue' (quantities kept,
  // selling beyond them allowed) or 'source' (as the source says; default for a platform-to-platform migration).
  stockMode?: StockMode;
  // Phase 5.7 — Reference ⊕ Learned FormatKnowledge snapshot (from the app's
  // KnowledgeStore). Absent = Reference only (what ships with the engine).
  knowledge?: { formats: FormatKnowledge[] };
  entity?: Entity; // optional — the real entity is detected from the file
  // What the page expects the uploaded file to be (its source side). A mismatch
  // is surfaced as a wrong-file redirect, never a silent wrong conversion.
  expectPlatform: Platform;
  // Orders only: resolves an ambiguous MM/DD-vs-DD/MM date column once she answers.
  dateOrder?: DateOrder;
  // BigCommerce products only: resolves the Weight column unit once she answers.
  weightUnit?: 'kg' | 'lbs';
  // BigBuy only: the companion categories file (required — the product file uses
  // numeric category IDs), and an optional same-catalogue file in another
  // language to fold into translation metafields.
  categoriesCsv?: string;
  secondaryCsv?: string;
  secondaryLang?: string;
  // Free tier: cap the OUTPUT to the first N converted units (products /
  // customers / orders). The preview always shows the full count; only the free
  // downloadable file is capped. null/undefined = the whole file (paid).
  limitUnits?: number;
  // Optional column-correspondence overrides (ÉTAPE 2). Absent → the engine's
  // default correspondence (byte-for-byte identical output). Present → editable
  // scalar source columns are re-pointed/excluded via an alias applied to the
  // parsed table BEFORE the unchanged parser runs. See core/src/mapping.ts.
  mapping?: { overrides?: MappingOverrides };
  // Optional value corrections (ÉTAPE 4), keyed by source line → field → value.
  // Applied to the parsed table (never the file on disk) after overrides. Absent
  // → no change. See core/src/problems.ts.
  corrections?: Corrections;
  // Product migration only: when BOTH are set, the result carries a redirect map
  // (old URL → new URL) applying these bases to every product handle, so SEO
  // follows a store move. e.g. old "https://old.com/products/", new
  // "https://new.com/product/". Covers all products (not capped).
  redirectOldBase?: string;
  redirectNewBase?: string;
  // Products only: the optional SKU generator (OFF unless `enabled: true`). A real SKU is never overwritten;
  // see core/knowledge-proposal/sku.mjs. Absent → no SKU is invented anywhere.
  skuGenerator?: SkuGeneratorOptions;
  // Products only: where each « case personnalisée » goes, per target platform (field key → place; see
  // core/src/custom-fields.ts). Chosen once in step 3 and remembered; a missing key takes its never-lost default.
  customTargets?: Record<string, Record<string, string>>;
};

function cap<T>(items: T[], limit?: number): T[] {
  return limit != null ? items.slice(0, limit) : items;
}

// The target format id a direction produces for a given entity — the third
// argument analyzePlan needs. Mirrors the per-entity dispatch below.
export function targetFormatFor(direction: Direction, entity: Entity): FormatId {
  const target = targetPlatformOf(direction);
  return entity === 'products' ? productFormatOf(target)
    : entity === 'customers' ? customerFormatOf(target)
      : orderFormatOf(target);
}

// A conversion that couldn't start (wrong file, empty, unknown format). Returned
// as a normal result with ok:false so the UI renders it the same way. Carries a
// diagnostic CODE, not prose — the UI localises it.
function fail(direction: Direction, code: string, params?: DiagParams, extra?: Partial<ConvertResult>): ConvertResult {
  return {
    ok: false, direction, sourceFormat: 'unknown', targetFormat: 'unknown',
    headers: [], rows: [], counts: { inputUnits: 0, outputUnits: 0, failedUnits: 0, outputRows: 0 },
    errors: [{ row: 0, code, params }], losses: [], warnings: [], questions: [], ...extra,
  };
}

// Phase 8 — Shopware / PrestaShop are consumed as JSON payloads (Admin API /
// Webservice dumps), not CSV. The knowledge entries carry `json-shape`
// signatures the recognizer can match against the paths present in the first
// item (detection shared with analyzeProblems via core/src/detect.ts).
// Companions (variations, categories, order_details…) are absent when
// the user drops a single file — the generic parser tolerates missing
// companion arrays and we surface a `json_companions_missing` warning so the
// merchant knows the join-derived fields are best-effort.
function tryJsonConvert(csvText: string, opts: ConvertOptions): ConvertResult | null {
  const items = extractJsonItems(csvText);
  if (!items) return null;
  if (items.length === 0) return fail(opts.direction, 'empty_file');

  const knowledgeFormats = opts.knowledge?.formats ?? loadReferenceFormatsSync();
  const format = matchJsonFormat(items, knowledgeFormats);
  if (!format) return null;

  const platformHint = jsonFormatPlatform(format);
  if (opts.expectPlatform && platformHint && platformHint !== opts.expectPlatform) {
    return fail(opts.direction, 'wrong_platform', { format: format.displayName || format.id, target: platformName(targetPlatformOf(opts.direction)) }, { sourceFormat: format.id as ConvertResult['sourceFormat'] });
  }
  const target = targetPlatformOf(opts.direction);
  if (format.entity) {
    const cp = capabilityFor(opts.expectPlatform, target, format.entity as Entity);
    if (cp.status === 'impossible') return fail(opts.direction, cp.code ?? 'impossible_generic', cp.params, { sourceFormat: format.id as ConvertResult['sourceFormat'] });
  }
  const parsed = parseWithKnowledge(format, items, { companions: {}, canon: loadCanonCatalogSync() }) as { products: unknown[]; report: { warnings: { code: string }[] } };
  const warnings: Warning[] = parsed.report.warnings.map((w) => ({ code: 'knowledge_' + w.code } as Warning));
  const structureCompanions = (format as { structure?: { companions?: Record<string, unknown> } }).structure?.companions;
  if (structureCompanions && Object.keys(structureCompanions).length > 0) {
    warnings.push({ code: 'json_companions_missing', params: { format: format.displayName || format.id } });
  }
  if (format.entity === 'orders') return finishOrders(parsed.products as CanonOrder[], opts, format.id, null, warnings);
  if (format.entity === 'customers') return finishCustomers(parsed.products as CanonCustomer[], opts, format.id, null, warnings);
  return finishProducts(parsed.products as CanonProduct[], opts, format.id, null, warnings, []);
}

// Phase 2 Lot 2 — an .eloshon envelope (the suite's own canon catalogue):
// read + migrated + edit log replayed by the catalog's reader (eloshon.ts),
// then the same finishing pipeline as every canon-first source.
function tryEloshonConvert(text: string, opts: ConvertOptions): ConvertResult | null {
  const read = readEloshonText(text);
  if (!read) return null;
  const { direction } = opts;
  if (!read.ok) return fail(direction, read.code, read.params);
  if (opts.expectPlatform !== 'eloshon') {
    return fail(direction, 'wrong_platform', { format: ELOSHON_DISPLAY_NAME, target: platformName(targetPlatformOf(direction)) }, { sourceFormat: ELOSHON_SOURCE_FORMAT as ConvertResult['sourceFormat'] });
  }
  if (!read.entity) return fail(direction, 'empty_file');
  const cp = capabilityFor('eloshon', targetPlatformOf(direction), read.entity);
  if (cp.status === 'impossible') return fail(direction, cp.code ?? 'impossible_generic', cp.params, { sourceFormat: ELOSHON_SOURCE_FORMAT as ConvertResult['sourceFormat'] });
  const warnings: Warning[] = [...read.warnings];
  if (read.entity === 'orders') return finishOrders(read.orders, opts, ELOSHON_SOURCE_FORMAT, null, warnings);
  if (read.entity === 'customers') return finishCustomers(read.customers, opts, ELOSHON_SOURCE_FORMAT, null, warnings);
  return finishProducts(read.products, opts, ELOSHON_SOURCE_FORMAT, null, warnings);
}

export function convert(csvText: string, opts: ConvertOptions): ConvertResult {
  const eloshonResult = tryEloshonConvert(csvText, opts);
  if (eloshonResult) return eloshonResult;
  const jsonResult = tryJsonConvert(csvText, opts);
  if (jsonResult) return jsonResult;
  const { direction, entity, expectPlatform } = opts;
  const parsed = parseCsv(csvText);
  if (parsed.headers.length === 0) return fail(direction, 'empty_file');
  // 7.7 — card-data scanner on the table BEFORE any parser reads it: a card /
  // credential column is blanked and reported (pci_card_data_stripped), never
  // carried. Byte-identical for a file without such columns.
  const scanned = scanTable(parsed);
  const table: Table = { headers: scanned.headers, rows: scanned.rows, malformed: parsed.malformed, ...(parsed.unwrappedLines ? { unwrappedLines: parsed.unwrappedLines } : {}) };
  const pciWarnings: Warning[] = scanned.findings.length ? [{ code: 'pci_card_data_stripped', params: { count: scanned.findings.length, columns: scanned.findings.map((f) => f.path).join(', ') } }] : [];

  // Reference formats ship with the engine; the app may pass a Reference ⊕
  // Learned snapshot so user-taught formats are recognised too.
  const knowledgeFormats = opts.knowledge?.formats;
  const det = detectFormat(table.headers, knowledgeFormats);
  if (det.format === 'unknown') return fail(direction, 'unrecognized');

  // BigBuy (supplier catalogue) is a source-only, products-only path with a
  // required companion categories file. The detected format is passed as a param
  // (`format`) so the UI can name it in the viewer's language.
  if (expectPlatform === 'bigbuy') {
    if (det.format === 'presta_categories')
      return fail(direction, 'bigbuy_categories_as_main', undefined, { sourceFormat: det.format });
    if (det.platform !== 'bigbuy')
      return fail(direction, 'bigbuy_not_supplier', { format: det.format }, { sourceFormat: det.format });
    if (!opts.categoriesCsv)
      return fail(direction, 'bigbuy_need_categories', { format: det.format }, {
        sourceFormat: det.format,
        questions: [{ kind: 'need_file', code: 'need_categories_file', params: { format: det.format }, fileRole: 'categories' }],
      });
    // The scanned table, never a re-parse: a card / credential column must not
    // reach the parser or the preservation channels on this path either.
    const res = convertBigBuy(csvText, opts, det.format, det, table);
    return pciWarnings.length ? { ...res, warnings: [...pciWarnings, ...res.warnings] } : res;
  }

  // A direction page ("Shopify → WooCommerce") accepts products, customers OR
  // orders — the entity comes from the file, not the page. Only the PLATFORM is
  // guarded, so a Shopify customers file is fine here but a WooCommerce one is
  // caught as the wrong direction.
  if (det.platform !== expectPlatform) {
    return fail(direction, 'wrong_platform', { format: det.format, target: platformName(targetPlatformOf(direction)) }, { sourceFormat: det.format });
  }
  void entity;

  // Refuse an impossible conversion BEFORE doing any work — e.g. an order file on
  // a converter that outputs BigCommerce (which has no order CSV import at all),
  // or a customer/order file heading into Wix (products-only import). She learns
  // this before uploading time is wasted, not after.
  const target = targetPlatformOf(direction);
  if (det.entity) {
    const cp = capabilityFor(expectPlatform, target, det.entity);
    if (cp.status === 'impossible') return fail(direction, cp.code ?? 'impossible_generic', cp.params, { sourceFormat: det.format });
  }

  // Apply any column-correspondence overrides + value corrections to the parsed
  // table before the (unchanged) parser reads it. No overrides/corrections →
  // same table reference → output identical to the default engine.
  const workTable = applyCorrectionsToTable(
    applyOverridesToTable(table, det.format, opts.mapping?.overrides),
    det.format, opts.corrections,
  );

  // Phase 5.7 — a format known to the KnowledgeStore but without a per-format
  // parser: the generic knowledge-driven parser reads it (fields = data).
  const withPci = (res: ConvertResult): ConvertResult => (pciWarnings.length ? { ...res, warnings: [...pciWarnings, ...res.warnings] } : res);
  if (det.format === 'knowledge') return withPci(convertKnowledge(det, opts, workTable, knowledgeFormats));

  if (det.entity === 'products') return withPci(convertProducts(csvText, opts, det.format, workTable, det));
  if (det.entity === 'customers') return withPci(convertCustomers(csvText, opts, det.format, workTable, det));
  if (det.entity === 'orders') return withPci(convertOrders(csvText, opts, det.format, workTable, det));
  return fail(direction, 'coming_soon');
}

function convertKnowledge(det: Detection, opts: ConvertOptions, table: Table, formats: FormatKnowledge[] | undefined): ConvertResult {
  const format = (formats ?? loadReferenceFormatsSync()).find((f) => f.id === det.knowledgeId);
  if (!format) return fail(opts.direction, 'unrecognized');
  const parsed = parseWithKnowledge(format, table.rows, { companions: {}, canon: loadCanonCatalogSync() }) as { products: unknown[]; report: { warnings: { code: string }[] } };
  const warnings: Warning[] = parsed.report.warnings.map((w) => ({ code: 'knowledge_' + w.code } as Warning));
  // The file is not exactly what the format was taught on: say how, the new columns are listed as unmapped.
  if (det.similar) warnings.unshift({ code: 'format_similar', params: { added: det.similar.added, missing: det.similar.missing } } as Warning);
  const id = det.knowledgeId ?? 'knowledge';
  // Phase 7: a knowledge entry may describe an orders or customers file.
  if (format.entity === 'orders') return finishOrders(parsed.products as CanonOrder[], opts, id, table, warnings);
  if (format.entity === 'customers') return finishCustomers(parsed.products as CanonCustomer[], opts, id, table, warnings);
  if (det.entity !== 'products') return fail(opts.direction, 'coming_soon', undefined, { sourceFormat: det.format });
  return finishProducts(parsed.products as CanonProduct[], opts, id, table, warnings);
}

function convertBigBuy(csvText: string, opts: ConvertOptions, sourceFormat: string, det?: Detection, scannedTable?: Table): ConvertResult {
  const { direction } = opts;
  const toShopify = direction === 'bigbuy-to-shopify';
  const table = scannedTable ?? parseCsv(csvText);
  const catIndex = parsePrestaCategories(parseCsv(opts.categoriesCsv!).rows);

  const products = sourceFormat === 'bigbuy_standard'
    ? parseBigBuyStandard(table.rows, catIndex)
    : parseBigBuyPresta(table.rows, catIndex);

  // Optional same-catalogue file in another language → translation metafields.
  // Both files share a layout, so the id column that matches the SKU we stored
  // is 'ID' for the standard file and 'bb_REFERENCE' for the PrestaShop one.
  if (opts.secondaryCsv && opts.secondaryLang) {
    const second = parseCsv(opts.secondaryCsv);
    const idCol = sourceFormat === 'bigbuy_standard' ? 'ID' : 'bb_REFERENCE';
    mergeLanguage(products, second.rows, opts.secondaryLang, idCol, 'NAME', 'DESCRIPTION', (p) => p.variants[0]?.sku ?? '');
  }

  const errors: RowError[] = [];
  const warnings: Warning[] = [];
  if (det) annotateLegacy(det, opts, table, products, 'variants', warnings);
  const usable = products.filter((p, i) => {
    if (!p.title.trim()) { errors.push({ row: i + 2, field: 'name', code: 'product_no_name_supplier' }); return false; }
    return true;
  });

  warnings.push(...malformedWarning(table));
  warnings.push(...dedupeHandles(usable));
  if (!toShopify) { warnings.push(...duplicateSkuWarnings(usable)); warnings.push(idRemovedNote('woocommerce')); }
  const capped = cap(usable, opts.limitUnits);
  const out = toShopify ? serializeShopifyProducts(capped) : serializeWooModern(capped);
  const losses = bigbuyLosses(usable, toShopify);

  return {
    ok: usable.length > 0, direction,
    sourceFormat: sourceFormat as ConvertResult['sourceFormat'],
    targetFormat: toShopify ? 'shopify_products' : 'woo_products_modern',
    headers: out.headers, rows: out.rows,
    counts: { inputUnits: products.length, outputUnits: usable.length, failedUnits: products.length - usable.length, outputRows: out.rows.length },
    errors, losses, warnings, questions: [],
    ...withPreserved(usable),
  };
}

// The optional `preserved` key, present only when something was kept.
function withPreserved(units: object[]): { preserved?: PreservedReport } {
  const preserved = preservedReportOf(units);
  return preserved ? { preserved } : {};
}

function convertOrders(csvText: string, opts: ConvertOptions, sourceFormat: string, providedTable?: Table, det?: Detection): ConvertResult {
  const table = providedTable ?? parseCsv(csvText);
  let orders: CanonOrder[] = [];
  const warnings: Warning[] = [];
  const questions: ConvertResult['questions'] = [];
  if (sourceFormat === 'woo_orders') {
    const parsed = parseWooOrders(table.headers, table.rows, opts.dateOrder);
    orders = parsed.orders; warnings.push(...parsed.warnings); questions.push(...parsed.questions);
  } else if (sourceFormat === 'shopify_orders') {
    const parsed = parseShopifyOrders(table.rows);
    orders = parsed.orders; warnings.push(...parsed.warnings);
  } else if (sourceFormat === 'bigcommerce_orders') {
    const parsed = parseBigCommerceOrders(table.rows);
    orders = parsed.orders; warnings.push(...parsed.warnings);
  }
  if (det) annotateLegacy(det, opts, table, orders, 'lineItems', warnings);
  return finishOrders(orders, opts, sourceFormat, table, warnings, questions);
}

// Everything that happens AFTER orders are in canon form (7.4 / 7.6): test
// orders excluded, row validation, numbering report, capping, serialisation,
// losses. Shared by the CSV parsers and the canon-first entry point.
function finishOrders(
  orders: CanonOrder[], opts: ConvertOptions, sourceFormat: string, table: Table | null,
  warnings: Warning[] = [], questions: ConvertResult['questions'] = [],
): ConvertResult {
  const { direction, expectPlatform } = opts;
  const target = targetPlatformOf(direction);
  const errors: RowError[] = [];
  // 7.2 (decision 4): test / sandbox orders never migrate by default — a
  // warning names how many were left out.
  const testCount = orders.filter((o) => o.test === true).length;
  if (testCount) warnings.push({ code: 'test_orders_excluded', params: { count: testCount } });
  const usable = orders.filter((o, i) => {
    if (o.test === true) return false;
    if (o.lineItems.length === 0) { errors.push({ row: i + 2, code: 'order_no_line_items' }); return false; }
    return true;
  });
  if (table) warnings.push(...malformedWarning(table));
  const numberingReport = buildNumberingReport(usable);
  for (const w of numberingReport.warnings) {
    if (w === 'numbering_source_duplicate') warnings.push({ code: w, params: { numbers: numberingReport.sourceSequence.duplicates.slice(0, 10).join(', ') } });
    else if (w === 'numbering_source_gaps') warnings.push({ code: w, params: { gaps: numberingReport.sourceSequence.gaps.slice(0, 10).join(', ') } });
  }
  const capped = cap(usable, opts.limitUnits);
  const out = serializeOrdersFor(target, capped);
  const losses = [...orderLossesFor(expectPlatform, target, usable), ...orderNumberingLosses(target, usable, numberingReport)];
  return {
    ok: usable.length > 0, direction,
    sourceFormat: sourceFormat as ConvertResult['sourceFormat'],
    targetFormat: orderFormatOf(target),
    headers: out.headers, rows: out.rows,
    counts: { inputUnits: orders.length, outputUnits: usable.length, failedUnits: orders.length - usable.length, outputRows: out.rows.length },
    errors, losses, warnings, questions,
    ...(usable.length ? { numberingReport } : {}),
    ...withPreserved(usable),
  };
}

// 7.4 — the SOURCE numbering as observed. Gaps and duplicates are facts to
// report (a missing invoice in a legal sequence is not repaired), the target
// sequence is always native. A numbering block missing on a CSV-parsed order
// means "the flat number IS the source number".
function sourceNumberOf(o: CanonOrder): string { return (o.numbering?.sourceNumber ?? o.number ?? '').trim(); }
function sequenceFacts(values: string[]): { min: string | null; max: string | null; numeric: boolean; gaps: string[]; duplicates: string[] } {
  const present = values.filter((v) => v !== '');
  const seen = new Map<string, number>();
  for (const v of present) seen.set(v, (seen.get(v) ?? 0) + 1);
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([v]) => v).sort();
  const nums = present.map((v) => v.replace(/\D+/g, '')).filter((d) => d !== '').map((d) => Number(d));
  const numeric = present.length > 0 && nums.length === present.length && nums.every((n) => Number.isSafeInteger(n));
  if (!numeric) return { min: present.length ? [...present].sort()[0] : null, max: present.length ? [...present].sort().at(-1)! : null, numeric: false, gaps: [], duplicates };
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const gaps: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const lo = sorted[i - 1] + 1, hi = sorted[i] - 1;
    if (hi >= lo) gaps.push(lo === hi ? String(lo) : `${lo}–${hi}`);
  }
  const byNum = (n: number) => present.find((v) => Number(v.replace(/\D+/g, '')) === n)!;
  return { min: byNum(sorted[0]), max: byNum(sorted.at(-1)!), numeric: true, gaps, duplicates };
}
export function buildNumberingReport(orders: CanonOrder[]): NumberingReport {
  const sourceSequence = sequenceFacts(orders.map(sourceNumberOf));
  const invoiceNumbers = orders.map((o) => (o.numbering?.sourceInvoiceNumber ?? '').trim());
  const withNumber = invoiceNumbers.filter(Boolean).length;
  const invoices = { withNumber, withoutNumber: orders.length - withNumber, gaps: withNumber ? sequenceFacts(invoiceNumbers).gaps : [] };
  const warnings: string[] = [];
  if (sourceSequence.duplicates.length) warnings.push('numbering_source_duplicate');
  if (sourceSequence.gaps.length) warnings.push('numbering_source_gaps');
  if (withNumber) warnings.push('invoice_numbers_not_carried');
  return { orders: orders.length, sourceSequence, invoices, targetPolicy: 'native-sequence', warnings };
}
function orderNumberingLosses(target: Platform, orders: CanonOrder[], report: NumberingReport): Loss[] {
  if (!orders.length) return [];
  const t = lossTag(target);
  const losses: Loss[] = [{ code: `loss_${t}_order_numbering`, params: { orders: orders.length, min: report.sourceSequence.min ?? '', max: report.sourceSequence.max ?? '' } }];
  if (report.invoices.withNumber) losses.push({ code: `loss_${t}_invoice_numbers`, params: { count: report.invoices.withNumber } });
  const payments = orders.reduce((a, o) => a + (o.payments?.length ?? 0), 0);
  if (payments) losses.push({ code: `loss_${t}_payments_detail`, params: { count: payments } });
  return losses;
}

// Phase 7 — canon-first orders (a JSON/API adapter or the generic parser).
export function convertOrdersFromCanon(orders: CanonOrder[], opts: ConvertOptions, sourceFormat = 'canon'): ConvertResult {
  return finishOrders(orders, opts, sourceFormat, null);
}

function convertCustomers(csvText: string, opts: ConvertOptions, sourceFormat: string, providedTable?: Table, det?: Detection): ConvertResult {
  const table = providedTable ?? parseCsv(csvText);
  const warnings: Warning[] = [];
  const { customers, skippedNonCustomers } = parseCustomersTable(sourceFormat, table, opts.knowledge?.formats);
  if (skippedNonCustomers > 0) warnings.push({ code: 'skipped_non_customers', params: { count: skippedNonCustomers } });

  if (det) annotateLegacy(det, opts, table, customers, 'variants', warnings);
  return finishCustomers(customers, opts, sourceFormat, table, warnings);
}

// Everything that happens AFTER customers are in canon form (7.3): duplicate
// e-mails, consent report, capping, serialisation (every target NOT
// subscribed), losses. Shared by the CSV parsers and the canon-first entry.
function finishCustomers(customers: CanonCustomer[], opts: ConvertOptions, sourceFormat: string, table: Table | null, warnings: Warning[] = []): ConvertResult {
  const { direction } = opts;
  const target = targetPlatformOf(direction);
  const { warnings: dupWarnings, errors } = customerWarnings(customers);
  warnings.push(...dupWarnings);
  if (table) warnings.push(...malformedWarning(table));
  const errorRows = new Set(errors.map((e) => e.row));
  const usable = customers.filter((_, i) => !errorRows.has(i + 2));
  const consentReport = buildConsentReport(usable);
  const capped = cap(usable, opts.limitUnits);
  const out = serializeCustomersFor(target, capped);
  const losses = [...customerLossesFor(target, usable), ...consentLosses(target, usable, consentReport)];
  return {
    ok: usable.length > 0, direction,
    sourceFormat: sourceFormat as ConvertResult['sourceFormat'],
    targetFormat: customerFormatOf(target),
    headers: out.headers, rows: out.rows,
    counts: { inputUnits: customers.length, outputUnits: usable.length, failedUnits: customers.length - usable.length, outputRows: out.rows.length },
    errors, losses, warnings, questions: [],
    ...(usable.length ? { consentReport } : {}),
    ...withPreserved(usable),
  };
}

// 7.3 — what the source said (evidence), per customer across channels: the
// strongest statement counts (opted_in > pending > opted_out > unknown). A
// pre-Phase-7 acceptsEmail flag with no typed evidence counts as a statement
// without timestamp (pending / opted_out).
export function buildConsentReport(customers: CanonCustomer[]): ConsentReport {
  let explicit = 0, withTimestamp = 0, pending = 0, optedOut = 0, unknown = 0;
  for (const c of customers) {
    const states = [c.marketingConsent?.email?.state, c.marketingConsent?.sms?.state].filter(Boolean) as string[];
    if (!states.length) { if (c.acceptsEmail === true) states.push('pending'); else if (c.acceptsEmail === false) states.push('opted_out'); }
    if (states.includes('opted_in')) { explicit++; withTimestamp++; }
    else if (states.includes('pending')) { explicit++; pending++; }
    else if (states.includes('opted_out')) optedOut++;
    else unknown++;
  }
  return { customers: customers.length, explicitSourceConsent: explicit, withTimestamp, pending, optedOut, unknown, targetPolicy: 'not-subscribed', requiresReconfirmation: true };
}
function consentLosses(target: Platform, customers: CanonCustomer[], report: ConsentReport): Loss[] {
  if (!customers.length) return [];
  return [{ code: `loss_${lossTag(target)}_marketing_consent`, params: { customers: report.customers, explicit: report.explicitSourceConsent, timestamped: report.withTimestamp, pending: report.pending } }];
}

// Phase 7 — canon-first customers (a JSON/API adapter or the generic parser).
export function convertCustomersFromCanon(customers: CanonCustomer[], opts: ConvertOptions, sourceFormat = 'canon'): ConvertResult {
  return finishCustomers(customers, opts, sourceFormat, null);
}

function convertProducts(csvText: string, opts: ConvertOptions, sourceFormat: string, providedTable?: Table, det?: Detection): ConvertResult {
  const { direction, expectPlatform } = opts;
  const table = providedTable ?? parseCsv(csvText);
  let products: CanonProduct[] = [];
  const warnings: Warning[] = [];
  const errors: RowError[] = [];
  const questions: ConvertResult['questions'] = [];

  // An entry the generic parser can execute reads the file (bespoke parser
  // retired); the others keep their bespoke parser.
  const generic = parseProductsTable(sourceFormat, table, opts.knowledge?.formats);
  if (generic) products = generic;
  else if (sourceFormat === 'shopify_products') products = parseShopifyProducts(table.headers, table.rows);
  else if (sourceFormat === 'woo_products_modern') products = parseWooModern(table.headers, table.rows);
  else if (sourceFormat === 'wix_products') products = parseWixProducts(table.rows);
  else if (sourceFormat === 'bigcommerce_products') {
    const parsed = parseBigCommerceProducts(table.rows, opts.weightUnit);
    products = parsed.products; warnings.push(...parsed.warnings); questions.push(...parsed.questions);
  }
  // The older WooCommerce export cannot carry per-variation rows: its options are
  // attributes only, which the user must know before importing.
  if (sourceFormat === 'woo_products_legacy' && products.some((p) => p.options.length > 0))
    warnings.push({ code: 'woo_legacy_variants' });

  if (det) annotateLegacy(det, opts, table, products, 'variants', warnings);
  return finishProducts(products, opts, sourceFormat, table, warnings, errors, questions);
}

// Everything that happens AFTER products are in canon form: row validation,
// handle/SKU hygiene, capping, serialisation, losses, redirects. Shared by the
// CSV parsers and by canon-first entry points (Phase 5.5: JSON/API adapters).
// `table` is the parsed source when there was one (malformed-row warning).
function finishProducts(
  products: CanonProduct[], opts: ConvertOptions, sourceFormat: string, table: Table | null,
  warnings: Warning[] = [], errors: RowError[] = [], questions: ConvertResult['questions'] = [],
): ConvertResult {
  const { direction, expectPlatform } = opts;
  // 6.3 — canon derivation rules (data: canon/fields.v1.json#derivations), e.g.
  // barcode ← first of identifiers.gtin/ean/upc/isbn. Idempotent: fills only
  // what is empty, so the generic parser's own pass and this one agree; the
  // legacy CSV parsers get the same rule without a line of platform code.
  applyCanonDerivations(products, loadCanonCatalogSync());
  // Option axes named from their values (never « option »); a scraped file's colour pages grouped under one parent.
  warnings.push(...nameGenericAxes(products));
  if (isScrapedFormat(String(sourceFormat))) { const fam = groupColourFamilies(products); products = fam.products; warnings.push(...fam.warnings, ...combineFlatAxes(products)); }
  // Row-level validation: a product with no title can't be created.
  const usable: CanonProduct[] = [];
  products.forEach((p, i) => {
    if (!p.title.trim()) errors.push({ row: i + 2, field: 'title', code: 'product_no_title' });
    else usable.push(p);
  });

  const target = targetPlatformOf(direction);
  if (table) warnings.push(...malformedWarning(table));
  // SKU contract: a value that is a label / phrase / option name is not a SKU — removed, the SKU stays empty,
  // listed in the result. Then, only when the user turned it on, the generator fills the empty SKUs.
  const skuRejected = guardSkus(usable);
  if (skuRejected.length) warnings.push({ code: 'sku_rejected', params: { count: skuRejected.length, detail: skuRejected.slice(0, 6).map((r) => `« ${r.value} » (${r.product}${r.variant ? ` — ${r.variant}` : ''})`).join(' · ') + (skuRejected.length > 6 ? ' …' : '') } });
  // Step 3 shows the generator's effect before / after on the first variants (nothing is changed by the preview).
  const skuPreview = opts.skuGenerator?.enabled ? previewSkus(usable, opts.skuGenerator) : undefined;
  const skuGen = generateSkus(usable, opts.skuGenerator);
  if (skuGen.generated.length) warnings.push({ code: 'skus_generated', params: { count: skuGen.generated.length } });
  // WooCommerce: a variable product with no parent SKU (real, from the source, or generated above) gets one by default
  // — the only way a new product's variations are attached to it. Marked « generated »; variations keep their own SKU
  // (empty when the source gives none).
  let parentSkuMap = skuGen.parents;
  const generatedSkus = [...skuGen.generated];
  if (target === 'woocommerce') {
    const fromSource = usable.map((p) => parentSkuFromSource(p));
    const extra = parentSkus(usable, { skip: (_p, i) => !!parentSkuMap.get(i) || !!fromSource[i], reserved: [...fromSource, ...parentSkuMap.values()], options: opts.skuGenerator });
    if (extra.size) {
      parentSkuMap = new Map([...parentSkuMap, ...extra]);
      for (const [i, sku] of extra) generatedSkus.push({ product: usable[i].handle || usable[i].title, variant: '', sku, scope: 'parent' });
      warnings.push({ code: 'woo_parent_skus_generated', params: { count: extra.size } });
    }
  }
  // Capture the original (source) handles BEFORE dedupeHandles mutates them, so a
  // migration redirect starts from the URL that is actually indexed today.
  const origHandles = usable.map((p) => p.handle);
  warnings.push(...dedupeHandles(usable));
  // The source site's availability is not the merchant's stock: a scraped variant is not imported « sold out ».
  warnings.push(...applyStockMode(usable, stockModeFor(String(sourceFormat), opts.stockMode)));
  // WooCommerce updates by SKU; both WooCommerce and BigCommerce overwrite by ID.
  if (target === 'woocommerce') { warnings.push(...duplicateSkuWarnings(usable)); warnings.push(...wooParentSkuWarnings(usable, parentSkuMap)); warnings.push(idRemovedNote('woocommerce')); }
  else if (target === 'bigcommerce') warnings.push(idRemovedNote('bigcommerce'));
  // The « cases personnalisées » of a SCRAPER file (products.json, the panel's CSV and manifest, .eloshon): its own
  // columns and, off Shopify, its product type, placed where the user chose for this target in step 3, else where they
  // are never lost (custom-fields.ts). A platform-to-platform conversion keeps its own rules (unchanged).
  const fromScraper = isScrapedFormat(String(sourceFormat)) || String(sourceFormat) === ELOSHON_SOURCE_FORMAT;
  const customFields = fromScraper ? placeCustomFields(usable, target, opts.customTargets?.[target] || {}) : [];
  const capped = cap(usable, opts.limitUnits);
  const out = serializeProductsFor(target, capped, opts.categoriesAsTags === true, parentSkuMap);
  // Options, choices and variants beyond what the target takes: reported, never cut in silence.
  const losses = [...productLossesFor(expectPlatform, target, usable), ...platformLimitLosses(target, usable)];
  // Migration redirect map (all products, not capped) when both URL bases are set.
  const redirects = (opts.redirectOldBase?.trim() && opts.redirectNewBase?.trim())
    ? buildRedirects(usable, origHandles, opts.redirectOldBase, opts.redirectNewBase)
    : undefined;

  return {
    ok: usable.length > 0,
    direction,
    sourceFormat: sourceFormat as ConvertResult['sourceFormat'],
    targetFormat: productFormatOf(target),
    headers: out.headers,
    rows: out.rows,
    redirects,
    counts: { inputUnits: products.length, outputUnits: usable.length, failedUnits: products.length - usable.length, outputRows: out.rows.length },
    errors, losses, warnings, questions,
    skus: { rejected: skuRejected, generated: generatedSkus, generator: skuGen.enabled, ...(skuPreview ? { preview: skuPreview } : {}) },
    ...(customFields.length ? { customFields } : {}),
    ...withPreserved(usable),
  };
}

// Phase 5.5 — canon-first conversion. Products already in canon form (from a
// JSON/API adapter, a .eloshon file, or the generic parser) go through the
// same finishing pipeline as a CSV source. `sourceFormat` labels the result
// (a KnowledgeStore id such as `woocommerce.products.rest.v1`).
export function convertFromCanon(products: CanonProduct[], opts: ConvertOptions, sourceFormat = 'canon'): ConvertResult {
  return finishProducts(products, opts, sourceFormat, null);
}
