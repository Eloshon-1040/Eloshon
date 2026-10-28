/**
 * Fixed values on TWO levels (Andy, 28/10/2026):
 *   - the SITE profile (one per domain): the brand, and the fields of the panel (names, roles, designations);
 *   - the scrape BATCH (one per list page: « adidas / chaussures-hommes »): collection, product type, tags, status
 *     and the established attributes — so the men's, women's and kids' scrapes of one site never share them.
 * Saved in the app (domain profile `site_values` + `list_batches`), copied in the extension; stamped on every
 * product when it is recorded (shared/export/constants.mjs). Portable (no DOM, no Node).
 */
import { normalizeConstants } from './constants.mjs';

/** The roles kept for the whole site; every other fixed value belongs to the batch (the list page). */
export const SITE_ROLES = new Set(['brand']);
export const levelOf = (c) => (c && SITE_ROLES.has(c.role) ? 'site' : 'batch');
const MAX_BATCHES = 200;
const MAX_FIELDS = 60;
// Query parameters that only page, sort or track a list: the same batch with or without them.
const NOISE = /^(page|p|pg|paged|pn|start|offset|from|skip|sort|sortby|sort_by|order|orderby|dir|view|limit|size|n|per_page|ppp|utm_.*|gclid|fbclid|srsltid|_ga|ref|lang)$/i;

/**
 * The batch a page belongs to: host (without www) + path (no trailing slash, no page segment) + the query
 * parameters that choose the list (a category facet), never the ones that only page or track it.
 * « https://www.adidas.be/fr/chaussures-hommes?start=48 » → « adidas.be/fr/chaussures-hommes ».
 */
