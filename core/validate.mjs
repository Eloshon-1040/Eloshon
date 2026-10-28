/**
 * Enriched attempt validator (F2) — PURE, additive, DORMANT (imported only by
 * recovery.mjs + tests, never by the live engine path yet). It COMPOSES the
 * existing, unchanged primitives (`classifyResponse` from detect.mjs +
 * `extractProduct` from extract.mjs) into a single richer verdict the recovery
 * ladder needs. It changes NO existing behaviour and touches NO existing file.
 *
 * "HTTP 200 is a start condition, not success": a fetch is only USABLE when a
 * product actually extracts. The verdict distinguishes the states the ladder
 * must act on differently:
 *   usable · incomplete · empty · wrong_representation · js_not_rendered ·
 *   challenge · captcha · auth_required · http_temporary · http_definitive
 */
import { classifyResponse, STATUS } from './detect.mjs';
import { extractProduct } from './extract.mjs';

export const VERDICT = {
  USABLE: 'usable',                       // product with a name AND a price → accept
  INCOMPLETE: 'incomplete',               // product with a name but no price → keep, try to improve
  EMPTY: 'empty',                         // no meaningful body
  WRONG_REPRESENTATION: 'wrong_representation', // 200 content, but not the product (listing/stub/…)
  JS_NOT_RENDERED: 'js_not_rendered',     // SPA shell / needs a browser
  CHALLENGE: 'challenge',                 // anti-bot challenge
  CAPTCHA: 'captcha',                     // captcha widget
  AUTH_REQUIRED: 'auth_required',         // 401/407 — no representation/browser fixes this
  HTTP_TEMPORARY: 'http_temporary',       // 429 / 5xx / timeout / network → retriable
  HTTP_DEFINITIVE: 'http_definitive',     // 403/404/410 … denied for this representation
};

const VISIBLE_MIN = 32; // chars of visible text below which a 200 body is "empty"

function visibleLength(html) {
  return String(html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}
const hasName = (p) => !!(p && typeof p.name === 'string' && p.name.trim());
const hasPrice = (p) => !!(p && p.price != null && !Number.isNaN(Number(p.price)));

/**
 * Validate one fetch result into an enriched verdict.
 * @param {{status?:number, url?:string, requestedUrl?:string, body?:string,
 *          error?:string|null, headers?:object}} result  a Fetcher.get() result
 * @param {{extract?:Function, product?:object|null, needsBrowser?:boolean}} [opts]
 *   `extract` overrides the extractor (tests); `product`/`needsBrowser` let a
 *   caller pass an already-computed extraction to avoid doing it twice.
 * @returns {{verdict:string, code:string, product:object|null, usable:boolean,
 *   incomplete:boolean, browserRecoverable:boolean, authRequired:boolean,
 *   retriable:boolean, definitive:boolean, reason:string}}
 */
export function validate(result = {}, opts = {}) {
  const body = result.body || '';
  const srcUrl = result.url || result.requestedUrl || '';

  let product = null, needsBrowser = false;
  if (opts.product !== undefined) { product = opts.product; needsBrowser = !!opts.needsBrowser; }
  else if (body) {
    const ext = (opts.extract || extractProduct)(body, srcUrl);
    product = ext.product; needsBrowser = ext.needsBrowser;
  }

  const resp = classifyResponse({
    status: result.status, url: result.url, requestedUrl: result.requestedUrl,
    body, error: result.error, headers: result.headers, needsBrowser,
  });

  let verdict;
  switch (resp.code) {
    // Protection / transport codes are decisive — a challenge page's <title>
    // ("Just a moment…") must NEVER be mistaken for an extracted product.
    case STATUS.BOT_CHALLENGE: verdict = VERDICT.CHALLENGE; break;
    case STATUS.CAPTCHA: verdict = VERDICT.CAPTCHA; break;
    case STATUS.AUTH_REQUIRED: verdict = VERDICT.AUTH_REQUIRED; break;
    case STATUS.RATE_LIMITED:
    case STATUS.NETWORK_ERROR: verdict = VERDICT.HTTP_TEMPORARY; break;
    case STATUS.ACCESS_DENIED: verdict = VERDICT.HTTP_DEFINITIVE; break;
    // A 404/410 is a dead page for this representation: its <title> ("page not
    // found") must never be adopted as a product (job 20260929165036-g8hh3).
    case STATUS.NOT_FOUND: verdict = VERDICT.HTTP_DEFINITIVE; break;
    default: {
      // Content-ish codes (OK / JAVASCRIPT_REQUIRED / NOT_A_PRODUCT_PAGE): an
      // actually-extracted product WINS over a tiny-body "JS required" hint
      // (mirrors the engine, which uses preProduct when present).
      if (hasName(product)) verdict = hasPrice(product) ? VERDICT.USABLE : VERDICT.INCOMPLETE;
      else if (!body.trim()) verdict = VERDICT.EMPTY;                       // truly blank 200
      else if (resp.code === STATUS.JAVASCRIPT_REQUIRED || needsBrowser) verdict = VERDICT.JS_NOT_RENDERED;
      else verdict = visibleLength(body) < VISIBLE_MIN ? VERDICT.EMPTY : VERDICT.WRONG_REPRESENTATION;
    }
  }

  const carriesProduct = verdict === VERDICT.USABLE || verdict === VERDICT.INCOMPLETE;
  return {
    verdict,
    code: resp.code,
    product: carriesProduct ? product : null,
    usable: verdict === VERDICT.USABLE,
    incomplete: verdict === VERDICT.INCOMPLETE,
    // a browser could plausibly recover these (JS render / bot challenge)
    browserRecoverable: verdict === VERDICT.JS_NOT_RENDERED || verdict === VERDICT.CHALLENGE || verdict === VERDICT.CAPTCHA,
    authRequired: verdict === VERDICT.AUTH_REQUIRED,
    retriable: verdict === VERDICT.HTTP_TEMPORARY,
    // definitive FOR THIS representation (another representation may still work)
    definitive: verdict === VERDICT.HTTP_DEFINITIVE || verdict === VERDICT.AUTH_REQUIRED,
    reason: resp.reason,
  };
}
