/**
 * Technical specifications of a product page ("Caractéristiques techniques",
 * "Données techniques", "Specificaties"…), read by SHAPE, never by site:
 *
 *   1. JSON-LD `additionalProperty` (schema.org PropertyValue: name, value, unitText);
 *   2. the page's embedded state: an object carrying a group label and a list of
 *      at least two "feature" objects (a label + a value), whatever the field
 *      spelling. A normalised Apollo cache (`{"__ref": "Type:id"}` entries) is
 *      resolved first, so the features are read where the store keeps them;
 *   3. the HTML: two-cell table rows and definition lists, only when 1 and 2 gave
 *      nothing.
 *
 * Output: [{ group, name, value }] — `group` is null when the source has none; a
 * unit stated apart is appended to the value ("60" + "Hz" → "60 Hz"). Deduped by
 * name + value, bounded (MAX_SPECS). Nothing is invented: no source, no entry.
 *
 * PORTABLE: zero Node built-ins, zero dependencies.
 */

const MAX_SPECS = 300;
const MAX_LABEL = 120;
const MAX_VALUE = 400;

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : (typeof v === 'number' && Number.isFinite(v) ? String(v) : (typeof v === 'boolean' ? String(v) : null)));
const lc = (k) => String(k).toLowerCase();

// Roles (lower-case keys), in preference order.
const LABEL_KEYS = ['name', 'label', 'title', 'key', 'featurename', 'attributename', 'propertyname', 'specname', 'displayname'];
const VALUE_KEYS = ['value', 'displayvalue', 'valuetext', 'formattedvalue', 'text', 'values', 'valuesandunits', 'attributevalue'];
const UNIT_KEYS = ['unit', 'unittext', 'unitname', 'uom'];
const GROUP_LABEL_KEYS = ['featuregroupname', 'groupname', 'sectionname', 'categoryname', 'name', 'title', 'label', 'heading', 'displayname'];
// The product a spec group belongs to, when the state says so (several products'
// specs often share one store: the page's product and the accessories shown with it).
const OWNER_KEYS = ['productid', 'sku', 'articleid', 'articlenumber', 'productcode', 'itemid', 'productnumber'];
// A list whose items carry a price or a link is a list of products/links, not features.
const NOT_FEATURE_KEYS = ['price', 'prices', 'url', 'href', 'link', 'sku', 'gtin', 'image', 'images'];

const keyOf = (o, keys) => { const m = new Map(Object.keys(o).map((k) => [lc(k), k])); for (const k of keys) if (m.has(k)) return m.get(k); return null; };
const clip = (s, n) => (s.length > n ? s.slice(0, n).trim() : s);
const stripTags = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#x27;|&#39;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim();

/** One value as text: a string/number, a list of values ("a, b"), or value objects ({value, unit}). */
function valueText(v, depth = 0) {
  if (depth > 3 || v == null) return null;
  const s = str(v); if (s) return s;
  if (Array.isArray(v)) { const parts = v.map((x) => valueText(x, depth + 1)).filter(Boolean); return parts.length ? [...new Set(parts)].join(', ') : null; }
  if (isObj(v)) {
    const vk = keyOf(v, ['value', 'text', 'name', 'label', 'displayvalue']); if (!vk) return null;
    const base = valueText(v[vk], depth + 1); if (!base) return null;
    const uk = keyOf(v, UNIT_KEYS); const unit = uk ? str(v[uk]) : null;
    return unit && !base.endsWith(unit) ? `${base} ${unit}` : base;
  }
  return null;
}

