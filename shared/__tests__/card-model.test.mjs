/**
 * The product card learned from one click (card-model.mjs), on the real marshydro.eu pages (WooCommerce, 28/10):
 * the hub « Lampe de culture LED » groups its products by series and carries product cards in its header mega-menu
 * too; the automatic grid read took 37 « cards » there, 30 without a price. The collection check (collection-check.mjs)
 * and the platform feed limited to ONE collection (shared/platform/platform-strategy.mjs). Offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { learnCardModel, classifyCards, negativeSignature, sanitizeCardModel, linkShape } from '../extract/card-model.mjs';
import { extractDomGrid } from '../extract/dom-grid.mjs';
import { collectionVerdict, sameCategory } from '../extract/collection-check.mjs';
import { collectionScope, platformDefaultLane } from '../platform/platform-strategy.mjs';
import { detectPlatform } from '../platform/platform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const raw = (name) => zlib.gunzipSync(fs.readFileSync(path.join(HERE, '..', '..', 'core', '__tests__', 'fixtures', 'sites', `${name}.html.gz`))).toString('utf8');
const HUB = 'https://marshydro.eu/collections/led-grow-light-fr/?lang=fr';
const FCE = 'https://marshydro.eu/collections/fc-e-series-led-fr/?lang=fr';
const hubHtml = raw('marshydro.eu.hub'); const hub = parseHTML(hubHtml).document;
const sub = parseHTML(raw('marshydro.eu.collection')).document;
const mainCards = (d) => [...d.querySelectorAll('.product-grid-item')].filter((x) => d.querySelector('.main-page-wrapper').contains(x));

// The export of 28/10 (extension 0.7.32) came from the visual read (639.99 instead of the shop's 409.99) because that
// panel had NO reader of the shop's data: platformDefaultLane ran in the app only. The panel now tries it first
// (service-worker viaPlatform, the same three steps as here: the page's platform, the URL's scope, the Store API).
test('root cause of the visual read: what the panel needs to read a marshydro collection from the shop\'s data is there', () => {
  for (const html of [hubHtml, raw('marshydro.eu.collection')]) assert.equal(detectPlatform(html.slice(0, 600000)), 'woocommerce');
  assert.equal(collectionScope(FCE, 'woocommerce').kind, 'category');
  const sw = fs.readFileSync(path.join(HERE, '..', '..', 'extension', 'background', 'service-worker.mjs'), 'utf8');
  assert.match(sw, /const feed = await viaPlatform\(t\.tab\.url\);\s*\n\s*if \(feed\)/, 'the panel reads the shop\'s data before the visual read');
});

test('root cause: the automatic grid takes header and promo links for products (30 of its 37 cards have no price)', () => {
  const g = extractDomGrid(hubHtml, HUB);
  assert.equal(g.cards.length, 37); assert.equal(g.cards.filter((c) => c.price == null).length, 30);
});

test('one click on a card: the pattern, its grid, its link kind; a card of another section adds that section; the menu is out', () => {
  const [first] = mainCards(hub);
  const r = learnCardModel(first.querySelector('.price'), hub, HUB);
  assert.equal(r.ok, true);
  assert.equal(r.model.card, 'div.product-grid-item.wd-with-labels');
  assert.equal(r.model.linkShape, '/products/*');
  assert.deepEqual(r.model.needs, { title: true, price: true });
  assert.equal(r.count, 4, 'the series section the user clicked in');
  const other = mainCards(hub).find((x) => !hub.querySelector(r.model.scopes[0]).contains(x));
  const r2 = learnCardModel(other, hub, HUB, { previous: r.model });
  assert.equal(r2.added, true); assert.equal(r2.count, 14);
  const c = classifyCards(hub, r2.model, HUB);
  assert.equal(c.kept.length, 14); assert.ok(c.kept.every((el) => el.querySelector('.price')), 'every kept card has its price');
  assert.ok(c.rejected.length > 0 && c.rejected.every((x) => x.reason === 'outside_list'), 'the mega-menu and the other blocks are listed as outside the list');
});

test('another page of the site (a series page built card by card): its content is the list, the mega-menu is not', () => {
  const r = learnCardModel(mainCards(hub)[0].querySelector('.price'), hub, HUB);
  const c = classifyCards(sub, r.model, FCE);
  assert.equal(c.kept.length, 14); assert.equal(c.byReason.outside_list, 10);
  assert.ok(c.kept.every((el) => /FC-E/i.test(el.textContent)));
});

test('« pas un produit », a banner whose link goes elsewhere, a card without price, a carousel: each rejected with its reason', () => {
  const card = (cls, href, price, name) => `<div class="tile ${cls}"><a href="${href}"><img src="/i.jpg"></a><h3 class="title">${name}</h3>${price ? `<span class="price">${price} €</span>` : ''}</div>`;
  const doc = parseHTML(`<html><body><header><nav>${card('', '/products/menu-a', '10,00', 'Menu A')}${card('', '/products/menu-b', '11,00', 'Menu B')}</nav></header><main><div class="grid">${card('', '/products/a', '10,00', 'Lampe A')}${card('', '/products/b', '12,00', 'Lampe B')}${card('promo-banner', '/collections/sale', '', 'Soldes')}${card('', '/products/c', '', 'Lampe C')}${card('', '/products/d', '9,00', 'Lampe D')}</div><div class="related-products">${card('', '/products/e', '8,00', 'Lampe E')}${card('', '/products/f', '7,00', 'Lampe F')}</div></main></body></html>`).document;
  const r = learnCardModel(doc.querySelector('.grid .tile .price'), doc, 'https://s.test/c/lamps');
  assert.equal(r.ok, true); assert.equal(r.model.card, 'div.tile');
  let c = classifyCards(doc, r.model, 'https://s.test/c/lamps');
  assert.deepEqual(c.kept.map((x) => x.querySelector('h3').textContent), ['Lampe A', 'Lampe B', 'Lampe D']);
  assert.deepEqual(Object.fromEntries(c.rejected.map((x) => [x.name, x.reason])), { 'Menu A': 'outside_list', 'Menu B': 'outside_list', Soldes: 'other_link', 'Lampe C': 'no_price', 'Lampe E': 'outside_list', 'Lampe F': 'outside_list' });
  // The same list on another page (no learned section there): the header and the « related » carousel are out by their zone.
  c = classifyCards(doc, r.model, 'https://s.test/c/other');
  assert.equal(c.byReason.carousel, 2); assert.equal(c.byReason.outside_list, 2);
  // « Pas un produit » on D: its signature rejects it from now on.
  const sig = negativeSignature(doc.querySelectorAll('.grid .tile')[4], doc, r.model, 'https://s.test/c/lamps');
  c = classifyCards(doc, { ...r.model, negatives: [sig] }, 'https://s.test/c/lamps');
  assert.deepEqual(c.kept.map((x) => x.querySelector('h3').textContent), ['Lampe A', 'Lampe B']); assert.equal(c.byReason.marked_not_product, 1);
  const kept = sanitizeCardModel({ ...r.model, negatives: [sig], evil: 1 });
  assert.equal(kept.evil, undefined); assert.equal(kept.negatives.length, 1);
  assert.equal(linkShape('https://www.adidas.be/fr/chaussure-samba/B75806.html'), '/fr/*/*.html');
});

