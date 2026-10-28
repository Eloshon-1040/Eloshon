/**
 * Net quantity / weight of a product, whatever lane read it. Generic — no site
 * names in the code under test; the recipe files are the shipped ones, the API
 * answers are hand-built (no network).
 *   - a unit-price reference ("500 g - 2,58 EUR/kg") is reduced to its quantity;
 *   - a multipack keeps its multiplier ("6 x 33 cl" = 1,98 l);
 *   - a labelled weight in a description fills a gap, a capacity/load label never does;
 *   - a quantity written in the name fills a gap, a load rating never does;
 *   - what the source states always wins over the gap fillers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { quantityFromUnitPrice, weightFromLabelledText, weightFromName, netQuantityText, parseWeight, estimateWeightKg, setWeightEstimatePolicy } from '../weight.mjs';
import { loadConfig } from '../config.mjs';
import { toImportCsv } from '../csv.mjs';
import { toNormalizedProduct } from '../normalize.mjs';
import { replayInternalApi } from '../../shared/internal-api.mjs';

const recipe = (f) => JSON.parse(fs.readFileSync(new URL(`../recipes/${f}`, import.meta.url), 'utf8'));

test('quantityFromUnitPrice: the quantity glued to a reference price, multiplier kept', () => {
  assert.equal(quantityFromUnitPrice('500 g - 2,58 EUR/kg'), '500 g');
  assert.equal(quantityFromUnitPrice('1,5 kg — 2,66 € / kg'), '1,5 kg');
  assert.equal(quantityFromUnitPrice('6 x 33 cl - 2,5 EUR/l'), '6 x 33 cl');
  assert.equal(quantityFromUnitPrice('Protéines 4,0 g · Sel 20 g'), null);   // no reference price → not a quantity
  assert.equal(quantityFromUnitPrice(''), null);
  assert.equal(parseWeight(quantityFromUnitPrice('6 x 33 cl - 2,5 EUR/l')).volume_l, 1.98);
});

test('weightFromLabelledText: the item\'s own weight, next to its label, in FR/NL/DE/EN/ES', () => {
  assert.equal(weightFromLabelledText('<p><strong>Puissance</strong> : 200 W<br /><strong>Poids</strong>&nbsp;: env. 1,2 kg</p>'), '1,2 kg');
  assert.equal(weightFromLabelledText('Gewicht: ca. 850 g'), '850 g');
  assert.equal(weightFromLabelledText('Net weight 500 g'), '500 g');
  assert.equal(weightFromLabelledText('Peso neto: 2 kg'), '2 kg');
  assert.equal(weightFromLabelledText('Nettogewicht 750 g'), '750 g');
});

test('weightFromLabelledText: a capacity / load / user-weight label is not the item\'s weight', () => {
  assert.equal(weightFromLabelledText('Poids maximal de l\'utilisateur : 120 kg'), null);
  assert.equal(weightFromLabelledText('Capacité de charge : 30 kg'), null);
  assert.equal(weightFromLabelledText('Puissance 200 W, contenance 0,88 l'), null);
  assert.equal(weightFromLabelledText(''), null);
});

test('weightFromName: a unit-anchored quantity in the name; a load rating or a bare number is not', () => {
  assert.equal(weightFromName('Pâtes tricolores 500g'), '500 g');
  assert.equal(weightFromName('Elektrische lier, 600 kg'), null);
  assert.equal(weightFromName('Jean 501 Original'), null);
});

test('netQuantityText: the source wins, then the description label, then the name', () => {
  assert.equal(netQuantityText({ weightText: '2L', description: 'Poids : 3 kg', name: 'Eau 1,5 L' }), '2L');
  assert.equal(netQuantityText({ weightText: null, description: 'Poids : 3 kg', name: 'Eau 1,5 L' }), '3 kg');
  assert.equal(netQuantityText({ description: 'rien ici', name: 'Eau 1,5 L' }), '1,5 L');
  assert.equal(netQuantityText({ description: 'rien ici', name: 'Table basse' }), null);
  // a unit price's reference unit ("1 m = 0.01", "1 kg = 2,58") is not the pack's size
  assert.equal(netQuantityText({ weightText: '1 m = 0.01', name: 'Fil de jute' }), null);
  assert.equal(netQuantityText({ weightText: '1 kg = 2,58', name: 'Pâtes 500 g' }), '500 g');
});

test('toNormalizedProduct: a stated mass is weight_kg; a drink gets a MARKED estimate; pieces get none', () => {
  setWeightEstimatePolicy(null);   // defaults: 1 kg per litre + 10 % container
  const base = { name: 'X', price: 1, currency: 'EUR', sourceUrl: 'https://shop.test/p/1' };
  const mass = toNormalizedProduct({ ...base, weightText: '500 g - 2,58 EUR/kg' });
  assert.equal(mass.weight_kg, 0.5); assert.equal(mass.raw.weight_text, '500 g'); assert.equal(mass.raw.weight_estimated, false);
  const drink = toNormalizedProduct({ ...base, weightText: '70cl' });
  assert.equal(drink.weight_kg, 0.77); assert.equal(drink.raw.weight_estimated, true);       // 0,7 l x 1 kg/l x 1,10
  assert.equal(drink.raw.volume_l, 0.7); assert.equal(drink.raw.weight_text, '70cl');
  const pack = toNormalizedProduct({ ...base, weightText: '4x33cl' });
  assert.equal(pack.weight_kg, 1.452); assert.equal(pack.raw.weight_estimated, true);        // 1,32 l x 1,10
  assert.equal(pack.raw.volume_l, 1.32); assert.equal(pack.raw.pack_count, 4);
  const pieces = toNormalizedProduct({ ...base, weightText: '150pc' });
  assert.equal(pieces.weight_kg, null); assert.equal(pieces.raw.pack_count, 150); assert.equal(pieces.raw.weight_estimated, false);
  const described = toNormalizedProduct({ ...base, description: '<b>Poids</b> : 1,2 kg' });
  assert.equal(described.weight_kg, 1.2);
});

test('shipped Lidl recipe: price.basePrice.text becomes the net quantity (food), a non-food item without one stays empty', async () => {
  const lidl = recipe('lidl-be.json');
  assert.equal(lidl.field_map.weightText, 'gridbox.data.price.basePrice.text');
  const item = (title, erp, base, desc) => ({ gridbox: { data: {
    fullTitle: title, erpNumber: erp, canonicalPath: `/p/fr-BE/x/p${erp}`, category: 'Food',
    price: { price: 1.29, currencyCode: 'EUR', ...(base ? { basePrice: { prefix: false, text: base } } : {}) },
    keyfacts: { supplementalDescription: desc || null },
  } } });
  const body = { numFound: 3, items: [
    item('HALLOWEEN Pâtes tricolores', '100001', '500 g - 2,58 EUR/kg'),
    item('Boisson pétillante pack', '100002', '6 x 33 cl - 2,5 EUR/l'),
    item('SILVERCREST® Mini cuiseur', '100003', null, '<p><strong>Capacit&eacute;</strong> : env. 0,88 l<br /><strong>Poids</strong> : 1,1 kg</p>'),
  ] };
  const httpGet = async () => ({ status: 200, body });
  const res = await replayInternalApi(lidl, { httpGet, vars: { campaign: '1', lang: 'fr' }, maxPages: 1 });
  assert.equal(res.products.length, 3);
  const np = res.products.map((p) => toNormalizedProduct(p));
  assert.equal(np[0].weight_kg, 0.5);
  assert.equal(np[1].weight_kg, 2.178); assert.equal(np[1].raw.weight_estimated, true); assert.equal(np[1].raw.volume_l, 1.98); assert.equal(np[1].raw.weight_text, '6 x 33 cl');
  assert.equal(np[2].weight_kg, 1.1); assert.equal(np[2].raw.weight_estimated, false);   // stated in the description; the capacity (0,88 l) line is not turned into a weight
});

test('shipped Colruyt recipe: the stated content is kept as the net quantity', async () => {
  const colruyt = recipe('colruyt-be.json');
  assert.equal(colruyt.field_map.weightText, 'content');
  const body = { totalProductsFound: 3, products: [
    { LongName: 'BONI Pâtes 500g', content: '500g', commercialArticleNumber: '1', price: { basicPrice: 1.5 }, brand: 'BONI' },
    { LongName: 'RODENBACH Grand Cru 4x33cl', content: '4x33cl', commercialArticleNumber: '2', price: { basicPrice: 5 }, brand: 'RODENBACH' },
    { LongName: 'EVERYDAY mouchoirs 150pc', content: '150pc', commercialArticleNumber: '3', price: { basicPrice: 2 }, brand: 'EVERYDAY' },
  ] };
  const res = await replayInternalApi(colruyt, { httpGet: async () => ({ status: 200, body }), vars: { placeId: '604', categoryId: '1' }, presetHeaders: { 'X-CG-APIKey': 'test' }, maxPages: 1 });
  const np = res.products.map((p) => toNormalizedProduct(p));
  assert.deepEqual(np.map((p) => p.weight_kg), [0.5, 1.452, null]);   // a drink: 4 x 33 cl = 1,32 l, estimated; pieces: none
  assert.deepEqual(np.map((p) => p.raw.weight_estimated), [false, true, false]);
  assert.deepEqual(np.map((p) => p.raw.weight_text), ['500g', '4x33cl', '150pc']);
  assert.equal(np[1].raw.volume_l, 1.32);
  assert.equal(np[2].raw.pack_count, 150);
});

test('estimateWeightKg: volume x kg-per-litre x (1 + container %), config-driven, off switch, bad values fall back', () => {
  setWeightEstimatePolicy(null);
  assert.equal(estimateWeightKg(1), 1.1);
  assert.equal(estimateWeightKg(0.7), 0.77);
  assert.equal(estimateWeightKg(null), null);
  assert.equal(estimateWeightKg(0), null);
  setWeightEstimatePolicy({ kgPerLitre: 1, containerPct: 0 }); assert.equal(estimateWeightKg(0.7), 0.7);
  setWeightEstimatePolicy({ kgPerLitre: 0.92, containerPct: 25 }); assert.equal(estimateWeightKg(1), 1.15);
  setWeightEstimatePolicy({ enabled: false }); assert.equal(estimateWeightKg(1), null);
  setWeightEstimatePolicy({ kgPerLitre: -3, containerPct: 'x' }); assert.equal(estimateWeightKg(1), 1.1);   // invalid → defaults
  setWeightEstimatePolicy(null);
});

test('loadConfig carries the weightEstimate policy into the estimate (a job flow only needs its config)', () => {
  loadConfig({ weightEstimate: { containerPct: 50 } });
  assert.equal(estimateWeightKg(1), 1.5);
  const off = toNormalizedProduct({ name: 'X', price: 1, weightText: '1 l', sourceUrl: 'https://shop.test/p/2' });
  assert.equal(off.weight_kg, 1.5); assert.equal(off.raw.weight_estimated, true);
  loadConfig({ weightEstimate: { enabled: false } });
  const none = toNormalizedProduct({ name: 'X', price: 1, weightText: '1 l', sourceUrl: 'https://shop.test/p/2' });
  assert.equal(none.weight_kg, null); assert.equal(none.raw.weight_estimated, false); assert.equal(none.raw.volume_l, 1);
  loadConfig({});   // back to the defaults
  assert.equal(estimateWeightKg(1), 1.1);
});

test('a real mass is never replaced by an estimate; the CSV carries both and marks the estimate in its trailing column', () => {
  setWeightEstimatePolicy(null);
  const NL = String.fromCharCode(10), CR = String.fromCharCode(13), BOM = String.fromCharCode(0xFEFF);
  const base = { price: 1, currency: 'EUR', sourceUrl: 'https://shop.test/p/3' };
  const mass = toNormalizedProduct({ ...base, name: 'Farine', weightText: '1 kg' });
  const drink = toNormalizedProduct({ ...base, name: 'Eau', weightText: '1,5 l', sourceUrl: 'https://shop.test/p/4' });
  assert.equal(mass.weight_kg, 1); assert.equal(drink.weight_kg, 1.65);
  const lines = toImportCsv([mass, drink]).trim().split(NL).map((l) => l.split(CR).join(''));
  const cols = lines[0].split(BOM).join('').split(',');
  assert.equal(cols.length, 25); assert.equal(cols[18], 'weight_estimated');
  const kg = cols.indexOf('weight_kg');
  const row = (n) => lines[n].split(',');
  assert.equal(row(1)[kg], '1'); assert.equal(row(1)[18], '');            // stated mass: no marker
  assert.equal(row(2)[kg], '1.65'); assert.equal(row(2)[18], 'true');     // estimate: written AND marked
});
