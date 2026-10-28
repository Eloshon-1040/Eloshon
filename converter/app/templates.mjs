/**
 * Modèles de correspondance (ÉTAPE 3) — a saved set of column overrides tied to
 * a platform pair, reusable across conversions. Stored locally as ONE JSON file
 * in the app-data dir (no online store). Pure fs + a path: point it at a temp
 * dir to test headless.
 *
 * A template records the rule-format version and a FINGERPRINT of the source
 * columns it was built for, so applying it to a file with different columns
 * reports what is missing/new instead of failing silently. If the rule format
 * evolves, templates are migrated on load (migrate() below).
 */
import { sanitizeCustomTargets } from './custom-targets.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MAPPING_RULES_VERSION } from '../core/dist/index.mjs';

const STORE_VERSION = 1;
const nowIso = () => new Date().toISOString();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10));

// Migrate a single template to the current rule-format version. Identity for v1;
// add cases here when SOURCE_FIELDS ids change so old templates keep working.
function migrate(tpl) {
  let t = { ...tpl };
  if ((t.rulesVersion ?? 0) < MAPPING_RULES_VERSION) {
    // v0/v1: no id changes yet — bump the stamp.
    t = { ...t, rulesVersion: MAPPING_RULES_VERSION, migratedAt: nowIso() };
  }
  return t;
}

function readAll(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const doc = JSON.parse(raw);
    const list = Array.isArray(doc?.templates) ? doc.templates : [];
    return list.map(migrate);
  } catch {
    return []; // missing/corrupt → empty (never throw at read)
  }
}

function writeAll(file, templates) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, templates }, null, 2));
  fs.renameSync(tmp, file); // atomic-ish replace
}

const fingerprintOf = (headers) => Array.from(new Set(headers)).sort();

/** Open (or lazily create) the template store backed by `file`. */
export function createTemplateStore(file) {
  const load = () => readAll(file);
  const persist = (list) => writeAll(file, list);

  function list() { return load(); }
  function get(id) { return load().find((t) => t.id === id) ?? null; }

  function create({ name, direction, sourceFormat, targetFormat, entity, overrides = {}, headers = [], edits = [], outEdits = [], customTargets = {} }) {
    if (!name || !name.trim()) throw new Error('template name required');
    const all = load();
    const tpl = {
      id: uid(), name: name.trim(), direction, sourceFormat, targetFormat, entity,
      rulesVersion: MAPPING_RULES_VERSION, columnFingerprint: fingerprintOf(headers),
      overrides: overrides ?? {}, edits: Array.isArray(edits) ? edits : [], outEdits: Array.isArray(outEdits) ? outEdits : [],
      // where each « case personnalisée » goes for this template's platform (step 3)
      customTargets: sanitizeCustomTargets(customTargets), createdAt: nowIso(), updatedAt: nowIso(),
    };
    all.push(tpl); persist(all); return tpl;
  }

  function save(id, patch = {}) {
    const all = load();
    const i = all.findIndex((t) => t.id === id);
    if (i < 0) throw new Error('template not found: ' + id);
    const next = { ...all[i], ...patch, id: all[i].id, updatedAt: nowIso() };
    if (patch.headers) { next.columnFingerprint = fingerprintOf(patch.headers); delete next.headers; }
    all[i] = next; persist(all); return next;
  }

  function rename(id, name) {
    if (!name || !name.trim()) throw new Error('template name required');
    return save(id, { name: name.trim() });
  }

  function duplicate(id, name) {
    const src = get(id);
    if (!src) throw new Error('template not found: ' + id);
    const all = load();
    const copy = { ...src, id: uid(), name: name?.trim() || `${src.name} (copie)`, createdAt: nowIso(), updatedAt: nowIso() };
    all.push(copy); persist(all); return copy;
  }

  function remove(id) {
    const all = load();
    const next = all.filter((t) => t.id !== id);
    if (next.length === all.length) return false;
    persist(next); return true;
  }

  // Apply a template to a file's real columns: returns the overrides to use PLUS
  // a diff so the UI can warn (never a silent failure). Overrides that point at a
  // column absent from the file are surfaced in `overridesOnMissing`.
  function applyTo(id, headers) {
    const tpl = get(id);
    if (!tpl) throw new Error('template not found: ' + id);
    const have = new Set(headers);
    const fp = new Set(tpl.columnFingerprint ?? []);
    const missingColumns = (tpl.columnFingerprint ?? []).filter((c) => !have.has(c));
    const newColumns = headers.filter((h) => !fp.has(h));
    const overridesOnMissing = Object.entries(tpl.overrides ?? {})
      .filter(([, ov]) => ov && ov.column != null && !have.has(ov.column))
      .map(([id2, ov]) => ({ field: id2, column: ov.column }));
    return { overrides: tpl.overrides ?? {}, edits: Array.isArray(tpl.edits) ? tpl.edits : [], outEdits: Array.isArray(tpl.outEdits) ? tpl.outEdits : [], customTargets: sanitizeCustomTargets(tpl.customTargets), missingColumns, newColumns, overridesOnMissing, template: tpl };
  }

  function exportOne(id) {
    const tpl = get(id);
    if (!tpl) throw new Error('template not found: ' + id);
    return JSON.stringify({ kind: 'eloshon-converter-template', ...tpl }, null, 2);
  }

  // fallbackName: the name of a template file that has none, in the interface language (main passes it).
  function importOne(jsonString, fallbackName = 'Modèle importé') {
    let parsed;
    try { parsed = JSON.parse(jsonString); } catch { throw new Error('invalid template JSON'); }
    if (!parsed || typeof parsed !== 'object' || !parsed.direction) throw new Error('not a template');
    const all = load();
    const tpl = migrate({
      id: uid(),
      name: (parsed.name || fallbackName).trim(),
      direction: parsed.direction, sourceFormat: parsed.sourceFormat, targetFormat: parsed.targetFormat, entity: parsed.entity,
      rulesVersion: parsed.rulesVersion ?? 1,
      columnFingerprint: Array.isArray(parsed.columnFingerprint) ? parsed.columnFingerprint : [],
      overrides: parsed.overrides && typeof parsed.overrides === 'object' ? parsed.overrides : {},
      edits: Array.isArray(parsed.edits) ? parsed.edits : [],
      outEdits: Array.isArray(parsed.outEdits) ? parsed.outEdits : [],
      customTargets: sanitizeCustomTargets(parsed.customTargets),
      createdAt: nowIso(), updatedAt: nowIso(), importedAt: nowIso(),
    });
    all.push(tpl); persist(all); return tpl;
  }

  return { list, get, create, save, rename, duplicate, remove, applyTo, exportOne, importOne };
}
