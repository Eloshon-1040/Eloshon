/**
 * Domain-profile keys: an address typed without a scheme must key on its host
 * (it used to key on the whole address, so the profile was never found again),
 * and a file holding such keys is repaired by the app when it loads it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostKey, migrateProfileKeys, createProfileStore } from '../domain-profile.mjs';

test('hostKey: with or without scheme, path, query or www → the bare host', () => {
  assert.equal(hostKey('https://www.shop.example/fr/c?q=1'), 'shop.example');
  assert.equal(hostKey('shop.example/fr/shop/boissons/c/v2dri?q=%3arelevance'), 'shop.example');
  assert.equal(hostKey('WWW.Shop.Example'), 'shop.example');
  assert.equal(hostKey(''), '');
});

test('migrateProfileKeys: a whole-address key is re-keyed to its host; on a collision the most recent profile wins', () => {
  const { map, changed } = migrateProfileKeys({
    'shop.example/fr/c?q=x': { runs: 2, updatedAt: '2026-09-27T00:00:00Z' },
    'other.example': { runs: 5, updatedAt: '2026-10-01T00:00:00Z' },
    'other.example/p/1': { runs: 1, updatedAt: '2026-09-01T00:00:00Z' },
  });
  assert.equal(changed, true);
  assert.deepEqual(Object.keys(map).sort(), ['other.example', 'shop.example']);
  assert.equal(map['shop.example'].runs, 2);
  assert.equal(map['other.example'].runs, 5, 'the newer, correctly keyed profile is kept');
  assert.equal(migrateProfileKeys({ 'a.example': {} }).changed, false, 'a clean file is left untouched');
});

test('profile store: a malformed file is repaired and written back on load; lookups by URL find it', () => {
  let disk = { 'shop.example/fr/c?q=x': { method: 'browser', runs: 2, updatedAt: '2026-09-27T00:00:00Z' } };
  let writes = 0;
  const store = createProfileStore({ read: () => JSON.parse(JSON.stringify(disk)), write: (m) => { writes++; disk = JSON.parse(JSON.stringify(m)); } });
  assert.equal(store.get('https://www.shop.example/fr/c').method, 'browser');
  assert.equal(writes, 1);
  assert.deepEqual(Object.keys(disk), ['shop.example']);
});
