// Phase 5.3 — FormatRecognizer.
// Matches an input SHAPE (CSV header set, JSON paths, XML root) against the
// signatures carried by FormatKnowledge entries. Signatures are DATA read
// from the KnowledgeStore (Reference ⊕ Learned) — this module holds no
// per-platform rule and no list order: detected formats are ranked by
// SPECIFICITY (how many signature columns matched), then coverage, then id.
//
// Two layers:
//   – pure/sync:  matchSignature(sig, input), recognize(input, formats),
//                 structuralHash(columns), toLegacyDetection(...)
//                 → usable from the synchronous engine (detect.ts).
//   – async:      createFormatRecognizer(store) → reads the store on demand.

import crypto from 'node:crypto';

/** Header normalisation shared by every csv-header-set comparison:
 *  trim, collapse whitespace, case-insensitive. */
export function normHeader(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Opaque, stable hash of a column SET (order-insensitive, normalised).
 *  Used to name scraper-generated formats (`scraper.<site>.<hash>.v1`) and
 *  to match `structural-hash` signatures. 6 hex chars = 16M buckets, plenty
 *  for "several formats per site". */
export function structuralHash(columns) {
  const key = [...new Set(columns.map(normHeader))].sort().join('\n');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 6);
}

export const KIND_RANK = { exact: 4, superset: 3, similar: 2.5, subset: 2, partial: 1, none: 0 };
export function rankKind(k) { return KIND_RANK[k] ?? 0; }

/** exact / superset = the input IS this format (all gating columns present);
 *  similar = a TAUGHT format whose column set is nearly the file's (a column added or removed
 *  since the last export), see SIMILAR_MIN. */
export function isDetected(kind) { return kind === 'exact' || kind === 'superset' || kind === 'similar'; }

/** A taught format matches a file with the same columns but a few: at least this share of
 *  the union is common (Jaccard) and at least this many columns are shared. */
export const SIMILAR_MIN = { jaccard: 0.8, shared: 4 };

const NONE = () => ({ kind: 'none', coverage: 0, missing: [], extra: [], matched: [], score: 0 });

/** Match ONE signature against ONE input shape. Pure. */
export function matchSignature(sig, input) {
  if (!sig || !input || sig.kind !== input.kind) {
    // structural-hash signatures are matched against csv-header-set inputs
    if (sig && input && sig.kind === 'structural-hash' && input.kind === 'csv-header-set') {
      const h = structuralHash(input.columns);
      if (h === sig.hash) return { kind: 'exact', coverage: 1, missing: [], extra: [], matched: [sig.hash], score: input.columns.length };
      if (Array.isArray(sig.columns) && sig.columns.length) {
        const a = new Set(sig.columns.map(normHeader));
        const b = new Set(input.columns.map(normHeader));
        const shared = [...a].filter((c) => b.has(c));
        const union = new Set([...a, ...b]).size;
        const jaccard = union ? shared.length / union : 0;
        if (jaccard >= SIMILAR_MIN.jaccard && shared.length >= SIMILAR_MIN.shared) {
          // the score stays tiny: any REAL signature match outranks it, it only wins when nothing else does
          return { kind: 'similar', coverage: jaccard, missing: [...a].filter((c) => !b.has(c)), extra: [...b].filter((c) => !a.has(c)), matched: shared, score: shared.length / 1000 };
        }
      }
      return NONE();
    }
    return NONE();
  }

  if (sig.kind === 'csv-header-set') {
    const cols = new Set(input.columns.map(normHeader));
    const req = uniq((sig.required || []).map(normHeader));
    const anyOf = uniq((sig.anyOf || []).map(normHeader));
    const hints = uniq((sig.hints || []).map(normHeader));

    const reqPresent = req.filter((c) => cols.has(c));
    const missing = req.filter((c) => !cols.has(c));
    const anyPresent = anyOf.filter((c) => cols.has(c));
    const hintsPresent = hints.filter((c) => cols.has(c));
    const sigAll = new Set([...req, ...anyOf, ...hints]);
    const extra = [...cols].filter((c) => !sigAll.has(c));

    const gated = missing.length === 0 && (anyOf.length === 0 || anyPresent.length > 0);
    const matched = [...reqPresent, ...anyPresent, ...hintsPresent];
    // coverage: gating columns weigh as a block; hints refine within it
    const denom = req.length + (anyOf.length ? 1 : 0) + hints.length;
    const coverage = denom === 0 ? 1
      : (reqPresent.length + (anyPresent.length ? 1 : 0) + hintsPresent.length) / denom;
    const score = matched.length;

    let kind;
    // A closed signature (a file Eloshon writes itself, whose columns the user may extend) matches only its own
    // columns: an added column leaves the file to semantic recognition, which maps it, instead of keeping it raw.
    if (gated) kind = extra.length === 0 ? 'exact' : (sig.closed ? 'partial' : 'superset');
    else {
      const reqCoverage = req.length === 0 ? 0 : reqPresent.length / req.length;
      const threshold = typeof sig.minCoverage === 'number' ? sig.minCoverage : 1;
      if (extra.length === 0 && reqPresent.length > 0 && reqPresent.length < req.length) kind = 'subset';
      else if (reqCoverage >= threshold * 0.5 && reqPresent.length > 0) kind = 'partial';
      else kind = 'none';
    }
    return { kind, coverage, missing, extra, matched, score };
  }

  if (sig.kind === 'json-shape') {
    const paths = new Set(input.paths);
    const req = uniq(sig.requiredPaths || []);
    const hints = uniq(sig.hintPaths || []);
    const reqPresent = req.filter((p) => paths.has(p));
    const missing = req.filter((p) => !paths.has(p));
    const hintsPresent = hints.filter((p) => paths.has(p));
    const sigAll = new Set([...req, ...hints]);
    const extra = [...paths].filter((p) => !sigAll.has(p));
    const denom = req.length + hints.length;
    const coverage = denom === 0 ? 1 : (reqPresent.length + hintsPresent.length) / denom;
    const matched = [...reqPresent, ...hintsPresent];
    let kind;
    if (missing.length === 0) kind = extra.length === 0 ? 'exact' : 'superset';
    else if (extra.length === 0 && reqPresent.length > 0) kind = 'subset';
    else if (req.length && reqPresent.length / req.length >= 0.5) kind = 'partial';
    else kind = 'none';
    return { kind, coverage, missing, extra, matched, score: matched.length };
  }

  if (sig.kind === 'xml-root') {
    if (sig.root !== input.root) return { ...NONE(), missing: [sig.root] };
    const req = uniq(sig.requiredElements || []);
    const els = new Set(input.elements || []);
    const present = req.filter((p) => els.has(p));
    const missing = req.filter((p) => !els.has(p));
    const coverage = req.length === 0 ? 1 : present.length / req.length;
    const matched = [sig.root, ...present];
    return {
      kind: missing.length === 0 ? 'exact' : coverage >= 0.5 ? 'partial' : 'none',
      coverage, missing, extra: [], matched, score: matched.length,
    };
  }

  return NONE();
}

