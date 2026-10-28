/**
 * Complete LISTING products from their product pages — one free HTTP visit per
 * model, at the caller's polite rate (the injected `fetchHtml` is the run's
 * Fetcher). Generic: the page is read by shape (product group in the embedded
 * JSON / JSON-LD, then the regular fiche extractor), never by site.
 *
 *   - option A grouping: one row per colourway; its sizes become `variants`
 *     ({code, type:'taille', name, gtin?, availability?}); the row keeps its own
 *     reference and gets its colour name;
 *   - one visit per model: a page that carries several colourways completes
 *     every listed row of that model; URLs are normalised (no query/fragment);
 *   - sample first: after `sample` visits, if none added anything, the rest is
 *     skipped (a catalogue whose product pages add nothing costs `sample` requests);
 *   - never invents: an absent field stays absent; a failed page leaves the row
 *     exactly as listed and is counted with its reason.
 */
import { extractProductGroup, matchColourway, mergeColourway } from '../shared/extract/product-group.mjs';
import { extractProduct } from './extract.mjs';
import { normAvailability, productAvailability } from '../shared/extract/stock.mjs';
import { applyKnowledgeToHtml, mergeKnowledgeIntoRow, missingFields, foldOutcomes, rowKeysOf } from './site-knowledge.mjs';
import { mergeImageSources, imageUrls } from '../shared/extract/images.mjs';

const normUrl = (u) => { try { const x = new URL(u); x.hash = ''; x.search = ''; return x.toString().replace(/\/$/, ''); } catch { return null; } };
// Fields that make a visit worth it. A breadcrumb / MPN / weight alone is merged
// but does not count as "completed" (nor keep the sample rule from stopping).
const SIGNIFICANT = new Set(['name', 'color', 'variants', 'gtin', 'images', 'description', 'brand', 'listPrice', 'category', 'price', 'availability', 'rating', 'reviewCount', 'breadcrumb', 'specs']);
const significant = (added) => added.some((f) => SIGNIFICANT.has(f) || String(f).startsWith('k:'));
const urlOf = (c) => c.sourceUrl || c.canonicalUrl || null;
const has = (v) => v != null && v !== '' && !(Array.isArray(v) && !v.length);
/** A short label, not a description: a few words, no sentence (« Originals », « Femmes Originals », « Hommes Sportswear »). */
export const isLabelText = (v) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 60 && v.trim().split(/\s+/).length <= 6 && !/[.!?;:]\s+\S/.test(v.trim());

/** What the generic fiche extractor read (structured sources flagged). */
function ficheData(html, url) {
  try {
    const { product, strategies } = extractProduct(html, url);
    if (!product) return null;
    const structured = strategies.some((s) => s === 'generic-jsonld' || s === 'generic-microdata' || s === 'generic-embedded-json');
    return {
      description: product.description || null, richText: product.richText === true, descriptionFromMetaOnly: !structured && product.richText !== true,
      brand: product.brand || null, gtin: product.gtin || null, mpn: product.mpn || null,
      breadcrumb: product.breadcrumb || [], images: structured ? (product.images || []) : [],
      weightText: product.weightText || null, listPrice: product.listPrice ?? null,
      specs: Array.isArray(product.specs) && product.specs.length ? product.specs : null,
      color: product.color || null, variants: product.variants || null,
      // Name / price only from structured data (JSON-LD, microdata, embedded JSON):
      // they fill a row that has none, never replace what the listing showed.
      name: structured ? (product.name || null) : null,
      // The reference the page DECLARES as its SKU (schema.org sku: PrestaShop's <span itemprop="sku">) — never
      // one read from loose text; the SKU contract (normalize) still checks it.
      sku: structured && typeof product.sku === 'string' && product.sku.trim() ? product.sku.trim() : null,
      price: structured && product.price != null ? product.price : null, currency: structured ? (product.currency || null) : null,
      // Stock and reviews as the page states them (schema.org availability, aggregateRating).
      availability: normAvailability(product.availability), rating: product.rating ?? null, reviewCount: product.reviewCount ?? null,
    };
  } catch { return null; }
}

/**
 * Merge a colourway and/or the page's generic fiche data into a listed product.
 * @returns {string[]} the fields added
 */
