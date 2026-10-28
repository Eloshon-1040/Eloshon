/**
 * BUG 4: the detailed end-of-job report must be reachable from Jobs history.
 * controller.jobReport reads the persisted reports/<id>.txt, and falls back to
 * reconstructing from the saved job.report record (so already-run jobs work).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../controller.mjs';
import { loadConfig } from '../../core/config.mjs';
import { createJob, Job } from '../../core/jobstore.mjs';

function ctl() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-rep-'));
  const dirs = ensureDirs(appDirs(base));
  return { controller: createController({ dirs }), dirs };
}

test('jobReport reads the persisted reports/<id>.txt', () => {
  const { controller, dirs } = ctl();
  const cfg = loadConfig({ outputDir: dirs.data });
  const { id } = createJob(cfg, { origin: 'https://x.be/cat', store: 's' });
  const job = new Job(cfg, id);
  fs.writeFileSync(job.paths.reportTxt, `Job ${id}\n\nstore: s\nOK · accepted=9`);
  const r = controller.jobReport(id);
  assert.equal(r.ok, true);
  assert.match(r.text, /accepted=9/);
  assert.ok(r.reportPath && r.reportPath.endsWith('.txt'));
});

test('jobReport falls back to the saved job.report when the .txt is missing (old jobs)', () => {
  const { controller, dirs } = ctl();
  const cfg = loadConfig({ outputDir: dirs.data });
  const { id } = createJob(cfg, { origin: 'https://y.be', store: 't' });
  const job = new Job(cfg, id);
  job.setStatus('done', { report: { store: 't', status: 'OK', accepted: 3, detected: 3, method: 'generic-jsonld' } });
  // Ensure no .txt on disk for this job.
  try { fs.unlinkSync(job.paths.reportTxt); } catch { /* none */ }
  const r = controller.jobReport(id);
  assert.equal(r.ok, true);
  assert.match(r.text, /Job /);
});

test('jobReport returns ok:false for a job with no report anywhere', () => {
  const { controller, dirs } = ctl();
  const cfg = loadConfig({ outputDir: dirs.data });
  const { id } = createJob(cfg, { origin: 'https://z.be' });
  const r = controller.jobReport(id);
  assert.equal(r.ok, false);
  assert.equal(r.text, null);
});