/** A feature object → { name, value } or null. */
function featureOf(o) {
  if (!isObj(o)) return null;
  if (keyOf(o, NOT_FEATURE_KEYS)) return null;
  const lk = keyOf(o, LABEL_KEYS); const vk = keyOf(o, VALUE_KEYS.filter((k) => k !== lc(lk || '')));
  if (!lk || !vk) return null;
  const name = str(o[lk]); if (!name || name.length > MAX_LABEL) return null;
  let value = valueText(o[vk]); if (!value) return null;
  const uk = keyOf(o, UNIT_KEYS); const unit = uk ? str(o[uk]) : null;
  if (unit && !value.endsWith(unit)) value = `${value} ${unit}`;
  if (value === name) return null;
  return { name, value: clip(value, MAX_VALUE) };
}

// A configuration entry: a CONSTANT_CASE name, or the shape of a feature flag / an A/B test.
const CONFIG_NAME = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;
const CONFIG_KEYS = ['defaultvariant', 'defaultvalue', 'flagkey', 'experimentid', 'targeting', 'rollout'];
const isConfig = (o) => !!keyOf(o, CONFIG_KEYS) || (typeof o.name === 'string' && CONFIG_NAME.test(o.name) && Array.isArray(o.variants));
const BULLET_KEYS = /^(usps|features|feature_?bullets|bullets|bullet_?points|highlights|key_?features|product_?highlights)$/i;
/** A list of short sentences → « Label: Value » pairs, and the rest as one « Détails » entry. */
function bulletSpecs(list) {
  const pairs = []; const rest = [];
  for (const raw of list.slice(0, 40)) {
    const s = stripTags(raw).replace(/[.;]\s*$/, '').trim(); if (!s || s.length > 200) continue;
    const m = s.match(/^([^:：]{2,40})\s*[:：]\s*(.{1,160})$/);
    if (m) pairs.push({ name: m[1].trim(), value: m[2].trim() }); else rest.push(s);
  }
  if (rest.length) pairs.push({ name: 'Détails', value: clip(rest.join(' · '), MAX_VALUE) });
  return pairs;
}

