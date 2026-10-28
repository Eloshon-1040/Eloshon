/**
 * A 🎯 designation can ALWAYS be left (28/10, ext 0.7.32 in a real Chrome: the « carte produit » designation ignored
 * the click, Escape and the right-click, and kept swallowing the page's clicks). Root cause: `pickOnce` set
 * `activePick` to a wrapper of `finish`, and `finish` starts with `if (activePick !== finish) return` — every exit
 * returned early. The real in-page runner (extension/content/runner.mjs) is loaded here on a linkedom page with a
 * stand-in window: each exit — click, Escape, right-click, the panel's cancel (Escape in the panel, the panel
 * closed), another tab — ends the designation, removes every listener and overlay, and answers.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseHTML } from 'linkedom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, '..', '..', 'extension');
const card = (n, price) => `<div class="tile"><a href="/products/p${n}"><img src="/i${n}.jpg"></a><h3 class="title">Lampe ${n}</h3><span class="price">${price} €</span></div>`;
const dom = parseHTML(`<html><body><main><div class="grid">${card(1, '10,00')}${card(2, '12,00')}${card(3, '9,00')}</div></main></body></html>`);
const { document, HTMLElement } = dom;

// The stand-in window: its listeners are kept so the test can fire events and count what is left.
const listeners = new Map();
const win = {
  addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(fn); },
  removeEventListener: (t, fn) => { const s = listeners.get(t); if (s) s.delete(fn); },
};
const fire = (type, extra = {}) => { const e = { type, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, clientX: 5, clientY: 5, ...extra }; for (const fn of [...(listeners.get(type) || [])]) fn(e); };
const live = () => ['mousemove', 'wheel', 'click', 'mousedown', 'keydown', 'contextmenu'].reduce((n, t) => n + ((listeners.get(t) && listeners.get(t).size) || 0), 0);
// The designation's instruction bar (the green / red card count shown after a click is not one).
const overlays = () => [...document.documentElement.querySelectorAll('div[style*="2147483647"]')].filter((d) => /Échap/.test(d.textContent)).length;
let under = null; // what the pointer is over
Object.assign(globalThis, {
  window: win, document, location: new URL('https://shop.test/c/lamps'), innerWidth: 1200, innerHeight: 800, scrollX: 0, scrollY: 0,
  chrome: { runtime: { getURL: (p) => pathToFileURL(path.join(EXT, p)).href } },
  getComputedStyle: () => ({ position: 'static', display: 'block', visibility: 'visible' }),
  requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: (id) => clearTimeout(id),
});
document.elementsFromPoint = () => (under ? [under] : []);
HTMLElement.prototype.getBoundingClientRect = function rect() { return { left: 0, top: 0, width: 100, height: 40, right: 100, bottom: 40 }; };
HTMLElement.prototype.getClientRects = function rects() { return [this.getBoundingClientRect()]; };
await import(pathToFileURL(path.join(EXT, 'content', 'runner.mjs')).href);
const R = globalThis.__eloRunner;
const tick = () => new Promise((r) => setTimeout(r, 5));
// Waits until the designation is on screen (never for its end: an async function returning `p` would adopt it).
const started = async () => { await tick(); await tick(); assert.ok(live() > 0, 'the designation listens'); assert.equal(overlays(), 1, 'its instruction bar is shown'); };
// A failed check never leaves a designation (and its 2-minute timer) behind.
afterEach(() => { R.cancelPick(); under = null; });
const ended = () => { assert.equal(live(), 0, 'no listener left on the page'); assert.equal(overlays(), 0, 'no overlay left'); };

test('Escape in the page ends the card designation', async () => {
  const p = R.learnCard({}); await started();
  fire('keydown', { key: 'Escape' });
  assert.deepEqual(await p, { ok: false, reason: 'annulé' }); ended();
});

test('a right-click ends it', async () => {
  const p = R.learnCard({}); await started();
  fire('contextmenu');
  assert.equal((await p).ok, false); ended();
});

test('the panel\'s cancel (Escape pressed in the panel, the panel closed) ends it', async () => {
  const p = R.learnCard({}); await started();
  assert.equal(R.cancelPick(), true);
  assert.equal((await p).ok, false); ended();
});

test('another tab (the page hidden) ends it', async () => {
  const p = R.markNotProduct({ model: { card: 'div.tile', fields: {}, negatives: [] } }); await started();
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  document.dispatchEvent(new dom.Event('visibilitychange'));
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  assert.equal((await p).ok, false); ended();
});

test('a click on a card answers with the learned card, and the page is free again', async () => {
  const p = R.learnCard({}); await started();
  under = document.querySelectorAll('.tile .price')[1];
  fire('mousemove'); fire('click');
  const r = await p; under = null;
  assert.equal(r.ok, true); assert.equal(r.model.card, 'div.tile'); assert.equal(r.kept, 3);
  assert.equal(live(), 0);
});

test('« Enregistrer » that the app cannot keep says why: an app older than the extension is not « closed »', async () => {
  const { appWhy } = await import(pathToFileURL(path.join(EXT, 'ui', 'read-state.mjs')).href);
  assert.match(appWhy('demande inconnue'), /plus ancienne que l’extension : mettez-la à jour/, 'the installed 0.5.57 answered this to op site_values (28/10)');
  assert.match(appWhy('application hors ligne'), /fermée : lancez-la/);
  assert.match(appWhy(null), /fermée/);
  assert.equal(appWhy('page_too_large'), 'page_too_large');
});

test('a new designation ends the one in progress; the « page suivante » one still leaves with Escape', async () => {
  const first = R.pickHub(); await started();
  const second = R.pickNextButton({});
  assert.equal(await first.then((r) => r.ok), false, 'the first one answered');
  await tick(); fire('keydown', { key: 'Escape' });
  assert.equal((await second).ok, false); ended();
});
