/**
 * Video metadata — GENERIC and PORTABLE (regex on an HTML / XML string: no DOM,
 * no Node built-ins; runs in Node and in the extension's service worker).
 *
 * What a page or a sitemap STATES about its videos, read in this order of trust:
 *   1. JSON-LD VideoObject (standalone, the `video` of a page, the items of an ItemList);
 *   2. a video sitemap (<video:video> under each <url>);
 *   3. Open Graph (og:type video.*, og:video, twitter:player) and microdata VideoObject;
 *   4. the page's own <video> / <iframe> player;
 *   5. repeated cards: a link with a thumbnail, a title and a duration.
 *
 * Metadata only: title, page URL, thumbnail, duration, views, publication date,
 * description, channel or brand NAME, categories and tags, embed URL. Never a
 * media file, never a download, never a person: an author of type Person, an
 * uploader, a username, an avatar or a profile link is not read. No site name
 * anywhere: the URL shapes below are DATA (generic path words), not rules for a site.
 */
import { bestFromSrcset } from './images.mjs';

// ── Portable primitives ───────────────────────────────────────────────────────
const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;|&#x27;/gi, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/\s+/g, ' ').trim();
const stripTags = (s) => decode(String(s || '').replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '));
const lc = (s) => String(s == null ? '' : s).toLowerCase();
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
function attr(tag, name) {
  const m = String(tag || '').match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? '') : null;
}
function absolute(href, base) {
  if (!href) return null;
  try { return new URL(String(href).trim(), base || undefined).toString(); } catch { return null; }
}
const MEDIA_FILE_RE = /\.(mp4|webm|m3u8|mpd|mov|m4v|ogv|avi|mkv|mp3|flv)(\?|#|$)/i;
const DURATION_TOKEN_RE = /(?:^|[^\d:])(\d{1,2}:\d{2}(?::\d{2})?)(?![\d:])/;
const GENERIC_SEGMENTS = new Set(['watch', 'video', 'videos', 'v', 'w', 'embed', 'play', 'player', 'media', 'clip', 'clips', 'episode', 'episodes', 'talk', 'talks', 'film', 'films', 'recording', 'recordings', 'view', 'details', 'index.html', 'index.php']);

/**
 * A video PAGE URL, by its path shape (generic words, never a host): /watch?v=…,
 * /videos/<slug>, /video/<slug>, /v/<id>, /w/<id>, /embed/<id>, /media/<slug>,
 * /clip/<slug>, /episode/<slug>, /talk/<slug>, /film/<slug>, /recording/<slug>.
 * A listing root under the same words (/videos/, /videos/trending, /videos/page/2)
 * is NOT a video page.
 */
const NOT_ITEM = '(?!(?:page|p|tag|tags|category|categories|cat|search|recent|recently-added|trending|popular|latest|all|most|most-viewed|most-liked|local|overview|browse|sort|new|top|live|upcoming|channel|channels|playlist|playlists)(?:[/?#]|$))';
export const VIDEO_URL_RE = new RegExp(
  `(\\/watch\\/?(?:\\?|$)|[?&]v=[\\w-]{2,}|\\/videos?\\/${NOT_ITEM}[^/?#]+|\\/(?:v|w)\\/[\\w.-]+|\\/embed\\/[\\w.-]+|\\/(?:media|clips?|episodes?|talks?|films?|recordings?)\\/${NOT_ITEM}[^/?#]+)`, 'i');
/** A page that LISTS videos (crawled deeper, never an item): a videos root, a channel, a playlist, a category, a tag, a series, a conference. */
export const VIDEO_LISTING_RE = /(\/videos?\/?(?:[?#]|$)|\/videos?\/(?:page|p|tag|tags|category|categories|cat|recent|recently-added|trending|popular|latest|all|most|most-viewed|most-liked|local|overview|browse|sort|new|top|live|upcoming)(?:[/?#]|$)|\/channels?\/|\/playlists?\/|\/series\/|\/shows?\/|\/categor(?:y|ies)\/|\/tags?\/|\/browse(?:[/?#]|$)|\/explore(?:[/?#]|$)|\/[cb]\/[^/?#]+\/?(?:[?#]|$)|\/conferences?\/|\/events?\/|\/collections?\/|\/playlist\?)/i;

/** A sub-resource of a video page (its playlist, audio, embed, download, comments…): the page itself is the item. */
const VIDEO_SUBRESOURCE_RE = /\/(?:v|w|watch|videos?|embed|media|clips?|episodes?|talks?|films?|recordings?)\/[^/?#]+\/(?:playlist|audio|embed|oembed|download|related|comments?|share|transcript|subtitles|captions|chapters|stats)\/?(?:[?#]|$)/i;
export function isVideoLink(url) { const u = String(url || ''); return VIDEO_URL_RE.test(u) && !VIDEO_SUBRESOURCE_RE.test(u); }
export function isVideoListingLink(url) { return VIDEO_LISTING_RE.test(String(url || '')) && !isVideoLink(url); }

const TRACKING = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'gclid', 'fbclid', 'msclkid', 'ref', 'ref_', 'feature', 'list', 'index', 't', 'start', 'autoplay', 'si', 'pp', 'ab_channel'];
/** One key per video page: no fragment, no tracking or playback parameter, no trailing slash, lower-case host. */
export function normalizeVideoUrl(u) {
  try {
    const x = new URL(String(u));
    x.hash = '';
    x.hostname = x.hostname.toLowerCase().replace(/^www\./, '');
    for (const k of [...x.searchParams.keys()]) if (TRACKING.includes(k.toLowerCase())) x.searchParams.delete(k);
    x.pathname = x.pathname.replace(/\/+$/, '') || '/';
    return x.toString();
  } catch { return String(u || '').split('#')[0].replace(/\/+$/, ''); }
}

/** The stable id a video URL carries (?v=…, ?id=…, or the last specific path segment); null when the URL has none. */
export function videoIdFromUrl(u) {
  let x; try { x = new URL(String(u)); } catch { return null; }
  for (const k of ['v', 'id', 'vid', 'video_id', 'videoid', 'video']) { const p = x.searchParams.get(k); if (p && /^[\w.-]{2,}$/.test(p)) return p; }
  const segs = x.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  while (segs.length && GENERIC_SEGMENTS.has(segs[segs.length - 1].toLowerCase())) segs.pop();
  const last = segs.pop();
  return last && last.length >= 2 ? last : null;
}

// ── Values ────────────────────────────────────────────────────────────────────
/** Seconds from an ISO 8601 duration (PT1H2M3S), a clock ("1:02:03", "12:34"), plain seconds, or "1 h 02 min 03 s". */
export function parseDuration(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  const s = String(v).trim();
  let m = s.match(/^P(?:(\d+(?:[.,]\d+)?)D)?(?:T(?:(\d+(?:[.,]\d+)?)H)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)S)?)?$/i);
  if (m && (m[1] || m[2] || m[3] || m[4])) {
    const n = (x) => (x ? parseFloat(String(x).replace(',', '.')) : 0);
    const sec = n(m[1]) * 86400 + n(m[2]) * 3600 + n(m[3]) * 60 + n(m[4]);
    return sec > 0 ? Math.round(sec) : null;
  }
  m = s.match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
  if (m) return m[3] != null ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
  if (/^\d+$/.test(s)) { const n = Number(s); return n > 0 ? n : null; }
  if (/^\d+(?:[.,]\d+)?$/.test(s)) { const n = parseFloat(s.replace(',', '.')); return n > 0 ? Math.round(n) : null; }
  const h = s.match(/(\d+)\s*(?:h|hr|heures?|hours?|std|uur)\b/i);
  const mi = s.match(/(\d+)\s*(?:min|mn|minutes?|minuten)\b/i);
  const se = s.match(/(\d+)\s*(?:s|sec|secondes?|seconds?|sek)\b/i);
  if (h || mi || se) { const sec = (h ? Number(h[1]) * 3600 : 0) + (mi ? Number(mi[1]) * 60 : 0) + (se ? Number(se[1]) : 0); return sec > 0 ? sec : null; }
  return null;
}
/** "h:mm:ss" above one hour, else "m:ss". */
export function formatDuration(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return null;
  const h = Math.floor(n / 3600); const m = Math.floor((n % 3600) / 60); const s = Math.round(n % 60);
  const two = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
/** An integer count from a number or a text ("1 234", "1,234", "12 k", "1.2M vues"); null when none. */
export function parseCount(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  const s = String(v).trim();
  const k = s.match(/(\d+(?:[.,]\d+)?)\s*([kKmM])\b/);
  if (k) { const base = parseFloat(k[1].replace(',', '.')); return Math.round(base * (k[2].toLowerCase() === 'k' ? 1e3 : 1e6)); }
  const d = s.replace(/[^\d]/g, '');
  return d ? Number(d) : null;
}
/** "YYYY-MM-DD" from any parseable date; null otherwise. */
export function parseDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);   // keep the stated day, never shifted by a time zone
  return new Date(t).toISOString().slice(0, 10);
}

// ── JSON-LD ───────────────────────────────────────────────────────────────────
/** Every JSON-LD node of the page (unwraps @graph and arrays). */
export function jsonLdNodes(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const visit = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(visit); return; }
      if (Array.isArray(n['@graph'])) n['@graph'].forEach(visit);
      out.push(n);
    };
    visit(data);
  }
  return out;
}
const VIDEO_TYPES = ['videoobject', 'clip', 'movie', 'episode', 'tvepisode', 'musicvideoobject'];
const typesOf = (n) => asArray(n && n['@type']).map(lc);
export function isVideoNode(n) { return !!n && typeof n === 'object' && typesOf(n).some((t) => VIDEO_TYPES.includes(t)); }
/** Video nodes a page's JSON-LD describes: standalone, the `video` of a page / article, the items of an ItemList. */
export function videoNodes(nodes) {
  const out = []; const seen = new Set();
  const push = (n) => { if (n && typeof n === 'object' && isVideoNode(n) && !seen.has(n)) { seen.add(n); out.push(n); } };
  for (const n of nodes) {
    push(n);
    for (const v of asArray(n.video)) push(v);
    for (const v of asArray(n.mainEntity)) push(v);
    if (Array.isArray(n.itemListElement)) for (const el of n.itemListElement) { if (!el || typeof el !== 'object') continue; push(el.item && typeof el.item === 'object' ? el.item : el); }
  }
  return out;
}

