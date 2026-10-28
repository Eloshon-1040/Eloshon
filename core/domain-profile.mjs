/**
 * Domain profiles — the scraper's MEMORY of how each site behaves, so a repeat
 * run doesn't re-derive everything from scratch. Per registrable host we remember
 * what actually WORKED: the discovery method, robots-declared sitemaps, the best
 * extractor strategy, locale, whether a browser / hard-unlock was needed, and the
 * last product count + a confidence signal.
 *
 * Design principles:
 *   • ADDITIVE and SAFE — a profile only provides HINTS (e.g. known sitemap URLs
 *     to try first). It never removes a discovery avenue, so a stale/wrong profile
 *     can only cost a little time, never correctness. The full ladder still runs.
 *   • Storage-agnostic — this module is pure logic over a plain object map; the
 *     app persists it as JSON in app-data (injected), tests use an in-memory map.
 *   • Generic — keyed by host, no per-site logic anywhere.
 */

import { upsertRule, recordOutcome, setTests, emptyKnowledge, migrateKnowledge, KNOWLEDGE_VERSION } from '../shared/knowledge/rules.mjs';
import { putBatch } from '../shared/export/site-values.mjs';

/** Registrable-ish host key (www-insensitive, lowercased). An address typed
 *  without a scheme ("shop.example/fr/c?q=x") is read as https:// — it used to
 *  become a key holding the whole address, so the profile was never found again. */
export function hostKey(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return s.toLowerCase(); }
}

