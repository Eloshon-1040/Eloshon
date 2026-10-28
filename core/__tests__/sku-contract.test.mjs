/**
 * SKU contract (shared/extract/sku.mjs): a SKU is an identifier the source declares, else EMPTY; a label, a
 * phrase or an option name is never written as a SKU — it is removed and reported. The product's reference
 * (article code of its colourway / URL) is kept apart from the SKU.
 *
 * Proof on real data: the row of job 20261027205754-x7tst (adidas.be, 27/10/2026, a 🎯 « Variantes » rule taught
 * on the colour-swatch strip) whose « Variant SKU » became « Couleur du produit : Aurora Coffee / … », and the
 * real product page saved in fixtures/sites. Offline, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { skuVerdict, cleanSku, optionTypeOf, splitSharedLabel, SKU_MAX_LENGTH } from '../../shared/extract/sku.mjs';
import { readVariants } from '../../shared/knowledge/readers.mjs';
import { mergeKnowledgeIntoRow } from '../../shared/knowledge/apply.mjs';
import { toNormalizedProduct } from '../normalize.mjs';
import { attachDiagnostics, formatReport } from '../engine.mjs';
import { extractProduct } from '../extract.mjs';
import { extractEmbeddedProducts } from '../../shared/extract/embedded-state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(HERE, 'fixtures');
const realRow = () => JSON.parse(fs.readFileSync(path.join(FX, 'sku', 'adidas-taught-swatches.row.json'), 'utf8')).row;
const adidasPage = () => zlib.gunzipSync(fs.readFileSync(path.join(FX, 'sites', 'adidas.be.product.html.gz'))).toString('utf8');

test('skuVerdict: real identifiers pass; labels, phrases, option names, long or empty values never do', () => {
  for (const ok of ['IF6490_520', 'LA9033', 'ABC-123', '4006381333931', 'AB 1234', 'sku.42', 'X']) assert.equal(skuVerdict(ok).ok, true, ok);
  const no = (v, reason, names) => assert.deepEqual(skuVerdict(v, { names }), { ok: false, reason }, String(v));
  no('Couleur du produit : Aurora Coffee / Magic Mauve / Gum', 'label');
  no('Core Black / Gum', 'label');
  no('Size: 42', 'label');
  no('Bleu nuit', 'phrase');
  no('Chaussure de sport pour homme', 'phrase');
  no('30 ml', 'option_name', ['30 ml', '50 ml']);
  no('chaussure handball spezial', 'option_name', ['Chaussure Handball Spezial']);
  no('A'.repeat(SKU_MAX_LENGTH + 1), 'too_long');
  no('—', 'no_identifier');
  no('', 'empty'); no(null, 'empty');
  assert.equal(cleanSku('  IF6490_520 '), 'IF6490_520');
  assert.equal(cleanSku('Couleur : Bleu'), null);
});

test('options: a label shared by every entry names the option; its words give the variant type', () => {
  assert.deepEqual(splitSharedLabel(['Couleur du produit : Bleu', 'Couleur du produit : Rouge / Blanc']), { label: 'Couleur du produit', names: ['Bleu', 'Rouge / Blanc'] });
  assert.deepEqual(splitSharedLabel(['Taille : 42', 'Couleur : Bleu']).label, null, 'two different labels: kept as written');
  assert.deepEqual(splitSharedLabel(['Couleur : Bleu']).label, null, 'one entry: nothing to compare');
  assert.equal(splitSharedLabel(['10:30', '11:00']).label, null, 'a time is not a label');
  assert.equal(optionTypeOf('Couleur du produit'), 'couleur');
  assert.equal(optionTypeOf('Colour'), 'couleur');
  assert.equal(optionTypeOf('Pointure'), 'taille');
  assert.equal(optionTypeOf('Größe'), 'taille');
  assert.equal(optionTypeOf('Contenance'), 'autre');
  assert.equal(optionTypeOf(''), 'autre');
});

test('real page: the colour-swatch strip reads as colours, without the « Couleur du produit : » label and without a code', () => {
  const { document } = parseHTML(adidasPage());
  const strip = document.querySelector('[data-testid="color-variation-link"]').parentElement;
  const vs = readVariants(strip);
  assert.ok(vs.length >= 5, `swatches read: ${vs.length}`);
  for (const v of vs) {
    assert.ok(!/couleur du produit/i.test(v.name), `name keeps the value only: ${v.name}`);
    assert.equal(v.group, 'Couleur du produit');
    assert.equal(v.code, undefined, 'a swatch has no code of its own on this page');
  }
  // Applied as a taught rule: the row's variants are colours, and none carries a label as its code.
  const row = { name: 'Chaussure Handball Spezial', color: 'Earth Strata / Off White / Gum' };
  mergeKnowledgeIntoRow(row, { values: { variants: vs }, sources: { variants: { origin: 'manual' } } });
  assert.ok(row.variants.every((v) => v.type === 'couleur' && v.code === undefined && v.label === 'Couleur du produit'), JSON.stringify(row.variants[0]));
});

test('real page: the article code « IF6490 » is the product reference, not a SKU', () => {
  const { product } = extractProduct(adidasPage(), 'https://www.adidas.be/fr/chaussure-handball-spezial/IF6490.html');
  assert.equal(product.sku || null, null, 'the page declares no product-level SKU');
  assert.equal(product.reference, 'IF6490');
  const np = toNormalizedProduct(product, {});
  assert.equal(np.raw.sku, null);
  assert.equal(np.raw.reference, 'IF6490');
  assert.equal(np.source_product_id, 'IF6490', 'the row keeps its identifier');
  // The per-size SKUs the page state declares stay the variants' codes.
  const codes = (np.variants || []).map((v) => v.code).filter(Boolean);
  assert.ok(codes.length === 0 || codes.every((c) => /^IF6490_\d+$/.test(c)), codes.join(', '));
});

test('real row (job x7tst): label codes are removed — the SKU stays empty — and listed in the report with their reason', () => {
  const row = realRow();
  assert.match(row.variants[0].code, /^Couleur du produit : /, 'fixture = the faulty shape found in the job');
  const diag = { rejectedImages: [], urlsCorrected: 0, urlSamples: [] };
  const np = toNormalizedProduct({ name: row.name, color: row.color, price: row.price, sourceUrl: row.source_url, sku: 'Couleur du produit : Earth Strata / Off White / Gum', variants: row.variants }, { diag });
  assert.ok(np.variants.every((v) => !('code' in v)), 'no variant keeps a label as code');
  assert.equal(np.raw.sku, null);
  assert.equal(diag.rejectedSkus.length, row.variants.length + 1);
  assert.deepEqual([...new Set(diag.rejectedSkus.map((r) => r.reason))], ['label']);
  assert.equal(diag.rejectedSkus[1].value, row.variants[0].code);
  assert.equal(diag.rejectedSkus[1].field, 'variants.code');
  const report = attachDiagnostics({ status: 'OK' }, diag);
  assert.equal(report.skus.rejected, row.variants.length + 1);
  const text = formatReport(report);
  assert.match(text, /skus rejected: +5 — label×5 \(the SKU stays empty\)/);
  assert.match(text, /« Couleur du produit : Aurora Coffee \/ Magic Mauve \/ Gum »/);
});

test('listing state: an id the page does not declare as SKU identifies the row as its reference, never as SKU', () => {
  // Real adidas listing card shape (live 2026): { id: 'IF6490', … }; a declared { sku } stays a SKU.
  const card = (o) => extractEmbeddedProducts(`<script>window.__S={"products":[${JSON.stringify(o)},${JSON.stringify({ ...o, url: o.url.replace('IF6490', 'IF6562'), id: o.id && 'IF6562', sku: o.sku && 'IF6562-S' })}]}</script>`, 'https://www.adidas.be/fr/hommes').cards[0];
  const base = { id: 'IF6490', title: 'Chaussure Handball Spezial', url: 'https://www.adidas.be/fr/chaussure-handball-spezial/IF6490.html', image: 'https://assets.adidas.com/x.jpg', priceData: { prices: [{ type: 'original', value: 110 }] } };
  const ref = card(base);
  assert.equal(ref.sku, 'IF6490', 'the card keeps its identifier for matching');
  assert.equal(ref.skuIsReference, true);
  const np = toNormalizedProduct(ref, {});
  assert.equal(np.raw.sku, null);
  assert.equal(np.raw.reference, 'IF6490');
  assert.equal(np.source_product_id, 'IF6490');
  const declared = card({ ...base, sku: 'IF6490-S' });
  assert.equal(declared.sku, 'IF6490-S', 'a declared SKU wins over the card id');
  assert.equal(declared.skuIsReference, undefined);
  const coded = card({ ...base, code: 'IF6490-C', sku: 'IF6490-S' });
  assert.equal(coded.skuIsReference, true, 'a `code` read first is the reference, even when a sku is declared too');
  const npCoded = toNormalizedProduct(coded, {});
  assert.equal(npCoded.raw.sku, 'IF6490-S', 'the declared SKU is never lost');
  assert.equal(npCoded.raw.reference, 'IF6490-C');
  const onlySku = card({ title: base.title, url: base.url, image: base.image, priceData: base.priceData, sku: 'IF6490-S' });
  assert.equal(onlySku.skuIsReference, undefined, 'declared under « sku »: a SKU');
  assert.equal(toNormalizedProduct(onlySku, {}).raw.sku, 'IF6490-S');
});

test('a real SKU is never touched; a variant code that repeats its own option name is dropped', () => {
  const diag = {};
  const np = toNormalizedProduct({ name: 'Parfum', sku: 'PF-100', sourceUrl: 'https://s.test/p/1', variants: [{ code: 'PF-100-30', type: 'autre', name: '30 ml' }, { code: '50 ml', type: 'autre', name: '50 ml' }] }, { diag });
  assert.equal(np.raw.sku, 'PF-100');
  assert.equal(np.variants[0].code, 'PF-100-30');
  assert.equal('code' in np.variants[1], false);
  assert.deepEqual(diag.rejectedSkus.map((r) => [r.value, r.reason]), [['50 ml', 'option_name']]);
  assert.equal(attachDiagnostics({}, { rejectedSkus: [] }).skus.rejected, 0, 'nothing rejected: the report says 0');
});
