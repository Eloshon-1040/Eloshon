/**
 * ChallengeStrategy interface + registry (Requirement: pluggable detect→handle→
 * resume, extensible without touching the core). A strategy is created per job
 * and its `handle()` decides how to react to a detected challenge, using only the
 * capabilities injected in `env` — so strategies are portable and unit-testable,
 * and adding a new legitimate strategy later means registering a factory, never
 * editing this file.
 *
 * HARD BOUNDARY (fixed): no strategy solves captchas, spoofs identity, rotates
 * IPs, or clicks/types inside a challenge. Its only powers are: WAIT, ask the
 * human to act in their own browser, re-check, resume, or hand back to the app.
 *
 * PORTABLE: zero Node built-ins, zero dependencies.
 *
 * env (injected capabilities):
 *   now()            -> number
 *   sleep(ms)        -> Promise
 *   notify(evt)      -> void         // {level, code, message, category} (badge/notification/app status)
 *   recheck()        -> Promise<bool>// re-read the page; true when back to normal
 *   pacer            -> DomainPacer  // optional; resumeGently() on resume
 *   signal           -> {aborted}    // cooperative stop
 *   log(entry)       -> void         // diagnostic sink (no secrets)
 *
 * handle() resolves to a RESOLUTION object (the durable contract):
 *   { resolution: 'resumed'|'retry'|'blocked'|'stopped', category, attempts, waitedMs, reason? }
 */

export const RESOLUTION = Object.freeze({
  RESUMED: 'resumed',   // page is normal again; continue from the cursor
  RETRY: 'retry',       // caller should re-attempt the same request now
  BLOCKED: 'blocked',   // give up on this tier; app moves to the next tier
  STOPPED: 'stopped',   // job was stopped by the operator
});

/** Default timeouts (ms) — conservative; overridable per recipe. */
export const CHALLENGE_TIMEOUTS = Object.freeze({
  solveMs: 5 * 60 * 1000,  // how long to wait for a human to solve
  pollMs: 3000,            // how often to re-check
  cooldownMs: 60 * 1000,   // base cooldown for cooldown-retry
  maxRetries: 3,
  backoffFactor: 2,
});

/** Base class documenting the contract; strategies may extend or duck-type it. */
export class ChallengeStrategy {
  constructor(config = {}) { this.config = { ...CHALLENGE_TIMEOUTS, ...config }; this.attempts = 0; }
  get name() { return 'base'; }
  // eslint-disable-next-line no-unused-vars
  async handle({ category, context, env }) { throw new Error('ChallengeStrategy.handle not implemented'); }
}

/** Registry of strategy factories, keyed by name. */
export class ChallengeRegistry {
  constructor() { this.factories = new Map(); }
  /** @param {string} name @param {(config:object)=>ChallengeStrategy} factory */
  register(name, factory) { this.factories.set(name, factory); return this; }
  has(name) { return this.factories.has(name); }
  names() { return [...this.factories.keys()]; }
  /** Create a strategy instance; throws a clear French error if unknown. */
  create(name, config = {}) {
    const f = this.factories.get(name);
    if (!f) throw new Error(`Stratégie de défi inconnue « ${name} ». Disponibles : ${this.names().join(', ') || '(aucune)'}.`);
    return f(config);
  }
}
