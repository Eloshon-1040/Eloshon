/**
 * GUI wiring: the recovery ladder (F1/F2 + F3.1 browser escalation) is reachable
 * from the real application path (app/controller.mjs), not just from tests.
 *
 * Before this wiring `recovery` was never passed to discoverProducts()/runScrape(),
 * so F2/F3.1 were dormant in the GUI. These tests drive the ACTUAL controller
 * (headless, temp app-data, mock fetcher, browser disabled) and assert recovery
 * runs end-to-end, and that a user can still turn it OFF via config.json.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../../app/controller.mjs';

const ld = (o) => `<html><head><script type="application/ld+json">${JSON.stringify(o)}</script></head><body></body></html>`;
const productHtml = (name, price) => ld({ '@type': 'Product', name, offers: { price: String(price), priceCurrency: 'EUR' } });
const SHELL = '<html><body><div id="root"></div></body></html>';                 // JS shell (needsBrowser) → recovery target
const CHALLENGE = { status: 403, body: '<html><head><title>Just a moment...</title></head><body>Checking your browser. /cdn-cgi/challenge-platform ray id</body></html>' };
const catalogue = (links) => ({ status: 200, body:
  `<html><head><title>Cat</title></head><body><h1>Catalogue</h1><p>${'produits en stock '.repeat(8)}</p>`
  + links.map((h) => `<a href="${h}">Voir le produit</a>`).join('') + '</body></html>' });

class Mock {
  constructor(map) { this.map = map; this.calls = []; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(u) {
    this.calls.push(u); this.stats.requests++;
    const e = this.map[u] || { status: 404, body: '' };
    const status = e.error ? 0 : (e.status ?? 200);
    const ok = !e.error && status >= 200 && status < 300;
    if (ok) this.stats.ok++; else this.stats.failed++;
    return { ok, status, url: e.finalUrl || u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: e.body ?? '', bytes: null, headers: e.headers || {}, error: e.error ?? null, blocked: false };
  }
  async getText(u) { return this.get(u); }
}
const mkDirs = () => ensureDirs(appDirs(fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-rec-'))));

test('GUI: recovery ON by default → F2 extraction recovery runs through the controller', async () => {
  const dirs = mkDirs();
  const url = 'https://www.shop.example.com/p/1';
  const fetcher = new Mock({ [url]: { body: SHELL }, 'https://m.shop.example.com/p/1': { body: productHtml('Chaise', 49) }, 'https://shop.example.com/p/1': { status: 404 } });
  try {
    const ctrl = createController({ dirs });
    const { report } = await ctrl.start({ urls: [url], store: 'demo', browser: false, fetcher });
    assert.equal(report.recovered, 1);   // recovery reached runScrape from the real GUI path
    assert.equal(report.detected, 1);    // SHELL rescued via the mobile twin (HTTP-only)
  } finally { fs.rmSync(dirs.userData, { recursive: true, force: true }); }
});

test('GUI: recovery can be turned OFF via config.json (OFF remains possible)', async () => {
  const dirs = mkDirs();
  fs.writeFileSync(dirs.configFile, JSON.stringify({ recovery: false }), 'utf8');
  const url = 'https://www.shop.example.com/p/1';
  const fetcher = new Mock({ [url]: { body: SHELL }, 'https://m.shop.example.com/p/1': { body: productHtml('Chaise', 49) }, 'https://shop.example.com/p/1': { status: 404 } });
  try {
    const ctrl = createController({ dirs });
    const { report } = await ctrl.start({ urls: [url], store: 'demo', browser: false, fetcher });
    assert.equal(report.recovered || 0, 0);  // recovery did not run
    assert.equal(report.detected, 0);        // SHELL + no browser + no recovery → nothing (previous behaviour)
  } finally { fs.rmSync(dirs.userData, { recursive: true, force: true }); }
});

test('GUI: recovery reaches discovery too (blocked catalogue recovered via alternative representation)', async () => {
  const dirs = mkDirs();
  const origin = 'https://www.shop.example.com/c/cat';
  const fetcher = new Mock({
    [origin]: CHALLENGE,
    'https://m.shop.example.com/c/cat': CHALLENGE,
    'https://shop.example.com/c/cat': catalogue(['https://shop.example.com/p/a', 'https://shop.example.com/p/b']),
    'https://shop.example.com/p/a': { body: productHtml('Produit A', 10) },
    'https://shop.example.com/p/b': { body: productHtml('Produit B', 12) },
  });
  try {
    const ctrl = createController({ dirs });
    const { report } = await ctrl.start({ origin, store: 'demo', browser: false, fetcher });
    assert.equal(report.discovery.recovered, 1); // discovery recovery reached from the real GUI path
    assert.equal(report.detected, 2);            // both products discovered + extracted
  } finally { fs.rmSync(dirs.userData, { recursive: true, force: true }); }
});
