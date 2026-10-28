/**
 * When the host relay gives up. Chrome keeps a host alive as long as the extension's port
 * is open, and the host runs as `Eloshon Scraper.exe` — so a host that waited for the app
 * forever looked like the app "staying open in the background" and blocked the next
 * installation. The host now leaves when the app has been unreachable for `idleMs`; the
 * extension reconnects later (with a growing delay) or at once when the user needs the app.
 */
export const HOST_IDLE_EXIT_MS = 8000;

/**
 * @param {{ isUp:()=>boolean, exit:()=>void, idleMs?:number, now?:()=>number }} o
 * @returns {{ tick:()=>boolean }} tick() → true when it called exit()
 */
export function createIdleExit({ isUp, exit, idleMs = HOST_IDLE_EXIT_MS, now = Date.now }) {
  let downSince = now();
  let done = false;
  return {
    tick() {
      if (done) return true;
      if (isUp()) { downSince = null; return false; }
      if (downSince == null) downSince = now();
      if (now() - downSince >= idleMs) { done = true; exit(); return true; }
      return false;
    },
  };
}
