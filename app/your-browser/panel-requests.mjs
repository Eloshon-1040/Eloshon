/**
 * Requests from the extension's SIDE PANEL (the user scraping the page open in
 * their own Chrome), answered by the app:
 *   - op 'recipe': the learned card recipe for this site (manual_selectors card +
 *     field selectors only), so the panel reads the page exactly like the app does;
 *   - op 'ingest': the rows the user accepted become a normal job in the app
 *     (normalise → eligibility → CSV/report), optionally completed from each
 *     product's own page (free HTTP, the "Sous-pages" option).
 * Inputs come from the extension: everything is validated and bounded here.
 */
import { hostKey } from '../../core/providers/optin.mjs';
import { isAssetUrl } from '../../shared/extract/product-shape.mjs';
import { specsToObject } from '../../shared/knowledge/readers.mjs';
import { ROLES } from '../../shared/extract/field-meaning.mjs';
import { normalizeConstants, constantColumns } from '../../shared/export/constants.mjs';
import { sanitizePaginationMemo, PAGINATION_MODES } from '../../shared/extract/pagination-memo.mjs';
import { batchKeyOf, batchLabelOf, sanitizeSiteProfile, sanitizeBatch } from '../../shared/export/site-values.mjs';
import { sanitizeCardModel, REJECT_REASONS } from '../../shared/extract/card-model.mjs';

// The app → extension link carries at most 1 MB per message: each chunk of finished rows stays below this.
const MAX_REPLY_BYTES = 750000;

/**
 * The job's products as the panel shows them (same column keys as the panel fields), so the
 * « Résultats » table and « Exporter CSV » show what the app finished — description, specs,
 * brand, category read on each product page — not the list preview.
 * Sent in CHUNKS: one chunk per message from `offset`; `next` is the offset of the following chunk (null at
 * the end), `total` the job's row count. The panel asks until `next` is null: no row is ever cut.
 */
export function finishedRows(products, { offset = 0, maxBytes = MAX_REPLY_BYTES } = {}) {
  const list = products || [];
  const out = []; let bytes = 0; let i = Math.max(0, Math.floor(Number(offset) || 0));
  for (; i < list.length; i++) {
    const p = list[i];
    const row = {
      name: p.name || null, price: p.price ?? null, brand: p.brand || null, category: p.source_category || null, ...(p.product_type ? { product_type: p.product_type } : {}),
      images: Array.isArray(p.images) && p.images.length ? p.images : (p.image_url ? [p.image_url] : []), sourceUrl: p.source_url || null, sku: p.source_product_id || null,
      ean: p.barcode || null, availability: p.availability || null, description: p.description || null,
      ...(Array.isArray(p.specs) && p.specs.length ? { technical_specs: specsToObject(p.specs) } : {}),
      // The user's own columns (designated in the panel, taught on the product pages), under their own keys.
      ...(p.columns && typeof p.columns === 'object' ? Object.fromEntries(Object.entries(p.columns).filter(([k, v]) => v != null && typeof v !== 'object' && !['name', 'price', 'brand', 'category', 'images', 'sourceUrl', 'sku', 'ean', 'availability', 'description', 'technical_specs', 'variants'].includes(k))) : {}),
      // Options as one cell: "30 ML : 77.7 | 50 ML : 115.5 (épuisé)".
      ...(Array.isArray(p.variants) && p.variants.length ? { variants: p.variants.map((v) => `${v.name}${v.price != null ? ` : ${v.price}` : ''}${/OutOfStock/i.test(v.availability || '') ? ' (épuisé)' : ''}`).join(' | ') } : {}),
    };
    const size = JSON.stringify(row).length;
    if (out.length && bytes + size > maxBytes) break; // a single huge row still goes alone (the link takes 1 MB)
    bytes += size; out.push(row);
  }
  return { rows: out, next: i < list.length ? i : null, total: list.length };
}

export const MAX_ROWS = 5000;
const MAX_STR = 2000;
const MAX_DESCRIPTION = 12000; // a description read from the page keeps its length (was clipped at 2000)
const MAX_SPECS = 300;
const MAX_EXTRA_KEYS = 20;
const KNOWN = new Set(['specs', 'technical_specs', 'richText', 'name', 'title', 'price', 'listPrice', 'currency', 'sourceUrl', 'canonicalUrl', 'images', 'sku', 'gtin', 'description', 'brand', 'color', 'strategy', 'category', 'availability', 'rating', 'reviewCount']);

