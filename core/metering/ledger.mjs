/**
 * Usage ledger — the permanent, append-only record of every external or routing
 * event (one JSON line per event). It is the SINGLE source of truth for "which
 * route ran, when, for which job, with what result and cost". Nothing in here is
 * ever rewritten, reset on a month change, or deleted automatically.
 *
 * Storage: <userData>/usage-ledger/ledger.jsonl (UTF-8 JSON Lines). When the
 * current file would grow past `maxBytes` (default 5 MiB ≈ 12–15k lines) it is
 * renamed to ledger-YYYY-MM-NNN.jsonl (YYYY-MM = rotation month, NNN = sequence)
 * and a fresh ledger.jsonl starts. ALL rotated files are kept; the reader walks
 * them in order.
 *
 * Single writer: every event goes through `record()`, which appends ONE complete
 * line with a synchronous append. The main process is single-threaded, so the
 * engine's parallel workers (async concurrency) can never interleave two lines.
 *
 * Never breaks a job: `record()` never throws. A write failure is counted, kept
 * in `status()` for the admin area, and reported to `onError` ONCE.
 *
 * Secrets: URLs lose their query string, fragment and user:password; free-text
 * reasons are redacted (bearer tokens, key=…, provider auth strings, long opaque
 * tokens) and scrubbed of any known secret value supplied by `secrets()`.
 */
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 1;
export const LEDGER_DIRNAME = 'usage-ledger';
export const CURRENT_FILE = 'ledger.jsonl';
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** Every route the app can take. `local` and `extension` are free for the owner. */
export const PROVIDERS = Object.freeze(['local', 'extension', 'firecrawl', 'webunlocker', 'scrapingbrowser', 'cascade', 'scrapfly', 'anthropic', 'zyte']);
export const PAID_PROVIDERS = Object.freeze(['firecrawl', 'webunlocker', 'scrapingbrowser', 'cascade', 'scrapfly', 'anthropic', 'zyte']);
// `empty` (v0.5.34): the paid request succeeded and a page came back, but the page
// yielded no product — billed, and not a success for the job.
export const OUTCOMES = Object.freeze(['success', 'empty', 'failed', 'blocked_by_cap', 'blocked_no_optin', 'skipped', 'timeout', 'quota_exhausted']);
/** direct = the owner's own keys on this machine; server = through the Eloshon
 *  server cascade (server-side keys); local = no external service. */
export const CHANNELS = Object.freeze(['local', 'direct', 'server']);

/** The stable line shape (v1). Every key is always present (null when unknown). */
export const FIELDS = Object.freeze([
  'v', 'ts', 'jobId', 'domain', 'url', 'provider', 'route', 'channel', 'outcome', 'attempted', 'reason',
  'products', 'bytes', 'durationMs', 'credits', 'units', 'upstream', 'model', 'tokensIn', 'tokensOut',
  'costUsd', 'costBasis', 'testMode', 'appVersion', 'cacheState',
]);
/** Where a paid page came from, when the provider says so (Firecrawl v2
 *  `metadata.cacheState`): `hit` = a copy the provider already held. */
export const CACHE_STATES = Object.freeze(['hit', 'miss']);

const ROTATED_RE = /^ledger-(\d{4})-(\d{2})-(\d{3})\.jsonl$/;

// ---------------------------------------------------------------- sanitising

/** Origin + path only: no query, no fragment, no user:password. null if not a URL. */
export function sanitizeUrl(u) {
  if (u == null || u === '') return null;
  try {
    const x = new URL(String(u));
    if (!/^https?:$/.test(x.protocol)) return null;
    return `${x.protocol}//${x.host}${x.pathname}`.slice(0, 500);
  } catch { return null; }
}

/** Registrable-ish host (lowercase, no leading www.) — the same key the controller
 *  uses to match opt-in lists. */
