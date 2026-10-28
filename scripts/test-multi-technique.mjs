/**
 * Step 2b-d — Multi-technique re-classification of 17 e-commerce sites.
 *
 * For each site: tests a listing page and up to 2 product pages with every
 * technique combination (fetch method x data extraction), cheapest first.
 * Records EVERY attempt; keeps the cheapest successful combination.
 *
 * Classification:
 *   http      — works without a browser
 *   browser   — needs Playwright/Edge (free)
 *   protected — blocked after all techniques
 *
 * Usage:
 *   node scripts/test-multi-technique.mjs
 *   node scripts/test-multi-technique.mjs --site colruyt.be
 *   node scripts/test-multi-technique.mjs --skip-browser   (HTTP-only pass)
 *   node scripts/test-multi-technique.mjs --skip-unlock     (no nodriver)
 */
import { Fetcher } from '../core/http-fetcher.mjs';
import { extractListing } from '../core/listing.mjs';
import { extractEmbeddedProducts } from '../core/embedded-state.mjs';
import { extractProduct } from '../core/extract.mjs';
import { classifyResponse, STATUS } from '../core/detect.mjs';
import { BrowserSession, browserAvailable } from '../core/browser.mjs';
import { unlockAvailable, unlockRender } from '../core/unlock.mjs';
import { runRecipeLane, replayInternalApi, resolveHeaders, defaultHttpGet, mapItem } from '../core/internal-api.mjs';
import fs from 'node:fs';
import path from 'node:path';

// ─── Recipe loading ────────────────────────────────────────────────────────
const RECIPE_DIR = path.resolve('core/recipes');
function loadRecipe(domain) {
  const fp = path.join(RECIPE_DIR, `${domain.replace(/\./g, '-')}.json`);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return null; }
}

