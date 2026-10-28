// SKU contract on the Converter side (core/knowledge-proposal/sku.mjs): a value that is not an identifier is never
// written as a SKU; the optional generator (OFF by default) fills empty SKUs deterministically and never overwrites
// a real one. Real input: test/fixtures/scraper/scraper_adidas_taught_swatches.csv = the first 3 rows of the Scraper export
// of job 20261027205754-x7tst (adidas.be, 27/10/2026) whose variant codes are « Couleur du produit : … » labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert, convertFromCanon } from '../core/dist/index.mjs';
import { skuVerdict, guardSkus, generateSkus, planSkus, previewSkus, skuGeneratorOptions } from '../core/knowledge-proposal/sku.mjs';
import { skuVerdict as scraperVerdict } from '../../shared/extract/sku.mjs';
import { loadReferenceFormatsSync } from '../core/knowledge-proposal/reference.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adidasCsv = () => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'scraper', 'scraper_adidas_taught_swatches.csv'), 'utf8');
const variant = (o = {}) => ({ optionValues: [], sku: '', price: 10, compareAtPrice: null, cost: null, barcode: '', grams: null, lengthCm: null, widthCm: null, heightCm: null, requiresShipping: true, taxable: true, inventoryQty: null, imageSrc: '', ...o });
const product = (o = {}) => ({ handle: 'p', title: 'Produit', bodyHtml: '', vendor: '', productType: '', tags: [], published: true, options: [], variants: [variant()], images: [], categories: [], metafields: [], ...o });

test('same rule as the Scraper: both copies give the same verdict on the same values', () => {
  const cases = ['IF6490_520', 'LA9033', 'AB 1234', 'Couleur du produit : Aurora Coffee / Gum', 'Core Black / Gum', 'Bleu nuit', 'Chaussure de sport pour homme', 'A'.repeat(65), '—', '', '30 ml'];
  for (const c of cases) assert.deepEqual(skuVerdict(c, { names: ['30 ml'] }), scraperVerdict(c, { names: ['30 ml'] }), c);
});

test('real Scraper export (adidas, taught swatches): no label reaches « Variant SKU », the removal is reported', () => {
  const r = convert(adidasCsv(), { direction: 'eloshon-to-shopify', entity: 'products', expectPlatform: 'eloshon', knowledge: { formats: loadReferenceFormatsSync() } });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const skus = r.rows.map((x) => x['Variant SKU']).filter(Boolean);
  assert.deepEqual(skus, [], `no SKU invented or kept from a label: ${skus.slice(0, 3).join(' | ')}`);
  assert.ok(r.skus.rejected.length >= 10, `rejected: ${r.skus.rejected.length}`);
  // A label over 64 characters is reported as too long (the length is checked first), the others as labels.
  assert.ok(r.skus.rejected.every((x) => ['label', 'too_long'].includes(x.reason) && /^Couleur du produit : /.test(x.value)));
  assert.ok(r.skus.rejected.some((x) => x.reason === 'label'));
  assert.equal(r.skus.generator, false);
  assert.deepEqual(r.skus.generated, []);
  const w = r.warnings.find((x) => x.code === 'sku_rejected');
  assert.ok(w && w.params.count === r.skus.rejected.length && /Couleur du produit/.test(w.params.detail));
});

test('generator OFF by default: an empty SKU stays empty on every target', () => {
  for (const direction of ['eloshon-to-shopify', 'eloshon-to-wix', 'eloshon-to-bigcommerce']) {
    const r = convertFromCanon([product({ handle: 'tee', title: 'T-shirt' })], { direction, entity: 'products', expectPlatform: 'eloshon' });
    const col = r.headers.find((h) => /^(Variant SKU|SKU|sku|Code)$/i.test(h));
    if (col) assert.ok(r.rows.every((x) => !x[col]), `${direction}: ${col} = ${r.rows.map((x) => x[col]).join(',')}`);
    assert.deepEqual(r.skus.generated, []);
  }
});

