/**
 * Phase 2 Lot 4 — the sites × platforms bench as a permanent regression net
 * (see test/bench/matrix.mjs). Three guarantees:
 *   1. no cell regresses: a cell may never move to a worse status than its
 *      snapshot (ok → preserved → flagged → failed), and an n/a cell stays n/a;
 *   2. every saved Scraper / third-party / supplier source converts to at least
 *      one target (the objective: whatever the Scraper produced, the Converter
 *      can ingest);
 *   3. the committed artifact docs/phase2-conversion-matrix.md and the
 *      snapshot are exactly what the engine produces now — any intended change
 *      is regenerated deliberately (npm run bench) and reviewed as a diff.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeMatrix, snapshotOf, renderMarkdown, statusRank, SOURCES, TARGETS } from './bench/matrix.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'bench', 'expected-matrix.json'), 'utf8'));
const matrix = computeMatrix();
const now = snapshotOf(matrix);

test('bench: no cell regresses below its snapshot', () => {
  const regressions = [];
  for (const [id, row] of Object.entries(expected)) {
    for (const t of TARGETS) {
      const was = row[t], is = now[id]?.[t];
      if (!is) { regressions.push(`${id} → ${t}: cell disappeared`); continue; }
      if (was.status === 'n/a') { if (is.status !== 'n/a') regressions.push(`${id} → ${t}: was n/a, now ${is.status}`); continue; }
      if (statusRank(is.status) < statusRank(was.status)) regressions.push(`${id} → ${t}: ${was.status} → ${is.status} (${is.reason})`);
    }
  }
  assert.deepEqual(regressions, []);
});

test('bench: every saved Scraper, third-party and supplier source converts to at least one target', () => {
  const ingest = SOURCES.filter((s) => !/^Platform/.test(s.group));
  assert.ok(ingest.length >= 14);
  for (const s of ingest) {
    const ok = TARGETS.filter((t) => ['ok', 'preserved', 'flagged'].includes(now[s.id][t].status));
    assert.ok(ok.length > 0, `${s.label}: no target accepts it`);
    assert.equal(TARGETS.some((t) => now[s.id][t].status === 'failed'), false, `${s.label}: a target failed`);
  }
});

test('bench: the committed matrix artifact and snapshot match the engine (regenerate with npm run bench)', () => {
  assert.deepEqual(now, expected, 'test/bench/expected-matrix.json is stale');
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'phase2-conversion-matrix.md'), 'utf8');
  assert.equal(doc.replace(/\r\n/g, '\n'), renderMarkdown(matrix), 'docs/phase2-conversion-matrix.md is stale');
});
