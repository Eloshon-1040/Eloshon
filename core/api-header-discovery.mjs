/**
 * API request headers read from a site's PUBLIC JavaScript — generic, free, bounded.
 *
 * When a listing's internal API refuses the plain request (400 / 401 / 403, "a
 * header must be present"), the header the page's own code sends is often a
 * constant inside one of the scripts every visitor downloads. This module lists the
 * page's <script src> files, reads a bounded number of them over the run's own HTTP
 * fetcher (polite rate, byte cap per file), and looks — by SHAPE, never by a site
 * name — for a header-like name written next to the API's host or path, with a
 * string-literal value.
 *
 * Only a value that is the same for every visitor is taken: a literal in a static
 * script file. A value that looks like a personal or session token (JWT, long opaque
 * blob, hex digest, "Bearer …"), a template, or a name seen with several different
 * values is refused and reported — never sent.
 *
 * The result is one spec { from, pattern, flags } per header: exactly what
 * shared/internal-api.mjs resolveHeaders() re-reads at the next run. The recipe
 * stores WHERE to read the value, never the value itself.
 *
 * PURE + injectable: `fetchText(url) → { ok, text, status, tooLarge }` is the only
 * I/O. Limits (DISCOVERY_DEFAULTS): scripts read per page, bytes per file (the
 * fetcher stops reading past the cap), same-site scripts or scripts on a host the
 * page itself declares (<link rel="preconnect|dns-prefetch">).
 */

