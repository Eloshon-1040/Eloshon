/**
 * The export manifest: ONE contract, from the extension and the app to the Converter, that says what an
 * export really holds. Every export (panel CSV, job CSV, products.json, .eloshon) carries it, so an
 * incomplete export can never pass for a complete one:
 *   - where it comes from (extension | app) and the contract version;
 *   - its status: `preview` (the list as read, before « Accepter »), `complete`, or `partial`;
 *   - the product pages: how many were to read, how many were read, which ones were blocked and why,
 *     which ones were never opened (a limit, the time budget, a stop) — never a silent cut;
 *   - the site rules that failed, the rows cut from the export, and the fill rate of every column.
 *
 * Portable (no Node, no chrome.*): the extension ships it through `extension/vendor/shared/`, the app
 * imports it directly, and the Converter reads the same shape (`converter/core/knowledge-proposal/export-manifest.mjs`).
 */

export const MANIFEST_KIND = 'eloshon.export-manifest';
export const MANIFEST_CONTRACT = 1;
export const MANIFEST_STATUSES = ['preview', 'complete', 'partial'];
export const MANIFEST_SOURCES = ['extension', 'app'];
/** Why a product page was not read. */
export const PAGE_REASONS = ['human_check', 'failed', 'limit', 'time', 'stopped', 'not_opened', 'denied'];

const MAX_LISTED = 500; // product pages listed by URL; the counts stay exact beyond
const filled = (v) => {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.some((x) => filled(x));
  if (typeof v === 'object') return Object.keys(v).length > 0;
  if (typeof v === 'number') return Number.isFinite(v);
  return true;
};

/**
 * Fill rate per column: how many rows have a value in it.
 * @param {object[]} rows
 * @param {{key:string,label?:string}[]} columns
 * @param {(row:object,key:string)=>any} [read]  how a cell is read (default: row[key])
 * @returns {Record<string,{label:string,filled:number,total:number}>}
 */
export function columnFill(rows, columns, read = (row, key) => (row ? row[key] : null)) {
  const list = Array.isArray(rows) ? rows : [];
  const out = {};
  for (const c of columns || []) {
    if (!c || !c.key) continue;
    let n = 0;
    for (const r of list) { let v = null; try { v = read(r, c.key); } catch { v = null; } if (filled(v)) n++; }
    out[c.key] = { label: String(c.label || c.key), filled: n, total: list.length };
  }
  return out;
}

const count = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
const pageList = (list) => (Array.isArray(list) ? list : [])
  .filter((p) => p && typeof p.url === 'string')
  // `detail`: why a page failed, in words (optional, added after contract 1 — readers ignore it).
  .map((p) => ({ url: p.url, reason: PAGE_REASONS.includes(p.reason) ? p.reason : 'failed', ...(typeof p.detail === 'string' && p.detail ? { detail: p.detail.slice(0, 120) } : {}) }));

/**
 * Builds the manifest and DERIVES its status (a caller never declares "complete" itself):
 *   preview  — the rows were not accepted (`accepted: false`);
 *   complete — accepted, every product page to read was read, nothing blocked or unopened, no failing
 *              rule, no row cut;
 *   partial  — anything else.
 * @param {object} o
 * @returns {object} the manifest
 */
export function buildManifest(o = {}) {
  const pages = o.productPages || {};
  const blocked = pageList(pages.blocked);
  const notOpened = pageList(pages.notOpened);
  const toRead = count(pages.toRead);
  const read = Math.min(count(pages.read), toRead || count(pages.read));
  const blockedCount = Math.max(count(pages.blockedCount), blocked.length);
  const notOpenedCount = Math.max(count(pages.notOpenedCount), notOpened.length, toRead ? toRead - read - blockedCount : 0);
  // Exact counts per reason, even beyond the listed URLs (callers may pass counts for unlisted pages).
  const byReason = {};
  for (const p of [...blocked, ...notOpened]) byReason[p.reason] = (byReason[p.reason] || 0) + 1;
  for (const [k, v] of Object.entries(pages.byReason || {})) if (PAGE_REASONS.includes(k)) byReason[k] = Math.max(byReason[k] || 0, count(v));
  const unlistedNotOpened = notOpenedCount - Object.entries(byReason).filter(([k]) => k !== 'human_check' && k !== 'failed' && k !== 'denied').reduce((s, [, v]) => s + v, 0);
  if (unlistedNotOpened > 0) byReason.not_opened = (byReason.not_opened || 0) + unlistedNotOpened;
  const rulesFailing = (Array.isArray(o.rulesFailing) ? o.rulesFailing : []).filter((r) => r && r.field).map((r) => ({ field: String(r.field), ...(r.reason ? { reason: String(r.reason) } : {}), ...(r.pages != null ? { pages: count(r.pages) } : {}) }));
  const truncated = o.truncated && count(o.truncated.rows) ? { rows: count(o.truncated.rows), ...(o.truncated.reason ? { reason: String(o.truncated.reason) } : {}) } : null;
  const limit = pages.limit && count(pages.limit.max) ? { max: count(pages.limit.max), ...(pages.limit.from ? { from: String(pages.limit.from) } : {}) } : null;
  const accepted = o.accepted === true;
  const incomplete = (toRead > read) || blockedCount > 0 || notOpenedCount > 0 || rulesFailing.length > 0 || !!truncated || o.jobStatus === 'PARTIAL';
  const status = !accepted ? 'preview' : incomplete ? 'partial' : 'complete';
  const rows = Array.isArray(o.rows) ? o.rows : [];
  return {
    kind: MANIFEST_KIND,
    contract: MANIFEST_CONTRACT,
    source: MANIFEST_SOURCES.includes(o.source) ? o.source : 'app',
    ...(o.sourceVersion ? { sourceVersion: String(o.sourceVersion) } : {}),
    createdAt: o.createdAt || new Date().toISOString(),
    ...(o.site ? { site: String(o.site) } : {}),
    ...(o.listUrl ? { listUrl: String(o.listUrl) } : {}),
    // How the list was read (« données publiques de la boutique », « carte produit apprise », « détection automatique »).
    ...(o.listMethod ? { listMethod: String(o.listMethod).slice(0, 160) } : {}),
    ...(o.jobId ? { jobId: String(o.jobId) } : {}),
    ...(o.jobStatus ? { jobStatus: String(o.jobStatus) } : {}),
    status,
    rows: o.rowCount != null ? count(o.rowCount) : rows.length,
    productPages: {
      toRead, read, blocked: blockedCount, notOpened: notOpenedCount, byReason,
      ...(limit ? { limit } : {}),
      list: [...blocked, ...notOpened].slice(0, MAX_LISTED),
    },
    rulesFailing,
    ...(truncated ? { truncated } : {}),
    fill: o.fill || columnFill(rows, o.columns || [], o.read),
    // Each column with its name as typed and its role for the Converter (shared/extract/field-meaning.mjs ROLES).
    ...(Array.isArray(o.columns) && o.columns.some((c) => c && c.role) ? { columns: o.columns.filter((c) => c && c.key).map((c) => ({ key: String(c.key), label: String(c.label || c.key), ...(c.role ? { role: String(c.role) } : {}), ...(c.axis ? { axis: String(c.axis) } : {}) })) } : {}),
  };
}

