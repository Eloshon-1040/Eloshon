/**
 * Phase 5.7 — "no parser per site" put to the test with REAL Eloshon Scraper
 * exports (test/fixtures/scraper: Levi's, April, Lidl.de, Colruyt) and an
 * unknown supplier CSV taught through the Learned strata. Zero new parser code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectFormat, detectJson, parseCsv, parseCsvWithKnowledge, convert, serializeCsv, semanticAnalyze, learnFormat, proposeFormatId } from '../core/dist/index.mjs';
import { createJsonKnowledgeStore } from '../core/knowledge-proposal/json-store.mjs';
import { loadAllFormats } from '../core/knowledge-proposal/reference.mjs';
import { makeValidator } from '../core/knowledge-proposal/validator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures', 'scraper');
const read = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');
const FILES = ['levis-be.csv', 'april-beauty-be.csv', 'lidl-de.csv', 'colruyt-be.csv'];
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'core', 'knowledge-proposal', 'schema.json'), 'utf8'));
const validateFormat = makeValidator(schema, 'formatKnowledge');

test('every real Scraper export (19 or 21 columns) is recognised as scraper.eloshon-export.v1 and routed to the generic parser', () => {
  for (const f of FILES) {
    const t = parseCsv(read(f));
    const det = detectFormat(t.headers);
    assert.equal(det.format, 'knowledge', f);
    assert.equal(det.knowledgeId, 'scraper.eloshon-export.v1', f);
    assert.equal(det.platform, 'eloshon'); assert.equal(det.entity, 'products');
    assert.equal(det.displayName, 'Eloshon Scraper export (CSV)');
  }
});

test('parse: nothing unknown, canon populated from the real content', () => {
  for (const f of FILES) {
    const { products, report } = parseCsvWithKnowledge('scraper.eloshon-export.v1', read(f));
    assert.deepEqual(report.unknownKeys, [], f);
    assert.deepEqual(report.warnings, [], f);
    assert.equal(report.units, parseCsv(read(f)).rows.length, f);
    for (const p of products) {
      assert.ok(p.title, f + ': title');
      assert.ok(p.handle, f + ': handle');
      assert.equal(p.variants.length, 1, f + ': one variant per row');
      assert.equal(p.identity.slug, p.handle);
      assert.ok(p.provenance.title.sourceField === 'name_fr');
      // multilingual duplicates are NOT reported as losses; different values are kept + flagged
      const dup = (p.unmapped || []).filter((u) => u.sourceField === 'name_en');
      assert.ok(dup.length <= 1);
    }
  }
  const april = parseCsvWithKnowledge('scraper.eloshon-export.v1', read('april-beauty-be.csv')).products[0];
  assert.equal(april.categories[0], 'Shop > Soins visage > Soin visage homme > Nettoyage et gommage > Nettoyant Exfoliant Visage');
  assert.equal(april.variants[0].price, 28.5);
  assert.equal(april.sourceExtension.eloshon.store_slug, 'April');
  const colruyt = parseCsvWithKnowledge('scraper.eloshon-export.v1', read('colruyt-be.csv')).products[0];
  assert.equal(colruyt.variants[0].grams, 100, 'weight_kg 0.1 → 100 g');
  assert.equal(colruyt.variants[0].price, null, 'no price on Colruyt listing pages — kept null, not 0');
  const lidl = parseCsvWithKnowledge('scraper.eloshon-export.v1', read('lidl-de.csv')).products;
  assert.ok(lidl.some((p) => p.variants[0].barcode), 'Lidl carries EANs on some rows');
});

test("Levi's: swatch entries are SIBLING colourways, not variants → merchandising.related (relationship-aware)", () => {
  const { products, report } = parseCsvWithKnowledge('scraper.eloshon-export.v1', read('levis-be.csv'));
  assert.equal(report.variants, products.length, 'exactly one variant per product, no swatch duplicates');
  const jean = products.find((p) => /501/.test(p.title) && (p.merchandising?.related?.length ?? 0) > 10);
  assert.ok(jean, 'a 501 with many colourways');
  assert.ok(!jean.merchandising.related.includes(jean.identity.sourceId), 'self is not its own sibling');
  assert.equal(jean.provenance['merchandising.related'].method, 'structural');
  assert.ok(Array.isArray(jean.sourceExtension.eloshon.siblings) && jean.sourceExtension.eloshon.siblings.length >= jean.merchandising.related.length, 'raw swatch list preserved');
  assert.equal(jean.options.length, 0, 'no option axis invented from null names');
});

test('convert: each real export → Shopify and WooCommerce CSV through the engine, no per-format parser', () => {
  for (const f of FILES) {
    const csv = read(f);
    const rows = parseCsv(csv).rows.length;
    const sh = convert(csv, { direction: 'eloshon-to-shopify', entity: 'products', expectPlatform: 'eloshon' });
    assert.equal(sh.ok, true, f + ' ' + JSON.stringify(sh.errors));
    assert.equal(sh.sourceFormat, 'scraper.eloshon-export.v1');
    assert.equal(sh.targetFormat, 'shopify_products');
    assert.equal(sh.counts.outputUnits, rows, f);
    assert.equal(sh.rows.length, rows, f + ': one Shopify row per product (single variant)');
    assert.ok(sh.rows.every((r) => r['Title'] && r['Handle']), f);
    const woo = convert(csv, { direction: 'eloshon-to-woocommerce', entity: 'products', expectPlatform: 'eloshon' });
    assert.equal(woo.ok, true, f);
    assert.equal(woo.rows.length, rows, f);
    assert.ok(serializeCsv(woo.headers, woo.rows).length > 100);
    // wrong platform guard still applies
    const wrong = convert(csv, { direction: 'shopify-to-woocommerce', entity: 'products', expectPlatform: 'shopify' });
    assert.equal(wrong.ok, false); assert.equal(wrong.errors[0].code, 'wrong_platform');
  }
});

test('unknown supplier CSV (FR, semicolons) → semantic → learnFormat → Learned store → recognised & converted', async () => {
  const csv = ['Référence;Désignation;Prix de vente;Code EAN;Stock disponible;Visuel;Rayon;Marque;Poids (kg);Colonne interne',
    'F-001;Table basse chêne;129,90;3701234567890;12;https://cdn.x/a.jpg;Maison > Salon;Eloshon;12.5;zz1',
    'F-002;Chaise scandinave;59,00;3701234567906;0;https://cdn.x/b.jpg;Maison > Salon;Eloshon;4.2;zz2',
    'F-003;Lampe de bureau;39,90;3701234567913;5;https://cdn.x/c.png;Maison > Bureau;Lumo;1.1;zz3'].join('\n');
  const t = parseCsv(csv);
  assert.equal(detectFormat(t.headers).format, 'unknown');

  const report = semanticAnalyze(t.headers, t.rows, 'products');
  const fmt = learnFormat({ headers: t.headers, report, hint: 'fournisseur-x', provenance: 'supplier', platform: 'eloshon', by: 'user:test' });
  assert.equal(fmt.id, proposeFormatId(t.headers, { provenance: 'supplier', hint: 'fournisseur-x' }));
  assert.match(fmt.id, /^supplier\.fournisseur-x\.[0-9a-f]{6}\.v1$/);
  const v = validateFormat(fmt);
  assert.equal(v.ok, true, v.errors.map((e) => e.path + ' ' + e.msg).join('; '));
  const byPath = Object.fromEntries(fmt.fields.map((f) => [f.path, f]));
  assert.equal(byPath['Désignation'].canon, 'title');
  assert.equal(byPath['Prix de vente'].canon, 'variants[].price'); assert.equal(byPath['Prix de vente'].transform, 'money');
  assert.equal(byPath['Poids (kg)'].transform, 'weight_to_grams'); assert.deepEqual(byPath['Poids (kg)'].args, { unit: 'kg', decimal: '.' });
  assert.equal(byPath['Rayon'].transform, 'category_path_split');
  assert.ok(fmt.unknownFields.some((u) => u.path === 'Colonne interne'), 'unrecognised column listed, not dropped');

  const learnedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-learn-'));
  const store = createJsonKnowledgeStore({ referenceDir: path.join(ROOT, 'core', 'knowledge-ref'), learnedDir });
  await store.putLearnedFormat(fmt);
  assert.equal(await store.origin(fmt.id), 'learned');
  const formats = await loadAllFormats(store);
  const det = detectFormat(t.headers, formats);
  assert.equal(det.format, 'knowledge'); assert.equal(det.knowledgeId, fmt.id);
  assert.equal(detectFormat(t.headers).format, 'unknown', 'Reference alone still does not know it');

  const res = convert(csv, { direction: 'eloshon-to-shopify', entity: 'products', expectPlatform: 'eloshon', knowledge: { formats } });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  const r = res.rows[0];
  assert.equal(r['Title'], 'Table basse chêne'); assert.equal(r['Variant Price'], '129.90'); assert.equal(r['Variant Barcodes'], '3701234567890');
  assert.equal(r['Variant Grams'], '12500'); assert.equal(r['Variant Inventory Qty'], '12'); assert.equal(r['Vendor'], 'Eloshon');
  assert.equal(r['Handle'], 'f-001', 'handle derived from the sku (provenance: default)');
  // the unknown column is preserved, not lost
  const { products } = parseCsvWithKnowledge(fmt.id, csv, { formats });
  assert.equal(products[0].sourceExtension.eloshon._raw['Colonne interne'], 'zz1');
  assert.ok(products[0].unmapped.some((u) => u.sourceField === 'Colonne interne' && u.reason === 'unknown'));
  assert.equal(products[0].provenance.handle.method, 'default');

  assert.equal(await store.removeLearnedFormat(fmt.id), true);
  assert.equal(detectFormat(t.headers, await loadAllFormats(store)).format, 'unknown');
});

// ── Single-language contract (name / description / slug, no *_en) ────────────────────
const V2_HEADER = 'slug,name,description,price,category_slug,barcode,hs_code,weight_kg,image_url,store_slug,source_url,source_product_id,source_category,product_type,storage_info,is_alcoholic,color,variants,weight_estimated,brand,availability,rating,review_count,net_content,technical_specs';
const v2Row = (name, id, extra = {}) => {
  const r = { slug: `${name.toLowerCase().replace(/\W+/g, '-')}-abc123`, name, description: 'Ligne 1.\nLigne 2, avec "guillemets".', price: '85', category_slug: '', barcode: '', hs_code: '', weight_kg: '', image_url: 'https://cdn.x/a.jpg', store_slug: 'adidas', source_url: `https://www.adidas.be/fr/x/${id}.html`, source_product_id: id, source_category: 'Vêtements', product_type: '', storage_info: '', is_alcoholic: '', color: '', variants: '', weight_estimated: '', brand: 'adidas', availability: '', rating: '', review_count: '', net_content: '', technical_specs: '', ...extra };
  return V2_HEADER.split(',').map((h) => { const v = r[h]; return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(',');
};

test('a current Scraper export (name / description / slug, 25 columns) is recognised as v2 and converts with its title, description and brand', () => {
  const csv = '﻿' + [V2_HEADER, v2Row('Sweat-shirt à capuche', 'LF3019'), v2Row('Jogger NY', 'LD1614')].join('\r\n') + '\r\n';
  assert.equal(detectFormat(parseCsv(csv).headers).knowledgeId, 'scraper.eloshon-export.v2');
  const res = convert(csv, { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' });
  assert.equal(res.ok, true);
  assert.equal(res.counts.failedUnits, 0);
  assert.deepEqual(res.rows.map((r) => r.Title), ['Sweat-shirt à capuche', 'Jogger NY']);
  assert.deepEqual(res.rows.map((r) => r.Vendor), ['adidas', 'adidas']);
  assert.match(res.rows[0]['Body (HTML)'], /guillemets/);
  assert.equal(res.rows[0].Handle, parseCsv(csv).rows[0].slug, 'the handle is the slug the Scraper wrote');
});

test('an export from an older version (slug_fr / name_fr, with the *_en mirror) is still read as v1', () => {
  assert.equal(detectFormat(parseCsv(read(FILES[0])).headers).knowledgeId, 'scraper.eloshon-export.v1');
});

test('a current products.json (name / description, no *_en) is recognised as v2 and converts', () => {
  const json = JSON.stringify([{ store_slug: 'demo', source_url: 'https://shop.example/p/a', source_product_id: 'A-1', source_category: 'Maison > Déco', product_type: null, name: 'Vase en verre', description: 'Vase soufflé.', storage_info: null, price: 39.9, weight_kg: 0.8, barcode: null, hs_code: null, images: ['https://shop.example/a1.jpg'], image_url: 'https://shop.example/a1.jpg', category_slug: null, color: null, variants: null, raw: { brand: 'Verrerie', currency: 'EUR' } }]);
  assert.equal(detectJson(json)?.knowledgeId, 'scraper.products-json.v2');
  const res = convert(json, { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' });
  assert.equal(res.ok, true);
  assert.equal(res.rows[0].Title, 'Vase en verre');
  assert.equal(res.rows[0].Vendor, 'Verrerie');
  assert.match(res.rows[0].Handle, /^vase-en-verre-/, 'the same slug-plus-hash handle the Scraper CSV writes');
});
