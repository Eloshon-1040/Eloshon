/**
 * BENCHMARK / non-regression for the hard-unlock (Cloudflare) layer.
 *
 * Guarded: runs only when ELOSHON_UNLOCK_PYTHON points at a Python that has
 * nodriver installed (and a real Chrome is present). Otherwise it SKIPS, so the
 * default suite is unaffected. This freezes the proven result:
 *   Playwright headless → Cloudflare stub (~28 KB, no catalogue)
 *   nodriver + real Chrome → real page (~1.28 MB) → our extractor → 24 cards
 * so a future regression in the sidecar / wrapper / extractor is caught.
 *
 *   ELOSHON_UNLOCK_PYTHON=/path/to/venv/python node --test core/__tests__/unlock-benchmark.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PY = process.env.ELOSHON_UNLOCK_PYTHON;

test('BENCHMARK microfluo: nodriver unlock passes Cloudflare → structured cards', { skip: PY ? false : 'set ELOSHON_UNLOCK_PYTHON to run (needs nodriver + real Chrome)' }, async () => {
  const { unlockRender } = await import('../unlock.mjs');
  const { extractListing } = await import('../listing.mjs');
  const url = 'https://microfluo.net/fr/2-materiel';
  const r = await unlockRender(url, { pythonPath: PY, timeoutMs: 75000 });
  assert.ok(r.html && r.html.length > 200000, `expected the real page, got ${r.html ? r.html.length : null} bytes (err=${r.error})`);
  assert.ok(!/just a moment|un instant/i.test((r.html.match(/<title[^>]*>(.*?)<\/title>/i) || [])[1] || ''), 'title must not be a challenge');
  const { cards } = extractListing(r.html, url);
  assert.ok(cards.length >= 10, `expected many product cards from the unlocked page, got ${cards.length}`);
});
