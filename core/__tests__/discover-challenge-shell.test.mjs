/**
 * Challenge-shell early-stop (Levi's 10-minute-hang fix, discovery layer): a
 * first-visit protected site (no profile yet) whose browser render returns a tiny
 * shell — no links, no cards — but advertises pagination would, without a guard,
 * keep queuing and re-rendering that same wall up to maxBrowserPages (dozens of
 * ~15s renders = minutes). The guard stops after 2 empty renders and routes to
 * unlock. Offline (mock fetcher + fake browser), no site.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverProducts } from '../discover.mjs';

const ORIGIN = 'https://www.wall.example/c/cat';
// A reachable 200 listing with NO product links → client-rendered → recovery never
// runs → the CSR browser fallback fires (unknown first visit, no profile).
const csrShell = { status: 200, body: '<html><head><title>Cat</title></head><body><div id="app"></div></body></html>' };

class Mock {
  constructor(map) { this.map = map; this.userAgent = 't'; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; }
  async get(u) {
    this.stats.requests++;
    const e = this.map[u] || { status: 404, body: '' };
    const ok = (e.status ?? 200) >= 200 && (e.status ?? 200) < 300;
    return { ok, status: e.status ?? 200, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: e.body ?? '', bytes: null, headers: {}, error: null, blocked: false };
  }
  async getText(u) { return this.get(u); }
}

test('a bot-wall render (0 links, 0 cards) yields no products and is diagnosed for unlock — not a bare 0', async () => {
  const f = new Mock({ [ORIGIN]: csrShell });
  let renders = 0;
  // A DataDome-style shell: the render returns a tiny wall — no links, no cards. The
  // queue drains after one render; without the wall diagnosis this would report a
  // bare, unexplained "0 products" instead of routing to the paid unlock.
  const fb = {
    async collectListing() {
      renders++;
      return { html: '<html><body>Access Denied</body></html>', links: [], cards: [], pageLinks: [], blocked: null };
    },
  };
  const { urls, report } = await discoverProducts(f, ORIGIN, { recovery: true, getBrowser: async () => fb, maxBrowserPages: 40 });

  assert.ok(renders <= 2, `did not re-render the wall dozens of times (got ${renders})`);
  assert.equal(urls.length, 0, 'a bot wall yields no products');
  assert.ok(report.stopped && report.stopped.code === 'JAVASCRIPT_REQUIRED', `routed to unlock, got ${JSON.stringify(report.stopped)}`);
  assert.equal(report.diagnosis, 'blocked', 'a set terminal stop is classified blocked (unlock offered)');
});

test('a paginated wall (fakes pageLinks but never yields products) stops after 2 empty renders, then diagnoses', async () => {
  const f = new Mock({ [ORIGIN]: csrShell });
  let renders = 0;
  // A trickier wall that advertises pagination on every empty render — unguarded this
  // would keep the queue full and re-render up to maxBrowserPages (dozens × ~12s).
  const fb = {
    async collectListing() {
      renders++;
      return { html: '<html><body>checking your browser</body></html>', links: [], cards: [], pageLinks: [`${ORIGIN}?page=2`, `${ORIGIN}?page=3`], blocked: null };
    },
  };
  const { urls, report } = await discoverProducts(f, ORIGIN, { recovery: true, getBrowser: async () => fb, maxBrowserPages: 40 });

  assert.ok(renders <= 2, `stopped after 2 empty renders, not up to 40 (got ${renders})`);
  assert.equal(urls.length, 0);
  assert.ok(report.stopped && report.stopped.code === 'JAVASCRIPT_REQUIRED', `routed to unlock, got ${JSON.stringify(report.stopped)}`);
});
