/**
 * Automatic product-URL discovery from a shop URL. Product-oriented crawl:
 *
 *   shop URL → sitemap/index → product URLs
 *            → (if insufficient) categories/listings → pagination → product URLs
 *            → dedup
 *
 * Reuses sitemap.mjs (sitemaps), pagination.mjs (rel=next), detect.mjs
 * (stop on protection), url-utils.mjs (dedup/host). Never crawls legal/account/
 * cart/checkout/login/support/blog. Hard guardrails prevent infinite crawls.
 */
import { parseHTML } from 'linkedom';
import { classifyResponse } from './detect.mjs';
import { discoverFromSitemaps } from './sitemap.mjs';
import { scopeLinks } from './link-scope.mjs';
import { relNext, nextPageUrl } from './pagination.mjs';
import { parseRobots } from './robots.mjs';
import { absoluteUrl, dedupKey, sameHost, originOf, cleanUrl, registrableHost } from './url-utils.mjs';
import { classifyUrl, detectLocale, normalizeHost, KNOWN_LANG, isNestedCategoryTrail } from './url-context.mjs';
import { recoverDiscovery } from './discover-recovery.mjs';
import { extractListing } from './listing.mjs';
import { parseMoney } from './dom-fallback.mjs';
import { readerFor, VIDEO_READER } from './content-reader.mjs';
import { detectContentType } from '../shared/content/detect.mjs';
import { normalizeContentType } from '../shared/content/profiles.mjs';
import { createComplementScope } from './complement-scope.mjs';

// Binary/asset URLs — never fetch.
export const ASSET_RE = /\/cdn-cgi\/|\.(pdf|jpe?g|png|gif|webp|svg|css|js|zip|mp4|avif|ico|woff2?)(\?|$)/i;
// Non-catalogue sections — never crawl (keyword may be a segment prefix, e.g.
// "conditions-generales"). Checked AFTER product detection so a product slug
// that merely contains such a word (e.g. /product/contact-lens) is not dropped.
export const SECTION_RE = /\/(conditions?|mentions|legal|privacy|confidential|cookies?|rgpd|gdpr|account|mon-compte|compte|panier|cart|checkout|caisse|login|log-in|signin|sign-in|connexion|register|inscription|support|contact|help|aide|faq|blog|news|actualites|about|a-propos|wishlist|favoris|jobs|carrieres?|press|presse|newsletter|store-locator|magasins)([-/?]|$)/i;
// Combined (used for classification/tests).
export const SKIP_RE = new RegExp(`(${ASSET_RE.source})|(${SECTION_RE.source})`, 'i');
// A product detail page. The bare `/p/` token (used by many shops for
// `/p/<slug>`) excludes well-known CONTENT sub-paths that also live under `/p/`
// on some sites (e.g. AliExpress `/p/wiki/`, `/p/video/`) so a help/guide page
// is never mistaken for a product. Generic denylist, not site-specific.
export const PRODUCT_RE = /(\/product\/|\/produit\/|\/products\/|\/produits\/[a-z0-9]|\/p\/(?!(?:wiki|video|guide|help|about|blog|faq|page|content|info|news|story|lookbook)\/)|-p-\d|\/dp\/|\/item\/|\/artikel\/|\/pd\/)/i;
// A category/listing/collection page (crawl deeper).
export const LISTING_RE = /(\/category\/|\/categorie|\/categories\/|\/collection|\/collections\/|\/c\/|\/shop\b|\/boutique|\/catalog|\/rayon|\/assortiment|\/gamme)/i;
/**
 * A link the crawl may queue AS A PRODUCT: PRODUCT_RE says product AND the
 * nested-category-trail veto does not re-read it as a category tree
 * (colruyt.be's /fr/produits/toutes-les-categories/boissons matches
 * PRODUCT_RE's /produits/ marker but is a listing, never a fiche).
 */
export function isProductLink(url) { return PRODUCT_RE.test(url) && !isNestedCategoryTrail(url); }
// A pagination link (same listing, next page).
export const PAGE_RE = /([?&](page|p|start|offset|from)=\d+)|(\/page\/\d+)/i;
// Query-string parameters that never carry a product FILTER (pagination, page size,
// sort/view, locale/currency, tracking). Everything else on a listing URL is a facet
// the user chose. Generic denylist (data), shared in spirit with shared/internal-api.
const NON_FACET_PARAM = /^(page|p|pg|pagenumber|paged|pageindex|pagenum|pagina|seite|offset|start|from|skip|startindex|begin|size|limit|perpage|per_page|pagesize|page_size|count|rows|take|sort|order|orderby|sortby|sort_by|tri|view|display|mode|layout|affichage|lang|language|locale|hl|gl|currency|cur|country|utm_[a-z]+|gclid|gbraid|wbraid|fbclid|msclkid|mc_cid|mc_eid|ref|ref_|referrer|source|igshid|yclid|dclid|spm|cmpid)$/i;
/** Facet filters carried by a URL's query string: { key(lower): value }. */
function facetsOf(u) { const o = {}; try { for (const [k, v] of new URL(u).searchParams) if (v && !NON_FACET_PARAM.test(k)) o[k.toLowerCase()] = v; } catch { /* no url */ } return o; }
/**
 * A link to another page of THIS listing whatever its parameter is called
 * ("?currentPage=2", "?pageNumber=3", "?pg=2"): same path, and the query differs
 * from the current page's by one parameter whose value is a number.
 */
export function samePagePagination(link, pageUrl) {
  try {
    const a = new URL(link); const b = new URL(pageUrl);
    if (a.origin !== b.origin || a.pathname.replace(/\/+$/, '') !== b.pathname.replace(/\/+$/, '')) return false;
    const keys = new Set([...a.searchParams.keys(), ...b.searchParams.keys()]);
    const diff = [...keys].filter((k) => a.searchParams.get(k) !== b.searchParams.get(k));
    return diff.length === 1 && /^\d{1,4}$/.test(a.searchParams.get(diff[0]) || '') && /page|^p$|^pg$|^pn$|offset|start|from|skip/i.test(diff[0]) && !/size|count|limit|per|total/i.test(diff[0]);
  } catch { return false; }
}

function extractLinks(html, baseUrl) {
  const out = [];
  const re = /<a\b[^>]*href=["']([^"'#\s]+)["']/gi;
  let m;
  while ((m = re.exec(html))) { const abs = absoluteUrl(m[1], baseUrl); if (abs) out.push(abs); }
  return out;
}

/**
 * Collection scoping shared by every harvest point (HTTP crawl, rendered
 * listing, engine reclassification, unlocked HTML, probe). Order per page:
 * learned link_filter recipe > confident grid heuristic > current behaviour
 * (fail-open). Graduated v1 decision: an excluded product link is NOT queued
 * but IS counted (report.scopedOut + up to 10 report.scopedOutSamples), so the
 * filter can be tightened after telemetry. Anti-emptying guard: scoping that
 * would zero a page which exposed ≥3 product links keeps the current behaviour
 * (report.scopeFallback++) — same philosophy as the language filter in finish().
 * @param {string} html
 * @param {string} baseUrl
 * @param {string[]} productLinks  absolute product-candidate URLs on this page
 * @param {{ linkFilter?:object|null, report?:object }} [opts]
 * @returns {{ keep:Set<string>|null, scope:object|null, learnedApplied:boolean }}
 *   keep — dedupKey set to keep; null = no scoping applied (keep everything).
 */