function pickImages(v) {
  const out = [];
  for (const i of asArray(v)) {
    if (typeof i === 'string' && i.trim()) out.push(i.trim());
    else if (i && typeof i === 'object') { const u = str(i.url) || str(i.contentUrl) || str(i.src); if (u) out.push(u); }
  }
  return [...new Set(out)];
}
// A channel / brand name: an Organization (or an untyped publisher) by name — never a Person.
function orgName(v, { untypedOk = false } = {}) {
  for (const x of asArray(v)) {
    if (typeof x === 'string') { if (untypedOk && x.trim()) return x.trim(); continue; }
    if (!x || typeof x !== 'object') continue;
    const t = typesOf(x);
    if (t.includes('person')) continue;
    if (t.length === 0 && !untypedOk) continue;
    const n = str(x.name) || str(x.legalName) || str(x.alternateName);
    if (n) return n;
  }
  return null;
}
function viewsOf(stat) {
  for (const s of asArray(stat)) {
    if (!s || typeof s !== 'object') continue;
    const type = lc(typeof s.interactionType === 'string' ? s.interactionType : (s.interactionType && s.interactionType['@type']) || '');
    if (type && !/watch|view|play/.test(type)) continue;
    const n = parseCount(s.userInteractionCount);
    if (n != null) return n;
  }
  return null;
}
function tagsOf(keywords, max = 10) {
  const list = Array.isArray(keywords) ? keywords : (typeof keywords === 'string' ? keywords.split(/[,;|]/) : []);
  return [...new Set(list.map((k) => (typeof k === 'string' ? k.trim() : '')).filter((k) => k && k.length <= 60))].slice(0, max);
}
function ratingOf(ar) {
  const a = Array.isArray(ar) ? ar[0] : ar;
  if (!a || typeof a !== 'object') return {};
  const value = Number(a.ratingValue); const best = Number(a.bestRating) > 0 ? Number(a.bestRating) : 5;
  const count = [a.reviewCount, a.ratingCount].map(Number).find((n) => Number.isInteger(n) && n >= 0);
  if (!Number.isFinite(value) && count == null) return {};
  const rating = Number.isFinite(value) && value >= 0 && value <= best ? Math.round((value / best) * 5 * 100) / 100 : null;
  return { rating: count === 0 ? null : rating, reviewCount: count != null ? count : null };
}
const pageUrlOf = (n) => str(n.url) || str(n['@id']) || (n.mainEntityOfPage && (str(n.mainEntityOfPage) || str(n.mainEntityOfPage['@id']))) || null;

