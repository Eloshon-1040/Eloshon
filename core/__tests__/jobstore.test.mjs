/**
 * Job store tests — persistence + resume math. Uses a temp output dir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJob, Job } from '../jobstore.mjs';

function tmpCfg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-jobs-'));
  return { outputDir: dir };
}

test('createJob writes job dir + files', () => {
  const cfg = tmpCfg();
  const { id, paths } = createJob(cfg, { origin: 'https://x' });
  assert.ok(id);
  assert.ok(fs.existsSync(paths.job));
  assert.ok(fs.existsSync(paths.discovered));
  const job = JSON.parse(fs.readFileSync(paths.job, 'utf8'));
  assert.equal(job.meta.origin, 'https://x');
});

test('discovered/processed/products persist and reload', () => {
  const cfg = tmpCfg();
  const { id } = createJob(cfg, {});
  let job = new Job(cfg, id);
  job.setDiscovered(['https://s/p/1', 'https://s/p/2', 'https://s/p/3']);
  job.markProcessed('https://s/p/1');
  job.addProduct({ name: 'A', __eligibility: { status: 'accepted' } });
  job.flush();

  job = new Job(cfg, id); // reload from disk
  assert.equal(job.discovered.length, 3);
  assert.equal(job.products.length, 1);
  assert.equal(job.remaining().length, 2); // p/2 and p/3 left
  assert.ok(job.remaining().every((u) => !u.endsWith('/p/1')));
});

test('remaining() dedups by canonical key (tracking params / trailing slash)', () => {
  const cfg = tmpCfg();
  const { id } = createJob(cfg, {});
  const job = new Job(cfg, id);
  job.setDiscovered(['https://s/p/1?utm_source=x', 'https://s/p/2/']);
  job.markProcessed('https://s/p/1'); // same product, clean URL
  assert.deepEqual(job.remaining().map((u) => u), ['https://s/p/2/']);
});

test('setStatus updates job.json', () => {
  const cfg = tmpCfg();
  const { id, paths } = createJob(cfg, {});
  const job = new Job(cfg, id);
  job.setStatus('done', { note: 'ok' });
  const saved = JSON.parse(fs.readFileSync(paths.job, 'utf8'));
  assert.equal(saved.status, 'done');
  assert.equal(saved.note, 'ok');
});

test('a job written before the single-language contract is read under the current names', async () => {
  const { upgradeLegacyProduct } = await import('../jobstore.mjs');
  const old = { name_fr: 'Vélo', name_en: 'Vélo', description_fr: 'Texte', description_en: 'Texte', price: 5, source_url: 'u' };
  assert.deepEqual(upgradeLegacyProduct(old), { price: 5, source_url: 'u', name: 'Vélo', description: 'Texte' });
  const current = { name: 'Bike', description: null, price: 1 };
  assert.equal(upgradeLegacyProduct(current), current, 'a current product is returned untouched');
  assert.equal(upgradeLegacyProduct({ name_fr: '', name_en: 'Bike' }).name, 'Bike');
});
