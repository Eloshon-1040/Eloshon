// Phase 7.7 — card-data scanner, in the INGESTION path (not an audit).
//
// Hard rule: never read, store or migrate raw payment card data (PAN, CVV,
// full numbers). This module runs on every source object BEFORE anything
// canonicalises or preserves it, and on every CSV table before a parser reads
// it. A hit is REMOVED from the object (the value never reaches
// sourceExtension._raw, a fixture or a target) and reported by path + kind —
// never by value. Truncated / masked numbers (IIN, last4, •••• 4242), card
// expiry, card holder, gateway tokens, IBANs and credentials (password
// hashes, secure keys, reset tokens) are stripped too. A card BRAND ('visa')
// is a payment fact and is kept.
//
// Detection is DATA (core/knowledge-ref/canon/pci.v1.json): field-name
// families, card container names, value shapes (Luhn-valid 13–19 digits,
// masked PAN, IBAN, expiry, CVV) and the brand allow-list. Bare digit strings
// are only treated as a PAN under a card-family name or next to a
// card-family sibling / inside a card container — a GTIN-13 on a product line
// is not a card.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CONFIG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'knowledge-ref', 'canon', 'pci.v1.json');
let cached = null;
export function loadPciConfigSync(fp = DEFAULT_CONFIG_PATH) {
  if (cached && cached.fp === fp) return cached.doc;
  const doc = JSON.parse(fs.readFileSync(fp, 'utf8'));
  cached = { fp, doc };
  return doc;
}

function compile(cfg) {
  const fam = Object.fromEntries(Object.entries(cfg.nameFamilies || {}).map(([k, re]) => [k, new RegExp(re, 'i')]));
  const shapes = Object.fromEntries(Object.entries(cfg.valueShapes || {}).map(([k, s]) => [k, { ...s, re: new RegExp(s.regex) }]));
  return { fam, shapes, container: new RegExp(cfg.cardContainerNames, 'i'), brand: new RegExp(cfg.brandFields, 'i'), context: new Set(cfg.cardContextFamilies || []) };
}

/** Luhn check on a digit string (spaces / dashes ignored). */
export function luhnValid(s) {
  const d = String(s).replace(/[ -]/g, '');
  if (!/^\d{13,19}$/.test(d)) return false;
  let sum = 0, dbl = false;
  for (let i = d.length - 1; i >= 0; i--) { let n = d.charCodeAt(i) - 48; if (dbl) { n *= 2; if (n > 9) n -= 9; } sum += n; dbl = !dbl; }
  return sum % 10 === 0;
}

const norm = (k) => String(k).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

function familyOf(key, c) {
  const k = norm(key);
  for (const [name, re] of Object.entries(c.fam)) if (re.test(k)) return name;
  return null;
}

/**
 * scanForCardData(value, { config?, strip = true }) → { value, findings }
 *   value    : a deep copy with every hit removed (strip) — or the original when strip=false
 *   findings : [{ path, kind, via: 'name' | 'shape' | 'container' }]  — never the value
 * Pure; the input is never mutated.
 */
