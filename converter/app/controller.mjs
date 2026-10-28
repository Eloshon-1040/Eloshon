/**
 * Conversion controller — app-side, pure and headless-testable. Takes/returns
 * strings + plain data; the Electron main process does the fs read/write and the
 * native dialogs. Wraps the extracted engine (core/dist) and applies the
 * freemium rule: free ≤ freeLimit units, full output only when licensed.
 * No cloud, no Homie Book, no browser.
 */
import {
  convert, detectFormat, parseCsv, serializeCsv,
  analyzePlan, validatePlan, hasMappingPlan, targetFormatFor,
  analyzeProblems, semanticAnalyze, summarizeColumns, learnFormat, proposeFormatId,
  extractJsonItems, matchJsonFormat, jsonFormatPlatform, jsonShapePaths,
  readEloshonText, ELOSHON_SOURCE_FORMAT, ELOSHON_DISPLAY_NAME, TARGET_FIELDS, applyEdits,
} from '../core/dist/index.mjs';
import { sanitizeCustomTargets } from './custom-targets.mjs';
import { DIRECTIONS, DEFAULT_FREE_LIMIT } from '../core/directions.mjs';
import { loadAllFormats, loadReferenceFormatsSync, loadCanonCatalogSync, loadTransformAliasesSync } from '../core/knowledge-proposal/reference.mjs';
import { entryForCanon } from '../core/knowledge-proposal/learn.mjs';
import { buildStep3 } from './step3-rows.mjs';

export { DIRECTIONS, analyzeProblems };

/** Full pre-export analysis for step 4: the line-by-line problem report given
 *  the current mapping overrides + corrections + ignored ids. `formats` is the
 *  Reference ⊕ Learned snapshot — the same detection surface steps 2-3 use, so
 *  a file that converted fine never gets re-detected as unknown at the gate. */
export function analyzeIssues(csvText, direction, { overrides, corrections, ignored, formats } = {}) {
  return analyzeProblems(csvText, { direction, overrides, corrections, ignored, formats });
}

/** Phase 8 — Shopware / PrestaShop JSON drop: match the first item's paths
 *  against `json-shape` signatures (shared engine helpers — the same detection
 *  convert() and analyzeProblems() use) and return the same shape as a
 *  detected knowledge-driven CSV so step 2 renders identically. Companions
 *  are absent (single-file drop); step 5 warns via `json_companions_missing`.
 *  Returns null if no JSON knowledge format matches — the caller falls back
 *  to the CSV path (which reports "unrecognized"). */
function analyzeJsonMapping(trimmed, direction, opts) {
  const items = extractJsonItems(trimmed);
  if (!items || items.length === 0) return null;

  const formats = opts.formats ?? loadReferenceFormatsSync();
  const format = matchJsonFormat(items, formats);
  if (!format) return null;

  const paths = jsonShapePaths(items[0]);
  const platform = jsonFormatPlatform(format);
  const entity = format.entity ?? 'products';
  const targetFormat = targetFormatFor(direction, entity);
  const detection = { format: 'knowledge', platform, entity, knowledgeId: format.id, displayName: format.displayName };
  const fields = (format.fields ?? []).filter((f) => f.canon).map((f) => ({ path: f.path, canon: f.canon, transform: f.transform, confidence: f.confidence, when: f.when ?? null }));
  const consumed = new Set(fields.map((f) => f.path));
  const unknownColumns = paths.filter((p) => !consumed.has(p));
  return {
    detection, targetFormat, hasPlan: false, plan: null, validation: null,
    knowledge: { id: format.id, displayName: format.displayName, origin: 'reference', fields, unknownColumns, companionsRequired: Object.keys(format.structure?.companions ?? {}) },
    rowCount: items.length,
    __ctx: { headers: paths, rows: items, fmt: format },
  };
}

