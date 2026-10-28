/**
 * Fill rate per product field: how many products of a job carry each column. One definition for the job
 * report (`report.fill`, « fill rate » line), the export manifest of a job (`manifest.fill`) and the ops
 * relevé (`scripts/ops-last-scraps.mjs`). A count of pages visited says nothing about what was read: this does.
 */

/** The product columns, with the field of products.json that carries each one. */
export const PRODUCT_FIELDS = [
  { key: 'nom', label: 'nom', get: (p) => p.name },
  { key: 'prix', label: 'prix', get: (p) => p.price },
  { key: 'url', label: 'URL', get: (p) => p.source_url },
  { key: 'reference', label: 'référence', get: (p) => p.source_product_id },
  { key: 'images', label: 'image(s)', get: (p) => (Array.isArray(p.images) && p.images.length ? p.images : p.image_url) },
  { key: 'couleur', label: 'couleur', get: (p) => p.color },
  { key: 'variantes', label: 'variantes', get: (p) => p.variants },
  { key: 'ean', label: 'EAN', get: (p) => p.barcode },
  { key: 'description', label: 'description', get: (p) => p.description },
  { key: 'marque', label: 'marque', get: (p) => p.raw && p.raw.brand },
  { key: 'categorie', label: 'catégorie', get: (p) => p.source_category },
  { key: 'prix_barre', label: 'prix barré', get: (p) => p.raw && p.raw.list_price },
];

/** A value is filled when it carries information (0 counts: a price at 0 is an anomaly, not a gap). */
export function isFilled(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

const pctOf = (n, total) => (total ? Math.round((n / total) * 100) : null);

/** Fill rate per product column, plus the columns designated in the extension panel (raw.columns). */
export function fillRates(products) {
  const list = Array.isArray(products) ? products : [];
  const total = list.length;
  const fields = PRODUCT_FIELDS.map(({ key, label, get }) => {
    const filled = list.filter((p) => { try { return isFilled(get(p)); } catch { return false; } }).length;
    return { key, label, filled, total, pct: pctOf(filled, total) };
  });
  const cols = new Map();
  for (const p of list) {
    const c = p && p.raw && p.raw.columns;
    if (c && typeof c === 'object') for (const [k, v] of Object.entries(c)) cols.set(k, (cols.get(k) || 0) + (isFilled(v) ? 1 : 0));
  }
  const panelColumns = [...cols].map(([label, filled]) => ({ label, filled, total, pct: pctOf(filled, total) }));
  return { total, fields, panelColumns };
}

/** The same rates in the export manifest's shape: { key: { label, filled, total } }. */
export function manifestFill(fill) {
  const out = {};
  for (const f of (fill && fill.fields) || []) out[f.key] = { label: f.label, filled: f.filled, total: f.total };
  for (const c of (fill && fill.panelColumns) || []) out[`col:${c.label}`] = { label: c.label, filled: c.filled, total: c.total };
  return out;
}

/** « fill rate: nom 100 % · prix 100 % · description 6 % … » (report.txt). */
export function fillLine(fill) {
  if (!fill || !fill.total) return '';
  const parts = [...fill.fields, ...(fill.panelColumns || [])].map((f) => `${f.label} ${f.pct} %`);
  return `${parts.join(' · ')} (${fill.total} products)`;
}
