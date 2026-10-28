// Phase 6 (28/10/2026): colour pages grouped under one parent (Couleur × Taille, every combination a variant,
// each colour's pictures); generic option axes named from their values; nothing guessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { convert } from '../core/dist/index.mjs';

const page = (id, colour, sizes, img, price, others) => ({
  name: 'Basket Runner', source_product_id: id, source_url: `https://shop.test/runner-${colour.toLowerCase()}/${id}.html`, image_url: img,
  images: [img, img.replace('.jpg', '-2.jpg')], store_slug: 'shop.test', hs_code: null, price, color: colour, barcode: null,
  description: 'Chaussure de course.', source_category: 'Chaussures', product_type: null, weight_kg: null, category_slug: null,
  name_en: 'Basket Runner', description_en: null, storage_info: null,
  variants: [...others.map(([code, name]) => ({ code, type: 'couleur', name })), ...sizes.map((s) => ({ code: `${id}-${s}`, type: 'option', name: s, availability: 'InStock' }))],
  raw: { brand: 'Marque', currency: 'EUR', list_price: null },
  __eligibility: { status: 'accepted' },
});
const family = [
  page('HQ1', 'Blanc', ['40', '41'], 'https://img.test/blanc.jpg', 99, [['HQ1', 'Blanc'], ['HQ2', 'Noir']]),
  page('HQ2', 'Noir', ['40', '41', '42'], 'https://img.test/noir.jpg', 109, [['HQ1', 'Blanc'], ['HQ2', 'Noir']]),
];
const run = (items, tgt, extra = {}) => convert(JSON.stringify(items), { direction: `eloshon-to-${tgt}`, expectPlatform: 'eloshon', ...extra });

test('colour pages of one model become one parent: Couleur × Taille, each colour with its own price and pictures', () => {
  const s = run(family, 'shopify');
  assert.equal(s.ok, true, JSON.stringify(s.errors));
  assert.ok(s.warnings.some((w) => w.code === 'colour_family_grouped'));
  assert.equal(new Set(s.rows.map((r) => r.Handle)).size, 1, 'one product');
  const vs = s.rows.filter((r) => r['Option1 Value']);
  assert.deepEqual(vs.map((r) => [r['Option1 Name'], r['Option1 Value'], r['Option2 Value'], r['Variant Price'], r['Variant SKU']]),
    [['Couleur', 'Blanc', '40', '99.00', 'HQ1-40'], ['Couleur', 'Blanc', '41', '99.00', 'HQ1-41'], ['Couleur', 'Noir', '40', '109.00', 'HQ2-40'], ['Couleur', 'Noir', '41', '109.00', 'HQ2-41'], ['Couleur', 'Noir', '42', '109.00', 'HQ2-42']]);
  assert.equal(s.rows[0]['Option2 Name'], 'Taille', 'the generic « option » axis is named from its values');
  assert.equal(vs.find((r) => r['Option1 Value'] === 'Noir')['Variant Image'], 'https://img.test/noir.jpg');
  const w = run(family, 'woocommerce');
  const parent = w.rows.find((r) => r.Type === 'variable');
  assert.equal(parent['Attribute 1 name'], 'Couleur'); assert.equal(parent['Attribute 1 value(s)'], 'Blanc, Noir');
  assert.equal(parent['Attribute 2 value(s)'], '40, 41, 42');
  assert.equal(w.rows.filter((r) => r.Type === 'variation').length, 5);
  const x = run(family, 'wix');
  assert.equal(x.rows.filter((r) => r.fieldType === 'VARIANT').length, 5);
});

test('a family is left as it is (and said) when a page has no colour: nothing is guessed', () => {
  const noColour = [family[0], { ...family[1], color: null, variants: family[1].variants.map((v) => (v.type === 'couleur' ? { ...v, name: v.code === 'HQ2' ? '' : v.name } : v)) }];
  const s = run(noColour, 'shopify');
  assert.equal(new Set(s.rows.map((r) => r.Handle)).size, 2);
  assert.ok(s.warnings.some((w) => w.code === 'colour_family_not_grouped'));
});

test('one page listing colours and sizes as one flat list: every combination becomes a variant, no SKU invented', () => {
  const one = [{ ...page('Z1', 'Rouge', [], 'https://img.test/z.jpg', 49, []), color: null,
    variants: [{ code: 'z-r', type: 'couleur', name: 'Rouge', image: 'https://img.test/z-rouge.jpg' }, { code: 'z-b', type: 'couleur', name: 'Bleu', image: 'https://img.test/z-bleu.jpg' },
      { code: 'z-s', type: 'taille', name: 'S' }, { code: 'z-m', type: 'taille', name: 'M' }, { code: 'z-l', type: 'taille', name: 'L', price: 55 }] }];
  const s = run(one, 'shopify');
  assert.ok(s.warnings.some((w) => w.code === 'variants_combined'));
  const vs = s.rows.filter((r) => r['Option1 Value']);
  assert.equal(vs.length, 6);
  assert.deepEqual(vs.map((r) => `${r['Option1 Value']}/${r['Option2 Value']}/${r['Variant Price']}/${r['Variant SKU']}`),
    ['Rouge/S/49.00/', 'Rouge/M/49.00/', 'Rouge/L/55.00/', 'Bleu/S/49.00/', 'Bleu/M/49.00/', 'Bleu/L/55.00/']);
  assert.equal(vs[3]['Variant Image'], 'https://img.test/z-bleu.jpg');
});

test('a single page whose sizes are typed « option » gets a named axis (Taille, Contenance)', () => {
  const perfume = [{ ...page('P1', 'Rose', [], 'https://img.test/p.jpg', 69.53, []), color: null, variants: [{ code: '1', type: 'option', name: '30 ML', price: 69.53 }, { code: '2', type: 'option', name: '50 ML', price: 96.94 }] }];
  const s = run(perfume, 'shopify');
  assert.equal(s.rows[0]['Option1 Name'], 'Contenance');
  assert.deepEqual(s.rows.map((r) => r['Variant Price']), ['69.53', '96.94'], 'per-size prices unchanged');
});
