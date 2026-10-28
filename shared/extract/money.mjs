/**
 * Money parsing — the SINGLE source of truth for turning a price string into a
 * { price, currency } pair, shared by every extractor (embedded-state, dom-grid,
 * product-shape, the core DOM fallback). Locale- and currency-broad on purpose:
 * the software's users are NOT only French/euro, so it recognises the major world
 * currencies and both decimal conventions.
 *
 * PORTABLE: zero Node built-ins, zero dependencies.
 */

/**
 * Parse a numeric amount from a messy string, locale-aware.
 *  - both `.` and `,` present → the LAST one is the decimal separator
 *    ("1.299,00" → 1299, "1,299.00" → 1299);
 *  - only `,`  → comma is the decimal ("0,748" → 0.748, "99,95" → 99.95) — this keeps
 *    European 3-decimal prices (e.g. Colruyt "0,748 €/pce") correct;
 *  - only `.`  → a `.` before three digits at a word boundary is a thousands
 *    separator ("1.299" → 1299), otherwise the decimal ("19.99" → 19.99);
 *  - spaces are thousands separators.
 * @returns {number|null}
 */
export function parseAmount(v) {
  let c = String(v == null ? '' : v).replace(/[^\d.,]/g, '');
  if (!c) return null;
  const lc = c.lastIndexOf(','), ld = c.lastIndexOf('.');
  if (lc > -1 && ld > -1) {
    c = lc > ld ? c.replace(/\./g, '').replace(',', '.') : c.replace(/,/g, '');
  } else {
    c = c.replace(/[ ](?=\d{3}\b)/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
  }
  const n = parseFloat(c);
  return Number.isFinite(n) ? n : null;
}

// Symbol → ISO code (unambiguous symbols only; ambiguous ones like `kr` and `¥`
// still detect the AMOUNT but leave the currency null/approximate).
export const CUR_SYMBOL = {
  '€': 'EUR', $: 'USD', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₽': 'RUB', '₺': 'TRY',
  '₩': 'KRW', '฿': 'THB', '₫': 'VND', '₪': 'ILS', '₴': 'UAH', '₦': 'NGN', '₱': 'PHP',
  'zł': 'PLN', 'Kč': 'CZK', 'Ft': 'HUF', 'R$': 'BRL', Rp: 'IDR', RM: 'MYR',
};
// Currency alternation for the money regex. Multi-char tokens FIRST so "R$"/"zł" win
// over "$"/single chars. `kr` is kept (Nordic) though it maps to no single ISO code.
export const CUR = 'R\\$|zł|Kč|Ft|Rp|RM|kr|€|\\$|£|¥|₹|₽|₺|₩|฿|₫|₪|₴|₦|₱|CHF|EUR|USD|GBP|CAD|AUD|NZD|JPY|CNY|INR|RUB|TRY|KRW|THB|VND|ILS|UAH|NGN|PHP|PLN|CZK|HUF|SEK|NOK|DKK|BRL|MYR|IDR|ZAR|MXN|AED|SAR|SGD|HKD|RON|BGN';
const AMT = '\\d{1,3}(?:[ .,]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?';
export const MONEY_RE = new RegExp(`(${CUR})\\s*(${AMT})|(${AMT})\\s*(${CUR})`, 'i');

/** First currency+amount in a text → { price, currency } | null. */
export function parseMoney(text) {
  const m = String(text || '').match(MONEY_RE);
  if (!m) return null;
  const curRaw = (m[1] || m[4] || '');
  const price = parseAmount(m[2] || m[3]);
  if (price == null || price <= 0 || price >= 1e9) return null;
  const up = curRaw.toUpperCase();
  const currency = CUR_SYMBOL[curRaw] || CUR_SYMBOL[up] || (/^[A-Z]{3}$/.test(up) ? up : null);
  return { price, currency };
}

// Words that name the BASIS of a price on a listing card: a total for the stay, a price
// per night / month / person / hour… Multilingual and generic — a form of data, never a
// site rule. A trailing tax word ("TTC") or a CTA is NOT a basis.
const BASIS_WORD_RE = /\b(total|totaal|gesamt|nuit|nuits|night|nights|nacht|nächte|nachten|noche|noches|notte|notti|mois|month|months|monat|monate|maand|mes|meses|mese|semaine|semaines|week|weeks|woche|wochen|semana|semanas|settimana|jour|jours|day|days|tag|tage|dag|dagen|dia|dias|giorno|giorni|pers|personne|personnes|person|persons|people|persona|personas|heure|heures|hour|hours|stunde|stunden|uur|hora|horas|ora|ore|séjour|sejour|stay|verblijf|aufenthalt|estancia|soggiorno)\b/i;

/**
 * The basis stated right after a price on a listing card: "116 € au total" → "au total",
 * "45 € par nuit" → "par nuit", "€45/night" → "/night". Null when the text ends at the
 * amount, when a second amount follows, or when what follows names no basis.
 * @returns {string|null}
 */
export function moneyQualifier(text) {
  const s = String(text || '');
  const m = s.match(MONEY_RE);
  if (!m) return null;
  const after = s.slice(m.index + m[0].length).replace(/^[\s,;:·•–-]+/, '').replace(/[\s.,;:]+$/, '');
  if (!after || after.length > 40 || MONEY_RE.test(after)) return null;
  return BASIS_WORD_RE.test(after) ? after : null;
}

// A price shown "per unit of measure" — €/kg, €/l, /pce, par litre, per stuk… The
// SELLING price of a product is never its per-unit price, so a reader must keep them
// apart. Generic + multilingual (a unit word after a slash or a "par/per/au/voor"),
// a form of data, never a site rule.
export const PER_UNIT_RE = /(?:\/|\bpar\b|\bper\b|\bau\b|\bvoor\b|\bpro\b)\s*\.?\s*(?:pi[eè]ces?|pce|pcs|stuks?|st|unit[eé]?s?|units?|each|ea|kg|kilos?|g|gr|grammes?|l|lt|litres?|liter|cl|ml|m[2²]?|m[eè]tres?|meter|portions?|lavages?|wash|doses?|capsules?|tablettes?)\b/i;

/**
 * Split a price string into its SELLING price and any PER-UNIT price it also shows.
 * "10,99 € /pce" → { main:"10,99 € ", unit:"/pce" } (the unit carries no amount of its
 * own). "0,75 € 1,50 €/l" → { main:"0,75 € ", unit:"1,50 €/l" }. Generic: the selling
 * price is the FIRST amount not glued to a per-unit word.
 * @returns {{ main:string, unit:string|null }}
 */
// A per-unit marker that IMMEDIATELY follows an amount (a glued "€/l", " /pce",
// " par litre") — anchored, so a LATER price's unit does not mask this one.
const PER_UNIT_HEAD = new RegExp(`^\\s*(?:€|\\$|£)?\\s*(?:${PER_UNIT_RE.source})`, 'i');
export function splitUnitPrice(text) {
  const s = String(text == null ? '' : text);
  const re = new RegExp(MONEY_RE.source, 'gi');
  let m; let sale = null;
  while ((m = re.exec(s))) {
    const after = s.slice(m.index + m[0].length);
    if (PER_UNIT_HEAD.test(after)) continue; // this amount is glued to a unit word → per-unit, not the sale
    sale = { end: m.index + m[0].length }; break;
  }
  if (!sale) return { main: s, unit: null };
  const main = s.slice(0, sale.end);
  const rest = s.slice(sale.end).trim();
  return { main, unit: rest && (PER_UNIT_RE.test(rest) || MONEY_RE.test(rest)) ? rest : null };
}

/**
 * Join an integer part and a cents fragment set apart in the markup (a superscript,
 * a small span) into a decimal: 10 + "99" → 10.99, 0 + "956" → 0.956 (three
 * decimals), 29 + "20" → 29.20. The cents length decides the divisor (2 → /100,
 * 3 → /1000), so three-decimal unit prices stay correct.
 * @returns {number|null}
 */
export function joinCents(intPart, cents) {
  const whole = parseAmount(String(intPart));
  const c = String(cents == null ? '' : cents).replace(/\D/g, '');
  if (whole == null || !c || c.length > 3) return whole;
  const n = whole + Number(c) / 10 ** c.length;
  return Number.isFinite(n) ? n : whole;
}

/**
 * The amount in a text the user DESIGNATED as a price (a field read from one element
 * of a product card): the element is known to hold a price, so a figure without a
 * currency is accepted ("649,99", "399,-"), cents written right after the currency
 * sign ("29€20", from "29€<sup>20</sup>") are kept, up to THREE decimals are read
 * ("0,956 €/pce"), and a per-unit price shown alongside ("… €/l") is never taken for
 * the selling price.
 * @returns {{price:number, currency:string|null}|null}
 */
const AMOUNT_RE = '\\d{1,3}(?:[ .\\u00a0\\u202f]\\d{3})+(?:[.,]\\d{1,3})?|\\d+(?:[.,]\\d{1,3})?';
const oneLineLen = (s) => String(s).replace(/\s+/g, ' ').trim().length;
export function designatedPrice(text) {
  const raw = String(text == null ? '' : text).replace(/(\d)\s*(€|\$|£)\s*(\d{2,3})(?!\d)/, '$1,$3 $2');
  const { main } = splitUnitPrice(raw);
  const v = main || raw;
  const cm = v.match(new RegExp(`(?:${CUR})`, 'i'));
  const curRaw = cm ? cm[0] : null;
  const currency = curRaw ? (CUR_SYMBOL[curRaw] || CUR_SYMBOL[curRaw.toUpperCase()] || (/^[A-Z]{3}$/.test(curRaw.toUpperCase()) ? curRaw.toUpperCase() : null)) : null;
  // A block holding other figures besides the price (an order form: « Mars Hydro 2026 – FC-4800 … 409.99 EUR », an
  // option « 100×100×180cm »): the price is the amount written WITH its currency; with none, a long text gives no
  // price at all (marshydro 28/10: the form's first figure, « 2026 », « 1500 », « 15 », « 100 », was read as the price).
  const figures = v.match(new RegExp(AMOUNT_RE, 'g')) || [];
  if (figures.length > 1) {
    const wc = v.match(new RegExp(`(?:${CUR})\\s*(${AMOUNT_RE})|(${AMOUNT_RE})\\s*(?:${CUR})`));
    const n = wc ? parseAmount(wc[1] || wc[2]) : null;
    if (n != null && n > 0 && n < 1e9) return { price: n, currency };
    if (oneLineLen(v) > 24) return null;
  }
  // First number, with up to THREE decimals (a designated price is known to be one).
  const nm = v.match(/\d{1,3}(?:[ .]\d{3})+(?:[.,]\d{1,3})?|\d+(?:[.,]\d{1,3})?/);
  if (nm) { const n = parseAmount(nm[0]); if (n != null && n > 0 && n < 1e9) return { price: n, currency }; }
  const m = parseMoney(v);
  if (m && m.price != null) return m;
  const n = parseAmount(v);
  return n != null && n > 0 && n < 1e9 ? { price: n, currency } : null;
}