const httpUrl = (u) => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.toString() : null; } catch { return null; } };
const str = (v) => (v == null ? null : String(v).slice(0, MAX_STR));

/** One row from the panel → a plain raw product (known fields typed, extra fields as short text). */
export function sanitizeRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const out = {};
  if (row.name != null || row.title != null) out.name = str(row.name != null ? row.name : row.title).slice(0, 300);
  const price = Number(row.price);
  if (Number.isFinite(price) && price > 0 && price < 1e9) out.price = price;
  if (typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency)) out.currency = row.currency;
  const list = Number(row.listPrice);
  // a « prix barré » not above the price is the price read twice, not a reduction
  if (Number.isFinite(list) && list > 0 && list < 1e9 && !(out.price != null && list <= out.price)) out.listPrice = list;
  const u = httpUrl(row.sourceUrl || row.canonicalUrl || row.url);
  // A picture or a file is never the product's page: it would become the product's
  // reference ("origin.webp") and merge every row into one.
  const fileLink = !!u && isAssetUrl(u);
  if (u && !fileLink) { out.sourceUrl = u; out.canonicalUrl = u; }
  const imgs = (Array.isArray(row.images) ? row.images : (row.image ? [row.image] : (fileLink ? [u] : []))).map(httpUrl).filter(Boolean).slice(0, 10);
  if (imgs.length) out.images = imgs;
  for (const k of ['sku', 'gtin', 'brand', 'color', 'category', 'availability']) if (row[k] != null && row[k] !== '') out[k] = str(row[k]);
  if (row.description != null && row.description !== '') { out.description = String(row.description).slice(0, MAX_DESCRIPTION); if (row.richText === true) out.richText = true; }
  // Technical specifications read from the page: [{group, name, value}] (and the same as { name: value }).
  if (Array.isArray(row.specs)) { const sp = row.specs.filter((x) => x && typeof x.name === 'string' && x.value != null).slice(0, MAX_SPECS).map((x) => ({ group: x.group == null ? null : str(x.group).slice(0, 80), name: str(x.name).slice(0, 80), value: str(x.value).slice(0, 500) })); if (sp.length) out.specs = sp; }
  if (row.technical_specs && typeof row.technical_specs === 'object' && !Array.isArray(row.technical_specs)) { const t = {}; for (const [k, v] of Object.entries(row.technical_specs).slice(0, MAX_SPECS)) if (v != null && typeof v !== 'object') t[String(k).slice(0, 80)] = str(v).slice(0, 500); if (Object.keys(t).length) out.technical_specs = t; }
  const rating = Number(row.rating); if (Number.isFinite(rating) && rating >= 0 && rating <= 5) out.rating = rating;
  const reviews = Number(row.reviewCount); if (Number.isInteger(reviews) && reviews >= 0) out.reviewCount = reviews;
  let extra = 0;
  for (const [k, v] of Object.entries(row)) {
    if (KNOWN.has(k) || k === 'url' || k === 'image' || extra >= MAX_EXTRA_KEYS) continue;
    if (!/^[a-z][a-z0-9_]{0,39}$/i.test(k) || v == null || typeof v === 'object') continue;
    out[k] = str(v); extra++;
    (out.columns = out.columns || {})[k] = out[k]; // kept as the job's own columns (raw.columns)
  }
  return out.name || out.sourceUrl ? out : null;
}

const STOPS = new Set(['max_products', 'max_pages', 'max_rounds', 'time', 'stopped', 'single_page', 'end', 'no_new', 'button_gone', 'total_reached', 'navigated', 'hub_done', 'platform_feed']);
const count = (v, max = 1000000) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= max ? n : null; };
/**
 * How the panel read the list (mode, pages, stop) and the total the list announced against the rows read →
 * the job's report.pagination, the same shape the app's own runs write. Null when nothing usable came.
 */
