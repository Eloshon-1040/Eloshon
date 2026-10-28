/**
 * The « Variantes » cell the Eloshon extension and app write in a CSV, read back as variant objects:
 *   "30 ML : 77.7 | 50 ML : 115.5 (épuisé)"  → [{ type:'Contenance', name:'30 ML', price:'77.7' }, { …, availability:'OutOfStock' }]
 *   "S, M, L"                                 → [{ type:'Taille', name:'S' }, …] (names only: the product price applies)
 * Each object is a child of the product (structure.variants.parseText); the option axis is named from what the
 * values are (a volume or weight → Contenance, a garment size → Taille), never left as the word « option ».
 */

const SOLD_OUT = /\s*\((épuisé|epuise|rupture|sold ?out|out of stock|uitverkocht|ausverkauft|agotado)\)\s*$/i;
const VOLUME = /^\d+([.,]\d+)?\s*(ml|cl|dl|l|g|kg|mg|oz|fl\.? ?oz|gr)\b/i;
const SIZE = /^(xxs|xs|s|m|l|xl|xxl|xxxl|[2-5]xl|\d{2}([.,]5)?|\d{1,2}\s*\/\s*\d{1,2}|w\d{2}(\s*l\d{2})?|taille unique|one size|tu)$/i;
const MONEY = /^-?\d{1,3}([ . ]\d{3})*([.,]\d{1,2})?$|^-?\d+([.,]\d{1,2})?$/;

/** The option axis of a list of values, in French (the panel's language): Contenance, Taille, or Variante. */
export function axisNameFor(names, { generic = 'Variante' } = {}) {
  const vals = (names || []).map((n) => String(n || '').trim()).filter(Boolean);
  if (!vals.length) return generic;
  if (vals.every((v) => VOLUME.test(v))) return 'Contenance';
  if (vals.every((v) => SIZE.test(v))) return 'Taille';
  return generic;
}

/** A generic axis name a source wrote (« option », « variant »…): to be named from the values. */
export const isGenericAxis = (name) => !name || /^(options?|variants?|variantes?|type|value|valeur|choix)$/i.test(String(name).trim());

/**
 * @param {string} text
 * @param {{ itemSep?:string, kvSep?:string }} [opts]
 * @returns {Array<{type:string, name:string, price?:string, availability?:string}>}
 */
export function parseVariantText(text, { itemSep = '|', kvSep = ':' } = {}) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s || /^[[{]/.test(s)) return []; // JSON is read by parseJson, not here
  let items = s.split(itemSep).map((x) => x.trim()).filter(Boolean);
  // A list of names written « S, M, L » (no price): split on commas only when no item holds a price.
  if (items.length === 1 && !items[0].includes(kvSep) && /,\s/.test(items[0])) items = items[0].split(/,\s+/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const raw of items) {
    let it = raw; let availability;
    if (SOLD_OUT.test(it)) { availability = 'OutOfStock'; it = it.replace(SOLD_OUT, '').trim(); }
    const at = it.lastIndexOf(kvSep);
    let name = it; let price;
    if (at > 0) {
      const tail = it.slice(at + kvSep.length).trim().replace(/\s*(€|eur|usd|\$|£|chf)\s*$/i, '').replace(/^(€|\$|£)\s*/, '');
      if (MONEY.test(tail)) { name = it.slice(0, at).trim(); price = tail; }
    }
    if (!name) continue;
    out.push({ name, ...(price !== undefined ? { price } : {}), ...(availability ? { availability } : {}) });
  }
  const type = axisNameFor(out.map((o) => o.name));
  return out.map((o) => ({ type, ...o }));
}