/** Best signature of a format against the input (formats may carry several). */
export function matchFormat(format, input) {
  let best = NONE();
  for (const sig of format.signatures || []) {
    const r = matchSignature(sig, input);
    if (compareMatch(r, best) < 0) best = r;
  }
  return best;
}

// Sort order: detected first, then specificity, then kind rank, coverage, id.
function compareMatch(a, b) {
  const da = isDetected(a.kind) ? 1 : 0, db = isDetected(b.kind) ? 1 : 0;
  if (da !== db) return db - da;
  if (a.score !== b.score) return b.score - a.score;
  if (rankKind(a.kind) !== rankKind(b.kind)) return rankKind(b.kind) - rankKind(a.kind);
  if (a.coverage !== b.coverage) return b.coverage - a.coverage;
  return String(a.formatId ?? '').localeCompare(String(b.formatId ?? ''));
}

/** Rank every known format against the input. Returns SignatureMatch[]
 *  best-first; formats with verdict `none` are omitted (empty array = unknown). */
export function recognize(input, formats) {
  const out = [];
  for (const f of formats) {
    const r = matchFormat(f, input);
    if (r.kind !== 'none') out.push({ formatId: f.id, ...r });
  }
  out.sort(compareMatch);
  return out;
}

/** Engine routing for the best DETECTED format:
 *  – `legacy` block  → the pre-Phase-5 per-format parser (format = legacy id);
 *  – `routing` block → the generic knowledge-driven parser (format = 'knowledge');
 *  – neither         → unknown (recognised but not convertible yet). */
export function toLegacyDetection(matches, formats) {
  const byId = new Map(formats.map((f) => [f.id, f]));
  for (const m of matches) {
    if (!isDetected(m.kind)) break;
    const f = byId.get(m.formatId);
    if (!f) continue;
    if (f.legacy) return { format: f.legacy.formatId, platform: f.legacy.platform, entity: f.legacy.entity, knowledgeId: f.id, displayName: f.displayName };
    if (f.routing) return { format: 'knowledge', platform: f.routing.platform, entity: f.routing.entity, knowledgeId: f.id, displayName: f.displayName, ...(m.kind === 'similar' ? { similar: { added: m.extra.length, missing: m.missing.length } } : {}) };
    return { format: 'unknown', platform: null, entity: f.entity ?? null, knowledgeId: f.id, displayName: f.displayName };
  }
  return { format: 'unknown', platform: null, entity: null, knowledgeId: null, displayName: null };
}

/** Async recognizer bound to a KnowledgeStore: Reference ∪ Learned, read on
 *  every call (the store is the source of truth; Learned can change at runtime). */
export function createFormatRecognizer(store) {
  async function loadFormats() {
    const descriptors = await store.listFormats();
    const formats = await Promise.all(descriptors.map((d) => store.getFormat(d.id)));
    return formats.filter(Boolean);
  }
  return {
    /** SignatureMatch[] best-first for any shape. */
    async recognize(input) { return recognize(input, await loadFormats()); },
    /** Convenience for CSV: headers → SignatureMatch[]. */
    async recognizeHeaders(columns) { return recognize({ kind: 'csv-header-set', columns }, await loadFormats()); },
    /** Legacy-engine detection { format, platform, entity, knowledgeId }. */
    async detect(columns) {
      const formats = await loadFormats();
      return toLegacyDetection(recognize({ kind: 'csv-header-set', columns }, formats), formats);
    },
    structuralHash,
  };
}

function uniq(arr) { return [...new Set(arr)]; }
