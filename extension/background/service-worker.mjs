/**
 * Service worker — the extension's orchestrator (Requirement D/E/F). It:
 *   - links to the desktop app via the native host (NativeLink), speaking the
 *     shared versioned protocol;
 *   - runs jobs by driving a real tab (TabDriver) through the shared interpreter,
 *     with the shared adaptive pacer and pluggable challenge strategies;
 *   - persists cursor/products in chrome.storage (JobStore) so a job survives SW
 *     sleep, browser restart and long human pauses;
 *   - keeps itself alive across long waits with chrome.alarms and resumes RUNNING
 *     jobs after a suspend;
 *   - surfaces status to the popup and to the app (badge + notifications).
 *
 * No secret is ever stored, logged or sent. Recipes are DATA interpreted by this
 * code; nothing is fetched or eval'd from the network.
 */
import { NativeLink, createRouter } from './native-link.mjs';
import { TabDriver } from './tab-driver.mjs';
import { readSubpages, subpageUrls } from './subpages.mjs';
import { createQueueStore, planEnrichment, newQueue, pendingUrls, summarize, closeReading, toResume, missingUrls, followUpQueue } from './enrich-queue.mjs';
import { hasDomainPermission, grantedDomains, originsForDomain } from './permissions.mjs';
import { runProgram } from '../vendor/shared/dsl/interpret.mjs';
import { runRecipeLane } from '../vendor/shared/internal-api.mjs';
import { migrateRecipe } from '../vendor/shared/recipe/migrate.mjs';
import { PacingRegistry } from '../vendor/shared/pacing/pacer.mjs';
import { defaultChallengeRegistry } from '../vendor/shared/challenge/index.mjs';
import { JobStore, productKey } from '../vendor/shared/job/store.mjs';
import { STATE } from '../vendor/shared/job/machine.mjs';
import * as P from '../vendor/shared/protocol/messages.mjs';
import { classifyHtmlPage, classifyItem, mergeRules } from '../vendor/shared/classify/page-kind.mjs';
import { extractEmbeddedProducts, embeddedJsonValues } from '../vendor/shared/extract/embedded-state.mjs';
import { productArraySources } from '../vendor/shared/extract/ai-assist.mjs';
import { extractDomGrid } from '../vendor/shared/extract/dom-grid.mjs';
import { bestFromSrcset } from '../vendor/shared/extract/images.mjs';
import { listingMicrodata } from '../vendor/shared/extract/microdata.mjs';
import { productsFromCaptures, replayPaginate, enrichFromCaptures } from '../vendor/shared/extract/xhr-endpoint.mjs';
import { emptyPageDiagnosis } from '../vendor/shared/classify/empty-diagnosis.mjs';
import { defaultProgram, mapState, laneProducts, sameSiteUrl } from './program.mjs';
import { runPanelExtraction, panelReader, PANEL_MAX_ROWS } from './panel-run.mjs';
import { mergeRecipe, rowKey } from '../vendor/shared/extract/card-recipe.mjs';
import { sanitizePaginationMemo, patchPaginationMemo, sanitizeCues } from '../vendor/shared/extract/pagination-memo.mjs';
import { sanitizeCardModel, REJECT_REASONS } from '../vendor/shared/extract/card-model.mjs';
import { detectPlatform } from '../vendor/shared/platform/platform.mjs';
import { platformDefaultLane, collectionScope, PLATFORMS_WITH_DEFAULT } from '../vendor/shared/platform/platform-strategy.mjs';
import { mergeKnowledgeIntoRow, rowKeysOf } from '../vendor/shared/knowledge/apply.mjs';

const HEARTBEAT = 'elo-heartbeat';

// chrome.storage.session (in-memory, cleared on browser close) for cursors that
// need not persist across restarts; chrome.storage.local for durable state.
function storageAdapter(area) {
  return {
    async get(k) { const o = await chrome.storage[area].get(k); return o[k]; },
    async set(k, v) { await chrome.storage[area].set({ [k]: v }); },
    async remove(k) { await chrome.storage[area].remove(k); },
  };
}

const jobStore = new JobStore(storageAdapter('local'), { dedupKey: productKey });
const pacing = new PacingRegistry({});
const challenges = defaultChallengeRegistry();

/** Runtime registry of live jobs (AbortSignal + tabId) — rebuilt on wake. */
const live = new Map();

// ONE link for the whole service worker: startup, install, the wake-up alarm and the module load all
// call connectApp(), which used to create a new link (and a new host process) each time.
let link = null;
function connectApp() {
  if (!link) {
    link = new NativeLink(chrome, {
      onMessage: (msg) => router.handle(msg),
      onStatus: (s) => broadcast({ kind: 'link_status', status: s }),
      log: (e) => console.debug('[native]', e),
    });
  }
  link.ensure();
}

function sendApp(msg) { if (link) link.send(msg); }

// Announce our capabilities AND the live list of domains the user has granted host
// permission for — the single source of truth the app uses to decide whether the
// tier is usable on a site (no config.json flag, no restart). Re-sent whenever a
// domain is activated/removed, so the app updates the moment the user clicks
// "Activer ce domaine".
async function sendCapabilities() {
  let domains = [];
  try { domains = await grantedDomains(chrome); } catch { domains = []; }
  sendApp(P.capabilities(['internal_api', 'embedded_state', 'dom', 'json_ld', 'actions'], {
    browser: detectBrowser(), extensionVersion: chrome.runtime.getManifest().version, domains,
  }));
}
try {
  chrome.permissions.onAdded.addListener(() => { sendCapabilities(); });
  chrome.permissions.onRemoved.addListener(() => { sendCapabilities(); });
} catch { /* permissions events unavailable — the app still learns domains on connect */ }

// Pending AI-assist requests (corr id = the request envelope id → the app echoes it).
const aiPending = new Map();

const router = createRouter({
  [P.MSG.HELLO]: () => { sendCapabilities(); },
  [P.MSG.JOB]: (payload) => { startJob(payload).catch((e) => sendApp(P.error('E_JOB', String(e && e.message || e), { job_id: payload.job_id }))); },
  [P.MSG.PAUSE]: (payload) => pauseJob(payload.job_id),
  [P.MSG.RESUME]: (payload) => resumeJob(payload.job_id),
  [P.MSG.STOP]: (payload) => stopJob(payload.job_id),
  [P.MSG.DIAGNOSTIC]: (payload) => sendDiagnostic(payload.job_id),
  [P.MSG.AI_RESULT]: (payload, raw) => { const w = aiPending.get(raw.id); if (w) { clearTimeout(w.timer); aiPending.delete(raw.id); w.resolve(payload || { ok: false, reason: 'vide' }); } },
  [P.MSG.PANEL_RESULT]: (payload, raw) => { const w = panelPending.get(raw.id); if (w) { clearTimeout(w.timer); panelPending.delete(raw.id); w.resolve(payload || { ok: false, reason: 'vide' }); } },
  // The host answers « app closed »: the requests waiting for the app get that answer now, not after their time limit.
  [P.MSG.ERROR]: (payload) => {
    if (!payload || payload.code !== 'E_APP_DOWN') return;
    for (const pending of [panelPending, aiPending]) { for (const [id, w] of pending) { clearTimeout(w.timer); pending.delete(id); w.resolve({ ok: false, reason: 'application hors ligne' }); } }
  },
}, { send: sendApp, log: (e) => console.debug('[router]', e) });

