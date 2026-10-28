/* Admin usage display helpers — PURE (no DOM, no IPC), shared by the
 * Administration page and the admin-only additions of the main screens.
 * Owner-facing, French-first (like the rest of the admin area). Every value
 * comes from the usage ledger; costs are always shown as estimates. */

export const PROVIDER_LABEL = Object.freeze({
  local: 'Lecture locale',
  extension: 'Votre navigateur (extension)',
  firecrawl: 'Firecrawl',
  webunlocker: 'Bright Data Web Unlocker',
  scrapingbrowser: 'Bright Data Scraping Browser',
  cascade: 'Cascade serveur Eloshon',
  scrapfly: 'Scrapfly',
  anthropic: 'Claude (Anthropic)',
  zyte: 'Zyte',
});
export const PROVIDER_ORDER = Object.freeze(['local', 'extension', 'firecrawl', 'webunlocker', 'scrapingbrowser', 'cascade', 'scrapfly', 'anthropic', 'zyte']);
export const PAID = Object.freeze(['firecrawl', 'webunlocker', 'scrapingbrowser', 'cascade', 'scrapfly', 'anthropic', 'zyte']);

const ROUTE_LABEL = {
  escalation: 'dernier recours', bootstrap: 'session d’amorçage', unlock: 'page 1', 'unlock-page': 'page suivante',
  cascade: 'tentative de la cascade', 'ai-assist': 'détection par IA', nodriver: 'navigateur spécialisé',
  'your-browser': 'extension',
};

export const OUTCOME_LABEL = Object.freeze({
  success: 'Produits trouvés', empty: 'Page reçue, aucun produit', failed: 'Échec', timeout: 'Délai dépassé', quota_exhausted: 'Quota épuisé',
  blocked_by_cap: 'Bloqué : plafond atteint', blocked_no_optin: 'Bloqué : site non autorisé', skipped: 'Non tenté',
});
export const OUTCOME_TONE = Object.freeze({ success: 'ok', empty: 'warn', failed: 'err', timeout: 'err', quota_exhausted: 'err', blocked_by_cap: 'warn', blocked_no_optin: 'warn', skipped: '' });
/** A paid request that came back without any usable product (billed for nothing). */
export function paidForNothing(e) {
  return !!(e && e.attempted && PAID.includes(e.provider) && e.outcome !== 'skipped' && (e.outcome === 'empty' || (e.outcome === 'success' && Number(e.products) === 0)));
}

const REASON_LABEL = {
  no_optin: 'site non autorisé pour cette voie (onglet Domaines)',
  cap_reached: 'plafond atteint (onglet Fournisseurs)',
  kill_switch: 'tous les fournisseurs sont désactivés',
  disabled: 'fournisseur désactivé',
  domain_off: 'bloqué pour ce site par l’interrupteur du site',
  not_configured: 'aucune clé enregistrée',
  priority: 'une voie prioritaire a été essayée avant',
  one_session_per_job: 'une session Scraping Browser a déjà été ouverte pour ce job',
  test_mode: 'autorisé par le mode test',
  stopped: 'job arrêté avant l’appel',
  stopped_by_user: 'arrêté par vous',
  no_products: 'aucun produit trouvé',
  quota_exceeded: 'quota mensuel de crédits épuisé',
  all_providers_failed: 'aucun fournisseur de la cascade n’a réussi',
  provider_timeout: 'le fournisseur n’a pas répondu à temps',
  network_error: 'serveur injoignable',
  zone_manual_expect_disabled: 'option « Manual expect » désactivée sur la zone Bright Data',
  // free-lane block / diagnosis codes (engine)
  ACCESS_DENIED: 'accès refusé par le site', BOT_CHALLENGE: 'protection anti-robot', RATE_LIMITED: 'trop de requêtes (site protégé)',
  JAVASCRIPT_REQUIRED: 'page rendue côté navigateur', NETWORK_ERROR: 'site injoignable', UNREACHABLE: 'site injoignable',
  blocked: 'site protégé', 'needs-browser': 'navigateur nécessaire', 'structured-undetected': 'données vues mais produits non atteints',
  unreachable: 'site injoignable', error: 'erreur pendant le job', not_wired: 'voie non branchée',
};

/** "Firecrawl" / "Firecrawl (via le serveur)". */
export function providerName(provider, channel) {
  const base = PROVIDER_LABEL[provider] || String(provider || '—');
  return channel === 'server' && provider !== 'cascade' ? `${base} (via le serveur)` : base;
}
export function routeName(route) { return route ? (ROUTE_LABEL[route] || route) : ''; }
export function reasonText(reason) {
  if (!reason) return '';
  const r = String(reason);
  if (REASON_LABEL[r]) return REASON_LABEL[r];
  const m = r.match(/^http_(\d{3})$/); if (m) return `réponse HTTP ${m[1]}`;
  const a = r.match(/^ai_http_(\d{3})(?::(.+))?$/); if (a) return `réponse HTTP ${a[1]}${a[2] ? ` (${a[2]})` : ''}`;
  return r;
}
export function outcomeText(o) { return OUTCOME_LABEL[o] || String(o || '—'); }

