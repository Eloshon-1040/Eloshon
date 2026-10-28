/**
 * GENERIC listing pagination — follow every page of a product list over free
 * HTTP, from signals any site may expose, never from a site name:
 *
 *   1. rel="next" (<link> or <a>), then a "next / suivant / volgende / weiter…" link;
 *   2. a page/offset URL parameter OBSERVED on the page (current URL or its links),
 *      each new page validated by its content (new products, not a repeat);
 *   3. an internal-API "next" URL found in the page's embedded JSON (next /
 *      nextPage / nextUrl…), with an announced total (totalResources / total…),
 *      resolved against the page origin then the API hosts the page itself
 *      declares (<link rel="preconnect|dns-prefetch"> on the same site);
 *   4. "load more" / infinite scroll with no deducible request → NOT guessed:
 *      reported as a limit.
 *
 * Stops (all enforced): no new product, announced total reached, product cap,
 * page cap, loop (same URL or same content again), error / block. Products are
 * deduplicated across pages. Returns a `memo` the recipe can store so the next
 * run goes straight to the working mechanism.
 */
import { relNext } from './pagination.mjs';
import { pageJsonPayloads } from '../shared/extract/product-group.mjs';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const lc = (s) => String(s).toLowerCase();
const PAGE_PARAMS = ['page', 'p', 'pg', 'pagenumber', 'paged', 'pageindex'];
const OFFSET_PARAMS = ['offset', 'start', 'from', 'skip', 'startindex'];
const NEXT_KEYS = ['next', 'nextpage', 'nexturl', 'nextpageurl', 'nextlink', 'nexthref', 'nextpagelink'];
const CURSOR_KEYS = ['nextcursor', 'endcursor', 'cursor', 'nextpagetoken', 'pagetoken', 'after', 'searchafter', 'continuationtoken'];
const TOTAL_KEYS = ['totalresources', 'totalresults', 'totalcount', 'totalitems', 'totalproducts', 'numberofresults', 'resultscount', 'resultcount', 'nbhits', 'hitcount', 'total', 'count'];
const TOTAL_PAGES_KEYS = ['totalpages', 'pagecount', 'numberofpages', 'nbpages', 'pagestotal'];
const NEXT_TEXT_RE = /^\s*(suivant(e)?|page suivante|next( page)?|volgende( pagina)?|weiter|nächste( seite)?|siguiente|successiva|›|»|>|→)\s*$/i;
const LOAD_MORE_RE = /(voir plus|charger plus|afficher plus|plus de produits|load more|show more|meer laden|toon meer|mehr laden|mehr anzeigen|cargar más|ver más)/i;