/** Build the extra, additive columns of a video (only the known values). */
export function videoColumns({ duration, views, published, embed, tags } = {}) {
  const c = {};
  const d = parseDuration(duration); if (d) c.duration = formatDuration(d);
  const vw = parseCount(views); if (vw != null) c.views = String(vw);
  const p = parseDate(published); if (p) c.published_at = p;
  if (embed && !MEDIA_FILE_RE.test(embed)) c.embed_url = embed;
  const t = Array.isArray(tags) ? tags.filter(Boolean) : [];
  if (t.length) c.tags = t.join(', ');
  return Object.keys(c).length ? c : undefined;
}

/** A card (RawProduct-ish) built from the given video facts; `url` is the PAGE. */
export function videoCard({ name, description, url, thumbnail, duration, views, published, embed, channel, categories, tags, rating, reviewCount, strategy, confidence }, base) {
  const page = absolute(url, base);
  const thumbs = pickImages(thumbnail).map((t) => absolute(t, base)).filter(Boolean);
  const embedAbs = embed ? absolute(embed, base) : null;
  const card = {
    name: name ? decode(name) : null, description: description ? decode(description) : null,
    price: null, listPrice: null, currency: null, availability: null,
    gtin: null, sku: page ? videoIdFromUrl(page) : null, mpn: null, brand: null,
    images: thumbs, category: channel ? decode(channel) : null,
    breadcrumb: (categories || []).map((c) => decode(c)).filter(Boolean),
    weightText: null, sourceUrl: page, canonicalUrl: page,
    strategy: strategy || 'video', confidence: confidence ?? 0.5, contentType: 'video',
  };
  if (rating != null) card.rating = rating;
  if (reviewCount != null) card.reviewCount = reviewCount;
  const cols = videoColumns({ duration, views, published, embed: embedAbs, tags });
  if (cols) card.columns = cols;
  return card;
}

