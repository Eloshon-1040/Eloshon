/**
 * Source probe — analyse a shop URL and report the BEST ACHIEVABLE result across
 * the WHOLE chain, not the failure of a single path. It evaluates, in order, every
 * lane the scraper itself would use:
 *
 *   internal_api recipe (free) → embedded state (free) → listing/JSON-LD (free)
 *   → single fiche (free) → local browser render (free) → assisted unlock (paid)
 *
 * and reports the FIRST lane that yields products as the verdict — with a per-field
 * status so the user sees what is free, what needs an unlock, and what is genuinely
 * absent. A field is only marked ABSENT when we actually read a product for free and
 * the field was missing; on a protected site (no free read) every field is marked
 * "needs unlock", never a bare cross. A complete failure is reported only when no
 * lane can work.
 *
 * The sample product is taken from the pasted URL's own listing (embedded /
 * listing / recipe cards) so its language matches the URL. Only when the pasted
 * URL fails NON-terminally (404 / network error) does the probe fall back to a
 * sitemap fiche — and then ONLY one in the SAME language as the pasted URL,
 * never a competing one. When nothing free answers but the origin or a sitemap
 * does, the free local-browser lane is estimated ('needs-browser'); 'unreachable'
 * is reserved for a site where nothing answered at all.
 *
 * HTTP-only in-process; the browser/unlock lanes are ESTIMATED (from the domain
 * profile + the caller's unlock estimate), never run here — so the probe stays cheap
 * and never spends a credit.
 */
import { Fetcher } from './http-fetcher.mjs';
import { parseRobots, isDisallowed } from './robots.mjs';
import { detectPlatform } from './platform.mjs';
import { extractProduct } from './extract.mjs';
import { extractEmbeddedProducts } from './embedded-state.mjs';
import { extractListing } from './listing.mjs';
import { needsBrowser } from './html-meta.mjs';
import { classifyResponse } from './detect.mjs';
import { originOf } from './url-utils.mjs';
import { discoverFromSitemaps } from './sitemap.mjs';
import { createComplementScope } from './complement-scope.mjs';
import { runRecipeLane, defaultHttpGet } from './internal-api.mjs';
import { classifyUrl, detectLocale, normalizeHost, KNOWN_LANG } from './url-context.mjs';
import { detectContentType } from '../shared/content/detect.mjs';
import { normalizeContentType } from '../shared/content/profiles.mjs';
import { extractVideoCards, extractVideoPage, parseVideoSitemap, videoCardFromSitemapEntry } from '../shared/extract/video.mjs';

const FIELDS = ['name', 'price', 'ean', 'sku', 'brand', 'category', 'image', 'weight', 'description'];
const STATUS_MARK = { free: '✓', browser: '⟳', unlock: '€', absent: '✗' };
const FIELD_LABEL = { name: 'nom', price: 'prix', ean: 'code-barres', sku: 'référence', brand: 'marque', category: 'catégorie', image: 'image', weight: 'poids', description: 'description' };
// Content type "video" (shared/content): the fields a video carries for free.
const VIDEO_FIELDS = ['name', 'url', 'image', 'description', 'duration', 'published', 'views', 'embed'];
const VIDEO_FIELD_LABEL = { name: 'titre', url: 'adresse', image: 'vignette', description: 'description', duration: 'durée', published: 'date de publication', views: 'vues', embed: 'lecteur' };
const FREE_PATHS = ['recipe', 'embedded', 'listing', 'fiche', 'video-list', 'video-page'];
function coverageFromVideo(v) {
  if (!v) return null;
  const c = v.columns || {};
  return { name: !!v.name, url: !!(v.canonicalUrl || v.sourceUrl), image: (v.images || []).length > 0, description: !!v.description, duration: !!c.duration, published: !!c.published_at, views: !!c.views, embed: !!c.embed_url };
}

/** Field presence on a single product/card (generic across free extractors). */
function coverageFromProduct(p) {
  if (!p) return null;
  return {
    name: !!p.name,
    price: p.price != null,
    ean: !!p.gtin,
    sku: !!p.sku,
    brand: !!p.brand,
    category: !!p.category || (p.breadcrumb || []).length > 0,
    image: (p.images || []).length > 0 || !!p.image,
    weight: !!p.weightText,
    description: !!p.description,
  };
}

