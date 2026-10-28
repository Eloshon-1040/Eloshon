// Phase 5.7 — Learned writer.
// Turns what the semantic recogniser found (and what the user decided) about
// an UNKNOWN file into a FormatKnowledge entry for the Learned strata:
//   – signature   : structural hash of the column set (rule 8: several formats
//                   per site are fine — each column set is its own format);
//   – fields      : auto + decided columns → canon paths + registry transforms
//                   (via the canon catalogue + transform-aliases data);
//   – unknownFields: everything else (the generic parser preserves them under
//                   sourceExtension._raw + unmapped[] anyway);
//   – routing     : { platform: 'eloshon'|…, entity } so the engine converts it
//                   with the generic parser — no new code per site.
// Suggestions never become knowledge on their own (5.6 contract).

import { structuralHash } from './recognizer.mjs';

const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'unknown';

/** Provisional id for an unknown column set: `<provenance>.<hint>.<hash>.v1`. */
export function proposeFormatId(headers, { provenance = 'unknown', hint = 'csv' } = {}) {
  return `${provenance}.${slug(hint)}.${structuralHash(headers)}.v1`;
}

/**
 * The field entry that sends ONE source column to canon field `spec` (a
 * catalogue field whose transform has a single-column alias), with the
 * registry transform, the unit read from the column name and, for a custom
 * field, its key. Shared by the Learned writer and the step-3 edits of a
 * Reference format (overlay). → entry, or null for a structural field.
 */
const NUMERIC_TRANSFORMS = new Set(['money', 'int', 'float', 'weight_to_grams', 'length_to_cm']);

/** Weight unit from the magnitude of a column's values, or null when it is unclear. */
function unitFromValues(transform, numeric) {
  if (transform !== 'weight_to_grams' || numeric.median == null) return null;
  if (numeric.median >= 20) return { unit: 'g' };
  if (numeric.median > 0 && numeric.median < 20) return { unit: 'kg' };
  return null;
}

export function entryForCanon({ column, spec, aliases, platform = 'eloshon', confidence = 'user-corrected', by = 'user', metafield, customKey, numeric }) {
  const alias = aliases.aliases?.[spec.transform];
  if (alias === null || alias === undefined) return null;
  const variantScoped = new Set(aliases.variantScoped || []);
  const canon = aliases.canonPaths?.[spec.path]?.replace('{platform}', platform)
    ?? (aliases.appendPaths?.[spec.path] ?? (variantScoped.has(spec.path) ? `variants[].${spec.path}` : spec.path));
  const entry = { path: column, canon, transform: alias.transform, confidence, source: by };
  if (alias.args) entry.args = { ...alias.args };
  // Unit-bearing fields (weight, length): the unit is read from the column
  // name when it says so ("Poids (kg)", "Weight (g)"), else the data default.
  const uh = spec.unitHint && aliases.unitHints?.[spec.unitHint];
  if (uh) {
    // The unit may sit anywhere in the name ("Weight_g", "Masse en grammes",
    // "Gewicht in g"): a word boundary would miss "_g", so letters are the border.
    const m = column.toLowerCase().match(new RegExp('(?<![a-zà-ÿ])(' + uh.units.join('|') + ')(?![a-zà-ÿ])'));
    entry.transform = uh.transform;
    let unit = m ? m[1] : uh.default;
    if (!m) {
      // No unit in the name: the VALUES decide (a "Poids" column holding 500, 750,
      // 1200 is grams; one holding 0.5, 1.2, 2 is kilos). Never a blind kg.
      const guess = numeric && unitFromValues(uh.transform, numeric);
      if (guess) { unit = guess.unit; entry.notes = `unit ${guess.unit} inferred from the values (median ${numeric.median}) — not stated in the column name`; }
      else entry.notes = `unit assumed ${uh.default} (not stated in the column name)`;
    }
    entry.args = { [uh.argName]: unit };
  }
  // The column's decimal separator, decided on all its values (1,234 → 1.234 or 1234).
  if (numeric?.decimal && NUMERIC_TRANSFORMS.has(entry.transform)) entry.args = { ...(entry.args || {}), decimal: numeric.decimal };
  if (alias.transform === 'metafield_pair') {
    // 6.5: a recognised metafield column keeps its source key and namespace
    // (P2) instead of the column label; ownership is recorded as a note so
    // the entry says why it is a carry and not a mapping. A custom field the
    // user NAMED in step 3 (`marca_producto` → `brand_origin`) wins.
    const mf = metafield;
    entry.args = customKey ? { key: String(customKey) } : mf?.key ? { key: mf.key, ...(mf.namespace ? { namespace: mf.namespace } : {}) } : { key: column };
    if (mf?.owner === 'thirdParty') entry.notes = `carried as a metafield: ${mf.namespace ? 'namespace ' + mf.namespace : 'key ' + mf.key} is app-owned (${mf.via})`;
  }
  if (variantScoped.has(spec.path)) entry.when = 'self';
  if (spec.pii) entry.samplePolicy = 'redact';
  return entry;
}

/**
 * buildLearnedFormat({ id?, headers, report, catalog, aliases, displayName?,
 *                      provenance?, platform?, entity?, hint?, by? })
 *  report  : SemanticReport (recognizeColumns output, decisions already applied)
 *  catalog : canon field catalogue (fields.v1.json)
 *  aliases : transform-aliases.v1.json
 * → FormatKnowledge (schema-valid), ready for store.putLearnedFormat()
 */
