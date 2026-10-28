/**
 * Admin-gated IPC surface (MAIN process). Every provider-related channel is
 * wrapped by requireAdmin(): when the session is locked it returns a GENERIC
 * refusal { ok:false, locked:true } with NO data. Renderer state is never trusted.
 *
 * Testable without Electron: registerAdminIpc returns a { handlers } map that the
 * tests call directly; if `ipcMain` is provided it also registers them.
 *
 * The renderer only ever receives masked provider state (presence/source/flags),
 * booleans, counts and timestamps — never a credential value or a passphrase.
 */
import { PROVIDERS, maskState, isConfigured, resolveCredentials } from '../../core/providers/registry.mjs';
import { planImport } from '../../core/providers/import-env.mjs';
import { firecrawlCreditUsage } from '../../core/unlock/firecrawl.mjs';
import { registerUsageHandlers, USAGE_GATED, saveBalance } from './usage-ipc.mjs';

// Channels that require an unlocked admin session.
export const GATED = [
  'provider:list', 'provider:setCredentials', 'provider:deleteCredentials', 'provider:test',
  'provider:importPreview', 'provider:importConfirm',
  'provider:setEnabled', 'provider:setKill', 'provider:setDomain', 'provider:addDomain', 'provider:removeDomain',
  'provider:setCap', 'provider:usage', 'admin:log', 'admin:setAutoLock',
  ...USAGE_GATED,
];
// Channels usable while locked (create/unlock the lock screen; destructive reset).
export const UNGATED = ['admin:status', 'admin:create', 'admin:unlock', 'admin:lock', 'admin:reset'];

/**
 * @param {{
 *   session, secureStore, runtime, persist:()=>void,
 *   resolveIo:()=>({secure:object,config:object,env:object}),   // for maskState/isConfigured
 *   readEnvFile:(path:string)=>string, pickEnvFile:()=>Promise<string|null>,
 *   ipcMain?, log?:Function
 * }} io
 */
