/**
 * The NEXT page of a list, found the ways list scrapers do (Web Scraper's pagination types, Octoparse's
 * "Paginate" tip, Instant Data Scraper's learned Next): the control the user showed for this site, a
 * rel="next" link, a « suivant / next / › » control, the page number after the current one, then a page
 * parameter in the address. Never a « précédent » control, never a disabled one. Portable (browser +
 * linkedom), no site rule.
 */
import { nextPageUrl } from './paginate-url.mjs';
import { controlSelector, pathSelector, findControl, isDisabled } from './page-control.mjs';

const NEXT_TEXT = /^(suivant|suivante|page suivante|next|next page|volgende|volgende pagina|weiter|nächste|nächste seite|siguiente|successivo|próxima|›|»|>|→|>>)$/i;
const NEXT_HINT = /(^|[-_ ])(next|suivant|pagination-next|pager-next|arrow-right|chevron-right)([-_ ]|$)/i;
const PREV_HINT = /(prev|previous|précédent|precedent|vorige|zurück|anterior|back|‹|«)/i;
const text = (el) => String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
const label = (el) => `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('rel') || ''}`.trim();

const disabled = isDisabled;
const usableHref = (el, base) => {
  const h = el.getAttribute && el.getAttribute('href');
  if (!h || /^(#|javascript:)/i.test(h.trim())) return null;
  try { return new URL(h, base).href; } catch { return null; }
};

/** A stable selector for a control (its own marks, else a stable ancestor + the path below it) — see page-control.mjs. */
export const nextControlSelector = controlSelector;

/**
 * @param {Document} doc @param {string} pageUrl
 * @param {{learned?:object|string|null, mode?:string, visible?:(el:Element)=>boolean}} [o]  mode: auto | button | url;
 *   learned: the cues of the control the user showed (page-control.mjs), or a selector kept by an older version
 * @returns {{href:string, how:string}|{selector:string, how:string}|null}
 */
export function findNextPage(doc, pageUrl, { learned = null, mode = 'auto', visible } = {}) {
  const here = String(pageUrl).split('#')[0];
  const ok = (href) => href && href.split('#')[0] !== here;
  if (mode !== 'url') {
    // 1) the control the user showed for this site (its cues: selector, text, block…)
    if (learned) {
      const hit = findControl(doc, learned, visible ? { visible } : {});
      if (hit && hit.disabled) return null; // the learned control is there but disabled: last page
      if (hit) { const href = usableHref(hit.el, pageUrl); return ok(href) ? { href, how: 'learned' } : { selector: pathSelector(hit.el, doc), how: 'learned' }; }
    }
    // 2) rel="next"
    for (const el of doc.querySelectorAll('link[rel~="next"], a[rel~="next"]')) { const href = usableHref(el, pageUrl); if (ok(href)) return { href, how: 'rel-next' }; }
    // 3) a « next » control by its text, label or class (never « previous », never disabled)
    const cands = [...doc.querySelectorAll('a, button, [role="button"], [role="link"]')].filter((el) => {
      const t = text(el); const l = label(el); const c = el.getAttribute('class') || '';
      if (PREV_HINT.test(`${t} ${l} ${c}`) && !NEXT_TEXT.test(t)) return false;
      return (t.length <= 20 && NEXT_TEXT.test(t)) || /\b(next|suivant|suivante|volgende|weiter|siguiente)\b/i.test(l) || NEXT_HINT.test(c);
    });
    // A « next » control WITH a link is followed at once; one that must be clicked waits until no link
    // to the next page number exists (opening an address is more reliable than a click).
    let clickNext = null;
    for (const el of cands) {
      if (disabled(el)) continue;
      const href = usableHref(el, pageUrl);
      if (ok(href)) return { href, how: 'next-control' };
      if (!clickNext) { const sel = nextControlSelector(el, doc); if (sel) clickNext = { selector: sel, how: 'next-control' }; }
    }
    if (cands.length && cands.every(disabled)) return null; // only a disabled « next »: last page
    // A « next » that lost its link on the last page (PrestaShop: a <span> in a disabled <li>) is the same evidence.
    const ghostNext = !cands.length && [...doc.querySelectorAll('li, span')].some((el) => NEXT_TEXT.test(text(el)) && disabled(el));
    // 4) the page number after the current one
    const cur = doc.querySelector('[aria-current="page"], .pagination .active, .pagination .current, [class*="pagination"] [class*="active"], [class*="pager"] [class*="current"]');
    const n = cur ? parseInt(text(cur), 10) : NaN;
    if (Number.isFinite(n)) {
      const target = [...doc.querySelectorAll('a, button')].find((el) => text(el) === String(n + 1) && !disabled(el));
      if (target) { const href = usableHref(target, pageUrl); if (ok(href)) return { href, how: 'page-number' }; if (!clickNext) { const sel = nextControlSelector(target, doc); if (sel) return { selector: sel, how: 'page-number' }; } }
    }
    if (clickNext) return clickNext;
    if (ghostNext) return null;
  }
  // 5) a page parameter in the address (?page=2 / /page/2) — the loop's « nothing new » guard stops a site that ignores it
  if (mode === 'url' || mode === 'auto') {
    const u = nextPageUrl(pageUrl);
    if (ok(u) && (mode === 'url' || /[?&](page|p|pg|paged|pn)=\d+|\/page\/\d+/i.test(pageUrl) || doc.querySelector('[class*="pagination"], nav[aria-label*="agination"]'))) return { href: u, how: 'url-param' };
  }
  return null;
}
