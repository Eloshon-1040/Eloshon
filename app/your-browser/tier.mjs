/**
 * "Your browser" execution tier (Requirement 11) — the clean app-side contract
 * the future tier chain calls BEFORE paid providers. Transport-agnostic: it is
 * given a `send(msg)` (to the extension via the native-host bridge) and is fed
 * inbound messages via onMessage(); it correlates them to jobs by job_id and
 * resolves a job when a TERMINAL result arrives. Pause/blocked are surfaced via
 * callbacks without resolving (a paused job may still resume).
 *
 * Result status vocabulary matches the shared JOB_STATUS so the chain can decide:
 * done -> success; blocked -> try the next tier; error/stopped -> report.
 */
import * as P from '../../shared/protocol/messages.mjs';

const TERMINAL = new Set([P.JOB_STATUS.DONE, P.JOB_STATUS.BLOCKED, P.JOB_STATUS.STOPPED, P.JOB_STATUS.ERROR]);

export class TierSession {
  /** @param {{send:(msg:object)=>void, now?:()=>number}} io */
  constructor(io) {
    this.send = io.send;
    this.now = io.now || Date.now;
    this.pending = new Map(); // job_id -> { resolve, onProgress, onPause, result }
  }

  /**
   * Start a job on the extension. Resolves with the terminal result:
   *   { status, products, counts, reason?, pacing? }
   * @param {{job_id:string, domain:string, recipe:object, config?:object, limits?:object, start_url?:string, onProgress?:Function, onPause?:Function}} spec
   */
  run(spec) {
    const { job_id, domain, recipe } = spec;
    return new Promise((resolve) => {
      this.pending.set(job_id, { resolve, onProgress: spec.onProgress, onPause: spec.onPause });
      this.send(P.job(job_id, domain, recipe, { config: spec.config || {}, limits: spec.limits || {}, start_url: spec.start_url, ...(spec.pacing ? { pacing: spec.pacing } : {}), ...(spec.page_rules ? { page_rules: spec.page_rules } : {}), ...(spec.challenge ? { challenge: spec.challenge } : {}), ...(spec.detail ? { detail: spec.detail } : {}) }));
    });
  }

  /** True while a job is awaiting its terminal result. */
  has(job_id) { return this.pending.has(job_id); }

  /** Resolve one pending job locally (e.g. the extension never answered a stop). */
  settle(job_id, result) {
    const p = this.pending.get(job_id);
    if (!p) return false;
    this.pending.delete(job_id);
    p.resolve({ products: [], counts: {}, ...result });
    return true;
  }

  /** Resolve every pending job as an error (e.g. the extension disconnected). */
  failAll(reason) {
    for (const jid of [...this.pending.keys()]) this.settle(jid, { status: P.JOB_STATUS.ERROR, reason });
  }

  pause(job_id) { this.send(P.pause(job_id, 'operator')); }
  resume(job_id) { this.send(P.resume(job_id)); }
  stop(job_id) { this.send(P.stop(job_id)); }
  requestDiagnostic(job_id) { this.send(P.diagnostic(job_id, {})); }

  /** Feed an inbound envelope from the extension. */
  onMessage(msg) {
    if (!msg || !msg.payload) return;
    const jid = msg.payload.job_id;
    const p = jid && this.pending.get(jid);
    if (msg.type === P.MSG.PROGRESS) { if (p && p.onProgress) p.onProgress(msg.payload); return; }
    if (msg.type === P.MSG.PAUSE) { if (p && p.onPause) p.onPause(msg.payload); return; }
    if (msg.type === P.MSG.DIAGNOSTIC) { if (p && p.onDiagnostic) p.onDiagnostic(msg.payload.report); return; }
    if (msg.type === P.MSG.ERROR) {
      if (p) { this.pending.delete(jid); p.resolve({ status: P.JOB_STATUS.ERROR, products: [], counts: {}, reason: msg.payload.message, code: msg.payload.code }); }
      return;
    }
    if (msg.type === P.MSG.RESULT) {
      const status = msg.payload.status;
      if (status === P.JOB_STATUS.PAUSED_CHALLENGE) { if (p && p.onPause) p.onPause(msg.payload); return; }
      if (TERMINAL.has(status) && p) {
        this.pending.delete(jid);
        p.resolve({
          status,
          products: msg.payload.products || [],
          counts: msg.payload.counts || {},
          reason: msg.payload.reason,
          pacing: msg.payload.pacing,
          pageVerdicts: msg.payload.page_verdicts || null,
          timings: msg.payload.timings || null,
          recipeDiag: msg.payload.recipe_diag || null,
          extraction: msg.payload.extraction || null,
          errors: msg.payload.errors || null,
        });
      }
    }
  }
}

/** Per-domain opt-in (Requirement H): the tier runs only where the user enabled it. */
export function isYourBrowserEnabled(config, domain) {
  const bag = config && config.yourBrowser && config.yourBrowser.perDomain && config.yourBrowser.perDomain[domain];
  return !!(bag && bag.enabled === true);
}

/** Per-domain pacing overrides for this tier, merged shape for the shared PacingRegistry. */
export function pacingConfigFor(config) {
  const yb = (config && config.yourBrowser) || {};
  const perDomain = {};
  for (const [d, v] of Object.entries(yb.perDomain || {})) if (v && v.pacing) perDomain[d] = v.pacing;
  return { defaults: yb.pacing || {}, perDomain };
}

/**
 * The chain-facing contract: returns a result whose status tells the chain what
 * to do next. `blocked` means "this tier can't; try the next tier".
 */
export async function runYourBrowserTier(session, spec) {
  const res = await session.run(spec);
  return { ...res, tier: 'your_browser', tryNextTier: res.status === P.JOB_STATUS.BLOCKED };
}
