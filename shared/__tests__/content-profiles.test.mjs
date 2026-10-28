/**
 * Content types: the video acceptance rule is two-sided (accepted / to verify /
 * excluded), the product rule is untouched, and a type name is read in any spelling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateVideoEligibility, normalizeContentType, profileFor, CONTENT_PROFILES, SELECTABLE_CONTENT_TYPES } from '../content/profiles.mjs';
import { evaluateEligibility } from '../../core/eligibility/index.mjs';
import { toNormalizedProduct } from '../../core/normalize.mjs';

const video = (extra = {}) => toNormalizedProduct({ name: 'Conférence', description: 'Résumé.', images: ['https://cdn.v.test/1.jpg'], sourceUrl: 'https://v.test/w/1', canonicalUrl: 'https://v.test/w/1', sku: '1', columns: { duration: '12:34' }, strategy: 'video-jsonld', ...extra });

test('video rule: title + page address + (thumbnail or description) → accepted; thin → to verify; nothing → excluded', () => {
  assert.equal(evaluateVideoEligibility(video()).status, 'accepted');
  assert.equal(evaluateVideoEligibility(video()).code, 'accepted_video');
  assert.equal(evaluateVideoEligibility(video({ description: null })).status, 'accepted', 'a thumbnail alone is enough');
  assert.equal(evaluateVideoEligibility(video({ images: [] })).status, 'accepted', 'a description alone is enough');
  const thin = evaluateVideoEligibility(video({ images: [], description: null }));
  assert.equal(thin.status, 'to_verify'); assert.equal(thin.code, 'to_verify_video_thin');
  const noTitle = evaluateVideoEligibility(video({ name: '' }));
  assert.equal(noTitle.status, 'to_verify'); assert.equal(noTitle.code, 'to_verify_incomplete');
  const noUrl = evaluateVideoEligibility(video({ sourceUrl: null, canonicalUrl: null }));
  assert.equal(noUrl.status, 'to_verify'); assert.equal(noUrl.code, 'to_verify_incomplete');
  assert.equal(evaluateVideoEligibility(toNormalizedProduct({ images: ['https://cdn.v.test/x.jpg'] })).status, 'excluded');
  // A video has no price: the rule never asks for one.
  assert.equal(video().price, null);
});

test('e-commerce unchanged: the product rule still wants a name and a price; a video row through the product rule stays to verify', () => {
  assert.equal(evaluateEligibility(toNormalizedProduct({ name: 'Perceuse', price: 89, sourceUrl: 'https://shop.test/product/p1' })).status, 'accepted');
  assert.equal(evaluateEligibility(toNormalizedProduct({ name: 'Perceuse', sourceUrl: 'https://shop.test/product/p1' })).status, 'to_verify');
  assert.equal(evaluateEligibility(video()).status, 'to_verify', 'without a price the product rule does not accept a video');
});

test('type names and profiles', () => {
  assert.equal(normalizeContentType('Vidéos'), 'video'); assert.equal(normalizeContentType('video'), 'video'); assert.equal(normalizeContentType('Produits'), 'product');
  assert.equal(normalizeContentType('annonce'), 'listing'); assert.equal(normalizeContentType(''), 'auto'); assert.equal(normalizeContentType(undefined), 'auto'); assert.equal(normalizeContentType('whatever'), 'auto');
  assert.deepEqual([...SELECTABLE_CONTENT_TYPES], ['auto', 'product', 'video']);
  assert.equal(profileFor('video').engine, 'video'); assert.equal(profileFor('listing').engine, 'product'); assert.equal(profileFor('auto').id, 'product');
  assert.deepEqual([...CONTENT_PROFILES.video.extras], ['duration', 'views', 'published_at', 'embed_url', 'tags']);
  assert.equal(typeof CONTENT_PROFILES.video.eligibility, 'function');
});
