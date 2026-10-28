// Phase 2 — the generic, format-agnostic transforms and the structure.preserveNested
// guarantee added for the products.json entry. Tested here WITHOUT any
// products.json: they are vocabulary for any knowledge entry, not Scraper code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTransform } from '../transforms.mjs';
import { parseWithKnowledge } from '../generic-parser.mjs';

const T = (id, v, args, extra = {}) => applyTransform(id, v, { args, source: {}, parent: null, product: {}, companions: {}, field: null, platform: 'x', ...extra });

test('first_present: the first present input, converted; an empty list falls back to the next input', () => {
  assert.deepEqual(T('first_present', [['a.jpg', 'b.jpg'], 'z.jpg'], { as: 'images_from_urls' }).map((i) => i.src), ['a.jpg', 'b.jpg']);
  assert.deepEqual(T('first_present', [[], 'z.jpg'], { as: 'images_from_urls' }).map((i) => i.src), ['z.jpg']);
  assert.deepEqual(T('first_present', [undefined, 'z.jpg'], { as: 'images_from_urls' }).map((i) => i.src), ['z.jpg']);
  assert.equal(T('first_present', [undefined, null], { as: 'images_from_urls' }), undefined, 'nothing present → nothing written');
  assert.equal(T('first_present', [['a.jpg'], 'z.jpg'], { as: 'first' }), 'a.jpg');
});

test('money_if_above: a crossed-out price only when strictly above the reference', () => {
  assert.equal(T('money_if_above', [99.9, 72.9]), 99.9);
  assert.equal(T('money_if_above', ['29,90', '24.90']), 29.9);
  assert.equal(T('money_if_above', [9.9, 12.9]), undefined);
  assert.equal(T('money_if_above', [12.9, 12.9]), undefined);
  assert.equal(T('money_if_above', [12.9, null]), undefined, 'no reference → nothing to compare against');
  assert.equal(T('money_if_above', [null, 12.9]), undefined);
});

test('text_matching: the text when it matches, else nothing', () => {
  const gtin = { pattern: '^([0-9]{8}|[0-9]{12,14})$' };
  assert.equal(T('text_matching', '4006381333931', gtin), '4006381333931');
  assert.equal(T('text_matching', ' 12345678 ', gtin), '12345678');
  assert.equal(T('text_matching', '12345', gtin), undefined);
  assert.equal(T('text_matching', null, gtin), undefined);
});

test('regex_map: the first matching rule wins; no match → default', () => {
  const args = { rules: [{ pattern: 'out ?of ?stock|rupture', flags: 'i', value: 0 }] };
  assert.equal(T('regex_map', 'https://schema.org/OutOfStock', args), 0);
  assert.equal(T('regex_map', 'Rupture de stock', args), 0);
  assert.equal(T('regex_map', 'InStock', args), undefined);
  assert.equal(T('regex_map', null, { ...args, default: 'x' }), 'x');
});

test('slug_hash: slug of the first base input + base-36 31-polynomial hash of the first id input', () => {
  // Same algorithm as the Eloshon Scraper CSV writer (core/csv.mjs slugify + shortId).
  assert.equal(T('slug_hash', ['Filtre à particules 315 mm', null, '4006381333931'], { baseInputs: 2 }), 'filtre-a-particules-315-mm-5bm3ta');
  assert.equal(T('slug_hash', [null, null, null], { baseInputs: 2, fallback: 'produit' }), 'produit-0', 'empty base → fallback; empty basis hashes to 0');
  assert.equal(T('slug_hash', ['x'.repeat(80), null, 'id'], { baseInputs: 2, maxLen: 60 }).split('-')[0].length, 60);
});

