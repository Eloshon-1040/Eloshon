/**
 * Internal-API replay (2b) — replays a site's LEARNED internal JSON product API
 * over plain HTTP (no browser), with pagination, so a repeat run skips the
 * expensive render entirely. Generic: no per-site code — everything comes from
 * the recipe, which is exactly the Supabase `recipes.internal_api` jsonb value.
 *
 * PURE + injectable: pass `httpGet` (defaults to a global-fetch adapter) so tests
 * stay offline. It NEVER stores or hardcodes credentials — a dynamic header (e.g.
 * an app key baked into the page JS) is declared as {from,pattern} and re-read at
 * run time from the page, so a rotated key is picked up automatically.
 *
 * Recipe shape (== recipes.internal_api jsonb):
 * {
 *   "endpoint_tpl": "https://…/api/search?size={size}&skip={skip}&categoryIds={categoryId}",
 *   "method": "GET",
 *   "static_headers": { "Origin": "https://site", "Referer": "https://site/" },
 *   "headers": { "X-Api-Key": { "from": "https://site/", "pattern": "X-Api-Key:\\s*([0-9a-f-]{36})" } },
 *   "pagination": { "type": "offset|page|cursor", "param": "skip", "size_param": "size",
 *                   "size": 22, "start": 0, "total_json_path": "totalProductsFound",
 *                   "cursor_json_path": "nextCursor" },
 *   "json_path": "products",
 *   "field_map": { "name": "name", "price": "price.basicPrice", "sku": "commercialArticleNumber", "image": "fullImage", "url": "detailUrl" }
 * }
 */

// Pure field-mapping + dot-path/template helpers now live in shared/ (one source
// of truth used by both app and extension). Re-exported so this module's public
// API is unchanged.
import { getPath, fillTemplate, fillFromItem, headerValue, redactValues, mapItem } from './extract/field-map.mjs';
import { fetchWithin, HostPacer, retryAfterMs } from './net/deadline.mjs';
import { safeRegExp, boundedMatch } from './safe-regex.mjs';
export { getPath, fillTemplate, headerValue, redactValues, mapItem };

const RETRY_HTTP = new Set([429, 500, 502, 503, 504]);

/**
 * Default httpGet adapter over fetch, for recipe replays and platform feeds — the
 * same manners as the main Fetcher: one deadline over headers AND body
 * (`timeoutMs`), the run's User-Agent unless the recipe sets one, per-host spacing
 * (`pacer`, shared with the Fetcher so lanes never double the rate, else
 * `minDelayMs`), and a retry of 429 / 5xx (Retry-After honoured up to
 * `maxRetryAfterMs`). `signal` stops it with the job. `as` is 'json' | 'text'.
 * Returns { status, body } (+ `error: 'timeout' | 'aborted' | …` when no answer).
 */
export function defaultHttpGet(fetchImpl = (typeof fetch !== 'undefined' ? fetch : null), {
  timeoutMs = 20000, userAgent = null, retries = 2, minDelayMs = 0, pacer = null, maxRetryAfterMs = 60000,
  signal = null, sleepImpl = null,
} = {}) {
  const pace = pacer || new HostPacer({ minDelayMs });
  const sleep = sleepImpl || ((ms) => new Promise((r) => setTimeout(r, ms)));
  return async (url, { headers = {}, method = 'GET', as = 'json' } = {}) => {
    if (!fetchImpl) throw new Error('no fetch implementation available');
    const h = { ...headers };
    if (userAgent && !Object.keys(h).some((k) => k.toLowerCase() === 'user-agent')) h['User-Agent'] = userAgent;
    let attempt = 0;
    for (;;) {
      if (signal && signal.aborted) return { status: 0, body: null, error: 'aborted' };
      const wait = pace.reserve(url);
      if (wait > 0) await sleep(wait);
      const got = await fetchWithin(fetchImpl, url, { method, headers: h }, { timeoutMs, signal, as });
      // No complete answer (deadline, stop, network): status 0, never a half-read 200.
      if (!got.ok) return { status: 0, body: null, error: got.error };
      if (RETRY_HTTP.has(got.status) && attempt < retries) {
        const asked = got.status === 429 ? retryAfterMs(got.headers && typeof got.headers.get === 'function' ? got.headers.get('retry-after') : null) : null;
        const backoff = asked ?? 1000 * 2 ** attempt;
        if (backoff <= maxRetryAfterMs) { pace.pushBack(url, backoff); attempt += 1; continue; }
      }
      return { status: got.status, body: got.jsonError ? null : got.body };
    }
  };
}

