/**
 * HARD-UNLOCK layer (optional, escalation-only) — the Node side of the Python
 * nodriver sidecar (core/unlock/unlock.py). nodriver drives REAL Chrome over CDP
 * without the automation signals Playwright exposes, so it passes anti-bot walls
 * (Cloudflare Turnstile) that headless Playwright cannot — verified on
 * microfluo.net. This is the LAST tier of the ladder: HTTP → Playwright →
 * hard-unlock, used ONLY when a terminal Cloudflare/anti-bot block is hit.
 *
 * It is OPT-IN and degrades gracefully: if Python / nodriver / Chrome are not
 * present, `available()` is false and the engine simply reports the block (as
 * today). Nothing here is bundled into the EXE yet — see the distribution note
 * in the report. No CAPTCHA solving; a real browser loading a public page.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

// Path to the Python sidecar. In a packaged Electron app this module lives INSIDE
// app.asar, but Python cannot open a file inside the asar archive — the sidecar is
// unpacked (electron-builder asarUnpack: "core/unlock/**") to app.asar.unpacked/…,
// so rewrite the path accordingly. In dev there is no app.asar and the path is
// used as-is. Never a machine-specific absolute path.
const SIDECAR = fileURLToPath(new URL('./unlock/unlock.py', import.meta.url)).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

function firstExisting(paths) { for (const p of paths) { try { if (p && fs.existsSync(p)) return p; } catch { /* ignore */ } } return null; }

/** Resolve a REAL Chrome (preferred) or the bundled full Chromium for nodriver. */
export function resolveChrome(opts = {}) {
  if (opts.chromePath && fs.existsSync(opts.chromePath)) return opts.chromePath;
  const sys = firstExisting([
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
  ]);
  if (sys) return sys;
  // Fallback: the bundled Playwright full Chromium (chrome.exe, not headless_shell).
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base) { try {
    const dir = fs.readdirSync(base).find((d) => d.startsWith('chromium-') && !d.includes('headless'));
    if (dir) return firstExisting([path.join(base, dir, 'chrome-win64', 'chrome.exe'), path.join(base, dir, 'chrome-linux', 'chrome'), path.join(base, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')]);
  } catch { /* ignore */ } }
  return null;
}

/**
 * Environment for the Python child. nodriver is typically a PER-USER pip install
 * (`pip install --user`), living under %APPDATA%\Python\PythonXY\site-packages,
 * which the interpreter only sees when APPDATA resolves to the real user profile.
 * A GUI (Explorer) launch can hand the app — and thus a spawned child — an env
 * WITHOUT a usable APPDATA; the per-user site then disappears and an installed
 * nodriver looks absent, so probing falls through to the Microsoft Store stub.
 * (Proven: unsetting APPDATA reproduces the exact "install from the Store" error.)
 * Guarantee APPDATA (compute it from USERPROFILE when missing) and never let an
 * inherited PYTHONNOUSERSITE hide the per-user install. Copies process.env, so the
 * parent's own env is left untouched (diagnostics still read the RAW values).
 */
function childEnv() {
  const env = { ...process.env };
  if (process.platform === 'win32') {
    if ((!env.APPDATA || !env.APPDATA.trim()) && env.USERPROFILE) env.APPDATA = path.join(env.USERPROFILE, 'AppData', 'Roaming');
    if (env.PYTHONNOUSERSITE) delete env.PYTHONNOUSERSITE;
  }
  return env;
}

function run(cmd, pre, sidecarArgs, { timeoutMs = 90000, maxBytes = 32 * 1024 * 1024, onLine } = {}) {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawn(cmd, [...pre, SIDECAR, ...sidecarArgs], { windowsHide: true, env: childEnv() }); }
    catch (e) { return resolve({ code: -1, out: '', err: String(e) }); }
    let out = ''; let err = ''; let killed = false; let buf = '';
    const timer = setTimeout(() => { killed = true; try { proc.kill(); } catch { /* ignore */ } }, timeoutMs);
    proc.stdout.on('data', (d) => { out += d; if (out.length > maxBytes) { try { proc.kill(); } catch { /* ignore */ } } });
    proc.stderr.on('data', (d) => {
      err += d;
      if (onLine) { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onLine(line); } }
    });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err || String(e) }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code: killed ? -2 : code, out, err }); });
  });
}