/** A file with one ROW per variant: a column recognised as the group key
 *  (parent id / handle) whose values repeat, plus the option columns (Couleur,
 *  Taille…). null when the file is one row per product. */
function detectRowVariants(report) {
  const decided = (c) => (c.status === 'auto' || c.status === 'decided') && c.best;
  const group = report.columns.find((c) => decided(c) && (c.best.canon === 'parentRef' || c.best.canon === 'handle') && c.profile && c.profile.nonEmpty >= 2 && c.profile.uniqueRatio <= 0.85);
  if (!group) return null;
  const options = report.columns.filter((c) => decided(c) && c.best.canon === 'options' && c.column !== group.column).map((c) => c.column);
  return { group: group.column, options };
}

export function buildLearnedFormat({ id, headers, report, catalog, aliases, displayName, provenance = 'unknown', platform = 'eloshon', entity = 'products', hint = 'csv', by = 'user' }) {
  const formatId = id || proposeFormatId(headers, { provenance, hint });
  const byPath = new Map((catalog.fields || []).filter((f) => !entity || f.entity === entity).map((f) => [f.path, f]));
  const fields = [];
  const unknownFields = [];
  const now = new Date().toISOString();
  const rowVariants = entity === 'products' ? detectRowVariants(report) : null;

  for (const col of report.columns) {
    // option axes of a one-row-per-variant file are read together (below), once
    if (rowVariants?.options.includes(col.column)) continue;
    if (col.status === 'ignored') { fields.push({ path: col.column, canon: null, transform: 'ignore', confidence: 'user-confirmed', source: by }); continue; }
    if (!(col.status === 'auto' || col.status === 'decided') || !col.best) { unknownFields.push({ path: col.column, observedAt: now }); continue; }
    const spec = byPath.get(col.best.canon);
    if (!spec) { unknownFields.push({ path: col.column, observedAt: now }); continue; }
    const alias = aliases.aliases?.[spec.transform];
    const confidence = col.best.confidence === 'user-confirmed' || col.best.confidence === 'user-corrected' ? col.best.confidence : 'inferred';
    // 6.7 (P1): a non-default locale column recognised as `translations` lands
    // on translations.<locale>.<field> (nested canon path, text/html transform).
    const tr = col.context?.translation;
    if (spec.path === 'translations' && tr && !tr.isDefault) {
      fields.push({ path: col.column, canon: `translations.${tr.locale}.${tr.field}`, transform: tr.field === 'bodyHtml' ? 'html' : 'text', confidence, source: by, notes: `locale ${tr.locale} of ${tr.field}` });
      continue;
    }
    if (alias === null || alias === undefined) {
      // structural / multi-column concept: keep the column verbatim, flagged promotable
      fields.push({ path: col.column, canon: `sourceExtension.${platform}.${col.column}`, transform: 'text', preservationReason: 'ambiguous', confidence, source: by, notes: `recognised as ${spec.path} (${spec.transform}) — needs a structural mapping` });
      continue;
    }
    fields.push(entryForCanon({ column: col.column, spec, aliases, platform, confidence, by, metafield: col.context?.metafield, customKey: col.best.decision?.args?.key, numeric: col.profile?.numeric }));
  }

  // every row of the group IS a variant: its fields are read from that row, not only when the product stands alone
  if (rowVariants) for (const f of fields) if (f.when === 'self') delete f.when;
  if (rowVariants?.options.length) {
    fields.push({ path: rowVariants.options[0], inputs: rowVariants.options, canon: 'variants[].optionValues', transform: 'option_values_from_columns', args: { names: rowVariants.options }, confidence: 'inferred', source: by, notes: `option axes (one column per axis, one row per variant, grouped by "${rowVariants.group}")` });
  }

  return {
    schemaVersion: 1,
    id: formatId,
    displayName: displayName || `${hint} (${structuralHash(headers)})`,
    provenance,
    medium: 'csv',
    platformHint: platform,
    entity,
    signatures: [{ kind: 'structural-hash', hash: structuralHash(headers), columnsPreview: headers.slice(0, 40), columns: [...new Set(headers.map((h) => String(h).trim().toLowerCase().replace(/\s+/g, ' ')))] }],
    structure: rowVariants
      ? {
        unit: 'product',
        rows: { groupBy: { column: rowVariants.group, trim: true, emptyOwnUnit: true }, children: { where: { column: rowVariants.group, nonEmpty: true }, selfWhenNone: true } },
        variants: { inlinePath: '__rows', selfWhenNone: true },
        ...(rowVariants.options.length ? { options: { fromVariants: { columns: rowVariants.options } } } : {}),
      }
      : { unit: 'product', variants: { selfWhenNone: true } },
    routing: { platform, entity },
    fields,
    ...(unknownFields.length ? { unknownFields } : {}),
    invariantsExpected: [],
    history: [{ at: now, op: 'seed', from: by, origin: 'learned', diff: [`learned from a file with ${headers.length} columns: ${fields.filter((f) => f.canon && !f.canon.startsWith('sourceExtension')).length} mapped, ${unknownFields.length} unknown`] }],
  };
}
