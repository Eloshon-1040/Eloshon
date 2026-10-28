/**
 * Bright Data Scraping Browser tier (v0.5.7) — the THIRD and most capable generic
 * escalation tier, tried LAST (after web-unlocker and firecrawl). Unlike those
 * single-request fetch APIs, this connects Playwright to a cloud-hosted headful
 * Chrome over CDP (Bright Data "Browser API" / zone type browser_api), so it gets a
 * genuine full-browser render for sites that serve a products-less bot-shell to the
 * fetch tiers (e.g. Adidas, whose __NEXT_DATA__ products only appear for a real
 * browser). The rendered HTML is fed through the SAME core/spa-state.mjs extractor —
 * no per-site logic here.
 *
 * REUSES the project's existing Playwright (same dependency the local browser lane
 * uses); only the connection target changes: chromium.connectOverCDP(cdpUrl) instead
 * of a local launch. Pure + injectable (`connect`) so unit tests mock the CDP
 * connection and never open a real (billed) session.
 *
 * Billing: Bright Data documents the Browser API as traffic-based (per GB); the
 * session RUNTIME is still reported distinctly (report.scrapingBrowser.runtimeSec)
 * alongside bytes, and the session is ALWAYS closed in a finally.
 *
 * Credentials (never hardcoded — config/env, same convention as the other tiers):
 *   config.brightData = { browserAuth?, customerId?, browserZone?, browserPassword?, browserHost?, browserPort? }
 *   env: BROWSER_AUTH | BRD_BROWSER_AUTH  (full "brd-customer-<id>-zone-<zone>:<password>")
 *        or BRD_CUSTOMER_ID + BRD_BROWSER_PASSWORD (+ optional BRD_BROWSER_ZONE)
 *
 * v0.5.9 adds scrapingBrowserBootstrap(): the same remote browser used only as a
 * short BOOTSTRAP for an internal-api recipe (capture the header/cookie values the
 * app's runtime injects into its own API call, then close) — see below.
 */

import { BLOCKED_RESOURCE_TYPES } from '../browser.mjs';
import { AUTH_DENYLIST } from '../cookie-jar.mjs';

export const SUPERPROXY_HOST = 'brd.superproxy.io';
export const SCRAPING_BROWSER_PORT = 9222;
export const DEFAULT_BROWSER_ZONE = 'mcp_browser';

let _pw = null; // cached playwright module, or false if unavailable
async function defaultConnect(cdpUrl, { timeoutMs = 60000 } = {}) {
  if (_pw === null) { try { _pw = await import('playwright'); } catch { _pw = false; } }
  if (!_pw) throw new Error('playwright not installed');
  return _pw.chromium.connectOverCDP(cdpUrl, { timeout: timeoutMs });
}

/**
 * Resolve the Scraping Browser CDP endpoint from config/env. A full `browserAuth`
 * wins; otherwise it is built from customerId + zone + password. Never throws.
 * @returns {{ auth:string|null, cdpUrl:string|null, zone:string, configured:boolean }}
 */
