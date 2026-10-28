/**
 * URL normalisation + dedup helpers. Store-agnostic, pure functions.
 *
 * Goal: collapse the many URLs that point to the same product (tracking
 * params, trailing slash, sitemap vs category vs canonical) WITHOUT dropping
 * params that genuinely identify a variant.
 */
import { TRACKING_PARAMS } from './types.mjs';

const TRACKING_SET = new Set(TRACKING_PARAMS);

/** Resolve a possibly-relative href against a base URL. Returns null if invalid. */
export function absoluteUrl(href, base) {
  if (!href) return null;
  try { return new URL(href, base).toString(); } catch { return null; }
}

/**
 * Canonical dedup key for a URL: lowercase host, drop fragment, drop tracking
 * params, sort remaining params, normalise trailing slash. Variant-identifying
 * params (anything not in TRACKING_SET) are KEPT, so ?color=red stays distinct.
 */
export function dedupKey(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return String(rawUrl || '').trim(); }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.protocol = 'https:';
  const kept = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (TRACKING_SET.has(k.toLowerCase())) continue;
    kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  // normalise trailing slash on the path (but keep root "/")
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

/** Strip only obvious tracking params, preserving everything else (for display/storage). */
export function cleanUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return rawUrl; }
  for (const k of [...u.searchParams.keys()]) {
    if (TRACKING_SET.has(k.toLowerCase())) u.searchParams.delete(k);
  }
  u.hash = '';
  return u.toString();
}

export function sameHost(a, b) {
  try {
    return new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, '');
  } catch { return false; }
}

// Second-level domains that are really public suffixes (so `co.uk`, `com.au`… are
// NOT registrable domains on their own). Small, well-known list — enough to keep
// `shop.co.uk` and `blog.co.uk` from being treated as the same site.
const PUBLIC_SLD = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'go', 'or', 'ne', 'gouv']);

/**
 * The registrable domain of a hostname: the last two labels, or the last THREE
 * when the second-to-last is a public SLD (co.uk, com.au, gouv.fr…). So
 * `nl.aliexpress.com` → `aliexpress.com`, `shop.example.co.uk` → `example.co.uk`.
 * Generic, no network, no full public-suffix list.
 * @param {string} hostname
 * @returns {string}
 */
export function registrableHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return h;
  const take = PUBLIC_SLD.has(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-take).join('.');
}

/**
 * Same SITE = same registrable domain, so a product fiche on a locale/region
 * subdomain (`nl.aliexpress.com`, `fr.shop.com`, `m.shop.com`) counts as part of
 * the listing's site. Looser than sameHost (which only strips `www.`) — use it for
 * accepting product URLs, not for deciding what to crawl.
 */
export function sameSite(a, b) {
  try { return registrableHost(new URL(a).hostname) === registrableHost(new URL(b).hostname); }
  catch { return false; }
}

export function originOf(rawUrl) {
  try { return new URL(rawUrl).origin; } catch { return null; }
}
