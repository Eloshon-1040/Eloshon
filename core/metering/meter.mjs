/**
 * Meter — the ONE call every instrumented route makes. It prices the event with
 * the cost settings (estimate), appends it to the ledger, and — for a call really
 * sent with the owner's own keys — bumps the provider runtime's cap counters in
 * the same step. So caps and ledger can never drift apart: they are fed by the
 * same function, and at startup the cap counters are reconciled from the ledger.
 *
 * Source of truth: the LEDGER (history, totals, last use, per-job chain). The
 * runtime counters in config.json `providers.usage` are the fast cache the caps
 * read before each billable call; `reconcile()` raises them to the ledger's
 * month totals (never lowers them, so usage recorded before the ledger existed
 * still counts against the caps).
 *
 * Never throws: metering must never break scraping.
 */
import { nullLedger } from './ledger.mjs';
import { effectiveCosts, estimateCost } from './costs.mjs';
import { RUNTIME_ID, capUsageFromLedger } from './reader.mjs';

const FREE = new Set(['local', 'extension']);

export function createMeter({ ledger = nullLedger(), runtime = null, persist = null, readConfig = () => ({}), now = Date.now } = {}) {
  function costsNow() { try { return effectiveCosts(readConfig() || {}); } catch { return effectiveCosts({}); } }

  /** Record one event. Returns the written line (or null if the ledger write failed). */
  function record(evt = {}) {
    let line = null;
    try {
      const e = { ...evt };
      e.attempted = e.attempted === undefined ? true : !!e.attempted;
      e.channel = e.channel || (FREE.has(e.provider) || !e.provider ? 'local' : 'direct');
      if (e.costUsd === undefined) Object.assign(e, estimateCost(e, costsNow()));
      line = ledger.record(e);
      // Caps: a DIRECT call that was really sent counts — even if the ledger write
      // failed (a disk error must not lift a spending cap).
      const id = RUNTIME_ID[e.provider];
      if (runtime && id && e.channel === 'direct' && e.attempted) {
        try {
          runtime.recordCall(id, { bytes: Number(e.bytes) || 0, usd: Number(e.costUsd) || 0 });
          if (persist) persist();
        } catch { /* accounting best-effort */ }
      }
    } catch { /* never break a run */ }
    return line;
  }

  /** A recorder bound to one job: jobId / domain / testMode filled in by default. */
  function forJob({ jobId = null, domain = null, url = null, testMode = false } = {}) {
    return {
      record: (evt = {}) => record({ jobId, domain, url, testMode, ...evt }),
    };
  }

  /** Raise the runtime's current-month cap counters to the ledger's totals. */
  async function reconcile() {
    if (!runtime || !ledger.dir) return { ok: false, reason: 'no_runtime' };
    try {
      const fromLedger = await capUsageFromLedger(ledger.dir, { now: now() });
      let changed = false;
      for (const [id, l] of Object.entries(fromLedger)) {
        const u = runtime.usageFor(id);
        if (l.calls > u.callsThisMonth) { u.callsThisMonth = l.calls; changed = true; }
        if (l.bytes > u.bytesThisMonth) { u.bytesThisMonth = l.bytes; changed = true; }
        if (l.usd > u.usdThisMonth) { u.usdThisMonth = l.usd; changed = true; }
      }
      if (changed && persist) { try { persist(); } catch { /* ignore */ } }
      return { ok: true, changed };
    } catch { return { ok: false, reason: 'read_error' }; }
  }

  return { record, forJob, reconcile, ledger, dir: ledger.dir, status: () => ledger.status() };
}

/** A meter that records nothing (controller default in tests / when not wired). */
export function nullMeter() { return createMeter({ ledger: nullLedger() }); }
