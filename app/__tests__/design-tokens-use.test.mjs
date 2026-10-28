/**
 * The Scraper renderer takes every design value from the shared tokens (.interface-design/system.md §11):
 * index.html links ../../shared/design/tokens.base.css and tokens.scraper.css before app.css, and app.css only
 * uses them. A token redefined in app.css, a raw color, a shadow or a retired variable name would drift from
 * shared/design/ without any other test noticing. The theme follows Windows by default and main validates it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const html = R('app/renderer/index.html');
const css = noComments(R('app/renderer/app.css'));
const JS = ['app.js', 'your-browser-ui.js', 'ui-kit.js', 'admin-panel.js', 'admin-usage-ui.js'].map((f) => [f, R('app/renderer/' + f)]);
const tokens = R('shared/design/tokens.base.css') + R('shared/design/tokens.scraper.css');

test('index.html links the shared tokens directly, before app.css, Scraper accent, theme following Windows', () => {
  const base = html.indexOf('href="../../shared/design/tokens.base.css"');
  const app = html.indexOf('href="../../shared/design/tokens.scraper.css"');
  const own = html.indexOf('href="app.css"');
  assert.ok(base > 0 && app > base && own > app, 'order: tokens.base.css, tokens.scraper.css, app.css');
  assert.match(html, /<html[^>]*data-app="scraper"/);
  assert.match(html, /<html[^>]*data-theme="system"/);
});

test('app.css defines no token and holds no raw color (white on the brand mark and the close button excepted)', () => {
  assert.ok(!/(^|[;{\s])--[\w-]+\s*:/m.test(css), 'a custom property is defined in app.css: define it in shared/design/');
  const hex = (css.match(/#[0-9A-Fa-f]{3,8}\b/g) || []).filter((h) => h.toUpperCase() !== '#FFFFFF');
  assert.deepEqual(hex, [], `raw colors in app.css: ${hex.join(', ')}`);
  assert.equal((css.match(/#FFFFFF/gi) || []).length, 2, 'white only on .lockup-mark and .tb-btn.close:hover');
  assert.ok(!/rgba?\(|hsla?\(/.test(css), 'rgb()/hsl() in app.css: use a token');
  assert.ok(!/box-shadow\s*:\s*(?!none)/.test(css), 'no shadows (system.md §4: lines only)');
  assert.ok(!/Archivo|Segoe|system-ui/.test(css), 'Inter (--font-ui) is the only UI font');
});

test('Poppins only for headings of 22 px and more (system.md §3)', () => {
  const uses = css.match(/[^{}]+\{[^}]*var\(--font-brand\)[^}]*\}/g) || [];
  assert.ok(uses.length >= 1, '.h1 uses --font-brand');
  for (const rule of uses) assert.match(rule, /font:\s*600 (2[2-9]|[3-9]\d)px/, `Poppins on a heading under 22 px: ${rule.trim().slice(0, 80)}`);
  for (const [f, src] of JS) assert.ok(!/Poppins|font-brand/.test(src), `${f} sets Poppins inline`);
});

test('every var(--…) used by the renderer is a shared token', () => {
  const defined = new Set([...tokens.matchAll(/--([\w-]+)\s*:/g)].map((m) => m[1]));
  const used = new Map();
  for (const [f, src] of [['app.css', css], ...JS]) for (const m of src.matchAll(/var\(--([\w-]+)/g)) if (!defined.has(m[1])) used.set(m[1], f);
  assert.deepEqual([...used].map(([v, f]) => `${f}: --${v}`), []);
});

test('the renderer scripts use no raw color, no retired variable and no old pill markup', () => {
  for (const [f, src] of JS) {
    const code = noComments(src);
    assert.deepEqual(code.match(/#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b(?![\w-])/g) || [], [], `${f}: raw colors`);
    assert.ok(!/rgba?\(/.test(code), `${f}: rgb()`);
    assert.ok(!/class="pill\b|class: 'pill\b/.test(code), `${f}: old .pill markup; use the status-chip component`);
  }
});

test('status chips: the shared component with an icon and a word (system.md §5.4)', async () => {
  const { chip, CI } = await import('../renderer/ui-kit.js');
  const c = chip('danger', 'attention', CI.octX, 'Bloqué');
  assert.match(c, /^<span class="status-chip" data-tone="danger" data-shape="attention"><svg[^>]*>.*<\/svg>Bloqué<\/span>$/);
  const moving = chip('neutral', 'settled', '', 'En cours', true);
  assert.match(moving, /class="moving"/); assert.match(moving, /class="still"/); // still clock under reduced motion
});

test('the theme defaults to « Système », only accepts system, light or dark, and drives nativeTheme', () => {
  const main = R('app/main.mjs');
  assert.match(main, /const THEMES = \['system', 'light', 'dark'\]/);
  assert.match(main, /const DEFAULT_THEME = 'system'/);
  assert.match(main, /nativeTheme\.themeSource = THEMES\.includes\(theme\) \? theme : DEFAULT_THEME/);
  assert.match(main, /if \('theme' in p && !THEMES\.includes\(p\.theme\)\) delete p\.theme/, 'settings:set validates the theme');
  const app = R('app/renderer/app.js');
  assert.match(app, /const THEMES = \['system', 'light', 'dark'\]/);
  assert.match(app, /theme: 'system'/);
});

test('chrome zones stay dark in both themes, edged by --chrome-line', () => {
  assert.match(css, /\.titlebar, \.sidebar, \.toast \{ color-scheme: dark; \}/);
  assert.match(css, /\.titlebar \{[^}]*border-bottom: 1px solid var\(--chrome-line\)/);
  assert.match(css, /\.sidebar \{[^}]*border-right: 1px solid var\(--chrome-line\)/);
  assert.match(css, /\[hidden\], \.hidden \{ display: none !important; \}/);
});