export function scrapingBrowserConfig(config = {}, env = (typeof process !== 'undefined' ? process.env : {}), { country } = {}) {
  const bd = (config && config.brightData) || {};
  const e = env || {};
  const zone = bd.browserZone || e['BRD_BROWSER_ZONE'] || DEFAULT_BROWSER_ZONE;
  let auth = bd.browserAuth || e['BROWSER_AUTH'] || e['BRD_BROWSER_AUTH'] || null;
  const customerId = bd.customerId || e['BRD_CUSTOMER_ID'] || null;
  const password = bd.browserPassword || e['BRD_BROWSER_PASSWORD'] || null;
  if (!auth && customerId && password) auth = `brd-customer-${customerId}-zone-${zone}:${password}`;
  if (auth) auth = String(auth).trim().replace(/^["']|["']$/g, '');
  // Geo-targeting (Bright Data username suffix `-country-xx`): a per-host business
  // choice passed in from config (e.g. a Belgian IP for a Belgian store), never
  // hardcoded here. Ignored when the auth already pins a country.
  const cc = country && /^[a-z]{2}$/i.test(String(country)) ? String(country).toLowerCase() : null;
  if (auth && cc && !/-country-[a-z]{2}(:|$)/i.test(auth)) {
    const i = auth.indexOf(':');
    auth = i > 0 ? `${auth.slice(0, i)}-country-${cc}${auth.slice(i)}` : `${auth}-country-${cc}`;
  }
  const host = bd.browserHost || e['BRD_BROWSER_HOST'] || SUPERPROXY_HOST;
  const port = bd.browserPort || SCRAPING_BROWSER_PORT;
  return { auth: auth || null, cdpUrl: auth ? `wss://${auth}@${host}:${port}` : null, zone, country: cc, configured: !!auth };
}

export function scrapingBrowserAvailable(config, env) { return scrapingBrowserConfig(config, env).configured; }

/** Strip any `user:password@` userinfo from a string — Playwright's connectOverCDP
 *  errors echo the endpoint URL, which embeds the zone password. Never let it reach
 *  report.json, logs or the smoke panel. */
export function redactCredentials(s) {
  return String(s == null ? '' : s).replace(/(wss?|https?):\/\/[^@\s/]+@/gi, '$1://***@').replace(/brd-customer-[A-Za-z0-9_]+-zone-[A-Za-z0-9_-]+(:[^@\s]+)?/g, 'brd-customer-***');
}

/**
 * Render one URL through the remote Scraping Browser. Returns
 *   { ok, html, bytes, bytesSource, runtimeSec, error }.
 * `waitSelector` waits (state: attached) for a real product element before
 * capturing (hydration). Bright Data allows ONE initial navigation per session, so
 * a session serves exactly one listing page.
 *
 * Cost controls (the zone is billed per GB of traffic): heavy sub-resources are
 * aborted (same `image/media/font` set as the local browser lane — product data
 * lives in the HTML/state, not in the pixels), and bytes are measured from CDP
 * `Network.loadingFinished.encodedDataLength` (actual bytes received, pushed
 * events → no extra round-trips), falling back to response content-length sums.
 * The session is ALWAYS closed (finally): an idle remote session lingers up to 5
 * minutes and may keep pulling traffic (polling XHRs) until then.
 *
 * @param {string} url
 * @param {{ cdpUrl:string, waitSelector?:string, timeoutMs?:number, connect?:Function,
 *   blockTypes?:Set<string>|null }} opts
 */
export async function scrapingBrowserRender(url, { cdpUrl, waitSelector, timeoutMs = 120000, connect, blockTypes = BLOCKED_RESOURCE_TYPES, solveCaptcha = true } = {}) {
  const started = Date.now();
  const runtime = () => Math.round(((Date.now() - started) / 1000) * 10) / 10;
  if (!cdpUrl) return { ok: false, html: null, bytes: 0, bytesSource: null, runtimeSec: 0, error: 'scraping browser not configured (no credentials)', note: 'not_configured' };
  if (!url) return { ok: false, html: null, bytes: 0, bytesSource: null, runtimeSec: 0, error: 'no url' };
  const doConnect = connect || defaultConnect;
  let browser = null, clBytes = 0, cdpBytes = 0, cdp = null, captcha = null;
  const bytesNow = () => ({ bytes: Math.max(cdpBytes, clBytes), bytesSource: cdpBytes > 0 ? 'cdp' : (clBytes > 0 ? 'content-length' : null), captcha });
  try {
    browser = await doConnect(cdpUrl, { timeoutMs });
    const ctxs = (typeof browser.contexts === 'function' && browser.contexts()) || [];
    const ctx = ctxs[0] || await browser.newContext();
    // Fallback accounting: response content-length (cheap; no body read).
    try { ctx.on('response', (r) => { try { const cl = r.headers()['content-length']; if (cl) clBytes += parseInt(cl, 10) || 0; } catch { /* skip */ } }); } catch { /* no event support */ }
    const page = await ctx.newPage();
    try { if (typeof page.setDefaultNavigationTimeout === 'function') page.setDefaultNavigationTimeout(timeoutMs); } catch { /* ignore */ }
    // Accurate accounting: CDP encodedDataLength per finished request.
    try {
      if (typeof ctx.newCDPSession === 'function') {
        cdp = await ctx.newCDPSession(page);
        cdp.on('Network.loadingFinished', (e) => { cdpBytes += (e && e.encodedDataLength) || 0; });
        await cdp.send('Network.enable');
      }
    } catch { /* fall back to content-length */ }
    // Abort heavy sub-resources (never the document, scripts or XHR/fetch).
    if (blockTypes && blockTypes.size && typeof page.route === 'function') {
      try {
        await page.route('**/*', (route) => {
          const t = route.request().resourceType();
          if (blockTypes.has(t)) route.abort('aborted').catch(() => {});
          else route.continue().catch(() => {});
        });
      } catch { /* proceed without blocking */ }
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    // Bright Data's documented challenge wait: auto-solve is on by default, but
    // `Captcha.solve` BLOCKS until a detected challenge is solved (or reports none),
    // so we never capture the interstitial instead of the real page. Status is
    // recorded for the report; unavailable outside Bright Data → silently skipped.
    if (solveCaptcha && cdp) {
      try { const s = await cdp.send('Captcha.solve', { detectTimeout: 10000 }); captcha = (s && s.status) || 'unknown'; }
      catch (e) { captcha = `unavailable: ${redactCredentials((e && e.message) || e).slice(0, 100)}`; }
    }
    if (waitSelector) { try { await page.waitForSelector(waitSelector, { state: 'attached', timeout: Math.min(timeoutMs, 45000) }); } catch { /* proceed with whatever rendered */ } }
    const html = await page.content();
    return { ok: !!(html && html.length > 200), html: html || null, ...bytesNow(), runtimeSec: runtime(), error: html ? null : 'empty render' };
  } catch (e) {
    return { ok: false, html: null, ...bytesNow(), runtimeSec: runtime(), error: redactCredentials((e && e.message) || e) };
  } finally {
    // ALWAYS release the remote session.
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  }
}

// ── v0.5.9 — generic BROWSER BOOTSTRAP for internal-api recipes ─────────────────
const sleep = (ms) => { let t; const p = new Promise((r) => { t = setTimeout(r, Math.max(0, ms)); }); return { p, cancel: () => clearTimeout(t) }; };
const lowerKeys = (h) => { const o = {}; for (const k of Object.keys(h || {})) o[k.toLowerCase()] = h[k]; return o; };

/**
 * Open ONE page in the remote Scraping Browser only to observe the app's OWN API
 * request and capture what its runtime injects — header values (e.g. an app key)
 * and, if asked, named cookies — then close the session at once. The capture feeds
 * the internal-api recipe's plain-HTTP replay (core/internal-api.mjs runRecipeLane
 * `headerBootstrap`), so the paid browser serves seconds of bootstrap, never the
 * catalogue. Generic: WHAT to capture comes from per-host config, never from code.
 *
 * Captured VALUES are returned to the caller for this run only (memory) and never
 * appear in `error` / `note` / `captured`, which carry names and origin+path only.
 * An overall deadline (timeoutMs, default 90 s) keeps it under the controller's
 * 120 s stall heartbeat; a late connect is closed, never leaked.
 *
 * @param {string} url  page whose app fires the API call (one navigation per session)
 * @param {{ cdpUrl:string, capture:{ urlPattern:string, flags?:string, headers?:string[], cookies?:string[] },
 *   timeoutMs?:number, captureTimeoutMs?:number, connect?:Function, blockTypes?:Set<string>|null,
 *   solveCaptcha?:boolean }} opts
 * @returns {Promise<{ ok:boolean, headers:object, cookie:string, captured:object|null, bytes:number,
 *   bytesSource:string|null, runtimeSec:number, captcha:string|null, error:string|null, note?:string }>}
 */
export async function scrapingBrowserBootstrap(url, { cdpUrl, capture = {}, timeoutMs = 90000, captureTimeoutMs = 45000, connect, blockTypes = BLOCKED_RESOURCE_TYPES, solveCaptcha = true } = {}) {
  const started = Date.now();
  const runtime = () => Math.round(((Date.now() - started) / 1000) * 10) / 10;
  const base = { ok: false, headers: {}, cookie: '', captured: null, bytes: 0, bytesSource: null, runtimeSec: 0, captcha: null, error: null };
  if (!cdpUrl) return { ...base, error: 'scraping browser not configured (no credentials)', note: 'not_configured' };
  const names = (Array.isArray(capture && capture.headers) ? capture.headers : []).map(String).filter(Boolean);
  const cookieNames = (Array.isArray(capture && capture.cookies) ? capture.cookies : []).map(String).filter(Boolean);
  let re = null;
  try { re = capture && capture.urlPattern ? new RegExp(capture.urlPattern, String(capture.flags || '').replace(/[gy]/g, '')) : null; } catch { re = null; }
  if (!url || !re || (!names.length && !cookieNames.length)) return { ...base, error: 'bad capture spec (needs a url, a urlPattern and header or cookie names)', note: 'bad_capture_spec' };
  // An auth-looking cookie is never carried, so requiring one could never succeed:
  // refuse BEFORE connecting rather than pay for a session that must fail.
  const denied = cookieNames.filter((n) => AUTH_DENYLIST.test(n));
  if (denied.length) return { ...base, error: `bad capture spec (auth cookies are never captured: ${denied.join(', ')})`, note: 'bad_capture_spec' };

  const deadline = started + Math.max(1000, timeoutMs);
  const left = () => Math.max(0, deadline - Date.now());
  const doConnect = connect || defaultConnect;
  const lower = names.map((n) => n.toLowerCase());
  const got = {}; const secrets = [];
  const timers = [];
  const wait = (ms) => { const s = sleep(ms); timers.push(s); return s.p; };
  let browser = null, ctx = null, cdp = null, clBytes = 0, cdpBytes = 0, captcha = null;
  let capturedUrl = null, sawMatch = false, resolveCap = () => {};
  const capturedP = new Promise((r) => { resolveCap = r; });
  const redact = (s) => { let out = redactCredentials(s); for (const v of secrets) if (v && v.length >= 4) out = out.split(v).join('***'); return out; };
  const bytesNow = () => ({ bytes: Math.max(cdpBytes, clBytes), bytesSource: cdpBytes > 0 ? 'cdp' : (clBytes > 0 ? 'content-length' : null) });

  const onRequest = async (req) => {
    try {
      if (capturedUrl || !req) return;
      const method = typeof req.method === 'function' ? String(req.method()).toUpperCase() : 'GET';
      if (method === 'OPTIONS') return; // a CORS preflight carries header NAMES, not values
      const u = typeof req.url === 'function' ? String(req.url()) : '';
      if (!re.test(u)) return;
      sawMatch = true;
      let h = {};
      try { h = lowerKeys((typeof req.headers === 'function' && req.headers()) || {}); } catch { /* keep {} */ }
      if (lower.some((n) => h[n] == null || h[n] === '') && typeof req.allHeaders === 'function') {
        const s = sleep(3000); // allHeaders() can wait for the response — bound it
        try { const all = await Promise.race([req.allHeaders(), s.p.then(() => ({}))]); h = { ...lowerKeys(all || {}), ...h }; } catch { /* keep h */ } finally { s.cancel(); }
      }
      if (capturedUrl || lower.some((n) => h[n] == null || h[n] === '')) return; // wait for a request carrying every name
      names.forEach((n, i) => { got[n] = String(h[lower[i]]); secrets.push(got[n]); });
      capturedUrl = u; resolveCap(true);
    } catch { /* a listener must never throw into Playwright */ }
  };

  let result;
  let closing = false, solveStarted = false;
  try {
    // Connect, bounded by the overall deadline.
    const connectP = Promise.resolve().then(() => doConnect(cdpUrl, { timeoutMs: Math.min(60000, left()) }));
    browser = await Promise.race([connectP, wait(left()).then(() => null)]);
    if (!browser) {
      connectP.then((b) => { try { if (b) b.close(); } catch { /* ignore */ } }).catch(() => {});
      result = { ...base, error: 'connect timeout', note: 'timeout' };
    } else {
      // EVERYTHING after the connect runs under the same deadline: a remote call
      // that never answers (page, CDP, route, cookies) must neither hang the job past
      // the stall heartbeat nor keep a billed session open — the finally closes it.
      const session = async () => {
      const ctxs = (typeof browser.contexts === 'function' && browser.contexts()) || [];
      ctx = ctxs[0] || await browser.newContext();
      try { ctx.on('response', (r) => { try { const cl = r.headers()['content-length']; if (cl) clBytes += parseInt(cl, 10) || 0; } catch { /* skip */ } }); } catch { /* no event support */ }
      let listening = false;
      try { if (typeof ctx.on === 'function') { ctx.on('request', onRequest); listening = true; } } catch { /* fall back to the page */ }
      const page = await ctx.newPage();
      try { if (!listening && typeof page.on === 'function') page.on('request', onRequest); } catch { /* no event support */ }
      try { if (typeof page.setDefaultNavigationTimeout === 'function') page.setDefaultNavigationTimeout(Math.max(1000, left())); } catch { /* ignore */ }
      try {
        if (typeof ctx.newCDPSession === 'function') {
          cdp = await ctx.newCDPSession(page);
          cdp.on('Network.loadingFinished', (e) => { cdpBytes += (e && e.encodedDataLength) || 0; });
          await cdp.send('Network.enable');
        }
      } catch { /* fall back to content-length */ }
      if (blockTypes && blockTypes.size && typeof page.route === 'function') {
        try {
          await page.route('**/*', (route) => {
            const r = route.request();
            // The capture target always goes through, whatever its resource type.
            if (blockTypes.has(r.resourceType()) && !re.test(r.url())) route.abort('aborted').catch(() => {});
            else route.continue().catch(() => {});
          });
        } catch { /* proceed without blocking */ }
      }
      // Listeners are attached BEFORE navigation: the API call can fire before
      // domcontentloaded. Navigation is not awaited on its own — the capture is.
      let navErr = null;
      const navP = Promise.resolve().then(() => page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(1000, left()) })).catch((e) => { navErr = e || new Error('navigation failed'); });
      // A challenge page can hold the app back: once navigation settles without a
      // capture, let Bright Data's documented solver work, within the capture window.
      navP.then(async () => {
        if (capturedUrl || navErr || !solveCaptcha || !cdp) return;
        solveStarted = true;
        try { const s = await cdp.send('Captcha.solve', { detectTimeout: 10000 }); captcha = (s && s.status) || 'unknown'; }
        // Rejected because WE closed the session (capture window over)? Then the
        // solve was still pending — reported as such, not as "solver unavailable".
        catch (e) { if (!closing) captcha = `unavailable: ${redact((e && e.message) || e).slice(0, 100)}`; }
      }).catch(() => {});
      const navFailed = navP.then(() => (navErr ? 'nav_failed' : new Promise(() => {})));
      const outcome = await Promise.race([capturedP.then(() => 'captured'), navFailed, wait(Math.min(left(), captureTimeoutMs)).then(() => 'timeout')]);

      let cookie = ''; const cookieGot = [];
      if (outcome === 'captured' && cookieNames.length && typeof ctx.cookies === 'function') {
        try {
          const cs = await ctx.cookies([capturedUrl || url]);
          const pairs = (Array.isArray(cs) ? cs : []).filter((c) => c && c.name && cookieNames.includes(c.name) && !AUTH_DENYLIST.test(c.name));
          for (const c of pairs) { secrets.push(String(c.value)); if (!cookieGot.includes(c.name)) cookieGot.push(c.name); }
          cookie = pairs.map((c) => `${c.name}=${c.value}`).join('; ');
        } catch { /* no cookies */ }
      }
      const ok = outcome === 'captured' && cookieNames.every((n) => cookieGot.includes(n));
      let note = null, error = null;
      if (!ok) {
        if (outcome === 'nav_failed') { note = 'nav_failed'; error = `navigation failed: ${redact((navErr && navErr.message) || navErr).slice(0, 200)}`; }
        else if (outcome === 'captured') { note = 'cookies_missing'; error = `cookies not found: ${cookieNames.filter((n) => !cookieGot.includes(n)).join(', ')}`; }
        else if (sawMatch) { note = 'headers_missing'; error = `a matching request lacked: ${names.join(', ')}`; }
        else { note = 'no_match'; error = 'no matching request observed'; }
      }
      let captured = null;
      if (capturedUrl) { let o; try { const x = new URL(capturedUrl); o = x.origin + x.pathname; } catch { o = '(unparsable)'; } captured = { url: o, headerNames: Object.keys(got), cookieNames: cookieGot }; }
      return { ...base, ok, headers: ok ? got : {}, cookie: ok ? cookie : '', captured, error, ...(note ? { note } : {}) };
      };
      const sessionP = session();
      sessionP.catch(() => {}); // may settle after the close below — never unhandled
      result = await Promise.race([sessionP, wait(left()).then(() => ({ ...base, error: 'bootstrap deadline reached', note: 'timeout' }))]);
    }
  } catch (e) {
    result = { ...base, error: redact((e && e.message) || e), note: 'error' };
  } finally {
    for (const t of timers) t.cancel();
    closing = true;
    // ALWAYS release the remote session — immediately after the capture, to stop
    // the per-GB traffic of an app that keeps loading.
    if (browser) { const s = sleep(10000); try { await Promise.race([Promise.resolve().then(() => browser.close()), s.p]); } catch { /* ignore */ } finally { s.cancel(); } }
  }
  return { ...result, ...bytesNow(), runtimeSec: runtime(), captcha: captcha || (solveStarted ? 'pending_at_close' : null) };
}
