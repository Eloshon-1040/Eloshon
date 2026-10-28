/**
 * Zyte API lane (Zyte API `extract` endpoint). PAID → INERT unless configured.
 * Generic: no per-site code — credentials come through the registry (config.zyte
 * or the ZYTE_API_KEY env NAME). Billed per successful request; the price varies
 * with site difficulty, so caps live in the provider runtime.
 *
 * Auth: HTTP Basic with the API key as the username and an empty password
 * (per Zyte API docs). Body: `{ url, httpResponseBody: true }` for a raw HTTP
 * fetch, or `{ url, browserHtml: true }` for a browser-rendered page.
 *
 * PURE + injectable: pass `fetchImpl` so tests stay offline. Never logs the key.
 */
import { fetchWithin } from '../../shared/net/deadline.mjs';
const ENDPOINT = 'https://api.zyte.com/v1/extract';

/** @returns {{ apiKey:string|null, configured:boolean }} */
export function zyteConfig(config = {}, env = (typeof process !== 'undefined' ? process.env : {})) {
  const z = (config && config.zyte) || {};
  const e = env || {};
  const apiKey = z.apiKey || e.ZYTE_API_KEY || null;
  return { apiKey: apiKey || null, configured: !!apiKey };
}

/**
 * Fetch a URL through the Zyte API.
 * @param {string} url
 * @param {{ apiKey:string, browser?:boolean, timeoutMs?:number, fetchImpl?:Function, geolocation?:string }} opts
 * @returns {Promise<{ok:boolean,status:number,html:string|null,bytes:number,error:string|null,note?:string}>}
 */
export async function zyteFetch(url, { apiKey, browser = false, timeoutMs = 120000, fetchImpl, geolocation } = {}) {
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) return { ok: false, status: 0, html: null, bytes: 0, error: 'no fetch implementation available' };
  if (!apiKey) return { ok: false, status: 0, html: null, bytes: 0, error: 'zyte not configured (no api key)', note: 'not_configured' };
  if (!url) return { ok: false, status: 0, html: null, bytes: 0, error: 'no url' };

  const body = { url };
  if (browser) body.browserHtml = true; else body.httpResponseBody = true;
  if (geolocation) body.geolocation = geolocation;

  const auth = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');
  // One deadline for the headers AND the body.
  const got = await fetchWithin(doFetch, ENDPOINT, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, { timeoutMs, as: 'json' });
  if (!got.ok) return { ok: false, status: got.status || 0, html: null, bytes: 0, error: `zyte request failed: ${got.error}`, ...(got.error === 'timeout' ? { note: 'timeout' } : {}) };
  const r = got.res;
  const data = got.jsonError ? null : got.body;
  if (r.status >= 400 || !data) {
    const msg = (data && (data.detail || data.title)) || `HTTP ${r.status}`;
    return { ok: false, status: r.status, html: null, bytes: 0, error: `zyte: ${msg}`, note: r.status === 401 || r.status === 403 ? 'auth_error' : undefined };
  }
  let html = null;
  if (browser && typeof data.browserHtml === 'string') html = data.browserHtml;
  else if (data.httpResponseBody) { try { html = Buffer.from(data.httpResponseBody, 'base64').toString('utf8'); } catch { html = null; } }
  const bytes = html ? Buffer.byteLength(html, 'utf8') : 0;
  if (!html) return { ok: false, status: r.status, html: null, bytes: 0, error: 'zyte: empty body' };
  return { ok: true, status: r.status, html, bytes, error: null };
}