export function listPagination(x) {
  if (!x || typeof x !== 'object') return null;
  const t = x.total && typeof x.total === 'object' ? x.total : null;
  const announced = t ? count(t.announced) : null;
  const read = t ? count(t.read) : null;
  const stoppedBy = STOPS.has(x.stoppedBy) ? x.stoppedBy : null;
  const short = announced != null && read != null ? Math.max(0, announced - read) : 0;
  // A shortfall the user's own limits explain (max products / pages, time, a stop) is expected, not a miss.
  const explained = short > 0 && ['max_products', 'max_pages', 'max_rounds', 'time', 'stopped', 'single_page'].includes(stoppedBy);
  return {
    mechanism: 'your-browser', mode: PAGINATION_MODES.includes(x.mode) ? x.mode : 'auto',
    pages: count(x.pages, 10000) || 1, loads: count(x.loads, 10000) || 0, stoppedBy,
    totalAnnounced: announced, ...(announced != null ? { totalText: t && typeof t.text === 'string' ? t.text.slice(0, 90) : null, read } : {}),
    warnings: short > 0 && !explained ? ['total_not_reached'] : [],
  };
}

/** The cards a learned card model left out of the list (report.listRejected): counts per reason + up to 200 named. */
export function listRejected(x) {
  if (!x || typeof x !== 'object') return null;
  const list = (Array.isArray(x.list) ? x.list : []).filter((r) => r && REJECT_REASONS[r.reason]).slice(0, 200)
    .map((r) => ({ reason: r.reason, label: REJECT_REASONS[r.reason], name: typeof r.name === 'string' ? r.name.slice(0, 120) : '', url: httpUrl(r.url) }));
  const byReason = {}; for (const [k, v] of Object.entries(x.byReason || {})) if (REJECT_REASONS[k] && count(v) != null) byReason[k] = count(v);
  const total = count(x.count);
  return total || list.length ? { count: Math.max(total || 0, list.length), byReason, list } : null;
}
/** The sub-collections of a hub page the panel read (report.hub). */
export function hubRead(x) {
  if (!Array.isArray(x) || !x.length) return null;
  return x.slice(0, 50).map((s) => ({ name: typeof s.name === 'string' ? s.name.slice(0, 80) : '', url: httpUrl(s.url), rows: count(s.rows) || 0, ...(STOPS.has(s.stoppedBy) || s.stoppedBy === 'hub_done' ? { stoppedBy: s.stoppedBy } : {}), ...(typeof s.error === 'string' ? { error: s.error.slice(0, 80) } : {}) })).filter((s) => s.url);
}

/** Only the parts of a stored recipe the panel needs (never pagination memos or ids). */
export function panelRecipe(ms) {
  if (!ms || typeof ms.card !== 'string' || !ms.card) return null;
  const fields = {};
  for (const [k, f] of Object.entries(ms.fields || {})) {
    if (f && typeof f.selector === 'string' && f.selector) fields[k] = { selector: f.selector, attr: typeof f.attr === 'string' ? f.attr : null };
  }
  return Object.keys(fields).length ? { card: ms.card, fields } : null;
}

/**
 * @param {object} payload  the extension's request payload
 * @param {{ resolveRecipe?:(url:string)=>Promise<object>, controller?:{ingestExternalProducts:Function} }} io
 * @returns {Promise<object>} the reply payload ({ ok, … } or { ok:false, reason })
 */
