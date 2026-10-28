/**
 * Headless check of the GUI controller: start → progress/product/counters/done,
 * CSV written to a temp app-data dir. No Electron, no network, no Luna.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, ensureDirs } from '../lib/osenv.mjs';
import { createController } from '../app/controller.mjs';
import { createProviderRegistry } from '../app/providers/index.mjs';

// Provider registry basics.
const reg = createProviderRegistry();
assert.equal(reg.manual.isConfigured(), true, 'manual always available');
assert.equal(reg.twocaptcha.isConfigured(), false, 'twocaptcha not configured');
console.log('✓ providers: manual=available, twocaptcha=not-configured');

// Temp app-data dir (never the repo).
const dirs = ensureDirs(appDirs(fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-verify-'))));

const productHtml = (seg) => `<html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'Product', name: 'Widget ' + seg, sku: seg,
  offers: { '@type': 'Offer', price: '4.50', priceCurrency: 'EUR' },
})}</script></head><body>ok</body></html>`;

const fetcher = {
  userAgent: 'Eloshon-Scraper/1.0', stats: {},
  async get(url) { const seg = url.split('/').pop(); return { ok: true, status: 200, url, requestedUrl: url, body: productHtml(seg), error: null, headers: {}, kind: 'html' }; },
};

const events = [];
const ctrl = createController({ dirs, emit: (t, p) => events.push({ t, p }) });

const { jobId } = await ctrl.start({
  urls: ['https://shop.example.com/p/aaa', 'https://shop.example.com/p/bbb'],
  store: 'demo-source', browser: false, fetcher,
});

const done = events.find((e) => e.t === 'done');
assert.ok(done, "a 'done' event was emitted");
assert.equal(done.p.counts.accepted, 2, 'two products accepted (generic profile)');
assert.ok(fs.existsSync(done.p.csvPath), 'CSV written');
const csv = fs.readFileSync(done.p.csvPath, 'utf8').trim().split(/\r?\n/);
assert.equal(csv.length, 3, 'CSV = header + 2 rows');
assert.ok(done.p.csvPath.startsWith(dirs.data), 'CSV lives under app-data, not the repo');
console.log('✓ controller: start → 2 products → accepted → CSV in app-data');

// Jobs listing sees the run.
const jobs = ctrl.listJobs();
assert.ok(jobs.find((j) => j.id === jobId), 'job appears in listJobs');
console.log('✓ jobs: run listed (' + jobs.length + ' job)');

fs.rmSync(dirs.userData, { recursive: true, force: true });
console.log('\nCONTROLLER OK — events:', [...new Set(events.map((e) => e.t))].join(', '));
