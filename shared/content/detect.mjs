/**
 * Content-type recognition on ONE page — generic signals only, no site name.
 *
 *   video   : JSON-LD VideoObject nodes, og:type video / og:video / twitter:player,
 *             players on the page, ≥ 3 repeated video cards, ≥ 3 video-sitemap entries,
 *             a video-page URL shape;
 *   product : JSON-LD Product nodes, og:type product / product:price:amount,
 *             ≥ 3 price tokens, an add-to-cart control.
 *
 * The type is `video` when its score is at least 2 AND above the product score,
 * `product` when the product score is at least 2, else null (unknown: the caller
 * keeps its default, the product reader). PORTABLE: regex on an HTML string.
 */
import { CUR } from '../extract/money.mjs';
import { jsonLdNodes, isVideoNode, extractVideoCards, isVideoLink } from '../extract/video.mjs';

const MONEY_RE = new RegExp(`(?:${CUR})\\s?\\d[\\d .,]*\\d|\\d[\\d .,]*\\d\\s?(?:${CUR})|\\d+[.,]\\d{2}\\s?(?:${CUR})`, 'gi');
const ADD_TEXT_RE = /(add to (cart|basket|bag)|ajouter au (panier|caddie)|in (de |het )?(winkelwagen|winkelmandje|mandje)|in den (warenkorb|einkaufswagen)|a[ñn]adir al (carrito|cesta)|aggiungi al carrello|buy now|acheter maintenant)/gi;
const ADD_ATTR_RE = /<(?:button|a|input|form)\b[^>]*(?:add[-_]?to[-_]?(?:cart|basket|bag)|addtocart|add-to-cart|btn-cart|product-form__submit)[^>]*>/gi;
const PRODUCT_TYPES = ['product', 'productgroup', 'productmodel', 'individualproduct', 'vehicle', 'book', 'foodproduct'];
const lc = (s) => String(s == null ? '' : s).toLowerCase();
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
function meta(html, prop) {
  const re1 = new RegExp(`<meta\\b[^>]*(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta\\b[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? m[1].trim() : null;
}

/**
 * @param {string} html
 * @param {string} [url]
 * @param {{ sitemapVideos?: number }} [extra]  entries of a video sitemap already read for the site
 * @returns {{ type: 'video'|'product'|null, scores: { video: number, product: number }, signals: string[] }}
 */
export function detectContentType(html, url = '', extra = {}) {
  const s = String(html || '');
  const signals = [];
  let video = 0; let product = 0;
  const nodes = s ? jsonLdNodes(s) : [];
  const videoNodes = nodes.filter((n) => isVideoNode(n) || asArray(n.video).some(isVideoNode) || asArray(n.mainEntity).some(isVideoNode)).length;
  const productNodes = nodes.filter((n) => asArray(n['@type']).map(lc).some((t) => PRODUCT_TYPES.includes(t))).length;
  const ogType = lc(meta(s, 'og:type'));
  const ogVideo = /^video/.test(ogType) || !!meta(s, 'og:video') || !!meta(s, 'og:video:url') || !!meta(s, 'og:video:secure_url') || !!meta(s, 'twitter:player');
  const ogProduct = /product/.test(ogType) || !!meta(s, 'product:price:amount');
  const players = (s.match(/<video\b[^>]*>/gi) || []).length + (s.match(/<iframe\b[^>]*src=["'][^"']*(?:embed|player)[^"']*["']/gi) || []).length;
  const text = s.replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const prices = (text.match(MONEY_RE) || []).length;
  const addToCart = Math.max((text.match(ADD_TEXT_RE) || []).length, (s.match(ADD_ATTR_RE) || []).length);
  const videoCards = s ? extractVideoCards(s, url).cards.length : 0;
  const sitemapVideos = Number(extra && extra.sitemapVideos) || 0;
  const urlVideo = !!url && isVideoLink(url);

  if (videoNodes) { video += 2; signals.push(`jsonld_video:${videoNodes}`); }
  if (ogVideo) { video += 2; signals.push('og_video'); }
  if (players) { video += 1; signals.push(`players:${players}`); }
  if (videoCards >= 3) { video += 2; signals.push(`video_cards:${videoCards}`); }
  if (sitemapVideos >= 3) { video += 2; signals.push(`sitemap_videos:${sitemapVideos}`); }
  if (urlVideo) { video += 1; signals.push('url_video'); }
  if (productNodes) { product += 2; signals.push(`jsonld_product:${productNodes}`); }
  if (ogProduct) { product += 2; signals.push('og_product'); }
  if (prices >= 3) { product += 2; signals.push(`prices:${prices}`); }
  if (addToCart) { product += 1; signals.push(`add_to_cart:${addToCart}`); }

  const type = video >= 2 && video > product ? 'video' : (product >= 2 ? 'product' : null);
  return { type, scores: { video, product }, signals };
}
