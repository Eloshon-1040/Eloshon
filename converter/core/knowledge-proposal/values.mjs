// Phase 2 Lot 3 — the scalar value fixers shared by the engine's bespoke CSV
// parsers (core/src/csv.ts, normalize.ts re-export them unchanged) and the
// generic knowledge transforms (clean_text, consent_bool). ONE implementation:
// a format moved from a bespoke parser to the generic parser reads every cell
// exactly as before, by construction.
//
// Invisible characters are built from their code points on purpose: a literal
// non-breaking space or control character in source is too easy to lose.
const NBSP = String.fromCharCode(0xa0);
const CR = String.fromCharCode(13), LF = String.fromCharCode(10), TAB = String.fromCharCode(9);

// ── Lists of URLs ────────────────────────────────────────────────────────────
// The same rule as the Scraper's image contract (shared/extract/images.mjs,
// kept in step by converter/test/scraper-roundtrip-images.test.mjs): a cell
// holding several URLs is split only before a new URL (scheme or "//"), on a
// newline, or on ";" / "|" / ", " between two paths — never on a bare comma,
// which is part of a CDN path ("c_lpad,w_iw,h_ih"). With `sep` (a format's
// declared separator) that separator splits only when the next part starts a
// URL or a path.
const URL_START = /(?:https?:\/\/|\/\/[^/\s])/i;
const SCHEME_SPLIT = /(?:^|[\s,;|]+)(?=(?:https?:\/\/|\/\/[^/\s]))/i;
const PATH_SPLIT = /\s*[;|]\s*(?=\/|\.\/)|,\s+(?=\/|\.\/)/;
export function splitUrlList(value, sep = null) {
  if (Array.isArray(value)) return value.flatMap((v) => splitUrlList(v, sep));
  const s = String(value == null ? '' : value).trim();
  if (!s) return [];
  const out = [];
  const push = (p) => { const t = String(p).trim().replace(/^[\s,;|]+|[\s,;|]+$/g, ''); if (t) out.push(t); };
  for (const line of s.split(/\r?\n/)) {
    for (const part of line.split(SCHEME_SPLIT)) {
      if (!part.trim()) continue;
      const pieces = PATH_SPLIT.test(part) ? part.split(PATH_SPLIT) : [part];
      for (const piece of pieces) {
        if (sep && sep !== ',' && sep !== '\n') {
          const esc = sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`\\s*${esc}\\s*(?=\\/|\\.\\/|${URL_START.source})`, 'i');
          for (const q of piece.split(re)) push(q);
        } else push(piece);
      }
    }
  }
  return out;
}
// Is this a plausible image/file address (absolute, protocol-relative, or a path)? A piece of a URL
// ("w_iw", "f_auto") is not, and is never written to a target.
export function looksLikeUrl(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return false;
  if (/^(https?:)?\/\//i.test(t)) return true;
  if (/^\.?\//.test(t)) return true;
  return /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(t) || /\.(jpe?g|png|webp|gif|avif|svg|bmp)(\?|#|$)/i.test(t);
}
// A URL written inside a list whose separator is `sep`: the separator inside the
// URL is percent-encoded so the target's importer never splits the address
// (WooCommerce "," → "%2C", Wix ";" → "%3B"). The browser reads it back as the
// same address.
export function encodeUrlForList(url, sep) {
  const s = String(url == null ? '' : url);
  if (!sep) return s;
  const code = '%' + sep.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
  return s.split(sep).join(code);
}

// ── Smart-punctuation repair ─────────────────────────────────────────────────
const SMART_MAP = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"',
  '–': '-', '—': '-', '…': '...', [NBSP]: ' ',
};
const SMART_RE = new RegExp('[' + Object.keys(SMART_MAP).join('') + ']', 'g');
export function fixSmartPunctuation(s) {
  return s.replace(SMART_RE, (c) => SMART_MAP[c] ?? c);
}

// Trim outer whitespace and collapse embedded newlines/tabs a value should not
// contain. HTML body fields keep their newlines (handled by the caller opting
// out); everything routed through here is a plain scalar cell.
const BREAKS_RE = new RegExp('[' + CR + LF + TAB + ']+', 'g');
export function cleanScalar(v) {
  return fixSmartPunctuation(v)
    .replace(BREAKS_RE, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// Shopify exports long numbers / phones with a leading apostrophe so Excel keeps
// them as text ("'+16135550127", "'10276014030941"). Strip that guard on the way
// in; it is never part of the value.
export function stripExcelGuard(v) {
  if (v == null) return '';
  return v.startsWith("'") ? v.slice(1) : v;
}

// ── US state name ↔ code (Woo customers spell it out; Shopify wants the code).
// Codes pass through unchanged; non-US regions pass through (no reliable table).
const US_STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
};
const US_CODE_TO_NAME = Object.fromEntries(
  Object.entries(US_STATES).map(([name, code]) => [code, name.replace(/\b\w/g, (c) => c.toUpperCase())]),
);

export function stateToCode(state, country) {
  const s = state.trim();
  if (!s) return '';
  if (/^[A-Z]{2}$/.test(s)) return s; // already a code
  if (country.toUpperCase() === 'US' || country.toUpperCase() === 'USA') {
    return US_STATES[s.toLowerCase()] ?? s;
  }
  return s; // other countries: pass through (Shopify accepts full names outside the US)
}

export function stateToName(state, country) {
  const s = state.trim();
  if ((country.toUpperCase() === 'US' || country.toUpperCase() === 'USA') && /^[A-Z]{2}$/.test(s)) {
    return US_CODE_TO_NAME[s] ?? s;
  }
  return s;
}

// Consent literals: Shopify uses exactly "yes"/"no" (not true/1). Read either
// side tolerantly; write the literal Shopify demands.
export function parseConsent(v) {
  if (v == null) return null;
  const s = v.trim().toLowerCase();
  if (['yes', 'true', '1', 'subscribed'].includes(s)) return true;
  if (['no', 'false', '0', 'unsubscribed', 'not subscribed'].includes(s)) return false;
  return null;
}

/** Separator-blind form of a column name: case, accents, camelCase, "_", "-", spaces and
 *  punctuation all fold to single spaces — "Prix HT", "prix_ht" and "PRIX-HT" are one name. */
export function columnKey(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ── Numbers ──────────────────────────────────────────────────────────────────
// A cell can hold more than a number ("12,99 € / 500 g", "12.99 EUR (TVA 21%)",
// "12,50€ 15,00€", "1 234,50"). The amount is the FIRST numeric token; the rest
// (currency, unit, tax rate, a second price) is never glued onto it — gluing
// "12.99" and "21" into 12.9921 was the old behaviour.
const NUM_TOKEN = /-?\d{1,3}(?:[   ']\d{3})+(?:[.,]\d+)?|-?\d+(?:[.,]\d+)*|[.,]\d+/g;

export function numericTokens(s) {
  return String(s).match(NUM_TOKEN) || [];
}

/**
 * One token → number. `decimal` (',' or '.') is the separator the COLUMN uses,
 * decided on all its values (see decimalSeparatorOf); without it a lone separator
 * followed by 3 digits ("1,234") stays a decimal, as it always was.
 */
export function parseNumberToken(tok, decimal) {
  let t = tok.replace(/[   ']/g, '');
  const dots = (t.match(/\./g) || []).length;
  const commas = (t.match(/,/g) || []).length;
  if (dots && commas) {
    t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (dots > 1) t = t.replace(/\./g, '');
  else if (commas > 1) t = t.replace(/,/g, '');
  else if (dots || commas) {
    const sep = dots ? '.' : ',';
    const after = t.length - t.indexOf(sep) - 1;
    const lead = t.slice(0, t.indexOf(sep)).replace('-', '');
    if (decimal && sep !== decimal && after === 3 && lead !== '0' && lead !== '') t = t.replace(sep, ''); // thousands
    else t = t.replace(sep, '.');
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * The decimal separator a column uses, from ALL its values: ',' or '.' when the
 * evidence points one way, null when it is mixed or only ambiguous forms such as
 * "1,234" exist. `ambiguous` counts the values that settle nothing.
 */
export function decimalSeparatorOf(values) {
  let comma = 0, dot = 0, ambiguous = 0;
  for (const v of values) {
    const tok = numericTokens(v)[0];
    if (!tok) continue;
    const t = tok.replace(/[   ']/g, '');
    const dots = (t.match(/\./g) || []).length;
    const commas = (t.match(/,/g) || []).length;
    if (dots && commas) { if (t.lastIndexOf(',') > t.lastIndexOf('.')) comma++; else dot++; continue; }
    if (dots > 1) { comma++; continue; }
    if (commas > 1) { dot++; continue; }
    const sep = dots ? '.' : commas ? ',' : '';
    if (!sep) continue;
    const after = t.length - t.indexOf(sep) - 1;
    if (after === 3 && t.slice(0, t.indexOf(sep)).replace('-', '') !== '0') { ambiguous++; continue; }
    if (sep === ',') comma++; else dot++;
  }
  const decimal = comma && !dot ? ',' : dot && !comma ? '.' : null;
  return { decimal, ambiguous };
}
