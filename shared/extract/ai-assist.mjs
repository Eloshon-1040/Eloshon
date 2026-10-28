/**
 * AI-assisted extraction — the OPT-IN, ON-DEMAND layer. When the deterministic
 * pipeline (structured data → embedded JSON → DOM grid → XHR capture) does not yield
 * a clean product grid, the user may CHOOSE to ask a model to identify the structure.
 *
 * This module is MODEL-AGNOSTIC and side-effect free: it compacts the page into small
 * candidates, builds a prompt, validates the model's JSON answer, and applies the
 * returned hints through the SAME deterministic mappers (field-map / money). The
 * actual model call — and the API key — are injected by the app (`askJson`), so no
 * key ever lives in the extension and nothing is sent anywhere unless the user asks.
 *
 * PORTABLE: zero Node built-ins; depends only on the portable field-map + money.
 */
import { mapItem } from './field-map.mjs';
import { scoreArray } from './product-shape.mjs';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const truncate = (s, n) => { const t = String(s); return t.length > n ? `${t.slice(0, n)}…` : t; };

// The default product field schema. The USER may add/remove fields and give each one
// a free-text AI hint (e.g. add {key:'tags', label:'Tags', hint:'the category tags'})
// — exactly the Thunderbit-style per-field targeting. name/price/image/url/sku get
// their deterministic normalisation in mapItem; any extra field is copied verbatim.
export const DEFAULT_FIELDS = Object.freeze([
  { key: 'name', label: 'Nom' }, { key: 'price', label: 'Prix' }, { key: 'image', label: 'Image' },
  { key: 'url', label: 'Lien' }, { key: 'sku', label: 'Référence' },
]);
const normFields = (fields) => (Array.isArray(fields) && fields.length ? fields : DEFAULT_FIELDS)
  .filter((f) => f && typeof f.key === 'string' && f.key)
  .map((f) => ({ key: f.key, label: f.label || f.key, hint: f.hint ? String(f.hint) : '' }));

/** Resolve a dot/bracket path ("a.b[2].c") against a decoded value. */
export function resolvePath(value, path) {
  if (path == null || path === '') return value;
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter((p) => p !== '');
  let cur = value;
  for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
  return cur;
}

/**
 * Every array-of-objects in a decoded JSON value, compacted for a model: its PATH,
 * length, the union of keys across a few items, and ONE truncated sample item. Small
 * and structure-first (not a full data dump). Larger / more homogeneous arrays first.
 * @returns {Array<{path:string,length:number,keys:string[],sample:object}>}
 */
export function jsonCandidates(value, { maxCandidates = 12, maxSampleChars = 900, maxDepth = 8 } = {}) {
  const found = [];
  const seen = new Set();
  const walk = (node, path, depth) => {
    if (node == null || depth > maxDepth || found.length > 200) return;
    if (Array.isArray(node)) {
      const objs = node.filter(isObj);
      if (objs.length >= 2) {
        const keys = [...new Set(objs.slice(0, 8).flatMap((o) => Object.keys(o)))].slice(0, 40);
        if (keys.length) { const sig = keys.join(','); if (!seen.has(sig)) { seen.add(sig); found.push({ path, length: node.length, keys, sample: objs[0] }); } }
      }
      node.slice(0, 20).forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
      return;
    }
    if (isObj(node)) for (const k of Object.keys(node)) walk(node[k], path ? `${path}.${k}` : k, depth + 1);
  };
  walk(value, '', 0);
  // Prefer bigger arrays, then those whose keys look product-ish (a soft nudge only).
  const PRODUCTISH = /(name|title|price|prix|image|img|url|link|sku|product)/i;
  found.sort((a, b) => (b.length - a.length) || (PRODUCTISH.test(b.keys.join(' ')) - PRODUCTISH.test(a.keys.join(' '))));
  return found.slice(0, maxCandidates).map((c) => ({ path: c.path, length: c.length, keys: c.keys, sample: JSON.parse(truncate(JSON.stringify(c.sample), maxSampleChars).replace(/…$/, '') || '{}') }));
}

/** The instruction + compacted candidates → a single prompt string for the model.
 *  `fields` is the user's schema (each may carry a free-text `hint`). */
export function buildPrompt(candidates, { url = '', lang = 'fr', fields } = {}) {
  const fs = normFields(fields);
  const head = [
    'You identify the main record GRID in e-commerce / listing page data. You are given',
    'candidate JSON arrays extracted from one page. Pick the ONE array that holds the',
    'records to extract, and map the requested fields to its keys. Ignore arrays of',
    'menus, facets, breadcrumbs, reviews, fonts, banners or tracking records.',
    '',
    `Page URL: ${url}`,
    `Preferred language: ${lang}`,
    '',
    'Fields to map (map each to a key or dot-path of the chosen array; follow any hint):',
    ...fs.map((f) => `  - ${f.key}${f.label && f.label !== f.key ? ` (${f.label})` : ''}${f.hint ? ` — hint: ${f.hint}` : ''}`),
    '',
    'Candidates (path, length, keys, one sample item):',
  ];
  const body = candidates.map((c, i) => `#${i} path="${c.path}" length=${c.length} keys=[${c.keys.join(', ')}]\n   sample=${truncate(JSON.stringify(c.sample), 700)}`);
  const tail = [
    '',
    'Reply with STRICT JSON only, no prose:',
    `{"arrayPath": "<path of the record array>", "fieldMap": {${fs.map((f) => `"${f.key}":"<key>"`).join(', ')}}, "confidence": 0.0-1.0, "reason": "<short>"}`,
    'Omit a fieldMap key you cannot find. If NO candidate is a record grid, reply',
    '{"arrayPath": null, "confidence": 0, "reason": "<why>"}.',
  ];
  return [...head, ...body, ...tail].join('\n');
}

