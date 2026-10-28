/**
 * A site that refuses plain HTTP (anti-bot waiting page, 403) while the local
 * browser reads it — measured on a real shop: page 1 came through the browser,
 * then page 2 and every product page were refused over HTTP (24 of 40 products,
 * no image, no description). Now: after the first refusal, the next pages go
 * through the local browser and HTTP is not tried again in the run.
 * Through the REAL controller, offline (fake fetcher + fake browser).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../../app/controller.mjs';

const ORIGIN = 'https://www.shop.test/fr/40-extracteurs';
const P2 = `${ORIGIN}?page=2`;
const card = (i) => `<article class="pm"><a class="t" href="/fr/extracteurs/${i}-model-${i}.html">Model ${i}</a><span class="pr">${40 + i},90 €</span></article>`;
const listing = (from, to, next) => `<html><head>${next ? `<link rel="next" href="${next}">` : ''}</head><body>${Array.from({ length: to - from + 1 }, (_, k) => card(from + k)).join('')}</body></html>`;
const fiche = (i) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: `Model ${i}`, sku: `M${i}`, description: `Description réelle et assez longue du modèle ${i}.`, image: [`https://cdn.shop.test/${i}.jpg`], offers: { '@type': 'Offer', price: 40 + i + 0.9, priceCurrency: 'EUR', availability: 'https://schema.org/InStock' } })}</script></head><body><h1>Model ${i}</h1></body></html>`;

class RefusingFetcher {
  constructor() { this.calls = []; this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; }
  async get(u) { this.calls.push(u); this.stats.requests++; return { ok: false, status: 403, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: '<title>Just a moment...</title>', bytes: null, headers: {}, error: 'HTTP 403', blocked: true, block: { code: 'BOT_CHALLENGE', terminal: true } }; }
  async getText(u) { return this.get(u); }
}

test('HTTP refused, browser reads: page 2 and the product pages come through the local browser; HTTP is not retried', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-bpages-'));
  const dirs = ensureDirs(appDirs(root));
  fs.writeFileSync(dirs.configFile, JSON.stringify({ workers: 1, recovery: false, maxProducts: 6, sideData: { enabled: false }, browserPageGapMs: 0 }));
  const recipe = { card: '.pm', fields: { name: { selector: '.t', attr: null }, price: { selector: '.pr', attr: null }, url: { selector: '.t', attr: 'href' } }, pagination: { mode: 'none' } };
  fs.writeFileSync(path.join(dirs.data, 'domain-profiles.json'), JSON.stringify({ 'shop.test': { manual_selectors: recipe, manualSelectorsMeta: { status: 'candidate', version: 1, success_count: 1, fail_count: 0, consecutive_fails: 0, last_verified: new Date().toISOString() }, runs: 1 } }));
  const pages = { [ORIGIN]: listing(1, 3, P2), [P2]: listing(4, 6, null) };
  for (let i = 1; i <= 6; i++) pages[`https://www.shop.test/fr/extracteurs/${i}-model-${i}.html`] = fiche(i);
  const rendered = [];
  const browserSession = {
    render: async (u) => { rendered.push(u); return pages[u] ? { html: pages[u], status: 200, block: null } : { html: null, status: 404, block: null }; },
    collectListing: async () => ({ recipeCardsHtml: [] }), close: async () => {},
  };
  const fetcher = new RefusingFetcher();
  const events = [];
  const ctrl = createController({ dirs, emit: (t, p) => events.push({ t, p }) });
  await ctrl.start({ origin: ORIGIN, store: 'demo', browser: true, fetcher, browserSession });
  const done = events.find((e) => e.t === 'done').p;
  assert.equal(done.counts.detected, 6, 'both listing pages read');
  const prods = JSON.parse(fs.readFileSync(path.join(dirs.jobs, done.jobId, 'products.json'), 'utf8'));
  assert.ok(prods.every((p) => p.description && p.images.length && p.raw.availability === 'InStock'), 'every product completed from its page');
  assert.ok(rendered.includes(P2));
  assert.equal(done.pagesViaBrowser, 7, 'page 2 + 6 product pages through the browser');
  // HTTP: the origin once, then (after the first refusal on page 2) never again.
  assert.deepEqual(fetcher.calls.filter((u) => u.includes('/extracteurs/')), [], 'no product page asked over HTTP after the refusal');
  assert.match(fs.readFileSync(done.reportPath, 'utf8'), /relectures par le navigateur de l'app: 7 fiche\(s\)/);
});
