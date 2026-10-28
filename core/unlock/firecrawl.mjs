/**
 * Firecrawl escalation tier (v0.5.6, API v2 since v0.5.37) — a GENERIC, opt-in lane
 * that fetches a URL's rendered HTML + markdown through Firecrawl's scrape API
 * (POST https://api.firecrawl.dev/v2/scrape). It complements the Bright Data Web
 * Unlocker lane: Firecrawl has a native `actions: [{type:"wait", selector}]` step
 * that waits for a real product-card element to appear before returning — the
 * client-side HYDRATION fix — with no special/costly zone setting (unlike Bright
 * Data's "Manual expect"). Its own anti-bot handling is the v2 default
 * `proxy: "auto"` (basic, then enhanced on failure — same 1 credit per the docs);
 * `proxy` in config overrides it.
 *
 * Cache (v2): Firecrawl may return a copy of the page it already holds when that
 * copy is younger than `maxAge` (ms). The v2 default is 2 days when the field is
 * absent (v1: 0, no cache), so the lane ALWAYS sends it: the caller's value, else
 * DEFAULT_MAX_AGE_MS. Per the docs (verified 2026-10-20) a cached page still costs
 * 1 credit: the cache saves time and failed fresh renders, not credits; requests
 * with `actions` or `headers` skip the cache. `metadata.cacheState` ('hit'|'miss')
 * is passed through so the usage ledger can say where the page came from.
 *
 * Retries: 429 and 5xx (no document → 0 credits per the docs) are retried, honouring
 * Retry-After, within the caller's `timeoutMs` (the route budget). 402 (no credits
 * left) is never retried: note 'no_credits'.
 *
 * NO per-site code: the domain opt-in + wait selector + actions come from config
 * (config.firecrawl), never from a domain branch in the engine. PAID → INERT unless
 * a key is configured AND the domain opts in. Pure + injectable (`fetchImpl`,
 * `sleepImpl`, `now`) so tests never touch the network. Secrets come from
 * config/env, never hardcoded.
 *
 * Config (any of):
 *   config.firecrawl = { apiKey?, domains?:string[], selectors?:{host:sel},
 *                        proxy?, country?, actions?:{host:[...]}, maxAgeMs? }
 *   env: FIRECRAWL_API_KEY | FIRECRAWL-API-KEY
 */

import { fetchWithin, retryAfterMs } from '../../shared/net/deadline.mjs';
export { retryAfterMs };

export const FIRECRAWL_API = 'https://api.firecrawl.dev/v2';
export const FIRECRAWL_ENDPOINT = `${FIRECRAWL_API}/scrape`;
export const FIRECRAWL_CREDIT_USAGE = `${FIRECRAWL_API}/team/credit-usage`;
/** One hour: a relaunch in the same working session may reuse the page, while
 *  prices and stock stay at most an hour old (the v2 default is 2 days). */
export const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_SERVER_TIMEOUT_MS = 300000; // v2 `timeout` maximum
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_MIN_LEFT_MS = 5000; // a retry starts only with at least this much budget left

/** @returns {{ apiKey:string|null, configured:boolean }} */
export function firecrawlConfig(config = {}, env = (typeof process !== 'undefined' ? process.env : {})) {
  const fc = (config && config.firecrawl) || {};
  const e = env || {};
  const apiKey = fc.apiKey || e['FIRECRAWL_API_KEY'] || e['FIRECRAWL-API-KEY'] || null;
  return { apiKey: apiKey || null, configured: !!apiKey };
}

export function firecrawlAvailable(config, env) { return firecrawlConfig(config, env).configured; }

/** config.firecrawl.maxAgeMs as a usable value: a finite number ≥ 0, else the default. */
export function firecrawlMaxAge(config = {}) {
  const v = config && config.firecrawl && config.firecrawl.maxAgeMs;
  if (v === null || v === undefined || v === '') return DEFAULT_MAX_AGE_MS;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : DEFAULT_MAX_AGE_MS;
}

/**
 * FREE, read-only connection test: GET /v2/team/credit-usage. This endpoint does
 * NOT run a scrape and does NOT consume credits — it only reports the balance, so
 * it is safe to use for "Tester la connexion". Never billable. Never logs the key.
 * PURE + injectable (`fetchImpl`) so tests stay offline.
 * @returns {Promise<{ok:boolean, remaining:number|null, status?:number, error?:string}>}
 */
