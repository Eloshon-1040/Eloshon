/**
 * Recipe producer + reuse loop (2b) through the REAL controller, NO AI:
 *  Run 1 — a fresh site is discovered the normal way; the PRODUCER derives a
 *          manual_selectors recipe from the listing and stores it in the profile.
 *  Run 2 — the stored recipe is REPLAYED directly (dom-selectors), before any
 *          discovery; the per-product fiche fetches never happen again.
 * Headless, temp app-data, mock fetcher (browser disabled).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../../app/controller.mjs';

const N = 6;
const fiche = (i) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: `Tool ${i}`, sku: `T${i}`, offers: { price: String(i + 0.5), priceCurrency: 'EUR' } })}</script></head><body></body></html>`;
const cardHtml = (i) => `<li class="pc mozaic"><a class="t" href="https://shop.example.com/p/tool-${i}.html">Tool ${i}</a><img class="im" src="/i/${i}.jpg"><span class="pr">${i},50 €</span></li>`;
const GRID = `<html><head><title>Tools</title></head><body><h1>Outillage</h1>`
  + `<p>${'produits en stock '.repeat(8)}</p><ul class="grid">${Array.from({ length: N }, (_, k) => cardHtml(k + 1)).join('')}</ul>`
  + `<a rel="next" href="https://shop.example.com/c/tools?p=2">Suivant</a></body></html>`;

function buildMap() {
  const m = {
    'https://shop.example.com/robots.txt': { body: '' },
    'https://shop.example.com/c/tools': { body: GRID },
    'https://shop.example.com/c/tools?p=2': { body: '<html><body><ul class="grid"></ul></body></html>' }, // empty page 2 → stop
  };
  for (let i = 1; i <= N; i++) m[`https://shop.example.com/p/tool-${i}.html`] = { body: fiche(i) };
  return m;
}
class Mock {
  constructor(map) { this.map = map; this.calls = []; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(u) {
    this.calls.push(u); this.stats.requests++;
    const e = this.map[u] || { status: 404 };
    const status = e.error ? 0 : (e.status ?? 200); const ok = !e.error && status >= 200 && status < 300;
    if (ok) this.stats.ok++; else this.stats.failed++;
    return { ok, status, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: e.body ?? '', bytes: null, headers: {}, error: e.error ?? null, blocked: false };
  }
  async getText(u) { return this.get(u); }
}
const mkDirs = () => ensureDirs(appDirs(fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-prod-'))));
const profilesOf = (dirs) => { try { return JSON.parse(fs.readFileSync(path.join(dirs.data, 'domain-profiles.json'), 'utf8')); } catch { return {}; } };

test('producer loop: run 1 discovers + stores a manual_selectors recipe; run 2 replays it free (no fiche fetches)', async () => {
  const dirs = mkDirs();
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 2, recovery: false, maxProducts: 100 }), 'utf8');
  const origin = 'https://shop.example.com/c/tools';

  // ── Run 1: fresh site, no recipe → normal discovery + PRODUCER stores the recipe.
  const f1 = new Mock(buildMap());
  const ctrl1 = createController({ dirs });
  await ctrl1.start({ origin, store: 'demo', browser: false, fetcher: f1 });
  const j1 = ctrl1.listJobs()[0];
  assert.ok(j1.products >= 3, `run 1 produced products (got ${j1.products})`);

  const prof = profilesOf(dirs)['shop.example.com'];
  assert.ok(prof && prof.manual_selectors, 'run 1 stored a manual_selectors recipe');
  assert.equal(prof.manual_selectors.card, '.pc.mozaic');
  assert.equal(prof.manual_selectors.fields.name.selector, '.t');
  assert.equal(prof.manual_selectors.fields.price.selector, '.pr');
  assert.equal(prof.manualSelectorsMeta.status, 'candidate');

  // ── Run 2: the recipe is replayed BEFORE discovery — no per-product fiche fetch.
  const f2 = new Mock(buildMap());
  const ctrl2 = createController({ dirs });
  await ctrl2.start({ origin, store: 'demo', browser: false, fetcher: f2 });
  const j2 = ctrl2.listJobs()[0];
  assert.equal(j2.status, 'done');
  assert.ok(j2.products >= N, `run 2 replayed the catalogue (got ${j2.products})`);

  // v0.5.18: after a listing lane, product pages are visited ONLY to complete the
  // rows (colour, sizes, EAN, gallery…), sample-first: these fiches add nothing
  // significant, so visiting stops after the sample (3) — no re-discovery.
  const ficheFetches = f2.calls.filter((u) => /\/p\/tool-\d+\.html/.test(u));
  assert.ok(ficheFetches.length <= 3, `run 2 did not re-scrape every fiche — at most the completion sample (got ${ficheFetches.length})`);

  // The replay success bumped the recipe lifecycle.
  assert.equal(profilesOf(dirs)['shop.example.com'].manualSelectorsMeta.success_count, 1);
});

test('real progress: the engine emits `step` events during discovery (not a frozen 0/0)', async () => {
  const dirs = mkDirs();
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 100 }), 'utf8');
  const origin = 'https://shop.example.com/c/tools';
  const events = [];
  const ctrl = createController({ dirs, emit: (type, payload) => events.push({ type, payload }) });
  await ctrl.start({ origin, store: 'demo', browser: false, fetcher: new Mock(buildMap()) });
  const steps = events.filter((e) => e.type === 'step' && e.payload && e.payload.code);
  assert.ok(steps.length >= 1, `discovery streamed real step messages (got ${steps.length})`);
  assert.ok(steps.some((s) => ['analyze','crawl','sitemap','noSitemap','recipeCheck'].includes(s.payload.code)), 'steps carry stable codes for the actual discovery work');
});
