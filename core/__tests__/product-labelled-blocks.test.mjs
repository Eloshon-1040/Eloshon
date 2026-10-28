/**
 * Why descriptions and technical specifications were rarely read on computer / electronics pages,
 * and what now reads them: no site rule, the page's own labels ("Description", "Caractéristiques
 * techniques" as a tab, an accordion or a heading), paragraphs kept, specs as pairs, nothing lost
 * between the listing and the product page, nothing cut at 2000 characters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractProduct } from '../extract.mjs';
import { enrichFromDetailPages } from '../detail-enrich.mjs';
import { toNormalizedProduct } from '../normalize.mjs';

const ld = (extra = {}) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: 'Laptop Pro 14', sku: 'LP14', offers: { '@type': 'Offer', price: '999.00', priceCurrency: 'EUR' }, ...extra })}</script>`;
const LONG = Array.from({ length: 5 }, (_, i) => `Paragraphe ${i + 1} : ${'un texte utile sur le produit, '.repeat(18)}`);
const specRows = '<div class="row"><span class="k">Processeur</span><span class="v">Core i7</span></div><div class="row"><span class="k">Mémoire vive</span><span class="v">16 Go</span></div><div class="row"><span class="k">Stockage</span><span class="v">1 To SSD</span></div>';

const tabsPage = ({ structuredDescription = null, sizeChart = false } = {}) => `<html><head><title>Laptop Pro 14</title><meta name="description" content="Un portable puissant pour le travail.">${ld(structuredDescription ? { description: structuredDescription } : {})}</head><body>
  <h1>Laptop Pro 14</h1>
  ${sizeChart ? '<table><tr><td>Taille S</td><td>38</td></tr><tr><td>Taille M</td><td>40</td></tr></table>' : ''}
  <div class="tabs"><button role="tab" aria-controls="t1">Description</button><button role="tab" aria-controls="t2">Caractéristiques techniques</button></div>
  <div id="t1" hidden>${LONG.map((t) => `<p>${t}</p>`).join('')}<ul><li>Écran 14 pouces</li><li>Clavier rétroéclairé</li></ul></div>
  <div id="t2" hidden>${specRows}</div></body></html>`;

test('no structured description: the block labelled "Description" is read whole, with its paragraphs (not the <meta> snippet, not 2000 characters)', () => {
  const { product } = extractProduct(tabsPage(), 'https://shop.test/p/lp14');
  assert.ok(product.description.length > 2000, `read ${product.description.length} characters`);
  assert.ok(product.description.includes('\n'), 'paragraphs kept');
  assert.ok(product.description.includes('• Écran 14 pouces'));
  assert.equal(product.richText, true);
  const np = toNormalizedProduct(product, {});
  assert.ok(np.description.length > 2000 && np.description.includes('\n'), 'survives normalisation');
});

test('technical specifications come from the block labelled as such (a tab, whatever its row markup), not from another table of the page', () => {
  const { product, strategies } = extractProduct(tabsPage({ sizeChart: true }), 'https://shop.test/p/lp14');
  assert.deepEqual(product.specs.map((s) => [s.name, s.value]), [['Processeur', 'Core i7'], ['Mémoire vive', '16 Go'], ['Stockage', '1 To SSD']]);
  assert.ok(strategies.includes('generic-specs'));
});

test('a structured description stays authoritative (the labelled block is not used)', () => {
  const real = 'Description structurée, complète et fiable du portable, rédigée par le marchand.';
  const { product } = extractProduct(tabsPage({ structuredDescription: real }), 'https://shop.test/p/lp14');
  assert.equal(product.description, real);
  assert.equal(product.richText, undefined);
});

test('accordion (<details>) and heading + paragraph patterns are read too', () => {
  const html = `<html><head>${ld()}</head><body><details><summary>Description du produit</summary><p>${LONG[0]}</p><p>${LONG[1]}</p></details>
    <h2>Fiche technique</h2><dl><dt>Poids</dt><dd>1,4 kg</dd><dt>Écran</dt><dd>14 pouces</dd></dl></body></html>`;
  const { product } = extractProduct(html, 'https://shop.test/p/x');
  assert.ok(product.description.includes('Paragraphe 1') && product.description.includes('Paragraphe 2'));
  assert.deepEqual(product.specs.map((s) => s.name), ['Poids', 'Écran']);
});

test('listing → product page: the specs (and the full description) reach the listed row — they used to be dropped between the two', async () => {
  const pages = { 'https://shop.test/p/lp14': tabsPage() };
  const rows = [{ sourceUrl: 'https://shop.test/p/lp14', name: 'Laptop Pro 14', price: 999 }];
  const rep = await enrichFromDetailPages(rows, { fetchHtml: async (u) => ({ ok: true, html: pages[u], status: 200 }), maxVisits: 5 });
  assert.equal(rep.completed, 1);
  assert.equal(rows[0].specs.length, 3);
  assert.ok(rows[0].description.length > 2000);
  assert.equal(rows[0].richText, true);
});

// A shop that sends its description only in the page state (the block is built in the browser) and puts a
// marketing snippet in JSON-LD — the case seen on a real electronics shop page (description was the snippet).
const stateShop = (jsonldDescription) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: 'Phone A17', sku: '2195579', description: jsonldDescription, offers: { '@type': 'Offer', price: '199', priceCurrency: 'EUR' } })}</script></head><body><h1>Phone A17</h1>
  <script>window.__PRELOADED_STATE__ = ${JSON.stringify({ apolloState: { 'GraphqlProduct:Media:fr-BE:2195579': { id: '2195579', description: `<p><h3>L'avis de nos experts</h3></p><p>${'Un écran lumineux et un appareil photo stabilisé. '.repeat(6)}</p>` }, 'GraphqlProduct:Media:fr-BE:7777777': { id: '7777777', description: `<p>${'Le produit voisin. '.repeat(20)}</p>` } } })};</script></body></html>`;

test('a JSON-LD marketing snippet gives way to the page product\'s own description held in the state (never a neighbour\'s)', () => {
  const { product, strategies } = extractProduct(stateShop('Commande le Phone A17 à notre magasin. En ligne ou en magasin.'), 'https://shop.test/fr/product/_phone-a17-2195579.html');
  assert.match(product.description, /^L'avis de nos experts\nUn écran lumineux/);
  assert.ok(!/voisin/.test(product.description));
  assert.equal(product.richText, true);
  assert.ok(strategies.includes('generic-state-description'));
});

test('a real, long structured description is kept over the state', () => {
  const real = 'Description complète rédigée par le marchand. '.repeat(10);
  const { product } = extractProduct(stateShop(real), 'https://shop.test/fr/product/_phone-a17-2195579.html');
  assert.equal(product.description, real.trim());
});

test('product pages: a taught field that one rule cannot read sends the page to the rendered read, even if another field read fine', async () => {
  const { emptyKnowledge, upsertRule, newRule } = await import('../../shared/knowledge/rules.mjs');
  let k = emptyKnowledge();
  k = upsertRule(k, newRule({ scope: 'product', field: 'brand', selector: '.brand' })).knowledge;
  k = upsertRule(k, newRule({ scope: 'product', field: 'warranty', selector: '.warranty' })).knowledge;
  const plain = '<html><body><span class="brand">Acme</span></body></html>';
  const rendered = '<html><body><span class="brand">Acme</span><div class="warranty">Garantie 2 ans</div></body></html>';
  const rows = [{ sourceUrl: 'https://s.test/p/1', name: 'A', price: 1 }, { sourceUrl: 'https://s.test/p/2', name: 'B', price: 2 }];
  let renders = 0;
  const rep = await enrichFromDetailPages(rows, { fetchHtml: async () => ({ ok: true, html: plain }), fetchRendered: async () => { renders++; return { ok: true, html: rendered }; }, knowledge: k, maxVisits: 5 });
  assert.equal(rows[0].warranty, 'Garantie 2 ans'); assert.equal(rows[1].warranty, 'Garantie 2 ans');
  assert.equal(rows[0].brand, 'Acme');
  assert.equal(rep.renderedPages, 1); assert.equal(renders, 2, 'the next pages go straight to the rendered read');
});

test('what the user designated wins over the automatic read, page by page; a breadcrumb designated as the category is THE category', async () => {
  const { emptyKnowledge, upsertRule, newRule } = await import('../../shared/knowledge/rules.mjs');
  const { parseHTML } = await import('linkedom');
  const { ruleFromElement } = await import('../../shared/knowledge/apply.mjs');
  const page = (i) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: `Phone ${i}`, sku: `S${i}`, brand: { '@type': 'Brand', name: 'Marque-auto' }, description: `Phrase de référencement ${i}.`, offers: { '@type': 'Offer', price: '10', priceCurrency: 'EUR' } })}</script></head><body>
    <nav class="crumbs"><ol><li><a href="/">Accueil</a></li><li><a href="/tel">Téléphonie</a></li><li><a href="/tel/gsm">GSM</a></li></ol></nav>
    <span class="maker">Samsung</span><div class="expert"><p>L’avis de nos experts sur le Phone ${i} : un écran lumineux et une bonne autonomie.</p></div></body></html>`;
  const d = parseHTML(page(1)).document;
  let k = emptyKnowledge();
  for (const [sel, field] of [['.maker', 'brand'], ['.expert', 'description'], ['.crumbs', 'category']]) k = upsertRule(k, ruleFromElement(d.querySelector(sel), d, { field }).rule).knowledge;
  const rows = [{ sourceUrl: 'https://s.test/p/2', name: 'Phone 2', price: 10 }];
  await enrichFromDetailPages(rows, { fetchHtml: async () => ({ ok: true, html: page(2) }), knowledge: k, maxVisits: 3 });
  assert.equal(rows[0].brand, 'Samsung', 'the designated brand, not the automatic one');
  assert.match(rows[0].description, /^L’avis de nos experts sur le Phone 2/, 'the designated description, not the snippet');
  assert.deepEqual(rows[0].breadcrumb, ['Téléphonie', 'GSM']);
  const np = toNormalizedProduct(rows[0], {});
  assert.equal(np.source_category, 'Téléphonie > GSM');
  void newRule;
});
