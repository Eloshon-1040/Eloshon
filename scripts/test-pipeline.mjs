/**
 * Chantier C — End-to-end pipeline test: Scraper CSV -> Converter.
 * Uses cached bol.com products from the site catalogue test.
 * Tests conversion to Shopify and WooCommerce.
 */
import { toImportCsv } from '../core/csv.mjs';
import { convert } from '../converter/core/dist/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const CACHE_DIR = path.resolve('scripts/site-catalogue-results');
const OUT_DIR = path.resolve('scripts/pipeline-test-results');
fs.mkdirSync(OUT_DIR, { recursive: true });

const bolFile = path.join(CACHE_DIR, 'bol_com.json');
if (!fs.existsSync(bolFile)) {
  console.error('No cached bol.com products. Run test-sites-catalogue.mjs first.');
  process.exit(1);
}

const bolData = JSON.parse(fs.readFileSync(bolFile, 'utf-8'));
const products = bolData.products;
console.log(`Loaded ${products.length} bol.com products from cache`);

const csv = toImportCsv(products, { storeSlug: 'bol-com', categorySlug: 'electronics' });
const csvPath = path.join(OUT_DIR, 'bol-com-scraper.csv');
fs.writeFileSync(csvPath, csv);
console.log(`Scraper CSV: ${csvPath} (${csv.split('\n').length} rows)`);

function resultToCsv(result) {
  if (!result.headers || !result.rows) return '';
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const hdrs = result.headers;
  const lines = result.rows.map(r => {
    if (Array.isArray(r)) return r.map(esc).join(',');
    return hdrs.map(h => esc(r[h])).join(',');
  });
  return [hdrs.join(','), ...lines].join('\n');
}

function reportConversion(label, result, outBase) {
  const outCsv = resultToCsv(result);
  fs.writeFileSync(path.join(OUT_DIR, `${outBase}.csv`), outCsv);
  console.log(`\n--- ${label} ---`);
  console.log(`  ok: ${result.ok}`);
  console.log(`  Format: ${result.sourceFormat} -> ${result.targetFormat}`);
  console.log(`  Rows: ${result.rows?.length ?? 0}`);
  console.log(`  Output columns: ${(result.headers || []).length}`);
  if (result.headers?.length) console.log(`  Headers: ${result.headers.slice(0, 8).join(', ')}${result.headers.length > 8 ? '...' : ''}`);
  if (result.counts) console.log(`  Counts: ${JSON.stringify(result.counts)}`);
  if (result.warnings?.length) console.log(`  Warnings: ${result.warnings.map(w => w.code).join(', ')}`);
  if (result.errors?.length) console.log(`  Errors: ${result.errors.map(e => e.code || JSON.stringify(e)).join(', ')}`);
  if (result.losses?.length) console.log(`  Losses: ${result.losses.map(l => l.code || l.field).join(', ')}`);
  fs.writeFileSync(path.join(OUT_DIR, `${outBase}-report.json`), JSON.stringify({
    ok: result.ok, direction: result.direction, sourceFormat: result.sourceFormat,
    targetFormat: result.targetFormat, rowCount: result.rows?.length, columnCount: result.headers?.length,
    headers: result.headers, counts: result.counts, warnings: result.warnings,
    errors: result.errors, losses: result.losses, questions: result.questions,
  }, null, 2));
}

try {
  const shopify = convert(csv, { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' });
  reportConversion('Shopify', shopify, 'bol-com-shopify');
} catch (err) { console.error('Shopify conversion failed:', err.message); }

try {
  const woo = convert(csv, { direction: 'eloshon-to-woocommerce', expectPlatform: 'eloshon' });
  reportConversion('WooCommerce', woo, 'bol-com-woocommerce');
} catch (err) { console.error('WooCommerce conversion failed:', err.message); }

console.log(`\nPipeline test results: ${OUT_DIR}`);
