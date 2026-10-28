/**
 * "Your browser" launch rules — the single place that decides whether a
 * user-requested run may go to the extension, and what exactly is sent. PURE (no
 * Electron, no I/O) so every rule is unit-tested.
 *
 * GENERIC BY CONSTRUCTION: the domain comes from the start URL the user typed,
 * the opt-in / limits / pacing come from config.json `yourBrowser`, the recipe
 * comes from the app's normal per-domain recipe store. No site name appears here.
 *
 * NOT an admin feature: nothing here touches provider credentials or the admin
 * session. The renderer is NOT trusted: it may only supply a start URL, a label,
 * a product type and limits — the domain, recipe and pacing are derived here.
 */

import { EMPTY_DIAGNOSIS_TEXT } from '../../shared/classify/empty-diagnosis.mjs';

/** Hard bounds — a run can never be launched unbounded, whatever config or UI say. */
// maxDetailPages: `def: null` = as many product pages as products asked for (maxProducts, capped at `max`), so
// a run of 10 products never ends "5 completed, 5 failed" because of a default the user did not choose.
// A number set in config.json (yourBrowser.limits / perDomain) or in the form still wins.
export const LIMIT_BOUNDS = Object.freeze({
  maxProducts: Object.freeze({ min: 1, max: 5000, def: 500 }),
  maxListPages: Object.freeze({ min: 1, max: 50, def: 3 }),
  maxDetailPages: Object.freeze({ min: 0, max: 500, def: null }),
});

/**
 * Challenge wait timeouts for the tier, from config.yourBrowser.challenge, clamped.
 * A shorter default than the shared 5-min baseline so a stuck "action requise"
 * (nothing to solve) auto-resolves to "bloqué" in ~2 min instead of 5, with a
 * clear message. `solveMs` 20 s–10 min, `pollMs` 1 s–15 s.
 */
export function resolveChallengeTimeouts(config) {
  const c = (config && config.yourBrowser && config.yourBrowser.challenge) || {};
  const clampMs = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, Math.round(n))) : def; };
  return {
    solveMs: clampMs(c.solveMs, 20_000, 600_000, 120_000),
    pollMs: clampMs(c.pollMs, 1_000, 15_000, 3_000),
  };
}

/** Pacing keys the extension's DomainPacer understands, with safety floors. */
const PACING_KEYS = ['baseIntervalMs', 'burst', 'jitterRatio', 'minIntervalMs', 'maxIntervalMs', 'backoffFactor', 'decayFactor', 'successesToDecay', 'latencyHighMs', 'latencySlowFactor', 'resumeFactor'];
const PACING_FLOORS = Object.freeze({ baseIntervalMs: 800, minIntervalMs: 400, backoffFactor: 1.5, maxIntervalMs: 5000 });
const PACING_CEILS = Object.freeze({ burst: 3, jitterRatio: 1, decayFactor: 0.99 });

/** User-facing messages (French; the renderer localises by `code` when it can). */
export const MESSAGES = Object.freeze({
  invalid_request: 'Demande invalide.',
  invalid_url: 'Saisissez l’adresse complète de la page de départ (https://…).',
  domain_not_activated: 'Autorisez ce site dans l’extension (bouton « Activer ce domaine »), puis réessayez — aucun redémarrage nécessaire.',
  domain_not_enabled: 'Ce mode n’est pas encore configuré pour ce site.',
  restart_required: 'Ce mode vient d’être configuré pour ce site : redémarrez l’application pour l’activer.',
  extension_not_connected: 'Installez et connectez l’extension Eloshon Scraper dans votre navigateur pour utiliser ce mode.',
  busy: 'Un scraping via votre navigateur est déjà en cours. Attendez sa fin ou abandonnez-le.',
  unknown_job: 'Ce scraping n’est plus en cours.',
});

/** Non-technical outcome texts (the raw extension reason stays in report.json). */
const OUTCOME_TEXT = Object.freeze({
  permission_required: 'Autorisez ce site dans l’extension (bouton « Activer ce domaine »), puis relancez.',
  recipe_schema_too_new: 'L’extension doit être mise à jour pour lire ce site.',
  extension_disconnected: 'La connexion avec l’extension a été perdue pendant le scraping.',
  stopped: 'Scraping abandonné à votre demande.',
  blocked: 'Le site a bloqué l’accès depuis votre navigateur.',
  error: 'Le scraping via votre navigateur a échoué.',
  no_products: 'Aucun produit trouvé sur cette page.',
});

