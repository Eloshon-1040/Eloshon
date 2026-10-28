/**
 * What covers a list before a pagination click: a cookie banner, a newsletter or promo pop-up. The
 * controls returned close it the most private way — « Refuser » / « Continuer sans accepter » first,
 * else a close (×) control — and NEVER « Accepter »: a banner that only offers to accept is left
 * open (the click on the list control does not need it gone). Never inside a human check.
 * Portable (browser + linkedom): the page passes `isOverlay` (fixed / sticky position) when it can.
 */

const HINTED = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="gdpr" i], [class*="gdpr" i], [id*="didomi" i], [id*="onetrust" i], [id*="axeptio" i], [id*="tarteaucitron" i], [id*="cookiebot" i], [id*="CybotCookiebot" i], [class*="modal" i], [class*="popup" i], [id*="popup" i], [class*="newsletter" i], [id*="newsletter" i]';
const CONTROL = 'button, a, [role="button"], input[type="button"], input[type="submit"]';
const REFUSE = /^(tout refuser|refuser( tout| et fermer)?|je refuse|tout rejeter|rejeter( tout)?|continuer sans accepter|non merci|reject( all)?|decline( all)?|deny|no thanks|alles weigeren|weigeren|nee,? bedankt|alle ablehnen|ablehnen|rechazar( todo| todas)?|rifiuta( tutto)?|only (necessary|essential)( cookies)?|uniquement (les )?(cookies )?(nécessaires|essentiels)|nécessaires uniquement)$/i;
const REFUSE_MARK = /(^|[-_ ])(reject|refuse|decline|deny|disagree)([-_ ]|$)/i;
const CLOSE_TEXT = /^(×|✕|✖|x|fermer|close|sluiten|schließen|cerrar|chiudi)$/i;
const CLOSE_MARK = /(^|[-_ ])(close|fermer|dismiss|sluiten|schliessen|cerrar|chiudi)([-_ ]|$)/i;
const ACCEPT = /(accept|j'accepte|agree|akkoord|zustimmen|aceptar|accetta|autoriser|allow all|tout autoriser)/i;
const CHALLENGE = 'iframe[src*="captcha" i], iframe[src*="challenge" i], [id*="captcha" i], [class*="captcha" i], #challenge-form, .cf-turnstile';

const txt = (el) => String(el.textContent || el.getAttribute('value') || '').replace(/\s+/g, ' ').trim();
const marks = (el) => `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''}`;

/**
 * @param {Document} doc
 * @param {{isOverlay?:(el:Element)=>boolean, visible?:(el:Element)=>boolean, extra?:Element[]}} [o]
 * @returns {{controls:Element[], acceptOnly:number}}  controls to click (one per overlay); overlays left open because only « accept » was offered
 */
export function overlayControls(doc, { isOverlay = () => true, visible = () => true, extra = [] } = {}) {
  if (!doc || !doc.body) return { controls: [], acceptOnly: 0 };
  const boxes = [...new Set([...doc.querySelectorAll(HINTED), ...extra])]
    .filter((el) => el && el.querySelector && !/^(script|style|template|noscript|link|meta)$/i.test(el.tagName) && isOverlay(el) && visible(el))
    // the outermost box only (a dialog inside a cookie wrapper is one overlay)
    .filter((el, _, all) => !all.some((o) => o !== el && o.contains(el)));
  const controls = []; let acceptOnly = 0;
  for (const box of boxes) {
    if (box.querySelector(CHALLENGE)) continue; // never touch a human check
    const ctl = [...box.querySelectorAll(CONTROL)].filter((c) => visible(c) && !c.hasAttribute('disabled'));
    const refuse = ctl.find((c) => !ACCEPT.test(txt(c)) && (REFUSE.test(txt(c)) || REFUSE_MARK.test(marks(c))));
    const close = ctl.find((c) => !ACCEPT.test(txt(c)) && (CLOSE_TEXT.test(txt(c)) || CLOSE_MARK.test(marks(c))));
    const pick = refuse || close;
    if (pick) controls.push(pick);
    else if (ctl.some((c) => ACCEPT.test(txt(c)))) acceptOnly++;
  }
  return { controls: controls.slice(0, 4), acceptOnly };
}