/** Set a header, dropping any case-variant duplicate first: fetch() would JOIN
 *  'X-Key' and 'x-key' into "a, b" and corrupt the value. */
function setHeader(headers, name, value) {
  const want = String(name).toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === want) delete headers[k];
  headers[name] = value;
}

/**
 * Resolve the request headers for a run: static headers as-is, plus each dynamic
 * header re-read from its source page. Returns { headers, error }. A required
 * dynamic header that cannot be resolved yields an error (recipe unusable now).
 *
 * `preset` (v0.5.9): header values already obtained for THIS run (by a browser
 * bootstrap, or by a previous resolution) — memory only, never persisted. A
 * dynamic header present in `preset` (case-insensitive) is used as-is and its
 * source page is NOT fetched; preset names the recipe doesn't declare are added.
 */
export async function resolveHeaders(recipe, httpGet, { preset } = {}) {
  const headers = { ...(recipe.static_headers || {}) };
  const dyn = recipe.headers || {};
  const pre = preset || {};
  for (const [name, spec] of Object.entries(dyn)) {
    const pv = headerValue(pre, name);
    if (pv != null && pv !== '') { setHeader(headers, name, String(pv)); continue; }
    if (typeof spec === 'string') { headers[name] = spec; continue; } // literal (discouraged)
    if (!spec || !spec.from || !spec.pattern) return { headers, error: `header ${name}: bad source spec` };
    let page;
    // Fetch the source page browser-like (reuse static headers, esp. User-Agent) —
    // some sites 405/403 a bare request. Never sends the dynamic headers themselves.
    const srcHeaders = { ...(recipe.static_headers || {}), Accept: 'text/html,application/xhtml+xml' };
    try { page = await httpGet(spec.from, { headers: srcHeaders, as: 'text' }); } catch (e) { return { headers, error: `header ${name}: fetch ${spec.from} failed (${e.message})` }; }
    if (!page || page.status >= 400 || !page.body) return { headers, error: `header ${name}: source ${spec.from} → ${page && page.status}` };
    // Recipe patterns may come from the recipe server: checked, and the text bounded.
    const sr = safeRegExp(spec.pattern, spec.flags || '');
    if (sr.error) return { headers, error: `header ${name}: ${sr.error}` };
    const m = boundedMatch(page.body, sr.re);
    if (!m || !m[1]) return { headers, error: `header ${name}: not found on ${spec.from}` };
    setHeader(headers, name, m[1]);
  }
  for (const [k, v] of Object.entries(pre)) {
    if (v == null || v === '') continue;
    if (headerValue(dyn, k) === undefined) setHeader(headers, k, String(v));
  }
  return { headers, error: null };
}

/**
 * Resolve a recipe's template variables (the SAME idea as dynamic headers: a typed
 * source, reusing httpGet + regex/json-path — no second mechanism). Sources:
 *   - const:      { source:'const', value }                          → literal
 *   - url:        { source:'url',   pattern }                         → regex on the category URL
 *   - page:       { source:'page',  from?, json_path|pattern, needs_browser? }
 *                 resolved from the page over HTTP; when needs_browser the page is
 *                 protected → left PENDING for a one-time browser bootstrap.
 *   - pagination: handled by replayInternalApi, skipped here.
 * Returns { vars, pending, needsBrowser, error }. `pending` lists page-vars that
 * still need the browser bootstrap; those are filled by the caller then passed to
 * replay (so the browser is used ONCE, not per page).
 */
