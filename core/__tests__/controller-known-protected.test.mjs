/**
 * KNOWN-PROTECTED short-circuit (Levi's 10-minute-hang fix): a host the domain
 * profile already learned needs the paid unlock (needsUnlock, no free recipe) must
 * NOT be re-explored for free. The free ladder would render every sitemap URL
 * through the browser — each blocked — for minutes. Instead: ONE cheap HTTP probe;
 * if it still classifies as a terminal block, discovery + scrape are skipped and the
 * run ends blocked with the unlock offer. Generic: driven by the learned profile.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../../app/controller.mjs';

// Fetcher that always returns a terminal 403 (DataDome/anti-bot style) and counts
// every call — discovery/scrape would hit it many times; the short-circuit once.
class Blocked403 {
  constructor() { this.calls = []; this.userAgent = 't'; }
  async get(u) { this.calls.push(u); return { ok: false, status: 403, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: '<html><head><title>Access Denied</title></head><body>403</body></html>', bytes: null, headers: {}, error: null, blocked: true }; }
  async getText(u) { return this.get(u); }
}
const mkDirs = () => ensureDirs(appDirs(fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-known-protected-'))));

test('controller: a known-needsUnlock host is routed straight to unlock (one probe, no free re-exploration)', async () => {
  const dirs = mkDirs();
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: true, maxProducts: 100, maxBrowser: 40 }), 'utf8');
  const origin = 'https://shop.protected.example/c/jeans';

  // Seed the domain profile: this host is known to need the paid unlock, no recipe.
  fs.writeFileSync(path.join(dirs.data, 'domain-profiles.json'), JSON.stringify({
    'shop.protected.example': { needsUnlock: true, blockedBy: 'ACCESS_DENIED', needsBrowser: true, runs: 2, lastProductCount: 0 },
  }), 'utf8');

  const events = [];
  const fetcher = new Blocked403();
  // A browser that would render (and waste minutes) if ever reached — asserts it is NOT.
  let renders = 0;
  const getBrowser = async () => ({ render: async () => { renders++; return { html: '<html>challenge</html>' }; }, collectListing: async () => { renders++; return { html: '<html>challenge</html>', links: [], cards: [], pageLinks: [] }; }, close: async () => {} });

  const ctrl = createController({ dirs, emit: (type, payload) => events.push({ type, payload }) });
  await ctrl.start({ origin, store: 'demo', browser: true, fetcher, getBrowser });

  // ONE HTTP probe only — the free ladder (origin + sitemaps + crawl + per-URL
  // browser renders) never ran.
  assert.equal(fetcher.calls.length, 1, `expected a single probe, got ${fetcher.calls.length}: ${fetcher.calls.join(', ')}`);
  assert.equal(renders, 0, 'the browser was never invoked for a known-protected host');

  const j = ctrl.listJobs()[0];
  assert.equal(j.products, 0, 'no products (site is blocked) — but fast, not after minutes');

  const done = events.find((e) => e.type === 'done');
  assert.ok(done, 'a done event was emitted');
  assert.ok(String(done.payload.status).startsWith('stopped:'), `blocked status, got ${done.payload.status}`);
  assert.equal(done.payload.diagnosis, 'needs-unlock', 'diagnosis routes to unlock');
  assert.ok(done.payload.blocked && done.payload.blocked.code === 'ACCESS_DENIED', 'blocked reason preserved');
});

test('controller: a known-needsUnlock host that has re-opened falls through to the free ladder', async () => {
  const dirs = mkDirs();
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 100, maxBrowser: 2 }), 'utf8');
  const origin = 'https://shop.reopened.example/c/jeans';
  fs.writeFileSync(path.join(dirs.data, 'domain-profiles.json'), JSON.stringify({
    'shop.reopened.example': { needsUnlock: true, blockedBy: 'ACCESS_DENIED', runs: 2 },
  }), 'utf8');

  // Probe now returns 200 OK with a real product listing → NOT terminal → the free
  // ladder must run (proving the short-circuit is conditional, not permanent).
  const html = '<html><body><a href="/p/jean-a">Jean A</a><script type="application/ld+json">{"@type":"Product","name":"Jean A","offers":{"price":"39.90","priceCurrency":"EUR"}}</script></body></html>';
  class OK {
    constructor() { this.calls = []; this.userAgent = 't'; }
    async get(u) { this.calls.push(u); return { ok: true, status: 200, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: html, bytes: html.length, headers: {}, error: null, blocked: false }; }
    async getText(u) { return this.get(u); }
  }
  const fetcher = new OK();
  const ctrl = createController({ dirs });
  await ctrl.start({ origin, store: 'demo', browser: false, fetcher });

  assert.ok(fetcher.calls.length > 1, `the free ladder ran (more than the single probe): ${fetcher.calls.length} calls`);
});
