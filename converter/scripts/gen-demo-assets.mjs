/**
 * Publish the ConversionDemo assets for the marketing site.
 *
 * HARD RULE (see docs + the site's ConversionDemo component): every figure the
 * site shows — a price, a row count, a discount — must come from the real
 * engine, never from a hand-typed constant. This script is the ONLY writer of
 * `C:/eloshon/public/converter-demo/`, and it copies bytes that
 * `npm run gen:golden` produced from the real converter. It also emits a
 * `manifest.json` that the component reads, so the pair list, the labels and
 * the counts all have a single machine-generated source of truth.
 *
 * `test/demo-assets.test.mjs` then re-derives every published figure
 * INDEPENDENTLY and fails the build on any divergence.
 *
 *   node scripts/gen-demo-assets.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');

/**
 * The marketing site lives in a SIBLING repo named `eloshon`. The converter
 * has lived at two depths (standalone `C:\eloshon-converter`, monorepo
 * `C:\eloshon-scraper\converter`), so the site is located by candidates — or
 * named explicitly with ELOSHON_SITE_DIR. Exported so demo-assets.test.mjs
 * verifies the SAME directory this script publishes to: one resolver, no
 * duplicated path that could drift.
 */
export function resolveSitePublic(env = process.env) {
  if (env.ELOSHON_SITE_DIR) return path.join(env.ELOSHON_SITE_DIR, 'public', 'converter-demo');
  const candidates = [path.resolve(ROOT, '..', 'eloshon'), path.resolve(ROOT, '..', '..', 'eloshon')];
  const hit = candidates.find((d) => existsSync(path.join(d, 'public')));
  // No site found: fall back to the deepest candidate (monorepo layout) so the
  // error message / publish target is at least deterministic.
  return path.join(hit ?? candidates[candidates.length - 1], 'public', 'converter-demo');
}
export const SITE_PUBLIC = resolveSitePublic();

/**
 * Every published pair. `golden` names the frozen case (test/golden/<golden>.*),
 * `sources` the real input files (test/fixtures/...). Nothing else may be
 * published: the verification test walks exactly this list.
 */
export const DEMO_PAIRS = [
  {
    key: 'thunderbit_shopify', group: 'scraping',
    fromLabel: 'Thunderbit (scraping)', toLabel: 'Shopify',
    golden: 'thunderbit_growshops__to_shopify', sourceKind: 'csv',
    sources: [{ file: 'scraper/Thunderbit_5dad1f_20251112_233804.csv', as: 'thunderbit_source.csv' }],
    blurb: 'generic_scrape',
  },
  {
    key: 'levis_shopify', group: 'scraping',
    fromLabel: "Levi's (Eloshon Scraper)", toLabel: 'Shopify',
    golden: 'scraper_levis__to_shopify', sourceKind: 'csv',
    sources: [{ file: 'scraper/levis-be.csv', as: 'levis_source.csv' }],
    blurb: 'scraper_chain',
  },
  {
    key: 'lidl_shopify', group: 'scraping',
    fromLabel: 'Lidl.de (Eloshon Scraper)', toLabel: 'Shopify',
    golden: 'scraper_lidl__to_shopify', sourceKind: 'csv',
    sources: [{ file: 'scraper/lidl-de.csv', as: 'lidl_source.csv' }],
    blurb: 'scraper_chain',
  },
  {
    key: 'colruyt_woo', group: 'scraping',
    fromLabel: 'Colruyt.be (Eloshon Scraper)', toLabel: 'WooCommerce',
    golden: 'scraper_colruyt__to_woo', sourceKind: 'csv',
    sources: [{ file: 'scraper/colruyt-be.csv', as: 'colruyt_source.csv' }],
    blurb: 'missing_price',
  },
  {
    key: 'wix_shopify', group: 'platform',
    fromLabel: 'Wix', toLabel: 'Shopify',
    golden: 'wix__to_shopify', sourceKind: 'csv',
    sources: [{ file: 'wix_products.csv', as: 'wix_source.csv' }],
  },
  {
    key: 'shopify_woo', group: 'platform',
    fromLabel: 'Shopify', toLabel: 'WooCommerce',
    golden: 'shopify_products__to_woo', sourceKind: 'csv',
    sources: [{ file: 'shopify_products.csv', as: 'shopify_source.csv' }],
  },
  {
    key: 'bigcommerce_shopify', group: 'platform',
    fromLabel: 'BigCommerce', toLabel: 'Shopify',
    golden: 'bigcommerce__to_shopify', sourceKind: 'csv',
    sources: [{ file: 'bigcommerce_products.csv', as: 'bigcommerce_source.csv' }],
  },
  {
    key: 'woo_wix', group: 'platform',
    fromLabel: 'WooCommerce', toLabel: 'Wix',
    golden: 'woo_modern__to_wix', sourceKind: 'csv',
    sources: [{ file: 'woo_products_modern.csv', as: 'woo_source.csv' }],
  },
  {
    key: 'shopware_shopify', group: 'platform',
    fromLabel: 'Shopware', toLabel: 'Shopify',
    golden: 'shopware_api__to_shopify', sourceKind: 'json',
    sources: [
      { file: 'live/shopware-test/products.json', as: 'shopware_source.json' },
      { file: 'live/shopware-test/variations.json', as: 'shopware_variations.json' },
    ],
  },
  {
    key: 'prestashop_shopify', group: 'platform',
    fromLabel: 'PrestaShop', toLabel: 'Shopify',
    golden: 'prestashop_products__to_shopify', sourceKind: 'json',
    sources: [
      { file: 'live/prestashop-test/products.json', as: 'prestashop_source.json' },
      { file: 'live/prestashop-test/combinations.json', as: 'prestashop_combinations.json' },
    ],
  },
  {
    key: 'customers_woo', group: 'customers',
    fromLabel: 'Clients Shopify', toLabel: 'WooCommerce',
    golden: 'synthetic_customers__to_woo', sourceKind: 'csv',
    sources: [{ file: 'shopify-customers-synthetic/customers_export.csv', as: 'customers_source.csv' }],
    blurb: 'synthetic_customers',
  },
];