// Collect the page's JSON (script islands + captured XHR), forward it to the app for
// AI analysis (the app holds the key), and resolve with {ok, cards, hints}. On-demand
// only — called when the user clicks the AI button in the panel.
async function aiCollectAndAssist({ tabId, fields, settings } = {}) {
  if (!link || link.status !== 'connected') return { ok: false, reason: 'application hors ligne' };
  if (tabId == null) return { ok: false, reason: 'onglet introuvable' };
  let tab; try { tab = await chrome.tabs.get(tabId); } catch { return { ok: false, reason: 'onglet introuvable' }; }
  let domain = ''; try { domain = new URL(tab.url).hostname.replace(/^www\./, ''); } catch { return { ok: false, reason: 'cette page n’est pas un site web' }; }
  if (!(await hasDomainPermission(chrome, domain))) return { ok: false, reason: 'site non activé — clique « Activer ce site »' };
  const driver = new TabDriver(chrome, tabId, { log: () => {} });
  let ctx; try { ctx = await driver.context(); } catch { return { ok: false, reason: 'lecture de la page impossible' }; }
  const body = (ctx && ctx.body) || '';
  const sources = [];
  // (1) JSON script islands (application/json, ld+json, __NEXT_DATA__…).
  const re = /<script\b[^>]*type\s*=\s*["'](?:application\/(?:ld\+)?json)["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m; let n = 0;
  while ((m = re.exec(body)) && n < 25) { const t = (m[1] || '').trim(); if (t && (t[0] === '{' || t[0] === '[')) { sources.push(t); n++; } }
  // (1b) the page's inline state (window.X = {…}, JSON.parse("…"), Next.js rows): only
  // the lists that look like products, trimmed — most sites keep their grid there.
  try { for (const t of productArraySources(embeddedJsonValues(body, { max: 40 }))) { if (n >= 60) break; sources.push(t); n++; } } catch { /* best effort */ }
  // (2) captured XHR/GraphQL bodies (if the interceptor was active on this tab).
  try { for (const c of (await driver.capturedResponses()) || []) { if (n >= 60) break; const t = String((c && c.body) || '').trim(); if (t && (t[0] === '{' || t[0] === '[')) { sources.push(t); n++; } } } catch { /* none */ }
  if (!sources.length) return { ok: false, reason: 'aucune donnée JSON lisible sur la page' };
  // The link to the app takes messages up to 1 MB: keep the sources within ~800 KB,
  // in their order (islands, page-state product lists, captured answers).
  let budget = 800000; const kept = [];
  for (const t of sources) { if (t.length <= budget) { kept.push(t); budget -= t.length; } }
  if (!kept.length) return { ok: false, reason: 'données de la page trop volumineuses pour l’IA' };
  sources.length = 0; sources.push(...kept);
  const reqMsg = P.aiRequest({ mode: 'run', sources, baseUrl: (ctx && ctx.url) || `https://${domain}/`, url: (ctx && ctx.url) || '', lang: (settings && settings.lang) || 'fr', fields });
  return await new Promise((resolve) => {
    const timer = setTimeout(() => { aiPending.delete(reqMsg.id); resolve({ ok: false, reason: 'délai IA dépassé' }); }, 60000);
    aiPending.set(reqMsg.id, { resolve, timer });
    sendApp(reqMsg);
  });
}

function detectBrowser() {
  const ua = navigator.userAgent || '';
  if (/Edg\//.test(ua)) return 'edge';
  if (/Brave/.test(ua) || navigator.brave) return 'brave';
  return 'chrome';
}

// ---- Job lifecycle ----------------------------------------------------------

async function startJob(payload) {
  const { job_id, domain, recipe: rawRecipe, config = {}, limits = {} } = payload;
  const { recipe, unknownFuture } = migrateRecipe(rawRecipe);
  if (unknownFuture) { sendApp(P.result(job_id, P.JOB_STATUS.ERROR, { reason: 'recipe_schema_too_new' })); return; }

  // Host permission is a per-domain opt-in granted via the popup user gesture.
  const granted = await hasDomainPermission(chrome, domain);
  if (!granted) {
    await jobStore.create(job_id, { domain, recipeRevision: recipe.revision });
    await jobStore.setState(job_id, STATE.BLOCKED).catch(() => {});
    notify('permission', 'Autorisation requise', `Ouvrez l'extension et activez le domaine ${domain} pour lancer ce travail.`);
    sendApp(P.result(job_id, P.JOB_STATUS.BLOCKED, { reason: 'permission_required', domain }));
    return;
  }

  await jobStore.create(job_id, { domain, recipeRevision: recipe.revision });
  // The app sends the domain's configured (already sanitised) pacing with the job.
  if (payload.pacing && typeof payload.pacing === 'object') pacing.configure(domain, payload.pacing);
  const controller = { aborted: false };
  await registerNetCapture(domain); // must be in place BEFORE the tab navigates
  const tab = await openTab(domain, payload.start_url);
  live.set(job_id, { signal: controller, tabId: tab.id, domain });
  try {
    await runJobOnTab(job_id, recipe, { domain, config, limits, tabId: tab.id, signal: controller, pageRules: payload.page_rules, challenge: payload.challenge, detail: payload.detail || null });
  } finally {
    await unregisterNetCapture();
  }
}

async function openTab(domain, startUrl) {
  const url = startUrl || `https://${domain}/`;
  // Foreground: the user sees the run (and any challenge to solve) in the tab.
  return chrome.tabs.create({ url, active: true });
}

// Register the MAIN-world network interceptor for this domain at document_start, so
// it wraps fetch/XHR before the page's own scripts fetch the grid. Scoped to the
// granted domain (no broad host access); best-effort, never fails the job.
async function registerNetCapture(domain) {
  try {
    const matches = originsForDomain(domain);
    if (!matches.length || !chrome.scripting.registerContentScripts) return;
    await chrome.scripting.unregisterContentScripts({ ids: ['elo-net'] }).catch(() => {});
    await chrome.scripting.registerContentScripts([{
      id: 'elo-net', matches, js: ['content/net-capture.mjs'],
      runAt: 'document_start', world: 'MAIN', allFrames: false, persistAcrossSessions: false,
    }]);
  } catch (e) { console.debug('[job]', 'net-capture register skipped', String(e && e.message || e)); }
}
async function unregisterNetCapture() {
  try { await chrome.scripting.unregisterContentScripts({ ids: ['elo-net'] }); } catch { /* not registered */ }
}

async function runJobOnTab(job_id, recipe, ctx) {
  const { domain, config, limits, tabId, signal } = ctx;
  const pacer = pacing.get(domain);
  // Same "is this a product?" rules as the standard engine (shared/classify).
  const pageRules = mergeRules(ctx.pageRules);
  const driver = new TabDriver(chrome, tabId, { log: (e) => console.debug('[tab]', e) });
  await jobStore.setState(job_id, STATE.RUNNING).catch(() => {});
  await driver.goto(recipe.start_url || `https://${domain}/`).catch(() => {});
  setBadge(tabId, '…');

  // Paced page-runtime fetch for the internal-api lane.
  const httpGet = async (u, o) => {
    const waitMs = pacer.reserve(Date.now());
    if (waitMs > 0) await sleep(waitMs);
    const t0 = Date.now();
    const res = await driver.fetchInPage(u, o);
    pacer.onResponse({ status: res && res.status, latencyMs: Date.now() - t0, t: Date.now() });
    return res;
  };

  const recipeDiag = {}; // names only (resolved/missing vars, lane error) — sent back to the app

  // Generic extraction from the live page's outerHTML, in graceful-degradation
  // order: (1) name-agnostic embedded-JSON scan (every JSON island / inline state,
  // mined by shape), then (2) the DOM-grid heuristic (repeated tiles by structure).
  // Same shared code as the standard engine. No per-site selector.
  const baseUrlOf = (pageCtx) => (pageCtx && pageCtx.url) || recipe.start_url || `https://${domain}/`;
  const genericFrom = (pageCtx) => {
    const base = baseUrlOf(pageCtx);
    const body = (pageCtx && pageCtx.body) || '';
    try { const emb = extractEmbeddedProducts(body, base).cards || []; if (emb.length) return emb; } catch (e) { console.debug('[job]', job_id, { event: 'embedded_error', message: String(e && e.message || e) }); }
    try { const md = listingMicrodata(body, base); if (md.length) return md; } catch (e) { console.debug('[job]', job_id, { event: 'microdata_error', message: String(e && e.message || e) }); }
    try { const grid = extractDomGrid(body, base).cards || []; if (grid.length) return grid; } catch (e) { console.debug('[job]', job_id, { event: 'domgrid_error', message: String(e && e.message || e) }); }
    return [];
  };

  // Fill a MISSING product image from the page's own DOM grid. A recipe / dom
  // extraction (or an API that omits images) may map name/price/url but not the
  // (often lazy-loaded) thumbnail; the page still renders it. Read the page's product
  // tiles — dom-grid handles src / data-src / data-lazy / srcset — and match a tile's
  // image to the product by its detail URL. Generic, no site rule; runs only when a
  // product actually lacks an image and the page has a readable grid.
  const completeImagesFromDom = (products, pageCtx) => {
    try {
      if (!Array.isArray(products) || !products.length) return products;
      if (!products.some((p) => p && !(p.images && p.images.length))) return products;
      const base = baseUrlOf(pageCtx);
      const body = (pageCtx && pageCtx.body) || '';
      const abs = (s) => { try { return new URL(s, base).toString(); } catch { return null; } };
      const norm = (u) => { try { const x = new URL(u, base); return (x.origin + x.pathname).toLowerCase().replace(/\/$/, ''); } catch { return String(u || '').toLowerCase(); } };
      // (a) dom-grid tiles matched by product URL — works when the product-URL shape is
      // recognised (most sites).
      const byUrl = new Map();
      try { for (const g of (extractDomGrid(body, base).cards || [])) { if (g && g.images && g.images.length) { const k = norm(g.sourceUrl || g.canonicalUrl); if (k && !byUrl.has(k)) byUrl.set(k, g.images[0]); } } } catch { /* ignore */ }
      // (b) fallback: locate the product's OWN detail path in the HTML and read the
      // nearest tile image — no URL-shape heuristic, so PrestaShop /NNN-slug.html and
      // other unusual product URLs still recover their (often lazy) thumbnail.
      const okSrc = (s) => s && !/^data:/i.test(s) && !/(?:^|\/)(?:1x1|pixel|blank|spacer|placeholder)\.(?:gif|png|svg)/i.test(s);
      const firstImgIn = (region) => {
        // <img> (lazy attrs first), then <source srcset> (<picture>), then a CSS
        // background-image — covers how catalogues render thumbnails.
        for (const tag of (region.match(/<(?:img|source)\b[^>]*>/gi) || [])) {
          let src = (tag.match(/\b(?:data-src|data-original|data-lazy|src)\s*=\s*("([^"]*)"|'([^']*)')/i) || []).slice(2).find(Boolean);
          if (!src) { const ss = (tag.match(/\b(?:data-srcset|srcset)\s*=\s*("([^"]*)"|'([^']*)')/i) || []).slice(2).find(Boolean); if (ss) src = bestFromSrcset(ss); }
          if (!okSrc(src)) continue;
          const a = abs(src); if (a) return a;
        }
        const bg = region.match(/background-image\s*:\s*url\((["']?)([^"')]+)\1\)/i);
        if (bg && okSrc(bg[2])) { const a = abs(bg[2]); if (a) return a; }
        return null;
      };
      // Distinctive URL keys to find the tile in the HTML: the full pathname AND its
      // last segment (PrestaShop tile hrefs often drop the category prefix, e.g.
      // /fr/1099-slug.html vs /fr/cat/1099-slug.html — the filename is stable).
      const keysOf = (u) => {
        let path; try { path = new URL(u, base).pathname; } catch { path = String(u || '').split('#')[0].split('?')[0]; }
        const seg = path.split('/').filter(Boolean).pop() || '';
        return [path, seg].filter((k) => k && k.length >= 5);
      };
      let filled = 0;
      const out = products.map((p) => {
        if (!p || (p.images && p.images.length)) return p;
        const url = p.sourceUrl || p.canonicalUrl || p.url;
        let img = url ? byUrl.get(norm(url)) : null;
        if (!img && url) { for (const key of keysOf(url)) { const i = body.indexOf(key); if (i >= 0) { img = firstImgIn(body.slice(Math.max(0, i - 1600), i + 1600)); if (img) break; } } }
        if (img) { filled++; return { ...p, images: [img] }; }
        return p;
      });
      if (filled) emitProgress(job_id, { phase: 'image_recover', filled });
      return out;
    } catch { return products; }
  };

  // Set when the auto chain uses captured XHR — so the report can self-explain why a
  // price is missing (captured endpoints, product ids, how many the merge filled),
  // instead of needing a console capture on the site.
  let captureDiag = null;

  const extractors = {
    internal_api: async (pageCtx) => {
      const r = await runRecipeLane(recipe, pageCtx.url, {
        httpGet, siteConfig: config,
        maxProducts: limits.maxProducts || 10000,
        maxPages: recipe.pagination ? (limits.maxListPages || 3) * 50 : 100,
        onStep: (m, e) => emitProgress(job_id, { phase: m, ...e }),
      });
      return laneProducts(r, recipe, recipeDiag); // never swallow the lane's error
    },
    dom: (pageCtx, spec) => driver._call('extract', [{ ...spec, using: 'dom' }]),
    json_ld: () => driver._call('extract', [{ using: 'json_ld' }]),
    // Generic embedded product-state (SPA grids: __NEXT_DATA__ / Nuxt / Redux /
    // Apollo / Hybris …) read from the page's own outerHTML — the SAME extractor
    // the standard engine uses (shared/extract/embedded-state.mjs). No site rules.
    embedded_state: (pageCtx) => genericFrom(pageCtx),
    // Auto = the full graceful-degradation chain: in-page JSON-LD / item_selector,
    // then embedded-JSON scan, then the DOM-grid heuristic; and if ALL of that is
    // still empty, ONE hydration retry (scroll + wait, re-read the DOM) for a grid
    // that loads via client-side XHR after first paint. This is what lets an UNKNOWN
    // catalogue — SPA or server-rendered, hydrated early or late — still yield
    // products with no recipe and no per-site rule.
    auto: async (pageCtx, spec) => {
      const once = async (ctx) => {
        const inPage = await driver._call('extract', [{ ...spec, using: 'auto' }]);
        if (Array.isArray(inPage) && inPage.length) return inPage;
        return genericFrom(ctx);
      };
      let got = await once(pageCtx);
      if (!(Array.isArray(got) && got.length)) {
        // Hydration retry (bounded, content-aware LOOP): many catalogues render their
        // grid client-side from a third-party search/PLP API (Sensefuel, Constructor.io,
        // Algolia…) that fires LATE — after first paint, sometimes many seconds in, and
        // only once a viewport/lazy loader trips. We give it real time to render: up to
        // 6 passes, scrolling STEPWISE (top↔bottom, several steps) to trip those loaders,
        // waiting for it to settle, then re-reading BOTH the rendered DOM AND the
        // captured XHR. Stops as soon as a grid appears. Generic, no per-site rule.
        const base0 = baseUrlOf(pageCtx);
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            // Alternate the scroll direction so both top- and bottom-anchored lazy
            // grids come into view; several small steps beat one jump to the bottom.
            await driver.scroll({ to: attempt % 2 === 0 ? 'bottom' : 'top', times: 4, pause_ms: 400 });
            await sleep(1500);
            const ctxN = await driver.context();
            got = await once(ctxN);
            if (!(Array.isArray(got) && got.length)) {
              const caps = await driver.capturedResponses();
              const best = productsFromCaptures(caps || [], base0);
              if (best && best.cards.length) got = best.cards;
            }
          } catch (e) { console.debug('[job]', job_id, { event: 'hydration_retry_error', message: String(e && e.message || e) }); }
          if (Array.isArray(got) && got.length) { emitProgress(job_id, { phase: 'hydrated_retry', count: got.length, attempt: attempt + 1 }); break; }
        }
      }
      got = got || [];
      // XHR capture + replay (Stage C): the page's own JSON/GraphQL API is the richest
      // source and the only one that paginates cleanly. Use the intercepted response,
      // and replay its endpoint for more pages, when it beats the HTML scan.
      let final = got;
      try {
        const base = baseUrlOf(pageCtx);
        let caps = await driver.capturedResponses();
        if (caps && caps.length) {
          const best = productsFromCaptures(caps, base);
          if (best && best.cards.length) {
            const replayFetch = async (url, o) => { const r = await httpGet(url, { method: o.method, headers: o.headers, body: o.body, as: 'json' }); return r && r.body; };
            let all = best.cards;
            try { all = await replayPaginate({ capture: best.capture, firstCards: best.cards, firstPagination: best.pagination, baseUrl: base, fetchJson: replayFetch, maxProducts: limits.maxProducts || 500, maxPages: limits.maxListPages || 3 }); } catch { /* keep the first page */ }
            if (all.length > final.length) { emitProgress(job_id, { phase: 'xhr_replay', count: all.length }); final = all; }
          }
        }
        // Fill MISSING prices from a separately-loaded pricing source — the very common
        // "tiles are in the page, prices come later" split (Leroy Merlin/Adeo, many
        // SPAs). Prices arrive either as a late/scroll-triggered pricing XHR OR as a
        // later HTML/hydration chunk, so when prices are still missing we nudge the
        // page, wait, then retry BOTH channels: re-read the captured XHR AND re-scan
        // the freshened page. Bounded (3 attempts). Joined by sku/id — no site rule.
        if (final.some((p) => p && p.price == null)) {
          // Fill only missing price/currency/url/image on `targets` from any `sources`
          // product that shares an id — never adds or drops products.
          const idsOf = (p) => [p && p.sku, p && p.gtin, p && p.mpn, p && p.id, p && p.productId, p && p.source_product_id].filter((v) => v != null && v !== '').map(String);
          const fillFromScan = (targets, sources) => {
            if (!Array.isArray(sources) || !sources.length) return targets;
            const priced = new Map();
            for (const s of sources) { if (s && s.price != null) for (const id of idsOf(s)) if (!priced.has(id)) priced.set(id, s); }
            if (!priced.size) return targets;
            return targets.map((p) => {
              if (!p || p.price != null) return p;
              for (const id of idsOf(p)) { const s = priced.get(id); if (s) { const np = { ...p, price: s.price }; if (s.currency && !np.currency) np.currency = s.currency; return np; } }
              return p;
            });
          };
          for (let attempt = 0; attempt < 3; attempt++) {
            if (caps && caps.length) {
              const before = final.filter((p) => p && p.price != null).length;
              final = enrichFromCaptures(final, caps, base);
              const after = final.filter((p) => p && p.price != null).length;
              if (after > before) emitProgress(job_id, { phase: 'price_merge', filled: after - before });
            }
            if (!final.some((p) => p && p.price == null)) break; // every price filled
            if (attempt === 2) break;                             // last try — don't wait again
            // Nudge lazy price loaders (scroll) then wait for prices to land, and
            // refresh BOTH channels: the interceptor's captures and the page itself.
            try { await driver.scroll({ to: 'bottom', times: 2, pause_ms: 600 }); } catch { /* ignore */ }
            await sleep(1200);
            try { caps = await driver.capturedResponses(); } catch { /* keep previous */ }
            try {
              const ctxN = await driver.context();
              const fresh = await once(ctxN);
              const before = final.filter((p) => p && p.price != null).length;
              final = fillFromScan(final, fresh);
              const after = final.filter((p) => p && p.price != null).length;
              if (after > before) emitProgress(job_id, { phase: 'price_rescan', filled: after - before });
            } catch { /* keep what we have */ }
          }
          // Self-diagnostic: if products STILL lack a price, record WHY into the report
          // so the failure explains itself — no console capture on the site needed.
          const stillMissing = final.filter((p) => p && p.price == null);
          if (stillMissing.length) {
            const hostPath = (u) => { try { const x = new URL(u); return x.host + x.pathname; } catch { return String(u || ''); } };
            // (a) the UNFILTERED request trace — reveals a price channel we don't yet
            // parse (RSC flight, beacon, non-JSON pricing call) that the JSON/product
            // filter drops. Flag RSC (Next.js App Router: ?_rsc= / text/x-component /
            // body "N:[…]") and price-ish URLs so the real endpoint stands out.
            let allRequests = [];
            try {
              const log = await driver.requestLog();
              allRequests = (log || []).map((r) => ({
                m: r.method, u: hostPath(r.url), s: r.status, ct: String(r.contentType || '').split(';')[0], len: r.len,
                rsc: /[?&]_rsc=|x-component/i.test(`${r.url || ''} ${r.contentType || ''}`) || /^\s*\d+:/.test(r.head || ''),
                priceish: /pric|prix|tarif|cost|montant|amount|stock|availab/i.test(r.url || ''),
                head: String(r.head || '').slice(0, 140),
              })).slice(0, 120);
            } catch { /* trace best-effort */ }
            // (b) page probe — the prices render on first paint, so the price is in the
            // HTML we hold, not a request. Sample the markup AROUND a real product (its
            // sku) and around a product-shaped price, and note whether the price sits in
            // the __next_f flight JSON vs only the rendered DOM. That tells us exactly
            // where to read the price from and how to join it to the tile.
            let pageProbe = null;
            try {
              const ctxP = await driver.context();
              const html = (ctxP && ctxP.body) || '';
              const compact = (s) => String(s).replace(/\s+/g, ' ').trim();
              const priceRe = /(?:[€$£¥]|EUR|USD|GBP|CHF)\s?\d[\d .,]*\d|\d[\d .,]*\d\s?(?:[€$£¥]|EUR|USD|GBP|CHF)/g;
              const matches = html.match(priceRe) || [];
              // Region around the FIRST extracted sku → the product tile's own markup.
              const firstSku = stillMissing.map((p) => p && (p.sku || p.gtin || p.mpn || p.id || p.productId)).filter(Boolean).map(String)[0] || null;
              let skuRegion = null, skuHasPriceNearby = null;
              if (firstSku) { const i = html.indexOf(firstSku); if (i >= 0) { const region = html.slice(Math.max(0, i - 700), i + 700); skuRegion = compact(region).slice(0, 1200); skuHasPriceNearby = /\d{1,4}[.,]\d{2}\s?(?:[€$£¥]|EUR)/.test(region); } }
              // Region around a product-shaped price (2-decimals + €).
              const pm = html.match(/\d{1,4}[.,]\d{2}\s?€/);
              let priceRegion = null;
              if (pm) { const i = html.indexOf(pm[0]); priceRegion = compact(html.slice(Math.max(0, i - 500), i + 160)).slice(0, 700); }
              pageProbe = {
                htmlLen: html.length,
                priceMatches: matches.length,
                samplePrices: [...new Set(matches)].slice(0, 8),
                hasNextFlight: /__next_f/.test(html),
                firstSku, skuHasPriceNearby, skuRegion, priceRegion,
              };
            } catch { /* probe best-effort */ }
            captureDiag = {
              capturedResponses: (caps && caps.length) || 0,
              endpoints: [...new Set((caps || []).map((c) => hostPath(c.url)))].filter(Boolean).slice(0, 25),
              pricelessCount: stillMissing.length,
              pricedCount: final.filter((p) => p && p.price != null).length,
              sampleJoinIds: stillMissing.slice(0, 5).map((p) => (p && (p.sku || p.gtin || p.mpn || p.id || p.productId)) || null),
              allRequests,
              pageProbe,
            };
          }
        }
      } catch (e) { console.debug('[job]', job_id, { event: 'xhr_capture_error', message: String(e && e.message || e) }); }
      return final;
    },
  };

  // Every extractor (recipe dom, internal-api, embedded, auto) gets a final generic
  // image pass: if a product came back without a thumbnail, recover it from the page's
  // own product tiles (matched by detail URL). Guarded, so it costs nothing when
  // images are already present.
  for (const k of Object.keys(extractors)) {
    const fn = extractors[k];
    extractors[k] = async (ctx, spec) => completeImagesFromDom(await fn(ctx, spec), ctx);
  }

  const env = {
    page: driver, extractors, pacer, config,
    limits: { maxListPages: 3, maxDetailPages: 5, maxProducts: 10000, ...limits },
    challenge: { registry: challenges, detect: (recipe.challenge && recipe.challenge.detect) || {}, strategy: (recipe.challenge && recipe.challenge.strategy) || 'human_in_the_loop', timeouts: { ...((recipe.challenge && recipe.challenge.timeouts) || {}), ...(ctx.challenge || {}) } },
    // Inverse content check for the guard: a page we can already extract from is not
    // blocked, whatever anti-bot marker it carries (never pause a readable page).
    hasContent: (pageCtx) => { try { return genericFrom(pageCtx).length > 0; } catch { return false; } },
    now: () => Date.now(),
    sleep,
    signal,
    log: (e) => console.debug('[job]', job_id, e),
    notify: (evt) => handleChallengeNotify(job_id, tabId, evt),
    emit: (p) => emitProgress(job_id, p),
    dedupKey: productKey,
    classifyItem: (item) => classifyItem(item, pageRules),
    classifyPage: (pageCtx, extracted) => classifyHtmlPage(pageCtx && pageCtx.body, { url: pageCtx && pageCtx.url, status: pageCtx && pageCtx.status, extracted, rules: pageRules }),
    // Product pages (followLinks): only this site's pages are opened; each one, once built, goes to the
    // app (op 'page', id = this job), which reads it with the site's taught rules when it records the job.
    acceptDetailUrl: (u) => sameSiteUrl(u, domain),
    onDetailPage: async (u) => {
      // Lazy-loaded gallery pictures and blocks only appear on sight: scroll through the page first.
      try { await driver._call('revealLazy', [{}]); await driver.settle({ minMs: 200, quietMs: 500, maxMs: 3000 }); } catch { /* read what is there */ }
      try { const ex = await driver._call('expandSections', [{}]); if (ex && ex.opened) await driver.settle({ minMs: 300, quietMs: 600, maxMs: 4000 }); } catch { /* read what is there */ }
      let page = null; try { page = await driver._call('compactHtml', [{}]); } catch { page = null; }
      const ok = !!(page && page.html) && !!((await appRequest({ op: 'page', url: u, runId: job_id, html: page.html }, 30000)) || {}).ok;
      detailSent += ok ? 1 : 0;
      emitProgress(job_id, { phase: 'detail_page', sent: detailSent, ok });
    },
  };
  let detailSent = 0;

  // A recipe with no explicit actions gets a default single-lane program from its
  // mode, so simple internal-api / embedded-state recipes need no DSL authoring.
  const program = recipe.actions && recipe.actions.length ? recipe : defaultProgram(recipe, { detail: ctx.detail });

  let out;
  try {
    out = await runProgram(program, env);
  } catch (e) {
    out = { status: P.JOB_STATUS.ERROR, products: [], reason: String(e && e.message || e) };
  }

  // Which extractor(s) actually produced products — recorded so the report can
  // say HOW the page was read (recipe lane / json_ld / embedded-state / dom),
  // and the report shows real reasons rather than a bare count.
  const products0 = out.products || [];
  const methods = [...new Set(products0.map((p) => (p && p.strategy) || 'auto'))];
  const extraction = { method: methods.length === 1 ? methods[0] : (methods[0] || null), methods, count: products0.length, diagnosis: null };
  // Attach the price self-diagnostic when products came back without prices, so the
  // report explains the gap (captured endpoints + join ids) with no console capture.
  if (captureDiag && products0.some((p) => p && p.price == null)) extraction.priceDiag = captureDiag;

  // Zero products on a run that neither the user stopped nor a challenge blocked:
  // never a dead end — diagnose WHY from the final page (block? unreadable data?
  // no machine-readable data? wrong URL?), in evidence, and set a plain reason.
  const emptyEligible = products0.length === 0 && (out.status === P.JOB_STATUS.DONE || out.status === P.JOB_STATUS.STOPPED) && !(signal && signal.aborted);
  if (emptyEligible) {
    try {
      const ctx = await driver.context();
      const diag = emptyPageDiagnosis(ctx && ctx.body, { url: ctx && ctx.url, status: ctx && ctx.status, rules: pageRules });
      extraction.diagnosis = diag;
      // A stable code the app maps to a non-technical French detail (readableDetail).
      if (!out.reason) out.reason = `empty:${diag.reasonCode}`;
      console.debug('[job]', job_id, { event: 'empty_diagnosis', ...diag });
      // 0 products on an SPA: attach a self-diagnostic so the empty page explains
      // itself from disk — the UNFILTERED request trace (a grid/API call we could
      // target) and which embedded state-globals / tile markers exist in the final
      // HTML. Tells us WHY the grid wasn't read (loads late / via an XHR we miss /
      // under an unknown state global) without a console capture on the site.
      try {
        const html = (ctx && ctx.body) || '';
        const hostPath = (u) => { try { const x = new URL(u); return x.host + x.pathname; } catch { return String(u || ''); } };
        let allRequests = [];
        try {
          const log = await driver.requestLog();
          allRequests = (log || []).map((r) => ({ m: r.method, u: hostPath(r.url), s: r.status, ct: String(r.contentType || '').split(';')[0], len: r.len, rsc: /[?&]_rsc=|x-component/i.test(`${r.url || ''} ${r.contentType || ''}`) || /^\s*\d+:/.test(r.head || ''), productish: /product|catalog|listing|search|graphql|\/api\/|plp|grid|item/i.test(r.url || '') })).slice(0, 120);
        } catch { /* trace best-effort */ }
        const STATE_GLOBALS = ['__NEXT_DATA__', '__next_f', '__LSCO_INITIAL_STATE__', '__NUXT__', '__APOLLO_STATE__', '__INITIAL_STATE__', '__PRELOADED_STATE__', '__remixContext', 'window.__data'];
        const MARKERS = [...STATE_GLOBALS, 'data-testid', 'ProductTile', 'product-tile', 'productCard', 'product-card', 'add-to-cart', 'addToCart'];
        const stateMarkers = {};
        for (const mk of MARKERS) stateMarkers[mk] = html.includes(mk);
        const jsonScripts = (html.match(/<script[^>]+type=["'](?:application\/(?:ld\+)?json)["'][^>]*>/gi) || []).length;
        // A product grid rendered by an external search SaaS (its listing call never
        // completes in an automated read): name the vendor from the request trace +
        // page, so the app can show a clear message and offer AI assist.
        const SEARCH_SAAS = [/sensefuel/i, /algolia(?:net)?\.(?:com|net)/i, /constructor\.io|cnstrc/i, /searchspring/i, /klevu/i, /findologic/i, /doofinder/i, /\bnosto\b/i, /bloomreach|brcdn/i, /unbxd/i, /attraqt|early\s*birds/i, /loop54/i, /tweakwise/i];
        const saasHay = `${allRequests.map((r) => r.u).join(' ')} ${html.slice(0, 20000)}`;
        const saasRe = SEARCH_SAAS.find((re) => re.test(saasHay));
        const saasVendor = saasRe ? (saasHay.match(saasRe)[0] || '').toLowerCase() : null;
        // Override the generic "empty" reason (never a real block) so the user gets the
        // SaaS-grid explanation + the AI-assist offer.
        if (saasVendor && ['empty_listing', 'no_machine_data', 'unreadable_data'].includes(diag.reasonCode)) out.reason = 'empty:saas_search_grid';
        // When a state global is present but yielded 0 products, sample a chunk of it
        // (and count product-ish tokens inside) so we can see WHY the extractor missed
        // the grid — e.g. products under an unknown key, or the array is empty because
        // the grid hydrates from a later fetch.
        let stateSample = null;
        for (const g of STATE_GLOBALS) {
          const i = html.indexOf(g);
          if (i < 0) continue;
          const chunk = html.slice(i, i + 4000);
          stateSample = { global: g, priceTokens: (chunk.match(/"(?:price|lowPrice|amount|sellingPrice)"/gi) || []).length, productTokens: (chunk.match(/"(?:products?|items|results|tiles|plp|hits|productList)"/gi) || []).length, sample: chunk.replace(/\s+/g, ' ').slice(0, 1600) };
          break;
        }
        extraction.spaProbe = { htmlLen: html.length, jsonScripts, stateMarkers, stateSample, saasVendor, allRequests };
      } catch { /* probe best-effort */ }
    } catch (e) { console.debug('[job]', job_id, { event: 'diagnose_error', message: String(e && e.message || e) }); }
  }

  // Persist the products (chunked, deduped) and report the final result.
  const fresh = await jobStore.appendProducts(job_id, out.products || []);
  await jobStore.setState(job_id, mapState(out.status)).catch(() => {});
  clearBadge(tabId);
  const rec = await jobStore.load(job_id);
  sendApp(P.result(job_id, out.status, {
    products: out.products || [],
    counts: { products: rec ? rec.productCount : (out.products || []).length, fresh: fresh.length, pages: out.pages, detailPages: out.detailPages, detailPagesSent: detailSent },
    reason: out.reason, errors: out.errors,
    pacing: pacer.snapshot(),
    page_verdicts: out.pageVerdicts || null,
    timings: out.timings || null, // where the run's time went (list, pacing, page loads, settle, page reads)
    recipe_diag: Object.keys(recipeDiag).length ? recipeDiag : null,
    extraction,
  }));
  live.delete(job_id);
}

async function pauseJob(job_id) {
  const l = live.get(job_id);
  if (l) l.signal.aborted = true; // interpreter observes and stops cleanly; state persists
  await jobStore.setState(job_id, STATE.PAUSED_CHALLENGE).catch(() => {});
  sendApp(P.result(job_id, P.JOB_STATUS.PAUSED_CHALLENGE, {}));
}

async function resumeJob(job_id) {
  const rec = await jobStore.load(job_id);
  if (!rec) return;
  // Resume gently from the persisted cursor (a full resume implementation replays
  // from rec.cursor; here we re-open the tab and continue the same recipe).
  pacing.get(rec.domain).resumeGently(Date.now());
  broadcast({ kind: 'job_resumed', job_id });
}

async function stopJob(job_id) {
  const l = live.get(job_id);
  if (l) { l.signal.aborted = true; try { await chrome.tabs.remove(l.tabId); } catch { /* tab gone */ } }
  await jobStore.setState(job_id, STATE.STOPPED).catch(() => {});
  sendApp(P.result(job_id, P.JOB_STATUS.STOPPED, {}));
  live.delete(job_id);
}

// ---- Challenge / notifications / badge --------------------------------------

// Snapshot the challenge tab so the operator (or a later diagnosis) can SEE what
// the "action required" screen actually was. Uses the host permission already
// granted for this domain (captureVisibleTab needs no extra prompt when the active
// tab's origin is granted). JPEG q40 keeps it small; failure is silent (no prompt).
async function captureChallengeShot(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 40 });
    if (typeof dataUrl === 'string' && dataUrl.length > 64 && dataUrl.length < 6_000_000) {
      return { dataUrl, url: tab.url || null, at: Date.now() };
    }
  } catch (e) { console.debug('[job]', 'challenge_capture_failed', String(e && e.message || e)); }
  return null;
}

async function handleChallengeNotify(job_id, tabId, evt) {
  if (!evt) return;
  if (evt.level === 'action_required') {
    setBadge(tabId, '!');
    notify('challenge', 'Action requise', evt.message);
    jobStore.setState(job_id, STATE.PAUSED_CHALLENGE).catch(() => {});
    const shot = await captureChallengeShot(tabId);
    sendApp(P.pause(job_id, evt.category || 'challenge', { message: evt.message, ...(shot ? { shot } : {}) }));
    broadcast({ kind: 'challenge', job_id, message: evt.message });
  } else if (evt.level === 'blocked') {
    setBadge(tabId, '×');
    notify('blocked', 'Site bloqué', evt.message);
  } else if (evt.code === 'challenge_resolved') {
    setBadge(tabId, '…');
    jobStore.setState(job_id, STATE.RUNNING).catch(() => {});
    broadcast({ kind: 'challenge_resolved', job_id });
  }
}

function notify(id, title, message) {
  try {
    chrome.notifications.create(`elo-${id}-${Date.now()}`, {
      type: 'basic', iconUrl: 'icons/icon-128.png', title: `Eloshon Scraper — ${title}`, message: String(message || ''),
    });
  } catch { /* notifications optional */ }
}
function setBadge(tabId, text) { try { chrome.action.setBadgeText({ text, tabId }); chrome.action.setBadgeBackgroundColor({ color: '#8b5cf6' }); } catch { /* */ } }
function clearBadge(tabId) { try { chrome.action.setBadgeText({ text: '', tabId }); } catch { /* */ } }

function emitProgress(job_id, data) {
  sendApp(P.progress(job_id, data));
  broadcast({ kind: 'progress', job_id, data });
}

// ---- Diagnostics (no secrets, no full page bodies) --------------------------

async function sendDiagnostic(job_id) {
  const rec = await jobStore.load(job_id);
  const l = live.get(job_id);
  const report = {
    job_id,
    state: rec && rec.state,
    counts: rec ? { products: rec.productCount, chunks: rec.chunks } : null,
    cursor: rec && rec.cursor,
    pacing: l ? pacing.get(l.domain).snapshot() : null,
    browser: detectBrowser(),
    extensionVersion: chrome.runtime.getManifest().version,
    generatedAt: Date.now(),
  };
  sendApp(P.diagnostic(job_id, report));
  return report;
}

// ---- Popup messaging --------------------------------------------------------

const ports = new Set();
// The tabs where a designation (🎯) waits for a click: the panel closed, nobody can answer it — it is cancelled.
const pickTabs = new Set();
async function withPickTab(tabId, work) {
  if (tabId != null) pickTabs.add(tabId);
  try { return await work(); } finally { pickTabs.delete(tabId); }
}
function cancelPicks() {
  for (const id of [...pickTabs]) { try { new TabDriver(chrome, id, { log: () => {} })._call('cancelPick', []).catch(() => {}); } catch { /* the tab is gone */ } }
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  ports.add(port);
  port.onDisconnect.addListener(() => { ports.delete(port); if (!ports.size) cancelPicks(); });
  port.postMessage({ kind: 'link_status', status: link ? link.status : 'disconnected' });
});
function broadcast(msg) { for (const p of ports) { try { p.postMessage(msg); } catch { ports.delete(p); } } }

// ---- Side panel ---------------------------------------------------------------

// Request/reply with the app over the native link (the app echoes the request id).
const panelPending = new Map();
async function appRequest(payload, timeoutMs = 15000) {
  // The app may have been opened since the last attempt: try at once rather than waiting for the next retry.
  if (link && link.status !== 'connected') { link.connectNow(); await new Promise((r) => setTimeout(r, 1500)); }
  if (!link || link.status !== 'connected') return { ok: false, reason: 'application hors ligne' };
  const msg = P.panelRequest(payload);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { panelPending.delete(msg.id); resolve({ ok: false, reason: 'l’application n’a pas répondu à temps' }); }, timeoutMs);
    panelPending.set(msg.id, { resolve, timer });
    sendApp(msg);
  });
}

// The tab the panel acts on, checked: a web page on an activated site.
async function panelTab(tabId) {
  if (tabId == null) return { error: 'onglet introuvable' };
  let tab; try { tab = await chrome.tabs.get(tabId); } catch { return { error: 'onglet introuvable' }; }
  let domain = ''; try { domain = new URL(tab.url).hostname.replace(/^www\./, ''); } catch { return { error: 'cette page n’est pas un site web' }; }
  if (!/^https?:/.test(tab.url || '')) return { error: 'cette page n’est pas un site web' };
  if (!(await hasDomainPermission(chrome, domain))) return { error: 'site non activé — clique « Activer ce site »' };
  return { tab, domain };
}

// The site's learned card recipe, from the app (null when the app is offline or the
// site has none — the panel then uses the automatic detection).
async function siteRecipe(url) {
  const r = await appRequest({ op: 'recipe', url }, 8000);
  return r && r.ok && r.recipe && r.recipe.card ? r.recipe : null;
}

// ---- How a site's lists load more (pagination memo, per site) -----------------------
// Kept in the app (domain profile `list_pagination`, shared with the .exe and recipes.json) and copied
// here, so the panel still has it when the app is closed. The app's copy wins when it answers.
const PAG_KEY = 'sitePagination';
async function localPagination(domain) {
  try {
    const all = await chrome.storage.local.get([PAG_KEY, 'nextSelectors']);
    const m = (all[PAG_KEY] || {})[domain];
    if (m) return sanitizePaginationMemo(m);
    const legacy = (all.nextSelectors || {})[domain]; // a selector kept by 0.7.32 and before
    return legacy ? sanitizePaginationMemo({ next: legacy }) : null;
  } catch { return null; }
}
async function storeLocalPagination(domain, memo) {
  try {
    const all = await chrome.storage.local.get([PAG_KEY, 'nextSelectors']);
    const map = all[PAG_KEY] || {}; if (memo) map[domain] = memo; else delete map[domain];
    const legacy = all.nextSelectors || {}; delete legacy[domain];
    await chrome.storage.local.set({ [PAG_KEY]: map, nextSelectors: legacy });
  } catch { /* this run only */ }
}
/** The site's memo: {memo, savedIn:'app'|'browser'|null}. */
async function sitePagination(t) {
  const local = await localPagination(t.domain);
  if (link && link.status === 'connected') {
    const r = await appRequest({ op: 'pagination', action: 'get', url: t.tab.url }, 5000);
    if (r && r.ok) {
      const app = sanitizePaginationMemo(r.memo);
      // Kept in the browser while the app was closed: given to the app now.
      if (!app && local) { const w = await appRequest({ op: 'pagination', action: 'set', url: t.tab.url, memo: local }, 5000); return { memo: local, savedIn: w && w.ok ? 'app' : 'browser' }; }
      if (app) await storeLocalPagination(t.domain, app);
      return { memo: app, savedIn: app ? 'app' : null };
    }
  }
  return { memo: local, savedIn: local ? 'browser' : null };
}
/** Apply a change to the site's memo (a part set to null is forgotten); saved here and in the app. */
async function updateSitePagination(t, patch) {
  const cur = (await sitePagination(t)).memo;
  const memo = patchPaginationMemo(cur, patch);
  await storeLocalPagination(t.domain, memo);
  let savedIn = memo ? 'browser' : null;
  if (link && link.status === 'connected') {
    const r = await appRequest(memo ? { op: 'pagination', action: 'set', url: t.tab.url, memo } : { op: 'pagination', action: 'forget', url: t.tab.url }, 5000);
    if (r && r.ok && memo) savedIn = 'app';
  }
  return { memo, savedIn };
}

// ---- The product card learned for a site (card-model.mjs): in the app (domain profile `card_model`) and here ----
const CARD_KEY = 'siteCardModels';
async function siteCardModel(t) {
  let local = null; try { local = sanitizeCardModel(((await chrome.storage.local.get(CARD_KEY))[CARD_KEY] || {})[t.domain]); } catch { local = null; }
  if (link && link.status === 'connected') {
    const r = await appRequest({ op: 'card_model', action: 'get', url: t.tab.url }, 5000);
    if (r && r.ok) {
      const app = sanitizeCardModel(r.model);
      if (!app && local) { const w = await appRequest({ op: 'card_model', action: 'set', url: t.tab.url, model: local }, 5000); return { model: local, savedIn: w && w.ok ? 'app' : 'browser' }; }
      if (app) { try { const all = (await chrome.storage.local.get(CARD_KEY))[CARD_KEY] || {}; all[t.domain] = app; await chrome.storage.local.set({ [CARD_KEY]: all }); } catch { /* kept in the app */ } }
      return { model: app, savedIn: app ? 'app' : null };
    }
  }
  return { model: local, savedIn: local ? 'browser' : null };
}
async function storeCardModel(t, model) {
  const m = model ? sanitizeCardModel(model) : null;
  try { const all = (await chrome.storage.local.get(CARD_KEY))[CARD_KEY] || {}; if (m) all[t.domain] = m; else delete all[t.domain]; await chrome.storage.local.set({ [CARD_KEY]: all }); } catch { /* this run only */ }
  let savedIn = m ? 'browser' : null;
  if (link && link.status === 'connected') { const r = await appRequest(m ? { op: 'card_model', action: 'set', url: t.tab.url, model: m } : { op: 'card_model', action: 'forget', url: t.tab.url }, 5000); if (r && r.ok && m) savedIn = 'app'; }
  return { model: m, savedIn };
}
// « 🎯 Montrer une carte produit » / « 🎯 Pas un produit » / « Voir les cartes » / « Oublier la carte » / the hub's block.
async function cardAction({ tabId, action } = {}) {
  const t = await panelTab(tabId); if (t.error) return { ok: false, reason: t.error };
  const driver = new TabDriver(chrome, tabId, { log: () => {} });
  const { model, savedIn } = await siteCardModel(t);
  if (action === 'info') return { ok: true, model, savedIn };
  if (action === 'forget') { const s = await storeCardModel(t, null); return { ok: true, model: null, savedIn: s.savedIn }; }
  try { await chrome.tabs.update(tabId, { active: true }); } catch { /* best-effort */ }
  if (action === 'show') { if (!model) return { ok: false, reason: 'aucune carte apprise pour ce site' }; const r = await driver._call('highlightCards', [model, {}]); return { ok: true, model, savedIn, ...(r || {}) }; }
  if (action === 'hub') { const r = await driver._call('pickHub', []); return r || { ok: false, reason: 'aucune réponse de la page' }; }
  const r = action === 'not_product' ? await driver._call('markNotProduct', [{ model }]) : await driver._call('learnCard', [{ previous: model }]);
  if (!r || !r.ok) return r || { ok: false, reason: 'aucune réponse de la page' };
  const s = await storeCardModel(t, r.model);
  return { ...r, model: s.model, savedIn: s.savedIn };
}

// The readers of a list page, best first (see panelRun), and how the panel's run reads it. A product card learned for
// the site comes first and alone: the user taught it, so its kept cards are the list and its rejected ones are listed.
async function listReader(t, driver, { fields, card } = {}) {
  const { model } = await siteCardModel(t);
  if (model) {
    const own = (Array.isArray(fields) ? fields : []).filter((f) => f && f.key && f.selector && card === model.card);
    const recipe = mergeRecipe({ card: model.card, fields: model.fields }, { card: model.card, fields: own });
    const rejected = new Map();
    return {
      read: async () => {
        let r = null; try { r = await driver._call('readModelCards', [model, recipe]); } catch { r = null; }
        for (const x of (r && r.rejected) || []) { const k = `${x.url || x.name}|${x.reason}`; if (!rejected.has(k)) rejected.set(k, x); }
        return (r && r.rows) || [];
      },
      info: () => ({ method: 'carte produit apprise', weak: false }),
      rejected: () => [...rejected.values()],
    };
  }
  const userFields = (Array.isArray(fields) ? fields : []).filter((f) => f && f.key && f.selector);
  const stored = await siteRecipe(t.tab.url);
  const user = { card: card || null, fields: userFields };
  // Readers to try, best first: the site's recipe merged with the user's fields,
  // then the user's fields alone (when the site's recipe no longer reads names or
  // prices), then the automatic detection — chosen on the first read by panelReader.
  const candidates = [];
  const withStored = mergeRecipe(stored, user);
  const userKeys = userFields.map((f) => f.key);
  if (withStored) candidates.push({ userKeys, recipe: withStored, method: userFields.length ? (stored ? 'recette du site + vos champs' : 'vos champs désignés') : 'recette du site' });
  const userOnly = stored && userFields.length ? mergeRecipe(null, user) : null;
  if (userOnly) candidates.push({ userKeys, recipe: userOnly, method: 'vos champs désignés (la recette du site ne lit plus les noms ou les prix)' });
  const baseOf = (ctx) => (ctx && ctx.url) || t.tab.url;
  const autoRead = async () => {
    try { const inpage = await driver._call('extract', [{ using: 'auto' }]); if (Array.isArray(inpage) && inpage.length) return inpage; } catch { /* fall through */ }
    let ctx = null; try { ctx = await driver.context(); } catch { return []; }
    const body = (ctx && ctx.body) || ''; const b = baseOf(ctx);
    let g = []; try { g = extractEmbeddedProducts(body, b).cards || []; } catch { /* */ }
    if (!g.length) { try { g = listingMicrodata(body, b); } catch { /* */ } }
    if (!g.length) { try { g = extractDomGrid(body, b).cards || []; } catch { /* */ } }
    return g;
  };
  return panelReader({ candidates, readRecipe: (r) => driver._call('readRecipeCards', [r]), autoRead, learn: (rows) => driver._call('learnRecipe', [rows.slice(0, 40)]) });
}

// The pagination steps in the user's tab, shared by « Exécuter » and « Tester ».
function listSteps(t, tabId, driver, memo) {
  // Cookie banners and pop-ups closed (the private way) before a click on the list.
  const clearWay = async () => { try { return (await driver._call('dismissOverlays', [])) || null; } catch { return null; } };
  // The next page of the list, in the user's tab: a link to open, or a control to click (the one the user showed first).
  const nextPage = async (mode) => {
    let cand = null; try { cand = await driver._call('findNextPage', [{ learned: (memo && memo.next) || null, mode }]); } catch { cand = null; }
    if (!cand) return false;
    const loaded = new Promise((resolve) => {
      const to = setTimeout(() => { chrome.tabs.onUpdated.removeListener(l); resolve(false); }, cand.href ? 25000 : 6000);
      const l = (tid, info) => { if (tid === tabId && info.status === 'complete') { clearTimeout(to); chrome.tabs.onUpdated.removeListener(l); resolve(true); } };
      chrome.tabs.onUpdated.addListener(l);
    });
    if (cand.href) await chrome.tabs.update(tabId, { url: cand.href });
    else { await clearWay(); let clicked = false; try { clicked = !!(await driver._call('click', [cand.selector, { optional: true, reveal: true }])); } catch { clicked = false; } if (!clicked) return false; }
    await loaded; // a click that only redraws the list (no navigation) simply waits a few seconds
    try { await driver._call('settle', [{}]); } catch { /* read what is there */ }
    return true;
  };
  const loadMore = async () => { await clearWay(); try { return (await driver._call('loadMoreOnce', [{ learned: (memo && memo.loadMore) || null }])) === true; } catch { return false; } };
  const scroll = () => driver.scroll({ to: 'bottom', times: 1, pause_ms: 300 });
  const total = async () => { try { return (await driver._call('announcedTotal', [])) || null; } catch { return null; } };
  return { nextPage, loadMore, scroll, total, clearWay };
}

// Side-panel "Exécuter maintenant": read the page open in the user's tab with the
// site's learned recipe (from the app) merged with the fields the user designated
// with the mouse — or, without a recipe, the automatic detection — then load more
// products the way the user chose for the site (next page, load-more control,
// scrolling, page number) up to the chosen maximum. Progress is pushed to the
// panel. No new tab, nothing sent anywhere.
async function panelRun({ tabId, fields, card, settings } = {}) {
  const t = await panelTab(tabId);
  if (t.error) return { ok: false, reason: t.error };
  const driver = new TabDriver(chrome, tabId, { log: () => {} });
  const { memo } = await sitePagination(t);
  const steps = listSteps(t, tabId, driver, memo);
  const t0 = Date.now();
  const readList = async (reader, onProgress) => runPanelExtraction({
    nextPage: steps.nextPage, loadMore: steps.loadMore, scroll: steps.scroll, total: steps.total,
    read: reader.read, settings,
    path: async () => { try { return await driver._call('pagePath', []); } catch { return null; } },
    onProgress,
  });
  const hub = settings && settings.hub && Array.isArray(settings.hub.links) && settings.hub.links.length ? settings.hub : null;
  // A Shopify / WooCommerce collection: its public data (variants, SKU, images, tags) for THIS collection, read in the
  // user's tab; the visual read (learned card, automatic detection) when the platform gives nothing.
  const viaPlatform = async (pageUrl) => {
    if (settings && settings.pagination === 'none') return null; // « this page only »
    let html = ''; try { html = ((await driver.context()) || {}).body || ''; } catch { return null; }
    const platform = detectPlatform(html.slice(0, 600000));
    if (!PLATFORMS_WITH_DEFAULT.has(platform)) return null;
    const scope = collectionScope(pageUrl, platform);
    if (scope.kind !== 'collection' && scope.kind !== 'category') return null;
    const cap = Math.max(1, Math.min(PANEL_MAX_ROWS, Number(settings && settings.maxProducts) || 500));
    const httpGet = async (u) => { try { return await driver._call('fetchInPage', [u, { as: 'json' }]); } catch { return null; } };
    let lane = null; try { lane = await platformDefaultLane(pageUrl, { httpGet, platform, maxProducts: cap, maxPages: Math.ceil(cap / 100) + 1 }); } catch { lane = null; }
    if (!lane || !lane.ok || !lane.products.length) return null;
    const announced = lane.collection && lane.collection.announced;
    return {
      rows: lane.products.slice(0, cap), rounds: lane.pages, pages: lane.pages, loads: 0, stoppedBy: 'platform_feed',
      total: announced ? { announced, text: null, read: Math.min(cap, lane.products.length), ok: lane.products.length >= announced, short: Math.max(0, announced - lane.products.length), explained: lane.products.length >= cap } : null,
      method: `données publiques de la boutique (${platform === 'shopify' ? 'Shopify' : 'WooCommerce'}), cette collection seulement${lane.outsideCount ? ` ; ${lane.outsideCount} produit(s) renvoyé(s) hors de cette collection écarté(s) : ${lane.outside.slice(0, 5).map((o) => o.name).join(', ')}${lane.outsideCount > 5 ? '…' : ''}` : ''}`,
    };
  };
  if (!hub) {
    const feed = await viaPlatform(t.tab.url);
    if (feed) { const how = { info: () => ({ method: feed.method, weak: false }) }; broadcast({ kind: 'panel_progress', count: feed.rows.length }); return panelRunResult(t, tabId, driver, how, feed, t0); }
    const reader = await listReader(t, driver, { fields, card });
    const res = await readList(reader, (n) => broadcast({ kind: 'panel_progress', count: n }));
    return panelRunResult(t, tabId, driver, reader, res, t0);
  }
  // A hub page: each sub-collection shown with 🎯 is opened in turn and read like a list (its pages too); its name
  // can be the products' collection. A product listed in two sub-collections is kept once, with where else it is.
  const rows = new Map(); const per = []; const rejected = new Map(); let lastReader = null; let pages = 0; let loads = 0;
  const hubUrl = t.tab.url;
  for (const [i, sub] of hub.links.slice(0, 50).entries()) {
    broadcast({ kind: 'panel_progress', count: rows.size, note: `sous-collection ${i + 1} / ${hub.links.length} : ${sub.name}` });
    const loaded = new Promise((resolve) => {
      const to = setTimeout(() => { chrome.tabs.onUpdated.removeListener(l); resolve(false); }, 25000);
      const l = (tid, info) => { if (tid === tabId && info.status === 'complete') { clearTimeout(to); chrome.tabs.onUpdated.removeListener(l); resolve(true); } };
      chrome.tabs.onUpdated.addListener(l);
    });
    try { await chrome.tabs.update(tabId, { url: sub.url }); } catch { per.push({ name: sub.name, url: sub.url, rows: 0, error: 'ouverture impossible' }); continue; }
    await loaded; try { await driver._call('settle', [{}]); } catch { /* read what is there */ }
    const feed = await viaPlatform(sub.url);
    const reader = feed ? { info: () => ({ method: feed.method, weak: false }) } : await listReader(t, driver, { fields, card }); lastReader = reader;
    const res = feed || await readList(reader, (n) => broadcast({ kind: 'panel_progress', count: rows.size + n, note: `sous-collection ${i + 1} / ${hub.links.length} : ${sub.name}` }));
    let added = 0;
    for (const row of res.rows) {
      const k = rowKey(row);
      if (rows.has(k)) { const r0 = rows.get(k); r0.alsoIn = [r0.alsoIn, sub.name].filter(Boolean).join(' | ').slice(0, 300); continue; }
      rows.set(k, { ...row, subCollection: sub.name, ...(hub.useName ? { category: sub.name } : {}) }); added++;
    }
    pages += res.pages || 1; loads += res.loads || 0;
    for (const x of (reader.rejected ? reader.rejected() : [])) rejected.set(`${x.url || x.name}|${x.reason}`, x);
    per.push({ name: sub.name, url: sub.url, rows: added, read: res.rows.length, stoppedBy: res.stoppedBy, total: res.total || null });
  }
  try { await chrome.tabs.update(tabId, { url: hubUrl }); } catch { /* the user can come back */ }
  const res = { rows: [...rows.values()], rounds: per.length, stoppedBy: 'hub_done', pages, loads, total: null, hub: per };
  const reader = { info: () => (lastReader ? lastReader.info() : { method: 'détection automatique', weak: false }), rejected: () => [...rejected.values()] };
  return panelRunResult({ ...t, tab: { ...t.tab, url: hubUrl } }, tabId, driver, reader, res, t0);
}

// The rows of a run + what the panel shows with them (method, pages, stop, announced total, taught fields…).
async function panelRunResult(t, tabId, driver, reader, res, t0) {
  // runId: one id per run, so the app records these rows once even if "Accepter" is clicked again.
  const runId = `pr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const how = reader.info();
  let origin = ''; try { origin = new URL(t.tab.url).origin; } catch { origin = ''; }
  await rememberLinks(origin, res.rows);
  // The site's taught product rules (from the app): the collection's rows get those fields from each product
  // page, and the preview already shows what they read (this page, or the first product pages of the list).
  let knowledge = null; try { const k = await appRequest({ op: 'rules', url: t.tab.url }, 5000); knowledge = k && k.ok ? k.knowledge : null; } catch { knowledge = null; }
  // The fields the USER taught (manual rules) make « Accepter » open each product page; rules found
  // automatically apply on the pages read anyway.
  const taught = knowledge ? [...new Set(knowledge.rules.filter((r) => r.scope === 'product' && r.origin === 'manual' && (r.status === 'active' || r.status === 'failing')).map((r) => r.field))] : [];
  let taughtPreview = null;
  if (knowledge && res.rows.length) { try { taughtPreview = await previewTaught({ driver, rows: res.rows, knowledge, pageUrl: t.tab.url, runId }); } catch { taughtPreview = null; } }
  let trail = null; try { const tr = await driver._call('pageTrail', []); trail = tr && Array.isArray(tr.trail) && tr.trail.length ? tr.trail : null; } catch { trail = null; }
  try { lastPreview.set(tabId, { taughtPreview, rows: res.rows.slice(0, 3) }); while (lastPreview.size > 10) lastPreview.delete(lastPreview.keys().next().value); } catch { /* preview only */ }
  // The cards the learned card model left out, listed with their reason (never dropped in silence).
  const rej = reader.rejected ? reader.rejected() : [];
  const byReason = {}; for (const x of rej) byReason[x.reason] = (byReason[x.reason] || 0) + 1;
  const rejected = rej.length ? { count: rej.length, byReason, labels: Object.fromEntries(Object.keys(byReason).map((k) => [k, REJECT_REASONS[k] || k])), list: rej.slice(0, 200) } : null;
  return { ok: true, rows: res.rows, meta: { method: how.method, weak: how.weak, count: res.rows.length, rounds: res.rounds, pages: res.pages, loads: res.loads || 0, stoppedBy: res.stoppedBy, total: res.total || null, durationMs: Date.now() - t0, url: t.tab.url, runId, trail, taught, taughtPreview, rejected, hub: res.hub || null } };
}

// « Tester » (Pages tab): ONE step of the chosen mode on the open list — a click on « suivant » / « charger
// plus », a scroll, or the next page number — with the product cards counted before and after.
async function panelPaginationTest({ tabId, fields, card, mode = 'auto' } = {}) {
  const t = await panelTab(tabId); if (t.error) return { ok: false, reason: t.error };
  try { await chrome.tabs.update(tabId, { active: true }); } catch { /* best-effort */ }
  const driver = new TabDriver(chrome, tabId, { log: () => {} });
  const { memo } = await sitePagination(t);
  const reader = await listReader(t, driver, { fields, card });
  const steps = listSteps(t, tabId, driver, memo);
  const startUrl = t.tab.url;
  const keys = (rows) => new Set((rows || []).map(rowKey));
  let before = []; try { before = await reader.read(); } catch { before = []; }
  const seen = keys(before);
  const overlays = await steps.clearWay();
  // « Automatique »: what « Exécuter » would do first — the load-more control, else the next page, else a scroll.
  let action = mode; let note = '';
  if (mode === 'auto') {
    let more = null; try { more = await driver._call('locateControl', [{ kind: 'load_more', learned: memo && memo.loadMore }]); } catch { more = null; }
    let next = null; try { next = await driver._call('locateControl', [{ kind: 'next', learned: memo && memo.next, mode: 'auto' }]); } catch { next = null; }
    action = more && more.found && !more.disabled ? 'load_more' : (next && next.found ? 'button' : 'infinite');
  }
  let moved = false;
  if (action === 'load_more') {
    let where = null; try { where = await driver._call('locateControl', [{ kind: 'load_more', learned: memo && memo.loadMore }]); } catch { where = null; }
    if (!where || !where.found) note = memo && memo.loadMore ? 'le bouton « charger plus » montré n’est plus sur la page' : 'aucun bouton « charger plus » trouvé : montrez-le avec 🎯';
    else if (where.disabled) note = 'le bouton « charger plus » est désactivé (fin de la liste ?)';
    else { moved = await steps.loadMore(); if (moved) { await new Promise((r) => setTimeout(r, 1500)); try { await driver._call('settle', [{ maxMs: 6000 }]); } catch { /* read */ } } }
  } else if (action === 'button' || action === 'url') {
    const how = mode === 'auto' ? 'auto' : action; // « Automatique » also takes a page number in the address
    let where = null; try { where = await driver._call('locateControl', [{ kind: 'next', learned: memo && memo.next, mode: how }]); } catch { where = null; }
    if (!where || !where.found) note = action === 'url' ? 'pas de numéro de page reconnu dans l’adresse ni de pagination sur la page' : (memo && memo.next ? 'le bouton « page suivante » montré n’est plus sur la page, ou il est désactivé (dernière page ?)' : 'aucun bouton « page suivante » trouvé : montrez-le avec 🎯');
    else moved = await steps.nextPage(how);
  } else if (action === 'infinite') {
    try { await steps.scroll(); moved = true; } catch { moved = false; }
    await new Promise((r) => setTimeout(r, 1500));
    try { await driver._call('settle', [{ maxMs: 6000 }]); } catch { /* read */ }
  } else return { ok: false, reason: 'mode « Aucune » : rien à tester' };
  if (!moved && !note) note = 'le clic n’a rien déclenché';
  let after = []; if (moved) { try { after = await reader.read(); } catch { after = []; } }
  const added = moved ? after.filter((r) => !seen.has(rowKey(r))).length : 0;
  let total = null; try { total = await steps.total(); } catch { total = null; }
  if (moved && !added) note = action === 'infinite' ? 'le défilement n’a chargé aucun nouveau produit' : 'la page a réagi mais aucune nouvelle carte produit n’est apparue';
  const navigated = moved && (action === 'button' || action === 'url');
  let tabUrl = null; try { tabUrl = (await chrome.tabs.get(tabId)).url; } catch { tabUrl = null; }
  // The list goes back to its first page, so « Exécuter » starts from the start.
  if (navigated && tabUrl && tabUrl !== startUrl) { try { await chrome.tabs.update(tabId, { url: startUrl }); } catch { /* the user can come back */ } }
  const lastTest = { at: new Date().toISOString(), mode: action, ok: added > 0, added, before: before.length, after: after.length, ...(note ? { reason: note } : {}) };
  const saved = await updateSitePagination(t, { lastTest });
  return { ok: true, test: lastTest, action, total, overlays, savedIn: saved.savedIn, wentBack: navigated };
}

// "Désigner à la souris" (🎯): the user clicks the element of a product card that
// holds this field; the page returns the card + a selector relative to it.
async function panelPick({ tabId, fieldKey, label, card } = {}) {
  const t = await panelTab(tabId);
  if (t.error) return { ok: false, reason: t.error };
  let known = card || null;
  if (!known) { const r = await siteRecipe(t.tab.url); known = r ? r.card : null; }
  try { await chrome.tabs.update(tabId, { active: true }); } catch { /* best-effort */ }
  const driver = new TabDriver(chrome, tabId, { log: () => {} });
  try { return (await driver._call('pick', [{ card: known, fieldKey: String(fieldKey || ''), label: String(label || '') }])) || { ok: false, reason: 'aucune réponse de la page' }; }
  catch (e) { return { ok: false, reason: String(e && e.message || e).slice(0, 160) }; }
}

// Escape pressed in the side panel while a designation is open in the page: the
// keyboard is in the panel, so the panel asks the page to cancel.
async function panelPickCancel({ tabId } = {}) {
  if (tabId == null) return { ok: false };
  try { return { ok: !!(await new TabDriver(chrome, tabId, { log: () => {} })._call('cancelPick', [])) }; } catch { return { ok: false }; }
}

// "Accepter": the previewed rows become a normal job in the app (normalise →
// eligibility → CSV/report), optionally completed from each product page.
// Sub-pages in the user's browser: a minimized window with a couple of tabs opens each product page,
// waits until the page has built itself, and hands the rendered page to the app (op 'page').
// The pages a run already sent to the app (panel preview), so « Accepter » does not open them again.
const runPagesSent = new Map(); // runId → Set(url)
const PREVIEW_PAGES = 3;
async function subpagesInBrowser({ rows, listUrl, runId, max = null, knowledge = null, urls: given = null, onOutcome = null, isStopped = null, onWindow = null }) {
  const already = runPagesSent.get(runId) || new Set();
  const urls = (given || subpageUrls(rows, listUrl, max || Number.MAX_SAFE_INTEGER)).filter((u) => !already.has(u));
  if (!urls.length) return null;
  // Per page: what the taught rules read there (panel preview); readSubpages counts the human checks.
  const applied = new Map();
  let win = null;
  try { win = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'minimized' }); } catch { win = null; }
  if (win && onWindow) { try { await onWindow(win.id); } catch { /* best-effort */ } }
  let spare = win && win.tabs && win.tabs[0] ? win.tabs[0].id : null;
  const open = async () => {
    if (spare != null) { const id = spare; spare = null; return id; }
    const t = await chrome.tabs.create(win ? { windowId: win.id, url: 'about:blank', active: false } : { url: 'about:blank', active: false });
    return t.id;
  };
  const visit = async (id, url) => {
    // Listen BEFORE navigating: a fast page can finish before a late listener.
    const loaded = new Promise((resolve) => {
      const to = setTimeout(() => { chrome.tabs.onUpdated.removeListener(l); resolve(false); }, 25000);
      const l = (tid, info) => { if (tid === id && info.status === 'complete') { clearTimeout(to); chrome.tabs.onUpdated.removeListener(l); resolve(true); } };
      chrome.tabs.onUpdated.addListener(l);
    });
    await chrome.tabs.update(id, { url });
    const complete = await loaded;
    const d = new TabDriver(chrome, id, { log: () => {} });
    try { await d._call('settle', [{}]); } catch { /* read what is there */ }
    // A human check instead of the product page: never sent as the page (it would read as a failed rule).
    let ch = null; try { ch = await d._call('challengeHere', []); } catch { ch = null; }
    if (ch) return { challenge: true };
    // Lazy-loaded gallery pictures and blocks only appear on sight: the page is scrolled through first.
    try { await d._call('revealLazy', [{}]); await d._call('settle', [{ minMs: 200, quietMs: 500, maxMs: 3000 }]); } catch { /* read what is there */ }
    // Folded sections (accordions, tabs built on opening) are opened so their text is in the page read.
    try { const ex = await d._call('expandSections', [{}]); if (ex && ex.opened) await d._call('settle', [{ minMs: 300, quietMs: 600, maxMs: 4000 }]); } catch { /* read what is there */ }
    if (knowledge) { try { applied.set(url, await d._call('applyKnowledge', [knowledge, {}])); } catch { /* preview only */ } }
    let r = null; try { r = await d._call('compactHtml', [{}]); } catch (e) { return { error: `lecture de la page impossible (${String((e && e.message) || e).slice(0, 80)})` }; }
    if (r && r.html) return r;
    return { error: complete ? 'la page chargée ne contient rien de lisible' : 'la page ne s’est pas chargée en 25 s' };
  };
  const close = async (id) => { if (!win) { try { await chrome.tabs.remove(id); } catch { /* gone */ } } };
  // true, or why the app did not keep the page (no answer, too large, memory full…): the reason goes to the manifest.
  const send = async (url, html) => {
    const r = await appRequest({ op: 'page', url, runId, html }, 30000);
    if (r && r.ok) { already.add(url); runPagesSent.set(runId, already); return true; }
    return (r && r.reason) || 'l’application n’a pas reçu la page';
  };
  try {
    const rep = await readSubpages(urls, { open, visit, close, send, concurrency: 2, ...(onOutcome ? { onOutcome } : {}), ...(isStopped ? { isStopped } : {}), onProgress: (done, total) => broadcast({ kind: 'subpage_progress', runId, done, total }) });
    return { ...rep, applied };
  } finally {
    if (win) { try { await chrome.windows.remove(win.id); } catch { /* closed by the user */ } }
    while (runPagesSent.size > 20) runPagesSent.delete(runPagesSent.keys().next().value);
  }
}

// « Exécuter » on a taught site: the preview shows what the taught product rules read. On a product page
// they are read on the page itself; on a list, on the first few product pages (opened in a minimized
// window, kept for « Accepter »). Returns, per field, how many previewed rows the rules filled.
async function previewTaught({ driver, rows, knowledge, pageUrl, runId }) {
  const summary = { pages: 0, fields: {}, missing: [], challenged: 0, unread: 0 };
  const wanted = [...new Set((knowledge.rules || []).filter((r) => r.scope === 'product' && r.status !== 'superseded' && r.status !== 'deprecated').map((r) => r.field))];
  const merge = (row, ap) => { if (!ap || !ap.values) return; for (const f of mergeKnowledgeIntoRow(row, ap)) summary.fields[f] = (summary.fields[f] || 0) + 1; };
  let kind = 'unknown'; try { kind = await driver._call('pageKind', []); } catch { /* unknown */ }
  if (kind === 'product' && rows.length) {
    try { merge(rows[0], await driver._call('applyKnowledge', [knowledge, { name: rows[0].name || '' }])); summary.pages = 1; } catch { summary.unread = 1; }
    // The page itself goes to the app too: « Accepter » reads it there without asking the site again.
    try { const page = await driver._call('compactHtml', [{}]); if (page && page.html) { const r = await appRequest({ op: 'page', url: pageUrl, runId, html: page.html }, 30000); if (r && r.ok) runPagesSent.set(runId, new Set([String(pageUrl).split('#')[0]])); } } catch { /* preview only */ }
  } else {
    const sub = await subpagesInBrowser({ rows, listUrl: pageUrl, runId, max: PREVIEW_PAGES, knowledge });
    if (sub) {
      summary.pages = sub.applied.size; summary.challenged = sub.challenged; summary.unread = sub.failed - sub.challenged;
      summary.blocked = [...sub.outcomes].filter(([, o]) => o !== 'read').map(([url, reason]) => ({ url, reason, ...(sub.reasons && sub.reasons.get(url) ? { detail: sub.reasons.get(url) } : {}) }));
      for (const row of rows) { const u = row && String(row.sourceUrl || row.canonicalUrl || row.url || '').split('#')[0]; if (sub.applied.has(u)) merge(row, sub.applied.get(u)); }
    }
  }
  summary.missing = wanted.filter((f) => !summary.fields[rowKeysOf(f)[0]] && !summary.fields[f]);
  return summary;
}

// « Accepter » is a persisted queue (enrich-queue.mjs): it answers at once, then reads every product page in a
// minimized window of the user's browser, writes what happened to each page after every page, pauses on a
// human check until the user answers it, and records the job in the app. The panel follows the queue in
// chrome.storage.local (and through `enrich_progress` messages); a service worker put to sleep by Chrome
// takes the queue up again when it wakes (resumeEnrichments, below).
const enrichStore = createQueueStore(chrome.storage.local);
const enrichRunning = new Set(); // runIds this worker is running now
const enrichCtl = new Map(); // runId → { stop: boolean }

async function panelAccept({ tabId, rows, fields, settings, meta, card, constants } = {}) {
  if (!Array.isArray(rows) || !rows.length) return { ok: false, reason: 'aucune ligne à enregistrer — lance d’abord « Exécuter »' };
  let url = meta && meta.url;
  if (!url && tabId != null) { try { url = (await chrome.tabs.get(tabId)).url; } catch { url = null; } }
  if (!url) return { ok: false, reason: 'adresse de la liste inconnue — relancez « Exécuter »' };
  const runId = (meta && meta.runId) || `pr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const known = await enrichStore.get(runId);
  if (known && known.phase !== 'error') return { ok: true, started: true, runId, phase: known.phase }; // one record per run
  // Product pages read in the user's browser when « Sous-pages » is on, or when the site was taught fields only
  // its product pages hold. The app then completes each row from the page as the user's browser built it.
  const wantSub = !!(settings && settings.subpages) || !!(meta && Array.isArray(meta.taught) && meta.taught.length);
  const plan = planEnrichment({ rows, listUrl: url, maxPages: settings && settings.maxProductPages, alreadyRead: [...(runPagesSent.get(runId) || [])] });
  let origin = ''; try { origin = new URL(url).origin; } catch { origin = ''; }
  const q = newQueue({ runId, origin, listUrl: url, plan, wantSub });
  // Rows beyond what one job holds are never dropped in silence: the export manifest counts them.
  q.rowsCut = Math.max(0, rows.length - PANEL_MAX_ROWS);
  await enrichStore.putPayload(runId, { rows: rows.slice(0, PANEL_MAX_ROWS), fields, settings, meta: { ...(meta || {}), url, runId }, card, constants: Array.isArray(constants) ? constants : [] });
  await enrichStore.put(q);
  await enrichStore.prune();
  runEnrichment(runId);
  return { ok: true, started: true, runId, phase: q.phase, toRead: plan.toRead, limit: plan.limit };
}

// « Lire les fiches manquantes »: after « Accepter », only the product pages it did not read are opened (failed,
// human check, stopped, never opened, beyond the limit); the list is not read again and the pages already read
// are reused from the app (read again only if the app no longer holds them). The result is a new job.
async function enrichMissing({ runId } = {}) {
  const q = runId ? await enrichStore.get(runId) : null;
  if (!q) return { ok: false, reason: 'travail introuvable — relancez « Exécuter » puis « Accepter »' };
  if (q.phase !== 'done') return { ok: false, reason: 'la lecture des fiches n’est pas terminée' };
  const missing = missingUrls(q);
  if (!missing.length) return { ok: false, reason: 'aucune fiche manquante' };
  const payload = await enrichStore.payload(runId);
  if (!payload) return { ok: false, reason: 'les lignes de ce travail ne sont plus disponibles (plus de 3 h) — relancez « Exécuter »' };
  const n = (q.followUps || 0) + 1;
  const next = `${String(runId).slice(0, 56)}-m${n}`;
  const reuse = await appRequest({ op: 'page_reuse', url: q.listUrl, runId: next, from: runId }, 15000);
  const reused = reuse && reuse.ok && Array.isArray(reuse.urls) ? reuse.urls : [];
  const nq = followUpQueue(q, { runId: next, reused });
  q.followUps = n; await enrichStore.put(q);
  await enrichStore.putPayload(next, { ...payload, settings: { ...(payload.settings || {}), maxProductPages: 0 }, meta: { ...(payload.meta || {}), runId: next } });
  await enrichStore.put(nq);
  runEnrichment(next);
  const toOpen = pendingUrls(nq).length;
  return { ok: true, started: true, runId: next, toOpen, reused: Object.keys(nq.outcomes).length, missing: missing.length };
}

async function runEnrichment(runId) {
  if (enrichRunning.has(runId)) return;
  enrichRunning.add(runId);
  const ctl = enrichCtl.get(runId) || { stop: false }; enrichCtl.set(runId, ctl);
  try {
    let q = await enrichStore.get(runId);
    if (!q) return;
    const payload = await enrichStore.payload(runId);
    if (!payload) { q.phase = 'error'; q.error = 'les lignes de ce travail ne sont plus disponibles — relancez « Exécuter »'; await enrichStore.put(q); broadcastEnrich(q); return; }
    if (q.windowId != null) { try { await chrome.windows.remove(q.windowId); } catch { /* already closed */ } q.windowId = null; }
    if (q.phase === 'reading') {
      try { await appRequest({ op: 'page_keep', url: q.listUrl, runId }, 10000); } catch { /* pages kept or read again */ }
      let paused = false;
      const pending = pendingUrls(q);
      if (pending.length) {
        await subpagesInBrowser({
          rows: [], listUrl: q.listUrl, runId, urls: pending,
          onWindow: async (id) => { q.windowId = id; await enrichStore.put(q); },
          isStopped: () => (ctl.stop ? 'stopped' : (paused ? 'human_check' : false)),
          onOutcome: async (u, o, why) => {
            q.outcomes[u] = o;
            q.reasons = q.reasons || {}; if (why) q.reasons[u] = why; else delete q.reasons[u];
            if (o === 'human_check' && !paused) { paused = true; q.pauseUrl = u; }
            await enrichStore.put(q); broadcastEnrich(q);
          },
        });
        q.windowId = null;
      }
      if (paused && !ctl.stop) { q.phase = 'paused'; await enrichStore.put(q); broadcastEnrich(q); return; }
      closeReading(q); await enrichStore.put(q); broadcastEnrich(q);
    }
    if (q.phase !== 'ingesting') return;
    const { rows, fields, settings, meta, card, constants } = payload;
    const sum = summarize(q);
    const reply = await appRequest({
      op: 'ingest', url: q.listUrl, rows, runId,
      fields: (fields || []).map((f) => ({ key: f.key, label: f.label, role: f.role || null, axis: f.axis || null })), lang: settings && settings.lang,
      // What the user designated with 🎯 on the LIST page: the app keeps it as the site's card recipe.
      designated: card && card !== 'body' ? { card, fields: (fields || []).filter((f) => f && f.selector).map((f) => ({ key: f.key, selector: f.selector, attr: f.attr || null, part: f.part || null, all: f.all || null })) } : null,
      constants: constants || [], // fixed values for every product (brand, collection, type, tags, status…)
      subpages: q.wantSub, browserChallenged: sum.blocked.filter((b) => b.reason === 'human_check').length, browserPages: sum.read,
      durationMs: meta && meta.durationMs, listing: { trail: (meta && Array.isArray(meta.trail)) ? meta.trail : [],
        // How the list was read in the browser and whether its count matches the total it announced (report.pagination).
        pagination: meta ? { mode: (settings && settings.pagination) || 'auto', pages: meta.pages || 1, loads: meta.loads || 0, stoppedBy: meta.stoppedBy || null, total: meta.total || null } : null,
        // The cards the learned card left out (report.listRejected), and the sub-collections of a hub page read.
        rejected: meta && meta.rejected ? meta.rejected : null, hub: meta && Array.isArray(meta.hub) ? meta.hub : null },
      enrich: { toRead: sum.toRead, read: sum.read, blocked: sum.blocked.length, notOpened: sum.notOpened.length, limit: sum.limit, list: [...sum.blocked, ...sum.notOpened].slice(0, 500) },
    }, rows.length > 50 ? 1800000 : 180000); // the app may read product pages again for each row
    q = (await enrichStore.get(runId)) || q;
    if (reply && reply.ok) {
      q.phase = 'done';
      q.result = { jobId: reply.jobId, counts: reply.counts || null, status: reply.status || null, reportStatus: reply.reportStatus || null, rulesFailing: reply.rulesFailing || [], rowsTotal: reply.rowsTotal != null ? reply.rowsTotal : null, cardsLearned: reply.cardsLearned || null };
    } else { q.phase = 'error'; q.error = (reply && reply.reason) || 'aucune réponse de l’application'; }
    await enrichStore.put(q); broadcastEnrich(q);
  } catch (e) {
    const q = await enrichStore.get(runId);
    if (q) { q.phase = 'error'; q.error = String((e && e.message) || e).slice(0, 200); await enrichStore.put(q); broadcastEnrich(q); }
  } finally { enrichRunning.delete(runId); }
}

function broadcastEnrich(q) {
  const s = summarize(q);
  broadcast({ kind: 'enrich_progress', runId: q.runId, phase: q.phase, read: s.read, blocked: s.blocked.length, toRead: s.toRead, done: Object.keys(q.outcomes).length, pauseUrl: q.pauseUrl || null });
}

/** The panel's answer to a paused run, or its « Arrêter »: resume (the page was answered), skip that page, or end. */
async function enrichControl({ runId, action } = {}) {
  const q = runId ? await enrichStore.get(runId) : null;
  if (!q) return { ok: false, reason: 'travail introuvable' };
  if (action === 'stop') {
    if (q.phase === 'reading') { (enrichCtl.get(runId) || enrichCtl.set(runId, { stop: false }).get(runId)).stop = true; if (!enrichRunning.has(runId)) { closeReading(q); await enrichStore.put(q); runEnrichment(runId); } return { ok: true }; }
    if (q.phase === 'paused') { closeReading(q); await enrichStore.put(q); runEnrichment(runId); return { ok: true }; }
    return { ok: false, reason: 'rien à arrêter' };
  }
  if (q.phase !== 'paused') return { ok: false, reason: 'ce travail n’est pas en pause' };
  if (action === 'skip' && q.pauseUrl) q.outcomes[q.pauseUrl] = 'human_check_skipped';
  if (action === 'resume' || action === 'skip') { q.phase = 'reading'; q.pauseUrl = null; await enrichStore.put(q); runEnrichment(runId); return { ok: true }; }
  return { ok: false, reason: 'action inconnue' };
}

/** A chunk of the job's finished rows (the panel asks until `next` is null). */
async function enrichRows({ runId, jobId, url, offset = 0 } = {}) {
  const q = runId ? await enrichStore.get(runId) : null;
  const id = jobId || (q && q.result && q.result.jobId);
  if (!id) return { ok: false, reason: 'job inconnu' };
  return appRequest({ op: 'rows', url: url || (q && q.listUrl), jobId: id, offset }, 60000);
}

/** The queues of a site (newest first), with the rows of the run when the panel asks for them. */
async function enrichState({ origin, runId, withRows = false } = {}) {
  const qs = runId ? [await enrichStore.get(runId)].filter(Boolean) : (await enrichStore.list()).filter((q) => !origin || q.origin === origin);
  const q = qs[0] || null;
  if (!q) return { ok: true, queue: null };
  const payload = withRows ? await enrichStore.payload(q.runId) : null;
  return { ok: true, queue: { ...q, summary: summarize(q) }, ...(payload ? { rows: payload.rows, meta: payload.meta } : {}) };
}

async function enrichConsumed({ runId } = {}) {
  const q = runId ? await enrichStore.get(runId) : null;
  if (!q) return { ok: false };
  q.consumed = true; await enrichStore.put(q); await enrichStore.prune();
  return { ok: true };
}

// A woken service worker takes up the runs it was reading or recording when Chrome put it to sleep.
async function resumeEnrichments() {
  try { for (const q of toResume(await enrichStore.list())) runEnrichment(q.runId); } catch { /* nothing to resume */ }
}
resumeEnrichments();

// ---- Site knowledge (🎯 on a PRODUCT page → rules the app keeps for the whole site) --------------

const MEMO_LINKS = 40;
// The product links the user's collection pages showed, per site: the pages a rule learned on ONE
// product is then checked on ("testée : 4/5 fiches").
async function rememberLinks(origin, rows) {
  try {
    const urls = [...new Set((rows || []).map((r) => r && (r.sourceUrl || r.canonicalUrl || r.url)).filter((u) => typeof u === 'string' && /^https?:/.test(u)))].slice(0, MEMO_LINKS);
    if (!urls.length) return;
    const all = (await chrome.storage.local.get('siteLinks')).siteLinks || {};
    all[origin] = { urls, at: Date.now() };
    const keys = Object.keys(all); if (keys.length > 30) for (const k of keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 30)) delete all[k];
    await chrome.storage.local.set({ siteLinks: all });
  } catch { /* memo is best-effort */ }
}
async function recalledLinks(origin) {
  try { const all = (await chrome.storage.local.get('siteLinks')).siteLinks || {}; return (all[origin] && all[origin].urls) || []; } catch { return []; }
}

// 🎯 on a product page: highlight a block (the whole description, the spec table), wheel to widen,
// click to take it. Returns the rule + what was understood; nothing is stored yet.
async function knowledgePick({ tabId, field, label } = {}) {
  const t = await panelTab(tabId);
  if (t.error) return { ok: false, reason: t.error };
  try { await chrome.tabs.update(tabId, { active: true }); } catch { /* best-effort */ }
  const driver = new TabDriver(chrome, tabId, { log: () => {} });
  try { return (await driver._call('pickKnowledge', [{ field: String(field || 'description'), label: String(label || '') }])) || { ok: false, reason: 'aucune réponse de la page' }; }
  catch (e) { return { ok: false, reason: String(e && e.message || e).slice(0, 160) }; }
}

// "Enregistrer et tester": the rule goes to the app (stored in the site's knowledge), which checks it
// on other product pages of the site and answers with the honest result.
async function knowledgeLearn({ tabId, rule, pageUrl, sampleUrls } = {}) {
  const t = await panelTab(tabId);
  if (t.error) return { ok: false, reason: t.error };
  if (!rule || !rule.selector) return { ok: false, reason: 'aucune règle à enregistrer' };
  const url = pageUrl || t.tab.url;
  let origin = ''; try { origin = new URL(url).origin; } catch { origin = ''; }
  const samples = [...new Set([...(Array.isArray(sampleUrls) ? sampleUrls : []), ...(await recalledLinks(origin))])].slice(0, 30);
  const r = await appRequest({ op: 'learn', url, scope: 'product', origin: 'manual', rules: [rule], sampleUrls: samples }, 60000);
  // No other product page could be read over plain HTTP (a protected site): the check runs on pages opened in
  // the user's own browser instead, so the rule's result is measured on pages that are really readable.
  if (r && r.ok && !r.sampled && samples.length) {
    const viaBrowser = await checkInBrowser({ url, field: rule.field, samples: samples.filter((u) => String(u).split('#')[0] !== String(url).split('#')[0]) });
    if (viaBrowser) return { ...r, ...viaBrowser, rules: (viaBrowser.rules || []).map((x) => ({ ...x, failures: [] })) };
  }
  return r;
}

// Check a field's rule on a few product pages opened in the user's browser (minimized window), then ask the
// app to test the rule on exactly those pages. Null when no page could be read (each reason is counted).
const BROWSER_CHECK_PAGES = 4;
async function checkInBrowser({ url, field, samples }) {
  const urls = [...new Set(samples)].slice(0, BROWSER_CHECK_PAGES);
  if (!urls.length) return null;
  const runId = `kt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  let sub = null; try { sub = await subpagesInBrowser({ rows: [], listUrl: url, runId, urls }); } catch { sub = null; }
  if (!sub || !sub.sent) return sub ? { browserCheck: { read: 0, challenged: sub.challenged } } : null;
  const rt = await appRequest({ op: 'retest', url, field, scope: 'product', pageRunId: runId }, 60000);
  return rt && rt.ok ? { sampled: rt.sampled, rules: rt.rules, browserCheck: { read: sub.sent, challenged: sub.challenged } } : { browserCheck: { read: sub.sent, challenged: sub.challenged } };
}

// 🎯 « bouton page suivante » / « charger plus »: the user points at it once; its cues are kept for the site
// (in the app and here). A pointed control that is not usable says why — never a silent « nothing kept ».
const MEMO_PART = { next: 'next', load_more: 'loadMore' };
async function pickNext({ tabId, kind = 'next' } = {}) {
  const t = await panelTab(tabId); if (t.error) return { ok: false, reason: t.error };
  const part = MEMO_PART[kind] || 'next';
  try { await chrome.tabs.update(tabId, { active: true }); } catch { /* best-effort */ }
  let r; try { r = await new TabDriver(chrome, tabId, { log: () => {} })._call('pickNextButton', [{ kind: kind === 'load_more' ? 'load_more' : 'next' }]); } catch (e) { r = { ok: false, reason: String(e && e.message || e).slice(0, 160) }; }
  if (!r || !r.ok) return r || { ok: false, reason: 'aucune réponse de la page' };
  const cues = sanitizeCues(r.cues || r.selector);
  if (!cues) return { ok: false, reason: 'ce bouton n’a pas de repère utilisable' };
  const saved = await updateSitePagination(t, { [part]: cues });
  return { ok: true, text: r.text || cues.text || cues.label || '', savedIn: saved.savedIn, memo: saved.memo };
}
async function forgetNext({ tabId, kind = 'next' } = {}) {
  const t = await panelTab(tabId); if (t.error) return { ok: false, reason: t.error };
  const saved = await updateSitePagination(t, { [MEMO_PART[kind] || 'next']: null });
  return { ok: true, memo: saved.memo, savedIn: saved.savedIn };
}
async function nextInfo({ tabId } = {}) {
  const t = await panelTab(tabId); if (t.error) return { ok: false, reason: t.error };
  const { memo, savedIn } = await sitePagination(t);
  return { ok: true, domain: t.domain, memo, savedIn, selector: memo && memo.next ? (memo.next.selector || memo.next.text || null) : null };
}
// « Valeurs fixes »: the site profile and the batch of a list page, read from / saved in the app. `url` is the list
// page of the batch (the tab may show one of its product pages): only accepted on the tab's own site.
async function siteValues({ tabId, action, url, site, batch } = {}) {
  const t = await panelTab(tabId); if (t.error) return { ok: false, reason: t.error };
  let page = t.tab.url;
  try { if (url && new URL(url).hostname.replace(/^www\./, '') === t.domain) page = url; } catch { /* the tab's page */ }
  const p ={ op: 'site_values', action: action === 'set' ? 'set' : 'get', url: page };
  if (p.action === 'set') { if (site !== undefined) p.site = site; if (batch !== undefined) p.batch = batch; }
  return (await appRequest(p, 8000)) || { ok: false, reason: 'aucune réponse de l’application' };
}

// The mode chosen for the site (the select of the Pages tab), kept with its controls.
async function setPaginationMode({ tabId, mode } = {}) {
  const t = await panelTab(tabId); if (t.error) return { ok: false, reason: t.error };
  const saved = await updateSitePagination(t, { mode });
  return { ok: true, memo: saved.memo, savedIn: saved.savedIn };
}

async function pageKindOf({ tabId } = {}) {
  const t = await panelTab(tabId); if (t.error) return { ok: false, reason: t.error };
  try { return { ok: true, kind: await new TabDriver(chrome, tabId, { log: () => {} })._call('pageKind', []) }; } catch { return { ok: false, reason: 'lecture de la page impossible' }; }
}

async function knowledgeSummary({ tabId } = {}) {
  const t = await panelTab(tabId); if (t.error) return { ok: false, reason: t.error };
  return appRequest({ op: 'knowledge', url: t.tab.url }, 8000);
}
async function knowledgeRetest({ tabId, field } = {}) {
  const t = await panelTab(tabId); if (t.error) return { ok: false, reason: t.error };
  let origin = ''; try { origin = new URL(t.tab.url).origin; } catch { origin = ''; }
  const samples = (await recalledLinks(origin)).slice(0, 10);
  const r = await appRequest({ op: 'retest', url: t.tab.url, field, scope: 'product', sampleUrls: samples }, 60000);
  // Plain HTTP read no other product page: the same check on pages opened in the user's browser.
  if (r && !r.ok && samples.length) { const viaBrowser = await checkInBrowser({ url: t.tab.url, field, samples }); if (viaBrowser && viaBrowser.rules) return { ok: true, ...viaBrowser }; if (viaBrowser) return { ...r, ...viaBrowser }; }
  return r;
}
// ---- Chat agent (the app holds the AI key and runs the tools on the page this sends) ----------------------
// The last « Exécuter » preview per tab: the agent sees what the panel just showed the user.
const lastPreview = new Map(); // tabId → { taughtPreview, rows }
async function agentChat({ tabId, chatId, message } = {}) {
  const t = await panelTab(tabId); if (t.error) return { ok: false, reason: t.error };
  const driver = new TabDriver(chrome, tabId, { log: () => {} });
  let page = null; try { page = await driver._call('compactHtml', [{}]); } catch { page = null; }
  if (!page || !page.html) return { ok: false, reason: 'lecture de la page impossible' };
  let around = []; try { around = (await driver._call('sameShapeLinks', [])) || []; } catch { around = []; }
  const r = await appRequest({ op: 'chat', url: t.tab.url, chatId, message, html: page.html, preview: lastPreview.get(tabId) || null, sampleUrls: around.slice(0, 10) }, 240000);
  // What the agent asked to show in the page.
  for (const a of (r && Array.isArray(r.actions) ? r.actions : []).slice(0, 5)) {
    if (a && a.highlight) { try { await chrome.tabs.update(tabId, { active: true }); await driver._call('highlight', [a.highlight, a.label || '']); } catch { /* the page moved on */ } }
  }
  return r;
}

// A repair proposal answered in the panel (accept / reject), or an automatic repair undone.
async function knowledgeRepair({ tabId, action, id } = {}) {
  const t = await panelTab(tabId); if (t.error) return { ok: false, reason: t.error };
  return appRequest({ op: 'repair', url: t.tab.url, action, id }, 8000);
}
async function knowledgeForget({ tabId, field, scope } = {}) {
  const t = await panelTab(tabId); if (t.error) return { ok: false, reason: t.error };
  return appRequest({ op: 'forget', url: t.tab.url, field, scope: scope || 'product' }, 8000);
}

// "Détecter par IA" on a product page: the app reads the page (structured data, embedded state, DOM)
// and the values it finds are located back in the page as PROPOSED rules (a 🎯 corrects them).
async function knowledgePropose({ tabId } = {}) {
  const t = await panelTab(tabId); if (t.error) return { ok: false, reason: t.error };
  const driver = new TabDriver(chrome, tabId, { log: () => {} });
  let kind = 'unknown'; try { kind = await driver._call('pageKind', []); } catch { /* unknown */ }
  let ctx; try { ctx = await driver.context(); } catch { return { ok: false, reason: 'lecture de la page impossible' }; }
  const html = (ctx && ctx.body) || '';
  if (html.length > 900000) return { ok: false, reason: 'page trop volumineuse pour l’analyse' };
  let origin = ''; try { origin = new URL(t.tab.url).origin; } catch { origin = ''; }
  let around = []; try { around = (await driver._call('sameShapeLinks', [])) || []; } catch { around = []; }
  const sampleUrls = [...new Set([...around, ...(await recalledLinks(origin))])].slice(0, 20);
  const r = await appRequest({ op: 'propose', url: (ctx && ctx.url) || t.tab.url, html, sampleUrls }, 120000);
  return { ...r, pageKind: kind };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.kind === 'status') { reply({ link: link ? link.status : 'disconnected', jobs: [...live.keys()] }); return true; }
  if (msg && msg.kind === 'panel_run') { panelRun(msg).then(reply).catch((e) => reply({ ok: false, reason: String(e && e.message || e) })); return true; }
  if (msg && msg.kind === 'ai_detect') { aiCollectAndAssist(msg).then(reply).catch((e) => reply({ ok: false, reason: String(e && e.message || e) })); return true; }
  if (msg && msg.kind === 'stop') { stopJob(msg.job_id); reply({ ok: true }); return true; }
  if (msg && msg.kind === 'resume') { resumeJob(msg.job_id); reply({ ok: true }); return true; }
  // Side-panel (interactive UI). The AI key lives in the app, so key state is reported
  // by the app over the native link; the panel shows app connectivity meanwhile.
  if (msg && msg.kind === 'ai_status') { const on = !!(link && link.status === 'connected'); reply({ ok: true, configured: false, managed: on, reason: on ? 'clé gérée dans l’application (vérifiée au clic)' : 'application hors ligne — démarrez Eloshon' }); return true; }
  if (msg && msg.kind === 'pick_cancel') { panelPickCancel(msg).then(reply).catch(() => reply({ ok: false })); return true; }
  if (msg && msg.kind === 'pick_element') { withPickTab(msg.tabId, () => panelPick(msg)).then(reply).catch((e) => reply({ ok: false, reason: String(e && e.message || e) })); return true; }
  if (msg && msg.kind === 'pick_next') { withPickTab(msg.tabId, () => pickNext(msg)).then(reply).catch((e) => reply({ ok: false, reason: String(e && e.message || e) })); return true; }
  if (msg && msg.kind === 'forget_next') { forgetNext(msg).then(reply).catch(() => reply({ ok: false })); return true; }
  if (msg && msg.kind === 'next_info') { nextInfo(msg).then(reply).catch(() => reply({ ok: false })); return true; }
  if (msg && msg.kind === 'card') { withPickTab(msg.tabId, () => cardAction(msg)).then(reply).catch((e) => reply({ ok: false, reason: String(e && e.message || e) })); return true; }
  if (msg && msg.kind === 'site_values') { siteValues(msg).then(reply).catch((e) => reply({ ok: false, reason: String(e && e.message || e) })); return true; }
  if (msg && msg.kind === 'pagination_mode') { setPaginationMode(msg).then(reply).catch(() => reply({ ok: false })); return true; }
  if (msg && msg.kind === 'pagination_test') { panelPaginationTest(msg).then(reply).catch((e) => reply({ ok: false, reason: String(e && e.message || e) })); return true; }
  if (msg && msg.kind === 'page_kind') { pageKindOf(msg).then(reply).catch(() => reply({ ok: false })); return true; }
  if (msg && msg.kind === 'knowledge_pick') { withPickTab(msg.tabId, () => knowledgePick(msg)).then(reply).catch((e) => reply({ ok: false, reason: String(e && e.message || e) })); return true; }
  if (msg && msg.kind === 'knowledge_learn') { knowledgeLearn(msg).then(reply).catch((e) => reply({ ok: false, reason: String(e && e.message || e) })); return true; }
  if (msg && msg.kind === 'knowledge_summary') { knowledgeSummary(msg).then(reply).catch((e) => reply({ ok: false, reason: String(e && e.message || e) })); return true; }
  if (msg && msg.kind === 'knowledge_retest') { knowledgeRetest(msg).then(reply).catch((e) => reply({ ok: false, reason: String(e && e.message || e) })); return true; }
  if (msg && msg.kind === 'recipes') { (async () => { const t = await panelTab(msg.tabId); const url = t.tab ? t.tab.url : 'https://eloshon.invalid/'; return appRequest({ op: 'recipes', url, action: msg.action, file: msg.file, previewId: msg.previewId }, 60000); })().then(reply).catch((e) => reply({ ok: false, reason: String(e && e.message || e) })); return true; }
  if (msg && msg.kind === 'agent_chat') { agentChat(msg).then(reply).catch((e) => reply({ ok: false, reason: String(e && e.message || e) })); return true; }
  if (msg && msg.kind === 'knowledge_repair') { knowledgeRepair(msg).then(reply).catch((e) => reply({ ok: false, reason: String(e && e.message || e) })); return true; }
  if (msg && msg.kind === 'knowledge_forget') { knowledgeForget(msg).then(reply).catch((e) => reply({ ok: false, reason: String(e && e.message || e) })); return true; }
  if (msg && msg.kind === 'knowledge_propose') { knowledgePropose(msg).then(reply).catch((e) => reply({ ok: false, reason: String(e && e.message || e) })); return true; }
  if (msg && msg.kind === 'enrich_missing') { enrichMissing(msg).then(reply).catch((e) => reply({ ok: false, reason: String(e && e.message || e) })); return true; }
  if (msg && msg.kind === 'panel_accept') { panelAccept(msg).then(reply).catch((e) => reply({ ok: false, reason: String(e && e.message || e) })); return true; }
  if (msg && msg.kind === 'enrich_control') { enrichControl(msg).then(reply).catch((e) => reply({ ok: false, reason: String(e && e.message || e) })); return true; }
  if (msg && msg.kind === 'enrich_rows') { enrichRows(msg).then(reply).catch((e) => reply({ ok: false, reason: String(e && e.message || e) })); return true; }
  if (msg && msg.kind === 'enrich_state') { enrichState(msg).then(reply).catch((e) => reply({ ok: false, reason: String(e && e.message || e) })); return true; }
  if (msg && msg.kind === 'enrich_consumed') { enrichConsumed(msg).then(reply).catch(() => reply({ ok: false })); return true; }
  return false;
});

// ---- Keep-alive + wake resume ----------------------------------------------

chrome.runtime.onStartup.addListener(bootstrap);
chrome.runtime.onInstalled.addListener(bootstrap);
function bootstrap() {
  try { chrome.alarms.create(HEARTBEAT, { periodInMinutes: 0.5 }); } catch { /* */ }
  // Clicking the toolbar icon opens the interactive side panel (Thunderbit-style).
  try { if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch { /* older Chrome */ }
  connectApp();
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === HEARTBEAT) connectApp(); // no-op while linked or while a reconnect is scheduled
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Connect immediately on load too (SW may spin up outside startup events).
connectApp();
