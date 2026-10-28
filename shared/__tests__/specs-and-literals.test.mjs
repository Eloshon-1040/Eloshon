/**
 * Technical specifications by shape (shared/extract/specs.mjs) and page data literals
 * that are JS, not JSON (shared/extract/js-literal.mjs). Hand-built fixtures, fictional
 * data, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDataLiteral, jsTokensToJson } from '../extract/js-literal.mjs';
import { specsFromState, specsFromJsonLd, specsFromHtml, extractSpecs, dedupeSpecs } from '../extract/specs.mjs';
import { pageJsonPayloads, colourwaysFromJsonLd, sizeVariants } from '../extract/product-group.mjs';

test('parseDataLiteral: JSON as is; undefined / NaN / Infinity outside strings become null', () => {
  assert.deepEqual(parseDataLiteral('{"a":1}'), { a: 1 });
  assert.deepEqual(parseDataLiteral('{"a":undefined,"b":[1,NaN,-Infinity],"c":"undefined NaN","d":1e-7}'), { a: null, b: [1, null, null], c: 'undefined NaN', d: 1e-7 });
  assert.deepEqual(parseDataLiteral('{"s":"say \\"undefined\\"","t":true,"n":null}'), { s: 'say "undefined"', t: true, n: null });
});

test('parseDataLiteral: anything else that is not JSON still fails (no guessing)', () => {
  for (const bad of ['{a:1}', "{'a':1}", '{"a":foo()}', '{"a":1} // x', '{"a":`x`}', '{"a":function(){}}']) {
    assert.throws(() => parseDataLiteral(bad), SyntaxError, bad);
  }
  assert.equal(jsTokensToJson('{"a":1}'), null, 'nothing to change → null');
});

test('pageJsonPayloads: a window state carrying `undefined` is read (it used to be dropped whole)', () => {
  const html = `<script>window.__STATE__ = {"product":{"name":"Lampe","promo":undefined,"specs":[]},"pad":"${'x'.repeat(120)}"};</script>`;
  const { json } = pageJsonPayloads(html);
  assert.equal(json.length, 1);
  assert.equal(json[0].product.name, 'Lampe');
  assert.equal(json[0].product.promo, null);
});

/** A normalised Apollo-like store: the page product's spec groups + an accessory's. */
const STATE = {
  apollo: {
    'Feature:F1': { __typename: 'Feature', name: 'Diagonale', value: '102 cm / 40 pouces', unit: null },
    'Feature:F2': { __typename: 'Feature', name: 'Résolution', value: 'Full HD' },
    'Feature:F3': { __typename: 'Feature', name: 'Fréquence', value: '60', unit: 'Hz' },
    'Feature:F4': { __typename: 'Feature', name: 'Poids sans pied', value: '4.60 kg' },
    'Feature:A1': { __typename: 'Feature', name: 'Taille max. (pouces)', value: '70' },
    'Feature:A2': { __typename: 'Feature', name: 'Charge maximale', value: '35 kg' },
    'Groups:111': { __typename: 'Groups', productId: '111', featureGroups: [
      { groupName: 'Image', features: [{ __ref: 'Feature:F1' }, { __ref: 'Feature:F2' }, { __ref: 'Feature:F3' }] },
      { groupName: 'Général', features: [{ __ref: 'Feature:F4' }, { __ref: 'Feature:F2' }] },
    ] },
    'Groups:999': { __typename: 'Groups', productId: '999', featureGroups: [
      { groupName: 'Support', features: [{ __ref: 'Feature:A1' }, { __ref: 'Feature:A2' }] },
    ] },
  },
  // Not features: a list of products (price + url) and breadcrumbs.
  related: [{ name: 'Support mural', price: 49, url: '/p/999' }, { name: 'Barre de son', price: 199, url: '/p/555' }],
};

test('specsFromState: resolves __ref, keeps group names, appends units, keeps only the page product', () => {
  const s = specsFromState(STATE, { productIds: ['111'] });
  assert.deepEqual(s.map((x) => [x.group, x.name, x.value]), [
    ['Image', 'Diagonale', '102 cm / 40 pouces'],
    ['Image', 'Résolution', 'Full HD'],
    ['Image', 'Fréquence', '60 Hz'],
    ['Général', 'Poids sans pied', '4.60 kg'],
    ['Général', 'Résolution', 'Full HD'],
  ]);
  assert.ok(!s.some((x) => /max|Charge/.test(x.name)), 'the accessory shown on the page is not this product');
});

