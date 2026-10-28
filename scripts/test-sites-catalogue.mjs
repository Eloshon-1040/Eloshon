/**
 * Chantier B — Test candidate e-commerce sites for free scraping.
 * For each site: probe -> classify easy/hard -> if easy, extract up to 10 products.
 * Usage: node scripts/test-sites-catalogue.mjs [--site <domain>]
 */
import { Fetcher } from '../core/http-fetcher.mjs';
import { probeSource } from '../core/probe.mjs';
import { extractListing } from '../core/listing.mjs';
import { extractEmbeddedProducts } from '../core/embedded-state.mjs';
import { extractProduct } from '../core/extract.mjs';
import { toNormalizedProduct } from '../core/normalize.mjs';
import { deriveSelectorRecipe, applySelectorRecipe } from '../core/recipe-producer.mjs';
import fs from 'node:fs';
import path from 'node:path';

const CANDIDATES = [
  { domain: 'colruyt.be', url: 'https://www.colruyt.be/fr/produits/boissons', country: 'BE', category: 'grocery' },
  { domain: 'delhaize.be', url: 'https://www.delhaize.be/fr/shop/Boissons/c/v2FRSH100000', country: 'BE', category: 'grocery' },
  { domain: 'brico.be', url: 'https://www.brico.be/fr/jardin-exterieur/mobilier-de-jardin/salons-de-jardin/c/010606', country: 'BE', category: 'diy' },
  { domain: 'coolblue.be', url: 'https://www.coolblue.be/fr/ordinateurs-portables', country: 'BE', category: 'electronics' },
  { domain: 'carrefour.fr', url: 'https://www.carrefour.fr/r/epicerie-sucree/chocolats', country: 'FR', category: 'grocery' },
  { domain: 'leroymerlin.fr', url: 'https://www.leroymerlin.fr/produits/peinture-droguerie/peinture-interieure/', country: 'FR', category: 'diy' },
  { domain: 'fnac.com', url: 'https://www.fnac.com/l-univers-livre/Livres-Litterature-Romans/s1?t=s', country: 'FR', category: 'media' },
  { domain: 'lidl.be', url: 'https://www.lidl.be/fr/c/bricolage-et-amenagement-du-jardin/s10013424', country: 'BE', category: 'discount' },
  { domain: 'mediamarkt.de', url: 'https://www.mediamarkt.de/de/category/notebooks-430.html', country: 'DE', category: 'electronics' },
  { domain: 'obi.de', url: 'https://www.obi.de/gartenmoebel/c/931', country: 'DE', category: 'diy' },
  { domain: 'otto.de', url: 'https://www.otto.de/mode/herrenmode/herrenbekleidung/', country: 'DE', category: 'fashion' },
  { domain: 'lidl.de', url: 'https://www.lidl.de/c/werkzeug-maschinen/s10007293', country: 'DE', category: 'discount' },
  { domain: 'bol.com', url: 'https://www.bol.com/nl/nl/l/laptops/4770/', country: 'NL', category: 'marketplace' },
  { domain: 'coolblue.nl', url: 'https://www.coolblue.nl/laptops', country: 'NL', category: 'electronics' },
  { domain: 'ah.nl', url: 'https://www.ah.nl/producten/dranken', country: 'NL', category: 'grocery' },
];

const OUT_DIR = path.resolve('scripts/site-catalogue-results');
const singleSite = process.argv.includes('--site')
  ? process.argv[process.argv.indexOf('--site') + 1]
  : null;
const candidates = singleSite
  ? CANDIDATES.filter(c => c.domain === singleSite || c.url.includes(singleSite))
  : CANDIDATES;

