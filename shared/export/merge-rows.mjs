/**
 * Finished rows (each product page read by the app) merged INTO the rows already shown, by canonical URL.
 * The panel never swaps its rows for a shorter list: a row the app did not send back (cut, excluded, not
 * finished yet) stays as it was; a finished row with no match is added at the end.
 * Portable: used by the extension panel, tested in Node.
 */

const TRACKING = /^(utm_\w+|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga|ref|ref_src|srsltid)$/i;

/** One key per product page: no fragment, no tracking parameter, no trailing slash, host without www. */
export function canonicalUrlKey(u) {
  if (typeof u !== 'string' || !u) return '';
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return '';
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (TRACKING.test(k)) x.searchParams.delete(k);
    x.searchParams.sort();
    const host = x.hostname.toLowerCase().replace(/^www\./, '');
    const pathName = x.pathname.replace(/\/+$/, '') || '/';
    const q = x.searchParams.toString();
    return `${host}${pathName}${q ? `?${q}` : ''}`;
  } catch { return ''; }
}

export const rowUrl = (r) => (r && (r.sourceUrl || r.canonicalUrl || r.url)) || '';

const present = (v) => v != null && !(typeof v === 'string' && v.trim() === '') && !(Array.isArray(v) && !v.length);

/**
 * @param {object[]} current   rows on screen (list preview or earlier chunks)
 * @param {object[]} finished  rows from the app (a chunk or all)
 * @returns {{ rows: object[], merged: number, added: number }}
 */
export function mergeRowsByUrl(current, finished) {
  const rows = (Array.isArray(current) ? current : []).map((r) => (r && typeof r === 'object' ? { ...r } : r));
  const at = new Map();
  rows.forEach((r, i) => { const k = canonicalUrlKey(rowUrl(r)); if (k && !at.has(k)) at.set(k, i); });
  let merged = 0; let added = 0;
  for (const f of Array.isArray(finished) ? finished : []) {
    if (!f || typeof f !== 'object') continue;
    const k = canonicalUrlKey(rowUrl(f));
    const i = k ? at.get(k) : undefined;
    if (i === undefined) { rows.push({ ...f }); if (k) at.set(k, rows.length - 1); added++; continue; }
    const base = rows[i];
    // What the product page gave wins; a value the list had and the page did not keep stays.
    for (const [key, v] of Object.entries(f)) if (present(v)) base[key] = v;
    merged++;
  }
  return { rows, merged, added };
}