const goldenPath = (name, ext) => path.join(ROOT, 'test', 'golden', `${name}.${ext}`);
const fixturePath = (rel) => path.join(ROOT, 'test', 'fixtures', rel);

function main() {
  // REFUSE, don't guess: publishing into a phantom directory while the real
  // site keeps serving stale assets is the silent failure mode. The site's
  // own public/ must already exist (candidates or ELOSHON_SITE_DIR).
  if (!existsSync(path.resolve(SITE_PUBLIC, '..'))) {
    console.error(`gen-demo-assets: no marketing-site checkout found (looked for a sibling 'eloshon/public'). Set ELOSHON_SITE_DIR to the site repo. Refusing to publish into ${SITE_PUBLIC}.`);
    process.exit(1);
  }
  if (!existsSync(SITE_PUBLIC)) mkdirSync(SITE_PUBLIC, { recursive: true });

  // Start from a clean slate so a removed pair cannot leave a stale file the
  // component might still be pointing at.
  for (const f of readdirSync(SITE_PUBLIC)) {
    if (/\.(csv|json)$/.test(f)) unlinkSync(path.join(SITE_PUBLIC, f));
  }

  const pairs = [];
  for (const p of DEMO_PAIRS) {
    const metaRaw = readFileSync(goldenPath(p.golden, 'meta.json'), 'utf8');
    const meta = JSON.parse(metaRaw);
    if (!meta.ok) throw new Error(`${p.key}: golden ${p.golden} is not ok — refusing to publish`);

    const targetName = `${p.key}_output.csv`;
    writeFileSync(path.join(SITE_PUBLIC, targetName), readFileSync(goldenPath(p.golden, 'out.csv')));

    const sources = [];
    for (const s of p.sources) {
      writeFileSync(path.join(SITE_PUBLIC, s.as), readFileSync(fixturePath(s.file)));
      sources.push(`/converter-demo/${s.as}`);
    }

    pairs.push({
      key: p.key,
      group: p.group,
      fromLabel: p.fromLabel,
      toLabel: p.toLabel,
      sourceKind: p.sourceKind,
      blurb: p.blurb ?? null,
      sources,
      target: `/converter-demo/${targetName}`,
      golden: p.golden,
      sourceFormat: meta.sourceFormat,
      targetFormat: meta.targetFormat,
      counts: meta.counts,
      losses: meta.losses ?? [],
      warnings: meta.warnings ?? [],
      errors: meta.errors ?? [],
    });
  }

  const manifest = {
    // Not a timestamp: a build that only regenerates assets must stay
    // byte-identical so the verification test can compare freely.
    generator: 'scripts/gen-demo-assets.mjs',
    note: 'Generated from test/golden/* by the real converter engine. Never edit by hand.',
    pairs,
  };
  writeFileSync(path.join(SITE_PUBLIC, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(`published ${pairs.length} demo pairs → ${SITE_PUBLIC}`);
  for (const p of pairs) {
    console.log(`  ${p.key.padEnd(22)} ${String(p.counts.inputUnits).padStart(5)} units → ${String(p.counts.outputRows).padStart(5)} rows   (${p.golden})`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(HERE, 'gen-demo-assets.mjs')) main();
