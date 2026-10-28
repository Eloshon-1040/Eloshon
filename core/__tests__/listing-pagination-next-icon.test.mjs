/**
 * A "next page" link whose content is an inline icon (a long SVG) with the word only
 * in aria-label is still the next-page link — the shape of a results page whose
 * pagination is cursor-based (the href carries an opaque token). Offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPagination } from '../listing-pagination.mjs';

const PAGE = 'https://stays.test/s/ville/homes';
const svg = `<svg viewBox="0 0 32 32" aria-hidden="true" role="presentation" focusable="false" style="display:block;fill:none;height:12px;width:12px;stroke:currentColor;stroke-width:5.33333;overflow:visible"><path d="m12 4 11.3 11.3a1 1 0 0 1 0 1.4L12 28" fill="none"></path><g><circle cx="1" cy="1" r="1"></circle><circle cx="2" cy="2" r="1"></circle><circle cx="3" cy="3" r="1"></circle></g></svg>`;

test('next link carried by aria-label around a long SVG icon → next-link mechanism, href resolved (entities decoded)', () => {
  const html = `<html><body><nav aria-label="Pagination"><a aria-label="Précédent" href="${PAGE}?cursor=aaa">${svg}</a><a aria-label="Suivant" variant="isolated" href="/s/ville/homes?ref=1&amp;cursor=eyJpdGVtc19vZmZzZXQiOjE4fQ%3D%3D">${svg}</a></nav></body></html>`;
  const s = detectPagination(html, PAGE);
  assert.equal(s.nextLink, 'https://stays.test/s/ville/homes?ref=1&cursor=eyJpdGVtc19vZmZzZXQiOjE4fQ%3D%3D');
});

test('a page without any next word has no next link', () => {
  const s = detectPagination(`<html><body><a href="/s/ville/homes?cursor=x">${svg}</a></body></html>`, PAGE);
  assert.equal(s.nextLink, null);
});