export function mergeIntoCard(card, cw, fiche) {
  // A « description » read on the list that is only a label (adidas' card subtitle « Femmes Originals ») never keeps
  // the product page's real description out; the label is kept as the row's subtitle (nothing dropped).
  const weak = isLabelText(card.description);
  if (weak && !has(card.subtitle)) card.subtitle = String(card.description).trim();
  const added = cw ? mergeColourway(card, cw, { weakDescription: weak }) : [];
  if (fiche) {
    const set = (k, v) => { if (has(v) && !has(card[k])) { card[k] = v; added.push(k); } };
    // A <meta>-only text is a last resort: never over a colourway, only over nothing.
    if (!(cw && fiche.descriptionFromMetaOnly)) {
      if (weak && has(fiche.description) && card.description === card.subtitle && String(fiche.description).length > String(card.description).length) { card.description = fiche.description; added.push('description'); }
      else set('description', fiche.description);
      if (fiche.richText && card.description === fiche.description) card.richText = true;
    }
    set('brand', fiche.brand);
    if (!cw) { set('gtin', fiche.gtin); set('color', fiche.color); set('variants', fiche.variants); }
    set('mpn', fiche.mpn);
    // The page's declared SKU for a row that has none (a colourway brings its own). A listing code kept as the
    // product's reference (skuIsReference) gets the declared SKU beside it.
    if (!cw && fiche.sku) {
      if (card.skuIsReference === true) { if (!has(card.declaredSku)) { card.declaredSku = fiche.sku; added.push('sku'); } }
      else set('sku', fiche.sku);
    }
    if (!has(card.breadcrumb) && has(fiche.breadcrumb)) { card.breadcrumb = fiche.breadcrumb; added.push('breadcrumb'); }
    if (!cw && Array.isArray(fiche.images) && fiche.images.length) {
      const cur = Array.isArray(card.images) ? card.images : [];
      // The page's gallery leads (its main picture first, in its largest size); the listing's picture follows
      // when it is another picture — the same picture in another size is not a new image (image contract).
      const merged = imageUrls(mergeImageSources([{ source: 'jsonld', items: fiche.images }, { source: 'listing', items: cur }]).images);
      if (merged.length > cur.length) added.push('images');
      if (merged.length) card.images = merged;
    }
    set('weightText', fiche.weightText);
    set('specs', fiche.specs);
    set('name', fiche.name);
    if (card.price == null && fiche.price != null && Number(fiche.price) > 0) { card.price = Number(fiche.price); if (fiche.currency && !card.currency) card.currency = fiche.currency; added.push('price'); }
    if (card.listPrice == null && fiche.listPrice != null && card.price != null && Number(fiche.listPrice) > Number(card.price)) { card.listPrice = fiche.listPrice; added.push('listPrice'); }
    if (card.reviewCount == null && fiche.reviewCount != null) { card.reviewCount = fiche.reviewCount; card.rating = fiche.rating; added.push('reviewCount'); if (fiche.rating != null) added.push('rating'); }
    // The page-level state describes the page's own colourway: only for a row without one.
    if (!cw && !card.availability && fiche.availability) { card.availability = fiche.availability; added.push('availability'); }
  }
  // A row whose sizes carry a stock state gets its own state from them.
  const fromSizes = productAvailability(card.variants);
  if (fromSizes && card.availability !== fromSizes) { card.availability = fromSizes; added.push('availability'); }
  return [...new Set(added)];
}

// What a product page normally adds to a listed row. A row whose page could not be read and that lacks any
// of these is "to verify": the user sees which fields are missing instead of an accepted half-product.
const PAGE_FIELDS = [
  ['description', (np) => !!np.description],
  ['images', (np) => Array.isArray(np.images) && np.images.length > 0],
  ['marque', (np) => !!(np.raw && np.raw.brand)],
  ['variantes', (np) => !!(np.color || (Array.isArray(np.variants) && np.variants.length))],
  ['caractéristiques', (np) => !!(np.raw && np.raw.specs && np.raw.specs.length)],
];
export const DETAIL_REASON_TEXT = {
  needs_user_browser: 'ce site ne laisse lire ses fiches que dans votre navigateur',
  max_visits: 'limite de fiches produit atteinte',
  blocked: 'le site a refusé la fiche',
  fetch_failed: 'la fiche n’a pas pu être lue',
  sample_no_data: 'arrêt après l’échantillon',
  stopped: 'scraping arrêté',
};
/**
 * The verdict for a normalised row whose own product page FAILED (raw._detail from enrichFromDetailPages):
 * "to verify" with the fields the page would have given, or null when the listing already had them all.
 * @param {object} raw  the listed row (carries _detail)  @param {object} np  its normalised product
 * @returns {{status:'to_verify', code:string, reason:string, missing:string[], detail:string}|null}
 */