/** Provider card status code → wording + tone. */
export const STATUS_TEXT = Object.freeze({
  not_wired: { t: 'Non branché : l’application n’appelle jamais ce fournisseur', c: '' },
  not_configured: { t: 'Non configuré : aucune clé enregistrée', c: 'warn' },
  kill_switch: { t: 'Désactivé par « Tout désactiver »', c: 'err' },
  disabled: { t: 'Désactivé', c: 'err' },
  cap_reached: { t: 'Plafond atteint : plus aucun appel ce mois-ci', c: 'err' },
  quota_exhausted: { t: 'Quota épuisé chez le fournisseur', c: 'err' },
  last_call_error: { t: 'Erreur au dernier appel', c: 'warn' },
  no_optin: { t: 'Configuré, mais aucun site autorisé (onglet Domaines)', c: 'warn' },
  ready: { t: 'Prêt', c: 'ok' },
});
export function statusView(status) { return STATUS_TEXT[(status && status.code) || 'not_configured'] || { t: String(status && status.code), c: '' }; }

// ---------------------------------------------------------------- numbers & time

const nf = (max, min = 0) => new Intl.NumberFormat('fr-BE', { maximumFractionDigits: max, minimumFractionDigits: min });
export function fmtInt(n) { return n == null || !Number.isFinite(Number(n)) ? '—' : nf(0).format(Number(n)); }
/** "≈ 0,0123 $" — always an estimate; "inconnu" when no price is configured. */
export function fmtUsd(n) {
  if (n == null || !Number.isFinite(Number(n))) return 'inconnu';
  const v = Number(n);
  if (v === 0) return '0 $';
  // Per-call costs are fractions of a cent: keep 4 decimals below 1 $.
  return `≈ ${(Math.abs(v) < 1 ? nf(4, 2) : nf(2, 2)).format(v)} $`;
}
export function fmtBytes(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (v < 1024) return `${v} o`;
  if (v < 1024 * 1024) return `${nf(1).format(v / 1024)} Ko`;
  return `${nf(1).format(v / (1024 * 1024))} Mo`;
}
export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '—';
  const s = Number(ms) / 1000;
  if (s < 1) return `${Math.round(Number(ms))} ms`;
  if (s < 60) return `${nf(1).format(s)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}
/** Local date + time ("06/10/2026 21:28"); stored values are UTC ISO. */
export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return '—';
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fmtDate(iso) { const s = fmtDateTime(iso); return s === '—' ? s : s.slice(0, 10); }
/** "il y a 3 min" (relative to `now`). */
export function relTime(iso, now = Date.now()) {
  if (!iso) return 'jamais';
  const t = Date.parse(iso); if (!Number.isFinite(t)) return 'jamais';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'à l’instant';
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

// ---------------------------------------------------------------- "Passé par"

/**
 * The admin-only route summary of ONE job, from its ledger lines (oldest first).
 * Returns null when the admin is locked or nothing was recorded — callers then
 * render nothing, so an ordinary user sees exactly today's screen.
 * @param {Array} events ledger lines of the job
 * @param {{unlocked:boolean}} opts
 * @returns {null | {text:string, chain:string[], credits:number, costUsd:number|null, costUnknown:boolean, testMode:boolean, blocked:string[]}}
 */
export function passeParLine(events, { unlocked = false } = {}) {
  if (!unlocked || !Array.isArray(events) || !events.length) return null;
  const chain = []; let credits = 0; let cost = 0; let costKnown = false; let costUnknown = false; const blocked = [];
  for (const e of events) {
    if (e.attempted) {
      const name = providerName(e.provider, e.channel) + (e.outcome && e.outcome !== 'success' ? ` (${outcomeText(e.outcome).toLowerCase()})` : '');
      if (chain[chain.length - 1] !== name) chain.push(name);
      if (Number.isFinite(e.credits)) credits += e.credits;
      if (Number.isFinite(e.costUsd)) { cost += e.costUsd; costKnown = costKnown || e.costUsd > 0; } else if (PAID.includes(e.provider) && e.provider !== 'cascade' && e.channel !== 'server') costUnknown = true;
    } else if (e.outcome === 'blocked_no_optin' || e.outcome === 'blocked_by_cap') {
      blocked.push(`${providerName(e.provider, e.channel)} : ${outcomeText(e.outcome).replace(/^Bloqué : /, '')}`);
    }
  }
  if (!chain.length && !blocked.length) return null;
  const testMode = events.some((e) => e.testMode);
  let text = `Passé par : ${chain.length ? chain.join(' → ') : 'aucune voie tentée'}`;
  if (credits) text += ` · ${fmtInt(credits)} crédit${credits > 1 ? 's' : ''}`;
  if (costKnown) text += ` · coût estimé ${fmtUsd(cost)}`;
  else if (costUnknown) text += ' · coût estimé inconnu (prix non renseigné)';
  return { text, chain, credits, costUsd: costKnown ? cost : null, costUnknown, testMode, blocked };
}
