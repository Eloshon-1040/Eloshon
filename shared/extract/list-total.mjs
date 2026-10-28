/**
 * The number of products a list announces (« Résultats 1 - 24 sur 32 », « Showing 1–24 of 312 results »,
 * « 32 produits »), read from the page text so a run can stop when it has them all and say at the end
 * whether the count matches. Conservative: a short text in a counting / toolbar / pagination block, and
 * null when the page announces different totals (a cart count, a rating, a filter facet are not a total).
 * Portable (browser + linkedom), no site rule.
 */

const NUM = '(\\d{1,3}(?:[ .,\\u00a0\\u202f]\\d{3})+|\\d{1,7})';
// « 1 - 24 sur 32 », « 1–24 of 312 », « 25 à 48 de 120 », « 1-24 van 80 », « 1 bis 24 von 80 »
const RANGE = new RegExp(`\\b\\d{1,7}\\s*(?:-|–|—|à|a|to|tot|bis|al)\\s*\\d{1,7}\\s*(?:sur|of|de|van|von|di|op|du total de)\\s*${NUM}`, 'i');
// « 32 produits », « 312 results », « 80 artikelen » (the noun right after the number)
const COUNT = new RegExp(`(?:^|[^\\d])${NUM}\\s*(?:produits?|articles?|article\\(s\\)|résultats?|resultats?|références|results?|products?|items?|artikelen|resultaten|producten|artikel|ergebnisse|produkte|productos|resultados|artículos|prodotti|risultati|articoli)\\b`, 'i');
const HINT = /(count|total|result|amount|toolbar|showing|pagin|pager|summary|number|nb-?prod|items?-?found|product-?count|heading)/i;
const SKIP = 'script, style, noscript, template, select, option, [class*="cart" i], [id*="cart" i], [class*="basket" i], [class*="facet" i], [class*="filter" i], [class*="rating" i], [class*="review" i]';

const toInt = (s) => { const n = Number(String(s).replace(/[ .,  ]/g, '')); return Number.isInteger(n) && n > 0 && n < 10000000 ? n : null; };
const own = (el) => String(el.textContent || '').replace(/\s+/g, ' ').trim();

/**
 * @param {Document} doc
 * @returns {{total:number, text:string, kind:'range'|'count'}|null}  kind: « 1 - 24 sur 32 » (range) or « 32 produits » (count)
 */
export function readAnnouncedTotal(doc) {
  if (!doc || !doc.body) return null;
  const found = new Map(); // total → {text, kind} of the first element that said it
  for (const el of doc.body.querySelectorAll('*')) {
    if (el.closest && el.closest(SKIP)) continue;
    const t = own(el);
    if (!t || t.length > 90) continue;
    // The innermost element saying it (its children do not say it alone).
    if ([...el.children].some((c) => { const ct = own(c); return ct.length >= 3 && (RANGE.test(ct) || COUNT.test(ct)); })) continue;
    const marks = `${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''} ${(el.parentElement && el.parentElement.getAttribute('class')) || ''}`;
    let m = t.match(RANGE); let kind = 'range';
    if (!m && HINT.test(marks)) { m = t.match(COUNT); kind = 'count'; }
    if (!m) continue;
    const n = toInt(m[1]);
    if (n != null && (!found.has(n) || (kind === 'range' && found.get(n).kind !== 'range'))) found.set(n, { text: t.slice(0, 90), kind });
  }
  if (found.size !== 1) return null; // none, or the page says different things
  const [[total, said]] = [...found];
  return { total, text: said.text, kind: said.kind };
}
