/**
 * GUI controller — the app-side orchestrator that drives the generic core for
 * one run at a time. Pure and headless-testable: it takes an `emit(type,payload)`
 * callback and returns plain data. Electron's main process adapts `emit` to
 * webContents.send and settles interventions via the active provider.
 *
 * Mirrors the CLI's executeJob flow (discovery → runScrape → CSV/reports) but:
 *   • streams progress/counters/products/intervention/done via `emit`
 *   • supports pause / resume / stop (engine config.control)
 *   • routes challenges to a ChallengeProvider (manual by default) — no bypass
 *   • writes ALL user data under the OS app-data dir (never the repo/bundle)
 *   • uses the GENERIC eligibility layer (no Luna business rules)
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, outputRoot, DEFAULTS as ENGINE_DEFAULTS } from '../core/config.mjs';
import { createJob, Job, listJobs } from '../core/jobstore.mjs';
import { Fetcher } from '../core/http-fetcher.mjs';
import { discoverProducts } from '../core/discover.mjs';
import { runScrape, formatReport, attachDiagnostics, applyPartialStatus } from '../core/engine.mjs';
import { fillRates } from '../core/fill-rate.mjs';
import { jobManifest, writeJobManifest } from '../core/job-manifest.mjs';
import { applyConstantsToProduct, constantColumns } from '../shared/export/constants.mjs';
import { batchKeyOf, batchLabelOf, storedConstantsFor, indexBatch, productKeyOf } from '../shared/export/site-values.mjs';
import { collectionVerdict, audienceVerdict } from '../shared/extract/collection-check.mjs';
import { BrowserSession, browserAvailable as defaultBrowserAvailable } from '../core/browser.mjs';
import { toImportCsv } from '../core/csv.mjs';
import { probeSource, formatProbe } from '../core/probe.mjs';
import { unlockAvailable, resolveChrome, unlockRender } from '../core/unlock.mjs';
import { extractProduct } from '../core/extract.mjs';
import { extractListing } from '../core/listing.mjs';
import { extractEmbeddedProducts, extractProductsFromJson } from '../core/embedded-state.mjs';
import { paginateListing, findJsonPagination } from '../core/listing-pagination.mjs';
import { discoverApiHeaders as discoverApiHeadersInJs, discoverySummary } from '../core/api-header-discovery.mjs';
import { resolveHeaders as resolveRecipeHeaders } from '../shared/internal-api.mjs';
import { listingTrailFromHtml, applyTrailToNormalized, applyTrailToRaw } from '../core/listing-context.mjs';
import { completeSideData, fetcherJson } from '../core/side-requests.mjs';
import { browserPageReader } from '../core/browser-pages.mjs';
import { toNormalizedProduct } from '../core/normalize.mjs';
import { evaluateEligibility } from '../core/eligibility/index.mjs';
import { detectContentType } from '../shared/content/detect.mjs';
import { normalizeContentType } from '../shared/content/profiles.mjs';
import { runRecipeLane, estimateRecipeCost, defaultHttpGet, unconsumedFacets } from '../core/internal-api.mjs';
import { deriveSelectorRecipe, applySelectorRecipe, replaySelectorLane, replaySelectorLaneGeneric, selectorRowsHealth } from '../core/recipe-producer.mjs';
import { enrichFromDetailPages, detailVisitCap, detailUnreadVerdict } from '../core/detail-enrich.mjs';
import { createKnowledgeService } from './knowledge-service.mjs';
import { resolveAiCredentials, isAiConfigured } from '../core/providers/ai.mjs';
import { createAnthropicAsker } from './ai/provider.mjs';
import { createAgentService, AGENT_DEFAULT_MODEL } from './ai/agent.mjs';
import { exportRecipes, planImport, applyImport } from '../core/recipes-file.mjs';
import { missingFields } from '../core/site-knowledge.mjs';
import { newlyFailing } from '../shared/knowledge/rules.mjs';
import { detailAccessOf, createAccessTracker, listAccessOf } from '../core/domain-profile.mjs';
import { dedupKey, absoluteUrl } from '../core/url-utils.mjs';
import { PRODUCT_RE, scopeProductLinks } from '../core/discover.mjs';
import { learnFromClick as learnRecipesFromClick, recognizedCount } from '../core/link-learn.mjs';
import { createProfileStore, urlShapeOf } from '../core/domain-profile.mjs';
import { classifyResponse } from '../core/detect.mjs';
import { detectPlatform } from '../core/platform.mjs';
import { platformDefaultLane, PLATFORMS_WITH_DEFAULT } from '../core/platform-strategy.mjs';
import { bundledInternalApiFor } from '../core/bundled-recipes.mjs';
import { measureRunQuality, judgeRunQuality } from '../core/run-quality.mjs';
import { webUnlockerConfig, webUnlockerFetch } from '../core/unlock/web-unlocker.mjs';
import { firecrawlConfig, firecrawlScrape, firecrawlMaxAge } from '../core/unlock/firecrawl.mjs';
import { profileFileIo } from '../core/profile-file.mjs';
import { safeRegExp, boundedMatch } from '../shared/safe-regex.mjs';
import { scrapingBrowserConfig, scrapingBrowserRender, scrapingBrowserBootstrap } from '../core/unlock/scraping-browser.mjs';
import { buildProviderCfg } from '../core/providers/gate.mjs';
import { isConfigured as providerConfigured } from '../core/providers/registry.mjs';
import { PAID_ROUTES, hostKey, isOptedIn, routeDecision } from '../core/providers/optin.mjs';
import { createMeter } from '../core/metering/meter.mjs';
import { nullLedger } from '../core/metering/ledger.mjs';
import { extractSpaProducts, extractMarkdownProducts } from '../core/spa-state.mjs';
import { createProviderRegistry } from './providers/index.mjs';
import { createEdgeClient, describeUnlock, describeEstimate } from '../core/edge-client.mjs';
import { rateFromAccount } from '../core/credit-rate.mjs';
import { classifyItem, mergeRules, tallyVerdict } from '../shared/classify/page-kind.mjs';

// Eloshon server (Convert | Scrap Apps). The anon key is a PUBLISHABLE key —
// safe in the distributed client (RLS-gated; provider secrets stay server-side).
// The per-client licence is entered in Settings (saved config: edgeLicense).
const EDGE_BASE = 'https://ilaakzwnfgzkinyygevv.supabase.co';
const EDGE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlsYWFrenduZmd6a2lueXlnZXZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3NDM2ODEsImV4cCI6MjEwNTMxOTY4MX0.xg7lrPYIyK2i7L6Kn8rEMQo921aCwkzfLn9j4jnWqhs';

const intOr = (v, d) => (v != null && v !== '' && !Number.isNaN(+v) ? +v : d);

// Turn rendered/unlocked HTML into raw product records — the SAME generic path
// for the nodriver path and the server cascade: fiche + listing cards + same-host
// product anchors (PRODUCT_RE or id-slug ".html"). Pure, no side effects.
function rawsFromHtml(html, url) {
  const raws = [];
  const { product } = extractProduct(html, url);
  if (product && product.name) raws.push(product);
  for (const card of extractListing(html, url).cards) raws.push(card);
  // A1 "état intégré": products hydrated from an embedded JSON blob (SPA grids
  // whose cards are NOT JSON-LD, e.g. Levi's) — one list page → all its products
  // with name/price/sku, so fiches need not be unlocked one by one.
  const have0 = new Set(raws.map((x) => x.sourceUrl || x.canonicalUrl).filter(Boolean));
  for (const card of extractEmbeddedProducts(html, url).cards) {
    if (card.sourceUrl && have0.has(card.sourceUrl)) continue;
    if (card.sourceUrl) have0.add(card.sourceUrl);
    raws.push(card);
  }
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const have = new Set(raws.map((x) => x.sourceUrl || x.canonicalUrl).filter(Boolean));
    const linkRe = /<a\b[^>]*href=["']([^"'#\s]+)["']/gi; let mm;
    while ((mm = linkRe.exec(html))) {
      const abs = absoluteUrl(mm[1], url); if (!abs) continue;
      let p = ''; try { const u = new URL(abs); if (u.hostname.replace(/^www\./, '') !== host) continue; p = u.pathname; } catch { continue; }
      if (!(PRODUCT_RE.test(abs) || /\/\d+-[a-z0-9-]+\.html$/i.test(p))) continue;
      const clean = abs.split('#')[0];
      if (have.has(clean)) continue; have.add(clean);
      raws.push({ sourceUrl: clean, canonicalUrl: clean, strategy: 'unlock-link' });
    }
  } catch { /* harvest is best-effort */ }
  return raws;
}

// Engine config keys that Settings (defaults) and New-Scraping (per-run override)
// can both set. Kept in sync with core/config.mjs DEFAULTS names.
const CFG_KEYS = ['timeoutMs', 'retries', 'rateLimitMs', 'workers', 'maxProducts', 'maxPages', 'maxDepth', 'maxBrowser'];
// A value is "provided" only if it is a finite number (0 is honored, not falsy);
// null/undefined/''/NaN → not provided, so a lower-priority source (or the core
// DEFAULTS) is used instead.
const num = (v) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };

// Every documented engine setting (core/config.mjs DEFAULTS) is forwarded from the
// app's config.json — the list is DERIVED, never hand-written (a hand-written subset
// silently dropped quality, weightEstimate, renderTimeoutMs, breaker…). `browser`
// comes from the launch form, `outputDir` from the app's data folder.
export const ENGINE_CONFIG_KEYS = Object.freeze(Object.keys(ENGINE_DEFAULTS).filter((k) => k !== 'outputDir' && k !== 'browser'));
const isPlainObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
/** A saved value of the default's kind, else undefined (the default stays). */
function sameKind(def, v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof def === 'number' || def === null) return num(v); // null default = a number, or "derived
  if (typeof def === 'boolean') return typeof v === 'boolean' ? v : undefined;
  if (isPlainObj(def)) return isPlainObj(v) ? v : undefined;
  return typeof v === typeof def ? v : undefined;
}

/**
 * Effective engine overrides for one run. Priority per field:
 *   New-Scraping value (limits, for the form's numeric fields) → saved config.json → core DEFAULTS.
 * Returns only defined fields; objects are deep-merged onto the defaults by loadConfig.
 * @param {object} saved  persisted Settings (userData/config.json)
 * @param {object} limits per-run values from the New-Scraping form
 */
export function jobConfigOverrides(saved = {}, limits = {}) {
  const out = {};
  for (const k of ENGINE_CONFIG_KEYS) {
    const def = ENGINE_DEFAULTS[k];
    const over = CFG_KEYS.includes(k) ? sameKind(def, limits[k]) : undefined;
    const val = over !== undefined ? over : sameKind(def, (saved || {})[k]);
    if (val !== undefined) out[k] = val;
  }
  return out;
}
const engineConfigOf = (cfg) => Object.fromEntries(ENGINE_CONFIG_KEYS.map((k) => [k, cfg[k]]));
const pickCfg = (cfg) => Object.fromEntries(CFG_KEYS.map((k) => [k, cfg[k]]));

/**
 * The local browser's "a human solves it" handler. Only in intervention mode (a
 * visible browser the user asked for): a headless run must never wait for a human
 * who cannot see the page. The wait ends with the job's signal (as 'skip'), so a
 * stop or the watchdog always releases it.
 */
export function interventionHandler({ provider, emit, interactive, signal } = {}) {
  if (!interactive || !provider || typeof provider.resolve !== 'function') return undefined;
  return ({ url, code, reason }) => {
    if (signal && signal.aborted) return Promise.resolve('skip');
    const wait = Promise.resolve(provider.resolve({ url, code, reason }, { emit }));
    if (!signal) return wait;
    return new Promise((resolve) => {
      const onAbort = () => { try { if (provider.skip) provider.skip(); } catch { /* ignore */ } resolve('skip'); };
      signal.addEventListener('abort', onAbort, { once: true });
      wait.then((d) => { signal.removeEventListener('abort', onAbort); resolve(d); }, () => { signal.removeEventListener('abort', onAbort); resolve('skip'); });
    });
  };
}

function makeControl(emit) {
  let paused = false, stopped = false, stopReason = null, stoppedAt = null; const waiters = [];
  // The job's own signal: aborting it ends every external wait that honours it
  // (HTTP, recipe HTTP, the local browser is closed). Used by the watchdog.
  const abortCtl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  return {
    get paused() { return paused; },
    get stopped() { return stopped; },
    /** 'user' (the Stop button) | 'stalled' (the watchdog) | null */
    get stopReason() { return stopReason; },
    get stoppedAt() { return stoppedAt; },
    get signal() { return abortCtl ? abortCtl.signal : null; },
    pause() { paused = true; emit?.('state', { running: true, paused: true }); },
    resume() { paused = false; waiters.splice(0).forEach((f) => f()); emit?.('state', { running: true, paused: false }); },
    stop(reason = 'user') { if (!stopped) { stopReason = reason; stoppedAt = Date.now(); } stopped = true; paused = false; waiters.splice(0).forEach((f) => f()); emit?.('state', { running: true, stopping: true }); },
    /** Abort every wait of the job now (watchdog). */
    abort() { try { if (abortCtl && !abortCtl.signal.aborted) abortCtl.abort(); } catch { /* ignore */ } },
    waitIfPaused() { return paused ? new Promise((r) => waiters.push(r)) : Promise.resolve(); },
  };
}

function counters(job) {
  let accepted = 0, toVerify = 0, excluded = 0;
  for (const p of job.products) {
    const s = p.__eligibility?.status;
    if (s === 'accepted') accepted++; else if (s === 'excluded') excluded++; else toVerify++;
  }
  return { detected: job.products.length, accepted, toVerify, excluded };
}

/**
 * Persist challenge screenshots (data URLs the extension captured at each pause)
 * as image files in the job folder. Returns lightweight refs {file, url, at} for
 * the report — never the raw base64. Best-effort and bounded (max 10).
 */
function saveChallengeShots(job, shots) {
  if (!Array.isArray(shots) || !shots.length) return [];
  const saved = [];
  for (let i = 0; i < shots.length && i < 10; i++) {
    const s = shots[i];
    const m = s && typeof s.dataUrl === 'string' && s.dataUrl.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) continue;
    const ext = m[1] === 'jpeg' ? 'jpg' : 'png';
    const file = `challenge-${String(i + 1).padStart(2, '0')}.${ext}`;
    try {
      fs.writeFileSync(path.join(job.paths.dir, file), Buffer.from(m[2], 'base64'));
      saved.push({ file, url: (s && s.url) || null, at: (s && s.at) || null });
    } catch { /* best-effort: a missing shot never fails the job */ }
  }
  return saved;
}

// Sanitise a reason string for the USER surfaces (done event, job history): strip
// raw HTTP codes, provider names and technical modes (point 3). The full technical
// reason stays in report.json / job.error for the local journal + server logs.
const BLOCK_LABEL = { ACCESS_DENIED: 'accès refusé (site protégé)', BOT_CHALLENGE: 'protection anti-robot', RATE_LIMITED: 'trop de requêtes (site protégé)', JAVASCRIPT_REQUIRED: 'page rendue côté navigateur', NETWORK_ERROR: 'site injoignable', UNREACHABLE: 'site injoignable' };
export function sanitizeReason(s) {
  let x = String(s || '');
  if (!x) return '';
  x = x.replace(/\bHTTP\s+\d{3}\b[^,;()]*/gi, '').replace(/\b\d{3}\s+(Forbidden|Not Found|Method Not Allowed|Service Unavailable|Too Many Requests)\b/gi, '');
  x = x.replace(/\b(firecrawl|scrapfly|bright\s*data|brightdata)\b/gi, '');
  x = x.replace(/\(?\b(asp|datacenter|residential|stealth|unlocker)\b\)?/gi, '');
  x = x.replace(/\b(après|apres|after)\s+\d+\s+(tentatives?|attempts?|essais?)/gi, '').replace(/\b\d+\s+(tentatives?|attempts?)\b/gi, '');
  x = x.replace(/[,;]\s*(?=[,;]|$)/g, '').replace(/\s{2,}/g, ' ').replace(/\s*[:•·,;]\s*$/, '').replace(/^[\s:·,;-]+/, '').trim();
  return x;
}
// A concise, human reason for a finished job, from its saved report (or error).
// Order: an explicit block → a discovery block → a non-ok discovery diagnosis →
// a captured error. Empty when the job simply succeeded. User-safe (sanitised).
function jobReason(report, error) {
  const r = report || {};
  const d = r.discovery || {};
  // The pasted listing was blocked and the sitemap held nothing in its scope.
  if (d.listingBlocked) return sanitizeReason(`liste bloquée : ${BLOCK_LABEL[d.listingBlocked.code] || d.listingBlocked.code || 'site protégé'}`);
  if (r.blocked) return sanitizeReason(BLOCK_LABEL[r.blocked.code] || r.blocked.code || 'site protégé');
  if (d.stopped) return sanitizeReason(BLOCK_LABEL[d.stopped.code] || d.stopped.code || 'site protégé');
  if (d.diagnosis && d.diagnosis !== 'ok') return sanitizeReason(d.diagnosisReason ? `${d.diagnosis}: ${d.diagnosisReason}` : d.diagnosis);
  return sanitizeReason(error || '');
}

// ── usage metering helpers (ledger lines; admin-only data, never shown to users) ──

/** Admin test mode for ONE launch: { firecrawl, webUnlocker, scrapingBrowser } booleans, or null. */
export function sanitizeTestMode(tm) {
  if (!tm || typeof tm !== 'object') return null;
  const out = Object.fromEntries(PAID_ROUTES.map((r) => [r.key, tm[r.key] === true]));
  return Object.values(out).some(Boolean) ? out : null;
}

/** Ledger outcome of a direct paid call result ({ok,status,error,note}). */
function paidOutcome(res) {
  if (res && res.ok) return 'success';
  const txt = `${(res && res.error) || ''} ${(res && res.note) || ''}`;
  if ((res && res.status === 402) || /insufficient credits|quota|payment required|credit balance/i.test(txt)) return 'quota_exhausted';
  if (/abort|timed? ?out|timeout/i.test(txt)) return 'timeout';
  return 'failed';
}
/** A short reason class for a failed direct call — status / note, never a raw body. */
function paidReason(res) {
  if (!res || res.ok) return null;
  if (res.note && res.note !== 'http_error') return res.note;
  if (res.status) return `http_${res.status}`;
  return String(res.error || 'error').replace(/\s+/g, ' ').slice(0, 80);
}

// Server cascade upstream names → ledger providers (the server's "brightdata" is
// the Bright Data Web Unlocker API, called with the SERVER's key).
const CASCADE_UPSTREAM = { firecrawl: 'firecrawl', scrapfly: 'scrapfly', brightdata: 'webunlocker' };

/** One cascade call → one 'cascade' line (credits) + one line per upstream attempt. */
function recordCascadeCall(jm, res, ms, page) {
  const ok = !!(res && res.ok && res.html !== undefined);
  const reason = ok ? null : String((res && (res.reason || res.error)) || 'unknown').slice(0, 80);
  const outcome = ok ? 'success' : reason === 'quota_exceeded' ? 'quota_exhausted' : reason === 'not_configured' ? 'skipped' : 'failed';
  jm.record({
    provider: 'cascade', route: page > 1 ? 'unlock-page' : 'unlock', channel: 'server',
    attempted: reason !== 'not_configured', outcome, reason,
    credits: ok ? (Number(res.eloshon_credits) || 0) : 0,
    units: ok && res.provider_units != null ? res.provider_units : null,
    upstream: ok && res.provider ? `${res.provider}:${res.mode || ''}` : null,
    bytes: ok ? (Number(res.htmlBytes) || (typeof res.html === 'string' ? Buffer.byteLength(res.html) : null)) : null,
    durationMs: ms,
  });
  for (const a of (res && Array.isArray(res.attempts) ? res.attempts : [])) {
    jm.record({
      provider: CASCADE_UPSTREAM[a.provider] || 'inconnu', route: 'cascade', channel: 'server', attempted: true,
      outcome: a.ok ? 'success' : (a.error === 'provider_timeout' ? 'timeout' : 'failed'),
      // status class only — the server echoes provider error bodies, never stored
      reason: a.ok ? null : (a.error === 'provider_timeout' ? 'provider_timeout' : (a.status ? `http_${a.status}` : 'error')),
      upstream: a.mode ? `${a.provider}:${a.mode}` : (a.provider || null),
      units: a.ok && res && res.provider_units != null ? res.provider_units : null,
      durationMs: a.ms,
    });
  }
}

/**
 * The app's own steps (ms): product pages (re-reads in the app's browser happen inside them and are shown
 * apart, not added twice), stock & reviews, export; the list is what is left of the total.
 */
export function appTimings(stepMs, browserPages, totalMs) {
  const s = stepMs || {};
  const rereads = browserPages && browserPages.stats ? Number(browserPages.stats.ms) || 0 : 0;
  const known = (s.productPagesMs || 0) + (s.sideDataMs || 0) + (s.exportMs || 0);
  return { listMs: Math.max(0, (Number(totalMs) || 0) - known), productPagesMs: s.productPagesMs || 0, browserRereadsMs: rereads, sideDataMs: s.sideDataMs || 0, exportMs: s.exportMs || 0 };
}

/**
 * A finished job's fill rate per field, step timings and export manifest (written beside products.json and
 * the CSV, docs/EXPORT-MANIFEST.md). Never breaks a job: a manifest that cannot be written is said in the report.
 */
export function finishJobReport(job, report, origin, { app = null, extension = null, totalMs = null, source = 'app' } = {}) {
  try { report.fill = fillRates(job.products); } catch { /* the report stands without it */ }
  report.timings = { totalMs: totalMs != null ? totalMs : (report.durationMs ?? null), ...(extension ? { extension } : {}), ...(app ? { app } : {}) };
  try {
    const m = jobManifest({ report, products: job.products, jobId: job.id, origin, source });
    report.manifest = { status: m.status, files: writeJobManifest(job.paths, m).map((f) => path.basename(f)) };
  } catch (e) { report.manifest = { status: null, error: String((e && e.message) || e).slice(0, 160) }; }
}

