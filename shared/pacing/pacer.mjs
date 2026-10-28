/**
 * Adaptive pacing engine (Requirement: first-class, not a constant). Per-domain
 * token bucket + jitter + Retry-After + automatic backoff on 429/456/403/challenge
 * + latency-aware slowdown + gentle restart after a pause. Every threshold comes
 * from config with conservative defaults. SHARED by app and extension.
 *
 * PORTABLE: zero Node built-ins, zero dependencies. Clock and RNG are injected so
 * tests are deterministic and the same code runs in a service worker or in Node.
 *
 * Usage:
 *   const reg = new PacingRegistry({ defaults, perDomain }, { now, random });
 *   const p = reg.get('colruyt.be');
 *   const waitMs = p.reserve(now());   // sleep waitMs, then make the request
 *   p.onResponse({ status: 200, latencyMs: 120 });  // feed the outcome back
 */
import { TokenBucket } from './token-bucket.mjs';

/** Conservative defaults — tuned to protect the operator's own IP. */
export const PACING_DEFAULTS = Object.freeze({
  baseIntervalMs: 1200,     // steady spacing between requests to one domain
  burst: 1,                 // bucket capacity (1 = strict spacing, no burst)
  jitterRatio: 0.35,        // ± fraction of the interval added as random jitter
  minIntervalMs: 400,       // fastest the engine will ever go
  maxIntervalMs: 30000,     // slowest before it gives up pacing and hands back
  backoffFactor: 2.0,       // multiply interval on a backoff signal
  decayFactor: 0.85,        // multiply interval down after sustained success
  successesToDecay: 5,      // successes before one decay step
  latencyHighMs: 2500,      // above this, treat as the site straining → slow down
  latencySlowFactor: 1.4,   // multiply interval on a high-latency success
  resumeFactor: 2.0,        // interval multiplier applied on gentle restart
  backoffStatuses: [429, 456, 403, 503],  // statuses that trigger backoff
});

/** One adaptive pacer for a single domain. */
export class DomainPacer {
  /**
   * @param {object} config per-domain config merged over PACING_DEFAULTS
   * @param {{now?:()=>number, random?:()=>number}} [io]
   */
  constructor(config = {}, io = {}) {
    this.cfg = { ...PACING_DEFAULTS, ...config };
    this._now = io.now || Date.now;
    this._rand = io.random || Math.random;
    this.intervalMs = this.cfg.baseIntervalMs;
    this.cooldownUntil = 0;      // hard floor from Retry-After / gentle restart
    this.successStreak = 0;
    this.bucket = new TokenBucket({
      capacity: this.cfg.burst,
      refillPerSec: 1000 / this.intervalMs,
      now: this._now,
    });
    /** @type {Array<{t:number, reason:string, intervalMs:number, waitMs:number}>} */
    this.decisions = [];         // ring buffer for diagnostics (bounded)
  }

  _applyInterval() { this.bucket.setRate(1000 / this.intervalMs); }
  _clampInterval() { this.intervalMs = Math.min(this.cfg.maxIntervalMs, Math.max(this.cfg.minIntervalMs, this.intervalMs)); }
  _log(t, reason, waitMs) {
    this.decisions.push({ t, reason, intervalMs: Math.round(this.intervalMs), waitMs: Math.round(waitMs) });
    if (this.decisions.length > 200) this.decisions.shift();
  }

  /**
   * Reserve the next request slot. Returns milliseconds to wait before firing.
   * @param {number} [t] current time (defaults to injected clock)
   */
  reserve(t = this._now()) {
    const bucketWait = this.bucket.reserve(t);
    const hardWait = Math.max(0, this.cooldownUntil - t);
    const base = Math.max(bucketWait, hardWait);
    const jitter = this.intervalMs * this.cfg.jitterRatio * this._rand();
    const waitMs = Math.max(0, Math.round(base + jitter));
    this._log(t, hardWait > bucketWait ? 'cooldown' : 'bucket', waitMs);
    return waitMs;
  }

