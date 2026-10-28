/**
 * Price, list price, name and EAN taught with the 🎯 are REAL fields: a price is an amount + a currency
 * (the page's currency when the block shows only the figure), cents in a superscript are joined, an EAN
 * is kept only with a right check digit, a brand is short text. A value that fails its check is a rule
 * failure (counted), never data. Merged into the row as the product's price — not as an extra column.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { ruleFromElement, readRule, applyKnowledge, mergeKnowledgeIntoRow, validateValue, foldOutcomes } from '../knowledge/apply.mjs';
import { growBlock } from '../knowledge/pick-block.mjs';
import { newRule } from '../knowledge/rules.mjs';

const URL = 'https://shop.test/p/1';
const page = ({ price = '<span class="amt">10<sup>99</sup> €</span>', ld = '' } = {}) => parseHTML(`<html><head>${ld}</head><body><main>
  <h1 class="title">Sérum Éclat</h1><a class="brand-link" href="/marques/lumea">Luméa</a>
  <div class="prices"><span class="now">${price}</span><s class="was">14,50 €</s></div>
  <div class="ean">EAN : 4006381333931</div><div class="ean-bad">EAN : 4006381333932</div></main></body></html>`).document;

function designate(doc, sel, field) {
  const el = growBlock(doc.querySelector(sel), field);
  const { rule, read } = ruleFromElement(el, doc, { field, url: URL });
  return { rule, read };
}

test('price: a click on the cents still takes the whole amount, read as 10.99 EUR', () => {
  const doc = page();
  const { rule, read } = designate(doc, '.amt sup', 'price');
  assert.equal(read.ok, true, read.reason);
  assert.deepEqual(read.value, { price: 10.99, currency: 'EUR' });
  assert.equal(rule.example, '10.99 EUR');
});

test('price: a figure without a currency takes the currency the page declares; none at all is a failure', () => {
  const withLd = page({ price: '<span class="amt">24,90</span>', ld: '<script type="application/ld+json">{"@type":"Product","offers":{"price":"24.90","priceCurrency":"EUR"}}</script>' });
  const rule = newRule({ field: 'price', selector: '.amt' });
  assert.deepEqual(readRule(withLd, rule).value, { price: 24.9, currency: 'EUR' });
  const bare = page({ price: '<span class="amt">24,90</span>' });
  const r = readRule(bare, rule);
  assert.equal(r.ok, false); assert.match(r.reason, /sans devise/);
  const soon = readRule(page({ price: '<span class="amt">Bientôt disponible</span>' }), rule);
  assert.equal(soon.ok, false); assert.match(soon.reason, /pas un prix lisible/);
});

test('a value that fails its check counts as a failure of the rule (feeds its confidence)', () => {
  const rule = newRule({ field: 'price', selector: '.amt' });
  const k = { version: 2, rules: [rule] };
  const ap = applyKnowledge(page({ price: '<span class="amt">Rupture</span>' }), k, { url: 'https://shop.test/p/2' });
  assert.deepEqual(foldOutcomes({}, ap)[rule.id], { ok: 0, fail: 1 });
  assert.equal(ap.values.price, undefined);
});

test('EAN: kept only with a right check digit; brand and name are short text', () => {
  const doc = page();
  assert.equal(readRule(doc, newRule({ field: 'ean', selector: '.ean' })).value, '4006381333931');
  const bad = readRule(doc, newRule({ field: 'ean', selector: '.ean-bad' }));
  assert.equal(bad.ok, false); assert.match(bad.reason, /chiffre de contrôle/);
  assert.equal(validateValue('brand', 'Luméa'), null);
  assert.match(validateValue('brand', 'https://shop.test/marques/lumea'), /adresse/);
  assert.match(validateValue('brand', '12345'), /lettres/);
  assert.match(validateValue('brand', 'x'.repeat(80)), /trop long/);
  assert.equal(validateValue('name', 'Sérum Éclat'), null);
});

test('merged as the product’s own fields: a manual price wins (with its currency), the list price and the name too', () => {
  const doc = page();
  const k = { version: 2, rules: [
    designate(doc, '.amt sup', 'price').rule,
    { ...newRule({ field: 'list_price', selector: '.was' }) },
    designate(doc, '.title', 'name').rule,
    designate(doc, '.brand-link', 'brand').rule,
  ] };
  const ap = applyKnowledge(doc, k, { url: 'https://shop.test/p/3' });
  const row = { name: 'SERUM', price: 12, currency: 'USD' };
  const added = mergeKnowledgeIntoRow(row, ap);
  assert.deepEqual(added.sort(), ['brand', 'listPrice', 'name', 'price']);
  assert.equal(row.price, 10.99); assert.equal(row.currency, 'EUR');
  assert.equal(row.listPrice, 14.5); assert.equal(row.name, 'Sérum Éclat'); assert.equal(row.brand, 'Luméa');
  assert.equal(row.columns, undefined, 'no extra « name » / « price » column');
});
