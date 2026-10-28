/**
 * "Your browser" tier integration — the single small hook the desktop app uses to
 * start/stop the HostBridge, complete the hello→capabilities handshake, expose the
 * states, and hand user-launched jobs to the extension, routing the results back
 * through the controller's existing ingest (normalise → eligibility → CSV/report).
 *
 * ADDITIVE + SAFE: the feature is OFF unless at least one domain carries the
 * per-domain opt-in flag (config.yourBrowser.perDomain[<domain>].enabled === true —
 * the SAME flag `isYourBrowserEnabled`/`runYourBrowserTier` use). When off, no
 * listener is created and nothing else changes. Start never throws; on any error
 * it logs a clear NON-secret message and continues with the feature off.
 *
 * USER-FACING (not admin): `launch()` validates a renderer request with the pure
 * rules in launch.mjs (opt-in, bounded limits, sanitised pacing, recipe resolved
 * app-side), runs ONE job at a time, never retries on its own, and records EVERY
 * outcome (done / blocked / abandoned / failed) as a normal job in the history.
 *
 * No secret is ever logged: the pairing handshake is consumed inside HostBridge
 * (pre-auth), so post-auth messages carry none; this module never stringifies raw
 * messages into logs.
 */
import { HostBridge } from './bridge.mjs';
import { TierSession, runYourBrowserTier } from './tier.mjs';
import { availability as availabilityFor, buildLaunch, outcomeFor, fail } from './launch.mjs';
import { handlePanelRequest, takeRenderedPages } from './panel-requests.mjs';
import * as P from '../../shared/protocol/messages.mjs';

/** Domains with the per-domain opt-in flag set. */
export function enabledDomains(config) {
  const per = (config && config.yourBrowser && config.yourBrowser.perDomain) || {};
  return Object.keys(per).filter((d) => per[d] && per[d].enabled === true);
}

const CHALLENGE_TEXT = 'action requise : résous le défi dans l’onglet';

/**
 * @param {{ config:object, readConfig?:()=>object, controller?:object, emit?:Function, log?:Function,
 *           now?:()=>number, bridgeFactory?:()=>object, bridgeOptions?:object,
 *           resolveRecipe?:(url:string)=>Promise<object>, recordRun?:(entry:object)=>void,
 *           newJobId?:()=>string, stopGraceMs?:number, setTimer?:Function, clearTimer?:Function }} io
 */