export async function firecrawlCreditUsage(apiKey, { fetchImpl, timeoutMs = 15000 } = {}) {
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) return { ok: false, remaining: null, error: 'no fetch implementation available' };
  if (!apiKey) return { ok: false, remaining: null, error: 'not_configured' };
  // One deadline for the headers AND the body (shared/net/deadline.mjs).
  const got = await fetchWithin(doFetch, FIRECRAWL_CREDIT_USAGE, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } }, { timeoutMs, as: 'json' });
  if (!got.ok && !got.res) return { ok: false, remaining: null, error: `requête échouée (${got.error})` };
  if (!got.ok) return { ok: false, remaining: null, status: got.status, error: `requête échouée (${got.error})` };
  const r = got.res;
  const data = got.jsonError ? null : got.body;
  if (r.status === 401 || r.status === 403) return { ok: false, remaining: null, status: r.status, error: 'clé invalide ou non autorisée' };
  if (r.status >= 400 || !data) return { ok: false, remaining: null, status: r.status, error: `HTTP ${r.status}` };
  // v2 answers camelCase (remainingCredits, planCredits, billingPeriodEnd); the
  // snake_case names are the v1 shape, still read by the official SDK.
  const d = data.data || data;
  const remaining = d.remainingCredits ?? d.remaining_credits ?? d.remaining ?? null;
  // Reset date / plan size only when the API states them (never guessed).
  const reset = d.billingPeriodEnd ?? d.billing_period_end ?? d.period_end ?? null;
  const plan = d.planCredits ?? d.plan_credits ?? null;
  return {
    ok: true, remaining: remaining == null ? null : Number(remaining),
    ...(reset && !Number.isNaN(Date.parse(reset)) ? { resetAt: new Date(reset).toISOString() } : {}),
    ...(plan != null && Number.isFinite(Number(plan)) ? { planCredits: Number(plan) } : {}),
  };
}

const byteLen = (s) => { try { return Buffer.byteLength(s || ''); } catch { return (s ? String(s).length : 0); } };
const headerOf = (r, name) => { try { return (r && r.headers && typeof r.headers.get === 'function') ? r.headers.get(name) : null; } catch { return null; } };


/**
 * Scrape one URL. Returns { ok, status, html, markdown, bytes, error, note, credits,
 * cacheState, attempts } — `html` is the raw page (scripts included) unless the
 * caller asks for other formats. `waitSelector` adds a wait-for-CSS-selector action
 * (hydration wait); `actions` (if given) is used verbatim instead. `proxy` overrides
 * Firecrawl's own proxy choice (v2 default: auto). `maxAge` (ms) bounds the age of a
 * cached copy Firecrawl may return (0 = always fresh). `timeoutMs` is the WHOLE
 * budget, retries included.
 */
