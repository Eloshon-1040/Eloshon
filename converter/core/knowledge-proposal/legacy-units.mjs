// Phase 2 Lot 3 — uniform preservation + provenance for CSV formats whose canon
// VALUES are still produced by a bespoke engine parser (core/src).
//
// The knowledge entry of such a format is the authority on its columns: its
// `fields[]` declare every column the parser reads (exact `path`, multi-column
// `inputs`, or a column FAMILY via `pathPattern`), the canon path each feeds
// and the transform id describing how; `structure.rows` declares, as data, how
// CSV rows form units (and which rows are the unit's children). Nothing here
// knows a platform by name.
//
// annotateUnits() runs AFTER the bespoke parser, on its canon units, and adds
// only the preservation channels — every serialiser ignores them, so the
// exported files stay byte-identical:
//   – every column the entry does NOT declare, with a value on the unit's
//     rows, is kept verbatim under sourceExtension.<platform>._raw and listed
//     in unmapped[] (reason 'unknown');
//   – every declared column with a value records provenance on the canon path
//     it feeds (method 'exact', or 'override' when the user re-pointed it in
//     step 3); child-scope paths land on the aligned child (variant / line item).
// Alignment is checked, never assumed: when the data-declared grouping does not
// yield exactly the parser's unit (or child) count, nothing is attributed and
// the caller reports it.

/** ── Row conditions (data) ──────────────────────────────────────────────────
 *  { column, equals | notEquals | in | nonEmpty | empty | containsToken: { split, token } , ignoreCase }
 *  { anyOf: [cond…] } | { allOf: [cond…] } | { not: cond }  */
export function rowMatches(row, cond) {
  if (!cond) return true;
  if (Array.isArray(cond.anyOf)) return cond.anyOf.some((c) => rowMatches(row, c));
  if (Array.isArray(cond.allOf)) return cond.allOf.every((c) => rowMatches(row, c));
  if (cond.not) return !rowMatches(row, cond.not);
  const raw = String(row?.[cond.column] ?? '').trim();
  const v = cond.ignoreCase ? raw.toLowerCase() : raw;
  const norm = (x) => (cond.ignoreCase ? String(x).toLowerCase() : String(x));
  if (cond.nonEmpty === true && v === '') return false;
  if (cond.empty === true && v !== '') return false;
  if (cond.equals !== undefined && v !== norm(cond.equals)) return false;
  if (cond.notEquals !== undefined && v === norm(cond.notEquals)) return false;
  if (Array.isArray(cond.in) && !cond.in.map(norm).includes(v)) return false;
  if (cond.containsToken) {
    const tokens = v.split(new RegExp(cond.containsToken.split ?? ',')).map((s) => s.trim());
    if (!tokens.includes(norm(cond.containsToken.token))) return false;
  }
  return true;
}

/** ── Units from rows (data: structure.rows) ─────────────────────────────────
 *  include      cond — rows that are units at all (others are skipped)
 *  groupBy      { column, trim?, skipEmpty?, emptyOwnUnit? } — rows sharing the
 *               key form one unit, in order of first appearance; a row with an
 *               EMPTY key is dropped (skipEmpty) or stands as its own unit
 *               (emptyOwnUnit) — never merged with the other empty-key rows
 *  sequence     { column, start } — a unit starts at each row whose column
 *               equals `start` (ignoring case); rows before the first are orphans
 *  link         { childWhere, parentColumn, stripPrefix?, keyColumns } — rows
 *               matching childWhere attach to the unit whose keyColumns (tried
 *               in order) equal their parent value; the others are units
 *  head         { firstWhere } — the unit's main row (default: its first row)
 *  children     { where, selfWhenNone } — the unit's child rows (variants /
 *               line items); selfWhenNone = the head row stands as the child;
 *               { self: true } = the unit's head row IS its only child
 *  → [{ head, rows: [idx…], children: [idx…] }] (row indexes into `rows`) */
