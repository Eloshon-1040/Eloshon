/**
 * Native Messaging link to the desktop app's host process. The extension is the
 * EXECUTOR; the app owns the engine/config/credentials. Chrome launches the host
 * as its own child process; this module also carries the messages the host
 * relays to/from the running app.
 *
 * "App not running" is handled cleanly: connectNative's port disconnects
 * immediately (lastError), we surface status 'app_not_running' and retry with
 * backoff instead of throwing.
 *
 * ONE port at a time: every host process Chrome starts runs as « Eloshon Scraper.exe »,
 * so a second port (or a second reconnect loop) shows up as the app still running in
 * the background and blocks installing a new version. connect()/ensure() never open a
 * port while one is open or a reconnect is already scheduled; the delay grows up to
 * 5 minutes while the app stays closed, and connectNow() retries at once when the
 * user needs the app.
 *
 * The router (createRouter) is pure and unit-tested; the NativeLink class wraps
 * chrome.runtime.connectNative.
 */
import { validateMessage, error as errorMsg, MSG } from '../vendor/shared/protocol/messages.mjs';

export const HOST_NAME = 'com.eloshon.scraper.host';

/**
 * Build a message router. Validates every inbound envelope and dispatches by
 * type to `handlers[type]`. Version mismatches and malformed messages are
 * answered with an error envelope via `send` instead of crashing.
 * @param {Record<string,(payload:object,msg:object)=>void>} handlers
 * @param {{send:(msg:object)=>void, log?:Function}} io
 */
export function createRouter(handlers, io) {
  const send = io.send || (() => {});
  const log = io.log || (() => {});
  return {
    handle(raw) {
      const v = validateMessage(raw);
      if (!v.ok) {
        if (v.versionMismatch) send(errorMsg('E_PROTOCOL_VERSION', 'Version de protocole incompatible : mettez à jour l\'application ou l\'extension.'));
        else send(errorMsg('E_BAD_MESSAGE', `Message invalide : ${v.errors.join(' ')}`));
        log({ event: 'router_reject', errors: v.errors });
        return false;
      }
      const h = handlers[raw.type];
      if (!h) { log({ event: 'router_no_handler', type: raw.type }); return false; }
      h(raw.payload || {}, raw);
      return true;
    },
  };
}

export class NativeLink {
  /**
   * @param {object} chromeApi the chrome namespace
   * @param {{onMessage:Function, onStatus?:Function, log?:Function, maxBackoffMs?:number}} io
   */
  constructor(chromeApi, io = {}) {
    this.chrome = chromeApi;
    this.onMessage = io.onMessage || (() => {});
    this.onStatus = io.onStatus || (() => {});
    this.log = io.log || (() => {});
    this.maxBackoffMs = io.maxBackoffMs || 300000;
    this.port = null;
    this._timer = null;
    this.status = 'disconnected';
    this._backoff = 1000;
    this._connectedOnce = false;
  }

  _setStatus(s) { if (this.status !== s) { this.status = s; this.onStatus(s); } }

  connect() {
    if (this.port) return; // already linked: never a second host process
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    try {
      this.port = this.chrome.runtime.connectNative(HOST_NAME);
    } catch (e) {
      this._setStatus('app_not_running');
      this._scheduleReconnect();
      return;
    }
    this.port.onMessage.addListener((msg) => { this._connectedOnce = true; this._backoff = 1000; this._setStatus('connected'); this.onMessage(msg); });
    this.port.onDisconnect.addListener(() => {
      const err = this.chrome.runtime.lastError;
      this.log({ event: 'native_disconnect', error: err && err.message });
      this.port = null;
      // A near-immediate disconnect with no message ever received = host/app not up.
      this._setStatus(this._connectedOnce ? 'disconnected' : 'app_not_running');
      this._scheduleReconnect();
    });
    // Optimistically connected; a disconnect flips it back.
    this._setStatus('connected');
  }

  _scheduleReconnect() {
    if (this._timer) return; // one pending reconnect at most
    const delay = this._backoff;
    this._backoff = Math.min(this.maxBackoffMs, Math.round(this._backoff * 1.8));
    this._timer = setTimeout(() => { this._timer = null; this.connect(); }, delay);
  }

  /** Link if nothing is linked or scheduled (the periodic wake-up calls this). */
  ensure() { if (!this.port && !this._timer) this.connect(); }

  /** The user needs the app now (a panel request): retry at once, with a fresh delay. */
  connectNow() { if (this.port) return; this._backoff = 1000; this.connect(); }

  /** Send a message; returns false when the app/host is not reachable. */
  send(msg) {
    if (!this.port) return false;
    try { this.port.postMessage(msg); return true; } catch (e) { this.log({ event: 'native_send_fail', error: String(e && e.message) }); return false; }
  }

  disconnect() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } if (this.port) { try { this.port.disconnect(); } catch { /* ignore */ } this.port = null; } this._setStatus('disconnected'); }
}
