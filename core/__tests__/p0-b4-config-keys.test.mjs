/**
 * P0 / B4 — every documented engine setting of the app's config.json reaches the
 * engine. The controller forwarded a hand-written subset: `quality`,
 * `weightEstimate`, `renderTimeoutMs`, `breaker`, `csrFewThreshold`… written in
 * config.json were silently ignored (and a resume dropped `sideData` and
 * `browserPageGapMs`). The forwarded set is now DERIVED from the engine defaults
 * (core/config.mjs DEFAULTS), checked key by key here, for a launch and a resume.
 * Temp folders, mock fetcher, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController, ENGINE_CONFIG_KEYS, jobConfigOverrides } from '../../app/controller.mjs';
import { DEFAULTS } from '../config.mjs';

/** A distinctive, valid value of the same kind as the default (never the default). */
function distinct(key, def) {
  if (def === null) return 12345; // a "derived when absent" number
  if (typeof def === 'number') return def + 7;
  if (typeof def === 'boolean') return !def;
  if (def && typeof def === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(def)) out[k] = typeof v === 'number' ? v + 3 : typeof v === 'boolean' ? !v : v === null ? 9 : v;
    return out;
  }
  return def;
}

class Mock { constructor() { this.stats = { requests: 0, ok: 0, failed: 0, blocked: 0, bytes: 0 }; this.userAgent = 't'; } async get(u) { return { ok: false, status: 404, url: u, requestedUrl: u, contentType: 'text/html', kind: 'html', body: '', headers: {}, error: 'HTTP 404', blocked: false }; } async getText(u) { return this.get(u); } }

test('the forwarded keys are the engine defaults (minus the per-launch ones)', () => {
  const expected = Object.keys(DEFAULTS).filter((k) => !['outputDir', 'browser'].includes(k)).sort();
  assert.deepEqual([...ENGINE_CONFIG_KEYS].sort(), expected);
});

test('every engine key written in config.json reaches the job config — launch and resume', { timeout: 20000 }, async () => {
  const dirs = ensureDirs(appDirs(fs.mkdtempSync(path.join(os.tmpdir(), 'eloshon-b4-'))));
  const saved = {};
  for (const k of ENGINE_CONFIG_KEYS) saved[k] = distinct(k, DEFAULTS[k]);
  saved.maxProducts = 3; saved.workers = 1; saved.recovery = false; // keep the run small
  fs.writeFileSync(dirs.configFile, JSON.stringify({ lang: 'fr', ...saved }));
  const seen = [];
  const ctrl = createController({ dirs, emit: (t, p) => { if (t === 'started') seen.push(p); } });
  await ctrl.start({ origin: 'https://shop.test/c', store: 'demo', browser: false, fetcher: new Mock() });
  const started = seen[0].engineConfig;
  for (const k of ENGINE_CONFIG_KEYS) assert.deepEqual(started[k], saved[k], `launch: ${k}`);
  const jobId = ctrl.listJobs()[0].id;
  await ctrl.resume(jobId, { fetcher: new Mock() }).catch(() => {});
  const resumed = seen.find((p) => p.resumed);
  assert.ok(resumed, 'the resume started');
  for (const k of ENGINE_CONFIG_KEYS) assert.deepEqual(resumed.engineConfig[k], saved[k], `resume: ${k}`);
});

test('a value of the wrong kind is ignored (the default stays), a form limit wins over the saved one', () => {
  const o = jobConfigOverrides({ breaker: 'many', quality: 'strict', recovery: 'yes', workers: 2, maxProducts: 900 }, { maxProducts: 10 });
  assert.equal('breaker' in o, false); assert.equal('quality' in o, false); assert.equal('recovery' in o, false);
  assert.equal(o.workers, 2); assert.equal(o.maxProducts, 10);
});
