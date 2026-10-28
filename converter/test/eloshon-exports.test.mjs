// Phase 4 (28/10/2026): the Converter reads every Eloshon export by itself — the extension panel's CSV, a job's
// files, an .eloshon — and says what the file really holds (its export manifest) before converting it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convert, detectFormat, parseCsv } from '../core/dist/index.mjs';
import { readManifest, manifestSummary, formatFromManifest } from '../core/knowledge-proposal/export-manifest.mjs';
import { parseVariantText, axisNameFor } from '../core/knowledge-proposal/variant-text.mjs';
import { readFileManifest, manifestFormatFor } from '../app/manifest-sidecar.mjs';
import { buildStep3 } from '../app/step3-rows.mjs';
import { buildManifest } from '../../shared/export/manifest.mjs';

const HEAD = '"Nom","Prix","Prix barré","Marque","Collection","Image","Lien","Référence","Description","Caractéristiques techniques","Variantes"';
const PANEL = [HEAD,
  '"Eau de parfum Rose","69.53","81.8","Maison","Parfum > Femme","https://img.test/a.jpg, https://img.test/b.jpg","https://shop.test/p/1","1116707","Notes florales","Famille : Floral ; Notes : Rose","30 ML : 69.53 | 50 ML : 96.94 | 100 ML : 134.43 (épuisé)"',
  '"Savon","5","","Maison","Bain","https://img.test/c.jpg","https://shop.test/p/2","22","Doux","",""'].join('\n');
const run = (csv, tgt, formats) => convert(csv, { direction: `eloshon-to-${tgt}`, expectPlatform: 'eloshon', ...(formats ? { knowledge: { formats } } : {}) });

