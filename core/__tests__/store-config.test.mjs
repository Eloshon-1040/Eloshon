/**
 * Store-selection config (v0.5.5) — a recipe's business values that depend on a
 * USER choice (which store's prices, which region/market) must be user-configurable
 * via config.json `siteContext[<host>]`, never hardcoded in the recipe. This pins
 * the generic `config` var source and the Colruyt placeId (store) it powers.
 *
 * Colruyt's [USER DECISION — RESOLVED]: prices are store-dependent, so placeId is
 * read from config (default 604 = Colruyt Halle), selectable without touching code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveVars, replayInternalApi } from '../internal-api.mjs';

const colruyt = JSON.parse(fs.readFileSync(new URL('../recipes/colruyt-be.json', import.meta.url), 'utf8'));
const noFetch = { httpGet: async () => { throw new Error('config/url vars must not fetch'); } };

test('config var source: reads from siteConfig by key, falls back to default, honours optional', async () => {
  const recipe = { vars: {
    store: { source: 'config', key: 'placeId', default: '604' },
    region: { source: 'config', key: 'region', optional: true }, // optional, unset
  } };
  // User set placeId → wins over default; region unset+optional → absent (no error).
  const a = await resolveVars(recipe, 'https://x/y', { ...noFetch, siteConfig: { placeId: '999' } });
  assert.equal(a.error, null);
  assert.equal(a.vars.store, '999');
  assert.equal(a.vars.region, undefined);          // optional + unset → left out, no error
  // A blank/whitespace config value is treated as unset → falls back to default.
  const b = await resolveVars(recipe, 'https://x/y', { ...noFetch, siteConfig: { placeId: '   ' } });
  assert.equal(b.vars.store, '604');
});

test('config var source: default applies when the user has not configured the site', async () => {
  const recipe = { vars: { store: { source: 'config', key: 'placeId', default: '604' } } };
  const a = await resolveVars(recipe, 'https://x/y', { ...noFetch, siteConfig: {} });
  assert.equal(a.error, null);
  assert.equal(a.vars.store, '604');               // default
  const b = await resolveVars(recipe, 'https://x/y', noFetch); // no siteConfig at all
  assert.equal(b.vars.store, '604');
});

test('config var source: required var with no value and no default is a clean error, not a guess', async () => {
  const recipe = { vars: { market: { source: 'config', key: 'market' } } };
  const r = await resolveVars(recipe, 'https://x/y', { ...noFetch, siteConfig: {} });
  assert.match(r.error, /market/);
  assert.match(r.error, /no config value/);
});

test('config var flows into the built endpoint URL (placeId placeholder is filled)', async () => {
  const urls = [];
  const recipe = {
    endpoint_tpl: 'https://api/x?placeId={placeId}&size={size}&skip={skip}',
    pagination: { type: 'offset', param: 'skip', size_param: 'size', size: 5, total_json_path: 'total' },
    json_path: 'products', field_map: { name: 'n' },
  };
  const httpGet = async (url) => { urls.push(url); return { status: 200, body: { total: 1, products: [{ n: 'a' }] } }; };
  await replayInternalApi(recipe, { httpGet, vars: { placeId: '777' } });
  assert.match(urls[0], /placeId=777/);
});

test('colruyt recipe: placeId is a config var (store), no hardcoded 604 in the endpoint', async () => {
  // The endpoint template must carry the {placeId} placeholder, not a literal store.
  assert.match(colruyt.endpoint_tpl, /placeId=\{placeId\}/);
  assert.doesNotMatch(colruyt.endpoint_tpl, /placeId=604/);
  assert.equal(colruyt.vars.placeId.source, 'config');
  assert.equal(colruyt.vars.placeId.key, 'placeId');
  assert.equal(colruyt.vars.placeId.default, '604');

  // resolveVars on the real recipe: placeId comes from config; a configured store wins.
  // v0.5.9: categoryId is read from the category page itself (free HTTP, offline
  // fixture here) — the last id of its data-model-url — never from a stale static map.
  const url = 'https://www.colruyt.be/fr/produits/toutes-les-categories/boissons/eau';
  const pageGet = { httpGet: async (u, { as } = {}) => {
    assert.equal(u, url, 'the category id is read from the category page itself');
    assert.equal(as, 'text');
    return { status: 200, body: '<div data-model-url="/content/clp/fr/producten/alle-categorieen/354/379/jcr:content/root"></div>' };
  } };
  const cfg = await resolveVars(colruyt, url, { ...pageGet, siteConfig: { placeId: '1234' } });
  assert.equal(cfg.error, null);
  assert.equal(cfg.vars.placeId, '1234');
  assert.equal(cfg.vars.categoryId, '379');        // eau (child of boissons 354)
  assert.equal(cfg.needsBrowser, false);           // no browser trigger var anymore (the old _session hack is gone)
  const def = await resolveVars(colruyt, url, pageGet);
  assert.equal(def.vars.placeId, '604');           // default store when unconfigured
});
