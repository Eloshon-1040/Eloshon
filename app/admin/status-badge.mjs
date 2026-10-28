/**
 * Pure provider-status badge logic (shared by the renderer panel + tests). Given
 * a provider's masked state, its switch row and the kill switch, returns the
 * badge { t (label), c (css class) }. Kept pure so the save→status path is unit-
 * testable without a DOM.
 */
export function providerBadge(mask, sw, kill) {
  if (kill) return { t: 'désactivé (interrupteur général)', c: 'err' };
  if (sw && sw.enabled === false) return { t: 'désactivé', c: 'err' };
  if (mask && mask.incomplete) return { t: 'incomplet', c: 'warn' };
  if (!mask || !mask.configured) return { t: 'non configuré', c: 'warn' };
  return { t: 'actif', c: 'ok' };
}
