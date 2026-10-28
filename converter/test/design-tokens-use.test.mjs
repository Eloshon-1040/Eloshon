/**
 * The Converter renderer takes every design value from the shared tokens (.interface-design/system.md, §11):
 * index.html loads design/tokens.base.css and design/tokens.converter.css before app.css, and app.css only uses them.
 * A token redefined in app.css, or a raw color, would drift from shared/design/ without any test noticing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'app/renderer/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'app/renderer/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const js = fs.readFileSync(path.join(ROOT, 'app/renderer/app.js'), 'utf8');

test('index.html loads the shared tokens before app.css, as the Converter, theme following Windows', () => {
  const base = html.indexOf('design/tokens.base.css'), conv = html.indexOf('design/tokens.converter.css'), app = html.indexOf('app.css"');
  assert.ok(base > 0 && conv > base && app > conv, 'order: tokens.base.css, tokens.converter.css, app.css');
  assert.match(html, /<html[^>]*data-app="converter"/);
  assert.match(html, /<html[^>]*data-theme="system"/);
});

test('app.css defines no token and holds no raw color (white on the brand mark and the close button excepted)', () => {
  assert.ok(!/(^|[;{\s])--[\w-]+\s*:/m.test(css), 'a custom property is defined in app.css: define it in shared/design/');
  const hex = (css.match(/#[0-9A-Fa-f]{3,8}\b/g) || []).filter((h) => h.toUpperCase() !== '#FFFFFF');
  assert.deepEqual(hex, [], `raw colors in app.css: ${hex.join(', ')}`);
  assert.ok(!/rgba?\(/.test(css), 'rgb()/rgba() in app.css: use a token');
  assert.ok(!/box-shadow:\s*(?!none)/.test(css), 'no shadows (system.md §4: lines only)');
});

test('app.js no longer uses the retired variable names', () => {
  const old = js.match(/var\(--(or|ord|ord-h|ors|bg|card|card2|text|text2|bord|bord2|oks|warns|errs|err|ok-dot|warn-dot|sh|sh2|sh3|chrome2|chrome-bord|chrome-text|sans|mono)\)/g) || [];
  assert.deepEqual(old, []);
});

test('the theme defaults to « Système » and only accepts system, light or dark', () => {
  const main = fs.readFileSync(path.join(ROOT, 'app/main.mjs'), 'utf8');
  assert.match(main, /theme: 'system'/);
  assert.match(main, /const THEMES = \['system', 'light', 'dark'\]/);
  assert.match(main, /nativeTheme\.themeSource/);
});
