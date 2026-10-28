/**
 * Portable pagination-URL helpers — the SINGLE source of truth for synthesizing
 * next-page URLs and reading rel=next, used by the app crawl AND the extension's
 * tab driver. Lifted verbatim (behaviour-preserving) from core/pagination.mjs,
 * which now re-exports these.
 *
 * PORTABLE: zero Node built-ins, zero dependencies (URL is a web/Node global).
 */

/** Find a rel="next" link href in HTML. */
export function relNext(html) {
  const tag = String(html).match(/<link[^>]*rel=["']next["'][^>]*>/i)?.[0]
    || String(html).match(/<a[^>]*rel=["']next["'][^>]*>/i)?.[0];
  return tag ? (tag.match(/href=["']([^"']+)["']/i)?.[1] || null) : null;
}

/**
 * Synthesize the NEXT page URL for a listing with no rel=next. Increments an
 * existing page param (page/paged/p/start/from) or a `/page/N` path segment;
 * otherwise starts at ?page=2. Returns null on a bad URL. Self-correcting: the
 * crawl's dedup/no-new guard stops it when a site ignores the param.
 */
export function nextPageUrl(url) {
  try {
    const u = new URL(url);
    for (const s of ['page', 'paged', 'p', 'start', 'from']) {
      const v = u.searchParams.get(s);
      if (v != null && /^\d+$/.test(v)) { u.searchParams.set(s, String(parseInt(v, 10) + 1)); return u.toString(); }
    }
    // Any other page-number parameter already in the URL ("currentPage", "pageNumber", "pg").
    for (const [k, v] of u.searchParams) {
      if (/page|^pg$|^pn$/i.test(k) && !/size|count|limit|per|total/i.test(k) && /^\d{1,4}$/.test(v)) { u.searchParams.set(k, String(parseInt(v, 10) + 1)); return u.toString(); }
    }
    const m = u.pathname.match(/\/page\/(\d+)/i);
    if (m) { u.pathname = u.pathname.replace(/\/page\/\d+/i, `/page/${parseInt(m[1], 10) + 1}`); return u.toString(); }
    u.searchParams.set('page', '2');
    return u.toString();
  } catch { return null; }
}

/** Build the URL for page N given a base URL and a param style. */
export function pageUrl(baseUrl, n, style = 'page', pageSize = 24) {
  try {
    const u = new URL(baseUrl);
    if (style === 'offset') u.searchParams.set('offset', String((n - 1) * pageSize));
    else u.searchParams.set(style, String(n));
    return u.toString();
  } catch { return null; }
}
