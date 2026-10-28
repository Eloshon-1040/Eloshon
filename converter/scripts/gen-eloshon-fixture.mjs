/**
 * Builds test/fixtures/eloshon/catalog-edited.eloshon with the catalog's OWN
 * writer (newEloshon + CommandLog, vendored byte-identical in core/vendor) —
 * never a hand-rolled envelope. The catalogue is the canon the products.json
 * entry produces for test/fixtures/scraper/products-json/derived-21gen.json
 * (a realistic Scraper catalogue), stored as CatalogProducts (canon + id /
 * sourceUrl / sourceProductId / strategy / confidence), with a real edit
 * history: a title rewrite, a bulk vendor change and one removed product, plus
 * a customers container so the "other entities" report has something to say.
 *
 * createdAt and the command ids/timestamps are pinned so the file is
 * reproducible:  node scripts/build-engine.mjs && node scripts/gen-eloshon-fixture.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonWithKnowledge } from '../core/dist/index.mjs';
import { newEloshon, stringifyEloshon, CommandLog } from '../core/vendor/eloshon-catalog/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const PINNED_AT = '2026-10-04T09:00:00.000Z';

const scraped = JSON.parse(fs.readFileSync(path.join(FIX, 'scraper', 'products-json', 'derived-21gen.json'), 'utf8'));
const { products: canon } = parseJsonWithKnowledge('scraper.products-json.v1', scraped);

// CatalogProduct = Canon + the catalog's own identity/provenance extras.
const products = canon.map((p, i) => {
  const ext = p.sourceExtension?.eloshon ?? {};
  return { id: `p${i + 1}`, ...p, sourceUrl: ext.source_url, sourceProductId: p.identity?.sourceId, strategy: ext.extractor, confidence: ext.confidence };
});

const customers = [{
  firstName: 'Camille', lastName: 'Durand', email: 'camille.durand@example.com', phone: '', note: '', tags: [], taxExempt: false,
  address: { company: '', address1: '12 rue des Fleurs', address2: '', city: 'Lyon', province: '', provinceCode: '', country: 'FR', zip: '69001', phone: '' },
  shipping: null, acceptsEmail: null, acceptsSms: null,
}];

const file = newEloshon({ products, customers, source: { type: 'scrape', platform: 'generic', origin: 'https://shop.example' }, generator: 'eloshon-fixture-generator' });
file.eloshon.createdAt = PINNED_AT;

const log = CommandLog.fromFile(file);
log.setField('p1', 'title', 'Housse de coussin en lin lavé — bleu', 'Titre retravaillé');
log.bulkSetField(['p1', 'p2'], 'vendor', 'Lin & Co (Belgique)', 'Marque harmonisée');
log.remove('p4', 'Produit retiré du catalogue');
const out = log.writeInto(file);
out.edits.commands = out.edits.commands.map((c, i) => ({ ...c, id: `cmd-${i + 1}`, at: PINNED_AT }));

const dir = path.join(FIX, 'eloshon');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'catalog-edited.eloshon'), stringifyEloshon(out) + '\n');
console.log('wrote', path.join(dir, 'catalog-edited.eloshon'), `(${products.length} products, ${out.edits.commands.length} edits, ${customers.length} customer)`);
