/**
 * Shared regression harness (ÉTAPE 0 — non-régression). SINGLE source of truth
 * used by BOTH scripts/gen-golden.mjs (freezes current behaviour) and
 * regression.golden.test.mjs (re-runs + compares). Deterministic, offline: a
 * MockFetcher serves the fixtures/*, no real network, no real Playwright.
 *
 * Purely additive — it imports the engine read-only and never modifies it.
 * Snapshots omit time-based fields (startedAt/durationMs/fetchStats) so goldens
 * are stable; everything else is frozen exactly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractProduct } from '../extract.mjs';
import { runScrape } from '../engine.mjs';
import { discoverProducts } from '../discover.mjs';
import { classifyResponse } from '../detect.mjs';
import { toImportCsv } from '../csv.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const FIX = path.join(DIR, 'fixtures');
export const GOLD = path.join(DIR, 'golden');
export const readFix = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');

// Keys = golden file basenames (golden/<key>.json). Order irrelevant.
export const KEYS = ['extraction', 'engine-e2e', 'engine-browser', 'discovery-sitemap', 'discovery-crawl', 'classification'];

/** Deterministic mock of the Fetcher contract the engine/discovery rely on. */
export class MockFetcher {
  constructor(map) {
    this.map = map;
    this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 };
    this.userAgent = 'Eloshon-Scraper/test';
  }
  async get(url) {
    this.stats.requests++;
    const e = this.map[url] || { status: 404 };
    const status = e.error ? 0 : (e.status ?? 200);
    const body = e.error ? '' : (e.body != null ? e.body : (e.fixture ? readFix(e.fixture) : ''));
    const ok = !e.error && status >= 200 && status < 300;
    if (ok) this.stats.ok++; else this.stats.failed++;
    const ct = e.contentType || 'text/html';
    const kind = ct.includes('json') ? 'json' : (ct.includes('xml') || url.endsWith('.xml') ? 'xml' : 'html');
    return { ok, status, url, requestedUrl: url, contentType: ct, kind, body, bytes: null, headers: e.headers || {}, error: e.error || null, blocked: false };
  }
  async getText(url) { return this.get(url); }
}

// ── Stable snapshots (drop non-deterministic fields) ─────────────────────────
export function reportSnapshot(rep) {
  return {
    status: rep.status, discovered: rep.discovered, fetched: rep.fetched, detected: rep.detected,
    normalized: rep.normalized, accepted: rep.accepted, toVerify: rep.toVerify, excluded: rep.excluded,
    incomplete: rep.incomplete, duplicates: rep.duplicates, networkErrors: rep.networkErrors,
    parseErrors: rep.parseErrors, notAProductPage: rep.notAProductPage, browserRequired: rep.browserRequired,
    browserUsed: rep.browserUsed || 0, byStatus: rep.byStatus || {},
    blocked: rep.blocked ? { code: rep.blocked.code } : null,
    remaining: rep.remaining || 0, resumeCount: (rep.resumeUrls || []).length,
  };
}
export function productSnapshot(np) {
  const r = np.raw || {};
  return {
    name: np.name || null, price: np.price ?? null, currency: r.currency ?? null,
    list_price: r.list_price ?? null, availability: r.availability ?? null,
    barcode: np.barcode ?? null, sku: r.sku ?? null, source_product_id: np.source_product_id ?? null,
    weight_kg: np.weight_kg ?? null, image_url: np.image_url ?? null,
    source_category: np.source_category ?? null, product_type: np.product_type ?? null,
    extractor: r.extractor ?? null, eligibility: np.__eligibility?.status ?? null,
  };
}

// ── Case computations (each returns plain, JSON-serialisable data) ───────────
export function computeExtraction() {
  const cases = [
    ['simple-jsonld', 'simple-jsonld.html', 'https://shop.example/fr/chaise-de-bureau'],
    ['promo-jsonld', 'promo-jsonld.html', 'https://shop.example/fr/casque-audio'],
    ['food-luna', 'food-luna.html', 'https://epicerie.example/fr/cafe-moulu-250g'],
    ['microdata', 'microdata.html', 'https://bricolage.example/fr/marteau'],
    ['meta-only', 'meta-only.html', 'https://bricolage.example/fr/tournevis'],
    ['incomplete', 'incomplete.html', 'https://shop.example/fr/produit-mystere'],
    ['not-a-product', 'not-a-product.html', 'https://shop.example/fr/a-propos'],
    ['csr-shell', 'csr-shell.html', 'https://spa.example/fr/montre-connectee'],
  ];
  const out = {};
  for (const [name, fix, url] of cases) {
    const { product, needsBrowser, strategies } = extractProduct(readFix(fix), url);
    out[name] = { product, needsBrowser, strategies };
  }
  return out;
}