export async function resolveVars(recipe, categoryUrl, { httpGet, siteConfig } = {}) {
  const get = httpGet || defaultHttpGet();
  const spec = recipe?.vars || {};
  const cfg = siteConfig || {};
  const vars = {}; const pending = []; let needsBrowser = false;
  for (const [name, sRaw] of Object.entries(spec)) {
    if (!sRaw || typeof sRaw !== 'object') { vars[name] = sRaw; continue; }
    // A var may list several SOURCES to try in order (first non-empty wins): e.g. a
    // category id read from the URL FACET (?categories=412) when present, else from
    // the page's own category model. A per-source "not found" is not fatal while a
    // later source may still resolve; a missing var is fatal only when none did and
    // the var (or every source) is not optional. One-source vars behave as before.
    const sources = Array.isArray(sRaw.sources) && sRaw.sources.length ? sRaw.sources : [sRaw];
    let done = false; let lastErr = null;
    for (const s of sources) {
      if (!s || typeof s !== 'object') { if (s != null) { vars[name] = s; done = true; break; } continue; }
      const r = await resolveVarSource(name, s, { recipe, categoryUrl, get, cfg });
      if (r.needsBrowser) { needsBrowser = true; pending.push(name); done = true; break; }
      if (r.error) { lastErr = r.error; continue; }
      if (r.skip) { done = true; break; }               // pagination source: replay owns it
      if (r.value != null && String(r.value) !== '') { vars[name] = r.value; done = true; break; }
    }
    if (done) continue;
    if (sRaw.optional || sources.every((s) => s && s.optional)) continue;
    return { vars, pending, needsBrowser, error: lastErr || `var ${name}: unresolved` };
  }
  return { vars, pending, needsBrowser, error: null };
}

/**
 * Resolve ONE var source. Returns { value } | { error } | { needsBrowser } |
 * { skip } (pagination, owned by the replay). Pure per the injected `get`.
 */
async function resolveVarSource(name, s, { recipe, categoryUrl, get, cfg }) {
  if (s.source === 'const') return { value: s.value };
  // config: a USER-CONFIGURABLE business value (a store/place id, a region, a market)
  // read from the per-host `siteContext` bag in config.json — NEVER hardcoded. `key`
  // selects the field; `default` is the fallback. (Colruyt's placeId lives here.)
  if (s.source === 'config') {
    const raw = (cfg && s.key != null && cfg[s.key] != null && String(cfg[s.key]).trim() !== '') ? cfg[s.key] : s.default;
    if (raw == null || String(raw).trim() === '') return { error: `var ${name}: no config value for '${s.key}' and no default` };
    return { value: String(raw) };
  }
  if (s.source === 'pagination') return { skip: true }; // replay owns pagination
  if (s.source === 'url') {
    const sr = safeRegExp(s.pattern, s.flags || '');
    if (sr.error) return { error: `var ${name}: url ${sr.error}` };
    const m = boundedMatch(categoryUrl, sr.re);
    const captured = m && m[1] != null ? m[1] : null;
    // resolve: 'category_to_id' — the API wants an internal id, the URL carries a
    // slug mapped through recipe.category_map; fall back to the nearest mapped
    // ancestor (a deep /…/boissons/lait-… still resolves to 'boissons').
    if (s.resolve === 'category_to_id') {
      const map = recipe?.category_map || {};
      let val = captured != null && map[captured] != null ? String(map[captured]) : null;
      if (val == null) {
        let segs = []; try { segs = new URL(categoryUrl).pathname.split('/').filter(Boolean); } catch { /* keep [] */ }
        const hit = [...segs].reverse().find((x) => map[x] != null);
        if (hit != null) val = String(map[hit]);
      }
      if (val == null) return { error: `var ${name}: no URL segment matches category_map` };
      return { value: val };
    }
    if (captured == null) return { error: `var ${name}: not found in URL` };
    return { value: captured };
  }
  if (s.source === 'page') {
    if (s.needs_browser) return { needsBrowser: true }; // one-time bootstrap fills it
    const from = s.from || categoryUrl;
    const asJson = !!s.json_path;
    let page; try { page = await get(from, { headers: { ...(recipe.static_headers || {}), Accept: asJson ? 'application/json' : 'text/html,application/xhtml+xml' }, as: asJson ? 'json' : 'text' }); }
    catch (e) { return { error: `var ${name}: fetch ${from} failed (${e.message})` }; }
    if (!page || page.status >= 400 || page.body == null) return { error: `var ${name}: source ${from} → ${page && page.status}` };
    let val;
    if (asJson) val = getPath(page.body, s.json_path);
    else { const sr = safeRegExp(s.pattern, s.flags || ''); if (sr.error) return { error: `var ${name}: ${sr.error}` }; const m = boundedMatch(page.body, sr.re); val = m && m[1]; }
    if (val == null || val === '') return { error: `var ${name}: not found on ${from}` };
    return { value: val };
  }
  return { error: `var ${name}: unknown source ${s.source}` };
}

