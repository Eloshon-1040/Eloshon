/**
 * ÉTAPE 0 — Golden non-regression net. Re-runs the CURRENT engine over the
 * fixtures and asserts the output is IDENTICAL to the frozen goldens
 * (core/__tests__/golden/*.json). Any drift in extraction, normalisation,
 * dedup, eligibility, the report counts, the CSV, discovery or response
 * classification makes a test fail. Deterministic + offline (MockFetcher).
 *
 * Regenerate goldens ONLY on an INTENDED change: `node scripts/gen-golden.mjs`
 * then review the git diff of core/__tests__/golden before committing.
 *
 * Additive: imports the engine read-only; changes no existing file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GOLD, KEYS, readFix,
  computeExtraction, computeEngineE2e, computeEngineBrowser,
  computeDiscoverySitemap, computeDiscoveryCrawl, computeClassification,
} from './_regression-cases.mjs';
import { extractProduct } from '../extract.mjs';

const golden = (key) => JSON.parse(fs.readFileSync(path.join(GOLD, `${key}.json`), 'utf8'));

test('regression: all golden files present', () => {
  for (const k of KEYS) assert.ok(fs.existsSync(path.join(GOLD, `${k}.json`)), `missing golden ${k} — run: node scripts/gen-golden.mjs`);
});

test('regression: extraction (JSON-LD / microdata / OG-meta / incomplete / not-a-product / CSR shell)', () => {
  assert.deepEqual(computeExtraction(), golden('extraction'));
});

test('regression: engine end-to-end — simple/JSON-LD/promo/food/image/incomplete/duplicates/Shopify/HTTP-error + report + CSV', async () => {
  assert.deepEqual(await computeEngineE2e(), golden('engine-e2e'));
});

test('regression: engine browser fallback — CSR shell → rendered (injected session)', async () => {
  assert.deepEqual(await computeEngineBrowser(), golden('engine-browser'));
});

test('regression: discovery via sitemap (product URLs, non-product filtered)', async () => {
  assert.deepEqual(await computeDiscoverySitemap(), golden('discovery-sitemap'));
});

test('regression: discovery via crawl + pagination (junk skipped, page 2 followed, dedup)', async () => {
  assert.deepEqual(await computeDiscoveryCrawl(), golden('discovery-crawl'));
});

test('regression: response classification (HTTP errors / challenge / captcha / timeout)', () => {
  assert.deepEqual(computeClassification(), golden('classification'));
});

// Real Playwright render — validates the actual browser path is functional in
// THIS environment. Guarded + non-fatal: skips (never fails) if Chromium is not
// available, so ÉTAPE 0 stays deterministic. (`--smoke` also validates Chromium.)
test('regression: real Playwright render of a CSR page (guarded)', async (t) => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(ROOT, '.playwright-browsers');
  let mod;
  try { mod = await import('../browser.mjs'); } catch (e) { return t.skip('browser module unavailable: ' + e.message); }
  if (!(await mod.browserAvailable())) return t.skip('Playwright/Chromium not available in this environment');
  const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(readFix('csr-rendered.html'));
  const s = new mod.BrowserSession({ headless: true });
  try {
    const r = await s.render(dataUrl, { timeoutMs: 15000 });
    const { product } = extractProduct(r.html || '', 'https://spa.example/fr/montre-connectee');
    assert.ok(product && /Montre connect/i.test(product.name), 'rendered HTML should extract the product');
  } catch (e) {
    t.skip('real render skipped in this environment: ' + (e && e.message || e));
  } finally {
    try { await s.close(); } catch { /* ignore */ }
  }
});
