/**
 * Native-host self-registration — makes the installer "just works" for end users
 * (no PowerShell, no admin, no system Node). Pure pieces + a mock-io end-to-end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  hostManifest, launcherScript, regAddArgs, regDeleteArgs, resolveHostMjs,
  ensureNativeHostRegistered, HOST_NAME, DEFAULT_EXTENSION_IDS, BROWSER_BASES,
} from '../native-host-register.mjs';

test('hostManifest: schema + allowed_origins (default dev id, plus config ids, deduped)', () => {
  const m = hostManifest('C:\\d\\host.bat', undefined);
  assert.equal(m.name, HOST_NAME);
  assert.equal(m.type, 'stdio');
  assert.equal(m.path, 'C:\\d\\host.bat');
  assert.deepEqual(m.allowed_origins, [`chrome-extension://${DEFAULT_EXTENSION_IDS[0]}/`]);
  const m2 = hostManifest('x', ['STOREID123', 'STOREID123']);
  assert.deepEqual(m2.allowed_origins, ['chrome-extension://STOREID123/'], 'config ids replace default, deduped');
});

test('launcherScript: runs host.mjs via the app Electron AS Node (no system node)', () => {
  const s = launcherScript('C:\\App\\Eloshon Scraper.exe', 'C:\\App\\resources\\app.asar.unpacked\\native-host\\host.mjs');
  assert.match(s, /set ELECTRON_RUN_AS_NODE=1/);
  assert.match(s, /"C:\\App\\Eloshon Scraper\.exe" "C:\\App\\resources\\app\.asar\.unpacked\\native-host\\host\.mjs" %\*/);
  assert.doesNotMatch(s, /^node /m, 'never depends on a system node');
});

test('regAddArgs/regDeleteArgs: HKCU only, reg.exe argv (no PowerShell)', () => {
  const a = regAddArgs(BROWSER_BASES.chrome, 'C:\\d\\m.json');
  assert.deepEqual(a, ['add', `HKCU\\${BROWSER_BASES.chrome}\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', 'C:\\d\\m.json', '/f']);
  assert.ok(a[1].startsWith('HKCU\\'), 'never HKLM / never admin');
  assert.deepEqual(regDeleteArgs(BROWSER_BASES.edge), ['delete', `HKCU\\${BROWSER_BASES.edge}\\${HOST_NAME}`, '/f']);
});

test('resolveHostMjs: packaged → app.asar.unpacked; dev → repo', () => {
  assert.equal(resolveHostMjs({ isPackaged: true, resourcesPath: 'C:\\App\\resources', repoRoot: 'X' }), path.join('C:\\App\\resources', 'app.asar.unpacked', 'native-host', 'host.mjs'));
  assert.equal(resolveHostMjs({ isPackaged: false, resourcesPath: 'X', repoRoot: 'C:\\repo' }), path.join('C:\\repo', 'native-host', 'host.mjs'));
});

function memFs() {
  const files = new Map();
  return {
    files,
    mkdirSync: () => {},
    readFileSync: (p) => { if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(p); },
    writeFileSync: (p, d) => { files.set(p, d); },
  };
}

test('ensureNativeHostRegistered: writes launcher + manifest and registers Chrome/Edge/Brave (no PowerShell)', async () => {
  const fs = memFs(); const calls = [];
  const execFile = (cmd, args, cb) => { calls.push({ cmd, args }); cb(null); };
  const r = await ensureNativeHostRegistered({ platform: 'win32', dataDir: 'C:\\data', hostMjsPath: 'C:\\App\\host.mjs', execPath: 'C:\\App\\e.exe', fs, execFile });
  assert.equal(r.ok, true);
  assert.deepEqual(r.registered, ['chrome', 'edge', 'brave']);
  const man = JSON.parse(fs.files.get(path.join('C:\\data', 'native-host', `${HOST_NAME}.json`)));
  assert.equal(man.path, path.join('C:\\data', 'native-host', 'host.bat'));
  assert.match(fs.files.get(path.join('C:\\data', 'native-host', 'host.bat')), /ELECTRON_RUN_AS_NODE=1/);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.cmd === 'reg' && c.args[0] === 'add'));
});

test('idempotent: a second run with nothing changed rewrites no file, still (re)asserts the keys', async () => {
  const fs = memFs(); let writes = 0;
  const origWrite = fs.writeFileSync; fs.writeFileSync = (p, d) => { writes++; origWrite(p, d); };
  const execFile = (cmd, args, cb) => cb(null);
  const io = { platform: 'win32', dataDir: 'C:\\data', hostMjsPath: 'C:\\App\\host.mjs', execPath: 'C:\\App\\e.exe', fs, execFile };
  await ensureNativeHostRegistered(io);
  const after1 = writes;
  await ensureNativeHostRegistered(io);
  assert.equal(writes, after1, 'no file rewritten when content is unchanged');
});

test('best-effort: non-Windows is a clean no-op; a reg.exe failure does not throw', async () => {
  assert.equal((await ensureNativeHostRegistered({ platform: 'darwin' })).reason, 'unsupported_platform');
  const fs = memFs();
  const execFile = (cmd, args, cb) => cb(Object.assign(new Error('denied'), { code: 1 }));
  const r = await ensureNativeHostRegistered({ platform: 'win32', dataDir: 'C:\\d', hostMjsPath: 'h', execPath: 'e', fs, execFile });
  assert.equal(r.ok, false, 'no browser registered, but no throw');
  assert.deepEqual(r.registered, []);
});
