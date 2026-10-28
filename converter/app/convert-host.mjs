/**
 * Engine host client (Phase 1 step 5) — the main-process side of
 * convert-worker.mjs. Owns the worker lifecycle (lazy spawn, respawn after a
 * crash with in-flight jobs rejected, never silently lost), pushes each file's
 * text to the worker ONCE per worker lifetime (previews stop re-marshalling
 * the whole file), forwards progress events, and memoizes the last results so
 * entering step 4 right after an identical step-3 preview re-uses the engine
 * output instead of re-running it.
 *
 * `spawn` is injected: Electron passes a utilityProcess.fork wrapper, the test
 * suite a node:worker_threads wrapper — see makeSpawn in app/main.mjs and
 * test/convert-worker.test.mjs. The wrapper contract:
 *   { post(msg), onMessage(fn), onExit(fn), stop() }
 */
import crypto from 'node:crypto';

const CACHE_SIZE = 4; // tiny: the wizard only ever flips between a few inputs

export function createEngineHost({ spawn, knowledgeDirs, onProgress }) {
  let worker = null;
  let nextId = 1;
  const pending = new Map();   // id → { resolve, reject }
  let sentFiles = new Set();   // fileIds pushed to the CURRENT worker
  const fileTexts = new Map(); // fileId → text (main-side registry)
  let knowledgeVersion = 0;    // bumped on learn/decide/forget → cache off
  const cache = new Map();     // key → result (insertion-ordered, capped)

  function ensureWorker() {
    if (worker) return worker;
    worker = spawn();
    sentFiles = new Set();
    worker.onMessage((msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'progress') { onProgress?.({ id: msg.id, phase: msg.phase }); return; }
      const job = pending.get(msg.id);
      if (!job) return;
      pending.delete(msg.id);
      if (msg.type === 'result') job.resolve(msg.result);
      else if (msg.type === 'error') job.reject(new Error(msg.error));
    });
    worker.onExit(() => {
      // A crashed engine run must surface as an error, never hang the UI.
      for (const [, job] of pending) job.reject(new Error('engine_worker_exited'));
      pending.clear();
      worker = null;
    });
    worker.post({ type: 'init', knowledgeDirs });
    return worker;
  }

  function registerFile(fileId, text) { fileTexts.set(fileId, text); }
  function fileText(fileId) { return fileTexts.get(fileId); }
  function forgetFile(fileId) {
    fileTexts.delete(fileId);
    if (worker && sentFiles.has(fileId)) { worker.post({ type: 'forget-file', fileId }); sentFiles.delete(fileId); }
    cache.clear(); // results for a discarded file have no further takers
  }
  function bumpKnowledge() { knowledgeVersion++; cache.clear(); }

  const hash = (s) => (s == null ? '' : crypto.createHash('sha256').update(s).digest('hex').slice(0, 16));
  // Key-order-insensitive clone: { a, b } and { b, a } are the same overrides.
  const stable = (v) => {
    if (v == null || typeof v !== 'object') return v ?? null;
    if (Array.isArray(v)) return v.map(stable);
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  };

  // Only the fields the engine actually reads — a stray UI field (mode, …)
  // must not defeat the cache, and a relevant one must never be missed.
  function cacheKey(kind, input) {
    return JSON.stringify([kind, knowledgeVersion,
      input.fileId ?? hash(input.csvText),
      input.direction, input.expectPlatform, input.entity ?? null,
      stable(input.overrides), stable(input.corrections), stable(input.edits), stable(input.outEdits), input.categoriesAsTags === true,
      input.ignored ? [...input.ignored].sort() : null,
      input.dateOrder ?? null, input.weightUnit ?? null,
      hash(input.categoriesCsv), hash(input.secondaryCsv), input.secondaryLang ?? null,
      input.redirectOldBase ?? null, input.redirectNewBase ?? null,
      input.limitUnits ?? null, stable(input.skuGenerator), input.stockMode ?? null, stable(input.customTargets),
      // A format built for this file (its manifest's roles, or the column choices not saved yet).
      input.extraFormat ? hash(JSON.stringify(input.extraFormat.fields || [])) : null,
    ]);
  }

  function dispatch(kind, input) {
    const key = cacheKey(kind, input);
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    const w = ensureWorker();
    // Push the file text once per worker lifetime; jobs then carry the id only.
    const payload = { ...input };
    if (payload.fileId != null) {
      if (!sentFiles.has(payload.fileId)) {
        const text = fileTexts.get(payload.fileId);
        if (text != null) { w.post({ type: 'file', fileId: payload.fileId, text }); sentFiles.add(payload.fileId); }
      }
      if (sentFiles.has(payload.fileId)) delete payload.csvText;
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, {
        resolve: (result) => {
          cache.set(key, result);
          while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
          resolve(result);
        },
        reject,
      });
      w.post({ type: 'job', id, kind, input: payload });
    });
  }

  return {
    /** Run a conversion (engine only — billing stays in convert-service). */
    run: (input) => dispatch('run', input),
    /** Step-4 problem report (analyzeIssues) off the main thread. */
    issues: (input) => dispatch('issues', input),
    registerFile, fileText, forgetFile, bumpKnowledge,
    dispose() { if (worker) { worker.stop(); worker = null; } pending.clear(); },
  };
}
