/**
 * Provider runtime — the data-driven switches, per-domain toggles, caps, usage
 * counters and effective-availability logic. Pure: it operates on a plain `state`
 * object (persisted as config.json `providers`, NO secrets) and an injected
 * `isConfigured(id)` predicate (credential presence comes from the registry with
 * the secure store; this module never touches secrets).
 *
 * Effective availability = provider switch ON and domain toggle ON and configured
 * and under caps and the master kill switch OFF. The controller consults
 * `isAvailable(id, domain)` before every billable call.
 */
import { PROVIDERS, PROVIDER_IDS, getProvider } from './registry.mjs';

const ym = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };

export function withDefaults(state = {}) {
  const s = { killSwitch: false, enabled: {}, perDomain: {}, caps: {}, usage: {}, ...(state || {}) };
  s.enabled = { ...(s.enabled || {}) };
  s.perDomain = { ...(s.perDomain || {}) };
  s.caps = { ...(s.caps || {}) };
  s.usage = { ...(s.usage || {}) };
  return s;
}

export class ProviderRuntime {
  /** @param {object} state config.json `providers` block @param {{now?:()=>number, isConfigured?:(id:string)=>boolean}} io */
  constructor(state = {}, io = {}) {
    this.state = withDefaults(state);
    this.now = io.now || Date.now;
    this._configured = io.isConfigured || (() => false);
  }

  // ---- switches ----
  isKill() { return this.state.killSwitch === true; }
  setKill(on) { this.state.killSwitch = !!on; return this; }
  isEnabled(id) { return this.state.enabled[id] !== false; } // default ON
  setEnabled(id, on) { this.state.enabled[id] = !!on; return this; }

  // ---- per-domain ----
  domains() { return Object.keys(this.state.perDomain); }
  addDomain(domain) { if (domain && !this.state.perDomain[domain]) this.state.perDomain[domain] = {}; return this; }
  removeDomain(domain) { delete this.state.perDomain[domain]; return this; }
  domainEnabled(domain, id) { const d = this.state.perDomain[domain]; return !d || d[id] !== false; } // default ON
  setDomainEnabled(domain, id, on) { this.addDomain(domain); this.state.perDomain[domain][id] = !!on; return this; }

  // ---- caps + usage ----
  capFor(id) { const p = getProvider(id); return { ...(p ? p.caps : {}), ...(this.state.caps[id] || {}) }; }
  setCap(id, patch) { this.state.caps[id] = { ...(this.state.caps[id] || {}), ...(patch || {}) }; return this; }
  usageFor(id) {
    const now = ym(this.now());
    let u = this.state.usage[id];
    if (!u || u.month !== now) { u = { month: now, callsThisMonth: 0, bytesThisMonth: 0, usdThisMonth: 0, callsThisJob: 0, bytesThisJob: 0 }; this.state.usage[id] = u; }
    return u;
  }
  resetJobCounters() { for (const id of PROVIDER_IDS) { const u = this.usageFor(id); u.callsThisJob = 0; u.bytesThisJob = 0; } return this; }

  underCaps(id) {
    const cap = this.capFor(id); const u = this.usageFor(id);
    if (cap.maxCallsPerJob != null && u.callsThisJob >= cap.maxCallsPerJob) return false;
    if (cap.maxCallsPerMonth != null && u.callsThisMonth >= cap.maxCallsPerMonth) return false;
    if (cap.maxBytesPerJob != null && u.bytesThisJob >= cap.maxBytesPerJob) return false;
    if (cap.maxBytesPerMonth != null && u.bytesThisMonth >= cap.maxBytesPerMonth) return false;
    if (cap.maxUsdPerMonth != null && u.usdThisMonth >= cap.maxUsdPerMonth) return false;
    return true;
  }

  /** Record one billable call's usage (bytes/usd optional). */
  recordCall(id, { bytes = 0, usd = 0 } = {}) {
    const u = this.usageFor(id);
    u.callsThisJob += 1; u.callsThisMonth += 1;
    u.bytesThisJob += bytes; u.bytesThisMonth += bytes;
    // per_gb providers: derive USD from bytes if not given.
    const p = getProvider(id);
    if (!usd && p && p.costModel && p.costModel.type === 'per_gb' && p.costModel.usdPerGb) usd = (bytes / (1024 ** 3)) * p.costModel.usdPerGb;
    u.usdThisMonth += usd;
    return u;
  }

  // ---- effective availability + reason ----
  /** @returns {null|'kill_switch'|'disabled'|'domain_off'|'not_configured'|'cap_reached'} null = available. */
  availabilityReason(id, domain) {
    if (this.isKill()) return 'kill_switch';
    if (!this.isEnabled(id)) return 'disabled';
    if (domain && !this.domainEnabled(domain, id)) return 'domain_off';
    if (!this._configured(id)) return 'not_configured';
    if (!this.underCaps(id)) return 'cap_reached';
    return null;
  }
  isAvailable(id, domain) { return this.availabilityReason(id, domain) == null; }

  // ---- audience-split reporting ----
  /** Admin-only log rows (per provider). Contains configured/enabled/calls/cost/skip. */
  adminLog(domain) {
    return PROVIDERS.map((p) => {
      const u = this.usageFor(p.id);
      const reason = this.availabilityReason(p.id, domain);
      return {
        id: p.id, label: p.label,
        configured: this._configured(p.id),
        enabled: this.isEnabled(p.id) && !this.isKill(),
        enabledForDomain: this.domainEnabled(domain, p.id),
        calls: u.callsThisMonth, callsThisJob: u.callsThisJob,
        estCost: estCostText(p, u),
        skipReason: reason ? reasonFr(reason, p.label) : null,
      };
    });
  }

  /**
   * Non-provider executions for the admin journal (the free "your browser"
   * extension tier). Kept apart from provider rows so a run in the user's own
   * browser is never mistaken for a billed call. Bounded; no secrets, no URLs.
   */
  recordExternalRun(entry = {}) {
    const runs = Array.isArray(this.state.externalRuns) ? this.state.externalRuns : [];
    const row = {
      source: String(entry.source || 'your_browser'), label: String(entry.label || 'Votre navigateur'),
      domain: entry.domain ? String(entry.domain) : null, status: entry.status ? String(entry.status) : null,
      products: Number(entry.products) || 0, paid: false, at: entry.at || new Date(this.now()).toISOString(),
    };
    this.state.externalRuns = [row, ...runs].slice(0, 20);
    return row;
  }
  externalRuns(domain) { return (Array.isArray(this.state.externalRuns) ? this.state.externalRuns : []).filter((r) => !domain || r.domain === domain); }

  /** User-facing note (any user): generic, NO provider name/cost/config detail. */
  userFacingNote() { return 'palier avancé non disponible pour ce site'; }
}

const reasonFr = (reason, label) => ({
  kill_switch: `${label} : tous les fournisseurs sont désactivés (interrupteur général).`,
  disabled: `${label} : désactivé.`,
  domain_off: `${label} : désactivé pour ce domaine.`,
  not_configured: `${label} : non configuré pour ce domaine.`,
  cap_reached: `${label} : plafond atteint.`,
}[reason] || `${label} : indisponible.`);

function estCostText(p, u) {
  const m = p.costModel || {};
  if (m.type === 'per_gb') return `${(u.usdThisMonth || 0).toFixed(2)} $ (${((u.bytesThisMonth || 0) / (1024 ** 2)).toFixed(1)} Mo) ce mois`;
  if (m.type === 'credits') return `${u.callsThisMonth || 0} appel(s) ce mois`;
  return `${u.callsThisMonth || 0} requête(s) ce mois`;
}
