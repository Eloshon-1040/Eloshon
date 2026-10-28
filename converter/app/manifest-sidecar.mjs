/**
 * The export manifest of an opened file (core/knowledge-proposal/export-manifest.mjs): read beside it —
 * `<name>.manifest.json` (the extension panel's CSV, a job's CSV), `manifest.json` beside a job's
 * products.json — or from an .eloshon header (`eloshon.manifest`). A missing or unreadable manifest is not an
 * error: the file is then recognised by its column names, as before.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readManifest, formatFromManifest } from '../core/knowledge-proposal/export-manifest.mjs';
import { parseCsv } from '../core/dist/index.mjs';

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

/** Where a manifest of this file may be. */
export function sidecarCandidates(p) {
  const dir = path.dirname(p); const base = path.basename(p);
  const out = [path.join(dir, `${base.replace(/\.(csv|json|eloshon|tsv|txt)$/i, '')}.manifest.json`)];
  if (/^products\.json$/i.test(base)) out.push(path.join(dir, 'manifest.json'));
  return out;
}

/** The manifest of an opened file, or null. `text` is the file's own text (an .eloshon carries it in its header). */
export function readFileManifest(p, text) {
  for (const c of p ? sidecarCandidates(p) : []) {
    try {
      const st = fs.statSync(c);
      if (st.isFile() && st.size <= MAX_MANIFEST_BYTES) { const m = readManifest(fs.readFileSync(c, 'utf8')); if (m) return m; }
    } catch { /* no manifest there */ }
  }
  const t = typeof text === 'string' ? text.replace(/^﻿/, '').trimStart() : '';
  if (t.startsWith('{') && t.length < 256 * 1024 * 1024) {
    try { const o = JSON.parse(t); const m = o && o.eloshon && readManifest(o.eloshon.manifest); if (m) return m; } catch { /* not an .eloshon */ }
  }
  return null;
}

/** The format built from the manifest's column roles, for a CSV whose column names were changed (or null). */
export function manifestFormatFor(m, text) {
  if (!m || !m.columns || !m.columns.length || typeof text !== 'string') return null;
  const head = text.slice(0, 64 * 1024).split(/\r?\n/).slice(0, 2).join('\n');
  let headers = [];
  try { headers = parseCsv(head).headers; } catch { headers = []; }
  return headers.length ? formatFromManifest(m, headers) : null;
}