test('generator: reference / title / title + options; prefix, separator, case, accents, maximum length', () => {
  const p = () => [product({ handle: 'creme', title: 'Crème brûlée Æsop', identity: { sourceId: 'if6490' }, options: [{ name: 'Taille', values: ['42', '43'] }], variants: [variant({ optionValues: ['42'] }), variant({ optionValues: ['43'] })] })];
  const skus = (o) => { const ps = p(); const g = generateSkus(ps, { enabled: true, ...o }); return { variants: ps[0].variants.map((v) => v.sku), parent: g.parents.get(0) }; };
  assert.deepEqual(skus({ source: 'reference' }), { variants: ['IF6490-42', 'IF6490-43'], parent: 'IF6490' });
  assert.deepEqual(skus({ source: 'title' }), { variants: ['CREME-BRULEE-AESOP-42', 'CREME-BRULEE-AESOP-43'], parent: 'CREME-BRULEE-AESOP' }, 'several variants: the options make each one unique');
  assert.deepEqual(skus({ source: 'title_options', prefix: 'ab', separator: '_', case: 'lower' }).variants, ['ab_creme_brulee_aesop_42', 'ab_creme_brulee_aesop_43']);
  assert.deepEqual(skus({ source: 'title', transliterate: false, case: 'keep' }).parent, 'Crème-brûlée-Æsop');
  for (const s of [...skus({ source: 'title', maxLength: 10 }).variants]) assert.ok(s.length <= 10, s);
  assert.equal(skuGeneratorOptions({ maxLength: 500 }).maxLength, 64, 'bounded');
  assert.equal(skuGeneratorOptions({ source: 'variant_name' }).source, 'reference', 'the variant name alone is not a source');
});

test('generator: a real SKU is never overwritten, an EAN is used only when chosen, collisions get a stable suffix', () => {
  const ps = [product({ handle: 'a', title: 'Bleu', variants: [variant({ sku: 'REAL-1' })] }), product({ handle: 'b', title: 'Bleu', variants: [variant({ barcode: '4006381333931' })] }), product({ handle: 'c', title: 'Bleu', variants: [variant()] })];
  const g = generateSkus(ps, { enabled: true, source: 'title' });
  assert.equal(ps[0].variants[0].sku, 'REAL-1');
  assert.equal(g.keptReal, 1);
  const [b, c] = [ps[1].variants[0].sku, ps[2].variants[0].sku];
  assert.equal(b, 'BLEU');
  assert.match(c, /^BLEU-[0-9A-Z]{4}$/, 'second « Bleu » gets a suffix');
  assert.notEqual(b, '4006381333931', 'the EAN is not a source by default');
  // Same input → same SKUs, from one import to the next (and whatever the other products' order).
  const again = [ps[2], ps[1]].map((x) => ({ ...x, variants: x.variants.map((v) => ({ ...v, sku: '' })) }));
  const first = [product({ handle: 'b', title: 'Bleu' }), product({ handle: 'c', title: 'Bleu' })];
  generateSkus(first, { enabled: true, source: 'title' });
  const second = [product({ handle: 'b', title: 'Bleu' }), product({ handle: 'c', title: 'Bleu' })];
  generateSkus(second, { enabled: true, source: 'title' });
  assert.deepEqual(second.map((x) => x.variants[0].sku), first.map((x) => x.variants[0].sku), 'deterministic');
  void again;
  const ean = [product({ variants: [variant({ barcode: '4006381333931' })] })];
  generateSkus(ean, { enabled: true, source: 'barcode' });
  assert.equal(ean[0].variants[0].sku, '4006381333931', 'EAN only when chosen explicitly');
  // A collision with a real SKU elsewhere in the file is avoided too.
  const clash = [product({ handle: 'x', title: 'Bleu', variants: [variant({ sku: 'BLEU' })] }), product({ handle: 'y', title: 'Bleu' })];
  generateSkus(clash, { enabled: true, source: 'title' });
  assert.notEqual(clash[1].variants[0].sku, 'BLEU');
});

test('generator through convert: SKUs written, marked « generated » in the result; preview shows before / after', () => {
  const ps = () => [product({ handle: 'tee', title: 'T-shirt', identity: { sourceId: 'TS1' } })];
  const r = convertFromCanon(ps(), { direction: 'eloshon-to-shopify', entity: 'products', expectPlatform: 'eloshon', skuGenerator: { enabled: true, source: 'reference' } });
  assert.equal(r.rows[0]['Variant SKU'], 'TS1');
  assert.deepEqual(r.skus.generated, [{ product: 'tee', variant: '', sku: 'TS1', scope: 'variant' }]);
  assert.ok(r.warnings.some((w) => w.code === 'skus_generated' && w.params.count === 1));
  const pre = previewSkus(ps(), { source: 'title' });
  assert.deepEqual(pre, [{ product: 'T-shirt', variant: '', before: '', after: 'T-SHIRT', generated: true }]);
  assert.equal(planSkus([product({ title: '' })], { source: 'reference' }).noSource, 1, 'no reference → nothing generated, counted');
});

