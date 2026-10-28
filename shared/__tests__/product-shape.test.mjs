/**
 * Generic product-SHAPE scorer — finds a product array by the shape of its objects,
 * with NO knowledge of the container name OR the internal field names. This is what
 * makes a site we have never seen (a 13th, 14th… unknown shape) work with no code
 * change. Generic by construction: the fixtures are not real sites.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeObject, scoreArray, extractProductsByShape } from '../extract/product-shape.mjs';
import { extractEmbeddedProducts } from '../extract/embedded-state.mjs';

test('analyzeObject: recognises product signals across unusual/non-English field names', () => {
  const a = analyzeObject({ titre: 'Chaise', montant: '49,99 €', vignette: '/img/c.jpg', lien: '/product/chaise-1', ref: 'C1' });
  assert.equal(a.name, true); assert.equal(a.price, true); assert.equal(a.image, true); assert.equal(a.url, true); assert.equal(a.id, true);
  assert.equal(a.signal, true);
  // A nav node: label + href, nothing product-like → not a signal.
  const nav = analyzeObject({ label: 'Femme', href: '/c/femme' });
  assert.equal(nav.signal, false); assert.equal(nav.nav, true);
  // A review node.
  const rev = analyzeObject({ rating: 5, author: 'Jean', comment: 'super' });
  assert.equal(rev.signal, false); assert.equal(rev.review, true);
});

test('scoreArray: a product grid scores > 0; nav / review / facet arrays score 0', () => {
  const grid = Array.from({ length: 6 }, (_, i) => ({ nom: `Article ${i}`, prix: 10 + i, lien: `/product/a-${i}`, ref: `R${i}` }));
  assert.ok(scoreArray(grid, 'data').score > 0);
  const nav = [{ label: 'A', href: '/a' }, { label: 'B', href: '/b' }, { label: 'C', href: '/c' }];
  assert.equal(scoreArray(nav, 'menu').score, 0);
  const reviews = [{ rating: 5, author: 'x' }, { rating: 4, author: 'y' }, { rating: 3, author: 'z' }];
  assert.equal(scoreArray(reviews, 'reviews').score, 0);
  const facets = [{ name: 'Rouge', count: 12 }, { name: 'Bleu', count: 8 }, { name: 'Vert', count: 3 }];
  assert.equal(scoreArray(facets, 'facets').score, 0);
});

test('13th unknown SHAPE: unknown container name + unknown, non-English field names → still extracted', () => {
  // Nothing here is in any known list: not "products"/"items", field names are French.
  const blob = { zone: 'be', bloc: { rayonnage: [
    { titre: 'Marteau', montant: '19,99 €', devise: 'EUR', vignette: 'https://cdn.x/m.jpg', lien: '/product/marteau-1', ref: 'MRT1' },
    { titre: 'Tournevis', montant: '8,50 €', devise: 'EUR', vignette: 'https://cdn.x/t.jpg', lien: '/product/tournevis-2', ref: 'TRN2' },
    { titre: 'Perceuse', montant: '89,00 €', devise: 'EUR', vignette: 'https://cdn.x/p.jpg', lien: '/product/perceuse-3', ref: 'PRC3' },
  ] } };
  const { cards } = extractProductsByShape(blob, 'https://www.bricoshop.test/c/outils');
  assert.equal(cards.length, 3);
  const m = cards.find((c) => c.name === 'Marteau');
  assert.equal(m.price, 19.99);
  assert.equal(m.currency, 'EUR');
  assert.equal(m.sku, 'MRT1');
  assert.equal(m.sourceUrl, 'https://www.bricoshop.test/product/marteau-1');
  assert.equal(m.images[0], 'https://cdn.x/m.jpg');

  // And end-to-end through the embedded-state scan with an unknown global name.
  const html = `<html><body><script>window.__WHATEVER_42 = ${JSON.stringify(blob)};</script></body></html>`;
  assert.equal(extractEmbeddedProducts(html, 'https://www.bricoshop.test/c/outils').cards.length, 3);
});

test('multilingual fields: DE / ES / IT / PL object shapes are all detected and mapped', () => {
  const de = { bezeichnung: 'Hammer', preis: '19,99 €', bild: 'https://cdn.x/h.jpg', productUrl: '/product/hammer-1', artikelnr: 'DE1' };
  const es = { nombre: 'Martillo', precio: '€ 19,99', imagen: 'https://cdn.x/m.jpg', productLink: '/product/martillo-2', codigo: 'ES1' };
  const it = { nome: 'Martello', prezzo: '19,99 EUR', immagine: 'https://cdn.x/i.jpg', slug: '/product/martello-3', codice: 'IT1' };
  const pl = { nazwa: 'Młotek', cena: '129,99 zł', zdjecie: 'https://cdn.x/z.jpg', handle: '/product/mlotek-4', kod: 'PL1' };
  const { cards } = extractProductsByShape({ list: [de, es, it, pl] }, 'https://shop.test/c/x');
  assert.equal(cards.length, 4);
  assert.equal(cards.find((c) => c.sku === 'DE1').price, 19.99);
  assert.equal(cards.find((c) => c.sku === 'PL1').price, 129.99);
  assert.equal(cards.find((c) => c.sku === 'PL1').currency, 'PLN');
  assert.ok(cards.find((c) => c.name === 'Martello'));
});

test('precision preserved with the broader multilingual patterns: nav/review arrays still score 0', () => {
  const nav = [{ label: 'Femme', href: '/c/femme' }, { label: 'Homme', href: '/c/homme' }, { label: 'Enfant', href: '/c/enfant' }];
  assert.equal(scoreArray(nav, 'menu').score, 0);
  const reviews = [{ rating: 5, author: 'A', comment: 'x' }, { rating: 4, author: 'B', comment: 'y' }, { rating: 3, author: 'C', comment: 'z' }];
  assert.equal(scoreArray(reviews, 'reviews').score, 0);
  // A key that merely CONTAINS a short word must not be read as a price/url/image.
  const tricky = analyzeObject({ cartId: 'abc', discoverMore: '/x', variantCount: 3, starRating: 5 });
  assert.equal(tricky.price, false); assert.equal(tricky.image, false); assert.equal(tricky.signal, false);
});

test('prefers the real grid over a demoted recommendations array', () => {
  const value = {
    recommendations: [{ name: 'Reco 1', price: 5, url: '/product/r-1', sku: 'R1' }, { name: 'Reco 2', price: 6, url: '/product/r-2', sku: 'R2' }, { name: 'Reco 3', price: 7, url: '/product/r-3', sku: 'R3' }],
    catalog: { rows: [
      { name: 'Grid 1', price: 10, url: '/product/g-1', sku: 'G1' }, { name: 'Grid 2', price: 11, url: '/product/g-2', sku: 'G2' },
      { name: 'Grid 3', price: 12, url: '/product/g-3', sku: 'G3' }, { name: 'Grid 4', price: 13, url: '/product/g-4', sku: 'G4' },
    ] },
  };
  const { cards } = extractProductsByShape(value, 'https://s.test/');
  assert.equal(cards.length, 4);
  assert.ok(cards.every((c) => /Grid/.test(c.name)), 'the main grid wins over the reco array');
});
