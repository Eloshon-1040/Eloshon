/**
 * Client for the `firecrawl-unlock` Edge Function — the ONLY channel between the
 * desktop app and the server (decision 2b). Pure and injectable: pass `fetchImpl`
 * in tests. Provider secrets never touch the client; the licence + anon key do.
 *
 * Actions: estimate (cost before launch), unlock (cascade), profile (shared
 * recipe), feedback (run outcome), diag. All refusals are mapped to a clear
 * French message + a machine `reason`, so the UI can offer a clean local fallback.
 */

import { fetchWithin } from '../shared/net/deadline.mjs';
import { eurosSuffix } from './credit-rate.mjs';

export function createEdgeClient({ baseUrl, anonKey, license, fetchImpl, timeoutMs = 20000, unlockTimeoutMs = 180000 } = {}) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const url = baseUrl ? `${baseUrl.replace(/\/$/, '')}/functions/v1/firecrawl-unlock` : null;
  const configured = !!(url && anonKey && license);

  // One deadline over the request AND its body: a server that never finishes its
  // answer cannot hold the job (the recipe sync is awaited before every run).
  // The server-side unlock does real work, hence its longer budget.
  async function call(payload) {
    if (!configured) return { ok: false, status: 0, reason: 'not_configured' };
    const got = await fetchWithin(f, url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ license, ...payload }),
    }, { timeoutMs: payload && payload.action === 'unlock' ? unlockTimeoutMs : timeoutMs, as: 'json' });
    if (!got.ok) {
      if (got.error === 'timeout') return { ok: false, status: 0, reason: 'timeout' };
      return { ok: false, status: 0, reason: 'network_error', error: String(got.error) };
    }
    const j = got.jsonError || !got.body || typeof got.body !== 'object' ? {} : got.body;
    return { status: got.status, ...j };
  }

  return {
    isConfigured: () => configured,
    estimate: (targetUrl, pages = 1) => call({ action: 'estimate', url: targetUrl, pages }),
    unlock: (targetUrl, { returnHtml = true, mode } = {}) => call({ action: 'unlock', url: targetUrl, returnHtml, mode }),
    profile: (host) => call({ action: 'profile', host }),
    // 2b sync: upload a locally-derived recipe as a shared candidate (server owns the
    // candidate→shared promotion after several distinct clients). Best-effort.
    pushRecipe: (host, recipe) => call({ action: 'recipe-push', host, recipe }),
    feedback: (host, feedback) => call({ action: 'feedback', host, feedback }),
    // Palier et soldes du compte. Sert à convertir un nombre de crédits en
    // euros au taux du palier RÉELLEMENT actif (core/credit-rate.mjs) — sans
    // lui, l'UI n'affiche que les crédits, jamais un équivalent estimé.
    accountStatus: () => call({ action: 'account_status' }),
    diag: () => call({ action: 'diag' }),
  };
}

const REASONS = {
  not_configured: 'Déblocage assisté non configuré (licence/serveur manquants) — lecture locale uniquement.',
  network_error: 'Serveur de déblocage injoignable — repli en lecture locale.',
  unknown_account: 'Licence inconnue — vérifiez votre clé Eloshon dans les paramètres.',
  account_blocked: 'Compte bloqué — contactez le support. Repli en lecture locale.',
  quota_exceeded: 'Quota mensuel de crédits épuisé — repli en lecture locale.',
  all_providers_failed: 'Aucun fournisseur n’a pu débloquer ce site.',
  feedback_daily_cap: 'Limite quotidienne de remontées atteinte.',
  NO_URL: 'URL manquante.',
  BAD_ACTION: 'Action inconnue.',
};

// User-facing wording NEVER exposes the provider, the technical mode (asp /
// datacenter / stealth), the attempt count or raw HTTP codes — those stay in the
// returned object (for the local technical journal + server logs) but never in
// `message`. The client sees only the result and its ORIGIN: a first discovery or
// an already-known site. (Personal-key mode, which must name the paid service, and
// a developer mode are handled by the caller, not here.)
const originLabel = (fromProfile) => (fromProfile ? 'site déjà connu' : 'première découverte');

/** Human-readable outcome for the UI (success or a clear, actionable refusal).
 *  `rate` (€ par crédit du palier actif, cf. core/credit-rate.mjs) ajoute
 *  l'équivalent monétaire ; absent ou null → crédits seuls. */
export function describeUnlock(res, rate = null) {
  if (res && res.ok && res.html !== undefined) {
    const eur = eurosSuffix(res.eloshon_credits, rate);
    return { ok: true, provider: res.provider, mode: res.mode, credits: res.eloshon_credits, countryMismatch: !!res.country_mismatch, message: `Débloqué — ${res.eloshon_credits} crédit(s)${eur} (${originLabel(res.from_profile)}).` };
  }
  const reason = (res && res.reason) || (res && res.error) || 'unknown';
  const quota = res && res.quota;
  let message = REASONS[reason] || 'Échec du déblocage assisté.';
  if (reason === 'quota_exceeded' && quota) message += ` (${quota.used}/${quota.quota})`;
  return { ok: false, reason, message, quota, attempts: res && res.attempts, fallbackLocal: reason !== 'all_providers_failed' };
}

/** Format an estimate for the "coût estimé avant lancement" banner. */
export function describeEstimate(res, rate = null) {
  if (!res || !res.ok) return { ok: false, reason: (res && res.reason) || 'unknown', message: describeUnlock(res).message };
  const src = originLabel(res.from_profile);
  const eur = eurosSuffix(res.estimated_total, rate);
  return { ok: true, provider: res.provider, mode: res.mode, perPage: res.credits_per_page, pages: res.pages, total: res.estimated_total, fromProfile: !!res.from_profile, message: `Déblocage assisté ≈ ${res.estimated_total} crédit(s)${eur} (${src}).` };
}
