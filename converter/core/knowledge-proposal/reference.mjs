// Phase 5.3 — synchronous loader for the Reference strata.
// The engine (`convert()`) is synchronous; it needs the shipped signatures
// without going through the async KnowledgeStore. This reads
// `core/knowledge-ref/formats/*.json` once and caches. Learned knowledge is
// NOT loaded here — the async recognizer (createFormatRecognizer) overlays it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REFERENCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'knowledge-ref');

let cache = null;

/** Every Reference FormatKnowledge entry, sorted by id. Cached after first call. */
export function loadReferenceFormatsSync(dir = path.join(REFERENCE_DIR, 'formats')) {
  if (cache && cache.dir === dir) return cache.formats;
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const formats = [];
  for (const n of names) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
    if (j && j.id) formats.push(j);
  }
  cache = { dir, formats };
  return formats;
}

/** Test hook: drop the cache (e.g. after writing fixtures). */
export function resetReferenceCache() { cache = null; }

// ── Canon catalogue + recognition config (Phase 5.4) ───────────────────────
let canonCache = null;
/** `core/knowledge-ref/canon/fields.v1.json` — the semantic recogniser's field catalogue. */
export function loadCanonCatalogSync(fp = path.join(REFERENCE_DIR, 'canon', 'fields.v1.json')) {
  if (canonCache && canonCache.fp === fp) return canonCache.doc;
  const doc = JSON.parse(fs.readFileSync(fp, 'utf8'));
  canonCache = { fp, doc };
  return doc;
}
let recogCache = null;
/** `core/knowledge-ref/canon/recognition.v1.json` — thresholds, weights, classifiers. */
export function loadRecognitionConfigSync(fp = path.join(REFERENCE_DIR, 'canon', 'recognition.v1.json')) {
  if (recogCache && recogCache.fp === fp) return recogCache.doc;
  const doc = JSON.parse(fs.readFileSync(fp, 'utf8'));
  recogCache = { fp, doc };
  return doc;
}

let aliasCache = null;
/** `core/knowledge-ref/canon/transform-aliases.v1.json` — mapping-layer transform ids → registry. */
export function loadTransformAliasesSync(fp = path.join(REFERENCE_DIR, 'canon', 'transform-aliases.v1.json')) {
  if (aliasCache && aliasCache.fp === fp) return aliasCache.doc;
  const doc = JSON.parse(fs.readFileSync(fp, 'utf8'));
  aliasCache = { fp, doc };
  return doc;
}

/** Reference ∪ Learned snapshot from a KnowledgeStore (Learned wins by id) —
 *  what the engine's `convert(..., { knowledge: { formats } })` expects. */
export async function loadAllFormats(store) {
  const descriptors = await store.listFormats();
  const formats = await Promise.all(descriptors.map((d) => store.getFormat(d.id)));
  return formats.filter(Boolean);
}
