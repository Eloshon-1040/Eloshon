/**
 * Cost settings + "estimé" cost of one ledger event. ONE table: the defaults are
 * the values that already existed in the provider registry (today only the
 * Scraping Browser's 8 $/GB), overridable in config.json `costs`. A provider with
 * no configured unit price gets costUsd = null ("inconnu") — never an invented
 * number. All results are ESTIMATES; the provider invoice is the reference.
 *
 * config.json:
 *   "costs": {
 *     "scrapingbrowser": { "usdPerGb": 8 },
 *     "webunlocker":     { "usdPerRequest": null },
 *     "firecrawl":       { "usdPerCredit": null, "usdPerRequest": null },
 *     "zyte":            { "usdPerRequest": null },
 *     "anthropic":       { "usdPerMTokIn": null, "usdPerMTokOut": null }
 *   }
 */
import { getProvider } from '../providers/registry.mjs';

export const COST_FIELDS = Object.freeze({
  scrapingbrowser: ['usdPerGb'],
  webunlocker: ['usdPerRequest'],
  firecrawl: ['usdPerCredit', 'usdPerRequest'],
  zyte: ['usdPerRequest'],
  anthropic: ['usdPerMTokIn', 'usdPerMTokOut'],
});

const GIB = 1024 ** 3; // same divisor as ProviderRuntime.recordCall

/** Defaults = the values already present in the code (registry), unchanged. */
export function defaultCosts() {
  const sb = getProvider('brightData.scrapingBrowser');
  return {
    scrapingbrowser: { usdPerGb: (sb && sb.costModel && Number.isFinite(sb.costModel.usdPerGb)) ? sb.costModel.usdPerGb : null },
    webunlocker: { usdPerRequest: null },
    firecrawl: { usdPerCredit: null, usdPerRequest: null },
    zyte: { usdPerRequest: null },
    anthropic: { usdPerMTokIn: null, usdPerMTokOut: null },
  };
}

const price = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Number(v));

/** Defaults overlaid with config.json `costs` (a missing key keeps the default). */
export function effectiveCosts(config = {}) {
  const base = defaultCosts();
  const over = (config && typeof config.costs === 'object' && config.costs) || {};
  for (const [prov, fields] of Object.entries(COST_FIELDS)) {
    const o = over[prov] || {};
    for (const f of fields) if (Object.prototype.hasOwnProperty.call(o, f)) base[prov][f] = price(o[f]);
  }
  return base;
}

/** Validate a costs patch (unknown keys rejected, values ≥ 0 or null). */
export function validateCostsPatch(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return { ok: false, error: 'invalid' };
  for (const [prov, vals] of Object.entries(patch)) {
    if (!COST_FIELDS[prov] || !vals || typeof vals !== 'object') return { ok: false, error: `unknown:${prov}` };
    out[prov] = {};
    for (const [f, v] of Object.entries(vals)) {
      if (!COST_FIELDS[prov].includes(f)) return { ok: false, error: `unknown:${prov}.${f}` };
      if (v === null || v === '') { out[prov][f] = null; continue; }
      const n = Number(v); if (!Number.isFinite(n) || n < 0) return { ok: false, error: `value:${prov}.${f}` };
      out[prov][f] = n;
    }
  }
  return { ok: true, value: out };
}

/**
 * Estimated USD cost of one event. Only calls that were really sent through the
 * owner's own keys (channel 'direct') or the AI key are priced; server-cascade
 * calls are billed in Eloshon credits (the line carries `credits`).
 * @returns {{costUsd:number|null, costBasis:string|null}}
 */
