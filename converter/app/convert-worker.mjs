/**
 * Engine host worker (Phase 1 step 5) — runs the PURE conversion engine off
 * the Electron main process, so a large catalogue never freezes the window
 * chrome. The engine itself is untouched (goldens stay byte-identical); this
 * file is transport only.
 *
 * Runs under Electron utilityProcess.fork() in the app (asar-safe, isolates an
 * engine crash/OOM from the window) and under plain node:worker_threads in the
 * test suite — the shim below is the only difference between the two.
 *
 * Protocol (all messages carry plain data):
 *   in : { type: 'init', knowledgeDirs }        — bind the KnowledgeStore dirs
 *   in : { type: 'file', fileId, text }         — cache a file once (no
 *                                                 re-marshalling per preview)
 *   in : { type: 'forget-file', fileId }        — drop a cached file
 *   in : { type: 'job', id, kind, input }       — kind 'run' | 'issues';
 *                                                 input.csvText or input.fileId
 *                                                 (issues: + overrides /
 *                                                  corrections / ignored)
 *   out: { type: 'ready' }
 *   out: { type: 'progress', id, phase }        — phase 'convert' | 'issues'
 *   out: { type: 'result', id, result }
 *   out: { type: 'error', id, error }
 */
import { runConversion, analyzeIssues } from './controller.mjs';
import { applyEditsToText } from '../core/dist/index.mjs';
import { loadAllFormats, loadReferenceFormatsSync } from '../core/knowledge-proposal/reference.mjs';
import { createJsonKnowledgeStore } from '../core/knowledge-proposal/json-store.mjs';

// Transport shim: Electron utilityProcess exposes process.parentPort (messages
// arrive as MessageEvent, .data holds the payload); a Node worker thread
// exposes worker_threads.parentPort (messages arrive bare).
let send, onMessage;
if (process.parentPort) {
  send = (m) => process.parentPort.postMessage(m);
  onMessage = (fn) => process.parentPort.on('message', (e) => fn(e.data));
} else {
  const { parentPort } = await import('node:worker_threads');
  send = (m) => parentPort.postMessage(m);
  onMessage = (fn) => parentPort.on('message', fn);
}

let store = null;           // KnowledgeStore (Reference ⊕ Learned), per init
const files = new Map();    // fileId → text, sent once per worker lifetime

onMessage(async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'init') { store = createJsonKnowledgeStore(msg.knowledgeDirs); return; }
  if (msg.type === 'file') { files.set(msg.fileId, msg.text); return; }
  if (msg.type === 'forget-file') { files.delete(msg.fileId); return; }
  if (msg.type !== 'job') return;
  const { id, kind, input } = msg;
  try {
    // the user's edits (rename a column, replace text, fix prices…) run before detection, mapping and conversion
    const csvText = applyEditsToText(input.csvText ?? files.get(input.fileId) ?? '', input.edits);
    send({ type: 'progress', id, phase: kind === 'issues' ? 'issues' : 'convert' });
    // Formats are re-read from disk per job (the store is the source of truth;
    // Learned changes at runtime when the user teaches a format or decides).
    // A format built from the export manifest beside the file (its column roles) is tried first.
    const base = store ? await loadAllFormats(store) : (input.extraFormat ? loadReferenceFormatsSync() : undefined);
    const formats = input.extraFormat && base ? [input.extraFormat, ...base] : base;
    let result;
    if (kind === 'issues') {
      result = analyzeIssues(csvText, input.direction, { overrides: input.overrides, corrections: input.corrections, ignored: input.ignored, formats });
    } else {
      result = runConversion({ ...input, csvText, ...(formats ? { knowledge: { formats } } : {}) });
    }
    send({ type: 'result', id, result });
  } catch (err) {
    send({ type: 'error', id, error: String((err && err.stack) || err) });
  }
});

send({ type: 'ready' });
