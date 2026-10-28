/**
 * Local job store — makes the scraper resumable and inspectable without any DB.
 *
 * scraper-output/
 *   jobs/<JOB_ID>/  job.json · discovered.json · processed.json · products.json
 *   csv/<JOB_ID>.csv
 *   reports/<JOB_ID>.json  + <JOB_ID>.txt
 *
 * A job keeps: config, discovered URLs, processed URL keys, normalized products,
 * errors, status, and the remaining URLs (discovered − processed) for resume.
 */
import fs from 'node:fs';
import path from 'node:path';
import { outputRoot } from './config.mjs';
import { dedupKey } from './url-utils.mjs';

const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));

export function newJobId() {
  const d = new Date();
  const ts = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${ts}-${Math.random().toString(36).slice(2, 7)}`;
}

export function jobPaths(cfg, id) {
  const root = outputRoot(cfg);
  const dir = path.join(root, 'jobs', id);
  return {
    root, dir,
    job: path.join(dir, 'job.json'),
    discovered: path.join(dir, 'discovered.json'),
    processed: path.join(dir, 'processed.json'),
    products: path.join(dir, 'products.json'),
    csv: path.join(root, 'csv', `${id}.csv`),
    reportJson: path.join(root, 'reports', `${id}.json`),
    reportTxt: path.join(root, 'reports', `${id}.txt`),
  };
}

function ensureDirs(cfg, id) {
  const p = jobPaths(cfg, id);
  for (const d of [p.dir, path.dirname(p.csv), path.dirname(p.reportJson)]) fs.mkdirSync(d, { recursive: true });
  return p;
}

export function createJob(cfg, meta) {
  const id = newJobId();
  const p = ensureDirs(cfg, id);
  const job = { id, createdAt: new Date().toISOString(), status: 'created', config: cfg, meta, counters: {} };
  writeJson(p.job, job);
  writeJson(p.discovered, []);
  writeJson(p.processed, []);
  writeJson(p.products, []);
  return { id, paths: p, job };
}

/** Jobs written before the single-language contract carry name_fr / description_fr and a mirrored
 *  *_en copy: read them under the current names (name, description) and drop the copy. */
export function upgradeLegacyProduct(p) {
  if (!p || typeof p !== 'object' || !('name_fr' in p || 'description_fr' in p || 'name_en' in p || 'description_en' in p)) return p;
  const { name_fr, description_fr, name_en, description_en, ...rest } = p;
  return { ...rest, name: rest.name || name_fr || name_en || '', description: rest.description || description_fr || description_en || null };
}

/** A live handle that buffers products/processed keys and flushes to disk. */
export class Job {
  constructor(cfg, id) {
    this.cfg = cfg; this.id = id; this.paths = jobPaths(cfg, id);
    if (!fs.existsSync(this.paths.job)) throw new Error(`Unknown job: ${id} (looked in ${this.paths.dir})`);
    this.job = readJson(this.paths.job, {});
    this.discovered = readJson(this.paths.discovered, []);
    this.processed = new Set(readJson(this.paths.processed, []));
    this.products = readJson(this.paths.products, []).map(upgradeLegacyProduct);
    this._dirty = false;
  }

  setDiscovered(urls) { this.discovered = urls; writeJson(this.paths.discovered, urls); }

  /** URLs discovered but not yet processed (for resume). */
  remaining() { return this.discovered.filter((u) => !this.processed.has(dedupKey(u))); }

  markProcessed(url) { this.processed.add(dedupKey(url)); this._dirty = true; }
  addProduct(np) { this.products.push(np); this._dirty = true; }

  flush() {
    if (!this._dirty) return;
    writeJson(this.paths.processed, [...this.processed]);
    writeJson(this.paths.products, this.products);
    this._dirty = false;
  }

  setStatus(status, extra = {}) {
    this.job.status = status;
    this.job.updatedAt = new Date().toISOString();
    Object.assign(this.job, extra);
    writeJson(this.paths.job, this.job);
  }
}

export function listJobs(cfg) {
  const dir = path.join(outputRoot(cfg), 'jobs');
  try { return fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, 'job.json'))); } catch { return []; }
}