/** Validate a model answer (object or JSON string) → {arrayPath, fieldMap, confidence, reason} | null.
 *  Only keys in the field schema are kept (unknown keys dropped). */
export function parseHints(answer, { fields } = {}) {
  const allowed = new Set(normFields(fields).map((f) => f.key));
  let a = answer;
  if (typeof a === 'string') { try { a = JSON.parse(a.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); } catch { return null; } }
  if (!isObj(a)) return null;
  if (a.arrayPath == null) return { arrayPath: null, fieldMap: {}, confidence: 0, reason: String(a.reason || '') };
  if (typeof a.arrayPath !== 'string') return null;
  const fm = {};
  if (isObj(a.fieldMap)) for (const [k, v] of Object.entries(a.fieldMap)) { if (allowed.has(k) && typeof v === 'string' && v) fm[k] = v; }
  const confidence = Number.isFinite(Number(a.confidence)) ? Math.max(0, Math.min(1, Number(a.confidence))) : null;
  return { arrayPath: a.arrayPath, fieldMap: fm, confidence, reason: String(a.reason || '') };
}

/**
 * Apply validated hints to the decoded value → product cards (via the deterministic
 * mapItem, so prices/urls/images are normalised exactly like every other path).
 */
export function applyHints(value, hints, baseUrl) {
  if (!hints || !hints.arrayPath) return [];
  const arr = resolvePath(value, hints.arrayPath);
  if (!Array.isArray(arr) || !arr.length) return [];
  const fm = hints.fieldMap && Object.keys(hints.fieldMap).length ? hints.fieldMap : { name: 'name', price: 'price', image: 'image', url: 'url', sku: 'sku' };
  const out = [];
  for (const item of arr) {
    if (!isObj(item)) continue;
    const card = mapItem(item, fm, { strategy: 'ai-assist' });
    // Resolve a relative url against the page, exactly like the other extractors.
    if (card.url && baseUrl) { try { const abs = new URL(card.url, baseUrl).toString(); card.sourceUrl = abs; card.canonicalUrl = abs; } catch { /* keep as-is */ } }
    // Keep any record that resolved at least one mapped field (the AI picked the array
    // on purpose and the user reviews the result) — supports non-product schemas too
    // (videos with tags/views/uploader, etc.), not only name+price products.
    if (Object.keys(card).some((k) => k !== 'strategy')) out.push(card);
  }
  return out;
}

/**
 * One-shot, ON-DEMAND helper: decoded page JSON + an injected `askJson(prompt)` (the
 * app's model call, with its own key) → product cards. Returns {cards, hints} so the
 * app can show the confidence/reason and let the user accept or reject. Never called
 * unless the user explicitly requests AI assist.
 * @param {*} value decoded JSON (embedded state / captured XHR)
 * @param {string} baseUrl
 * @param {{askJson:(prompt:string)=>Promise<object|string>, url?:string, lang?:string}} io
 */
export async function aiAssistJson(value, baseUrl, { askJson, url = '', lang = 'fr', fields } = {}) {
  if (typeof askJson !== 'function') throw new Error('askJson is required');
  const candidates = jsonCandidates(value);
  if (!candidates.length) return { cards: [], hints: null, candidates: 0 };
  const prompt = buildPrompt(candidates, { url, lang, fields });
  let answer;
  try { answer = await askJson(prompt); } catch (e) { return { cards: [], hints: null, candidates: candidates.length, error: String(e && e.message || e) }; }
  const hints = parseHints(answer, { fields });
  const cards = applyHints(value, hints, baseUrl);
  return { cards, hints, candidates: candidates.length };
}

/**
 * What to send the model from a page whose records live in its inline state (not in a
 * JSON island): the arrays that look like a record grid, best first, each trimmed to
 * stay small. A menu tree or a breadcrumb scores 0 and is not sent. When nothing
 * scores, the largest arrays of objects are sent instead (the model decides).
 * @param {any[]} values parsed JSON values of the page (embeddedJsonValues)
 * @returns {string[]} JSON strings, one per array
 */
export function productArraySources(values, { maxArrays = 4, maxItems = 120, maxChars = 300000 } = {}) {
  const scored = []; const plain = [];
  const walk = (node, key, depth) => {
    if (node == null || typeof node !== 'object' || depth > 12) return;
    if (Array.isArray(node)) {
      if (node.filter(isObj).length >= 2) {
        let r = { score: 0, count: 0 }; try { r = scoreArray(node, key); } catch { /* best effort */ }
        (r.score > 0 ? scored : plain).push({ arr: node, score: r.score, n: node.length });
      }
      for (const v of node.slice(0, 50)) walk(v, key, depth + 1);
      return;
    }
    for (const k of Object.keys(node)) walk(node[k], k, depth + 1);
  };
  for (const v of values || []) walk(v, '', 0);
  scored.sort((x, y) => (y.score - x.score) || (y.n - x.n));
  plain.sort((x, y) => y.n - x.n);
  const pick = (scored.length ? scored : plain.filter((p) => p.n >= 3)).slice(0, maxArrays);
  const out = [];
  for (const { arr } of pick) {
    let items = arr.slice(0, maxItems); let s = JSON.stringify(items);
    while (s.length > maxChars && items.length > 2) { items = items.slice(0, Math.ceil(items.length / 2)); s = JSON.stringify(items); }
    if (s.length <= maxChars) out.push(s);
  }
  return out;
}
