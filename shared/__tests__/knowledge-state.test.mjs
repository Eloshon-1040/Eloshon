/**
 * Shops that build the description / spec blocks in the browser still send the text in the page's
 * embedded state (Apollo cache, preloaded store…). Read it there — for the page's product only.
 * Offline, generic shapes (modelled on a real electronics shop: description HTML under the product's
 * cache key, a related product with its own description next to it).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { htmlToText, stateTextFor, stateKeyForText, productIdsOf } from '../knowledge/state-values.mjs';
import { pageJsonPayloads } from '../extract/product-group.mjs';
import { ruleFromElement, applyKnowledge } from '../knowledge/apply.mjs';
import { emptyKnowledge, upsertRule } from '../knowledge/rules.mjs';

const DESC = "<p><h3>L'avis de nos experts</h3> </p>\n<p><b>+ Écran lumineux : </b>l'écran de 6,7 pouces offre des images fluides.</p>\n<ul><li>Triple capteur 50 MP</li><li>128 Go extensibles</li></ul>";
const state = (id) => ({
  apolloState: {
    [`GraphqlProduct:Media:fr-BE:${id}`]: { __typename: 'GraphqlProduct', id: String(id), description: DESC.replace('6,7', id === '2195579' ? '6,7' : '6,1'), featureGroups: [{ name: 'Écran', features: [{ name: 'Taille', value: '6,7"' }, { name: 'Type', value: 'AMOLED' }] }] },
    'GraphqlProduct:Media:fr-BE:9999999': { __typename: 'GraphqlProduct', id: '9999999', description: '<p>Accessoire voisin, une autre description qui ne doit jamais être prise pour celle de la page.</p>' },
  },
});
// The HTML the shop SENDS: no description block, a snippet in JSON-LD, the text in the state.
const sent = (id) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: 'Phone', sku: id, description: 'Commande le Phone chez nous.' })}</script></head><body><h1>Phone</h1><section aria-label="Description du produit"></section>
  <script>window.__PRELOADED_STATE__ = ${JSON.stringify(state(id))};</script></body></html>`;
const URL_OF = (id) => `https://shop.test/fr/product/_phone-${id}.html`;

test('htmlToText keeps headings, paragraphs and list items as lines and decodes entities', () => {
  assert.equal(htmlToText(DESC), "L'avis de nos experts\n+ Écran lumineux : l'écran de 6,7 pouces offre des images fluides.\n• Triple capteur 50 MP\n• 128 Go extensibles");
  assert.equal(htmlToText('A &amp; B&nbsp;C'), 'A & B C');
});

test('stateTextFor: the description of the PAGE product, never the related one next to it', () => {
  const { json, jsonLd } = pageJsonPayloads(sent('2195579'));
  const ids = productIdsOf({ url: URL_OF('2195579'), jsonLd });
  assert.ok(ids.includes('2195579'));
  const got = stateTextFor(json, { productIds: ids });
  assert.match(got.text, /^L'avis de nos experts\n\+ Écran lumineux : l'écran de 6,7 pouces/);
  assert.match(got.path, /2195579\.description$/);
  // Unknown product: several different descriptions → nothing rather than a guess.
  assert.equal(stateTextFor(json, { productIds: ['1111111'] }), null);
});

test('stateKeyForText: the state key a designated block came from (a heading fragment is not it)', () => {
  const { json } = pageJsonPayloads(sent('2195579'));
  assert.equal(stateKeyForText(json, htmlToText(DESC)), 'description');
  assert.equal(stateKeyForText(json, 'trop court'), null);
});

test('a rule designated on the RENDERED page reads the state on a page the shop sends without the block', () => {
  // Rendered page (what the user saw and clicked): the block exists, the state too.
  const rendered = parseHTML(sent('2195579').replace('<section aria-label="Description du produit"></section>', `<section aria-label="Description du produit"><div class="x-hash1 x-hash2">${DESC}</div></section>`)).document;
  const payloads = pageJsonPayloads(rendered.documentElement.outerHTML).json;
  const { rule, read } = ruleFromElement(rendered.querySelector('.x-hash1'), rendered, { field: 'description', payloads });
  assert.ok(read.ok); assert.deepEqual(rule.state, { key: 'description' });
  const k = upsertRule(emptyKnowledge(), rule).knowledge;
  // Another product, as sent over plain HTTP: no block in the HTML.
  const other = sent('2195580');
  const page = pageJsonPayloads(other);
  const got = applyKnowledge(parseHTML(other).document, k, { payloads: page.json, productIds: productIdsOf({ url: URL_OF('2195580'), jsonLd: page.jsonLd }) });
  assert.equal(got.trace[0].strategy, 'state');
  assert.match(got.values.description, /6,1 pouces/, 'its own description');
});

test('an older rule without a learned key still finds a description in the state; a specs rule reads the state specs', () => {
  const doc = parseHTML('<html><body><div class="d"><p>Une description rendue dans le navigateur, assez longue pour compter.</p></div><table class="s"><tr><th>A</th><td>1</td></tr><tr><th>B</th><td>2</td></tr></table></body></html>').document;
  let k = emptyKnowledge();
  k = upsertRule(k, ruleFromElement(doc.querySelector('.d'), doc, { field: 'description' }).rule).knowledge;
  k = upsertRule(k, ruleFromElement(doc.querySelector('.s'), doc, { field: 'technical_specs' }).rule).knowledge;
  const html = sent('2195579'); const page = pageJsonPayloads(html);
  const got = applyKnowledge(parseHTML(html).document, k, { payloads: page.json, productIds: productIdsOf({ url: URL_OF('2195579'), jsonLd: page.jsonLd }) });
  assert.deepEqual(got.trace.map((t) => [t.field, t.ok, t.strategy]), [['description', true, 'state'], ['technical_specs', true, 'state']]);
  assert.deepEqual(got.values.technical_specs.map((s) => [s.name, s.value]), [['Taille', '6,7"'], ['Type', 'AMOLED']]);
});