/** Map one JSON-LD video node to a card; `pageUrl` is used when the node states no page URL. */
export function videoFromNode(n, pageUrl, { usePageUrl = true } = {}) {
  if (!isVideoNode(n)) return null;
  const stated = pageUrlOf(n);
  const url = stated && !MEDIA_FILE_RE.test(stated) ? stated : (usePageUrl ? pageUrl : null);
  if (!url) return null;
  const { rating, reviewCount } = ratingOf(n.aggregateRating);
  return videoCard({
    name: str(n.name) || str(n.headline) || str(n.title),
    description: str(n.description) || str(n.abstract),
    url, thumbnail: n.thumbnailUrl ?? n.thumbnail ?? n.image,
    duration: n.duration, views: viewsOf(n.interactionStatistic),
    published: n.uploadDate || n.datePublished || n.dateCreated,
    embed: str(n.embedUrl),
    channel: orgName(n.publisher, { untypedOk: true }) || orgName(n.author) || orgName(n.creator) || orgName(n.brand),
    categories: asArray(n.genre).map(str).filter(Boolean).concat(asArray(n.category).map((c) => (typeof c === 'string' ? c : str(c && c.name))).filter(Boolean)),
    tags: tagsOf(n.keywords), rating, reviewCount,
    strategy: 'video-jsonld', confidence: 0.9,
  }, pageUrl);
}

