/**
 * Generic last-resort extractor for product DETAIL pages that expose NO
 * structured data (no JSON-LD / microdata / product meta / embedded JSON) yet
 * render the product in plain HTML. Pure, regex-based (no DOM dependency),
 * deliberately CONSERVATIVE and LOW-confidence:
 *
 *   • the PRICE must come from a price-attributed element (class/id/itemprop
 *     containing price/prix/prijs/preis) or a data-price attribute — never a
 *     bare number anywhere on the page (avoids shipping/loyalty/related noise);
 *   • pages that look like a LISTING (many price elements) are skipped, so a
 *     category page is not mistaken for a single product;
 *   • returns null unless a PRICE is found (never invents data).
 *
 * It only fills gaps left by the structured extractors and carries a low
 * confidence so downstream review/eligibility can treat it accordingly.
 */

import { cleanText } from './html-meta.mjs';
import { quantityFromUnitPrice } from './weight.mjs';
import { parseMoney, parseAmount } from '../shared/extract/money.mjs';

const stripTags = (s) => String(s || '').replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Labels that announce a product description block, across FR/NL/EN/ES/DE.
const DESC_LABEL = 'description|beschrijving|descripci[oó]n|produktbeschreibung|caract[eé]ristiques|kenmerken|d[eé]tails? du produit|informations? (?:sur le|du) produit|product (?:details|information|description)';

/**
 * Extract a product DESCRIPTION from the DOM/text when the structured data has
 * none (e.g. Lidl's "Productbeschrijving" spec list, Colruyt's "Description du
 * produit"). Conservative + capped; returns null when nothing meaningful is
 * found. Never invents. Used only to fill a gap left by structured extractors.
 */