export async function firecrawlScrape(url, {
  apiKey, waitSelector, actions, waitMs, proxy, country, headers, maxAge = DEFAULT_MAX_AGE_MS,
  formats = ['rawHtml', 'markdown'], timeoutMs = 120000, retries = 2,
  fetchImpl, sleepImpl, now = Date.now,
} = {}) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const fail = (o) => ({ ok: false, status: 0, html: null, markdown: null, bytes: 0, credits: null, cacheState: null, attempts: 0, ...o });
  if (!f) return fail({ error: 'no fetch implementation' });
  if (!apiKey) return fail({ error: 'firecrawl not configured (no api key)', note: 'not_configured' });
  if (!url) return fail({ error: 'no url' });
  const sleep = sleepImpl || ((ms) => new Promise((r) => setTimeout(r, ms)));

  const body = { url, formats, onlyMainContent: false };
  const acts = Array.isArray(actions) ? actions.slice()
    : (waitSelector ? [{ type: 'wait', selector: waitSelector }] : []);
  if (waitMs) acts.push({ type: 'wait', milliseconds: waitMs });
  if (acts.length) body.actions = acts;
  if (proxy) body.proxy = proxy;
  // v2 expects an ISO 3166-1 alpha-2 code in upper case.
  if (country) body.location = { country: String(country).toUpperCase() };
  // Per-host request headers (incl. Cookie) — Firecrawl forwards them to the target.
  // Used to carry a site's session/store cookie (e.g. Colruyt's store selection),
  // derived from config, never hardcoded.
  if (headers && typeof headers === 'object' && Object.keys(headers).length) body.headers = headers;
  const age = Number(maxAge);
  body.maxAge = Number.isFinite(age) && age >= 0 ? Math.round(age) : DEFAULT_MAX_AGE_MS;

  const deadline = now() + timeoutMs;
  const maxAttempts = Math.max(1, Math.floor(Number(retries) || 0) + 1);
  let attempts = 0;
  let last = null; // the last retryable answer, when the budget or the attempts run out
  while (attempts < maxAttempts) {
    const left = Math.max(1, deadline - now());
    // Firecrawl's own deadline sits just inside ours, so a slow page ends as a clean
    // answer from the API rather than an abort on our side (1 s is the API minimum).
    const serverTimeout = Math.max(1000, Math.min(MAX_SERVER_TIMEOUT_MS, left - 2000));
    attempts += 1;
    // One deadline for the headers AND the body: a stalled answer ends the attempt.
    const got = await fetchWithin(f, FIRECRAWL_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, timeout: serverTimeout }),
    }, { timeoutMs: left, as: 'json' });
    if (!got.ok) {
      if (got.error === 'timeout') return fail({ status: got.status || 0, error: `route timeout after ${timeoutMs} ms`, note: 'timeout', attempts });
      return fail({ error: `request failed: ${got.error}`, attempts });
    }
    const r = got.res;
    const j = got.jsonError ? null : got.body;
    const apiMsg = (j && (j.error || j.message)) || `HTTP ${r.status}`;
    // No credits left (or pay-as-you-go allowance used up): stop, never retry.
    if (r.status === 402) return fail({ status: 402, error: `no credits left: ${String(apiMsg)}`, note: 'no_credits', attempts });
    if (RETRY_STATUSES.has(r.status)) {
      last = { status: r.status, error: String(apiMsg), note: r.status === 429 ? 'rate_limited' : 'http_error' };
      if (attempts >= maxAttempts) break;
      const wait = retryAfterMs(headerOf(r, 'retry-after'), now()) ?? 1000 * 2 ** (attempts - 1);
      // A wait that would leave less than RETRY_MIN_LEFT_MS for the next attempt ends
      // the lane now: the route budget is never exceeded.
      if (now() + wait + RETRY_MIN_LEFT_MS > deadline) { last.error += ` (wait of ${Math.round(wait / 1000)} s exceeds the route budget)`; break; }
      await sleep(wait);
      continue;
    }
    if (r.status >= 400 || !j) return fail({ status: r.status, error: String(apiMsg), note: 'http_error', attempts });
    if (j.success === false) return fail({ status: r.status, error: String(j.error || 'firecrawl error'), note: 'api_error', attempts });
    const data = j.data || j;
    const meta = data.metadata || {};
    // The page as served (rawHtml): the cleaned 'html' format drops the <script> blocks
    // where many shops keep their product grid (page state), leaving only the markdown.
    const html = data.rawHtml || data.html || null;
    const markdown = data.markdown || null;
    const bytes = byteLen(html) + byteLen(markdown);
    // Credits billed for this scrape, when the API reports them (usage ledger only).
    const cu = meta.creditsUsed ?? j.creditsUsed ?? null;
    const credits = cu != null && Number.isFinite(Number(cu)) ? Number(cu) : null;
    // Where the page came from, when Firecrawl says so (absent with maxAge 0).
    const cacheState = meta.cacheState === 'hit' || meta.cacheState === 'miss' ? meta.cacheState : null;
    const extra = { credits, cacheState, attempts, ...(cacheState === 'hit' && meta.cachedAt ? { cachedAt: String(meta.cachedAt) } : {}) };
    if (!html && !markdown) return { ok: false, status: r.status, html: null, markdown: null, bytes, error: 'empty firecrawl result', note: 'empty', ...extra };
    return { ok: true, status: r.status, html, markdown, bytes, error: null, ...extra };
  }
  if (last) return fail({ ...last, attempts });
  return fail({ error: `route timeout after ${timeoutMs} ms`, note: 'timeout', attempts });
}
