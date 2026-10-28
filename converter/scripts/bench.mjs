/**
 * Phase 2 Lot 4 — regenerate the sites × platforms conversion matrix:
 *   docs/phase2-conversion-matrix.md   (the human artifact)
 *   test/bench/expected-matrix.json    (the snapshot test/bench.test.mjs guards)
 * Saved fixtures only: no live site, no API, no provider. Regenerate
 * deliberately when an engine change is MEANT to move a cell, and read the diff.
 *   npm run bench
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeMatrix, snapshotOf, renderMarkdown } from '../test/bench/matrix.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const matrix = computeMatrix();
fs.writeFileSync(path.join(ROOT, 'docs', 'phase2-conversion-matrix.md'), renderMarkdown(matrix));
fs.writeFileSync(path.join(ROOT, 'test', 'bench', 'expected-matrix.json'), JSON.stringify(snapshotOf(matrix), null, 2) + '\n');
const cells = Object.values(matrix).flatMap((r) => Object.values(r));
const n = (s) => cells.filter((c) => c.status === s).length;
console.log(`bench: ${Object.keys(matrix).length} sources × 4 targets = ${cells.length} cells — ${n('ok')} ok, ${n('preserved')} preserved, ${n('flagged')} flagged, ${n('failed')} failed, ${n('n/a')} n/a`);
