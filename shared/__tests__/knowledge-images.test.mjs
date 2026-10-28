/**
 * Pictures through the knowledge layer: the designated block is read as ProductImage[] (absolute addresses,
 * largest size, the attribute that gave them), a rule remembers that strategy, the panel preview never shows
 * "undefined", a rule is checked on other pages for CONTENT (complete addresses), and older rules migrate.
 * Offline (linkedom), generic markup, no site rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { readImages, readImageUrls, leavesPage } from '../knowledge/readers.mjs';
import { readGallery } from '../extract/gallery.mjs';
import { ruleFromElement, applyKnowledge, testRule, validateValue, mergeKnowledgeIntoRow } from '../knowledge/apply.mjs';
import { emptyKnowledge, upsertRule, migrateKnowledge, KNOWLEDGE_VERSION, newRule } from '../knowledge/rules.mjs';
import { previewLines, previewText } from '../knowledge/preview.mjs';
import { isProductImage, imageUrls } from '../extract/images.mjs';

const PAGE = 'https://shop.test/fr/p/chaussure-spezial/IF6490';
const CLOUD = (t, file) => `https://cdn.test/images/e_trim:EAEEEF/c_lpad,w_iw,h_ih/${t}/ab250e4e_9366/${file}`;
const doc = (body, url = PAGE) => parseHTML(`<html><head><base href="${url}"></head><body>${body}</body></html>`).document;

// A product page: a gallery (<picture> with Cloudinary-style srcsets, a lazy picture, a zoom attribute, a CSS
// background), a strip of colour swatches that lead to OTHER product pages, related products, an SVG icon.
const page = (id, { gallery = 3 } = {}) => doc(`
  <nav><a href="/fr"><img src="/static/logo.svg"></a></nav>
  <main>
    <h1>Chaussure Spezial ${id}</h1>
    <div class="pdp-gallery">
      ${Array.from({ length: gallery }, (_, i) => `<figure><picture>
        <source srcset="${CLOUD('h_320,f_auto', `${id}_0${i + 1}_standard.jpg`)} 320w, ${CLOUD('h_840,f_auto', `${id}_0${i + 1}_standard.jpg`)} 840w, ${CLOUD('h_2000,f_auto', `${id}_0${i + 1}_standard.jpg`)} 2000w">
        <img src="${CLOUD('h_320,f_auto', `${id}_0${i + 1}_standard.jpg`)}" alt="Chaussure Spezial ${id} vue ${i + 1}" width="320" height="320">
      </picture></figure>`).join('')}
      <img data-src="/media/${id}_detail.jpg" src="data:image/gif;base64,R0lGOD" alt="détail">
      <img src="/media/${id}_zoom_small.jpg" data-zoom-image="/media/${id}_zoom_large.jpg" alt="zoom">
      <div class="bg" style="background-image:url('https://cdn.test/media/${id}_bg.jpg')"></div>
    </div>
    <ul class="swatches"><li><a href="/fr/p/chaussure-spezial/KH9814"><img src="${CLOUD('w_180', 'KH9814_00_plp.jpg')}" alt="Marron"></a></li>
      <li><a href="/fr/p/chaussure-spezial/${id}"><img src="${CLOUD('w_180', `${id}_00_plp.jpg`)}" alt="Beige"></a></li></ul>
    <section class="related"><a href="/fr/p/autre/ZZ1"><img src="https://cdn.test/media/ZZ1_00.jpg" alt="Autre"></a></section>
  </main>
  <footer><img src="https://cdn.test/static/payment-visa.png"></footer>`, `https://shop.test/fr/p/chaussure-spezial/${id}`);

test('readImages: a block gives ProductImage[] — absolute, largest size (srcset / zoom / lazy), picture once, swatches leading elsewhere excluded', () => {
  const d = page('IF6490');
  const imgs = readImages(d.querySelector('.pdp-gallery'), { pageUrl: PAGE });
  assert.ok(imgs.every(isProductImage), 'the contract');
  assert.deepEqual(imageUrls(imgs), [
    CLOUD('h_2000,f_auto', 'IF6490_01_standard.jpg'), CLOUD('h_2000,f_auto', 'IF6490_02_standard.jpg'), CLOUD('h_2000,f_auto', 'IF6490_03_standard.jpg'),
    'https://shop.test/media/IF6490_detail.jpg', 'https://shop.test/media/IF6490_zoom_large.jpg', 'https://cdn.test/media/IF6490_bg.jpg',
  ]);
  assert.equal(imgs[0].alt, 'Chaussure Spezial IF6490 vue 1');
  assert.equal(imgs[0].attr, 'source@srcset', 'the <picture>’s largest source');
  assert.equal(imgs[3].attr, 'data-src'); assert.equal(imgs[4].attr, 'data-zoom-image'); assert.equal(imgs[5].attr, 'style');
  assert.deepEqual(imgs.map((i) => i.position), [1, 2, 3, 4, 5, 6]);
  // The whole page: the swatch of ANOTHER colourway (a link to its page) and the related product are not this product's pictures.
  const all = readImageUrls(d.querySelector('main'), { pageUrl: PAGE });
  assert.ok(!all.some((u) => /KH9814|ZZ1_00/.test(u)), `other products excluded: ${all.join(' ')}`);
  assert.ok(all.includes(CLOUD('w_180', 'IF6490_00_plp.jpg')), 'the swatch that leads to THIS page is this product’s picture');
  assert.ok(!all.some((u) => /logo\.svg|payment/.test(u)));
  assert.equal(leavesPage('/fr/p/chaussure-spezial/KH9814', PAGE), true);
  assert.equal(leavesPage('/fr/p/chaussure-spezial/IF6490?size=42', PAGE), false, 'the same page with a query is the same page');
  assert.equal(leavesPage('https://cdn.test/media/IF6490_full.jpg', PAGE), false, 'a link to the large picture file is not a page');
  assert.equal(leavesPage('#zoom', PAGE), false);
});

test('readGallery: anchored on a declared picture, the gallery block gives every picture in its largest size; never the swatch strip', () => {
  const d = page('IF6490');
  const seeds = [CLOUD('w_500,f_auto', 'IF6490_01_standard.jpg')]; // the JSON-LD picture, another size of the first gallery picture
  const g = readGallery(d, { pageUrl: PAGE, seeds, name: 'Chaussure Spezial IF6490' });
  assert.deepEqual(imageUrls(g).slice(0, 3), [CLOUD('h_2000,f_auto', 'IF6490_01_standard.jpg'), CLOUD('h_2000,f_auto', 'IF6490_02_standard.jpg'), CLOUD('h_2000,f_auto', 'IF6490_03_standard.jpg')]);
  assert.ok(!imageUrls(g).some((u) => /KH9814|ZZ1_00|plp/.test(u)), 'no swatch, no related product');
  // No declared picture: the block that reads as a gallery.
  const g2 = readGallery(d, { pageUrl: PAGE, seeds: [], name: '' });
  assert.ok(imageUrls(g2).length >= 3 && imageUrls(g2)[0] === CLOUD('h_2000,f_auto', 'IF6490_01_standard.jpg'));
  assert.deepEqual(readGallery(doc('<p>no pictures</p>'), { pageUrl: PAGE }), []);
});

test('validateValue: pictures must be complete usable addresses — a truncated or relative-only block is a FAILURE, not data', () => {
  assert.equal(validateValue('image', readImages(page('IF6490').querySelector('.pdp-gallery'), { pageUrl: PAGE })), null);
  assert.equal(validateValue('image', []), 'aucune image dans ce bloc');
  assert.match(validateValue('image', [{ url: 'https://cdn.test/images/e_trim:EAEEEF/c_lpad', position: 1, source: 'dom' }]), /sans adresse complète.*tronquée/);
  assert.match(validateValue('image', ['/media/relative.jpg']), /sans adresse complète/);
});

test('a picture rule remembers its strategy (source + attribute), reads ProductImage[] on other pages and is checked for content there', () => {
  const taught = page('IF6490');
  const { rule, read } = ruleFromElement(taught.querySelector('.pdp-gallery'), taught, { field: 'image', url: PAGE });
  assert.ok(read.ok, read.reason);
  assert.equal(rule.extract.mode, 'image'); assert.equal(rule.extract.source, 'dom'); assert.equal(rule.extract.attr, 'source@srcset');
  assert.match(rule.example, /^6 image\(s\) : https:\/\/cdn\.test\/images\/e_trim:EAEEEF\/c_lpad,w_iw,h_ih\/h_2000/, 'the example shows addresses, not objects');
  const k = upsertRule(emptyKnowledge(), rule).knowledge;
  // On another product page the same block reads that page's pictures (complete addresses), not the taught ones.
  const other = page('KK2802', { gallery: 4 });
  const ap = applyKnowledge(other, k, { scope: 'product', url: 'https://shop.test/fr/p/chaussure-spezial/KK2802' });
  assert.ok(Array.isArray(ap.values.image) && ap.values.image.every(isProductImage), 'ProductImage[] on the way out');
  assert.equal(imageUrls(ap.values.image)[0], CLOUD('h_2000,f_auto', 'KK2802_01_standard.jpg'));
  assert.ok(!imageUrls(ap.values.image).some((u) => /IF6490/.test(u)));
  // The row keeps the serialised form: addresses, the designated ones first.
  const row = { name: 'x', images: ['https://cdn.test/media/KK2802_bg.jpg', 'https://cdn.test/other.jpg'] };
  const added = mergeKnowledgeIntoRow(row, ap);
  assert.ok(added.includes('images'));
  assert.ok(row.images.every((u) => typeof u === 'string' && /^https:/.test(u)));
  assert.equal(row.images[0], CLOUD('h_2000,f_auto', 'KK2802_01_standard.jpg'));
  assert.ok(row.images.includes('https://cdn.test/other.jpg') && row.images.filter((u) => /KK2802_bg/.test(u)).length === 1, 'another picture kept, the same picture not twice');
  // The check on other pages looks at the content: a page whose block holds only a truncated address fails with the reason.
  const broken = doc(`<main><div class="pdp-gallery"><img src="https://cdn.test/images/e_trim:EAEEEF/c_lpad" alt="x"></div></main>`, 'https://shop.test/fr/p/chaussure-spezial/ZZ9');
  const t = testRule(k.rules[0], [{ url: 'https://shop.test/fr/p/chaussure-spezial/KK2802', doc: other }, { url: 'https://shop.test/fr/p/chaussure-spezial/ZZ9', doc: broken }]);
  assert.equal(t.ok, 1); assert.equal(t.total, 2);
  assert.equal(t.results[0].sample, '7 image(s)'); assert.equal(t.results[0].count, 7);
  assert.match(t.results[1].reason, /aucune image dans ce bloc|sans adresse complète/, 'the truncated address is never read as a picture');
});

test('the page’s own declaration (JSON-LD) is read as the same ProductImage shape as a block', () => {
  const ld = { '@context': 'https://schema.org', '@type': 'Product', name: 'Chaussure Spezial IF6490', image: [{ '@type': 'ImageObject', url: CLOUD('w_500,f_auto', 'IF6490_01_standard.jpg') }, CLOUD('w_500,f_auto', 'IF6490_02_standard.jpg')], offers: { '@type': 'Offer', price: 110, priceCurrency: 'EUR' } };
  const html = `<html><head><base href="${PAGE}"><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><main><div class="pdp-gallery"><img src="${CLOUD('h_320,f_auto', 'IF6490_01_standard.jpg')}" alt="vue 1"></div></main></body></html>`;
  const d = parseHTML(html).document;
  const { rule, read } = ruleFromElement(d.querySelector('.pdp-gallery'), d, { field: 'image', url: PAGE, html });
  assert.ok(read.ok, read.reason);
  assert.equal(rule.strategies[0].kind, 'jsonld', 'the declaration holds the designated picture: it is the first strategy');
  const k = upsertRule(emptyKnowledge(), rule).knowledge;
  const ap = applyKnowledge(d, k, { scope: 'product', url: PAGE, html });
  assert.equal(ap.sources.image.strategy, 'jsonld');
  assert.ok(ap.values.image.every(isProductImage));
  assert.deepEqual(imageUrls(ap.values.image), [CLOUD('w_500,f_auto', 'IF6490_01_standard.jpg'), CLOUD('w_500,f_auto', 'IF6490_02_standard.jpg')]);
});

test('previewLines: no shape ever prints "undefined" — pictures (objects or addresses) show their address, specs, variants, prices, texts', () => {
  const shapes = {
    image: [{ url: 'https://cdn.test/a.jpg', alt: 'Vue 1', position: 1, source: 'dom' }, { url: 'https://cdn.test/b.jpg', position: 2, source: 'dom' }, 'https://cdn.test/c.jpg'],
    technical_specs: [{ group: null, name: 'Tige', value: 'Cuir' }, { name: 'Semelle', value: 'Gomme' }],
    variants: [{ name: '42', price: 110, currency: 'EUR', availability: 'OutOfStock', code: 'S42' }, { name: '43' }],
    price: [{ price: 110, currency: 'EUR' }],
    description: 'Une chaussure.',
    weird: [{ foo: 'bar', n: 2 }, null, undefined, 7, { nested: { x: 1 } }],
  };
  for (const [field, sample] of Object.entries(shapes)) {
    const lines = previewLines(field, sample);
    assert.ok(lines.length >= 1, field);
    for (const l of lines) { assert.equal(typeof l.text, 'string'); assert.doesNotMatch(l.text, /undefined|\[object Object\]|null/, `${field}: ${l.text}`); }
  }
  const pics = previewLines('image', shapes.image);
  assert.deepEqual(pics.map((l) => l.image), ['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg', 'https://cdn.test/c.jpg'], 'a thumbnail per picture');
  assert.equal(pics[0].text, '1. https://cdn.test/a.jpg — Vue 1');
  assert.equal(previewText('technical_specs', shapes.technical_specs), 'Tige : Cuir\nSemelle : Gomme');
  assert.equal(previewText('variants', shapes.variants), '42 — 110 EUR (épuisé) · S42\n43');
  assert.deepEqual(previewLines('x', null), []);
});

test('an older picture rule (v2, no strategy) migrates to v3: source "dom", any attribute; it still reads', () => {
  const old = { version: 2, rules: [{ ...newRule({ scope: 'product', field: 'image', selector: '.pdp-gallery', learnedFrom: PAGE }), extract: { mode: 'image', multiline: false } }], updatedAt: null };
  const m = migrateKnowledge(old);
  assert.equal(m.changed, true); assert.equal(m.knowledge.version, KNOWLEDGE_VERSION);
  assert.deepEqual(m.knowledge.rules[0].extract, { mode: 'image', multiline: false, source: 'dom' });
  const ap = applyKnowledge(page('KK2802'), m.knowledge, { scope: 'product', url: 'https://shop.test/fr/p/chaussure-spezial/KK2802' });
  assert.equal(imageUrls(ap.values.image)[0], CLOUD('h_2000,f_auto', 'KK2802_01_standard.jpg'));
  assert.equal(migrateKnowledge(m.knowledge).changed, false, 'already current');
});
