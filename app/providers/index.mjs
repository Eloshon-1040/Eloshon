/**
 * Challenge-provider registry (app layer — the ENGINE knows none of this).
 *
 * The engine only detects a protection and calls onIntervention({url,code,reason})
 * expecting 'retry' | 'skip'. The app routes that call to the ACTIVE provider:
 *
 *   • manual     — always available; opens the visible browser and waits for the
 *                  user to solve it, then Continue (retry) / Skip. No bypass.
 *   • twocaptcha — interface prepared, NOT implemented in this version.
 *   • …          — extensible later.
 *
 * No credentials live here. A future provider reads its key from OS-secure
 * storage (Electron safeStorage), never from code or plain config.
 */

export function manualProvider() {
  let pending = null;
  return {
    id: 'manual',
    label: 'Intervention manuelle',
    isConfigured: () => true,
    async testConnection() { return { ok: true, message: 'Toujours disponible (aucune configuration requise).' }; },
    /** Resolves to 'retry' | 'skip'. The app settles it via continue()/skip(). */
    resolve(challenge, { emit } = {}) {
      emit?.('intervention', { ...challenge, mode: 'manual', state: 'waiting' });
      return new Promise((res) => { pending = res; });
    },
    continue() { if (pending) { const r = pending; pending = null; r('retry'); } },
    skip() { if (pending) { const r = pending; pending = null; r('skip'); } },
    get waiting() { return !!pending; },
  };
}

export function twoCaptchaProvider() {
  return {
    id: 'twocaptcha',
    label: 'TwoCaptcha',
    isConfigured: () => false, // no key wired; not implemented yet
    async testConnection() { return { ok: false, message: 'Provider non implémenté (prévu).' }; },
    async resolve() { throw new Error('TwoCaptcha provider not implemented yet'); },
  };
}

/** Fresh registry. `manual` is the default and always present. */
export function createProviderRegistry() {
  return { manual: manualProvider(), twocaptcha: twoCaptchaProvider() };
}