export function registerAdminIpc(io) {
  const { session, secureStore, runtime, persist, resolveIo } = io;
  const log = io.log || (() => {});
  const handlers = {};

  const maskAll = () => PROVIDERS.map((p) => maskState(p.id, resolveIo()));
  const providerState = () => ({
    providers: maskAll(),
    switches: PROVIDERS.map((p) => ({ id: p.id, enabled: runtime.isEnabled(p.id), caps: runtime.capFor(p.id), usage: runtime.usageFor(p.id) })),
    killSwitch: runtime.isKill(),
    domains: runtime.domains().map((d) => ({ domain: d, toggles: Object.fromEntries(PROVIDERS.map((p) => [p.id, runtime.domainEnabled(d, p.id)])) })),
  });

  // requireAdmin wrapper — the single enforcement point.
  const gate = (fn) => (...args) => {
    if (!session.isUnlocked()) return { ok: false, locked: true };
    session.touch();
    const fail = (e) => { log('admin ipc error: ' + (e && e.code || 'err')); return { ok: false, error: 'erreur interne' }; };
    try {
      const r = fn(...args);
      // Async handlers: a rejection becomes the same generic refusal (no stack to the renderer).
      return r && typeof r.then === 'function' ? r.catch(fail) : r;
    } catch (e) { return fail(e); }
  };

  // ---- ungated (lock screen) ----
  handlers['admin:status'] = () => ({ ok: true, ...session.status() });
  handlers['admin:create'] = (pass, confirm) => session.createPassphrase(pass, confirm);
  handlers['admin:unlock'] = (pass) => session.unlock(pass);
  handlers['admin:lock'] = () => { session.lock(); return { ok: true }; };
  handlers['admin:reset'] = (confirmText) => {
    if (confirmText !== 'REINITIALISER') return { ok: false, error: 'Tapez REINITIALISER pour confirmer (efface toutes les clés).' };
    const r = session.reset();
    if (r.wipeStore) secureStore.wipe();
    return { ok: true, wiped: true };
  };

  // ---- gated (provider management) ----
  handlers['provider:list'] = gate(() => ({ ok: true, ...providerState() }));

  handlers['provider:setCredentials'] = gate((id, fields) => {
    if (!PROVIDERS.some((p) => p.id === id)) return { ok: false, error: 'fournisseur inconnu' };
    const r = secureStore.setFields(id, fields || {});
    return r.ok ? { ok: true, mask: maskState(id, resolveIo()) } : r;
  });
  handlers['provider:deleteCredentials'] = gate((id, field) => {
    const r = secureStore.deleteField(id, field);
    return r.ok ? { ok: true, mask: maskState(id, resolveIo()) } : r;
  });

  // Connection test. NEVER billable: providers with a documented FREE check
  // (Firecrawl credit-usage) actually run it with the stored key (main process,
  // never logged); all others only do a local format check and say so.
  handlers['provider:test'] = gate(async (id) => {
    const p = PROVIDERS.find((x) => x.id === id); if (!p) return { ok: false, status: 'non_configuré', error: 'fournisseur inconnu' };
    if (!isConfigured(id, resolveIo())) return { ok: false, status: 'non_configuré', at: Date.now(), message: 'Non configuré : importez vos clés ou saisissez-les.' };
    const at = Date.now();
    if (p.freeCheck === 'credit_usage') {
      const creds = resolveCredentials(id, resolveIo());        // value stays in main
      const res = await firecrawlCreditUsage(creds.apiKey, { fetchImpl: io.fetchImpl });
      if (res.ok) saveBalance(io.balancesFile, 'firecrawl', res); // same free read → refresh the card's cached balance
      if (res.ok) return { ok: true, status: 'connecté', remaining: res.remaining, at, message: res.remaining != null ? `Connexion réussie — ${res.remaining} crédits restants` : 'Connexion réussie.' };
      return { ok: false, status: 'échec', at, message: `Échec : ${res.error || 'test impossible'}` };
    }
    // Providers with no documented free check: local format check only.
    return { ok: true, status: 'format_only', at, message: 'Format des identifiants valide. Aucun test gratuit disponible pour ce fournisseur — un test réel serait facturé.' };
  });

  handlers['provider:importPreview'] = gate(async () => {
    const path = await io.pickEnvFile();
    if (!path) return { ok: false, cancelled: true };
    let text; try { text = io.readEnvFile(path); } catch { return { ok: false, error: 'lecture du fichier impossible' }; }
    return { ok: true, path, ...planImport(text) }; // NAMES only, no values
  });
  handlers['provider:importConfirm'] = gate(async (path) => {
    if (!path) return { ok: false, error: 'chemin manquant' };
    let text; try { text = io.readEnvFile(path); } catch { return { ok: false, error: 'lecture du fichier impossible' }; }
    const { extractValues } = await import('../../core/providers/import-env.mjs');
    const r = secureStore.importValues(extractValues(text)); // values → store only
    if (r.ok) persist();
    return r.ok ? { ok: true, count: r.count, providers: maskAll() } : r;
  });

  handlers['provider:setEnabled'] = gate((id, on) => { runtime.setEnabled(id, on); persist(); return { ok: true, ...providerState() }; });
  handlers['provider:setKill'] = gate((on) => { runtime.setKill(on); persist(); return { ok: true, ...providerState() }; });
  handlers['provider:setDomain'] = gate((domain, id, on) => { runtime.setDomainEnabled(domain, id, on); persist(); return { ok: true, ...providerState() }; });
  handlers['provider:addDomain'] = gate((domain) => { runtime.addDomain(domain); persist(); return { ok: true, ...providerState() }; });
  handlers['provider:removeDomain'] = gate((domain) => { runtime.removeDomain(domain); persist(); return { ok: true, ...providerState() }; });
  handlers['provider:setCap'] = gate((id, patch) => { runtime.setCap(id, patch); persist(); return { ok: true, caps: runtime.capFor(id) }; });
  handlers['provider:usage'] = gate(() => ({ ok: true, usage: PROVIDERS.map((p) => ({ id: p.id, usage: runtime.usageFor(p.id), caps: runtime.capFor(p.id) })) }));
  handlers['admin:log'] = gate((domain) => ({ ok: true, rows: runtime.adminLog(domain || null), runs: runtime.externalRuns(domain || null) }));
  handlers['admin:setAutoLock'] = gate((ms) => session.setAutoLockMs(ms));

  // Usage ledger, opt-in, costs, balances, test plan — same gate.
  registerUsageHandlers(handlers, gate, io);

  if (io.ipcMain) {
    for (const [chan, fn] of Object.entries(handlers)) io.ipcMain.handle(chan, (_e, ...args) => fn(...args));
  }
  return { handlers, GATED, UNGATED };
}
