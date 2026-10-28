/**
 * Phase 2 Lot 1 — the Scraper's products.json is read DIRECTLY (owner decision
 * A): detected by its json-shape signature, ingested through the generic
 * parser with `scraper.products-json.v1` (knowledge data, no per-site code),
 * per the Phase 0 contract field map (docs/phase0-products-json-contract.md
 * §2/§6). Every documented key is MAPPED to canon or PRESERVED with a reason;
 * an undocumented key is preserved as unknown — nothing is dropped.
 *
 * Fixtures (test/fixtures/scraper/products-json/):
 *   contract-example.json  byte copy of the Scraper's locked contract example
 *   derived-21gen.json     derived from it: colourway siblings, real variants,
 *                          out-of-stock, below-price list_price, review verdict,
 *                          malformed GTIN, one undocumented top-level + raw key
 *   historical-19gen.json  a pre-color/variants/images generation
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert, detectJson, parseJsonWithKnowledge } from '../core/dist/index.mjs';

const DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'test', 'fixtures', 'scraper', 'products-json');
const read = (n) => fs.readFileSync(path.join(DIR, n), 'utf8');
const parse = (n) => parseJsonWithKnowledge('scraper.products-json.v1', JSON.parse(read(n))).products;
const run = (n, target) => convert(read(n), { direction: `eloshon-to-${target}`, expectPlatform: 'eloshon' });
const ext = (p) => p.sourceExtension?.eloshon ?? {};
const unmappedOf = (p) => Object.fromEntries((p.unmapped ?? []).map((u) => [u.sourceField, u.reason]));

test('detection: every generation of products.json is recognised by its json-shape signature', () => {
  for (const f of ['contract-example.json', 'derived-21gen.json', 'historical-19gen.json']) {
    assert.equal(detectJson(read(f))?.knowledgeId, 'scraper.products-json.v1', f);
  }
  // a single product object (not wrapped in an array) is a products.json too
  const one = JSON.stringify(JSON.parse(read('contract-example.json'))[0]);
  assert.equal(detectJson(one)?.knowledgeId, 'scraper.products-json.v1');
});

test('handles are the Scraper CSV slug_fr values — one handle per product whichever handoff file is used', () => {
  // Computed by the Scraper's own core/csv.mjs toImportCsv on contract-example.json.
  assert.deepEqual(parse('contract-example.json').map((p) => p.handle), ['filtre-a-particules-315-mm-5bm3ta', 'pepersalami-halal-rzczr']);
});

test('contract example: images[], brand, compare-at, identifiers, currency, availability — all mapped or preserved', () => {
  const [filtre] = parse('contract-example.json');
  assert.deepEqual(filtre.images.map((i) => i.src), ['https://shop.example/img/a.jpg', 'https://cdn.example/b.jpg', 'https://shop.example/p/img/c.png']);
  assert.equal(filtre.vendor, 'Winflex');
  assert.equal(filtre.identity.sourceId, '4006381333931');
  assert.deepEqual(filtre.categories, ['Maison > Ventilation']);
  // the single inline variant { code V1, couleur Bleu } is a real variant: it
  // inherits the product price AND its crossed-out price (raw.list_price > price)
  const v = filtre.variants[0];
  assert.equal(v.sku, 'V1');
  assert.equal(v.price, 72.9);
  assert.equal(v.compareAtPrice, 99.9);
  assert.equal(v.barcode, '4006381333931');
  assert.equal(v.grams, 500);
  assert.deepEqual(filtre.options, [{ name: 'couleur', values: ['Bleu'] }]);
  assert.deepEqual(filtre.attributesRich, [{ name: 'Couleur', values: ['Bleu'], forVariation: false, visible: true }]);
  // product-level identifiers the child variant replaced are kept verbatim
  assert.equal(ext(filtre).sku, 'SKU-315');
  assert.equal(ext(filtre).mpn, 'MPN-315');
  // promotable fields the canon has no home for: preserved AND declared
  assert.equal(ext(filtre).currency, 'EUR');
  assert.equal(ext(filtre).availability, 'InStock');
  assert.equal(unmappedOf(filtre)['raw.currency'], 'no-canon-field');
  assert.equal(unmappedOf(filtre)['raw.availability'], 'no-canon-field');
  assert.equal(unmappedOf(filtre)['raw.weight_text'], 'no-canon-field');
});

test('derived 21-gen: siblings, real variants, stock, list_price below price, review verdict, unknown keys', () => {
  const [bleu, vert, pot, bougie] = parse('derived-21gen.json');
  // colourways listed on each family member → siblings (merchandising.related), not variants
  assert.deepEqual(bleu.merchandising.related, ['HC-100-VE']);
  assert.deepEqual(vert.merchandising.related, ['HC-100-BL']);
  assert.equal(bleu.variants.length, 1);
  assert.equal(bleu.variants[0].sku, 'HC-100-BL');
  assert.equal(bleu.variants[0].compareAtPrice, 29.9, 'list_price above price → compare-at');
  assert.equal(bleu.variants[0].identifiers.gtin, '3701234567906');
  assert.deepEqual(bleu.translations, { en: { title: 'Linen cushion cover — blue', bodyHtml: '45 x 45 cm washed linen cover.' } });
  assert.equal(vert.translations, undefined, 'a mirrored EN value is not a translation');
  // real variants: own prices (no inherited compare-at), per-variant stock statement
  assert.deepEqual(pot.options, [{ name: 'taille', values: ['S', 'L'] }]);
  assert.deepEqual(pot.variants.map((v) => [v.sku, v.price, v.compareAtPrice, v.inventoryQty]), [['POT-200-S', 12.5, null, null], ['POT-200-L', 18, null, 0]]);
  assert.equal(pot.variants[1].sourceExtension.eloshon.availability, 'OutOfStock');
  assert.equal(pot.variants[0].identifiers, undefined, 'product identifiers are not copied onto each child');
  assert.equal(ext(pot).mpn, 'TC-POT-200');
  // out of stock (schema.org URL), list_price BELOW price, review verdict, malformed GTIN
  const bv = bougie.variants[0];
  assert.equal(bv.inventoryQty, 0);
  assert.equal(bv.compareAtPrice, null, 'a list_price below the charged price is not a compare-at…');
  assert.equal(ext(bougie).list_price, 9.9, '…but it is kept verbatim');
  assert.equal(bv.identifiers, undefined, 'a GTIN of invalid length never becomes canonical…');
  assert.equal(bv.barcode, '', '…nor promoted to the barcode by the canon derivation…');
  assert.equal(ext(bougie).gtin, '12345', '…and is kept verbatim');
  assert.equal(bougie.status, 'draft');
  assert.equal(bougie.published, false);
  assert.deepEqual(ext(bougie).eligibility, { status: 'to_verify', code: 'manual_review', reason: 'Pack quantity needs review' });
  // undocumented keys: preserved verbatim and flagged unknown — top level AND inside raw{}
  assert.equal(ext(bougie)._raw.seller, 'Marketplace Partner 42');
  assert.equal(ext(bougie)._raw['raw.promo_label'], 'Lot de 2');
  assert.equal(unmappedOf(bougie).seller, 'unknown');
  assert.equal(unmappedOf(bougie)['raw.promo_label'], 'unknown');
  assert.equal(unmappedOf(bougie)['raw.pack_count'], 'no-canon-field');
});

test('historical 19-gen: missing images → [image_url] (or nothing), missing color/variants → none', () => {
  const [salami, gouda] = parse('historical-19gen.json');
  assert.deepEqual(salami.images.map((i) => i.src), ['https://static.example/std/salami.jpg']);
  assert.equal(salami.variants[0].imageSrc, 'https://static.example/std/salami.jpg');
  assert.deepEqual(gouda.images, [], 'no images key and image_url null → no image');
  for (const p of [salami, gouda]) {
    assert.equal(p.attributesRich, undefined);
    assert.deepEqual(p.options, []);
    assert.equal(p.variants.length, 1);
    assert.equal(p.merchandising, undefined);
    assert.equal(p.unmapped?.some((u) => u.reason === 'unknown') ?? false, false, 'nothing unknown in a historical file');
  }
  assert.equal(gouda.vendor, 'Boni');
  assert.equal(gouda.variants[0].barcode, '5400101025773');
});

test('converts to Shopify and WooCommerce with everything present in the output', () => {
  const shop = run('derived-21gen.json', 'shopify');
  assert.equal(shop.ok, true, JSON.stringify(shop.errors));
  assert.equal(shop.sourceFormat, 'scraper.products-json.v1');
  // The blue and green pages of the cushion cover are one model: grouped under one parent (Couleur), every picture kept.
  const bleuRows = shop.rows.filter((r) => r['Handle'] === 'housse-de-coussin-en-lin-116fum');
  assert.deepEqual(bleuRows.map((r) => r['Image Src']).filter(Boolean).slice(0, 2), ['https://shop.example/img/housse-bleu-1.jpg', 'https://shop.example/img/housse-bleu-2.jpg'], 'every image, in order');
  assert.deepEqual(bleuRows.filter((r) => r['Option1 Value']).map((r) => [r['Option1 Name'], r['Option1 Value']]), [['Couleur', 'Bleu'], ['Couleur', 'Vert']]);
  assert.equal(bleuRows[0]['Vendor'], 'Lin & Co');
  assert.equal(bleuRows[0]['Variant Compare At Price'], '29.90');
  assert.equal(bleuRows[0]['Variant Barcodes'], '3701234567906');
  assert.equal(bleuRows[0]['Variant SKU'], 'HC-100-BL');
  // The scraped site's « out of stock » is not the merchant's stock: not tracked by default (said in a warning);
  // the quantity reaches the file when the user keeps the source's stock (stockMode 'source').
  const potL = shop.rows.find((r) => r['Variant SKU'] === 'POT-200-L');
  assert.equal(potL['Variant Inventory Qty'], '');
  assert.ok(shop.warnings.some((w) => w.code === 'stock_untracked'));
  const kept = convert(read('derived-21gen.json'), { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon', stockMode: 'source' });
  assert.equal(kept.rows.find((r) => r['Variant SKU'] === 'POT-200-L')['Variant Inventory Qty'], '0');
  const bougie = shop.rows.find((r) => r['Variant SKU'] === 'BG-310');
  assert.equal(bougie['Status'], 'draft');
  assert.ok(shop.losses.some((l) => l.code === 'loss_shopify_translations'), 'the EN translation the target cannot carry is declared');

  const woo = run('derived-21gen.json', 'woocommerce');
  assert.equal(woo.ok, true, JSON.stringify(woo.errors));
  // Grouped: a variable product (every picture of both colours) and the blue variation (its own picture and prices).
  const parentRow = woo.rows.find((r) => r['Type'] === 'variable' && r['Name'] === 'Housse de coussin en lin');
  assert.match(parentRow['Images'], /^https:\/\/shop\.example\/img\/housse-bleu-1\.jpg, https:\/\/shop\.example\/img\/housse-bleu-2\.jpg/);
  assert.equal(parentRow['Brands'], 'Lin & Co');
  const bleu = woo.rows.find((r) => r['SKU'] === 'HC-100-BL');
  assert.equal(bleu['Type'], 'variation');
  assert.equal(bleu['Images'], 'https://shop.example/img/housse-bleu-1.jpg');
  assert.equal(bleu['Regular price'], '29.9');
  assert.equal(bleu['Sale price'], '24.9');
  assert.equal(bleu['GTIN, UPC, EAN, or ISBN'], '3701234567906');
  assert.equal(woo.rows.find((r) => r['SKU'] === 'BG-310')['Published'], '0');

  const hist = run('historical-19gen.json', 'shopify');
  assert.equal(hist.ok, true);
  assert.equal(hist.counts.outputUnits, 2);
});

test('a products.json dropped on another platform\'s page is redirected, never silently converted', () => {
  const r = convert(read('contract-example.json'), { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'wrong_platform');
});