export async function handlePanelRequest(payload, io = {}) {
  const p = payload || {};
  const url = httpUrl(p.url);
  if (!url) return { ok: false, reason: 'adresse de page invalide' };
  if (p.op === 'recipe') {
    if (typeof io.resolveRecipe !== 'function') return { ok: true, recipe: null };
    let h = null; try { h = await io.resolveRecipe(url); } catch { h = null; }
    return { ok: true, recipe: panelRecipe(h && h.manualSelectors) };
  }
  // Site knowledge (rules designated with 🎯 / proposed by the detection): taught, checked, listed, forgotten.
  if (p.op === 'learn' || p.op === 'propose' || p.op === 'knowledge' || p.op === 'forget' || p.op === 'retest' || p.op === 'rules' || p.op === 'repair') {
    const kn = io.knowledge; if (!kn) return { ok: false, reason: 'application indisponible' };
    // Product pages the user's browser read for this check (op 'page' with this id): tested before any HTTP read.
    const pageRunId = typeof p.pageRunId === 'string' && /^[\w-]{4,64}$/.test(p.pageRunId) ? p.pageRunId : null;
    const rendered = pageRunId ? (io.pageCache || PAGE_CACHE).take(pageRunId) : null;
    if (p.op === 'learn') return kn.learn(url, { ...p, rendered });
    if (p.op === 'propose') return kn.propose(url, p);
    if (p.op === 'forget') return kn.retire(url, p);
    if (p.op === 'retest') return kn.retest(url, { ...p, rendered });
    if (p.op === 'repair') return typeof kn.repairAction === 'function' ? kn.repairAction(url, { action: p.action, id: p.id }) : { ok: false, reason: 'application à mettre à jour' };
    if (p.op === 'rules') return { ok: true, knowledge: typeof kn.forPanel === 'function' ? kn.forPanel(url) : null };
    return kn.summary(url);
  }
  if (p.op === 'card_model') {
    // The product card learned in the panel for this site (card-model.mjs): kept in its profile, shared by every browser.
    const cm = io.cardModel || (io.controller && io.controller.cardModel);
    if (!cm) return { ok: false, reason: 'application à mettre à jour' };
    if (p.action === 'get') return { ok: true, model: cm.get(url) || null };
    if (p.action === 'forget') { cm.set(url, null); return { ok: true, model: null }; }
    if (p.action === 'set') { const model = sanitizeCardModel(p.model); if (!model) return { ok: false, reason: 'carte illisible' }; cm.set(url, model); return { ok: true, model }; }
    return { ok: false, reason: 'action inconnue' };
  }
  if (p.op === 'site_values') {
    // Fixed values on two levels: the SITE profile (brand, fields) and the BATCH of this list page (collection,
    // type, tags, status…). Saved here, shared by every browser and by the jobs the app starts on this page.
    const sv = io.siteValues || (io.controller && io.controller.siteValues);
    if (!sv) return { ok: false, reason: 'application à mettre à jour' };
    const key = batchKeyOf(url);
    if (p.action === 'get') return { ok: true, ...sv.get(url), batchKey: key, label: batchLabelOf(url) };
    if (p.action === 'set') {
      const now = new Date().toISOString();
      const change = {};
      // A part left out (or undefined) is kept; null forgets it.
      if (p.site !== undefined) change.site = p.site === null ? null : sanitizeSiteProfile(p.site, now);
      if (p.batch !== undefined) change.batch = p.batch === null ? null : sanitizeBatch(p.batch, url, now);
      sv.set(url, change);
      return { ok: true, ...sv.get(url), batchKey: key, label: batchLabelOf(url) };
    }
    return { ok: false, reason: 'action inconnue' };
  }
  if (p.op === 'pagination') {
    // How this site's lists load more (mode, the « suivant » / « charger plus » controls the user showed, last test):
    // kept in the site's profile, shared by every browser with the extension and by recipes.json.
    const sp = io.sitePagination || (io.controller && io.controller.sitePagination);
    if (!sp) return { ok: false, reason: 'application à mettre à jour' };
    if (p.action === 'get') return { ok: true, memo: sp.get(url) || null };
    if (p.action === 'forget') { sp.set(url, null); return { ok: true, memo: null }; }
    if (p.action === 'set') { const memo = sanitizePaginationMemo(p.memo); if (!memo) return { ok: false, reason: 'pagination illisible' }; sp.set(url, memo); return { ok: true, memo }; }
    return { ok: false, reason: 'action inconnue' };
  }
  if (p.op === 'recipes') {
    // recipes.json through the app (the extension keeps no recipe of its own): export, preview an import, apply it.
    const c = io.controller; if (!c || typeof c.recipesExport !== 'function') return { ok: false, reason: 'application à mettre à jour' };
    if (p.action === 'export') { const file = c.recipesExport({}); return JSON.stringify(file).length > 900000 ? { ok: false, reason: 'trop de recettes pour le panneau : exportez-les depuis l’application (Réglages)' } : { ok: true, file }; }
    if (p.action === 'preview') return c.recipesPreview(p.file);
    if (p.action === 'apply') return c.recipesApply(String(p.previewId || ''));
    return { ok: false, reason: 'action inconnue' };
  }
  if (p.op === 'chat') {
    // The chat agent: one user message about the page open in the user's browser (the app holds the AI key).
    const ag = io.agent; if (!ag || typeof ag.chat !== 'function') return { ok: false, reason: 'application à mettre à jour' };
    if (typeof p.html !== 'string' || p.html.length > 8 * 1024 * 1024) return { ok: false, reason: 'page illisible ou trop volumineuse' };
    return ag.chat(url, { chatId: p.chatId, message: p.message, html: p.html, preview: p.preview && typeof p.preview === 'object' ? p.preview : null, sampleUrls: Array.isArray(p.sampleUrls) ? p.sampleUrls.slice(0, 20) : [] });
  }
  if (p.op === 'page') {
    // A product page as the user's browser rendered it (sub-pages read in the browser).
    const runId = typeof p.runId === 'string' && /^[\w-]{4,64}$/.test(p.runId) ? p.runId : null;
    if (!runId) return { ok: false, reason: 'run inconnu' };
    const put = (io.pageCache || PAGE_CACHE).put(runId, url, p.html);
    return put === true ? { ok: true } : { ok: false, reason: typeof put === 'string' ? put : 'page refusée' };
  }
  if (p.op === 'page_reuse') {
    // « Lire les fiches manquantes »: the follow-up run starts with the pages the first run already sent.
    const runId = typeof p.runId === 'string' && /^[\w-]{4,64}$/.test(p.runId) ? p.runId : null;
    const from = typeof p.from === 'string' && /^[\w-]{4,64}$/.test(p.from) ? p.from : null;
    if (!runId || !from) return { ok: false, reason: 'run inconnu' };
    const cache = io.pageCache || PAGE_CACHE;
    return { ok: true, urls: typeof cache.reuse === 'function' ? cache.reuse(from, runId) : [] };
  }
  if (p.op === 'page_keep') {
    // A paused run (human check in the user's browser) keeps the pages already sent while the user answers.
    const runId = typeof p.runId === 'string' && /^[\w-]{4,64}$/.test(p.runId) ? p.runId : null;
    return { ok: !!runId && (io.pageCache || PAGE_CACHE).keep(runId) };
  }
  if (p.op === 'rows') return jobRowsChunk(p, io);
  if (p.op === 'ingest') {
    if (!io.controller || typeof io.controller.ingestExternalProducts !== 'function') return { ok: false, reason: 'application indisponible' };
    // One record per panel run: a repeated "Accepter" (even while the first is still
    // being recorded) gets the same answer instead of a duplicate job.
    const runId = typeof p.runId === 'string' && /^[\w-]{4,64}$/.test(p.runId) ? p.runId : null;
    const runs = io.runs || RECENT_RUNS;
    if (runId && runs.has(runId)) return { ...(await runs.get(runId)), duplicate: true };
    const work = ingestRows(p, url, { ...io, knowledge: io.knowledge });
    if (runId) {
      runs.set(runId, work);
      work.then((res) => { if (!res || !res.ok) runs.delete(runId); }, () => runs.delete(runId));
      while (runs.size > 50) runs.delete(runs.keys().next().value);
    }
    return work;
  }
  return { ok: false, reason: 'demande inconnue' };
}