test('guard: a variant code equal to its option value is removed; a SKU that reads like the title is kept', () => {
  const ps = [product({ title: 'Guide PDF', variants: [variant({ sku: 'GUIDE-PDF' })] }), product({ title: 'Parfum', options: [{ name: 'Contenance', values: ['30 ml'] }], variants: [variant({ sku: '30 ml', optionValues: ['30 ml'] })] })];
  const out = guardSkus(ps);
  assert.equal(ps[0].variants[0].sku, 'GUIDE-PDF');
  assert.equal(ps[1].variants[0].sku, '');
  assert.deepEqual(out.map((x) => [x.value, x.reason]), [['30 ml', 'option_name']]);
});

test('WooCommerce by default: a variable product with no parent SKU gets one (marked generated); its variations stay empty', () => {
  const ps = () => [
    product({ handle: 'tee', title: 'T-shirt Été', identity: { sourceId: 'TS1' }, options: [{ name: 'Taille', values: ['S', 'M'] }], variants: [variant({ optionValues: ['S'] }), variant({ optionValues: ['M'] })] }),
    product({ handle: 'pull', title: 'Pull Hiver', options: [{ name: 'Taille', values: ['S', 'M'] }], variants: [variant({ optionValues: ['S'] }), variant({ optionValues: ['M'], sku: 'PULL-M' })] }),
    product({ handle: 'cap', title: 'Casquette' }),
  ];
  const r = convertFromCanon(ps(), { direction: 'eloshon-to-woocommerce', entity: 'products', expectPlatform: 'eloshon' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const byType = (t) => r.rows.filter((x) => x.Type === t);
  assert.deepEqual(byType('variable').map((x) => x.SKU), ['TS1', 'PULL-HIVER'], 'reference first, else the title');
  assert.deepEqual(byType('variation').map((x) => [x.Parent, x.SKU]), [['TS1', ''], ['TS1', ''], ['PULL-HIVER', ''], ['PULL-HIVER', 'PULL-M']]);
  assert.deepEqual(byType('simple').map((x) => x.SKU), [''], 'a simple product without SKU stays empty');
  assert.deepEqual(r.skus.generated, [{ product: 'tee', variant: '', sku: 'TS1', scope: 'parent' }, { product: 'pull', variant: '', sku: 'PULL-HIVER', scope: 'parent' }]);
  assert.ok(r.warnings.some((w) => w.code === 'woo_parent_skus_generated' && w.params.count === 2));
  assert.ok(!r.warnings.some((w) => w.code === 'woo_parent_sku_missing'));
  // Not for the other targets: nothing is generated there.
  const shop = convertFromCanon(ps(), { direction: 'eloshon-to-shopify', entity: 'products', expectPlatform: 'eloshon' });
  assert.deepEqual(shop.skus.generated, []);
  // Same file → same parent SKUs (deterministic).
  const again = convertFromCanon(ps(), { direction: 'eloshon-to-woocommerce', entity: 'products', expectPlatform: 'eloshon' });
  assert.deepEqual(again.skus.generated, r.skus.generated);
});

test('WooCommerce CSV → WooCommerce: the parent SKU the source declares is kept, nothing is generated', () => {
  const csv = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'woo_products_modern.csv'), 'utf8');
  const r = convert(csv, { direction: 'woocommerce-to-woocommerce', entity: 'products', expectPlatform: 'woocommerce' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const parents = r.rows.filter((x) => x.Type === 'variable');
  assert.ok(parents.length >= 1, 'the fixture has a variable product');
  assert.ok(parents.every((x) => x.SKU), 'parents keep the SKU of the source');
  assert.ok(!r.skus.generated.some((g) => g.scope === 'parent'), JSON.stringify(r.skus.generated));
});

test('a platform record id is not a product reference: the parent SKU then comes from the title', () => {
  for (const id of ['13', 'gid://shopify/Product/104801831816', '43a23e0c03bf4ceabc6055a2185faa87', '0e8f4a7c-1b2d-4c3e-9f00-1234567890ab']) {
    const ps = [product({ handle: 'sac', title: 'Sac en cuir', identity: { sourceId: id }, options: [{ name: 'Couleur', values: ['Noir', 'Brun'] }], variants: [variant({ optionValues: ['Noir'] }), variant({ optionValues: ['Brun'] })] })];
    const r = convertFromCanon(ps, { direction: 'eloshon-to-woocommerce', entity: 'products', expectPlatform: 'eloshon' });
    assert.equal(r.rows.find((x) => x.Type === 'variable').SKU, 'SAC-EN-CUIR', id);
  }
  const g = generateSkus([product({ identity: { sourceId: '13' } })], { enabled: true, source: 'reference' });
  assert.equal(g.noSource, 1, 'the full generator does not write a record id as SKU either');
});
