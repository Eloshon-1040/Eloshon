/**
 * Versioned wire protocol shared by app ↔ native host ↔ extension (Requirement
 * E). Every message is a plain JSON envelope; there is exactly one place that
 * defines the message set, so all three processes agree. Forward-compatible: a
 * receiver that sees a higher `protocol_version` reports a clear mismatch instead
 * of misinterpreting fields.
 *
 * PORTABLE: zero Node built-ins, zero dependencies.
 *
 * Envelope: { protocol_version, type, id, ts, payload }
 *   - id ties a response to its request (echoed back on progress/result/error).
 *   - ts is a millisecond timestamp for ordering/diagnostics.
 *
 * Message set (type):
 *   hello, capabilities, job, progress, result, error, pause, resume, stop, diagnostic
 *
 * NEVER carries a secret. Paid-provider credentials, licence private parts,
 * cookies and customer ids are out of band by construction.
 */

export const PROTOCOL_VERSION = 1;

export const MSG = Object.freeze({
  HELLO: 'hello',                 // extension/host -> peer: I am here, here is who I am
  CAPABILITIES: 'capabilities',   // reply to hello: modes/browser/permissions supported
  JOB: 'job',                     // app -> extension: run this job (recipe + cursor + config)
  PROGRESS: 'progress',           // extension -> app: incremental progress
  RESULT: 'result',               // extension -> app: chunk/final products + status
  ERROR: 'error',                 // any -> any: a failure tied to an id
  PAUSE: 'pause',                 // app -> extension OR extension -> app (challenge)
  RESUME: 'resume',               // app -> extension: continue from cursor
  STOP: 'stop',                   // app -> extension: abandon the job
  DIAGNOSTIC: 'diagnostic',       // extension -> app: diagnostic export (no secrets)
  AI_REQUEST: 'ai_request',       // extension -> app: analyse this page's JSON with the model (opt-in)
  AI_RESULT: 'ai_result',         // app -> extension: { ok, cards, hints } — echoes the request id
  PANEL_REQUEST: 'panel_request', // extension -> app: side-panel request { op: 'recipe' | 'ingest' | 'learn' | 'propose' | 'knowledge' | 'forget' | 'retest' | 'page' | 'rules' | 'repair' | 'chat' | 'recipes', … }
  PANEL_RESULT: 'panel_result',   // app -> extension: reply to a panel request — echoes the request id
});

export const MSG_TYPES = Object.freeze(Object.values(MSG));

/** Required payload fields per message type (structural, not exhaustive). */
const REQUIRED = Object.freeze({
  [MSG.HELLO]: ['role'],                       // 'extension' | 'host' | 'app'
  [MSG.CAPABILITIES]: ['protocol_version', 'modes'],
  [MSG.JOB]: ['job_id', 'domain', 'recipe'],
  [MSG.PROGRESS]: ['job_id'],
  [MSG.RESULT]: ['job_id', 'status'],
  [MSG.ERROR]: ['code', 'message'],
  [MSG.PAUSE]: ['job_id', 'reason'],
  [MSG.RESUME]: ['job_id'],
  [MSG.STOP]: ['job_id'],
  [MSG.DIAGNOSTIC]: ['job_id'],
  [MSG.AI_REQUEST]: ['mode'],     // 'detect' | 'run'
  [MSG.AI_RESULT]: ['ok'],
  [MSG.PANEL_REQUEST]: ['op'],     // 'recipe' | 'ingest' | 'learn' | 'propose' | 'knowledge' | 'forget' | 'retest' | 'page' | 'rules' | 'repair' | 'chat' | 'recipes'
  [MSG.PANEL_RESULT]: ['ok'],
});

let _seq = 0;
/** Monotonic-ish id; callers may pass their own. */
export function newId(prefix = 'm') { _seq = (_seq + 1) % 1e9; return `${prefix}_${Date.now().toString(36)}_${_seq}`; }

/**
 * Build a well-formed envelope.
 * @param {string} type one of MSG.*
 * @param {object} payload
 * @param {{id?:string, ts?:number}} [opts]
 */
export function makeMessage(type, payload = {}, opts = {}) {
  if (!MSG_TYPES.includes(type)) throw new Error(`Type de message inconnu « ${type} ».`);
  return {
    protocol_version: PROTOCOL_VERSION,
    type,
    id: opts.id || newId(),
    ts: opts.ts == null ? Date.now() : opts.ts,
    payload,
  };
}

/**
 * Validate a received envelope. Returns { ok, errors:[…], versionMismatch }.
 * Never throws. Treats a higher protocol_version as a version mismatch (the
 * receiver should ask the peer to update rather than guess).
 */
export function validateMessage(msg) {
  const errors = [];
  if (msg == null || typeof msg !== 'object') return { ok: false, errors: ['Message vide ou non-objet.'], versionMismatch: false };
  const versionMismatch = typeof msg.protocol_version === 'number' && msg.protocol_version > PROTOCOL_VERSION;
  if (typeof msg.protocol_version !== 'number') errors.push('Champ protocol_version manquant.');
  if (!MSG_TYPES.includes(msg.type)) errors.push(`Type « ${msg.type} » inconnu.`);
  if (typeof msg.id !== 'string' || !msg.id) errors.push('Champ id manquant.');
  const req = REQUIRED[msg.type] || [];
  const p = msg.payload || {};
  for (const f of req) if (p[f] == null) errors.push(`Charge utile: champ « ${f} » requis pour « ${msg.type} ».`);
  return { ok: errors.length === 0 && !versionMismatch, errors, versionMismatch };
}

// ---- Convenience factories (all return envelopes) ----------------------------

export const hello = (role, info = {}) => makeMessage(MSG.HELLO, { role, ...info });
export const capabilities = (modes, info = {}) => makeMessage(MSG.CAPABILITIES, { protocol_version: PROTOCOL_VERSION, modes, ...info });
export const job = (job_id, domain, recipe, extra = {}) => makeMessage(MSG.JOB, { job_id, domain, recipe, ...extra });
export const progress = (job_id, data = {}) => makeMessage(MSG.PROGRESS, { job_id, ...data });
export const result = (job_id, status, data = {}) => makeMessage(MSG.RESULT, { job_id, status, ...data });
export const error = (code, message, data = {}) => makeMessage(MSG.ERROR, { code, message, ...data });
export const pause = (job_id, reason, data = {}) => makeMessage(MSG.PAUSE, { job_id, reason, ...data });
export const resume = (job_id, data = {}) => makeMessage(MSG.RESUME, { job_id, ...data });
export const stop = (job_id, data = {}) => makeMessage(MSG.STOP, { job_id, ...data });
export const diagnostic = (job_id, report = {}) => makeMessage(MSG.DIAGNOSTIC, { job_id, report });
export const aiRequest = (payload = {}, opts = {}) => makeMessage(MSG.AI_REQUEST, payload, opts);
export const aiResult = (payload = {}, opts = {}) => makeMessage(MSG.AI_RESULT, payload, opts);
export const panelRequest = (payload = {}, opts = {}) => makeMessage(MSG.PANEL_REQUEST, payload, opts);
export const panelResult = (payload = {}, opts = {}) => makeMessage(MSG.PANEL_RESULT, payload, opts);

/** Job/result status vocabulary shared with the controller (Requirement F/H). */
export const JOB_STATUS = Object.freeze({
  RUNNING: 'running',
  PAUSED_CHALLENGE: 'paused_challenge',
  BLOCKED: 'blocked',
  DONE: 'done',
  STOPPED: 'stopped',
  ERROR: 'error',
});
