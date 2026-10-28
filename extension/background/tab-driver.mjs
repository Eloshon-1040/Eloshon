/**
 * TabDriver — implements the shared interpreter's `env.page` against a real
 * Chrome/Edge tab. Navigation is driven from the service worker (which survives
 * page reloads); per-page work runs in the injected content runner via
 * chrome.scripting. This is what makes the tier "a real browser": the user's own
 * IP, cookies and session apply to every request.
 *
 * The unit-testable pieces (nextListUrl) are pure and shared; the chrome-bound
 * methods are thin wrappers.
 */
import { nextPageUrl } from '../vendor/shared/extract/paginate-url.mjs';

const RUNNER_FILE = 'content/runner.mjs';

export class TabDriver {
  /**
   * @param {object} chromeApi chrome namespace
   * @param {number} tabId
   * @param {{navTimeoutMs?:number, log?:Function}} [opts]
   */
  constructor(chromeApi, tabId, opts = {}) {
    this.chrome = chromeApi;
    this.tabId = tabId;
    this.navTimeoutMs = opts.navTimeoutMs || 30000;
    this.log = opts.log || (() => {});
  }

  async _ensureRunner() {
    await this.chrome.scripting.executeScript({ target: { tabId: this.tabId }, files: [RUNNER_FILE] });
  }

  /** Call a __eloRunner method inside the tab and return its (serializable) result. */
  async _call(method, args = []) {
    await this._ensureRunner();
    const res = await this.chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      args: [method, args],
      func: (m, a) => globalThis.__eloRunner[m](...a),
    });
    return res && res[0] ? res[0].result : undefined;
  }

  _waitForComplete() {
    return new Promise((resolve) => {
      const to = setTimeout(() => { cleanup(); resolve(false); }, this.navTimeoutMs);
      const listener = (id, info) => { if (id === this.tabId && info.status === 'complete') { cleanup(); resolve(true); } };
      const cleanup = () => { clearTimeout(to); this.chrome.tabs.onUpdated.removeListener(listener); };
      this.chrome.tabs.onUpdated.addListener(listener);
    });
  }

  // ---- env.page surface -----------------------------------------------------

  async goto(url) {
    await this.chrome.tabs.update(this.tabId, { url });
    await this._waitForComplete();
    return this.context();
  }

  async currentUrl() { const t = await this.chrome.tabs.get(this.tabId); return t.url; }

  async context() {
    const ctx = await this._call('readContext', []);
    return ctx || { url: await this.currentUrl(), body: '' };
  }

  async waitFor(opts) { return this._call('waitFor', [opts]); }
  async click(selector, opts) { return this._call('click', [selector, opts || {}]); }
  async type(selector, value, opts) { return this._call('type', [selector, value, opts || {}]); }
  async select(selector, opts) { return this._call('select', [selector, opts || {}]); }
  async scroll(opts) { return this._call('scroll', [opts || {}]); }
  async fetchInPage(url, opts) { return this._call('fetchInPage', [url, opts || {}]); }
  /** Wait until the page stops building itself (no DOM change / request for a moment, bounded). */
  async settle(opts) { return this._call('settle', [opts || {}]); }
  /** JSON/GraphQL responses the page fetched (from the MAIN-world net interceptor). */
  async capturedResponses() { try { return (await this._call('getCapturedResponses', [])) || []; } catch { return []; } }
  /** Unfiltered request trace (method+url+status+contentType+head) for diagnostics. */
  async requestLog() { try { return (await this._call('getRequestLog', [])) || []; } catch { return []; } }

  /**
   * Advance to the next listing page. Returns {moved, done, ctx}.
   * Styles: url_param (synthesize next URL), next_button (click), infinite_scroll
   * (scroll to load more), cursor (API cursor → handled by internal-api mode).
   */
  async paginate({ style, param, selector } = {}) {
    if (style === 'url_param') {
      const cur = await this.currentUrl();
      const next = param ? bumpParam(cur, param) : nextPageUrl(cur);
      if (!next || next === cur) return { moved: false, done: true };
      const ctx = await this.goto(next);
      return { moved: true, done: false, ctx };
    }
    if (style === 'next_button') {
      const clicked = await this.click(selector, { optional: true });
      if (!clicked) return { moved: false, done: true };
      await this._waitForComplete();
      return { moved: true, done: false, ctx: await this.context() };
    }
    if (style === 'infinite_scroll') {
      await this.scroll({ to: 'bottom', times: 3, pause_ms: 600 });
      return { moved: true, done: false, ctx: await this.context() };
    }
    // cursor pagination is an API concern, not a DOM one
    return { moved: false, done: true };
  }
}

/** Increment (or set to 2) a specific query param in a URL. Pure/testable. */
export function bumpParam(url, param) {
  try {
    const u = new URL(url);
    const v = u.searchParams.get(param);
    if (v != null && /^\d+$/.test(v)) u.searchParams.set(param, String(parseInt(v, 10) + 1));
    else u.searchParams.set(param, '2');
    return u.toString();
  } catch { return null; }
}
