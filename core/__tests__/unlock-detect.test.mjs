/**
 * Item 8 — hard-unlock (Python/nodriver) DETECTION. The Settings panel showed
 * "Python + nodriver" red on a machine with a confirmed-working Python 3.14 +
 * nodriver 0.50.3. These cover the detection's pure, mockable parts: the enriched
 * selfcheck parser (Python-3.14-style version string), the actionable reason
 * builder (the two real causes), and the Windows candidate discovery (real name
 * is python.exe / "py", never "python3"). Pure + offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSelfcheck, buildUnlockReason, pythonCandidates } from '../unlock.mjs';

test('parseSelfcheck: enriched success carries Python + nodriver versions', () => {
  const r = parseSelfcheck('ok 3.14.6 nodriver=0.50.3\n', '');
  assert.equal(r.ok, true); assert.equal(r.python, '3.14.6'); assert.equal(r.nodriver, '0.50.3');
});
test('parseSelfcheck: legacy bare "ok" still passes', () => {
  const r = parseSelfcheck('ok\n', '');
  assert.equal(r.ok, true); assert.equal(r.python, null);
});
test('parseSelfcheck: import failure JSON on stderr → version + error, not ok', () => {
  const r = parseSelfcheck('', '{"error":"nodriver import failed: No module named \'nodriver\'","python":"3.14.6"}');
  assert.equal(r.ok, false); assert.equal(r.python, '3.14.6');
  assert.match(r.error, /No module named 'nodriver'/);
});
test('parseSelfcheck: non-JSON stderr is still surfaced as an error', () => {
  const r = parseSelfcheck('', 'Traceback (most recent call last): ImportError: bad marshal data');
  assert.equal(r.ok, false); assert.match(r.error, /ImportError/);
});

test('buildUnlockReason: nodriver not installed FOR the found interpreter (pip/python mismatch)', () => {
  const reason = buildUnlockReason([
    { cmd: 'C:\\Python314\\python.exe', pre: '', code: 3, python: '3.14.6', err: "nodriver import failed: No module named 'nodriver'" },
  ]);
  assert.match(reason, /Python 3\.14\.6/);
  assert.match(reason, /not installed FOR THIS interpreter/);
  assert.match(reason, /"C:\\Python314\\python\.exe" -m pip install nodriver/);
});
test('buildUnlockReason: import failed on a 3.14 interpreter → routes to the #35 guidance', () => {
  const reason = buildUnlockReason([
    { cmd: 'C:\\Python314\\python.exe', pre: '', code: 3, python: '3.14.6', err: 'nodriver import failed: cannot import name X from websockets' },
  ]);
  assert.match(reason, /issue #35/);
  assert.match(reason, /Python 3\.12 or 3\.13/);
});
test('buildUnlockReason: the confirmed Non-UTF-8/SyntaxError signature points to nodriver issue #35 + 3.12/3.13', () => {
  const reason = buildUnlockReason([
    { cmd: 'C:\\Python314\\python.exe', pre: '', code: 3, python: '3.14.6', err: "nodriver import failed: Non-UTF-8 code starting with '\\xe2' in file cdp.py on line 12, but no encoding declared; see PEP 263 (SyntaxError)" },
  ]);
  assert.match(reason, /GitHub issue #35/);
  assert.match(reason, /Python 3\.12 or 3\.13/);
  assert.match(reason, /py -3\.12 -m pip install nodriver/);
});
test('buildUnlockReason: a NON-3.14 import failure keeps the generic message (no false #35 claim)', () => {
  const reason = buildUnlockReason([
    { cmd: 'C:\\Python312\\python.exe', pre: '', code: 3, python: '3.12.4', err: 'nodriver import failed: DLL load failed while importing _cffi' },
  ]);
  assert.match(reason, /importing nodriver failed/);
  assert.doesNotMatch(reason, /issue #35/);
});
test('buildUnlockReason: no interpreter found → install guidance, no false import claim', () => {
  assert.match(buildUnlockReason([]), /no Python interpreter found/);
  assert.match(buildUnlockReason([{ cmd: 'python', pre: '', code: -1, python: null, err: 'spawn python ENOENT' }]), /no Python interpreter found/);
});

test('pythonCandidates (win): absolute C:\\Python314\\python.exe is tried FIRST, plus py/python', () => {
  const deps = {
    platform: 'win32', env: {},
    readdirSync: (base) => (base === 'C:\\' ? ['Windows', 'Python314', 'Users'] : []),
    existsSync: () => true,
  };
  const c = pythonCandidates({}, deps);
  assert.match(c[0].cmd, /Python314[\\/]python\.exe$/, 'the real absolute interpreter is first');
  assert.ok(c.some((x) => x.cmd === 'py' && x.pre[0] === '-3'), 'the py launcher is a candidate');
  assert.ok(c.some((x) => x.cmd === 'python'), 'python (the real Windows name) is a candidate');
});
test('pythonCandidates (win): Store-only PATH still yields py/python/python3, none duplicated', () => {
  const deps = { platform: 'win32', env: {}, readdirSync: () => [], existsSync: () => false };
  const c = pythonCandidates({}, deps);
  assert.deepEqual(c.map((x) => `${x.cmd} ${x.pre.join(' ')}`.trim()), ['py -3', 'python', 'python3']);
});
test('pythonCandidates: an explicit pythonPath wins first place', () => {
  const c = pythonCandidates({ pythonPath: 'C:\\Py\\python.exe' }, { platform: 'win32', env: {}, readdirSync: () => [], existsSync: () => false });
  assert.equal(c[0].cmd, 'C:\\Py\\python.exe');
});
