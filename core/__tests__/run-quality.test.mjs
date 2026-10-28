/**
 * Part 2 — post-run quality gate. measureRunQuality derives objective signals;
 * judgeRunQuality applies INJECTED thresholds (never hard-coded in the module).
 * The Colruyt failure (196 normalized, 0 accepted, empty names, listing-as-product)
 * must judge ok:false; a healthy run ok:true.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureRunQuality, judgeRunQuality } from '../run-quality.mjs';

// The thresholds under proposal (kept in the TEST, not the source, pending sign-off).
const PROPOSED = { minAcceptedRatio: 0.1, maxEmptyNameRatio: 0.3, maxEmptyPriceRatio: 0.5, maxEmptyImageRatio: 0.85, flagListingAsProduct: true, flagSeedsWithoutFiche: true };

test('Colruyt-shaped failure → ok:false with the right reasons', () => {
  const origin = 'https://www.colruyt.be/fr/produits?page=1';
  const products = [
    { name: 'Produits', source_url: 'https://www.colruyt.be/fr/produits', price: null, image_url: null, __eligibility: { status: 'to_verify' } },
    ...Array.from({ length: 195 }, (_, i) => ({ name: '', price: null, image_url: "data:image/svg+xml,%3Csvg viewBox='0 0 200 200'%3E", source_url: `https://www.colruyt.be/fr/produits/x${i}`, __eligibility: { status: 'to_verify' } })),
  ];
  const report = { origin, accepted: 0, fetched: 1 };
  const s = measureRunQuality(report, products);
  assert.equal(s.products, 196);
  assert.equal(s.accepted, 0);
  assert.ok(s.emptyNameRatio > 0.9, 'almost all names empty');
  assert.ok(s.emptyImageRatio > 0.9, 'placeholder SVGs count as empty images');
  assert.equal(s.listingPageAsProduct, true, 'the /produits listing page is among the rows');
  assert.equal(s.seedsWithoutFiche, true, '196 rows off a single fetched page');

  const v = judgeRunQuality(s, PROPOSED);
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes('low-accepted-ratio'));
  assert.ok(v.failures.includes('empty-names'));
  assert.ok(v.failures.includes('listing-page-as-product'));
  assert.ok(v.failures.includes('fiches-not-fetched'));
});

test('a healthy run → ok:true', () => {
  const products = Array.from({ length: 50 }, (_, i) => ({ name: `Produit ${i}`, price: 1 + i, image_url: 'https://img/' + i + '.jpg', source_url: 'https://s/p/' + i, __eligibility: { status: i < 45 ? 'accepted' : 'to_verify' } }));
  const report = { origin: 'https://s/c/all', accepted: 45, fetched: 50 };
  const s = measureRunQuality(report, products);
  assert.equal(s.accepted, 45);
  assert.ok(s.acceptedRatio >= 0.9);
  assert.equal(s.listingPageAsProduct, false);
  assert.equal(s.seedsWithoutFiche, false);
  assert.deepEqual(judgeRunQuality(s, PROPOSED), { ok: true, failures: [] });
});

test('empty product set is not judged (discovery outcome, handled elsewhere)', () => {
  assert.deepEqual(judgeRunQuality(measureRunQuality({ accepted: 0, fetched: 0 }, []), PROPOSED), { ok: true, failures: [] });
});
