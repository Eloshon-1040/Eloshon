/**
 * Weight / format parser. Converts a contenance string to weight_kg WHEN it is
 * reliable (mass units). For volumes (L/cl/ml) it does NOT invent a kg value —
 * water-density assumptions would be wrong for oil, alcohol, etc. — it returns
 * kg=null and keeps the text so a human/the filter can decide.
 *
 * Handles: "500 g", "1 kg", "1,5 kg", "250g", "6 x 33 cl", "2x1L",
 *          "12 pièces", "1 L", "750 ml".
 */

/** @returns {{ weight_kg: number|null, text: string|null, volume_l: number|null, count: number|null }} */
export function parseWeight(input) {
  const empty = { weight_kg: null, text: null, volume_l: null, count: null };
  if (!input) return empty;
  const text = String(input).trim();
  const s = text.toLowerCase().replace(',', '.');

  // multipack: "6 x 33 cl", "2x1l", "12 x 100 g"
  const multi = s.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|g|mg|l|cl|ml)\b/);
  if (multi) {
    const count = parseFloat(multi[1]);
    const per = parseFloat(multi[2]);
    const unit = multi[3];
    const mass = toKg(per, unit);
    const vol = toL(per, unit);
    return {
      weight_kg: mass != null ? round(mass * count) : null,
      volume_l: vol != null ? round(vol * count) : null,
      count, text,
    };
  }

  // single mass/volume: "500 g", "1.5 kg", "750 ml", "1 l"
  const single = s.match(/(\d+(?:\.\d+)?)\s*(kg|g|mg|l|cl|ml)\b/);
  if (single) {
    const val = parseFloat(single[1]);
    const unit = single[2];
    return { weight_kg: toKg(val, unit), volume_l: toL(val, unit), count: null, text };
  }

  // piece count only: "12 pièces", "x6", "lot de 4"
  const pieces = s.match(/(\d+)\s*(?:pi[eè]ces?|pcs?|stuks?|units?)\b/) || s.match(/\bx\s*(\d+)\b/) || s.match(/lot de (\d+)/);
  if (pieces) return { weight_kg: null, volume_l: null, count: parseInt(pieces[1], 10), text };

  return { ...empty, text };
}

/**
 * Net quantity glued to a UNIT-PRICE reference: "500 g - 2,58 EUR/kg" → "500 g".
 * The trailing "<price> <currency>/<unit>" is the anchor that makes this safe and
 * generic: a nutrition table or a spec line carries no reference price, so it
 * never matches. Returns "<number> <unit>" or null.
 */
export function quantityFromUnitPrice(text) {
  if (!text) return null;
  const re = /(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(kg|g|mg|l|cl|ml)\s*[-–—]\s*\d+(?:[.,]\d+)?\s*(?:€|eur|\$|£|chf)\s*\/\s*(kg|g|mg|l|cl|ml|pi[eè]ce|st(?:uks?)?|unit[eé]?)/i;
  const m = String(text).match(re);
  // A multipack keeps its multiplier ("6 x 33 cl"), so the total is 6 × 33 cl, not 33 cl.
  return m ? `${m[1] ? `${m[1]} x ` : ''}${m[2]} ${m[3].toLowerCase()}` : null;
}

/**
 * A weight written next to its LABEL in free text (a description, a spec block):
 * "<strong>Poids</strong> : 1,2 kg", "Gewicht: ca. 850 g", "Net weight 500 g".
 * Only the item's own weight/net content labels count; a capacity or load label
 * ("Poids maximal de l'utilisateur", "charge max") is not followed directly by a
 * number, so it never matches. Returns "<number> <unit>" or null.
 */
const LABELLED_WEIGHT_RE = /\b(?:poids(?:\s+net|\s+brut)?|net\s+weight|gross\s+weight|weight|netto\s?gewicht|gewicht|peso(?:\s+neto)?|gewicht\s+netto|contenu\s+net|net\s+content|netto\s?inhalt|inhoud)\s*(?:\([^)]{0,20}\))?\s*[:：=-]?\s*(?:env\.?|ca\.?|circa|approx\.?|about|~)?\s*(\d+(?:[.,]\d+)?)\s*(kg|g|mg|l|cl|ml)\b/i;
export function weightFromLabelledText(text) {
  if (!text) return null;
  const plain = String(text).replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ');
  const m = plain.match(LABELLED_WEIGHT_RE);
  return m ? `${m[1]} ${m[2].toLowerCase()}` : null;
}

