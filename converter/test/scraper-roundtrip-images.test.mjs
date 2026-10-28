/**
 * Images and product addresses from the Scraper to every target, byte for byte: a Scraper export (CSV written
 * by the app's own writer, and products.json) whose addresses hold commas (CDN transformation paths), query
 * strings, encoded spaces and unicode goes through the Converter and comes out with every address intact —
 * one image per row for Shopify / Wix / BigCommerce, a comma-safe list for WooCommerce — and is read back
 * from the written CSV identical. The product address reaches Shopify as a metafield.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert, parseCsv, serializeCsv } from '../core/dist/index.mjs';
import { splitUrlList, encodeUrlForList, looksLikeUrl } from '../core/knowledge-proposal/values.mjs';
import { TRANSFORMS } from '../core/knowledge-proposal/transforms.mjs';
import { toImportCsv } from '../../core/csv.mjs';

const CLOUD = (t, file) => `https://assets.example-cdn.com/images/e_trim:EAEEEF/c_lpad,w_iw,h_ih/b_rgb:EAEEEF/${t},f_auto,q_auto,fl_lossy,c_fill,g_auto/ab250e4e84694097996b2564de682545_9366/${file}`;
const URLS = {
  cloud1: CLOUD('w_2000', 'Chaussure_Spezial_Marron_IF6490_01_00_standard.jpg'),
  cloud2: CLOUD('w_2000', 'Chaussure_Spezial_Marron_IF6490_02_standard.jpg'),
  imgix: 'https://img.example.net/catalog/p/42/front.jpg?w=1600&h=1600&auto=format,compress&fit=max',
  shopify: 'https://cdn.shopify.com/s/files/1/0001/products/pull.jpg?v=1699999999',
  space: 'https://media.example.org/photos/mon%20produit/%C3%A9t%C3%A9.jpg',
  akamai: 'https://assets.example-cdn.com/isr/1/c1/-/ASSET_MMS_162895121?x=1248&y=936&format=webp&quality=60',
};
const products = [
  { store_slug: 'demo', source_url: 'https://www.example-shop.be/fr/chaussure-spezial/IF6490.html', source_product_id: 'IF6490', source_category: 'Chaussures', product_type: null, name: 'Chaussure Spezial', description: 'Une chaussure.', storage_info: null, price: 110, weight_kg: null, barcode: null, hs_code: null, images: [URLS.cloud1, URLS.cloud2, URLS.imgix], image_url: URLS.cloud1, category_slug: null, color: null, variants: null, raw: { brand: 'Marque', currency: 'EUR' } },
  { store_slug: 'demo', source_url: 'https://www.example-shop.be/fr/pull/P42.html', source_product_id: 'P42', source_category: 'Pulls', product_type: null, name: 'Pull, col rond', description: 'Un pull "doux".', storage_info: null, price: 59.9, weight_kg: null, barcode: null, hs_code: null, images: [URLS.shopify, URLS.space, URLS.akamai], image_url: URLS.shopify, category_slug: null, color: null, variants: null, raw: { brand: 'Marque', currency: 'EUR' } },
];
const ALL = Object.values(URLS);
// The file the app writes for a result (converter/app/controller.mjs does the same).
const csvOf = (r) => serializeCsv(r.headers, r.rows);

test('splitUrlList / images_from_urls: never on a bare comma; pieces that are not addresses are dropped', () => {
  assert.deepEqual(splitUrlList(URLS.cloud1), [URLS.cloud1]);
  assert.deepEqual(splitUrlList(`${URLS.cloud1}, ${URLS.imgix}`), [URLS.cloud1, URLS.imgix]);
  assert.deepEqual(splitUrlList(`${URLS.cloud1};${URLS.cloud2}`, ';'), [URLS.cloud1, URLS.cloud2]);
  assert.deepEqual(splitUrlList('/img/a.jpg, /img/b.jpg'), ['/img/a.jpg', '/img/b.jpg']);
  const imgs = TRANSFORMS.images_from_urls(URLS.cloud1, { args: {} });
  assert.deepEqual(imgs, [{ src: URLS.cloud1, position: 1, alt: '' }], 'ONE image, not eight pieces');
  assert.deepEqual(TRANSFORMS.images_from_urls(`${URLS.imgix}\n${URLS.shopify}`, { args: {} }).map((i) => i.src), [URLS.imgix, URLS.shopify]);
  assert.deepEqual(TRANSFORMS.images_from_urls('w_iw, f_auto', { args: {} }), [], 'pieces of an address are never images');
  assert.deepEqual(TRANSFORMS.images_from_urls([URLS.cloud1, URLS.cloud1], { args: {} }).map((i) => i.src), [URLS.cloud1], 'deduplicated');
  assert.equal(looksLikeUrl('w_iw'), false); assert.equal(looksLikeUrl('//cdn/a.jpg'), true); assert.equal(looksLikeUrl('/a.jpg'), true);
  assert.equal(encodeUrlForList(URLS.cloud1, ','), URLS.cloud1.split(',').join('%2C'));
});

test('Scraper CSV (the app’s own writer) → Shopify: one Image Src per row, byte-identical, and the source address as a metafield; read back identical', () => {
  const csv = toImportCsv(products);
  const res = convert(csv, { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.equal(res.sourceFormat, 'scraper.eloshon-export.v2');
  // The CSV carries one image per product (image_url): that one, intact.
  const srcs = res.rows.map((r) => r['Image Src']).filter(Boolean);
  assert.deepEqual(srcs, [URLS.cloud1, URLS.shopify]);
  assert.deepEqual(res.rows.map((r) => r['Image Position']).filter(Boolean), ['1', '1']);
  const col = 'source_url (product.metafields.eloshon.source_url)';
  assert.ok(res.headers.includes(col), 'the product address travels as a metafield');
  assert.deepEqual(res.rows.map((r) => r[col]), ['https://www.example-shop.be/fr/chaussure-spezial/IF6490.html', 'https://www.example-shop.be/fr/pull/P42.html']);
  assert.deepEqual(res.rows.map((r) => r.Handle), [parseCsv(csv).rows[0].slug, parseCsv(csv).rows[1].slug], 'a stable handle from the Scraper slug');
  // RFC 4180 round trip of the written file.
  const back = parseCsv(csvOf(res));
  assert.deepEqual(back.rows.map((r) => r['Image Src']), [URLS.cloud1, URLS.shopify]);
  assert.deepEqual(back.rows.map((r) => r[col]), res.rows.map((r) => r[col]));
  assert.deepEqual(back.malformed, [], 'no column shift');
});

test('products.json (every image) → Shopify / Wix / BigCommerce: one image per row, in order, byte-identical; WooCommerce: a comma-safe list', () => {
  const json = JSON.stringify(products);
  const shop = convert(json, { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' });
  assert.equal(shop.ok, true);
  assert.deepEqual(shop.rows.map((r) => r['Image Src']).filter(Boolean), ALL, 'every address, in order, intact');
  assert.deepEqual(shop.rows.map((r) => r['Image Position']).filter(Boolean), ['1', '2', '3', '1', '2', '3']);
  assert.deepEqual(parseCsv(csvOf(shop)).rows.map((r) => r['Image Src']).filter(Boolean), ALL, 'read back identical');
  const wix = convert(json, { direction: 'eloshon-to-wix', expectPlatform: 'eloshon' });
  assert.equal(wix.ok, true);
  const mediaCol = wix.headers.find((h) => /^media$|productImageUrl/i.test(h));
  const media = wix.rows.map((r) => r[mediaCol]).filter(Boolean).flatMap((v) => splitUrlList(v, ';'));
  assert.deepEqual(media, ALL, 'Wix media rows, intact');
  const bc = convert(json, { direction: 'eloshon-to-bigcommerce', expectPlatform: 'eloshon' });
  assert.equal(bc.ok, true);
  assert.deepEqual(bc.rows.map((r) => r['Image URL (Import)']).filter(Boolean), ALL);
  const woo = convert(json, { direction: 'eloshon-to-woocommerce', expectPlatform: 'eloshon' });
  assert.equal(woo.ok, true);
  const cells = woo.rows.map((r) => r['Images']).filter(Boolean);
  assert.equal(cells.length, 2);
  for (const c of cells) assert.ok(!c.split(', ').some((u) => u.includes(',')), `a comma inside an address would split the Woo list: ${c}`);
  assert.deepEqual(cells.flatMap((c) => c.split(', ')).map((u) => u.replace(/%2C/g, ',')), ALL, 'the Woo list holds every address, its commas percent-encoded, nothing else changed');
  const wooCsv = csvOf(woo);
  assert.deepEqual(parseCsv(wooCsv).malformed, []);
  const reRead = convert(wooCsv, { direction: 'woocommerce-to-shopify', expectPlatform: 'woocommerce' });
  assert.equal(reRead.ok, true);
  assert.deepEqual(reRead.rows.map((r) => r['Image Src']).filter(Boolean).map((u) => u.replace(/%2C/g, ',')), ALL, 'a WooCommerce file written by the Converter reads back every address whole');
});

test('a wrapped Scraper CSV (each line re-saved as one quoted cell by a spreadsheet) still gives whole addresses', () => {
  const csv = toImportCsv(products);
  const [header, ...lines] = csv.replace(/^﻿/, '').split('\r\n').filter(Boolean);
  const wrapped = '﻿' + [header, ...lines.map((l) => `"${l.replace(/"/g, '""')}"`)].join('\r\n') + '\r\n';
  const res = convert(wrapped, { direction: 'eloshon-to-shopify', expectPlatform: 'eloshon' });
  assert.equal(res.ok, true);
  assert.ok(res.warnings.some((w) => /unwrapped|wrapped/.test(w.code)), 'the repair is reported');
  assert.deepEqual(res.rows.map((r) => r['Image Src']).filter(Boolean), [URLS.cloud1, URLS.shopify]);
  assert.equal(csvOf(res).split('\r\n')[1].includes(`"${URLS.cloud1}"`), true, 'quoted as one field on the way out');
});
