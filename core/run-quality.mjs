/**
 * Post-run QUALITY GATE (Part 2) — lets the engine judge its own output instead
 * of reporting "ok" whenever any rows exist. Two pure pieces, both offline:
 *
 *  • measureRunQuality(report, products) → objective signals (ratios + flags),
 *    computed from what a run actually produced. No thresholds, no policy here.
 *  • judgeRunQuality(signals, thresholds) → { ok, failures[] } using thresholds
 *    the CALLER supplies. Thresholds are NOT hard-coded in this module — per the
 *    project rule they are business config, injected after sign-off, so tuning
 *    them never means editing derivation logic.
 *
 * The Colruyt case (196 normalized, 0 accepted, ~100% empty names, the listing
 * page saved as a product) must come back ok:false so the run self-corrects /
 * surfaces a failure instead of a silent success.
 */

const nonEmpty = (v) => v != null && String(v).trim() !== '';
const isBlankImage = (u) => !nonEmpty(u) || /^data:image\/svg\+xml/i.test(String(u)); // placeholder SVG counts as empty

/**
 * @param {object} report   the run report (counts + notes + discovery)
 * @param {object[]} products normalized products (name, price, image_url, __eligibility)
 * @returns {{ products:number, accepted:number, acceptedRatio:number, emptyNameRatio:number,
 *   emptyPriceRatio:number, emptyImageRatio:number, listingPageAsProduct:boolean,
 *   fichesFetched:number, seedsWithoutFiche:boolean }}
 */
export function measureRunQuality(report = {}, products = []) {
  const list = Array.isArray(products) ? products : [];
  const n = list.length;
  const nameOf = (p) => (p && p.name) || '';
  const statusOf = (p) => (p && ((p.__eligibility && p.__eligibility.status) || p.status)) || null;
  const emptyName = list.filter((p) => !nonEmpty(nameOf(p))).length;
  const emptyPrice = list.filter((p) => !(p && p.price != null && !Number.isNaN(Number(p.price)))).length;
  const emptyImage = list.filter((p) => isBlankImage(p && p.image_url)).length;
  const accepted = report.accepted != null ? report.accepted : list.filter((p) => statusOf(p) === 'accepted').length;
  const fetched = Number(report.fetched) || 0;
  return {
    products: n,
    accepted,
    acceptedRatio: n ? accepted / n : 0,
    emptyNameRatio: n ? emptyName / n : 0,
    emptyPriceRatio: n ? emptyPrice / n : 0,
    emptyImageRatio: n ? emptyImage / n : 0,
    // A row whose source_url is the scraped origin/listing itself (the "Produits |
    // Colruyt" leak) — a listing page counted as a product.
    listingPageAsProduct: list.some((p) => p && p.source_url && report.origin && stripQS(p.source_url) === stripQS(report.origin)),
    fichesFetched: fetched,
    // Seeds were discovered but their product pages were never fetched (all rows
    // came off the listing itself): many products, at most one page fetched.
    seedsWithoutFiche: n >= 3 && fetched <= 1,
  };
}

function stripQS(u) { try { const x = new URL(u); return `${x.origin}${x.pathname.replace(/\/$/, '')}`; } catch { return String(u || '').split('?')[0].replace(/\/$/, ''); } }

/**
 * Judge the signals against INJECTED thresholds. Returns the failure reasons that
 * tripped, or ok:true. Only runs its checks when there is something to judge
 * (products > 0) — an empty run is a discovery outcome, judged elsewhere.
 * @param {object} signals   from measureRunQuality
 * @param {{ minAcceptedRatio:number, maxEmptyNameRatio:number, maxEmptyPriceRatio:number,
 *   maxEmptyImageRatio?:number, flagListingAsProduct?:boolean, flagSeedsWithoutFiche?:boolean }} thresholds
 * @returns {{ ok:boolean, failures:string[] }}
 */
export function judgeRunQuality(signals, thresholds) {
  const t = thresholds || {};
  if (!signals || !signals.products) return { ok: true, failures: [] };
  // CORE signals decide ok/not-ok — the "no usable data" signature (empty names,
  // nothing accepted, the listing page itself as a product, seeds never fetched).
  const core = [];
  if (t.minAcceptedRatio != null && signals.acceptedRatio < t.minAcceptedRatio) core.push('low-accepted-ratio');
  if (t.maxEmptyNameRatio != null && signals.emptyNameRatio > t.maxEmptyNameRatio) core.push('empty-names');
  if (t.flagListingAsProduct && signals.listingPageAsProduct) core.push('listing-page-as-product');
  if (t.flagSeedsWithoutFiche && signals.seedsWithoutFiche && signals.emptyNameRatio > 0.5) core.push('fiches-not-fetched');
  // CORROBORATING signals are reported for context but never fail a run on their
  // own — a valid catalogue can legitimately lack images (or prices, e.g. "sur
  // devis"). They only appear alongside a core failure.
  const extra = [];
  if (t.maxEmptyPriceRatio != null && signals.emptyPriceRatio > t.maxEmptyPriceRatio) extra.push('empty-prices');
  if (t.maxEmptyImageRatio != null && signals.emptyImageRatio > t.maxEmptyImageRatio) extra.push('empty-images');
  return { ok: core.length === 0, failures: core.length ? [...core, ...extra] : [] };
}