// Product pages the user's browser rendered for a run (op 'page'), until « Accepter » uses them.
// Bounded: per run (as many as the rows a run may hold), in total, and in time (a run the user never accepted
// is dropped; a paused run is kept alive by op 'page_keep'). A refused page answers WHY, and the extension
// reports it as not read — never a silent loss.
const PAGE_TTL_MS = 3 * 60 * 60 * 1000; const MAX_PAGES_PER_RUN = MAX_ROWS; const MAX_PAGE_BYTES = 16 * 1024 * 1024; const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
export function createPageCache({ now = Date.now, maxTotalBytes = MAX_TOTAL_BYTES, maxPagesPerRun = MAX_PAGES_PER_RUN } = {}) {
  // A run's pages, once taken by its job, stay `taken` until they expire: « Lire les fiches manquantes » reuses
  // them (reuse) instead of opening those pages again. Taken runs are the first to go when memory is short.
  const runs = new Map(); let bytes = 0;
  const drop = (id) => { const r = runs.get(id); if (r) { bytes -= r.bytes; runs.delete(id); } };
  const sweep = () => { for (const [id, r] of runs) if (now() - r.at > PAGE_TTL_MS) drop(id); };
  const room = (need) => {
    if (bytes + need <= maxTotalBytes) return true;
    for (const [id] of [...runs].filter(([, x]) => x.taken).sort((a, b) => a[1].at - b[1].at)) { drop(id); if (bytes + need <= maxTotalBytes) return true; }
    return false;
  };
  return {
    /** @returns {true|string} true, or why the page was refused ('page_too_large', 'run_full', 'memory_full'). */
    put(runId, url, html) {
      sweep();
      if (typeof html !== 'string' || !html) return 'page_empty';
      if (html.length > MAX_PAGE_BYTES) return 'page_too_large';
      const r = runs.get(runId) || { pages: new Map(), at: now(), bytes: 0 };
      if (r.pages.size >= maxPagesPerRun) return 'run_full';
      if (!room(html.length)) return 'memory_full';
      const key = String(url).split('#')[0];
      if (r.pages.has(key)) { bytes -= r.pages.get(key).length; r.bytes -= r.pages.get(key).length; }
      r.pages.set(key, html); r.bytes += html.length; bytes += html.length; r.at = now(); r.taken = false; runs.set(runId, r);
      return true;
    },
    keep(runId) { const r = runs.get(runId); if (!r) return false; r.at = now(); return true; },
    /** The pages sent for a run, for its job (once: a second take answers null). */
    take(runId) { sweep(); const r = runs.get(runId); if (!r || r.taken) return null; r.taken = true; r.at = now(); return new Map(r.pages); },
    /** A follow-up run starts with the pages an earlier run already read: their URLs, moved to `toRunId`. */
    reuse(fromRunId, toRunId) {
      sweep(); const r = runs.get(fromRunId);
      if (!r || fromRunId === toRunId) return [];
      runs.delete(fromRunId);
      const to = runs.get(toRunId);
      if (to) { for (const [u, h] of r.pages) { if (!to.pages.has(u)) { to.pages.set(u, h); to.bytes += h.length; } else bytes -= h.length; } to.at = now(); }
      else runs.set(toRunId, { pages: r.pages, at: now(), bytes: r.bytes, taken: false });
      return [...r.pages.keys()];
    },
    size: () => ({ runs: runs.size, bytes }),
  };
}
const PAGE_CACHE = createPageCache();

