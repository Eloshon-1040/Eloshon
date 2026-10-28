/**
 * An element marked `hidden` is never shown. A component's own `display` (`.banner { display: flex }`) beats the
 * browser's default for `[hidden]`, so the stylesheet must carry `[hidden] { display: none !important }` — the empty
 * error banner of step 3 was shown as a pink band without it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(ROOT, 'app/renderer/app.css'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'app/renderer/app.js'), 'utf8');

test('the stylesheet makes `hidden` win over every display rule', () => {
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

test('the elements the renderer hides do have a display rule of their own (the case the rule protects)', () => {
  // Classes of the elements written with `hidden` in the templates; at least one has a display rule (.banner).
  const classes = [...js.matchAll(/<[a-z]+[^>]*class="([^"$]+)"[^>]*\shidden[\s>]/g)].flatMap((m) => m[1].split(/\s+/));
  const withDisplay = classes.filter((c) => new RegExp(`\\.${c}\\s*\\{[^}]*display\\s*:\\s*(?!none)`).test(css));
  assert.ok(withDisplay.includes('banner'), `hidden elements with a display rule: ${withDisplay.join(', ')}`);
});
