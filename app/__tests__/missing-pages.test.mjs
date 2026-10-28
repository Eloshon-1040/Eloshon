/**
 * Product pages of a list (hydrozone.fr, PrestaShop 1.6, 28/10): the reference the page DECLARES
 * (<span itemprop="sku">) and its « Fiche technique » table reach the row; the pages a run already sent stay
 * in the app after its job so « Lire les fiches manquantes » opens only the others. Offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { enrichFromDetailPages } from '../../core/detail-enrich.mjs';
import { toNormalizedProduct } from '../../core/normalize.mjs';
import { createPageCache, handlePanelRequest } from '../your-browser/panel-requests.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = zlib.gunzipSync(fs.readFileSync(path.join(HERE, '..', '..', 'core', '__tests__', 'fixtures', 'sites', 'hydrozone.fr.product.html.gz'))).toString('utf8');
const URL7941 = 'https://www.hydrozone.fr/ph-perfect-base-nutrients/7941-ph-perfect-bloom-10l-advanced-nutrients.html';

test('hydrozone product page: the declared reference and the « Fiche technique » complete a listed row (no rule taught)', async () => {
  const card = { name: 'pH Perfect Bloom 10L - Advanced Nutrients', price: 94.2, sourceUrl: URL7941 };
  await enrichFromDetailPages([card], { fetchHtml: async () => ({ ok: true, html: PAGE, status: 200 }), sample: 3 });
  assert.equal(card.sku, 'ADV-PHB9000', 'schema.org sku of the page (it was read, then dropped before 28/10)');
  const specs = Object.fromEntries((card.specs || []).map((s) => [s.name, s.value]));
  assert.equal(specs['Litrage'], '10 L'); assert.equal(specs['Type engrais'], 'Minéral'); assert.equal(specs['Utilisable en'], 'Terre - Hydro - Coco');
  const np = toNormalizedProduct(card, { store: 'hydrozone.fr' });
  assert.equal(np.raw.sku, 'ADV-PHB9000', 'the SKU contract keeps a declared identifier');
  assert.equal(np.source_product_id, 'ADV-PHB9000');
});

test('the declared SKU never replaces what the row has, and is never taken from loose text', async () => {
  const has = { name: 'x', price: 1, sourceUrl: URL7941, sku: 'LIST-1' };
  await enrichFromDetailPages([has], { fetchHtml: async () => ({ ok: true, html: PAGE, status: 200 }) });
  assert.equal(has.sku, 'LIST-1');
  const ref = { name: 'x', price: 1, sourceUrl: URL7941, sku: '7941', skuIsReference: true };
  await enrichFromDetailPages([ref], { fetchHtml: async () => ({ ok: true, html: PAGE, status: 200 }) });
  assert.equal(ref.sku, '7941'); assert.equal(ref.declaredSku, 'ADV-PHB9000', 'a listing code stays the reference, the page gives the SKU');
  const loose = '<html><body><h1>Produit</h1><p>Référence : ABC-123</p><span class="price">10 €</span></body></html>';
  const row = { name: 'y', price: 10, sourceUrl: 'https://shop.test/p/1' };
  await enrichFromDetailPages([row], { fetchHtml: async () => ({ ok: true, html: loose, status: 200 }) });
  assert.equal(row.sku, undefined, 'a reference written in a sentence is not a declared SKU');
});

test('the pages a run sent stay after its job: a follow-up run reuses them; under memory pressure they go first', async () => {
  const cache = createPageCache({ maxTotalBytes: 100 });
  assert.equal(cache.put('pr_one', 'https://s.test/p/1', 'a'.repeat(30)), true);
  assert.equal(cache.put('pr_one', 'https://s.test/p/2', 'b'.repeat(30)), true);
  assert.equal(cache.take('pr_one').size, 2);
  assert.equal(cache.take('pr_one'), null, 'taken once by its job');
  const r = await handlePanelRequest({ op: 'page_reuse', url: 'https://s.test/c', runId: 'pr_one-m1', from: 'pr_one' }, { pageCache: cache });
  assert.deepEqual(r, { ok: true, urls: ['https://s.test/p/1', 'https://s.test/p/2'] });
  assert.equal(cache.put('pr_one-m1', 'https://s.test/p/3', 'c'.repeat(30)), true);
  assert.deepEqual([...cache.take('pr_one-m1').keys()], ['https://s.test/p/1', 'https://s.test/p/2', 'https://s.test/p/3'], 'the new job has every page');
  // A taken run gives way to a new run's pages; pages not yet taken never do.
  assert.equal(cache.put('pr_two', 'https://s.test/q/1', 'd'.repeat(60)), true);
  assert.equal(cache.size().runs, 1);
  assert.equal(cache.put('pr_three', 'https://s.test/r/1', 'e'.repeat(60)), 'memory_full');
  assert.equal((await handlePanelRequest({ op: 'page_reuse', url: 'https://s.test/c', runId: 'x', from: 'pr_one' }, { pageCache: cache })).ok, false, 'ids are checked');
});
