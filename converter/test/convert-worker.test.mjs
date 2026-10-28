/**
 * Phase 1 step 5 — the engine-host worker and its main-side client. The engine
 * is PURE and untouched; these tests prove the plumbing: the worker speaks the
 * protocol (init / file / job → progress + result) and returns byte-identical
 * results to a direct engine call, the host pushes a file's text to the worker
 * ONCE (no re-marshalling per preview), and identical runs are served from the
 * host cache until the knowledge version bumps.
 *
 * In the app the worker runs under Electron utilityProcess (asar-safe, crash-
 * isolated); here it runs under node:worker_threads through the same shim.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { runConversion } from '../app/controller.mjs';
import { createEngineHost } from '../app/convert-host.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'app', 'convert-worker.mjs');
const KNOWLEDGE_DIRS = {
  referenceDir: path.join(ROOT, 'core', 'knowledge-ref'),
  learnedDir: fs.mkdtempSync(path.join(os.tmpdir(), 'elo-worker-kb-')),
};
const CSV = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'shopify_products.csv'), 'utf8');
const RUN_INPUT = { direction: 'shopify-to-woocommerce', expectPlatform: 'shopify' };

const cleanup = [];
after(() => { for (const fn of cleanup) fn(); });

function rawWorker() {
  const w = new Worker(WORKER);
  cleanup.push(() => w.terminate());
  const waitFor = (pred, ms = 8000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker message timeout')), ms);
    w.on('message', (m) => { if (pred(m)) { clearTimeout(timer); resolve(m); } });
  });
  return { w, waitFor };
}

test('worker: protocol round trip, result identical to a direct engine call', async () => {
  const { w, waitFor } = rawWorker();
  await waitFor((m) => m.type === 'ready');
  w.postMessage({ type: 'init', knowledgeDirs: KNOWLEDGE_DIRS });
  w.postMessage({ type: 'file', fileId: 'f1', text: CSV });

  const progress = waitFor((m) => m.type === 'progress' && m.id === 1);
  const result = waitFor((m) => m.type === 'result' && m.id === 1);
  w.postMessage({ type: 'job', id: 1, kind: 'run', input: { ...RUN_INPUT, fileId: 'f1' } });
  assert.equal((await progress).phase, 'convert');
  const viaWorker = (await result).result;

  const direct = runConversion({ ...RUN_INPUT, csvText: CSV });
  assert.equal(viaWorker.ok, true);
  assert.equal(viaWorker.outputCsv, direct.outputCsv, 'worker output is byte-identical to the direct engine');
  assert.deepEqual(viaWorker.counts, direct.counts);
  assert.deepEqual([viaWorker.sourceFormat, viaWorker.targetFormat], [direct.sourceFormat, direct.targetFormat]);
});

test('worker: issues job runs the step-4 gate off the main thread', async () => {
  const { w, waitFor } = rawWorker();
  await waitFor((m) => m.type === 'ready');
  w.postMessage({ type: 'init', knowledgeDirs: KNOWLEDGE_DIRS });
  w.postMessage({ type: 'file', fileId: 'f1', text: CSV });
  const result = waitFor((m) => m.type === 'result' && m.id === 7);
  w.postMessage({ type: 'job', id: 7, kind: 'issues', input: { fileId: 'f1', direction: 'shopify-to-woocommerce' } });
  const report = (await result).result;
  assert.equal(report.ok, true);
  assert.equal(typeof report.canExport, 'boolean');
  assert.ok(Array.isArray(report.problems));
});

function hostWithCounters() {
  const posted = { job: 0, file: 0 };
  const host = createEngineHost({
    spawn: () => {
      const w = new Worker(WORKER);
      cleanup.push(() => w.terminate());
      return {
        post: (m) => { if (posted[m.type] != null) posted[m.type]++; w.postMessage(m); },
        onMessage: (fn) => w.on('message', fn),
        onExit: (fn) => w.on('exit', fn),
        stop: () => w.terminate(),
      };
    },
    knowledgeDirs: KNOWLEDGE_DIRS,
    onProgress: () => {},
  });
  cleanup.push(() => host.dispose());
  return { host, posted };
}

test('host: file text crosses to the worker once; identical runs hit the cache', async () => {
  const { host, posted } = hostWithCounters();
  host.registerFile('f1', CSV);

  const r1 = await host.run({ ...RUN_INPUT, fileId: 'f1' });
  assert.equal(r1.ok, true);
  assert.deepEqual(posted, { job: 1, file: 1 });

  // Same input again (entering step 4 right after the identical step-3
  // preview): served from the cache — no new job, no re-marshalled file.
  const r2 = await host.run({ ...RUN_INPUT, fileId: 'f1' });
  assert.deepEqual(r2, r1);
  assert.deepEqual(posted, { job: 1, file: 1 });

  // A real change (overrides) is a different key → one more job, file NOT resent.
  await host.run({ ...RUN_INPUT, fileId: 'f1', overrides: { tags: { column: null } } });
  assert.deepEqual(posted, { job: 2, file: 1 });

  // Learned knowledge changed → cache is stale by definition → fresh job.
  host.bumpKnowledge();
  await host.run({ ...RUN_INPUT, fileId: 'f1' });
  assert.deepEqual(posted, { job: 3, file: 1 });
});

test('host: issues and run cache independently; stray UI fields never defeat the cache', async () => {
  const { host, posted } = hostWithCounters();
  host.registerFile('f1', CSV);
  const a = await host.issues({ fileId: 'f1', direction: 'shopify-to-woocommerce' });
  const b = await host.issues({ fileId: 'f1', direction: 'shopify-to-woocommerce' });
  assert.deepEqual(b, a);
  assert.equal(posted.job, 1);
  // mode rides along from the renderer on exports — engine-irrelevant, cached alike.
  await host.run({ ...RUN_INPUT, fileId: 'f1' });
  await host.run({ ...RUN_INPUT, fileId: 'f1', mode: 'export' });
  assert.equal(posted.job, 2, 'mode is not part of the engine cache key');
});

test('host: overrides key order never defeats the cache; a forgotten file is freed and re-pushed', async () => {
  const { host, posted } = hostWithCounters();
  host.registerFile('f1', CSV);
  await host.run({ ...RUN_INPUT, fileId: 'f1', overrides: { vendor: { column: null }, tags: { column: null } } });
  await host.run({ ...RUN_INPUT, fileId: 'f1', overrides: { tags: { column: null }, vendor: { column: null } } });
  assert.deepEqual(posted, { job: 1, file: 1 }, 'same overrides in a different key order hit the cache');

  host.forgetFile('f1');
  host.registerFile('f1', CSV);
  const r = await host.run({ ...RUN_INPUT, fileId: 'f1', overrides: { vendor: { column: null }, tags: { column: null } } });
  assert.equal(r.ok, true);
  assert.deepEqual(posted, { job: 2, file: 2 }, 'forget drops the worker copy and the cache; the next job re-pushes');
});