export function detailUnreadVerdict(raw, np) {
  const d = raw && raw._detail;
  if (!d || d.ok) return null;
  // A page skipped because the sample showed the pages add nothing: the listing already holds what the site gives.
  if (d.skipped && d.reason === 'sample_no_data') return null;
  const missing = PAGE_FIELDS.filter(([, has]) => !has(np)).map(([f]) => f);
  if (!missing.length) return null;
  const why = DETAIL_REASON_TEXT[d.reason] || (/^http_\d+$/.test(String(d.reason)) ? `le site a répondu ${String(d.reason).slice(5)}` : String(d.reason || 'raison inconnue'));
  return { status: 'to_verify', code: 'to_verify_detail_unread', reason: `fiche produit non lue (${why}) : champs manquants : ${missing.join(', ')}`, missing, detail: String(d.reason || '') };
}

/**
 * How many product pages a job may visit: as many as the products it lists
 * (`limit` = the job's product cap or row count), further capped only by an
 * explicit positive `detailPages.maxPerJob` in the configuration.
 * @param {{maxPerJob?:number|null}|null} dp
 * @param {number} limit
 */
export function detailVisitCap(dp, limit) {
  const lim = Math.max(0, Math.floor(Number(limit) || 0));
  const own = Number(dp && dp.maxPerJob);
  return Number.isFinite(own) && own > 0 ? Math.min(Math.floor(own), lim) : lim;
}

/**
 * @param {object[]} cards raw listing products (mutated in place: fields added)
 * @param {{ fetchHtml:(url:string)=>Promise<{ok:boolean,html?:string,status?:number,blocked?:boolean}>,
 *   maxVisits?:number, sample?:number, onStep?:Function, isStopped?:()=>boolean }} opts
 * @returns {Promise<{ listed:number, candidates:number, visited:number, completed:number, unchanged:number,
 *   failed:number, skipped:number, reasons:Record<string,number>, stoppedEarly:string|null }>}
 */