/** The product pages the user's browser sent for a run or a job (op 'page'), taken once. */
export function takeRenderedPages(runId, cache = PAGE_CACHE) {
  return typeof runId === 'string' && /^[\w-]{4,64}$/.test(runId) ? cache.take(runId) : null;
}

const ROLE_IDS = new Set(ROLES);
/** The panel's columns: key, label as typed, role for the Converter (validated, bounded). */
export function columnRoles(fields) {
  return (Array.isArray(fields) ? fields : []).slice(0, 60).filter((f) => f && typeof f.key === 'string' && /^[a-z][a-z0-9_]{0,39}$/i.test(f.key))
    .map((f) => ({ key: f.key, label: String(f.label || f.key).slice(0, 80), ...(ROLE_IDS.has(f.role) ? { role: f.role } : {}), ...(typeof f.axis === 'string' && f.axis.trim() ? { axis: f.axis.trim().slice(0, 30) } : {}) }));
}

/** The extension's product-page counts for a run, validated (numbers only). */
function enrichCounts(e) {
  if (!e || typeof e !== 'object') return null;
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.min(Math.floor(Number(v)), MAX_ROWS * 2) : 0);
  const out = { toRead: n(e.toRead), read: n(e.read), blocked: n(e.blocked), notOpened: n(e.notOpened) };
  if (e.limit && Number(e.limit.max) > 0) out.limit = { max: n(e.limit.max) };
  // The pages not read, by address and reason (at most 500; the counts stay exact).
  const REASONS = new Set(['human_check', 'failed', 'denied', 'limit', 'time', 'stopped', 'not_opened']);
  if (Array.isArray(e.list)) out.list = e.list.slice(0, 500).filter((x) => x && typeof x.url === 'string' && /^https?:\/\//.test(x.url) && REASONS.has(x.reason)).map((x) => ({ url: x.url.slice(0, 2000), reason: x.reason }));
  return out.toRead ? out : null;
}

