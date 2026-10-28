/**
 * One HTTP exchange under ONE deadline — headers AND body. A timer that is
 * cleared once the headers arrive leaves the body read unbounded: a server that
 * answers its headers and then stalls the body would hold the caller forever.
 * Here the same timer (and an optional caller signal, e.g. the job's own stop
 * signal) covers the whole exchange; the body read is also raced against the
 * deadline, so even a fetch implementation that ignores the abort signal
 * cannot hang the caller.
 *
 * PORTABLE: zero Node built-ins (AbortController / setTimeout only).
 */

export class DeadlineError extends Error {
  constructor(kind, ms) { super(kind === 'aborted' ? 'aborted' : `timeout after ${ms} ms`); this.name = 'DeadlineError'; this.kind = kind; }
}

/** A signal aborted when any of `signals` aborts (AbortSignal.any when available). */
export function anySignal(signals) {
  const list = (signals || []).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const ac = new AbortController();
  for (const s of list) { if (s.aborted) { ac.abort(s.reason); break; } s.addEventListener('abort', () => ac.abort(s.reason), { once: true }); }
  return ac.signal;
}

/**
 * Run `work(signal)` (which fetches AND reads the body) within `timeoutMs`, also
 * stopped by `signal`. Resolves with work's value, or rejects with a DeadlineError
 * ('timeout' | 'aborted'). The timer is always cleared.
 */
export function withinDeadline(work, { timeoutMs = 20000, signal = null } = {}) {
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const combined = anySignal([ac && ac.signal, signal]);
  let timer = null; let onAbort = null;
  const stop = new Promise((_, reject) => {
    if (signal && signal.aborted) { reject(new DeadlineError('aborted', timeoutMs)); return; }
    timer = setTimeout(() => { try { ac && ac.abort(); } catch { /* ignore */ } reject(new DeadlineError('timeout', timeoutMs)); }, Math.max(1, Number(timeoutMs) || 1));
    if (signal) { onAbort = () => reject(new DeadlineError('aborted', timeoutMs)); signal.addEventListener('abort', onAbort, { once: true }); }
  });
  const run = Promise.resolve().then(() => work(combined));
  return Promise.race([run, stop]).finally(() => {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    run.catch(() => { /* a late failure after the deadline is not unhandled */ });
  });
}

/**
 * fetch + body read under one deadline. `as`: 'text' | 'json'. Never throws:
 * { ok:true, res, status, headers, body } or { ok:false, status, error:'timeout'|'aborted'|message, res? }.
 * With as 'json', a body that is not JSON gives body null and `jsonError: true`.
 */
export async function fetchWithin(fetchImpl, url, init = {}, { timeoutMs = 20000, signal = null, as = 'text' } = {}) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) return { ok: false, status: 0, error: 'no fetch implementation available' };
  let res = null;
  try {
    return await withinDeadline(async (sig) => {
      res = await f(url, { ...init, ...(sig ? { signal: sig } : {}) });
      let body = null; let jsonError = false;
      if (as === 'json') { try { body = await res.json(); } catch (e) { if (e && e.name === 'AbortError') throw e; body = null; jsonError = true; } }
      else { body = await res.text(); }
      return { ok: true, res, status: res.status, headers: res.headers, body, ...(jsonError ? { jsonError } : {}) };
    }, { timeoutMs, signal });
  } catch (e) {
    const kind = e instanceof DeadlineError ? e.kind : (e && e.name === 'AbortError' ? (signal && signal.aborted ? 'aborted' : 'timeout') : null);
    return { ok: false, status: res ? res.status : 0, res, error: kind || String((e && e.message) || e) };
  }
}

/** Retry-After as milliseconds (seconds or an HTTP date), or null when absent/unreadable. */
export function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

/**
 * Per-host request spacing with RESERVATION: the slot is booked synchronously
 * before the caller waits, so concurrent callers queue one `minDelayMs` apart
 * instead of all reading the same "last request" time and firing together.
 * `pushBack(host, ms)` moves the host's next free slot (a 429's Retry-After).
 */
export class HostPacer {
  constructor({ minDelayMs = 500, now = () => Date.now() } = {}) { this.minDelayMs = Math.max(0, Number(minDelayMs) || 0); this.now = now; this._next = new Map(); }
  static hostOf(url) { try { return new URL(url).host; } catch { return ''; } }
  /** Book the next slot for `url`'s host; returns how long the caller must wait (ms). */
  reserve(url) {
    const host = HostPacer.hostOf(url); const t = this.now();
    const slot = Math.max(t, this._next.get(host) || 0);
    this._next.set(host, slot + this.minDelayMs);
    return slot - t;
  }
  pushBack(url, ms) {
    const host = HostPacer.hostOf(url); const until = this.now() + Math.max(0, Number(ms) || 0);
    if ((this._next.get(host) || 0) < until) this._next.set(host, until);
  }
}