/**
 * Per-field status. A present field is `free`. An unreached field is:
 *   - `browser` when the FREE local-browser render is the lane (bestPath
 *     'browser') — the fields cost nothing, they just await a render. Marking
 *     them `unlock` (paid) here is what made the verdict self-contradict: a
 *     "navigateur local (gratuit)" headline over a "€ déblocage" field list.
 *   - `unlock` only when the PAID assisted-unlock lane is required (bestPath
 *     'unlock'), or a richer known lane (recipe/fiche) could still fill it.
 *   - `absent` on a fully-readable site where the field was genuinely missing.
 */
function fieldStatus(coverage, { protectedSite, paidUnlock, fields = FIELDS }) {
  const out = {};
  for (const k of fields) {
    if (coverage && coverage[k]) out[k] = 'free';
    else if (paidUnlock) out[k] = 'unlock';
    else if (protectedSite) out[k] = 'browser';
    else out[k] = 'absent';
  }
  return out;
}

/**
 * Language-safe sitemap sample candidates, best-scored first. A candidate whose
 * path carries a language segment DIFFERENT from the pasted URL's is dropped
 * (never fall back to it — the wrong-language-fiche bug this sampling once had);
 * language-neutral paths are kept. Scoring prefers an explicit country/language
 * match and the entry's leading path segment.
 */
function localeSampleCandidates(urls, entryUrl, locale, limit = 3) {
  if (!urls || !urls.length) return [];
  const langsIn = (u) => { try { const s = new URL(u).pathname.toLowerCase(); return [...s.matchAll(/(?:^|[/_.-])([a-z]{2})(?:[/_.-]|$)/g)].map((m) => m[1]).filter((x) => KNOWN_LANG.has(x)); } catch { return []; } };
  const ll = locale.language ? locale.language.toLowerCase() : null;
  const kept = ll ? urls.filter((u) => { const ls = langsIn(u); return ls.length === 0 || ls.includes(ll); }) : [...urls];
  if (!kept.length) return [];
  let firstSeg = '';
  try { firstSeg = (new URL(entryUrl).pathname.split('/').filter(Boolean)[0] || '').toLowerCase(); } catch { /* ignore */ }
  const cc = locale.country ? locale.country.toLowerCase() : null;
  const score = (u) => {
    let p = ''; try { p = new URL(u).pathname.toLowerCase(); } catch { return -1; }
    let s = 0;
    if (cc && (p.includes(`/${cc}/`) || p.includes(`_${cc}/`) || p.includes(`-${cc}/`))) s += 2;
    if (ll && (p.includes(`/${ll}/`) || p.includes(`/${ll}_`) || p.includes(`/${ll}-`))) s += 1;
    if (firstSeg && p.startsWith(`/${firstSeg}/`)) s += 1;
    return s;
  };
  return kept.map((u) => [u, score(u)]).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([u]) => u);
}

/**
 * @param {string} entryUrl
 * @param {{ fetcher?:Fetcher, recipe?:object|null, httpGet?:Function,
 *          browserBootstrap?:Function, profile?:object|null }} [opts]
 *   recipe  — a usable internal_api recipe from the domain profile (free lane).
 *   profile — the domain profile (its needsUnlock/lastProductCount inform the
 *             protected-site verdict without spending anything).
 */