export async function computeEngineE2e() {
  const map = {
    'https://shop.example/fr/chaise-de-bureau': { fixture: 'simple-jsonld.html' },
    'https://shop.example/fr/chaise-de-bureau?utm_source=nl': { fixture: 'simple-jsonld.html' }, // dup by URL key (tracking)
    'https://shop.example/fr/chaise-bureau-2': { fixture: 'simple-jsonld.html' },                // dup by identity (same GTIN)
    'https://shop.example/fr/casque-audio': { fixture: 'promo-jsonld.html' },
    'https://epicerie.example/fr/cafe-moulu-250g': { fixture: 'food-luna.html' },
    'https://bricolage.example/fr/marteau': { fixture: 'microdata.html' },
    'https://bricolage.example/fr/tournevis': { fixture: 'meta-only.html' },
    'https://shop.example/fr/produit-mystere': { fixture: 'incomplete.html' },
    'https://shop.example/fr/a-propos': { fixture: 'not-a-product.html' },
    'https://shop.example/fr/timeout': { error: 'timeout' },
    'https://tee.shop/products/classic-tee': { fixture: 'shopify-product.html' },
    'https://tee.shop/products/classic-tee.json': { fixture: 'shopify-product.json', contentType: 'application/json' },
  };
  const urls = [
    'https://shop.example/fr/chaise-de-bureau',
    'https://shop.example/fr/chaise-de-bureau?utm_source=nl',
    'https://shop.example/fr/chaise-bureau-2',
    'https://shop.example/fr/casque-audio',
    'https://epicerie.example/fr/cafe-moulu-250g',
    'https://bricolage.example/fr/marteau',
    'https://bricolage.example/fr/tournevis',
    'https://shop.example/fr/produit-mystere',
    'https://shop.example/fr/a-propos',
    'https://shop.example/fr/timeout',
    'https://tee.shop/products/classic-tee',
  ];
  const fetcher = new MockFetcher(map);
  const { products, report } = await runScrape({
    store: { slug: 'demo' }, urls, concurrency: 1, useBrowser: false, lang: 'fr', defaultProductType: null, fetcher,
  });
  const accepted = products.filter((p) => p.__eligibility?.status === 'accepted');
  const toVerify = products.filter((p) => p.__eligibility?.status === 'to_verify');
  return {
    report: reportSnapshot(report),
    products: products.map(productSnapshot),
    acceptedCsv: toImportCsv(accepted, { storeSlug: 'demo' }),
    toVerifyCsv: toImportCsv(toVerify, { storeSlug: 'demo' }),
  };
}

export async function computeEngineBrowser() {
  const map = { 'https://spa.example/fr/montre-connectee': { fixture: 'csr-shell.html' } };
  const fetcher = new MockFetcher(map);
  const fakeSession = {
    renders: 0,
    async render() { this.renders++; return { html: readFix('csr-rendered.html'), status: 200, block: null, error: null }; },
    async close() {},
  };
  const { products, report } = await runScrape({
    store: { slug: 'demo' }, urls: ['https://spa.example/fr/montre-connectee'],
    concurrency: 1, lang: 'fr', defaultProductType: null, fetcher, browserSession: fakeSession,
  });
  return { report: reportSnapshot(report), products: products.map(productSnapshot), renders: fakeSession.renders };
}

export async function computeDiscoverySitemap() {
  const map = {
    'https://sitemapshop.example/robots.txt': { fixture: 'robots.txt', contentType: 'text/plain' },
    'https://sitemapshop.example/sitemap.xml': { fixture: 'sitemap.xml', contentType: 'application/xml' },
  };
  const f = new MockFetcher(map);
  const { urls, report } = await discoverProducts(f, 'https://sitemapshop.example/', {});
  return { method: report.method, count: urls.length, paths: urls.map((u) => new URL(u).pathname).sort() };
}

export async function computeDiscoveryCrawl() {
  const map = {
    'https://crawlshop.example/robots.txt': { status: 404 },
    'https://crawlshop.example/shop': { fixture: 'listing-crawl-1.html' },
    'https://crawlshop.example/shop?page=2': { fixture: 'listing-crawl-2.html' },
  };
  const f = new MockFetcher(map);
  const { urls, report } = await discoverProducts(f, 'https://crawlshop.example/shop', {});
  return { method: report.method, count: urls.length, paths: urls.map((u) => new URL(u).pathname).sort() };
}

export function computeClassification() {
  const cases = [
    ['403-plain', { status: 403, body: 'Forbidden' }],
    ['403-cloudflare', { status: 403, body: readFix('challenge-cloudflare.html') }],
    ['429-retry-after', { status: 429, body: '', headers: { 'retry-after': '120' } }],
    ['503', { status: 503, body: '' }],
    ['captcha', { status: 200, body: readFix('captcha-recaptcha.html') }],
    ['401', { status: 401, body: '' }],
    ['200-challenge', { status: 200, body: readFix('challenge-cloudflare.html') }],
    ['timeout', { status: 0, error: 'timeout' }],
    ['200-empty', { status: 200, body: '   ' }],
    ['200-valid-product', { status: 200, body: readFix('simple-jsonld.html') }],
  ];
  const out = {};
  for (const [k, r] of cases) { const v = classifyResponse(r); out[k] = { code: v.code, terminal: v.terminal, retryAfter: v.retryAfter }; }
  return out;
}

/** Compute every case. Returns { key: data }. */
export async function computeAll() {
  return {
    extraction: computeExtraction(),
    'engine-e2e': await computeEngineE2e(),
    'engine-browser': await computeEngineBrowser(),
    'discovery-sitemap': await computeDiscoverySitemap(),
    'discovery-crawl': await computeDiscoveryCrawl(),
    classification: computeClassification(),
  };
}