// A weight/contenance token embedded in the product name ("Biscuits 300g"). Unit-anchored
// so a bare number (a clothing size like "501") is never mistaken for a weight. A
// capacity/rating stated in a NAME ("Elektrische lier, 600 kg" — a winch's PULL rating;
// "étagère 250 kg" — a shelf's LOAD) is not the item's own shippable mass, so a mass
// candidate is dropped when a load/capacity keyword sits near it (fr/nl/de/en) OR when
// it is implausibly large for a self-weight named in a title (> 50 kg). Volumes are
// unaffected (a litre value is never a self-weight, and parseWeight keeps it as volume).
const CAPACITY_NEAR_RE = /(charge|capacit|jusqu|draagverm|belast|tragkraft|trekkracht|maximaal|\bmax\b|\btot\b|up to|load|capacity)/i;
// A number glued to letters before it is part of a model code ("TCL 40S5L", "XR-55A80L"),
// not a quantity; a multipack ("4x33cl", "6×1,5L") is the one letter allowed.
const QTY_IN_NAME_RE = /(\d+(?:[.,]\d+)?)\s?(kg|g|mg|l|cl|ml|litres?|gr(?:ammes?)?)\b/gi;
function quantityInName(s) {
  for (const m of s.matchAll(QTY_IN_NAME_RE)) {
    const before = s.slice(0, m.index);
    // A multipack counts a handful of units ("6x1,5L", "24 x 33cl"); "98X11L" is a model code.
    const pack = before.match(/(?:^|[^\p{L}\d.,])(\d{1,3})\s?[x×]$/iu);
    if (/[\p{L}\d.,]$/u.test(before) && !(pack && Number(pack[1]) >= 2 && Number(pack[1]) <= 48)) continue;
    return m;
  }
  return null;
}
export function weightFromName(name) {
  const s = String(name || '');
  const m = quantityInName(s);
  if (!m) return null;
  const unit = m[2].toLowerCase();
  const isMass = /^(kg|g|mg|gr)/.test(unit);
  if (isMass) {
    const val = parseFloat(m[1].replace(',', '.'));
    const kg = /^kg/.test(unit) ? val : /^mg/.test(unit) ? val / 1e6 : val / 1000; // g/gr → kg
    if (kg > 50) return null;
    const at = m.index ?? s.indexOf(m[0]);
    if (CAPACITY_NEAR_RE.test(s.slice(Math.max(0, at - 20), at + m[0].length + 20))) return null;
  }
  return `${m[1]} ${m[2]}`.replace(/\s+/g, ' ').trim();
}

/**
 * The product's net quantity text, from the best source available, in order: what the
 * source stated (a unit-price reference is reduced to its quantity), a labelled weight
 * in the description, a unit-anchored quantity in the name. Never invents a value.
 */
// "1 m = 0.01", "1 kg = 2,58": the reference unit of a unit price ("per 1 m"), not the pack's size.
const UNIT_REFERENCE_RE = /^\s*\d+(?:[.,]\d+)?\s*[a-zµ²³]{1,4}\s*=\s*\d/i;
export function netQuantityText({ weightText, description, name } = {}) {
  const raw = weightText != null && String(weightText).trim() ? String(weightText) : null;
  const stated = quantityFromUnitPrice(raw) || (raw && !UNIT_REFERENCE_RE.test(raw) ? raw : null);
  return stated || weightFromLabelledText(description) || weightFromName(name) || null;
}

/**
 * Weight ESTIMATE for a liquid (a volume is known, no mass is): volume x kg-per-litre,
 * plus a container allowance (bottle, can, carton) that scales with the quantity. It is
 * an estimate — callers mark it (raw.weight_estimated) — and a real mass is never replaced
 * by it. The shipping carton is NOT in here: it belongs to the parcel, not to the product.
 * Policy (config.json "weightEstimate"): { enabled, kgPerLitre, containerPct }.
 */
export const DEFAULT_WEIGHT_ESTIMATE = Object.freeze({ enabled: true, kgPerLitre: 1, containerPct: 10 });
let estimatePolicy = { ...DEFAULT_WEIGHT_ESTIMATE };
export function setWeightEstimatePolicy(p) {
  const d = DEFAULT_WEIGHT_ESTIMATE; const x = p && typeof p === 'object' ? p : {};
  const kg = Number(x.kgPerLitre), pct = Number(x.containerPct);
  estimatePolicy = {
    enabled: x.enabled !== false,
    kgPerLitre: Number.isFinite(kg) && kg > 0 ? kg : d.kgPerLitre,
    containerPct: Number.isFinite(pct) && pct >= 0 && pct <= 300 ? pct : d.containerPct,
  };
}
export function estimateWeightKg(volumeL) {
  if (!estimatePolicy.enabled || !(Number(volumeL) > 0)) return null;
  return round(Number(volumeL) * estimatePolicy.kgPerLitre * (1 + estimatePolicy.containerPct / 100));
}

function toKg(val, unit) {
  switch (unit) {
    case 'kg': return round(val);
    case 'g': return round(val / 1000);
    case 'mg': return round(val / 1e6);
    default: return null; // L/cl/ml are volume, not mass
  }
}

function toL(val, unit) {
  switch (unit) {
    case 'l': return round(val);
    case 'cl': return round(val / 100);
    case 'ml': return round(val / 1000);
    default: return null;
  }
}

function round(n) { return Math.round(n * 1000) / 1000; }