async function fetchRecipe(url, domain, country) {
  const t0 = Date.now();
  const recipe = loadRecipe(domain);
  if (!recipe) return { html: '', status: 0, blocked: false, blockCode: 'NO_RECIPE', error: 'no recipe for domain', durationMs: Date.now() - t0, bytes: 0, recipeProducts: [] };
  const httpGet = defaultHttpGet();

  async function browserBootstrap({ recipe: r, categoryUrl, pending }) {
    if (skipBrowser || !(await browserAvailable())) return { vars: {}, cookie: '', error: 'browser unavailable' };
    const pw = await import('playwright');
    const browser = await pw.chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
    const ctx = await browser.newContext({ locale: 'fr-BE', viewport: { width: 1366, height: 900 } });
    await ctx.addInitScript(() => { try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {} });
    const page = await ctx.newPage();
    try {
      await page.goto(r.vars?._session?.from || categoryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch {}
      try {
        await page.evaluate(() => {
          const rx = /^(accept|tout accepter|j.accepte|accepter|ok)$/i;
          const el = [...document.querySelectorAll('button,a,[role="button"]')].find(b => rx.test((b.textContent || '').trim()));
          if (el) el.click();
        });
      } catch {}
      await page.waitForTimeout(1000);
      const cookies = await ctx.cookies();
      const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      const vars = {};
      const html = await page.content();
      for (const name of pending) {
        const spec = r.vars?.[name];
        if (spec?.pattern) { const m = html.match(new RegExp(spec.pattern)); if (m) vars[name] = m[1] ?? m[0]; }
      }
      // Also extract dynamic headers from the browser-rendered page
      // (the plain-HTTP resolveHeaders may be blocked by anti-bot)
      const dynHeaders = r.headers || {};
      for (const [hName, hSpec] of Object.entries(dynHeaders)) {
        if (typeof hSpec === 'object' && hSpec.pattern) {
          const hm = html.match(new RegExp(hSpec.pattern));
          if (hm && hm[1]) {
            r.static_headers = { ...(r.static_headers || {}), [hName]: hm[1] };
            delete r.headers[hName];
          }
        }
      }
      return { vars, cookie, error: null };
    } catch (e) {
      return { vars: {}, cookie: '', error: e.message };
    } finally {
      await page.close().catch(() => {});
      await ctx.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  // Resolve categoryId from URL slug + category_map
  const categorySlug = url.match(/produits\/(?:toutes-les-categories\/)?([^/?#]+)/)?.[1]
    || url.match(/\/(\d+)-[^/?#]+/)?.[1]
    || url.match(/\/([^/?#]+)\/?$/)?.[1];
  if (recipe.category_map && categorySlug) {
    const numericId = recipe.category_map[categorySlug];
    if (numericId) {
      const orig = recipe.vars?.categoryId;
      if (orig) recipe.vars.categoryId = { source: 'const', value: numericId };
    }
  }

  try {
    const result = await runRecipeLane(recipe, url, { httpGet, browserBootstrap, maxProducts: 30, maxPages: 2 });
    const products = result.products || [];
    return {
      html: '', status: result.ok ? 200 : 0, blocked: !result.ok,
      blockCode: result.ok ? STATUS.OK : 'RECIPE_FAILED',
      error: result.error, durationMs: Date.now() - t0, bytes: JSON.stringify(products).length,
      recipeProducts: products, usedBrowser: result.usedBrowser,
    };
  } catch (e) {
    return { html: '', status: 0, blocked: false, blockCode: 'RECIPE_ERROR', error: e.message, durationMs: Date.now() - t0, bytes: 0, recipeProducts: [] };
  }
}

// ─── Site definitions ───────────────────────────────────────────────────────
const SITES = [
  { domain: 'colruyt.be',      listing: 'https://www.colruyt.be/fr/produits/toutes-les-categories/boissons',               country: 'BE', category: 'grocery' },
  { domain: 'delhaize.be',     listing: 'https://www.delhaize.be/c/v2DRI',                                                country: 'BE', category: 'grocery' },
  { domain: 'brico.be',        listing: 'https://www.brico.be/fr/jardin-terrasse-exterieur/ga1/',                               country: 'BE', category: 'diy' },
  { domain: 'coolblue.be',     listing: 'https://www.coolblue.be/fr/ordinateurs-portables',                                country: 'BE', category: 'electronics' },
  { domain: 'carrefour.fr',    listing: 'https://www.carrefour.fr/r/epicerie-sucree/chocolats',                             country: 'FR', category: 'grocery' },
  { domain: 'leroymerlin.fr',  listing: 'https://www.leroymerlin.fr/produits/peinture-droguerie/peinture-interieure/',      country: 'FR', category: 'diy' },
  { domain: 'fnac.com',        listing: 'https://www.fnac.com/l-univers-livre/Livres-Litterature-Romans/s1?t=s',            country: 'FR', category: 'media' },
  { domain: 'lidl.be',         listing: 'https://www.lidl.be/q/search?q=bricolage',                                       country: 'BE', category: 'discount' },
  { domain: 'mediamarkt.de',   listing: 'https://www.mediamarkt.de/de/category/notebooks-430.html',                        country: 'DE', category: 'electronics' },
  { domain: 'obi.de',          listing: 'https://www.obi.de/search/gartenwerkzeug/',                                       country: 'DE', category: 'diy' },
  { domain: 'otto.de',         listing: 'https://www.otto.de/herren/mode/',                                                country: 'DE', category: 'fashion' },
  { domain: 'lidl.de',         listing: 'https://www.lidl.de/q/search?q=werkzeug',                                        country: 'DE', category: 'discount' },
  { domain: 'bol.com',         listing: 'https://www.bol.com/nl/nl/l/laptops/4770/',                                       country: 'NL', category: 'marketplace' },
  { domain: 'coolblue.nl',     listing: 'https://www.coolblue.nl/laptops',                                                 country: 'NL', category: 'electronics' },
  { domain: 'ah.nl',           listing: 'https://www.ah.nl/producten/20130/frisdrank-sappen-water',                        country: 'NL', category: 'grocery' },
  { domain: 'microfluo.net',   listing: 'https://www.microfluo.net/3-lampes-uv',                                           country: 'FR', category: 'specialty' },
  { domain: 'levi.com',        listing: 'https://www.levi.com/US/en_US/clothing/men/jeans/c/levi_clothing_men_jeans',       country: 'US', category: 'fashion' },
];

const COVERAGE_FIELDS = ['name', 'price', 'ean', 'sku', 'brand', 'category', 'image', 'weight', 'description'];

const OUT_DIR = path.resolve('scripts/site-catalogue-results');
const args = process.argv.slice(2);
const singleSite = args.includes('--site') ? args[args.indexOf('--site') + 1] : null;
const skipBrowser = args.includes('--skip-browser');
const skipUnlock = args.includes('--skip-unlock');

// ─── Fetch methods ──────────────────────────────────────────────────────────
// Each returns { html, status, blocked, blockCode, error, durationMs, bytes }

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ACCEPT_LANG = { BE: 'fr-BE,fr;q=0.9,nl-BE;q=0.8,en;q=0.7', FR: 'fr-FR,fr;q=0.9,en;q=0.5', DE: 'de-DE,de;q=0.9,en;q=0.5', NL: 'nl-NL,nl;q=0.9,en;q=0.5', US: 'en-US,en;q=0.9' };

async function fetchHttpPlain(url) {
  const t0 = Date.now();
  const fetcher = new Fetcher({ minDelayMs: 800 });
  const res = await fetcher.get(url);
  const blocked = res.blocked || false;
  const blockCode = res.block?.code || STATUS.OK;
  return { html: res.body || '', status: res.status, blocked, blockCode, error: res.error, durationMs: Date.now() - t0, bytes: (res.body || '').length };
}

async function fetchHttpBrowserHeaders(url, country) {
  const t0 = Date.now();
  const lang = ACCEPT_LANG[country] || ACCEPT_LANG.FR;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, {
      redirect: 'follow', signal: ctrl.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': lang,
        'Accept-Encoding': 'gzip, deflate, br',
        'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
        'cache-control': 'max-age=0',
      },
    });
    clearTimeout(timer);
    const body = await res.text();
    const block = classifyResponse({ status: res.status, url: res.url, requestedUrl: url, body });
    const blocked = block.code !== STATUS.OK && block.code !== STATUS.NOT_A_PRODUCT_PAGE && block.code !== STATUS.JAVASCRIPT_REQUIRED;
    return { html: body, status: res.status, blocked, blockCode: block.code, error: res.ok ? null : `HTTP ${res.status}`, durationMs: Date.now() - t0, bytes: body.length };
  } catch (e) {
    clearTimeout(timer);
    return { html: '', status: 0, blocked: false, blockCode: STATUS.NETWORK_ERROR, error: e?.message || String(e), durationMs: Date.now() - t0, bytes: 0 };
  }
}

let _browserSession = null;
let _edgeSession = null;

async function ensureBrowser(edge = false) {
  if (edge) {
    if (!_edgeSession) _edgeSession = new BrowserSession({ headless: true, channel: 'msedge' });
    return _edgeSession;
  }
  if (!_browserSession) _browserSession = new BrowserSession({ headless: true });
  return _browserSession;
}

async function fetchPlaywright(url, { edge = false } = {}) {
  const t0 = Date.now();
  if (!(await browserAvailable())) return { html: '', status: 0, blocked: false, blockCode: 'NO_PLAYWRIGHT', error: 'playwright not installed', durationMs: Date.now() - t0, bytes: 0 };
  try {
    const pw = await import('playwright');
    const launchOpts = { headless: true, args: ['--disable-blink-features=AutomationControlled'] };
    if (edge) launchOpts.channel = 'msedge';
    const browser = await pw.chromium.launch(launchOpts);
    const ctx = await browser.newContext({ locale: 'fr-BE', viewport: { width: 1366, height: 900 } });
    await ctx.addInitScript(() => {
      try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
      try { if (!window.chrome) window.chrome = { runtime: {} }; } catch {}
    });
    const page = await ctx.newPage();
    await page.route('**/*', route => {
      const t = route.request().resourceType();
      if (['image', 'media', 'font'].includes(t)) route.abort('aborted').catch(() => {});
      else route.continue().catch(() => {});
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
    // Accept cookie/consent banner
    try {
      await page.evaluate(() => {
        const rx = /^(accept all|accept|agree|allow all|allow cookies|tout accepter|j.accepte|accepter|alles accepteren|alle akzeptieren|akzeptieren|zustimmen|ok|continue|got it)$/i;
        const el = [...document.querySelectorAll('button,a,[role="button"]')].find(b => rx.test((b.textContent || '').trim()));
        if (el) el.click();
      });
    } catch {}
    await page.waitForTimeout(500);
    const html = await page.content();
    const block = classifyResponse({ status: 200, url: page.url(), requestedUrl: url, body: html });
    const blocked = block.terminal || false;
    await page.close();
    await ctx.close();
    await browser.close();
    return { html, status: 200, blocked, blockCode: block.code, error: null, durationMs: Date.now() - t0, bytes: html.length };
  } catch (e) {
    return { html: '', status: 0, blocked: false, blockCode: STATUS.NETWORK_ERROR, error: e?.message || String(e), durationMs: Date.now() - t0, bytes: 0 };
  }
}

async function fetchPlaywrightFull(url) {
  const t0 = Date.now();
  if (!(await browserAvailable())) return { html: '', cards: [], status: 0, blocked: false, blockCode: 'NO_PLAYWRIGHT', error: 'playwright not installed', durationMs: Date.now() - t0, bytes: 0 };
  try {
    const session = new BrowserSession({ headless: true });
    const result = await session.collectListing(url, { timeoutMs: 30000, maxScrolls: 6 });
    await session.close();
    const html = result.html || '';
    return { html, cards: result.cards || [], status: result.blocked ? 403 : 200, blocked: !!result.blocked, blockCode: result.blocked?.code || STATUS.OK, error: result.error, durationMs: Date.now() - t0, bytes: html.length };
  } catch (e) {
    return { html: '', cards: [], status: 0, blocked: false, blockCode: STATUS.NETWORK_ERROR, error: e?.message || String(e), durationMs: Date.now() - t0, bytes: 0 };
  }
}

async function fetchNodriver(url) {
  const t0 = Date.now();
  const avail = await unlockAvailable();
  if (!avail.ok) return { html: '', status: 0, blocked: false, blockCode: 'NO_NODRIVER', error: avail.reason, durationMs: Date.now() - t0, bytes: 0 };
  const result = await unlockRender(url, { timeoutMs: 60000 });
  const html = result.html || '';
  if (html) {
    const block = classifyResponse({ status: 200, url, requestedUrl: url, body: html });
    return { html, status: 200, blocked: block.terminal || false, blockCode: block.code, error: null, durationMs: Date.now() - t0, bytes: html.length };
  }
  return { html: '', status: 0, blocked: true, blockCode: STATUS.BLOCKED, error: result.error, durationMs: Date.now() - t0, bytes: 0 };
}

// ─── Extraction methods ─────────────────────────────────────────────────────
// All run on HTML, return { method, products[], fields[] }

function coverageOf(p) {
  if (!p) return [];
  const out = [];
  if (p.name) out.push('name');
  if (p.price != null) out.push('price');
  if (p.gtin || p.ean || p.barcode) out.push('ean');
  if (p.sku) out.push('sku');
  if (p.brand) out.push('brand');
  if (p.category || (p.breadcrumb || []).length) out.push('category');
  if ((p.images || []).length || p.image) out.push('image');
  if (p.weightText || p.weight) out.push('weight');
  if (p.description) out.push('description');
  return out;
}

function cardCoverage(c) {
  if (!c) return [];
  const out = [];
  if (c.name) out.push('name');
  if (c.priceText || c.price != null) out.push('price');
  if (c.image || c.url) out.push('image');
  if (c.url) out.push('url');
  return out;
}

function extractAllFromHtml(html, url) {
  const extractions = {};

  // JSON-LD / listing (includes JSON-LD + embedded JSON + embedded state)
  try {
    const lst = extractListing(html, url);
    const products = lst.cards || [];
    const fields = products.length ? coverageOf(products[0]) : [];
    const urls = products.map(p => p.canonicalUrl || p.sourceUrl).filter(Boolean);
    extractions['listing'] = { productCount: products.length, fields, productUrls: urls.slice(0, 10), products: products.slice(0, 5) };
  } catch (e) {
    extractions['listing'] = { productCount: 0, fields: [], productUrls: [], error: e.message };
  }

  // Embedded state only
  try {
    const emb = extractEmbeddedProducts(html, url);
    const products = emb.cards || [];
    const fields = products.length ? coverageOf(products[0]) : [];
    const urls = products.map(p => p.canonicalUrl || p.sourceUrl || p.source_url).filter(Boolean);
    extractions['embedded-state'] = { productCount: products.length, fields, productUrls: urls.slice(0, 10), products: products.slice(0, 5) };
  } catch (e) {
    extractions['embedded-state'] = { productCount: 0, fields: [], productUrls: [], error: e.message };
  }

  // Product page extraction (for single product URLs)
  try {
    const { product, strategies } = extractProduct(html, url);
    if (product) {
      const fields = coverageOf(product);
      const hasMinimum = fields.includes('name') && fields.includes('price') && fields.includes('image');
      extractions['product-fiche'] = { productCount: 1, fields, strategies, hasMinimum, product };
    } else {
      extractions['product-fiche'] = { productCount: 0, fields: [], strategies };
    }
  } catch (e) {
    extractions['product-fiche'] = { productCount: 0, fields: [], error: e.message };
  }

  return extractions;
}

// ─── Success criteria ───────────────────────────────────────────────────────

function isListingSuccess(extraction) {
  if (!extraction || !extraction.productCount) return false;
  const withUrl = (extraction.productUrls || []).length;
  return extraction.productCount >= 5 && withUrl >= 3;
}

function isProductSuccess(extraction) {
  if (!extraction || !extraction.productCount) return false;
  const f = extraction.fields || [];
  return f.includes('name') && (f.includes('price') || f.includes('image'));
}

function bestListingExtraction(extractions) {
  for (const method of ['listing', 'embedded-state']) {
    if (isListingSuccess(extractions[method])) return { method, ...extractions[method] };
  }
  for (const method of ['listing', 'embedded-state']) {
    if (extractions[method] && extractions[method].productCount > 0) return { method, ...extractions[method] };
  }
  return null;
}

// ─── Fetch method definitions ───────────────────────────────────────────────

function fetchMethods(country, domain) {
  const methods = [];
  if (loadRecipe(domain)) {
    methods.push({ name: 'recipe-api', tier: 'recipe', fn: (url) => fetchRecipe(url, domain, country), full: false, isRecipe: true });
  }
  methods.push(
    { name: 'http-plain', tier: 'http', fn: (url) => fetchHttpPlain(url), full: false },
    { name: 'http-browser-headers', tier: 'http', fn: (url) => fetchHttpBrowserHeaders(url, country), full: false },
  );
  if (!skipBrowser) {
    methods.push(
      { name: 'playwright-headless', tier: 'browser', fn: (url) => fetchPlaywrightFull(url), full: true },
      { name: 'playwright-edge', tier: 'browser', fn: (url) => fetchPlaywright(url, { edge: true }), full: false },
    );
  }
  if (!skipUnlock) {
    methods.push(
      { name: 'nodriver', tier: 'unlock', fn: (url) => fetchNodriver(url), full: false },
    );
  }
  return methods;
}

// ─── Main test loop ─────────────────────────────────────────────────────────

async function testSite(site) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${site.domain} — ${site.listing}`);
  console.log('='.repeat(60));

  const result = {
    domain: site.domain, listing: site.listing, country: site.country, category: site.category,
    classification: null,
    winner: null,
    listingAttempts: [],
    productPages: [],
    edgeWorks: null,
    durationMs: 0,
  };
  const t0 = Date.now();
  const methods = fetchMethods(site.country, site.domain);
  let winnerTier = null;
  let discoveredProductUrls = [];

  // ── Test listing page ──
  for (const method of methods) {
    console.log(`  [${method.name}] fetching listing...`);
    const fetchResult = await method.fn(site.listing);
    const attempt = {
      fetchMethod: method.name, tier: method.tier,
      httpStatus: fetchResult.status, blocked: fetchResult.blocked, blockCode: fetchResult.blockCode,
      error: fetchResult.error, durationMs: fetchResult.durationMs, bytes: fetchResult.bytes,
      extractions: {},
      domCards: null,
    };

    if (fetchResult.blocked || (!fetchResult.html && !(fetchResult.recipeProducts && fetchResult.recipeProducts.length))) {
      console.log(`    BLOCKED (${fetchResult.blockCode}) — ${fetchResult.error || 'no content'}`);
      result.listingAttempts.push(attempt);
      continue;
    }

    // Recipe method: products come directly from the API, not HTML extraction
    if (method.isRecipe && fetchResult.recipeProducts && fetchResult.recipeProducts.length) {
      const products = fetchResult.recipeProducts;
      const fields = products.length ? coverageOf(products[0]) : [];
      const urls = products.map(p => p.url).filter(Boolean).map(u => u.startsWith('http') ? u : `https://www.${site.domain}${u}`);
      attempt.extractions = { 'recipe-api': { productCount: products.length, fields, productUrls: urls.slice(0, 10), products: products.slice(0, 5) } };
      console.log(`    recipe-api: ${products.length} product(s) [${fields.join(', ')}]`);
      if (products.length >= 5 && !winnerTier) {
        winnerTier = 'recipe';
        result.winner = {
          fetchMethod: 'recipe-api', extractionMethod: 'recipe-api', tier: 'recipe',
          productCount: products.length, fields,
          durationMs: fetchResult.durationMs, bytes: fetchResult.bytes,
        };
        discoveredProductUrls = urls;
        console.log(`    => SUCCESS (recipe-api: ${products.length} products)`);
      }
      result.listingAttempts.push(attempt);
      continue;
    }

    // Run all extraction methods on the HTML
    attempt.extractions = extractAllFromHtml(fetchResult.html, site.listing);

    // For full browser methods, DOM cards come from the same pass (no extra launch)
    if (method.full && fetchResult.cards && fetchResult.cards.length) {
      attempt.domCards = {
        productCount: fetchResult.cards.length,
        fields: cardCoverage(fetchResult.cards[0]),
        productUrls: fetchResult.cards.map(c => c.url).filter(Boolean).slice(0, 10),
      };
      console.log(`    DOM cards: ${fetchResult.cards.length} products`);
    }

    // Summarize
    const best = bestListingExtraction(attempt.extractions);
    const domCards = attempt.domCards;
    const effectiveCount = Math.max(best?.productCount || 0, domCards?.productCount || 0);
    const effectiveMethod = (best?.productCount || 0) >= (domCards?.productCount || 0) ? best?.method : 'dom-cards';
    const effectiveUrls = (best?.productCount || 0) >= (domCards?.productCount || 0) ? (best?.productUrls || []) : (domCards?.productUrls || []);
    const effectiveFields = (best?.productCount || 0) >= (domCards?.productCount || 0) ? (best?.fields || []) : (domCards?.fields || []);

    for (const [m, ext] of Object.entries(attempt.extractions)) {
      console.log(`    ${m}: ${ext.productCount || 0} product(s) [${(ext.fields || []).join(', ')}]`);
    }
    if (domCards) console.log(`    dom-cards: ${domCards.productCount} product(s) [${domCards.fields.join(', ')}]`);

    result.listingAttempts.push(attempt);

    // Check success
    if (effectiveCount >= 5) {
      if (!winnerTier) {
        winnerTier = method.tier;
        result.winner = {
          fetchMethod: method.name, extractionMethod: effectiveMethod, tier: method.tier,
          productCount: effectiveCount, fields: effectiveFields,
          durationMs: fetchResult.durationMs, bytes: fetchResult.bytes,
        };
        discoveredProductUrls = effectiveUrls;
        console.log(`    => SUCCESS (${method.name} + ${effectiveMethod}: ${effectiveCount} products)`);
      }
      // Keep testing other methods for the matrix, but we have the winner
    } else if (effectiveCount > 0) {
      console.log(`    => PARTIAL (${effectiveCount} products, need 5+)`);
      if (!discoveredProductUrls.length) discoveredProductUrls = effectiveUrls;
    } else {
      console.log(`    => EMPTY`);
    }
  }

  // ── Test Edge channel for browser-class sites ──
  if (winnerTier === 'browser' && !skipBrowser) {
    console.log(`  Testing Edge channel compatibility...`);
    const edgeResult = await fetchPlaywright(site.listing, { edge: true });
    if (!edgeResult.blocked && edgeResult.html) {
      const exts = extractAllFromHtml(edgeResult.html, site.listing);
      const best = bestListingExtraction(exts);
      result.edgeWorks = !!(best && best.productCount >= 5);
      console.log(`    Edge: ${result.edgeWorks ? 'WORKS' : 'INSUFFICIENT'} (${best?.productCount || 0} products)`);
    } else {
      result.edgeWorks = false;
      console.log(`    Edge: BLOCKED or ERROR`);
    }
  }

  // ── Test 2 product pages ──
  if (discoveredProductUrls.length > 0) {
    const productUrls = discoveredProductUrls.slice(0, 2);
    const winningFetchMethod = methods.find(m => m.name === result.winner?.fetchMethod) || methods[0];

    for (const pUrl of productUrls) {
      console.log(`  [product] ${pUrl}`);
      const pResult = { url: pUrl, attempts: [], winner: null };

      for (const method of methods) {
        // Only test the winning tier and below for products (optimization)
        if (winnerTier === 'http' && method.tier !== 'http') break;

        const fetchResult = await method.fn(pUrl);
        const pAttempt = {
          fetchMethod: method.name, tier: method.tier,
          httpStatus: fetchResult.status, blocked: fetchResult.blocked,
          error: fetchResult.error, durationMs: fetchResult.durationMs, bytes: fetchResult.bytes,
          extractions: {},
        };

        if (!fetchResult.blocked && fetchResult.html) {
          pAttempt.extractions = extractAllFromHtml(fetchResult.html, pUrl);
          const fiche = pAttempt.extractions['product-fiche'];
          if (fiche && isProductSuccess(fiche)) {
            console.log(`    ${method.name}: OK [${fiche.fields.join(', ')}]`);
            if (!pResult.winner) {
              pResult.winner = { fetchMethod: method.name, fields: fiche.fields, strategies: fiche.strategies };
            }
          } else {
            const best = bestListingExtraction(pAttempt.extractions);
            if (best && best.productCount > 0) {
              console.log(`    ${method.name}: listing-like (${best.productCount} products)`);
              if (!pResult.winner) pResult.winner = { fetchMethod: method.name, fields: best.fields, extractionMethod: best.method };
            } else {
              console.log(`    ${method.name}: no product data`);
            }
          }
        } else {
          console.log(`    ${method.name}: ${fetchResult.blocked ? 'BLOCKED' : 'ERROR'}`);
        }
        pResult.attempts.push(pAttempt);

        if (pResult.winner && method.tier === (winnerTier || method.tier)) break;
      }

      result.productPages.push(pResult);
    }
  } else {
    console.log('  No product URLs discovered — skipping product page tests');
  }

  // ── Classify ──
  if (winnerTier === 'recipe') result.classification = 'http';
  else if (winnerTier === 'http') result.classification = 'http';
  else if (winnerTier === 'browser') result.classification = 'browser';
  else if (winnerTier === 'unlock') result.classification = 'browser';
  else result.classification = 'protected';

  result.durationMs = Date.now() - t0;
  console.log(`\n  => ${result.classification.toUpperCase()} (${(result.durationMs / 1000).toFixed(1)}s)`);
  return result;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const hasBrowser = await browserAvailable();
  const hasUnlock = (await unlockAvailable()).ok;
  console.log(`Capabilities: Playwright=${hasBrowser}, Edge=true, nodriver=${hasUnlock}`);
  console.log(`Flags: skipBrowser=${skipBrowser}, skipUnlock=${skipUnlock}`);

  const sites = singleSite ? SITES.filter(s => s.domain === singleSite || s.listing.includes(singleSite)) : SITES;
  if (!sites.length) { console.error(`No site matching "${singleSite}"`); process.exit(1); }

  const results = [];
  for (const site of sites) {
    const r = await testSite(site);
    results.push(r);
    fs.writeFileSync(path.join(OUT_DIR, `multi_${site.domain.replace(/\./g, '_')}.json`), JSON.stringify(r, null, 2));
  }

  // ── Summary ──
  console.log('\n' + '='.repeat(60));
  console.log('  MULTI-TECHNIQUE CLASSIFICATION SUMMARY');
  console.log('='.repeat(60));

  const http = results.filter(r => r.classification === 'http');
  const browser = results.filter(r => r.classification === 'browser');
  const protectedSites = results.filter(r => r.classification === 'protected');

  console.log(`\nTested: ${results.length} | http: ${http.length} | browser: ${browser.length} | protected: ${protectedSites.length}\n`);

  for (const r of results) {
    const w = r.winner;
    const productInfo = r.productPages.length ? ` | ${r.productPages.filter(p => p.winner).length}/${r.productPages.length} product pages OK` : '';
    const edge = r.edgeWorks != null ? ` | edge=${r.edgeWorks ? 'yes' : 'no'}` : '';
    console.log(`  [${r.classification.toUpperCase().padEnd(9)}] ${r.domain.padEnd(20)} ${w ? `${w.fetchMethod}+${w.extractionMethod} (${w.productCount} prod)` : 'no winning combination'}${productInfo}${edge}`);
  }

  // ── Installer size analysis (2e) ──
  console.log('\n--- Installer Size Analysis (2e) ---');
  console.log('[OBSERVATION] The 329 MB installer bundles Playwright Chromium (chrome-win64/)');
  console.log('[OBSERVATION] plus chromium_headless_shell and ffmpeg — these account for ~250 MB');
  const browserSites = browser.filter(r => r.edgeWorks);
  const browserSitesNeedChromium = browser.filter(r => r.edgeWorks === false);
  if (browser.length > 0) {
    console.log(`[OBSERVATION] ${browserSites.length}/${browser.length} browser-class sites work with Edge channel`);
    if (browserSitesNeedChromium.length === 0 && browser.length > 0) {
      console.log('[PROPOSITION] All browser-class sites work with system Edge — bundled Chromium could be dropped, saving ~250 MB');
    } else {
      console.log(`[OBSERVATION] ${browserSitesNeedChromium.length} site(s) need bundled Chromium: ${browserSitesNeedChromium.map(r => r.domain).join(', ')}`);
    }
  }

  // Save full report
  const report = {
    generated: new Date().toISOString(),
    capabilities: { playwright: hasBrowser, edge: true, nodriver: hasUnlock },
    totalTested: results.length,
    counts: { http: http.length, browser: browser.length, protected: protectedSites.length },
    sites: results.map(r => ({
      domain: r.domain, listing: r.listing, country: r.country, category: r.category,
      classification: r.classification, edgeWorks: r.edgeWorks,
      winner: r.winner, durationMs: r.durationMs,
      listingAttemptCount: r.listingAttempts.length,
      productPagesTestedCount: r.productPages.length,
      productPagesSuccessCount: r.productPages.filter(p => p.winner).length,
    })),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'multi-technique-report.json'), JSON.stringify(report, null, 2));
  console.log(`\nFull report: ${OUT_DIR}/multi-technique-report.json`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