export function domainOf(u) {
  if (!u) return null;
  try { return new URL(/^[a-z]+:\/\//i.test(String(u)) ? String(u) : `https://${u}`).hostname.toLowerCase().replace(/^www\./, '') || null; } catch { return null; }
}

/**
 * Remove anything that looks like a credential from a free-text string, then any
 * exact known secret value. Used for `reason` (and defensively for every string).
 */
export function redactSecrets(s, known = []) {
  let x = scrubKnown(String(s == null ? '' : s), known);
  x = x.replace(/(wss?|https?):\/\/[^@\s/]+@/gi, '$1://***@');
  x = x.replace(/brd-customer-[A-Za-z0-9_]+-zone-[A-Za-z0-9_-]+(:[^@\s]+)?/g, 'brd-customer-***');
  x = x.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
  x = x.replace(/\b(sk-ant|fc|sk)-[A-Za-z0-9_-]{8,}/g, '$1-***');
  x = x.replace(/((?:api[_-]?key|x-api-key|apikey|token|licen[cs]e|password|passwd|secret|authorization|auth|cookie|key)\s*["']?\s*[:=]\s*["']?)([^\s"',;&]+)/gi, '$1***');
  x = x.replace(/[A-Za-z0-9_-]{32,}/g, '***');
  // Query strings carry tokens too: keep the path, drop the parameters.
  x = x.replace(/(https?:\/\/[^\s?#"']+)\?[^\s"']*/gi, '$1');
  return x;
}

/** Replace every exact occurrence of a known secret value (≥ 6 chars) by ***. */
export function scrubKnown(s, known = []) {
  let x = String(s == null ? '' : s);
  for (const v of known) { if (v && String(v).length >= 6) x = x.split(String(v)).join('***'); }
  return x;
}

/** A short, machine-ish reason (never a raw error body). */
export function reasonOf(r, known = []) {
  if (r == null || r === '') return null;
  return redactSecrets(String(r), known).replace(/\s+/g, ' ').trim().slice(0, 160) || null;
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const int = (v) => { const n = num(v); return n == null ? null : Math.round(n); };
const str = (v, max = 120) => (v == null || v === '' ? null : String(v).slice(0, max));

/**
 * Build the fixed-shape v1 line from a loose event. Unknown providers / outcomes
 * are kept as given (so a future route is never lost) but trimmed.
 */
export function normalizeEvent(e = {}, { now = Date.now, appVersion = null, secrets = [] } = {}) {
  const url = sanitizeUrl(e.url);
  const ts = e.ts ? new Date(e.ts) : new Date(now());
  const out = {
    v: SCHEMA_VERSION,
    ts: Number.isNaN(ts.getTime()) ? new Date(now()).toISOString() : ts.toISOString(),
    jobId: str(e.jobId, 80),
    domain: str(e.domain ? String(e.domain).toLowerCase().replace(/^www\./, '') : domainOf(url), 200),
    url,
    provider: str(e.provider, 40) || 'local',
    route: str(e.route, 60),
    channel: CHANNELS.includes(e.channel) ? e.channel : (e.provider === 'local' || e.provider === 'extension' || !e.provider ? 'local' : 'direct'),
    outcome: str(e.outcome, 40) || 'success',
    attempted: e.attempted === undefined ? true : !!e.attempted,
    reason: reasonOf(e.reason, secrets),
    products: int(e.products),
    bytes: int(e.bytes),
    durationMs: int(e.durationMs),
    credits: num(e.credits),
    units: num(e.units),
    upstream: str(e.upstream, 60),
    model: str(e.model, 80),
    tokensIn: int(e.tokensIn),
    tokensOut: int(e.tokensOut),
    costUsd: num(e.costUsd),
    costBasis: str(e.costBasis, 120),
    testMode: !!e.testMode,
    appVersion: str(e.appVersion || appVersion, 40),
    // Added after the 24 original fields (v0.5.37); older lines simply lack it.
    cacheState: CACHE_STATES.includes(e.cacheState) ? e.cacheState : null,
  };
  // Defence in depth: no field may carry a known secret value.
  for (const k of FIELDS) {
    if (typeof out[k] === 'string' && secrets.length) out[k] = scrubKnown(out[k], secrets);
  }
  return out;
}

// ---------------------------------------------------------------- files

/** Ledger files in chronological order: rotated (by month, then sequence), then the current file. */
export function ledgerFiles(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const rotated = names.filter((n) => ROTATED_RE.test(n)).sort();
  const out = rotated.map((n) => path.join(dir, n));
  if (names.includes(CURRENT_FILE)) out.push(path.join(dir, CURRENT_FILE));
  return out;
}

function nextRotatedName(dir, d) {
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* empty */ }
  let max = 0;
  for (const n of names) { const m = n.match(ROTATED_RE); if (m && `${m[1]}-${m[2]}` === ym) max = Math.max(max, Number(m[3])); }
  return `ledger-${ym}-${String(max + 1).padStart(3, '0')}.jsonl`;
}

// ---------------------------------------------------------------- writer

/**
 * @param {{ dir:string, maxBytes?:number, now?:()=>number, appVersion?:string,
 *   secrets?:()=>string[], onError?:(info:{code:string})=>void,
 *   onRecord?:(line:object)=>void }} opts
 */
export function createLedger({ dir, maxBytes = DEFAULT_MAX_BYTES, now = Date.now, appVersion = null, secrets = () => [], onError = () => {}, onRecord = null } = {}) {
  if (!dir) throw new Error('ledger dir required');
  const file = path.join(dir, CURRENT_FILE);
  let size = null; // cached size of the current file (lazy stat)
  let fd = null;   // one append-mode descriptor (opening per line costs ~15 ms on Windows)
  let errorCount = 0; let lastError = null; let reported = false; let written = 0;

  const fail = (e) => {
    errorCount += 1;
    lastError = { at: new Date(now()).toISOString(), code: String((e && e.code) || (e && e.message) || 'erreur').slice(0, 60) };
    if (!reported) { reported = true; try { onError({ ...lastError }); } catch { /* never throw */ } }
  };

  function closeFd() { if (fd != null) { try { fs.closeSync(fd); } catch { /* ignore */ } fd = null; } }
  function openFd() {
    if (fd != null) return fd;
    fs.mkdirSync(dir, { recursive: true });
    // 'a' = O_APPEND: every write lands at the end, even with another writer.
    fd = fs.openSync(file, 'a');
    try { size = fs.fstatSync(fd).size; } catch { size = 0; }
    return fd;
  }
  function currentSize() {
    if (size != null) return size;
    try { size = fs.statSync(file).size; } catch { size = 0; }
    return size;
  }
  function rotateIfNeeded(addBytes) {
    const cur = currentSize();
    if (cur === 0 || cur + addBytes <= maxBytes) return;
    closeFd();
    const target = path.join(dir, nextRotatedName(dir, new Date(now())));
    fs.renameSync(file, target); // keep everything — never delete history
    size = 0;
  }

  /** Append one event. Returns the written line object, or null if it could not be written. */
  function record(event) {
    let line;
    try {
      let known = [];
      try { known = (secrets() || []).filter(Boolean).map(String); } catch { known = []; }
      line = normalizeEvent(event, { now, appVersion, secrets: known });
      const text = JSON.stringify(line) + '\n';
      const bytes = Buffer.byteLength(text, 'utf8');
      openFd();
      rotateIfNeeded(bytes);
      const buf = Buffer.from(text, 'utf8');
      fs.writeSync(openFd(), buf, 0, buf.length); // ONE write call per line
      size = currentSize() + bytes;
      written += 1;
    } catch (e) { closeFd(); size = null; fail(e); return null; }
    if (onRecord) { try { onRecord(line); } catch { /* a listener never breaks the write */ } }
    return line;
  }

  return {
    dir, file, record,
    close: closeFd,
    files: () => ledgerFiles(dir),
    status: () => ({ dir, file, written, errorCount, lastError, maxBytes }),
  };
}

/** A recorder that writes nothing (controller default when metering is not wired). */
export function nullLedger() {
  return { dir: null, file: null, record: () => null, files: () => [], status: () => ({ dir: null, file: null, written: 0, errorCount: 0, lastError: null }) };
}
