/**
 * Crédits ↔ euros, côté app Scraper.
 *
 * RÈGLE : un crédit ne vaut que ce que dit le palier qui l'a vendu. Le taux est
 * TOUJOURS `prix ÷ crédits` du palier réellement actif sur le compte — jamais
 * une constante partagée, jamais un taux « moyen ». Si le palier n'est pas
 * connu, ou s'il est gratuit, il n'y a pas de taux : on affiche le nombre de
 * crédits seul plutôt qu'un équivalent inventé.
 *
 * Le palier vient de `account_status` (edge function firecrawl-unlock), qui
 * renvoie aujourd'hui `plan` seul. Tant que la réponse ne porte pas le prix et
 * le volume du palier, `rateFromAccount` renvoie null et l'UI se contente des
 * crédits — voir le rapport de chantier.
 */

/** Nombre fini, ou null. `Number(null)` vaut 0 et non NaN : sans ce garde,
 *  un prix absent produirait un taux de 0 €/crédit — donc « gratuit » affiché
 *  sur un palier payant. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** € par crédit pour un palier, ou null si la question n'a pas de réponse. */
export function creditRate(tier) {
  if (!tier) return null;
  if (tier.is_free || tier.tier === 'free' || tier.plan === 'free') return null;
  const price = num(tier.price_eur);
  const credits = num(tier.credits);
  if (price === null || credits === null || credits <= 0) return null;
  return price / credits;
}

/** Le taux du compte, depuis la réponse account_status. null = pas de taux
 *  affichable (palier gratuit, palier inconnu, ou champs absents). */
export function rateFromAccount(status) {
  if (!status || status.ok === false) return null;
  if (status.plan === 'free' || status.plan == null) return null;
  // `price_eur` / `credits` ne sont PAS encore renvoyés par get_account_status.
  // Dès qu'ils le seront, le taux devient disponible sans autre changement ici.
  return creditRate({ price_eur: status.plan_price_eur, credits: status.plan_credits, plan: status.plan });
}

/** Ce que valent `credits` crédits à ce taux, en euros. null si pas de taux. */
export function creditsToEuros(credits, rate) {
  const n = Number(credits);
  if (rate == null || !Number.isFinite(n)) return null;
  return n * rate;
}

/** « 11,05 € » — un total, deux décimales. */
export function formatEuros(amount, locale = 'fr-BE') {
  return new Intl.NumberFormat(locale, {
    style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Le suffixe « (≈ 11,05 €) » à coller derrière un nombre de crédits, ou une
 * chaîne vide quand aucun taux n'est disponible. Concaténable sans condition
 * côté UI : c'est ici que se décide s'il y a quelque chose à dire.
 */
export function eurosSuffix(credits, rate, locale = 'fr-BE') {
  const euros = creditsToEuros(credits, rate);
  return euros == null ? '' : ` (≈ ${formatEuros(euros, locale)})`;
}
