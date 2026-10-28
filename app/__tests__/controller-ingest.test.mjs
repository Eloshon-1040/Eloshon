/**
 * The "your browser" tier routes its products through controller.ingestExternalProducts,
 * which must run the SAME normalise → eligibility → dedup → CSV/report path as
 * every other lane. Offline: a temp data dir, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { appDirs, ensureDirs } from '../../lib/osenv.mjs';
import { createController } from '../controller.mjs';

function ctl() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-ctl-'));
  const dirs = ensureDirs(appDirs(base));
  const events = [];
  const controller = createController({ dirs, emit: (t, p) => events.push({ t, p }) });
  return { controller, events, base };
}

test('ingestExternalProducts: normalises, dedups by id, writes CSV, emits done', async () => {
  const { controller, events } = ctl();
  const r = await controller.ingestExternalProducts({
    store: 'colruyt', lang: 'fr',
    products: [
      { name: 'Lait 1L', price: 1.29, sku: 'C1', images: ['https://img/1.jpg'], sourceUrl: 'https://x/1' },
      { name: 'Lait 1L', price: 1.29, sku: 'C1', images: ['https://img/1.jpg'], sourceUrl: 'https://x/1' }, // dup
      { name: 'Beurre 250g', price: 2.49, sku: 'C2', sourceUrl: 'https://x/2' },
    ],
  });
  assert.equal(r.counts.detected, 2, 'the duplicate must be dropped');
  assert.ok(r.counts.accepted >= 1);
  assert.ok(fs.existsSync(r.csvPath));
  const lines = fs.readFileSync(r.csvPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1 + r.counts.accepted); // header + accepted rows
  assert.ok(events.some((e) => e.t === 'done'));
  assert.ok(events.some((e) => e.t === 'product'));
});

test('ingestExternalProducts: products are persisted (Jobs list count + Results view read them from disk)', async () => {
  const { controller } = ctl();
  const r = await controller.ingestExternalProducts({ store: 'persist', products: [{ name: 'A', price: 1, sku: 'a' }, { name: 'B', price: 2, sku: 'b' }] });
  const row = controller.listJobs().find((j) => j.id === r.jobId);
  assert.equal(row.products, 2);
  assert.equal(row.via, 'your-browser');
  assert.equal(controller.jobProducts(r.jobId).length, 2);
});

test('ingestExternalProducts: a blocked run is recorded as a normal job with a plain reason', async () => {
  const { controller } = ctl();
  const r = await controller.ingestExternalProducts({ store: 'blk', products: [], origin: 'https://x.test/c', outcome: { status: 'stopped:blocked', blocked: { code: 'blocked' }, stoppedByUser: false, text: 'Le site a bloqué l’accès depuis votre navigateur.' }, details: { extensionReason: 'raw technical reason' } });
  const row = controller.listJobs().find((j) => j.id === r.jobId);
  assert.equal(row.status, 'stopped:blocked');
  assert.match(row.reason, /bloqué l’accès/);
  const rep = controller.jobReport(r.jobId).text;
  assert.match(rep, /executed in:\s+votre navigateur/);
  assert.doesNotMatch(rep, /raw technical reason|resumable/);
});

test('ingestExternalProducts: empty product set writes an empty CSV and returns zero counts', async () => {
  const { controller } = ctl();
  const r = await controller.ingestExternalProducts({ store: 's', products: [] });
  assert.equal(r.counts.detected, 0);
  assert.ok(fs.existsSync(r.csvPath));
});
