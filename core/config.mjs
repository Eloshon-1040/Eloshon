/**
 * Simple local configuration. Defaults live here; an optional
 * `scraper-output/config.json` (gitignored) overrides them; CLI flags override
 * both. No secrets here — the browser profile (cookies/logins) lives on disk
 * under scraper-output/.browser-profile and is never committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setWeightEstimatePolicy } from './weight.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..'); // app/frontend

export const DEFAULTS = {
  outputDir: 'scraper-output',
  // fetcher
  timeoutMs: 20000,
  retries: 2,
  rateLimitMs: 600,   // polite per-host spacing
  workers: 4,
  // discovery / crawl guardrails
  maxPages: 150,
  maxProducts: 1000,
  maxDepth: 3,
  // browser fallback
  browser: true,      // allow Playwright fallback for CSR pages
  maxBrowser: 40,
  // Render fallback trigger for UNKNOWN sites: run the CSR browser pass when the
  // free HTTP path found fewer than this many products on a reachable, non-blocked
  // page (the archetype-3 first-visit case — an XHR/RSC grid returns a shell that
  // yields ~1 over HTTP). Default 2 = fire on 0–1 only, so a page that already
  // found several is never re-rendered. A remembered browser-needing host uses the
  // more aggressive `< sitemapMin` instead (learned via the domain profile).
  csrFewThreshold: 2,
  headless: true,     // headful only needed for manual intervention (false = watch the local browser)
  // Per-page render budget of the local browser (ms); null = derived from timeoutMs
  // (max(15 s, timeoutMs + 12 s), core/engine.mjs).
  renderTimeoutMs: null,
  breaker: 6,
  // Refusals (HTTP 403…) in a row before the source is considered refused; one
  // refused page is skipped and reported, the run goes on.
  deniedStreak: 3,
  // Collection scope: when discovery starts from a specific listing URL and a
  // product grid is found on the page, deeper LISTING links are limited to the
  // page BODY (nav/header/footer/aside excluded) and off-grid product links are
  // counted in the report instead of queued. A home URL keeps the full crawl.
  scopeToCollection: true,
  // recovery ladder (F1/F2 + F3.1 browser escalation). ON by default; a user
  // can disable it with `"recovery": false` in config.json (no dedicated UI).
  recovery: true,
  // site-catalogue TTLs (ms) — how often each class is re-tested
  catalogueTtlHttpMs: 7 * 24 * 60 * 60 * 1000,
  catalogueTtlBrowserMs: 7 * 24 * 60 * 60 * 1000,
  catalogueTtlRecipeMs: 14 * 24 * 60 * 60 * 1000,
  // Post-run QUALITY GATE thresholds (approved). Business config — editable via
  // config.json without a code change; the engine uses these to judge whether a
  // finished run is real (see core/run-quality.mjs). A run that trips any of these
  // ends as a failure that self-corrects / surfaces "Apprendre cette page",
  // never a silent "ok" with empty rows.
  quality: {
    minAcceptedRatio: 0.10,
    maxEmptyNameRatio: 0.30,
    maxEmptyPriceRatio: 0.60,
    maxEmptyImageRatio: 0.85,
    flagListingAsProduct: true,
    flagSeedsWithoutFiche: true,
  },
  // Product-page completion after a LISTING lane (recipe / internal API / platform
  // feed): one free HTTP visit per product page, at the polite rate above, to add
  // colour, sizes + EAN, gallery, real description, brand, list price. Bounded by
  // the job's maxProducts (every product listed can be completed); `maxPerJob` = an
  // optional extra cap (null = none). Stops after `sample` visits if none adds data
  // (e.g. a grocery API whose product pages carry nothing more).
  detailPages: { enabled: true, maxPerJob: null, sample: 3 },
  // Generic listing pagination (recipe replay): page cap per job, on top of the
  // product cap and the "no new product" / loop / total-reached stops.
  // `jsHeaders`: when the listing's API refuses the plain request and the local
  // browser is not allowed, read the page's public scripts (at most `jsHeaderFiles`
  // files of `jsHeaderFileBytes` each, free HTTP) for the static header the page's
  // own code sends — see core/api-header-discovery.mjs.
  listPagination: { enabled: true, maxPages: 50, jsHeaders: true, jsHeaderFiles: 10, jsHeaderFileBytes: 2 * 1024 * 1024 },
  // Paid escalation after the free lanes found nothing: how many allowed paid routes
  // may be tried for one page (in the configured order, until one yields products),
  // and the time budget of each route. Opt-in, caps and the kill switch still apply
  // to every route (see app/controller.mjs, "UNLOCK escalation tiers").
  escalation: { maxRoutesPerPage: 3, routeTimeoutMs: 120000 },
  // Stock per size + reviews that product pages load with their own requests:
  // learned on ONE page in the local browser (needs the browser fallback), then
  // asked for every product over free HTTP. Category trail from the listing page.
  sideData: { enabled: true },
  // Weight of a LIQUID when the site gives a volume but no mass: volume x kgPerLitre, plus a
  // container allowance (%). Marked as an estimate in the data; a real mass is never replaced.
  weightEstimate: { enabled: true, kgPerLitre: 1, containerPct: 10 },
  // Pages read in the local browser after the site refused plain HTTP: spaced by
  // this delay; the first human check asked by the site stops them for the run.
  browserPageGapMs: 3000,
  // Job watchdog, over the WHOLE job (last phase and browser close included): no
  // progress for `stallMs` → the job is stopped as stalled and every external wait
  // is aborted; a stop that has not finished `stopGraceMs` after it was asked
  // (a wait that ignores it) is released the same way.
  watchdog: { stallMs: 120000, stopGraceMs: 30000 },
};

export function loadConfig(overrides = {}) {
  const cfg = { ...DEFAULTS };
  const filePath = path.join(REPO_ROOT, DEFAULTS.outputDir, 'config.json');
  try {
    if (fs.existsSync(filePath)) Object.assign(cfg, JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (e) { console.warn('[scraper] ignoring invalid config.json:', e.message); }
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined) cfg[k] = v;
  // quality thresholds deep-merge onto defaults, so a partial config.json/override
  // (e.g. just maxEmptyNameRatio) keeps the other approved thresholds.
  cfg.quality = { ...DEFAULTS.quality, ...(cfg.quality || {}), ...(overrides.quality || {}) };
  cfg.detailPages = { ...DEFAULTS.detailPages, ...(cfg.detailPages || {}), ...(overrides.detailPages || {}) };
  cfg.listPagination = { ...DEFAULTS.listPagination, ...(cfg.listPagination || {}), ...(overrides.listPagination || {}) };
  cfg.sideData = { ...DEFAULTS.sideData, ...(cfg.sideData || {}), ...(overrides.sideData || {}) };
  cfg.escalation = { ...DEFAULTS.escalation, ...(cfg.escalation || {}), ...(overrides.escalation || {}) };
  cfg.weightEstimate = { ...DEFAULTS.weightEstimate, ...(cfg.weightEstimate || {}), ...(overrides.weightEstimate || {}) };
  cfg.watchdog = { ...DEFAULTS.watchdog, ...(cfg.watchdog || {}), ...(overrides.watchdog || {}) };
  // every job flow loads its config first: the estimate policy follows it (module state in weight.mjs)
  setWeightEstimatePolicy(cfg.weightEstimate);
  return cfg;
}

export function outputRoot(cfg) { return path.isAbsolute(cfg.outputDir) ? cfg.outputDir : path.join(REPO_ROOT, cfg.outputDir); }
