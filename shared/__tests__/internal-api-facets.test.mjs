/**
 * Internal-API recipe: a var may try several SOURCES in order (first non-empty wins),
 * and the engine flags a URL FACET filter the recipe does not read — so a filtered
 * listing (?categories=412 = spirits only) is never silently served as its whole
 * parent category (water + sodas). Generic, driven by the recipe's own vars. Offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVars, unconsumedFacets } from '../internal-api.mjs';

// A recipe that reads a category id from the URL facet first, else from the page.
const recipe = {
  endpoint_tpl: 'https://api.test/search?cat={categoryId}&skip={skip}&size={size}',
  static_headers: { Accept: 'application/json' },
  vars: {
    categoryId: { sources: [
      { source: 'url', pattern: '[?&]categories=(\\d+)', optional: true },
      { source: 'page', pattern: 'model/(\\d+)/jcr' },
    ] },
    placeId: { source: 'config', key: 'placeId', default: '604' },
  },
  pagination: { type: 'offset', param: 'skip', size_param: 'size', size: 22, start: 0 },
  json_path: 'products', field_map: { name: 'name' },
};
const pageGet = async () => ({ status: 200, body: '<a data-url="/x/model/8020/jcr:content">x</a>' });

test('ordered sources: the URL facet wins when present, the page is the fallback otherwise', async () => {
  const filtered = await resolveVars(recipe, 'https://s.test/boissons?categories=412&page=8', { httpGet: pageGet });
  assert.equal(filtered.error, null);
  assert.equal(filtered.vars.categoryId, '412');     // honours the filter from the URL
  assert.equal(filtered.vars.placeId, '604');
  const plain = await resolveVars(recipe, 'https://s.test/boissons', { httpGet: pageGet });
  assert.equal(plain.vars.categoryId, '8020');       // no facet → read from the page model
});

test('a config var still falls back to its default, and a user value overrides it', async () => {
  const d = await resolveVars(recipe, 'https://s.test/x?categories=1', { httpGet: pageGet, siteConfig: {} });
  assert.equal(d.vars.placeId, '604');
  const u = await resolveVars(recipe, 'https://s.test/x?categories=1', { httpGet: pageGet, siteConfig: { placeId: '902' } });
  assert.equal(u.vars.placeId, '902');
});

test('unconsumedFacets: a facet the recipe reads is not flagged; one it ignores is', () => {
  // This recipe reads `categories` (a url var) → not flagged.
  assert.deepEqual(unconsumedFacets(recipe, 'https://s.test/x?categories=412&page=8'), []);
  // Pagination / sort / locale / tracking are never facets.
  assert.deepEqual(unconsumedFacets(recipe, 'https://s.test/x?page=2&sort=price&utm_source=ad&lang=fr'), []);
  // A brand facet the recipe does NOT read → flagged (the lane would widen the result).
  assert.deepEqual(unconsumedFacets(recipe, 'https://s.test/x?brand=coca&categories=412'), [{ key: 'brand', value: 'coca' }]);
  // A recipe with no url var at all → any real facet is unconsumed.
  const noUrl = { vars: { placeId: { source: 'config', key: 'placeId', default: '1' } } };
  assert.deepEqual(unconsumedFacets(noUrl, 'https://s.test/x?categories=412'), [{ key: 'categories', value: '412' }]);
  assert.deepEqual(unconsumedFacets(noUrl, 'https://s.test/x'), []);
});
