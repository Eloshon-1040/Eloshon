/**
 * Config-driven challenge detection. The recipe/config declares WHAT a challenge
 * looks like for a domain (status codes, DOM markers, URL patterns, text
 * patterns) and this module only MATCHES — it never hardcodes a site, a vendor
 * or a marker. Ships sane generic defaults so a recipe that declares nothing
 * still catches common anti-bot pages.
 *
 * PORTABLE: zero Node built-ins, zero dependencies.
 *
 * Detection config shape (== recipe.challenge.detect and siblings):
 *   {
 *     challenge:    { status:[503,403], dom_markers:[…], text_patterns:[…], text_regex:['…'], url_patterns:[…] },
 *     captcha:      { dom_markers:['g-recaptcha','cf-turnstile'], text_patterns:['verify you are human'] },
 *     auth_required:{ status:[401,407], url_patterns:['/login'] },
 *     rate_limited: { status:[429,456] },
 *     blocked:      { status:[451] }
 *   }
 * Categories are checked in priority order; the first match wins.
 */

/** Generic fallback markers, merged UNDER any recipe-provided config. */
export const DEFAULT_DETECT = Object.freeze({
  captcha: {
    // Real, interactive challenge WIDGETS/iframes — present only when the site is
    // actually challenging the visitor. `captcha-delivery.com` is DataDome's captcha
    // iframe (it is NOT in a normal page), `px-captcha` is PerimeterX's widget.
    dom_markers: ['g-recaptcha', 'grecaptcha', 'h-captcha', 'hcaptcha', 'cf-turnstile', 'turnstile', 'px-captcha', 'captcha-delivery.com', 'geo.captcha-delivery'],
    text_patterns: ["i'm not a robot", 'verify you are human', 'are you human'],
  },
  challenge: {
    status: [503],
    // CHALLENGE-PAGE markers ONLY — never a bare anti-bot SDK name. `datadome`,
    // `_px`, `incapsula`, `imperva`, `perimeterx` are loaded on EVERY normal page
    // of a protected site (Leroy Merlin, etc.), so matching them paused real content
    // pages for a challenge that did not exist (job stuck "action requise" with
    // nothing to solve, then a 5-min timeout). We now match the Cloudflare challenge
    // platform and challenge-page text — the actual interstitial, not the SDK.
    dom_markers: ['/cdn-cgi/challenge-platform', 'cf_chl_opt', '_incapsula_resource', 'errors.edgesuite.net', 'sec-cpt-if'],
    // A bare « Access Denied » page stays an ACCESS_DENIED block (classified by status elsewhere), not a challenge.
    text_patterns: ['attention required', 'checking your browser', 'just a moment', 'ddos protection', 'ray id', 'enable javascript and cookies to continue', 'incapsula incident id', 'reference #18', 'pardon our interruption'],
    // The CDN edge's refusal reference, in a shop's own branded block page: « Reference Error: <edge>.<hex>.<epoch>.<hex> »
    // (or « Reference #… »). The first number is the edge server that answered, so it changes from one refusal to the next:
    // « 18. » on 25/10/2026, « 0. » on 27/10/2026 (same sports shop, « Nous ne pouvons pas vous laisser accéder à notre
    // site »). Matched on the shape of the whole reference, never on one edge number.
    text_regex: ['\\breference\\s*(?:error\\s*:|#)\\s*\\d{1,3}\\.[0-9a-f]{6,10}\\.\\d{9,11}\\.[0-9a-f]{4,10}\\b'],
    url_patterns: ['/cdn-cgi/', '_incapsula_resource'],
  },
  auth_required: { status: [401, 407], url_patterns: ['/login', '/signin', '/account/login'] },
  rate_limited: { status: [429, 456] },
  blocked: { status: [451] },
});

// Priority: a captcha widget is the most specific; auth before generic challenge.
const ORDER = ['captcha', 'auth_required', 'rate_limited', 'challenge', 'blocked'];

const lc = (s) => String(s == null ? '' : s).toLowerCase();
const anyIncludes = (hay, needles) => {
  if (!needles || !needles.length) return false;
  const h = lc(hay);
  return needles.some((n) => h.includes(lc(n)));
};

function mergeRule(base, extra) {
  const b = base || {}; const e = extra || {};
  return {
    status: [...new Set([...(b.status || []), ...(e.status || [])])],
    dom_markers: [...(b.dom_markers || []), ...(e.dom_markers || [])],
    text_patterns: [...(b.text_patterns || []), ...(e.text_patterns || [])],
    url_patterns: [...(b.url_patterns || []), ...(e.url_patterns || [])],
    text_regex: [...(b.text_regex || []), ...(e.text_regex || [])],
  };
}

// Patterns are strings (a recipe is JSON), compiled once, case-insensitive; an invalid one is ignored.
const regexCache = new Map();
function compiled(src) {
  if (!regexCache.has(src)) { let re = null; try { re = new RegExp(src, 'i'); } catch { re = null; } regexCache.set(src, re); }
  return regexCache.get(src);
}
/** Does `hay` match one of the regex sources (strings)? Shared with core/detect.mjs. */
export function anyRegex(hay, sources) {
  if (!sources || !sources.length || !hay) return false;
  const h = String(hay);
  return sources.some((s) => { const re = compiled(String(s)); return !!re && re.test(h); });
}

function ruleMatches(rule, ctx) {
  if (!rule) return false;
  if (rule.status && ctx.status != null && rule.status.includes(ctx.status)) return true;
  if (anyIncludes(ctx.url, rule.url_patterns)) return true;
  // DOM markers and text patterns both scan the body; kept as separate config
  // keys for authoring clarity, matched against the same text here.
  if (anyIncludes(ctx.body, rule.dom_markers)) return true;
  if (anyIncludes(ctx.body, rule.text_patterns)) return true;
  if (anyRegex(ctx.body, rule.text_regex)) return true;
  return false;
}

/**
 * Detect the challenge category for a page context.
 * @param {{status?:number, url?:string, body?:string}} ctx
 * @param {object} [config] recipe.challenge.detect (merged over DEFAULT_DETECT)
 * @returns {{category:string, rule:object}|null} null when nothing matches
 */
export function detectChallenge(ctx = {}, config = {}) {
  for (const cat of ORDER) {
    const rule = mergeRule(DEFAULT_DETECT[cat], config[cat]);
    if (ruleMatches(rule, ctx)) return { category: cat, rule };
  }
  return null;
}

/**
 * Has the page returned to a normal state? Used by the human-in-the-loop
 * strategy to auto-detect that the operator solved the challenge.
 * @param {{status?:number, url?:string, body?:string}} ctx
 * @param {object} [config]
 * @returns {boolean}
 */
export function isBackToNormal(ctx = {}, config = {}) {
  if (ctx.status != null && ctx.status >= 400) return false;
  return detectChallenge(ctx, config) == null;
}