/** The Apollo-style reference map of a state: every `"Type:id": {__typename…}` entry. */
function refMap(root) {
  const map = new Map(); let seen = 0;
  const walk = (n, depth) => {
    if (depth > 8 || seen > 200000) return;
    if (Array.isArray(n)) { for (const x of n) walk(x, depth + 1); return; }
    if (!isObj(n)) return;
    for (const [k, v] of Object.entries(n)) {
      seen += 1;
      if (isObj(v) && typeof v.__typename === 'string' && k.includes(':')) map.set(k, v);
      if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };
  walk(root, 0);
  return map;
}
const deref = (v, refs) => (isObj(v) && typeof v.__ref === 'string' && refs.has(v.__ref) ? refs.get(v.__ref) : v);

/**
 * Spec groups found in one JSON value (embedded state). With `productIds` (the page
 * product's sku / EAN / id), groups that name ANOTHER product are dropped; when the
 * state holds several products and none is the page's, nothing is kept.
 */
export function specsFromState(root, { productIds = [] } = {}) {
  const refs = refMap(root);
  const out = []; let visited = 0;
  const walk = (n, depth, owner) => {
    if (depth > 14 || visited > 300000 || out.length >= MAX_SPECS * 4) return;
    n = deref(n, refs);
    if (Array.isArray(n)) { for (const x of n) walk(x, depth + 1, owner); return; }
    if (!isObj(n)) return;
    visited += 1;
    const ok = keyOf(n, OWNER_KEYS); if (ok && str(n[ok])) owner = str(n[ok]);
    let consumed = null;
    // A site's configuration (feature flags: {name:"ADIPULSE_ENABLED", defaultVariant, variants:[{name:"off", value:false}]})
    // is not the product's specifications (adidas 28/10: « ADIPULSE_ENABLED : off = false » in the export).
    if (isConfig(n)) return;
    for (const [k, v] of Object.entries(n)) {
      if (!Array.isArray(v) || v.length < 2) continue;
      // « usps » / « features » / « highlights »: the product's details as a list of short sentences (« Tige: Cuir »).
      if (BULLET_KEYS.test(k) && v.every((x) => typeof x === 'string')) { for (const s of bulletSpecs(v)) out.push({ group: null, ...s, owner }); consumed = k; continue; }
      const feats = v.map((x) => featureOf(deref(x, refs))).filter(Boolean);
      if (feats.length < 2 || feats.length < v.length * 0.6) continue;
      if (feats.every((f) => /^(true|false|on|off)$/i.test(f.value))) continue; // switches, not characteristics
      const gk = keyOf(n, GROUP_LABEL_KEYS.filter((g) => g !== lc(k)));
      const group = gk ? str(n[gk]) : null;
      if (group && CONFIG_NAME.test(group)) continue;
      for (const f of feats) out.push({ group: group && group.length <= MAX_LABEL ? group : null, ...f, owner });
      consumed = k;
    }
    for (const [k, v] of Object.entries(n)) if (k !== consumed && v && typeof v === 'object') walk(v, depth + 1, owner);
  };
  walk(root, 0, null);
  const ids = new Set((productIds || []).map((x) => str(x)).filter(Boolean).map(lc));
  const owners = new Set(out.map((s) => s.owner).filter(Boolean).map(lc));
  let kept = out;
  if (owners.size) {
    const mine = out.filter((s) => s.owner && ids.has(lc(s.owner)));
    kept = mine.length ? mine : (owners.size === 1 ? out : []); // one product only: it is the page's
  }
  return kept.map(({ owner, ...s }) => s);
}

/** schema.org additionalProperty (PropertyValue) of a JSON-LD node. */
export function specsFromJsonLd(node) {
  if (!isObj(node)) return [];
  const list = [].concat(node.additionalProperty || []).filter(isObj);
  return list.map((p) => {
    const name = str(p.name) || str(p.propertyID); const v = valueText(p.value);
    if (!name || !v) return null;
    const unit = str(p.unitText) || str(p.unitCode);
    return { group: null, name: clip(name, MAX_LABEL), value: clip(unit && !v.endsWith(unit) ? `${v} ${unit}` : v, MAX_VALUE) };
  }).filter(Boolean);
}

/** Label/value pairs of the HTML: two-cell table rows and <dt>/<dd> pairs. */
export function specsFromHtml(html) {
  const out = []; const src = String(html || ''); let m; let n = 0;
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  while ((m = rowRe.exec(src)) && n < 600) {
    n += 1;
    const cells = [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)];
    if (cells.length !== 2) continue;
    const name = stripTags(cells[0][1]); const value = stripTags(cells[1][1]);
    if (name && value && name.length <= MAX_LABEL && name !== value) out.push({ group: null, name, value: clip(value, MAX_VALUE) });
  }
  const dlRe = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi; n = 0;
  while ((m = dlRe.exec(src)) && n < 600) {
    n += 1;
    const name = stripTags(m[1]); const value = stripTags(m[2]);
    if (name && value && name.length <= MAX_LABEL && name !== value) out.push({ group: null, name, value: clip(value, MAX_VALUE) });
  }
  return out;
}

/** Dedupe (name + value) and bound. */
export function dedupeSpecs(list) {
  const seen = new Set(); const out = [];
  for (const s of list || []) {
    const k = `${lc(s.name)}\u0000${lc(s.value)}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(s);
    if (out.length >= MAX_SPECS) break;
  }
  return out;
}

/**
 * Specs of a product page, best source first.
 * @param {{ jsonLdNode?:object|null, states?:any[], html?:string, productIds?:string[] }} src
 * @returns {Array<{group:string|null, name:string, value:string}>}
 */
export function extractSpecs({ jsonLdNode = null, states = [], html = '', productIds = [] } = {}) {
  const structured = [...specsFromJsonLd(jsonLdNode)];
  for (const s of states || []) { structured.push(...specsFromState(s, { productIds })); if (structured.length >= MAX_SPECS) break; }
  const list = structured.length ? structured : specsFromHtml(html);
  return dedupeSpecs(list);
}