export function scopeProductLinks(html, baseUrl, productLinks, { linkFilter, report } = {}) {
  let learned;
  if (linkFilter && (linkFilter.container || (Array.isArray(linkFilter.url_templates) && linkFilter.url_templates.length))) {
    // A url-templates-only recipe (container:null) rides the module's documented
    // dead-container fallback: a never-matching tag engages templates-only scoping.
    learned = linkFilter.container ? linkFilter : { ...linkFilter, container: 'x-eloshon-none' };
  }
  let scope = null;
  try { scope = scopeLinks(html || '', baseUrl, { productReSource: PRODUCT_RE.source, learned }); } catch { scope = null; }
  if (!scope || !scope.confident) return { keep: null, scope: null, learnedApplied: false };
  // Learned modes are recognisable: container matched verbatim, or the
  // templates-only fallback (no grid selector, no cards). A heuristic win over a
  // dead container is NOT the recipe being applied — its outcome must not be
  // attributed to the filter.
  const learnedApplied = !!(learned && ((linkFilter.container && scope.gridSelector === linkFilter.container)
    || (!scope.gridSelector && scope.cardCount === 0)));
  const keep = new Set();
  const dropped = [];
  const seen = new Set();
  for (const u of productLinks || []) {
    const k = dedupKey(u);
    if (seen.has(k)) continue;
    seen.add(k);
    if (scope.classify(u) === 'in_grid') keep.add(k); else dropped.push(u);
  }
  if (report && learnedApplied) report.linkFilterUsed = (report.linkFilterUsed || 0) + 1;
  if (!keep.size && seen.size >= 3) {
    if (report) {
      report.scopeFallback = (report.scopeFallback || 0) + 1;
      if (learnedApplied) report.linkFilterEmptied = (report.linkFilterEmptied || 0) + 1;
    }
    return { keep: null, scope, learnedApplied };
  }
  if (report) {
    if (learnedApplied) report.linkFilterKept = (report.linkFilterKept || 0) + keep.size;
    if (dropped.length) {
      report.scopedOut = (report.scopedOut || 0) + dropped.length;
      const samples = (report.scopedOutSamples = report.scopedOutSamples || []);
      for (const u of dropped) { if (samples.length >= 10) break; if (!samples.includes(u)) samples.push(u); }
    }
  }
  return { keep, scope, learnedApplied };
}

/**
 * dedupKeys of the links living under a navigation/peripheral zone — the SAME
 * S4 definition as link-scope.mjs (nav/header/footer/aside/[role=navigation]/
 * breadcrumb). Used by scopeToCollection to keep body sub-category links while
 * excluding chrome ones. Fail-open: an unparseable/oversized page returns an
 * empty set (nothing excluded).
 */
function navZoneLinkKeys(html, baseUrl) {
  const keys = new Set();
  if (!html || html.length > 3 * 1024 * 1024) return keys;
  let document;
  try { ({ document } = parseHTML(html)); } catch { return keys; }
  const inNav = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const tag = n.tagName;
      if (tag === 'NAV' || tag === 'HEADER' || tag === 'FOOTER' || tag === 'ASIDE') return true;
      if (!n.getAttribute) continue;
      if ((n.getAttribute('role') || '').toLowerCase() === 'navigation') return true;
      if (/breadcrumb/i.test(n.getAttribute('class') || '') || /breadcrumb/i.test(n.getAttribute('aria-label') || '')) return true;
    }
    return false;
  };
  for (const a of document.querySelectorAll('a[href]')) {
    if (!inNav(a)) continue;
    const abs = absoluteUrl(a.getAttribute('href'), baseUrl);
    if (abs) keys.add(dedupKey(abs));
  }
  return keys;
}

/**
 * @param {import('./http-fetcher.mjs').Fetcher} fetcher
 * @param {string} shopUrl
 * @param {{ maxProducts?:number, maxPages?:number, maxDepth?:number, sitemapMin?:number,
 *          getBrowser?:()=>Promise<object|null>, maxBrowserPages?:number,
 *          recovery?:boolean, recoveryMaxAttempts?:number, device?:'auto'|'desktop'|'mobile',
 *          onRecovery?:(info:object)=>void,
 *          linkFilter?:object|null, scopeToCollection?:boolean }} [opts]
 *   `recovery` (opt-in, OFF by default) lets a BLOCKED catalogue fetch try
 *   alternative representations before giving up (see discover-recovery.mjs);
 *   `onRecovery` receives the explainable trace. OFF → behaviour is unchanged.
 *   `linkFilter` — learned link_filter recipe (domain profile / shared recipes);
 *   `scopeToCollection` (default true) — with a specific listing URL and a found
 *   grid, deeper LISTING links are kept from the page body only (nav excluded).
 * @returns {Promise<{ urls:string[], report:object }>}
 */