// Query-string parameters that NEVER carry a product filter: pagination, page size,
// sort/view, locale/currency, and tracking. Everything else on a listing URL is a
// FACET the user chose (a sub-category, a brand, a price range…).
const NON_FACET_PARAM = /^(page|p|pg|pagenumber|paged|pageindex|pagenum|pagina|seite|offset|start|from|skip|startindex|begin|size|limit|perpage|per_page|pagesize|page_size|count|rows|take|sort|order|orderby|sort_by|sortby|tri|view|display|mode|layout|affichage|lang|language|locale|hl|gl|currency|cur|country|utm_[a-z]+|gclid|gbraid|wbraid|fbclid|msclkid|mc_cid|mc_eid|ref|ref_|referrer|source|igshid|yclid|dclid|spm|cmpid)$/i;

/**
 * The FACET filters on an entry URL that this recipe would NOT honour — query
 * parameters that select a subset of the listing (a sub-category, a brand…) and
 * that no url-source var of the recipe reads. A recipe that ignores such a facet
 * returns the WHOLE parent listing instead of the filtered subset (water + sodas
 * when the user asked for spirits only), so the caller must not trust it silently.
 * Generic: driven by the recipe's own vars, never a site name.
 * @returns {{key:string, value:string}[]}
 */
export function unconsumedFacets(recipe, categoryUrl) {
  let u; try { u = new URL(categoryUrl); } catch { return []; }
  const params = [...u.searchParams.entries()];
  if (!params.length) return [];
  // Keys a url-source var demonstrably reads (its pattern matches the param).
  const consumed = new Set();
  const urlSources = [];
  for (const s of Object.values(recipe?.vars || {})) {
    if (!s || typeof s !== 'object') continue;
    for (const one of (Array.isArray(s.sources) ? s.sources : [s])) if (one && one.source === 'url' && one.pattern) urlSources.push(one);
  }
  for (const one of urlSources) {
    const sr = safeRegExp(one.pattern, one.flags || ''); if (sr.error) continue; const re = sr.re;
    for (const [k, v] of params) {
      const cand = [`?${k}=${v}`, `&${k}=${v}`, `${k}=${v}`, v];
      if (cand.some((c) => { try { return re.test(c); } catch { return false; } })) consumed.add(k);
    }
  }
  const facets = [];
  for (const [k, v] of params) {
    if (!v || consumed.has(k) || NON_FACET_PARAM.test(k)) continue;
    facets.push({ key: k, value: v });
  }
  return facets;
}

/**
 * Classify what a recipe would COST before running it — so the UI can say
 * "gratuit (site connu)" vs "environ X crédits". A recipe is free when every var
 * resolves without a PAID lane: url/const/http-page vars are free, and a page var
 * that needs a browser is still free if the LOCAL browser can bootstrap it (no
 * credits); it only costs when even the bootstrap needs the paid unlock (the
 * domain profile says so). The catalogue itself is always free (HTTP/API replay).
 * @param {object} recipe
 * @param {{ needsUnlock?: boolean }} [profile]  domain profile (paid-lane history)
 * @param {number} [bootstrapCredits]  estimated credits for one paid bootstrap
 * @param {{ paidBootstrap?: boolean }} [opts]  the host is configured to ALWAYS
 *   capture its headers through the paid remote-browser bootstrap (v0.5.9)
 */
