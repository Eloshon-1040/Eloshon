/**
 * Captures test/fixtures/scraper/products-json/extension-lane.json: the
 * products.json the Eloshon Scraper writes for an EXTENSION ("your browser")
 * run — produced by the Scraper's own code (app/controller.mjs
 * ingestExternalProducts → toNormalizedProduct → eligibility → job folder),
 * fully offline, in a throw-away data dir, from the payload the Scraper's own
 * test uses (app/__tests__/controller-ingest.test.mjs) plus one product with
 * the optional fields the extension may send (images, sourceUrl).
 *
 * Monorepo-only dev tool (it imports the Scraper app); the fixture it writes
 * is what the Converter tests and the bench read.
 *   node scripts/capture-extension-lane-fixture.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONVERTER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRAPER = path.resolve(CONVERTER, '..');
const { appDirs, ensureDirs } = await import(new URL('file:///' + path.join(SCRAPER, 'lib', 'osenv.mjs').replace(/\\/g, '/')).href);
const { createController } = await import(new URL('file:///' + path.join(SCRAPER, 'app', 'controller.mjs').replace(/\\/g, '/')).href);

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-ext-lane-'));
const dirs = ensureDirs(appDirs(base));
const controller = createController({ dirs, emit: () => {} });
const r = await controller.ingestExternalProducts({
  store: 'colruyt', lang: 'fr',
  products: [
    { name: 'Lait 1L', price: 1.29, sku: 'C1', images: ['https://img/1.jpg'], sourceUrl: 'https://x/1' },
    { name: 'Lait 1L', price: 1.29, sku: 'C1', images: ['https://img/1.jpg'], sourceUrl: 'https://x/1' },
    { name: 'Beurre 250g', price: 2.49, sku: 'C2', sourceUrl: 'https://x/2' },
    { name: 'Café moulu 500g', price: 5.99, sku: 'C3', images: ['https://img/3a.jpg', 'https://img/3b.jpg'], sourceUrl: 'https://x/3' },
  ],
});
// <data>/jobs/<id>/products.json (Scraper core/jobstore.mjs layout)
const find = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? find(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const file = find(base).find((f) => f.endsWith(path.join(r.jobId, 'products.json')));
if (!file) throw new Error('products.json of job ' + r.jobId + ' not found');
const products = JSON.parse(fs.readFileSync(file, 'utf8'));
const out = path.join(CONVERTER, 'test', 'fixtures', 'scraper', 'products-json', 'extension-lane.json');
fs.writeFileSync(out, JSON.stringify(products, null, 2) + '\n');
console.log('wrote', out, `(${products.length} products from job ${r.jobId})`);
fs.rmSync(base, { recursive: true, force: true });