async function testSite(site) {
  const t0 = Date.now();
  const result = {
    domain: site.domain, url: site.url, country: site.country, category: site.category,
    classification: null, products: [], productCount: 0, error: null, durationMs: 0,
    method: null, fieldsAvailable: [], fieldsAbsent: [],
    probeDigest: null,
  };

  console.log(`\n--- ${site.domain} (${site.url}) ---`);
  try {
    const fetcher = new Fetcher({ minDelayMs: 800 });

    // Probe
    const probe = await probeSource(site.url, { fetcher });
    result.probeDigest = {
      diagnosis: probe.diagnosis, bestPath: probe.best_path,
      productCount: probe.product_count, platform: probe.platform,
      rendering: probe.rendering, confidence: probe.confidence,
      freeFields: probe.free_fields, unlockFields: probe.unlock_fields,
      absentFields: probe.absent_fields,
    };
    result.fieldsAvailable = probe.free_fields || [];
    result.fieldsAbsent = probe.absent_fields || [];
    console.log(`  Probe: ${probe.diagnosis} | path=${probe.best_path} | ${probe.product_count ?? 0} prod(s)`);

    if (probe.diagnosis === 'ok' && probe.best_path && !probe.protected_site) {
      result.classification = 'easy';
      result.method = probe.best_path;

      // Extract products
      const products = [];
      const homeRes = await fetcher.get(site.url);
      if (homeRes.ok) {
        const emb = extractEmbeddedProducts(homeRes.body, homeRes.url);
        for (const card of emb.cards.slice(0, 10)) {
          const np = toNormalizedProduct(card);
          if (np && np.name) products.push(np);
        }
        if (products.length < 10) {
          const lst = extractListing(homeRes.body, homeRes.url);
          for (const card of lst.cards) {
            if (products.length >= 10) break;
            const np = toNormalizedProduct(card);
            if (np && np.name && !products.some(p => p.source_url === np.source_url)) products.push(np);
          }
        }
        if (products.length === 0) {
          const { product } = extractProduct(homeRes.body, homeRes.url);
          if (product) { const np = toNormalizedProduct(product); if (np && np.name) products.push(np); }
        }
        if (products.length < 3 && homeRes.body) {
          try {
            const recipe = deriveSelectorRecipe(homeRes.body, homeRes.url);
            if (recipe) {
              for (const card of applySelectorRecipe(homeRes.body, recipe, homeRes.url)) {
                if (products.length >= 10) break;
                const np = toNormalizedProduct(card);
                if (np && np.name && !products.some(p => p.source_url === np.source_url)) products.push(np);
              }
            }
          } catch { /* best-effort */ }
        }
      }

      result.products = products;
      result.productCount = products.length;
      const hasPrice = products.filter(p => p.price != null && p.price > 0).length;
      console.log(`  Extracted ${products.length} prod(s), ${hasPrice} with price`);

      if (products.length < 3 || hasPrice < 2) {
        result.classification = 'hard';
        result.error = `Poor extraction: ${products.length} products, ${hasPrice} with price`;
        console.log(`  => DOWNGRADE to hard`);
      }
    } else if (probe.protected_site) {
      result.classification = 'hard';
      result.error = `Protected: ${probe.diagnosis}`;
    } else {
      result.classification = 'hard';
      result.error = `No free products: ${probe.diagnosis}`;
    }
  } catch (err) {
    result.classification = 'hard';
    result.error = `Exception: ${err.message}`;
    console.error(`  ERROR: ${err.message}`);
  }

  result.durationMs = Date.now() - t0;
  console.log(`  => ${result.classification} (${(result.durationMs / 1000).toFixed(1)}s)`);
  return result;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const results = [];
  for (const site of candidates) {
    const r = await testSite(site);
    results.push(r);
    fs.writeFileSync(path.join(OUT_DIR, `${site.domain.replace(/\./g, '_')}.json`), JSON.stringify(r, null, 2));
  }

  const easy = results.filter(r => r.classification === 'easy');
  const hard = results.filter(r => r.classification === 'hard');

  console.log('\n========== SUMMARY ==========');
  console.log(`Tested: ${results.length} | Easy: ${easy.length} | Hard: ${hard.length}`);
  for (const r of easy) console.log(`  [EASY] ${r.domain.padEnd(20)} ${r.productCount} prod — ${r.method}`);
  for (const r of hard) console.log(`  [HARD] ${r.domain.padEnd(20)} ${r.error}`);

  const report = {
    generated: new Date().toISOString(), totalTested: results.length,
    easyCount: easy.length, hardCount: hard.length,
    sites: results.map(r => ({ domain: r.domain, url: r.url, country: r.country, category: r.category,
      classification: r.classification, method: r.method, productCount: r.productCount,
      fieldsAvailable: r.fieldsAvailable, fieldsAbsent: r.fieldsAbsent, error: r.error, durationMs: r.durationMs })),
    easyProducts: Object.fromEntries(easy.map(r => [r.domain, r.products])),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'catalogue-report.json'), JSON.stringify(report, null, 2));
  console.log(`Report: ${OUT_DIR}/catalogue-report.json`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