/** Is this object a manifest this contract can read? (A newer contract is read as far as it goes.) */
export function isManifest(m) {
  return !!(m && typeof m === 'object' && m.kind === MANIFEST_KIND && Number.isInteger(m.contract) && MANIFEST_STATUSES.includes(m.status));
}

/** The sidecar name of an export file: `eloshon-x-20261028-101500.csv` → `eloshon-x-20261028-101500.manifest.json`. */
export function manifestFileName(exportFile) {
  const s = String(exportFile || 'eloshon-export');
  return `${s.replace(/\.(csv|json|eloshon|tsv|txt)$/i, '')}.manifest.json`;
}

/**
 * A unique export name per site and minute, so the browser never renames it ("(3)") and the CSV and
 * its manifest keep the same stem.
 */
export function exportStem(site, at = new Date()) {
  const host = String(site || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0].replace(/[^a-z0-9.-]+/gi, '-').slice(0, 60) || 'export';
  const p = (n) => String(n).padStart(2, '0');
  const d = at instanceof Date ? at : new Date(at);
  return `eloshon-${host}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * One line a person reads (French, the panel's language): « Aperçu : 2 fiches lues sur 864
 * (1 bloquée par une vérification humaine) ».
 */
export function manifestSummaryFr(m) {
  if (!m) return '';
  const p = m.productPages || {};
  const human = (p.byReason && p.byReason.human_check) || 0;
  const head = { preview: 'Aperçu', complete: 'Complet', partial: 'Partiel' }[m.status] || m.status;
  if (!p.toRead) return `${head} : ${m.rows} ligne${m.rows > 1 ? 's' : ''}, aucune fiche produit à lire`;
  const pl = (n, one, many) => `${n} ${n > 1 ? many : one}`;
  if (m.status === 'preview') {
    // Before « Accepter » only a few pages are opened, for the preview: the others are WAITING, not lost.
    const opened = (p.read || 0) + (p.blocked || 0);
    const how = [pl(p.read || 0, 'lue', 'lues')];
    if (human) how.push(`${human} bloquée${human > 1 ? 's' : ''} par une vérification humaine`);
    if (p.blocked - human > 0) how.push(`${p.blocked - human} en échec`);
    const rest = p.notOpened ? ` ; ${p.notOpened > 1 ? `les ${p.notOpened} autres attendent` : 'l’autre attend'} « Accepter »` : '';
    return `Aperçu : ${pl(p.toRead, 'fiche produit', 'fiches produit')} à lire ; ${opened ? `${pl(opened, 'ouverte', 'ouvertes')} pour l’aperçu (${how.join(', ')})` : 'aucune ouverte pour l’aperçu'}${rest}`;
  }
  const extra = [];
  if (human) extra.push(`${human} bloquée${human > 1 ? 's' : ''} par une vérification humaine`);
  const other = p.blocked - human; if (other > 0) extra.push(`${other} en échec`);
  if (p.notOpened) extra.push(`${p.notOpened} non ouverte${p.notOpened > 1 ? 's' : ''}`);
  return `${head} : ${p.read} ${p.read > 1 ? 'fiches lues' : 'fiche lue'} sur ${p.toRead}${extra.length ? ` (${extra.join(', ')})` : ''}`;
}

export { filled as isFilled, MAX_LISTED as MANIFEST_MAX_LISTED };
