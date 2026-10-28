/**
 * Content types — WHAT a run collects. One PROFILE per type: the fields expected,
 * what identifies an item, which acceptance rule judges it, and how its page URLs
 * look (generic path words, never a site). PORTABLE: no Node built-ins.
 *
 *   product  — an e-commerce product: name + price, identity by EAN / reference / URL.
 *   listing  — a listing card (an accommodation, a vehicle, a job): name + price with
 *              its basis, identity by the entity id or the URL. Same acceptance rule as
 *              a product (name + price): the engine reads both with the product reader.
 *   video    — a video: title + page URL, with a thumbnail or a description; duration,
 *              views, publication date, embed URL and tags travel as additive columns.
 *
 * The engine picks its reader from `engine` (product | video); the form offers
 * `SELECTABLE_CONTENT_TYPES` (auto = recognised on the first page).
 */
import { isVideoLink, isVideoListingLink } from '../extract/video.mjs';

export const CONTENT_TYPE = Object.freeze({ AUTO: 'auto', PRODUCT: 'product', LISTING: 'listing', VIDEO: 'video' });
export const SELECTABLE_CONTENT_TYPES = Object.freeze(['auto', 'product', 'video']);

/** 'auto' | 'product' | 'listing' | 'video' from any spelling; anything else → 'auto'. */
export function normalizeContentType(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (/^(video|videos|vidéo|vidéos|vid)$/.test(s)) return 'video';
  if (/^(product|products|produit|produits|prod)$/.test(s)) return 'product';
  if (/^(listing|listings|annonce|annonces)$/.test(s)) return 'listing';
  return 'auto';
}

const result = (status, code, reason) => ({ status, code, reason, matched: [], is_alcoholic: false, requires_cold_chain: null });

/**
 * Acceptance rule of the VIDEO type — two-sided:
 *   accepted   → a title, an absolute page URL, and a thumbnail or a description;
 *   to_verify  → a title or a page URL missing, or neither a thumbnail nor a description;
 *   excluded   → neither a title nor a page URL (nothing to identify the row by).
 * The uniqueness of the normalised URL is enforced by the engine's dedup (never by title).
 * E-commerce is untouched: products keep core/eligibility (name + price).
 * @param {{name?:string,source_url?:string|null,image_url?:string|null,images?:string[],description?:string|null}} p
 */
export function evaluateVideoEligibility(p) {
  const name = String((p && p.name) || '').trim();
  const url = String((p && p.source_url) || '').trim();
  const hasName = name.length >= 2;
  const hasUrl = /^https?:\/\/\S+$/i.test(url);
  const hasThumb = !!(p && (p.image_url || (Array.isArray(p.images) && p.images.length)));
  const hasDesc = String((p && p.description) || '').trim().length > 0;
  if (!hasName && !hasUrl) return result('excluded', 'excluded_invalid', 'données manifestement invalides (ni titre ni adresse de page)');
  if (!hasName) return result('to_verify', 'to_verify_incomplete', 'titre manquant');
  if (!hasUrl) return result('to_verify', 'to_verify_incomplete', 'adresse de page manquante');
  if (!hasThumb && !hasDesc) return result('to_verify', 'to_verify_video_thin', 'ni vignette ni description');
  return result('accepted', 'accepted_video', 'vidéo valide (titre, adresse de page, vignette ou description)');
}

export const CONTENT_PROFILES = Object.freeze({
  product: Object.freeze({
    id: 'product', engine: 'product', rule: 'product',
    fields: Object.freeze(['name', 'price', 'url', 'image', 'sku', 'gtin', 'brand', 'category', 'description']),
    identity: Object.freeze(['gtin', 'sku', 'url']),
    extras: Object.freeze([]),
  }),
  listing: Object.freeze({
    id: 'listing', engine: 'product', rule: 'product',
    fields: Object.freeze(['name', 'price', 'id', 'image', 'rating', 'description']),
    identity: Object.freeze(['id', 'url']),
    extras: Object.freeze([]),
  }),
  video: Object.freeze({
    id: 'video', engine: 'video', rule: 'video',
    fields: Object.freeze(['name', 'url', 'image', 'description', 'duration', 'views', 'published_at', 'embed_url', 'channel', 'tags']),
    identity: Object.freeze(['url']),
    /** Additive columns (raw.columns) — the products.json contract gains no key. */
    extras: Object.freeze(['duration', 'views', 'published_at', 'embed_url', 'tags']),
    isItemLink: isVideoLink, isListingLink: isVideoListingLink,
    eligibility: evaluateVideoEligibility,
  }),
});

/** The profile of a type; 'auto' and unknown values read as the product profile. */
export function profileFor(type) {
  const t = normalizeContentType(type);
  return CONTENT_PROFILES[t] || CONTENT_PROFILES.product;
}
