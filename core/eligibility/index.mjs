/**
 * Generic, REPLACEABLE eligibility layer — Eloshon Scraper core.
 *
 * The engine calls `evaluateEligibility(product)` for every normalized product
 * and never decides on its own. This default policy is business-AGNOSTIC — it
 * knows nothing about food, cold chain, alcohol or any vertical. To specialise
 * (e.g. a supermarket "shelf-stable" profile), swap this module or add a
 * profile registry; the engine contract stays the same.
 *
 * V1 policy:
 *   • valid product              → 'accepted'
 *   • insufficient / ambiguous   → 'to_verify'   (name or price missing)
 *   • manifestly invalid / tech  → 'excluded'    (no name AND no identity)
 *
 * Return shape matches what the engine + UI expect (status/code/reason +
 * informational flags that never affect status here).
 */

function result(status, code, reason) {
  return { status, code, reason, matched: [], is_alcoholic: false, requires_cold_chain: null };
}

/** @param {{name?:string,price?:number|null,source_product_id?:string|null,barcode?:string|null,source_url?:string|null}} p */
export function evaluateEligibility(p) {
  const name = String((p && p.name) || '').trim();
  const hasName = name.length >= 2;
  const hasIdentity = !!(p && (p.source_product_id || p.barcode || p.source_url));
  const hasPrice = p && p.price != null && !Number.isNaN(Number(p.price));

  // Manifestly invalid: nothing to identify the row by → not a usable product.
  if (!hasName && !hasIdentity) {
    return result('excluded', 'excluded_invalid', 'données manifestement invalides (ni nom ni identifiant)');
  }
  // Ambiguous / insufficient: identifiable, but missing a usable name or price.
  if (!hasName || !hasPrice) {
    return result('to_verify', 'to_verify_incomplete', 'données incomplètes (nom ou prix manquant)');
  }
  return result('accepted', 'accepted_default', 'produit valide');
}

// Aliases so the engine can bind to a generic name.
export const isEligibleProduct = evaluateEligibility;
export default evaluateEligibility;