export async function probeSource(entryUrl, opts = {}) {
  const fetcher = opts.fetcher || new Fetcher({ minDelayMs: 800 });
  const origin = originOf(entryUrl) || entryUrl;
  const domain = normalizeHost(entryUrl) || (() => { try { return new URL(entryUrl).hostname; } catch { return entryUrl; } })();
  const urlType = classifyUrl(entryUrl).type;
  const locale = detectLocale(entryUrl);
  if (!locale.country) {
    const tld = (domain.split('.').pop() || '').toUpperCase();
    if (/^[A-Z]{2}$/.test(tld) && tld !== 'CO') { locale.country = tld; locale.source = `${locale.source || 'host'} + ccTLD`; }
  }
  const profile = opts.profile || null;

  // robots (informational + sitemap hints; never gates the verdict).
  const robotsRes = await fetcher.get(`${origin}/robots.txt`);
  const robots = robotsRes.ok ? parseRobots(robotsRes.body) : null;

  let bestPath = null;        // 'recipe' | 'embedded' | 'listing' | 'fiche' | 'browser' | 'unlock' | null
  let sample = null;          // the product the coverage is computed from (from the pasted URL)
  let productCount = null;    // products reachable on the pasted URL via the free lane
  let coverageSource = null;  // 'recipe' | 'embedded-card' | 'listing-card' | 'fiche'

  // ── LANE 1: internal_api recipe (free — one discovery already paid for it). ──
  if (opts.recipe && opts.recipe.endpoint_tpl) {
    try {
      const lane = await runRecipeLane(opts.recipe, entryUrl, { httpGet: opts.httpGet || defaultHttpGet(undefined, { userAgent: fetcher.userAgent, pacer: fetcher.pacer || null }), browserBootstrap: opts.browserBootstrap, maxProducts: 24, maxPages: 1 });
      if (lane.ok && lane.products.length) { bestPath = 'recipe'; sample = lane.products[0]; productCount = lane.total ?? lane.products.length; coverageSource = 'recipe'; }
    } catch { /* fall through to the free HTTP lanes */ }
  }

  // ── The pasted page itself (one fetch, reused by the HTML lanes below). ──
  const home = bestPath ? null : await fetcher.get(entryUrl);
  const entryClass = home ? classifyResponse({ status: home.status, url: home.url, requestedUrl: entryUrl, body: home.body, error: home.error, headers: home.headers }) : null;
  const platform = home && home.ok ? detectPlatform(home.body) : null;
  const homeNeedsBrowser = home && home.ok ? needsBrowser(home.body) : false;
  const homeBlocked = !!(entryClass && entryClass.terminal);

  // Content type: the form's choice, or recognised on the pasted page ("auto").
  const wanted = normalizeContentType(opts.contentType);
  const contentType = { requested: wanted, type: wanted === 'video' ? 'video' : 'product', detected: null, signals: [] };
  if (home && home.ok && home.body) {
    const det = detectContentType(home.body, home.url || entryUrl);
    contentType.detected = det.type; contentType.signals = det.signals;
    if (wanted === 'auto' && det.type === 'video') contentType.type = 'video';
  }
  let isVideo = contentType.type === 'video';
  // ── LANE 2v / 4v: the videos the page lists, or the page's own video (free). ──
  if (!bestPath && isVideo && home && home.ok) {
    const vl = extractVideoCards(home.body, home.url || entryUrl);
    if (vl.cards.length) { bestPath = 'video-list'; sample = vl.cards[0]; productCount = vl.cards.length; coverageSource = 'video-card'; }
    else { const vp = extractVideoPage(home.body, home.url || entryUrl); if (vp) { bestPath = 'video-page'; sample = vp; productCount = 1; coverageSource = 'video-page'; } }
  }
  // ── "auto", page without any signal (a client-rendered shell): the site's video
  //    sitemap decides (≥ 3 entries) — the same source discovery would use. ──
  if (!bestPath && wanted === 'auto' && home && home.ok && !isVideo && contentType.detected == null) {
    try {
      const sm = await discoverFromSitemaps(fetcher, origin, { max: 40, maxSitemaps: 6, hint: robots?.sitemaps || [], parseEntries: (xml) => parseVideoSitemap(xml).map((e) => ({ url: e.url, card: videoCardFromSitemapEntry(e) })).filter((e) => e.card) });
      const entries = sm.entries || [];
      if (entries.length >= 3) {
        contentType.type = 'video'; contentType.detected = 'video'; contentType.signals = [`sitemap_videos:${entries.length}`]; isVideo = true;
        bestPath = 'video-list'; sample = entries[0].card; productCount = sm.urls.length || entries.length; coverageSource = 'video-sitemap';
      }
    } catch { /* the page's own verdict stands */ }
  }

  if (!bestPath && !isVideo && home && home.ok) {
    // ── LANE 2: embedded product state in the HTML (free). ──
    const emb = extractEmbeddedProducts(home.body, home.url);
    if (emb.cards.length) { bestPath = 'embedded'; sample = emb.cards[0]; productCount = (emb.pagination && emb.pagination.totalResults) || emb.cards.length; coverageSource = 'embedded-card'; }
    // ── LANE 3: listing / JSON-LD product cards on the page (free). ──
    if (!bestPath) {
      const lst = extractListing(home.body, home.url);
      if (lst.cards.length) { bestPath = 'listing'; sample = lst.cards[0]; productCount = lst.cards.length; coverageSource = 'listing-card'; }
    }
    // ── LANE 4: the page IS a single product fiche (free). ──
    if (!bestPath && urlType === 'product') {
      const { product } = extractProduct(home.body, home.url);
      if (product) { bestPath = 'fiche'; sample = product; productCount = 1; coverageSource = 'fiche'; }
    }
  }

  const knownNeedsUnlock = !!(profile && profile.needsUnlock);
  const knownCount = profile && typeof profile.lastProductCount === 'number' ? profile.lastProductCount : null;

  // ── LANE 4b: the pasted URL failed NON-terminally (404 / network error). The
  //    scrape itself would still deliver (origin crawl + sitemap complement +
  //    free browser fallback), so sample the chain instead of giving up: pick a
  //    SAME-LANGUAGE fiche from the sitemaps and measure coverage on it. The
  //    pasted URL stays the priority — this runs only when it did not answer. ──
  const entryFailedSoft = !!(home && !home.ok && !homeBlocked);
  let siteAnswers = false;          // origin/homepage reachable, or a sitemap parsed
  let sampledFromSitemap = null;    // URL of the sitemap fiche the coverage came from
  if (!bestPath && entryFailedSoft && !knownNeedsUnlock) {
    const strip = (u) => String(u || '').replace(/\/+$/, '');
    const originRes = strip(origin) === strip(entryUrl) ? home : await fetcher.get(origin);
    if (originRes && originRes.ok) siteAnswers = true;
    const disc = await discoverFromSitemaps(fetcher, origin, { max: 40, maxSitemaps: 6, hint: robots?.sitemaps || [] });
    if (disc.sitemapsRead.length) siteAnswers = true;
    // Same scope as the scrape's sitemap complement: a listing is only stood in for
    // by sitemap URLs in its language and category (core/complement-scope.mjs).
    let pool = disc.urls;
    if (urlType !== 'product') {
      const scope = createComplementScope(entryUrl, { siteUrls: disc.urls });
      pool = disc.urls.filter((u) => scope.check(u, disc.sources ? disc.sources.get(u) : null).ok);
    }
    for (const cand of localeSampleCandidates(pool, entryUrl, locale)) {
      const r = await fetcher.get(cand);
      if (!r.ok || !r.body) continue;
      const { product } = extractProduct(r.body, r.url || cand);
      if (product) { bestPath = 'fiche'; sample = product; productCount = 1; coverageSource = 'fiche'; sampledFromSitemap = r.url || cand; break; }
    }
  }

  // ── LANE 5/6: no free product reachable → is it protected (browser/unlock) or
  //    genuinely empty? Use the page classification + the domain memory. ──
  let browserEstimated = false;     // lane inferred from the scrape's free-browser fallback, not observed
  if (!bestPath) {
    if (homeBlocked || knownNeedsUnlock) bestPath = 'unlock';
    else if (homeNeedsBrowser || (profile && profile.needsBrowser)) bestPath = 'browser';
    // The entry failed but the SITE answers: the scrape's unconditional local
    // browser fallback (free, under csrFewThreshold) still gets its chance, so
    // the honest verdict is needs-browser — 'unreachable' is reserved for a site
    // where NOTHING answered (entry + origin + robots/sitemaps all dead).
    else if (entryFailedSoft && siteAnswers) { bestPath = 'browser'; browserEstimated = true; }
  }

  const protectedSite = bestPath === 'unlock' || bestPath === 'browser';
  const paidUnlock = bestPath === 'unlock';       // only the assisted-unlock lane costs credits
  const fields = isVideo ? VIDEO_FIELDS : FIELDS;
  const labels = isVideo ? VIDEO_FIELD_LABEL : FIELD_LABEL;
  const coverage = isVideo ? coverageFromVideo(sample) : coverageFromProduct(sample);
  const status = fieldStatus(coverage, { protectedSite, paidUnlock, fields });

  // Honest six-state diagnosis (kept for the engine/UI), now driven by the WHOLE chain.
  let diagnosis, diagnosisReason, action;
  if (FREE_PATHS.includes(bestPath)) {
    diagnosis = 'ok'; action = 'proceed';
    diagnosisReason = `${productCount ?? '?'} ${isVideo ? 'video(s)' : 'product(s)'} reachable for free via ${bestPath}`;
    if (sampledFromSitemap) diagnosisReason += ' (entry page failed; sampled a same-language sitemap fiche)';
  } else if (bestPath === 'unlock') {
    diagnosis = 'blocked'; action = 'browser-or-feed';
    diagnosisReason = knownNeedsUnlock ? 'site protected — assisted unlock brings products' : (entryClass ? `${entryClass.code}: ${entryClass.reason}` : 'site protected');
  } else if (bestPath === 'browser') {
    diagnosis = 'needs-browser'; action = 'browser';
    diagnosisReason = browserEstimated
      ? 'entry page failed over HTTP but the site answers — free local browser render estimated'
      : 'content requires a local browser render (free)';
  } else if (home && home.ok) {
    diagnosis = 'no-signal'; action = 'check-url';
    diagnosisReason = 'reachable but no product data found on this page';
  } else {
    diagnosis = 'unreachable'; action = 'check-url';
    diagnosisReason = 'the page could not be fetched from here';
  }

  const freeFields = fields.filter((k) => status[k] === 'free');
  const browserFields = fields.filter((k) => status[k] === 'browser');
  const unlockFields = fields.filter((k) => status[k] === 'unlock');
  const absentFields = fields.filter((k) => status[k] === 'absent');

  // A one-line, product-language verdict — what the user CAN do, not the first failure.
  let headline;
  if (FREE_PATHS.includes(bestPath)) {
    const extra = unlockFields.length ? ` · ${unlockFields.map((f) => labels[f]).join(', ')} via déblocage` : '';
    headline = `Extraction gratuite possible · ${productCount ?? '?'} ${isVideo ? 'vidéo(s) détectée(s)' : 'produit(s) détecté(s)'} · ${freeFields.map((f) => labels[f]).join(', ')}${extra}`;
  } else if (bestPath === 'unlock') {
    headline = `Site protégé · déblocage assisté${knownCount != null ? ` · ~${knownCount} produits` : ''} · champs attendus : ${FIELDS.map((f) => FIELD_LABEL[f]).slice(0, 5).join(', ')}`;
  } else if (bestPath === 'browser') {
    headline = 'Rendu navigateur local nécessaire (gratuit) · produits attendus après rendu';
  } else if (diagnosis === 'no-signal') {
    headline = 'Aucune donnée produit sur cette page — vérifie l\'URL (catégorie/produit)';
  } else {
    headline = 'Page injoignable depuis ici';
  }

  return {
    domain, url_type: urlType, locale, platform: platform || 'unknown',
    diagnosis, diagnosis_reason: diagnosisReason, action,
    best_path: bestPath, product_count: productCount, coverage_source: coverageSource,
    sample_url: (sample && (sample.source_url || sample.sourceUrl || sample.canonicalUrl))
      || sampledFromSitemap
      || (bestPath === 'recipe' ? entryUrl : (sample ? ((home && home.url) || entryUrl) : null)),
    rendering: home && home.ok ? (homeNeedsBrowser ? 'CSR (browser likely)' : 'SSR/static') : (bestPath === 'recipe' ? 'API (internal)' : 'unknown'),
    product_data: coverage ? 'detected' : (protectedSite ? 'behind-unlock' : 'not-detected'),
    coverage, field_status: status,
    free_fields: freeFields, browser_fields: browserFields, unlock_fields: unlockFields, absent_fields: absentFields,
    protected_site: protectedSite, known_needs_unlock: knownNeedsUnlock, known_count: knownCount,
    headline,
    // Content type of the analysis (requested / recognised) and the field list it reads.
    content_type: contentType, fields, field_labels: labels,
    robots_sitemaps: robots?.sitemaps || [],
    confidence: coverage ? Math.round((freeFields.length / fields.length) * 100) / 100 : 0,
    fetch_stats: fetcher.stats,
  };
}

