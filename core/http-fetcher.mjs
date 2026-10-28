/**
 * HTTP fetch layer — independent of any parser (it knows nothing about product
 * fields). Handles: timeout, retry with backoff, redirects (native), gzip
 * (native fetch decompresses), content-type detection, configurable UA, and a
 * polite per-host rate limit. Never bypasses captchas/auth/protections: a 403/
 * 429/503 or a challenge page is reported, not circumvented.
 */
import { DEFAULT_USER_AGENT } from './types.mjs';
import { classifyResponse, STATUS } from './detect.mjs';
import { CookieJar } from './cookie-jar.mjs';
import { HostPacer, retryAfterMs, anySignal } from '../shared/net/deadline.mjs';

// Some sites (CDN/WAF such as Akamai; long Set-Cookie/CSP/link header sets)
// return response headers larger than undici's default 16 KiB limit. The global
// fetch then throws `UND_ERR_HEADERS_OVERFLOW` (surfaced as a generic
// "fetch failed"), losing the page entirely. A dedicated dispatcher with a
// larger — but still bounded — maxHeaderSize fixes this generically for every
// source. undici ships with Node; if it cannot be loaded we fall back to the
// default dispatcher, i.e. the previous behaviour.
let UndiciAgent = null;
try { ({ Agent: UndiciAgent } = await import('undici')); } catch { /* default fetch (16 KiB header cap) */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A wait that ends early when `signal` aborts. */
const sleepUnless = (ms, signal) => new Promise((r) => {
  if (signal && signal.aborted) { r(); return; }
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); if (signal) signal.removeEventListener('abort', done); r(); }
  if (signal) signal.addEventListener('abort', done, { once: true });
});

/** @typedef {Object} FetchResult
 * @property {boolean} ok
 * @property {number} status
 * @property {string} url        final URL after redirects
 * @property {string} contentType
 * @property {'html'|'json'|'xml'|'gzip'|'other'} kind
 * @property {string} body       text body ('' for binary/gzip handled elsewhere)
 * @property {Uint8Array|null} bytes  raw bytes (for gzip/binary)
 * @property {string|null} error
 * @property {boolean} blocked   true if the response looks like a bot challenge
 */

// Headers a caller may NOT set through `o.headers`: identity, session and
// transport headers stay the Fetcher's own (its UA, its cookie jar, no credential).
const RESERVED_HEADER = /^(cookie|authorization|proxy-.*|host|content-length|connection|accept-encoding|user-agent|upgrade-insecure-requests|te|trailer|transfer-encoding|keep-alive|priority|sec-.*|:.*)$/i;

/** Extra request headers (e.g. the ones a listing page sends to its own API), filtered. */
export function extraHeaders(h) {
  const out = {};
  if (!h || typeof h !== 'object') return out;
  for (const [k, v] of Object.entries(h)) {
    if (!k || RESERVED_HEADER.test(k) || v == null || typeof v === 'object') continue;
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(k)) continue;
    out[k] = String(v).replace(/[\r\n]/g, ' ').slice(0, 1024);
  }
  return out;
}

/** Defaults + filtered extras; an extra replaces a default of the same name (any case). */
function withExtraHeaders(base, extra) {
  const add = extraHeaders(extra);
  const out = { ...base };
  for (const k of Object.keys(add)) for (const b of Object.keys(out)) if (b.toLowerCase() === k.toLowerCase()) delete out[b];
  return { ...out, ...add };
}

/**
 * Read a response body up to `maxBytes`. A declared Content-Length above the cap
 * is refused without reading; otherwise the stream is cancelled as soon as the cap
 * is passed. Returns { text, bytes, tooLarge }.
 */
async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) { try { await res.body?.cancel(); } catch { /* ignore */ } return { text: '', bytes: 0, tooLarge: true }; }
  if (!res.body || typeof res.body.getReader !== 'function') { const t = await res.text(); return t.length > maxBytes ? { text: '', bytes: t.length, tooLarge: true } : { text: t, bytes: t.length, tooLarge: false }; }
  const reader = res.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } return { text: '', bytes: total, tooLarge: true }; }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes: total, tooLarge: false };
}

function classify(contentType, url) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('application/json') || ct.includes('+json')) return 'json';
  if (ct.includes('xml') || url.endsWith('.xml')) return 'xml';
  if (ct.includes('gzip') || url.endsWith('.gz')) return 'gzip';
  if (ct.includes('html')) return 'html';
  return 'other';
}