/**
 * The column-correspondence plan for an uploaded file (ÉTAPE 2). Detects the
 * source format, resolves the target format for the chosen direction, and binds
 * the declarative plan to the file's real columns (confidence + suggested
 * near-name matches). `overrides` reflects the user's edits in step 3.
 *
 * Phase 5.6 — `opts.semantic` turns on the semantic column recogniser: the
 * plan gains `semantic` (per-column candidates with samples) and unresolved
 * rules are pre-filled from AUTO columns (suggestion only). `opts.store` is a
 * KnowledgeStore whose Learned decisions for the detected format are applied
 * (confirmed / corrected / rejected / ignored). Without a store, `opts.decisions`
 * can be passed directly (headless tests).
 * Returns { detection, targetFormat, hasPlan, plan, validation }.
 */
export async function analyzeMapping(csvText, direction, overrides = {}, opts = {}) {
  const r = await analyzeMappingCore(csvText, direction, overrides, opts);
  // Step 3: one row per column of the file, the same model for the three cases (app/step3-rows.mjs).
  const ctx = r.__ctx || { headers: [], rows: [] };
  delete r.__ctx;
  r.step3 = buildStep3(r, { ...ctx, overrides, direction, editChoices: columnEditChoices() });
  return r;
}

async function analyzeMappingCore(csvText, direction, overrides = {}, opts = {}) {
  // Phase 8 — a JSON drop (Shopware / PrestaShop API dump, one payload object
  // or an array of them) short-circuits the CSV mapping flow: the knowledge
  // entry is the mapping, and the app displays it read-only (like any other
  // knowledge-driven CSV). Companions are absent — the export step warns.
  const trimmed = (csvText || '').replace(/^﻿/, '').trimStart();
  // Phase 2 Lot 2 — an .eloshon catalogue is already canon: no column map to
  // show, the step-3 table says so (knowledge.canonNative).
  const env = trimmed.startsWith('{') ? readEloshonText(trimmed) : null;
  if (env) {
    if (!env.ok) return { detection: { format: 'unknown', platform: null, entity: null }, targetFormat: null, hasPlan: false, plan: null, validation: null, eloshonError: { code: env.code, params: env.params } };
    const entity = env.entity ?? 'products';
    const units = entity === 'customers' ? env.customers : entity === 'orders' ? env.orders : env.products;
    return {
      detection: { format: 'knowledge', platform: 'eloshon', entity, knowledgeId: ELOSHON_SOURCE_FORMAT, displayName: ELOSHON_DISPLAY_NAME },
      targetFormat: targetFormatFor(direction, entity), hasPlan: false, plan: null, validation: null,
      knowledge: { id: ELOSHON_SOURCE_FORMAT, displayName: ELOSHON_DISPLAY_NAME, origin: 'reference', fields: [], unknownColumns: [], canonNative: true },
      rowCount: units.length,
    };
  }
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const j = analyzeJsonMapping(trimmed, direction, opts);
    if (j) return j;
  }
  const table = parseCsv(csvText);
  // Phase 5.7 — Reference ⊕ Learned: user-taught formats are recognised too.
  const baseFormats = opts.formats ?? (opts.store ? await loadAllFormats(opts.store) : undefined);
  // A format built from the export manifest beside the file (its column roles) is tried first.
  const formats = opts.extraFormat ? [opts.extraFormat, ...(baseFormats || loadReferenceFormatsSync())] : baseFormats;
  const detection = detectFormat(table.headers, formats);
  const decisionsFor = async (id) => opts.decisions ?? (opts.store && id ? await opts.store.listDecisions(id) : []);

  // Unknown file: with semantics on, propose candidates for EVERY column under a
  // provisional id derived from the column set (stable → decisions stick), so
  // the user can teach the format (learn mode).
  if (detection.format === 'unknown') {
    if (!opts.semantic) return { detection, targetFormat: null, hasPlan: false, plan: null, validation: null };
    const proposedId = proposeFormatId(table.headers, { provenance: 'unknown', hint: 'csv' });
    const semantic = semanticAnalyze(table.headers, table.rows, 'products', { formatId: proposedId, decisions: await decisionsFor(proposedId) });
    const summary = summarizeColumns({ bindings: [], unused: table.headers.map((h) => ({ column: h, confidence: 'none', sample: '' })), semantic }, {}, { learn: true });
    // The chosen target and where each field lands in its file: a proposal says what is really written (« → Shopify
    // “Variant SKU” ») and « not carried » only when the target has no column for it. (Before: no target at all here,
    // so every proposal — SKU and Title included — said « not carried by Shopify ».)
    const learnTarget = targetFormatFor(direction, 'products');
    return { detection, targetFormat: null, hasPlan: false, plan: null, validation: null, learn: { proposedId, headers: table.headers, semantic, targetFormat: learnTarget, targetCols: targetColumnsOf(learnTarget) }, summary,
      __ctx: { headers: table.headers, rows: table.rows } };
  }
  const targetFormat = targetFormatFor(direction, detection.entity);

  // Knowledge-driven format (generic parser): the mapping IS the knowledge
  // entry — shown read-only (fields → canon) with the columns it leaves aside.
  if (detection.format === 'knowledge') {
    const fmt = (formats ?? []).find((f) => f.id === detection.knowledgeId) ?? null;
    const fields = fmt ? fmt.fields.filter((f) => f.canon).map((f) => ({ path: f.path, canon: f.canon, transform: f.transform, confidence: f.confidence, when: f.when ?? null })) : [];
    const consumed = new Set(fields.map((f) => f.path).concat(...(fmt?.fields ?? []).map((f) => [f.path, ...(f.inputs ?? []), ...(f.consumes ?? [])])));
    const unknownColumns = table.headers.filter((h) => !consumed.has(h));
    // A few real cells per column, so the user sees WHAT each mapping moves.
    const head = table.rows.slice(0, 50);
    const sampleOf = (col) => { for (const r of head) { const v = String(r[col] ?? '').trim(); if (v) return v.length > 60 ? v.slice(0, 60) + '…' : v; } return ''; };
    for (const f of fields) f.sample = sampleOf(f.path);
    const unknownSamples = Object.fromEntries(unknownColumns.map((h) => [h, sampleOf(h)]));
    // Step-3 edits of a Reference format (learned overlay): which columns the
    // user re-pointed, so the table says so and offers "back to the original".
    const origin = fmt?.history?.[0]?.origin ?? 'reference';
    const editsDoc = origin === 'reference' && opts.store?.getColumnEdits ? await opts.store.getColumnEdits(detection.knowledgeId) : null;
    const edited = Object.fromEntries(Object.entries(editsDoc?.columns ?? {}).map(([c, v]) => [c, describeEdit(v.entries)]));
    const mappedCols = new Set(table.headers.filter((h) => consumed.has(h)));
    const ignoredCols = new Set((fmt?.fields ?? []).filter((f) => f.canon === null || f.transform === 'ignore').map((f) => f.path));
    const isEdited = (h) => Object.prototype.hasOwnProperty.call(edited, h);
    const summary = { total: table.headers.length, auto: [...mappedCols].filter((h) => !ignoredCols.has(h) && !isEdited(h)).length, check: 0,
      manual: [...mappedCols].filter((h) => !ignoredCols.has(h) && isEdited(h)).length, ignored: [...mappedCols].filter((h) => ignoredCols.has(h)).length,
      unknown: unknownColumns.length, notCarried: 0, notCarriedFields: [] };
    // Every column of the file can be re-pointed (keys read inside a nested
    // variation JSON are not file columns, so they never show here).
    const editable = origin === 'reference' ? table.headers.filter(Boolean) : [];
    return { detection, targetFormat, hasPlan: false, plan: null, validation: null, summary,
      knowledge: { id: detection.knowledgeId, displayName: detection.displayName, origin, fields, unknownColumns, unknownSamples,
        editable, edited, choices: origin === 'reference' ? columnEditChoices() : [],
        // where each destination lands in the chosen target file, so the list says what is really written
        targetCols: origin === 'reference' ? targetColumnsOf(targetFormat) : {} },
      __ctx: { headers: table.headers, rows: table.rows, fmt } };
  }

  const hasPlan = hasMappingPlan(detection.format, targetFormat);
  // Sample rows feed the "example" column of step 3 (and value profiling).
  let analyze = { rows: table.rows.slice(0, 200) };
  if (opts.semantic) {
    analyze = { recognize: 'semantic', rows: table.rows, formatId: detection.knowledgeId ?? undefined, decisions: await decisionsFor(detection.knowledgeId) };
  }
  const plan = hasPlan ? analyzePlan(table.headers, detection.format, targetFormat, detection.entity, overrides, analyze) : null;
  const validation = plan ? validatePlan(plan, overrides) : null;
  const summary = plan ? summarizeColumns(plan, overrides) : null;
  return { detection, targetFormat, hasPlan, plan, validation, summary, __ctx: { headers: table.headers, rows: table.rows } };
}