// Recent panel runs already recorded (runId → Promise of the reply), bounded.
const RECENT_RUNS = new Map();

async function ingestRows(p, url, io) {
  const rows = (Array.isArray(p.rows) ? p.rows : []).slice(0, MAX_ROWS).map(sanitizeRow).filter(Boolean);
  if (!rows.length) return { ok: false, reason: 'aucune ligne exploitable à enregistrer' };
  const fields = (Array.isArray(p.fields) ? p.fields : []).slice(0, 40).map((f) => f && String(f.key || '').slice(0, 40)).filter(Boolean);
  const durationMs = Number.isFinite(Number(p.durationMs)) ? Math.max(0, Math.round(Number(p.durationMs))) : 0;
  // The designations made on the list page become the site's card recipe (one persistence for panel and app).
  let cardsLearned = null;
  if (p.designated && io.knowledge && typeof io.knowledge.learnCards === 'function') { try { cardsLearned = io.knowledge.learnCards(url, p.designated); } catch { cardsLearned = null; } }
  const res = await io.controller.ingestExternalProducts({
    products: rows, origin: url, method: 'your-browser', lang: typeof p.lang === 'string' ? p.lang.slice(0, 5) : 'fr',
    outcome: { status: 'done', blocked: null, stoppedByUser: false, text: '' }, durationMs,
    completeDetails: p.subpages === true,
    browserChallenged: Number.isInteger(p.browserChallenged) && p.browserChallenged > 0 ? Math.min(p.browserChallenged, 1000) : 0,
    // What the user's browser read of the rows' product pages (blocked and unopened ones make the job PARTIAL).
    yourBrowserPages: enrichCounts(p.enrich),
    // Each column with the name the user typed and the role chosen for the Converter (job manifest).
    // Fixed values typed in the panel (brand, collection, type, tags, status, established attributes): given to every product.
    constants: normalizeConstants(p.constants),
    columns: [...columnRoles(p.fields), ...constantColumns(normalizeConstants(p.constants))].filter((c, i, all) => all.findIndex((x) => x.key === c.key) === i),
    // Product pages the user's browser rendered for this run: used before any HTTP re-read.
    renderedPages: (() => { const runId = typeof p.runId === 'string' ? p.runId : null; return runId ? (io.pageCache || PAGE_CACHE).take(runId) : null; })(),
    listing: { trail: (p.listing && Array.isArray(p.listing.trail) ? p.listing.trail : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 80)).slice(0, 8), pagination: listPagination(p.listing && p.listing.pagination), rejected: listRejected(p.listing && p.listing.rejected), hub: hubRead(p.listing && p.listing.hub) },
    details: { domain: hostKey(url), source: 'panel', fields, rowsSent: Array.isArray(p.rows) ? p.rows.length : 0 },
  });
  let finished = null;
  try { if (res && res.jobId && typeof io.controller.jobProducts === 'function') finished = finishedRows(io.controller.jobProducts(res.jobId, { limit: Infinity })); } catch { finished = null; }
  return { ok: true, jobId: res && res.jobId, counts: res && res.counts, status: res && res.status, reportStatus: (res && res.reportStatus) || null, rulesFailing: (res && Array.isArray(res.rulesFailing)) ? res.rulesFailing : [], ...(res && res.manifest ? { manifest: res.manifest } : {}), ...(cardsLearned ? { cardsLearned } : {}), ...(finished ? { rows: finished.rows, rowsNext: finished.next, rowsTotal: finished.total } : {}) };
}

/** op 'rows': the next chunk of a job's finished rows (after the first one sent with the ingest reply). */
function jobRowsChunk(p, io) {
  const jobId = typeof p.jobId === 'string' && /^[\w-]{4,64}$/.test(p.jobId) ? p.jobId : null;
  if (!jobId) return { ok: false, reason: 'job inconnu' };
  if (!io.controller || typeof io.controller.jobProducts !== 'function') return { ok: false, reason: 'application à mettre à jour' };
  let list = null; try { list = io.controller.jobProducts(jobId, { limit: Infinity }); } catch { list = null; }
  if (!Array.isArray(list)) return { ok: false, reason: 'job introuvable' };
  const c = finishedRows(list, { offset: p.offset });
  return { ok: true, jobId, rows: c.rows, next: c.next, total: c.total };
}
