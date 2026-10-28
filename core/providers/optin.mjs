/**
 * Per-domain OPT-IN for the direct paid routes — the persisted authorisation that
 * lets a site use Firecrawl / Bright Data Web Unlocker / Bright Data Scraping
 * Browser. It lives in config.json (the lists the controller already read):
 *   firecrawl.domains, brightData.domains, brightData.scrapingBrowserDomains.
 *
 * Matching (unchanged from the controller): the job URL's hostname without a
 * leading "www." must be EXACTLY in the list. So "example.com" covers
 * example.com and www.example.com, but NOT shop.example.com (add it separately).
 *
 * Pure: no fs, no Electron. The admin IPC does the atomic write.
 */

export const PAID_ROUTES = Object.freeze([
  Object.freeze({ key: 'firecrawl', provider: 'firecrawl', runtimeId: 'firecrawl', label: 'Firecrawl', block: 'firecrawl', list: 'domains' }),
  Object.freeze({ key: 'webUnlocker', provider: 'webunlocker', runtimeId: 'brightData.webUnlocker', label: 'Web Unlocker', block: 'brightData', list: 'domains' }),
  Object.freeze({ key: 'scrapingBrowser', provider: 'scrapingbrowser', runtimeId: 'brightData.scrapingBrowser', label: 'Scraping Browser', block: 'brightData', list: 'scrapingBrowserDomains' }),
]);
export const routeByKey = (k) => PAID_ROUTES.find((r) => r.key === k) || null;

/** The key the controller matches on: lowercase hostname without a leading "www.". */
export function hostKey(url) {
  if (!url) return '';
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(String(url)) ? String(url) : `https://${url}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * Normalise what the admin typed ("https://www.Shop.com/fr/x?y", "WWW.shop.com",
 * "shop.com") to the stored key, and say exactly which hosts it will match.
 * @returns {{ok:boolean, domain?:string, matches?:string[], notMatched?:string, error?:string}}
 */
export function normalizeDomain(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, error: 'empty' };
  const d = hostKey(raw);
  if (!d || !HOST_RE.test(d)) return { ok: false, error: 'invalid' };
  return { ok: true, domain: d, matches: [d, `www.${d}`], notMatched: `sous-domaines (ex. boutique.${d})` };
}

const listOf = (cfg, r) => {
  const b = cfg && cfg[r.block];
  return b && Array.isArray(b[r.list]) ? b[r.list].map((x) => String(x)) : [];
};

/** Is the route opted in for this host (exact controller semantics)? */
export function isOptedIn(cfg, routeKey, host) {
  const r = routeByKey(routeKey); if (!r || !host) return false;
  return listOf(cfg, r).includes(host);
}

/** { firecrawl, webUnlocker, scrapingBrowser } booleans for one domain. */
export function optInState(cfg, domain) {
  return Object.fromEntries(PAID_ROUTES.map((r) => [r.key, listOf(cfg, r).includes(domain)]));
}

/** Every domain present in at least one opt-in list. */
export function optedInDomains(cfg) {
  const s = new Set(); for (const r of PAID_ROUTES) for (const d of listOf(cfg, r)) s.add(d);
  return [...s].sort();
}

/** Return a NEW config with the route switched on/off for the domain (others untouched). */
export function withOptIn(cfg, domain, routeKey, on) {
  const r = routeByKey(routeKey); if (!r) throw new Error('unknown_route');
  const next = JSON.parse(JSON.stringify(cfg || {}));
  const block = next[r.block] = (next[r.block] && typeof next[r.block] === 'object') ? next[r.block] : {};
  const cur = Array.isArray(block[r.list]) ? block[r.list].map(String) : [];
  const without = cur.filter((x) => x !== domain);
  block[r.list] = on ? [...without, domain] : without;
  return next;
}

/** Schema check before a write: every opt-in list (when present) is an array of valid hosts. */
export function validateOptInConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { ok: false, error: 'config_not_object' };
  for (const r of PAID_ROUTES) {
    const b = cfg[r.block];
    if (b == null) continue;
    if (typeof b !== 'object' || Array.isArray(b)) return { ok: false, error: `${r.block}_not_object` };
    if (b[r.list] == null) continue;
    if (!Array.isArray(b[r.list])) return { ok: false, error: `${r.block}.${r.list}_not_array` };
    for (const d of b[r.list]) if (typeof d !== 'string' || !HOST_RE.test(d)) return { ok: false, error: `${r.block}.${r.list}_invalid:${String(d).slice(0, 60)}` };
  }
  return { ok: true };
}

/**
 * Whether ONE paid route may run for a launch, and why not.
 * @param {{configured:boolean, optedIn:boolean, testMode:boolean, gateReason:string|null}} s
 * @returns {{allowed:boolean, reason:string|null, outcome:string|null}}
 *   outcome = the ledger outcome to record when it is not allowed.
 */
export function routeDecision({ configured, optedIn, testMode, gateReason }) {
  if (!configured) return { allowed: false, reason: 'not_configured', outcome: 'skipped' };
  if (!optedIn && !testMode) return { allowed: false, reason: 'no_optin', outcome: 'blocked_no_optin' };
  if (gateReason === 'cap_reached') return { allowed: false, reason: 'cap_reached', outcome: 'blocked_by_cap' };
  if (gateReason) return { allowed: false, reason: gateReason, outcome: 'skipped' };
  return { allowed: true, reason: testMode && !optedIn ? 'test_mode' : null, outcome: null };
}
