// Reference JSON implementation of KnowledgeStore.
// Strata:
//   – Reference: read-only, rooted at `referenceDir`, shipped with the app.
//   – Learned:   read-write, rooted at `learnedDir`, lives in userData.
// This implementation is deliberately simple — the point is the CONTRACT,
// not this backend. Swap for SQLite/Supabase without changing the engine.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { columnKey as normHeaderKey } from './values.mjs';
import crypto from 'node:crypto';
import { recognize } from './recognizer.mjs';

export const DEFAULT_CONFIG = {
  samples: {
    enabled: true,
    maxPerField: 5,
    maxLength: 200,
    maxLengthLong: 500,
    defaultPolicy: 'keep',
    redactByPathHint: [
      'email', 'phone', 'address', 'zip', 'postcode',
      'firstName', 'lastName', 'transaction', 'orderKey',
      'customerNote', 'billing_', 'shipping_'
    ],
    hashOnlyByPathHint: ['bodyHtml', 'description', 'Description', 'post_content']
  }
};

async function readJsonSafe(fp) {
  try { return JSON.parse(await fs.readFile(fp, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function writeJsonAtomic(fp, data) {
  await fs.mkdir(path.dirname(fp), { recursive: true });
  const tmp = fp + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, fp);
}

async function listJsonFiles(dir) {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((n) => n.endsWith('.json')).map((n) => path.join(dir, n));
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

function pathMatchesAny(fieldPath, hints) {
  const p = fieldPath.toLowerCase();
  return hints.some((h) => p.includes(h.toLowerCase()));
}

function resolveSamplePolicy(cfg, fieldEntry, fieldPath, override) {
  if (override) return override;
  if (fieldEntry && fieldEntry.samplePolicy) return fieldEntry.samplePolicy;
  if (pathMatchesAny(fieldPath, cfg.samples.redactByPathHint)) return 'redact';
  if (pathMatchesAny(fieldPath, cfg.samples.hashOnlyByPathHint)) return 'hash-only';
  return cfg.samples.defaultPolicy;
}

function makeSamplePayload(policy, raw, cfg, isLong) {
  if (policy === 'none') return null;
  const valueType = raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw;
  const asString = raw == null ? '' : (typeof raw === 'string' ? raw : JSON.stringify(raw));
  const length = asString.length;
  if (policy === 'redact') return { kind: 'redact', length, valueType };
  if (policy === 'hash-only') {
    const hash = crypto.createHash('sha256').update(asString).digest('hex').slice(0, 16);
    return { kind: 'hash-only', hash, length, valueType };
  }
  // keep
  const max = isLong ? cfg.samples.maxLengthLong : cfg.samples.maxLength;
  if (length > max) return { kind: 'keep', value: asString.slice(0, max) + '…truncated', truncated: true };
  return { kind: 'keep', value: asString };
}

// ── Signature matching ─────────────────────────────────────────────────────
// Lives in recognizer.mjs (Phase 5.3) so the sync engine and this store share
// ONE semantic. The store only feeds it the Reference ∪ Learned entries.

// ── Store impl ─────────────────────────────────────────────────────────────

export function createJsonKnowledgeStore({ referenceDir, learnedDir }) {
  const configPath = path.join(learnedDir, 'config.json');
  const formatsRefDir = path.join(referenceDir, 'formats');
  const formatsLearnedDir = path.join(learnedDir, 'formats');
  const decisionsFile = (id) => path.join(learnedDir, 'learned', id, 'decisions.jsonl');
  const samplesFile = (id, field) => {
    const safe = field.replace(/[^a-z0-9._-]/gi, '_');
    return path.join(learnedDir, 'learned', id, 'samples', `${safe}.jsonl`);
  };

  async function loadConfig() {
    const found = await readJsonSafe(configPath);
    if (!found) return { ...DEFAULT_CONFIG };
    // shallow merge on the top-level samples key
    return { ...DEFAULT_CONFIG, ...found, samples: { ...DEFAULT_CONFIG.samples, ...(found.samples || {}) } };
  }

  async function readAllFormats() {
    const [refFiles, learnFiles] = await Promise.all([listJsonFiles(formatsRefDir), listJsonFiles(formatsLearnedDir)]);
    const map = new Map(); // id → { entry, origin }
    for (const f of refFiles) {
      const j = await readJsonSafe(f);
      if (j && j.id) map.set(j.id, { entry: j, origin: 'reference' });
    }
    for (const f of learnFiles) {
      const j = await readJsonSafe(f);
      if (j && j.id) {
        const prev = map.get(j.id);
        map.set(j.id, { entry: j, origin: prev ? 'learned' : 'learned' });
      }
    }
    return map;
  }

  async function readRawFormat(id, strata) {
    if (strata === 'reference') return readJsonSafe(path.join(formatsRefDir, `${id}.json`));
    if (strata === 'learned')   return readJsonSafe(path.join(formatsLearnedDir, `${id}.json`));
    // default: prefer learned when present
    const learned = await readJsonSafe(path.join(formatsLearnedDir, `${id}.json`));
    if (learned) return learned;
    const ref = await readJsonSafe(path.join(formatsRefDir, `${id}.json`));
    const edits = ref ? await readJsonSafe(overlayFile(id)) : null;
    return ref && edits ? applyColumnEdits(ref, edits) : ref;
  }

  // ── Column edits of a Reference format (step 3) ──────────────────────────
  // The user re-points ONE column of a shipped format (technical_specs → a
  // custom field). Stored per column in learned/overlays/<id>.json, never in
  // Reference: at read time the edited columns' entries replace the Reference
  // ones, every other column keeps following Reference (and its updates).
  const overlayFile = (id) => path.join(learnedDir, 'overlays', `${id}.json`);
  function applyColumnEdits(ref, edits) {
    const cols = edits.columns || {};
    const edited = new Set(Object.keys(cols));
    if (!edited.size) return ref;
    // Only the file's own column entries are replaced; entries read inside a
    // nested variation (when: 'child') share a name but not the column.
    const kept = (ref.fields || []).filter((f) => !(edited.has(f.path) && f.when !== 'child'));
    const added = Object.values(cols).flatMap((c) => c.entries || []);
    const unknownFields = (ref.unknownFields || []).filter((u) => !edited.has(u.path));
    const diff = Object.entries(cols).map(([c, v]) => `${c} → ${(v.entries || []).map((e) => e.canon ?? 'ignored').join(' + ')}`);
    return {
      ...ref, fields: [...kept, ...added],
      ...(ref.unknownFields ? { unknownFields } : {}),
      history: [...(ref.history || []), { at: edits.at, op: 'correct', from: 'user', origin: 'learned', diff }],
    };
  }

  async function overlay(id) {
    const [ref, learned] = await Promise.all([
      readJsonSafe(path.join(formatsRefDir, `${id}.json`)),
      readJsonSafe(path.join(formatsLearnedDir, `${id}.json`))
    ]);
    if (!ref && !learned) return null;
    const decisions = await listDecisions(id).catch(() => []);
    const rejected = new Set(decisions
      .filter((d) => d.action === 'rejected' && d.canonCandidate)
      .map((d) => `${d.fieldPath}::${d.canonCandidate}`));

    const base = learned ? { ...ref, ...learned } : { ...ref };
    // One source path may feed SEVERAL canon targets (slug → handle AND
    // identity.slug; attributes → attributesRich AND options; `name` on the
    // product vs on a variation). Overlay identity is therefore
    // (path, canon, when, scope): a Learned entry overrides the Reference entry
    // with the same identity and ADDS otherwise. Rejections target (path, canon).
    const keyOf = (f) => `${f.scope ?? ''}|${f.when ?? ''}|${f.path}|${f.canon ?? 'null'}`;
    const byKey = new Map();
    for (const f of (ref?.fields || [])) byKey.set(keyOf(f), { entry: f, origin: 'reference' });
    for (const f of (learned?.fields || [])) {
      const prev = byKey.get(keyOf(f));
      byKey.set(keyOf(f), {
        entry: f, origin: 'learned',
        overriddenReference: prev ? prev.entry : undefined
      });
    }
    // filter out rejected candidates from surface
    const fields = [...byKey.values()]
      .filter(({ entry }) => !(entry.canon && rejected.has(`${entry.path}::${entry.canon}`)))
      .map(({ entry, origin, overriddenReference }) => ({
        ...entry, origin, ...(overriddenReference ? { overriddenReference } : {})
      }));

    return { ...base, fields };
  }

  async function readDecisions(id) {
    const fp = decisionsFile(id);
    try {
      const text = await fs.readFile(fp, 'utf8');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  // Decisions about a COLUMN NAME (the default scope) are shared by every file: they come
  // first, so what the user said about this very file still has the last word.
  const COLUMN_MEMORY = '_columns';
  async function listDecisions(formatId) {
    const own = await readDecisions(formatId);
    if (formatId === COLUMN_MEMORY) return own;
    return [...(await readDecisions(COLUMN_MEMORY)), ...own];
  }

  return {
    async listFormats() {
      const all = await readAllFormats();
      return [...all.values()].map(({ entry, origin }) => ({
        id: entry.id,
        displayName: entry.displayName,
        provenance: entry.provenance,
        medium: entry.medium,
        version: entry.version,
        origin
      }));
    },

    async getFormat(id, strata) {
      return readRawFormat(id, strata);
    },

    async matchSignature(input) {
      const all = await readAllFormats();
      return recognize(input, [...all.values()].map(({ entry }) => entry));
    },

    overlayView: overlay,

    async putLearnedFormat(format) {
      if (!format || typeof format.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(format.id)) throw new Error('putLearnedFormat: invalid format id');
      if (!Array.isArray(format.signatures) || !format.signatures.length) throw new Error('putLearnedFormat: a signature is required');
      if (!Array.isArray(format.fields)) throw new Error('putLearnedFormat: fields[] is required');
      const fp = path.join(formatsLearnedDir, `${format.id}.json`);
      await writeJsonAtomic(fp, format);
      return format;
    },

    /** The user's column edits of a Reference format: { id, at, columns: { [column]: { at, entries } } } | null. */
    async getColumnEdits(id) {
      return readJsonSafe(overlayFile(id));
    },

    /** Re-point one column of a Reference format: `entries` replace that
     *  column's Reference entries (one ignore entry = do not import). */
    async putColumnEdit(id, column, entries) {
      if (!(await readJsonSafe(path.join(formatsRefDir, `${id}.json`)))) throw new Error(`putColumnEdit: ${id} is not a Reference format`);
      if (!column || !Array.isArray(entries) || !entries.length || entries.some((e) => !e || e.path !== column || !e.transform)) throw new Error('putColumnEdit: entries must target the column');
      const at = new Date().toISOString();
      const cur = (await readJsonSafe(overlayFile(id))) || { schemaVersion: 1, id, columns: {} };
      const next = { ...cur, at, columns: { ...cur.columns, [column]: { at, entries } } };
      await writeJsonAtomic(overlayFile(id), next);
      return next;
    },

    /** Back to the Reference mapping for one column (or every column: no column). */
    async removeColumnEdit(id, column) {
      const cur = await readJsonSafe(overlayFile(id));
      if (!cur) return false;
      const columns = { ...cur.columns };
      if (column) delete columns[column]; else for (const k of Object.keys(columns)) delete columns[k];
      if (!Object.keys(columns).length) { await fs.unlink(overlayFile(id)).catch((e) => { if (e.code !== 'ENOENT') throw e; }); return true; }
      await writeJsonAtomic(overlayFile(id), { ...cur, at: new Date().toISOString(), columns });
      return true;
    },

    async removeLearnedFormat(id) {
      const fp = path.join(formatsLearnedDir, `${id}.json`);
      try { await fs.unlink(fp); return true; }
      catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    },

    async recordDecision(decision) {
      const shared = decision.scope?.kind === 'column';
      const storeId = shared ? COLUMN_MEMORY : decision.formatId;
      const fp = decisionsFile(storeId);
      await fs.mkdir(path.dirname(fp), { recursive: true });
      // idempotence: saying again what was last said about this column adds nothing
      // (the clock is NOT part of the key: it never repeats, so nothing was ever deduplicated)
      const existing = await readDecisions(storeId);
      const same = (a) => (shared ? normHeaderKey(a.fieldPath) === normHeaderKey(decision.fieldPath) : a.fieldPath === decision.fieldPath);
      const last = [...existing].reverse().find((d) => same(d) && (d.scope?.kind === 'column') === shared && (d.action !== 'rejected' || d.canonCandidate === decision.canonCandidate || decision.action !== 'rejected'));
      if (last && last.action === decision.action && (last.canonCandidate ?? null) === (decision.canonCandidate ?? null) && last.formatId === decision.formatId) return;
      await fs.appendFile(fp, JSON.stringify(decision) + '\n', 'utf8');
    },

    listDecisions,

    async addSample({ formatId, fieldPath, raw, policy }) {
      const cfg = await loadConfig();
      if (!cfg.samples.enabled) return;
      const fmt = await readRawFormat(formatId);
      const entry = (fmt?.fields || []).find((f) => f.path === fieldPath);
      const resolved = resolveSamplePolicy(cfg, entry, fieldPath, policy);
      const isLong = /html|description|body/i.test(fieldPath);
      const payload = makeSamplePayload(resolved, raw, cfg, isLong);
      if (!payload) return; // policy 'none'
      const fp = samplesFile(formatId, fieldPath);
      await fs.mkdir(path.dirname(fp), { recursive: true });
      // ring buffer: keep only maxPerField last
      let lines = [];
      try { lines = (await fs.readFile(fp, 'utf8')).split('\n').filter(Boolean); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      lines.push(JSON.stringify({ at: new Date().toISOString(), formatId, fieldPath, payload }));
      const keep = lines.slice(-cfg.samples.maxPerField);
      await fs.writeFile(fp, keep.join('\n') + '\n', 'utf8');
    },

    async listSamples(formatId, fieldPath) {
      const fp = samplesFile(formatId, fieldPath);
      try {
        const text = await fs.readFile(fp, 'utf8');
        return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    },

    async purgeSamples(scope) {
      let count = 0;
      if (scope.kind === 'field') {
        const fp = samplesFile(scope.formatId, scope.fieldPath);
        try { const existing = await fs.readFile(fp, 'utf8'); count = existing.split('\n').filter(Boolean).length; await fs.unlink(fp); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        return count;
      }
      if (scope.kind === 'format') {
        const dir = path.dirname(samplesFile(scope.formatId, 'x'));
        try {
          const entries = await fs.readdir(dir);
          for (const n of entries) {
            const fp = path.join(dir, n);
            const text = await fs.readFile(fp, 'utf8').catch(() => '');
            count += text.split('\n').filter(Boolean).length;
            await fs.unlink(fp);
          }
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        return count;
      }
      // all
      const root = path.join(learnedDir, 'learned');
      async function walk(d) {
        let entries;
        try { entries = await fs.readdir(d, { withFileTypes: true }); }
        catch (e) { if (e.code === 'ENOENT') return; throw e; }
        for (const it of entries) {
          const p = path.join(d, it.name);
          if (it.isDirectory()) await walk(p);
          else if (p.endsWith('.jsonl') && p.includes(`${path.sep}samples${path.sep}`)) {
            const text = await fs.readFile(p, 'utf8').catch(() => '');
            count += text.split('\n').filter(Boolean).length;
            await fs.unlink(p);
          }
        }
      }
      await walk(root);
      return count;
    },

    async origin(id) {
      const learned = await readJsonSafe(path.join(formatsLearnedDir, `${id}.json`));
      if (learned) return 'learned';
      const ref = await readJsonSafe(path.join(formatsRefDir, `${id}.json`));
      if (ref) return 'reference';
      return null;
    },

    async getConfig() { return loadConfig(); },
    async setConfig(patch) {
      const cur = await loadConfig();
      const next = { ...cur, ...patch, samples: { ...cur.samples, ...(patch?.samples || {}) } };
      await writeJsonAtomic(configPath, next);
      return next;
    }
  };
}