// ── Step 3: re-point a column of a Reference format (learned overlay) ───────
// The choices are the canon fields a single column can feed (the catalogue
// fields whose transform has a one-column alias), plus a description section,
// a custom field the user names, and "do not import".
/** canon field → the column(s) the TARGET file writes it to (empty = the target does not carry it). */
export function targetColumnsOf(targetFormat) {
  const table = TARGET_FIELDS[targetFormat] ?? {};
  return Object.fromEntries(columnEditChoices().map((c) => [c, table[c]?.cols ?? []]));
}

export function columnEditChoices() {
  const aliases = loadTransformAliasesSync();
  return loadCanonCatalogSync().fields
    .filter((f) => f.entity === 'products' && f.path !== 'metafields' && f.path !== 'translations' && aliases.aliases?.[f.transform])
    .map((f) => f.path);
}

/** target: { kind: 'canon', canon } | { kind: 'custom', key } | { kind: 'ignore' } → the column's new entries. */
export function columnEditEntries(column, target) {
  if (!column || !target) throw new Error('columnEditEntries: column and target are required');
  if (target.kind === 'ignore') return [{ path: column, canon: null, transform: 'ignore', confidence: 'user-confirmed', source: 'user', notes: 'not imported (step 3)' }];
  const catalog = loadCanonCatalogSync();
  const aliases = loadTransformAliasesSync();
  const specOf = (p) => catalog.fields.find((f) => f.entity === 'products' && f.path === p);
  if (target.kind === 'custom') {
    const key = String(target.key ?? '').trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) throw new Error('columnEditEntries: a custom field key uses letters, digits, _ and - only');
    return [entryForCanon({ column, spec: specOf('metafields'), aliases, customKey: key })];
  }
  if (target.kind === 'canon' && columnEditChoices().includes(target.canon)) {
    const e = entryForCanon({ column, spec: specOf(target.canon), aliases });
    if (e) return [e];
  }
  throw new Error('columnEditEntries: unsupported target');
}