/** A stored key that is not a bare host (it holds a path, a query or a scheme). */
const isMalformedKey = (k) => /[/?#]|:\/\//.test(k);

/**
 * Re-key entries saved under a whole address (written by the old hostKey) to
 * their host. On a collision the most recently updated profile wins (the other
 * is dropped — a profile is advisory memory, never data). Pure; returns
 * { map, changed }.
 */
export function migrateProfileKeys(map) {
  const out = {}; let changed = false;
  const stamp = (p) => Date.parse((p && p.updatedAt) || '') || 0;
  for (const [k, v] of Object.entries(map || {})) {
    const key = isMalformedKey(k) ? hostKey(k) : k;
    if (key !== k) changed = true;
    if (!key) { changed = true; continue; }
    if (!out[key] || stamp(v) > stamp(out[key])) out[key] = v;
  }
  return { map: out, changed };
}

const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

// internal_api recipe lifecycle (2b) — same spirit as the rest of the profile:
// a learned endpoint is a HINT, demoted after repeated failures and re-verified
// once stale, and a demotion only falls back to normal discovery (never wrong).
export const INTERNAL_API_MAX_FAILS = 3;                      // consecutive fails → 'deprecated'
export const INTERNAL_API_TTL_MS = 14 * 24 * 60 * 60 * 1000;  // re-verify after ~14 days
// Manual-designation selectors (Thunderbit-style, last resort): a HUMAN pointed at
// the fields, so trust them longer than a derived API, but still demote on repeated
// failure (the page changed) and re-verify after a longer TTL.
export const MANUAL_SELECTORS_MAX_FAILS = 3;
export const MANUAL_SELECTORS_TTL_MS = 60 * 24 * 60 * 60 * 1000; // ~60 days
// Link-filter recipe (scoped collection): a HUMAN designated the listing region /
// URL patterns, so it earns the same trust window as manual selectors.
export const LINK_FILTER_MAX_FAILS = 3;
export const LINK_FILTER_TTL_MS = 60 * 24 * 60 * 60 * 1000; // ~60 days

// A learned artifact (internal_api recipe, manual selectors or link filter) shares one lifecycle:
// it is a HINT, demoted after MAX consecutive fails, re-verified after a TTL, and a
// demotion only falls back to normal discovery — never a wrong result.
function recipeUsable(recipe, meta, present) {
  if (!recipe || !present(recipe)) return false;
  if (meta && meta.status === 'deprecated') return false;
  return true;
}
function recipeStale(meta, ttlMs, now) {
  if (!meta || !meta.last_verified) return true;
  const t = Date.parse(meta.last_verified);
  return !Number.isFinite(t) || (now - t) > ttlMs;
}
function bumpMeta(meta, ok, maxFails, now) {
  const m = { ...(meta || { status: 'candidate', version: 1, success_count: 0, fail_count: 0, consecutive_fails: 0, last_verified: now }) };
  if (ok) { m.success_count += 1; m.consecutive_fails = 0; m.last_verified = now; if (m.status === 'deprecated') m.status = 'candidate'; }
  else { m.fail_count += 1; m.consecutive_fails += 1; if (m.consecutive_fails >= maxFails) m.status = 'deprecated'; }
  return m;
}
const hasEndpoint = (r) => !!(r && r.endpoint_tpl);
const hasSelectors = (r) => !!(r && r.card && r.fields && Object.keys(r.fields).length);
const hasLinkFilter = (r) => !!(r && (r.container || (Array.isArray(r.url_templates) && r.url_templates.length)));

/**
 * Merge a run's observations into a host profile (immutable-ish: returns a new
 * object). Only meaningful (non-empty) observations overwrite; counters/dates
 * always update. `runs` counts how many times we've learned this host.
 * @param {object|null} prev  existing profile or null
 * @param {object} obs  { method, diagnosis, sitemaps, locale, extractorStrategy,
 *                        needsBrowser, needsUnlock, productCount, sampleUrl, confidence }
 * @param {string} [now] ISO date (injectable for deterministic tests)
 */
export function mergeProfile(prev, obs = {}, now = new Date().toISOString()) {
  const p = { ...(prev || {}) };
  const set = (k, v) => { if (!isEmpty(v)) p[k] = v; };
  set('method', obs.method);                 // discovery: sitemap | crawl | browser | unlock
  set('diagnosis', obs.diagnosis);
  set('browser', obs.browser);               // none | playwright | nodriver
  set('blockedBy', obs.blockedBy);           // observed anti-bot code (BOT_CHALLENGE/ACCESS_DENIED…)
  set('pageType', obs.pageType);             // product | collection | search | home | unknown
  set('urlShape', obs.urlShape);             // typical product-URL path shape
  set('locale', obs.locale && (obs.locale.country || obs.locale.language) ? obs.locale : undefined);
  set('extractorStrategy', obs.extractorStrategy);
  set('sampleUrl', obs.sampleUrl);
  if (!isEmpty(obs.sitemaps)) p.sitemaps = [...new Set(obs.sitemaps)].slice(0, 40);
  if (typeof obs.needsBrowser === 'boolean') p.needsBrowser = obs.needsBrowser;
  if (typeof obs.needsUnlock === 'boolean') p.needsUnlock = obs.needsUnlock;
  set('unlockRoute', obs.unlockRoute);       // the paid route that worked last time (firecrawl | web-unlocker | scraping-browser) — tried first next time
  // The way this site's PRODUCT pages could be read (detailAccessOf below), dated so it expires.
  if (DETAIL_ACCESS.includes(obs.detailAccess)) { p.detailAccess = obs.detailAccess; p.detailAccessAt = now; }
  // Who reads this site's LISTS: the app itself, or only the user's own browser (the extension), dated too.
  if (LIST_ACCESS.includes(obs.listAccess)) { p.listAccess = obs.listAccess; p.listAccessAt = now; }
  else if (obs.listAccess === null) { delete p.listAccess; delete p.listAccessAt; } // the app was refused: no longer its reader
  // The last page a paid route served from its own cache-capable fetch had no
  // product → the next paid fetch skips the provider's cache (Firecrawl maxAge 0).
  if (typeof obs.unlockCacheBypass === 'boolean') p.unlockCacheBypass = obs.unlockCacheBypass;
  if (typeof obs.productCount === 'number') p.lastProductCount = obs.productCount;
  if (typeof obs.confidence === 'number') p.confidence = Math.round(obs.confidence * 100) / 100;
  if (typeof obs.ms === 'number') p.lastMs = obs.ms;
  if (obs.productCount > 0) p.lastSuccess = now; // only a real yield counts as success
  // internal_api (2b): the SELF-SUFFICIENT replay spec. It is stored verbatim so it
  // equals the Supabase `recipes.internal_api` jsonb column (no conversion on sync).
  // Its lifecycle counters live SEPARATELY in `internalApiMeta` (they map 1:1 to the
  // sibling `recipes` row columns), keeping `internal_api` exactly the column value.
  // The API key is NEVER stored here — the recipe records only WHERE to re-read it.
  if (obs.internalApi && obs.internalApi.endpoint_tpl) {
    const prevEp = prev && prev.internal_api && prev.internal_api.endpoint_tpl;
    p.internal_api = obs.internalApi;
    if (prevEp !== obs.internalApi.endpoint_tpl || !p.internalApiMeta) {
      p.internalApiMeta = {
        status: 'candidate',
        version: (((prev && prev.internalApiMeta && prev.internalApiMeta.version) || 0) + 1),
        success_count: 0, fail_count: 0, consecutive_fails: 0, last_verified: now,
      };
    }
  }
  // manual_selectors (Thunderbit-style, last resort): the user pointed at the fields,
  // so we store their designation verbatim next to internal_api (== Supabase column),
  // with the SAME lifecycle. Reset the meta when the card anchor changes (a new layout).
  if (obs.manualSelectors && hasSelectors(obs.manualSelectors)) {
    const prevCard = prev && prev.manual_selectors && prev.manual_selectors.card;
    p.manual_selectors = obs.manualSelectors;
    if (prevCard !== obs.manualSelectors.card || !p.manualSelectorsMeta) {
      p.manualSelectorsMeta = {
        status: 'candidate',
        version: (((prev && prev.manualSelectorsMeta && prev.manualSelectorsMeta.version) || 0) + 1),
        success_count: 0, fail_count: 0, consecutive_fails: 0, last_verified: now,
      };
    }
  }
  // link_filter (scoped collection): stored verbatim next to internal_api and
  // manual_selectors (== Supabase `recipes.link_filter` jsonb column), with the
  // SAME lifecycle. Reset the meta when the container OR the url_templates change
  // (a new designation), mirroring the card-anchor reset above. Patterns stay
  // plain strings (JSON-serializable as-is), never RegExp objects.
  if (obs.linkFilter && hasLinkFilter(obs.linkFilter)) {
    const prevLf = (prev && prev.link_filter) || {};
    const sameShape = prevLf.container === obs.linkFilter.container
      && JSON.stringify(prevLf.url_templates || []) === JSON.stringify(obs.linkFilter.url_templates || []);
    p.link_filter = obs.linkFilter;
    if (!sameShape || !p.linkFilterMeta) {
      p.linkFilterMeta = {
        status: 'candidate',
        version: (((prev && prev.linkFilterMeta && prev.linkFilterMeta.version) || 0) + 1),
        success_count: 0, fail_count: 0, consecutive_fails: 0, last_verified: now,
      };
    }
  }
  // Persist a recipe replay OUTCOME through the same store.record path (no second
  // system): a boolean bumps the sibling lifecycle (success clears the streak /
  // revives; MAX consecutive fails deprecates → engine falls back to discovery).
  if (typeof obs.internalApiOutcome === 'boolean' && hasEndpoint(p.internal_api)) {
    p.internalApiMeta = bumpMeta(p.internalApiMeta, obs.internalApiOutcome, INTERNAL_API_MAX_FAILS, now);
  }
  if (typeof obs.manualSelectorsOutcome === 'boolean' && hasSelectors(p.manual_selectors)) {
    p.manualSelectorsMeta = bumpMeta(p.manualSelectorsMeta, obs.manualSelectorsOutcome, MANUAL_SELECTORS_MAX_FAILS, now);
  }
  if (typeof obs.linkFilterOutcome === 'boolean' && hasLinkFilter(p.link_filter)) {
    p.linkFilterMeta = bumpMeta(p.linkFilterMeta, obs.linkFilterOutcome, LINK_FILTER_MAX_FAILS, now);
  }
  // How this site's lists load more, as the user set it in the extension's panel (mode, the « suivant » /
  // « charger plus » controls shown with 🎯, the last « Tester »): stored as given (validated by the
  // panel request), null forgets it. Shared with the extension and recipes.json.
  if (obs.listPagination && typeof obs.listPagination === 'object') p.list_pagination = obs.listPagination;
  else if (obs.listPagination === null) delete p.list_pagination;
  // Fixed values on two levels (shared/export/site-values.mjs), saved from the panel: the SITE profile (brand,
  // fields) and one BATCH per list page (collection, type, tags, status…). Validated by the panel request.
  // Which batches (list pages) each product of the site was recorded in (site-values.mjs indexBatch).
  if (obs.batchIndex && typeof obs.batchIndex === 'object') p.batch_index = obs.batchIndex;
  // The product card learned in the panel (shared/extract/card-model.mjs), validated by the panel request.
  if (obs.cardModel && typeof obs.cardModel === 'object') p.card_model = obs.cardModel;
  else if (obs.cardModel === null) delete p.card_model;
  if (obs.siteValues && typeof obs.siteValues === 'object') p.site_values = obs.siteValues;
  else if (obs.siteValues === null) delete p.site_values;
  if (obs.listBatch && typeof obs.listBatch.key === 'string') {
    p.list_batches = putBatch(p.list_batches, obs.listBatch.key, obs.listBatch.batch || null);
    if (!Object.keys(p.list_batches).length) delete p.list_batches;
  }
  // SITE KNOWLEDGE (shared/knowledge): rules taught by the user (🎯) or proposed by the AI,
  // one store for both. `knowledgeRules` are upserted with the manual > AI priority,
  // `knowledgeTests` ({ruleId: {ok,total,urls}}) replace a multi-page check, and
  // `knowledgeOutcomes` ({ruleId: {ok,fail}}) fold the pages a scrape read with them.
  if (obs.knowledgeReplace && Array.isArray(obs.knowledgeReplace.rules)) p.siteKnowledge = obs.knowledgeReplace; // the user forgot some rules
  if (Array.isArray(obs.knowledgeRules) && obs.knowledgeRules.length) {
    let k = p.siteKnowledge || emptyKnowledge();
    for (const r of obs.knowledgeRules) k = upsertRule(k, r, now).knowledge;
    p.siteKnowledge = k;
  }
  if (obs.knowledgeTests && p.siteKnowledge) {
    let k = p.siteKnowledge;
    for (const [id, t] of Object.entries(obs.knowledgeTests)) k = setTests(k, id, t, now);
    p.siteKnowledge = k;
  }
  if (obs.knowledgeOutcomes && p.siteKnowledge) {
    let k = p.siteKnowledge;
    for (const [id, o] of Object.entries(obs.knowledgeOutcomes)) {
      for (let i = 0; i < (o.ok || 0); i++) k = recordOutcome(k, id, true, { now });
      for (let i = 0; i < (o.fail || 0); i++) k = recordOutcome(k, id, false, { now });
    }
    p.siteKnowledge = k;
  }
  p.runs = (p.runs || 0) + 1;
  p.updatedAt = now;
  return p;
}

/**
 * Derive a generic product-URL shape from a sample URL (host-agnostic): a pure
 * numeric segment → '#', a segment mixing digits + text (id-slug) → '#-slug',
 * plain segments kept; consecutive '#-slug' collapsed. e.g.
 *   /fr/463-testeurs/5471-92458-bubble.html → /fr/#-slug
 *   /p/005010101 → /p/#   ·   /products/mens-runner → /products/mens-runner
 */
export function urlShapeOf(sampleUrl) {
  try {
    const segs = new URL(sampleUrl).pathname.split('/').filter((s) => s.length);
    const shaped = segs.map((s) => (/^\d+$/.test(s) ? '#' : (/\d/.test(s) ? '#-slug' : s)));
    const out = [];
    for (const s of shaped) { if (s === '#-slug' && out[out.length - 1] === '#-slug') continue; out.push(s); }
    return ('/' + out.join('/')).slice(0, 80);
  } catch { return null; }
}

/**
 * Turn a stored profile into SAFE hints for the next discovery. Never removes an
 * avenue — only supplies known-good starting points and advisory flags.
 * @returns {{ sitemapHints:string[], preferBrowser:boolean, preferUnlock:boolean, knownMethod:string|null }}
 */
export function profileHints(profile) {
  if (!profile) return { sitemapHints: [], preferBrowser: false, preferUnlock: false, knownMethod: null, knowledge: null };
  return {
    sitemapHints: Array.isArray(profile.sitemaps) ? profile.sitemaps : [],
    // Advisory only: a site that has NEEDED a browser/unlock before is likely to
    // again — the engine may escalate sooner, but the cheap tiers still run first.
    preferBrowser: profile.needsBrowser === true || /needs-browser/.test(profile.diagnosis || ''),
    preferUnlock: profile.needsUnlock === true,
    knownMethod: profile.method || null,
    // 2b: a live internal-API recipe to try FIRST over cheap HTTP (null when absent
    // or deprecated). `internalApiStale` tells the caller to re-verify opportunistically.
    internalApi: internalApiUsable(profile) ? profile.internal_api : null,
    internalApiStale: internalApiStale(profile),
    // Last-resort manual designation (human-pointed selectors). Offered only when
    // present + not deprecated; the engine uses it after the automatic lanes fail.
    manualSelectors: manualSelectorsUsable(profile) ? profile.manual_selectors : null,
    manualSelectorsStale: manualSelectorsStale(profile),
    // Scoped-collection link filter (human-designated region + URL patterns).
    // Advisory like the rest: it narrows link collection when offered, and its
    // absence/deprecation simply leaves the full crawl untouched.
    linkFilter: linkFilterUsable(profile) ? profile.link_filter : null,
    linkFilterStale: linkFilterStale(profile),
    // Site knowledge: the rules the user / the AI taught for this host (null when none).
    knowledge: profile.siteKnowledge && Array.isArray(profile.siteKnowledge.rules) && profile.siteKnowledge.rules.length ? profile.siteKnowledge : null,
    // How product pages were read last time (http | browser | extension), null when unknown or expired.
    detailAccess: detailAccessOf(profile),
    // 'extension' when only the user's browser could read its lists lately (expires like detailAccess).
    listAccess: listAccessOf(profile),
    // How its lists load more, as the user set it in the extension (null when never set).
    listPagination: profile.list_pagination && typeof profile.list_pagination === 'object' ? profile.list_pagination : null,
    // The fixed values saved for the site and for each of its list pages (null / {} when none).
    siteValues: profile.site_values && typeof profile.site_values === 'object' ? profile.site_values : null,
    listBatches: profile.list_batches && typeof profile.list_batches === 'object' ? profile.list_batches : {},
    batchIndex: profile.batch_index && typeof profile.batch_index === 'object' ? profile.batch_index : {},
    // The product card learned in the panel (null when none).
    cardModel: profile.card_model && typeof profile.card_model === 'object' ? profile.card_model : null,
  };
}

/**
 * Bring every stored site knowledge to the current schema (shared/knowledge/rules.mjs
 * migrateKnowledge). Returns the map to keep and whether anything changed.
 */
export function migrateKnowledgeAll(map) {
  if (!map || typeof map !== 'object') return { map, changed: false };
  let changed = false; const out = {};
  for (const [host, p] of Object.entries(map)) {
    if (p && p.siteKnowledge) {
      const m = migrateKnowledge(p.siteKnowledge);
      if (m.changed) { out[host] = { ...p, siteKnowledge: m.knowledge }; changed = true; continue; }
    }
    out[host] = p;
  }
  return { map: changed ? out : map, changed };
}

/** Is the stored internal_api recipe usable (present + not deprecated)? */
export function internalApiUsable(profile) {
  return recipeUsable(profile && profile.internal_api, profile && profile.internalApiMeta, hasEndpoint);
}
/** True when the internal_api recipe has not been verified within its TTL. */
export function internalApiStale(profile, now = Date.now()) {
  return recipeStale(profile && profile.internalApiMeta, INTERNAL_API_TTL_MS, now);
}
/**
 * Record the outcome of an internal_api replay, updating the sibling lifecycle
 * counters: a success clears the fail streak and revives a deprecated recipe; MAX
 * consecutive fails deprecates it so the engine falls back to normal discovery.
 * Returns a new profile (immutable-ish).
 */
export function recordInternalApiOutcome(profile, ok, now = new Date().toISOString()) {
  if (!profile || !hasEndpoint(profile.internal_api)) return profile;
  const p = { ...profile };
  p.internalApiMeta = bumpMeta(p.internalApiMeta, ok, INTERNAL_API_MAX_FAILS, now);
  p.updatedAt = now;
  return p;
}

/** Are the stored manual_selectors usable (a card + at least one field, not deprecated)? */
export function manualSelectorsUsable(profile) {
  return recipeUsable(profile && profile.manual_selectors, profile && profile.manualSelectorsMeta, hasSelectors);
}
/** True when the manual selectors have not been verified within their TTL. */
export function manualSelectorsStale(profile, now = Date.now()) {
  return recipeStale(profile && profile.manualSelectorsMeta, MANUAL_SELECTORS_TTL_MS, now);
}
/** Record the outcome of a manual-selector scrape (same lifecycle as internal_api). */
export function recordManualSelectorsOutcome(profile, ok, now = new Date().toISOString()) {
  if (!profile || !hasSelectors(profile.manual_selectors)) return profile;
  const p = { ...profile };
  p.manualSelectorsMeta = bumpMeta(p.manualSelectorsMeta, ok, MANUAL_SELECTORS_MAX_FAILS, now);
  p.updatedAt = now;
  return p;
}

/** Is the stored link_filter usable (a container or url_templates, not deprecated)? */
export function linkFilterUsable(profile) {
  return recipeUsable(profile && profile.link_filter, profile && profile.linkFilterMeta, hasLinkFilter);
}
/** True when the link filter has not been verified within its TTL. */
export function linkFilterStale(profile, now = Date.now()) {
  return recipeStale(profile && profile.linkFilterMeta, LINK_FILTER_TTL_MS, now);
}
/** Record the outcome of a link-filtered collection (same lifecycle as manual_selectors). */
export function recordLinkFilterOutcome(profile, ok, now = new Date().toISOString()) {
  if (!profile || !hasLinkFilter(profile.link_filter)) return profile;
  const p = { ...profile };
  p.linkFilterMeta = bumpMeta(p.linkFilterMeta, ok, LINK_FILTER_MAX_FAILS, now);
  p.updatedAt = now;
  return p;
}

/** A tiny file-backed store. `readJson`/`writeJson` are injected (Node fs in the
 *  app, in-memory in tests) so this module stays pure + testable. */
export function createProfileStore({ read, write: rawWrite, snapshot } = {}) {
  let cache = null;
  // A read that could not see the file (`{ __readOnly: true, data }`) must never
  // lead to a write: the run would replace every stored recipe with its own view.
  let readOnly = false;
  const write = (m) => { if (!readOnly && rawWrite) rawWrite(m); };
  const load = () => {
    if (cache) return cache;
    let got;
    try { got = (read && read()) || {}; } catch { got = { __readOnly: true, data: {} }; }
    if (got && got.__readOnly) { readOnly = true; cache = (got.data && typeof got.data === 'object') ? got.data : {}; }
    else cache = got;
    // One-time repair of keys saved under a whole address (old hostKey), written
    // back at once so the file on disk is fixed by the app itself.
    const { map, changed } = migrateProfileKeys(cache);
    if (changed) { cache = map; try { write(cache); } catch { /* best-effort */ } }
    // Site knowledge written by an older app: migrated once. The file as it was is copied aside first
    // (one copy per schema version, never overwritten), then the migrated map is written.
    const mk = migrateKnowledgeAll(cache);
    if (mk.changed) {
      cache = mk.map;
      if (!readOnly) { try { if (snapshot) snapshot(`domain-profiles.before-knowledge-v${KNOWLEDGE_VERSION}.json`); } catch { /* the regular previous copy still exists */ } }
      try { write(cache); } catch { /* best-effort */ }
    }
    return cache;
  };
  return {
    get(url) { const m = load(); return m[hostKey(url)] || null; },
    hints(url) { return profileHints(this.get(url)); },
    record(url, obs, now) {
      const m = load();
      const k = hostKey(url);
      m[k] = mergeProfile(m[k], obs, now);
      try { write && write(m); } catch { /* best-effort; a failed write never breaks a run */ }
      return m[k];
    },
    all() { return { ...load() }; },
    /** Replace every profile at once (a recipes import): the file as it was is copied aside first. */
    replaceAll(map, snapshotName) {
      load();
      if (readOnly) return false;
      if (snapshotName && snapshot) { try { snapshot(snapshotName); } catch { /* the regular previous copy still exists */ } }
      cache = map && typeof map === 'object' ? map : {};
      try { write(cache); } catch { return false; }
      return true;
    },
  };
}

/**
 * How a site's PRODUCT pages can be read, remembered per site (domain profile `detailAccess`):
 *
 *   'http'      plain HTTP answers with the page                 → the app reads them itself, fast
 *   'browser'   HTTP is refused, the app's local browser reads    → straight to the local browser
 *   'extension' both are refused; only the user's own browser     → the extension opens them
 *               (through the extension) reads them
 *
 * Learned from what a run actually saw (never guessed), reused on the next run instead of
 * retrying a refused way every time, and forgotten after DETAIL_ACCESS_TTL_MS so a site that
 * stopped blocking is noticed again. Pure: the caller notes each attempt, then records the verdict.
 */
export const DETAIL_ACCESS = Object.freeze(['http', 'browser', 'extension']);
export const DETAIL_ACCESS_TTL_MS = 7 * 24 * 3600 * 1000;
export const LIST_ACCESS = Object.freeze(['app', 'extension']);

/** Who reads a site's lists lately (app | extension), null when unknown or older than the TTL (then the app tries again). */
export function listAccessOf(profile, now = Date.now()) {
  const m = profile && profile.listAccess;
  if (!LIST_ACCESS.includes(m)) return null;
  const at = Date.parse((profile && profile.listAccessAt) || '');
  return Number.isFinite(at) && now - at <= DETAIL_ACCESS_TTL_MS ? m : null;
}

/** The stored way to read a site's product pages, or null (none yet, or too old to trust). */
export function detailAccessOf(profile, now = Date.now()) {
  const m = profile && profile.detailAccess;
  if (!DETAIL_ACCESS.includes(m)) return null;
  const at = Date.parse((profile && profile.detailAccessAt) || '');
  if (!Number.isFinite(at) || now - at > DETAIL_ACCESS_TTL_MS) return null;
  return m;
}

/** Counts each way tried on a run's product pages and turns them into the way to remember. */
export function createAccessTracker() {
  const counts = { http: { ok: 0, refused: 0 }, browser: { ok: 0, refused: 0 }, extension: { ok: 0, refused: 0 } };
  return {
    counts,
    note(way, ok) { const c = counts[way]; if (c) { if (ok) c.ok++; else c.refused++; } },
    /**
     * The cheapest way that worked. 'extension' is only learned when the app's own ways were refused
     * on this run: pages the user's browser brought while HTTP was never tried prove nothing about HTTP.
     */
    verdict() {
      if (counts.http.ok) return 'http';
      if (counts.browser.ok) return 'browser';
      if (counts.extension.ok && (counts.http.refused || counts.browser.refused)) return 'extension';
      return null;
    },
  };
}