export function createYourBrowserService(io = {}) {
  const emit = io.emit || (() => {});
  const log = io.log || (() => {});
  const config = io.config || {};
  const readConfig = io.readConfig || (() => config);
  const domains = enabledDomains(config);
  // The tier is available whenever the app runs — per-domain authorization is the
  // extension's host-permission grant, learned live over the bridge (below), NOT a
  // config.json flag. So the bridge always starts and waits for the extension,
  // unless an admin explicitly turns the whole tier off (yourBrowser.enabled:false).
  const enabled = !(config && config.yourBrowser && config.yourBrowser.enabled === false);
  const now = io.now || Date.now;
  const newJobId = io.newJobId || (() => `yb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  const stopGraceMs = io.stopGraceMs != null ? io.stopGraceMs : 8000;
  const setTimer = io.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); try { t.unref(); } catch { /* */ } return t; });
  const clearTimer = io.clearTimer || clearTimeout;

  const state = { app: 'running', enabled, domains, permittedDomains: [], bridge: 'stopped', extension: 'disconnected', browser: null, modes: [], job: null };
  let bridge = null;
  let session = null;
  let active = null; // { id, domain } — ONE user job at a time (reserved before any await)
  let stopTimer = null;

  const emitState = (patch) => { Object.assign(state, patch || {}); emit('yourBrowser', { kind: 'state', ...state }); };
  const jobPatch = (patch) => emitState({ job: { ...(state.job || {}), ...patch } });

  function onBridgeStatus(s) {
    if (s === 'connected') { emitState({ bridge: 'connected' }); try { bridge.send(P.hello('app')); } catch { /* solicit capabilities */ } }
    else if (s === 'listening') emitState({ bridge: 'listening' });
    else if (s === 'auth_failed') { emitState({ bridge: 'auth_failed', lastAuth: 'failed' }); log('un client hôte a échoué à s\'authentifier (secret invalide) — refusé'); }
    else if (s === 'error') { emitState({ bridge: 'error' }); }
    else if (s === 'disconnected') {
      emitState({ bridge: 'listening', extension: 'disconnected', browser: null, modes: [], permittedDomains: [] });
      // A job waiting on a vanished extension would otherwise hang forever.
      if (session) session.failAll('extension_disconnected');
    }
  }

  function onBridgeMessage(msg) {
    if (msg && msg.type === P.MSG.CAPABILITIES) {
      const p = msg.payload || {};
      // The extension's granted-domain list is the live authorization source; it is
      // re-sent on every "Activer ce domaine", so this updates with no restart.
      emitState({ extension: 'connected', browser: p.browser || null, modes: p.modes || [], permittedDomains: Array.isArray(p.domains) ? p.domains : [] });
      return;
    }
    // Opt-in AI assist: the extension sends the page's JSON; the app holds the key,
    // calls the model, and replies (echoing the request id). Never runs unless the
    // user clicked the AI button, and only if the app wired an aiAssist handler.
    if (msg && msg.type === P.MSG.AI_REQUEST) {
      const replyId = msg.id;
      const done = (res) => { try { if (bridge) bridge.send(P.aiResult(res || { ok: false, reason: 'ai_unavailable' }, { id: replyId })); } catch { /* link gone */ } };
      if (typeof io.aiAssist !== 'function') { done({ ok: false, reason: 'ai_unavailable' }); return; }
      Promise.resolve().then(() => io.aiAssist(msg.payload || {})).then(done).catch((e) => done({ ok: false, reason: String((e && e.message) || e) }));
      return;
    }
    // Side-panel requests (the user scraping the page open in their own Chrome):
    // the site's learned recipe, or recording the accepted rows as a normal job.
    if (msg && msg.type === P.MSG.PANEL_REQUEST) {
      const replyId = msg.id;
      const done = (res) => { try { if (bridge) bridge.send(P.panelResult(res || { ok: false, reason: 'vide' }, { id: replyId })); } catch { /* link gone */ } };
      const op = msg.payload && msg.payload.op;
      Promise.resolve().then(() => handlePanelRequest(msg.payload || {}, { resolveRecipe: io.resolveRecipe, controller: io.controller, knowledge: io.knowledge || (io.controller && io.controller.knowledge), agent: io.agent || (io.controller && io.controller.agent) }))
        .then((res) => { if (op === 'ingest') log(`panneau : ${res && res.ok ? `lignes enregistrées comme job ${res.jobId}` : `enregistrement refusé (${res && res.reason})`}`); done(res); })
        .catch((e) => { log(`panneau : demande « ${String(op).slice(0, 20)} » en échec (${e && e.code ? e.code : 'erreur'})`); done({ ok: false, reason: 'erreur de l’application' }); });
      return;
    }
    if (session) session.onMessage(msg);
  }

  function start() {
    if (!enabled) { log('tier « votre navigateur » désactivé (aucun domaine opt-in) — HostBridge non démarré'); emitState({ bridge: 'stopped' }); return { started: false, reason: 'feature_off' }; }
    try {
      bridge = io.bridgeFactory
        ? io.bridgeFactory()
        : new HostBridge({ ...(io.bridgeOptions || {}), onMessage: onBridgeMessage, onStatus: onBridgeStatus, log: (e) => log(`bridge: ${e && e.event ? e.event : ''}`) });
      // When a factory is supplied (tests), it may not have wired our handlers.
      if (io.bridgeFactory) { bridge.onMessage = onBridgeMessage; bridge.onStatus = onBridgeStatus; }
      session = new TierSession({ send: (m) => bridge.send(m), now: io.now });
      bridge.start();
      emitState({ bridge: 'listening' });
      return { started: true, domains };
    } catch (e) {
      log(`démarrage HostBridge impossible (${e && e.code ? e.code : 'erreur'}) — tier laissé désactivé`);
      emitState({ bridge: 'error' });
      bridge = null; session = null;
      return { started: false, reason: 'start_error' };
    }
  }

  const svcView = (busy) => ({ started: !!session, connected: state.extension === 'connected', browser: state.browser, busy, permittedDomains: state.permittedDomains });

  /** Is the mode usable for this URL right now? (read-only; drives the form). */
  function availability(url) {
    const av = availabilityFor(readConfig(), url, svcView(!!active));
    // preferred: only the user's browser read this site's lists lately (the app is refused) — launch there.
    let preferred = false; try { preferred = !!(io.prefersYourBrowser && io.prefersYourBrowser(url)); } catch { preferred = false; }
    return { ...av, preferred };
  }

  /** Run one validated spec on the extension, then record the outcome as a job. */
  async function runJob(spec) {
    if (!session) throw new Error('Le tier « votre navigateur » n\'est pas démarré.');
    if (!active) active = { id: spec.job_id, domain: spec.domain };
    const t0 = now();
    emitState({ job: { id: spec.job_id, domain: spec.domain, phase: 'connecting', done: 0, total: 0, message: null } });
    // Terminal trace of each step (no secret: names, counts, host only).
    log(`travail ${spec.job_id} envoyé à l'extension — domaine ${spec.domain}, recette ${spec.recipeKind || '?'} (source ${spec.recipeSource || '?'}${spec.recipeRevision != null ? `, révision ${spec.recipeRevision}` : ''}), limites ${JSON.stringify(spec.limits || {})}`);
    let res; let sawProgress = false;
    const challengeShots = []; // screenshots captured by the extension at each pause
    try {
      res = await runYourBrowserTier(session, {
        ...spec,
        onProgress: (p) => {
          if (!sawProgress) { sawProgress = true; log(`travail ${spec.job_id} : première progression reçue de l'extension`); }
          // step 'detail': the product pages are being opened in the user's browser (done / total pages).
          jobPatch({ phase: 'running', message: null, done: p && p.done, total: p && p.total, step: p && p.phase === 'detail' ? 'detail' : null });
        },
        onPause: (p) => {
          if (p && p.shot && challengeShots.length < 10) { challengeShots.push(p.shot); log(`travail ${spec.job_id} : capture du défi enregistrée`); }
          log(`travail ${spec.job_id} : en pause (défi à résoudre dans l'onglet)`);
          jobPatch({ phase: 'paused', message: (p && p.message) || CHALLENGE_TEXT });
        },
      });
    } finally {
      if (stopTimer) { clearTimer(stopTimer); stopTimer = null; }
      active = null;
    }
    const durationMs = Math.max(0, now() - t0);
    const laneError = (res.recipeDiag && res.recipeDiag.laneError) || null;
    const outcome = outcomeFor({ ...res, laneError });
    const products = res.products || [];
    log(`travail ${spec.job_id} : résultat ${res.status}, ${products.length} produit(s), ${(durationMs / 1000).toFixed(1)} s${res.reason ? ` — raison : ${String(res.reason).slice(0, 200)}` : ''}${laneError && laneError !== res.reason ? ` — recette : ${laneError.slice(0, 200)}` : ''}`);
    if (io.controller && typeof io.controller.ingestExternalProducts === 'function') {
      try {
        res.ingest = await io.controller.ingestExternalProducts({
          products, store: spec.store, productType: spec.productType,
          categorySlug: spec.categorySlug, lang: spec.lang, origin: spec.start_url || (spec.domain ? `https://${spec.domain}/` : null), method: 'your-browser',
          outcome, durationMs,
          // The product pages the extension opened in the user's browser for this job (op 'page', id = job id).
          renderedPages: takeRenderedPages(spec.job_id),
          details: {
            domain: spec.domain, recipeKind: spec.recipeKind || null, recipeSource: spec.recipeSource || null, recipeRevision: spec.recipeRevision ?? null,
            // names only (resolved / missing vars) + the lane's own error — never a value
            recipeDiag: res.recipeDiag || null,
            limits: spec.limits || null, pacing: spec.pacing || null, browser: state.browser,
            extensionStatus: res.status, extensionReason: res.reason || null, extensionErrors: Array.isArray(res.errors) ? res.errors.slice(0, 5).map((x) => String(x).slice(0, 240)) : null,
            counts: res.counts || null, durationMs, pageVerdicts: res.pageVerdicts || null, timings: res.timings || null,
            // How the page was read (recipe / json_ld / embedded-state / dom) and,
            // when 0 products, the evidence-based diagnosis of why.
            extraction: res.extraction || null,
            // Screenshots the extension took at each challenge pause (raw data URLs;
            // the controller writes them to the job folder and keeps only file refs).
            challengeShots: challengeShots.length ? challengeShots : null,
          },
        });
        if (res.ingest && res.ingest.jobId) log(`travail ${spec.job_id} : enregistré comme job ${res.ingest.jobId} (${res.ingest.status || outcome.status})`);
      } catch (e) { log(`enregistrement du job impossible (${e && e.code ? e.code : 'erreur'})`); }
    }
    try { if (io.recordRun) io.recordRun({ source: 'your_browser', label: 'Votre navigateur', domain: spec.domain, status: outcome.status, products: products.length, at: new Date().toISOString() }); } catch { /* best-effort */ }
    emitState({ job: { id: spec.job_id, domain: spec.domain, phase: res.status, message: outcome.text || null } });
    return { ...res, outcome };
  }

  /**
   * User-facing launch from the renderer. Validates everything app-side; returns
   * {ok:true, jobId, domain, limits} immediately (the run streams via events) or
   * {ok:false, code, message} with a French, non-technical message.
   */
  async function launch(input) {
    const jobId = newJobId();
    const cfg = readConfig();
    const pre = buildLaunch(input, { config: cfg, svc: svcView(!!active), hints: null, jobId });
    if (!pre.ok) { log(`lancement refusé (${pre.code})`); return pre; }
    active = { id: jobId, domain: pre.domain }; // reserve before any await (no double launch)
    let hints = null;
    try { hints = io.resolveRecipe ? await io.resolveRecipe(pre.spec.start_url) : null; } catch { hints = null; log('résolution de la recette impossible — extraction générique'); }
    const b = buildLaunch(input, { config: cfg, svc: svcView(false), hints, jobId });
    if (!b.ok) { active = null; log(`lancement refusé (${b.code})`); return b; }
    runJob(b.spec).catch((e) => {
      active = null;
      log(`travail « votre navigateur » en échec (${e && e.code ? e.code : 'erreur'})`);
      emitState({ job: { id: jobId, domain: b.domain, phase: 'error', message: outcomeFor({ status: 'error' }).text } });
    });
    return { ok: true, jobId, domain: b.domain, limits: b.spec.limits, recipeKind: b.spec.recipeKind };
  }

  const isActive = (job_id) => typeof job_id === 'string' && !!active && active.id === job_id && !!session;

  function pause(job_id) { if (!isActive(job_id)) return fail('unknown_job'); session.pause(job_id); jobPatch({ phase: 'paused' }); return { ok: true }; }
  function resume(job_id) { if (!isActive(job_id)) return fail('unknown_job'); session.resume(job_id); jobPatch({ phase: 'running', message: null }); return { ok: true }; }
  function stopJob(job_id) {
    if (!isActive(job_id)) return fail('unknown_job');
    session.stop(job_id);
    jobPatch({ phase: 'stopping' });
    // If the extension never confirms, settle locally so the UI can't hang.
    if (!stopTimer) stopTimer = setTimer(() => { stopTimer = null; if (session && session.has(job_id)) session.settle(job_id, { status: P.JOB_STATUS.STOPPED, reason: 'stopped' }); }, stopGraceMs);
    return { ok: true };
  }

  function stop() { try { if (bridge) bridge.stop(); } catch { /* ignore */ } if (session) session.failAll('extension_disconnected'); bridge = null; session = null; emitState({ bridge: 'stopped', extension: 'disconnected', browser: null, modes: [] }); }

  return {
    start, stop, runJob, launch, availability, pause, resume, stopJob,
    status: () => ({ ...state, activeJob: active ? { ...active } : null }),
    isEnabled: () => enabled,
    get _session() { return session; },
    get _bridge() { return bridge; },
  };
}
