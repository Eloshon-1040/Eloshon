/**
 * The GALLERY of a product page read from its DOM, by shape — never by a site's class names:
 *
 *   1. anchored on a picture the page DECLARES (JSON-LD / microdata / og:image): the smallest block that
 *      shows that picture together with others is the gallery, and it gives every picture in its largest
 *      size (srcset, zoom and lazy attributes) — the declared sources often hold one picture or small ones;
 *   2. without a declared picture: the block of the page that holds the most product pictures (a block
 *      whose class or id reads as a gallery / carousel / slider first, else the main content);
 *   3. nothing is invented: a picture inside a link to ANOTHER page of the site (related products, the
 *      colour swatches that lead to their own product page) is never this product's picture.
 *
 * Portable (browser + linkedom): a Document and an optional page URL in, ProductImage[] out.
 */
import { readImages, leavesPage } from '../knowledge/readers.mjs';
import { imageKey, dedupeImages } from './images.mjs';

const OUTSIDE = 'nav, header, footer, form, [role="navigation"], [role="dialog"], [role="menu"], [aria-hidden="true"], template';
const GALLERY_HINT = /gallery|galerie|carousel|carrousel|slider|slideshow|swiper|splide|glide|slick|product-?image|product-?media|product-?photo|pdp-?image|media-?gallery|images?-?wrapper|lightbox|zoom/i;
const BODYISH = /^(body|html|main)$/i;
const MAX_IMGS = 1500;

const closest = (n, sel) => { try { return n && n.closest ? n.closest(sel) : null; } catch { return null; } };
const count = (el, pageUrl) => readImages(el, { pageUrl, max: 60 }).length;

/**
 * @param {Document} doc
 * @param {{pageUrl?:string|null, seeds?:string[], name?:string, max?:number}} [o]
 *   seeds: picture addresses the page declares (any size); name: the product's name (alt matching, last resort)
 * @returns {import('./images.mjs').ProductImage[]}
 */
export function readGallery(doc, { pageUrl = null, seeds = [], name = '', max = 30 } = {}) {
  if (!doc) return [];
  const root = doc.body || doc.documentElement || doc;
  let imgs = []; try { imgs = [...root.querySelectorAll('img')].slice(0, MAX_IMGS); } catch { imgs = []; }
  const usable = imgs.filter((n) => !closest(n, OUTSIDE));
  const own = (n) => readImages(n, { pageUrl, max: 1 });   // the picture of one <img>, if it is a product picture of this page

  // 1. The block around a declared picture.
  const keys = new Set((seeds || []).map(imageKey).filter(Boolean));
  let container = null;
  if (keys.size) {
    for (const n of usable) {
      const im = own(n)[0];
      if (!im || !keys.has(imageKey(im.url))) continue;
      // The smallest ancestor showing at least two pictures, widened while it still reads as one block of pictures.
      let best = null; let bestCount = 1;
      for (let a = n.parentElement, i = 0; a && i < 8 && !BODYISH.test(a.tagName); i++, a = a.parentElement) {
        const c = count(a, pageUrl);
        if (c < 2) continue;
        if (best && c > bestCount + 20) break;         // a much larger block: the page, not the gallery
        if (best && c === bestCount) { best = a; continue; } // the same pictures, one wrapper up (the gallery's own frame)
        best = a; bestCount = c;
      }
      if (best) { container = best; break; }
    }
  }
  // 2. A block that reads as a gallery, else the richest block of the main content.
  if (!container) {
    let hinted = []; try { hinted = [...root.querySelectorAll('[class], [id]')].filter((e) => GALLERY_HINT.test(`${e.getAttribute('class') || ''} ${e.getAttribute('id') || ''}`) && !closest(e, OUTSIDE)).slice(0, 200); } catch { hinted = []; }
    let bestC = 0;
    for (const e of hinted) { const c = count(e, pageUrl); if (c >= 2 && c > bestC) { container = e; bestC = c; } }
  }
  if (container) return dedupeImages(readImages(container, { pageUrl, max }));
  // 3. Last resort: the pictures whose alt is the product's name (the main picture, usually).
  const want = String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (want.length >= 4) {
    const out = [];
    for (const n of usable) {
      const alt = String(n.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!alt || !(alt.includes(want) || want.includes(alt) && alt.length >= 8)) continue;
      if (leavesPage(linkHref(n), pageUrl)) continue;
      const im = own(n)[0]; if (im) out.push(im);
      if (out.length >= max) break;
    }
    return dedupeImages(out);
  }
  return [];
}

function linkHref(n) {
  let a = n;
  for (let i = 0; a && i < 12; i++, a = a.parentElement) if (a.tagName && /^a$/i.test(a.tagName) && a.getAttribute('href')) return a.getAttribute('href');
  return null;
}