export const DISCOVERY_DEFAULTS = Object.freeze({ maxFiles: 10, maxBytesPerFile: 2 * 1024 * 1024, window: 6000, maxHeaders: 4 });

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
// Identity, transport and standard negotiation headers: never "the missing header".
const RESERVED = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'host', 'content-length', 'content-type', 'content-encoding', 'accept', 'accept-encoding', 'accept-language', 'accept-charset', 'user-agent', 'referer', 'origin', 'connection', 'keep-alive', 'cache-control', 'pragma', 'if-none-match', 'if-modified-since', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'transfer-encoding', 'upgrade-insecure-requests', 'retry-after', 'www-authenticate']);
// sec-* / proxy-* are transport; aria-* / data-* are DOM attributes (object keys in
// front-end bundles that look like headers but never are).
const RESERVED_PREFIX = /^(sec-|proxy-|access-control-|cf-|aria-|data-)/;
// A header written in an object literal belongs to a request's headers object: the
// keyword sits a few hundred characters before it ("headers:{…}", "new Headers({…})").
const HEADERS_CTX_RE = /headers\s*[:=(]|new\s+Headers\s*\(|["']headers["']\s*:/i;
const HEADERS_CTX_WINDOW = 400;
const VENDOR_FILE_RE = /(polyfill|framework|vendor|runtime|webpack|react|jquery|lodash|gtm|analytics|tag-?manager|pixel|consent|cookie)/i;
const HINT_STOP = new Set(['header', 'headers', 'not', 'present', 'missing', 'required', 'invalid', 'error', 'request', 'must', 'be', 'the', 'is', 'was']);

const lc = (s) => String(s == null ? '' : s).toLowerCase();
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const siteOf = (h) => String(h || '').toLowerCase().replace(/^www\./, '').split('.').slice(-2).join('.');
function sameSite(a, b) { try { return siteOf(new URL(a).hostname) === siteOf(new URL(b).hostname); } catch { return false; } }

/** A hyphenated custom-header name (never an identity / transport / standard header). */
export function isHeaderName(name) {
  const n = lc(name);
  return n.length <= 64 && NAME_RE.test(n) && !RESERVED.has(n) && !RESERVED_PREFIX.test(n);
}

/**
 * Is this literal a value shared by every visitor (static), or does it look like a
 * token, a credential or a template? Returns { ok, reason? }.
 */
export function valueVerdict(value) {
  const v = String(value == null ? '' : value);
  if (!v.trim()) return { ok: false, reason: 'empty' };
  if (v.length > 200) return { ok: false, reason: 'too_long' };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(v) || /\$\{|\{\{|%[sd]\b/.test(v)) return { ok: false, reason: 'template' };
  if (/^(bearer|basic|token)\s/i.test(v)) return { ok: false, reason: 'credential' };
  if (/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(v)) return { ok: false, reason: 'jwt' };
  if (/^[0-9a-f]{32,}$/i.test(v)) return { ok: false, reason: 'hex_digest' };
  const longestRun = v.split(/[^A-Za-z0-9+/=]/).reduce((m, part) => Math.max(m, part.length), 0);
  if (longestRun >= 40) return { ok: false, reason: 'opaque_token' };
  return { ok: true };
}

/** Origins the page itself declares (<link rel="preconnect"> / "dns-prefetch">), any site. */
export function declaredOrigins(html, pageUrl) {
  const out = [];
  const re = /<link\b[^>]*rel=["'](?:preconnect|dns-prefetch)["'][^>]*>/gi; let m;
  while ((m = re.exec(String(html)))) {
    const href = (m[0].match(/href=["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    try { const o = new URL(href, pageUrl).origin; if (/^https?:/.test(o) && !out.includes(o)) out.push(o); } catch { /* skip */ }
  }
  return out;
}

/** Short, distinctive strings of the API request a script would also contain. */
export function apiAnchors(apiUrl) {
  let u; try { u = new URL(apiUrl); } catch { return []; }
  const anchors = [];
  const add = (s) => { const x = String(s || ''); if (x.length >= 4 && !anchors.includes(x)) anchors.push(x); };
  add(u.pathname);
  add(u.hostname.replace(/^www\./, ''));
  for (const seg of u.pathname.split('/')) {
    if (seg.length < 4 || /^\d+$/.test(seg) || /^[0-9a-f-]{20,}$/i.test(seg)) continue; // ids and uuids identify a request, not a client
    add(seg);
  }
  return anchors.slice(0, 8);
}

/** Words of a refusal's error code ("CALLER_ID_HEADER_NOT_PRESENT" → caller, id) that may name the header. */
export function hintTokens(errorText) {
  return [...new Set(lc(errorText).split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !HINT_STOP.has(t)))];
}

/** Does a hyphenated name carry the hint words as a run ("shop-api-caller-id" ⊇ caller, id)? */
export function nameMatchesHint(name, hints) {
  if (!hints || hints.length < 2) return false;
  const parts = lc(name).split('-');
  for (let i = 0; i + hints.length <= parts.length; i++) {
    if (hints.every((h, j) => parts[i + j] === h)) return true;
  }
  return false;
}

/**
 * The page's <script src> files, resolved, limited to the page's own site or a host
 * the page declares, deduplicated, ordered: scripts whose path names the API or a
 * page chunk first, known framework / vendor / tracking files last.
 */
export function pageScriptUrls(html, pageUrl, { allowedOrigins = [], anchors = [] } = {}) {
  const urls = [];
  const re = /<script\b([^>]*)>/gi; let m;
  while ((m = re.exec(String(html)))) {
    const attrs = m[1];
    const type = (attrs.match(/\btype=["']([^"']+)["']/i) || [])[1];
    if (type && !/javascript|module|ecmascript/i.test(type)) continue; // JSON islands, templates
    const src = (attrs.match(/\bsrc=["']([^"']+)["']/i) || [])[1];
    if (!src) continue;
    let u; try { u = new URL(src.replace(/&amp;/g, '&'), pageUrl); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    u.hash = '';
    const s = u.toString();
    if (urls.includes(s)) continue;
    if (!sameSite(s, pageUrl) && !allowedOrigins.includes(u.origin)) continue;
    urls.push(s);
  }
  const words = anchors.map((a) => lc(a).replace(/^\/+/, '')).filter((a) => a.length >= 4 && !a.includes('/'));
  const score = (s) => {
    const p = lc(s);
    let n = 0;
    if (words.some((w) => p.includes(w)) || /\bapi\b/.test(p)) n += 2;
    if (/(^|[/_-])(page|pages|chunk|app)([/_.-]|$)/.test(p)) n += 1;
    if (VENDOR_FILE_RE.test(p)) n -= 1;
    return n;
  };
  return urls.map((s, i) => ({ s, i, n: score(s) })).sort((a, b) => b.n - a.n || a.i - b.i).map((x) => x.s);
}

/**
 * Header-like literal pairs: inside a headers object within `window` characters of
 * an API anchor, or a `set/append/setRequestHeader("name", "value")` call there —
 * and, when the refusal names the header (`hints`), any pair whose name carries
 * those words, anywhere in the file (`hinted: true`, distance 0).
 *   { headers: { "x-app-id": "web" } }   or   headers.set("x-app-id", "web")
 * @returns {Array<{name:string, value:string, index:number, distance:number, form:'object'|'call', hinted:boolean}>}
 */
export function headerCandidates(text, anchors, { window = DISCOVERY_DEFAULTS.window, hints = [] } = {}) {
  const s = String(text || '');
  const positions = [];
  for (const a of anchors) {
    let from = 0, hits = 0;
    while (hits < 500) { const i = s.indexOf(a, from); if (i < 0) break; positions.push(i); from = i + a.length; hits++; }
  }
  positions.sort((x, y) => x - y);
  const nearest = (i) => { // binary search the closest anchor position
    if (!positions.length) return Infinity;
    let lo = 0, hi = positions.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (positions[mid] < i) lo = mid + 1; else hi = mid; }
    const d1 = Math.abs(positions[lo] - i); const d2 = lo > 0 ? Math.abs(positions[lo - 1] - i) : Infinity;
    return Math.min(d1, d2);
  };
  const inHeadersObject = (i) => HEADERS_CTX_RE.test(s.slice(Math.max(0, i - HEADERS_CTX_WINDOW), i));
  const out = [];
  const take = (m, name, value, form) => {
    if (!isHeaderName(name)) return;
    const hinted = nameMatchesHint(name, hints);
    const distance = nearest(m.index);
    if (!hinted && distance > window) return;
    if (!hinted && form === 'object' && !inHeadersObject(m.index)) return; // an object key outside a headers object is a prop, not a header
    out.push({ name: lc(name), value, index: m.index, distance: hinted ? 0 : distance, form, hinted });
  };
  const objRe = /(["'])([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)\1\s*:\s*(["'])([^"'\\\r\n]{1,200})\3/g; let m;
  while ((m = objRe.exec(s))) take(m, m[2], m[4], 'object');
  const callRe = /\.(?:setRequestHeader|set|append)\(\s*(["'])([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)\1\s*,\s*(["'])([^"'\\\r\n]{1,200})\3\s*\)/g;
  while ((m = callRe.exec(s))) take(m, m[2], m[4], 'call');
  return out;
}

/** The regex (as a string) that re-reads this header's value from the same file; group 1 = the value. */
export function patternFor(cand) {
  const name = esc(cand.name);
  return cand.form === 'call'
    ? `\\.(?:setRequestHeader|set|append)\\(\\s*["']${name}["']\\s*,\\s*["']([^"']+)["']`
    : `["']${name}["']\\s*:\\s*["']([^"']+)["']`;
}

/**
 * Find the API headers in the page's public scripts.
 * @param {{ html:string, pageUrl:string, apiUrl:string, fetchText:Function, errorText?:string,
 *   maxFiles?:number, maxBytesPerFile?:number, window?:number, maxHeaders?:number }} o
 * @returns {Promise<{ found:boolean, headers:Object<string,string>, specs:Object<string,{from:string,pattern:string,flags:string}>,
 *   filesListed:number, filesRead:number, filesSkipped:Array<{url:string,reason:string}>, filesBeyondCap:number,
 *   candidates:number, rejected:Array<{name:string,reason:string}> }>}  (names only: a value never leaves `headers`)
 */
export async function discoverApiHeaders({ html, pageUrl, apiUrl, fetchText, errorText = '', maxFiles = DISCOVERY_DEFAULTS.maxFiles, maxBytesPerFile = DISCOVERY_DEFAULTS.maxBytesPerFile, window = DISCOVERY_DEFAULTS.window, maxHeaders = DISCOVERY_DEFAULTS.maxHeaders } = {}) {
  const out = { found: false, headers: {}, specs: {}, filesListed: 0, filesRead: 0, filesSkipped: [], filesBeyondCap: 0, candidates: 0, rejected: [] };
  if (typeof fetchText !== 'function' || !html || !pageUrl || !apiUrl) return out;
  const anchors = apiAnchors(apiUrl);
  if (!anchors.length) return out;
  const urls = pageScriptUrls(html, pageUrl, { allowedOrigins: declaredOrigins(html, pageUrl), anchors });
  out.filesListed = urls.length;
  const cap = Math.max(1, Number(maxFiles) || DISCOVERY_DEFAULTS.maxFiles);
  out.filesBeyondCap = Math.max(0, urls.length - cap);
  // The refusal often names the header ("NIKE_API_CALLER_ID_HEADER_NOT_PRESENT" →
  // nike, api, caller, id): then only a name carrying those words is a candidate,
  // wherever it sits in the file; with no such hint, the headers written next to
  // the API path are taken.
  const hints = hintTokens(errorText);
  const byName = new Map(); // name → { values:Set, hits:[{cand, url, text}] }
  for (const url of urls.slice(0, cap)) {
    let r = null;
    try { r = await fetchText(url, { maxBytes: maxBytesPerFile }); } catch { r = null; }
    if (!r || !r.ok || typeof r.text !== 'string' || !r.text) { out.filesSkipped.push({ url, reason: r && r.tooLarge ? 'too_large' : `http_${(r && r.status) || 0}` }); continue; }
    if (Buffer.byteLength(r.text) > maxBytesPerFile) { out.filesSkipped.push({ url, reason: 'too_large' }); continue; } // a fetcher without its own cap
    out.filesRead += 1;
    for (const cand of headerCandidates(r.text, anchors, { window, hints })) {
      out.candidates += 1;
      const e = byName.get(cand.name) || { values: new Set(), hits: [] };
      e.values.add(cand.value); e.hits.push({ cand, url, text: r.text });
      byName.set(cand.name, e);
    }
  }
  const names = [...byName.keys()];
  const hinted = names.filter((n) => nameMatchesHint(n, hints));
  if (hints.length >= 2 && !hinted.length) {
    // The site named the header and no script holds it as a literal: sending other
    // headers would be a guess. Say what was looked for.
    out.rejected.push({ name: hints.join('-'), reason: names.length ? 'not_found_named' : 'not_found' });
    return out;
  }
  const chosen = (hinted.length ? hinted : names);
  const accepted = [];
  for (const name of chosen) {
    const e = byName.get(name);
    if (e.values.size > 1) { out.rejected.push({ name, reason: 'ambiguous' }); continue; }
    const best = e.hits.slice().sort((a, b) => a.cand.distance - b.cand.distance)[0];
    const verdict = valueVerdict(best.cand.value);
    if (!verdict.ok) { out.rejected.push({ name, reason: verdict.reason }); continue; }
    // The stored spec must re-read exactly this value from this file (round trip).
    const pattern = patternFor(best.cand);
    let same = false;
    try { const m = best.text.match(new RegExp(pattern, 'i')); same = !!(m && m[1] === best.cand.value); } catch { same = false; }
    if (!same) { out.rejected.push({ name, reason: 'pattern_mismatch' }); continue; }
    accepted.push({ name, value: best.cand.value, from: best.url, pattern, distance: best.cand.distance });
  }
  for (const a of accepted.sort((x, y) => x.distance - y.distance).slice(0, Math.max(1, maxHeaders))) {
    out.headers[a.name] = a.value;
    out.specs[a.name] = { from: a.from, pattern: a.pattern, flags: 'i' };
  }
  out.found = Object.keys(out.headers).length > 0;
  return out;
}

/** The report-safe view of a discovery result: names and counts, never a value. */
export function discoverySummary(d) {
  if (!d) return null;
  return {
    found: !!d.found, names: Object.keys(d.headers || {}), filesListed: d.filesListed || 0, filesRead: d.filesRead || 0,
    filesBeyondCap: d.filesBeyondCap || 0, filesSkipped: (d.filesSkipped || []).map((x) => x.reason), rejected: (d.rejected || []).map((x) => `${x.name}:${x.reason}`),
  };
}
