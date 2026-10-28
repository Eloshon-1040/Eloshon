import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipCreate, zipRead } from '../../scripts/lib/zip.mjs';

test('zip: round-trips names and content (deflate + store)', () => {
  const big = Buffer.from('x'.repeat(5000)); // compressible -> deflate
  const small = Buffer.from('{}');            // tiny -> stored
  const buf = zipCreate([
    { name: 'manifest.json', data: small },
    { name: 'background/service-worker.mjs', data: big },
  ]);
  const entries = zipRead(buf);
  const by = new Map(entries.map((e) => [e.name, e]));
  assert.ok(by.has('manifest.json'));
  assert.equal(by.get('manifest.json').data.toString(), '{}');
  assert.equal(by.get('background/service-worker.mjs').data.toString(), 'x'.repeat(5000));
});

test('zip: manifest.json sits at the archive root (no folder prefix)', () => {
  const buf = zipCreate([{ name: 'manifest.json', data: Buffer.from('{"manifest_version":3}') }]);
  const names = zipRead(buf).map((e) => e.name);
  assert.ok(names.includes('manifest.json'));
  assert.ok(!names.some((n) => n.endsWith('/manifest.json')));
});

test('zip: backslashes in names are normalized to forward slashes', () => {
  const buf = zipCreate([{ name: 'ui\\popup.mjs', data: Buffer.from('//') }]);
  assert.equal(zipRead(buf)[0].name, 'ui/popup.mjs');
});