test('in the collection or not: the product page\'s own breadcrumb against the list (or the hub\'s sub-collection)', () => {
  assert.equal(collectionVerdict({ listTrail: ['Accueil', 'Lampe de culture LED'], crumb: ['Accueil', 'Lampes de culture LED', 'Série FC-E'] }), null);
  const v = collectionVerdict({ listTrail: ['Accueil', 'Lampe de culture LED'], crumb: ['Accueil', 'Kits de tentes de culture'] });
  assert.equal(v.code, 'out_of_collection'); assert.match(v.reason, /Kits de tentes de culture/);
  assert.equal(collectionVerdict({ listTrail: ['Lampe de culture LED'], crumb: [] }), null, 'no breadcrumb on the page: no verdict, never a guess');
  assert.equal(collectionVerdict({ listTrail: ['Lampe de culture LED'], expected: 'FC-E Série - LED Bridgelux USA', crumb: ['Série FC-E'] }), null);
  assert.ok(sameCategory('Hommes > Chaussures'.split(' > ')[1], 'chaussures'));
});

test('the platform feed reads ONE collection, never the whole store for a collection address', async () => {
  assert.deepEqual(collectionScope('https://shop.test/fr/collections/sneakers?page=2', 'shopify'), { kind: 'collection', handle: 'sneakers', prefix: '/fr' });
  assert.equal(collectionScope('https://shop.test/collections/all', 'shopify').kind, 'store');
  assert.equal(collectionScope('https://shop.test/products/samba', 'shopify').kind, 'other');
  assert.deepEqual(collectionScope(HUB, 'woocommerce'), { kind: 'category', path: '/collections/led-grow-light-fr', lang: 'fr' });
  const calls = [];
  const httpGet = async (u) => {
    calls.push(u);
    if (/products\/categories/.test(u)) return { status: 200, body: [{ id: 9, name: 'Tentes', permalink: 'https://marshydro.eu/collections/tents-fr/?lang=fr', count: 30 }, { id: 1296, name: 'Lampe de culture LED', permalink: 'https://marshydro.eu/collections/led-grow-light-fr/?lang=fr', count: 2 }] };
    return { status: 200, body: [{ name: 'FC-E 3000', permalink: 'https://marshydro.eu/products/fc-e3000/?lang=fr', prices: { price: '29999', currency_code: 'EUR', currency_minor_unit: 2 }, sku: 'FCE3000', images: [{ src: 'https://i.test/1.jpg' }, { src: 'https://i.test/2.jpg' }], categories: [{ name: 'Série FC-E' }] }, { name: 'TS 1000', permalink: 'https://marshydro.eu/products/ts1000/?lang=fr', prices: { price: '9999', currency_code: 'EUR', currency_minor_unit: 2 }, sku: 'TS1000', images: [] }] };
  };
  const lane = await platformDefaultLane(`${HUB.replace('?lang=fr', 'page/2/?lang=fr')}`, { httpGet, platform: 'woocommerce' });
  assert.equal(lane.ok, true); assert.equal(lane.scope, 'category'); assert.deepEqual(lane.collection, { id: 1296, name: 'Lampe de culture LED', announced: 2 });
  assert.ok(calls.some((u) => /\/wc\/store\/v1\/products\?per_page=100&page=1&category=1296&lang=fr$/.test(u)), calls.join('\n'));
  assert.deepEqual(lane.products[0].images, ['https://i.test/1.jpg', 'https://i.test/2.jpg']); assert.equal(lane.products[0].sku, 'FCE3000');
  const none = await platformDefaultLane('https://marshydro.eu/collections/unknown-fr/?lang=fr', { httpGet, platform: 'woocommerce' });
  assert.equal(none.ok, false); assert.equal(none.error, 'collection_not_resolved', 'an unknown collection never falls back to the whole store');
});

