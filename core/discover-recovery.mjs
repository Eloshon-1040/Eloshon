/**
 * Discovery recovery (F2 → discovery) — PURE, additive, DORMANT (imported only by
 * discover.mjs behind a flag + tests). When a catalogue/listing fetch is BLOCKED
 * (a terminal response: Access Denied / challenge / captcha / auth / rate-limit),
 * it tries the SAME alternative-representation ladder used for products — F1
 * `alternativeRepresentations` for the candidates + F2 `validate` to classify each
 * response — but with a DISCOVERY acceptance test instead of a product one:
 *
 *   a representation is taken ONLY when it is not itself a block AND the caller
 *   confirms (via `accept`) that it actually yields catalogue links.
 *
 * Guarantees (same spirit as recovery.mjs):
 *   • HTTP-only + bounded (maxAttempts). Never launches a browser; recommends
 *     'browser' escalation only when a candidate looked browser-recoverable.
 *   • A block page (challenge/captcha/denied/empty) is NEVER accepted, so it can
 *     never become a fake discovery result.
 *   • Identity re-check before accepting a heuristic host swap (rejects a twin
 *     that redirected to a generic homepage); a site-declared representation is
 *     trusted. Never invents URLs.
 *   • Explainable: returns a `trace` of every attempt + why it was (not) taken.
 */
import { alternativeRepresentations } from './url-transforms.mjs';
import { validate } from './validate.mjs';

/** Host-agnostic path+query key (trailing slash normalised) for the redirect guard. */
function pathKey(u) {
  try {
    const url = new URL(u);
    let p = url.pathname;
    if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
    return p + url.search;
  } catch { return null; }
}

/**
 * @param {{
 *   url: string,
 *   fetcher: { get:(u:string)=>Promise<object> },
 *   html?: string|null,                 // the blocked response body (for declared reps)
 *   device?: 'auto'|'desktop'|'mobile',
 *   maxAttempts?: number,
 *   accept: (res:object, cand:object)=>boolean,  // does this representation yield catalogue links?
 * }} args
 * @returns {Promise<{ ok:boolean, via:object|null, result:object|null, verdict:string,
 *   escalate:'browser'|'none', trace:object[], attempts:number }>}
 */
export async function recoverDiscovery({ url, fetcher, html = null, device = 'auto', maxAttempts = 4, accept } = {}) {
  const trace = [];
  if (!url || !fetcher || typeof fetcher.get !== 'function') {
    return { ok: false, via: null, result: null, verdict: 'invalid_args', escalate: 'none', trace, attempts: 0 };
  }

  const wantPath = pathKey(url);
  // Declared representations (from the blocked body, usually none) first, then
  // generic host heuristics. Feeds are not catalogue HTML → skip them.
  const candidates = alternativeRepresentations({ url, html, device })
    .filter((c) => !/^feed_/.test(c.kind || ''));

  let sawBrowserRecoverable = false;
  let attempts = 0;
  for (const cand of candidates) {
    if (attempts >= maxAttempts) break;
    attempts++;

    let res;
    try { res = await fetcher.get(cand.url); }
    catch (e) { trace.push({ url: cand.url, source: cand.source, verdict: 'fetch_error', accepted: false, reason: String((e && e.message) || e) }); continue; }

    const v = validate(res, { product: null }); // classify the representation (block? content?)
    if (v.browserRecoverable) sawBrowserRecoverable = true;

    // A representation that is ITSELF a block (challenge/captcha/denied/auth/
    // temporary) or empty is never a usable catalogue — never accepted, so a
    // block page can never be turned into discovery results.
    const isBlock = v.browserRecoverable || v.authRequired || v.retriable || v.definitive || v.verdict === 'empty';
    if (isBlock) { trace.push({ url: cand.url, source: cand.source, verdict: v.verdict, accepted: false, reason: v.reason }); continue; }

    // Identity: a heuristic host swap that redirected to a different path (e.g. a
    // generic homepage) is rejected; a site-declared representation is trusted.
    const finalUrl = (res && res.url) || cand.url;
    if (cand.source !== 'declared' && wantPath && pathKey(finalUrl) !== wantPath) {
      trace.push({ url: cand.url, source: cand.source, verdict: v.verdict, accepted: false, reason: 'identity_mismatch' });
      continue;
    }

    // Discovery acceptance: does this representation actually yield catalogue
    // links? (Supplied by the caller so this module stays link-format-agnostic.)
    let ok = false;
    try { ok = !!accept && !!accept(res, cand); } catch { ok = false; }
    if (!ok) { trace.push({ url: cand.url, source: cand.source, verdict: v.verdict, accepted: false, reason: 'no_catalogue_links' }); continue; }

    trace.push({ url: cand.url, source: cand.source, verdict: v.verdict, accepted: true });
    return { ok: true, via: cand, result: res, verdict: v.verdict, escalate: 'none', trace, attempts };
  }

  return { ok: false, via: null, result: null, verdict: 'exhausted', escalate: sawBrowserRecoverable ? 'browser' : 'none', trace, attempts };
}
