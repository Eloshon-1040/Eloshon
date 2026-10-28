/**
 * The design tokens and fonts have ONE source: shared/design/ (.interface-design/system.md). The Converter is packaged
 * from converter/ only, so it ships a committed copy in app/renderer/design/. This test fails when the copy drifts
 * (a token changed in shared/ but not here, or the reverse). To fix it, regenerate the copy and review the diff:
 *   npm run sync:design
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SRC, DEST, designFiles } from '../scripts/sync-design.mjs';

test('app/renderer/design/ is byte-identical to shared/design/ (run `npm run sync:design`)', () => {
  const expected = designFiles();
  const actual = fs.existsSync(DEST)
    ? fs.readdirSync(DEST, { recursive: true }).map((f) => f.split(path.sep).join('/')).filter((f) => fs.statSync(path.join(DEST, f)).isFile()).sort()
    : [];
  assert.deepEqual(actual, [...expected].sort(), 'files in app/renderer/design/ differ from shared/design/');
  for (const f of expected) {
    assert.ok(fs.readFileSync(path.join(SRC, f)).equals(fs.readFileSync(path.join(DEST, f))), `${f} differs from shared/design/${f}`);
  }
});

test('the Converter copy carries no Scraper accent', () => {
  assert.ok(!fs.existsSync(path.join(DEST, 'tokens.scraper.css')));
});
