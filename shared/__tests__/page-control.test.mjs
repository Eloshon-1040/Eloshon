/**
 * Pagination controls the user points at (page-control.mjs): the real link / button around the click,
 * several cues kept (selector, text, block, place, page parameter), found again on the next pages and
 * the next runs; the last page recognised; the announced total; cookie banners closed the private way.
 * Real pages: hydrozone.fr (PrestaShop 1.6) list, page 1 and its last page 2. Offline (linkedom).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { controlCues, findControl, clickableOf, usableCues, controlSelector } from '../extract/page-control.mjs';
import { findNextPage } from '../extract/next-page.mjs';
import { readAnnouncedTotal } from '../extract/list-total.mjs';
import { overlayControls } from '../extract/overlays.mjs';
import { sanitizePaginationMemo, patchPaginationMemo } from '../extract/pagination-memo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const site = (name) => parseHTML(zlib.gunzipSync(fs.readFileSync(path.join(HERE, '..', '..', 'core', '__tests__', 'fixtures', 'sites', `${name}.html.gz`))).toString('utf8')).document;
const doc = (html) => parseHTML(`<html><body>${html}</body></html>`).document;
const HZ = 'https://www.hydrozone.fr/755-ph-perfect-base-nutrients';
const P1 = site('hydrozone.fr.listing-p1');
const P2 = site('hydrozone.fr.listing-p2');
const suivant = (d) => [...d.querySelectorAll('b')].find((b) => b.textContent.trim() === 'Suivant');

test('hydrozone: the « Suivant » the user clicks is a bare <a href> — the cues climb to its stable parent (0.7.32 kept nothing)', () => {
  const b = suivant(P1);
  const a = clickableOf(b);
  assert.equal(a.tagName, 'A'); assert.deepEqual([...a.attributes].map((x) => x.name), ['href'], 'no id, class or attribute on the link itself');
  const cues = controlCues(b, P1, { kind: 'next', pageUrl: HZ });
  assert.equal(cues.selector, '#pagination_next_bottom > a');
  assert.equal(P1.querySelector(cues.selector), a);
  assert.equal(cues.text, 'Suivant');
  assert.equal(cues.block, 'ul.pagination');
  assert.deepEqual(cues.param, { name: 'p', kind: 'page' });
  assert.deepEqual(findNextPage(P1, HZ, { learned: cues, mode: 'button' }), { href: `${HZ}?p=2`, how: 'learned' });
});

test('hydrozone page 2 is the last page: the shown control is found disabled, and no ?p=3 is invented', () => {
  const cues = controlCues(suivant(P1), P1, { kind: 'next', pageUrl: HZ });
  const hit = findControl(P2, cues);
  assert.ok(hit && hit.disabled, 'the « Suivant » of the last page is a <span> in a disabled item');
  assert.equal(findNextPage(P2, `${HZ}?p=2`, { learned: cues, mode: 'button' }), null);
  assert.equal(findNextPage(P2, `${HZ}?p=2`, { mode: 'auto' }), null, 'auto: the disabled « Suivant » is the end, not a ?p=3 guess');
  assert.deepEqual(findNextPage(P1, HZ, { mode: 'auto' }), { href: `${HZ}?p=2`, how: 'next-control' }, 'page 1 auto still finds page 2');
});

test('a control is found again when its selector no longer matches: text in its block, counts made generic, label of an icon', () => {
  const d1 = doc('<div class="grid"></div><div class="load-more-wrap"><span>24 sur 80</span><button class="css-a1b2c3 btn">Voir plus (24)</button><a href="/aide">Aide</a></div>');
  const cues = controlCues(d1.querySelector('button'), d1, { kind: 'load_more' });
  assert.equal(cues.text, 'Voir plus (24)');
  const d2 = doc('<div class="grid"></div><div class="load-more-wrap"><span>48 sur 80</span><button class="css-z9y8x7 btn">Voir plus (48)</button><a href="/aide">Aide</a></div>');
  const hit = findControl(d2, { ...cues, selector: 'button.does-not-match' });
  assert.equal(hit.el.textContent, 'Voir plus (48)'); assert.equal(hit.disabled, false);
  const d3 = doc('<div class="load-more-wrap"><button class="btn" disabled>Voir plus (0)</button><a href="/aide">Aide</a></div>');
  assert.equal(findControl(d3, { ...cues, selector: null }).disabled, true, 'a spent « charger plus » reads as the end');
  const icon = doc('<nav class="pagination"><a href="?page=1">1</a><a class="x1" href="?page=2" aria-label="Page suivante"><svg></svg></a></nav>');
  const ic = controlCues(icon.querySelector('svg'), icon, { kind: 'next', pageUrl: 'https://s.test/c' });
  assert.equal(ic.label, 'Page suivante');
  assert.equal(findControl(doc('<nav class="pagination"><a href="?page=2">2</a><a class="x9" href="?page=3" aria-label="Page suivante"><svg></svg></a></nav>'), { ...ic, selector: null }).el.getAttribute('href'), '?page=3');
});

test('nothing to keep: an element without text, label or stable mark is refused (never a silent « nothing kept »)', () => {
  const d = doc('<div><div><div><span></span></div></div></div>');
  assert.equal(usableCues(controlCues(d.querySelector('span'), d)), false);
  // A selector kept by 0.7.32 still works
  assert.deepEqual(findNextPage(doc('<a class="xyz-arrow" href="/c/2">→</a>'), 'https://s.test/c', { learned: 'a.xyz-arrow' }), { href: 'https://s.test/c/2', how: 'learned' });
  assert.equal(controlSelector(null, d), null);
});

test('the announced total: « Résultats 1 - 24 sur 32 » on hydrozone; ranges and counts; a cart, a rating or two totals are not one', () => {
  assert.deepEqual(readAnnouncedTotal(P1), { total: 32, text: 'Résultats 1 - 24 sur 32.', kind: 'range' });
  assert.equal(readAnnouncedTotal(P2).total, 32);
  assert.equal(readAnnouncedTotal(doc('<p class="toolbar-amount">Showing 1–24 of 1,312 results</p>')).total, 1312);
  assert.deepEqual(readAnnouncedTotal(doc('<div class="products-count">80 artikelen</div>')), { total: 80, text: '80 artikelen', kind: 'count' });
  assert.equal(readAnnouncedTotal(doc('<div class="mini-cart">3 articles</div><span class="rating">4,5 sur 5</span>')), null);
  assert.equal(readAnnouncedTotal(doc('<p>1 - 24 sur 32</p><p>1 - 24 sur 90</p>')), null, 'the page says two things');
  assert.equal(readAnnouncedTotal(doc('<p>Livraison offerte dès 100 € d’achat</p>')), null);
});

test('cookie banners and pop-ups: « Rejeter tout » first, else ×; never « Accepter »; a human check is never touched', () => {
  const hz = overlayControls(P1);
  assert.equal(hz.controls[0].textContent.replace(/\s+/g, ' ').trim(), 'Rejeter tout', 'hydrozone: the lgcookieslaw banner is refused');
  const acceptOnly = overlayControls(doc('<div id="cookie-banner"><p>Cookies</p><button>J’accepte</button></div>'));
  assert.equal(acceptOnly.controls.length, 0); assert.equal(acceptOnly.acceptOnly, 1);
  const promo = overlayControls(doc('<div class="newsletter-popup"><p>-10 %</p><button class="popup-close" aria-label="Fermer">×</button><button>Je m’inscris</button></div>'));
  assert.equal(promo.controls[0].getAttribute('aria-label'), 'Fermer');
  assert.equal(overlayControls(doc('<div role="dialog"><iframe src="https://x.test/captcha"></iframe><button>Fermer</button></div>')).controls.length, 0);
});

test('the per-site memo: validated, a 0.7.32 selector migrated, a part set to null forgotten', () => {
  assert.equal(sanitizePaginationMemo({ mode: 'weird', junk: 1 }), null);
  assert.deepEqual(sanitizePaginationMemo({ next: 'a.next' }), { v: 1, next: { v: 1, kind: 'next', selector: 'a.next' } });
  const m = sanitizePaginationMemo({ mode: 'button', next: { selector: '#x > a', text: 'Suivant', param: { name: 'p', kind: 'page' }, onclick: 'alert(1)' }, lastTest: { ok: true, added: 8, before: 24, after: 8, mode: 'button', at: '2026-10-28T10:00:00.000Z' } });
  assert.equal(m.next.onclick, undefined); assert.equal(m.lastTest.added, 8);
  const p = patchPaginationMemo(m, { next: null }, '2026-10-28T11:00:00.000Z');
  assert.equal(p.next, undefined); assert.equal(p.mode, 'button');
  assert.equal(patchPaginationMemo({ next: 'a' }, { next: null }), null, 'nothing left: forgotten');
});