  /**
   * Feed an outcome back so the engine adapts. Call once per request.
   * @param {{status?:number, challenge?:boolean, latencyMs?:number, retryAfterMs?:number, t?:number}} r
   */
  onResponse(r = {}) {
    const t = r.t == null ? this._now() : r.t;
    const isBackoff = r.challenge === true || (r.status != null && this.cfg.backoffStatuses.includes(r.status));
    if (isBackoff) {
      this.intervalMs *= this.cfg.backoffFactor;
      this._clampInterval();
      if (r.retryAfterMs && r.retryAfterMs > 0) {
        this.cooldownUntil = Math.max(this.cooldownUntil, t + r.retryAfterMs);
      } else {
        // No explicit Retry-After: pause for at least one (raised) interval.
        this.cooldownUntil = Math.max(this.cooldownUntil, t + this.intervalMs);
      }
      this.successStreak = 0;
      this._applyInterval();
      this._log(t, r.challenge ? 'backoff:challenge' : `backoff:${r.status}`, 0);
      return;
    }
    // Success path.
    if (r.latencyMs != null && r.latencyMs > this.cfg.latencyHighMs) {
      this.intervalMs *= this.cfg.latencySlowFactor;
      this._clampInterval();
      this.successStreak = 0;
      this._applyInterval();
      this._log(t, 'slow:latency', 0);
      return;
    }
    this.successStreak += 1;
    if (this.successStreak >= this.cfg.successesToDecay && this.intervalMs > this.cfg.minIntervalMs) {
      this.intervalMs *= this.cfg.decayFactor;
      this._clampInterval();
      this.successStreak = 0;
      this._applyInterval();
      this._log(t, 'decay', 0);
    }
  }

  /**
   * Gentle restart after a human pause / service-worker wake: raise the interval
   * and impose one cooldown so the job eases back in instead of hammering.
   * @param {number} [t]
   */
  resumeGently(t = this._now()) {
    this.intervalMs = Math.max(this.intervalMs, this.cfg.baseIntervalMs * this.cfg.resumeFactor);
    this._clampInterval();
    this.cooldownUntil = Math.max(this.cooldownUntil, t + this.intervalMs);
    this.successStreak = 0;
    this._applyInterval();
    this._log(t, 'resume', this.intervalMs);
  }

  /** Snapshot for the diagnostic export (no secrets, bounded). */
  snapshot() {
    return {
      intervalMs: Math.round(this.intervalMs),
      cooldownUntil: this.cooldownUntil,
      successStreak: this.successStreak,
      recentDecisions: this.decisions.slice(-20),
    };
  }
}

/** Holds one DomainPacer per domain, built from a config object. */
export class PacingRegistry {
  /**
   * @param {{defaults?:object, perDomain?:Record<string,object>}} config
   * @param {{now?:()=>number, random?:()=>number}} [io]
   */
  constructor(config = {}, io = {}) {
    this.defaults = { ...PACING_DEFAULTS, ...(config.defaults || {}) };
    this.perDomain = config.perDomain || {};
    this.io = io;
    this.pacers = new Map();
  }

  /** Get (or lazily create) the pacer for a domain. */
  get(domain) {
    if (!this.pacers.has(domain)) {
      const cfg = { ...this.defaults, ...(this.perDomain[domain] || {}) };
      this.pacers.set(domain, new DomainPacer(cfg, this.io));
    }
    return this.pacers.get(domain);
  }

  /**
   * Apply a per-domain config delivered at run time (e.g. with a job). Same config
   * again → no-op, so a pacer keeps what it learned. A changed config rebuilds the
   * pacer but never goes FASTER than a backoff/cooldown it is already under.
   */
  configure(domain, config = {}) {
    const next = { ...(config || {}) };
    const prev = this.perDomain[domain];
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) return this.get(domain);
    this.perDomain = { ...this.perDomain, [domain]: next };
    const old = this.pacers.get(domain);
    this.pacers.delete(domain);
    const p = this.get(domain);
    if (old) {
      p.intervalMs = Math.max(p.intervalMs, old.intervalMs);
      p.cooldownUntil = Math.max(p.cooldownUntil, old.cooldownUntil);
      p._clampInterval(); p._applyInterval();
    }
    return p;
  }
}
