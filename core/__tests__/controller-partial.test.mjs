/**
 * Honest job outcomes through the real controller (app/controller.mjs):
 *  1. a source blocked MID-RUN still delivers the products collected before the
 *     block (they were being thrown away when finalization was skipped on error);
 *  2. a discovery that is blocked and finds nothing ends as `stopped:<code>` with
 *     a human `reason` + `diagnosis` — never a misleading "done" or bare "error".
 * Headless, temp app-data, mock fetcher, browser disabled.
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
    return { ok, status, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: e.body ?? '', bytes: null, headers: {}, error: e.error ?? null, blocked: false };
  }
  async getText(u) { return this.get(u); }
}
const mkDirs = () => ensureDirs(appDirs(fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-part-'))));

test('controller: a source blocked mid-run still delivers the products already collected', async () => {
  const dirs = mkDirs();
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false }), 'utf8');
  const origin = 'https://shop.example.com/c/jeans';
  const fetcher = new Mock({
    [origin]: catalogue(['https://shop.example.com/p/a', 'https://shop.example.com/p/b']),
    'https://shop.example.com/p/a': { body: productHtml('Chaise', 49) },
    'https://shop.example.com/p/b': CHALLENGE, // terminal block AFTER a is extracted
  });
  try {
    const ctrl = createController({ dirs });
    await ctrl.start({ origin, store: 'demo', browser: false, fetcher });
    const j = ctrl.listJobs()[0];
    assert.equal(j.products, 1, 'the product collected before the block is kept');
    assert.ok(String(j.status).startsWith('stopped'), `status should reflect the block, got ${j.status}`);
    // Point 3: the user-facing reason explains the block in plain words and NEVER
    // leaks the raw code / HTTP status (the technical code stays in report.json).
    assert.ok(j.reason && /protégé|robot|refusé|injoignable/i.test(j.reason), `reason explains the block in plain words: ${j.reason}`);
    assert.ok(!/BOT_CHALLENGE|ACCESS_DENIED|HTTP\s*\d{3}/.test(j.reason), `no raw code leaked: ${j.reason}`);
    // partial delivery: a CSV exists somewhere under the job's csv dir
    assert.ok(fs.readdirSync(path.join(dirs.data, 'csv')).some((f) => f.endsWith('.csv')), 'a CSV was written (partial delivery)');
  } finally { fs.rmSync(dirs.userData, { recursive: true, force: true }); }
});

test('controller: a run records a domain profile (method + product count), consultable next time', async () => {
  const dirs = mkDirs();
  const origin = 'https://shop.test/c/jeans';
  const fetcher = new Mock({
    [origin]: catalogue(['https://shop.test/p/a', 'https://shop.test/p/b']),
    'https://shop.test/p/a': { body: productHtml('Chaise', 49) },
    'https://shop.test/p/b': { body: productHtml('Tabouret', 19) },
  });
  try {
    const ctrl = createController({ dirs });
    await ctrl.start({ origin, store: 'demo', browser: false, fetcher });
    const p = ctrl.domainProfiles()['shop.test'];
    assert.ok(p, 'a profile was recorded for the host');
    assert.ok(p.lastProductCount >= 1, `product count remembered (${p.lastProductCount})`);
    assert.ok(p.method, 'discovery method remembered');
    assert.ok(p.runs >= 1);
    assert.ok(typeof p.updatedAt === 'string');
  } finally { fs.rmSync(dirs.userData, { recursive: true, force: true }); }
});

test('controller.unlockStatus: reflects the setting + reports a safe availability shape', async () => {
  const dirs = mkDirs();
  try {
    const ctrl = createController({ dirs });
    let s = await ctrl.unlockStatus();
    assert.equal(s.enabled, false);                 // opt-in, off by default
    assert.equal(typeof s.chromeFound, 'boolean');
    assert.equal(typeof s.ready, 'boolean');        // never throws even if python/nodriver absent
    fs.writeFileSync(dirs.configFile, JSON.stringify({ unlock: true }), 'utf8');
    s = await ctrl.unlockStatus();
    assert.equal(s.enabled, true);                  // toggle persisted in config is reflected
  } finally { fs.rmSync(dirs.userData, { recursive: true, force: true }); }
});

test('controller: a blocked discovery → status stopped:<code> + reason + diagnosis (not "done")', async () => {
  const dirs = mkDirs();
  fs.writeFileSync(dirs.configFile, JSON.stringify({ recovery: false }), 'utf8');
  const origin = 'https://blocked.example.com/c/x';
  const fetcher = new Mock({
    'https://blocked.example.com/robots.txt': CHALLENGE,
    [origin]: CHALLENGE,
  });
  try {
    const ctrl = createController({ dirs });
    await ctrl.start({ origin, store: 'demo', browser: false, fetcher });
    const j = ctrl.listJobs()[0];
    assert.equal(j.products, 0);
    assert.ok(String(j.status).startsWith('stopped'), `blocked discovery should be stopped, got ${j.status}`);
    assert.equal(j.diagnosis, 'blocked');
    assert.ok(j.reason && j.reason.length > 0, 'a human reason is present');
  } finally { fs.rmSync(dirs.userData, { recursive: true, force: true }); }
});