test('marshydro export of 28/10: a WooCommerce product as the Store API gives it; a « prix barré » equal to the price is dropped', async () => {
  const { wooStoreProductToRaw } = await import('../platform/platform-strategy.mjs');
  const { readCards } = await import('../extract/card-recipe.mjs');
  const { buildManifest } = await import('../export/manifest.mjs');
  const r = wooStoreProductToRaw({
    name: 'Mars Hydro 2026 – Système d&rsquo;éclairage FC-4800-Osram', type: 'variable', sku: 'FC-4800-Osram-1', permalink: 'https://marshydro.eu/products/fc-4800/?lang=fr',
    prices: { price: '40999', regular_price: '49999', currency_code: 'EUR', currency_minor_unit: 2 },
    short_description: '<p>PPF : 1467 μmol/s<br />PPE : 2,95 μmol/J</p><p>Efficacité leader sur le marché &#8211; spectre complet</p>',
    categories: [{ name: 'Hot Sale' }, { name: 'LED Grow Light' }], images: [{ src: 'https://img.test/1.jpg' }],
    attributes: [{ name: 'Puissance', has_variations: false, terms: [{ name: '480 W' }] }, { name: 'Add-on', has_variations: true, terms: [{ name: 'None' }, { name: '+iHub Pro Power Strip' }] }],
  }, 'https://marshydro.eu');
  assert.equal(r.name, 'Mars Hydro 2026 – Système d’éclairage FC-4800-Osram');
  assert.equal(r.price, 409.99); assert.equal(r.listPrice, 499.99);
  assert.equal(r.description, 'PPF : 1467 μmol/s\nPPE : 2,95 μmol/J\nEfficacité leader sur le marché – spectre complet');
  assert.deepEqual(r.specs, [{ group: null, name: 'Puissance', value: '480 W' }]);
  assert.equal(r.options, 'Add-on : None | +iHub Pro Power Strip'); assert.equal(r.productCategories, 'Hot Sale, LED Grow Light');
  const doc = parseHTML('<div class="c"><a href="/p/1">FC-4800</a><span class="now">639,99 €</span><span class="was">639,99 €</span></div><div class="c"><a href="/p/2">TS 1000</a><span class="now">69,99 €</span><span class="was">89,99 €</span></div>').document;
  const rows = readCards(doc, { card: 'div.c', fields: { name: { selector: 'a' }, price: { selector: '.now' }, list_price: { selector: '.was' } } }, 'https://marshydro.eu/');
  assert.deepEqual(rows.map((x) => x.listPrice), [undefined, 89.99]);
  assert.equal(buildManifest({ source: 'extension', rows: [], listMethod: 'données publiques de la boutique (WooCommerce)' }).listMethod, 'données publiques de la boutique (WooCommerce)');
});
