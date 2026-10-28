/**
 * Product detail in the REAL renderer (app/renderer/app.js) through the DOM-free harness
 * and a fake bridge: brand, stock (schema.org term → label), customer rating, the options
 * with their own price and stock, and the technical specifications grouped as the page
 * groups them. A product without them shows none of these sections. No Electron, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const els = new Map();
const el = (id) => { if (!els.has(id)) els.set(id, { id, value: '', innerHTML: '', textContent: '', classList: { add() {}, remove() {}, toggle() {} }, focus() {}, setSelectionRange() {}, remove() {}, appendChild() {} }); return els.get(id); };
const listeners = {};
globalThis.document = {
  getElementById: (id) => el(id),
  addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  body: { classList: { add() {} } },
  activeElement: null,
  createElement: () => el('x-' + Math.random()),
};
globalThis.requestAnimationFrame = (fn) => fn();

const JOBS = [{ id: 'job-p', status: 'done', source: 'https://www.shop.test/fr/category/tv.html', store: 'tv', createdAt: '2026-10-20T10:00:00Z', products: 2, discovered: 2, processed: 2, isUrl: true }];
const RICH = {
  key: 'https://www.shop.test/p/1002', name: 'Marque 40S5L - TV 40 pouces', price: 299, currency: 'EUR', status: 'accepted', code: 'accepted_default', reason: '',
  image_url: null, source_url: 'https://www.shop.test/p/1002', source_product_id: '5901292530372', barcode: '5901292530372', weight_kg: 4.6,
  brand: 'Marque', availability: 'InStock', rating: 3.3, review_count: 6,
  variants: [{ name: '50 pouces', price: 444, availability: 'InStock' }, { name: '32 pouces', price: 249, availability: 'OutOfStock' }],
  specs: [
    { group: 'Caractéristiques techniques', name: 'Résolution', value: 'Full HD' },
    { group: 'Caractéristiques techniques', name: 'Diagonale', value: '102 cm / 40 pouces' },
    { group: 'Caractéristiques générales', name: 'Poids sans pied', value: '4.60 kg' },
    { group: null, name: 'Garantie', value: '2 ans' },
  ],
};
const BARE = { key: 'https://www.shop.test/p/2', name: 'Câble', price: 9.99, status: 'accepted', code: 'accepted_default', reason: '', source_url: 'https://www.shop.test/p/2', availability: 'Selon le magasin', variants: [], specs: [] };
globalThis.window = {
  eloshon: {
    platform: 'win32', uiReady() {}, win: {},
    appInfo: async () => ({ version: 't', arch: 'x64', packaged: false }),
    settings: { get: async () => ({}), set: async (p) => p },
    jobs: { list: async () => JOBS, report: async () => ({ ok: true, text: 'r' }), products: async () => [RICH, BARE] },
    accountStatus: async () => ({ rate: null }),
    onEvent: () => {},
    yourBrowser: { availability: async () => ({ ok: false, code: 'domain_not_enabled', enabled: false, connected: false }), run: async () => ({ ok: false }), resume: async () => ({}), stop: async () => ({}), pause: async () => ({}), status: async () => ({}) },
  },
};

const html = () => el('app').innerHTML;
const tick = () => new Promise((r) => setTimeout(r, 0));
const click = async (dataset) => { for (const fn of listeners.click || []) await fn({ target: { closest: () => ({ dataset }) } }); await tick(); };

test('product detail: brand, stock, rating, options, technical specifications by group', async () => {
  await import('../renderer/app.js');
  await tick(); await tick();
  await click({ nav: 'jobs' });
  await click({ act: 'view-results', job: 'job-p' });
  await click({ act: 'detail', key: RICH.key });
  const h = html();
  assert.match(h, /Marque<\/span>[\s\S]*?>Marque</);
  assert.match(h, /Disponibilité<\/span>[\s\S]*?En stock/);
  assert.match(h, /Note des clients<\/span>[\s\S]*?3,3 sur 5 \(6 avis\)/);
  assert.match(h, /Variantes<\/h2>[\s\S]*50 pouces<\/span>[\s\S]*?444,00\s€ · En stock[\s\S]*32 pouces<\/span>[\s\S]*?249,00\s€ · Épuisé/); // Intl, in the product's own currency
  assert.match(h, /Caractéristiques techniques<\/h2>/);
  const order = ['Caractéristiques techniques</div>', 'Résolution', 'Full HD', 'Diagonale', 'Caractéristiques générales</div>', 'Poids sans pied', 'Autres caractéristiques</div>', 'Garantie', '2 ans'].map((s) => h.indexOf(s));
  assert.ok(order.every((i) => i > 0), 'every group and spec is shown');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'grouped, in the page order');
  await click({ act: 'detail-close' });

  // A product without those details: no empty section; a stock statement that is not a
  // schema.org term is shown as the site wrote it.
  await click({ act: 'detail', key: BARE.key });
  const b = html();
  assert.doesNotMatch(b, /Variantes<\/h2>/);
  assert.doesNotMatch(b, /Caractéristiques techniques<\/h2>/);
  assert.doesNotMatch(b, /Note des clients/);
  assert.match(b, /Disponibilité<\/span>[\s\S]*?Selon le magasin/);
});