/** What an edit does, for the step-3 table: { kind, canon?, key? }. */
function describeEdit(entries = []) {
  const e = entries[0];
  if (!e || e.canon === null || e.transform === 'ignore') return { kind: 'ignore' };
  if (e.transform === 'metafield_pair') return { kind: 'custom', key: e.args?.key ?? e.path };
  const catalog = loadCanonCatalogSync(); const aliases = loadTransformAliasesSync();
  const hit = columnEditChoices().find((p) => entryForCanon({ column: e.path, spec: catalog.fields.find((f) => f.entity === 'products' && f.path === p), aliases })?.canon === e.canon);
  return { kind: 'canon', canon: hit ?? e.canon };
}

/** Phase 5.7 — teach an unknown format from its semantic report (+ decisions
 *  already applied) and persist it in the Learned strata. Returns the entry. */
export async function learnFromAnalysis(store, { headers, semantic, hint, provenance = 'unknown', platform = 'eloshon', by = 'user' }) {
  const id = proposeFormatId(headers, { provenance: 'unknown', hint: 'csv' }); // same id the decisions were recorded under
  const fmt = learnFormat({ headers, report: semantic, id, hint, provenance, platform, by, displayName: hint ? `${hint} (${id.split('.')[2]})` : undefined });
  await store.putLearnedFormat(fmt);
  return fmt;
}

