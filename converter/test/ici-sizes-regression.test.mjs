// Non-regression (acceptance 28/10/2026, live ICI Paris XL job, anonymised shape): a perfume page whose reference is
// the code of its first size, and whose sizes link to the same page (« ?varSel= », without its « /fr/ » segment).
// The sizes are the product's own variants with their own prices — never sibling products.
import test from 'node:test';
import assert from 'node:assert/strict';
import { convert } from '../core/dist/index.mjs';

const page = 'https://shop.test/fr/marque/parfum-rose/p/BP_100';
const item = {
  name: 'Parfum Rose', source_product_id: '3600000000004', source_url: page, image_url: 'https://img.test/rose.jpg', images: ['https://img.test/rose.jpg'],
  store_slug: 'shop.test', hs_code: null, price: 20.5, barcode: '3600000000004', description: 'Notes de rose.', raw: { brand: 'Marque', currency: 'EUR' },
  variants: [
    { code: '3600000000001', type: 'taille', name: '10 ML', price: 20.5, availability: 'InStock', url: 'https://shop.test/marque/parfum-rose/p/BP_100?varSel=1' },
    { code: '3600000000002', type: 'taille', name: '25 ML', price: 56, availability: 'InStock', url: 'https://shop.test/marque/parfum-rose/p/BP_100?varSel=2' },
    { code: '3600000000004', type: 'taille', name: '50 ML', price: 105.78, availability: 'OutOfStock', url: 'https://shop.test/marque/parfum-rose/p/BP_100?varSel=4' },
  ],
};

test('ICI-shaped sizes stay variants with their own price, on the three targets', () => {
  for (const tgt of ['shopify', 'woocommerce', 'wix']) {
    const r = convert(JSON.stringify([item]), { direction: `eloshon-to-${tgt}`, expectPlatform: 'eloshon' });
    assert.equal(r.ok, true, `${tgt}: ${JSON.stringify(r.errors)}`);
    const price = tgt === 'shopify' ? 'Variant Price' : tgt === 'woocommerce' ? 'Regular price' : 'price';
    const vs = r.rows.filter((x) => (tgt === 'shopify' ? x['Option1 Value'] : tgt === 'woocommerce' ? x.Type === 'variation' : x.fieldType === 'VARIANT'));
    assert.deepEqual(vs.map((x) => Number(x[price])), [20.5, 56, 105.78], tgt);
  }
  const s = convert(JSON.stringify([item]), { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' });
  assert.equal(s.rows[0]['Option1 Name'], 'Contenance', 'a « taille » axis of volumes is a Contenance');
  assert.deepEqual(s.rows.map((r) => r['Option1 Value']), ['10 ML', '25 ML', '50 ML']);
});