export function unitsOfRows(spec = {}, rows = []) {
  const idx = rows.map((_, i) => i).filter((i) => rowMatches(rows[i], spec.include));
  let groups;
  if (spec.groupBy) {
    const { column, trim = false, skipEmpty = false, emptyOwnUnit = false } = spec.groupBy;
    const order = [];
    const byKey = new Map();
    for (const i of idx) {
      let key = String(rows[i][column] ?? '');
      if (trim) key = key.trim();
      if (skipEmpty && key === '') continue;
      if (emptyOwnUnit && key === '') key = '\u0000row' + i;
      if (!byKey.has(key)) { byKey.set(key, []); order.push(key); }
      byKey.get(key).push(i);
    }
    groups = order.map((k) => byKey.get(k));
  } else if (spec.sequence) {
    const { column, start } = spec.sequence;
    groups = [];
    let cur = null;
    for (const i of idx) {
      if (String(rows[i][column] ?? '').trim().toLowerCase() === String(start).toLowerCase()) { cur = [i]; groups.push(cur); }
      else if (cur) cur.push(i);
    }
  } else if (spec.link) {
    const { childWhere, parentColumn, stripPrefix = '', keyColumns = [] } = spec.link;
    const childrenOf = new Map();
    for (const i of idx) {
      if (!rowMatches(rows[i], childWhere)) continue;
      let p = String(rows[i][parentColumn] ?? '').trim();
      if (stripPrefix && p.startsWith(stripPrefix)) p = p.slice(stripPrefix.length);
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p).push(i);
    }
    groups = idx.filter((i) => !rowMatches(rows[i], childWhere)).map((i) => {
      let kids = [];
      for (const k of keyColumns) { const key = rows[i][k]; if (key && childrenOf.get(key)?.length) { kids = childrenOf.get(key); break; } }
      return [i, ...kids];
    });
  } else {
    groups = idx.map((i) => [i]);
  }
  return groups.map((g) => {
    const headIdx = spec.head?.firstWhere ? (g.find((i) => rowMatches(rows[i], spec.head.firstWhere)) ?? g[0]) : g[0];
    let children = [];
    if (spec.children?.self) children = [headIdx];
    else if (spec.children) {
      children = g.filter((i) => rowMatches(rows[i], spec.children.where));
      if (!children.length && spec.children.selfWhenNone) children = [headIdx];
    }
    return { head: headIdx, rows: g, children };
  });
}

const MAX_PROVENANCE_VALUE = 200;
const short = (v) => (v.length > MAX_PROVENANCE_VALUE ? v.slice(0, MAX_PROVENANCE_VALUE) + '…' : v);
const filled = (v) => String(v ?? '').trim() !== '';

/** Every column the entry accounts for: exact paths, inputs, consumes, families. */
export function declaredColumns(format) {
  const exact = new Set();
  const patterns = [];
  for (const f of format.fields || []) {
    if (f.pathPattern) patterns.push(new RegExp(f.pathPattern));
    else if (f.path) exact.add(f.path);
    for (const p of f.inputs || []) exact.add(p);
    for (const p of f.consumes || []) exact.add(p);
  }
  return { has: (col) => exact.has(col) || patterns.some((re) => re.test(col)) };
}

/**
 * annotateUnits(format, table, units, opts)
 *   format    the knowledge entry (fields + structure.rows)
 *   table     { headers, rows } — the WORKING table the parser read
 *   units     the parser's canon units (mutated: preservation channels only)
 *   opts.childKey         'variants' | 'lineItems' — where child-scope paths land
 *   opts.overrideColumns  { [declaredColumn]: chosenColumn | null } (step-3 re-points)
 * → { aligned, unknownColumns: [{ column, units }] }
 */
