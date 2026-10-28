// Phase 5.4 — Semantic column recogniser.
//
// Given a table (headers + sample rows), proposes for every column the canon
// field(s) it most likely carries, through a scored pipeline:
//
//   name   : exact → alias (EN/FR) → separator-blind (`product_name` = `Product
//            Name`) → same words (synonyms, stop words, unit folded) →
//            ambiguous names (`value`: the values decide) → similarity
//            (tokens + Levenshtein); a unit in the name (`(mm)`, `_kg`) rules
//            out fields measured otherwise
//   profile: what the VALUES look like (price, EAN, HTML, image URL, bool, int,
//            enum, date, email…, uniqueness, emptiness)
//   context: structural families (Image1..n, Option1 Name/Value, Meta:*),
//            columns that REFERENCE another column (parent → id), neighbours
//
// Every threshold, weight, alias and classifier is DATA (core/knowledge-ref/
// canon/*.json). This module reads knowledge; it encodes none.
//
// Resolution: score ≥ auto → 'auto' ; grey ≤ score < auto → 'suggest' (ranked
// candidates, 3 real samples each) ; below grey → 'none' (column preserved as
// metadata downstream). Learned decisions override: confirmed/corrected →
// 'decided', rejected → candidate removed, ignored → 'ignored'.

import { DEFAULT_CONFIG as STORE_DEFAULTS } from './json-store.mjs';
import { numericTokens, parseNumberToken, decimalSeparatorOf, columnKey } from './values.mjs';

// ── Name normalisation ─────────────────────────────────────────────────────

function stripAccents(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, ''); }

/** Column name → normalised tokens (lowercase, no accents, camel/snake split,
 *  stop tokens dropped, synonyms folded). */
