/**
 * Fixed values for a whole scrape (Andy, 28/10/2026): a brand, a collection, a product type, tags… typed once in the
 * panel and given to EVERY product of the scrape, instead of designating a block on each page (a breadcrumb the page
 * moves, a brand the site does not write). Remembered per site.
 *
 * Each value has a role (what the store does with it) and a mode:
 *   - `always` : given to every product, replacing what the pages read (« every product of this scrape is in collection
 *                X ») — the default, as typed for the whole scrape;
 *   - `empty`  : fills only the products where the page gave nothing (the page's own value wins).
 * Tags are ADDED to the tags already there, never replace them.
 *
 * Portable (no DOM, no Node): the panel applies it to its rows (table + CSV export), the app to the products it
 * records (products.json), and the column's role travels in the export manifest to the Converter.
 */

/** The roles a fixed value can have, and the row key each one fills (panel rows and app raw products). */
export const CONSTANT_ROLES = {
  brand: { key: 'brand', label: 'Marque' },
  category: { key: 'category', label: 'Collection' },
  product_type: { key: 'product_type', label: 'Type de produit' },
  tags: { key: 'tags', label: 'Étiquettes' },
  status: { key: 'status', label: 'Statut à l’import' },
  attribute: { key: null, label: 'Attribut' },
};
/**
 * The other fixed values are ESTABLISHED terms only (Andy, 28/10/2026): a closed list, never a free name, so the
 * Converter recognises each column by its name with no guess (and the same key reaches products.json).
 */
export const ATTRIBUTE_TERMS = {
  genre: 'Genre',
  matiere: 'Matière',
  saison: 'Saison',
  origine: 'Pays d’origine',
  garantie: 'Garantie',
};
/** Status at import: a draft is imported hidden, to review before it is on sale. */
export const STATUS_VALUES = { draft: 'Brouillon', active: 'Actif' };
const MODES = new Set(['empty', 'always']);
const MAX_VALUES = 12;
const MAX_LEN = 200;

const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
const filled = (v) => v != null && String(v).trim() !== '';

/** Tags as a clean list: « soldes, Été 2026 ; homme » → ['soldes', 'Été 2026', 'homme'] (order kept, no duplicate). */
export function tagList(v) {
  const seen = new Set(); const out = [];
  for (const t of String(v == null ? '' : v).split(/[,;|]/).map((x) => x.trim()).filter(Boolean)) {
    const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(t); }
  }
  return out;
}

/**
 * The fixed values, validated and bounded: [{ role, key, label, value, mode }]. An empty value is dropped; a free
 * attribute gets a key from its name (« Matière » → matiere).
 */
export function normalizeConstants(list) {
  const out = []; const used = new Set();
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || !CONSTANT_ROLES[c.role] || !filled(c.value)) continue;
    // A free attribute is one of the established terms (by its key, or its name written as in the list).
    const term = c.role === 'attribute' ? (ATTRIBUTE_TERMS[c.term] ? c.term : Object.keys(ATTRIBUTE_TERMS).find((k) => slug(ATTRIBUTE_TERMS[k]) === slug(c.label))) : null;
    if (c.role === 'attribute' && !term) continue;
    const key = term || CONSTANT_ROLES[c.role].key;
    if (used.has(key)) continue; // one value per column
    let value = String(c.value).trim().slice(0, MAX_LEN);
    if (c.role === 'status') { value = STATUS_VALUES[value] ? value : (Object.keys(STATUS_VALUES).find((k) => slug(STATUS_VALUES[k]) === slug(value)) || ''); if (!value) continue; }
    used.add(key);
    out.push({ role: c.role, key, label: term ? ATTRIBUTE_TERMS[term] : CONSTANT_ROLES[c.role].label, value, mode: c.role === 'status' ? 'always' : (MODES.has(c.mode) ? c.mode : 'always') });
    if (out.length >= MAX_VALUES) break;
  }
  return out;
}

/** One row with the fixed values (a new object; the row given is not changed). */
export function applyConstantsToRow(row, constants) {
  const out = { ...(row || {}) };
  for (const c of constants || []) {
    if (c.role === 'tags') { out.tags = tagList([out.tags, c.value].filter(filled).join(', ')).join(', '); continue; }
    if (c.mode === 'always' || !filled(out[c.key])) out[c.key] = c.value;
  }
  return out;
}

/**
 * A normalized product (products.json) with the fixed values: brand → raw.brand, collection → source_category,
 * product type → product_type, tags and free attributes → raw.columns (the user's own columns).
 */
export function applyConstantsToProduct(np, constants) {
  if (!np || !constants || !constants.length) return np;
  np.raw = np.raw || {};
  const set = (cur, c) => (c.mode === 'always' || !filled(cur) ? c.value : cur);
  for (const c of constants) {
    if (c.role === 'brand') np.raw.brand = set(np.raw.brand, c);
    else if (c.role === 'category') np.source_category = set(np.source_category, c);
    else if (c.role === 'product_type') np.product_type = set(np.product_type, c);
    else {
      const cols = np.raw.columns || (np.raw.columns = {});
      cols[c.key] = c.role === 'tags' ? tagList([cols.tags, c.value].filter(filled).join(', ')).join(', ') : set(cols[c.key], c);
    }
  }
  return np;
}

/** The columns the fixed values add to an export, with their role for the Converter (manifest columns). */
export function constantColumns(constants) {
  return (constants || []).map((c) => ({ key: c.key, label: c.label, role: c.role }));
}
