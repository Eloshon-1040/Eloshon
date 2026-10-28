/**
 * "Your browser" IPC — USER-FACING, deliberately NOT admin-gated: this mode has
 * nothing to do with provider credentials, costs or margins, so any user of the
 * app can launch and follow a run in their own Chrome/Edge. (The provider panel
 * stays admin-only in app/admin/ipc.mjs; nothing here touches it.)
 *
 * Least privilege: invoke-only channels, every argument re-validated here (the
 * renderer is never trusted), whitelisted return shapes, every failure mapped to
 * a French, non-technical {ok:false, code, message}. Pure: takes an `ipcMain`-like
 * object so it is testable without Electron.
 */
import { availability as availabilityFor, fail } from './launch.mjs';

export const YB_CHANNELS = Object.freeze(['yb:status', 'yb:availability', 'yb:run', 'yb:pause', 'yb:resume', 'yb:stop']);

/**
 * @param {{ getService:()=>object|null, readConfig:()=>object }} deps
 * @returns {Record<string, Function>}
 */
export function createYourBrowserHandlers({ getService, readConfig }) {
  const svc = () => { try { return getService() || null; } catch { return null; } };
  const cfg = () => { try { return readConfig() || {}; } catch { return {}; } };
  const guard = (fn) => async (...args) => { try { return await fn(...args); } catch { return fail('invalid_request'); } };
  const control = (method) => guard((jobId) => {
    const s = svc();
    if (!s || typeof jobId !== 'string' || !jobId || jobId.length > 80) return fail('unknown_job');
    return s[method](jobId);
  });

  return {
    'yb:status': guard(() => {
      const s = svc();
      if (!s) return { enabled: false, bridge: 'stopped', extension: 'disconnected', browser: null, job: null, activeJob: null };
      const st = s.status();
      return { enabled: !!st.enabled, bridge: st.bridge, extension: st.extension, browser: st.browser || null, job: st.job || null, activeJob: st.activeJob || null };
    }),
    'yb:availability': guard((url) => {
      if (typeof url !== 'string') return fail('invalid_url');
      const s = svc();
      return s ? s.availability(url) : availabilityFor(cfg(), url, { started: false, connected: false });
    }),
    'yb:run': guard(async (input) => {
      const s = svc();
      if (!s) {
        const av = availabilityFor(cfg(), input && typeof input.startUrl === 'string' ? input.startUrl : '', { started: false, connected: false });
        return fail(av.code || 'restart_required');
      }
      return s.launch(input);
    }),
    'yb:pause': control('pause'),
    'yb:resume': control('resume'),
    'yb:stop': control('stopJob'),
  };
}

/** Register the handlers on Electron's ipcMain (invoke/handle only). */
export function registerYourBrowserIpc(ipcMain, deps) {
  const handlers = createYourBrowserHandlers(deps);
  for (const [chan, fn] of Object.entries(handlers)) ipcMain.handle(chan, (_e, ...args) => fn(...args));
  return handlers;
}
