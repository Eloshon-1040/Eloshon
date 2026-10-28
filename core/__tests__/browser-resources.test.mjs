/**
 * Increment 2 — headless renders block heavy sub-resources (image/media/font)
 * for speed, but never in headful/intervention mode (a human must see a normal
 * page) and never for content-bearing requests (document/script/xhr/fetch/css).
 * Pure decision logic; the Playwright wiring uses these exports at runtime.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldBlockResources, BLOCKED_RESOURCE_TYPES, LISTING_BLOCKED_RESOURCE_TYPES } from '../browser.mjs';

test('block by default in headless mode', () => {
  assert.equal(shouldBlockResources({}), true);
  assert.equal(shouldBlockResources({ headless: true }), true);
});

test('never block in headful / intervention mode (page must look normal)', () => {
  assert.equal(shouldBlockResources({ headless: false }), false);
});

test('respect explicit opt-out', () => {
  assert.equal(shouldBlockResources({ disableResources: false }), false);
  assert.equal(shouldBlockResources({ headless: true, disableResources: false }), false);
});

test('only heavy sub-resources are blocked; content requests are allowed', () => {
  for (const t of ['image', 'media', 'font']) assert.ok(BLOCKED_RESOURCE_TYPES.has(t), `${t} blocked`);
  for (const t of ['document', 'script', 'xhr', 'fetch', 'stylesheet']) assert.ok(!BLOCKED_RESOURCE_TYPES.has(t), `${t} allowed`);
});

test('listing collection allows images (card gate needs real sizes); media/font stay blocked', () => {
  assert.ok(!LISTING_BLOCKED_RESOURCE_TYPES.has('image'), 'image allowed on listings');
  for (const t of ['media', 'font']) assert.ok(LISTING_BLOCKED_RESOURCE_TYPES.has(t), `${t} blocked`);
  assert.ok(BLOCKED_RESOURCE_TYPES.has('image'), 'fiche renders keep blocking images');
});
