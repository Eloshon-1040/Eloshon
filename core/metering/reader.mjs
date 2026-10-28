/**
 * Usage ledger READER — streaming queries over every ledger file (rotated + the
 * current one). Never loads the whole ledger: lines are read one by one with
 * readline; a newest-first page holds at most one file's matching lines (files
 * are capped by the writer's rotation threshold), aggregates are O(1) memory.
 *
 * Malformed lines (a crash mid-write, a manual edit) are skipped and counted, so
 * one bad line can never hide the rest of the history.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { ledgerFiles, FIELDS, PAID_PROVIDERS } from './ledger.mjs';

/** Ledger provider → provider-runtime id (caps). Only DIRECT (own-key) calls count. */
export const RUNTIME_ID = Object.freeze({
  firecrawl: 'firecrawl',
  webunlocker: 'brightData.webUnlocker',
  scrapingbrowser: 'brightData.scrapingBrowser',
  zyte: 'zyte',
});

async function* readLines(file, stats) {
  let stream;
  try { stream = fs.createReadStream(file, { encoding: 'utf8' }); } catch { return; }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of rl) {
      const s = raw.trim(); if (!s) continue;
      let o; try { o = JSON.parse(s); } catch { if (stats) stats.badLines += 1; continue; }
      if (!o || typeof o !== 'object' || !o.ts) { if (stats) stats.badLines += 1; continue; }
      yield o;
    }
  } catch { /* unreadable file: skip it, keep the rest */ } finally { try { rl.close(); stream.destroy(); } catch { /* ignore */ } }
}

/** Every event, oldest first, across all files. */
export async function* iterateLedger(dir, stats = { badLines: 0 }) {
  for (const f of ledgerFiles(dir)) yield* readLines(f, stats);
}

const asList = (v) => (v == null || v === '' ? null : (Array.isArray(v) ? v : [v]).map(String));
const toMs = (v) => { if (v == null || v === '') return null; const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? n : null; };

/** Compile a filter into a predicate. Domain matches the exact host or any subdomain of it. */
export function compileFilter(filter = {}) {
  const from = toMs(filter.from), to = toMs(filter.to);
  const providers = asList(filter.provider), outcomes = asList(filter.outcome), channels = asList(filter.channel);
  const domain = filter.domain ? String(filter.domain).toLowerCase().replace(/^www\./, '').trim() : null;
  const jobId = filter.jobId ? String(filter.jobId) : null;
  const tm = filter.testMode === true || filter.testMode === 'true' ? true : (filter.testMode === false || filter.testMode === 'false' ? false : null);
  const paidOnly = !!filter.paidOnly;
  return (o) => {
    const t = Date.parse(o.ts);
    if (from != null && !(t >= from)) return false;
    if (to != null && !(t < to)) return false;
    if (providers && !providers.includes(o.provider)) return false;
    if (outcomes && !outcomes.includes(o.outcome)) return false;
    if (channels && !channels.includes(o.channel)) return false;
    if (jobId && o.jobId !== jobId) return false;
    if (tm != null && !!o.testMode !== tm) return false;
    if (paidOnly && !PAID_PROVIDERS.includes(o.provider)) return false;
    if (domain && !(o.domain === domain || (o.domain && o.domain.endsWith('.' + domain)))) return false;
    return true;
  };
}

/**
 * Newest-first page of matching events + the total match count.
 * @returns {Promise<{rows:object[], total:number, offset:number, limit:number, badLines:number}>}
 */
export async function queryLedger(dir, filter = {}, { offset = 0, limit = 50 } = {}) {
  const pred = compileFilter(filter);
  const stats = { badLines: 0 };
  const files = ledgerFiles(dir).reverse();
  const rows = []; let total = 0; let skip = Math.max(0, offset | 0); const take = Math.max(1, Math.min(1000, limit | 0 || 50));
  for (const f of files) {
    const inFile = [];
    for await (const o of readLines(f, stats)) if (pred(o)) inFile.push(o);
    total += inFile.length;
    for (let i = inFile.length - 1; i >= 0 && rows.length < take; i--) {
      if (skip > 0) { skip--; continue; }
      rows.push(inFile[i]);
    }
  }
  return { rows, total, offset: Math.max(0, offset | 0), limit: take, badLines: stats.badLines };
}

/** Every event of one job, oldest first by timestamp (the route chain, in order;
 *  stable for equal timestamps, so write order breaks ties). */
export async function jobEvents(dir, jobId) {
  if (!jobId) return [];
  const out = [];
  for await (const o of iterateLedger(dir)) if (o.jobId === jobId) out.push(o);
  return out.map((o, i) => [o, i]).sort((a, b) => (a[0].ts < b[0].ts ? -1 : a[0].ts > b[0].ts ? 1 : a[1] - b[1])).map(([o]) => o);
}

// ---------------------------------------------------------------- aggregates

