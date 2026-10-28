/**
 * Phase 5.8 — Round trips.
 *  (1) WC REST (real) → canon → WooCommerce CSV → CSV parser → canon':
 *      STRICT equality on the extended-canon fields the WC CSV carries.
 *  (2) A synthetic canon product exercising every extended field the WC
 *      exporter has a column for (sale window, downloads, external, purchase
 *      note, tax/shipping class, upsells/cross-sells, descriptive attributes).
 *  (3) Scraper export → canon → WC CSV → canon': carried fields identical.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWooRestJson, convertFromCanon, convert, serializeCsv, parseCsv, parseCsvWithKnowledge } from '../core/dist/index.mjs';
import { parseWooModern } from '../core/dist/products.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = path.join(ROOT, 'test', 'fixtures', 'live', 'woocommerce-test');
const J = (n) => JSON.parse(fs.readFileSync(path.join(LIVE, n), 'utf8'));

const toWooCsvAndBack = (products) => {
  const res = convertFromCanon(products, { direction: 'woocommerce-to-woocommerce', entity: 'products', expectPlatform: 'woocommerce' });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  const csv = serializeCsv(res.headers, res.rows);
  const t = parseCsv(csv);
  return { csv, back: parseWooModern(t.headers, t.rows), headers: t.headers };
};

// What the WooCommerce CSV can carry of the extended canon — compared STRICTLY.
const ext = (p) => ({
  title: p.title, published: p.published, categories: p.categories, tags: p.tags,
  visibility: p.visibility ?? null,
  notes: p.notes ?? null,
  external: p.external ?? null,
  digital: p.digital ? { downloads: p.digital.downloads ?? [], downloadLimit: p.digital.downloadLimit ?? null, downloadExpiry: p.digital.downloadExpiry ?? null } : null,
  menuOrder: p.merchandising?.menuOrder ?? null,
  attributesRich: (p.attributesRich ?? []).map((a) => ({ name: a.name, values: [...a.values].sort(), forVariation: !!a.forVariation, visible: a.visible ?? true })),
  options: p.options.map((o) => ({ name: o.name, values: [...o.values].sort() })),
  variants: p.variants.map((v) => ({
    price: v.price, compareAtPrice: v.compareAtPrice, grams: v.grams, inventoryQty: v.inventoryQty, taxable: v.taxable, requiresShipping: v.requiresShipping,
    optionValues: v.optionValues,
    salePeriod: v.salePeriod ? { from: v.salePeriod.from ?? null, to: v.salePeriod.to ?? null } : null,
    backorders: v.stockPolicy?.backorders ?? null, soldIndividually: v.stockPolicy?.soldIndividually ?? null,
    taxClass: v.taxClass || null, shippingClass: v.shippingClass || null,
  })).sort((a, b) => a.optionValues.join('|').localeCompare(b.optionValues.join('|'))),
});

test('WC REST (real) → canon → WC CSV → CSV parser: extended fields survive strictly', () => {
  const { products } = parseWooRestJson({ products: J('products.json'), variations: { 13: J('products-13-variations.json') }, categories: J('categories.json') });
  const { back, headers } = toWooCsvAndBack(products);
  assert.equal(back.length, products.length);
  for (const h of ['Is featured?', 'Backorders allowed?', 'Sold individually?', 'Position']) assert.ok(headers.includes(h), 'column ' + h);
  const byTitle = Object.fromEntries(back.map((p) => [p.title, p]));
  for (const p of products) {
    const q = byTitle[p.title];
    assert.ok(q, p.title);
    assert.deepEqual(ext(q), ext(p), p.title);
  }
});

test('synthetic canon with EVERY extended WC column: strict round trip (sale window, downloads, external, note, classes, upsells, descriptive attributes)', () => {
  const mk = (id, sku, title, extra = {}) => ({
    handle: sku.toLowerCase(), title, bodyHtml: '<p>x</p>', vendor: '', productType: '', tags: ['t1'], status: 'active', categories: ['A > B'], published: true,
    options: [], images: [{ src: 'https://cdn.example.test/' + sku + '.jpg', position: 1, alt: '' }], metafields: [], seoTitle: '', seoDescription: 'short',
    identity: { sourceId: id },
    variants: [{ optionValues: [], sku, price: 10, compareAtPrice: 12, cost: null, barcode: '', grams: 500, lengthCm: 1, widthCm: 2, heightCm: 3, requiresShipping: true, taxable: true, inventoryQty: 4, imageSrc: '' }],
    ...extra,
  });
  const a = mk('1', 'SKU-A', 'Alpha', {
    visibility: { featured: true, catalogVisibility: 'catalog' },
    notes: { purchase: 'Merci !' },
    external: { url: 'https://partner.example.test/p', buttonText: 'Acheter' },
    digital: { downloads: [{ name: 'Manuel', file: 'https://cdn.example.test/m.pdf' }, { name: 'Fiche', file: 'https://cdn.example.test/f.pdf' }], downloadLimit: 3, downloadExpiry: '30' },
    merchandising: { menuOrder: 7, upsells: ['2'], crossSells: ['2'] },
    attributesRich: [{ name: 'Matière', values: ['Chêne', 'Hêtre'], forVariation: false, visible: true }, { name: 'Origine', values: ['France'], forVariation: false, visible: false }],
  });
  a.variants[0].salePeriod = { from: '2026-12-01T00:00:00.000Z', to: '2026-12-24T00:00:00.000Z' };
  a.variants[0].stockPolicy = { backorders: 'notify', soldIndividually: true };
  a.variants[0].taxClass = 'reduced-rate'; a.variants[0].shippingClass = 'heavy';
  const b = mk('2', 'SKU-B', 'Beta', { visibility: { featured: false, catalogVisibility: 'visible' }, merchandising: { menuOrder: 0 } });
  b.variants[0].stockPolicy = { backorders: 'no', soldIndividually: false };

  const { back, headers, csv } = toWooCsvAndBack([a, b]);
  for (const h of ['Date sale price starts', 'Date sale price ends', 'Tax class', 'Shipping class', 'Purchase note', 'Upsells', 'Cross-sells', 'External URL', 'Button text', 'Download 1 name', 'Download 2 URL', 'Download limit', 'Download expiry']) assert.ok(headers.includes(h), 'column ' + h);
  const A = back.find((p) => p.title === 'Alpha'), B = back.find((p) => p.title === 'Beta');
  assert.deepEqual(ext(A), ext(a));
  assert.deepEqual(ext(B), ext(b));
  // merchandising ids were SOURCE ids → resolved to the target's SKU in the batch
  assert.deepEqual(A.merchandising.upsells, ['SKU-B']); assert.deepEqual(A.merchandising.crossSells, ['SKU-B']);
  // and a product without the extended fields does not get phantom values
  assert.equal(B.notes, undefined); assert.equal(B.external, undefined); assert.equal(B.digital, undefined);
  assert.ok(!csv.includes('undefined'));
});

test('Scraper export → canon → WC CSV → CSV parser: carried fields identical', () => {
  const csv = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'scraper', 'lidl-de.csv'), 'utf8');
  const { products } = parseCsvWithKnowledge('scraper.eloshon-export.v1', csv);
  const res = convert(csv, { direction: 'eloshon-to-woocommerce', entity: 'products', expectPlatform: 'eloshon' });
  const t = parseCsv(serializeCsv(res.headers, res.rows));
  const back = parseWooModern(t.headers, t.rows);
  const proj = (p) => ({ title: p.title, categories: p.categories, tags: p.tags, images: p.images.map((i) => i.src), price: p.variants[0].price, grams: p.variants[0].grams, metafields: p.metafields });
  assert.deepEqual(back.map(proj), products.map(proj));
});
