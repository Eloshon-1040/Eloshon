/**
 * « Type de produit » typed in the extension's panel and the adidas job of 28/10: the job was started from the APP and
 * run in the user's browser (your-browser/integration.mjs), a path that never received the panel's fixed values →
 * product_type null in products.json → empty « Type » in the Converter. Now the values are saved in the app (site
 * profile + the batch of the list page) and stamped on every product of every job started on that page; the
 * Converter gives them to Shopify's « Type ». Offline: a real controller in a temp folder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../controller.mjs';
import { handlePanelRequest } from '../your-browser/panel-requests.mjs';
import { convert } from '../../converter/core/dist/index.mjs';

const H = 'https://www.adidas.be/fr/chaussures-hommes';
const F = 'https://www.adidas.be/fr/chaussures-femmes';
const row = (id, list) => ({ name: `Samba ${id}`, price: 120, currency: 'EUR', sourceUrl: `https://www.adidas.be/samba-${id}/${id}.html`, brand: 'adidas', category: list === H ? 'Homme' : 'Femme', images: [`https://assets.adidas.test/${id}.jpg`] });

function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-sv-'));
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, sideData: { enabled: false } }));
  return { dirs, ctl: createController({ dirs, emit: () => {} }) };
}
const productsOf = (dirs, jobId) => JSON.parse(fs.readFileSync(path.join(dirs.jobs, jobId, 'products.json'), 'utf8'));

test('saved from the panel, the site profile and each list page\'s batch reach the jobs the app starts there — never another page\'s', async () => {
  const { dirs, ctl } = boot();
  const save = (url, site, batch) => handlePanelRequest({ op: 'site_values', action: 'set', url, site, batch }, { controller: ctl });
  const s1 = await save(H, { constants: [{ role: 'brand', value: 'Adidas' }], fields: [{ key: 'name', label: 'Nom', role: 'title' }] }, { constants: [{ role: 'category', value: 'Chaussures' }, { role: 'product_type', value: 'Chaussures hommes' }, { role: 'tags', value: 'soldes' }] });
  assert.equal(s1.ok, true); assert.equal(s1.label, 'adidas / chaussures-hommes'); assert.equal(s1.batch.constants.length, 3);
  await save(F, undefined, { constants: [{ role: 'product_type', value: 'Chaussures femmes' }] });
  const got = await handlePanelRequest({ op: 'site_values', action: 'get', url: `${H}?start=48` }, { controller: ctl });
  assert.equal(got.site.constants[0].value, 'Adidas'); assert.equal(got.batch.constants[1].value, 'Chaussures hommes', 'page 2 of the list is the same batch');

  // The path of the 28/10 adidas job: started from the app, run in the user's browser, no constants sent.
  const men = await ctl.ingestExternalProducts({ products: [row('a', H), row('b', H)], origin: H, method: 'your-browser' });
  const women = await ctl.ingestExternalProducts({ products: [row('c', F)], origin: F, method: 'your-browser' });
  const pm = productsOf(dirs, men.jobId); const pw = productsOf(dirs, women.jobId);
  assert.deepEqual(pm.map((p) => [p.product_type, p.source_category, p.raw.brand, p.raw.columns && p.raw.columns.tags]), [['Chaussures hommes', 'Chaussures', 'Adidas', 'soldes'], ['Chaussures hommes', 'Chaussures', 'Adidas', 'soldes']]);
  assert.deepEqual(pw.map((p) => [p.product_type, p.source_category, p.raw.brand]), [['Chaussures femmes', 'Femme', 'Adidas']], 'the women\'s page keeps its own type and its page category');

  // The panel's own values (what the user saw at « Accepter ») win over the saved ones.
  const panel = await ctl.ingestExternalProducts({ products: [row('d', H)], origin: H, method: 'your-browser', constants: [{ role: 'product_type', key: 'product_type', label: 'Type de produit', value: 'Running', mode: 'always' }] });
  assert.equal(productsOf(dirs, panel.jobId)[0].product_type, 'Running');

  // … and the Converter writes the type in Shopify's « Type » (the column that was empty).
  const shop = convert(JSON.stringify(pm), { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' });
  assert.equal(shop.ok, true, JSON.stringify(shop.errors));
  assert.deepEqual(shop.rows.filter((r) => r.Title).map((r) => [r.Type, r.Vendor, r['Product Category']]), [['Chaussures hommes', 'Adidas', 'Chaussures'], ['Chaussures hommes', 'Adidas', 'Chaussures']]);
});

test('a mixed batch (sizes + a simple product) on the four store files: product data on the main / parent line; no option on a simple product', () => {
  const base = (id, variants) => ({ name: `Samba ${id}`, source_product_id: `S-${id}`, source_url: `https://shop.test/p/${id}`, image_url: 'https://img.test/a.jpg', images: ['https://img.test/a.jpg'], store_slug: 'shop.test', hs_code: null, price: 100, description: 'd', raw: { brand: 'Adidas', currency: 'EUR' }, product_type: 'Chaussures hommes', source_category: 'Chaussures', variants });
  const items = [base('A', [{ code: 'A-40', type: 'taille', name: '40', price: 100 }, { code: 'A-41', type: 'taille', name: '41', price: 100 }]), base('B', [])];
  const run = (t) => { const r = convert(JSON.stringify(items), { direction: `eloshon-to-${t}`, expectPlatform: 'eloshon' }); assert.equal(r.ok, true, `${t}: ${JSON.stringify(r.errors)}`); return r.rows; };
  // Shopify: Vendor / Type / Product Category on the first row of each product only; a simple product is ONE row
  // (Shopify's own convention for it: Option1 « Title » = « Default Title »).
  const s = run('shopify');
  assert.deepEqual(s.map((r) => [r.Handle.slice(0, 7), r.Type, r['Option1 Value']]), [['samba-a', 'Chaussures hommes', '40'], ['samba-a', '', '41'], ['samba-b', 'Chaussures hommes', 'Default Title']]);
  // WooCommerce: a variable parent with the brand and category, variations without them; a simple product, no option —
  // its product type is an attribute « Type » (WooCommerce has no free product type; phase 5, custom-fields.ts).
  const w = run('woocommerce');
  assert.deepEqual(w.map((r) => [r.Type, r.Brands, r.Categories, r['Attribute 1 name']]), [['variable', 'Adidas', 'Chaussures', 'Taille'], ['variation', '', '', 'Taille'], ['variation', '', '', 'Taille'], ['simple', 'Adidas', 'Chaussures', 'Type']]);
  // Wix: brand and collection (slug) on the PRODUCT line — plus the product type as a category (Wix has no type column);
  // the simple product has no VARIANT line and no option.
  const x = run('wix');
  assert.deepEqual(x.filter((r) => r.fieldType !== 'MEDIA').map((r) => [r.fieldType, r.brand, r.categorySlugs, r.productOptionName1 || '']), [['PRODUCT', 'Adidas', 'chaussures;chaussures-hommes', 'Taille'], ['VARIANT', '', '', 'Taille'], ['VARIANT', '', '', 'Taille'], ['PRODUCT', 'Adidas', 'chaussures;chaussures-hommes', '']]);
  // BigCommerce: one Product line per product, its sizes as Variant lines; the simple product has none.
  const b = run('bigcommerce');
  assert.deepEqual(b.filter((r) => r.Item !== 'Image').map((r) => r.Item), ['Product', 'Variant', 'Variant', 'Product']);
});
