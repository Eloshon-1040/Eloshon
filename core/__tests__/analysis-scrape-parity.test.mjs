/**
 * PRODUCT RULE (2b): what the analysis promises, the scrape must deliver.
 * The analysis (probe) and the scrape must use the SAME extraction chain, so a page
 * whose grid lives in a hydration blob (brico's products.collection) yields the SAME
 * products to both. This test runs the probe AND a real controller scrape on the
 * same URL/HTML and FAILS if the scrape delivers fewer products than the analysis
 * detected — the exact "analysis says 54, scrape delivers 0" regression.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../../app/controller.mjs';
import { probeSource } from '../probe.mjs';

const N = 6;
// A brico-shaped listing: the grid lives ONLY in a hydration blob (no JSON-LD, no
// DOM cards) — exactly the shape that used to give the analysis 54 and the scrape 0.
const STATE = { products: { collection: Array.from({ length: N }, (_, k) => ({
  id: String(1000 + k), title: `Radiateur ${k + 1}`, link: `https://shop.example.com/p/rad-${k + 1}/${1000 + k}`,
  image: `https://img/${k}.webp`, ean: `540000000000${k}`, regular: { price: (k + 1) + 0.49 }, currency: 'EUR',
})) }, content: { response: { totalNumberOfResults: N } }, viewSize: 24 };
const GRID = `<html><head><title>Chauffage</title></head><body><h1>Chauffage</h1><script>window.__X=${JSON.stringify(STATE)}</script></body></html>`;

function buildMap() {
  const m = { 'https://shop.example.com/robots.txt': { body: '' }, 'https://shop.example.com/c/heat': { body: GRID } };
  for (let k = 0; k < N; k++) m[`https://shop.example.com/p/rad-${k + 1}/${1000 + k}`] = { body: '<html><body>fiche shell (SPA)</body></html>' };
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
const mkDirs = () => ensureDirs(appDirs(fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-parity-'))));

// ── Reverse direction: what the SCRAPE delivers, the analysis must not deny. ──
// Entry 404s, but the site's sitemap carries same-language fiches the scrape
// delivers via its sitemap complement. If the analysis calls such a site
// 'unreachable'/'no-signal' while the scrape delivers N≥2 products, parity is
// broken (the pre-fallback probe did exactly that).
const M = 3;
const FICHE_URL = (k) => `https://shop.example.com/fr/produits/cafe-${k + 1}`;
const FICHE_HTML = (k) => '<html><body><script type="application/ld+json">'
  + JSON.stringify({ '@type': 'Product', name: `Café moulu ${k + 1}`, offers: { price: String(3 + k), priceCurrency: 'EUR' }, gtin13: `540000000000${k}`, image: `https://img/${k}.webp` })
  + `</script><p>${'contenu produit lisible '.repeat(30)}</p></body></html>`;

function buildDeadEntryMap() {
  const m = {
    'https://shop.example.com/robots.txt': { body: 'Sitemap: https://shop.example.com/sitemap.xml' },
    'https://shop.example.com': { body: '<html><body><main>' + 'accueil sans produit '.repeat(80) + '</main></body></html>' },
    'https://shop.example.com/sitemap.xml': { body: '<?xml version="1.0"?><urlset>'
      + Array.from({ length: M }, (_, k) => `<url><loc>${FICHE_URL(k)}</loc></url>`).join('') + '</urlset>' },
    // the pasted collection URL itself is DEAD (404 — non-terminal)
  };
  for (let k = 0; k < M; k++) m[FICHE_URL(k)] = { body: FICHE_HTML(k) };
  return m;
}

test('parity (reverse): an entry the analysis cannot fetch is NOT unreachable when the scrape still delivers', async () => {
  const entry = 'https://shop.example.com/fr/produits?page=1';

  // 1) Scrape — the real controller flow: 404 entry, sitemap complement delivers.
  const dirs = mkDirs();
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 2, recovery: false, maxProducts: 100 }), 'utf8');
  const ctrl = createController({ dirs });
  await ctrl.start({ origin: entry, store: 'demo', browser: false, fetcher: new Mock(buildDeadEntryMap()) });
  const j = ctrl.listJobs()[0];
  assert.ok(j.products >= 2, `the scrape chain delivers despite the dead entry — got ${j.products}`);

  // 2) Analysis on the SAME site: parity forbids unreachable/no-signal here.
  const p = await probeSource(entry, { fetcher: new Mock(buildDeadEntryMap()) });
  assert.ok(!['unreachable', 'no-signal'].includes(p.diagnosis),
    `the scrape delivered ${j.products} product(s); the analysis may not say '${p.diagnosis}'`);
  assert.equal(p.diagnosis, 'ok', 'the sitemap-fiche fallback measures real coverage');
  assert.ok((p.sample_url || '').includes('/fr/'), `the sampled fiche keeps the entry language, got ${p.sample_url}`);
});

test('analysis↔scrape parity: an embedded grid the analysis detects is DELIVERED by the scrape', async () => {
  const origin = 'https://shop.example.com/c/heat';

  // 1) Analysis (probe) — the same extractEmbeddedProducts the UI verdict is built on.
  const p = await probeSource(origin, { fetcher: new Mock(buildMap()) });
  assert.ok(['embedded', 'listing'].includes(p.best_path), `analysis found the embedded grid (best_path=${p.best_path})`);
  const promised = p.product_count;
  assert.ok(promised >= N, `analysis promises the products (got ${promised})`);

  // 2) Scrape — the real controller flow on the SAME URL.
  const dirs = mkDirs();
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 2, recovery: false, maxProducts: 100 }), 'utf8');
  const ctrl = createController({ dirs });
  await ctrl.start({ origin, store: 'demo', browser: false, fetcher: new Mock(buildMap()) });
  const j = ctrl.listJobs()[0];

  // THE RULE: the scrape delivers what the analysis promised (no silent 0).
  assert.ok(j.products >= N, `scrape delivered the analysis-promised products — got ${j.products}, promised ${promised}`);
  assert.notEqual(j.products, 0, 'the analysis-says-N / scrape-delivers-0 regression must never return');
});