test('parent_when_absent: a child without its own value reads the parent; a child with one gets nothing', () => {
  const parent = { price: 72.9, list: 99.9 };
  const args = { parentInputs: ['list', 'price'], as: 'money_if_above' };
  assert.equal(T('parent_when_absent', undefined, args, { parent }), 99.9);
  assert.equal(T('parent_when_absent', 50, args, { parent }), undefined);
  assert.equal(T('parent_when_absent', undefined, args, { parent: null }), undefined, 'no parent (the product itself)');
});

test('clean_text / consent_bool: the engine CSV parsers\' own value semantics (values.mjs)', () => {
  const nb = String.fromCharCode(0xa0), lf = String.fromCharCode(10);
  assert.equal(T('clean_text', '  O’Brien' + lf + 'x' + nb + 'y  '), "O'Brien x y");
  assert.equal(T('clean_text', undefined), '');
  assert.equal(T('clean_text', "'+3312", { stripExcelGuard: true }), '+3312');
  assert.equal(T('consent_bool', ' Subscribed '), true);
  assert.equal(T('consent_bool', 'not subscribed'), false);
  assert.equal(T('consent_bool', 'maybe'), null);
  assert.equal(T('consent_bool', 'maybe', { strict: true }), false);
  assert.equal(T('consent_bool', undefined), null);
});

test('clean_list / join_parts / state_code / is_set(clean)', () => {
  assert.deepEqual(T('clean_list', ' Retail, Gold '), ['Retail, Gold'], 'one item by default');
  assert.deepEqual(T('clean_list', ' a , ,b ', { sep: ',' }), ['a', 'b']);
  assert.deepEqual(T('clean_list', '   '), []);
  const parts = { sep: ' — ', parts: [{}, { prefix: 'Store credit: ', skip: ['0'] }] };
  assert.equal(T('join_parts', ['VIP', '25.00'], parts), 'VIP — Store credit: 25.00');
  assert.equal(T('join_parts', ['', '0'], parts), '');
  assert.equal(T('join_parts', [' ', '10'], parts), 'Store credit: 10');
  assert.equal(T('state_code', ['new york', 'US']), 'NY');
  assert.equal(T('state_code', [' Quebec ', 'CA']), 'Quebec');
  assert.equal(T('is_set', '  ', { clean: true }), false);
  assert.equal(T('is_set', '  '), true, 'default unchanged');
});

test('address_block: a whole address from flat columns, null when the listed keys are all blank', () => {
  const args = { fields: { city: 'c', province: 's', country: 'k', zip: 'z' }, provinceCode: { state: 's', country: 'k' }, nullWhenEmpty: ['address1', 'city', 'zip', 'company', 'province'] };
  assert.deepEqual(T('address_block', undefined, args, { source: { c: ' Austin ', s: 'Texas', k: 'US', z: '73301' } }),
    { company: '', address1: '', address2: '', city: 'Austin', province: 'Texas', provinceCode: 'TX', country: 'US', zip: '73301', phone: '' });
  assert.equal(T('address_block', undefined, args, { source: { k: 'FR' } }), null, 'only a country: no address');
});

test('structure.rows.include: the generic parser keeps the matching rows and counts the others', () => {
  const format = { id: 'demo.rows.v1', platformHint: 'demo', entity: 'customers', structure: { rows: { include: { column: 'role', equals: 'customer', ignoreCase: true } } }, fields: [{ path: 'email', canon: 'email', transform: 'clean_text' }] };
  const { products, report } = parseWithKnowledge(format, [{ email: 'a', role: 'Customer' }, { email: 'b', role: 'admin' }, { email: 'c', role: 'customer' }]);
  assert.deepEqual(products.map((p) => p.email), ['a', 'c']);
  assert.equal(report.excluded, 1);
});

