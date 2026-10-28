/**
 * SKU — ONE rule for the app, the extension, the taught rules and (mirrored) the Converter:
 *
 *   A SKU is an identifier the SOURCE declares (JSON-LD `sku`, a code attribute of the page, an article
 *   code, a per-variant SKU). Nothing else is ever written as a SKU: when the source declares none, the
 *   SKU stays EMPTY. A product's REFERENCE (an article code read from the URL or from a colourway's
 *   `productId`, e.g. « IF6490 ») is not a SKU: it travels in its own field and the user decides to use it.
 *
 * Guard by value profile: a value that reads as a label — it holds « : » or « / », it is a phrase, it repeats
 * an option / colour / product name, it is too long, it has no letter or digit — is never a SKU. It is removed
 * and reported with its reason (product, value, reason), never kept silently and never "repaired".
 *
 * PORTABLE: zero DOM, zero Node built-ins. Mirrored in converter/core/knowledge-proposal/sku.mjs
 * (same cases checked by both test suites).
 */

export const SKU_MAX_LENGTH = 64;

/** Reasons a value is not a SKU (the report shows `SKU_REASON_TEXT`). */
export const SKU_REASON_TEXT = {
  empty: 'vide',
  label: 'libellé (contient « : » ou « / »)',
  phrase: 'phrase, pas un identifiant',
  option_name: 'reprend un nom d’option, de couleur ou de produit',
  too_long: `trop long (plus de ${SKU_MAX_LENGTH} caractères)`,
  no_identifier: 'ni lettre ni chiffre',
};

const fold = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Is `value` a SKU? `names` = the texts it must not repeat (option names, colour, product name).
 * @param {unknown} value  @param {{names?: unknown[]}} [ctx]
 * @returns {{ok:true, value:string} | {ok:false, reason:keyof SKU_REASON_TEXT}}
 */
export function skuVerdict(value, { names = [] } = {}) {
  const v = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!v) return { ok: false, reason: 'empty' };
  if (v.length > SKU_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  if (/[:/]/.test(v)) return { ok: false, reason: 'label' };
  if (!/[\p{L}\p{N}]/u.test(v)) return { ok: false, reason: 'no_identifier' };
  const f = fold(v);
  if (f && names.some((n) => n != null && fold(n) === f)) return { ok: false, reason: 'option_name' };
  // A phrase: three words or more, or two words of letters only (« Core Black », « Bleu nuit »). A code with a
  // space keeps a digit in a word (« AB 1234 », « 42 EU »).
  const words = v.split(' ');
  if (words.length >= 3 && words.filter((w) => !/\d/.test(w)).length >= 2) return { ok: false, reason: 'phrase' };
  if (words.length === 2 && words.every((w) => /^\p{L}{2,}$/u.test(w))) return { ok: false, reason: 'phrase' };
  return { ok: true, value: v };
}

/** The value when it is a SKU, else null. */
export const cleanSku = (value, ctx) => { const r = skuVerdict(value, ctx); return r.ok ? r.value : null; };

// ── Options read from the page ─────────────────────────────────────────────────────────────────────
// A swatch or a button often says its option in its label: « Couleur du produit : Aurora Coffee », « Size: 42 ».
const COLOUR = /\b(couleurs?|coloris|teintes?|colou?rs?|kleur(en)?|farben?|colores?|colori|cores?)\b/i;
const SIZE = /\b(tailles?|pointures?|sizes?|maat|maten|gr(o|ö|oe)(ss|ß)en?|tallas?|taglie|taglia|tamanhos?)\b/i;

/** The variant type (contract: 'couleur' | 'taille' | 'autre') a label of options names. */
export function optionTypeOf(label) {
  const s = String(label || '');
  if (COLOUR.test(s)) return 'couleur';
  if (SIZE.test(s)) return 'taille';
  return 'autre';
}

/**
 * Entries that all start with the same « Label : » (≥ 2 entries): the label is the option's, not the value's.
 * @param {string[]} names
 * @returns {{label:string|null, names:string[]}}
 */
export function splitSharedLabel(names) {
  const list = (names || []).map((n) => String(n || ''));
  if (list.length < 2) return { label: null, names: list };
  const parts = list.map((n) => n.match(/^\s*([^:]{1,40}?)\s*:\s*(\S.*)$/));
  if (parts.some((m) => !m)) return { label: null, names: list };
  const label = parts[0][1];
  if (parts.some((m) => fold(m[1]) !== fold(label))) return { label: null, names: list };
  return { label: label.trim(), names: parts.map((m) => m[2].trim()) };
}