const blank = () => ({ events: 0, calls: 0, success: 0, empty: 0, failed: 0, blocked: 0, skipped: 0, quotaExhausted: 0, credits: 0, costUsd: 0, costUnknown: 0, bytes: 0, tokensIn: 0, tokensOut: 0, products: 0 });

function add(acc, o) {
  acc.events += 1;
  if (o.attempted) acc.calls += 1;
  if (o.outcome === 'success') acc.success += 1;
  else if (o.outcome === 'empty') acc.empty += 1; // page received, no product: billed, not a success
  else if (o.outcome === 'failed' || o.outcome === 'timeout') acc.failed += 1;
  else if (o.outcome === 'blocked_by_cap' || o.outcome === 'blocked_no_optin') acc.blocked += 1;
  else if (o.outcome === 'skipped') acc.skipped += 1;
  else if (o.outcome === 'quota_exhausted') acc.quotaExhausted += 1;
  if (Number.isFinite(o.credits)) acc.credits += o.credits;
  if (Number.isFinite(o.costUsd)) acc.costUsd += o.costUsd;
  else if (o.attempted && PAID_PROVIDERS.includes(o.provider) && o.provider !== 'cascade') acc.costUnknown += 1;
  if (Number.isFinite(o.bytes)) acc.bytes += o.bytes;
  if (Number.isFinite(o.tokensIn)) acc.tokensIn += o.tokensIn;
  if (Number.isFinite(o.tokensOut)) acc.tokensOut += o.tokensOut;
  if (Number.isFinite(o.products)) acc.products += o.products;
}

/** Local-time period starts (the admin reads "today" in their own timezone). */
export function periodStarts(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const last7d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6).getTime();
  const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return { today, last7d, month };
}

/**
 * Totals per period (today / last 7 days / this month, local time) and per
 * provider, plus last use, last event and last error per provider.
 */
export async function summarizeLedger(dir, { now = Date.now() } = {}) {
  const starts = periodStarts(now);
  const periods = { today: { total: blank(), byProvider: {} }, last7d: { total: blank(), byProvider: {} }, month: { total: blank(), byProvider: {} } };
  const lastUse = {}, lastEvent = {}, lastError = {};
  const stats = { badLines: 0 }; let events = 0; let first = null;
  for await (const o of iterateLedger(dir, stats)) {
    events += 1; if (!first) first = o.ts;
    const t = Date.parse(o.ts);
    for (const [k, start] of Object.entries(starts)) {
      if (t >= start) { const p = periods[k]; add(p.total, o); add(p.byProvider[o.provider] = p.byProvider[o.provider] || blank(), o); }
    }
    if (o.attempted && (!lastUse[o.provider] || o.ts > lastUse[o.provider])) lastUse[o.provider] = o.ts;
    if (!lastEvent[o.provider] || o.ts >= lastEvent[o.provider].ts) lastEvent[o.provider] = { ts: o.ts, outcome: o.outcome, reason: o.reason || null, route: o.route || null };
    if (['failed', 'timeout', 'quota_exhausted'].includes(o.outcome) && (!lastError[o.provider] || o.ts >= lastError[o.provider].ts)) lastError[o.provider] = { ts: o.ts, outcome: o.outcome, reason: o.reason || null };
  }
  return { periods, lastUse, lastEvent, lastError, events, firstEventAt: first, badLines: stats.badLines, starts };
}

/**
 * Current-month usage of the DIRECT (own-key) paid routes, keyed by provider-runtime
 * id, in the runtime's own month convention (UTC YYYY-MM). Counts every attempted
 * call (a failed call was still sent), exactly like ProviderRuntime.recordCall.
 */
export async function capUsageFromLedger(dir, { now = Date.now() } = {}) {
  const d = new Date(now);
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const out = {};
  for await (const o of iterateLedger(dir)) {
    if (o.channel !== 'direct' || !o.attempted) continue;
    const id = RUNTIME_ID[o.provider]; if (!id) continue;
    if (String(o.ts).slice(0, 7) !== ym) continue;
    const u = out[id] = out[id] || { month: ym, calls: 0, bytes: 0, usd: 0 };
    u.calls += 1; u.bytes += Number(o.bytes) || 0; u.usd += Number(o.costUsd) || 0;
  }
  return out;
}

// ---------------------------------------------------------------- CSV

const csvCell = (v) => { if (v == null) return ''; const s = String(v); return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** CSV of ledger lines (all v1 fields, header first). Lines hold no secret by construction. */
export function toCsv(rows) {
  const head = FIELDS.join(',');
  const body = (rows || []).map((o) => FIELDS.map((k) => csvCell(o[k])).join(','));
  return [head, ...body].join('\r\n') + '\r\n';
}

/** All matching lines, oldest first, for an export. Bounded by `max` (safety). */
export async function exportRows(dir, filter = {}, { max = 200000 } = {}) {
  const pred = compileFilter(filter); const out = [];
  for await (const o of iterateLedger(dir)) { if (pred(o)) { out.push(o); if (out.length >= max) break; } }
  return out;
}
