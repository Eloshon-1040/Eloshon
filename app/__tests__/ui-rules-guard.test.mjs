/**
 * Rules of the Scraper's screens (roadmap phase 7, 28/10/2026), guarded on the renderer's source and dictionaries:
 *  - no paid service is named outside Administration (the Protection page showed « TwoCaptcha »);
 *  - a job stopped by the quality check has its own state, never « Bloqué »;
 *  - the end screen never shows a raw method id;
 *  - prices go through Intl (no fixed « € » glued to a number);
 *  - no ✓ ✗ ⟳ characters in the screens' texts (icons are drawn);
 *  - the French texts address the user as « vous ».
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const R = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer');
const app = fs.readFileSync(path.join(R, 'app.js'), 'utf8');
const dict = Object.fromEntries(['fr', 'en', 'de', 'es', 'nl'].map((l) => [l, fs.readFileSync(path.join(R, 'i18n', `${l}.js`), 'utf8')]));

test('no paid service named on the user screens', () => {
  assert.doesNotMatch(app, /TwoCaptcha|protection\.autoProvider|protection\.providerFuture/);
  for (const [l, s] of Object.entries(dict)) assert.doesNotMatch(s, /TwoCaptcha|2captcha|Firecrawl|Bright ?Data|Zyte/i, l);
});

test('a quality stop has its own state; the method is never shown raw', () => {
  assert.match(app, /s === 'stopped:low_quality'\) return chip\('warn', 'attention', CI\.alert, t\('status\.lowQuality'\)\)/);
  for (const s of Object.values(dict)) assert.match(s, /lowQuality: '/);
  assert.doesNotMatch(app, /return m;\s+\/\/ sitemap/);
  assert.match(app, /return t\('complete\.mPages'\)/);
});

test('prices through Intl, no ✓ ✗ ⟳ characters in the texts', () => {
  assert.doesNotMatch(app, /toFixed\(2\)\.replace\('\.', ','\) \+ ' €'/);
  assert.match(app, /const price = \(p, currency\) =>/);
  for (const [l, s] of Object.entries(dict)) assert.doesNotMatch(s, /[✓✗⟳]/, l);
});

test('French texts say « vous », never « tu »', () => {
  const values = [...dict.fr.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
  const informal = values.filter((v) => /(^|[\s(])(tu|ton|ta|tes|toi)\s|\bt’|(^|\. )(Colle|Choisis|Lance|Reprends|Ouvre|Décide|Saisis)\b/.test(v));
  assert.deepEqual(informal, []);
});
