/**
 * Sitemap complement scope: when the pasted listing cannot be read, only sitemap
 * URLs in the LISTING's language and category stand in for it; with none in scope
 * the listing is reported blocked, never filled with off-topic products (the real
 * case: a blocked French men's listing returned Dutch football-boot pages).
 * Hand-built fixtures, fictitious shop, offline (mock fetcher, no network).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { urlLanguage, createComplementScope } from '../complement-scope.mjs';
import { discoverProducts } from '../discover.mjs';
import { discoverFromSitemaps } from '../sitemap.mjs';
import { probeSource } from '../probe.mjs';
import { createController } from '../../app/controller.mjs';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';

class Mock {
  constructor(map) { this.map = map; this.reads = []; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(url) {
    this.reads.push(url); this.stats.requests++;
    const e = this.map[url] || { status: 404 };
    const status = e.status ?? 200;
    const ok = status >= 200 && status < 300;
    const body = ok ? (e.body ?? '') : '';
    return { ok, status, url, requestedUrl: url, contentType: 'text/html', kind: 'html', body, bytes: null, headers: {}, error: ok ? null : `HTTP ${status}`, blocked: !ok };
  }
  async getText(url) { return this.get(url); }
}
const S = 'https://www.shop.test';
const urlset = (urls) => `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
const index = (maps) => `<?xml version="1.0"?><sitemapindex>${maps.map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join('')}</sitemapindex>`;
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const fiche = (name) => `<html><body><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name, offers: { price: '20', priceCurrency: 'EUR' }, image: `${S}/img.jpg` })}</script><p>${'texte produit '.repeat(30)}</p></body></html>`;

// ── pure scope rules ─────────────────────────────────────────────────────────
test('urlLanguage reads a whole language segment or host label, never a word inside a slug', () => {
  assert.equal(urlLanguage(`${S}/fr/homme`), 'fr');
  assert.equal(urlLanguage(`${S}/BE/fr_BE/c/shoes`), 'fr');
  assert.equal(urlLanguage(`${S}/c/nl-BE/schoenen/s1`), 'nl');
  assert.equal(urlLanguage('https://de.shop.test/schuhe'), 'de');
  assert.equal(urlLanguage(`${S}/chaussure-de-sport/ID12.html`), null);   // "-de-" is a slug word
  assert.equal(urlLanguage(`${S}/homme`), null);
});

test('scope: an unprefixed listing keeps unprefixed URLs; a prefixed one keeps its own language', () => {
  const flat = createComplementScope(`${S}/shop`, { siteUrls: [`${S}/nl/a/1.html`, `${S}/a/1.html`] });
  assert.equal(flat.check(`${S}/nl/voetbalschoen/ID1.html`).why, 'language');
  assert.equal(flat.check(`${S}/chaussure/ID1.html`).ok, true);
  const fr = createComplementScope(`${S}/fr/shop`, { siteUrls: [`${S}/nl/a/1.html`, `${S}/fr/a/1.html`] });
  assert.equal(fr.check(`${S}/nl/a/2.html`).why, 'language');
  assert.equal(fr.check(`${S}/a/2.html`).why, 'language', 'the site uses language segments: an unprefixed URL is another branch');
  assert.equal(fr.check(`${S}/fr/a/2.html`).ok, true);
  // a site whose item URLs carry no language at all: the listing's segment cannot exclude them
  const frNoLangItems = createComplementScope(`${S}/fr/shop`, { siteUrls: [`${S}/p/1`, `${S}/p/2`] });
  assert.equal(frNoLangItems.check(`${S}/p/3`).ok, true);
});

test('scope: category = whole catalogue, a URL nested under the listing, or a sitemap named after it', () => {
  const men = createComplementScope(`${S}/fr/homme`, { siteUrls: [`${S}/fr/x`] });
  assert.equal(men.wholeCatalogue, false);
  assert.equal(men.check(`${S}/fr/chaussure-running/ID1.html`).why, 'category');
  assert.equal(men.check(`${S}/fr/homme/chaussures/ID1.html`).ok, true);
  assert.equal(men.check(`${S}/fr/femme/chaussures/ID1.html`).why, 'category');
  assert.equal(men.check(`${S}/fr/chaussure-running/ID1.html`, `${S}/sitemaps/fr/sitemap-homme-products.xml`).ok, true);
  assert.equal(men.check(`${S}/fr/chaussure-running/ID1.html`, `${S}/sitemaps/fr/sitemap-hommeries.xml`).why, 'category', 'a whole token, not a substring');
  for (const u of [`${S}/fr/shop`, `${S}/fr/collections/all`, `${S}/produits`, `${S}/fr/produits/toutes-les-categories`, `${S}/fr/`]) {
    assert.equal(createComplementScope(u).wholeCatalogue, true, u);
  }
  assert.equal(createComplementScope(`${S}/shop?category=men`).wholeCatalogue, false, 'a facet filter is a category');
  assert.equal(createComplementScope(`${S}/search?q=boots`).wholeCatalogue, false, 'search results are not the catalogue');
});

// ── discovery ────────────────────────────────────────────────────────────────
function blockedShop({ entry, sitemaps, extra = {} }) {
  const m = {
    [`${S}/robots.txt`]: { body: `Sitemap: ${S}/sitemap_index.xml` },
    [`${S}/sitemap_index.xml`]: { body: index(Object.keys(sitemaps)) },
    [entry]: { status: 403 },
    ...extra,
  };
  for (const [u, urls] of Object.entries(sitemaps)) m[u] = { body: urlset(urls) };
  return m;
}

test('blocked unprefixed listing, sitemap = another language + flat product URLs → nothing added, listing blocked', async () => {
  const entry = `${S}/homme`;
  const map = blockedShop({ entry, sitemaps: {
    [`${S}/sitemaps/nl/sitemap-product-1.xml`]: range(12, (i) => `${S}/nl/voetbalschoenen-${i}/ID${100 + i}.html`),
    [`${S}/sitemaps/fr/sitemap-product-1.xml`]: range(12, (i) => `${S}/chaussure-${i}/ID${200 + i}.html`),
  } });
  const { urls, report } = await discoverProducts(new Mock(map), entry, { maxProducts: 30 });
  assert.deepEqual(urls, [], 'no off-topic product stands in for the blocked listing');
  assert.equal(report.diagnosis, 'blocked');
  assert.equal(report.stopped.code, 'ACCESS_DENIED');
  assert.deepEqual(report.listingBlocked, { url: entry, code: 'ACCESS_DENIED', outOfScope: 24 });
  assert.equal(report.complement.outOfScope.language, 12);
  assert.equal(report.complement.outOfScope.category, 12);
  assert.match(report.diagnosisReason, /listing blocked/);
});

test('blocked listing: URLs nested under it in its language ARE the complement', async () => {
  const entry = `${S}/fr/homme`;
  const map = blockedShop({ entry, sitemaps: {
    [`${S}/sitemaps/sitemap-product-1.xml`]: [
      ...range(4, (i) => `${S}/nl/heren/schoenen/product-${i}`),
      ...range(4, (i) => `${S}/fr/femme/chaussures/product-${i}`),
      ...range(6, (i) => `${S}/fr/homme/chaussures/product-${i}`),
    ],
  } });
  const { urls, report } = await discoverProducts(new Mock(map), entry, { maxProducts: 30 });
  assert.equal(urls.length, 6);
  assert.ok(urls.every((u) => u.startsWith(`${S}/fr/homme/`)), urls.join(' '));
  assert.equal(report.method, 'sitemap-complement');
  assert.equal(report.listingBlocked, undefined);
});

test('blocked listing: a sitemap file named after the category scopes its flat URLs', async () => {
  const entry = `${S}/homme`;
  const map = blockedShop({ entry, sitemaps: {
    [`${S}/sitemaps/sitemap-product-femme.xml`]: range(5, (i) => `${S}/robe-${i}/ID${i}.html`),
    [`${S}/sitemaps/sitemap-product-homme.xml`]: range(5, (i) => `${S}/veste-${i}/ID${50 + i}.html`),
  } });
  const { urls } = await discoverProducts(new Mock(map), entry, { maxProducts: 30 });
  assert.equal(urls.length, 5);
  assert.ok(urls.every((u) => /\/veste-/.test(u)), urls.join(' '));
});

test('blocked whole-catalogue listing: any category of its language, never another language', async () => {
  const entry = `${S}/fr/shop`;
  const map = blockedShop({ entry, sitemaps: {
    [`${S}/sitemaps/sitemap-product-1.xml`]: [...range(4, (i) => `${S}/nl/product/item-${i}`), ...range(6, (i) => `${S}/fr/product/article-${i}`)],
  } });
  const { urls } = await discoverProducts(new Mock(map), entry, { maxProducts: 30 });
  assert.equal(urls.length, 6);
  assert.ok(urls.every((u) => u.includes('/fr/')));
});

test('first sitemap read stopped at the cap on another language: one scoped re-read finds the listing, language-named files first', async () => {
  const entry = `${S}/fr/homme`;
  const nl = `${S}/sitemaps/nl/sitemap-product.xml`;
  const de = `${S}/sitemaps/de/sitemap-product.xml`;
  const fr = `${S}/sitemaps/fr/sitemap-product.xml`;
  const map = blockedShop({ entry, sitemaps: {
    [nl]: range(10, (i) => `${S}/nl/heren/product-${i}`),
    [de]: range(10, (i) => `${S}/de/herren/product-${i}`),
    [fr]: range(10, (i) => `${S}/fr/homme/product-${i}`),
  } });
  const mock = new Mock(map);
  const { urls, report } = await discoverProducts(mock, entry, { maxProducts: 5 });
  assert.equal(urls.length, 5);
  assert.ok(urls.every((u) => u.startsWith(`${S}/fr/homme/`)), urls.join(' '));
  assert.equal(report.complement.sitemapReread, true);
  // ranked read: the French file is read before the German one in the re-read
  const second = mock.reads.slice(mock.reads.lastIndexOf(`${S}/sitemap_index.xml`));
  assert.ok(second.indexOf(fr) !== -1 && second.indexOf(de) === -1, `re-read order: ${second.join(' ')}`);
});

test('scoped sitemap read is bounded: it stops after N files in a row without an in-scope URL', async () => {
  const maps = range(8, (i) => `${S}/sitemaps/sitemap-product-${i}.xml`);
  const m = { [`${S}/sitemap.xml`]: { body: index(maps) } };
  for (const u of maps) m[u] = { body: urlset(range(3, (k) => `${S}/nl/product/x-${u.length}-${k}`)) };
  const mock = new Mock(m);
  const r = await discoverFromSitemaps(mock, S, { max: 10, accept: () => false, maxBarrenLeaves: 3 });
  assert.equal(r.urls.length, 0);
  assert.equal(r.rejected, 9);
  assert.equal(mock.reads.filter((u) => /sitemap-product-/.test(u)).length, 3);
});

test('sitemap read without a scope is unchanged (no accept → every product URL, sources recorded)', async () => {
  const m = { [`${S}/sitemap.xml`]: { body: urlset(range(4, (i) => `${S}/product/p-${i}`)) } };
  const r = await discoverFromSitemaps(new Mock(m), S, { max: 3 });
  assert.equal(r.urls.length, 3);
  assert.equal(r.truncated, true);
  assert.equal(r.sources.get(`${S}/product/p-0`), `${S}/sitemap.xml`);
});

// ── the whole app flow ─────────────────────────────────────────────────────────
test('controller: a blocked listing with nothing in scope ends blocked, 0 products, reason "liste bloquée"', async () => {
  const entry = `${S}/homme`;
  const flat = range(6, (i) => `${S}/chaussure-${i}/ID${300 + i}.html`);
  const extra = Object.fromEntries(flat.map((u, i) => [u, { body: fiche(`Chaussure ${i}`) }]));
  const map = blockedShop({ entry, sitemaps: { [`${S}/sitemaps/sitemap-product-1.xml`]: flat }, extra });
  const dirs = ensureDirs(appDirs(fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-scope-'))));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 2, recovery: false, maxProducts: 30, rateLimitMs: 0 }), 'utf8');
  const events = [];
  const ctrl = createController({ dirs, emit: (t, p) => events.push({ t, p }) });
  await ctrl.start({ origin: entry, store: 'demo', browser: false, fetcher: new Mock(map) });
  const done = events.find((e) => e.t === 'done').p;
  assert.equal(done.counts.detected || 0, 0);
  assert.equal(done.status, 'stopped:ACCESS_DENIED');
  assert.equal(done.listingBlocked.url, entry);
  assert.match(done.reason, /^liste bloquée : accès refusé/);
  const rep = JSON.parse(fs.readFileSync(path.join(dirs.data, 'reports', `${done.jobId}.json`), 'utf8'));
  assert.equal(rep.discovery.listingBlocked.code, 'ACCESS_DENIED');
  assert.match(fs.readFileSync(path.join(dirs.data, 'reports', `${done.jobId}.txt`), 'utf8'), /listing blocked: +https:\/\/www\.shop\.test\/homme/);
});

test('analysis parity: a dead listing is not sampled from an off-category sitemap fiche', async () => {
  const entry = `${S}/fr/homme`;
  const off = range(3, (i) => `${S}/fr/femme/robe-${i}`);
  const m = {
    [`${S}/robots.txt`]: { body: `Sitemap: ${S}/sitemap.xml` },
    [S]: { body: '<html><body>accueil</body></html>' },
    [`${S}/sitemap.xml`]: { body: urlset(off.map((u) => u.replace('/robe-', '/product/robe-'))) },
  };
  for (const u of off) m[u.replace('/robe-', '/product/robe-')] = { body: fiche('Robe') };
  const p = await probeSource(entry, { fetcher: new Mock(m) });
  assert.notEqual(p.diagnosis, 'ok', 'the scrape would not deliver those fiches; the analysis may not promise them');
});