export function estimateRecipeCost(recipe, profile = {}, bootstrapCredits = 0, { paidBootstrap = false } = {}) {
  const spec = recipe?.vars || {};
  const pageVar = Object.values(spec).some((s) => s && s.source === 'page' && s.needs_browser);
  let bootstrap = 'none';
  if (pageVar) bootstrap = profile.needsUnlock ? 'paid-unlock' : 'local-browser';
  if (paidBootstrap) bootstrap = 'paid-unlock';
  const free = bootstrap !== 'paid-unlock';
  const label = bootstrap === 'none' ? 'gratuit (site connu)'
    : bootstrap === 'local-browser' ? 'gratuit (site connu — court démarrage navigateur local)'
    : `environ ${Math.max(1, bootstrapCredits)} crédit(s) au démarrage, puis catalogue gratuit`;
  return { free, bootstrap, catalog: 'free', bootstrapCredits: bootstrap === 'paid-unlock' ? Math.max(1, bootstrapCredits) : 0, label };
}

/**
 * Run the full recipe lane: resolve vars → (ONE-TIME browser bootstrap only if a
 * var is behind a protected page) → replay the API over HTTP for ALL pages reusing
 * the bootstrap cookies + resolved vars. The browser is used at most ONCE (never
 * per page): after the bootstrap the whole catalogue is fetched over cheap HTTP.
 *
 * `browserBootstrap({recipe, categoryUrl, pending})` is injected by the caller
 * (it drives the existing BrowserSession) and returns { vars, cookie, error }:
 * the resolved page-vars and a Cookie header string to reuse for the HTTP replay.
 * Kept out of this module so it stays pure + offline-testable.
 *
 * `headerBootstrap({recipe, categoryUrl, names})` (v0.5.9, optional) is the LAST-
 * RESORT source of the recipe's DYNAMIC headers (e.g. an app key the page injects
 * at run time): a remote browser opens the page, observes the app's own API
 * request and returns { headers, cookie?, error? }. With headerBootstrapMode
 * 'fallback' (default) it runs ONLY when the free HTTP resolution of those headers
 * fails; 'always' skips the free attempt. Captured values live in memory for this
 * run only: they reach the catalogue requests, never `vars`, the result or an error.
 *
 * @returns {{ ok, products, pages, total, requests, usedBrowser, vars, error, usedHeaderBootstrap? }}
 */
