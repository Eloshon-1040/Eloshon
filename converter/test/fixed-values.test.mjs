// The panel's fixed values (« Valeurs fixes », shared/export/constants.mjs) are established column names: the Converter
// reads them with no mapping, from the panel CSV and from a job's products.json (raw.columns).
import test from 'node:test';
import assert from 'node:assert/strict';
import { convert, detectFormat, parseCsv } from '../core/dist/index.mjs';
import { applyConstantsToRow, applyConstantsToProduct, normalizeConstants, constantColumns } from '../../shared/export/constants.mjs';

const C = normalizeConstants([
  { role: 'brand', value: 'adidas' }, { role: 'category', value: 'Homme > Chaussures', mode: 'always' },
  { role: 'product_type', value: 'Chaussures' }, { role: 'tags', value: 'soldes, été 2026' },
  { role: 'status', value: 'draft' }, { role: 'attribute', term: 'matiere', value: 'Cuir' },
]);
const BASE = ['Nom', 'Prix', 'Prix barré', 'Marque', 'Collection', 'Image', 'Lien', 'Référence'];
const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

test('a panel CSV with its fixed-value columns is recognised and every value lands in the store file', () => {
  const extra = constantColumns(C).filter((c) => !['brand', 'category'].includes(c.key));
  const head = [...BASE, ...extra.map((c) => c.label)];
  const keys = { Nom: 'name', Prix: 'price', 'Prix barré': 'list_price', Marque: 'brand', Collection: 'category', Image: 'image', Lien: 'url', Référence: 'sku' };
  const row = applyConstantsToRow({ name: 'Samba OG', price: 120, url: 'https://shop.test/samba', image: 'https://img.test/s.jpg', sku: 'B75806', category: 'Homme' }, C);
  const csv = [head.map(q).join(','), head.map((h) => q(row[keys[h] || extra.find((c) => c.label === h).key])).join(',')].join('\n');
  assert.equal(detectFormat(parseCsv(csv).headers).knowledgeId, 'extension.panel-csv.fr.v1');
  const s = convert(csv, { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' });
  assert.equal(s.ok, true, JSON.stringify(s.errors));
  const r = s.rows[0];
  assert.equal(r.Vendor, 'adidas'); assert.equal(r.Type, 'Chaussures'); assert.equal(r.Status, 'draft');
  assert.match(r.Tags, /soldes/); assert.match(r.Tags, /été 2026/);
  assert.equal(r['Product Category'], 'Homme > Chaussures', '« always »: the fixed collection, not the page’s');
  const w = convert(csv, { direction: 'eloshon-to-woocommerce', expectPlatform: 'eloshon' });
  assert.ok(Object.values(w.rows[0]).includes('Cuir'), 'the Matière attribute reaches WooCommerce');
});

test('a job’s products.json with the fixed values (raw.columns) gives the same store file', () => {
  const np = applyConstantsToProduct({ name: 'Samba OG', name_fr: 'Samba OG', source_product_id: 'B75806', source_url: 'https://shop.test/samba', image_url: 'https://img.test/s.jpg', images: ['https://img.test/s.jpg'], store_slug: 'shop', hs_code: null, price: 120, source_category: 'Homme', product_type: null, raw: { brand: null }, variants: [] }, C);
  const s = convert(JSON.stringify([np]), { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' });
  assert.equal(s.ok, true, JSON.stringify(s.errors));
  const r = s.rows[0];
  assert.equal(r.Vendor, 'adidas'); assert.equal(r.Type, 'Chaussures'); assert.equal(r.Status, 'draft'); assert.match(r.Tags, /soldes/);
});
