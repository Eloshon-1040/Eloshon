/**
 * Step 3 has ONE vertical scroll container (the page): its column table grows with its rows and keeps a sticky
 * header; the converted-rows preview only scrolls sideways. Before: page + table (max-height 46vh) + preview
 * (max-height 34vh) each scrolled, and the sticky header could not stick to the page.
 * Since the redesign (system.md §5.6) one function draws the table for the three cases (known format, recognised
 * platform, unknown file): renderColumnTable, the `.map` table with its container query.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(ROOT, 'app/renderer/app.css'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'app/renderer/app.js'), 'utf8');
const body = (name) => { const i = js.indexOf(`function ${name}(`); assert.ok(i >= 0, name); const j = js.indexOf('\nfunction ', i + 10); return js.slice(i, j < 0 ? undefined : j); };
const rule = (sel) => { const i = css.indexOf(sel + ' {'); assert.ok(i >= 0, sel); return css.slice(i, css.indexOf('}', i)); };

test('one table function for the three cases; the old three are gone', () => {
  for (const old of ['renderMappingTable', 'renderKnowledgeTable', 'renderLearnTable']) assert.ok(!js.includes(`function ${old}(`), `${old} still exists`);
  const step3 = body('renderStep3');
  assert.match(step3, /renderColumnTable\(body\)/, 'renderStep3 draws every case through renderColumnTable');
  assert.match(body('renderColumnTable'), /class="map" id="s3-map"/);
});

test('the step-3 column table never scrolls on its own, and its header sticks to the page', () => {
  assert.ok(!/tbl-wrap h"/.test(body('renderColumnTable')), 'no capped .tbl-wrap.h');
  assert.ok(!/overflow/.test(rule('.map')), 'the .map container has no overflow of its own');
  assert.match(rule('.map'), /container:\s*map \/ inline-size/);
  assert.match(rule('.map-tbl thead th'), /position:\s*sticky;/);
  assert.match(css, /@container map \(min-width: 960px\)/, 'one-line rows from a 960 px wide table');
  // the « Modifier » list scrolls inside its dialog only
  assert.match(rule('.m-list'), /overflow-y:\s*auto/);
});

// Andy's request (28/10/2026): reading down the preview, its column titles stay visible, and its sideways bar is
// always in view — a box no taller than the window, scrolling both ways, with a sticky header.
test('the preview is a window-high box: sticky column titles, sideways bar always in view, one-line cells', () => {
  assert.match(js, /class="tbl-wrap preview" id="s3-preview-body">/);
  assert.ok(!/id="s3-preview-body" style="max-height/.test(js), 'the height cap lives in the stylesheet');
  assert.match(css, /\.tbl-wrap\.preview\s*\{\s*overflow:\s*auto;\s*max-height:\s*max\(240px, calc\(100vh - 240px\)\);/);
  assert.match(css, /\.tbl-wrap\.preview thead th\s*\{\s*position:\s*sticky;\s*top:\s*0;/);
  assert.match(css, /\.tbl-wrap\.preview tbody td:focus\s*\{[^}]*white-space:\s*pre-wrap;/);
});