export function annotateUnits(format, table, units, { childKey = 'variants', overrideColumns = {} } = {}) {
  const platform = format.legacy?.platform || format.platformHint || String(format.id).split('.')[0];
  const rows = table.rows || [];
  const groups = unitsOfRows(format.structure?.rows || {}, rows);
  if (groups.length !== units.length) return { aligned: false, unknownColumns: [] };

  const declared = declaredColumns(format);
  const chosen = new Set(Object.values(overrideColumns).filter(Boolean));
  const unknownCols = (table.headers || []).filter((h) => !declared.has(h) && !chosen.has(h));
  const unknownCount = new Map();
  // A column FAMILY (pathPattern) resolves to the file's columns it matches.
  const familyColumns = (f) => { const re = new RegExp(f.pathPattern); return (table.headers || []).filter((h) => re.test(h)); };
  const entries = (format.fields || []).filter((f) => typeof f.canon === 'string' && f.transform !== 'ignore' && !f.canon.startsWith('sourceExtension') && f.canon !== 'unmapped')
    .map((f) => (f.pathPattern ? { ...f, inputs: familyColumns(f), family: true } : f))
    .filter((f) => !f.pathPattern || f.inputs.length);
  const childPrefix = childKey + '[].';

  groups.forEach((g, u) => {
    const unit = units[u];
    const head = rows[g.head];

    // 1. undeclared columns: verbatim, one value per unit (or per row when its rows disagree)
    const ext = {};
    const unmapped = [];
    for (const col of unknownCols) {
      const values = g.rows.map((i) => String(rows[i][col] ?? ''));
      const distinct = [...new Set(values.filter(filled))];
      if (!distinct.length) continue;
      const value = distinct.length === 1 ? distinct[0] : values;
      ext[col] = value;
      unmapped.push({ platform, sourceField: col, sourceValue: value, reason: 'unknown' });
      unknownCount.set(col, (unknownCount.get(col) ?? 0) + 1);
    }
    if (unmapped.length) {
      const se = unit.sourceExtension || (unit.sourceExtension = {});
      se[platform] = { ...(se[platform] || {}), _raw: { ...(se[platform]?._raw || {}), ...ext } };
      unit.unmapped = [...(unit.unmapped || []), ...unmapped];
    }

    // 2. provenance of declared columns
    const children = unit[childKey];
    const childAligned = Array.isArray(children) && g.children.length === children.length;
    for (const f of entries) {
      const cols = f.inputs && f.inputs.length ? f.inputs : [f.path];
      const resolved = cols.map((c) => (Object.prototype.hasOwnProperty.call(overrideColumns, c) ? overrideColumns[c] : c));
      if (resolved.every((c) => c === null)) continue; // excluded by the user in step 3
      const method = cols.some((c) => Object.prototype.hasOwnProperty.call(overrideColumns, c) && overrideColumns[c]) ? 'override' : 'exact';
      const live = resolved.filter(Boolean);
      const isChild = f.canon.startsWith(childPrefix);
      const keys = f.canon.split('+').map((s) => s.trim()).map((k) => (k.startsWith(childPrefix) ? k.slice(childPrefix.length) : k).replace(/\[\]$/, ''));
      const record = (row) => {
        // a family names only the members this row fills; declared inputs are named as a whole
        const used = f.family ? live.filter((c) => filled(row?.[c])) : live;
        const vals = used.map((c) => String(row?.[c] ?? ''));
        if (!vals.some(filled)) return null;
        return { platform, sourceField: used.join(' + '), sourceValue: short(vals.find(filled)), transform: f.transform, method };
      };
      if (!isChild) {
        const p = record(head);
        if (!p) continue;
        unit.provenance = unit.provenance || {};
        for (const k of keys) unit.provenance[k] = p;
      } else if (childAligned) {
        g.children.forEach((ri, j) => {
          const p = record(rows[ri]);
          if (!p) return;
          const child = children[j];
          if (child && typeof child === 'object' && childKey === 'variants') {
            child.provenance = child.provenance || {};
            for (const k of keys) child.provenance[k] = p;
          } else {
            unit.provenance = unit.provenance || {};
            for (const k of keys) unit.provenance[`${childKey}[${j}].${k}`] = p;
          }
        });
      }
    }
  });
  return { aligned: true, unknownColumns: [...unknownCount].map(([column, n]) => ({ column, units: n })) };
}