export function estimateCost(evt = {}, costs = defaultCosts()) {
  if (!evt.attempted) return { costUsd: null, costBasis: null };
  const p = evt.provider;
  if (p === 'local' || p === 'extension') return { costUsd: 0, costBasis: 'gratuit' };
  if (evt.channel === 'server' || p === 'cascade' || p === 'scrapfly') return { costUsd: null, costBasis: 'crédits Eloshon (serveur)' };
  const c = costs[p] || {};
  if (p === 'scrapingbrowser') {
    if (c.usdPerGb == null || !Number.isFinite(Number(evt.bytes))) return { costUsd: null, costBasis: 'prix au Go non renseigné' };
    return { costUsd: (Number(evt.bytes) / GIB) * c.usdPerGb, costBasis: `octets × ${c.usdPerGb} $/Go` };
  }
  if (p === 'firecrawl') {
    // `credits` is set only when the API reported the credits of this call; without
    // it the line is priced from the settings and says it is an estimate.
    const reported = evt.credits !== null && evt.credits !== undefined && evt.credits !== '' && Number.isFinite(Number(evt.credits));
    if (c.usdPerCredit != null && reported) return { costUsd: Number(evt.credits) * c.usdPerCredit, costBasis: `crédits relevés × ${c.usdPerCredit} $` };
    if (c.usdPerRequest != null) return { costUsd: c.usdPerRequest, costBasis: `estimation : ${c.usdPerRequest} $/requête` };
    // Firecrawl's published rate for a scrape with the lane's options (rawHtml +
    // markdown, no LLM format): 1 credit per page — cached or not.
    if (c.usdPerCredit != null) return { costUsd: c.usdPerCredit, costBasis: `estimation : 1 crédit × ${c.usdPerCredit} $` };
    return { costUsd: null, costBasis: 'prix unitaire non renseigné' };
  }
  if (p === 'webunlocker' || p === 'zyte') {
    if (c.usdPerRequest != null) return { costUsd: c.usdPerRequest, costBasis: `${c.usdPerRequest} $/requête` };
    return { costUsd: null, costBasis: 'prix unitaire non renseigné' };
  }
  if (p === 'anthropic') {
    const tin = Number(evt.tokensIn), tout = Number(evt.tokensOut);
    if (c.usdPerMTokIn == null || c.usdPerMTokOut == null || !Number.isFinite(tin) || !Number.isFinite(tout)) return { costUsd: null, costBasis: 'prix des tokens non renseigné' };
    return { costUsd: (tin * c.usdPerMTokIn + tout * c.usdPerMTokOut) / 1e6, costBasis: `tokens × ${c.usdPerMTokIn}/${c.usdPerMTokOut} $ par million` };
  }
  return { costUsd: null, costBasis: null };
}

/**
 * Worst case of ONE launch for the admin test mode, from the existing caps and
 * cost settings. Each direct paid route makes at most one call per launch (the
 * escalation tries a single provider, and at most one Scraping Browser session
 * opens per job), so the upper bound sums one call per allowed route.
 * @param {Array<{provider:string, label:string, allowed:boolean, caps?:object}>} routes
 * @returns {{routes:Array, knownUsd:number, unknown:string[]}}
 */
export function worstCaseForLaunch(routes = [], costs = defaultCosts()) {
  const out = []; let knownUsd = 0; const unknown = [];
  for (const r of routes) {
    if (!r.allowed) continue;
    const c = costs[r.provider] || {};
    let usd = null; let basis = null;
    if (r.provider === 'scrapingbrowser') {
      const maxBytes = r.caps && Number.isFinite(Number(r.caps.maxBytesPerJob)) ? Number(r.caps.maxBytesPerJob) : null;
      if (c.usdPerGb != null && maxBytes != null) { usd = (maxBytes / GIB) * c.usdPerGb; basis = `1 session plafonnée à ${Math.round(maxBytes / (1024 * 1024))} Mo × ${c.usdPerGb} $/Go`; }
      else basis = c.usdPerGb == null ? 'prix au Go non renseigné' : 'plafond Mo/job non renseigné';
    } else if (r.provider === 'firecrawl') {
      if (c.usdPerRequest != null) { usd = c.usdPerRequest; basis = `1 requête × ${c.usdPerRequest} $`; }
      else basis = 'prix unitaire non renseigné';
    } else if (c.usdPerRequest != null) { usd = c.usdPerRequest; basis = `1 requête × ${c.usdPerRequest} $`; }
    else basis = 'prix unitaire non renseigné';
    if (usd == null) unknown.push(r.label || r.provider); else knownUsd += usd;
    out.push({ provider: r.provider, label: r.label || r.provider, maxCalls: 1, usd, basis });
  }
  return { routes: out, knownUsd, unknown };
}