export function tokenize(name, cfg) {
  const syn = cfg.name.tokenSynonyms || {};
  const stop = new Set(cfg.name.stopTokens || []);
  const s = stripAccents(String(name ?? ''))
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const fold = (t) => { let cur = t; for (let i = 0; i < 4 && syn[cur] && syn[cur] !== cur; i++) cur = syn[cur]; return cur; };
  const toks = s.split(' ').filter((t) => t && !/^\d+$/.test(t)).map(fold).filter((t) => !stop.has(t));
  return toks.length ? toks : (s ? [s.replace(/\s+/g, '')] : []);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 0..1 similarity between two token lists: half Jaccard, half Levenshtein ratio on the joined form. */
export function tokenSimilarity(a, b) {
  if (!a.length || !b.length) return 0;
  const A = new Set(a), B = new Set(b);
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  const jac = inter / (A.size + B.size - inter);
  const ja = a.join(''), jb = b.join('');
  const lev = 1 - levenshtein(ja, jb) / Math.max(ja.length, jb.length);
  return 0.5 * jac + 0.5 * lev;
}

const normExact = (s) => stripAccents(String(s ?? '')).trim().toLowerCase().replace(/\s+/g, ' ');

/** Separator-blind form of a column name: case, accents, camelCase, `_`, `-`,
 *  spaces and punctuation all fold to single spaces — `product_name`,
 *  `Product-Name`, `PRODUCT NAME` and `productName` are one name. */
export const normalizeColumnName = columnKey;

/** The unit a column name states, read from data (recognition name.unitTokens):
 *  a parenthesised suffix (`Poids (kg)`, `Prix (EUR)`, `Débit (m3/h)` → none)
 *  or a trailing separated token of 2+ letters (`weight_kg`, `length-mm`).
 *  → { unit, kind, bare } (bare = the name without the unit) or null. */
export function columnUnit(column, cfg) {
  const units = cfg.name.unitTokens || {};
  const s = String(column ?? '');
  const paren = s.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (paren) {
    const u = normalizeColumnName(paren[2].split('/')[0]);
    return units[u] ? { unit: u, kind: units[u], bare: paren[1] } : null;
  }
  const n = normalizeColumnName(s).split(' ');
  const last = n[n.length - 1];
  if (n.length >= 2 && last.length >= 2 && units[last]) return { unit: last, kind: units[last], bare: n.slice(0, -1).join(' ') };
  return null;
}

/** Order-free token key of a name with its unit removed (`nom_produit` →
 *  `name`, `Product Brand` → `brand`, `Poids (kg)` → `weight`). */
export function tokenKey(name, cfg) {
  const u = columnUnit(name, cfg);
  return [...new Set(tokenize(u ? u.bare : name, cfg))].sort().join(' ');
}

/** Stage 1–3. Returns { score, via: 'exact'|'alias'|'normalized'|'tokens'|'ambiguous'|'similar'|'none', matchedName }.
 *  exact      — the field's primary column name;
 *  alias      — a known name, case/accent-insensitive;
 *  normalized — a known name once `_` `-` spaces and punctuation are separators;
 *  tokens     — same words once synonyms, stop words and the unit are folded;
 *  ambiguous  — a name that alone fits several fields (`value`): values decide;
 *  similar    — fuzzy token similarity. */
export function nameScore(column, field, cfg, cache) {
  const col = normExact(column);
  // every language the catalogue knows (en, fr, nl, de, es, it, ca…): en[0] stays the primary name
  const names = [...(field.names?.en || []), ...Object.entries(field.names || {}).filter(([k]) => k !== 'en').flatMap(([, v]) => v || [])];
  // Only KNOWN COLUMN NAMES count — never the canon path itself (an internal
  // key like `shipping` would otherwise claim Shopify's "Shipping" amount).
  const primary = (field.names?.en?.slice(0, 1) || []).map(normExact);
  if (primary.includes(col)) return { score: cfg.name.exact, via: 'exact', matchedName: column };
  // A name that alone fits several fields (`value`, `available`) is never
  // settled by the name: each listed field gets the same modest score and the
  // values (profile) rank them — at best a suggestion the user validates.
  const colNorm = cache.norm(column);
  const amb = cfg.name.ambiguous?.[colNorm];
  // List order is the tie-break when the values say nothing either way.
  if (amb) return amb.includes(field.path) ? { score: (cfg.name.ambiguousScore ?? cfg.name.similarityMin) - 0.01 * amb.indexOf(field.path), via: 'ambiguous', matchedName: column } : { score: 0, via: 'none', matchedName: null };
  for (const n of names) if (normExact(n) === col) return { score: cfg.name.alias, via: 'alias', matchedName: n };
  if (colNorm) for (const n of names) if (cache.norm(n) === colNorm) return { score: cfg.name.normalized ?? cfg.name.alias, via: 'normalized', matchedName: n };
  const colKey = cache.key(column);
  // A known name that only matches once its own words were dropped (`Code
  // fabricant` → `brand`) is weaker than one that matches word for word.
  if (colKey && !(cfg.name.tokensExclude || []).includes(field.path)) {
    let hit = null;
    for (const n of names) if (cache.key(n) === colKey && (!hit || cache.dropped(n) < cache.dropped(hit))) hit = n;
    if (hit) return { score: (cfg.name.tokens ?? cfg.name.similarityMax) - 0.02 * cache.dropped(hit), via: 'tokens', matchedName: hit };
  }

  const colToks = cache.col(column);
  let best = 0, bestName = null;
  for (const n of names) {
    const s = tokenSimilarity(colToks, cache.name(n));
    if (s > best) { best = s; bestName = n; }
  }
  const floor = 0.5; // raw similarity under this is noise
  if (best < floor) return { score: 0, via: 'none', matchedName: null };
  const { similarityMin: lo, similarityMax: hi } = cfg.name;
  const score = lo + (hi - lo) * ((best - floor) / (1 - floor));
  return { score, via: 'similar', matchedName: bestName };
}

// ── Value profiling ────────────────────────────────────────────────────────

function compileClassifier(c) {
  return {
    ...c,
    re: c.regex ? new RegExp(c.regex, c.flags || '') : null,
    valueSet: c.values ? new Set(c.values.map((v) => v.toLowerCase())) : null,
  };
}

/** Profile one column's values. Pure; `values` = raw strings (may include empties). */
export function profileValues(values, cfg) {
  const P = cfg.profiles;
  const limit = P.sampleRows || 200;
  const raw = values.slice(0, limit).map((v) => (v == null ? '' : String(v)));
  const nonEmpty = raw.map((v) => v.trim()).filter((v) => v !== '');
  const n = nonEmpty.length;
  const distinct = new Set(nonEmpty);
  const avgLength = n ? nonEmpty.reduce((a, v) => a + v.length, 0) / n : 0;
  const uniqueRatio = n ? distinct.size / n : 0;
  const out = {
    rows: raw.length, nonEmpty: n, emptyRatio: raw.length ? 1 - n / raw.length : 1,
    distinct: distinct.size, uniqueRatio, avgLength, digitRatio: n ? nonEmpty.filter((v) => /\d/.test(v)).length / n : 0, matches: {}, primary: 'empty', profiles: [],
  };
  if (n < (P.minNonEmpty || 3)) return out;

  const compiled = Object.entries(P.classifiers).map(([name, c]) => [name, compileClassifier(c)]);
  const decimalRatio = nonEmpty.filter((v) => /[.,]\d{1,4}\s*(€|\$|£|[A-Z]{3})?$/.test(v)).length / n;
  for (const [name, c] of compiled) {
    let strength = 0;
    if (c.valueSet) {
      const r = nonEmpty.filter((v) => c.valueSet.has(v.toLowerCase())).length / n;
      if (r >= (c.minRatio ?? 0.9)) strength = 1;
    } else if (c.re) {
      const test = (v) => c.re.test(v);
      let r;
      if (c.listSeparators) {
        const sepRe = new RegExp('[' + c.listSeparators.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + ']');
        r = nonEmpty.filter((v) => { const parts = v.split(sepRe).map((p) => p.trim()).filter(Boolean); return parts.length > 0 && parts.every(test); }).length / n;
      } else r = nonEmpty.filter(test).length / n;
      if (r >= (c.minRatio ?? 0.9)) strength = 1;
      if (strength && c.requireDigits && nonEmpty.filter((v) => (v.match(/\d/g) || []).length >= c.requireDigits).length / n < 0.9) strength = 0;
      if (strength && c.minRows && n < c.minRows) strength = 0;
      if (strength && c.minAvgLength && avgLength < c.minAvgLength) strength = 0;
      if (strength && c.maxAvgLength && avgLength > c.maxAvgLength) strength = 0;
      if (strength && c.minUniqueRatio && uniqueRatio < c.minUniqueRatio) strength = 0;
      if (strength && c.maxDistinctRatio && uniqueRatio > c.maxDistinctRatio && n >= (P.enum.minRows || 5)) strength = 0;
      if (strength && typeof c.needsDecimalRatio === 'number' && decimalRatio < c.needsDecimalRatio) strength = 0.6; // weak: could be a plain integer
    } else if (c.minAvgLength) {
      if (avgLength >= c.minAvgLength) strength = 1;
    }
    if (strength) out.matches[name] = strength;
  }
  // enum: low cardinality
  const E = P.enum;
  if (n >= (E.minRows || 5) && distinct.size <= (E.maxDistinct || 12) && distinct.size / n <= (E.maxDistinctRatio || 0.3)) out.matches.enum = 1;
  if (!Object.keys(out.matches).length) out.matches.text = 1;

  const order = P.specificity || Object.keys(P.classifiers);
  const names = Object.keys(out.matches);
  names.sort((a, b) => (out.matches[b] - out.matches[a]) || (idx(order, a) - idx(order, b)));
  out.profiles = names;
  out.primary = names[0];
  out.numeric = numericStats(nonEmpty);
  return out;
}

/** What the NUMBERS of a column look like, from all sampled values (no raw value
 *  is kept, so this is safe for personal columns): the decimal separator the
 *  column uses, how many values settle nothing ("1,234"), the median and whether
 *  they are whole numbers. null when the column is not numeric. */
function numericStats(values) {
  const short = values.filter((v) => v.length <= 30);
  const withNumber = short.filter((v) => numericTokens(v).length > 0);
  if (!short.length || withNumber.length / values.length < 0.6) return null;
  const { decimal, ambiguous } = decimalSeparatorOf(withNumber);
  const nums = withNumber.map((v) => parseNumberToken(numericTokens(v)[0], decimal ?? undefined)).filter((n) => n !== null).sort((a, b) => a - b);
  if (!nums.length) return null;
  const median = nums[Math.floor(nums.length / 2)];
  return { decimal, ambiguous, median, wholeShare: round(nums.filter((n) => Number.isInteger(n)).length / nums.length) };
}
function idx(order, x) { const i = order.indexOf(x); return i < 0 ? 999 : i; }

const NUMERIC_PROFILES = new Set(['int', 'float', 'price']);

/** Stage 4: how well the observed profile fits what the field accepts. */
export function profileScore(field, profile, cfg) {
  const accepts = field.accepts || [];
  const strong = new Set(cfg.profiles.strongTyped || []);
  let best = 0;
  for (const [p, s] of Object.entries(profile.matches)) {
    const i = accepts.indexOf(p);
    if (i < 0) continue;
    best = Math.max(best, (i === 0 ? 1 : 0.75) * s);
  }
  let contradiction = false;
  if (best === 0) {
    if (profile.primary === 'empty') best = cfg.profiles.emptyNeutral ?? 0.5;
    else if (strong.has(profile.primary)) { best = 0.05; contradiction = true; }
    // A purely numeric field (weight, stock, price) whose values carry no
    // digit at all (`Red`, `Blue`) is contradicted, whatever text profile won.
    else if ((field.accepts || []).length && field.accepts.every((a) => NUMERIC_PROFILES.has(a)) && profile.nonEmpty >= 3 && profile.digitRatio < 0.5) { best = 0.05; contradiction = true; }
    else best = 0.5; // neutral text/enum/list: says nothing against
  }
  if (field.unique && profile.nonEmpty >= 10) {
    if (profile.uniqueRatio >= (cfg.profiles.uniqueness.uniqueRatio || 0.95)) best = Math.min(1, best + 0.1);
    else if (profile.uniqueRatio < 0.5) best *= 0.6;
  }
  if (field.required && profile.emptyRatio > (cfg.profiles.requiredEmptyRatio ?? 0.8)) best *= 0.7;
  return { score: best, contradiction };
}

// ── Metafield namespace ownership (Phase 6.5) ──────────────────────────────
// A metafield column is scored against the canon like any other column, with
// one rule: a field an APP injected (namespace it owns) is carried as a
// metafield, never proposed as a mapping candidate. The rule is data
// (recognition.v1.json#metafieldOwnership) and generalises to any platform:
//   1. columnPatterns    — how a column reveals a metafield namespace / key
//   2. thirdPartyGrammar — the platform's OWN reservation grammar for apps
//                          (Shopify app--<id>--, WordPress protected `_` keys)
//   3. platformOwned / merchantOwned — the tiny lists the platform documents
//   4. prefix clustering — keys of ONE file sharing a vendor-like prefix
//                          (rank_math_title / _description / _focus_keyword)
//   5. default           — an unknown NAMESPACE is third-party; a namespace-
//                          less key is the merchant's unless 2. or 4. say so
// Ownership is a query (pure), so the UI and the Learned writer reuse it.

/** Parse a column name into { platform, namespace, key } when it is a metafield column. */
export function metafieldColumn(column, cfg) {
  for (const cp of cfg.metafieldOwnership?.columnPatterns || []) {
    const m = String(column ?? '').match(new RegExp(cp.pattern, cp.flags || ''));
    if (!m) continue;
    return { platform: cp.platform, namespace: cp.namespace ? m[cp.namespace] : null, key: cp.key ? m[cp.key] : null };
  }
  return null;
}

function keyPrefix(key, cfg) {
  const sep = new RegExp(cfg.metafieldOwnership?.prefixCluster?.separators || '[-_.]');
  return stripAccents(String(key ?? '')).toLowerCase().replace(/^_+/, '').split(sep)[0];
}

/** Vendor-like prefixes shared by >= minKeys metafield keys of ONE header set. */
export function prefixClusters(headers, cfg) {
  const pc = cfg.metafieldOwnership?.prefixCluster;
  if (!pc) return new Set();
  const generic = new Set([...(cfg.name.stopTokens || []), ...Object.keys(cfg.name.tokenSynonyms || {}), ...Object.values(cfg.name.tokenSynonyms || {})]);
  const counts = new Map();
  for (const h of headers) {
    const mf = metafieldColumn(h, cfg);
    if (!mf?.key) continue;
    const first = keyPrefix(mf.key, cfg);
    if (!first || first.length < (pc.minPrefixLength || 2) || generic.has(first) || /^\d+$/.test(first)) continue;
    counts.set(first, (counts.get(first) || 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n >= (pc.minKeys || 3)).map(([k]) => k));
}

/**
 * classifyMetafieldOwnership(column, cfg, { headers, clusters? })
 *  → null when the column is not a metafield column, else
 *    { platform, namespace, key, owner: 'platform'|'merchant'|'thirdParty', via }
 *  Pure: the same answer for the UI, the recogniser and the Learned writer.
 */
export function classifyMetafieldOwnership(column, cfg, { headers = [], clusters } = {}) {
  const mf = metafieldColumn(column, cfg);
  if (!mf) return null;
  const own = cfg.metafieldOwnership || {};
  const test = (rule, value) => value != null && new RegExp(rule.pattern, rule.flags || '').test(String(value));
  for (const g of own.thirdPartyGrammar || []) {
    if (g.platform && g.platform !== mf.platform) continue;
    if (test(g, g.on === 'key' ? mf.key : mf.namespace)) return { ...mf, owner: 'thirdParty', via: 'grammar' };
  }
  if (mf.namespace != null) {
    if ((own.platformOwned?.[mf.platform] || []).includes(mf.namespace)) return { ...mf, owner: 'platform', via: 'list' };
    if ((own.merchantOwned?.[mf.platform] || []).includes(mf.namespace)) return { ...mf, owner: 'merchant', via: 'list' };
  }
  const cl = clusters ?? prefixClusters(headers, cfg);
  if (mf.key && cl.has(keyPrefix(mf.key, cfg))) return { ...mf, owner: 'thirdParty', via: 'cluster' };
  if (mf.namespace != null && own.unknownNamespaceIsThirdParty !== false) return { ...mf, owner: 'thirdParty', via: 'default' };
  return { ...mf, owner: 'merchant', via: 'default' };
}

// ── Locale-suffixed columns (Phase 6.7 / P1) ───────────────────────────────
// `name_en`, `Title (fr)`, `description_nl-BE` → { locale, field }. Data:
// recognition.v1.json#translations (patterns with named groups base/locale,
// baseFields = the translatable fields — the guard against `Weight (kg)` /
// `Prix (ht)`, whose base is not translatable). Default-locale election per
// field: a plain base column present → every suffixed column is a translation;
// none → the FIRST suffixed column (header order) is the default locale (its
// flat field), the others are translations. Pure; the UI shows the result.

function normBase(s) { return stripAccents(String(s ?? '')).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim(); }

/** { column, locale, field, base } when the column is a locale-suffixed translatable field, else null. */
export function translationColumn(column, cfg) {
  const T = cfg.translations;
  if (!T) return null;
  for (const pt of T.patterns || []) {
    const m = String(column ?? '').match(new RegExp(pt.pattern, pt.flags ?? 'i'));
    if (!m?.groups) continue;
    const base = normBase(m.groups.base);
    const field = T.baseFields?.[base];
    if (!field) continue;
    return { column, locale: m.groups.locale.replace('_', '-'), field, base };
  }
  return null;
}

/** Every translation column of a header set with its default-locale election: Map column → { locale, field, isDefault }. */
export function translationFacts(headers, cfg) {
  const out = new Map();
  const T = cfg.translations;
  if (!T) return out;
  const cols = headers.map((h) => translationColumn(h, cfg)).filter(Boolean);
  if (!cols.length) return out;
  // a plain base column ("name", "Title", "Description") present in the file?
  const plainFields = new Set(headers.map((h) => T.baseFields?.[normBase(h)]).filter(Boolean));
  const elected = new Set();
  for (const c of cols) {
    let isDefault = false;
    if (!plainFields.has(c.field) && !elected.has(c.field)) { elected.add(c.field); isDefault = true; }
    out.set(c.column, { locale: c.locale, field: c.field, flatField: T.flatFieldOf?.[c.field] ?? c.field, isDefault });
  }
  return out;
}

// ── Context ────────────────────────────────────────────────────────────────

function globToRe(g) { return new RegExp('^' + g.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'); }

/** Column-level structural facts, computed once per table. */
export function contextFacts(headers, columnsValues, catalog, cfg) {
  const facts = {};
  const families = catalog.fields.filter((f) => f.family).map((f) => ({ field: f, re: new RegExp(f.family, 'i') }));
  const headerSet = new Set(headers);
  // unique columns (candidate referents)
  const uniqueCols = [];
  for (const h of headers) {
    const vals = (columnsValues[h] || []).map((v) => String(v ?? '').trim()).filter(Boolean);
    const set = new Set(vals);
    if (vals.length >= 5 && set.size / vals.length >= 0.9) uniqueCols.push({ h, set });
  }
  const translations = translationFacts(headers, cfg);
  for (const h of headers) {
    const f = { family: null, referencesColumn: null, neighbourOf: null };
    for (const fam of families) if (fam.re.test(stripAccents(h).trim())) { f.family = fam.field.path; break; }
    // 6.7: a locale-suffixed translatable column. The elected default locale is
    // the flat field (no family: `title` must win); the others are translations.
    const tr = translations.get(h);
    if (tr) { f.translation = tr; if (tr.isDefault) f.family = null; else f.family = 'translations'; }
    // `Longueur (mm)` has the SHAPE of `Title (fr)`, but its base is not a
    // translatable field: only a real translation column joins that family.
    else if (f.family === 'translations') f.family = null;
    // reference: ≥ ratio of my non-empty values exist in a unique column ≠ me
    const mine = (columnsValues[h] || []).map((v) => String(v ?? '').trim()).filter(Boolean);
    if (mine.length >= 3) {
      const mySet = new Set(mine);
      for (const u of uniqueCols) {
        if (u.h === h) continue;
        const hit = mine.filter((v) => u.set.has(v)).length / mine.length;
        if (hit >= (cfg.context.referenceInclusionRatio || 0.9) && mySet.size < u.set.size) { f.referencesColumn = u.h; break; }
      }
    }
    for (const pair of cfg.context.neighbourPairs || []) {
      const re = new RegExp(pair.pattern, 'i');
      const m = h.match(re);
      if (m) {
        const counterpart = pair.counterpart.replace(/\$(\d)/g, (_, d) => m[Number(d)] ?? '');
        const found = headers.find((x) => x !== h && normExact(x) === normExact(counterpart));
        if (found) { f.neighbourOf = { column: found, canon: pair.canon }; break; }
      }
    }
    facts[h] = f;
  }
  void headerSet;
  return facts;
}

function contextScore(field, fact, cfg) {
  if (!fact) return 0.5;
  if (fact.family) return fact.family === field.path ? cfg.context.familyBoost : 0.1;
  if (fact.referencesColumn && field.role === 'parent-ref') return cfg.context.referenceColumnBoost;
  if (fact.neighbourOf && fact.neighbourOf.canon === field.path) return cfg.context.familyBoost;
  if (fact.referencesColumn && field.unique) return 0.2; // a reference is not an identifier
  return 0.5;
}

// ── Samples (bounded, redacted) ────────────────────────────────────────────

function samplePolicyFor(column, field, storeCfg) {
  const p = column.toLowerCase();
  if (field?.pii) return 'redact';
  if ((storeCfg.samples.redactByPathHint || []).some((h) => p.includes(h.toLowerCase()))) return 'redact';
  if ((storeCfg.samples.hashOnlyByPathHint || []).some((h) => p.includes(h.toLowerCase()))) return 'hash-only';
  return 'keep';
}

export function pickSamples(values, column, field, cfg, storeCfg) {
  const want = cfg.samples.perCandidate || 3;
  const max = cfg.samples.maxLength || 80;
  const policy = samplePolicyFor(column, field, storeCfg);
  const out = [];
  const seen = new Set();
  for (const v of values) {
    const s = String(v ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    if (policy === 'redact') out.push({ kind: 'redact', length: s.length });
    else if (policy === 'hash-only') out.push({ kind: 'hash-only', length: s.length, preview: s.slice(0, 24) + (s.length > 24 ? '…' : '') });
    else out.push({ kind: 'keep', value: s.length > max ? s.slice(0, max) + '…' : s, truncated: s.length > max });
    if (out.length >= want) break;
  }
  return out;
}

// ── Decisions (Learned) ────────────────────────────────────────────────────

function applicableDecisions(decisions, formatId) {
  return (decisions || []).filter((d) => {
    const sc = d.scope || { kind: 'format', id: d.formatId };
    if (sc.kind === 'global' || sc.kind === 'column') return true; // a column decision is matched on the header, below
    if (sc.kind === 'family') return formatId ? globToRe(sc.pattern).test(formatId) : false;
    return !formatId || sc.id === formatId || d.formatId === formatId;
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

/**
 * recognizeColumns({ headers, rows, entity, catalog, config, formatId?, decisions?, storeConfig? })
 *  → { entity, thresholds, columns: ColumnReport[], conflicts: [...] }
 *
 * ColumnReport: { column, status: 'auto'|'suggest'|'none'|'decided'|'ignored',
 *                 best: Candidate|null, candidates: Candidate[], profile, context }
 * Candidate:    { canon, score, name: {score, via, matchedName}, profile: {score},
 *                 context: {score}, samples: [...], confidence, decision? }
 */
export function recognizeColumns({ headers, rows = [], entity, catalog, config, formatId, decisions = [], storeConfig = STORE_DEFAULTS }) {
  const cfg = config;
  const fields = catalog.fields.filter((f) => !entity || f.entity === entity);
  const columnsValues = {};
  for (const h of headers) columnsValues[h] = rows.map((r) => r?.[h] ?? '');
  const facts = contextFacts(headers, columnsValues, { fields }, cfg);
  const applicable = applicableDecisions(decisions, formatId);
  // Names are normalised once per distinct string, never per cell.
  const tokenCache = { _c: new Map(), _n: new Map(), _m: new Map(), _k: new Map(),
    col(x) { if (!this._c.has(x)) this._c.set(x, tokenize(x, cfg)); return this._c.get(x); },
    name(x) { if (!this._n.has(x)) this._n.set(x, tokenize(x, cfg)); return this._n.get(x); },
    norm(x) { if (!this._m.has(x)) this._m.set(x, normalizeColumnName(x)); return this._m.get(x); },
    key(x) { if (!this._k.has(x)) this._k.set(x, tokenKey(x, cfg)); return this._k.get(x); },
    // words a known name loses to the stop list (`Code fabricant` loses `code`)
    dropped(x) { const u = columnUnit(x, cfg); const raw = normalizeColumnName(u ? u.bare : x).split(' ').filter((t) => t && !/^\d+$/.test(t)).length; return Math.max(0, raw - new Set(this.key(x).split(' ')).size); } };
  const W = cfg.weights, TH = cfg.thresholds;
  const clusters = prefixClusters(headers, cfg);

  const reports = headers.map((column) => {
    const values = columnsValues[column];
    const profile = profileValues(values, cfg);
    const fact = facts[column];
    // 6.5 — metafield ownership: a third-party (app-injected) namespace keeps
    // ONLY the `metafields` carry as a candidate.
    const ownership = classifyMetafieldOwnership(column, cfg, { headers, clusters });
    if (fact && ownership) fact.metafield = ownership;
    const thirdParty = ownership?.owner === 'thirdParty';
    const penalty = cfg.metafieldOwnership?.thirdPartyPenalty ?? 0;
    // Decisions replay in order: `proposed` (a "forget") resets the column,
    // `rejected` accumulates, confirmed / corrected / ignored is the latest word.
    const rejected = new Set();
    let decided = null;
    for (const d of applicable) {
      if (d.scope?.kind === 'column' ? normalizeColumnName(d.fieldPath) !== normalizeColumnName(column) : d.fieldPath !== column) continue;
      if (d.action === 'proposed') { rejected.clear(); decided = null; continue; }
      if (d.action === 'rejected') { if (d.canonCandidate) rejected.add(d.canonCandidate); continue; }
      if (d.action === 'confirmed' || d.action === 'corrected' || d.action === 'ignored') decided = d;
    }

    let candidates = [];
    const named = fields.map((f) => [f, nameScore(column, f, cfg, tokenCache)]);
    const hasStrongName = named.some(([, n]) => n.via === 'exact' || n.via === 'alias' || n.via === 'normalized');
    // A unit in the name (`Longueur (mm)`, `Prix (EUR)`, `Durée (mois)`) rules
    // out every field measured in another kind of unit — or in none.
    const unit = columnUnit(column, cfg);
    for (const [field, ns0] of named) {
      if (rejected.has(field.path)) continue;
      let ns = ns0;
      const ps = profileScore(field, profile, cfg);
      let cs = contextScore(field, fact, cfg);
      // A structural-family match (Image1, Meta: x, Attribute 1 value) IS a
      // name pattern: worth an alias on the name axis — unless some field
      // claims this column by an explicit exact/alias name (then the family
      // prefix is the weaker evidence: "Shipping Cost" is an amount).
      if (fact?.family === field.path && ns.score < cfg.name.alias && !hasStrongName) ns = { score: cfg.name.alias, via: 'family', matchedName: fact.family };
      // 6.7 — the column elected as the DEFAULT locale of a translatable field
      // ("name_fr" with no plain "name") is that flat field by structure: same
      // alias-level evidence as a family match.
      if (fact?.translation?.isDefault && field.path === fact.translation.flatField && ns.score < cfg.name.alias && !hasStrongName) ns = { score: cfg.name.alias, via: 'family', matchedName: 'default locale ' + fact.translation.locale };
      // A structural family only outranks a candidate matched by SIMILARITY;
      // an exact/alias name is stronger evidence than a prefix (billing_email
      // is the order's email even though it sits in the billing_* block).
      if (cs <= 0.1 && (ns.via === 'exact' || ns.via === 'alias' || ns.via === 'normalized')) cs = 0.5;
      let score = ns.score * W.name + ps.score * W.profile + cs * W.context;
      const reasons = [];
      if (ns.via !== 'none') reasons.push(`name:${ns.via}`);
      if (ps.contradiction) { score *= (cfg.profiles.contradictionPenalty || {})[ns.via] ?? 0.3; reasons.push('profile:contradiction'); }
      else if (ps.score >= 1) reasons.push('profile:ideal');
      if (cs >= (cfg.context.familyBoost || 0.9)) reasons.push('context:structural');
      if (cs <= 0.1) { score *= 0.5; reasons.push('context:other-family'); }
      // Value-only evidence (meaningless header): a strong, ideal profile is
      // worth a suggestion — never an auto.
      const strong = new Set(cfg.profiles.strongTyped || []);
      if (ns.via === 'none' && ps.score >= 1 && strong.has(profile.primary) && field.accepts?.[0] === profile.primary) {
        score = Math.max(score, TH.grey + 0.05);
        reasons.push('profile:value-only');
      }
      // Applied after the value-only floor: `Diamètre (mm)` holds integers, yet
      // it is never a stock quantity.
      if (unit && (cfg.name.unitKindOf?.[field.path] ?? null) !== unit.kind && field.path !== 'metafields') {
        score *= cfg.name.unitMismatchPenalty ?? 0.5; reasons.push(`unit:${unit.unit}-mismatch`);
      }
      // 6.5 — the LAST word: an app-owned metafield keeps only its carry. Applied
      // after every boost (value-only evidence included) so nothing resurrects it.
      if (thirdParty && field.path !== 'metafields') { score *= penalty; reasons.push('namespace:third-party'); }
      if (score < TH.grey * 0.5) continue;
      candidates.push({ canon: field.path, score: round(score), name: { score: round(ns.score), via: ns.via, matchedName: ns.matchedName },
        profile: { score: round(ps.score) }, context: { score: cs }, reasons, samples: pickSamples(values, column, field, cfg, storeConfig) });
    }
    candidates.sort((a, b) => b.score - a.score || a.canon.localeCompare(b.canon));
    candidates = candidates.slice(0, 5);

    let status, best = candidates[0] ?? null;
    if (decided && decided.action === 'ignored') { status = 'ignored'; best = null; }
    else if (decided) {
      status = 'decided';
      const field = fields.find((f) => f.path === decided.canonCandidate);
      best = candidates.find((c) => c.canon === decided.canonCandidate)
        ?? { canon: decided.canonCandidate, score: 1, name: { score: 0, via: 'none', matchedName: null }, profile: { score: 0 }, context: { score: 0.5 },
             reasons: ['decision'], samples: field ? pickSamples(values, column, field, cfg, storeConfig) : [] };
      best = { ...best, decision: { action: decided.action, at: decided.at, by: decided.by, ...(decided.args ? { args: decided.args } : {}) }, confidence: decided.action === 'corrected' ? 'user-corrected' : 'user-confirmed' };
      candidates = [best, ...candidates.filter((c) => c.canon !== best.canon)];
    } else if (!best) status = 'none';
    else if (best.score >= TH.auto) { status = 'auto'; best = { ...best, confidence: 'inferred' }; }
    else if (best.score >= TH.grey) { status = 'suggest'; best = { ...best, confidence: 'inferred' }; }
    else { status = 'none'; }

    return { column, status, best, candidates, profile: summarizeProfile(profile), context: fact };
  });

  // One canon field, one auto column — unless the field is a structural family
  // (images, options, metafields, address blocks). Weaker duplicates demote.
  const familyPaths = new Set(catalog.fields.filter((f) => f.family).map((f) => f.path));
  const byCanon = new Map();
  const conflicts = [];
  for (const r of reports) {
    if (r.status !== 'auto' && r.status !== 'decided') continue;
    const c = r.best.canon;
    if (familyPaths.has(c)) continue;
    const prev = byCanon.get(c);
    if (!prev) { byCanon.set(c, r); continue; }
    const loser = prev.status === 'decided' ? r : r.status === 'decided' ? prev : (r.best.score > prev.best.score ? prev : r);
    const winner = loser === r ? prev : r;
    if (loser.status === 'decided') continue; // two decisions: the user owns it
    loser.status = 'suggest';
    conflicts.push({ canon: c, kept: winner.column, demoted: loser.column });
    byCanon.set(c, winner);
  }

  // The title is the one blocking field: a file whose title column has a name we
  // do not know must not die with `product_no_title` on every row. When no column
  // is (or was decided as) the title, the most title-like column is PROPOSED —
  // short unique text, not a URL / number / code — and the user confirms it.
  if (entity === 'products') {
    const titleField = fields.find((f) => f.path === 'title');
    const taken = reports.some((r) => (r.status === 'auto' || r.status === 'decided') && r.best?.canon === 'title');
    if (titleField && !taken) {
      const notText = new Set(['imageUrl', 'url', 'html', 'email', 'phone', 'ean', 'price', 'int', 'float', 'date', 'bool', 'enum', 'currencyCode', 'countryCode', 'postcode']);
      const pool = reports.filter((r) => (r.status === 'none' || r.status === 'suggest') && !r.candidates.some((c) => c.canon === 'title' && c.score >= TH.grey)
        && r.profile.nonEmpty >= 2 && r.profile.uniqueRatio >= 0.7 && r.profile.avgLength >= 6 && r.profile.avgLength <= 150
        && !notText.has(r.profile.primary));
      pool.sort((a, b) => (b.profile.uniqueRatio - a.profile.uniqueRatio) || (Math.abs(a.profile.avgLength - 40) - Math.abs(b.profile.avgLength - 40)));
      const pick = pool[0];
      if (pick) {
        const cand = { canon: 'title', score: round(TH.grey + 0.05), name: { score: 0, via: 'none', matchedName: null }, profile: { score: 0.5 }, context: { score: 0.5 },
          reasons: ['fallback:title-candidate'], samples: pickSamples(columnsValues[pick.column], pick.column, titleField, cfg, storeConfig) };
        pick.status = 'suggest';
        pick.best = { ...cand, confidence: 'inferred' };
        pick.candidates = [cand, ...pick.candidates.filter((c) => c.canon !== 'title')].slice(0, 5);
      }
    }
  }

  return { entity: entity ?? null, formatId: formatId ?? null, thresholds: { ...TH }, columns: reports, conflicts };
}

function summarizeProfile(p) {
  return { primary: p.primary, profiles: p.profiles, nonEmpty: p.nonEmpty, emptyRatio: round(p.emptyRatio), distinct: p.distinct, uniqueRatio: round(p.uniqueRatio), avgLength: Math.round(p.avgLength), ...(p.numeric ? { numeric: p.numeric } : {}) };
}
function round(x) { return Math.round(x * 1000) / 1000; }

/** Turn a report into KB FieldMapEntry[] (auto + decided only). Suggestions
 *  never become knowledge on their own — the user resolves them (5.6). */
export function toFieldMapEntries(report, { source = 'engine:semantic', catalog } = {}) {
  const byPath = new Map((catalog?.fields || []).map((f) => [f.path, f]));
  const out = [];
  for (const r of report.columns) {
    if (r.status === 'ignored') { out.push({ path: r.column, canon: null, transform: 'ignore', confidence: 'user-confirmed', source }); continue; }
    if (r.status !== 'auto' && r.status !== 'decided') continue;
    const f = byPath.get(r.best.canon);
    out.push({ path: r.column, canon: r.best.canon, transform: f?.transform || 'copy', confidence: r.best.confidence || 'inferred', source });
  }
  return out;
}

/** Decision factory — keeps callers from hand-building LearnedDecision objects. */
export function makeDecision({ formatId, column, action, canon = null, by = 'user', transform, args, reason, scope, confidence }) {
  const conf = confidence ?? (action === 'corrected' ? 'user-corrected' : action === 'confirmed' || action === 'rejected' || action === 'ignored' ? 'user-confirmed' : 'inferred');
  const d = { at: new Date().toISOString(), by, formatId, fieldPath: column, action, canonCandidate: canon, confidence: conf };
  if (transform) d.transform = transform;
  if (args && typeof args === 'object' && Object.keys(args).length) d.args = { ...args };
  if (reason) d.reason = reason;
  // A decision is remembered PER COLUMN NAME unless the caller narrows it: the next file
  // with a "Prix HT" column starts from what the user said about "Prix HT" in this one.
  d.scope = scope || { kind: 'column' };
  return d;
}
