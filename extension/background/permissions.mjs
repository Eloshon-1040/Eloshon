/**
 * Per-domain host permission handling (Chrome Web Store compliance: minimal
 * permissions, host access requested per domain at activation via
 * optional_host_permissions). The origin-pattern derivation is pure and tested;
 * the request/verify calls wrap chrome.permissions.
 */

/**
 * Derive the match pattern(s) to request for a domain. Requests both the apex and
 * its subdomains over http+https. Generic: no per-site logic.
 * @param {string} domain e.g. "colruyt.be"
 * @returns {string[]} match patterns, e.g. ["*://colruyt.be/*", "*://*.colruyt.be/*"]
 */
export function originsForDomain(domain) {
  const d = String(domain || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^\*?\.?/, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
  if (!d || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return [];
  return [`*://${d}/*`, `*://*.${d}/*`];
}

/** True when the domain is already granted (does not prompt). */
export async function hasDomainPermission(chromeApi, domain) {
  const origins = originsForDomain(domain);
  if (!origins.length) return false;
  return new Promise((resolve) => {
    chromeApi.permissions.contains({ origins }, (granted) => resolve(!!granted));
  });
}

/** The domain behind a granted origin pattern ("*://*.colruyt.be/*" → "colruyt.be"),
 *  or null if it is not a plain host pattern. Inverse of originsForDomain. */
export function domainFromOrigin(origin) {
  let s = String(origin || '').trim().toLowerCase();
  s = s.replace(/^[a-z*]+:\/\//, '');   // scheme:// or *://
  s = s.replace(/\/.*$/, '');            // drop the /path
  s = s.replace(/^\*\./, '');            // drop a wildcard subdomain
  s = s.replace(/:\d+$/, '');            // drop a port
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
}

/** Distinct domains covered by a list of granted origin patterns. */
export function domainsFromOrigins(origins) {
  const out = new Set();
  for (const o of (origins || [])) { const d = domainFromOrigin(o); if (d) out.add(d); }
  return [...out];
}

/** The domains the user has granted host permission for, RIGHT NOW (live). This is
 *  the single source of truth the app queries to decide whether the tier is usable
 *  on a site — no config.json flag, no app restart. */
export async function grantedDomains(chromeApi) {
  return new Promise((resolve) => {
    try { chromeApi.permissions.getAll((p) => resolve(domainsFromOrigins((p && p.origins) || []))); }
    catch { resolve([]); }
  });
}

/**
 * Request host permission for a domain. MUST be called from a user gesture
 * (the popup's "Activer ce domaine" button) — Chrome rejects it otherwise.
 * @returns {Promise<boolean>} granted
 */
export async function requestDomainPermission(chromeApi, domain) {
  const origins = originsForDomain(domain);
  if (!origins.length) return false;
  return new Promise((resolve) => {
    chromeApi.permissions.request({ origins }, (granted) => resolve(!!granted));
  });
}
