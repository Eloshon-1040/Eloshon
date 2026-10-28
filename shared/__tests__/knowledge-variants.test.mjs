/**
 * Teaching a site where a product's VARIANTS are (sizes, volumes, colours): one click on one option takes
 * the whole group, each entry keeps its label, price, link, code and stock, and the same rule reads the
 * options of the other products. Offline (linkedom), generic markup, no site rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { readVariants } from '../knowledge/readers.mjs';
import { growBlock, describeBlock } from '../knowledge/pick-block.mjs';
import { ruleFromElement, applyKnowledge } from '../knowledge/apply.mjs';
import { emptyKnowledge, upsertRule } from '../knowledge/rules.mjs';
import { designatedPrice } from '../extract/money.mjs';

const doc = (html) => parseHTML(`<html><body>${html}</body></html>`).document;
const parsePrice = designatedPrice;

test('size buttons with their price: label, price, code, stock and the selected one', () => {
  const d = doc(`<div class="sizes">
    <button class="size-btn is-selected" data-sku="P-30"><span class="lbl">30 ml</span><span class="price">49,99 €</span></button>
    <button class="size-btn" data-sku="P-50"><span class="lbl">50 ml</span><span class="price">69,99 €</span></button>
    <button class="size-btn out-of-stock" data-sku="P-100" disabled><span class="lbl">100 ml</span><span class="price">99,99 €</span></button></div>`);
  assert.deepEqual(readVariants(d.querySelector('.sizes'), { parsePrice }), [
    { name: '30 ml', price: 49.99, currency: 'EUR', code: 'P-30', selected: true },
    { name: '50 ml', price: 69.99, currency: 'EUR', code: 'P-50' },
    { name: '100 ml', price: 99.99, currency: 'EUR', code: 'P-100', availability: 'OutOfStock' },
  ]);
});

test('other shapes: a <select>, swatch links with a label only, a price written in the same text', () => {
  const sel = doc('<select id="s"><option value="">Choisissez une taille</option><option value="S">S</option><option value="M" disabled>M</option><option value="L">L</option></select>');
  assert.deepEqual(readVariants(sel.getElementById('s'), { parsePrice }).map((v) => [v.name, v.code, v.availability || '']), [['S', 'S', ''], ['M', 'M', 'OutOfStock'], ['L', 'L', '']]);
  const sw = doc('<ul class="colors"><li><a href="/p/1?c=red" aria-label="Rouge"><img alt="Rouge"></a></li><li><a href="/p/1?c=blue" aria-label="Bleu"><img alt="Bleu"></a></li></ul>');
  assert.deepEqual(readVariants(sw.querySelector('.colors'), { parsePrice }).map((v) => [v.name, v.url]), [['Rouge', '/p/1?c=red'], ['Bleu', '/p/1?c=blue']]);
  const txt = doc('<div class="opts"><div class="o">30 ML - 77,70 €</div><div class="o">50 ML - 115,50 €</div></div>');
  assert.deepEqual(readVariants(txt.querySelector('.opts'), { parsePrice }).map((v) => [v.name, v.price]), [['30 ML', 77.7], ['50 ML', 115.5]]);
});

test('one click on ONE option selects the whole group; the hint says what will be read', () => {
  const d = doc('<main><h1>Parfum</h1><div class="variant-picker"><div class="opt"><span>30 ml</span> <b class="price">49,99 €</b></div><div class="opt"><span>50 ml</span> <b class="price">69,99 €</b></div></div><p>Livraison gratuite</p></main>');
  const block = growBlock(d.querySelector('.opt span'), 'variants');
  assert.equal(block.getAttribute('class'), 'variant-picker');
  assert.equal(describeBlock(block, 'variants'), '2 variante(s) : 30 ml, 50 ml');
});

test('a variants rule learned on product A reads the options (other count, other prices) of product B', () => {
  const page = (sizes) => doc(`<main class="pdp"><h1>Parfum</h1><div class="variant-picker">${sizes.map(([n, p]) => `<div class="opt"><span>${n}</span> <b class="price">${p} €</b></div>`).join('')}</div></main>`);
  const a = page([['30 ml', '49,99'], ['50 ml', '69,99']]);
  const { rule, read } = ruleFromElement(growBlock(a.querySelector('.opt span'), 'variants'), a, { field: 'variants' });
  assert.equal(rule.extract.mode, 'list'); assert.ok(read.ok);
  const k = upsertRule(emptyKnowledge(), rule).knowledge;
  const got = applyKnowledge(page([['20 ml', '39,00'], ['60 ml', '89,00'], ['90 ml', '119,00']]), k);
  assert.deepEqual(got.values.variants.map((v) => [v.name, v.price]), [['20 ml', 39], ['60 ml', 89], ['90 ml', 119]]);
});

// Pictures follow the shared contract (shared/extract/images.mjs): ProductImage objects with ABSOLUTE
// addresses (resolved against the page), the largest size of each picture, the attribute they came from.
test('an Image field reads the picture (largest srcset source, lazy attributes), not its text; the wheel can take the gallery', async () => {
  const { readImages, readImageUrls, bestFromSrcset } = await import('../knowledge/readers.mjs');
  assert.equal(bestFromSrcset('/a-320.jpg 320w, /a-1280.jpg 1280w, /a-640.jpg 640w'), '/a-1280.jpg');
  const d = doc(`<div class="gallery"><div class="main"><img class="hero" src="data:image/gif;base64,R0" data-src="/img/p1-large.jpg" alt="Parfum"></div>
    <ul class="thumbs"><li><img src="/img/p1-large.jpg?w=80"></li><li><img srcset="/img/p1-side-200.jpg 200w, /img/p1-side-1000.jpg 1000w"></li></ul></div>`);
  const url = 'https://shop.test/p/parfum';
  const hero = readImages(d.querySelector('.hero'), { pageUrl: url });
  assert.deepEqual(hero, [{ url: 'https://shop.test/img/p1-large.jpg', alt: 'Parfum', position: 1, source: 'dom', attr: 'data-src' }], 'a ProductImage: absolute address, alt, the attribute that gave it');
  assert.deepEqual(readImageUrls(d.querySelector('.gallery'), { pageUrl: url }), ['https://shop.test/img/p1-large.jpg', 'https://shop.test/img/p1-side-1000.jpg'], 'same picture in another size counted once, the largest kept');
  const { rule, read } = ruleFromElement(growBlock(d.querySelector('.main'), 'image'), d, { field: 'image', url });
  assert.equal(rule.extract.mode, 'image'); assert.ok(read.ok, read.reason);
  assert.equal(rule.extract.source, 'dom'); assert.equal(rule.extract.attr, 'data-src', 'the rule remembers the strategy that produced complete addresses');
  // The document's own base resolves the pictures when no page address is given (the panel's live hint).
  const withBase = parseHTML(`<html><head><base href="${url}"></head><body><img class="hero" src="/img/p1-large.jpg"></body></html>`).document;
  assert.equal(describeBlock(withBase.querySelector('.hero'), 'image'), '1 image(s) — molette vers le haut pour prendre toute la galerie');
  assert.deepEqual(readImages(d.querySelector('.hero')), [], 'without any page address a relative picture is not a usable address: nothing is invented');
});

test('confidence follows the RECENT pages: old failures (an older version) fade, a fresh check revives a failing rule', async () => {
  const { recordOutcome, setTests, testLabel, newRule } = await import('../knowledge/rules.mjs');
  let k = upsertRule(emptyKnowledge(), { ...newRule({ scope: 'product', field: 'description', selector: '.d' }), tests: { ok: 1, total: 16, urls: [] } }).knowledge;
  const id = k.rules[0].id;
  for (let i = 0; i < 3; i++) k = recordOutcome(k, id, false);
  assert.equal(k.rules[0].status, 'failing');
  for (let i = 0; i < 10; i++) k = recordOutcome(k, id, true);
  assert.deepEqual([k.rules[0].tests.ok, k.rules[0].tests.total], [10, 13], 'the stale 1/16 is gone');
  assert.equal(k.rules[0].status, 'active');
  for (let i = 0; i < 3; i++) k = recordOutcome(k, id, false);
  k = setTests(k, id, { ok: 5, total: 6, urls: [] });
  assert.equal(k.rules[0].status, 'active'); assert.equal(testLabel(k.rules[0]).label, 'élevée');
});
