/**
 * "Scraper via votre navigateur" — renderer pieces (pure string builders +
 * reducer), loaded in Node: the mode option, the running screen states and the
 * localised messages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../renderer/i18n/index.js';
import { ybModeView, ybModeHTML, ybLimitsHTML, ybRunning, applyYbState, ybRunningTopHTML, ybErrorText } from '../renderer/your-browser-ui.js';

setLang('fr');
const I = { browser: '<i-b/>', play: '<i-p/>', stop: '<i-s/>', shield: '<i-sh/>' };

test('mode option: greyed with a plain message when the site is not configured', () => {
  const v = ybModeView({ ok: false, code: 'domain_not_enabled', enabled: false });
  assert.equal(v.selectable, false);
  assert.equal(v.note, 'Ce mode n’est pas encore configuré pour ce site.');
  const html = ybModeHTML({ ok: false, code: 'domain_not_enabled' }, 'yb', I);
  assert.match(html, /data-mode="yb"[^>]*aria-disabled="true"/);
  assert.match(html, /radio-row active" data-act="yb-mode" data-mode="standard"/, 'falls back to standard');
});

test('mode option: selectable when opted in; not-connected shows the install/connect message', () => {
  const ok = ybModeView({ ok: true, code: null, browser: 'edge' });
  assert.equal(ok.selectable, true);
  assert.match(ok.note, /Edge/);
  const nc = ybModeView({ ok: false, code: 'extension_not_connected', enabled: true });
  assert.equal(nc.selectable, true);
  assert.equal(nc.note, 'Installez et connectez l’extension Eloshon Scraper dans votre navigateur pour utiliser ce mode.');
  assert.match(ybModeHTML({ ok: true, browser: 'chrome' }, 'yb', I), /radio-row active" data-act="yb-mode" data-mode="yb"/);
  assert.equal(ybModeView(null).selectable, false);
});

test('limits fields carry the bounds from the main process', () => {
  const html = ybLimitsHTML({ maxProducts: 500, maxListPages: 3, maxDetailPages: 5 }, { maxProducts: { min: 1, max: 5000 }, maxListPages: { min: 1, max: 50 }, maxDetailPages: { min: 0, max: 500 } });
  assert.match(html, /id="yb-maxp" type="number" min="1" max="5000" value="500"/);
  assert.match(html, /id="yb-maxlp" type="number" min="1" max="50" value="3"/);
  assert.match(html, /id="yb-maxdp" type="number" min="0" max="500" value="5"/);
});

test('running screen: paused shows the challenge action + Reprendre + Abandonner; done shows neither button', () => {
  const r = ybRunning({ url: 'https://boutique-alpha.test/c', store: 'alpha', jobId: 'j1', domain: 'boutique-alpha.test' });
  assert.ok(applyYbState(r, { kind: 'state', job: { id: 'j1', phase: 'paused', message: null } }));
  let html = ybRunningTopHTML(r, I);
  assert.match(html, /data-act="yb-resume"/);
  assert.match(html, /data-act="yb-stop"/);
  assert.match(html, /résolvez le défi dans l’onglet/);
  assert.match(html, /data-tone="warn" data-shape="attention"[\s\S]*?CAPTCHA requis/);
  applyYbState(r, { kind: 'state', job: { id: 'j1', phase: 'running', done: 2, total: 4 } });
  html = ybRunningTopHTML(r, I);
  assert.doesNotMatch(html, /data-act="yb-resume"/);
  assert.match(html, /<b>2<\/b> \/ 4 · 50%/);
  applyYbState(r, { kind: 'state', job: { id: 'j1', phase: 'done' } });
  html = ybRunningTopHTML(r, I);
  assert.doesNotMatch(html, /data-act="yb-(stop|resume)"/);
});

test('events for another run are ignored (never mixes two jobs)', () => {
  const r = ybRunning({ url: 'https://magasin-beta.example/', jobId: 'mine', domain: 'magasin-beta.example' });
  assert.equal(applyYbState(r, { kind: 'state', job: { id: 'other', phase: 'error' } }), false);
  assert.equal(r.ybPhase, 'connecting');
  assert.equal(applyYbState({ mode: 'standard' }, { kind: 'state', job: { id: 'mine', phase: 'done' } }), false);
});

test('error text is localised by code, never a raw code', () => {
  assert.equal(ybErrorText({ ok: false, code: 'busy' }), 'Un scraping via votre navigateur est déjà en cours. Attendez sa fin ou abandonnez-le.');
  assert.equal(ybErrorText({ ok: false, code: 'weird_new_code', message: 'Message serveur.' }), 'Message serveur.');
  assert.equal(ybErrorText(null), 'Demande invalide.');
  setLang('en');
  assert.equal(ybErrorText({ code: 'domain_not_enabled' }), 'This mode is not configured for this site yet.');
  setLang('fr');
});