/**
 * Python interpreters to try, ABSOLUTE paths first so we don't depend on the
 * ambient PATH — which differs between a shell launch and a GUI (Explorer) launch,
 * and can resolve the Microsoft Store stub instead of a real Python. This is why
 * the sidecar could look available from a terminal but not from the installed app.
 */
export function pythonCandidates(opts = {}, deps = {}) {
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const readdirSync = deps.readdirSync || fs.readdirSync;
  const existsSync = deps.existsSync || fs.existsSync;
  const out = [];
  const add = (cmd, pre = []) => { if (cmd) out.push({ cmd, pre }); };
  if (opts.pythonPath) add(opts.pythonPath);
  if (platform === 'win32') {
    const roots = ['C:\\', env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'Python') : null,
      env.ProgramFiles ? path.join(env.ProgramFiles) : null];
    for (const base of roots) {
      if (!base) continue;
      // NOTE: "python3" is NOT a real Windows executable name — the interpreter is
      // "python.exe"; the launcher is "py". We still list python3 last as a
      // best-effort, but a real install is found via the absolute C:\Python3NN scan
      // or "py -3"/"python" above it.
      try { for (const d of readdirSync(base)) { if (/^Python3\d+$/i.test(d)) { const p = path.join(base, d, 'python.exe'); if (existsSync(p)) add(p); } } } catch { /* ignore */ }
    }
    add('py', ['-3']); add('python'); add('python3');
  } else {
    for (const p of ['/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3']) if (existsSync(p)) add(p);
    add('python3'); add('python');
  }
  const seen = new Set();
  return out.filter((x) => { const k = `${x.cmd}|${x.pre.join(' ')}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * Parse the sidecar `--selfcheck` output into a structured result. Success prints
 * `ok <pyVersion> nodriver=<v>` on stdout (older builds print a bare `ok`); a
 * failure prints `{"error":…,"python":…}` on stderr. Pure — exported for tests.
 * @returns {{ ok:boolean, python:string|null, nodriver:string|null, error:string|null }}
 */
export function parseSelfcheck(out = '', err = '') {
  const res = { ok: false, python: null, nodriver: null, error: null };
  const m = /(?:^|\s)ok\s+(\d+\.\d+\.\d+)(?:\s+nodriver=(\S+))?/.exec(out || '');
  if (m) { res.ok = true; res.python = m[1]; res.nodriver = m[2] || null; return res; }
  if (/(^|\s)ok(\s|$)/.test(out || '')) { res.ok = true; return res; }   // legacy bare "ok"
  try { const j = JSON.parse(String(err || '').trim()); if (j && j.error) { res.error = String(j.error); if (j.python) res.python = String(j.python); } } catch { /* not JSON */ }
  if (!res.error && err) res.error = String(err).slice(0, 200).replace(/\s+/g, ' ').trim();
  return res;
}

/**
 * Build a human, ACTIONABLE reason from the per-candidate probe results — so a red
 * X in Settings explains itself instead of hiding the cause. Distinguishes: no
 * interpreter at all; an interpreter found but nodriver not installed FOR IT (the
 * classic pip/python mismatch); and an interpreter where importing nodriver threw
 * (e.g. a too-new Python 3.14 nodriver can't import yet). Pure — exported for tests.
 */
export function buildUnlockReason(tried = []) {
  const ran = tried.filter((t) => t && (t.python || t.code === 3 || /nodriver/i.test(t.err || '')));
  if (!ran.length) return 'no Python interpreter found (install Python 3.12 or 3.13, then: pip install nodriver)';
  const t = ran.find((x) => x.python) || ran[0];
  const ver = t.python ? `Python ${t.python}` : 'Python';
  const err = t.err || '';
  const notInstalled = /no module named ['"]?nodriver/i.test(err);
  if (notInstalled) return `${ver} found (${t.cmd}) but nodriver is not installed FOR THIS interpreter — install it with:  "${t.cmd}" -m pip install nodriver`;
  // Confirmed real-world case: on Python 3.14 nodriver fails to import with a
  // "Non-UTF-8 code" / SyntaxError (nodriver GitHub issue #35). Detect that
  // signature (or a 3.14+ interpreter, the first affected) and recommend 3.12/3.13
  // directly rather than leaving a raw traceback the user can't act on.
  const py314Incompat = /non-utf-8 code|syntaxerror|invalid syntax/i.test(err) || (t.python && Number(t.python.split('.')[1]) >= 14);
  if (py314Incompat) return `${ver} found (${t.cmd}) but nodriver can't be imported on Python 3.14 (known nodriver incompatibility, GitHub issue #35). Install Python 3.12 or 3.13 alongside it, then:  py -3.12 -m pip install nodriver`;
  return `${ver} found (${t.cmd}) but importing nodriver failed: ${err || 'unknown error'}`;
}

let _avail = null; // cached { ok, cmd, pre, chrome, reason, tried, env, sidecar }

/** RAW (un-guarded) snapshot of the env that decides whether the per-user site is
 *  visible — the exact values the CURRENT process inherited from its launcher. */
function envSnapshot() {
  const e = process.env;
  const v = (x) => (x == null ? null : String(x));
  return {
    APPDATA: v(e.APPDATA), LOCALAPPDATA: v(e.LOCALAPPDATA), USERPROFILE: v(e.USERPROFILE),
    PYTHONNOUSERSITE: v(e.PYTHONNOUSERSITE), PYTHONPATH: v(e.PYTHONPATH), PYTHONHOME: v(e.PYTHONHOME),
    pathHasWindowsApps: /WindowsApps/i.test(e.PATH || e.Path || ''),
  };
}

/** Is the hard-unlock layer usable here? Probes Python candidates. Cached. Never throws. */
export async function unlockAvailable(opts = {}) {
  if (_avail && !opts.recheck) return _avail;
  const chrome = resolveChrome(opts);
  const tried = [];
  const env = envSnapshot();
  if (!chrome) { _avail = { ok: false, reason: 'no Chrome/Chromium found', tried, env, sidecar: SIDECAR }; return _avail; }
  for (const cand of pythonCandidates(opts)) {
    const r = await run(cand.cmd, cand.pre, ['--selfcheck'], { timeoutMs: 20000 });
    const sc = parseSelfcheck(r.out, r.err);
    const ok = r.code === 0 && sc.ok;
    // Per-candidate diagnostic (also written to unlock-diag.json): which interpreter,
    // its Python version, and the REAL import error — so the failure is legible.
    tried.push({ cmd: cand.cmd, pre: cand.pre.join(' '), code: r.code, ok, python: sc.python || null, nodriver: sc.nodriver || null, err: (sc.error || r.err || '').slice(0, 160).replace(/\s+/g, ' ').trim() });
    if (ok) { _avail = { ok: true, cmd: cand.cmd, pre: cand.pre, chrome, python: [cand.cmd, ...cand.pre].join(' '), pythonVersion: sc.python || null, nodriverVersion: sc.nodriver || null, tried, env, sidecar: SIDECAR }; return _avail; }
  }
  _avail = { ok: false, reason: buildUnlockReason(tried), tried, env, sidecar: SIDECAR };
  return _avail;
}

/**
 * Render a URL through the hard-unlock sidecar. Returns rendered HTML or an error.
 * @returns {Promise<{ html:string|null, error:string|null }>}
 */
export async function unlockRender(url, opts = {}) {
  const a = await unlockAvailable(opts);
  if (!a.ok) { if (opts.trace) opts.trace(`unlock.mjs: capability NOT ready — ${a.reason}`); return { html: null, error: a.reason }; }
  if (opts.trace) { opts.trace(`unlock.mjs started`); opts.trace(`python = ${[a.cmd, ...a.pre].join(' ')}`); opts.trace(`Chrome = ${a.chrome}`); }
  const args = ['--url', url, '--timeout', String(Math.round((opts.timeoutMs ?? 60000) / 1000)), '--chrome', a.chrome];
  if (opts.headless) args.push('--headless');
  const r = await run(a.cmd, a.pre, args, { timeoutMs: (opts.timeoutMs ?? 60000) + 20000, onLine: opts.trace ? (l) => opts.trace(l.replace(/^\[UNLOCK\]\s*/, '')) : undefined });
  if (r.code === 0 && r.out && r.out.length > 500) return { html: r.out, error: null };
  let msg = `unlock failed (exit ${r.code})`;
  try { const j = JSON.parse((r.err || '').trim()); if (j.error) msg = j.error; } catch { if (r.err) msg = r.err.slice(0, 200); }
  return { html: null, error: msg };
}