export class Fetcher {
  /** @param {{userAgent?:string, timeoutMs?:number, retries?:number, minDelayMs?:number}} [opts] */
  constructor(opts = {}) {
    this.userAgent = opts.userAgent || DEFAULT_USER_AGENT;
    this.timeoutMs = opts.timeoutMs ?? 20000;
    this.retries = opts.retries ?? 2;
    this.minDelayMs = opts.minDelayMs ?? 500; // polite per-host spacing
    // A 429 is retried after the delay the site asks for, but never a wait longer
    // than this, nor one that ends past the job's deadline (`deadlineAt()`, epoch ms).
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 60000;
    this.deadlineAt = typeof opts.deadlineAt === 'function' ? opts.deadlineAt : () => null;
    // The job's signal: when it aborts (watchdog), the request in flight and any
    // wait end at once, as 'aborted', and nothing is retried.
    this.signal = opts.signal || null;
    // Accept large response header blocks (undici default is 16 KiB → overflow
    // on heavy-header sites). Bounded to avoid unbounded memory from a hostile
    // server. Falls back to the default dispatcher when undici is unavailable.
    this.maxHeaderSize = opts.maxHeaderSize ?? 131072; // 128 KiB
    this._dispatcher = null;
    if (UndiciAgent) {
      try { this._dispatcher = new UndiciAgent({ maxHeaderSize: this.maxHeaderSize }); } catch { this._dispatcher = null; }
    }
    // Run-scoped cookie jar (a Fetcher instance lives for one run, so cookies are
    // naturally shared discovery→extraction and never persisted). Disable with
    // `cookies: false`; inject a shared jar via `cookieJar`.
    this.jar = opts.cookieJar || (opts.cookies === false ? null : new CookieJar());
    // Per-host spacing with reservation: concurrent workers queue one delay apart.
    this.pacer = new HostPacer({ minDelayMs: this.minDelayMs });
    this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 };
  }

  async _throttle(url) {
    // The slot is booked BEFORE waiting, so parallel callers never share one.
    const wait = this.pacer.reserve(url);
    if (wait > 0) await sleepUnless(wait, this.signal);
  }

  /** @param {string} url @param {{accept?:string, asBytes?:boolean, headers?:Object<string,string>, maxBytes?:number}} [o]
   *  `maxBytes`: bounded text read — past the cap the result is { ok:false, error:'too_large', tooLarge:true }.
   *  @returns {Promise<FetchResult>} */
  async get(url, o = {}) {
    let attempt = 0;
    let lastErr = null;
    const abortedResult = () => ({ ok: false, status: 0, url, requestedUrl: url, contentType: '', kind: 'other', body: '', bytes: null, error: 'aborted', blocked: false, block: classifyResponse({ status: 0, error: 'aborted' }) });
    while (attempt <= this.retries) {
      if (this.signal && this.signal.aborted) return abortedResult();
      await this._throttle(url);
      if (this.signal && this.signal.aborted) return abortedResult();
      this.stats.requests++;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      // The deadline covers the whole exchange: headers AND body. A body read is
      // also raced against the abort, so a stalled body cannot hold the run.
      const sig = anySignal([ctrl.signal, this.signal]);
      const aborted = new Promise((_, reject) => { const no = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); if (sig.aborted) no(); else sig.addEventListener('abort', no, { once: true }); });
      aborted.catch(() => { /* only observed through the races below */ });
      const bounded = (p) => Promise.race([p, aborted]);
      try {
        const cookieHeader = this.jar ? this.jar.headerFor(url) : '';
        const res = await fetch(url, {
          redirect: 'follow',
          signal: sig,
          dispatcher: this._dispatcher || undefined, // larger response-header cap (see UndiciAgent above)
          headers: withExtraHeaders({
            'User-Agent': this.userAgent,
            'Accept': o.accept || 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
            'Accept-Language': 'fr-BE,fr;q=0.9,nl-BE;q=0.8,en;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br',
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          }, o.headers),
        });
        // Remember cookies this run received (same-site, non-auth) for later requests.
        if (this.jar) { try { this.jar.setFromResponse(res.url || url, res.headers.getSetCookie?.() || []); } catch { /* ignore */ } }
        const contentType = res.headers.get('content-type') || '';
        const kind = classify(contentType, res.url || url);
        let body = '', bytes = null;
        if (o.maxBytes) {
          // Bounded read (e.g. a script file scanned for API headers): stop reading
          // past the cap instead of downloading the whole file, and say so.
          const read = await bounded(readCapped(res, o.maxBytes));
          this.stats.bytes += read.bytes;
          if (read.tooLarge) {
            clearTimeout(timer);
            this.stats.failed++;
            return { ok: false, status: res.status, url: res.url || url, requestedUrl: url, contentType, kind, body: '', bytes: null, headers: {}, block: classifyResponse({ status: res.status, url: res.url || url, requestedUrl: url, contentType, body: '' }), error: 'too_large', blocked: false, tooLarge: true };
          }
          body = read.text;
        } else if (o.asBytes || kind === 'gzip') {
          const ab = await bounded(res.arrayBuffer());
          bytes = new Uint8Array(ab);
          this.stats.bytes += bytes.length;
        } else {
          body = await bounded(res.text());
          this.stats.bytes += body.length;
        }
        clearTimeout(timer);
        const headers = { 'retry-after': res.headers.get('retry-after') || '' };
        const block = classifyResponse({ status: res.status, url: res.url || url, requestedUrl: url, contentType, body, headers });
        const blocked = block.code !== STATUS.OK && block.code !== STATUS.NOT_A_PRODUCT_PAGE && block.code !== STATUS.JAVASCRIPT_REQUIRED;
        if (blocked) this.stats.blocked++;
        // 429 Too Many Requests: wait what the site asks (Retry-After, else 1 s then
        // 2 s), within maxRetryAfterMs and the job's deadline, then retry. The wait
        // moves the host's next slot, so parallel requests to it wait too.
        if (res.status === 429 && attempt < this.retries) {
          const wait = retryAfterMs(res.headers.get('retry-after')) ?? 1000 * 2 ** attempt;
          const end = this.deadlineAt();
          if (wait <= this.maxRetryAfterMs && !(end && Date.now() + wait > end)) {
            this.pacer.pushBack(url, wait);
            attempt++; continue;
          }
        }
        // Otherwise retry ONLY genuine transient server errors — never a detected
        // challenge or access-deny (retrying those is aggressive + futile).
        if (!res.ok && res.status >= 500 && res.status !== 501 && !block.terminal && attempt < this.retries) {
          attempt++; await sleepUnless(400 * 2 ** attempt, this.signal); continue;
        }
        if (res.ok) this.stats.ok++; else this.stats.failed++;
        return {
          ok: res.ok, status: res.status, url: res.url || url, requestedUrl: url,
          contentType, kind, body, bytes, headers, block,
          error: res.ok ? null : `HTTP ${res.status}`, blocked,
        };
      } catch (err) {
        clearTimeout(timer);
        // Keep the underlying cause code (ECONNRESET, UND_ERR_HEADERS_OVERFLOW,
        // ENOTFOUND, …) so a network failure is diagnosable, not an opaque
        // "fetch failed".
        if (this.signal && this.signal.aborted) return abortedResult();
        lastErr = err?.name === 'AbortError' ? 'timeout'
          : (err?.cause?.code ? `${err?.message || 'fetch failed'} (${err.cause.code})` : (err?.message || String(err)));
        if (attempt < this.retries) { attempt++; await sleepUnless(400 * 2 ** attempt, this.signal); continue; }
        this.stats.failed++;
        return { ok: false, status: 0, url, requestedUrl: url, contentType: '', kind: 'other', body: '', bytes: null, error: lastErr, blocked: false, block: classifyResponse({ status: 0, error: lastErr }) };
      }
    }
    this.stats.failed++;
    return { ok: false, status: 0, url, requestedUrl: url, contentType: '', kind: 'other', body: '', bytes: null, error: lastErr || 'unknown', blocked: false, block: classifyResponse({ status: 0, error: lastErr || 'unknown' }) };
  }

  /** Fetch + gunzip a (possibly gzipped) text resource. Uses native DecompressionStream. */
  async getText(url) {
    const r = await this.get(url, { asBytes: url.endsWith('.gz') });
    if (r.bytes && (r.kind === 'gzip' || url.endsWith('.gz'))) {
      try {
        const ds = new DecompressionStream('gzip');
        const stream = new Response(r.bytes).body.pipeThrough(ds);
        r.body = await new Response(stream).text();
        r.kind = r.body.trimStart().startsWith('<') ? 'xml' : 'other';
      } catch (e) {
        r.error = `gunzip failed: ${e?.message || e}`;
      }
    }
    return r;
  }
}
