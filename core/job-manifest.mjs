/**
 * The export manifest of an app job (docs/EXPORT-MANIFEST.md): what the job's CSV and products.json really
 * hold — the job's status, the product pages to read / read / failed / never opened, the site rules that
 * failed, the fill rate of every column. Written beside the job's products.json (`jobs/<id>/manifest.json`)
 * and beside its CSV (`csv/<id>.manifest.json`), so the Converter reads it with either file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildManifest } from '../shared/export/manifest.mjs';
import { fillRates, manifestFill } from './fill-rate.mjs';

/** The product pages of a job, in the manifest's terms. */
function productPagesOf(report) {
  // A run where your browser (the extension) read the product pages: its own count is the truth.
  const e = report.yourBrowserPages;
  if (e && Number(e.toRead) > 0) {
    const list = Array.isArray(e.list) ? e.list : [];
    const isBlocked = (p) => p.reason === 'human_check' || p.reason === 'failed' || p.reason === 'denied';
    return { toRead: e.toRead, read: e.read, blockedCount: e.blocked, notOpenedCount: e.notOpened, blocked: list.filter(isBlocked), notOpened: list.filter((p) => !isBlocked(p)), limit: e.limit || null };
  }
  const d = report.detailPages;
  if (!d) return { toRead: 0, read: 0 };
  const reasons = d.reasons || {};
  const quiet = Number(reasons.sample_no_data) || 0; // the sample showed the pages add nothing: not a gap
  const failed = Number(d.failed) || 0;
  const skipped = Math.max(0, (Number(d.skipped) || 0) - quiet);
  return {
    toRead: Math.max(0, (Number(d.candidates) || 0) - quiet),
    read: (Number(d.completed) || 0) + (Number(d.unchanged) || 0),
    blockedCount: failed,
    notOpenedCount: skipped,
    byReason: { failed, limit: Number(reasons.max_visits) || 0, stopped: Number(reasons.stopped) || 0 },
  };
}

/**
 * @param {{ report:object, products:object[], jobId:string, origin?:string, source?:'app'|'extension', sourceVersion?:string }} o
 */
export function jobManifest({ report, products, jobId, origin = null, source = 'app', sourceVersion = null }) {
  const fill = report.fill || fillRates(products || []);
  let site = report.store || '';
  try { if (origin) site = new URL(origin).hostname.replace(/^www\./, ''); } catch { /* keep the store */ }
  return buildManifest({
    source, sourceVersion, site, listUrl: origin, jobId, jobStatus: report.status,
    accepted: true, rowCount: (products || []).length,
    rulesFailing: (report.knowledgeInvalidated || []).map((r) => ({ field: r.field, reason: r.reason || null })),
    productPages: productPagesOf(report),
    columns: Array.isArray(report.columns) ? report.columns : [],
    fill: manifestFill(fill),
  });
}

/** Writes the manifest beside products.json and beside the CSV. Never breaks a job: returns the paths written. */
export function writeJobManifest(paths, manifest) {
  const written = [];
  const text = JSON.stringify(manifest, null, 1);
  for (const file of [path.join(paths.dir, 'manifest.json'), paths.csv.replace(/\.csv$/, '.manifest.json')]) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); written.push(file); } catch { /* the report says it */ }
  }
  return written;
}
