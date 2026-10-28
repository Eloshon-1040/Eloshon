/**
 * Bright Data Web Unlocker escalation tier (v0.5.5) — a GENERIC, opt-in way to
 * fetch a URL's UNLOCKED, JS-rendered HTML through Bright Data's Web Unlocker
 * (POST https://api.brightdata.com/request) when the free lanes (HTTP + local
 * browser + nodriver) are anti-bot-blocked. No per-site code: the zone + API key
 * come from config/env, and a per-domain recipe/profile may pass an
 * `x-unblock-expect` CSS selector so the unlocker keeps retrying until the
 * client-side grid has HYDRATED (the Colruyt case) rather than returning the empty
 * shell.
 *
 * PAID + per-GB billed → INERT unless a key is configured AND the domain opts in.
 * Pure + injectable (pass `fetchImpl`) so tests never touch the network and never
 * need a real key. Secrets are NEVER hardcoded: they come from config.json's
 * `brightData` block or the environment.
 *
 * Config (any of):
 *   config.brightData = { apiKey?, zone?, country? }
 *   env: BRIGHTDATA_API_KEY | BRIGHT-DATA-API-KEY | BRIGHTDATA_UNLOCKER_ZONE
 */

import { fetchWithin } from '../../shared/net/deadline.mjs';

export const WEB_UNLOCKER_ENDPOINT = 'https://api.brightdata.com/request';
export const DEFAULT_ZONE = 'mcp_unlocker';

/**
 * Resolve the Web Unlocker settings from config + env. Never throws.
 * @returns {{ apiKey:string|null, zone:string, country:string|null, configured:boolean }}
 */
export function webUnlockerConfig(config = {}, env = (typeof process !== 'undefined' ? process.env : {})) {
  const bd = (config && config.brightData) || {};
  const e = env || {};
  const apiKey = bd.apiKey || e['BRIGHTDATA_API_KEY'] || e['BRIGHT-DATA-API-KEY'] || null;
  const zone = bd.zone || e['BRIGHTDATA_UNLOCKER_ZONE'] || DEFAULT_ZONE;
  const country = bd.country || null;
  return { apiKey: apiKey || null, zone, country, configured: !!apiKey };
}

/** True when a Web Unlocker call could be made (a key is configured). */
export function webUnlockerAvailable(config, env) { return webUnlockerConfig(config, env).configured; }

const byteLen = (s) => {
  try { return Buffer.byteLength(s || ''); } catch { return (s ? String(s).length : 0); }
};

/**
 * Fetch one URL's unlocked HTML. Returns { ok, status, html, bytes, error, note }.
 * `expect` (a CSS selector / text) sets `x-unblock-expect` so the unlocker waits
 * for client-side hydration; that requires "Manual expect" enabled on the zone —
 * otherwise the API answers a short "Manual expect is not enabled for this zone"
 * body, which is surfaced as a CLEAR error (never a silent empty result).
 *
 * @param {string} url
 * @param {{ apiKey:string, zone?:string, expect?:string, country?:string,
 *   timeoutMs?:number, fetchImpl?:Function }} opts
 */
export async function webUnlockerFetch(url, { apiKey, zone = DEFAULT_ZONE, expect, country, timeoutMs = 120000, fetchImpl } = {}) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) return { ok: false, status: 0, html: null, bytes: 0, error: 'no fetch implementation' };
  if (!apiKey) return { ok: false, status: 0, html: null, bytes: 0, error: 'web unlocker not configured (no api key)', note: 'not_configured' };
  if (!url) return { ok: false, status: 0, html: null, bytes: 0, error: 'no url' };

  const body = { zone, url, format: 'raw' };
  if (country) body.country = country;
  // x-unblock-expect keeps the unlocker retrying until the selector/text appears —
  // the hydration-timing fix for client-side-rendered listings.
  if (expect) body.headers = { 'x-unblock-expect': expect };

  // One deadline for the headers AND the body (a stalled body ends the call).
  const got = await fetchWithin(f, WEB_UNLOCKER_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { timeoutMs, as: 'text' });
  if (!got.ok) {
    if (got.error === 'timeout') return { ok: false, status: got.status || 0, html: null, bytes: 0, error: `timeout after ${timeoutMs} ms`, note: 'timeout' };
    return { ok: false, status: 0, html: null, bytes: 0, error: `request failed: ${got.error}` };
  }
  const r = got.res;
  const text = typeof got.body === 'string' ? got.body : '';
  const bytes = byteLen(text);

  // Bright Data control-plane messages arrive 200 with a tiny body; map the known
  // ones to explicit errors so a misconfigured zone never looks like an empty page.
  if (/^\s*Manual expect is not enabled for this zone/i.test(text)) {
    return { ok: false, status: r.status, html: null, bytes, error: 'zone lacks "Manual expect" — enable it on the zone to use x-unblock-expect', note: 'zone_manual_expect_disabled' };
  }
  if (r.status >= 400) return { ok: false, status: r.status, html: text || null, bytes, error: `HTTP ${r.status}`, note: 'http_error' };
  if (!text || text.length < 200) return { ok: false, status: r.status, html: text || null, bytes, error: 'empty/too-short unlocked response', note: 'empty' };
  return { ok: true, status: r.status, html: text, bytes, error: null };
}
