import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonCandidates, buildPrompt, parseHints, applyHints, aiAssistJson } from '../extract/ai-assist.mjs';

const page = {
  props: { pageProps: {
    menu: [{ label: 'Homme' }, { label: 'Femme' }],
    data: { products: [
      { title: 'Casque A', cost: '89,90 €', photo: '/img/a.jpg', slug: '/p/a-1', ref: 'A1' },
      { title: 'Casque B', cost: '119,00 €', photo: '/img/b.jpg', slug: '/p/b-2', ref: 'B2' },
      { title: 'Casque C', cost: '74,50 €', photo: '/img/c.jpg', slug: '/p/c-3', ref: 'C3' },
    ] },
  } },
};

test('jsonCandidates compacts every array of objects with path/length/keys/sample', () => {
  const cands = jsonCandidates(page);
  const paths = cands.map((c) => c.path);
  assert.ok(paths.includes('props.pageProps.data.products'), 'the products array is a candidate');
  assert.ok(paths.includes('props.pageProps.menu'), 'the menu array is a candidate too (the model decides)');
  const prod = cands.find((c) => c.path === 'props.pageProps.data.products');
  assert.equal(prod.length, 3);
  assert.ok(prod.keys.includes('title') && prod.keys.includes('cost'));
});

test('parseHints validates and clamps; a null arrayPath is a clean "no grid"', () => {
  assert.equal(parseHints('not json'), null);
  const h = parseHints('```json\n{"arrayPath":"a.b","fieldMap":{"name":"t","price":"c","bogus":"x"},"confidence":1.7}\n```');
  assert.equal(h.arrayPath, 'a.b');
  assert.deepEqual(h.fieldMap, { name: 't', price: 'c' }, 'unknown field keys are dropped');
  assert.equal(h.confidence, 1, 'confidence clamped to [0,1]');
  assert.deepEqual(parseHints({ arrayPath: null, reason: 'nothing' }), { arrayPath: null, fieldMap: {}, confidence: 0, reason: 'nothing' });
});

test('applyHints maps the chosen array through the deterministic mapper (prices coerced, url absolutised)', () => {
  const hints = { arrayPath: 'props.pageProps.data.products', fieldMap: { name: 'title', price: 'cost', image: 'photo', url: 'slug', sku: 'ref' } };
  const cards = applyHints(page, hints, 'https://shop.test/fr/casques');
  assert.equal(cards.length, 3);
  assert.equal(cards[0].name, 'Casque A');
  assert.equal(cards[0].price, 89.9, 'the "89,90 €" text price is coerced to a number');
  assert.equal(cards[0].sourceUrl, 'https://shop.test/p/a-1', 'relative url absolutised');
  assert.deepEqual(cards[0].images, ['/img/a.jpg']);
  assert.equal(cards[0].sku, 'A1');
});

test('aiAssistJson: full on-demand flow with an injected (mock) model → product cards', async () => {
  let sawPrompt = '';
  const askJson = async (prompt) => {
    sawPrompt = prompt;
    // a well-behaved model points at the products array and maps the odd field names
    return { arrayPath: 'props.pageProps.data.products', fieldMap: { name: 'title', price: 'cost', image: 'photo', url: 'slug', sku: 'ref' }, confidence: 0.9, reason: 'homogeneous product objects' };
  };
  const { cards, hints, candidates } = await aiAssistJson(page, 'https://shop.test/fr/casques', { askJson, url: 'https://shop.test/fr/casques' });
  assert.ok(candidates >= 2 && /Candidates/.test(sawPrompt));
  assert.equal(hints.confidence, 0.9);
  assert.equal(cards.length, 3);
  assert.equal(cards[1].price, 119);
});

test('custom user fields + per-field AI hint: schema is honoured end to end (the "Tags" case)', async () => {
  const videoPage = { page: { items: [
    { t: 'Clip A', href: '/v/a', thumb: '/t/a.jpg', mots: ['hd', 'teen'], vues: '12k' },
    { t: 'Clip B', href: '/v/b', thumb: '/t/b.jpg', mots: ['hd', 'blonde'], vues: '8k' },
  ] } };
  const fields = [
    { key: 'name', label: 'Titre' }, { key: 'url', label: 'Lien' }, { key: 'image', label: 'Vignette' },
    { key: 'tags', label: 'Tags', hint: 'ici ce sont les tags à afficher' }, { key: 'views', label: 'Vues' },
  ];
  let prompt = '';
  const askJson = async (p) => { prompt = p; return { arrayPath: 'page.items', fieldMap: { name: 't', url: 'href', image: 'thumb', tags: 'mots', views: 'vues' }, confidence: 0.8 }; };
  const { cards } = await aiAssistJson(videoPage, 'https://site.test/c/x', { askJson, fields });
  assert.match(prompt, /tags \(Tags\) — hint: ici ce sont les tags/, 'the per-field hint reaches the model');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].name, 'Clip A');
  assert.deepEqual(cards[0].tags, ['hd', 'teen'], 'the custom field the AI mapped is carried through');
  assert.equal(cards[0].views, '12k');
  assert.equal(cards[0].sourceUrl, 'https://site.test/v/a');
});

test('aiAssistJson: a model that finds no grid yields 0 cards, no throw', async () => {
  const askJson = async () => ({ arrayPath: null, confidence: 0, reason: 'only menus and facets' });
  const { cards, hints } = await aiAssistJson(page, 'https://shop.test/', { askJson });
  assert.equal(cards.length, 0);
  assert.equal(hints.arrayPath, null);
});

test('aiAssistJson: an injected model error is caught (never breaks the run)', async () => {
  const askJson = async () => { throw new Error('rate limited'); };
  const r = await aiAssistJson(page, 'https://shop.test/', { askJson });
  assert.equal(r.cards.length, 0);
  assert.match(r.error, /rate limited/);
});