export async function discoverProducts(fetcher, shopUrl, opts = {}) {
  const origin = originOf(shopUrl) || shopUrl;
  const maxProducts = opts.maxProducts ?? 500;
  const maxPages = opts.maxPages ?? 150;
  const maxDepth = opts.maxDepth ?? 3;
  const sitemapMin = opts.sitemapMin ?? 5;
  const report = { method: null, httpProductUrls: 0, browserProductUrls: 0, pagesCrawled: 0, listingsCrawled: 0, browserPagesRendered: 0, productUrls: 0, notes: [], stopped: null };
  // The content type's reader (core/content-reader.mjs): what an item link looks
  // like, what a listing link looks like, what a page lists. Products by default;
  // the video reader when the run collects videos. Never a site rule.
  // "auto": start as products and switch to the video reader as soon as the site
  // says so — a video sitemap (≥ 3 entries) or the entry page's own signals.
  const autoType = normalizeContentType(opts.contentType) === 'auto';
  let reader = readerFor(opts.contentType);
  const isItemLink = (u) => reader.isItemLink(u);
  const isListingLink = (u) => reader.isListingLink(u);
  const readCards = (html, base) => reader.cards(html, base);
  report.contentType = reader.id;
  const adoptReader = (type, how) => { reader = readerFor(type); report.contentType = reader.id; report.contentTypeDetected = how; report.notes.push(`content type recognised: ${reader.id} (${how.by})`); };
  const recogniseOnPage = (html, url) => {
    if (!autoType || reader.id !== 'product' || !html) return;
    const det = detectContentType(html, url);
    if (det.type === 'video') adoptReader('video', { by: 'page', signals: det.signals });
  };
  // Keyed by canonical dedupKey so HTTP + browser results never duplicate.
  const products = new Map();
  const addProduct = (u) => { const k = dedupKey(u); if (!products.has(k)) products.set(k, u); };
  // Card data harvested from listing pages, keyed by dedupKey(url) → partial
  // RawProduct. The engine uses these to seed/enrich the product fiche.
  const seeds = new Map();
  // Cards the listing states with a price and an id but NO link of their own (the
  // page's data names the entity, the page routes by script): kept as products read
  // from the listing itself — there is no page to fetch for them. Keyed by id.
  const noUrlCards = new Map();
  const noteCardWithoutUrl = (card) => {
    if (!card || card.price == null || !(card.sku || card.gtin) || noUrlCards.size >= maxProducts) return;
    const k = `id:${card.gtin || card.sku}`;
    if (!noUrlCards.has(k)) noUrlCards.set(k, card);
  };
  // The entry page already fetched — by the caller (content-type recognition) or by
  // the home-page probe below — reused by the crawl: one request for the entry.
  let prefetched = (opts.prefetched && opts.prefetched.r && opts.prefetched.url && dedupKey(opts.prefetched.url) === dedupKey(shopUrl)) ? { url: shopUrl, r: opts.prefetched.r } : null;

  // ── 0) What the PROVIDED URL already tells us (generic, no network) ──────
  // The pasted URL — its path type AND its locale — is the starting point, never
  // silently replaced by a whole-site sitemap (that is how a Belgian-French
  // collection ended up returning a Dutch page / an off-category product).
  const ctx = classifyUrl(shopUrl);
  const loc = detectLocale(shopUrl);
  report.context = { pageType: ctx.type, host: normalizeHost(shopUrl), language: loc.language, country: loc.country, localeSource: loc.source };
  if (!report.context.country) {
    const tld = (report.context.host.split('.').pop() || '').toUpperCase();
    if (/^[A-Z]{2}$/.test(tld) && tld !== 'CO') { report.context.country = tld; report.context.countrySource = 'ccTLD'; }
  }
  // A language is a whole path segment ("/fr/", "/fr-be/", "/be_fr/") or a host label ("fr.shop.be") —
  // never a word inside a slug: "eau-de-parfum" is not German, "met-collageen-en-peptiden" not English
  // (that mistake dropped most perfume pages of a French listing).
  const langsIn = (u) => {
    try {
      const url = new URL(u); const out = [];
      const tag = (seg) => { const m = String(seg).toLowerCase().match(/^([a-z]{2})(?:[-_]([a-z]{2}))?$/); if (!m) return; for (const x of [m[1], m[2]]) if (x && KNOWN_LANG.has(x)) out.push(x); };
      for (const seg of url.pathname.split('/')) tag(seg);
      tag(url.hostname.split('.')[0]);
      return out;
    } catch { return []; }
  };
  const localeOk = (u, lang) => { const ls = langsIn(u); return ls.length === 0 || ls.includes(lang); };
  // FACET filters the ENTRY URL carries (a sub-category, a brand… — any query param
  // that is not pagination/sort/locale/tracking). A later page whose FINAL url drops
  // or changes one was clamped OUT of the filter (an out-of-range page served the
  // unfiltered list): its products are not harvested. Generic, driven by the URL, no
  // site name. The query-param names below are a stable, generic denylist (data).
  const entryFacets = facetsOf(shopUrl);
  const entryFacetKeys = Object.keys(entryFacets);
  const droppedEntryFacet = (finalUrl) => { if (!entryFacetKeys.length || !finalUrl) return false; const f = facetsOf(finalUrl); return entryFacetKeys.some((k) => f[k] == null || f[k] !== entryFacets[k]); };
  // Single finish path: language-filter (never emptying — req #3), then return.
  const finish = (methodOverride) => {
    if (methodOverride) report.method = methodOverride;
    let urls = [...products.values()];
    // A listing under "/fr/…" whose page data names products without the language segment ("/dior/…"): the
    // site serves those in its default language (a French collection came back in Dutch). When the site's own
    // product links carry the listing's segment, the bare ones get it too (a bare duplicate of a tagged link is dropped).
    try {
      const entry = new URL(shopUrl); const seg = (entry.pathname.split('/')[1] || '');
      const segLangs = langsIn(`${entry.origin}/${seg}/`);
      if (loc.language && segLangs.includes(loc.language)) {
        const host = entry.hostname.replace(/^www\./, '');
        const sameHost = (x) => x.hostname.replace(/^www\./, '') === host;
        const tagged = urls.filter((u) => { try { const x = new URL(u); return sameHost(x) && x.pathname.split('/')[1] === seg; } catch { return false; } });
        if (tagged.length) {
          const have = new Set(urls.map(dedupKey)); const out = [];
          for (const u of urls) {
            let x; try { x = new URL(u); } catch { out.push(u); continue; }
            if (!sameHost(x) || langsIn(u).length) { out.push(u); continue; }
            x.pathname = `/${seg}${x.pathname}`; const loc2 = x.toString();
            const seed = seeds.get(dedupKey(u));
            if (seed && !seeds.has(dedupKey(loc2))) { seeds.set(dedupKey(loc2), { ...seed, ...(seed.sourceUrl === u ? { sourceUrl: loc2, canonicalUrl: loc2 } : {}) }); }
            if (have.has(dedupKey(loc2))) continue; // the tagged link is already listed
            have.add(dedupKey(loc2)); out.push(loc2);
            report.localizedUrls = (report.localizedUrls || 0) + 1;
          }
          urls = out;
          if (report.localizedUrls) report.notes.push(`${report.localizedUrls} product URL(s) without the listing's language segment given "/${seg}/"`);
        }
      }
    } catch { /* keep the URLs as found */ }
    if (loc.language && urls.length) {
      const kept = urls.filter((u) => localeOk(u, loc.language));
      if (kept.length > 0) { urls = kept; report.context.languageFilter = 'applied'; }
      else {
        report.context.languageFilter = 'skipped-would-empty';
        report.context.languageWarning = `Aucune URL produit ne correspond à la langue « ${loc.language} » — autres langues proposées.`;
        report.context.availableLanguages = [...new Set(urls.flatMap((u) => langsIn(u)))];
      }
    }
    // Scoping visibility (report/logs only, never the renderer): abandoned URLs
    // are counted with samples, one note line per run.
    if (report.scopedOut) report.notes.push(`collection scope: ${report.scopedOut} off-grid link(s) not queued (samples in report.scopedOutSamples)`);
    if (report.scopeFallback) report.notes.push(`collection scope: fail-open kept ${report.scopeFallback} page(s) that scoping would have emptied`);
    report.productUrls = urls.length;
    const cardsWithoutUrl = [...noUrlCards.values()].slice(0, Math.max(0, maxProducts - Math.min(urls.length, maxProducts)));
    report.cardsWithoutUrl = cardsWithoutUrl.length;
    if (cardsWithoutUrl.length) report.notes.push(`${cardsWithoutUrl.length} card(s) read from the listing page itself (an id and a price, no page link)`);
    return { urls: urls.slice(0, maxProducts), report, seeds, cardsWithoutUrl };
  };

  // req #2 — a product fiche URL is analysed directly, without the sitemap.
  if (ctx.type === 'product') {
    report.diagnosis = 'ok';
    addProduct(cleanUrl(shopUrl));
    return finish('direct-product');
  }
  // req #1 — a specific listing/category/search URL leads discovery; a bare
  // home/root URL keeps the historical sitemap-first path.
  let pathLen = 1;
  try { pathLen = new URL(shopUrl).pathname.replace(/\/+$/, '').length; } catch { /* */ }
  let startFromUrl = ctx.type === 'collection' || ctx.type === 'search' || (ctx.type === 'unknown' && pathLen > 1);
  const scopeToCollection = opts.scopeToCollection !== false;
  let entryScope = null; // scoping result of the pasted listing page (depth 0) — drives the sitemap complement

  // Real-progress channel (opt-in): fed by the ACTUAL discovery steps so the UI
  // shows what the engine is doing instead of a frozen "0/0". Never throws.
  const step = (message, extra) => { try { if (opts.onStep) opts.onStep(message, extra || {}); } catch { /* never break discovery */ } };

  // ── 1) Sitemaps ─────────────────────────────────────────────────────────
  step('analyze');
  const robotsRes = await fetcher.get(`${origin}/robots.txt`);
  const robots = robotsRes.ok ? parseRobots(robotsRes.body) : null;
  report.robotsSitemaps = robots?.sitemaps || [];
  // Domain-profile hints (opts.sitemapHints) are ADDITIVE, tried first — a stale
  // hint costs at most one extra sitemap fetch, never correctness.
  const sm = await discoverFromSitemaps(fetcher, origin, {
    max: maxProducts, hint: [...(opts.sitemapHints || []), ...(robots?.sitemaps || [])],
    looksLike: reader.sitemap ? reader.sitemap.looksLike : undefined,
    // "auto": a video sitemap's entries are read whatever the current reader.
    parseEntries: reader.sitemap ? reader.sitemap.parseEntries : (autoType ? VIDEO_READER.sitemap.parseEntries : undefined),
  });
  report.notes.push(...sm.notes);
  if (autoType && reader.id === 'product' && (sm.entries || []).length >= 3) adoptReader('video', { by: 'sitemap', entries: sm.entries.length });
  // Items the sitemap describes itself (a video sitemap): known items whatever their
  // URL shape, with their cards as seeds.
  const knownItems = new Set();
  for (const e of sm.entries || []) {
    if (!e || !e.url) continue;
    const k = dedupKey(e.url); knownItems.add(k);
    if (e.card && !seeds.has(k)) seeds.set(k, e.card);
  }
  // The nested-category-trail veto also applies here: a category-tree URL in a
  // sitemap is never a fiche, and the sitemap complement must not pour the
  // whole category tree into the product set (colruyt.be).
  const sitemapUrls = sm.urls.filter((u) => !SKIP_RE.test(u) && !isNestedCategoryTrail(u));
  step(sitemapUrls.length ? 'sitemap' : 'noSitemap', { n: sitemapUrls.length });
  // A HOME page that is itself a listing (rows / carousels of priced cards) is read
  // from the page, never replaced by a whole-site sitemap whose URLs are hub or
  // landing pages. Probed only when the sitemap URLs look like no product page at
  // all — a shop whose sitemap lists its products keeps the sitemap-first path.
  if (!startFromUrl && ctx.type === 'home' && sitemapUrls.filter((u) => isItemLink(u) || knownItems.has(dedupKey(u))).length < sitemapMin) {
    const r0 = prefetched ? prefetched.r : await fetcher.get(shopUrl);
    prefetched = { url: shopUrl, r: r0 };
    if (r0 && r0.ok && r0.body) {
      recogniseOnPage(r0.body, r0.url || shopUrl);
      const priced = readCards(r0.body, r0.url || shopUrl).cards.filter((c) => reader.cardIsItem(c));
      if (priced.length >= sitemapMin) {
        startFromUrl = true;
        report.entryListing = priced.length;
        report.notes.push(`entry page lists ${priced.length} priced card(s): read as a listing (sitemap kept as a complement)`);
      }
    }
  }
  if (!startFromUrl) {
    for (const u of sitemapUrls) { addProduct(u); if (products.size >= maxProducts) break; }
    if (products.size >= sitemapMin) {
      report.diagnosis = 'ok';
      return finish('sitemap');
    }
  }

  // ── 2) Crawl categories/listings → pagination → product URLs ────────────
  report.method = products.size ? 'sitemap+crawl' : 'crawl';
  const visited = new Set([dedupKey(shopUrl)]);
  const queue = [{ url: shopUrl, depth: 0 }];
  let noNewStreak = 0;

  // Host allow-list for crawled links. Seeded with the shop origin; when recovery
  // rebases the crawl onto an alternative representation (e.g. an `m.`/apex twin),
  // that twin's host is added so its product links survive the same-host filter.
  // With one host it is exactly equivalent to the previous `sameHost(link, origin)`.
  const hostKey = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const allowedHosts = new Set([hostKey(origin)]);
  const hostAllowed = (link) => { const h = hostKey(link); return !!h && allowedHosts.has(h); };
  // PRODUCT URLs may live on a locale/region subdomain of the same registrable
  // domain (nl.aliexpress.com off www.aliexpress.com, fr./m. twins). Accept those
  // as products — but NOT for crawl decisions, so we never start crawling sibling
  // subdomains (blog./support./help.). hostAllowed stays strict for the queue.
  const allowedRegs = new Set([registrableHost(hostKey(origin))]);
  const productHostOk = (link) => { const h = hostKey(link); return !!h && (allowedHosts.has(h) || allowedRegs.has(registrableHost(h))); };
  let recoveryUsed = false; // discovery recovery is attempted at most once per run
  // Escalation verdict from discovery recovery, gating the browser fallback below:
  //   null      → recovery never ran (no terminal block; historical CSR case)
  //   'browser' → recovery asked to escalate to the browser
  //   'none'    → recovery ran and judged a browser would NOT help
  let recoveryBrowserAdvice = null;

  // Observations for an honest end-of-run diagnosis (never collapse everything to
  // "none-found"). Each distinguishes one of the user-visible failure classes:
  //   blocked (#5) · needs-browser (#3) · structured-undetected (#4) ·
  //   no-signal (#1) · insufficient-discovery (#2).
  let anyPageOk = false;        // at least one catalogue page fetched with a body → site reachable
  let sawStructured = false;    // a page carried product structured data we did NOT turn into URLs (#4)
  let sawCsrShell = false;      // an OK page looked like an unhydrated SPA shell (few links, no data) (#3)

  while (queue.length && products.size < maxProducts && report.pagesCrawled < maxPages) {
    // A pasted listing: its own next pages come before any neighbouring category, so
    // the collection asked for is read first (a promo banner's collection never
    // fills the product cap ahead of page 2).
    const pgAt = startFromUrl ? queue.findIndex((q) => q.pg) : -1;
    const { url, depth } = pgAt > 0 ? queue.splice(pgAt, 1)[0] : queue.shift();
    let r = (prefetched && dedupKey(prefetched.url) === dedupKey(url)) ? prefetched.r : await fetcher.get(url);
    prefetched = null;
    report.pagesCrawled++;
    step('crawl', { page: report.pagesCrawled, found: products.size });

    let resp = classifyResponse({ status: r.status, url: r.url, requestedUrl: url, body: r.body, error: r.error, headers: r.headers });
    if (resp.terminal) {
      // Discovery recovery (opt-in via opts.recovery; OFF → this block is skipped,
      // so behaviour stays byte-identical). A blocked catalogue fetch is offered
      // the SAME alternative-representation ladder (F1 + F2) before we give up.
      // Bounded, at most once per run, HTTP-only, never a fake result.
      let recovered = false;
      let escalateToBrowser = false;
      if (opts.recovery && !recoveryUsed && !report.stopped) {
        recoveryUsed = true;
        const rec = await recoverDiscovery({
          url, fetcher, html: r.body, device: opts.device || 'auto',
          maxAttempts: opts.recoveryMaxAttempts ?? 4,
          // Accept a representation only if it actually yields product links (on
          // its own host) — a homepage/soft-block with only nav links is rejected.
          accept: (res) => {
            for (const link of extractLinks(res.body || '', res.url)) {
              if (!sameHost(link, res.url) || ASSET_RE.test(link)) continue;
              if (isItemLink(link)) return true;
            }
            return false;
          },
        });
        opts.onRecovery?.({ phase: 'discovery', url, ok: rec.ok, via: rec.via, verdict: rec.verdict, escalate: rec.escalate, attempts: rec.attempts, trace: rec.trace });
        recoveryBrowserAdvice = rec.escalate; // remember the escalation verdict for the fallback gate
        if (rec.ok && rec.result) {
          allowedHosts.add(hostKey(rec.via.url));            // rebase the crawl onto the recovered representation
          allowedRegs.add(registrableHost(hostKey(rec.via.url)));
          r = rec.result;
          resp = classifyResponse({ status: r.status, url: r.url, requestedUrl: r.requestedUrl || rec.via.url, body: r.body, error: r.error, headers: r.headers });
          report.recovered = (report.recovered || 0) + 1;
          report.notes.push(`discovery recovered via alternative representation: ${rec.via.url}`);
          recovered = true;
        } else if (rec.escalate === 'browser') {
          escalateToBrowser = true; // F3: HTTP recovery exhausted → let the browser-discovery fallback try
        }
      }
      if (!recovered) {
        // F3: when recovery recommends the browser AND one is available, don't
        // mark the source stopped here — the browser-discovery fallback below
        // gets a chance and stops cleanly only if the browser is blocked too.
        if (!(escalateToBrowser && opts.getBrowser)) report.stopped = { code: resp.code, reason: resp.reason, url };
        break;
      }
    }
    if (!r.ok || !r.body) continue;
    // Filter coherence (H2): the entry carried a facet filter, but THIS page (not the
    // entry itself) came back on a URL that dropped or changed it — the site clamped
    // an out-of-range / paginated request to the unfiltered list. Its products are
    // outside the filter, so they are NOT harvested. The entry page (first crawl) is
    // always read; only later pages are checked.
    if (entryFacetKeys.length && report.pagesCrawled > 1 && droppedEntryFacet(r.url)) {
      report.filterDropped = (report.filterDropped || 0) + 1;
      if (report.filterDropped === 1) report.notes.push(`a page dropped the entry filter (${entryFacetKeys.join(', ')}) — out of range, not harvested`);
      continue;
    }
    if (depth > 0) report.listingsCrawled++;
    anyPageOk = true;
    if (report.pagesCrawled === 1) recogniseOnPage(r.body, r.url || url);   // "auto": the entry page's own signals
    // Yield of THIS page (cards + links — the cards read without a link included),
    // for the pagination decisions and the diagnosis.
    const found = () => products.size + noUrlCards.size;
    const pageStart = found();
    const structuredHere = /application\/ld\+json/i.test(r.body)
      || /__NEXT_DATA__|__NUXT__|__APOLLO_STATE__|window\.__[A-Z]/.test(r.body)
      || /itemtype=["'][^"']*Product/i.test(r.body)
      || /og:type["'][^>]*product/i.test(r.body);

    // Structured product cards embedded in this listing page (JSON-LD ItemList/
    // Products, Next/Nuxt/Apollo arrays) → discover URLs + seed enrichment data.
    for (const card of readCards(r.body, r.url).cards) {
      const u = card.sourceUrl;
      if (!u) { noteCardWithoutUrl(card); continue; }
      if (!productHostOk(u) || ASSET_RE.test(u) || SECTION_RE.test(u)) continue;
      const k = dedupKey(u);
      if (!seeds.has(k)) seeds.set(k, card);
      addProduct(u);
      if (products.size >= maxProducts) break;
    }

    const pageLinks = extractLinks(r.body, r.url);
    // Collection scoping: classify this page's product links ONCE (learned
    // recipe > confident heuristic > fail-open). Off-grid links are counted in
    // the report, never queued; the anti-emptying guard keeps current behaviour.
    const productCandidates = pageLinks.filter((l) => !ASSET_RE.test(l) && isItemLink(l) && productHostOk(l));
    // Collection scoping is a product-grid notion; another content type keeps every item link.
    const scoped = reader.id === 'product' ? scopeProductLinks(r.body, r.url, productCandidates, { linkFilter: opts.linkFilter, report }) : { keep: null, scope: null, learnedApplied: false };
    if (depth === 0 && !(entryScope && entryScope.scope)) entryScope = scoped; // first confident depth-0 scope wins (pagination stays depth 0)
    // scopeToCollection: a pasted listing URL with a found grid keeps body
    // sub-category links but never queues nav/header/footer/aside ones. A home
    // (startFromUrl=false) keeps the full crawl.
    const navKeys = (startFromUrl && scopeToCollection && scoped.scope) ? navZoneLinkKeys(r.body, r.url) : null;
    for (const link of pageLinks) {
      if (ASSET_RE.test(link)) continue;
      const isProduct = isItemLink(link);            // item detected first (slug may contain a section word)
      // Products accepted across the registrable domain (locale subdomains);
      // crawl links stay strictly same-host.
      if (!(isProduct ? productHostOk(link) : hostAllowed(link))) continue;
      const k = dedupKey(link);
      if (isProduct) {
        if (scoped.keep && !scoped.keep.has(k)) continue; // off-grid: counted in report.scopedOut
        addProduct(link);
        if (products.size >= maxProducts) break;
        continue;
      }
      if (SECTION_RE.test(link)) continue;            // non-catalogue → never crawl
      if (!visited.has(k) && queue.length + report.pagesCrawled < maxPages) {
        if (PAGE_RE.test(link) || samePagePagination(link, r.url)) { visited.add(k); queue.push({ url: link, depth, pg: depth === 0 }); } // pagination: same depth
        else if (depth < maxDepth && (isListingLink(link) || isNestedCategoryTrail(link))) {
          if (navKeys && navKeys.has(k)) { report.scopedOutNav = (report.scopedOutNav || 0) + 1; continue; } // chrome listing link, out of collection scope
          visited.add(k); queue.push({ url: link, depth: depth + 1 });                          // deeper category (body sub-category kept)
        }
      }
    }
    // Diagnosis signals for THIS page (observational; no effect on the crawl):
    //   structured data present but yielding nothing → detection gap (#4);
    //   an OK page with almost no links and no data → likely an unhydrated SPA
    //   shell whose catalogue needs a browser (#3).
    if (found() === pageStart) {
      if (structuredHere) sawStructured = true;
      else if (pageLinks.length < 8) sawCsrShell = true;
    }
    // rel="next" pagination (when not exposed as a normal <a>)
    const next = relNext(r.body);
    let hasPagLink = false;
    if (next) {
      const nabs = absoluteUrl(next, r.url); const nk = nabs && dedupKey(nabs);
      if (nabs && hostAllowed(nabs) && !visited.has(nk)) { visited.add(nk); queue.push({ url: nabs, depth, pg: depth === 0 }); }
      hasPagLink = true;
    }
    hasPagLink = hasPagLink || pageLinks.some((l) => hostAllowed(l) && !isItemLink(l) && !SECTION_RE.test(l) && PAGE_RE.test(l));

    // Page-ENUMERATION fallback: a real listing that yielded products but exposes
    // NO next-page link (JS / infinite-scroll pagination) → synthesize the next
    // page so the catalogue past page 1 is still crawled. Conservative: only from
    // a page that yielded ≥3 products and showed no pagination link, one page
    // ahead (it chains). Global caps + the no-new-products guard stop it, and a
    // site that ignores the param dedups to nothing.
    const pageYield = found() - pageStart;
    if (pageYield >= 3 && !hasPagLink && queue.length + report.pagesCrawled < maxPages) {
      const np = nextPageUrl(r.url);
      const nk = np && dedupKey(np);
      if (np && hostAllowed(np) && !visited.has(nk)) {
        visited.add(nk); queue.push({ url: np, depth, pg: depth === 0 });
        report.enumeratedPages = (report.enumeratedPages || 0) + 1;
        if (report.enumeratedPages === 1) report.notes.push('page-enumeration active (listing had no visible next-page link)');
      }
    }

    // Loop guard: too many pages yielding no new products → stop.
    // Counted on the whole page (its structured cards included, not only its links):
    // a grid read from the page state yields products although no link is new.
    if (found() === pageStart) { if (++noNewStreak >= 12) { report.notes.push('crawl stopped: no new products for 12 pages'); break; } }
    else noNewStreak = 0;
  }
  if (report.pagesCrawled >= maxPages) report.notes.push(`crawl hit maxPages=${maxPages}`);
  report.httpProductUrls = products.size;

  // ── 3) Browser-discovery fallback (CSR) ─────────────────────────────────
  // Fires only when HTTP found NO products AND a browser is available. Renders
  // the entry page (+ JS pagination / load-more) and rendered listing pages
  // (depth-limited) to collect product links, then feeds the SAME pipeline.
  // Escalation-aware: if discovery recovery ran and concluded escalate:'none'
  // (a browser would not help), the fallback is suppressed. When recovery never
  // ran (historical CSR case) or asked for the browser, it fires exactly as before.
  const browserAdvised = recoveryBrowserAdvice === null || recoveryBrowserAdvice === 'browser';
  let browserRan = false;
  // When to render (2a — the archetype-3 first-visit case). Two thresholds, both
  // additive (a dedup-keyed extra attempt) and generic (a count, never a site name):
  //   • UNKNOWN site: fire when the free HTTP path found essentially nothing on a
  //     reachable page — fewer than `csrFewThreshold` products (default 2, i.e. 0–1).
  //     Measured: an XHR/RSC grid (brico≈1, Lidl 0–1) returns a shell over HTTP, so
  //     "found 1" is really "found nothing usable"; a page that found ≥2 is left as is.
  //   • REMEMBERED browser-needing host (4e opts.preferBrowser): the more aggressive
  //     `< sitemapMin`, since the profile already knows its catalogue needs a render.
  // A wrong guess costs one bounded render (maxBrowserPages) and never wrong data.
  const csrFewThreshold = opts.csrFewThreshold ?? 2;
  // Cards read from the page without a link count as found: no render for a listing
  // that already delivered its products over HTTP.
  const foundSoFar = products.size + noUrlCards.size;
  const fewHttp = foundSoFar < csrFewThreshold || (opts.preferBrowser && foundSoFar < sitemapMin);
  if (fewHttp && opts.getBrowser && browserAdvised) {
    step('browserStart');
    const bs = await opts.getBrowser();
    if (bs) {
      browserRan = true;
      // Bound the render loop by BOTH a page cap AND a wall-clock budget, and give
      // each render a SHORT timeout — a protected SPA (DataDome) returns a tiny
      // challenge shell in ~13s that yields nothing, so 40 renders = 10 minutes for
      // zero products. The budget + a challenge-shell early-stop cap that at seconds.
      const maxBrowserPages = opts.maxBrowserPages ?? 10;
      const browserBudgetMs = opts.browserBudgetMs ?? 60000;
      const browserRenderMs = opts.browserRenderMs ?? 12000;
      const browserStart = Date.now();
      let emptyRenders = 0;
      report.notes.push(`HTTP discovery found ${report.httpProductUrls} product(s) → browser-discovery (CSR fallback)`);
      const visited = new Set([dedupKey(shopUrl)]);
      const queue = [{ url: shopUrl, depth: 0 }];
      while (queue.length && products.size < maxProducts && report.browserPagesRendered < maxBrowserPages && (Date.now() - browserStart) < browserBudgetMs) {
        const { url, depth } = queue.shift();
        // Prefer the richer collectListing (cards + rendered HTML) when available,
        // falling back to collectLinks for older/mocked sessions.
        const res = typeof bs.collectListing === 'function'
          ? await bs.collectListing(url, {
              timeoutMs: browserRenderMs, productReSource: PRODUCT_RE.source,
              // Learned link_filter hints for the in-page collector (browser.mjs
              // consumes them; older/mocked sessions ignore the extra opts).
              learnedContainer: (opts.linkFilter && opts.linkFilter.container) || undefined,
              consentSelector: (opts.linkFilter && opts.linkFilter.consent && opts.linkFilter.consent.selector) || undefined,
            })
          : { ...(await bs.collectLinks(url)), cards: [], html: null };
        const { links, blocked, cards, html, pageLinks } = res;
        report.browserPagesRendered++;
        step('render', { n: report.browserPagesRendered, found: products.size });
        if (blocked) { report.stopped = { code: blocked.code, reason: `${blocked.reason} (browser-discovery)`, url }; break; }
        // Challenge-shell detection: a tiny rendered page with no product links and no
        // cards is a bot wall the browser can't pass either. Count it; tolerate one
        // flaky render when the queue has more to try, but stop after two so a
        // paginated wall is not re-rendered dozens of times. Whether or not it fakes
        // pagination (pageLinks), an empty render carries no products. Generic
        // (size + emptiness), never a site name.
        if ((html || '').length < 1500 && (links || []).length === 0 && (cards || []).length === 0) {
          if (++emptyRenders >= 2) { step('protected'); break; }
        }

        // Pagination controls read from the rendered DOM (aria/rel/numbered): queue
        // the next pages to render. Keyed so they are NOT also treated as products
        // (a "/p/2/" path matches PRODUCT_RE but is a listing, not a fiche).
        const pageKeys = new Set();
        for (const pl of (pageLinks || [])) {
          const pabs = absoluteUrl(pl, url); if (!pabs || !hostAllowed(pabs)) continue;
          const pk = dedupKey(pabs); pageKeys.add(pk);
          if (!visited.has(pk) && report.browserPagesRendered + queue.length < maxBrowserPages) { visited.add(pk); queue.push({ url: pabs, depth }); }
        }

        // Rendered product CARDS (repeated-structure detection in the real DOM) →
        // URLs + seed enrichment (name/price/image), same as HTTP listing cards.
        // Guarded by URL-FAMILY CONSENSUS among the cards themselves: the
        // detector also fires on teaser/service tiles outside the grid (live
        // lidl.be: a support-article "card" whose 403 stopped the scrape), and
        // a strong majority of cards sharing one URL family (host + leading
        // path segments, digits wildcarded) votes the strays out. NOT the
        // img-anchored grid heuristic — 55/64 live lidl cards render without an
        // image (lazy-load) and must survive, per the image-less-card fix. The
        // learned link_filter already scoped cards in-page (learnedContainer).
        // A card URL the URL-classifier reads as a COLLECTION/search/home is a
        // category/section tile, never a product — Lidl section-hub pages
        // (/c/fr-BE/…/s<ID>, incl. /abonner "Newsletter") render dozens of these
        // among a few real product cards. classifyUrl keeps Shopify-style nested
        // product URLs (/collections/x/products/y → 'product') and non-pattern
        // product slugs ('unknown'), so this excludes only positively-listing
        // URLs without dropping the PrestaShop/custom-slug cards the detector exists for.
        const isListingCardUrl = (u) => { const ty = classifyUrl(u).type; return ty === 'collection' || ty === 'search' || ty === 'home'; };
        const cardEntries = [];
        for (const card of (cards || [])) {
          const u = card.url && absoluteUrl(card.url, url);
          // Structurally-detected cards are trusted as products even when the URL
          // matches NO pattern (PrestaShop /12-slug, custom slugs). Downstream
          // extraction + eligibility drop anything that turns out not to be one.
          if (!u || !productHostOk(u) || ASSET_RE.test(u) || SECTION_RE.test(u) || isListingCardUrl(u)) continue;
          cardEntries.push([u, card]);
        }
        const cardFamily = (u) => { try { const x = new URL(u); return `${x.hostname}/${x.pathname.split('/').filter(Boolean).slice(0, 2).map((s) => s.replace(/\d+/g, '#')).join('/')}`; } catch { return null; } };
        // The vote is cast by PRICED cards only — a price is the product signal.
        // A pre-hydration render can show MORE unpriced section/nav tiles than
        // real product cards (live lidl.be), so a raw majority would vote the
        // products out; priced-card consensus keeps the priced family (its
        // image-less members included) and drops the unpriced strays.
        let cardKeep = null; // null = no consensus → keep every card (fail-open)
        const priced = cardEntries.filter(([, c]) => c && (c.priceText || c.price != null));
        if (priced.length >= 5) {
          const fam = new Map();
          for (const [u] of priced) { const t = cardFamily(u); if (t) fam.set(t, (fam.get(t) || 0) + 1); }
          let bestTpl = null, bestN = 0;
          for (const [t, n] of fam) if (n > bestN) { bestTpl = t; bestN = n; }
          if (bestTpl && bestN >= priced.length * 0.8) {
            const keep = new Set(cardEntries.filter(([u]) => cardFamily(u) === bestTpl).map(([u]) => dedupKey(u)));
            if (keep.size < cardEntries.length) cardKeep = keep; // only engage when it actually excludes strays
          }
        }
        for (const [u, card] of cardEntries) {
          const k = dedupKey(u);
          if (cardKeep && !cardKeep.has(k)) {
            report.scopedOut = (report.scopedOut || 0) + 1;
            const samples = (report.scopedOutSamples = report.scopedOutSamples || []);
            if (samples.length < 10 && !samples.includes(u)) samples.push(u);
            continue;
          }
          if (!seeds.has(k)) {
            const seed = { sourceUrl: u, canonicalUrl: u, strategy: 'browser-card' };
            if (card.name) seed.name = card.name;
            if (card.image) seed.images = [card.image];
            const money = card.priceText ? parseMoney(card.priceText) : null;
            if (money) { seed.price = money.price; if (money.currency) seed.currency = money.currency; }
            // A listing card's secondary lines and the price with its basis ("116 € au
            // total") travel as the description; its rating as stated on the card.
            if (card.subtitle || card.priceLine) seed.description = [card.subtitle, card.priceLine].filter(Boolean).join(' · ');
            if (card.rating != null) { seed.rating = card.rating; if (card.reviewCount != null) seed.reviewCount = card.reviewCount; }
            seeds.set(k, seed);
          }
          addProduct(u);
          if (products.size >= maxProducts) break;
        }
        // Structured cards from the RENDERED HTML (JSON-LD ItemList / embedded
        // arrays that only appear after hydration).
        if (html) {
          for (const card of readCards(html, url).cards) {
            const u = card.sourceUrl;
            if (!u) { noteCardWithoutUrl(card); continue; }
            if (!productHostOk(u) || ASSET_RE.test(u) || SECTION_RE.test(u) || isListingCardUrl(u)) continue;
            const k = dedupKey(u);
            if (!seeds.has(k)) seeds.set(k, card);
            addProduct(u);
            if (products.size >= maxProducts) break;
          }
        }
        // Same collection scoping as the HTTP crawl, on the rendered links.
        const renderedCandidates = (links || []).filter((l) => !ASSET_RE.test(l) && !pageKeys.has(dedupKey(l)) && isItemLink(l) && productHostOk(l));
        const scopedR = reader.id === 'product' ? scopeProductLinks(html || '', url, renderedCandidates, { linkFilter: opts.linkFilter, report }) : { keep: null, scope: null, learnedApplied: false };
        const navKeysR = (startFromUrl && scopeToCollection && scopedR.scope) ? navZoneLinkKeys(html || '', url) : null;
        for (const link of links) {
          if (ASSET_RE.test(link)) continue;
          const k = dedupKey(link);
          if (pageKeys.has(k)) continue; // pagination control, already queued — never a product
          const isProduct = isItemLink(link);
          if (!(isProduct ? productHostOk(link) : hostAllowed(link))) continue;
          if (isProduct) {
            if (scopedR.keep && !scopedR.keep.has(k)) continue; // off-grid: counted in report.scopedOut
            addProduct(link); if (products.size >= maxProducts) break; continue;
          }
          if (SECTION_RE.test(link)) continue;
          if (!visited.has(k) && depth < maxDepth && report.browserPagesRendered + queue.length < maxBrowserPages) {
            if (PAGE_RE.test(link)) { visited.add(k); queue.push({ url: link, depth }); }
            else if (isListingLink(link) || isNestedCategoryTrail(link)) {
              if (navKeysR && navKeysR.has(k)) { report.scopedOutNav = (report.scopedOutNav || 0) + 1; continue; }
              visited.add(k); queue.push({ url: link, depth: depth + 1 });
            }
          }
        }
      }
      // Wall diagnosis: renders happened, every one came back empty (bot shell), and
      // no products were found → the browser can't pass it either. Route to the paid
      // unlock instead of reporting a bare, unexplained "0 products". Only when the
      // whole browser pass was empty (a partial catalogue that found some products is
      // a success, not a wall).
      if (products.size === 0 && emptyRenders > 0 && !report.stopped) {
        // Set only the terminal stop — the end-of-run classifier maps it to a
        // 'blocked' diagnosis with the reason, and the controller offers unlock.
        report.stopped = { code: 'JAVASCRIPT_REQUIRED', reason: 'page protégée — le rendu ne livre rien (déblocage requis)', url: shopUrl };
      }
      // Browser→HTTP handoff: pass the catalogue session cookies to the HTTP jar
      // so product-detail pages can be fetched over cheap HTTP (no-op if no jar).
      try { if (fetcher.jar && typeof bs.cookies === 'function') fetcher.jar.setFromBrowser(await bs.cookies()); } catch { /* ignore */ }
      report.browserProductUrls = products.size - report.httpProductUrls;
      report.method = report.method === 'sitemap' ? 'sitemap+browser' : (report.httpProductUrls ? 'crawl+browser' : 'browser');
    }
  }

  // Sitemap COMPLEMENT (never override): only when the pasted listing URL led to
  // too few products. Only URLs in the LISTING's scope stand in for it — its
  // language segment and its category (core/complement-scope.mjs: URL shapes and
  // sitemap structure, never a site rule). The entry grid's learned URL pattern
  // is an extra constraint. Nothing in scope → nothing added: a blocked listing is
  // reported blocked, never filled with off-topic products.
  if (startFromUrl && (products.size + noUrlCards.size) < sitemapMin && sitemapUrls.length) {
    const before = products.size;
    const pat = entryScope && entryScope.scope && entryScope.scope.urlPattern;
    const scope = createComplementScope(shopUrl, { urlPattern: pat, siteUrls: sitemapUrls });
    const cx = (report.complement = { scope: scope.describe(), checked: 0, added: 0, outOfScope: { language: 0, category: 0, pattern: 0 }, outOfScopeSamples: [], sitemapReread: false });
    const consider = (u, sitemapUrl) => {
      cx.checked++;
      const v = scope.check(u, sitemapUrl);
      if (!v.ok) {
        cx.outOfScope[v.why]++;
        if (v.why === 'pattern') report.sitemapFilteredByPattern = (report.sitemapFilteredByPattern || 0) + 1;
        if (cx.outOfScopeSamples.length < 5) cx.outOfScopeSamples.push(u);
        return;
      }
      addProduct(u);
    };
    const need = () => products.size < maxProducts && (products.size + noUrlCards.size) < maxProducts;
    for (const u of sitemapUrls) { if (!need()) break; consider(u, sm.sources ? sm.sources.get(u) : null); }
    // The first sitemap read stopped at the product cap, whatever the scope: the
    // listing's language/category may sit in a sitemap file not read yet. One more
    // read, scoped — sitemaps named after the category or the language first,
    // stopped after a few files in a row with nothing in scope.
    if (need() && sm.truncated && products.size - before < sitemapMin) {
      cx.sitemapReread = true;
      const seen = new Set(sitemapUrls.map(dedupKey));
      const sm2 = await discoverFromSitemaps(fetcher, origin, {
        max: maxProducts - products.size, hint: [...(opts.sitemapHints || []), ...(robots?.sitemaps || [])],
        looksLike: reader.sitemap ? reader.sitemap.looksLike : undefined,
        maxSitemaps: opts.complementMaxSitemaps ?? 12, maxBarrenLeaves: opts.complementBarrenSitemaps ?? 3,
        accept: (u, smUrl) => !SKIP_RE.test(u) && !isNestedCategoryTrail(u) && scope.check(u, smUrl).ok,
        rank: (smUrl) => scope.rankSitemap(smUrl),
      });
      cx.rereadSitemaps = sm2.sitemapsRead.length;
      cx.rereadRejected = sm2.rejected;
      for (const u of sm2.urls) { if (!need()) break; if (!seen.has(dedupKey(u))) consider(u, sm2.sources.get(u)); }
    }
    cx.added = products.size - before;
    if (cx.added) {
      report.method = report.method && report.method !== 'crawl' ? `${report.method}+sitemap` : 'sitemap-complement';
      report.notes.push(`sitemap complement added ${cx.added} URLs in the listing's scope (listing yielded too few)`);
    } else if (cx.checked) {
      report.notes.push(`sitemap complement: none of ${cx.checked} sitemap URL(s) is in the listing's scope (language ${cx.outOfScope.language}, category ${cx.outOfScope.category}, pattern ${cx.outOfScope.pattern} out of scope) — nothing added`);
    }
    // The listing itself was blocked and nothing in its scope exists elsewhere:
    // the run reports the LISTING as blocked (and the paid unlock may take it).
    if (!cx.added && report.stopped && products.size === 0 && noUrlCards.size === 0) {
      report.listingBlocked = { url: report.stopped.url || shopUrl, code: report.stopped.code, outOfScope: cx.checked };
    }
  }

  report.productUrls = products.size;

  // ── Honest end-of-run diagnosis (never a bare "none-found") ───────────────
  // Distinguishes the failure classes the way the user's five buckets do, from
  // what each avenue ACTUALLY observed — only after the avenues have been tried.
  if (products.size > 0 || noUrlCards.size > 0) {
    report.diagnosis = 'ok';
  } else if (report.stopped) {
    report.diagnosis = 'blocked';                 // #5 access/render blocked (terminal protection)
    report.diagnosisReason = `${report.stopped.code}: ${report.stopped.reason}`;
    if (report.listingBlocked) report.diagnosisReason += ' — listing blocked, no sitemap URL in its scope';
  } else if (recoveryBrowserAdvice === 'browser' && !browserRan) {
    report.diagnosis = 'needs-browser';           // #3 recovery judged a browser would help, none available
    report.diagnosisReason = 'HTTP exhausted; render (browser) recommended';
  } else if (sawStructured) {
    report.diagnosis = 'structured-undetected';   // #4 product data present but not turned into URLs
    report.diagnosisReason = 'structured product data seen but no product URLs extracted';
  } else if (sawCsrShell && !browserRan) {
    report.diagnosis = 'needs-browser';           // #3 pages look like unhydrated SPA shells
    report.diagnosisReason = 'catalogue pages appear client-rendered (empty shell over HTTP)';
  } else if (anyPageOk) {
    report.diagnosis = 'no-signal';               // #1 reachable & parsed, no catalogue signal found
    report.diagnosisReason = browserRan ? 'no product URLs even after browser render' : 'no product URLs in sitemaps or HTML';
  } else {
    report.diagnosis = 'unreachable';             // #5 nothing fetched successfully, no terminal verdict
    report.diagnosisReason = 'no catalogue page could be fetched';
  }

  return finish();
}
