import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecureStore } from '../admin/secure-store.mjs';

const FAKE = 'FAKE_KEY_FOR_TESTS';

// Fake safeStorage: reversible "encryption" for tests (obviously not real crypto).
function fakeIo({ available = true } = {}) {
  let blob = null;
  const captured = [];
  return {
    safeStorage: {
      isEncryptionAvailable: () => available,
      encryptString: (s) => Buffer.from('ENC::' + s, 'utf8'),
      decryptString: (b) => Buffer.from(b).toString('utf8').replace(/^ENC::/, ''),
    },
    readBlob: () => blob,
    writeBlob: (b64) => { blob = b64; },
    deleteBlob: () => { blob = null; },
    log: (m) => captured.push(m),
    _blob: () => blob,
    _log: captured,
  };
}

test('set/has/getAll round-trip; blob is not plaintext', () => {
  const io = fakeIo();
  const s = new SecureStore(io);
  assert.equal(s.setFields('firecrawl', { apiKey: FAKE }).ok, true);
  assert.equal(s.has('firecrawl'), true);
  assert.equal(s.getAll().firecrawl.apiKey, FAKE);
  // the stored blob is base64 of ENC:: — decodes but is not a bare plaintext key at rest in b64 of raw
  assert.ok(!io._blob().includes(FAKE));
});

test('replace overwrites; empty value deletes the field', () => {
  const io = fakeIo(); const s = new SecureStore(io);
  s.setFields('zyte', { apiKey: 'OLD' });
  s.setFields('zyte', { apiKey: FAKE });
  assert.equal(s.getAll().zyte.apiKey, FAKE);
  s.setFields('zyte', { apiKey: '' }); // clears
  assert.equal(s.has('zyte'), false);
});

test('deleteField removes one field or the whole provider', () => {
  const io = fakeIo(); const s = new SecureStore(io);
  s.setFields('brightData.webUnlocker', { apiKey: FAKE, zone: 'z' });
  s.deleteField('brightData.webUnlocker', 'zone');
  assert.equal(s.getAll()['brightData.webUnlocker'].zone, undefined);
  assert.equal(s.getAll()['brightData.webUnlocker'].apiKey, FAKE);
  s.deleteField('brightData.webUnlocker');
  assert.equal(s.has('brightData.webUnlocker'), false);
});

test('importValues writes many and returns a field count (no values)', () => {
  const io = fakeIo(); const s = new SecureStore(io);
  const r = s.importValues({ firecrawl: { apiKey: FAKE }, zyte: { apiKey: FAKE } });
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.ok(!JSON.stringify(r).includes(FAKE));
});

test('unavailable safeStorage refuses to store with a clear French message', () => {
  const io = fakeIo({ available: false });
  const s = new SecureStore(io);
  const r = s.setFields('firecrawl', { apiKey: FAKE });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'safe_storage_unavailable');
  assert.match(r.message, /indisponible/);
  assert.equal(s.has('firecrawl'), false);
  assert.deepEqual(s.getAll(), {});
});

test('wipe clears the blob', () => {
  const io = fakeIo(); const s = new SecureStore(io);
  s.setFields('firecrawl', { apiKey: FAKE });
  s.wipe();
  assert.equal(io._blob(), null);
  assert.equal(s.has('firecrawl'), false);
});

test('logger is never given a secret value', () => {
  const io = fakeIo(); const s = new SecureStore(io);
  s.setFields('firecrawl', { apiKey: FAKE });
  s.deleteField('firecrawl');
  assert.ok(!io._log.join('|').includes(FAKE));
});
