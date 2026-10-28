/**
 * Proves Settings → New-Scraping override → Engine wiring.
 * Priority per field: New-Scraping value → saved Settings default → core DEFAULTS.
 * No network, no Electron.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, DEFAULTS } from '../core/config.mjs';
import { appDirs, ensureDirs } from '../lib/osenv.mjs';
import { createController, resolveOverrides } from '../app/controller.mjs';

// 1) resolveOverrides — priority, 0-honored, invalid ignored, key names
let o = resolveOverrides({ maxProducts: 500, rateLimitMs: 1000 }, {});
assert.equal(o.maxProducts, 500); assert.equal(o.rateLimitMs, 1000); assert.equal(o.maxPages, undefined);
o = resolveOverrides({ maxProducts: 500 }, { maxProducts: 50 });
assert.equal(o.maxProducts, 50, 'per-run override wins');
o = resolveOverrides({}, { maxProducts: 0 });
assert.equal(o.maxProducts, 0, '0 is honored, not treated as falsy');
o = resolveOverrides({ maxProducts: 'abc', workers: null }, {});
assert.equal(o.maxProducts, undefined); assert.equal(o.workers, undefined, 'invalid/absent → undefined');
console.log('✓ resolveOverrides: settings-default / per-run override / 0 honored / invalid→undefined');

// 2) Final engine config via loadConfig (DEFAULTS as ultimate fallback)
assert.equal(loadConfig(resolveOverrides({}, {})).maxProducts, DEFAULTS.maxProducts, 'no settings → DEFAULTS');
assert.equal(loadConfig(resolveOverrides({ maxProducts: 500 }, {})).maxProducts, 500, 'settings → default');
assert.equal(loadConfig(resolveOverrides({ maxProducts: 500 }, { maxProducts: 50 })).maxProducts, 50, 'override wins');
assert.equal(loadConfig(resolveOverrides({ rateLimitMs: 1000 }, {})).rateLimitMs, 1000);
assert.equal(loadConfig(resolveOverrides({}, {})).rateLimitMs, DEFAULTS.rateLimitMs);
console.log('✓ final config: DEFAULTS fallback + settings-as-default + per-run override');

// 3) Integration — settings persisted on disk are read at start and reach the engine
const dirs = ensureDirs(appDirs(fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-set-'))));
fs.writeFileSync(dirs.configFile, JSON.stringify({ maxProducts: 500, maxPages: 100, maxDepth: 3, rateLimitMs: 1000, retries: 3, workers: 2, maxBrowser: 5, lang: 'fr' }));
const html = (seg) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: 'W ' + seg, sku: seg, offers: { '@type': 'Offer', price: '4.50', priceCurrency: 'EUR' } })}</script></head><body>ok</body></html>`;
const fetcher = { userAgent: 't', stats: {}, async get(u) { const seg = u.split('/').pop(); return { ok: true, status: 200, url: u, requestedUrl: u, body: html(seg), error: null, headers: {}, kind: 'html' }; } };
let started = null;
const ctrl = createController({ dirs, emit: (t, p) => { if (t === 'started') started = p; } });

await ctrl.start({ urls: ['https://x/p/aa', 'https://x/p/bb'], store: 'set-test', browser: false, fetcher });
assert.ok(started && started.config, "started event carries the effective engine config");
assert.equal(started.config.maxProducts, 500, 'persisted setting reached the engine (reload-safe: read from disk)');
assert.equal(started.config.workers, 2);
assert.equal(started.config.rateLimitMs, 1000);
console.log('✓ persisted Settings (on disk) → read at start → reach the engine');

// 4) per-run override on top of persisted settings — only that field changes
started = null;
await ctrl.start({ urls: ['https://x/p/cc'], store: 'set-test', browser: false, fetcher, limits: { maxProducts: 50 } });
assert.equal(started.config.maxProducts, 50, 'New-Scraping override wins for that field');
assert.equal(started.config.workers, 2, 'other fields stay from Settings');
assert.equal(started.config.rateLimitMs, 1000, 'other Settings retained');
console.log('✓ New-Scraping override wins per field; other Settings retained');

fs.rmSync(dirs.userData, { recursive: true, force: true });
console.log('\nSETTINGS OK');