/** Inspect an uploaded CSV: headers, row count, detected source, and the
 *  conversion directions whose source matches it. No conversion performed. */
export function analyze(csvText) {
  const table = parseCsv(csvText);
  const detection = detectFormat(table.headers);
  const suggestions = DIRECTIONS.filter((d) => d.expectPlatform === detection.platform);
  return {
    headers: table.headers,
    rowCount: table.rows.length,
    detection, // { format, platform, entity }
    suggestions, // directions that accept this source platform
  };
}

/**
 * Convert one file. Credit gating is handled upstream in main.mjs before this
 * function is called — conversion always runs on the full input.
 */
export function runConversion(input = {}) {
  const {
    csvText, direction, expectPlatform, entity, dateOrder, weightUnit,
    categoriesCsv, secondaryCsv, secondaryLang,
    redirectOldBase, redirectNewBase, overrides, corrections, limitUnits,
  } = input;

  const opts = { direction, expectPlatform, entity, dateOrder, weightUnit, categoriesCsv, secondaryCsv, secondaryLang, redirectOldBase, redirectNewBase, limitUnits };
  if (input.knowledge) opts.knowledge = input.knowledge;
  if (input.categoriesAsTags === true) opts.categoriesAsTags = true;
  if (['untracked', 'continue', 'source'].includes(input.stockMode)) opts.stockMode = input.stockMode;
  // The SKU generator the user set at step 3 (off unless enabled; core/knowledge-proposal/sku.mjs).
  if (input.skuGenerator && typeof input.skuGenerator === 'object') opts.skuGenerator = input.skuGenerator;
  // Where each « case personnalisée » goes, per platform, as chosen at step 3 (core/src/custom-fields.ts).
  if (input.customTargets && typeof input.customTargets === 'object') opts.customTargets = sanitizeCustomTargets(input.customTargets);
  if (overrides && Object.keys(overrides).length > 0) opts.mapping = { overrides };
  if (corrections && Object.keys(corrections).length > 0) opts.corrections = corrections;

  const res = convert(csvText, opts);
  // The user's edits to the OUTPUT file (rename a column, fill / replace text in what Shopify will receive…)
  let outHeaders = res.headers, outRows = res.rows, outReport = [];
  if (res.ok && Array.isArray(input.outEdits) && input.outEdits.length) {
    const edited = applyEdits({ headers: res.headers, rows: res.rows, malformed: [] }, input.outEdits);
    outHeaders = edited.table.headers; outRows = edited.table.rows; outReport = edited.report;
  }
  const outputCsv = res.ok ? serializeCsv(outHeaders, outRows) : '';
  const redirectsCsv = res.redirects ? serializeCsv(res.redirects.headers, res.redirects.rows) : null;

  return {
    ok: res.ok,
    sourceFormat: res.sourceFormat,
    targetFormat: res.targetFormat,
    counts: res.counts,
    errors: res.errors,
    losses: res.losses,
    warnings: res.warnings,
    questions: res.questions,
    preserved: res.preserved,
    ...(res.skus ? { skus: res.skus } : {}),
    ...(res.customFields ? { customFields: res.customFields } : {}),
    outputCsv,
    // The first rows as real cells (CSV-parsed, multi-line values intact): the preview
    // table edits these by position, so it must not re-split the CSV text itself.
    ...(res.ok ? { previewTable: { headers: outHeaders, total: outRows.length, rows: outRows.slice(0, 200).map((r) => outHeaders.map((h) => String(r[h] ?? ''))) } } : {}),
    ...(outReport.length ? { outEditsReport: outReport } : {}),
    redirectsCsv,
  };
}