export async function enrichFromDetailPages(cards, { fetchHtml, maxVisits = 200, sample = 3, onStep, isStopped = () => false, knowledge = null, fetchRendered = null } = {}) {
  const rep = { knowledge: null, listed: cards.length, candidates: 0, visited: 0, completed: 0, unchanged: 0, failed: 0, skipped: 0, reasons: {}, stoppedEarly: null };
  const reason = (r) => { rep.reasons[r] = (rep.reasons[r] || 0) + 1; };
  if (typeof fetchHtml !== 'function') return rep;
  const pages = new Map();          // normalised URL → { group, fiche, selected } | { error }
  const byCode = new Map();         // colourway code → { cw, fiche } from any visited page
  const step = (m, e) => { try { if (onStep) onStep(m, e || {}); } catch { /* never break */ } };
  let addedAny = false;
  // Site knowledge: the rules the site taught, applied to every visited page; their outcomes
  // are returned so the profile keeps an honest track record.
  const kTotals = {}; const kFields = {}; const kNeedsBrowser = {};
  // A page whose taught blocks are missing from the plain HTML (filled by the page's scripts) is read
  // once in the rendered page; when that works, the next pages go straight to it.
  let preferRendered = false; let renderedUseless = false;
  const okCount = (a) => (a ? Object.keys(a.values).length : 0);
  // A taught field none of its rules could read on this page (another field reading fine is no reason to skip it).
  const unread = (a) => !!(a && a.trace.some((t) => !t.ok && t.status !== 'superseded' && !(t.field in a.values)));
  if (knowledge) rep.knowledge = { rules: kTotals, fields: kFields, needsBrowser: kNeedsBrowser };

  for (const card of cards) {
    const u = urlOf(card);
    // A row that already carries colour + variants (a platform feed) needs no visit.
    // (A row whose taught fields are all present needs no visit for them either.)
    const needsK = knowledge ? missingFields(card, knowledge).length > 0 : false;
    if (!u || (has(card.variants) && has(card.color) && !needsK)) continue;
    rep.candidates += 1;
    if (isStopped()) { rep.skipped += 1; reason('stopped'); continue; }
    // 1) Covered by a page already visited for another colourway of the same model.
    const code = card.sku || null;
    let hit = null;
    // Strict: the row's reference or a segment of its URL IS the colourway code
    // (the single-colourway fallback of matchColourway must not apply here).
    const segs = (() => { try { return new URL(u).pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s).toLowerCase()); } catch { return []; } })();
    for (const [c, v] of byCode) {
      const lc = c.toLowerCase();
      if ((code && lc === String(code).toLowerCase()) || segs.includes(lc)) { hit = v; break; }
    }
    if (hit) {
      // The page's generic fiche data describes ITS selected colourway (images, EAN),
      // so another colourway of the model takes the colourway data only.
      card._detail = { ok: true, url: u, shared: true };
      const added = mergeIntoCard(card, hit.cw, null);
      if (significant(added)) { rep.completed += 1; addedAny = true; } else rep.unchanged += 1;
      continue;
    }
    // 2) Visit (once per normalised URL).
    const key = normUrl(u);
    let page = key ? pages.get(key) : null;
    if (!page) {
      if (rep.stoppedEarly) { rep.skipped += 1; reason(rep.stoppedEarly); card._detail = { ok: false, reason: rep.stoppedEarly, url: u, skipped: true }; continue; }
      if (rep.visited >= maxVisits) { rep.skipped += 1; reason('max_visits'); card._detail = { ok: false, reason: 'max_visits', url: u, skipped: true }; continue; }
      let res;
      const first = knowledge && fetchRendered && preferRendered ? fetchRendered : fetchHtml;
      try { res = await first(u); } catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
      rep.visited += 1;
      step('detailPage', { done: rep.visited, total: rep.candidates });
      if (!res || !res.ok || !res.html) {
        // A reader that knows WHY it read nothing says so (e.g. 'needs_user_browser': only the user's browser reads this site).
        page = { error: res && typeof res.reason === 'string' && /^[a-z_]{3,40}$/.test(res.reason) ? res.reason : (res && res.blocked ? 'blocked' : (res && res.status ? `http_${res.status}` : 'fetch_failed')) };
      } else {
        const group = extractProductGroup(res.html);
        page = { group, fiche: ficheData(res.html, u), selected: group.selected, applied: knowledge ? applyKnowledgeToHtml(res.html, knowledge, { name: card.name || '', url: u }) : null };
        if (knowledge && fetchRendered && !preferRendered && !renderedUseless && unread(page.applied)) {
          let rr = null; try { rr = await fetchRendered(u); } catch { rr = null; }
          const a2 = rr && rr.ok && rr.html ? applyKnowledgeToHtml(rr.html, knowledge, { name: card.name || '', url: u }) : null;
          if (a2 && okCount(a2) > okCount(page.applied)) { page.applied = a2; preferRendered = true; rep.renderedPages = (rep.renderedPages || 0) + 1; } else renderedUseless = true;
        }
        if (knowledge && page.applied) foldOutcomes(kTotals, page.applied);
        // Taught blocks this page did not show because they open only in a browser (counted per field, for the report).
        if (page.applied) for (const t of page.applied.trace || []) if (t.needsBrowser && !(t.field in page.applied.values)) kNeedsBrowser[t.field] = (kNeedsBrowser[t.field] || 0) + 1;
        for (const cw of group.colourways) if (cw.code && !byCode.has(cw.code)) byCode.set(cw.code, { cw, fiche: page.fiche });
      }
      if (key) pages.set(key, page);
    }
    // The row keeps what happened to its own page (the report says which rows a failed page left as listed).
    if (page.error) { rep.failed += 1; reason(page.error); card._detail = { ok: false, reason: page.error, url: u }; }
    else {
      card._detail = { ok: true, url: u };
      let cw = matchColourway(page.group, { sku: code, url: u });
      if (!cw && page.selected && normUrl(u) === key) cw = page.group.colourways.find((c) => c.code === page.selected) || null;
      const added = mergeIntoCard(card, cw, page.fiche);
      if (page.applied) {
        // A field the USER taught is worth the visit; one found automatically fills the row but never keeps a
        // run visiting pages it would have stopped at (sample-first stays cheap).
        const byUser = new Set(Object.entries(page.applied.sources || {}).filter(([, s]) => s.origin === 'manual').map(([f]) => rowKeysOf(f)[0]));
        for (const f of mergeKnowledgeIntoRow(card, page.applied)) { added.push(f); if (!SIGNIFICANT.has(f) && byUser.has(f)) added.push(`k:${f}`); kFields[f] = (kFields[f] || 0) + 1; }
      }
      if (significant(added)) { rep.completed += 1; addedAny = true; }
      else { rep.unchanged += 1; reason(page.group.colourways.length ? 'no_matching_colourway' : 'no_extra_data'); }
    }
    // Sample first: nothing gained on the first visits → stop visiting.
    if (!addedAny && !rep.stoppedEarly && rep.visited >= sample) rep.stoppedEarly = rep.failed === rep.visited && rep.reasons.needs_user_browser === rep.failed ? 'needs_user_browser' : 'sample_no_data';
  }
  return rep;
}