export async function runRecipeLane(recipe, categoryUrl, { httpGet, browserBootstrap, headerBootstrap, headerBootstrapMode = 'fallback', maxProducts = 1000, maxPages = 100, delayMs = 0, onStep, siteConfig } = {}) {
  const step = (m, e) => { try { if (onStep) onStep(m, e || {}); } catch { /* never break the lane */ } };
  const baseGet = httpGet || defaultHttpGet();
  const rv = await resolveVars(recipe, categoryUrl, { httpGet: baseGet, siteConfig });
  if (rv.error && !rv.needsBrowser) return { ok: false, products: [], pages: 0, total: null, requests: 0, usedBrowser: false, vars: rv.vars, error: rv.error };

  let vars = rv.vars; let cookie = ''; let usedBrowser = false;
  if (rv.needsBrowser) {
    if (!browserBootstrap) return { ok: false, products: [], pages: 0, total: null, requests: 0, usedBrowser: false, vars, error: 'browser bootstrap required but unavailable' };
    usedBrowser = true;
    step('browserStart');
    let b; try { b = await browserBootstrap({ recipe, categoryUrl, pending: rv.pending }); }
    catch (e) { return { ok: false, products: [], pages: 0, total: null, requests: 0, usedBrowser: true, vars, error: `bootstrap failed: ${e.message}` }; }
    if (!b || b.error) return { ok: false, products: [], pages: 0, total: null, requests: 0, usedBrowser: true, vars, error: (b && b.error) || 'bootstrap failed' };
    vars = { ...vars, ...(b.vars || {}) };
    cookie = b.cookie || '';
    for (const name of rv.pending) if (vars[name] == null) return { ok: false, products: [], pages: 0, total: null, requests: 0, usedBrowser: true, vars, error: `var ${name}: unresolved after bootstrap` };
  }
  // Reuse the bootstrap session (cookies) for every catalogue request — HTTP only.
  const withCookie = (c) => (c ? (u, o = {}) => baseGet(u, { ...o, headers: { ...(o.headers || {}), Cookie: c } }) : baseGet);
  let get = withCookie(cookie);

  // Dynamic headers (v0.5.9): the free HTTP resolution first; the header bootstrap
  // (a paid remote browser) only as the last resort, or always when so configured.
  let presetHeaders = null; let usedHeaderBootstrap = false; const secrets = [];
  const dynNames = Object.keys(recipe?.headers || {}).filter((n) => recipe.headers[n] && typeof recipe.headers[n] === 'object');
  // Never pay for headers the replay could not use: no endpoint for this URL → the
  // replay below fails cleanly without any bootstrap.
  const endpointOk = !!(recipe && recipe.endpoint_tpl && selectEndpoint(recipe, vars));
  if (headerBootstrap && dynNames.length && endpointOk) {
    let freeErr = null;
    if (headerBootstrapMode !== 'always') {
      const hr = await resolveHeaders(recipe, get);
      if (!hr.error) {
        presetHeaders = {};
        for (const n of dynNames) { presetHeaders[n] = headerValue(hr.headers, n); secrets.push(presetHeaders[n]); }
      } else freeErr = hr.error;
    }
    if (!presetHeaders) {
      step('browserStart');
      let cap;
      try { cap = await headerBootstrap({ recipe, categoryUrl, names: dynNames }); }
      catch (e) { cap = { error: `header bootstrap failed: ${(e && e.message) || e}` }; }
      // A Stop before the session opened is not a recipe failure (the caller must
      // not count it towards deprecation) and nothing was used.
      if (cap && cap.stopped) return { ok: false, products: [], pages: 0, total: null, requests: 0, usedBrowser, vars, stopped: true, error: redactValues([freeErr, cap.error || 'stopped'].filter(Boolean).join('; '), secrets) };
      usedHeaderBootstrap = true;
      const capHeaders = (cap && cap.headers) || {};
      for (const v of Object.values(capHeaders)) secrets.push(v);
      const capCookie = (cap && cap.cookie) || '';
      for (const part of String(capCookie).split(';')) { const i = part.indexOf('='); if (i > 0) secrets.push(part.slice(i + 1).trim()); }
      const missing = dynNames.filter((n) => { const v = headerValue(capHeaders, n); return v == null || v === ''; });
      if (!cap || cap.error || missing.length) {
        const why = (cap && cap.error) || `header bootstrap: ${missing.join(', ')} not captured`;
        return { ok: false, products: [], pages: 0, total: null, requests: 0, usedBrowser, usedHeaderBootstrap, vars, error: redactValues([freeErr, why].filter(Boolean).join('; '), secrets) };
      }
      presetHeaders = { ...capHeaders };
      if (capCookie) get = withCookie([cookie, capCookie].filter(Boolean).join('; '));
    }
  }
  const res = await replayInternalApi(recipe, { httpGet: get, vars, presetHeaders, maxProducts, maxPages, delayMs, onStep });
  const out = { ...res, usedBrowser, vars };
  if (usedHeaderBootstrap) out.usedHeaderBootstrap = true;
  if (out.error && secrets.length) out.error = redactValues(out.error, secrets);
  return out;
}

/** Fill {path} placeholders from the ITEM itself (dot-paths allowed), URL-encoded.
 *  Returns null when any placeholder is unresolved — never a half-built value. */
/**
 * Choose the endpoint template for a run. When a recipe declares
 * `endpoint_variants` (an ordered list of `{ require, endpoint_tpl }`), pick the
 * first whose required var resolved non-empty — so one recipe can serve several
 * mutually-exclusive URL shapes (Lidl: `campaign` for /a<ID>, `categoryId` for
 * /s<ID>). A variant with no `require` is an unconditional default. When variants
 * exist but none matches, return null (a clean "no matching id" failure rather
 * than firing the base template with an unresolved `{id}` placeholder). Recipes
 * without `endpoint_variants` keep using `endpoint_tpl` unchanged.
 */
