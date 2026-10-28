/**
 * Content READER — how the engine, discovery and the analysis read ONE content
 * type (shared/content/profiles.mjs): what a page yields, what a listing lists,
 * which links are items, how a page is judged, which rule accepts a row.
 *
 *   product → the existing product functions, unchanged (e-commerce and listing
 *             cards share this reader: same extraction, same acceptance rule);
 *   video   → shared/extract/video.mjs (JSON-LD VideoObject, Open Graph, players,
 *             repeated cards, video sitemaps) and the video acceptance rule.
 *
 * Generic: no site name, no selector. A reader is a bundle of functions; the
 * engine never branches on the type's name except through this object.
 */
import { extractProduct } from './extract.mjs';
import { extractListing } from './listing.mjs';
import { needsBrowser as productNeedsBrowser } from './html-meta.mjs';
import { isProductLink, LISTING_RE } from './discover.mjs';
import { classifyHtmlPage, pageSignals, PAGE_KIND, REASON_TEXT } from '../shared/classify/page-kind.mjs';
import { extractVideoPage, extractVideoCards, videoLinks, hasVideoSignals, isVideoLink, isVideoListingLink, parseVideoSitemap, videoCardFromSitemapEntry } from '../shared/extract/video.mjs';
import { CONTENT_PROFILES, evaluateVideoEligibility, normalizeContentType } from '../shared/content/profiles.mjs';

/**
 * Judge a page read in VIDEO mode: a dead page, a page that lists videos (harvested),
 * a page without any video signal (dropped), or the page's own video (kept).
 * @returns {{kind:string, firm:boolean, reasons:Array<{code:string, detail:any, text:string}>}}
 */
export function classifyVideoPage(html, { url = '', status = null, extracted = null } = {}) {
  const reasons = [];
  const add = (code, detail = null) => reasons.push({ code, detail, text: REASON_TEXT[code] ? REASON_TEXT[code](detail) : code });
  const out = (kind, firm = true) => ({ kind, firm, reasons });
  if (status === 404 || status === 410) { add('http_not_found', `HTTP ${status}`); return out(PAGE_KIND.NOT_FOUND); }
  const sig = pageSignals(html, { url, status });
  if (sig.soft404 && !(extracted && extracted.name)) { add('soft_404', sig.soft404.slice(0, 80)); return out(PAGE_KIND.NOT_FOUND); }
  if (extracted && extracted.name) { add('video_page'); return out(PAGE_KIND.VIDEO); }
  const cards = extractVideoCards(html, url).cards.length;
  if (cards >= 3) { add('video_listing', cards); return out(PAGE_KIND.LISTING); }
  const links = videoLinks(html, url).length;
  if (links >= 6) { add('video_links', links); return out(PAGE_KIND.LISTING); }
  add('no_video_signal');
  return out(PAGE_KIND.NON_PRODUCT);
}

const PRODUCT_READER = Object.freeze({
  id: 'product',
  profile: CONTENT_PROFILES.product,
  /** What ONE page yields (the product cascade). */
  extract: (html, url) => extractProduct(html, url),
  /** What a listing page lists (structured cards, embedded state, microdata, DOM grid). */
  cards: (html, baseUrl) => extractListing(html, baseUrl),
  /** A listed card that is an item in itself: a price and a link or an id. */
  cardIsItem: (c) => !!c && c.price != null && !!(c.sourceUrl || c.sku || c.gtin),
  isItemLink: (u) => isProductLink(u),
  isListingLink: (u) => LISTING_RE.test(u),
  /** null: the engine keeps its own product listing-link reader. */
  itemLinks: null,
  classify: (html, opts) => classifyHtmlPage(html, opts),
  /** A page whose data is not an item's (no price, no reference): a listing or a non-product page. */
  thin: (raw) => !!raw && raw.price == null && !raw.sku && !raw.gtin,
  /** Worth one browser render to complete: a name without a price. */
  completable: (raw) => !!(raw && raw.name) && raw.price == null,
  usable: (raw) => !!(raw && raw.name && raw.price != null),
  incomplete: (np) => !np.name || np.price == null,
  dropEditorial: true,
  platformFeeds: true,
  sampleFirst: false,
  /** null: the engine's configured product rule (core/eligibility). */
  eligibility: null,
  sitemap: null,
});

const VIDEO_READER = Object.freeze({
  id: 'video',
  profile: CONTENT_PROFILES.video,
  extract: (html, url) => {
    const video = extractVideoPage(html, url);
    // A shell that needs a render is one with NO video signal at all: neither a
    // video of its own, nor a tag that states one, nor a list of video cards.
    const needsBrowser = !video && !hasVideoSignals(html) && productNeedsBrowser(html) && extractVideoCards(html, url).cards.length < 3;
    return { product: video, needsBrowser, strategies: video ? [video.strategy] : [] };
  },
  cards: (html, baseUrl) => { const r = extractVideoCards(html, baseUrl); return { cards: r.cards, count: r.cards.length, pagination: null }; },
  cardIsItem: (c) => !!c && !!c.name && !!(c.sourceUrl || c.canonicalUrl),
  isItemLink: (u) => isVideoLink(u),
  isListingLink: (u) => isVideoListingLink(u),
  itemLinks: (html, baseUrl) => videoLinks(html, baseUrl),
  classify: (html, { url, status, extracted } = {}) => classifyVideoPage(html, { url, status, extracted }),
  thin: (raw) => !raw || !raw.name,
  /** Worth one browser render: a title with neither a thumbnail nor a description. */
  completable: (raw) => !!(raw && raw.name) && !(raw.images && raw.images.length) && !raw.description,
  usable: (raw) => !!(raw && raw.name && (raw.canonicalUrl || raw.sourceUrl)),
  incomplete: (np) => !np.name || !np.source_url,
  dropEditorial: false,
  platformFeeds: false,
  /** Listed videos already carry title, thumbnail, URL and duration: the first pages
   *  are visited as a sample; when none adds anything, the rest come from the list. */
  sampleFirst: true,
  eligibility: evaluateVideoEligibility,
  sitemap: {
    looksLike: (u) => /video/i.test(String(u || '')),
    parseEntries: (xml) => parseVideoSitemap(xml).map((e) => ({ url: e.url, card: videoCardFromSitemapEntry(e) })).filter((e) => e.card),
  },
});

/** The reader of a content type; 'auto', 'listing' and unknown values read with the product reader. */
export function readerFor(contentType) {
  return normalizeContentType(contentType) === 'video' ? VIDEO_READER : PRODUCT_READER;
}

export { PRODUCT_READER, VIDEO_READER };
