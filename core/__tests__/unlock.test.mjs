/**
 * Hard-unlock layer (Python nodriver sidecar) — Node side. The LIVE render is
 * validated manually + by the guarded benchmark (nodriver passes Cloudflare on
 * microfluo.net → 24 cards). Here we assert the layer is SAFE and OPT-IN: it
 * never throws and always returns a well-formed result, whether or not Python/
 * nodriver/Chrome are present — this is what guarantees default builds are
 * unaffected. (Actual availability is machine-dependent — Python-candidate
 * probing may find a real interpreter — so we assert shape, not a fixed value.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlockAvailable, unlockRender, resolveChrome } from '../unlock.mjs';

test('unlock: unlockAvailable never throws and returns a boolean ok', async () => {
  const a = await unlockAvailable({ pythonPath: 'definitely-not-a-python-binary-xyz', recheck: true });
  assert.equal(typeof a.ok, 'boolean');
  if (!a.ok) assert.ok(typeof a.reason === 'string' && a.reason.length > 0);
});

test('unlock: unlockRender is exported and callable (live render covered by the guarded benchmark)', () => {
  assert.equal(typeof unlockRender, 'function');
});

test('unlock: resolveChrome never throws (returns a path or null)', () => {
  const c = resolveChrome({});
  assert.ok(c === null || typeof c === 'string');
});