export function createController({ dirs, emit = () => {}, edgeClientFor: injectedEdgeClientFor, providerRuntime = null, secureStore = null, persistProviders = null, meter = null, makeFetcher = (o) => new Fetcher(o), browserAvailable = defaultBrowserAvailable } = {}) {
  const registry = createProviderRegistry();
  // Usage metering: the ONE recorder for every route. Without an injected meter
  // (tests, CLI diagnostics) it still feeds the provider caps exactly like before,
  // it just writes no ledger line.
  const M = meter || createMeter({ ledger: nullLedger(), runtime: providerRuntime, persist: persistProviders });
  let active = null; // { control, provider, jobId }
  let teachSession = null; // { session, abort } while a click-to-learn capture is open

  // Edge-function client (server cascade). Baked URL + publishable anon key; the
  // per-client licence comes from saved Settings. Rebuilt per call so a licence
  // change in Settings takes effect without a restart. Injectable for tests.
  const edgeClientFor = injectedEdgeClientFor || ((saved) => createEdgeClient({ baseUrl: EDGE_BASE, anonKey: EDGE_ANON, license: (saved && (saved.edgeLicense || saved.license)) || '' }));

  // 2b SYNC — pull the authoritative SHARED recipe into the local profile when we
  // don't already hold an internal_api one. internal_api is the top-priority lane
  // and must NEVER be suppressed by a locally-taught manual_selectors/link_filter:
  // once a domain that has an internal_api recipe is taught, the weaker DOM lane
  // would otherwise win (the recipe-priority regression). So the sync is gated ONLY
  // on the absence of a local internal_api — a taught DOM recipe no longer blocks
  // it. Best-effort, never throws, never blocks a run; a locally-taught
  // manual_selectors is never overwritten by a shared one.
  // Returns where the internal_api recipe comes from: 'local' | 'shared' | 'bundled' | null.
  async function syncSharedRecipe(originUrl) {
    try {
      if (!originUrl) return null;
      if (profiles.hints(originUrl).internalApi) return 'local';
      const client = edgeClientFor(readJson(dirs.configFile));
      const host = new URL(originUrl).hostname.replace(/^www\./, '');
      if (client.isConfigured()) {
        const p = await client.profile(host);
        const rec = p && p.ok && p.recipe;
        if (rec && rec.internal_api) { profiles.record(originUrl, { internalApi: rec.internal_api }); return 'shared'; }
        if (rec && rec.manual_selectors && !profiles.hints(originUrl).manualSelectors) profiles.record(originUrl, { manualSelectors: rec.manual_selectors });
      }
      // Local fallback: a site with a BUNDLED recipe (Lidl, Colruyt) must not
      // collapse to the browser lane just because the shared sync is unavailable
      // (offline / no licence). Shared always wins above; this only fills the gap.
      if (!profiles.hints(originUrl).internalApi) {
        const bundled = bundledInternalApiFor(host);
        if (bundled) { profiles.record(originUrl, { internalApi: bundled }); return 'bundled'; }
      }
    } catch { /* best-effort — the free ladder / probe still runs */ }
    return null;
  }

  // Taux €/crédit du palier actif, mémorisé pour la durée du process : le
  // palier ne change pas en cours de session, et une panne réseau ne doit
  // jamais retarder un message d'UI. null = pas d'équivalent monétaire.
  let _rate;
  async function currentRate() {
    if (_rate !== undefined) return _rate;
    try {
      const client = edgeClientFor(readJson(dirs.configFile));
      _rate = client.isConfigured() ? rateFromAccount(await client.accountStatus()) : null;
    } catch { _rate = null; }
    return _rate;
  }

  // Per-domain memory (AppData JSON). Read at job start for HINTS only; updated
  // after a run. Never a rigid rule — see core/domain-profile.mjs.
  const profilesPath = dirs.domainProfilesFile || path.join(dirs.data, 'domain-profiles.json');
  // Atomic writes with a previous copy; a corrupt file is set aside, never
  // overwritten; an unreadable one makes the run read-only (core/profile-file.mjs).
  // A schema migration first copies the file aside (profile-file snapshot).
  const profiles = createProfileStore(profileFileIo(profilesPath));
  // Site knowledge (rules taught with 🎯 or proposed by the detection): taught, checked on other
  // product pages and listed through the same profile store. Pages are fetched politely over plain HTTP.
  const knowledge = createKnowledgeService({
    profiles,
    // AI once per site (admin's Claude key, from the same encrypted store); null when no key is set.
    aiAsker: (pageUrl) => {
      try {
        const io = { secure: secureStore && typeof secureStore.getAll === 'function' ? secureStore.getAll() : {}, config: readJson(dirs.configFile) || {}, env: process.env };
        if (!isAiConfigured(io)) return null;
        const { apiKey, model } = resolveAiCredentials(io);
        const onCall = (info) => { try { if (meter) meter.record({ provider: 'anthropic', route: 'ai-locate', channel: 'direct', url: pageUrl, domain: pageUrl ? hostKey(pageUrl) : null, attempted: true, outcome: info.ok ? 'success' : 'failed', reason: info.ok ? null : info.reason, model: info.model, tokensIn: info.tokensIn, tokensOut: info.tokensOut, durationMs: info.durationMs }); } catch { /* ledger is best-effort */ } };
        return createAnthropicAsker({ apiKey, model, maxTokens: 800, onCall });
      } catch { return null; }
    },
    fetchHtml: (() => {
      let f = null;
      return async (u) => {
        if (!f) { const cfg = loadConfig({ outputDir: dirs.data, ...jobConfigOverrides(readJson(dirs.configFile), {}) }); f = makeFetcher({ timeoutMs: Math.min(Number(cfg.timeoutMs) || 20000, 8000), retries: 0, minDelayMs: cfg.rateLimitMs }); }
        const r = await f.get(u);
        return { ok: !!(r && r.ok && r.body), html: r && r.body, status: r && r.status };
      };
    })(),
  });
  const pendingImports = new Map(); // previewId → import plan (recipes.json), applied on confirmation
  // The side panel's chat agent: the app's Claude key and the agent's model (config.json ai.agentModel), each
  // model request in the usage ledger (route agent-chat). Its tools run on the page the extension sent.
  const agent = createAgentService({
    knowledge,
    credentials: () => {
      try {
        const io = { secure: secureStore && typeof secureStore.getAll === 'function' ? secureStore.getAll() : {}, config: readJson(dirs.configFile) || {}, env: process.env };
        if (!isAiConfigured(io)) return null;
        const { apiKey } = resolveAiCredentials(io);
        return { apiKey, model: (io.config.ai && typeof io.config.ai.agentModel === 'string' && io.config.ai.agentModel) || AGENT_DEFAULT_MODEL };
      } catch { return null; }
    },
    onCall: (info) => { try { if (meter) meter.record({ provider: 'anthropic', route: 'agent-chat', channel: 'direct', attempted: true, outcome: info.ok ? 'success' : 'failed', reason: info.ok ? null : info.reason, model: info.model, tokensIn: info.tokensIn, tokensOut: info.tokensOut, durationMs: info.durationMs }); } catch { /* ledger is best-effort */ } },
  });
  // Taught blocks the product pages did not show because they open only in a browser: what to do about it.
  const needsBrowserNote = (rep) => {
    const nb = rep && rep.knowledge && rep.knowledge.needsBrowser; const fields = nb ? Object.keys(nb) : [];
    return fields.length ? `Champ(s) ${fields.join(', ')} : le bloc appris ne s’affiche qu’une fois ouvert dans un navigateur, et ces fiches ont été lues sans l’ouvrir. Utilisez le mode « Votre navigateur » pour les compléter.` : null;
  };
  // The pages a run read with the taught rules → their track record (never throws). Returns the rules this
  // run made fail (live before, failing / deprecated after): they get a repair right after the run.
  // The rules a run made fail, for the report ("rules invalidated": field, rule id, why).
  const invalidatedOf = (failed) => (Array.isArray(failed) && failed.length ? failed.map((r) => ({ field: r.field, ruleId: r.id, reason: 'en échec sur les fiches lues par cette exécution' })) : null);
  const recordKnowledgeOutcomes = (originUrl, rep) => {
    try {
      if (!originUrl || !rep || !rep.knowledge || !Object.keys(rep.knowledge.rules).length) return [];
      const before = knowledge.forEngine(originUrl);
      profiles.record(originUrl, { knowledgeOutcomes: rep.knowledge.rules });
      return newlyFailing(before, knowledge.forEngine(originUrl));
    } catch { return []; }
  };
  // Self-healing after a run: each rule the run made fail gets a checked replacement (proposed for a manual
  // rule, applied for an AI one), on the product pages this run read. Never throws; reports what happened.
  const repairAfterRun = async (originUrl, failed, pages, fetchPage) => {
    if (!failed || !failed.length) return null;
    let r = null; try { r = await knowledge.repair(originUrl, { failed, pages, ...(fetchPage ? { fetchPage } : {}) }); } catch (e) { r = { ok: false, reason: String((e && e.message) || e).slice(0, 160), proposed: [], applied: [], unrepaired: failed.map((f) => f.field), aiCalls: 0 }; }
    return { failing: failed.map((f) => f.field), ...r };
  };
  const repairNotes = (rr) => {
    if (!rr) return [];
    const n = [];
    if (rr.applied && rr.applied.length) n.push(`Règle(s) réparée(s) automatiquement : ${rr.applied.map((a) => `${a.field} (vérifiée sur ${a.tests.ok}/${a.tests.total} fiches)`).join(', ')}. Vous pouvez annuler dans l’onglet « Fiche produit » de l’extension.`);
    if (rr.proposed && rr.proposed.length) n.push(`Champ(s) ${rr.proposed.map((a) => a.field).join(', ')} : votre règle échoue sur les dernières fiches. Une réparation vérifiée est proposée dans l’onglet « Fiche produit » : acceptez-la ou refusez-la.`);
    if (rr.unrepaired && rr.unrepaired.length) n.push(`Champ(s) ${rr.unrepaired.join(', ')} : la règle échoue et aucune réparation fiable n’a été trouvée${rr.reason ? ` (${rr.reason})` : ''}. Refaites 🎯 sur ce champ dans une fiche du site.`);
    return n;
  };
  // First discovery of a site no one taught: its rules are built from the product pages the run read (declared
  // data → detection → one AI call for what is still missing), checked on several pages, saved. Once per site.
  // rows: the run's products (raw or normalised), so a value the LIST gave is also located on the product page.
  const rowsByUrl = (list) => { const m = new Map(); for (const r of list || []) { if (!r) continue; const u = String(r.sourceUrl || r.source_url || r.canonicalUrl || r.url || '').split('#')[0]; if (!u || m.has(u)) continue; m.set(u, { name: r.name || null, price: r.price ?? null, currency: r.currency || null, images: Array.isArray(r.images) && r.images.length ? r.images : (r.image_url ? [r.image_url] : null), brand: r.brand || (r.raw && r.raw.brand) || null, sku: r.sku || null, gtin: r.gtin || r.barcode || null }); } return m; };
  const onboardAfterRun = async (originUrl, pages, rows = null) => {
    if (!originUrl) return null;
    try { if (knowledge.isOnboarded(originUrl)) return null; } catch { return null; }
    // Only the pages the run already read: a first discovery never asks the site for more pages.
    try { return await knowledge.onboard(originUrl, { pages, sampleUrls: [], fetchPage: async () => ({ ok: false }), rows: rowsByUrl(rows) }); }
    catch (e) { return { ok: false, reason: String((e && e.message) || e).slice(0, 160), fields: {}, missing: [], aiCalls: 0 }; }
  };
  const FIELD_FR = { name: 'nom', price: 'prix', list_price: 'prix barré', brand: 'marque', category: 'catégorie', description: 'description', variants: 'variantes', image: 'images', availability: 'disponibilité', sku: 'référence', ean: 'EAN', technical_specs: 'caractéristiques' };
  const onboardingNotes = (o) => {
    if (!o) return [];
    if (!o.ok) return [`Apprentissage automatique de ce site impossible pour l’instant (${o.reason}). Lancez le scraping avec le mode « Votre navigateur » pour que l’application lise ses fiches produit, ou désignez les champs avec 🎯 dans l’onglet « Fiche produit ».`];
    const found = Object.entries(o.fields).filter(([, f]) => f.found && f.via !== 'taught').map(([k]) => FIELD_FR[k] || k);
    const n = [`Site appris automatiquement sur ${found.length} champ(s)${found.length ? ` : ${found.join(', ')}` : ''}${o.aiCalls ? ` (${o.aiCalls} appel(s) à l’IA)` : ' (sans IA)'}. Les prochains scrapings utilisent ces règles sans IA.`];
    if (o.missing.length) n.push(`Champ(s) non trouvé(s) : ${o.missing.map((k) => FIELD_FR[k] || k).join(', ')} — absent(s) des fiches lues, ou à désigner avec 🎯 dans l’onglet « Fiche produit » de l’extension.`);
    return n;
  };
  // Every product page a run read, kept (bounded) so a repair is checked on the very pages that failed.
  const pageMemo = (max = 8) => { const m = new Map(); return { m, keep(u, r) { if (r && r.ok && r.html && !m.has(u)) { m.set(String(u).split('#')[0], String(r.html)); while (m.size > max) m.delete(m.keys().next().value); } return r; } }; };
  // Record what a finished run learned about a domain (write-only; never throws).
  const recordProfile = (originUrl, report, job, extra = {}) => {
    try {
      if (!originUrl) return;
      const d = (report && report.discovery) || {};
      const byStrat = (report && report.byStrategy) || {};
      const topStrat = Object.keys(byStrat).sort((a, b) => byStrat[b] - byStrat[a])[0] || null;
      const sampleUrl = (job.products[0] && job.products[0].source_url) || (job.discovered && job.discovered[0]) || null;
      const browserUsed = (d.browserPagesRendered > 0) || (report && report.browserUsed > 0);
      profiles.record(originUrl, {
        listAccess: extra.listAccess,
        method: d.method || (report && report.method) || undefined,
        diagnosis: d.diagnosis,
        browser: extra.browser || (browserUsed ? 'playwright' : 'none'),
        blockedBy: (report && report.blocked && report.blocked.code) || (d.stopped && d.stopped.code) || extra.blockedBy || undefined,
        needsBrowser: extra.needsBrowser ?? (browserUsed || undefined),
        needsUnlock: extra.needsUnlock,
        urlShape: sampleUrl ? urlShapeOf(sampleUrl) : undefined,
        extractorStrategy: extra.extractorStrategy || topStrat || undefined,
        sampleUrl,
        sitemaps: (d.robotsSitemaps && d.robotsSitemaps.length ? d.robotsSitemaps : undefined),
        productCount: job.products.length,
        ms: report && report.durationMs,
      });
    } catch { /* profile write is best-effort, never breaks a run */ }
  };

  // On a failed run, persist a terminal 'error' status (so the job never stays
  // stuck on 'running') and release the active slot.
  const failJob = (job, err) => {
    const message = String((err && err.message) || err);
    try { job.setStatus('error', { error: message }); } catch { /* ignore */ }
    active = null;
    emit('done', { jobId: job.id, status: 'error', error: message, stoppedByUser: false });
  };

  async function execute(job, cfg, meta, { fetcher: injectedFetcher, useBrowser, recipeHttpGet, scrapingBrowserConnect, browserSession = null } = {}) {
    const control = makeControl(emit);
    // The job's signal reaches the HTTP client: the watchdog can end a wait in flight;
    // once a stop is asked, no Retry-After wait is started.
    const fetcher = injectedFetcher || new Fetcher({ timeoutMs: cfg.timeoutMs, retries: cfg.retries, minDelayMs: cfg.rateLimitMs, userAgent: meta.userAgent, signal: control.signal, deadlineAt: () => (control.stopped ? Date.now() : null) });
    // Keep the listing page as the run fetched it (any lane), to read its category
    // trail at the end without asking for it again.
    let originHtml = null;
    { const get = fetcher.get.bind(fetcher); fetcher.get = async (u, o) => { const r = await get(u, o); if (!originHtml && u === meta.origin && r && r.ok && typeof r.body === 'string') originHtml = r.body; return r; }; }
    const provider = registry[meta.provider] && registry[meta.provider].isConfigured() ? registry[meta.provider] : registry.manual;
    active = { control, provider, jobId: job.id };

    const browserEnabled = useBrowser !== false && meta.browser !== false;
    // Human intervention only when the user asked for it (visible browser), and never
    // past a stop: see interventionHandler.
    const onIntervention = interventionHandler({ provider, emit, interactive: !!meta.intervene, signal: control.signal });
    // Usage ledger: every line of this job carries its id, domain and test-mode flag.
    const execStartedAt = Date.now();
    // Where the run's time goes, step by step (report.timings): the list is what is left of the total.
    const stepMs = { productPagesMs: 0, sideDataMs: 0, exportMs: 0 };
    const timed = async (k, fn) => { const t = Date.now(); try { return await fn(); } finally { stepMs[k] += Date.now() - t; } };
    const jobUrl = meta.origin || (Array.isArray(meta.urls) && meta.urls[0]) || null;
    const testMode = sanitizeTestMode(meta.testMode);
    const jm = M.forJob({ jobId: job.id, domain: jobUrl ? hostKey(jobUrl) : null, url: jobUrl, testMode: !!testMode });
    // The "per job" caps count THIS job only: their counters start from zero here.
    // The month counters are untouched — they mirror the ledger's totals (fed by
    // every billable call, raised to the ledger at startup) and bound the month.
    if (providerRuntime) { try { providerRuntime.resetJobCounters(); if (persistProviders) persistProviders(); } catch { /* accounting best-effort, never breaks a run */ } }
    let localRoute = null, localProducts = null; // what the FREE lanes did, frozen before any paid escalation
    // Bytes-downloaded accounting (Item 6). The HTTP crawl/sitemap lane is already
    // counted by fetcher.stats.bytes and the browser lane by _bs.stats.bytes; the
    // recipe/internal-api lane uses its own httpGet, so wrap it here to count the
    // bytes it pulls. Approximate for the recipe lane (measures the parsed body's
    // serialized length — the JSON payload actually downloaded), exact for the
    // other two lanes. Purpose: real cost-per-product before any per-GB proxy.
    const laneBytes = { recipe: 0 };
    // Remote Scraping Browser cost axes that must survive a report replacement
    // (ingest rebuilds `report`): session runtime (s) and sessions opened this job.
    const laneRuntime = {};
    let sbSessions = 0;
    let recipeBootstrapDiag = null, recipeLaneDiag = null, selectorRecipeDiag = null; // journal-only diagnostics (report.json), redacted
    let recipeFilterUnhonoured = null; // facet filter(s) on the entry URL the recipe could not honour (read the real page instead)
    let detailReport = null, paginationReport = null; // listing pagination + product-page completion (report.json + done event)
    let laneInvalidated = null; // taught rules this run made fail (report "rules invalidated")
    const laneDiag = { rejectedImages: [], urlsCorrected: 0, urlSamples: [] }; // image / address diagnostics of the recipe lanes
    let repairReport = null; // rules this run made fail, and their repairs (self-healing)
    let onboardReport = null; // the first discovery of a site, built from this run's product pages
    const enginePages = pageMemo(); // product pages the engine read (for a repair / a first discovery)
    // Content type of the run (shared/content/profiles.mjs): the form's choice, or
    // recognised on the entry page when the form said "auto". The entry page is
    // fetched at most once here and handed to discovery (no second request).
    const wantedType = normalizeContentType(meta.contentType);
    const contentType = { requested: wantedType, type: wantedType === 'video' ? 'video' : 'product', detected: null, signals: [] };
    let entryRes = null;
    const entryPage = async () => {
      if (entryRes === null) { try { entryRes = await fetcher.get(meta.origin); } catch (e) { entryRes = { ok: false, error: String((e && e.message) || e) }; } }
      return entryRes;
    };
    // Recipe replays and platform feeds keep the run's manners: its User-Agent, its
    // deadline over the whole exchange, its retries, and the SAME per-host spacing
    // as the main fetcher (one pacer), so two lanes never double the rate on a site.
    const baseRecipeGet = recipeHttpGet || defaultHttpGet(undefined, { userAgent: fetcher.userAgent, timeoutMs: cfg.timeoutMs, retries: cfg.retries, minDelayMs: cfg.rateLimitMs, pacer: fetcher.pacer || null, signal: control.signal });
    const recipeGet = async (url, opts = {}) => {
      const res = await baseRecipeGet(url, opts);
      try {
        const b = res && res.body;
        if (typeof b === 'string') laneBytes.recipe += Buffer.byteLength(b);
        else if (b != null) laneBytes.recipe += Buffer.byteLength(JSON.stringify(b));
      } catch { /* never break the lane over a counter */ }
      return res;
    };
    let _bs = null, _bsTried = false;
    const getBrowser = async () => {
      if (_bsTried) return _bs; _bsTried = true;
      if (browserSession && browserEnabled) { _bs = browserSession; return _bs; } // injected (tests)
      if (!browserEnabled || !(await browserAvailable())) return null;
      const profileDir = path.join(outputRoot(cfg), '.browser-profile');
      if (meta.intervene) fs.mkdirSync(profileDir, { recursive: true });
      _bs = new BrowserSession({ headless: meta.intervene ? false : cfg.headless !== false, userDataDir: meta.intervene ? profileDir : undefined, userAgent: fetcher.userAgent, onIntervention });
      return _bs;
    };

    // Discovery + scrape wrapped so the browser session is ALWAYS released, even
    // if discovery or runScrape throws (otherwise the Chromium process leaks).
    let discReport = null;
    let discSeeds = null; // listing cards from discovery → passed to runScrape so complete cards deliver even when a fiche is an SPA shell
    let discCards = null; // cards the listing states with an id and a price but no link of their own (read from the listing, nothing to fetch)
    let report;
    let runError = null; // a discovery/scrape error must NOT discard products already collected
    // Declared outside the try so they stay in scope for the outputs/emits below.
    let lastFlush = Date.now(), lastEmit = 0;
    const flushMaybe = () => { if (Date.now() - lastFlush > 1500) { job.flush(); lastFlush = Date.now(); } };
    const emitCounters = (force) => { const now = Date.now(); if (force || now - lastEmit > 250) { lastEmit = now; emit('counters', counters(job)); } };
    // Real-progress channel: relay the engine's ACTUAL step messages to the UI so a
    // long discovery/render/pagination phase shows what it is doing (never simulated).
    let lastStepAt = Date.now();
    // The engine emits STABLE CODES (analyze/crawl/render/firstPage/paginate/…), the
    // UI localises them — never a hardcoded language string crossing into another.
    const emitStep = (code, extra) => { lastStepAt = Date.now(); emit('step', { code, ...(extra || {}) }); };
    const onStep = (code, params) => emitStep(code, params);

    // Category trail + stock + reviews, completed once all lanes are done (report.json).
    let trailReport = null, sideReport = null, browserPages = null; // browserPages: pages read in the local browser because the site refused plain HTTP
    const completeProductContext = async () => {
      const prods = job.products;
      // 1) The listing page's category trail, for products whose own page has none.
      if (meta.origin && originHtml && prods.some((p) => !(p.raw && Array.isArray(p.raw.breadcrumb) && p.raw.breadcrumb.length))) {
        const { trail, source } = listingTrailFromHtml(originHtml, meta.origin);
        if (trail.length) trailReport = { source, trail, products: applyTrailToNormalized(prods, trail) };
      }
      // 2) Stock per size + reviews loaded by the product pages with their own requests.
      const sd = cfg.sideData || {};
      const needs = (p) => !(p.raw && p.raw.availability) || !(p.raw && p.raw.review_count != null);
      // Stock and reviews are product facts: a video run asks for none (no render).
      if (sd.enabled === false || contentType.type === 'video' || !browserEnabled || control.stopped || !prods.some(needs)) return;
      // The site already asked the browser for a human check in this run: no more pages.
      if (browserPages && browserPages.stats.stoppedBy === 'human_check') { sideReport = { learned: null, reason: 'human_check' }; return; }
      // A view of each normalized product in the raw shape the step reads; the sizes
      // are the product's own objects (completed in place).
      const views = prods.map((p) => ({ sourceUrl: p.source_url, sku: (p.raw && p.raw.sku) || p.source_product_id, gtin: p.barcode || (p.raw && p.raw.gtin) || null, variants: Array.isArray(p.variants) ? p.variants : [] }));
      sideReport = await timed('sideDataMs', () => completeSideData(views, { getSession: getBrowser, fetchJson: fetcherJson(fetcher), timeoutMs: cfg.renderTimeoutMs || 30000, onStep: (c, p) => emitStep(c, p), isStopped: () => control.stopped, maxRequests: Math.max(50, (cfg.maxProducts || 1000) * 3) }));
      prods.forEach((p, i) => {
        const v = views[i];
        if (v.availability) p.raw.availability = v.availability;
        if (v.reviewCount != null) { p.raw.review_count = v.reviewCount; p.raw.rating = v.reviewCount > 0 ? v.rating : null; }
      });
    };
    // Watchdog over the WHOLE job, last phase and browser close included (cleared only
    // once both are done). While working: a long silent op (Playwright launch/render,
    // a slow unlock) shows an honest "still working". No progress for `stallMs` → the
    // job is stopped as STALLED (not a user stop) and every external wait is aborted
    // through the job signal; the local browser is closed so its pending page
    // operations reject. A stop that has not finished `stopGraceMs` after it was asked
    // is released the same way.
    const wd = cfg.watchdog || {};
    const stallMs = Math.max(200, Number(wd.stallMs) || 120000);
    const stopGraceMs = Math.max(200, Number(wd.stopGraceMs) || 30000);
    const releaseWaits = () => { control.abort(); if (_bs) { try { _bs.close({ timeoutMs: 5000 }).catch(() => {}); } catch { /* ignore */ } } };
    const heartbeat = setInterval(() => {
      const silent = Date.now() - lastStepAt;
      if (control.stopped) {
        if (control.stoppedAt && Date.now() - control.stoppedAt > stopGraceMs && !(control.signal && control.signal.aborted)) releaseWaits();
        return;
      }
      if (silent > stallMs) { emit('step', { code: 'stalled', tick: true }); lastStepAt = Date.now(); try { control.stop('stalled'); } catch { /* ignore */ } releaseWaits(); }
      else if (silent > 6000) emit('step', { code: 'working', tick: true });
    }, Math.max(50, Math.min(4000, Math.floor(stallMs / 4))));
    try {
      // 2b — RECIPE LANE (free-first). A known host with a usable internal_api recipe
      // is replayed BEFORE discovery, the browser and any paid provider. Vars resolve
      // over HTTP/URL; the browser is used at most ONCE (bootstrap) only when a var
      // sits behind a protected page, then the whole catalogue is fetched over HTTP.
      // Any failure records the outcome and falls through to the normal ladder — the
      // free result always wins, a stale recipe only costs a little time.
      let handledByRecipe = false;
      // Shared ingest for BOTH recipe kinds (internal_api replay + manual_selectors
      // replay): normalise via the existing path, dedup, emit, and set the report.
      const ingestRecipeProducts = (rawProducts, method, pages, note) => {
        job.setStatus('running'); emit('phase', { phase: 'running' });
        const seen = new Set();
        for (const raw of rawProducts) {
          const np = toNormalizedProduct(raw, { storeSlug: meta.store || '', lang: meta.lang || 'fr', defaultProductType: meta.productType || null, categorySlug: meta.categorySlug || null, diag: laneDiag });
          const idKey = np.source_product_id ? `id:${np.source_product_id}` : `url:${np.source_url || np.name || ''}`;
          if (idKey && seen.has(idKey)) continue; seen.add(idKey);
          np.__eligibility = evaluateEligibility(np);
          // A row whose own product page could not be read and that still lacks what the page gives is "to verify".
          if (np.__eligibility.status === 'accepted') { const dv = detailUnreadVerdict(raw, np); if (dv) np.__eligibility = { ...np.__eligibility, ...dv }; }
          job.addProduct(np);
          emit('product', { name: np.name || '(sans nom)', price: np.price, status: np.__eligibility?.status || 'to_verify', image: !!np.image_url });
        }
        flushMaybe(); emitCounters(true);
        const acc = job.products.filter((p) => p.__eligibility?.status === 'accepted').length;
        const tv = job.products.filter((p) => p.__eligibility?.status === 'to_verify').length;
        const ex = job.products.filter((p) => p.__eligibility?.status === 'excluded').length;
        report = { store: meta.store || '', status: 'OK', method, discovered: rawProducts.length, fetched: pages, detected: job.products.length, normalized: job.products.length, accepted: acc, toVerify: tv, excluded: ex, incomplete: 0, notAProductPage: 0, duplicates: 0, networkErrors: 0, parseErrors: 0, browserRequired: 0, browserUsed: 0, sitemapsRead: [], durationMs: 0, remaining: 0, notes: [note], errors: [], byStrategy: { [method]: job.products.length }, discovery: { method, diagnosis: 'ok', browserPagesRendered: 0 } };
        const ingestedUrls = rawProducts.map((p) => p.source_url || p.sourceUrl || p.canonicalUrl).filter(Boolean);
        job.setDiscovered(ingestedUrls);
        // Already ingested ⇒ processed: a resumed job must not re-scrape every fiche
        // (remaining() = discovered − processed) nor skip the recipe lane for them.
        for (const u of ingestedUrls) job.markProcessed(u);
      };
      // Free HTTP-only helpers for pagination and product pages (the run's polite
      // Fetcher: same rate, cookies and byte accounting — never a paid route).
      // `blocked` = a SOURCE-WIDE block only (anti-bot, rate limit, access denied):
      // a 404 on one URL is a dead page, not a reason to stop trying.
      const terminalBlock = (r) => !!(r && r.block ? r.block.terminal : (r && r.blocked && r.status !== 404 && r.status !== 410));
      const httpPage = async (u) => { try { const r = await fetcher.get(u); return { ok: !!(r && r.ok && r.body), html: r && r.body, status: r && r.status, blocked: terminalBlock(r) }; } catch { return { ok: false }; } };
      const httpJson = async (u, headers = null) => {
        try {
          const r = await fetcher.get(u, { accept: 'application/json, text/plain, */*', ...(headers ? { headers } : {}) });
          let json = null; try { json = r && r.body ? JSON.parse(r.body) : null; } catch { json = null; }
          return { ok: !!(r && r.ok && json != null), json, body: r && r.body ? String(r.body).slice(0, 2000) : '', status: r && r.status, blocked: terminalBlock(r) };
        } catch { return { ok: false }; }
      };
      // A public script of the page, read over the same polite fetcher with a byte
      // cap (the fetcher stops reading past it). Used only to find / re-read the
      // static request header a listing API needs (core/api-header-discovery.mjs).
      const lp0 = cfg.listPagination || {};
      const jsFileBytes = Math.max(64 * 1024, Number(lp0.jsHeaderFileBytes) || 2 * 1024 * 1024);
      const httpText = async (u) => {
        try {
          const r = await fetcher.get(u, { accept: 'text/javascript,application/javascript;q=0.9,*/*;q=0.5', maxBytes: jsFileBytes });
          return { ok: !!(r && r.ok && typeof r.body === 'string' && r.body), text: r && typeof r.body === 'string' ? r.body : '', status: (r && r.status) || 0, tooLarge: !!(r && r.tooLarge) };
        } catch { return { ok: false, text: '', status: 0, tooLarge: false }; }
      };
      // Re-read the header specs a previous run stored in the recipe ({ from, pattern }).
      const resolveApiHeaders = async (specs) => {
        const r = await resolveRecipeHeaders({ headers: specs }, async (u) => { const t = await httpText(u); return { status: t.status, body: t.text }; });
        return { headers: r.error ? null : r.headers, error: r.error || null };
      };
      // Find them in the page's public scripts — only when the local browser is not
      // allowed for this run (with the browser, the page's own API traffic gives the
      // real headers, see the scroll step below). Free, bounded, static values only.
      const discoverApiHeaders = (!browserEnabled && lp0.jsHeaders !== false) ? async (args) => {
        const d = await discoverApiHeadersInJs({ ...args, fetchText: httpText, maxFiles: Math.max(1, Number(lp0.jsHeaderFiles) || 10), maxBytesPerFile: jsFileBytes });
        return { ...d, summary: discoverySummary(d) };
      } : undefined;
      // When the site refuses plain HTTP (an anti-bot waiting page) while the local
      // browser reads it, the next pages (pagination, product pages) go through the
      // browser — free, slower — and HTTP is not tried again in this run: repeated
      // refused attempts can make the site distrust the browser session too
      // (measured). Bounded by the browser budget (at least the product cap).
      let httpRefused = false;
      browserPages = browserPageReader({
        getSession: async () => (browserEnabled ? getBrowser() : null),
        budget: Math.max(Number(cfg.maxBrowser) || 40, (cfg.maxProducts || 0) + 5),
        minGapMs: cfg.browserPageGapMs != null ? Number(cfg.browserPageGapMs) : 3000,
        isStopped: () => control.stopped,
      });
      const pageHtml = async (u) => {
        if (!httpRefused) { const r = await httpPage(u); if (r.ok || !r.blocked) return r; httpRefused = true; }
        return (await browserPages.read(u)) || { ok: false, blocked: true };
      };
      // Product pages: the way that worked last time for this site (http | browser | extension) is used
      // first; a site whose product pages only the user's browser reads is not asked again here.
      const detailAccess = detailAccessOf(meta.origin ? profiles.get(meta.origin) : null);
      const detailTracker = createAccessTracker();
      let detailHttpRefused = detailAccess === 'browser' || detailAccess === 'extension';
      const detailPageHtml = async (u) => {
        if (detailAccess === 'extension') return { ok: false, blocked: true, reason: 'needs_user_browser' };
        if (!httpRefused && !detailHttpRefused) {
          const r = await httpPage(u);
          if (r.ok || !r.blocked) { if (r.ok) detailTracker.note('http', true); return r; }
          httpRefused = true; detailTracker.note('http', false);
        }
        const b = await browserPages.read(u);
        if (b && b.ok) detailTracker.note('browser', true); else if (b && b.blocked) detailTracker.note('browser', false);
        return b || { ok: false, blocked: true };
      };
      // Product-page completion of a listing lane (colour, sizes + EAN, gallery,
      // description, brand, list price) — one visit per model, sample-first.
      const runPages = pageMemo();
      const completeFromDetailPages = async (rawProducts) => {
        const dp = cfg.detailPages || {};
        if (dp.enabled === false || !rawProducts.length || control.stopped) return;
        try {
          detailReport = await timed('productPagesMs', () => enrichFromDetailPages(rawProducts, {
            fetchHtml: async (u) => runPages.keep(u, await detailPageHtml(u)), maxVisits: detailVisitCap(dp, cfg.maxProducts || 1000), sample: Number(dp.sample) || 3,
            onStep: (code, p) => emitStep(code, p), isStopped: () => control.stopped,
            // What the site taught (🎯 / detection): read on every product page; rendered page only when the plain HTML lacks the taught blocks.
            knowledge: knowledge.forEngine(meta.origin), fetchRendered: (u) => browserPages.read(u),
          }));
          const failedNow = recordKnowledgeOutcomes(meta.origin, detailReport); laneInvalidated = invalidatedOf(failedNow);
          repairReport = await repairAfterRun(meta.origin, failedNow, runPages.m, detailPageHtml);
          onboardReport = await onboardAfterRun(meta.origin, runPages.m, rawProducts);
          const learned = detailTracker.verdict();
          if (detailReport) detailReport.access = { used: detailAccess, learned, counts: detailTracker.counts };
          if (learned && meta.origin) { try { profiles.record(meta.origin, { detailAccess: learned }); } catch { /* best-effort */ } }
        } catch { detailReport = null; }
      };
      if (meta.origin && !job.discovered.length) {
        emitStep('recipeCheck');
        // 2b SYNC (fetch) — pull the authoritative shared internal_api into the local
        // profile before any lane, so a site another user already taught is free for
        // me too AND a locally-taught DOM recipe can't hide an existing internal_api.
        await syncSharedRecipe(meta.origin);
        const prof = profiles.get(meta.origin);
        const recipe = profiles.hints(meta.origin).internalApi;
        // A pasted URL may carry a FACET filter (e.g. ?categories=412 = a sub-category)
        // that the recipe does not read: the internal API would then return the WHOLE
        // parent listing (water + sodas when the user asked for spirits only). Never
        // trust it silently — skip the recipe and read the real filtered page via the
        // crawl/browser, which the site filters itself. Flagged in the report. Generic:
        // driven by the recipe's own vars, never a site name.
        const recipeFacets = recipe ? unconsumedFacets(recipe, meta.origin) : [];
        if (recipe && recipeFacets.length) {
          recipeLaneDiag = { ok: false, skipped: 'filter_unhonoured', facets: recipeFacets.map((f) => f.key) };
          recipeFilterUnhonoured = recipeFacets.map((f) => f.key);
          emit('recipe', { known: true, free: true, cost: 'filtre de la page non géré par la recette — lecture directe de la page filtrée' });
        } else if (recipe) {
          // v0.5.9 BROWSER BOOTSTRAP (opt-in, per host, config only): when the free
          // HTTP resolution of the recipe's dynamic headers fails (or always, if so
          // configured), ONE short remote Scraping Browser session observes the app's
          // own API request and captures the configured header/cookie values; the
          // catalogue is then replayed over cheap HTTP. Values stay in memory.
          //   config.json brightData.scrapingBrowserBootstrap[<host>] = {
          //     requestUrlPattern, headers?: [names], cookies?: [names], url?, mode?: 'fallback'|'always' }
          const bsAppCfg = readJson(dirs.configFile);
          const bsHost = (() => { try { return new URL(meta.origin).hostname.replace(/^www\./, ''); } catch { return ''; } })();
          const bsBd = (bsAppCfg && bsAppCfg.brightData) || {};
          const bsCfg = bsBd.scrapingBrowserBootstrap && bsBd.scrapingBrowserBootstrap[bsHost];
          const bsCountry = bsBd.scrapingBrowserCountry && bsBd.scrapingBrowserCountry[bsHost];
          const bsSb = scrapingBrowserConfig(bsAppCfg, undefined, { country: bsCountry });
          const bsWanted = !!(bsCfg && typeof bsCfg === 'object' && bsCfg.requestUrlPattern && bsSb.configured);
          // The admin switches (kill switch, provider off, caps) govern the bootstrap
          // session too — a cap or "Tout désactiver" must hold for every billed call.
          const bsGate = bsWanted && providerRuntime ? providerRuntime.availabilityReason('brightData.scrapingBrowser', bsHost) : null;
          const bsGateBlocks = bsGate && bsGate !== 'not_configured';
          if (bsWanted && bsGateBlocks) jm.record({ provider: 'scrapingbrowser', route: 'bootstrap', attempted: false, outcome: bsGate === 'cap_reached' ? 'blocked_by_cap' : 'skipped', reason: bsGate });
          const bootstrapOn = bsWanted && !bsGateBlocks;
          const bootstrapMode = bootstrapOn && bsCfg.mode === 'always' ? 'always' : 'fallback';
          const headerBootstrap = bootstrapOn ? async ({ names }) => {
            if (control.stopped) { jm.record({ provider: 'scrapingbrowser', route: 'bootstrap', attempted: false, outcome: 'skipped', reason: 'stopped' }); return { error: 'stopped before the bootstrap', stopped: true }; } // never a paid call after Stop
            const bsT0 = Date.now();
            const blockList = bsBd.scrapingBrowserBlock && bsBd.scrapingBrowserBlock[bsHost];
            const blockTypes = Array.isArray(blockList) ? new Set(blockList) : undefined;
            const capHeaders = [...new Set([...(Array.isArray(bsCfg.headers) ? bsCfg.headers : []), ...(names || [])])];
            const res = await scrapingBrowserBootstrap(bsCfg.url || meta.origin, {
              cdpUrl: bsSb.cdpUrl, connect: scrapingBrowserConnect, ...(blockTypes ? { blockTypes } : {}),
              capture: { urlPattern: bsCfg.requestUrlPattern, flags: bsCfg.flags, headers: capHeaders, cookies: bsCfg.cookies },
            });
            const bsAttempted = res.note !== 'not_configured' && res.note !== 'bad_capture_spec';
            if (bsAttempted) sbSessions += 1;
            laneBytes.scrapingBrowser = (laneBytes.scrapingBrowser || 0) + (res.bytes || 0);
            laneRuntime.scrapingBrowser = (laneRuntime.scrapingBrowser || 0) + (res.runtimeSec || 0);
            jm.record({ provider: 'scrapingbrowser', route: 'bootstrap', attempted: bsAttempted, outcome: bsAttempted ? paidOutcome(res) : 'skipped', reason: res.ok ? null : paidReason(res), bytes: res.bytes || 0, durationMs: res.runtimeSec != null ? Math.round(res.runtimeSec * 1000) : Date.now() - bsT0 });
            // Names + origin/path only — never a captured value.
            recipeBootstrapDiag = { attempted: true, ok: !!res.ok, note: res.note || null, captured: res.captured || null, bytes: res.bytes || 0, runtimeSec: res.runtimeSec ?? null, captcha: res.captcha || null, error: res.error ? String(res.error).slice(0, 240) : null };
            return { headers: res.headers, cookie: res.cookie, error: res.ok ? null : (res.error || 'bootstrap failed') };
          } : undefined;
          const cost = estimateRecipeCost(recipe, prof || {}, 0, { paidBootstrap: bootstrapOn && bootstrapMode === 'always' });
          emit('recipe', { known: true, free: cost.free, cost: cost.label });
          const httpGet = recipeGet;
          // One-time bootstrap: render the category page, read pending vars by regex
          // on the rendered HTML, and reuse its cookies for the HTTP replay.
          const browserBootstrap = async ({ recipe: rc, categoryUrl, pending }) => {
            const s = await getBrowser(); if (!s) return { error: 'no browser' };
            const rendered = await s.render(categoryUrl);
            if (!rendered || !rendered.html) return { error: (rendered && rendered.error) || 'render failed' };
            const vars = {};
            for (const name of pending) {
              const spec = (rc.vars && rc.vars[name]) || {};
              // A recipe pattern (possibly from the recipe server): checked and bounded.
              if (spec.pattern) { const sr = safeRegExp(spec.pattern, spec.flags || ''); if (!sr.error) { const m = boundedMatch(rendered.html, sr.re); if (m && m[1] != null) vars[name] = m[1]; } }
            }
            let cookie = '';
            try { if (typeof s.cookies === 'function') { const cs = await s.cookies(); if (Array.isArray(cs)) cookie = cs.map((c) => `${c.name}=${c.value}`).join('; '); } } catch { /* ignore */ }
            return { vars, cookie };
          };
          // User-configurable per-site context (e.g. Colruyt's store / placeId —
          // which shop's prices) read from config.json `siteContext[<host>]`, NEVER
          // hardcoded. Feeds the recipe's config-sourced vars; generic for any site.
          const siteConfig = (() => {
            try { const host = new URL(meta.origin).hostname.replace(/^www\./, ''); return (readJson(dirs.configFile).siteContext || {})[host] || {}; }
            catch { return {}; }
          })();
          let lane;
          try { lane = await runRecipeLane(recipe, meta.origin, { httpGet, browserBootstrap, headerBootstrap, headerBootstrapMode: bootstrapMode, maxProducts: cfg.maxProducts, onStep, siteConfig }); }
          catch (e) { lane = { ok: false, products: [], pages: 0, total: null, usedBrowser: false, error: String((e && e.message) || e) }; }
          // Kept for the journal (report.json) so a stale recipe is diagnosable; the
          // lane already redacts any captured header/cookie value from its error.
          // usedHeaderBootstrap = a remote session was really attempted (not a Stop).
          recipeLaneDiag = { ok: !!(lane.ok && lane.products.length), error: lane.error ? String(lane.error).slice(0, 240) : null, usedHeaderBootstrap: !!recipeBootstrapDiag };
          // A fallback bootstrap that actually ran made this start paid: say so
          // (provider-free) instead of the "gratuit" estimate emitted beforehand.
          let costLabel = cost.label;
          if (recipeBootstrapDiag && cost.bootstrap !== 'paid-unlock') {
            const paid = estimateRecipeCost(recipe, prof || {}, 0, { paidBootstrap: true });
            costLabel = paid.label;
            emit('recipe', { known: true, free: paid.free, cost: paid.label });
          }
          if (lane.ok && lane.products.length) {
            // The recipe's own API pagination (already generic in the recipe format).
            paginationReport = { mechanism: 'recipe-api', pages: lane.pages, totalAnnounced: lane.total ?? null, stoppedBy: null, warnings: (lane.total != null && lane.products.length < lane.total && lane.products.length < cfg.maxProducts) ? ['total_not_reached'] : [] };
            await completeFromDetailPages(lane.products);
            ingestRecipeProducts(lane.products, 'internal-api', lane.pages, `recipe internal-api: ${lane.total ?? lane.products.length} product(s), ${lane.pages} page(s) — ${costLabel}`);
            handledByRecipe = true;
            try { profiles.record(meta.origin, { internalApiOutcome: true, method: 'internal-api', productCount: job.products.length }); } catch { /* best-effort */ }
          } else if (!lane.stopped && !control.stopped) {
            // A Stop is not a recipe failure: it must not push a good recipe
            // towards deprecation.
            try { profiles.record(meta.origin, { internalApiOutcome: false }); } catch { /* best-effort */ }
          }
        }
        // manual_selectors recipe (DOM sites) — replayed the same free-first way,
        // over HTTP (browser only if the fetch is blocked), no per-product cost.
        if (!handledByRecipe) {
          const sel = profiles.hints(meta.origin).manualSelectors;
          if (sel) {
            emit('recipe', { known: true, free: true, cost: 'gratuit (site connu — sélecteurs)' });
            const fetchHtml = async (u) => {
              try { const r = await fetcher.get(u); if (r.ok && r.body) return { ok: true, html: r.body, status: r.status }; if (terminalBlock(r)) httpRefused = true; } catch { /* fall through to browser */ }
              const s = await getBrowser(); if (s) { try { const rr = await s.render(u); if (rr && rr.html) return { ok: true, html: rr.html }; } catch { /* ignore */ } }
              return { ok: false };
            };
            let lane;
            const lp = cfg.listPagination || {};
            try {
              lane = lp.enabled === false
                ? await replaySelectorLane(sel, meta.origin, { fetchHtml, maxProducts: cfg.maxProducts, maxPages: cfg.maxPages, onStep })
                // Generic pagination: page 1 as before (browser fallback allowed), every
                // further page over free HTTP only (pages, embedded API "next").
                : await replaySelectorLaneGeneric(sel, meta.origin, { fetchHtml, fetchPageHtml: pageHtml, fetchJson: httpJson, maxProducts: cfg.maxProducts, maxPages: Math.max(1, Math.min(Number(lp.maxPages) || 50, cfg.maxPages || 150)), onStep, isStopped: () => control.stopped, discoverApiHeaders, resolveApiHeaders });
            }
            catch (e) { lane = { ok: false, products: [], pages: 0, error: String((e && e.message) || e) }; }
            // A learned recipe that now reads rows without name / price (the page changed,
            // e.g. regenerated class names) is not trusted: one failure is counted for it
            // and the run continues with the other methods.
            const health = lane.ok && lane.products.length ? selectorRowsHealth(lane.products, cfg.quality) : null;
            if (health && !health.ok) selectorRecipeDiag = { skipped: true, reason: 'rows_without_name_or_price', rows: lane.products.length, emptyNameRatio: health.emptyNameRatio, emptyPriceRatio: health.emptyPriceRatio };
            if (lane.ok && lane.products.length && (!health || health.ok)) {
              if (lane.pagination) {
                const pg = lane.pagination;
                paginationReport = { mechanism: pg.mechanism, pages: pg.pages, totalAnnounced: pg.totalAnnounced, stoppedBy: pg.stoppedBy, warnings: pg.warnings, detail: pg.detail || null, ...(pg.apiHeaders ? { apiHeaders: pg.apiHeaders } : {}) };
                // Remember the working mechanism in the recipe (backward compatible:
                // `pagination.mode` gains values; old recipes are detected again). The
                // API header specs ({ from, pattern }, never a value) travel with it.
                const old = sel.pagination || {};
                const m = pg.memo;
                const sameSpecs = JSON.stringify(m && m.api_headers ? m.api_headers : null) === JSON.stringify(old.api_headers || null);
                if (m && (m.mode !== old.mode || m.param !== old.param || m.api_host !== old.api_host || !sameSpecs)) {
                  try { profiles.record(meta.origin, { manualSelectors: { ...sel, pagination: { ...old, ...m, detected_at: new Date().toISOString() } } }); } catch { /* best-effort */ }
                }
                // The rest of the list loads on SCROLL (no request we can rebuild over
                // HTTP, e.g. an API that needs the site's own header): let the free
                // LOCAL browser scroll the page — the site's own code loads the next
                // products — and replay the same recipe on every card it shows. Only
                // when products are missing and the browser fallback is allowed.
                const missing = lane.products.length < cfg.maxProducts && (pg.totalAnnounced == null || lane.products.length < pg.totalAnnounced);
                if (missing && (pg.warnings || []).includes('scroll_not_followable') && browserEnabled && !control.stopped) {
                  try {
                    const s = await getBrowser();
                    if (s && typeof s.collectListing === 'function') {
                      emitStep('browserStart');
                      const per = Math.max(lane.products.length, 12);
                      const maxScrolls = Math.min(80, Math.ceil(cfg.maxProducts / per) * 2 + 4);
                      const urlSel = sel.fields && sel.fields.url && sel.fields.url.selector;
                      // The API request the HTTP pagination could not complete: watch the
                      // page send it itself, to learn the headers it needs (filtered).
                      let apiPath = null; try { apiPath = pg.apiNext ? new URL(pg.apiNext, meta.origin).pathname : null; } catch { apiPath = null; }
                      const r = await s.collectListing(meta.origin, { recipeCard: sel.card, recipeUrlSelector: urlSel || null, stopAt: cfg.maxProducts, maxScrolls, timeoutMs: cfg.renderTimeoutMs || 30000, captureApi: apiPath ? { pathname: apiPath } : null });
                      const snaps = (r && r.recipeCardsHtml) || [];
                      const more = snaps.length ? applySelectorRecipe(`<html><body>${snaps.join('\n')}</body></html>`, sel, meta.origin) : [];
                      const key = (c) => { try { const u = new URL(c.sourceUrl || c.canonicalUrl); u.hash = ''; return u.toString().replace(/\/$/, ''); } catch { return `n:${c.name}|${c.price}`; } };
                      const seen = new Set(lane.products.map(key));
                      let added = 0;
                      for (const c of more) { if (lane.products.length >= cfg.maxProducts) break; const k = key(c); if (seen.has(k)) continue; seen.add(k); lane.products.push(c); added++; }
                      paginationReport.browserScroll = { cards: snaps.length, added, blocked: r && r.blocked ? r.blocked.code : null, error: (r && r.error) ? String(r.error).slice(0, 120) : null };
                      // A site often stops loading on scroll after a few pages. When the
                      // page itself called its listing API, continue THAT pagination over
                      // free HTTP with the same request headers it sent (never a cookie
                      // or a credential), from the request after the last one it made.
                      const cap = r && r.apiCapture;
                      let apiAdded = 0;
                      if (cap && cap.headers && cap.lastJson && cap.lastUrl && lane.products.length < cfg.maxProducts && !control.stopped) {
                        const nf = findJsonPagination(cap.lastJson);
                        let ref = null; try { ref = nf && nf.next ? new URL(nf.next, cap.lastUrl).toString() : null; } catch { ref = null; }
                        if (ref) {
                          const before = lane.products.length;
                          const cont = await paginateListing({
                            entryUrl: meta.origin, firstHtml: '', firstCards: lane.products, extractCards: () => [],
                            extractJsonCards: (json, u) => extractProductsFromJson(json, u).cards,
                            fetchHtml: httpPage, fetchJson: (u) => httpJson(u, cap.headers),
                            maxProducts: cfg.maxProducts, maxPages: Math.max(1, Math.min(Number(lp.maxPages) || 50, cfg.maxPages || 150)),
                            onStep, isStopped: () => control.stopped, apiStart: { ref },
                          });
                          for (const c of cont.cards.slice(before)) lane.products.push(c);
                          apiAdded = lane.products.length - before;
                          if (cont.totalAnnounced != null && pg.totalAnnounced == null) paginationReport.totalAnnounced = cont.totalAnnounced;
                          paginationReport.apiAfterScroll = { pages: Math.max(0, cont.pages - 1), added: apiAdded, stoppedBy: cont.stoppedBy, headersLearned: Object.keys(cap.headers).length, detail: cont.detail || null };
                        }
                      }
                      if (added > 0 || apiAdded > 0) {
                        const total = paginationReport.totalAnnounced;
                        paginationReport.mechanism = 'browser-scroll';
                        paginationReport.stoppedBy = lane.products.length >= cfg.maxProducts ? 'max_products' : (total != null && lane.products.length >= total ? 'total_reached' : (apiAdded > 0 ? paginationReport.apiAfterScroll.stoppedBy : 'scroll_end'));
                        paginationReport.warnings = (total != null && lane.products.length < total && lane.products.length < cfg.maxProducts) ? ['total_not_reached'] : [];
                        if (apiAdded > 0) paginationReport.pages = (paginationReport.pages || 1) + paginationReport.apiAfterScroll.pages;
                      }
                    }
                  } catch { /* the HTTP result stands */ }
                }
              }
              await completeFromDetailPages(lane.products);
              ingestRecipeProducts(lane.products, 'dom-selectors', lane.pages, `recipe manual-selectors: ${lane.products.length} product(s), ${lane.pages} page(s) — gratuit`);
              handledByRecipe = true;
              try { profiles.record(meta.origin, { manualSelectorsOutcome: true, method: 'dom-selectors', productCount: job.products.length }); } catch { /* best-effort */ }
            } else {
              try { profiles.record(meta.origin, { manualSelectorsOutcome: false }); } catch { /* best-effort */ }
            }
          }
        }
        // Tier 1 (Item 9a) — built-in PLATFORM DEFAULTS for an UNKNOWN host (no
        // learned recipe): a Shopify /products.json or WooCommerce Store-API feed
        // is a free, deterministic catalogue shared by every store on that platform.
        // Try it before the generic crawl; FAIL-SAFE — a miss (wrong guess, empty
        // feed, 404, non-JSON) yields nothing and falls straight through to
        // discovery, which still runs its full ladder. Nothing persisted.
        // Skipped for a host the profile already knows is protected (needsUnlock):
        // that keeps the known-protected fast path to a single cheap probe.
        // Content type "auto": recognised on the entry page (one request, reused by
        // the platform tier below and by discovery).
        if (!handledByRecipe && meta.origin && contentType.requested === 'auto' && !(prof && prof.needsUnlock)) {
          const r = await entryPage();
          if (r && r.ok && r.body) {
            const det = detectContentType(r.body, r.url || meta.origin);
            contentType.detected = det.type; contentType.signals = det.signals;
            if (det.type === 'video') contentType.type = 'video';
          }
        }
        if (contentType.type === 'video') emit('contentType', { ...contentType });
        if (!handledByRecipe && contentType.type !== 'video' && !(prof && prof.needsUnlock) && !profiles.hints(meta.origin).internalApi && !profiles.hints(meta.origin).manualSelectors) {
          try {
            const r = await entryPage();
            const platform = (r && r.ok && r.body) ? detectPlatform(r.body, r.headers) : null;
            if (PLATFORMS_WITH_DEFAULT.has(platform)) {
              emit('recipe', { known: false, free: true, cost: `gratuit (plateforme ${platform})` });
              const httpGet = recipeGet;
              let lane;
              try { lane = await platformDefaultLane(meta.origin, { httpGet, platform, maxProducts: cfg.maxProducts, maxPages: cfg.maxPages, onStep }); }
              catch (e) { lane = { ok: false, products: [], pages: 0, error: String((e && e.message) || e) }; }
              if (lane.ok && lane.products.length) {
                paginationReport = { mechanism: 'platform-feed', pages: lane.pages, totalAnnounced: null, stoppedBy: null, warnings: [] };
                await completeFromDetailPages(lane.products);
                ingestRecipeProducts(lane.products, `platform-${platform}`, lane.pages, `platform default (${platform}): ${lane.products.length} product(s), ${lane.pages} page(s) — gratuit${lane.outsideCount ? ` ; ${lane.outsideCount} produit(s) renvoyé(s) hors de cette collection écarté(s) : ${lane.outside.slice(0, 5).map((o) => o.name).join(', ')}` : ''}`);
                handledByRecipe = true;
              }
            }
          } catch { /* best-effort — fall through to discovery */ }
        }
      }
      if (!handledByRecipe) {
      // Discovery (skipped on resume when already discovered).
      if (!job.discovered.length) {
        job.setStatus('discovering'); emit('phase', { phase: 'discovering' });
        if (meta.origin) {
          // 4e — profile-FIRST: the domain's memory is consulted BEFORE exploring.
          // A known host reports what worked last time (method, product count, and
          // whether it needed a browser or the paid unlock) so a repeat run doesn't
          // re-derive everything, and the hints steer discovery (sitemaps to try
          // first, browser sooner). Advisory only — the free ladder still runs, so a
          // stale profile costs a little time, never correctness. Generic: keyed on
          // the host's learned behaviour, never on a site name.
          const prof = profiles.get(meta.origin);
          const hints = profiles.hints(meta.origin);
          if (prof) emit('profile', { known: true, host: prof && (prof.host || undefined), method: hints.knownMethod, needsBrowser: !!prof.needsBrowser, needsUnlock: !!prof.needsUnlock, blockedBy: prof.blockedBy || null, lastProductCount: prof.lastProductCount ?? null, runs: prof.runs || 0, updatedAt: prof.updatedAt || null });
          // KNOWN-PROTECTED short-circuit: a host the profile already learned needs the
          // paid unlock (DataDome/Cloudflare, no free recipe) must NOT be re-explored for
          // free — the free ladder would render every sitemap URL through the browser
          // (blocked each time) for minutes before giving up. One cheap HTTP probe: if it
          // still classifies as a terminal block, skip discovery + scrape and route
          // straight to the unlock offer. If the site opened up (probe not blocked), fall
          // through to the normal free ladder. Generic: driven by the learned profile, not
          // a site name. See memory recipe-producer-sync-priority / Levi's diagnosis.
          let knownProtected = false;
          if (prof && prof.needsUnlock && !hints.internalApi && !hints.manualSelectors) {
            emitStep('recipeCheck');
            let probe = null;
            try { const r = await entryPage(); probe = classifyResponse({ status: r.status, headers: r.headers, body: r.body, url: r.url, requestedUrl: meta.origin, error: r.error }); }
            catch (e) { probe = classifyResponse({ status: 0, error: String((e && e.message) || e) }); }
            if (probe && probe.terminal) {
              knownProtected = true;
              emitStep('protected');
              discReport = { method: 'known-protected', diagnosis: 'needs-unlock', stopped: { code: probe.code, reason: probe.reason, url: meta.origin }, blockedBy: probe.code };
              job.setDiscovered([]);
              emit('discovered', { total: 0, http: 0, browser: 0, method: 'known-protected', context: null });
            }
          }
          if (!knownProtected) {
          // "auto" still undecided after the entry page: discovery keeps recognising
          // (a video sitemap, the first page it reads) and says what it found.
          const discType = contentType.requested === 'auto' && contentType.type !== 'video' ? 'auto' : contentType.type;
          const disc = await discoverProducts(fetcher, meta.origin, { maxProducts: cfg.maxProducts, maxPages: cfg.maxPages, maxDepth: cfg.maxDepth, maxBrowserPages: cfg.maxBrowser, getBrowser, recovery: cfg.recovery, sitemapHints: hints.sitemapHints, preferBrowser: hints.preferBrowser, csrFewThreshold: cfg.csrFewThreshold, contentType: discType, prefetched: (entryRes && entryRes.ok) ? { url: meta.origin, r: entryRes } : null, onStep });
          if (discType === 'auto' && disc.report.contentType === 'video') {
            contentType.type = 'video'; contentType.detected = 'video';
            const how = disc.report.contentTypeDetected || {};
            contentType.signals = how.signals || (how.entries ? [`sitemap_videos:${how.entries}`] : []);
            emit('contentType', { ...contentType });
          }
          job.setDiscovered(disc.urls); discReport = disc.report; discSeeds = disc.seeds || null; discCards = Array.isArray(disc.cardsWithoutUrl) && disc.cardsWithoutUrl.length ? disc.cardsWithoutUrl : null;
          emit('discovered', { total: disc.urls.length + (discCards ? discCards.length : 0), http: (disc.report.httpProductUrls ?? disc.urls.length) + (discCards ? discCards.length : 0), browser: disc.report.browserProductUrls ?? 0, method: disc.report.method, context: disc.report.context || null });
          }
        } else {
          job.setDiscovered(meta.urls || []);
          emit('discovered', { total: (meta.urls || []).length, http: (meta.urls || []).length, browser: 0, method: 'provided URLs' });
        }
      }

      job.setStatus('running'); emit('phase', { phase: 'running' });
      const remaining = job.remaining();

      // Nothing to process (e.g. discovery was blocked and found no product URLs)
      // → don't run the scraper over an empty set; keep a clean empty report so the
      // finalization reports the discovery diagnosis honestly (not a spurious error).
      if (!remaining.length && !discCards) {
        const dg = discReport?.stopped ? discReport.stopped.code : (discReport?.diagnosis && discReport.diagnosis !== 'ok' ? discReport.diagnosis : 'ok');
        report = { store: meta.store || '', contentType: { ...contentType }, status: dg, discovered: job.discovered.length, fetched: 0, detected: 0, normalized: 0, accepted: 0, toVerify: 0, excluded: 0, incomplete: 0, notAProductPage: 0, duplicates: 0, networkErrors: 0, parseErrors: 0, browserRequired: 0, browserUsed: 0, sitemapsRead: [], durationMs: 0, remaining: 0, notes: [], errors: [] };
      } else {
        ({ report } = await runScrape({
          store: { slug: meta.store || '' },
          urls: remaining, seeds: discSeeds, cardsWithoutUrl: discCards || undefined,
          fetcher, // reuse the controller's fetcher (UA + rate-limit) — and the injected one in tests
          concurrency: cfg.workers, maxBrowser: cfg.maxBrowser, breaker: cfg.breaker, deniedStreak: cfg.deniedStreak,
          timeoutMs: cfg.timeoutMs, renderTimeoutMs: cfg.renderTimeoutMs, // 4d — per-page render budget (Settings-bounded)
          recovery: cfg.recovery, // F1/F2 recovery + F3.1 browser escalation (ON by default)
          pageRules: (readJson(dirs.configFile) || {}).pageRules, // shared product-page rules overrides (config.json)
          // Content type (shared/content): the reader, and the "sample first" size for its listed cards.
          contentType: contentType.type, contentTypeRequested: contentType.requested, contentTypeDetected: contentType.detected,
          detailSample: Number((cfg.detailPages || {}).sample) || 3,
          // What the site was taught (🎯 / detection): read on every product page of the run.
          knowledge: knowledge.forEngine(meta.origin),
          onProductPage: (u, html) => enginePages.keep(u, { ok: true, html }),
          // A video run without a typed product type is declared "video" (the CSV's product_type cell).
          defaultProductType: meta.productType || (contentType.type === 'video' ? 'video' : null), categorySlug: meta.categorySlug || null, lang: meta.lang || 'fr',
          useBrowser: browserEnabled ? undefined : false,
          interactive: !!meta.intervene,
          getBrowserSession: getBrowser,
          control,
          onProduct: (np) => { job.addProduct(np); flushMaybe(); emit('product', { name: np.name || '(sans nom)', price: np.price, status: np.__eligibility?.status || 'to_verify', image: !!np.image_url }); emitCounters(); },
          onProcessed: (url) => { job.markProcessed(url); flushMaybe(); },
          onProgress: (n, t) => emit('progress', { done: n, total: t }),
        }));
        // Pages re-read for a repair / a first discovery go through THIS job's fetcher (same identity, pacing, cookies).
        const jobPage = async (u) => { try { const r = await fetcher.get(u); return { ok: !!(r && r.ok && r.body), html: r && r.body }; } catch { return { ok: false }; } };
        { const rr = await repairAfterRun(meta.origin, recordKnowledgeOutcomes(meta.origin, report), enginePages.m, jobPage); if (rr) repairReport = rr; }
        if (!onboardReport && job.products.length) onboardReport = await onboardAfterRun(meta.origin, enginePages.m, job.products);
        // The job's own product limit (the form's "max products") bounded the run: say so.
        if (report && cfg.maxProducts && job.products.length >= cfg.maxProducts && !report.productLimit) {
          report.productLimit = { max: cfg.maxProducts, kept: job.products.length };
          report.notes = report.notes || []; report.notes.push(`product limit reached (${cfg.maxProducts}, the form's maximum)`);
        }
      }
      } // end !handledByRecipe (recipe lane already produced the catalogue)

      // UNLOCK escalation tiers — last resort when every FREE lane (HTTP + local
      // browser + nodriver) was anti-bot-blocked and produced nothing. Two GENERIC,
      // strictly opt-in providers: FIRECRAWL (v0.5.6 — native wait-for-selector
      // hydration, opt-in via config.firecrawl.domains) and BRIGHT DATA Web Unlocker
      // (v0.5.5 — opt-in via config.brightData.domains). Inert by default → no smoke
      // change, no credit spend, never a per-site branch in the engine. Products are
      // extracted with a shared cascade: embedded-state (simple product[] shapes) →
      // generic SPA state (Next/Nuxt/Redux/Apollo, core/spa-state.mjs) → the
      // provider's markdown as a last resort.
      // Never a paid call after a Stop (user or stall heartbeat).
      // Freeze what the FREE lanes produced, for the 'local' ledger line.
      localProducts = job.products.length;
      localRoute = (report && (report.method || (report.discovery && report.discovery.method))) || (discReport && discReport.method) || null;
      if (!handledByRecipe && job.products.length === 0 && meta.origin && !control.stopped) {
        try {
          const host = hostKey(meta.origin);
          // Provider gate (admin panel): inject creds for AVAILABLE providers and
          // withhold them for disabled/kill/capped/domain-off ones, so the lanes
          // below make no billable call. No-op when the feature is off.
          const rawCfg = readJson(dirs.configFile);
          const appCfg = buildProviderCfg(rawCfg, { runtime: providerRuntime, secureStore, host });
          const fc = firecrawlConfig(appCfg); const fcCfg = (appCfg && appCfg.firecrawl) || {};
          const bd = (appCfg && appCfg.brightData) || {}; const wu = webUnlockerConfig(appCfg);
          const sb = scrapingBrowserConfig(appCfg);
          // One decision per direct paid route, from the same facts the lanes use:
          // credentials present, persisted opt-in (config lists) OR the admin's
          // per-launch test mode, and the admin gate (kill switch / off / caps).
          // Each refusal is written to the usage ledger, so "was it called or
          // blocked?" always has an answer.
          const laneOn = { firecrawl: fc.configured, webUnlocker: wu.configured, scrapingBrowser: sb.configured };
          const resolveIo = { secure: secureStore ? secureStore.getAll() : {}, config: rawCfg, env: process.env };
          const decide = PAID_ROUTES.map((r) => {
            const gate = providerRuntime ? providerRuntime.availabilityReason(r.runtimeId, host) : null;
            const configured = laneOn[r.key] || (providerRuntime ? providerConfigured(r.runtimeId, resolveIo) : false);
            const optedIn = isOptedIn(appCfg, r.key, host);
            const tm = !!(testMode && testMode[r.key]);
            return { ...r, optedIn, tm, d: routeDecision({ configured, optedIn, testMode: tm, gateReason: gate === 'not_configured' ? null : gate }) };
          });
          // Fire whenever an EXPLICITLY opted-in host produced 0 free products —
          // whether it hard-blocked (Colruyt 456) or returned a 200 CSR shell with no
          // data (Nike). Opt-in is per-domain in config, so the user has already
          // accepted the paid call for these hosts; non-configured hosts never reach here.
          //
          // v0.5.33 — the allowed routes are tried IN ORDER until one yields products:
          // Firecrawl → Web Unlocker → Scraping Browser (LAST — most capable full-browser
          // render, most expensive: GB + hourly runtime), the route that worked last time
          // for this host first (profile.unlockRoute). At most `escalation.maxRoutesPerPage`
          // attempts for the page, each within `escalation.routeTimeoutMs`. Every attempt
          // and every refusal is a ledger line; opt-in, caps, the kill switch and the
          // per-site switch hold for each route and are re-checked right before each call
          // (the previous attempt may have reached a cap). At most ONE billed Scraping
          // Browser session per job: a recipe bootstrap that already opened one (and still
          // produced nothing) is not followed by a second, full-render session.
          const esc = cfg.escalation || {};
          const maxRoutes = Math.max(1, Number(esc.maxRoutesPerPage) || 3);
          const routeTimeoutMs = Math.max(1000, Number(esc.routeTimeoutMs) || 120000);
          const LANE = { firecrawl: 'firecrawl', webUnlocker: 'web-unlocker', scrapingBrowser: 'scraping-browser' };
          const remembered = (() => { try { const p = profiles.get(meta.origin); return (p && p.unlockRoute) || null; } catch { return null; } })();
          const order = decide.map((x, i) => ({ x, i })).sort((a, b) => ((LANE[b.x.key] === remembered) - (LANE[a.x.key] === remembered)) || (a.i - b.i)).map((e) => e.x);
          const learnedSel = profiles.hints(meta.origin).hydrationSelector;
          // Firecrawl may hand back a copy of the page it already holds (v2 `maxAge`):
          // config.firecrawl.maxAgeMs, 1 h by default. A host whose last Firecrawl page
          // gave no product asks for a fresh page: the same copy would give none again.
          const cacheBypass = (() => { try { const p = profiles.get(meta.origin); return !!(p && p.unlockCacheBypass); } catch { return false; } })();
          const fcMaxAge = cacheBypass ? 0 : firecrawlMaxAge(appCfg);
          // One route call (the lane's own timeout applies; bytes and session counters are
          // accounted here, even when the chain has already moved on).
          const runRoute = async (x) => {
            let res, html = null, markdown = null;
            if (x.key === 'firecrawl') {
              emitStep('firecrawl');
              const waitSelector = (fcCfg.selectors && fcCfg.selectors[host]) || learnedSel || undefined;
              const actions = fcCfg.actions && fcCfg.actions[host];
              const headers = fcCfg.headers && fcCfg.headers[host]; // per-host session/store cookie, from config
              res = await firecrawlScrape(meta.origin, { apiKey: fc.apiKey, waitSelector, actions, headers, waitMs: fcCfg.waitMs, proxy: fcCfg.proxy, country: fcCfg.country, maxAge: fcMaxAge, timeoutMs: routeTimeoutMs });
              html = res.html; markdown = res.markdown;
              laneBytes.firecrawl = (laneBytes.firecrawl || 0) + (res.bytes || 0);
            } else if (x.key === 'webUnlocker') {
              emitStep('webUnlocker');
              const expect = (bd.selectors && bd.selectors[host]) || learnedSel || undefined;
              res = await webUnlockerFetch(meta.origin, { apiKey: wu.apiKey, zone: wu.zone, country: wu.country, expect, timeoutMs: routeTimeoutMs });
              html = res.html;
              laneBytes.unlocker = (laneBytes.unlocker || 0) + (res.bytes || 0);
            } else {
              emitStep('scrapingBrowser');
              const waitSelector = (bd.scrapingBrowserSelectors && bd.scrapingBrowserSelectors[host]) || learnedSel || undefined;
              const country = bd.scrapingBrowserCountry && bd.scrapingBrowserCountry[host]; // per-host geo, from config
              const sbHost = country ? scrapingBrowserConfig(appCfg, undefined, { country }) : sb;
              // Per-host resource-blocking override (e.g. a site whose challenge needs images);
              // default = the shared image/media/font cost-control set.
              const blockList = bd.scrapingBrowserBlock && bd.scrapingBrowserBlock[host];
              const blockTypes = Array.isArray(blockList) ? new Set(blockList) : undefined;
              res = await scrapingBrowserRender(meta.origin, { cdpUrl: sbHost.cdpUrl, waitSelector, connect: scrapingBrowserConnect, timeoutMs: routeTimeoutMs, ...(blockTypes ? { blockTypes } : {}) });
              if (res.note !== 'not_configured') sbSessions += 1;
              if (res.captcha) report.scrapingBrowserCaptcha = res.captcha;
              html = res.html;
              laneBytes.scrapingBrowser = (laneBytes.scrapingBrowser || 0) + (res.bytes || 0);
              if (res.runtimeSec != null) laneRuntime.scrapingBrowser = (laneRuntime.scrapingBrowser || 0) + res.runtimeSec;
            }
            return { res, html, markdown };
          };
          // The page's time budget per route: a route still silent after it is recorded
          // as a timeout and the chain moves on (the late answer is ignored).
          const withDeadline = (p, ms) => new Promise((resolveDl) => {
            const t = setTimeout(() => resolveDl({ res: { ok: false, status: 0, html: null, bytes: 0, error: `route timeout after ${ms} ms`, note: 'timeout' }, html: null, markdown: null }), ms);
            p.then((v) => { clearTimeout(t); resolveDl(v); }, (e) => { clearTimeout(t); resolveDl({ res: { ok: false, status: 0, html: null, bytes: 0, error: String((e && e.message) || e) }, html: null, markdown: null }); });
          });
          const chain = []; let tried = 0; let won = false;
          const refuse = (x, outcome, reason) => { jm.record({ provider: x.provider, route: 'escalation', attempted: false, outcome, reason }); chain.push({ provider: LANE[x.key], attempted: false, outcome, reason }); };
          for (const x of order) {
            if (!x.d.allowed) {
              // A route nobody configured nor asked for is noise; everything else is recorded.
              if (x.d.reason === 'not_configured' && !x.optedIn && !x.tm) continue;
              refuse(x, x.d.outcome, x.d.reason); continue;
            }
            if (!laneOn[x.key]) continue; // allowed on paper, no usable credentials in the lane config
            if (x.key === 'scrapingBrowser' && sbSessions > 0) { refuse(x, 'skipped', 'one_session_per_job'); continue; }
            if (won) { jm.record({ provider: x.provider, route: 'escalation', attempted: false, outcome: 'skipped', reason: 'priority' }); continue; }
            if (tried >= maxRoutes) { refuse(x, 'skipped', 'max_routes'); continue; }
            if (control.stopped) { refuse(x, 'skipped', 'stopped'); continue; }
            if (tried > 0 && providerRuntime) {
              const g = providerRuntime.availabilityReason(x.runtimeId, host);
              if (g === 'cap_reached') { refuse(x, 'blocked_by_cap', 'cap_reached'); continue; }
              if (g && g !== 'not_configured') { refuse(x, 'skipped', g); continue; }
            }
            tried += 1;
            const provider = LANE[x.key];
            const callT0 = Date.now();
            const { res, html, markdown } = await withDeadline(runRoute(x), routeTimeoutMs);
            const unlockInfo = { provider, attempted: true, ok: !!res.ok, note: res.note || null, error: res.error ? String(res.error).slice(0, 240) : null, bytes: res.bytes || 0, ...(res.runtimeSec != null ? { runtimeSec: res.runtimeSec } : {}) };
            const callMs = res.runtimeSec != null ? Math.round(res.runtimeSec * 1000) : Date.now() - callT0;
            let cards = []; let cardsRead = 0;
            if (res.ok && (html || markdown)) {
              if (html) { cards = extractEmbeddedProducts(html, meta.origin).cards || []; if (!cards.length) cards = extractSpaProducts(html, meta.origin, { max: cfg.maxProducts }).products || []; }
              if (!cards.length && markdown) cards = extractMarkdownProducts(markdown, meta.origin, { max: cfg.maxProducts }).products || [];
              cardsRead = cards.length;
              if (cards.length > cfg.maxProducts) cards = cards.slice(0, cfg.maxProducts);
              if (cards.length) {
                ingestRecipeProducts(cards, provider, 1, `${provider}: ${cards.length} produit(s) — déblocage assisté`);
                // The job's own product limit (the form's "max products") cut the page: say
                // so in the report and in the admin job view — the page had more.
                if (cardsRead > cards.length) { report.productLimit = { max: cfg.maxProducts, read: cardsRead, kept: cards.length }; report.notes.push(`product limit reached (${cfg.maxProducts}, the form's maximum): ${cardsRead} card(s) read on the page, ${cards.length} kept`); }
                // Remember the route that worked for this host: next time it goes first,
                // and the known-protected fast path skips the free exploration.
                try { profiles.record(meta.origin, { method: provider, productCount: job.products.length, needsUnlock: true, unlockRoute: provider, ...(x.key === 'firecrawl' ? { unlockCacheBypass: false } : {}) }); } catch { /* best-effort */ }
                won = true;
              }
            }
            // After the ingest (which rebuilds `report`), so the last attempt survives
            // in report.json: the route that delivered, or the last one that failed.
            report.unlock = unlockInfo;
            // Usage ledger + caps (one step, in the meter). Only a real (non
            // "not_configured") billable attempt counts against the caps.
            const attempted = res.note !== 'not_configured';
            // A Firecrawl page with no product: the next run asks for a fresh page.
            if (x.key === 'firecrawl' && attempted && cards.length === 0 && (html || markdown) && !cacheBypass) { try { profiles.record(meta.origin, { unlockCacheBypass: true }); } catch { /* best-effort */ } }
            // A page that came back without any product is `empty`: billed, recorded as
            // such, and not a success — the chain moves on to the next allowed route.
            const base = attempted ? paidOutcome(res) : 'skipped';
            const outcome = base === 'success' && cards.length === 0 ? 'empty' : base;
            const reason = res.ok ? (x.d.reason === 'test_mode' ? 'test_mode' : null) : paidReason(res);
            jm.record({
              provider: x.provider, route: 'escalation', attempted, outcome, reason,
              bytes: res.bytes || 0, durationMs: callMs, products: cards.length,
              credits: res.credits != null && Number.isFinite(Number(res.credits)) ? Number(res.credits) : null,
              cacheState: res.cacheState || null,
            });
            chain.push({ provider, attempted, outcome, reason, products: cards.length, bytes: res.bytes || 0, ms: callMs, ...(res.note === 'timeout' ? { timedOut: true } : {}), ...(res.cacheState ? { cacheState: res.cacheState } : {}) });
          }
          // Admin-only journal (report.json → Administration › Utilisation › job): the
          // routes in the order they were considered, with each outcome.
          if (chain.length) report.unlockChain = chain;
        } catch { /* best-effort — the escalation never breaks a run */ }
      }

      // PRODUCER (2b, NO AI): a free DOM/listing run with no recipe yet → derive a
      // manual_selectors recipe from the origin page and store it, validated by a
      // ≥3-product preview. The NEXT run (and other users, once synced) replay it
      // for free — one understanding, no per-product cost. Best-effort, never fatal.
      // A product-selector recipe is a product notion: a video run derives none.
      if (!handledByRecipe && contentType.type !== 'video' && meta.origin && job.products.length > 0
          && !profiles.hints(meta.origin).internalApi && !profiles.hints(meta.origin).manualSelectors) {
        try {
          let html = null;
          const r = await fetcher.get(meta.origin);
          if (r.ok && r.body) html = r.body;
          if (!html || !deriveSelectorRecipe(html, meta.origin)) {
            const s = await getBrowser(); if (s) { const rr = await s.render(meta.origin); if (rr && rr.html) html = rr.html; }
          }
          const recipe = html ? deriveSelectorRecipe(html, meta.origin, 'auto-discovery') : null;
          if (recipe && applySelectorRecipe(html, recipe, meta.origin).length >= 3) {
            profiles.record(meta.origin, { manualSelectors: recipe });
            emit('recipe:learned', { kind: 'manual-selectors', fields: Object.keys(recipe.fields), pagination: recipe.pagination && recipe.pagination.mode });
            // 2b SYNC (push) — upload the derived recipe as a shared candidate.
            try { const client = edgeClientFor(readJson(dirs.configFile)); if (client.isConfigured()) client.pushRecipe(new URL(meta.origin).hostname.replace(/^www\./, ''), { manual_selectors: recipe, fields_available: Object.keys(recipe.fields || {}) }).catch(() => {}); } catch { /* best-effort */ }
          }
        } catch { /* best-effort — producing a recipe never breaks a run */ }
      }
    } catch (err) {
      // A block/network error mid-run must NOT throw away the products already
      // collected. Capture it; the finalization below still writes the CSV from
      // whatever is in the job, and the status carries the reason.
      runError = err;
    } finally {
      // Whatever lane produced the products: the listing's category trail for those
      // whose page has none, then stock per size + reviews when the product pages
      // load them with their own requests (learned on one page, asked for all).
      // Still under the watchdog (a hang here ends as 'stalled').
      if (!control.stopped && job.products.length) { try { await completeProductContext(); } catch { /* best-effort: the products stand */ } }
      if (_bs) { try { await _bs.close(); } catch { /* ignore */ } }
      clearInterval(heartbeat);
    }
    report = report || {};
    if (discReport) report.discovery = discReport;
    if (trailReport) report.categoryTrail = trailReport;
    if (sideReport) report.sideData = sideReport;
    if (browserPages && browserPages.stats.pages) { report.pagesViaBrowser = browserPages.stats.pages; report.browserPagesStop = browserPages.stats.stoppedBy; report.browserPagesNotRead = browserPages.stats.notRead || 0; }
    // The fixed values saved for this page in the panel (site profile + the batch of this list page), stamped on
    // every product: a job of the men's list never gets the women's collection or type.
    try {
      const h = meta.origin ? profiles.hints(meta.origin) : null;
      const fixed = h ? storedConstantsFor({ site: h.siteValues, batches: h.listBatches }, meta.origin, { productType: meta.productType }) : [];
      if (fixed.length && job.products.length) {
        for (const np of job.products) applyConstantsToProduct(np, fixed);
        report.columns = [...(Array.isArray(report.columns) ? report.columns : []), ...constantColumns(fixed)].filter((c, i, all) => all.findIndex((x) => x.key === c.key) === i);
        report.fixedValues = { from: 'saved', batch: batchKeyOf(meta.origin), values: fixed.map((c) => ({ key: c.key, value: c.value, mode: c.mode })) };
      }
    } catch { /* the products stay as read */ }
    job.flush();

    // Outputs (CSV accepted + to-verify + reports) — ALWAYS written, even on a
    // block/error, so partial results are delivered rather than lost.
    const accepted = job.products.filter((p) => p.__eligibility?.status === 'accepted');
    const toVerify = job.products.filter((p) => p.__eligibility?.status === 'to_verify');

    // Bytes downloaded (Item 6) — total on-the-wire bandwidth for the job, split by
    // lane, plus the average per ACCEPTED product. Written to report.json/report.txt
    // and surfaced on the completion event so the smoke panel can show it. This is
    // the real cost signal to weigh before connecting any per-GB proxy/unlocker.
    const httpBytes = (fetcher.stats?.bytes || 0) + (laneBytes.recipe || 0);
    const browserBytes = (_bs && _bs.stats?.bytes) || 0;
    const unlockerBytes = laneBytes.unlocker || 0; // Bright Data Web Unlocker lane (per-GB billed)
    const firecrawlBytes = laneBytes.firecrawl || 0; // Firecrawl lane (per-request/credit billed)
    const scrapingBrowserBytes = laneBytes.scrapingBrowser || 0; // Bright Data Scraping Browser (GB + hourly runtime)
    const totalBytes = httpBytes + browserBytes + unlockerBytes + firecrawlBytes + scrapingBrowserBytes;
    report.bytesDownloaded = { total: totalBytes, http: httpBytes, browser: browserBytes, unlocker: unlockerBytes, firecrawl: firecrawlBytes, scrapingBrowser: scrapingBrowserBytes };
    // Scraping Browser session runtime (seconds) — a distinct cost axis. Taken from
    // the run-scoped accumulator (bootstrap + render tier): a successful ingest
    // rebuilds `report`, which used to drop report.unlock.runtimeSec.
    if (laneRuntime.scrapingBrowser != null) report.scrapingBrowser = { runtimeSec: Math.round(laneRuntime.scrapingBrowser * 10) / 10 };
    else if (report.unlock && report.unlock.provider === 'scraping-browser' && report.unlock.runtimeSec != null) report.scrapingBrowser = { runtimeSec: report.unlock.runtimeSec };
    if (recipeBootstrapDiag) report.recipeBootstrap = recipeBootstrapDiag;
    if (selectorRecipeDiag) report.selectorRecipe = selectorRecipeDiag;
    if (recipeLaneDiag) report.recipeLane = recipeLaneDiag;
    // The entry URL's page filter was not applied by the known recipe → the page was
    // read directly instead. Surfaced so a filtered listing is never silently widened.
    if (recipeFilterUnhonoured && recipeFilterUnhonoured.length) {
      report.recipeFilterUnhonoured = { facets: recipeFilterUnhonoured };
      report.notes = report.notes || [];
      report.notes.push(`entry URL filter (${recipeFilterUnhonoured.join(', ')}) not readable by the site recipe — read the page directly instead of the whole category`);
    }
    // Listing pagination (mechanism, pages read, announced total, warnings) and
    // product-page completion (visited / completed / failed + reasons).
    if (paginationReport) report.pagination = paginationReport;
    else if (discReport && discReport.pagesCrawled) report.pagination = { mechanism: 'crawl', pages: discReport.pagesCrawled, totalAnnounced: null, stoppedBy: null, warnings: [] };
    if (detailReport) report.detailPages = detailReport;
    // Rejected image addresses and corrected product addresses (the engine's own report carries them already;
    // a recipe lane's report takes the lane's), the taught rules that failed this run, then an honest status:
    // rows to verify or product pages left unread make the run PARTIAL, never OK.
    if (!report.images) attachDiagnostics(report, laneDiag);
    if (laneInvalidated && laneInvalidated.length) report.knowledgeInvalidated = laneInvalidated;
    applyPartialStatus(report);
    // Self-healing and AI use of this run (the AI is called only for a first discovery, a repair, a chat).
    if (repairReport) { report.knowledgeRepair = repairReport; if (Array.isArray(report.notes)) report.notes.push(...repairNotes(repairReport)); }
    if (onboardReport) { report.onboarding = onboardReport; if (Array.isArray(report.notes)) report.notes.push(...onboardingNotes(onboardReport)); }
    report.aiCalls = { discovery: (onboardReport && onboardReport.aiCalls) || 0, repair: (repairReport && repairReport.aiCalls) || 0, chat: 0 };
    // Product pages only the user's browser can read: say so, with the way to complete them.
    { const nbNote = needsBrowserNote(detailReport); if (nbNote && Array.isArray(report.notes)) report.notes.push(nbNote); }
    if (detailReport && detailReport.reasons && detailReport.reasons.needs_user_browser && Array.isArray(report.notes)) report.notes.push(`${detailReport.reasons.needs_user_browser} fiche(s) produit non lue(s) : ce site ne laisse lire ses fiches que dans votre navigateur. Relancez avec le mode « Votre navigateur » pour les compléter.`);
    report.bytesPerAcceptedProduct = accepted.length ? Math.round(totalBytes / accepted.length) : null;
    // The whole run, completion included (a listing lane builds its report before
    // the product pages are read).
    if (!(report.durationMs > 0) || report.durationMs < Date.now() - execStartedAt) report.durationMs = Date.now() - execStartedAt;

    const exportStart = Date.now();
    fs.writeFileSync(job.paths.csv, toImportCsv(accepted, { storeSlug: meta.store, categorySlug: meta.categorySlug }), 'utf8');
    if (toVerify.length) fs.writeFileSync(job.paths.csv.replace(/\.csv$/, '-to-verify.csv'), toImportCsv(toVerify, { storeSlug: meta.store, categorySlug: meta.categorySlug }), 'utf8');
    stepMs.exportMs += Date.now() - exportStart;
    finishJobReport(job, report, meta.origin, { app: appTimings(stepMs, browserPages, report.durationMs), totalMs: report.durationMs });
    fs.writeFileSync(job.paths.reportJson, JSON.stringify(report, null, 2));
    fs.writeFileSync(job.paths.reportTxt, `Job ${job.id}\n\n${formatReport(report)}\n`);

    // Honest terminal status. A discovery that was blocked and produced no
    // products is reported as blocked (not a misleading "done"/"error"); a
    // mid-run error keeps its products but is flagged 'error' with the reason.
    // Who stopped the job: the user (Stop button) or the watchdog (no progress).
    const stalled = control.stopped && control.stopReason === 'stalled';
    const stoppedByUser = control.stopped && !stalled;
    if (stalled) { report.stopReason = 'stalled'; report.stall = { afterMs: stallMs }; report.notes = report.notes || []; report.notes.push(`stopped by the watchdog: no progress for ${Math.round(stallMs / 1000)} s (products read so far are kept)`); }
    const discStop = report.discovery?.stopped || null;
    const effBlocked = report.blocked || (job.products.length === 0 ? discStop : null);
    // Products obtained through an unlock: the free lanes' block is no longer the
    // run's outcome (a done job must not read "accès refusé").
    const unlocked = localProducts === 0 && job.products.length > 0;
    const reason = stalled ? `aucune progression pendant ${Math.round(stallMs / 1000)} s — job arrêté, produits déjà lus gardés` : (unlocked ? '' : jobReason(report, runError && String(runError.message || runError)));
    let status;
    if (stalled) status = 'stopped:stalled';
    else if (stoppedByUser) status = 'interrupted';
    else if (runError && job.products.length === 0) status = 'error';
    else if (effBlocked) status = `stopped:${effBlocked.code}`;
    else status = 'done';

    // QUALITY GATE (Part 2) — the engine judges its own output. A run that produced
    // rows but no real data (0 accepted, empty names, the listing page saved as a
    // product, seeds whose fiches were never fetched — the Colruyt "196 empty
    // shells, status ok" bug) must NOT end as a silent success. Thresholds are
    // config (cfg.quality), editable via config.json, never constants. On failure
    // the run is flagged low-quality and the UI surfaces "Apprendre cette page";
    // the outcome is recorded so the next run knows this strategy failed.
    let qualityFailures = [];
    if (status === 'done' && job.products.length > 0) {
      try {
        const signals = measureRunQuality({ ...report, origin: meta.origin }, job.products);
        const verdict = judgeRunQuality(signals, cfg.quality);
        if (!verdict.ok) { qualityFailures = verdict.failures; status = 'stopped:low_quality'; report.qualityFailures = qualityFailures; report.qualitySignals = signals; }
      } catch { /* the gate must never break finalize */ }
    }
    const qReason = qualityFailures.length ? `résultat de faible qualité (${qualityFailures.join(', ')}) — “Apprendre cette page” recommandé` : reason;
    job.setStatus(status, { report: { ...report, resumeUrls: undefined }, error: runError ? String(runError.message || runError) : undefined, reason: qReason });
    emitCounters(true);
    // Usage ledger: what the FREE lanes did for this job (one line, after any paid
    // lines). Products = what the free lanes found before any paid escalation.
    {
      const free = localProducts != null ? localProducts : job.products.length;
      const route = localRoute || report.method || (report.discovery && report.discovery.method) || (Array.isArray(meta.urls) && meta.urls.length ? 'provided-urls' : 'crawl');
      const why = stalled ? 'stalled' : stoppedByUser ? 'stopped_by_user' : (effBlocked && effBlocked.code) || (runError ? 'error' : (report.discovery && report.discovery.diagnosis && report.discovery.diagnosis !== 'ok' ? report.discovery.diagnosis : null));
      // ts = job start: the free lanes always run first, so the route chain reads in order.
      jm.record({ ts: new Date(execStartedAt).toISOString(), provider: 'local', route: browserBytes > 0 ? `${route}+browser` : route, channel: 'local', attempted: true, outcome: stoppedByUser ? 'skipped' : (free > 0 ? 'success' : 'failed'), reason: stalled ? 'stalled' : (free > 0 && !stoppedByUser ? null : (why || 'no_products')), products: free, bytes: httpBytes + browserBytes, durationMs: Date.now() - execStartedAt });
    }
    emit('done', {
      jobId: job.id, status, stoppedByUser, stalled, ...(stalled ? { stallMs } : {}), error: runError ? String(runError.message || runError) : null,
      reason: qReason, diagnosis: qualityFailures.length ? 'low-quality' : (report.discovery?.diagnosis || null),
      method: report.method || report.discovery?.method || null,   // extraction/discovery strategy, surfaced on the completion screen
      context: report.discovery?.context || null,
      contentType: report.contentType || null,                      // { type, requested, detected } — "vidéos" on the completion screen
      qualityFailures, needsTeach: qualityFailures.length > 0,      // surface "Apprendre cette page" on a low-quality result
      blocked: effBlocked || null, listingBlocked: (effBlocked && report.discovery && report.discovery.listingBlocked) || null, remaining: report.remaining || 0,
      counts: counters(job), durationMs: report.durationMs,
      bytesDownloaded: report.bytesDownloaded, bytesPerAcceptedProduct: report.bytesPerAcceptedProduct, scrapingBrowser: report.scrapingBrowser || null,
      pagination: report.pagination || null, detailPages: report.detailPages || null, sideData: report.sideData || null, categoryTrail: report.categoryTrail || null, pagesViaBrowser: report.pagesViaBrowser || 0, browserPagesStop: report.browserPagesStop || null,
      csvPath: job.paths.csv, reportPath: job.paths.reportTxt,
      csvToVerify: toVerify.length ? job.paths.csv.replace(/\.csv$/, '-to-verify.csv') : null,
    });
    // A free run of the app read this site's list itself: the app is its reader again (the user's browser is not needed).
    recordProfile(meta.origin || (Array.isArray(meta.urls) && meta.urls[0]) || null, report, job, { listAccess: job.products.length ? 'app' : ((report && (report.blocked || (report.discovery && report.discovery.stopped))) ? null : undefined) });

    // Assisted-unlock OFFER (never auto-run): a totally blocked source with no
    // products gets an estimated cost so the user can confirm the cascade. The
    // free local result already stands; this only adds a one-line proposal.
    if (effBlocked && job.products.length === 0 && meta.origin) {
      try {
        const client = edgeClientFor(readJson(dirs.configFile));
        if (client.isConfigured()) {
          client.estimate(meta.origin, 1).then(async (est) => {
            emit('unlock:offer', { url: meta.origin, estimate: describeEstimate(est, await currentRate()) });
          }).catch(() => { /* best-effort */ });
        }
      } catch { /* best-effort */ }
    }
    active = null;
    return { jobId: job.id, report };
  }

  return {
    /** Site knowledge: learn / propose / summary / retire (see app/knowledge-service.mjs). */
    knowledge,
    /** The side panel's chat agent (see app/ai/agent.mjs). */
    agent,
    /** input: { origin?, urls?, store?, productType?, categorySlug?, lang?, browser?, intervene?, provider?, userAgent?, limits{maxProducts,maxPages,maxDepth,workers,maxBrowser}, fetcher? } */
    async start(input = {}) {
      // Priority: New-Scraping (input.limits) → saved Settings → core DEFAULTS.
      const saved = readJson(dirs.configFile);
      const cfg = loadConfig({
        outputDir: dirs.data,
        ...jobConfigOverrides(saved, input.limits || {}),
        browser: input.browser,
      });
      const meta = {
        origin: input.origin || null, urls: input.urls || [], store: input.store || null,
        productType: input.productType || null, categorySlug: input.categorySlug || null,
        // Content type: 'auto' (recognised on the entry page), 'product' or 'video'.
        contentType: normalizeContentType(input.contentType),
        lang: input.lang || 'fr', browser: input.browser, intervene: !!input.intervene,
        provider: input.provider || 'manual', userAgent: input.userAgent || undefined,
        // Admin test mode for THIS launch only (validated by the main process,
        // which drops it unless the admin session is unlocked). Kept in the job's
        // meta as history; never written to config.json, never reused by a resume.
        testMode: sanitizeTestMode(input.testMode),
      };
      const { id } = createJob(cfg, meta);
      const job = new Job(cfg, id);
      emit('started', { jobId: id, meta, config: pickCfg(cfg), engineConfig: engineConfigOf(cfg) });
      try { return await execute(job, cfg, meta, { fetcher: input.fetcher, useBrowser: input.browser, recipeHttpGet: input.recipeHttpGet, scrapingBrowserConnect: input.scrapingBrowserConnect, browserSession: input.browserSession || null }); }
      catch (err) { failJob(job, err); throw err; }
    },

    async resume(jobId, extra = {}) {
      // Resume honors the saved Settings defaults too (no per-run form here).
      const saved = readJson(dirs.configFile);
      const cfg = loadConfig({ outputDir: dirs.data, ...jobConfigOverrides(saved, {}) });
      const job = new Job(cfg, jobId);
      // A resume is a new launch: the admin test mode of the first launch is NOT reused.
      const meta = { ...(job.job.meta || {}), intervene: !!extra.intervene, provider: extra.provider || (job.job.meta?.provider) || 'manual', testMode: null };
      emit('started', { jobId, meta, resumed: true, config: pickCfg(cfg), engineConfig: engineConfigOf(cfg) });
      try { return await execute(job, cfg, meta, { fetcher: extra.fetcher }); }
      catch (err) { failJob(job, err); throw err; }
    },

    pause() { active?.control.pause(); },
    resumeRun() { active?.control.resume(); },
    stop() { active?.control.stop(); },
    intervention(action) { const p = active?.provider; if (!p) return; if (action === 'skip') p.skip?.(); else p.continue?.(); },
    isRunning() { return !!active; },

    /**
     * Ingest products produced by an EXTERNAL executor (the "your browser"
     * extension tier) through the SAME normalise → eligibility → dedup → CSV/report
     * path as every other lane. Additive: existing lanes are untouched. Returns
     * { jobId, counts, csvPath }.
     *
     * `outcome` (optional, from your-browser/launch.mjs outcomeFor) records a
     * blocked / abandoned / failed run as a normal job too, with a non-technical
     * reason; `details` (technical: extension status/reason, limits, pacing) goes
     * to report.json only — never to the user-facing report text.
     * @param {{products:Array, store?:string, productType?:string, categorySlug?:string, lang?:string, origin?:string, method?:string,
     *          outcome?:{status:string, blocked?:object|null, stoppedByUser?:boolean, text?:string}, details?:object}} input
     */
    async ingestExternalProducts(input = {}) {
      const { products = [], store = null, productType = null, categorySlug = null, lang = 'fr', origin = null, method = 'your-browser' } = input;
      const outcome = input.outcome || { status: 'done', blocked: null, stoppedByUser: false, text: '' };
      const saved = readJson(dirs.configFile);
      const cfg = loadConfig({ outputDir: dirs.data, ...jobConfigOverrides(saved, {}) });
      // The store: what the form said, else the site itself (a run started from the extension's panel names none).
      const storeName = store || (origin ? hostKey(origin) : null);
      // Image addresses rejected and product addresses corrected while normalising (report.images / report.urls).
      const imageDiag = { rejectedImages: [], urlsCorrected: 0, urlSamples: [] };
      const meta = { origin, urls: [], store: storeName, productType, categorySlug, lang, browser: false, provider: 'your-browser' };
      const { id } = createJob(cfg, meta);
      const job = new Job(cfg, id);
      // Challenge screenshots (from the extension's pauses): write them to the job
      // folder and keep only lightweight file refs in the report (never the raw
      // base64 in report.json).
      const challengeShots = saveChallengeShots(job, input.details && input.details.challengeShots);
      emit('started', { jobId: id, meta, config: pickCfg(cfg), engineConfig: engineConfigOf(cfg) });
      // Optional product-page completion (the panel's "Sous-pages" option): the same
      // free, polite HTTP completion a listing lane gets (colour, sizes + EAN,
      // gallery, description…), one visit per model, sample-first. Rows are completed
      // in place before normalisation.
      let detailPagesRep = null, sideDataRep = null, ingestBrowserPages = null;
      const ingestStarted = Date.now(); const ingestMs = { productPagesMs: 0, sideDataMs: 0, exportMs: 0 }; // report.timings.app
      const ingestPages = pageMemo(); let ingestRepair = null; // product pages read (for a repair), and the repair itself
      let ingestInvalidated = null; // taught rules this run made fail (report "rules invalidated")
      let ingestReader = null; // the run's product-page reader, when it opened product pages
      const dp = cfg.detailPages || {};
      // A site that was taught fields only its product pages hold (description, specs…) opens the product
      // pages of a collection by itself — only for the rows that still lack one of them.
      const taught = knowledge.forEngine(origin);
      const needsTaught = !!taught && products.some((r) => missingFields(r, taught).length > 0);
      const rendered = input.renderedPages instanceof Map && input.renderedPages.size ? input.renderedPages : null;
      // How this site's product pages were read last time (http | browser | extension): the refused ways are not retried.
      const access = detailAccessOf(origin ? profiles.get(origin) : null);
      const tracker = createAccessTracker();
      if ((input.completeDetails === true || needsTaught || rendered) && dp.enabled !== false && products.length) {
        const f = makeFetcher({ timeoutMs: cfg.timeoutMs, retries: cfg.retries, minDelayMs: cfg.rateLimitMs });
        // A local headless browser, opened only when needed (a site that refuses plain
        // HTTP, or stock / reviews to learn), with the same identity as the HTTP client.
        let session = null;
        const getSession = async () => { if (!session && await browserAvailable()) session = new BrowserSession({ headless: true, userAgent: f.userAgent }); return session; };
        let refused = access === 'browser' || access === 'extension';
        let browserRefused = access === 'extension';
        ingestBrowserPages = browserPageReader({ getSession, budget: Math.max(Number(cfg.maxBrowser) || 40, products.length + 5), minGapMs: cfg.browserPageGapMs != null ? Number(cfg.browserPageGapMs) : 3000 });
        const pageHtml = async (u) => {
          // The page as the user's browser built it (sub-pages read in the browser): no request at all.
          const own = rendered && rendered.get(String(u).split('#')[0]);
          if (own) { tracker.note('extension', true); return { ok: true, html: own, status: 200, rendered: true }; }
          if (!refused) {
            try { const r = await f.get(u); const blocked = !!(r && r.block ? r.block.terminal : (r && r.blocked && r.status !== 404 && r.status !== 410)); if ((r && r.ok && r.body) || !blocked) { if (r && r.ok && r.body) tracker.note('http', true); return { ok: !!(r && r.ok && r.body), html: r && r.body, status: r && r.status, blocked }; } refused = true; tracker.note('http', false); } catch { return { ok: false }; }
          }
          // Only the user's own browser reads this site's product pages: the rows beyond the pages it sent stay as listed.
          if (browserRefused) return { ok: false, blocked: true, reason: 'needs_user_browser' };
          // The site refused plain HTTP: the page in the local browser (polite, bounded).
          const b = await ingestBrowserPages.read(u);
          if (b && b.ok) { tracker.note('browser', true); return b; }
          if (b && b.blocked) { browserRefused = true; tracker.note('browser', false); }
          return b || { ok: false, blocked: true };
        };
        ingestReader = pageHtml;
        try {
          const tPages = Date.now();
          try { detailPagesRep = await enrichFromDetailPages(products, { fetchHtml: async (u) => ingestPages.keep(u, await pageHtml(u)), maxVisits: detailVisitCap(dp, products.length), sample: Number(dp.sample) || 3, onStep: (code, p) => emit('step', { code, ...(p || {}) }), knowledge: knowledge.forEngine(origin), fetchRendered: async (u) => (browserRefused ? null : ingestBrowserPages.read(u)) }); const failedNow = recordKnowledgeOutcomes(origin, detailPagesRep); ingestInvalidated = invalidatedOf(failedNow); ingestRepair = await repairAfterRun(origin, failedNow, new Map([...(rendered || new Map()), ...ingestPages.m])); } catch { detailPagesRep = null; }
          ingestMs.productPagesMs += Date.now() - tPages;
          // Stock per size + reviews the product pages load with their own requests:
          // learned on one page in the local browser, asked for every row (not on a site that refuses that browser).
          if ((cfg.sideData || {}).enabled !== false && !browserRefused) {
            const tSide = Date.now();
            try { sideDataRep = await completeSideData(products, { getSession, fetchJson: fetcherJson(f), timeoutMs: cfg.renderTimeoutMs || 30000, onStep: (code, p) => emit('step', { code, ...(p || {}) }) }); } catch { sideDataRep = null; }
            ingestMs.sideDataMs += Date.now() - tSide;
          }
        } finally { if (session) { try { await session.close(); } catch { /* ignore */ } } }
      }
      // A site no one taught: its rules are built now from the product pages this run read (once per site).
      // Only from product pages this run could read (its own reader, or the pages the user's browser sent).
      const ingestOnboard = products.length && (ingestReader || rendered) ? await onboardAfterRun(origin, new Map([...(rendered || new Map()), ...ingestPages.m]), products) : null;
      // What this run learned about reading the site's product pages, kept for the next run.
      const learnedAccess = tracker.verdict();
      if (learnedAccess && origin) { try { profiles.record(origin, { detailAccess: learnedAccess }); } catch { /* best-effort */ } }
      const detailAccessRep = { used: access, learned: learnedAccess, counts: tracker.counts, browserPages: rendered ? rendered.size : 0 };
      // The trail of the page the rows were read on (sent by the extension), for the
      // rows whose own page gave none.
      const listingTrail = input.listing && Array.isArray(input.listing.trail) ? input.listing.trail : [];
      // In the collection? Each product's OWN page breadcrumb (before the list's trail fills the rows without one)
      // against the list's trail, or the sub-collection of a hub it was read in. Out of it: « à vérifier ».
      const outOfCollection = new Map();
      // The audience too: a « hommes » list (its address, its trail) and a card that says « Femmes Originals » (adidas 28/10).
      const listText = `${origin ? (() => { try { return new URL(origin).pathname; } catch { return ''; } })() : ''} ${listingTrail.join(' ')}`;
      const shortTexts = (raw) => [raw.gender, raw.subtitle, typeof raw.description === 'string' && raw.description.length <= 80 ? raw.description : null, ...Object.entries(raw.columns || {}).filter(([k, v]) => typeof v === 'string' && !/^(category|collection|type|product_type|tags|brand|marque)$/i.test(k)).map(([, v]) => v)].filter(Boolean);
      for (const raw of products) {
        if (!raw) continue;
        const v = collectionVerdict({ listTrail: listingTrail, expected: typeof raw.subCollection === 'string' ? raw.subCollection : null, crumb: raw.breadcrumb }) || audienceVerdict({ listText, productTexts: shortTexts(raw) });
        if (v) outOfCollection.set(raw, v);
      }
      const trailGiven = applyTrailToRaw(products, listingTrail);
      const seen = new Set();
      // Page/tile verdicts: the extension's (with reasons) + this defensive pass,
      // same shared rules as the standard engine.
      const pageRules = mergeRules((saved || {}).pageRules);
      const ext = (input.details && input.details.pageVerdicts) || {};
      const copy = (b) => (b ? JSON.parse(JSON.stringify(b)) : null); // tallyVerdict mutates — never the caller's object
      const pageVerdicts = { rejected: copy(ext.rejected), doubtful: copy(ext.doubtful) };
      let ownRejected = 0;
      // The fixed values the panel sent (what the user saw), else the ones saved for this page (a job the app
      // started and ran in the user's browser): stamped on every product, never shared between batches.
      const sentConstants = Array.isArray(input.constants) ? input.constants : [];
      let ingestConstants = sentConstants;
      if (!sentConstants.length && origin) { try { const h = profiles.hints(origin); ingestConstants = storedConstantsFor({ site: h.siteValues, batches: h.listBatches }, origin, { productType }); } catch { ingestConstants = []; } }
      const constantsFrom = sentConstants.length ? 'panel' : (ingestConstants.length ? 'saved' : null);
      for (const raw of products) {
        const iv = classifyItem(raw, pageRules);
        if (!iv.ok) { ownRejected++; pageVerdicts.rejected = tallyVerdict(pageVerdicts.rejected, { url: (raw && (raw.url || raw.sourceUrl)) || null, kind: 'item', reasons: [{ code: iv.code, text: iv.text }] }); continue; }
        const np = toNormalizedProduct(raw, { storeSlug: storeName || '', lang, defaultProductType: productType || null, categorySlug: categorySlug || null, diag: imageDiag });
        // The fixed values typed in the panel, on every product (after the product pages were read: « always » replaces them).
        if (ingestConstants.length) applyConstantsToProduct(np, ingestConstants);
        const idKey = np.source_product_id ? `id:${np.source_product_id}` : `url:${np.source_url || np.name || ''}`;
        if (seen.has(idKey)) continue; seen.add(idKey);
        np.__eligibility = evaluateEligibility(np);
        // A row whose own product page could not be read (only the user's browser reads this site, the page
        // limit, a refusal) and that still lacks what the page gives is "to verify", with the missing fields.
        if (np.__eligibility.status === 'accepted') { const dv = detailUnreadVerdict(raw, np); if (dv) np.__eligibility = { ...np.__eligibility, ...dv }; }
        // A product whose page the extension judged doubtful is never "accepted".
        if (Array.isArray(raw._doubtful) && raw._doubtful.length && np.__eligibility.status !== 'excluded') {
          np.__eligibility = { ...np.__eligibility, status: 'to_verify', code: 'to_verify_page_doubtful', reason: raw._doubtful.join(' ; ') };
        }
        // Classed elsewhere by its own page: listed, never imported as part of this collection.
        if (outOfCollection.has(raw) && np.__eligibility.status !== 'excluded') np.__eligibility = { ...np.__eligibility, status: 'to_verify', code: 'to_verify_out_of_collection', reason: outOfCollection.get(raw).reason };
        job.addProduct(np);
        emit('product', { name: np.name || '(sans nom)', price: np.price, status: np.__eligibility?.status || 'to_verify', image: !!np.image_url });
      }
      // Persist the products (Jobs list count, Results view, overrides read them from disk).
      job.flush();
      const accepted = job.products.filter((p) => p.__eligibility?.status === 'accepted');
      const toVerify = job.products.filter((p) => p.__eligibility?.status === 'to_verify');
      const excluded = job.products.filter((p) => p.__eligibility?.status === 'excluded');
      const status = outcome.status || 'done';
      const reason = outcome.text || '';
      // Real run duration (launch → extension result), measured by the caller.
      const durationMs = Number.isFinite(Number(input.durationMs)) && Number(input.durationMs) > 0 ? Math.round(Number(input.durationMs)) : 0;
      const notes = ['Source : votre navigateur (extension Eloshon Scraper, aucun fournisseur payant)'];
      if (reason) notes.push(reason);
      // Product pages left unread, with what the user can do about it (never a silent gap).
      const unreadByBrowserOnly = (detailPagesRep && detailPagesRep.reasons && (detailPagesRep.reasons.needs_user_browser || 0)) || 0;
      const nbNote = needsBrowserNote(detailPagesRep); if (nbNote) notes.push(nbNote);
      notes.push(...repairNotes(ingestRepair));
      notes.push(...onboardingNotes(ingestOnboard));
      if (unreadByBrowserOnly) {
        // The extension sent fewer product pages than it listed products: the « Fiches produit » limit cut them.
        const sent = Number(input.details && input.details.counts && input.details.counts.detailPagesSent) || (rendered ? rendered.size : 0);
        const lim = input.details && input.details.limits && input.details.limits.maxDetailPages;
        notes.push(`${unreadByBrowserOnly} fiche(s) produit non lue(s) : ce site ne laisse lire ses fiches que dans votre navigateur${sent && lim != null && sent >= Number(lim) ? `, et la limite « Fiches produit » (${lim}) a été atteinte` : ''}. Ces produits sont « à vérifier » (données de liste seules). Relancez avec le mode « Votre navigateur » et une limite « Fiches produit » au moins égale au nombre de produits pour les compléter.`);
      }
      if (ingestBrowserPages && ingestBrowserPages.stats.stoppedBy === 'human_check') notes.push('Le navigateur de l’application a reçu une vérification « êtes-vous humain ? » : les fiches restantes n’ont pas été lues. Utilisez le mode « Votre navigateur », où vous pouvez répondre à la vérification.');
      if (Number(input.browserChallenged) > 0) notes.push(`${Number(input.browserChallenged)} fiche(s) ont affiché une vérification « êtes-vous humain ? » dans votre navigateur : ouvrez une fiche du site, répondez-y, puis relancez.`);
      // Pages read: the list pages the extension read, the product pages it sent and the ones the app read itself.
      const listPages = Number(input.details && input.details.counts && input.details.counts.pages) || 0;
      const pagesRead = listPages + ['extension', 'http', 'browser'].reduce((n, k) => n + ((tracker.counts[k] && tracker.counts[k].ok) || 0), 0);
      const report = { store: storeName || '', status: status === 'done' ? 'OK' : status, method, discovered: products.length, fetched: pagesRead, detected: job.products.length, normalized: job.products.length, accepted: accepted.length, toVerify: toVerify.length, excluded: excluded.length, incomplete: 0, notAProductPage: (pageVerdicts.rejected && pageVerdicts.rejected.count) || 0, duplicates: products.length - job.products.length - ownRejected, networkErrors: 0, parseErrors: 0, browserRequired: 0, browserUsed: 0, sitemapsRead: [], durationMs, remaining: 0, notes, errors: [], byStrategy: { [method]: job.products.length }, discovery: { method, diagnosis: status === 'done' ? 'ok' : (outcome.blocked ? 'blocked' : status), browserPagesRendered: 0 } };
      report.executor = 'votre navigateur (extension Eloshon Scraper, aucun fournisseur payant)';
      if (detailPagesRep) report.detailPages = detailPagesRep;
      if (detailPagesRep || detailAccessRep.browserPages) report.detailAccess = detailAccessRep;
      if (ingestRepair) report.knowledgeRepair = ingestRepair;
      if (ingestOnboard) report.onboarding = ingestOnboard;
      // The user's browser read a list the app itself was refused: it is this site's list reader for now.
      try { const pr = origin ? profiles.get(origin) : null; if (job.products.length && method === 'your-browser' && pr && (pr.needsUnlock || pr.blockedBy) && listAccessOf(pr) !== 'app') { profiles.record(origin, { listAccess: 'extension' }); report.listAccess = 'extension'; } } catch { /* best-effort */ }
      report.aiCalls = { discovery: (ingestOnboard && ingestOnboard.aiCalls) || 0, repair: (ingestRepair && ingestRepair.aiCalls) || 0, chat: 0 };
      if (sideDataRep) report.sideData = sideDataRep;
      if (ingestBrowserPages && ingestBrowserPages.stats.pages) { report.pagesViaBrowser = ingestBrowserPages.stats.pages; report.browserPagesStop = ingestBrowserPages.stats.stoppedBy; report.browserPagesNotRead = ingestBrowserPages.stats.notRead || 0; }
      // The product pages your browser (the extension panel) read for these rows: blocked and unopened ones make the job PARTIAL.
      if (input.yourBrowserPages && Number(input.yourBrowserPages.toRead) > 0) report.yourBrowserPages = input.yourBrowserPages;
      if (Array.isArray(input.columns) && input.columns.length) report.columns = input.columns; // name as typed + role for the Converter
      else if (constantsFrom === 'saved') report.columns = constantColumns(ingestConstants);
      // Which fixed values were stamped on the products, and from where (the panel, or the values saved for the page).
      if (constantsFrom) report.fixedValues = { from: constantsFrom, batch: batchKeyOf(origin), values: ingestConstants.map((c) => ({ key: c.key, value: c.value, mode: c.mode })) };
      if (trailGiven) report.categoryTrail = { source: 'extension', trail: listingTrail, products: trailGiven };
      if (outOfCollection.size) report.outOfCollection = { count: outOfCollection.size, list: [...outOfCollection].slice(0, 100).map(([raw, v]) => ({ name: String(raw.name || '').slice(0, 120), url: raw.sourceUrl || null, reason: v.reason })) };
      // The same product already recorded from another list page of this site (a unisex shoe in « hommes » and « femmes »):
      // kept in this batch too, and listed with the other batches.
      try {
        const bk = origin ? batchKeyOf(origin) : null;
        if (bk && job.products.length) {
          const h = profiles.hints(origin);
          const { index, elsewhere } = indexBatch(h.batchIndex, bk, job.products.map(productKeyOf).filter(Boolean));
          profiles.record(origin, { batchIndex: index });
          if (elsewhere.size) {
            const labelOf = (k) => (h.listBatches[k] && h.listBatches[k].label) || batchLabelOf(`https://${k}`);
            report.crossBatch = { count: elsewhere.size, list: job.products.filter((np) => elsewhere.has(productKeyOf(np))).slice(0, 100).map((np) => ({ name: String(np.name || '').slice(0, 120), url: np.source_url || null, alsoIn: elsewhere.get(productKeyOf(np)).map(labelOf) })) };
          }
        }
      } catch { /* the job stands without it */ }
      // How the browser read the list and whether its count matches the announced total (a shortfall makes the job PARTIAL).
      if (input.listing && input.listing.pagination) report.pagination = input.listing.pagination;
      // The cards the learned product card left out of the list, each with its reason; the sub-collections of a hub.
      if (input.listing && input.listing.rejected) report.listRejected = input.listing.rejected;
      if (input.listing && input.listing.hub) report.hub = input.listing.hub;
      if (reason) report.userReason = reason;
      if (pageVerdicts.rejected || pageVerdicts.doubtful) report.pageVerdicts = Object.fromEntries(Object.entries(pageVerdicts).filter(([, v]) => v));
      if (outcome.blocked) report.blocked = { ...outcome.blocked, reason: outcome.blocked.reason || reason, resumable: false };
      // Rejected image addresses, corrected product addresses, taught rules that failed this run; then an
      // honest status: rows to verify or product pages left unread make the run PARTIAL, never OK.
      attachDiagnostics(report, imageDiag);
      if (ingestInvalidated && ingestInvalidated.length) report.knowledgeInvalidated = ingestInvalidated;
      applyPartialStatus(report);
      const exportStart = Date.now();
      fs.writeFileSync(job.paths.csv, toImportCsv(accepted, { storeSlug: storeName, categorySlug }), 'utf8');
      if (toVerify.length) fs.writeFileSync(job.paths.csv.replace(/\.csv$/, '-to-verify.csv'), toImportCsv(toVerify, { storeSlug: storeName, categorySlug }), 'utf8');
      ingestMs.exportMs += Date.now() - exportStart;
      // Where the time went: the extension's own steps (list, pacing, page loads…), then what the app did with the rows.
      const appMs = Date.now() - ingestStarted;
      const rereadMs = ingestBrowserPages ? Number(ingestBrowserPages.stats.ms) || 0 : 0;
      finishJobReport(job, report, origin, {
        source: 'extension', totalMs: durationMs + appMs,
        extension: input.details && input.details.timings ? input.details.timings : null,
        app: { productPagesMs: ingestMs.productPagesMs, browserRereadsMs: rereadMs, sideDataMs: ingestMs.sideDataMs, exportMs: ingestMs.exportMs, otherMs: Math.max(0, appMs - ingestMs.productPagesMs - ingestMs.sideDataMs - ingestMs.exportMs) },
      });
      // Technical detail (extension status/raw reason, limits, pacing) → journal only.
      // Replace the raw screenshot data URLs with the saved file refs so report.json
      // stays small.
      const journal = input.details ? { ...report, source: { tier: 'your_browser', label: 'Votre navigateur', paid: false }, yourBrowser: { ...input.details, challengeShots: challengeShots.length ? challengeShots : null, extensionReason: input.details.extensionReason ? String(input.details.extensionReason).slice(0, 240) : null } } : report;
      fs.writeFileSync(job.paths.reportJson, JSON.stringify(journal, null, 2));
      fs.writeFileSync(job.paths.reportTxt, `Job ${job.id}\n\n${formatReport(report)}\n`);
      job.setStatus(status, { report, reason });
      // Usage ledger: a run in the user's own browser (free, no external service).
      M.forJob({ jobId: job.id, domain: (input.details && input.details.domain) || (origin ? hostKey(origin) : null), url: origin }).record({
        provider: 'extension', route: method, channel: 'local', attempted: true,
        outcome: outcome.stoppedByUser ? 'skipped' : (status === 'done' ? 'success' : 'failed'),
        reason: status === 'done' ? null : status, products: job.products.length, durationMs,
      });
      emit('done', { jobId: job.id, status, stoppedByUser: !!outcome.stoppedByUser, error: null, reason, diagnosis: report.discovery.diagnosis, method, pagination: report.pagination || null, detailPages: report.detailPages || null, sideData: report.sideData || null, categoryTrail: report.categoryTrail || null, pagesViaBrowser: report.pagesViaBrowser || 0, browserPagesStop: report.browserPagesStop || null, blocked: outcome.blocked || null, remaining: 0, counts: counters(job), durationMs, csvPath: job.paths.csv, reportPath: job.paths.reportTxt, csvToVerify: toVerify.length ? job.paths.csv.replace(/\.csv$/, '-to-verify.csv') : null });
      return { jobId: job.id, status, reportStatus: report.status, rulesFailing: (report.knowledgeInvalidated || []).map((r) => ({ field: r.field, reason: r.reason || null })), counts: counters(job), csvPath: job.paths.csv };
    },

    /**
     * The per-domain recipe hints for an external (your-browser) run, resolved
     * EXACTLY like a normal job: shared-recipe sync (best-effort), then the local
     * domain profile (taught / bundled). Returns {internalApi, manualSelectors}.
     */
    /** recipes.json: the sites' recipes as one versioned file (core/recipes-file.mjs). */
    recipesExport({ hosts = null, appVersion = null } = {}) { return exportRecipes(profiles.all(), { hosts: Array.isArray(hosts) ? hosts : null, appVersion }); },
    /**
     * Fixed values saved from the panel (shared/export/site-values.mjs): the SITE profile and the BATCH of a list page.
     * get → { site, batch }; set(url, { site?, batch? }): a part given as null is forgotten, a part left out is kept.
     */
    siteValues: {
      get(url) { try { const h = profiles.hints(url); const key = batchKeyOf(url); return { site: h.siteValues || null, batch: (key && h.listBatches[key]) || null }; } catch { return { site: null, batch: null }; } },
      set(url, change = {}) {
        if ('site' in change) profiles.record(url, { siteValues: change.site || null });
        if ('batch' in change) { const key = batchKeyOf(url); if (key) profiles.record(url, { listBatch: { key, batch: change.batch || null } }); }
      },
    },
    /** The product card learned in the panel for a site (domain profile `card_model`). */
    cardModel: {
      get(url) { try { return profiles.hints(url).cardModel || null; } catch { return null; } },
      set(url, model) { profiles.record(url, { cardModel: model || null }); },
    },
    /** How a site's lists load more, as the user set it in the extension's panel (domain profile `list_pagination`). */
    sitePagination: {
      get(url) { try { return profiles.hints(url).listPagination || null; } catch { return null; } },
      set(url, memo) { profiles.record(url, { listPagination: memo || null }); },
    },
    /** What importing a recipes file would change (nothing written); the plan waits for recipesApply. */
    recipesPreview(file) {
      const r = planImport(profiles.all(), file);
      if (!r.ok) return r;
      const id = `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      pendingImports.set(id, r.plan); while (pendingImports.size > 5) pendingImports.delete(pendingImports.keys().next().value);
      return { ok: true, previewId: id, summary: r.summary, empty: !Object.keys(r.plan).length };
    },
    /** Apply a previewed import: a dated copy of domain-profiles.json is kept beside it first. */
    recipesApply(previewId) {
      const plan = pendingImports.get(previewId); if (!plan) return { ok: false, reason: 'aperçu expiré : réimportez le fichier' };
      pendingImports.delete(previewId);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const ok = profiles.replaceAll(applyImport(profiles.all(), plan), `domain-profiles.before-import-${stamp}.json`);
      return ok ? { ok: true, sites: Object.keys(plan) } : { ok: false, reason: 'écriture impossible (fichier des recettes en lecture seule pour l’instant)' };
    },

    /** Only the user's browser read this site's lists lately (the app was refused): launch there directly. */
    prefersYourBrowser(url) { try { return profiles.hints(url).listAccess === 'extension'; } catch { return false; } },

    async resolveExternalRecipe(url) {
      const source = await syncSharedRecipe(url);
      const h = profiles.hints(url) || {};
      return { internalApi: h.internalApi || null, manualSelectors: h.manualSelectors || null, source: h.internalApi ? source : (h.manualSelectors ? 'local' : null), detailAccess: h.detailAccess || null };
    },

    // Status of the OPT-IN specialized-browser (nodriver) capability, for the UI:
    // whether the user enabled it, and whether Python+nodriver+real-Chrome are
    // actually present. A pure probe — it launches nothing but a `--selfcheck`.
    /** Palier + soldes du compte, et le taux €/crédit qui en découle.
     *  Sert à afficher un équivalent monétaire à côté de chaque nombre de
     *  crédits. `rate: null` (palier gratuit, compte inconnu, ou serveur qui
     *  ne renvoie pas encore prix+volume du palier) ⇒ l'UI n'affiche que les
     *  crédits, jamais un équivalent estimé. */
    async accountStatus() {
      const client = edgeClientFor(readJson(dirs.configFile));
      if (!client.isConfigured()) return { ok: false, reason: 'not_configured', rate: null };
      try {
        const res = await client.accountStatus();
        return { ...res, rate: rateFromAccount(res) };
      } catch (e) {
        return { ok: false, reason: 'network_error', detail: String(e?.message || e), rate: null };
      }
    },

    async unlockStatus() {
      const saved = readJson(dirs.configFile) || {};
      const chrome = resolveChrome({ chromePath: saved.chromePath });
      let a = { ok: false, reason: 'disabled' };
      try { a = await unlockAvailable({ pythonPath: saved.unlockPython, recheck: true }); } catch (e) { a = { ok: false, reason: String(e?.message || e) }; }
      // Leave a trace of EXACTLY what the GUI process saw (paths + raw env + every
      // Python candidate tried), so a GUI-vs-CLI divergence can be proven, not guessed.
      try {
        fs.writeFileSync(path.join(dirs.userData, 'unlock-diag.json'), JSON.stringify({
          at: new Date().toISOString(), source: 'gui:unlockStatus',
          execPath: process.execPath, resourcesPath: process.resourcesPath,
          enabled: !!saved.unlock, ready: a.ok, reason: a.ok ? null : a.reason,
          chrome, sidecar: a.sidecar, env: a.env, tried: a.tried,
        }, null, 2), 'utf8');
      } catch { /* diagnostics are best-effort; never break the status call */ }
      return { enabled: !!saved.unlock, chromeFound: !!chrome, ready: a.ok, reason: a.ok ? null : a.reason };
    },

    /** All learned domain profiles (for the UI / diagnostics). Read-only. */
    domainProfiles() { return profiles.all(); },

    // USER-TRIGGERED specialized-browser (nodriver) escalation. Called ONLY from an
    // explicit UI action on an already-diagnosed blocked source — never auto-invoked
    // from page content. Renders the URL with the sidecar (real Chrome), then feeds
    // the RENDERED HTML into the existing Node extractors / normalize / eligibility /
    // dedup / CSV — nodriver only provides the HTML, the engine does the rest.
    async unlockRetry(input = {}) {
      const trace = (m) => { try { console.log('[UNLOCK] ' + m); } catch { /* ignore */ } };
      trace('UI action received');
      const url = input.url || input.origin;
      trace('URL = ' + url);
      if (!url) { emit('error', { message: 'no url' }); return { ok: false }; }
      const saved = readJson(dirs.configFile) || {};
      if (!saved.unlock) { trace('ABORT: specialized browser disabled'); emit('error', { message: 'specialized browser disabled' }); return { ok: false }; }
      const a = await unlockAvailable({ pythonPath: saved.unlockPython, recheck: true });
      trace('capability = ' + JSON.stringify({ enabled: !!saved.unlock, ready: a.ok, python: a.python || a.cmd || null, chrome: a.chrome || null, reason: a.reason || null }));
      if (!a.ok) { trace('ABORT: capability not ready'); emit('error', { message: a.reason }); return { ok: false, error: a.reason }; }
      const cfg = loadConfig({ outputDir: dirs.data, ...jobConfigOverrides(saved, {}) });
      const meta = { origin: url, store: input.store || null, productType: input.productType || null, categorySlug: input.categorySlug || null, lang: input.lang || 'fr', mode: 'unlock' };
      const { id } = createJob(cfg, meta);
      const job = new Job(cfg, id);
      const control = makeControl(emit);
      active = { control, provider: registry.manual, jobId: job.id };
      // Usage ledger: nodriver = a real Chrome on THIS machine (free route).
      const jm = M.forJob({ jobId: job.id, domain: hostKey(url), url });
      try {
        job.setStatus('running');
        emit('phase', { phase: 'unlock', stage: 'rendering' });
        trace('calling unlockRender (nodriver)');
        const t0 = Date.now();
        const r = await unlockRender(url, { pythonPath: saved.unlockPython, timeoutMs: (cfg.timeoutMs || 30000) + 60000, trace });
        if (!r.html) {
          trace('BREAK: no HTML — ' + (r.error || 'unlock failed'));
          jm.record({ provider: 'local', route: 'nodriver', channel: 'local', outcome: /time/i.test(String(r.error || '')) ? 'timeout' : 'failed', reason: String(r.error || 'unlock_failed').slice(0, 80), durationMs: Date.now() - t0 });
          failJob(job, new Error(r.error || 'unlock failed')); return { ok: false, error: r.error };
        }
        trace('HTML bytes = ' + r.html.length);
        emit('phase', { phase: 'unlock', stage: 'extracting', bytes: r.html.length });
        const isEligible = cfg.evaluateEligibility || evaluateEligibility;
        const raws = [];
        const { product } = extractProduct(r.html, url);
        if (product && product.name) raws.push(product);
        trace('extractListing started');
        const listingCards = extractListing(r.html, url).cards;
        trace('cards found = ' + listingCards.length);
        for (const card of listingCards) raws.push(card);
        // Also harvest same-host product links from the rendered HTML — listing
        // pages without a JSON-LD ItemList still expose product anchors. Generic:
        // PRODUCT_RE or an id-slug ".html" (PrestaShop/Magento). A homepage that
        // only links to categories yields none (correctly).
        try {
          const host = new URL(url).hostname.replace(/^www\./, '');
          const have = new Set(raws.map((x) => x.sourceUrl || x.canonicalUrl).filter(Boolean));
          const linkRe = /<a\b[^>]*href=["']([^"'#\s]+)["']/gi; let mm;
          while ((mm = linkRe.exec(r.html))) {
            const abs = absoluteUrl(mm[1], url); if (!abs) continue;
            let p = ''; try { const u = new URL(abs); if (u.hostname.replace(/^www\./, '') !== host) continue; p = u.pathname; } catch { continue; }
            if (!(PRODUCT_RE.test(abs) || /\/\d+-[a-z0-9-]+\.html$/i.test(p))) continue;
            const clean = abs.split('#')[0];
            if (have.has(clean)) continue; have.add(clean);
            raws.push({ sourceUrl: clean, canonicalUrl: clean, strategy: 'unlock-link' });
          }
        } catch { /* harvest is best-effort */ }
        const seen = new Set(); let flushed = Date.now();
        for (const raw of raws) {
          const np = toNormalizedProduct(raw, { storeSlug: meta.store, lang: meta.lang, defaultProductType: meta.productType, categorySlug: meta.categorySlug });
          const idKey = np.source_product_id ? `id:${np.source_product_id}` : `url:${dedupKey(np.source_url || url)}`;
          if (seen.has(idKey)) continue; seen.add(idKey);
          np.__eligibility = isEligible(np);
          job.addProduct(np);
          emit('product', { name: np.name || '(sans nom)', price: np.price, status: np.__eligibility?.status || 'to_verify', image: !!np.image_url });
          if (Date.now() - flushed > 800) { job.flush(); flushed = Date.now(); emit('counters', counters(job)); }
        }
        job.flush();
        trace('products returned = ' + job.products.length);
        const accepted = job.products.filter((p) => p.__eligibility?.status === 'accepted');
        const toVerify = job.products.filter((p) => p.__eligibility?.status === 'to_verify');
        fs.writeFileSync(job.paths.csv, toImportCsv(accepted, { storeSlug: meta.store, categorySlug: meta.categorySlug }), 'utf8');
        if (toVerify.length) fs.writeFileSync(job.paths.csv.replace(/\.csv$/, '-to-verify.csv'), toImportCsv(toVerify, { storeSlug: meta.store, categorySlug: meta.categorySlug }), 'utf8');
        const report = { store: meta.store || '', status: 'ok', method: 'unlock', discovered: raws.length, fetched: 1, detected: job.products.length, normalized: job.products.length, accepted: accepted.length, toVerify: toVerify.length, excluded: job.products.length - accepted.length - toVerify.length, incomplete: 0, notAProductPage: 0, duplicates: 0, networkErrors: 0, parseErrors: 0, browserRequired: 0, browserUsed: 0, sitemapsRead: [], durationMs: Date.now() - t0, remaining: 0, notes: [`hard-unlock (nodriver) rendered ${r.html.length} bytes → ${job.products.length} product(s)`], errors: [], unlock: true };
        fs.writeFileSync(job.paths.reportJson, JSON.stringify(report, null, 2));
        fs.writeFileSync(job.paths.reportTxt, `Job ${job.id}\n\n${formatReport(report)}\n`);
        job.setStatus(job.products.length ? 'done' : 'stopped:NO_PRODUCTS', { report: { ...report }, reason: job.products.length ? '' : 'specialized browser rendered the page but no products were extracted' });
        jm.record({ provider: 'local', route: 'nodriver', channel: 'local', outcome: job.products.length ? 'success' : 'failed', reason: job.products.length ? null : 'no_products', products: job.products.length, bytes: Buffer.byteLength(r.html), durationMs: report.durationMs });
        emit('done', { jobId: job.id, status: job.job.status, stoppedByUser: false, error: null, reason: '', diagnosis: 'ok', blocked: null, remaining: 0, counts: counters(job), durationMs: report.durationMs, csvPath: job.paths.csv, reportPath: job.paths.reportTxt, csvToVerify: toVerify.length ? job.paths.csv.replace(/\.csv$/, '-to-verify.csv') : null });
        // Memory: this domain needed the specialized browser (nodriver) and how
        // many products that yielded — advisory for next time (never auto-triggers).
        recordProfile(url, { ...report, discovery: { method: 'unlock', browserPagesRendered: 1 } }, job, { browser: 'nodriver', needsBrowser: true, needsUnlock: true, blockedBy: input.blockedBy || 'BOT_CHALLENGE', extractorStrategy: 'unlock-listing' });
        active = null;
        return { ok: true, jobId: job.id, count: job.products.length };
      } catch (e) { failJob(job, e); return { ok: false, error: String((e && e.message) || e) }; }
    },

    // Estimated cost of the assisted unlock BEFORE launching (server-computed from
    // the shared profile + config coefficients). For the confirm dialog.
    async estimateUnlock({ url, pages = 1 } = {}) {
      const client = edgeClientFor(readJson(dirs.configFile));
      if (!client.isConfigured()) return { ok: false, reason: 'not_configured', message: describeUnlock({ reason: 'not_configured' }).message };
      return describeEstimate(await client.estimate(url, pages), await currentRate());
    },

    // USER-CONFIRMED server cascade (Firecrawl → Scrapfly → Bright Data, per
    // app_config.provider_order, learned winner first, country imposed from the
    // URL). Feeds the returned HTML into the SAME extractor/normalize/eligibility
    // path as the nodriver route, records the run to the shared profile, and
    // reports run_feedback so the base improves for everyone. Never auto-invoked.
    async cascadeUnlock(input = {}) {
      const url = input.url || input.origin;
      if (!url) { emit('error', { message: 'no url' }); return { ok: false }; }
      const client = edgeClientFor(readJson(dirs.configFile));
      if (!client.isConfigured()) {
        M.forJob({ domain: hostKey(url), url }).record({ provider: 'cascade', route: 'unlock', channel: 'server', attempted: false, outcome: 'skipped', reason: 'not_configured' });
        const d = describeUnlock({ reason: 'not_configured' }); emit('error', { message: d.message }); return { ok: false, ...d };
      }
      const saved = readJson(dirs.configFile) || {};
      const cfg = loadConfig({ outputDir: dirs.data, ...jobConfigOverrides(saved, {}) });
      const meta = { origin: url, store: input.store || null, productType: input.productType || null, categorySlug: input.categorySlug || null, lang: input.lang || 'fr', mode: 'cascade' };
      const { id } = createJob(cfg, meta);
      const job = new Job(cfg, id);
      const control = makeControl(emit);
      active = { control, provider: registry.manual, jobId: job.id };
      const t0 = Date.now();
      // Usage ledger: the cascade runs on the Eloshon server (server keys, credits).
      const jm = M.forJob({ jobId: job.id, domain: hostKey(url), url });
      try {
        job.setStatus('running');
        emit('phase', { phase: 'unlock', stage: 'cascade' });
        const res = await client.unlock(url, { returnHtml: true });
        recordCascadeCall(jm, res, Date.now() - t0, 1);
        const d = describeUnlock(res, await currentRate());
        if (!d.ok) {
          // Clean fallback — not a crash. Quota/blocked/all-failed each carry a
          // clear message; the free local result already stands.
          job.setStatus(`stopped:${res.reason || 'unlock_failed'}`, { reason: d.message });
          emit('done', { jobId: job.id, status: job.job.status, stoppedByUser: false, error: null, reason: d.message, diagnosis: res.reason || 'unlock_failed', blocked: null, remaining: 0, counts: counters(job), durationMs: Date.now() - t0, csvPath: null, reportPath: null, csvToVerify: null });
          active = null;
          return { ok: false, ...d };
        }
        emit('phase', { phase: 'unlock', stage: 'extracting' }); // provider/bytes stay server-side only
        const isEligible = cfg.evaluateEligibility || evaluateEligibility;
        let raws = rawsFromHtml(res.html, url);
        let totalCredits = res.eloshon_credits || 0;
        let pagesUnlocked = 1;
        // Pagination: the embedded state announces totalPages → unlock the remaining
        // list pages (page=1..N-1) and merge, so the whole catalogue comes back, not
        // just page 1. Bounded; stops cleanly on the first page that fails.
        const pag = extractEmbeddedProducts(res.html, url).pagination;
        const pageCap = Math.min(Number(cfg.maxPages || 150), 40);
        if (pag && pag.totalPages && pag.totalPages > 1) {
          for (let pnum = 1; pnum < pag.totalPages && pnum < pageCap; pnum++) {
            if (control.stopped) break;
            const pu = url + (url.includes('?') ? '&' : '?') + 'page=' + pnum;
            emit('phase', { phase: 'unlock', stage: 'cascade', page: pnum + 1, pages: pag.totalPages });
            const pt0 = Date.now();
            const pr = await client.unlock(pu, { returnHtml: true });
            recordCascadeCall(M.forJob({ jobId: job.id, domain: hostKey(url), url: pu }), pr, Date.now() - pt0, pnum + 1);
            if (!pr || !pr.ok) break;
            totalCredits += pr.eloshon_credits || 0;
            pagesUnlocked++;
            raws = raws.concat(rawsFromHtml(pr.html, pu));
          }
        }
        // Give the progress bar a denominator: total = announced results (or the
        // number of raw candidates found across the unlocked pages).
        const progressTotal = (pag && pag.totalResults) ? pag.totalResults : raws.length;
        emit('discovered', { total: progressTotal, http: raws.length, browser: 0, method: 'déblocage assisté' }); // provider name never sent to the UI
        emit('progress', { done: 0, total: progressTotal });
        const seen = new Set(); let flushed = Date.now();
        for (const raw of raws) {
          const np = toNormalizedProduct(raw, { storeSlug: meta.store, lang: meta.lang, defaultProductType: meta.productType, categorySlug: meta.categorySlug });
          const idKey = np.source_product_id ? `id:${np.source_product_id}` : `url:${dedupKey(np.source_url || url)}`;
          if (seen.has(idKey)) continue; seen.add(idKey);
          np.__eligibility = isEligible(np); job.addProduct(np);
          emit('product', { name: np.name || '(sans nom)', price: np.price, status: np.__eligibility?.status || 'to_verify', image: !!np.image_url });
          emit('progress', { done: job.products.length, total: Math.max(progressTotal, job.products.length) });
          if (Date.now() - flushed > 800) { job.flush(); flushed = Date.now(); emit('counters', counters(job)); }
        }
        job.flush();
        emit('progress', { done: job.products.length, total: job.products.length });
        const accepted = job.products.filter((p) => p.__eligibility?.status === 'accepted');
        const toVerify = job.products.filter((p) => p.__eligibility?.status === 'to_verify');
        fs.writeFileSync(job.paths.csv, toImportCsv(accepted, { storeSlug: meta.store, categorySlug: meta.categorySlug }), 'utf8');
        if (toVerify.length) fs.writeFileSync(job.paths.csv.replace(/\.csv$/, '-to-verify.csv'), toImportCsv(toVerify, { storeSlug: meta.store, categorySlug: meta.categorySlug }), 'utf8');
        const report = { store: meta.store || '', status: 'ok', method: `cascade:${res.provider}`, discovered: raws.length, fetched: pagesUnlocked, detected: job.products.length, normalized: job.products.length, accepted: accepted.length, toVerify: toVerify.length, excluded: job.products.length - accepted.length - toVerify.length, incomplete: 0, notAProductPage: 0, duplicates: 0, networkErrors: 0, parseErrors: 0, browserRequired: 0, browserUsed: 0, sitemapsRead: [], durationMs: Date.now() - t0, remaining: 0, notes: [`server cascade via ${res.provider} (${res.mode}) · ${pagesUnlocked} page(s) → ${totalCredits} credit(s) → ${job.products.length} product(s)`], errors: [], unlock: true, credits: totalCredits, provider: res.provider, countryMismatch: !!res.country_mismatch };
        fs.writeFileSync(job.paths.reportJson, JSON.stringify(report, null, 2));
        fs.writeFileSync(job.paths.reportTxt, `Job ${job.id}\n\n${formatReport(report)}\n`);
        job.setStatus(job.products.length ? 'done' : 'stopped:NO_PRODUCTS', { report, reason: job.products.length ? '' : 'cascade rendered the page but no products were extracted' });
        // Report the run to the server (run_feedback) so the shared profile improves for all clients.
        try { const host = new URL(url).hostname.replace(/^www\./, ''); await client.feedback(host, { outcome: job.products.length ? 'success' : 'partial', products_found: job.products.length, duration_ms: report.durationMs, provider_used: res.provider, mode_used: res.mode, eloshon_credits: totalCredits, country_used: res.country_used, country_mismatch: !!res.country_mismatch }); } catch { /* best-effort */ }
        recordProfile(url, { ...report, discovery: { method: report.method, browserPagesRendered: 0 } }, job, { needsUnlock: true, blockedBy: input.blockedBy || undefined, extractorStrategy: `cascade:${res.provider}` });
        // User-facing 'done' carries the RESULT and cost only — never the provider,
        // technical mode or country mismatch (those remain in the local report.json
        // and the server logs for cost piloting).
        emit('done', { jobId: job.id, status: job.job.status, stoppedByUser: false, error: null, reason: '', diagnosis: 'ok', blocked: null, remaining: 0, counts: counters(job), durationMs: report.durationMs, csvPath: job.paths.csv, reportPath: job.paths.reportTxt, csvToVerify: toVerify.length ? job.paths.csv.replace(/\.csv$/, '-to-verify.csv') : null, credits: totalCredits, fromProfile: !!res.from_profile });
        active = null;
        return { ok: true, jobId: job.id, count: job.products.length, credits: totalCredits, provider: res.provider };
      } catch (e) { failJob(job, e); return { ok: false, error: String((e && e.message) || e) }; }
    },

    /**
     * Click-to-learn — the "Teach this page" flow. Opens a HEADFUL browser on the
     * analysed URL and waits for the user to click ONE product, then derives BOTH
     * recipes from that single gesture (link_filter + manual_selectors,
     * core/link-learn.mjs), persists them to the domain profile, and shares them
     * as a candidate. FAIL-SAFE: a click that yields no valid recipe saves NOTHING
     * and returns an actionable reason — never a guessed recipe (same contract as
     * the derivers). Pagination is deliberately NOT a manual step: a learned
     * link_filter rides the browser lane's existing generic load-more /
     * infinite-scroll / numbered-pagination exhaustion (core/browser.mjs
     * collectListing), so the user never has to teach "next".
     * @param {string} url
     * @param {{ session?:object }} [opts]  `session` injects a BrowserSession (tests only).
     * @returns {Promise<{ ok:boolean, recognized?:number, learned?:object, reason?:string }>}
     */
    async teach(url, opts = {}) {
      if (!url) return { ok: false, reason: 'no_url' };
      if (!opts.session && !(await browserAvailable())) return { ok: false, reason: 'no_browser' };
      // A live capture (or a running scrape holding the browser profile) must not
      // race a second headful launch — cancel any stale teach first.
      if (teachSession) { try { teachSession.abort.abort(); await teachSession.session.close(); } catch { /* ignore */ } teachSession = null; }

      const saved = readJson(dirs.configFile) || {};
      const cfg = loadConfig({ outputDir: dirs.data });
      // A DEDICATED profile dir (not the run's .browser-profile) so a teach never
      // contends with an in-flight scrape for the Chromium profile lock.
      const profileDir = path.join(outputRoot(cfg), '.teach-profile');
      try { fs.mkdirSync(profileDir, { recursive: true }); } catch { /* best-effort */ }
      const abort = new AbortController();
      const session = opts.session || new BrowserSession({ headless: false, userDataDir: profileDir, userAgent: saved.userAgent || undefined });
      teachSession = { session, abort };

      let capture = null, error = null;
      try { ({ capture, error } = await session.captureClick(url, { signal: abort.signal, labels: opts.labels })); }
      catch (e) { error = String((e && e.message) || e); }
      finally { try { await session.close(); } catch { /* ignore */ } teachSession = null; }

      if (!capture) return { ok: false, reason: error || 'no_capture' };

      // One click = BOTH recipes. Count what they actually recognise on the snapshot
      // (the honest "N products" signal): link_filter's own selection first, else
      // the manual_selectors replay.
      const { linkFilter, manualSelectors } = learnRecipesFromClick(capture, { deriveSelectorRecipe });
      if (!linkFilter && !manualSelectors) return { ok: false, reason: 'no_recipe' };
      let recognized = linkFilter ? recognizedCount(capture, linkFilter) : 0;
      if (!recognized && manualSelectors) { try { recognized = applySelectorRecipe(capture.domSnapshot, manualSelectors, capture.pageUrl).length; } catch { recognized = 0; } }

      // Persist locally (the domain profile mirrors the shared jsonb verbatim).
      try { profiles.record(url, { linkFilter: linkFilter || undefined, manualSelectors: manualSelectors || undefined }); } catch { /* best-effort */ }
      // Share as a CANDIDATE (best-effort; the server owns candidate→shared promotion).
      try {
        const client = edgeClientFor(saved);
        if (client.isConfigured()) {
          const host = new URL(url).hostname.replace(/^www\./, '');
          const fields = manualSelectors ? Object.keys(manualSelectors.fields || {}) : [];
          client.pushRecipe(host, { link_filter: linkFilter || null, manual_selectors: manualSelectors || null, fields_available: fields }).catch(() => {});
        }
      } catch { /* best-effort */ }

      return {
        ok: true, recognized,
        learned: { linkFilter: !!linkFilter, manualSelectors: !!manualSelectors, fields: manualSelectors ? Object.keys(manualSelectors.fields || {}) : [] },
      };
    },

    /** Cancel an open teach capture (the user closed the panel). */
    teachCancel() { if (teachSession) { try { teachSession.abort.abort(); } catch { /* ignore */ } } },

    async probe(url, opts = {}) {
      // Give the analysis the SAME knowledge a run has: pull the shared internal_api
      // recipe first (the run does this too), so Analyze reflects what a scrape would
      // actually do — not "browser render / teach this page" for a site whose recipe
      // is shared-only or was down-ranked by a local taught recipe.
      await syncSharedRecipe(url);
      const prof = profiles.get(url);
      const recipe = profiles.hints(url).internalApi;
      const p = await probeSource(url, { recipe, profile: prof, contentType: opts && typeof opts === 'object' ? opts.contentType : undefined });
      // The analysis must reflect the WHOLE chain, not just the free HTTP read:
      // when the free path can't get products BUT an assisted unlock is available,
      // surface it as "protected — scrapable with assisted unlock (≈ N credits)"
      // instead of a bare failure. Generic: true for ANY site whose free path is
      // blocked and whose cascade (per app_config.provider_order + any learned
      // recipe) can unlock it; nothing site-specific. The unlock is an OPTION with
      // an estimated cost, never a guarantee — if every provider fails, the run
      // reports all_providers_failed.
      // The paid unlock is only offered when unlocking would plausibly HELP — i.e.
      // the free path was BLOCKED (a bot wall / needs a real browser / unreachable
      // from here). It is NOT offered when the page was reachable and its structured
      // data was even seen but no product could be reached ('structured-undetected'):
      // that is a DISCOVERY gap (links/API not followed), not a block, so re-fetching
      // the same HTML through a provider would bill credits for nothing. Until one of
      // the generic discovery capabilities (follow-links / listen-XHR / learn-example)
      // can extract it, the diagnosis says so and offers NO paid unlock.
      let assistedUnlock = null;
      try {
        if (['blocked', 'needs-browser', 'unreachable'].includes(p.diagnosis)) {
          const client = edgeClientFor(readJson(dirs.configFile));
          if (client.isConfigured()) {
            const d = describeEstimate(await client.estimate(url, 1), await currentRate());
            if (d.ok) {
              // "Proven" only when the shared profile already has a recipe with known
              // extractable fields for this host; otherwise warn that a first unlock
              // on an unknown site may return nothing exploitable (point 1a).
              let expectedFields = null;
              try { const prof = await client.profile(new URL(url).hostname.replace(/^www\./, '')); expectedFields = (prof && prof.recipe && prof.recipe.fields_available) || null; } catch { /* */ }
              const unproven = !d.fromProfile && !(expectedFields && expectedFields.length);
              assistedUnlock = { available: true, credits: d.total, fromProfile: d.fromProfile, message: d.message, expectedFields, unproven };
            }
          }
        }
      } catch { /* best-effort — the free diagnosis still stands */ }
      return {
        text: formatProbe(p),
        headline: p.headline,
        best_path: p.best_path, product_count: p.product_count,
        free_fields: p.free_fields, browser_fields: p.browser_fields, unlock_fields: p.unlock_fields, absent_fields: p.absent_fields,
        field_status: p.field_status, protected_site: p.protected_site, known_count: p.known_count,
        diagnosis: p.diagnosis, diagnosis_reason: p.diagnosis_reason, action: p.action,
        url_type: p.url_type, locale: p.locale, product_data: p.product_data,
        confidence: p.confidence,
        assistedUnlock,
      };
    },

    listJobs() {
      const cfg = loadConfig({ outputDir: dirs.data });
      const activeId = active?.jobId || null;
      return listJobs(cfg).map((id) => {
        try {
          const job = new Job(cfg, id);
          const m = job.job.meta || {};
          let status = job.job.status;
          // A job marked running/discovering that is NOT the live run is stale
          // (the app was closed or the run errored) → show + persist 'interrupted'
          // so it never appears "En cours" forever and can be resumed.
          if ((status === 'running' || status === 'discovering') && id !== activeId) {
            status = 'interrupted';
            try { job.setStatus('interrupted'); } catch { /* ignore */ }
          }
          const rep = job.job.report || null;
          return {
            id, status, source: m.origin || (m.urls?.length ? `${m.urls.length} URL` : '—'),
            store: m.store || null, createdAt: job.job.createdAt, updatedAt: job.job.updatedAt,
            discovered: job.discovered.length, processed: job.processed.size, products: job.products.length,
            counts: counters(job),
            reason: job.job.reason || jobReason(rep, job.job.error) || '',
            diagnosis: rep?.discovery?.diagnosis || null,
            isUrl: /^https?:\/\//i.test(m.origin || ''),
            // Ran in the user's own browser (extension tier): not resumable by the engine.
            via: m.provider === 'your-browser' ? 'your-browser' : null,
            // Content type the run collected ("video" shows the Vidéos badge and the video columns).
            contentType: (rep && rep.contentType && rep.contentType.type) || (m.contentType && m.contentType !== 'auto' ? m.contentType : null),
          };
        } catch { return { id, status: 'unknown' }; }
      }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },

    /** The full technical report for a finished job (persisted per job). Reads
     *  reports/<id>.txt; falls back to reconstructing from the saved job.report
     *  (so jobs whose .txt is missing still show a report). No secrets. */
    jobReport(jobId) {
      const cfg = loadConfig({ outputDir: dirs.data });
      let job; try { job = new Job(cfg, jobId); } catch { return { ok: false, text: null, reportPath: null }; }
      let text = null;
      try { text = fs.readFileSync(job.paths.reportTxt, 'utf8'); } catch { text = null; }
      if (!text) { const rep = job.job && job.job.report; if (rep) { try { text = `Job ${jobId}\n\n${formatReport(rep)}\n`; } catch { text = null; } } }
      const reportPath = (() => { try { return fs.existsSync(job.paths.reportTxt) ? job.paths.reportTxt : null; } catch { return null; } })();
      return { ok: !!text, text: text || null, reportPath };
    },

    /** The parsed report.json of a job (admin job view only — read through a gated
     *  IPC). null when the job or its report does not exist. No secrets by design. */
    jobReportData(jobId) {
      if (!jobId || !/^[A-Za-z0-9_-]+$/.test(String(jobId))) return null;
      const cfg = loadConfig({ outputDir: dirs.data });
      let job; try { job = new Job(cfg, jobId); } catch { return null; }
      try { return JSON.parse(fs.readFileSync(job.paths.reportJson, 'utf8')); } catch { return (job.job && job.job.report) || null; }
    },

    jobProducts(jobId, { limit = 2000 } = {}) {
      const cfg = loadConfig({ outputDir: dirs.data });
      const job = new Job(cfg, jobId);
      return job.products.slice(0, limit).map((p) => ({
        key: p.source_url || p.source_product_id || (p.name || ''),
        name: p.name,
        price: p.price, currency: (p.raw && /^[A-Z]{3}$/.test(p.raw.currency || '')) ? p.raw.currency : null, status: p.__eligibility?.status || 'to_verify', code: p.__eligibility?.code || null,
        reason: p.__eligibility?.reason || '', image_url: p.image_url || null,
        images: Array.isArray(p.images) ? p.images : (p.image_url ? [p.image_url] : []),
        columns: (p.raw && p.raw.columns && typeof p.raw.columns === 'object') ? p.raw.columns : null, // the user's own columns (panel, taught fields)
        source_url: p.source_url || null, source_product_id: p.source_product_id || null,
        barcode: p.barcode || null, product_type: p.product_type || null,
        category_slug: p.category_slug || null, source_category: p.source_category || null,
        weight_kg: p.weight_kg ?? null,
        // Net content as the source states it ("70cl", "4x33cl", "500 g", "150pc"): shown when no mass in kg exists.
        net_content: (p.raw && p.raw.weight_text) || null,
        weight_estimated: !!(p.raw && p.raw.weight_estimated),   // weight_kg is an estimate (liquid), not a stated mass
        is_alcoholic: !!p.is_alcoholic, storage_info: p.storage_info || null,
        description: p.description || null,
        // Video columns (raw.columns, additive): duration "m:ss", views, publication date, player address.
        duration: (p.raw && p.raw.columns && p.raw.columns.duration) || null,
        views: (p.raw && p.raw.columns && p.raw.columns.views) || null,
        published_at: (p.raw && p.raw.columns && p.raw.columns.published_at) || null,
        embed_url: (p.raw && p.raw.columns && p.raw.columns.embed_url) || null,
        // Product-page details: brand, stock, customer rating, options and technical specs.
        brand: (p.raw && p.raw.brand) || null,
        availability: (p.raw && p.raw.availability) || null,
        rating: p.raw && p.raw.rating != null ? p.raw.rating : null,
        review_count: p.raw && p.raw.review_count != null ? p.raw.review_count : null,
        variants: Array.isArray(p.variants) ? p.variants.slice(0, 60).map((v) => ({ name: v && v.name != null ? String(v.name) : null, price: v && v.price != null ? v.price : null, availability: (v && v.availability) || null })).filter((v) => v.name) : [],
        specs: p.raw && Array.isArray(p.raw.specs) ? p.raw.specs.slice(0, 300) : [],
      }));
    },

    /** Manual accept/exclude override (To-verify review). Rewrites the CSV. */
    overrideEligibility(jobId, key, status) {
      const cfg = loadConfig({ outputDir: dirs.data });
      const job = new Job(cfg, jobId);
      let changed = 0;
      for (const p of job.products) {
        const k = p.source_url || p.source_product_id || (p.name || '');
        if (k === key) { p.__eligibility = { ...(p.__eligibility || {}), status, code: 'manual_override', reason: 'manual decision' }; changed++; }
      }
      if (changed) {
        job._dirty = true; job.flush();
        const meta = job.job.meta || {};
        const accepted = job.products.filter((p) => p.__eligibility?.status === 'accepted');
        const toVerify = job.products.filter((p) => p.__eligibility?.status === 'to_verify');
        fs.writeFileSync(job.paths.csv, toImportCsv(accepted, { storeSlug: meta.store, categorySlug: meta.categorySlug }), 'utf8');
        const tv = job.paths.csv.replace(/\.csv$/, '-to-verify.csv');
        if (toVerify.length) fs.writeFileSync(tv, toImportCsv(toVerify, { storeSlug: meta.store, categorySlug: meta.categorySlug }), 'utf8');
        else { try { fs.rmSync(tv, { force: true }); } catch { /* ignore */ } }
      }
      return { ok: changed > 0, changed, counts: counters(job) };
    },

    providerStatus() {
      return Object.values(registry).map((p) => ({ id: p.id, label: p.label, configured: p.isConfigured() }));
    },
  };
}