export function scanForCardData(input, { config = loadPciConfigSync(), strip = true } = {}) {
  const c = compile(config);
  const findings = [];
  const isBrand = (key) => c.brand.test(norm(key));

  const walk = (v, pathParts, inCardContainer, siblingsCardish) => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, [...pathParts, `[${i}]`], inCardContainer, false));
    if (!v || typeof v !== 'object') return v;
    const keys = Object.keys(v);
    // a bare `number` key is only a card sibling when something ELSE in the object says "card"
    const cardSiblings = keys.some((k) => { const f = familyOf(k, c); return f && c.context.has(f) && !(f === 'pan' && norm(k) === 'number'); });
    const out = {};
    for (const k of keys) {
      const p = [...pathParts, k].join('.').replace(/\.\[/g, '[');
      const fam = familyOf(k, c);
      const val = v[k];
      const brand = isBrand(k);
      // 1. card containers: a `credit_card` / `paymentDetails` object goes entirely — except brand fields inside it
      if (c.container.test(norm(k)) && val && typeof val === 'object' && !Array.isArray(val)) {
        const kept = {};
        for (const [ik, iv] of Object.entries(val)) if (isBrand(ik) && (iv === null || typeof iv !== 'object')) kept[ik] = iv;
        // idempotent: a container already reduced to its brand fields is not a finding
        if (Object.keys(kept).length !== Object.keys(val).length) findings.push({ path: p, kind: 'card-container', via: 'container' });
        if (strip) { if (Object.keys(kept).length) out[k] = kept; } else out[k] = val;
        continue;
      }
      // 2. name families (credential family included) — whatever the value (null / masked / hashed)
      if (fam && !brand && !(fam === 'pan' && k.toLowerCase() === 'number' && !inCardContainer && !cardSiblings)) {
        if (val !== undefined && val !== null && val !== '') findings.push({ path: p, kind: fam, via: 'name' });
        if (!strip) out[k] = val;
        continue;
      }
      // 3. value shapes, independent of the name
      if (typeof val === 'string' || typeof val === 'number') {
        const s = String(val).trim();
        if (c.shapes.iban && c.shapes.iban.re.test(s.replace(/\s/g, '')) && s.replace(/\s/g, '').length >= 15 && /^[A-Z]{2}\d{2}/.test(s)) { findings.push({ path: p, kind: 'bank', via: 'shape' }); if (!strip) out[k] = val; continue; }
        if (c.shapes.maskedPan && c.shapes.maskedPan.re.test(s)) { findings.push({ path: p, kind: 'pan', via: 'shape' }); if (!strip) out[k] = val; continue; }
        if (c.shapes.pan && c.shapes.pan.re.test(s) && (inCardContainer || cardSiblings || siblingsCardish) && (!c.shapes.pan.luhn || luhnValid(s))) { findings.push({ path: p, kind: 'pan', via: 'shape' }); if (!strip) out[k] = val; continue; }
        if (c.shapes.expiry && (inCardContainer || cardSiblings) && c.shapes.expiry.re.test(s) && /exp/i.test(norm(k))) { findings.push({ path: p, kind: 'expiry', via: 'shape' }); if (!strip) out[k] = val; continue; }
      }
      out[k] = walk(val, [...pathParts, k], inCardContainer || c.container.test(norm(k)), cardSiblings);
    }
    return out;
  };
  const value = walk(input, [], false, false);
  return { value, findings };
}

/** Table form (CSV): strips cells of card-family / card-shaped columns. Returns { headers, rows, findings } without mutating. */
export function scanTable(table, { config = loadPciConfigSync() } = {}) {
  const c = compile(config);
  const findings = [];
  const badCols = new Set();
  const cardContext = table.headers.some((h) => { const f = familyOf(h, c); return f && f !== 'pan' && c.context.has(f); });
  for (const h of table.headers) {
    const fam = familyOf(h, c);
    if (!fam || c.brand.test(norm(h))) continue;
    if (fam === 'pan' && norm(h) === 'number' && !cardContext) continue;   // an order "Number" column is not a card
    badCols.add(h);
  }
  // column with card-shaped VALUES (a 'Number' column that is Luhn-valid on most rows)
  for (const h of table.headers) {
    if (badCols.has(h)) continue;
    const vals = table.rows.map((r) => String(r[h] ?? '').trim()).filter(Boolean).slice(0, 200);
    if (vals.length >= 3 && vals.filter((v) => c.shapes.maskedPan.re.test(v) || (c.shapes.pan.re.test(v) && luhnValid(v) && /card|cc|pan/i.test(norm(h)))).length / vals.length >= 0.8) badCols.add(h);
  }
  if (!badCols.size) return { headers: table.headers, rows: table.rows, findings, malformed: table.malformed };
  for (const h of badCols) findings.push({ path: h, kind: familyOf(h, c) ?? 'pan', via: familyOf(h, c) ? 'name' : 'shape', rows: table.rows.filter((r) => (r[h] ?? '') !== '').length });
  const rows = table.rows.map((r) => { const o = { ...r }; for (const h of badCols) if (h in o) o[h] = ''; return o; });
  return { headers: table.headers, rows, findings, malformed: table.malformed };
}
