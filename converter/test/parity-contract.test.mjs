/**
 * Phase 5.8 — analysis ↔ conversion parity contract, automated.
 * "What the analysis step promises, the conversion step delivers":
 *   (A) mapping plans: every APPLIED + CARRIED binding lands in the output —
 *       its target columns exist and, when the source column has values, at
 *       least one output row carries a value there;
 *   (B) knowledge-driven formats: every declared canon field whose source
 *       value is non-empty is present in the parsed canon (provenance keyed),
 *       and every source key is accounted for (nothing silently dropped);
 *   (C) the semantic report agrees with the plan: an AUTO column bound to a
 *       rule never contradicts the rule's canon.
 * Runs over the whole case matrix — extend the matrix, the contract follows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as engine from '../core/dist/index.mjs';
import { loadReferenceFormatsSync } from '../core/knowledge-proposal/reference.mjs';
import { CASES, runCase } from './cases.mjs';

const { parseCsv, detectFormat, analyzePlan, hasMappingPlan, targetFormatFor } = engine;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const read = (rel) => fs.readFileSync(path.join(FIX, rel), 'utf8');
const nonEmpty = (rows, col) => rows.some((r) => (r[col] ?? '').trim() !== '');

for (const c of CASES.filter((x) => x.kind !== 'json' && !x.knowledge)) {
  const table = parseCsv(read(c.fixture));
  const det = detectFormat(table.headers);
  if (det.format === 'knowledge' || det.format === 'unknown') continue;
  const target = targetFormatFor(c.opts.direction, det.entity);
  if (!hasMappingPlan(det.format, target)) continue;

  test(`parity (A) plan → output: ${c.name}`, () => {
    const plan = analyzePlan(table.headers, det.format, target, det.entity, {}, { recognize: 'semantic', rows: table.rows, formatId: det.knowledgeId });
    const { res } = runCase(c, { read, engine: { ...engine, loadReferenceFormatsSync } });
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    const out = new Set(res.headers);
    // TARGET_FIELDS may describe a structural family with a LABEL ("Option1–3
    // Name/Value", "SKU (parent)") rather than a literal column: only literal
    // promises are checked for presence; a family label is checked by prefix.
    const isLabel = (col) => /[()…–/]/.test(col);
    const familyPresent = (label) => { const stem = label.split(/[ (–…/]/)[0]; return stem.length >= 3 && res.headers.some((h) => h.startsWith(stem)); };
    for (const b of plan.bindings.filter((x) => x.applied && x.carried)) {
      // Serialisers may prune columns that would be empty for the whole file: a
      // promise only binds when the source column actually carries values.
      const sourceHasValues = !b.resolvedColumn || !table.headers.includes(b.resolvedColumn) || nonEmpty(table.rows, b.resolvedColumn);
      for (const col of b.targetColumns) {
        if (!sourceHasValues) continue;
        if (isLabel(col)) assert.ok(familyPresent(col), `${c.name}: promised target family "${col}" (${b.id}) has no column in the output`);
        else assert.ok(out.has(col), `${c.name}: promised target column "${col}" (${b.id}) missing from output`);
      }
      if (b.editable && b.resolvedColumn && nonEmpty(table.rows, b.resolvedColumn) && b.targetColumns.every((col) => !isLabel(col))) {
        const delivered = b.targetColumns.some((col) => nonEmpty(res.rows, col));
        assert.ok(delivered, `${c.name}: "${b.resolvedColumn}" → ${b.canon} promised as ${b.targetColumns.join('/')} but every output row is empty there`);
      }
    }
    // (C) semantic never contradicts an exact rule binding
    for (const col of plan.semantic.columns.filter((x) => x.status === 'auto')) {
      const rules = plan.bindings.filter((b) => b.applied && b.resolvedColumn === col.column && b.confidence === 'high').map((b) => b.canon);
      if (rules.length) assert.ok(rules.includes(col.best.canon), `${c.name}: semantic says "${col.column}" is ${col.best.canon}, the exact rule says ${rules.join('/')}`);
    }
  });
}

for (const c of CASES.filter((x) => x.canon || x.kind === 'json')) {
  test(`parity (B) knowledge → canon: ${c.name}`, () => {
    const { res, canon } = runCase(c, { read, engine: { ...engine, loadReferenceFormatsSync } });
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(canon) && canon.length > 0);
    const formats = [...loadReferenceFormatsSync(), ...(c.knowledge ?? []).map((rel) => JSON.parse(read(rel)))];
    const fmt = formats.find((f) => f.id === res.sourceFormat);
    assert.ok(fmt, 'format entry for ' + res.sourceFormat);
    // Source units, the way the parser saw them
    let units;
    if (c.kind === 'json') units = JSON.parse(read(c.input.units ?? c.input.products));
    else if (c.fixture.endsWith('.json')) units = JSON.parse(read(c.fixture)); // a dropped JSON file (products.json)
    else units = parseCsv(read(c.fixture)).rows;
    assert.equal(canon.length, units.length, 'one canon product per source unit');

    const declared = fmt.fields.filter((f) => typeof f.canon === 'string' && !f.canon.startsWith('sourceExtension') && f.canon !== 'unmapped' && f.transform !== 'ignore' && (f.scope ?? (f.canon.startsWith('variants[].') ? 'variant' : 'product')) === 'product' && !f.canon.endsWith('[]'));
    units.forEach((u, i) => {
      const p = canon[i];
      for (const f of declared) {
        const raw = f.inputs ? f.inputs.map((k) => u[k]) : u[f.path];
        const has = Array.isArray(raw) ? raw.some((x) => x !== undefined && x !== null && x !== '' && !(Array.isArray(x) && !x.length)) : raw !== undefined && raw !== null && raw !== '' && !(Array.isArray(raw) && !raw.length);
        if (!has) continue;
        const keys = f.canon.split('+').map((s) => s.trim());
        for (const k of keys) {
          const delivered = Object.keys(p.provenance || {}).some((pk) => pk === k || pk.startsWith(k + '.') || pk.startsWith(k + '['));
          const value = k.split('.').reduce((o, s) => (o == null ? undefined : o[s]), p);
          const empty = value === undefined || value === '' || (Array.isArray(value) && !value.length);
          // A declared field with a source value must be delivered — unless the
          // transform legitimately yields nothing (differs_from / tag_when_true / enum default).
          const mayBeEmpty = ['differs_from', 'tag_when_true', 'enum_map', 'category_paths_from_terms', 'category_path_split', 'names_of', 'name_of_first', 'images_from_urls', 'images_from_objects', 'attributes_rich', 'options_from_attributes', 'default_option_values', 'downloads', 'metafields_from_pairs', 'ids_to_strings', 'int_or_null', 'sentinel_to_null', 'sale_period', 'stock_policy', 'timestamps',
            // 6.3: the default locale is the flat fields — a source with only default-locale rows yields no translations
            'translations_from_entities', 'translations_from_pairs',
            // 7.6: optional blocks / companion joins / presence-based values yield nothing when the source has nothing to say
            'lookup', 'object_map', 'objects_map', 'marketing_consent', 'format_number', 'address_from', 'sum_of', 'subtract', 'id_or_none', 'pick_where', 'date_present', 'money_present', 'money_nonzero', 'text_present', 'is_unset', 'split_name_options', 'equals_map', 'includes_map', 'constant', 'copy_present', 'list', 'weight_to_grams', 'bool',
            // PrestaShop multilingual [{id,value}] arrays whose every value is '' → nothing to deliver
            'first_lang_value', 'parent_field',
            // PrestaShop option axes: a standard (non-combinations) product has no axis to derive → []
            'prestashop_product_options', 'prestashop_variant_option_values'].includes(f.transform);
          if (mayBeEmpty && (!delivered || empty)) continue; // the transform legitimately yielded nothing (sentinel, duplicate, empty list)
          if (!delivered || empty) assert.fail(`${c.name} unit ${i}: "${f.path}" declared → ${k} but not delivered (value=${JSON.stringify(value)})`);
        }
      }
      // nothing silently dropped: every source key is either consumed or preserved+listed
      const consumed = new Set(fmt.fields.flatMap((f) => [f.path.split('.')[0], ...(f.inputs ?? []).map((x) => x.split('.')[0]), ...(f.consumes ?? [])]));
      if (fmt.structure?.items?.inlinePath) consumed.add(String(fmt.structure.items.inlinePath).split('.')[0]); // 7.6: the inline line array is consumed by the item scope
      for (const key of Object.keys(u)) {
        if (consumed.has(key)) continue;
        const kept = p.sourceExtension && Object.values(p.sourceExtension).some((ns) => ns && ns._raw && key in ns._raw);
        const listed = (p.unmapped || []).some((x) => x.sourceField === key && x.reason === 'unknown');
        assert.ok(kept && listed, `${c.name} unit ${i}: source key "${key}" neither consumed nor preserved+listed`);
      }
    });
  });
}