test('the panel CSV is recognised with no manual mapping; sizes become options with their own price', () => {
  assert.equal(detectFormat(parseCsv(PANEL).headers).knowledgeId || detectFormat(parseCsv(PANEL).headers).format, 'extension.panel-csv.fr.v1');
  const s = run(PANEL, 'shopify');
  assert.equal(s.ok, true); assert.equal(s.sourceFormat, 'extension.panel-csv.fr.v1');
  const rose = s.rows.filter((r) => r.Handle === 'eau-de-parfum-rose');
  assert.deepEqual(rose.map((r) => [r['Option1 Name'], r['Option1 Value'], r['Variant Price']]), [['Contenance', '30 ML', '69.53'], ['Contenance', '50 ML', '96.94'], ['Contenance', '100 ML', '134.43']]);
  assert.equal(rose[0].Vendor, 'Maison');
  // A scraped file: the source site's « épuisé » is not the merchant's stock — not tracked by default, said.
  assert.ok(rose.every((r) => r['Variant Inventory Qty'] === '' && r['Variant Inventory Tracker'] === ''));
  assert.ok(s.warnings.some((w) => w.code === 'stock_untracked'));
  const kept = convert(PANEL, { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon', stockMode: 'source' }).rows.filter((r) => r.Handle === 'eau-de-parfum-rose');
  assert.equal(kept[2]['Variant Inventory Qty'], '0', 'stockMode source: épuisé → stock 0');
  const cont = convert(PANEL, { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon', stockMode: 'continue' }).rows.filter((r) => r.Handle === 'eau-de-parfum-rose');
  assert.equal(cont[2]['Variant Inventory Policy'], 'continue');
  assert.match(rose[0]['Body (HTML)'], /Notes florales[\s\S]*<strong>Famille<\/strong> : Floral/);
  const w = run(PANEL, 'woocommerce');
  assert.deepEqual(w.rows.filter((r) => r.Type === 'variation').map((r) => r['Regular price']), ['69.53', '96.94', '134.43']);
  assert.equal(w.rows.find((r) => r.Type === 'variable')['Attribute 1 value(s)'], '30 ML, 50 ML, 100 ML');
  const x = run(PANEL, 'wix');
  assert.deepEqual(x.rows.filter((r) => r.handle === 'eau-de-parfum-rose' && r.fieldType === 'VARIANT').map((r) => r.price), ['69.53', '96.94', '134.43']);
});

test('a panel CSV with a column the user added is left to semantic recognition (nothing kept raw)', () => {
  const csv = PANEL.replace(HEAD, `${HEAD},"Couleur préférée"`).split('\n').map((l, i) => (i ? `${l},"bleu"` : l)).join('\n');
  assert.equal(detectFormat(parseCsv(csv).headers).format, 'unknown');
});

test('the « Variantes » text cell: value : price, (épuisé), names only; the axis is named from the values', () => {
  assert.deepEqual(parseVariantText('30 ML : 77.7 | 50 ML : 115.5 (épuisé)'), [{ type: 'Contenance', name: '30 ML', price: '77.7' }, { type: 'Contenance', name: '50 ML', price: '115.5', availability: 'OutOfStock' }]);
  assert.deepEqual(parseVariantText('S, M, L').map((o) => [o.type, o.name]), [['Taille', 'S'], ['Taille', 'M'], ['Taille', 'L']]);
  assert.equal(axisNameFor(['Bleu', 'Noir']), 'Variante');
  assert.deepEqual(parseVariantText('[{"name":"x"}]'), [], 'JSON is read by parseJson');
});

test('the manifest the Scraper writes is read, summarised in 4 languages, and its column roles recognise renamed columns', () => {
  const scraperSide = buildManifest({ source: 'extension', rows: Array.from({ length: 864 }, () => ({})), accepted: false, productPages: { toRead: 864, read: 2, blocked: [{ url: 'https://shop.test/p/1', reason: 'human_check' }] },
    columns: [{ key: 'name', label: 'Titre', role: 'title' }, { key: 'price', label: 'Tarif', role: 'price' }, { key: 'coloris', label: 'Coloris', role: 'color' }, { key: 'pointure', label: 'Pointure', role: 'size' }] });
  const m = readManifest(JSON.stringify(scraperSide));
  assert.equal(m.status, 'preview'); assert.equal(m.productPages.humanCheck, 1); assert.equal(m.productPages.notOpened, 861);
  // A preview is not a reading that stopped: 3 pages were opened FOR the preview, the 861 others wait for « Accepter ».
  assert.equal(manifestSummary(m, 'fr').text, 'Aperçu de l’extension : 3 fiches produit ouvertes sur 864 à lire (2 lues, 1 bloquée par une vérification humaine) ; les 861 autres ne sont pas encore lues : l’aperçu n’en ouvre que quelques-unes');
  assert.equal(manifestSummary(m, 'en').text, 'Extension preview: 3 product pages opened out of 864 to read (2 read, 1 blocked by a human check); the other 861 are not read yet: the preview opens only a few');
  assert.doesNotMatch(manifestSummary(m, 'fr').text, /non ouverte/);
  for (const l of ['nl', 'es']) assert.ok(manifestSummary(m, l).text.length > 20);
  assert.equal(readManifest({ kind: 'other' }), null);
  const csv = '"Titre","Tarif","Coloris","Pointure"\n"Basket X","99","Blanc, Noir","40 | 41 | 42"';
  const fmt = formatFromManifest(m, parseCsv(csv).headers);
  const s = run(csv, 'shopify', [fmt]);
  assert.equal(s.ok, true, JSON.stringify(s.errors));
  assert.equal(s.rows.length, 6, 'every colour × size combination');
  assert.deepEqual([s.rows[0]['Option1 Name'], s.rows[0]['Option2 Name']], ['Coloris', 'Pointure']);
  assert.ok(s.rows.every((r) => r['Variant Price'] === '99.00'));
  assert.equal(formatFromManifest(m, ['Tarif']), null, 'no title column → no format');
  // A picker designated with 🎯 on a field the user left as « Champ 1 »: the option takes the page's own name.
  const m2 = readManifest({ ...scraperSide, columns: [{ key: 'name', label: 'Titre', role: 'title' }, { key: 'champ_1', label: 'Champ 1', role: 'option', axis: 'Contenance' }] });
  const csv2 = '"Titre","Champ 1"\n"Rose","30 ML | 50 ML"';
  const s2 = run(csv2, 'shopify', [formatFromManifest(m2, parseCsv(csv2).headers)]);
  assert.deepEqual(s2.rows.map((r) => [r['Option1 Name'], r['Option1 Value']]), [['Contenance', '30 ML'], ['Contenance', '50 ML']]);
});

test('the manifest is found beside the file: panel CSV, job CSV, products.json, .eloshon header', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-mf-'));
  const mf = JSON.stringify(buildManifest({ source: 'app', jobId: 'J1', accepted: true, rows: [{}], productPages: { toRead: 1, read: 1 } }));
  fs.writeFileSync(path.join(dir, 'eloshon-shop-20261028-100000.csv'), PANEL);
  fs.writeFileSync(path.join(dir, 'eloshon-shop-20261028-100000.manifest.json'), mf);
  assert.equal(readFileManifest(path.join(dir, 'eloshon-shop-20261028-100000.csv'), PANEL).status, 'complete');
  fs.mkdirSync(path.join(dir, 'job'));
  fs.writeFileSync(path.join(dir, 'job', 'products.json'), '[]'); fs.writeFileSync(path.join(dir, 'job', 'manifest.json'), mf);
  assert.equal(readFileManifest(path.join(dir, 'job', 'products.json'), '[]').jobId, 'J1');
  const eloshon = JSON.stringify({ eloshon: { kind: 'catalog', manifest: JSON.parse(mf) } });
  assert.equal(readFileManifest(null, eloshon).status, 'complete');
  assert.equal(readFileManifest(path.join(dir, 'none.csv'), 'a,b'), null);
  assert.equal(manifestFormatFor(readManifest(mf), PANEL), null, 'no column roles → no format of its own');
});

test('step 3 counts every row: a column filled only after row 200 is not « Vide »; the type is read on filled values', () => {
  const rows = Array.from({ length: 864 }, (_, i) => ({ Nom: `P${i}`, Prix: String(i + 1), Description: i > 600 && i < 603 ? 'Texte lu sur la fiche' : '' }));
  const a = { detection: { format: 'unknown', entity: 'products' }, learn: { semantic: { columns: [] } }, targetFormat: null };
  const st = buildStep3(a, { headers: ['Nom', 'Prix', 'Description'], rows, overrides: {}, direction: 'eloshon-to-shopify' });
  const desc = st.rows.find((r) => r.column === 'Description');
  assert.equal(desc.filled, 2); assert.equal(desc.total, 864);
  assert.notEqual(desc.level, 'empty');
  assert.equal(st.rowCount, 864); assert.equal(st.analysedRows, 864);
});
