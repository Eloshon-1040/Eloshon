/**
 * The next page of a list: the control the user showed, rel=next, a « suivant » control (never
 * « précédent », never disabled), the next page number, a page parameter. Offline (linkedom).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { findNextPage, nextControlSelector } from '../extract/next-page.mjs';

const doc = (html) => parseHTML(`<html><body>${html}</body></html>`).document;
const URL0 = 'https://shop.test/c/parfums';

test('rel="next" first; a « Suivant » link; « Précédent » and disabled controls are never taken', () => {
  assert.deepEqual(findNextPage(doc('<a rel="next" href="/c/parfums?page=2">2</a>'), URL0), { href: 'https://shop.test/c/parfums?page=2', how: 'rel-next' });
  assert.deepEqual(findNextPage(doc('<nav class="pagination"><a href="/c/parfums?page=1">Précédent</a><a href="/c/parfums?page=3">Suivant</a></nav>'), URL0), { href: 'https://shop.test/c/parfums?page=3', how: 'next-control' });
  assert.equal(findNextPage(doc('<nav class="pagination"><a href="/c/p?page=4" class="prev">‹</a><button class="pagination-next" disabled>Suivant</button></nav>'), URL0), null, 'last page: only a disabled next');
});

test('a « next » button without a link is clicked (stable selector); the next page number after the current one', () => {
  const r = findNextPage(doc('<div class="pager"><button class="pager-next" aria-label="Page suivante">›</button></div>'), URL0);
  assert.equal(r.how, 'next-control'); assert.match(r.selector, /aria-label="Page suivante"|pager-next/);
  const n = findNextPage(doc('<ul class="pagination"><li><a href="/c/parfums?p=1">1</a></li><li class="active"><span>2</span></li><li><a href="/c/parfums?p=3">3</a></li></ul>'), URL0);
  assert.deepEqual(n, { href: 'https://shop.test/c/parfums?p=3', how: 'page-number' });
});

test('the control the user showed for the site comes first; a page parameter is the last resort', () => {
  const d = doc('<a class="xyz-arrow" href="/c/parfums/2">→</a><a rel="next" href="/elsewhere">x</a>');
  assert.deepEqual(findNextPage(d, URL0, { learned: 'a.xyz-arrow' }), { href: 'https://shop.test/c/parfums/2', how: 'learned' });
  assert.deepEqual(findNextPage(doc('<div class="grid"></div>'), 'https://shop.test/c/parfums?page=2'), { href: 'https://shop.test/c/parfums?page=3', how: 'url-param' });
  assert.equal(findNextPage(doc('<div class="grid"></div>'), URL0), null, 'no sign of pages: nothing invented');
  assert.deepEqual(findNextPage(doc('<div class="grid"></div>'), URL0, { mode: 'url' }), { href: 'https://shop.test/c/parfums?page=2', how: 'url-param' });
});

test('nextControlSelector prefers a stable attribute and resolves to the control', () => {
  const d = doc('<nav><a class="css-1x2y3z pagination__next" href="#" data-testid="pagination-next">›</a></nav>');
  const el = d.querySelector('a');
  const sel = nextControlSelector(el, d);
  assert.equal(sel, 'a[data-testid="pagination-next"]'); assert.equal(d.querySelector(sel), el);
});
