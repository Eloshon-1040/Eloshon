/**
 * marshydro.eu, job 20261028205401-tbr41 (« Accepter » of the extension on « Lampe de culture LED », 28/10): the rules
 * taught on a lamp page gave false values on the other products, all counted « ok »:
 *   - name « tr.first th » (the first header cell of the specifications table, « FC-1500-Osram » on the lamp page) read
 *     « Product Name », « INPUT », « Humidifier »…;
 *   - price « form.variations_form… » (the whole order form, « 169.99 EUR » on the teaching page) read the form's first
 *     figure: « 2026 » (the 2026 model), « 1500 » (FC1500), « 15 » (15L), « 100 » (100×100×180cm)…;
 *   - the shop's data answered a category with products outside it (tents, fans, a humidifier in the LED lamps).
 * Pages built by hand on the shape of the shop's pages (Woodmart theme, WooCommerce). Offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { readRule, ruleFromElement } from '../knowledge/apply.mjs';
import { growBlock } from '../knowledge/pick-block.mjs';
import { newRule } from '../knowledge/rules.mjs';
import { platformDefaultLane } from '../platform/platform-strategy.mjs';

const page = ({ name, price, form, specs }) => parseHTML(`<!doctype html><html><head>
  <script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name, offers: { '@type': 'Offer', price, priceCurrency: 'EUR' } })}</script>
  </head><body><h1 class="product_title">${name}</h1>
  <form class="variations_form cart wd-reset-side-lg">${form}</form>
  <table class="woocommerce-product-attributes"><tbody>${specs.map(([k, v], i) => `<tr class="${i === 0 ? 'first' : ''}"><th>${k}</th><td>${v}</td></tr>`).join('')}</tbody></table>
  </body></html>`).document;

const NAME = newRule({ field: 'name', selector: 'tr.first th' });
const PRICE = newRule({ field: 'price', selector: 'form.variations_form.cart.wd-reset-side-lg' });

const lamp = page({ name: 'Précommande Nouvelle référence 2026 Mars Hydro FC-1500-Osram Lampe de culture LED 150W', price: '169.99',
  form: '<label>Modèle</label> Mars Hydro 2026 – FC-1500-Osram <span class="price"><bdi>169.99 EUR</bdi></span> <button>Ajouter au panier</button>',
  specs: [['FC-1500-Osram', ''], ['PPF', '435 μmol/s']] });
const fan = page({ name: 'Mars Hydro iFresh 6″ (150 mm) Ventilateur de conduit en ligne', price: '179.99',
  form: '<label>Version</label> <select><option>Standard</option><option>Pro</option></select> <button>Ajouter au panier</button>',
  specs: [['Product Name', 'Mars Hydro iFresh 6-Inch Inline Duct Fan'], ['Duct Size', '6"']] });
const tent = page({ name: 'Mars Hydro 100×100×180 cm Tente de Culture Pro', price: '129.99',
  form: '<label>Taille</label> <select><option>100×100×180cm</option><option>120×120×200cm</option></select> <button>Ajouter au panier</button>',
  specs: [['Dimensions', '100x100x180cm']] });
const humid = page({ name: 'Mars Hydro 15L Humidificateur pour grands espaces', price: '89.99',
  form: 'Capacité 15L 1 <button>Ajouter au panier</button>', specs: [['Humidifier', ''], ['Capacity', '15L']] });

test('the taught name still reads the lamp\'s model; on another product it gives way to the name the page declares', () => {
  assert.deepEqual([readRule(lamp, NAME, { url: 'https://marshydro.eu/products/fc-1500-osram/?lang=fr' }).value], ['FC-1500-Osram']);
  for (const [doc, url, want] of [[fan, 'https://marshydro.eu/products/6-inch-inline-fan-kits/', 'Mars Hydro iFresh 6″ (150 mm) Ventilateur de conduit en ligne'],
    [humid, 'https://marshydro.eu/products/15l-humidificateur/', 'Mars Hydro 15L Humidificateur pour grands espaces']]) {
    const r = readRule(doc, NAME, { url });
    assert.equal(r.value, want, 'the page\'s own name, never « Product Name » / « Humidifier »');
    assert.equal(r.strategy, 'jsonld');
  }
});

test('the taught price is the amount written with its currency; a form with only other figures gives no price from the block', () => {
  assert.deepEqual(readRule(lamp, PRICE).value, { price: 169.99, currency: 'EUR' });
  // Before: 100 (the tent size) and 15 (the 15L capacity). Now the block gives nothing, the page's declared price is used.
  assert.deepEqual(readRule(tent, PRICE).value, { price: 129.99, currency: 'EUR' });
  assert.deepEqual(readRule(humid, PRICE).value, { price: 89.99, currency: 'EUR' });
  assert.deepEqual(readRule(fan, PRICE).value, { price: 179.99, currency: 'EUR' });
});

test('the shop\'s data for a category: a product not in it is left out and listed; when most are outside, no feed', async () => {
  const cats = [{ id: 1296, name: 'Lampe de culture LED', permalink: 'https://marshydro.eu/collections/led-grow-light-fr/?lang=fr', count: 3 }];
  const prod = (name, catIds, price) => ({ name, permalink: `https://marshydro.eu/products/${name.toLowerCase().replace(/\W+/g, '-')}/?lang=fr`, prices: { price: String(price * 100), currency_code: 'EUR', currency_minor_unit: 2 }, categories: catIds.map((id) => ({ id })), images: [] });
  const run = (items) => platformDefaultLane('https://marshydro.eu/collections/led-grow-light-fr/?lang=fr', { platform: 'woocommerce',
    httpGet: async (u) => ({ status: 200, body: /categories/.test(u) ? cats : items }) });
  const some = await run([prod('FC-1500-Osram', [1296], 169.99), prod('FC4800', [1296, 7], 409.99), prod('Tente 100x100x180', [12], 129.99)]);
  assert.equal(some.ok, true);
  assert.deepEqual(some.products.map((p) => p.name), ['FC-1500-Osram', 'FC4800']);
  assert.equal(some.outsideCount, 1); assert.equal(some.outside[0].name, 'Tente 100x100x180');
  const most = await run([prod('FC4800', [1296], 409.99), prod('Tente', [12], 129.99), prod('Humidificateur', [33], 89.99), prod('Ventilateur', [40], 179.99)]);
  assert.equal(most.ok, false); assert.equal(most.error, 'collection_mismatch', 'the shop did not filter: the visual read takes over');
});

test('a long product title (the heading of a WooCommerce page, wrapped in the markup) can be taught as the name', () => {
  const title = 'Mars Hydro FC1500 Lampe de culture LED 150W, Bridgelux 3030 &amp; 660nm Rouge profond, 2,85 PPE spectre complet pour tente de culture 70x70cm';
  const long = 'Précommande : Nouveau modèle phare Mars Hydro 2026 – Système d’éclairage LED horticole intelligent et dimmable FC-4800-Osram (480 W) | Efficacité (PPE) de 2,95 μmol/J, spectre complet, équipé de véritables LED horticoles OSRAM (incluant des LED rouge profond 660 nm) – Idéal pour la culture en intérieur dans des tentes de 120 × 120 cm (Date d’expédition estimée : 3–10 novembre)';
  for (const [t, url] of [[title, 'https://marshydro.eu/products/mars-hydro-fc1500-lampe-de-culture-led-150w/?lang=fr'], [long, 'https://marshydro.eu/products/systeme-declairage-led-pour-culture-mars-hydro-fc-4800-osram-480-w-ppe-295/?lang=fr']]) {
    const doc = parseHTML(`<!doctype html><html><body><div class="summary"><h1 class="product_title entry-title wd-entities-title">
  ${t.replace(', 2,85', ',\n 2,85')}
</h1><p class="price">119,99 €</p></div></body></html>`).document;
    const { rule, read } = ruleFromElement(growBlock(doc.querySelector('h1'), 'name'), doc, { field: 'name', url });
    assert.equal(read.ok, true, read.reason);
    // « Précommande : » before the name is a status written like a label: left out, the name is the rest.
    const want = t.replace('&amp;', '&').replace(/^Précommande : /, '');
    assert.equal(read.value, want, 'one line, whole');
    assert.equal(readRule(doc, rule, { url }).value, want);
  }
});