export function selectEndpoint(recipe, vars = {}) {
  const variants = Array.isArray(recipe?.endpoint_variants) ? recipe.endpoint_variants : null;
  if (!variants || !variants.length) return recipe?.endpoint_tpl || null;
  for (const v of variants) {
    if (!v || !v.endpoint_tpl) continue;
    if (!v.require || (vars[v.require] != null && String(vars[v.require]) !== '')) return v.endpoint_tpl;
  }
  return null; // variants declared but none applied to this URL
}

/**
 * Replay a recipe with pagination. Returns
 *   { ok, products, pages, total, error, requests }
 * `ok` is true when at least one page returned products. Bounded by maxProducts
 * and maxPages. `vars` supplies template values (e.g. { categoryId: '1684' }).
 */
export async function replayInternalApi(recipe, { httpGet, vars = {}, presetHeaders = null, maxProducts = 1000, maxPages = 100, delayMs = 0, onStep } = {}) {
  if (!recipe || !recipe.endpoint_tpl) return { ok: false, products: [], pages: 0, total: null, error: 'no recipe', requests: 0 };
  const endpointTpl = selectEndpoint(recipe, vars);
  if (!endpointTpl) return { ok: false, products: [], pages: 0, total: null, error: 'no endpoint variant matched the URL (no campaign/category id)', requests: 0 };
  const get = httpGet || defaultHttpGet();
  const pg = recipe.pagination || {};
  const size = Number(pg.size) || 24;
  const method = recipe.method || 'GET';
  const fieldMap = recipe.field_map || {};

  const { headers, error: hErr } = await resolveHeaders(recipe, get, { preset: presetHeaders });
  if (hErr) return { ok: false, products: [], pages: 0, total: null, error: hErr, requests: 0 };

  const products = [];
  let pages = 0, requests = 0, total = null;
  // pagination cursors
  let offset = Number(pg.start) || 0;         // offset / page number
  let cursor = pg.start_cursor || '';         // cursor mode

  while (pages < maxPages && products.length < maxProducts) {
    const pageVars = { ...vars, [pg.size_param || 'size']: size };
    if (pg.type === 'cursor') { if (pg.param) pageVars[pg.param] = cursor; }
    else { pageVars[pg.param || 'skip'] = offset; } // 'offset' and 'page' both live here

    const url = fillTemplate(endpointTpl, pageVars);
    let res;
    try { res = await get(url, { headers, method, as: 'json' }); } catch (e) { return { ok: products.length > 0, products, pages, total, error: `request failed: ${e.message}`, requests }; }
    requests += 1;
    if (!res || res.status >= 400 || res.body == null) return { ok: products.length > 0, products, pages, total, error: `HTTP ${res && res.status}`, requests };

    if (total == null && pg.total_json_path) { const t = getPath(res.body, pg.total_json_path); if (typeof t === 'number') total = t; }
    const list = getPath(res.body, recipe.json_path);
    const items = Array.isArray(list) ? list : [];
    if (items.length === 0) break; // no more products
    for (const it of items) { products.push(mapItem(it, fieldMap)); if (products.length >= maxProducts) break; }
    pages += 1;
    try { if (onStep) onStep(pages === 1 ? 'firstPage' : 'paginate', { page: pages, found: products.length, total }); } catch { /* never break the lane */ }

    // advance
    if (pg.type === 'cursor') {
      const next = getPath(res.body, pg.cursor_json_path);
      if (!next || next === cursor) break;
      cursor = next;
    } else if (pg.type === 'page') {
      offset += 1;
      if (total != null && (offset - (Number(pg.start) || 0)) * size >= total) break;
    } else { // offset
      offset += size;
      if (total != null && offset >= total) break;
    }
    if (items.length < size && pg.type !== 'cursor') break; // short page → last page
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }

  return { ok: products.length > 0, products, pages, total, error: null, requests };
}
