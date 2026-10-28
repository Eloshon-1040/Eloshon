/**
 * Product-page completion: how many product pages a job may visit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detailVisitCap } from '../detail-enrich.mjs';
import { loadConfig } from '../config.mjs';

test('visit cap: as many product pages as listed products; an explicit positive maxPerJob caps lower', () => {
  assert.equal(detailVisitCap({ maxPerJob: null }, 300), 300, 'default: every listed product (was capped at 200)');
  assert.equal(detailVisitCap({}, 1000), 1000);
  assert.equal(detailVisitCap(null, 42), 42);
  assert.equal(detailVisitCap({ maxPerJob: 150 }, 300), 150);
  assert.equal(detailVisitCap({ maxPerJob: 500 }, 300), 300);
  assert.equal(detailVisitCap({ maxPerJob: 0 }, 300), 300, '0 / invalid = no extra cap');
  assert.equal(detailVisitCap({ maxPerJob: 'x' }, 300), 300);
});

test('default configuration: no own cap on product pages', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.detailPages.enabled, true);
  assert.equal(cfg.detailPages.maxPerJob, null);
  assert.equal(detailVisitCap(cfg.detailPages, 1000), 1000);
});

test('a row without name / price gets them from the product page structured data; a listed value is never replaced', async () => {
  const { enrichFromDetailPages } = await import('../detail-enrich.mjs');
  const ld = (name, price) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name, sku: 'S1', description: 'Une description réelle et assez longue du produit.', offers: { '@type': 'Offer', price, priceCurrency: 'EUR' } })}</script></head><body></body></html>`;
  const pages = { 'https://s.test/pd/a': ld('Sneakers A', '89.95'), 'https://s.test/pd/b': ld('Sneakers B', '59.95') };
  const rows = [{ sourceUrl: 'https://s.test/pd/a' }, { sourceUrl: 'https://s.test/pd/b', name: 'Listed B', price: 49.95 }];
  const rep = await enrichFromDetailPages(rows, { fetchHtml: async (u) => ({ ok: !!pages[u], html: pages[u], status: pages[u] ? 200 : 404 }), maxVisits: 10 });
  assert.equal(rows[0].name, 'Sneakers A'); assert.equal(rows[0].price, 89.95); assert.equal(rows[0].currency, 'EUR');
  assert.equal(rows[1].name, 'Listed B'); assert.equal(rows[1].price, 49.95, 'never replaced');
  assert.equal(rep.completed, 2);
});