// ── Open Graph / microdata / player ──────────────────────────────────────────
function meta(html, prop) {
  const s = String(html || '');
  const re1 = new RegExp(`<meta\\b[^>]*(?:property|name|itemprop)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta\\b[^>]*content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${prop}["']`, 'i');
  const m = s.match(re1) || s.match(re2);
  return m ? decode(m[1]) : null;
}
function metaAll(html, prop) {
  const out = []; const s = String(html || '');
  const re = new RegExp(`<meta\\b[^>]*(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'gi');
  let m; while ((m = re.exec(s))) { const v = decode(m[1]); if (v) out.push(v); }
  return out;
}
const titleOf = (html) => decode((String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
const h1Of = (html) => stripTags((String(html || '').match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
const canonicalOf = (html) => { const m = String(html || '').match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || String(html || '').match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i); return m ? decode(m[1]) : null; };

/** The video the page describes in Open Graph / Twitter card tags, or null. */
export function videoFromOpenGraph(html, pageUrl) {
  const ogType = lc(meta(html, 'og:type'));
  const ogVideo = meta(html, 'og:video') || meta(html, 'og:video:url') || meta(html, 'og:video:secure_url');
  const player = meta(html, 'twitter:player');
  if (!/^video/.test(ogType) && !ogVideo && !player) return null;
  const name = meta(html, 'og:title') || meta(html, 'twitter:title') || h1Of(html) || titleOf(html);
  if (!name) return null;
  return videoCard({
    name, description: meta(html, 'og:description') || meta(html, 'description'),
    url: meta(html, 'og:url') || canonicalOf(html) || pageUrl,
    thumbnail: meta(html, 'og:image') || meta(html, 'og:image:url') || meta(html, 'twitter:image'),
    duration: meta(html, 'video:duration') || meta(html, 'og:video:duration'),
    published: meta(html, 'video:release_date') || meta(html, 'og:video:release_date') || meta(html, 'article:published_time'),
    embed: [ogVideo, player].find((u) => u && !MEDIA_FILE_RE.test(u)) || null,
    tags: metaAll(html, 'video:tag'),
    strategy: 'video-meta', confidence: 0.6,
  }, pageUrl);
}

/** Microdata VideoObject (itemtype …/VideoObject with itemprop values), or null. */
export function videoFromMicrodata(html, pageUrl) {
  const s = String(html || '');
  if (!/itemtype=["'][^"']*schema\.org\/VideoObject["']/i.test(s)) return null;
  const prop = (name) => {
    const tag = s.match(new RegExp(`<(?:meta|link|img|video|source|iframe|a)\\b[^>]*itemprop=["']${name}["'][^>]*>`, 'i'));
    if (tag) { const v = attr(tag[0], 'content') || attr(tag[0], 'src') || attr(tag[0], 'href') || attr(tag[0], 'datetime'); if (v) return v; }
    const el = s.match(new RegExp(`<([a-z0-9]+)\\b[^>]*itemprop=["']${name}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i'));
    return el ? stripTags(el[2]) : null;
  };
  const name = prop('name') || prop('headline');
  if (!name) return null;
  return videoCard({
    name, description: prop('description'), url: prop('url') || canonicalOf(html) || pageUrl,
    thumbnail: prop('thumbnailUrl') || prop('thumbnail') || prop('image'),
    duration: prop('duration'), published: prop('uploadDate') || prop('datePublished'),
    embed: prop('embedUrl'), views: (() => { const c = prop('interactionCount'); const m = c && String(c).match(/(?:UserPlays|WatchAction|views?)[:\s]*([\d.,\s]+)/i); return m ? m[1] : null; })(),
    strategy: 'video-microdata', confidence: 0.7,
  }, pageUrl);
}

/** The page's own player (<video> with a poster / source, an <iframe> embed) with the page title, or null. */
export function videoFromPlayer(html, pageUrl) {
  const s = String(html || '');
  const video = (s.match(/<video\b[^>]*>/i) || [])[0] || null;
  const iframe = (s.match(/<iframe\b[^>]*src=["'][^"']*(?:embed|player|video|watch)[^"']*["'][^>]*>/i) || [])[0] || null;
  if (!video && !iframe) return null;
  const name = h1Of(html) || meta(html, 'og:title') || titleOf(html);
  if (!name) return null;
  const poster = video ? attr(video, 'poster') : null;
  const src = iframe ? attr(iframe, 'src') : null;
  return videoCard({
    name, description: meta(html, 'description'), url: canonicalOf(html) || pageUrl,
    thumbnail: poster || meta(html, 'og:image'), embed: src && !MEDIA_FILE_RE.test(src) ? src : null,
    strategy: 'video-dom', confidence: 0.4,
  }, pageUrl);
}

/** Does the page carry any video signal at all (schema, Open Graph, player)? Cheap. */
export function hasVideoSignals(html) {
  const s = String(html || '');
  return /"@type"\s*:\s*"(?:VideoObject|Clip|Movie|TVEpisode|Episode|MusicVideoObject)"/i.test(s)
    || /<meta\b[^>]*(?:property|name)=["']og:type["'][^>]*content=["']video/i.test(s)
    || /<meta\b[^>]*(?:property|name)=["']og:video(?::url|:secure_url)?["']/i.test(s)
    || /<meta\b[^>]*name=["']twitter:player["']/i.test(s)
    || /<video\b/i.test(s)
    || /<iframe\b[^>]*src=["'][^"']*(?:embed|player)/i.test(s);
}

// ── One page ──────────────────────────────────────────────────────────────────
const empty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
function gapFill(base, extra) {
  if (!extra) return base;
  for (const k of Object.keys(extra)) {
    if (k === 'strategy' || k === 'confidence') continue;
    if (k === 'columns' && extra.columns) { base.columns = { ...(extra.columns || {}), ...(base.columns || {}) }; continue; }
    if (empty(base[k]) && !empty(extra[k])) base[k] = extra[k];
  }
  return base;
}

/**
 * The video a PAGE describes (its own JSON-LD VideoObject first, then Open Graph,
 * microdata and the player as gap-fillers). Null when the page describes no video of
 * its own — a page that lists several videos without one of its own is a listing.
 */
export function extractVideoPage(html, pageUrl) {
  const s = String(html || '');
  if (!s) return null;
  const nodes = videoNodes(jsonLdNodes(s));
  const key = normalizeVideoUrl(pageUrl || '');
  let own = null;
  if (nodes.length) {
    own = nodes.find((n) => { const u = pageUrlOf(n); return u && normalizeVideoUrl(absolute(u, pageUrl) || u) === key; }) || null;
    if (!own && nodes.length <= 2) own = nodes.find((n) => !pageUrlOf(n)) || nodes[0];   // one video stated for this page
  }
  let card = own ? videoFromNode(own, pageUrl) : null;
  if (card && own) card = { ...card, sourceUrl: absolute(pageUrl, pageUrl) || card.sourceUrl, canonicalUrl: card.canonicalUrl || pageUrl };
  const og = videoFromOpenGraph(s, pageUrl);
  const md = videoFromMicrodata(s, pageUrl);
  const pl = videoFromPlayer(s, pageUrl);
  if (!card) card = og || md || pl;
  if (!card) return null;
  for (const extra of [og, md, pl]) if (extra && extra !== card) gapFill(card, extra);
  if (!card.name) return null;
  if (!card.sku) card.sku = videoIdFromUrl(card.canonicalUrl || card.sourceUrl || pageUrl);
  return card;
}

// ── Lists ─────────────────────────────────────────────────────────────────────
const STATE_PATTERNS = [
  /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  /window\.__NUXT__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
  /window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
  /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
  /<script[^>]*id=["']__APOLLO_STATE__["'][^>]*>([\s\S]*?)<\/script>/i,
];
const K = {
  name: ['title', 'name', 'headline', 'displayName'],
  duration: ['duration', 'durationSeconds', 'duration_seconds', 'lengthSeconds', 'length_seconds', 'runtime', 'durationMs', 'duration_ms', 'length'],
  thumb: ['thumbnailUrl', 'thumbnail_url', 'thumbnail', 'thumbnails', 'poster', 'previewPath', 'preview', 'image', 'cover'],
  url: ['url', 'permalink', 'watchUrl', 'watch_url', 'href', 'link', 'path', 'webUrl', 'canonicalUrl'],
  views: ['views', 'viewCount', 'view_count', 'plays', 'playCount', 'play_count', 'viewsCount'],
  published: ['publishedAt', 'published_at', 'uploadDate', 'upload_date', 'publishedDate', 'date', 'createdAt', 'created_at', 'datePublished'],
  embed: ['embedUrl', 'embed_url', 'embedPath', 'embed_path', 'playerUrl'],
  desc: ['description', 'summary', 'abstract'],
  channel: ['channel', 'brand', 'publisher', 'show', 'series'],
  tags: ['tags', 'keywords', 'categories'],
};
const first = (o, keys) => { for (const k of keys) if (o[k] != null && o[k] !== '') return o[k]; return undefined; };
function thumbOf(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) { for (const x of v) { const t = thumbOf(x); if (t) return t; } return null; }
  if (v && typeof v === 'object') return str(v.url) || str(v.src) || str(v.path) || str(v.high) || str(v.medium) || str(v.default) || null;
  return null;
}
function channelOf(v) {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object') { if (/person|user|account|member/i.test(String(v.type || v.__typename || v['@type'] || ''))) return null; return str(v.displayName) || str(v.name) || str(v.title) || null; }
  return null;
}
/** A video-shaped object in embedded state: a title, a duration, a thumbnail or a URL, and a page URL. */
function videoFromStateObject(o, base) {
  const name = str(first(o, K.name));
  if (!name) return null;
  let dur = first(o, K.duration);
  if (typeof dur === 'number' && first(o, ['durationMs', 'duration_ms']) === dur) dur = dur / 1000;
  if (dur == null || dur === '') return null;
  const urlRaw = first(o, K.url);
  const url = typeof urlRaw === 'string' && urlRaw ? absolute(urlRaw, base) : null;
  if (!url || MEDIA_FILE_RE.test(url)) return null;
  const thumb = thumbOf(first(o, K.thumb));
  if (!thumb && !isVideoLink(url)) return null;
  const tags = first(o, K.tags);
  return videoCard({
    name, description: str(first(o, K.desc)), url, thumbnail: thumb, duration: dur,
    views: first(o, K.views), published: first(o, K.published), embed: str(first(o, K.embed)),
    channel: channelOf(first(o, K.channel)),
    tags: Array.isArray(tags) ? tags.map((t) => (typeof t === 'string' ? t : str(t && t.name))).filter(Boolean) : (typeof tags === 'string' ? tagsOf(tags) : []),
    strategy: 'video-embedded-state', confidence: 0.65,
  }, base);
}
function videosFromState(html, base) {
  const out = [];
  const s = String(html || '');
  for (const re of STATE_PATTERNS) {
    const m = s.match(re);
    if (!m || !m[1]) continue;
    let root; try { root = JSON.parse(m[1].trim()); } catch { continue; }
    const stack = [root]; let seen = 0;
    while (stack.length && seen < 30000 && out.length < 2000) {
      const n = stack.pop();
      if (!n || typeof n !== 'object') continue;
      seen++;
      if (Array.isArray(n)) { for (const x of n) if (x && typeof x === 'object') stack.push(x); continue; }
      try { const c = videoFromStateObject(n, base); if (c) out.push(c); } catch { /* skip node */ }
      for (const k in n) { const v = n[k]; if (v && typeof v === 'object') stack.push(v); }
    }
  }
  return out;
}

// Repeated cards in the markup: a link whose region holds a thumbnail and a title,
// with a duration token or a video-page URL. Each region runs from the anchor to the
// next anchor, so a duration or a date belongs to the right card.
const SKIP_HREF = (h) => !h || h.startsWith('#') || /^(javascript:|mailto:|tel:|data:)/i.test(h);
function cardThumb(region, base) {
  const imgs = region.match(/<img\b[^>]*>/gi) || [];
  for (const tag of imgs) {
    let src = attr(tag, 'src') || attr(tag, 'data-src') || attr(tag, 'data-original') || attr(tag, 'data-lazy');
    if (!src) src = bestFromSrcset(attr(tag, 'srcset') || attr(tag, 'data-srcset'));
    if (!src || /^data:/i.test(src) || /(^|\/)(1x1|pixel|blank|spacer|placeholder)\.(gif|png|svg)/i.test(src)) continue;
    // Never a person's avatar or profile picture.
    if (/avatar|profile|user-?pic|account/i.test(tag)) continue;
    const abs = absolute(src, base); if (abs) return abs;
  }
  const video = (region.match(/<video\b[^>]*>/i) || [])[0];
  const poster = video && attr(video, 'poster');
  return poster ? absolute(poster, base) : null;
}
const DURATION_TOKENS_G = /(?:^|[^\d:])\d{1,2}:\d{2}(?::\d{2})?(?![\d:])/g;
const okTitle = (t) => !!t && t.length >= 2 && t.length <= 200 && !/^\d[\d\s.,]*\s*(?:vues|views|visualizaciones|weergaven|aufrufe)\b/i.test(t);
/**
 * The card's title: the link's title / aria-label, the link's own text, a card
 * heading (h3–h6: an h1/h2 after the link is a section title, never the card's),
 * the thumbnail's alt, a title-named element, else the first line of text.
 */
function cardTitle(region, anchorTag, innerText) {
  for (const name of ['title', 'aria-label']) { const a = attr(anchorTag, name); if (okTitle(a) && !DURATION_TOKEN_RE.test(a)) return a; }
  const own = stripTags(String(innerText || '')).replace(DURATION_TOKENS_G, ' ').replace(/\s+/g, ' ').trim();
  if (okTitle(own)) return own;
  const h = region.match(/<(h[3-6])\b[^>]*>([\s\S]*?)<\/\1>/i);
  const ht = h && stripTags(h[2]);
  if (okTitle(ht)) return ht;
  const img = (region.match(/<img\b[^>]*>/i) || [])[0];
  const alt = img && attr(img, 'alt');
  if (okTitle(alt) && !/avatar|logo/i.test(alt)) return alt;
  const titled = region.match(/<[a-z0-9]+\b[^>]*(?:class|data-testid|itemprop)=["'][^"']*(?:title|name|heading)[^"']*["'][^>]*>([\s\S]*?)<\//i);
  const tt = titled && stripTags(titled[1]);
  if (okTitle(tt)) return tt;
  const text = stripTags(region.slice(0, 1200)).replace(DURATION_TOKENS_G, '  ').split(/\s{2,}|·|\|/).map((x) => x.trim()).filter((x) => okTitle(x));
  return text[0] || null;
}
function cardDuration(region) {
  const dt = region.match(/<time\b[^>]*datetime=["'](P[^"']+)["']/i);
  if (dt) { const d = parseDuration(dt[1]); if (d) return d; }
  const dur = region.match(/<[a-z0-9]+\b[^>]*(?:class|data-testid|itemprop|aria-label)=["'][^"']*duration[^"']*["'][^>]*>([\s\S]*?)<\//i);
  if (dur) { const d = parseDuration(stripTags(dur[1])) || parseDuration((stripTags(dur[1]).match(DURATION_TOKEN_RE) || [])[1]); if (d) return d; }
  const m = stripTags(region).match(DURATION_TOKEN_RE);
  return m ? parseDuration(m[1]) : null;
}
function cardViews(region) {
  const m = stripTags(region).match(/(\d[\d\s.,]*\s*[kKmM]?)\s*(?:vues|views|visualizaciones|visualizações|weergaven|aufrufe|visualizzazioni|lectures|plays)\b/i);
  return m ? parseCount(m[1]) : null;
}
function cardDate(region) {
  const t = region.match(/<time\b[^>]*datetime=["']([^"']+)["']/i);
  return t && !/^P/i.test(t[1]) ? t[1] : null;
}
/**
 * @returns {object[]} cards from the repeated markup (≥ 3 tiles), deduplicated by page URL.
 */
export function videoCardsFromDom(html, baseUrl, { minTiles = 3, maxTiles = 300 } = {}) {
  const s = String(html || '');
  if (!s) return [];
  const anchors = [];
  const aRe = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  let m;
  while ((m = aRe.exec(s)) && anchors.length < 1200) {
    const href = m[2] ?? m[3] ?? m[4];
    if (SKIP_HREF(href)) continue;
    const abs = absolute(decode(href), baseUrl);
    if (!abs || MEDIA_FILE_RE.test(abs)) continue;
    anchors.push({ tag: m[0], href: abs, at: m.index, end: aRe.lastIndex });
  }
  if (anchors.length < minTiles) return [];
  const byKey = new Map();
  // Each anchor owns what FOLLOWS it up to the next anchor (its own content, then
  // the gap: a heading, the duration, a date). It never reads backwards into the
  // previous card — except for a thumbnail placed just before the link, read from
  // the gap after the previous anchor's closing tag only when it has none of its own.
  const closeOf = (a) => { const c = s.indexOf('</a>', a.end); return c < 0 ? a.end : c + 4; };
  for (let i = 0; i < anchors.length && byKey.size < maxTiles; i++) {
    const a = anchors[i];
    const next = anchors[i + 1] ? anchors[i + 1].at : Math.min(s.length, a.end + 2500);
    const region = s.slice(a.at, Math.max(next, a.end));
    // A person's link (profile, account, channel avatar) is never a card.
    if (/\/(?:user|users|account|accounts|profile|profiles|member|members|u)\/[^/?#]+/i.test(a.href) || /rel=["'][^"']*author/i.test(a.tag)) continue;
    let thumb = cardThumb(region, baseUrl);
    if (!thumb && i > 0) {
      const prevClose = closeOf(anchors[i - 1]);
      if (prevClose < a.at) thumb = cardThumb(s.slice(Math.max(prevClose, a.at - 400), a.at), baseUrl);
    }
    const duration = cardDuration(region);
    const videoHref = isVideoLink(a.href);
    if (!thumb && !duration) continue;
    if (!duration && !videoHref) continue;
    const name = cardTitle(region, a.tag, s.slice(a.end, Math.min(closeOf(a), a.end + 600)));
    if (!name) continue;
    const key = normalizeVideoUrl(a.href);
    const card = videoCard({ name, url: a.href, thumbnail: thumb, duration, views: cardViews(region), published: cardDate(region), strategy: 'video-dom-grid', confidence: 0.45 }, baseUrl);
    const prev = byKey.get(key);
    if (prev) gapFill(prev, card); else byKey.set(key, card);
  }
  const cards = [...byKey.values()].filter((c) => c.name && (c.images.length || (c.columns && c.columns.duration)));
  return cards.length >= minTiles ? cards : [];
}

/**
 * Every video a LISTING page describes: JSON-LD video nodes (ItemList included),
 * video-shaped objects in the embedded state, then the repeated cards of the markup.
 * Cards for the same page URL are merged (gap-fill); dedup by normalised URL, never by title.
 * @returns {{ cards: object[], count: number, pagination: null }}
 */
export function extractVideoCards(html, baseUrl) {
  const s = String(html || '');
  if (!s) return { cards: [], count: 0, pagination: null };
  const byKey = new Map(); const cards = [];
  const add = (c) => {
    if (!c || !c.name) return;
    const url = c.canonicalUrl || c.sourceUrl;
    if (!url) return;
    const k = normalizeVideoUrl(url);
    const prev = byKey.get(k);
    if (prev) { gapFill(prev, c); return; }
    byKey.set(k, c); cards.push(c);
  };
  for (const n of videoNodes(jsonLdNodes(s))) add(videoFromNode(n, baseUrl, { usePageUrl: false }));
  for (const c of videosFromState(s, baseUrl)) add(c);
  if (cards.length < 3) for (const c of videoCardsFromDom(s, baseUrl)) add(c);
  return { cards, count: cards.length, pagination: null };
}

/** The video-page links a page exposes (its cards and its anchors of a video-page shape), absolute, deduplicated. */
export function videoLinks(html, baseUrl) {
  const out = new Map();
  for (const c of extractVideoCards(html, baseUrl).cards) { const u = c.canonicalUrl || c.sourceUrl; if (u) out.set(normalizeVideoUrl(u), u); }
  const re = /<a\b[^>]*href=["']([^"'#\s]+)["']/gi; let m;
  while ((m = re.exec(String(html || '')))) { const abs = absolute(decode(m[1]), baseUrl); if (abs && isVideoLink(abs) && !MEDIA_FILE_RE.test(abs)) { const k = normalizeVideoUrl(abs); if (!out.has(k)) out.set(k, abs); } }
  return [...out.values()];
}

// ── Video sitemaps ────────────────────────────────────────────────────────────
const xmlTag = (block, name) => { const m = block.match(new RegExp(`<video:${name}\\b[^>]*>([\\s\\S]*?)<\\/video:${name}>`, 'i')); return m ? decode(m[1]) : null; };
const xmlTags = (block, name) => { const out = []; const re = new RegExp(`<video:${name}\\b[^>]*>([\\s\\S]*?)<\\/video:${name}>`, 'gi'); let m; while ((m = re.exec(block))) { const v = decode(m[1]); if (v) out.push(v); } return out; };
/**
 * Entries of a video sitemap: { url, name, description, thumbnail, duration, published, embed, views, tags, categories }.
 * `video:uploader` and `video:content_loc` (the media file) are not read.
 */
export function parseVideoSitemap(xml) {
  const out = [];
  const s = String(xml || '');
  if (!/<video:video\b/i.test(s)) return out;
  const re = /<url\b[^>]*>([\s\S]*?)<\/url>/gi; let m;
  while ((m = re.exec(s))) {
    const block = m[1];
    const loc = (block.match(/<loc>\s*([\s\S]*?)\s*<\/loc>/i) || [])[1];
    const url = loc ? decode(loc) : null;
    const vb = (block.match(/<video:video\b[^>]*>([\s\S]*?)<\/video:video>/i) || [])[1];
    if (!url || !vb) continue;
    const player = xmlTag(vb, 'player_loc');
    out.push({
      url, name: xmlTag(vb, 'title'), description: xmlTag(vb, 'description'), thumbnail: xmlTag(vb, 'thumbnail_loc'),
      duration: xmlTag(vb, 'duration'), published: xmlTag(vb, 'publication_date'), embed: player && !MEDIA_FILE_RE.test(player) ? player : null,
      views: xmlTag(vb, 'view_count'), tags: xmlTags(vb, 'tag').slice(0, 10), categories: xmlTags(vb, 'category').slice(0, 3),
    });
  }
  return out;
}
/** A card (RawProduct-ish) from one sitemap entry. */
export function videoCardFromSitemapEntry(e) {
  if (!e || !e.url) return null;
  return videoCard({ name: e.name, description: e.description, url: e.url, thumbnail: e.thumbnail, duration: e.duration, views: e.views, published: e.published, embed: e.embed, categories: e.categories, tags: e.tags, strategy: 'video-sitemap', confidence: 0.8 }, e.url);
}
