/**
 * adidas, audited on the saved product page (core/__tests__/fixtures/sites/adidas.be.product.html.gz) and on the rows of
 * the real export of 28/10 (eloshon-adidas.be-20261028-192831.csv, « chaussures-hommes »):
 *   - the « specifications » were the site's feature flags (« ADIPULSE_ENABLED : off = false »); now its « usps »;
 *   - the RDFa breadcrumb (« Accueil > Originals > Chaussures ») was not read;
 *   - the card subtitle read as « Description » (« Femmes Originals ») kept the page's real description out;
 *   - women's products in the men's list (their card says « Femmes ») were imported as men's;
 *   - a size group read as one glued text (« 35 1/23636 2/3… »);
 *   - the declared variants mixed the OTHER colourways (links to their own pages, no size) with this page's sizes, each
 *     named « colourway / size » (« Grey Three / Off White / Gum, Grey Three / Off White / Gum / 35 1/2, … »).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { extractProduct } from '../../core/extract.mjs';
import { enrichFromDetailPages, isLabelText } from '../../core/detail-enrich.mjs';
import { audienceVerdict, audienceOf } from '../../shared/extract/collection-check.mjs';
import { groupedText } from '../../shared/knowledge/readers.mjs';
import { structuredOf } from '../../shared/knowledge/structured.mjs';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../controller.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = zlib.gunzipSync(fs.readFileSync(path.join(HERE, '..', '..', 'core', '__tests__', 'fixtures', 'sites', 'adidas.be.product.html.gz'))).toString('utf8');
const PDP = 'https://www.adidas.be/fr/chaussure-handball-spezial/IF6490.html';
const LIST = 'https://www.adidas.be/fr/chaussures-hommes';

test('the product page: its real details (usps), never the feature flags; its RDFa breadcrumb', () => {
  const { product } = extractProduct(PAGE, PDP);
  const specs = Object.fromEntries((product.specs || []).map((s) => [s.name, s.value]));
  assert.equal(specs.Tige, 'Cuir'); assert.equal(specs.Doublure, 'Autres Fibres / Textile');
  assert.match(specs['Détails'], /Chaussant standard · Fermeture à lacets/);
  assert.ok(!(product.specs || []).some((s) => /ADIPULSE|NEWSLETTER|^(on|off)$/i.test(`${s.group || ''} ${s.name}`)), 'no configuration entry');
  assert.deepEqual(product.breadcrumb, ['Accueil', 'Originals', 'Chaussures']);
});

test('the declared variants are this colourway\'s sizes, named by the size; the other colourways are not variants', () => {
  // The page's ProductGroup: variesBy colour + size; 22 sizes of « Earth Strata / Off White / Gum » + 17 colourway
  // entries without a size (each one its own product page).
  const v = structuredOf(PAGE, PDP).variants.value;
  assert.equal(v.length, 22);
  assert.deepEqual(v.slice(0, 3).map((x) => [x.name, x.code, x.price]), [['35 1/2', 'IF6490_520', 110], ['36', 'IF6490_530', 110], ['36 2/3', 'IF6490_540', 110]]);
  assert.ok(!v.some((x) => / \/ |Beige|Marron|Earth Strata/.test(x.name)), 'no colourway, no « colour / size » name');
});

test('a list « description » that is only the card subtitle gives way to the page\'s description, and is kept', async () => {
  assert.equal(isLabelText('Femmes Originals'), true); assert.equal(isLabelText('Originals'), true);
  assert.equal(isLabelText('Cette chaussure adidas Handball Spezial est celle qu’il te faut. Conçue en 1979.'), false);
  const row = { name: 'Chaussure Handball Spezial', price: 110, sourceUrl: PDP, sku: 'IF6490', description: 'Originals' };
  await enrichFromDetailPages([row], { fetchHtml: async () => ({ ok: true, html: PAGE, status: 200 }) });
  assert.match(row.description, /^Cette chaussure adidas Handball Spezial/); assert.equal(row.subtitle, 'Originals');
});

test('the audience: a « hommes » list keeps « Hommes » and unisex products, flags « Femmes » ones', () => {
  assert.equal(audienceOf('/fr/chaussures-hommes'), 'men'); assert.equal(audienceOf('Femmes Originals'), 'women'); assert.equal(audienceOf('Originals'), null);
  assert.equal(audienceVerdict({ listText: '/fr/chaussures-hommes', productTexts: ['Hommes Originals'] }), null);
  assert.equal(audienceVerdict({ listText: '/fr/chaussures-hommes', productTexts: ['Originals'] }), null);
  assert.equal(audienceVerdict({ listText: '/fr/chaussures-hommes', productTexts: ['Unisexe'] }), null);
  assert.match(audienceVerdict({ listText: '/fr/chaussures-hommes', productTexts: ['Femmes Originals'] }).reason, /« Femmes Originals » \(femmes\), la liste lue est pour les hommes/);
  assert.equal(audienceVerdict({ listText: '/collections/led-grow-light-fr', productTexts: ['Femmes'] }), null, 'a list for no audience: no verdict');
});

test('the real « chaussures-hommes » rows of 28/10: the three cards marked « Femmes Originals » are « à vérifier », not imported', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-adi-'));
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, sideData: { enabled: false } }));
  const ctl = createController({ dirs, emit: () => {} });
  const r = (name, code, sub, price) => ({ name, price, currency: 'EUR', sku: code, description: sub, sourceUrl: `https://www.adidas.be/fr/x/${code}.html`, images: [`https://assets.adidas.test/${code}.jpg`] });
  const rows = [r('Chaussure Handball Spezial', 'IF6490', 'Originals', 110), r('CHAUSSURE SAMBA OG', 'IH3979', 'Femmes Originals', 120), r('Gazelle Indoor Bad Bunny', 'KI2592', 'Hommes Originals', 140), r('CHAUSSURE HANDBALL SPEZIAL', 'KI2194', 'Femmes Originals', 110), r('CHAUSSURE SAMBA OG', 'IH9052', 'Femmes Originals', 140)];
  const res = await ctl.ingestExternalProducts({ products: rows, origin: LIST, method: 'your-browser', listing: { trail: ['Accueil', 'Chaussures', 'Hommes'] } });
  const prods = JSON.parse(fs.readFileSync(path.join(dirs.jobs, res.jobId, 'products.json'), 'utf8'));
  const st = Object.fromEntries(prods.map((p) => [p.source_url.match(/(\w+)\.html$/)[1], p.__eligibility.status]));
  assert.deepEqual(st, { IF6490: 'accepted', IH3979: 'to_verify', KI2592: 'accepted', KI2194: 'to_verify', IH9052: 'to_verify' });
});

test('a group of size buttons read by a taught rule: one value per size', () => {
  const d = parseHTML('<div class="sizes"><button>35 1/2</button><button>36</button><button>36 2/3</button><button>37 1/3</button></div><p class="t">Une chaussure <b>iconique</b>.</p>').document;
  assert.equal(groupedText(d.querySelector('.sizes')), '35 1/2 | 36 | 36 2/3 | 37 1/3');
  assert.equal(groupedText(d.querySelector('.t')), null);
});
