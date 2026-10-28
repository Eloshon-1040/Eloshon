/**
 * 4d — a per-page render budget. A single stubborn page (an anti-bot that stalls
 * the browser) must never hold the whole run: renderBounded caps EACH render with
 * a wall-clock race, so the pool moves on and the page is counted as a render
 * timeout. Generic — a time bound, not a site rule. Offline: mock fetcher + a
 * browser session whose render() hangs forever.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScrape } from '../engine.mjs';

class Mock {
  constructor(map) { this.map = map; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(u) {
    this.stats.requests++;
    const e = this.map[u] || { status: 404, body: '' };
    const status = e.error ? 0 : (e.status ?? 200);
    const ok = !e.error && status >= 200 && status < 300;
    if (ok) this.stats.ok++; else this.stats.failed++;
    return { ok, status, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: e.body ?? '', bytes: null, headers: {}, error: e.error ?? null, blocked: false };
  }
}
// A JSON-LD fiche with a NAME but NO price → the engine tries a single browser
// render to complete it (config.recovery), which is where the budget applies.
const nameOnly = (name) => `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"${name}"}</script>`;

test('a render that hangs is capped by the budget; the run still finishes and counts a timeout', async () => {
  const u = 'https://s.com/product/slow';
  const hangingSession = { calls: 0, async render() { this.calls++; return new Promise(() => {}); /* never resolves */ } };
  const t0 = Date.now();
  const products = [];
  const { report } = await runScrape({
    store: { slug: 't' }, urls: [u], fetcher: new Mock({ [u]: { body: nameOnly('Machine sans prix') } }),
    concurrency: 1, lang: 'fr', recovery: true,
    browserSession: hangingSession, useBrowser: true,
    renderTimeoutMs: 400, // tiny budget for the test
    onProduct: (p) => products.push(p),
  });
  const elapsed = Date.now() - t0;
  assert.equal(hangingSession.calls, 1, 'the browser render was attempted');
  assert.ok(elapsed < 5000, `run must not hang on the render (took ${elapsed}ms)`);
  assert.equal(report.renderTimeouts, 1, 'the timed-out render is counted');
  // The incomplete product (name, no price) is still kept — never lost to the timeout.
  assert.equal(products.length, 1);
  assert.equal(products[0].price, null);
});