export const fail = (code) => ({ ok: false, code, message: MESSAGES[code] || MESSAGES.invalid_request });

/** http(s) URL → lowercase host without a leading www., else null. */
export function hostOf(url) {
  if (typeof url !== 'string' || url.length > 2048) return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const h = u.hostname.toLowerCase().replace(/^www\./, '');
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) ? h : null;
  } catch { return null; }
}

const normKey = (k) => String(k || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

/**
 * The config.json `yourBrowser.perDomain` key that opts this host in, or null.
 * Exact host or a parent domain (shop.x.be matches x.be); the longest match wins.
 * Only `enabled === true` counts.
 */
export function matchEnabledDomain(config, host) {
  if (!host) return null;
  const per = (config && config.yourBrowser && config.yourBrowser.perDomain) || {};
  let best = null;
  for (const [raw, v] of Object.entries(per)) {
    if (!v || v.enabled !== true) continue;
    const k = normKey(raw);
    if (!k) continue;
    if ((host === k || host.endsWith('.' + k)) && (!best || k.length > best.key.length)) best = { key: k, raw };
  }
  return best;
}

/**
 * The domain the EXTENSION has granted host permission for that covers this host,
 * or null. This live list (sent by the extension over the bridge) is the single
 * source of truth for "may this site use the tier" — no config.json, no restart.
 * Exact host or a parent domain; the longest match wins.
 */
export function matchPermittedDomain(list, host) {
  if (!host || !Array.isArray(list)) return null;
  let best = null;
  for (const raw of list) {
    const k = normKey(raw);
    if (!k) continue;
    if ((host === k || host.endsWith('.' + k)) && (!best || k.length > best.length)) best = k;
  }
  return best;
}

const clampInt = (v, { min, max }, fallback) => {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/** Default limits for a domain: code defaults ← yourBrowser.limits ← perDomain.limits (all clamped). */
export function defaultLimits(config, rawKey) {
  const yb = (config && config.yourBrowser) || {};
  const g = yb.limits || {};
  const d = (rawKey && yb.perDomain && yb.perDomain[rawKey] && yb.perDomain[rawKey].limits) || {};
  const out = {};
  for (const [k, b] of Object.entries(LIMIT_BOUNDS)) out[k] = clampInt(d[k], b, clampInt(g[k], b, b.def));
  return followProducts(out);
}
// A product-page limit left unset follows the product limit (every listed product gets its page).
const followProducts = (out) => {
  if (out.maxDetailPages == null) out.maxDetailPages = Math.min(LIMIT_BOUNDS.maxDetailPages.max, out.maxProducts);
  return out;
};

/** Requested limits clamped to the hard bounds; a missing field takes the domain default. */
export function resolveLimits(config, rawKey, requested = {}) {
  const defs = defaultLimits(config, rawKey);
  const req = (requested && typeof requested === 'object') ? requested : {};
  const out = {};
  for (const [k, b] of Object.entries(LIMIT_BOUNDS)) out[k] = clampInt(req[k], b, defs[k]);
  // Products asked for in the form beyond the domain default: their pages follow, unless the pages limit was set explicitly.
  if (req.maxDetailPages == null || req.maxDetailPages === '' || !Number.isFinite(Number(req.maxDetailPages))) {
    const yb = (config && config.yourBrowser) || {};
    const explicit = (yb.limits && yb.limits.maxDetailPages != null) || (rawKey && yb.perDomain && yb.perDomain[rawKey] && yb.perDomain[rawKey].limits && yb.perDomain[rawKey].limits.maxDetailPages != null);
    if (!explicit) out.maxDetailPages = Math.min(LIMIT_BOUNDS.maxDetailPages.max, out.maxProducts);
  }
  return out;
}

/** Domain pacing: yourBrowser.pacing ← perDomain.pacing, known numeric keys only, floored. */
export function resolvePacing(config, rawKey) {
  const yb = (config && config.yourBrowser) || {};
  const merged = { ...(yb.pacing || {}), ...((rawKey && yb.perDomain && yb.perDomain[rawKey] && yb.perDomain[rawKey].pacing) || {}) };
  const out = {};
  for (const k of PACING_KEYS) {
    const n = Number(merged[k]);
    if (merged[k] === undefined || merged[k] === null || merged[k] === '' || !Number.isFinite(n) || n < 0) continue;
    let v = n;
    if (PACING_FLOORS[k] != null) v = Math.max(PACING_FLOORS[k], v);
    if (PACING_CEILS[k] != null) v = Math.min(PACING_CEILS[k], v);
    out[k] = v;
  }
  if (out.minIntervalMs != null && out.baseIntervalMs != null && out.minIntervalMs > out.baseIntervalMs) out.minIntervalMs = out.baseIntervalMs;
  return out;
}

/**
 * The recipe to send, from the app's normal per-domain recipe hints
 * ({internalApi, manualSelectors}). internal_api > learned DOM selectors > the
 * extension's generic "auto" extraction. Always carries the user's start URL.
 */
export function toExtensionRecipe(hints = {}, { domain, startUrl } = {}) {
  const h = hints || {};
  if (h.internalApi && typeof h.internalApi === 'object') {
    return { recipe: { ...h.internalApi, domain, start_url: startUrl }, kind: 'internal_api' };
  }
  const ms = h.manualSelectors;
  if (ms && typeof ms === 'object' && ms.card && ms.fields && typeof ms.fields === 'object') {
    const selectors = {};
    for (const [field, f] of Object.entries(ms.fields)) {
      if (f && typeof f.selector === 'string' && f.selector) selectors[field] = f.attr ? `${f.selector}@${f.attr}` : f.selector;
    }
    if (Object.keys(selectors).length) {
      return { recipe: { schema_version: 1, mode: 'dom', domain, start_url: startUrl, item_selector: ms.card, selectors }, kind: 'dom' };
    }
  }
  return { recipe: { schema_version: 1, mode: 'auto', domain, start_url: startUrl }, kind: 'auto' };
}

const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');

/**
 * Availability of the mode for a URL, for the "Nouveau scraping" form.
 * @param {object} config fresh config.json
 * @param {string} url
 * @param {{started:boolean, connected:boolean, browser?:string|null, busy?:boolean}} svc
 */
export function availability(config, url, svc = {}) {
  const host = hostOf(url);
  if (!host) return { ok: false, code: 'invalid_url', message: MESSAGES.invalid_url, domain: null, enabled: false, connected: !!svc.connected };
  // The extension's live grant is the real gate; a config.json perDomain entry
  // still counts (backward compatible) and is the ONLY source of per-domain
  // pacing/limits (via rawKey). Activation itself no longer needs config.
  const cfgMatch = matchEnabledDomain(config, host);
  const permitted = matchPermittedDomain(svc.permittedDomains, host);
  const enabled = !!permitted || !!cfgMatch;
  const domain = permitted || (cfgMatch && cfgMatch.key) || host;
  const rawKey = cfgMatch ? cfgMatch.raw : null;
  const base = { domain, enabled, connected: !!svc.connected, browser: svc.browser || null, busy: !!svc.busy, limits: defaultLimits(config, rawKey), bounds: LIMIT_BOUNDS };
  // Without the extension connected we can neither learn the grant nor run: ask to
  // connect it first. (A config-opted domain lands here too — same next step.)
  if (!svc.connected) return { ...base, ok: false, code: 'extension_not_connected', message: MESSAGES.extension_not_connected };
  // Connected, but this site is not authorized in the extension yet → the user
  // clicks "Activer ce domaine" and this becomes ok live (no restart).
  if (!enabled) return { ...base, ok: false, code: 'domain_not_activated', message: MESSAGES.domain_not_activated };
  if (svc.busy) return { ...base, ok: false, code: 'busy', message: MESSAGES.busy };
  return { ...base, ok: true, code: null, message: null };
}

/**
 * Which product pages the extension opens in the user's browser after the list (the « Fiches produit »
 * limit). The user's browser reads them unless the site is known to answer plain HTTP for its product
 * pages (`detailAccess: 'http'`): the app then reads them itself, faster, with the same taught rules.
 * @returns {{ follow:boolean, max:number }}
 */
export function detailPlan(limits, hints) {
  const max = Math.max(0, Number(limits && limits.maxDetailPages) || 0);
  return { follow: max > 0 && !(hints && hints.detailAccess === 'http'), max };
}

/**
 * Validate a renderer request and build the job spec. Never trusts the renderer
 * for the domain, recipe or pacing. Returns {ok:false, code, message} or
 * {ok:true, spec, domain, rawKey}.
 * @param {unknown} input {startUrl, store?, productType?, limits?}
 * @param {{config:object, svc:object, hints?:object, jobId:string}} ctx
 */
export function buildLaunch(input, { config, svc, hints, jobId }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('invalid_request');
  const startUrl = typeof input.startUrl === 'string' ? input.startUrl.trim() : '';
  const av = availability(config, startUrl, svc);
  if (!av.ok) return fail(av.code);
  // rawKey addresses the config.json perDomain entry for pacing/limits ONLY; a
  // domain authorized purely via the extension grant has none → null (defaults).
  const cfgMatch = matchEnabledDomain(config, hostOf(startUrl));
  const rawKey = cfgMatch ? cfgMatch.raw : null;
  const domain = av.domain;
  const limits = resolveLimits(config, rawKey, input.limits);
  const { recipe, kind } = toExtensionRecipe(hints, { domain, startUrl });
  const recipeSource = (hints && hints.source) || (kind === 'auto' ? 'generic' : null);
  const recipeRevision = recipe && recipe.revision != null ? recipe.revision : null;
  const siteContext = (config && config.siteContext && (config.siteContext[domain] || config.siteContext[rawKey])) || {};
  const store = cleanText(input.store, 80) || null;
  const pt = cleanText(input.productType, 40);
  return {
    ok: true, domain, rawKey,
    spec: {
      job_id: jobId, domain, start_url: startUrl, recipe, recipeKind: kind, recipeSource, recipeRevision, limits,
      detail: detailPlan(limits, hints),
      pacing: resolvePacing(config, rawKey), challenge: resolveChallengeTimeouts(config), config: siteContext,
      // Same product-page rules overrides as the standard engine (config.json `pageRules`).
      page_rules: (config && config.pageRules && typeof config.pageRules === 'object') ? config.pageRules : null,
      store, productType: pt && pt !== 'auto' ? pt : null,
    },
  };
}

/**
 * The lane/extension technical reason → a plain French detail for the user. The
 * raw text (var names, HTTP codes) stays in report.json only.
 */
export function readableDetail(raw) {
  const s = String(raw || '');
  if (!s) return '';
  let m;
  // Zero-product diagnosis code from the extension (empty:<reasonCode>).
  if ((m = s.match(/^empty:(\w+)$/))) return EMPTY_DIAGNOSIS_TEXT[m[1]] || '';
  if ((m = s.match(/var (\w+): (?:not found on|source)/))) return `la recette n’a pas trouvé « ${m[1]} » sur cette page (utilisez une page catégorie du site)`;
  if ((m = s.match(/var (\w+): (?:not found in URL|no URL segment)/))) return `l’adresse ne contient pas « ${m[1]} » attendu par la recette`;
  if (/header [^:]+:|not captured/i.test(s)) return 'la clé d’accès du site n’a pas été trouvée sur la page';
  if (/HTTP \d{3}/.test(s)) return 'le site a refusé la requête de la recette';
  if (/no matching id|endpoint/i.test(s)) return 'aucune variante de la recette ne correspond à cette page';
  return ''; // unrecognised → no invented detail (the raw text is in report.json)
}

/**
 * Map a terminal tier result to the app's job vocabulary + a non-technical text.
 * @param {{status:string, products?:Array, reason?:string}} res
 */
export function outcomeFor(res = {}) {
  const n = (res.products || []).length;
  const raw = String(res.reason || '');
  if (res.status === 'done') {
    if (n) return { status: 'done', blocked: null, stoppedByUser: false, text: '' };
    // Never an 'OK': an empty run gets its own status + why (when known).
    const why = readableDetail(res.laneError || (Array.isArray(res.errors) && res.errors[0]) || raw);
    return { status: 'stopped:no_products', blocked: null, stoppedByUser: false, text: why ? `${OUTCOME_TEXT.no_products} Détail : ${why}.` : OUTCOME_TEXT.no_products };
  }
  if (res.status === 'stopped') return { status: 'interrupted', blocked: null, stoppedByUser: true, text: OUTCOME_TEXT.stopped };
  if (res.status === 'blocked') {
    const code = raw === 'permission_required' ? 'permission_required' : 'blocked';
    return { status: `stopped:${code}`, blocked: { code }, stoppedByUser: false, text: OUTCOME_TEXT[code] };
  }
  const code = OUTCOME_TEXT[raw] ? raw : 'error';
  const why = code === 'error' ? readableDetail(raw) : '';
  return { status: 'error', blocked: null, stoppedByUser: false, text: why ? `${OUTCOME_TEXT[code]} Détail : ${why}.` : OUTCOME_TEXT[code] };
}