export const normUrl = (u) => { try { const x = new URL(u); x.hash = ''; return x.toString().replace(/\/$/, ''); } catch { return null; } };
const sameSite = (a, b) => { const tail = (h) => h.split('.').slice(-2).join('.'); try { return tail(new URL(a).hostname) === tail(new URL(b).hostname); } catch { return false; } };
const looksUrlish = (v) => typeof v === 'string' && v.length > 1 && v.length < 2000 && (/^https?:\/\//i.test(v) || (v.startsWith('/') && !v.startsWith('//')) || /^\?[^\s]+=/.test(v));

/** Pagination fields of one JSON object (direct keys or a pagination-like sub-object). */
function paginationFields(o) {
  if (!isObj(o)) return null;
  const sub = Object.keys(o).filter((k) => /^(pagination|paging|pagedata|pageinfo|pager|meta|links|page)$/i.test(k)).map((k) => o[k]).filter(isObj);
  const scopes = [o, ...sub];
  const pick = (keys, test) => { for (const s of scopes) for (const k of Object.keys(s)) if (keys.includes(lc(k)) && test(s[k])) return s[k]; return null; };
  const next = pick(NEXT_KEYS, looksUrlish);
  const cursor = pick(CURSOR_KEYS, (v) => (typeof v === 'string' && v && !looksUrlish(v)) || typeof v === 'number');
  const total = pick(TOTAL_KEYS, (v) => typeof v === 'number' && v > 0);
  const totalPages = pick(TOTAL_PAGES_KEYS, (v) => typeof v === 'number' && v > 0);
  const score = (next ? 3 : 0) + (cursor != null ? 1 : 0) + (total != null ? 1 : 0) + (totalPages != null ? 1 : 0);
  if (!next && cursor == null) return null; // a "next" handle is what makes it pagination
  return { next: next || null, cursor: cursor ?? null, total: total ?? null, totalPages: totalPages ?? null, score };
}

/** Best pagination object inside a JSON value. */
export function findJsonPagination(value) {
  let best = null; let visits = 0;
  const walk = (n, d) => {
    if (n == null || typeof n !== 'object' || d > 12 || ++visits > 40000) return;
    if (Array.isArray(n)) { for (const v of n) walk(v, d + 1); return; }
    const f = paginationFields(n);
    if (f && (!best || f.score > best.score)) best = f;
    for (const k of Object.keys(n)) walk(n[k], d + 1);
  };
  walk(value, 0);
  return best;
}

/** First <a> whose visible text is a "next" word, resolved against the page. */
function nextTextLink(html, pageUrl) {
  // The link's content may be an inline icon (an SVG of several hundred characters)
  // with the word only in aria-label: a wide window, stopped at the first `</a>`.
  const re = /<a\b([^>]*)>([\s\S]{0,3000}?)<\/a>/gi; let m;
  while ((m = re.exec(String(html)))) {
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').trim();
    const aria = (m[1].match(/aria-label=["']([^"']+)["']/i) || [])[1] || '';
    if (!NEXT_TEXT_RE.test(text) && !NEXT_TEXT_RE.test(aria)) continue;
    const href = (m[1].match(/href=["']([^"'#]+)["']/i) || [])[1];
    if (!href || /^javascript:/i.test(href)) continue;
    try { return new URL(href.replace(/&amp;/g, '&'), pageUrl).toString(); } catch { /* next */ }
  }
  return null;
}

/** A page/offset parameter observed on the current URL or on same-path links. */
function observedParam(html, pageUrl) {
  let base; try { base = new URL(pageUrl); } catch { return null; }
  for (const [k, v] of base.searchParams) {
    if (!/^\d+$/.test(v)) continue;
    if (PAGE_PARAMS.includes(lc(k))) return { param: k, kind: 'page', current: Number(v) };
    if (OFFSET_PARAMS.includes(lc(k))) return { param: k, kind: 'offset', current: Number(v) };
  }
  const re = /href=["']([^"'#]+)["']/gi; let m;
  while ((m = re.exec(String(html)))) {
    let u; try { u = new URL(m[1].replace(/&amp;/g, '&'), pageUrl); } catch { continue; }
    if (u.host !== base.host || u.pathname.replace(/\/$/, '') !== base.pathname.replace(/\/$/, '')) continue;
    for (const [k, v] of u.searchParams) {
      if (!/^\d+$/.test(v) || Number(v) < 2) continue;
      if (PAGE_PARAMS.includes(lc(k))) return { param: k, kind: 'page', current: 1 };
      if (OFFSET_PARAMS.includes(lc(k))) return { param: k, kind: 'offset', current: 0 };
    }
  }
  return null;
}

/** Same-site hosts the page declares (preconnect / dns-prefetch), API-looking first. */
export function declaredHosts(html, pageUrl) {
  const out = [];
  const re = /<link\b[^>]*rel=["'](?:preconnect|dns-prefetch)["'][^>]*>/gi; let m;
  while ((m = re.exec(String(html)))) {
    const href = (m[0].match(/href=["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    let o; try { o = new URL(href, pageUrl).origin; } catch { continue; }
    if (!sameSite(o, pageUrl) || out.includes(o)) continue;
    out.push(o);
  }
  return out.sort((a, b) => (/\/\/api[.-]/i.test(b) ? 1 : 0) - (/\/\/api[.-]/i.test(a) ? 1 : 0));
}

/**
 * Every pagination signal of a listing page.
 * @returns {{ relNext:string|null, nextLink:string|null, urlParam:object|null,
 *   api:{next:string|null,cursor:any,total:number|null,totalPages:number|null}|null,
 *   loadMore:boolean, hosts:string[], totalAnnounced:number|null }}
 */
export function detectPagination(html, pageUrl) {
  const rn = relNext(html);
  let rel = null; if (rn) { try { rel = new URL(rn.replace(/&amp;/g, '&'), pageUrl).toString(); } catch { rel = null; } }
  let api = null;
  for (const j of pageJsonPayloads(html).json) { const f = findJsonPagination(j); if (f && (!api || f.score > api.score)) api = f; }
  return {
    relNext: rel,
    nextLink: rel ? null : nextTextLink(html, pageUrl),
    urlParam: observedParam(html, pageUrl),
    api,
    loadMore: LOAD_MORE_RE.test(String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')),
    hosts: declaredHosts(html, pageUrl),
    totalAnnounced: api && api.total != null ? api.total : null,
  };
}

const keyOf = (c) => {
  const u = c.sourceUrl || c.canonicalUrl;
  if (u) { try { const x = new URL(u); x.hash = ''; return 'u:' + x.toString().replace(/\/$/, ''); } catch { /* fall through */ } }
  if (c.sku) return 's:' + c.sku;
  return `n:${c.name || ''}|${c.price ?? ''}`;
};

/** A short, safe error class from an API error body (code / message, no secret, ≤ 80 chars). */
function apiErrorClass(body) {
  try {
    const j = typeof body === 'string' ? JSON.parse(body) : body;
    const e = (Array.isArray(j && j.errors) && j.errors[0]) || (j && j.error) || j;
    const code = isObj(e) ? (e.code || e.type || e.message) : e;
    return code ? String(code).replace(/[^\w .:-]/g, '').slice(0, 80) : null;
  } catch { return null; }
}

/**
 * Follow a listing beyond page 1.
 * @param {{ entryUrl:string, firstHtml:string, firstCards:object[],
 *   extractCards:(html:string,url:string)=>object[],
 *   extractJsonCards?:(json:any,url:string)=>object[],
 *   fetchHtml:(url:string)=>Promise<{ok:boolean,html?:string,status?:number,blocked?:boolean}>,
 *   fetchJson?:(url:string)=>Promise<{ok:boolean,json?:any,status?:number,body?:string,blocked?:boolean}>,
 *   maxProducts?:number, maxPages?:number, memo?:object|null, onStep?:Function, isStopped?:()=>boolean,
 *   apiStart?:{ref:string}|null,
 *   discoverApiHeaders?:(o:{html,pageUrl,apiUrl,status,errorText})=>Promise<{found,headers,specs,summary?}|null>,
 *   resolveApiHeaders?:(specs:object)=>Promise<{headers:object|null,error?:string}> }} o
 *   `apiStart`: continue an API pagination from this request (absolute URL) instead of the page's own
 *   first "next" — e.g. right after what a browser already loaded. `fetchJson(url, headers?)` receives the
 *   API headers when some are known. `discoverApiHeaders` runs once, on a first request refused with
 *   400 / 401 / 403 (core/api-header-discovery.mjs); `resolveApiHeaders` re-reads the specs a previous
 *   run stored in the recipe (`memo.api_headers`).
 * @returns {Promise<{ cards:object[], pages:number, mechanism:string, totalAnnounced:number|null,
 *   stoppedBy:string, warnings:string[], detail:object|null, memo:object|null, apiNext:string|null,
 *   apiHeaders:object|null }>}  `apiHeaders`: where the API headers came from, names and counts only.
 */
export async function paginateListing(o) {
  const { entryUrl, firstHtml, extractCards, extractJsonCards, fetchHtml, fetchJson, onStep } = o;
  const maxProducts = o.maxProducts ?? 1000; const maxPages = Math.max(1, o.maxPages ?? 50);
  const isStopped = o.isStopped || (() => false);
  const step = (m, e) => { try { if (onStep) onStep(m, e || {}); } catch { /* never break */ } };
  const cards = []; const seen = new Set();
  const add = (list) => { let n = 0; for (const c of list || []) { if (cards.length >= maxProducts) break; const k = keyOf(c); if (seen.has(k)) continue; seen.add(k); cards.push(c); n++; } return n; };
  add(o.firstCards);
  const sig = (list) => (list || []).slice(0, 5).map(keyOf).join('|');
  const sig1 = sig(o.firstCards);

  const sg = detectPagination(firstHtml, entryUrl);
  const memo = isObj(o.memo) ? o.memo : null;
  let total = sg.totalAnnounced;
  const warnings = []; let detail = null;
  // Mechanism: a stored memo first (when its signal still applies), else by priority.
  let mechanism = 'none';
  const apiStart = o.apiStart && typeof o.apiStart.ref === 'string' && o.apiStart.ref ? o.apiStart : null;
  if (apiStart) mechanism = 'api-next';
  else if (memo && memo.mode === 'url-param' && memo.param) mechanism = 'url-param';
  else if (memo && memo.mode === 'api-next' && sg.api && sg.api.next) mechanism = 'api-next';
  else if (sg.relNext) mechanism = 'rel-next';
  else if (sg.nextLink) mechanism = 'next-link';
  else if (sg.urlParam) mechanism = 'url-param';
  else if (sg.api && sg.api.next) mechanism = 'api-next';
  let apiHeadersInfo = null; // names and counts only (report) — never a header value
  const result = (stoppedBy, pages, newMemo) => {
    if (total != null && cards.length < total && stoppedBy !== 'max_products') warnings.push('total_not_reached');
    if (mechanism === 'none' && (sg.loadMore || (sg.api && sg.api.cursor != null))) warnings.push('scroll_not_followable');
    return { cards, pages, mechanism, totalAnnounced: total, stoppedBy, warnings: [...new Set(warnings)], detail, memo: newMemo, apiNext: (sg.api && sg.api.next) || null, apiHeaders: apiHeadersInfo };
  };
  const capStop = (pages) => {
    if (cards.length >= maxProducts) return 'max_products';
    if (total != null && cards.length >= total) return 'total_reached';
    if (pages >= maxPages) return 'max_pages';
    if (isStopped()) return 'stopped';
    return null;
  };
  if (mechanism === 'none') return result(capStop(1) || 'no_pagination', 1, null);

  // ---- HTML modes: rel-next / next-link / url-param ----
  if (mechanism !== 'api-next') {
    const seenUrls = new Set([normUrl(entryUrl)]);
    const up = mechanism === 'url-param' ? (memo && memo.mode === 'url-param' ? { param: memo.param, kind: memo.kind || 'page', current: sg.urlParam && sg.urlParam.param === memo.param ? sg.urlParam.current : (memo.kind === 'offset' ? 0 : 1) } : sg.urlParam) : null;
    const pageSize = Math.max(1, (o.firstCards || []).length);
    let pages = 1; let html = firstHtml; let current = up ? up.current : null; let prevSig = sig1;
    const memoOut = mechanism === 'url-param' ? { mode: 'url-param', param: up.param, kind: up.kind } : { mode: mechanism };
    for (;;) {
      const stop = capStop(pages); if (stop) return result(stop, pages, memoOut);
      let next = null;
      if (mechanism === 'rel-next') { const r = relNext(html); if (r) { try { next = new URL(r.replace(/&amp;/g, '&'), entryUrl).toString(); } catch { next = null; } } }
      else if (mechanism === 'next-link') next = nextTextLink(html, entryUrl);
      else { try { const u = new URL(entryUrl); current = up.kind === 'offset' ? current + pageSize : current + 1; u.searchParams.set(up.param, String(current)); next = u.toString(); } catch { next = null; } }
      if (!next) return result('no_next', pages, memoOut);
      const nk = normUrl(next);
      if (seenUrls.has(nk)) return result('loop', pages, memoOut);
      seenUrls.add(nk);
      let res; try { res = await fetchHtml(next); } catch (e) { res = { ok: false }; }
      if (!res || !res.ok || !res.html) { detail = { status: (res && res.status) || 0 }; return result(res && res.blocked ? 'blocked' : 'error', pages, memoOut); }
      const got = extractCards(res.html, next) || [];
      const s = sig(got);
      if (got.length && (s === prevSig || s === sig1)) return result('loop', pages, memoOut);
      const fresh = add(got);
      pages += 1; html = res.html; prevSig = s;
      step('paginate', { page: pages, found: cards.length });
      if (!fresh) return result('no_new_products', pages, memoOut);
    }
  }

  // ---- API mode: follow the embedded "next" request over HTTP ----
  if (typeof fetchJson !== 'function' || typeof extractJsonCards !== 'function') return result('no_api_client', 1, null);
  let pageOrigin; try { pageOrigin = new URL(entryUrl).origin; } catch { pageOrigin = null; }
  const hosts = memo && memo.mode === 'api-next' && memo.api_host ? [memo.api_host] : [pageOrigin, ...sg.hosts].filter(Boolean).slice(0, 3);
  const resolve = (ref, host) => { try { return /^https?:\/\//i.test(ref) ? ref : new URL(ref, host).toString(); } catch { return null; } };
  // Request headers the API needs (the site's own code sends them; the plain
  // request is refused without them). Two free sources, both injected:
  //   • the recipe's stored specs (`memo.api_headers`, { from, pattern } per name),
  //     re-read from the site's public script by `resolveApiHeaders`;
  //   • on a refusal, `discoverApiHeaders` reads the page's public scripts for a
  //     static header written next to the API path (core/api-header-discovery.mjs).
  // Values live in memory for this run; the recipe keeps WHERE to read them.
  let apiHeaders = null; let headerSpecs = null;
  const memoSpecs = memo && memo.mode === 'api-next' && isObj(memo.api_headers) && Object.keys(memo.api_headers).length ? memo.api_headers : null;
  if (memoSpecs && typeof o.resolveApiHeaders === 'function') {
    let r = null; try { r = await o.resolveApiHeaders(memoSpecs); } catch (e) { r = { error: String((e && e.message) || e) }; }
    if (r && r.headers && Object.keys(r.headers).length) { apiHeaders = r.headers; headerSpecs = memoSpecs; apiHeadersInfo = { source: 'recipe', found: true, names: Object.keys(r.headers) }; }
    else apiHeadersInfo = { source: 'recipe', found: false, names: Object.keys(memoSpecs), error: String((r && r.error) || 'unresolved').slice(0, 120) };
  }
  const memoOut = (host) => (host ? { mode: 'api-next', api_host: host, ...(headerSpecs ? { api_headers: headerSpecs } : {}) } : null);
  const isRefusal = (r) => !!(r && [400, 401, 403].includes(Number(r.status)));
  // One attempt of a "next" ref over the candidate hosts: { ok, last, refusedUrl }.
  const attempt = async (ref, host) => {
    const tries = host ? [host] : (/^https?:\/\//i.test(ref) ? [null] : hosts);
    let ok = null; let last = null; let refusedUrl = null;
    for (const h of tries) {
      const url = h ? resolve(ref, h) : ref; if (!url) continue;
      let r; try { r = await fetchJson(url, apiHeaders || undefined); } catch { r = { ok: false }; }
      last = r;
      if (r && r.ok && r.json != null) {
        const got = extractJsonCards(r.json, entryUrl) || [];
        if (got.length) { ok = { r, got, h: h || (() => { try { return new URL(url).origin; } catch { return null; } })() }; break; }
      }
      if (!refusedUrl && isRefusal(r)) refusedUrl = url;
      if (r && r.blocked) break;
    }
    return { ok, last, refusedUrl };
  };
  let ref = apiStart ? apiStart.ref : sg.api.next; let host = null; let pages = 1; const seenRefs = new Set();
  let discoveryTried = false;
  for (;;) {
    const stop = capStop(pages); if (stop) return result(stop, pages, memoOut(host));
    if (!ref) return result('no_next', pages, memoOut(host));
    if (seenRefs.has(ref)) return result('loop', pages, memoOut(host));
    seenRefs.add(ref);
    let { ok, last, refusedUrl } = await attempt(ref, host);
    // First request refused (400 / 401 / 403) and no header yet: look for the one the
    // page's own scripts send, once, then retry the same request with it.
    if (!ok && pages === 1 && !apiHeaders && refusedUrl && !discoveryTried && typeof o.discoverApiHeaders === 'function') {
      discoveryTried = true;
      let d = null;
      try { d = await o.discoverApiHeaders({ html: firstHtml, pageUrl: entryUrl, apiUrl: refusedUrl, status: last && last.status, errorText: last ? apiErrorClass(last.json != null ? last.json : last.body) : null }); } catch { d = null; }
      apiHeadersInfo = { source: 'public-js', ...(d && d.summary ? d.summary : { found: !!(d && d.found), names: Object.keys((d && d.headers) || {}) }) };
      if (d && d.found && d.headers && Object.keys(d.headers).length) {
        apiHeaders = d.headers; headerSpecs = isObj(d.specs) && Object.keys(d.specs).length ? d.specs : null;
        ({ ok, last, refusedUrl } = await attempt(ref, host));
        apiHeadersInfo.retried = true; apiHeadersInfo.accepted = !!ok;
        if (!ok) { apiHeaders = null; headerSpecs = null; } // the found header did not open the API: nothing is stored
      }
    }
    if (!ok) {
      detail = { status: (last && last.status) || 0, error: last ? apiErrorClass(last.json != null ? last.json : last.body) : null };
      warnings.push(pages === 1 ? 'api_refused' : 'api_stopped');
      if (pages === 1) warnings.push('scroll_not_followable');
      return result(pages === 1 ? 'api_refused' : 'error', pages, memoOut(host));
    }
    host = host || ok.h;
    const s = sig(ok.got);
    if (s === sig1) return result('loop', pages, memoOut(host));
    const fresh = add(ok.got);
    pages += 1;
    step('paginate', { page: pages, found: cards.length });
    const f = findJsonPagination(ok.r.json);
    if (total == null && f && f.total != null) total = f.total;
    if (!fresh) return result('no_new_products', pages, memoOut(host));
    ref = f && f.next ? f.next : null;
  }
}
