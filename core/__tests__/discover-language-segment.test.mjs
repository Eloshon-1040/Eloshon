/**
 * A French perfume listing returned 4 Dutch products out of ~30 (real run, 24/10/2026):
 *  - the language filter read "de" in "eau-de-parfum" as German and dropped the page;
 *  - the page data named products without "/fr/", which the site serves in its default language.
 * Offline: map-backed fetcher, generic markup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverProducts } from '../discover.mjs';
import { cleanText, cleanRichText } from '../html-meta.mjs';

const ORIGIN = 'https://www.shop.test/fr/parfum/parfum-femme/c/00101';
function fetcherFor(pages) {
  return {
    userAgent: 't', stats: { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 },
    async get(u) { const body = pages[u]; return body ? { ok: true, status: 200, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body, headers: {} } : { ok: false, status: 404, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: '', headers: {}, error: 'HTTP 404' }; },
    async getText(u) { return this.get(u); },
  };
}
const SLUGS = ['lancome/idole/eau-de-parfum-rechargeable-femme', 'armani/my-way/eau-de-parfum', 'rabanne/fame/eau-de-toilette', 'dior/miss-dior/rose-nroses', 'prada/paradoxe/radical-essence-parfum', 'mugler/alien/eau-de-parfum-intense', 'gucci/flora/eau-de-parfum', 'ysl/libre/eau-de-parfum'];
const card = (slug, i, href) => `<div class="product-tile"><a class="product-tile__link" href="${href}"><img src="/i/${i}.jpg"><span class="product-tile__name">P${i}</span></a><span class="product-tile__price">${50 + i},00 €</span></div>`;

test('"eau-de-parfum" is not a German page: every French product of the listing is kept', async () => {
  const html = `<html lang="fr-BE"><body><nav><a href="/fr/maquillage/c/002">Maquillage</a></nav><main class="grid">${SLUGS.map((s, i) => card(s, i, `/fr/${s}/p/BP_${1000 + i}`)).join('')}</main></body></html>`;
  const disc = await discoverProducts(fetcherFor({ [ORIGIN]: html }), ORIGIN, { maxProducts: 30, maxPages: 5, maxDepth: 1, scopeToCollection: true, contentType: 'product' });
  assert.equal(disc.urls.length, SLUGS.length);
  assert.ok(disc.urls.every((u) => u.includes('/fr/')));
});

test('product URLs named by the page data without "/fr/" get the listing\'s language segment back', async () => {
  // The grid's links are bare (the shop's data), one tagged link proves the site uses "/fr/" for products.
  const html = `<html lang="fr-BE"><body><main class="grid">${SLUGS.map((s, i) => card(s, i, i === 0 ? `/fr/${s}/p/BP_${1000 + i}` : `/${s}/p/BP_${1000 + i}`)).join('')}</main></body></html>`;
  const disc = await discoverProducts(fetcherFor({ [ORIGIN]: html }), ORIGIN, { maxProducts: 30, maxPages: 5, maxDepth: 1, scopeToCollection: true, contentType: 'product' });
  assert.equal(disc.urls.length, SLUGS.length);
  assert.ok(disc.urls.every((u) => new URL(u).pathname.startsWith('/fr/')), disc.urls.join(' '));
  assert.ok(disc.report.localizedUrls >= SLUGS.length - 1);
});

test('a page really in another language is still filtered out', async () => {
  const html = `<html lang="fr-BE"><body><main class="grid">${SLUGS.slice(0, 5).map((s, i) => card(s, i, `/fr/${s}/p/BP_${1000 + i}`)).join('')}${card('x', 9, '/nl/dior/miss-dior/rose-nroses/p/BP_2000')}</main></body></html>`;
  const disc = await discoverProducts(fetcherFor({ [ORIGIN]: html }), ORIGIN, { maxProducts: 30, maxPages: 5, maxDepth: 1, scopeToCollection: true, contentType: 'product' });
  assert.ok(!disc.urls.some((u) => u.includes('/nl/')));
  assert.equal(disc.urls.length, 5);
});

test('a description whose HTML was escaped in the source keeps no tag (and a rich one turns them into lines)', () => {
  assert.equal(cleanText('Sì Parfum&lt;br&gt;&lt;br&gt;Omarm de kracht'), 'Sì Parfum Omarm de kracht');
  assert.equal(cleanText('Prix &lt; 50 € et taille &gt; 30'), 'Prix < 50 € et taille > 30', 'a real "<" stays');
  assert.equal(cleanRichText('Ligne un&lt;br&gt;Ligne deux<br>Ligne trois'), 'Ligne un\nLigne deux\nLigne trois');
});