test('options_from_columns / value_or_slug / exactness options on clean_text, category_path_split, price_promo', () => {
  assert.deepEqual(T('options_from_columns', { 'attribute:Taille': 'S | M |', 'attribute:Couleur': '' }, { stripPrefix: 'attribute:', sep: '|' }), [{ name: 'Taille', values: ['S', 'M'] }]);
  assert.equal(T('value_or_slug', ['', 'Écharpe — été']), 'echarpe-ete');
  assert.equal(T('value_or_slug', ['my-slug', 'ignored']), 'my-slug');
  assert.equal(T('value_or_slug', ['', '']), 'product');
  assert.equal(T('clean_text', 'Maison > Sous-marque ', { lastSegmentOf: '>' }), 'Sous-marque');
  assert.deepEqual(T('category_path_split', 'A >  > B', { sep: '>', listSep: ',' }), ['A > B'], 'default drops empty levels');
  assert.deepEqual(T('category_path_split', 'A >  > B', { sep: '>', listSep: ',', keepEmptySegments: true }), ['A >  > B']);
  assert.deepEqual(T('price_promo', ['', '12.5']), [12.5, null], 'default: a lone sale price is the price');
  assert.deepEqual(T('price_promo', ['', '12.5'], { noSaleFallback: true }), [null, null]);
});

test('generic parser: a column family (pathPattern) is read as one object and never reported unknown', () => {
  const format = { id: 'demo.family.v1', platformHint: 'demo', entity: 'products', fields: [
    { path: 'name', canon: 'title', transform: 'copy' },
    { path: 'attribute:<n>', pathPattern: '^attribute:', canon: 'options', transform: 'options_from_columns', args: { stripPrefix: 'attribute:', sep: '|' } },
  ] };
  const { products, report } = parseWithKnowledge(format, [{ name: 'A', 'attribute:Size': 'S|M', 'attribute:Color': 'Red', other: 'x' }]);
  assert.deepEqual(products[0].options, [{ name: 'Size', values: ['S', 'M'] }, { name: 'Color', values: ['Red'] }]);
  assert.deepEqual(report.unknownKeys, ['other'], 'family members consumed; the stray column is kept as unknown');
});

test('marketing_consent: trimRaw and ignoreCase are opt-in (defaults unchanged)', () => {
  const lists = { pending: ['yes'], optedOut: ['no'] };
  assert.equal(T('marketing_consent', ' YES ', { ...lists, ignoreCase: true, trimRaw: true }).state, 'pending');
  assert.equal(T('marketing_consent', ' YES ', { ...lists, ignoreCase: true, trimRaw: true }).source.raw, 'YES');
  assert.equal(T('marketing_consent', '   ', { ...lists, trimRaw: true }), undefined, 'a blank statement is no statement');
  assert.equal(T('marketing_consent', ' YES ', lists).state, 'unknown', 'default: case-sensitive');
  assert.equal(T('marketing_consent', ' YES ', lists).source.raw, ' YES ', 'default: raw verbatim');
});

test('structure.preserveNested: keys of a consumed nested object that no entry reads are preserved, never swallowed', () => {
  const format = {
    id: 'demo.nested.v1', platformHint: 'demo', entity: 'products',
    structure: { preserveNested: ['raw'] },
    fields: [
      { path: 'name', canon: 'title', transform: 'text' },
      { path: 'raw.brand', canon: 'vendor', transform: 'text' },
    ],
  };
  const { products, report } = parseWithKnowledge(format, [{ name: 'A', raw: { brand: 'B', extra: 42 } }]);
  assert.equal(products[0].vendor, 'B');
  assert.equal(products[0].sourceExtension.demo._raw['raw.extra'], 42);
  assert.deepEqual(products[0].unmapped, [{ platform: 'demo', sourceField: 'raw.extra', sourceValue: 42, reason: 'unknown' }]);
  assert.deepEqual(report.unknownKeys, ['raw.extra']);
  // without the declaration the historical behaviour is unchanged (the parent key is consumed)
  const { products: legacy } = parseWithKnowledge({ ...format, structure: {} }, [{ name: 'A', raw: { brand: 'B', extra: 42 } }]);
  assert.equal(legacy[0].unmapped, undefined);
});