export function batchKeyOf(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const path = u.pathname.replace(/\/page\/\d+\/?$/i, '').replace(/\/+$/, '') || '/';
  const keep = [...u.searchParams].filter(([k, v]) => v !== '' && !NOISE.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const q = keep.length ? `?${keep.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
  return `${host}${path}${q}`.slice(0, 300);
}

/** A readable name for a batch: « adidas / chaussures-hommes », « colruyt / boissons (categories=412) ». */
export function batchLabelOf(url) {
  let u; try { u = new URL(url); } catch { return ''; }
  const host = u.hostname.replace(/^www\./, '').split('.');
  const site = host.length > 1 ? host[host.length - 2] : host[0];
  const segs = u.pathname.replace(/\/page\/\d+\/?$/i, '').split('/').filter(Boolean).filter((s) => !/^[a-z]{2}(-[a-z]{2})?$/i.test(s));
  const facets = [...u.searchParams].filter(([k, v]) => v !== '' && !NOISE.test(k)).map(([k, v]) => `${k}=${v}`);
  const last = segs.length ? decodeURIComponent(segs[segs.length - 1]).slice(0, 60) : 'accueil';
  return `${site} / ${last}${facets.length ? ` (${facets.join(', ').slice(0, 60)})` : ''}`;
}

/** Split the panel's list of fixed values: { site, batch } (each validated, empty values dropped). */
export function splitConstants(list) {
  const all = normalizeConstants(list);
  return { site: all.filter((c) => levelOf(c) === 'site'), batch: all.filter((c) => levelOf(c) === 'batch') };
}

/** The values for one product scrape: the site's, then its batch's (normalized, one per column). */
export function joinConstants(site, batch) {
  return normalizeConstants([...(site || []), ...(batch || [])]);
}

/** Two lists of fixed values say the same thing (order and empty rows ignored). */
export function sameConstants(a, b) {
  const k = (l) => JSON.stringify(normalizeConstants(l).map((c) => [c.key, c.value, c.mode]).sort());
  return k(a) === k(b);
}

const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
/** The panel's fields kept with the site (name as typed, role for the Converter, the designation): validated. */
export function sanitizeFields(fields) {
  const out = [];
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f || typeof f.key !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/i.test(f.key)) continue;
    const g = { key: f.key, label: str(f.label, 80) || f.key };
    for (const k of ['role', 'axis', 'attr', 'part']) { const v = str(f[k], 40); if (v) g[k] = v; }
    for (const k of ['selector', 'all']) { const v = str(f[k], 300); if (v) g[k] = v; }
    out.push(g);
    if (out.length >= MAX_FIELDS) break;
  }
  return out;
}

/** The site profile as stored: { constants (site level), fields, card, template, savedAt }. Null when empty. */
export function sanitizeSiteProfile(p, now = new Date().toISOString()) {
  if (!p || typeof p !== 'object') return null;
  const constants = splitConstants(p.constants).site;
  const fields = sanitizeFields(p.fields);
  const card = str(p.card, 300); const template = str(p.template, 30);
  if (!constants.length && !fields.length && !card) return null;
  return { constants, ...(fields.length ? { fields } : {}), ...(card ? { card } : {}), ...(template ? { template } : {}), savedAt: now };
}

/** The sub-collections of a hub page (links of the page's own site only), validated. */
export function sanitizeHub(h, url) {
  if (!h || typeof h !== 'object' || !Array.isArray(h.links)) return null;
  let host = ''; try { host = new URL(url).hostname; } catch { host = ''; }
  const links = [];
  for (const l of h.links) {
    if (!l || typeof l.url !== 'string') continue;
    let u; try { u = new URL(l.url); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || (host && u.hostname !== host)) continue;
    links.push({ name: str(l.name, 80) || u.pathname, url: u.href.slice(0, 500) });
    if (links.length >= 50) break;
  }
  return links.length ? { links, useName: h.useName !== false } : null;
}

/** A batch as stored: { label, url, constants (batch level), hub?, savedAt }. Null when it has neither. */
export function sanitizeBatch(b, url, now = new Date().toISOString()) {
  if (!b || typeof b !== 'object') return null;
  const constants = splitConstants(b.constants).batch;
  const hub = sanitizeHub(b.hub, url);
  if (!constants.length && !hub) return null;
  return { label: str(b.label, 120) || batchLabelOf(url), url: str(url, 500), constants, ...(hub ? { hub } : {}), savedAt: now };
}

/** The batches of a site with one changed (null removes it); the oldest go beyond MAX_BATCHES. */
export function putBatch(batches, key, batch) {
  const out = { ...(batches && typeof batches === 'object' ? batches : {}) };
  if (!key) return out;
  if (batch) out[key] = batch; else delete out[key];
  const keys = Object.keys(out);
  if (keys.length > MAX_BATCHES) keys.sort((a, b) => String(out[a].savedAt).localeCompare(String(out[b].savedAt))).slice(0, keys.length - MAX_BATCHES).forEach((k) => delete out[k]);
  return out;
}

/**
 * Products seen in several batches of a site (a unisex shoe in « hommes » and « femmes »): the site's index of
 * product → batches, with `keys` (this batch's products) added. Returns the new index and, for each product of this
 * batch already in ANOTHER batch, those batches. The oldest products go beyond `max`.
 */
export function indexBatch(index, batchKey, keys, max = 5000) {
  const out = { ...(index && typeof index === 'object' ? index : {}) };
  const elsewhere = new Map();
  for (const k of keys || []) {
    if (typeof k !== 'string' || !k) continue;
    const prev = Array.isArray(out[k]) ? out[k] : [];
    const others = prev.filter((b) => b !== batchKey);
    if (others.length) elsewhere.set(k, others);
    delete out[k]; out[k] = [...new Set([...prev, batchKey])].slice(-6); // re-inserted: the most recent last
  }
  const all = Object.keys(out); if (all.length > max) for (const k of all.slice(0, all.length - max)) delete out[k];
  return { index: out, elsewhere };
}
/** A product's key across batches: its page address (no query, no fragment), else its declared id. */
export function productKeyOf(np) {
  const u = np && np.source_url; if (u) { try { const x = new URL(u); return `u:${x.origin}${x.pathname}`.replace(/\/$/, '').toLowerCase(); } catch { /* id */ } }
  return np && np.source_product_id ? `id:${np.source_product_id}` : null;
}

/**
 * The fixed values the APP gives a job started on `url` (from the app, or run in the user's browser): the site's
 * profile + the batch saved for that page. A job with its own product type (typed in the app) keeps it.
 */
export function storedConstantsFor({ site = null, batches = null } = {}, url, { productType = null } = {}) {
  const key = batchKeyOf(url);
  const batch = key && batches && batches[key] ? batches[key].constants : [];
  const all = joinConstants(site && site.constants, batch);
  return productType ? all.filter((c) => c.role !== 'product_type') : all;
}
