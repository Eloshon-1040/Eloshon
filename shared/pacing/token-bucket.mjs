/**
 * Token bucket — the rate primitive under the adaptive pacer. Time-based and
 * deterministic: all state is derived from an injected clock, so tests drive it
 * with a virtual `now` and there are no real timers here.
 *
 * PORTABLE: zero Node built-ins, zero dependencies (Date.now works in Node and
 * the browser, but the clock is injected so this stays pure and testable).
 *
 * Concurrency-safe backpressure: `reserve()` decrements immediately and lets the
 * balance go NEGATIVE (a debt). The returned wait is proportional to the debt, so
 * many near-simultaneous reserves queue correctly instead of all firing at once.
 */
export class TokenBucket {
  /**
   * @param {{capacity:number, refillPerSec:number, now?:()=>number}} opts
   */
  constructor({ capacity, refillPerSec, now = Date.now }) {
    this.capacity = Math.max(1, capacity);
    this.refillPerSec = Math.max(1e-6, refillPerSec);
    this._now = now;
    this.tokens = this.capacity;      // start full → an initial burst up to capacity
    this.last = now();
  }

  /** Refill based on elapsed time; the positive side is capped at capacity. */
  _refill(t) {
    if (t > this.last) {
      this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSec);
      this.last = t;
    }
  }

  /** Change the steady rate (adaptive pacing). Keeps accumulated tokens/debt. */
  setRate(refillPerSec) { this.refillPerSec = Math.max(1e-6, refillPerSec); }

  /**
   * Reserve one token at time `t`. Always succeeds (consumes now); returns the
   * milliseconds the caller must wait before actually using it (0 if a token was
   * available). Debt from over-subscription is paid down by refill over time.
   * @param {number} t current time in ms
   * @returns {number} waitMs (>= 0)
   */
  reserve(t) {
    this._refill(t);
    this.tokens -= 1;
    const deficit = this.tokens < 0 ? -this.tokens : 0;
    return (deficit / this.refillPerSec) * 1000;
  }

  /** Introspection for diagnostics — never used for control flow. */
  peek(t) { this._refill(t); return this.tokens; }
}
