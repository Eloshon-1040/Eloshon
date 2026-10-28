/**
 * What the LISTING page says about the products it lists: its category trail
 * (shared/extract/listing-trail.mjs). Products whose own page has no breadcrumb get
 * this trail, so their category reads e.g. "Homme > Sneakers" instead of
 * "Sneakers" alone.
 */
import { parseHTML } from 'linkedom';
import { trailFromDocument } from '../shared/extract/listing-trail.mjs';
import { categoryPath } from './normalize.mjs';

/** @returns {{ trail:string[], source:string|null }} */
export function listingTrailFromHtml(html, pageUrl) {
  if (!html || typeof html !== 'string') return { trail: [], source: null };
  try { const { document } = parseHTML(html); return trailFromDocument(document, pageUrl); } catch { return { trail: [], source: null }; }
}

/**
 * Give the trail to normalized products that have none (in place); their
 * `source_category` becomes the trail followed by their own category.
 * @returns {number} products completed
 */
export function applyTrailToNormalized(products, trail) {
  if (!Array.isArray(trail) || !trail.length) return 0;
  let n = 0;
  for (const p of products || []) {
    if (!p || !p.raw) continue;
    if (Array.isArray(p.raw.breadcrumb) && p.raw.breadcrumb.length) continue;
    p.raw.breadcrumb = [...trail];
    p.source_category = categoryPath(trail, p.source_category);
    n++;
  }
  return n;
}

/** Same, on raw rows (before normalisation): only the rows without a breadcrumb. */
export function applyTrailToRaw(rows, trail) {
  if (!Array.isArray(trail) || !trail.length) return 0;
  let n = 0;
  for (const r of rows || []) { if (r && !(Array.isArray(r.breadcrumb) && r.breadcrumb.length)) { r.breadcrumb = [...trail]; n++; } }
  return n;
}