/** Render a probe result as the human-readable SOURCE ANALYSIS block. */
export function formatProbe(p) {
  const st = p.field_status || {};
  const loc = p.locale && (p.locale.country || p.locale.language)
    ? `${p.locale.country || '?'} / ${p.locale.language || '?'}${p.locale.source ? ` (${p.locale.source})` : ''}`
    : 'not detected';
  const lines = [
    'ANALYSE DE LA SOURCE',
    `▶ ${p.headline}`,
    '',
    `domaine :          ${p.domain}`,
    `type d'URL :       ${p.url_type}`,
    `pays / langue :    ${loc}`,
    `plateforme :       ${p.platform}`,
    ...(p.content_type ? [`type de contenu :  ${p.content_type.type === 'video' ? 'vidéos' : 'produits'}${p.content_type.requested === 'auto' ? ' (reconnu automatiquement)' : ''}`] : []),
    `verdict :          ${p.diagnosis} — ${p.diagnosis_reason}`,
    `voie retenue :     ${p.best_path || '(aucune)'}`,
    `${p.content_type && p.content_type.type === 'video' ? 'vidéos :  ' : 'produits :'}         ${p.product_count ?? '—'}`,
    `échantillon :      ${p.sample_url || '(depuis la grille de l\'URL)'}`,
    '--- champs (✓ gratuit · ⟳ après rendu (gratuit) · € déblocage · ✗ absent) ---',
  ];
  const fields = Array.isArray(p.fields) && p.fields.length ? p.fields : FIELDS;
  const labels = p.field_labels || FIELD_LABEL;
  for (const k of fields) lines.push(`${((labels[k] || k) + ' :').padEnd(14)} ${STATUS_MARK[st[k]] || '✗'}`);
  lines.push('---', `confiance (gratuit) :  ${p.confidence}`);
  return lines.join('\n');
}