test('specsFromState: several products, none the page product → nothing; one product only → kept', () => {
  assert.deepEqual(specsFromState(STATE, { productIds: ['nope'] }), []);
  const one = { a: { productId: 'X-1', groups: [{ title: 'Taille', items: [{ label: 'Hauteur', value: '12 cm' }, { label: 'Largeur', value: '8 cm' }] }] } };
  assert.equal(specsFromState(one, { productIds: ['2232378'] }).length, 2);
  // No owner anywhere: kept as read.
  const bare = { specifications: [{ name: 'Matière', value: 'Chêne' }, { name: 'Finition', value: 'Huilée' }] };
  assert.deepEqual(specsFromState(bare).map((x) => [x.group, x.name, x.value]), [[null, 'Matière', 'Chêne'], [null, 'Finition', 'Huilée']]);
});

test('specsFromState: a list of products or links is never read as specs', () => {
  assert.deepEqual(specsFromState({ related: STATE.related, crumbs: [{ name: 'TV', item: '/tv' }, { name: 'OLED', item: '/oled' }] }), []);
});

test('specsFromJsonLd: schema.org additionalProperty (PropertyValue + unitText)', () => {
  const node = { '@type': 'Product', additionalProperty: [{ '@type': 'PropertyValue', name: 'Puissance', value: 1200, unitText: 'W' }, { '@type': 'PropertyValue', name: 'Couleur', value: 'Noir' }, { name: 'vide' }] };
  assert.deepEqual(specsFromJsonLd(node), [{ group: null, name: 'Puissance', value: '1200 W' }, { group: null, name: 'Couleur', value: 'Noir' }]);
});

test('extractSpecs: HTML label/value rows only when nothing structured exists; dedupe', () => {
  const html = '<table><tr><th>Matière</th><td>Acier <b>inox</b></td></tr><tr><td>a</td><td>b</td><td>c</td></tr></table><dl><dt>Garantie</dt><dd>2 ans</dd></dl>';
  assert.deepEqual(extractSpecs({ html }).map((x) => [x.name, x.value]), [['Matière', 'Acier inox'], ['Garantie', '2 ans']]);
  assert.equal(extractSpecs({ html, states: [{ specifications: [{ name: 'Poids', value: '1 kg' }, { name: 'Volume', value: '2 l' }] }] }).length, 2, 'structured wins');
  assert.equal(specsFromHtml('<p>rien</p>').length, 0);
  assert.equal(dedupeSpecs([{ name: 'A', value: '1' }, { name: 'a', value: '1' }]).length, 1);
});

test('colourwaysFromJsonLd: a ProductGroup wrapped in a BuyAction, varying by size without colour', () => {
  const ld = { '@type': 'BuyAction', object: { '@type': 'ProductGroup', name: 'TV 40', variesBy: ['size'], hasVariant: [
    { '@type': 'Product', sku: '1', gtin13: '5901292530358', size: '50 pouces', image: 'https://cdn.test/50.png', offers: { price: 444, url: '/p/1', availability: 'https://schema.org/InStock' } },
    { '@type': 'Product', sku: '2', gtin13: '5901292530372', size: '40 pouces', image: 'https://cdn.test/40.png', offers: { price: 299, url: '/p/2', availability: 'https://schema.org/OutOfStock' } },
  ] } };
  const cws = colourwaysFromJsonLd(ld);
  assert.equal(cws.length, 1); assert.equal(cws[0].color, null);
  assert.deepEqual(cws[0].images, [], 'another size is another product: its picture is not added');
  assert.deepEqual(sizeVariants(cws[0]), [
    { code: '5901292530358', type: 'taille', name: '50 pouces', gtin: '5901292530358', availability: 'InStock', price: 444, url: '/p/1', sku: '1' },
    { code: '5901292530372', type: 'taille', name: '40 pouces', gtin: '5901292530372', availability: 'OutOfStock', price: 299, url: '/p/2', sku: '2' },
  ]);
});

test('colourwaysFromJsonLd: colour groups are unchanged (no per-size price / url)', () => {
  const ld = { '@type': 'ProductGroup', hasVariant: [
    { '@type': 'Product', color: 'Rouge', size: 'M', gtin13: '4006381333931', offers: { price: 20, url: '/r-m' } },
    { '@type': 'Product', color: 'Rouge', size: 'L', offers: { price: 20 } },
  ] };
  const [cw] = colourwaysFromJsonLd(ld);
  assert.equal(cw.color, 'Rouge');
  assert.deepEqual(cw.sizes, [{ label: 'M', gtin: '4006381333931' }, { label: 'L' }]);
});
