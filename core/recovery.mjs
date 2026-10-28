/**
 * Recovery ladder (F2) — PURE, additive, DORMANT (not imported by the live
 * engine yet; the engine wiring is a later, feature-flagged step). Given a first
 * fetch that was judged NOT usable, it tries alternative PUBLIC representations
 * of the SAME resource (from url-transforms.mjs) over an INJECTED fetcher,
 * validates each (validate.mjs), and returns the first usable one — or a
 * recommendation to escalate to the browser lane. It NEVER launches a browser
 * itself (keeps it HTTP-only + offline-testable) and NEVER invents data.
 *
 * Guarantees the caller relies on:
 *   • Progressive + bounded: only runs after a non-usable first attempt; caps
 *     total HTTP attempts (maxAttempts). Fast path is untouched.
 *   • Identity re-check BEFORE accepting an alternative representation (never
 *     silently swaps in a different product / a redirected homepage).
 *   • Explainable: returns a `trace` of every attempt + why it was (not) taken.
 *   • Honest escalation: recommends 'browser' only when a browser could plausibly
 *     help (JS/challenge), 'none' when everything was definitively terminal.
 */
import { alternativeRepresentations } from './url-transforms.mjs';
import { validate } from './validate.mjs';

const digits = (s) => String(s == null ? '' : s).replace(/[^\d]/g, '');

/** Strongest stable identity available on a RawProduct, or null. */
function identityOf(p) {
  if (!p) return null;
  const g = digits(p.gtin);
  if (g) return `gtin:${g}`;
  if (p.sku && String(p.sku).trim()) return `sku:${String(p.sku).trim()}`;
  return null;
}

/** Host-agnostic path+query key (trailing slash normalised) for redirect guard. */
function pathKey(u) {
  try {
    const url = new URL(u);
    let p = url.pathname;
    if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
    return p + url.search;
  } catch { return null; }
}

/**
 * Is `product` extracted from `cand` acceptable as the SAME resource as `url`?
 *   • If both the original and the candidate carry a strong identity → they must match.
 *   • Else a site-DECLARED representation is trusted (canonical/amphtml/mobile).
 *   • Else (heuristic host swap) the FINAL URL path+query must equal the original's
 *     — this rejects an `m.` twin that redirected to a generic homepage.
 */
function acceptable(cand, product, originalProduct, url, res) {
  const idOld = identityOf(originalProduct);
  const idNew = identityOf(product);
  if (idOld && idNew) return idOld === idNew;
  if (cand.source === 'declared') return true;
  const finalUrl = (res && res.url) || cand.url;
  const a = pathKey(finalUrl);
  const b = pathKey(url);
  return !!a && a === b;
}

/**
 * @param {{
 *   url: string,
 *   fetcher: { get:(u:string)=>Promise<object> },
 *   original?: { result?: object, verdict?: object } | null,  // the first attempt + its validate() verdict
 *   device?: 'auto'|'desktop'|'mobile',
 *   extract?: Function,
 *   maxAttempts?: number,
 * }} args
 * @returns {Promise<{ ok:boolean, via:object|null, result:object|null, product:object|null,
 *   verdict:string, incomplete?:boolean, escalate:'browser'|'none', trace:object[], attempts:number }>}
 */
export async function recover({ url, fetcher, original = null, device = 'auto', extract, maxAttempts = 4 } = {}) {
  const trace = [];
  if (!url || !fetcher || typeof fetcher.get !== 'function') {
    return { ok: false, via: null, result: null, product: null, verdict: 'invalid_args', escalate: 'none', trace, attempts: 0 };
  }

  const originalProduct = original?.verdict?.product ?? null;
  const originalResult = original?.result ?? null;
  let sawBrowserRecoverable = !!original?.verdict?.browserRecoverable;

  // Baseline: keep an already-extracted (incomplete) original product so the
  // ladder never returns worse than what we already had. Never invents.
  let best = null;
  if (originalProduct && originalProduct.name) {
    best = {
      via: { url, source: 'original' }, result: originalResult, product: originalProduct,
      verdict: originalProduct.price != null ? 'usable' : 'incomplete',
    };
    trace.push({ url, source: 'original', verdict: best.verdict, accepted: true, baseline: true });
    if (best.verdict === 'usable') {
      // Shouldn't happen (ladder is entered on non-usable), but stay correct.
      return { ok: true, ...best, escalate: 'none', trace, attempts: 0 };
    }
  }

  // Candidate representations: declared (from the original body) first, then
  // generic heuristics. Feeds are not single-product HTML → skip them here.
  const html = originalResult && originalResult.body ? originalResult.body : null;
  const candidates = alternativeRepresentations({ url, html, device })
    .filter((c) => !/^feed_/.test(c.kind || ''));

  let attempts = 0;
  for (const cand of candidates) {
    if (attempts >= maxAttempts) break;
    attempts++;

    let res;
    try { res = await fetcher.get(cand.url); }
    catch (e) { trace.push({ url: cand.url, source: cand.source, verdict: 'fetch_error', accepted: false, reason: String((e && e.message) || e) }); continue; }

    const v = validate(res, extract ? { extract } : {});
    if (v.browserRecoverable) sawBrowserRecoverable = true;

    const positive = v.usable || v.incomplete;
    if (!positive) { trace.push({ url: cand.url, source: cand.source, verdict: v.verdict, accepted: false, reason: v.reason }); continue; }

    if (!acceptable(cand, v.product, originalProduct, url, res)) {
      trace.push({ url: cand.url, source: cand.source, verdict: v.verdict, accepted: false, reason: 'identity_mismatch' });
      continue;
    }

    trace.push({ url: cand.url, source: cand.source, verdict: v.verdict, accepted: true });
    if (v.usable) return { ok: true, via: cand, result: res, product: v.product, verdict: 'usable', escalate: 'none', trace, attempts };
    // incomplete candidate: adopt only if we have nothing yet (never invent, never downgrade).
    if (!best) best = { via: cand, result: res, product: v.product, verdict: 'incomplete' };
  }

  if (best) return { ok: true, via: best.via, result: best.result, product: best.product, verdict: best.verdict, incomplete: best.verdict === 'incomplete', escalate: 'none', trace, attempts };
  return { ok: false, via: null, result: null, product: null, verdict: 'exhausted', escalate: sawBrowserRecoverable ? 'browser' : 'none', trace, attempts };
}