export function extractDescriptionFromDom(html) {
  if (!html || typeof html !== 'string') return null;
  // 1) A heading/label that announces the description (the label may appear
  //    anywhere in the heading text, e.g. "Productbeschrijving") → the block that
  //    follows, up to the next heading (window-based, so nested tags don't break it).
  const label = new RegExp(`<(h[1-6]|summary|dt|strong|b)[^>]*>[^<]{0,80}?(?:${DESC_LABEL})[\\s\\S]*?</\\1>`, 'i');
  const m = html.match(label);
  if (m) {
    const after = html.slice(m.index + m[0].length);
    const nextH = after.search(/<h[1-6][\s>]/i);
    const block = nextH > 40 ? after.slice(0, nextH) : after.slice(0, 12000);
    const t = cleanText(block);
    if (t && t.length >= 15) return t.slice(0, 8000);
  }
  // 2) An element flagged as the product description via class/id.
  const attr = html.match(/(?:class|id)=["'][^"']*(?:product[-_]?description|description|beschrijving|descripcion)[^"']*["']/i);
  if (attr) {
    const t = cleanText(html.slice(attr.index, attr.index + 12000));
    if (t && t.length >= 15) return t.slice(0, 8000);
  }
  return null;
}

// ── Labeled DOM spec extraction (data sheets / spec tables / definition lists) ─
// Generic, platform-agnostic: PrestaShop "Fiche technique", WooCommerce
// "Additional information", generic <table>/<dl> spec blocks all expose fields as
// label→value rows. This reads those rows and maps recognised labels (FR/NL/EN/
// ES/DE) to the fields most often MISSING from structured data — EAN/GTIN,
// weight/contenance, brand, reference/SKU, category. It only maps KNOWN labels
// and validates values, so unrelated rows (size charts, shipping, reviews) are
// ignored. Used ONLY to fill gaps left by the structured extractors; never
// overrides them, never invents.
const SPEC_LABELS = [
  ['gtin', /^(ean(?:[ -]?13|[ -]?code)?|gtin(?:[ -]?\d+)?|code[ -]?(?:barres?|[ée]an)|barcode|c[oó]digo de barras|strichcode|upc)$/i],
  // The item's own mass, also when the sheet qualifies it ("Poids sans pied", "Poids du
  // produit", "Gewicht ohne Standfuß"); a load or maximum ("Poids (de chargement) maximal")
  // never matches: the qualifiers are a closed list.
  ['weightText', /^(poids(?: net| brut| sans (?:pied|support|socle|emballage)| du produit| de l'appareil| de l'article)?|weight|net weight|(?:product|item) weight|weight without stand|gewicht(?: ohne (?:standfu(?:ß|ss)|verpackung)| zonder (?:voet|standaard)| van het product)?|peso|masse|contenance|volume|litrage|capacit[eé]|inhoud|contenido|f[üu]llmenge)$/i],
  ['brand', /^(marque|brand|fabricant|manufacturer|merk|marca|hersteller)$/i],
  ['sku', /^(r[eé]f(?:[eé]rence)?|reference|sku|art(?:ikel)?[ .-]?(?:nr|nummer|no)?\.?|code produit|product code|artikelnr)$/i],
  ['mpn', /^(mpn|part ?number|r[eé]f(?:[eé]rence)? fabricant|manufacturer part(?: number)?|herstellernummer)$/i],
  ['category', /^(cat[eé]gorie|category|rayon|categor[ií]a|kategorie)$/i],
];
const labelToField = (labelRaw) => {
  const l = (cleanText(labelRaw) || '').replace(/[:：]\s*$/, '').trim();
  if (!l || l.length > 40) return null;
  for (const [field, re] of SPEC_LABELS) if (re.test(l)) return field;
  return null;
};
const SPEC_VALID = {
  weightText: (v) => /\d/.test(v) && /(kg|g|mg|l|cl|ml|litre|gramme|pi[eè]ce|stuk|unit)/i.test(v),
  brand: (v) => v.length >= 1 && v.length <= 80 && !/^\d+$/.test(v),
  sku: (v) => v.length >= 1 && v.length <= 80,
  mpn: (v) => v.length >= 1 && v.length <= 80,
  category: (v) => v.length >= 1 && v.length <= 120,
};

/**
 * @param {string} html
 * @returns {{ gtin?:string, weightText?:string, brand?:string, sku?:string, mpn?:string, category?:string }}
 */
/**
 * The known fields of a list of spec pairs read elsewhere (embedded state, JSON-LD
 * additionalProperty): same labels, same validation as the DOM rows below.
 * @param {Array<{name:string, value:string}>} pairs
 */
export function fieldsFromSpecPairs(pairs) {
  const out = {};
  for (const p of pairs || []) considerSpec(out, p && p.name, p && p.value);
  return out;
}
function considerSpec(out, labelRaw, valueRaw) {
  const field = labelToField(labelRaw);
  if (!field || out[field] != null) return;
  const v = cleanText(valueRaw);
  if (!v) return;
  if (field === 'gtin') { const d = v.replace(/\D/g, ''); if (d.length >= 8 && d.length <= 14) out.gtin = d; return; }
  if (SPEC_VALID[field](v)) out[field] = v;
}

export function extractSpecsFromDom(html) {
  if (!html || typeof html !== 'string') return {};
  const out = {};
  const consider = (labelRaw, valueRaw) => {
    const field = labelToField(labelRaw);
    if (!field || out[field] != null) return;
    const v = cleanText(valueRaw);
    if (!v) return;
    if (field === 'gtin') { const d = v.replace(/\D/g, ''); if (d.length >= 8 && d.length <= 14) out.gtin = d; return; }
    if (SPEC_VALID[field](v)) out[field] = v;
  };
  // Two-column table rows: <tr><t[hd]>LABEL</t[hd]><t[hd]>VALUE</t[hd]>…
  let m; let n = 0;
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  while ((m = rowRe.exec(html)) && n < 600) {
    n++;
    const cells = [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)];
    if (cells.length >= 2) consider(cells[0][1], cells[1][1]);
  }
  // Definition lists: <dt>LABEL</dt><dd>VALUE</dd>
  const dlRe = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
  n = 0;
  while ((m = dlRe.exec(html)) && n < 600) { n++; consider(m[1], m[2]); }
  return out;
}

/**
 * Net quantity read from a UNIT-PRICE reference, e.g. "150 g - 11,93 €/kg" or
 * "1,5 kg — 2,66 EUR / kg". The trailing "<price> <currency>/<unit>" anchor is
 * what makes this safe and generic: it never matches a nutrition table (those
 * carry no reference price), so grocery pages (Lidl, Colruyt, Delhaize…) yield
 * the pack size without inventing one. Returns the quantity text, or null.
 */
export function weightFromUnitPrice(html) {
  return quantityFromUnitPrice(html);
}

// parseMoney is the shared, currency-broad, locale-aware parser; re-exported so the
// core modules that import it from here keep working.
export { parseMoney };

function firstH1(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const t = m ? stripTags(m[1]) : null;
  return t && t.length >= 2 && t.length <= 300 ? t : null;
}

const PRICEY_ATTR = /(?:class|id|itemprop)=["'][^"']*(?:price|prix|prijs|preis)[^"']*["']/gi;

/**
 * @param {string} html
 * @returns {{ name:string|null, price:number, currency:string|null, strategy:string, confidence:number } | null}
 */
export function extractFromDom(html) {
  if (!html || typeof html !== 'string') return null;

  // 1) data-price attribute — the most reliable plain-HTML price signal.
  let money = null;
  const dp = html.match(/\bdata-(?:product-)?price(?:-amount)?\s*=\s*["']?([\d.,]+)/i);
  if (dp) {
    const p = parseAmount(dp[1]);
    if (p != null && p > 0 && p < 1e6) {
      const curAttr = html.match(/\bdata-(?:product-)?currency\s*=\s*["']?([A-Za-z]{3})/i);
      money = { price: p, currency: curAttr ? curAttr[1].toUpperCase() : null };
    }
  }

  // 2) price-attributed elements. Bail if there are many (looks like a listing).
  if (!money) {
    const idxs = [];
    let m;
    PRICEY_ATTR.lastIndex = 0;
    while ((m = PRICEY_ATTR.exec(html)) && idxs.length <= 30) idxs.push(m.index);
    if (idxs.length > 8) return null; // many price cells → listing, not a detail page
    for (const idx of idxs) {
      const found = parseMoney(stripTags(html.slice(idx, idx + 400)));
      if (found) { money = found; break; }
    }
  }

  if (!money) return null;
  return { name: firstH1(html), price: money.price, currency: money.currency, strategy: 'generic-dom', confidence: 0.35 };
}
