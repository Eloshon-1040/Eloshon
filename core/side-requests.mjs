/**
 * Stock and reviews that a product page loads with its OWN separate requests
 * (not in the page itself): learned once per job from ONE product page rendered
 * in the local browser, then asked for every product over free HTTP.
 *
 *   learn  — among the JSON answers the page received, keep the one that gives a
 *            stock state for this product's own codes (EAN / size ids) and the one
 *            that gives its rating + review count; turn each request URL into a
 *            template by putting the product's own values (its reference, its URL
 *            path parts) back as placeholders; keep the request headers (filtered:
 *            never a cookie or a credential);
 *   apply  — fill the template with each product's values, fetch (one request per
 *            distinct URL), read the answer by shape (shared/extract/stock.mjs).
 *
 * Generic: no site rule, no URL written in the code; only the page's own requests.
 * Nothing is stored beyond the job.
 */
import { availabilityByCode, signalFor, productAvailability, ratingFromJson } from '../shared/extract/stock.mjs';

/** The product's own values a request URL may carry, named for a template. */
export function rowTokens(row) {
  const out = [];
  const add = (name, v) => { const s = v == null ? '' : String(v).trim(); if (s.length >= 3 && !out.some((t) => t.value === s)) out.push({ name, value: s }); };
  // URL path parts first: every row of a listing has a URL of the same shape, while
  // a reference field may be missing on some rows.
  let path = [];
  try { path = new URL(row.sourceUrl || row.source_url || row.canonicalUrl).pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { path = []; }
  path.forEach((seg, i) => {
    if (/\d/.test(seg) || seg.length >= 6) add(`seg.${i}`, seg);
    seg.split('-').forEach((p, j) => { if (p.length >= 5 && /\d/.test(p) && /[a-z]/i.test(p)) add(`seg.${i}.${j}`, p); });
  });
  const sku = row && (row.sku || row.source_product_id);
  add('sku', sku);
  String(sku || '').split(/[-_.\s/]+/).forEach((p, i) => { if (/\d/.test(p) || p.length >= 5) add(`sku.${i}`, p); });
  return out;
}

const boundary = (s, i, len) => !/[A-Za-z0-9]/.test(s[i - 1] || '') && !/[A-Za-z0-9]/.test(s[i + len] || '');

/**
 * Turn a request URL into a template with the product's own values as
 * placeholders ({sku}, {sku.0}, {seg.3}, …). Null when the URL carries none of
 * them (then it is not a per-product request) or when the template does not give
 * the URL back for this product.
 */
export function templateFromUrl(url, row) {
  if (!url) return null;
  let tpl = String(url); let used = 0;
  for (const t of rowTokens(row).sort((a, b) => b.value.length - a.value.length)) {
    let i = tpl.indexOf(t.value);
    while (i >= 0) {
      if (boundary(tpl, i, t.value.length)) { tpl = tpl.slice(0, i) + `{${t.name}}` + tpl.slice(i + t.value.length); used++; i = tpl.indexOf(t.value, i + t.name.length + 2); }
      else i = tpl.indexOf(t.value, i + 1);
    }
  }
  if (!used) return null;
  return fillTemplate(tpl, row) === url ? tpl : null;
}

/** The template filled with this product's values; null when one is missing. */
export function fillTemplate(tpl, row) {
  const values = Object.fromEntries(rowTokens(row).map((t) => [t.name, t.value]));
  let missing = false;
  const out = String(tpl).replace(/\{([a-z]+(?:\.\d+){0,2})\}/g, (m, name) => { if (values[name] == null) { missing = true; return m; } return values[name]; });
  return missing ? null : out;
}

/** Codes of a product's sizes (EAN / GTIN first, then the size code). */
export const sizeCodes = (row) => (Array.isArray(row && row.variants) ? row.variants : []).flatMap((v) => [v && v.gtin, v && v.code]).filter(Boolean).map(String);

/**
 * Choose, among the JSON answers captured on ONE product page, the stock request
 * and the reviews request, as templates.
 * @param {Array<{url:string, headers?:object, json:any, bytes?:number}>} captures
 * @param {object} row  the product of that page (codes of its sizes, reference, URL)
 * @returns {{ availability:{template:string, headers:object, matched:number}|null, rating:{template:string, headers:object}|null }}
 */
export function learnSideRequests(captures, row) {
  const codes = [...new Set(sizeCodes(row))];
  let availability = null; let rating = null;
  for (const c of captures || []) {
    if (!c || !c.url || c.json == null) continue;
    if (codes.length) {
      const m = availabilityByCode(c.json);
      const matched = m.size ? codes.filter((k) => signalFor(m, k)).length : 0;
      if (matched >= Math.min(2, codes.length)) {
        const template = templateFromUrl(c.url, row);
        if (template && (!availability || matched > availability.matched || (matched === availability.matched && (c.bytes || 0) < (availability.bytes || 0)))) availability = { template, headers: c.headers || {}, matched, bytes: c.bytes || 0 };
      }
    }
    if (!rating) {
      const r = ratingFromJson(c.json);
      if (r) { const template = templateFromUrl(c.url, row); if (template) rating = { template, headers: c.headers || {} }; }
    }
  }
  if (availability) delete availability.bytes;
  return { availability, rating };
}

/**
 * Ask every product's stock / reviews with the learned requests and complete the
 * rows in place: each size gets `availability` (schema.org term) and, when given,
 * `stock_level`; the row gets `availability` (from its sizes) and `rating` +
 * `reviewCount`.
 * @param {object[]} rows
 * @param {{availability?:object|null, rating?:object|null}} learned
 * @param {{ fetchJson:(url:string, headers:object)=>Promise<{ok:boolean, json?:any, status?:number, blocked?:boolean}>,
 *   isStopped?:()=>boolean, onStep?:Function, maxRequests?:number }} o
 */
export async function applySideRequests(rows, learned, o) {
  const rep = { requests: 0, failed: 0, availabilityRows: 0, ratingRows: 0, stoppedBy: null };
  const isStopped = o.isStopped || (() => false);
  const max = o.maxRequests != null ? o.maxRequests : 5000;
  const cache = new Map();
  let blocked = false; let capped = false;
  const get = async (url, headers) => {
    if (cache.has(url)) return cache.get(url);
    if (blocked) return null;
    if (rep.requests >= max) { capped = true; return null; }
    rep.requests++;
    let r = null; try { r = await o.fetchJson(url, headers || {}); } catch { r = null; }
    const json = r && r.ok && r.json != null ? r.json : null;
    if (!json) { rep.failed++; if (r && r.blocked) blocked = true; }
    cache.set(url, json);
    return json;
  };
  let done = 0;
  for (const row of rows || []) {
    if (isStopped()) { rep.stoppedBy = 'stopped'; break; }
    if (blocked) { rep.stoppedBy = 'blocked'; break; }
    // Stock and reviews usually come from two different hosts (the polite delay is per
    // host): ask both at once.
    const stock = async () => {
      const url = fillTemplate(learned.availability.template, row);
      const json = url ? await get(url, learned.availability.headers) : null;
      if (!json) return;
      const m = availabilityByCode(json);
      let any = false;
      for (const v of Array.isArray(row.variants) ? row.variants : []) {
        const s = signalFor(m, v && v.gtin) || signalFor(m, v && v.code);
        if (s) { v.availability = s.availability; if (s.level) v.stock_level = s.level; any = true; }
      }
      const own = any ? productAvailability(row.variants) : (signalFor(m, row.gtin) || signalFor(m, row.sku) || {}).availability;
      if (own) { row.availability = own; rep.availabilityRows++; }
    };
    const reviews = async () => {
      const url = fillTemplate(learned.rating.template, row);
      const json = url ? await get(url, learned.rating.headers) : null;
      const r = json ? ratingFromJson(json) : null;
      if (r) { row.rating = r.rating; row.reviewCount = r.count; rep.ratingRows++; }
    };
    await Promise.all([learned.availability ? stock() : null, learned.rating ? reviews() : null]);
    done++;
    try { if (o.onStep) o.onStep('sideData', { done, total: rows.length }); } catch { /* never break */ }
  }
  if (capped && !rep.stoppedBy) rep.stoppedBy = 'max_requests'; // a request was refused by the cap
  return rep;
}

/**
 * The whole step for a list of rows: pick a sample product page (one whose sizes
 * carry codes), render it once to see its own requests, learn, then ask for every
 * row. `getSession()` gives a browser session with captureJson (or null).
 * @returns {Promise<object>} report: { learned:{availability,rating}|null, pageRequests, requests, failed, availabilityRows, ratingRows, stoppedBy, reason, error }
 */
export async function completeSideData(rows, { getSession, fetchJson, timeoutMs = 30000, onStep, isStopped = () => false, maxRequests } = {}) {
  const list = (rows || []).filter((r) => r && (r.sourceUrl || r.source_url));
  const sample = list.find((r) => sizeCodes(r).length >= 2) || list[0];
  if (!sample) return { learned: null, reason: 'no_product_page' };
  let s = null; try { s = getSession ? await getSession() : null; } catch { s = null; }
  if (!s || typeof s.captureJson !== 'function') return { learned: null, reason: 'browser_unavailable' };
  try { if (onStep) onStep('sideLearn', {}); } catch { /* never break */ }
  const cap = await s.captureJson(sample.sourceUrl || sample.source_url, { timeoutMs });
  const learned = learnSideRequests(cap.captures, sample);
  const rep = { learned: { availability: !!learned.availability, rating: !!learned.rating }, pageRequests: (cap.captures || []).length, error: cap.error || null };
  if (!learned.availability && !learned.rating) return rep;
  return Object.assign(rep, await applySideRequests(list, learned, { fetchJson, isStopped, onStep, maxRequests: maxRequests != null ? maxRequests : Math.max(50, list.length * 3) }));
}

/** fetchJson over the run's polite Fetcher (JSON accept + the learned headers). */
export function fetcherJson(fetcher) {
  return async (u, headers) => {
    try {
      const r = await fetcher.get(u, { accept: 'application/json, text/plain, */*', headers });
      let json = null; try { json = r && r.body ? JSON.parse(r.body) : null; } catch { json = null; }
      return { ok: !!(r && r.ok && json != null), json, status: r && r.status, blocked: !!(r && r.block && r.block.terminal) };
    } catch { return { ok: false }; }
  };
}
