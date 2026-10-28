/**
 * Reading a product page that LABELS its blocks, with no learned rule: "Description" and
 * "Caractéristiques techniques" as a tab, an accordion trigger or a heading. Generic fallback
 * for the product-page extractor when structured data holds no (or only a snippet of the)
 * description / specifications. Multilingual labels, no site rule.
 */
import { labelledBlocks } from './dom-locate.mjs';
import { readBlockText, readSpecPairs } from './readers.mjs';

// Compared on the normalised label (lower case, no accents or punctuation).
export const DESCRIPTION_LABEL = /^(description|description (du )?produit|description (de l )?article|descriptif|descriptif produit|product description|description of the product|about this item|about this product|product details|details? (du )?produit|presentation|presentation du produit|produktbeschreibung|beschreibung|artikelbeschreibung|productbeschrijving|beschrijving|omschrijving|descripcion|descripcion del producto|descrizione|descrizione prodotto)$/;
export const SPECS_LABEL = /^(caracteristiques?|caracteristiques? techniques?|fiche technique|donnees techniques|specifications?|specifications? techniques?|technical (specifications?|details|data|information)|specs|tech specs|technische (daten|gegevens|specificaties|eigenschaften)|kenmerken|eigenschappen|productspecificaties|ficha tecnica|caracteristicas|caracteristicas tecnicas|scheda tecnica|dati tecnici)$/;

/** The longest readable text among the blocks labelled as a description, or null. */
export function descriptionFromLabelledBlock(doc, { name = '' } = {}) {
  let best = '';
  for (const b of labelledBlocks(doc, DESCRIPTION_LABEL)) {
    if (b.querySelector && b.querySelector('table')) continue; // a spec table is not the description
    const t = readBlockText(b, { dropLabel: null });
    if (t.length > best.length && t.length >= 40 && t.toLowerCase() !== String(name).toLowerCase()) best = t;
  }
  return best || null;
}

/** The pairs of the first labelled block that reads as ≥ 2 label → value pairs, or []. */
export function specsFromLabelledBlock(doc) {
  for (const b of labelledBlocks(doc, SPECS_LABEL)) {
    const pairs = readSpecPairs(b);
    if (pairs.length >= 2) return pairs;
  }
  return [];
}
