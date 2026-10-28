/**
 * Browser fallback (Playwright) — used ONLY for pages whose product data
 * appears after client-side rendering. HTTP stays the default; the engine
 * calls this only when a page is detected as JS-required, and caps how many
 * pages get rendered. Protections are DETECTED via the shared classifier and
 * reported — never bypassed (no captcha solving, no challenge evasion).
 *
 * Enable: `pnpm add -D playwright && npx playwright install chromium` (done).
 */
import { classifyResponse } from './detect.mjs';
import { detectLocale } from './url-context.mjs';
import { extraHeaders } from './http-fetcher.mjs';
import { expandFoldedSections } from '../shared/knowledge/pick-block.mjs';

let _pw = null; // cached playwright module, or false if unavailable

// Resource types that carry no product data and only slow a render down. Blocking
// them (headless only) is a safe ~25% speedup; document/script/xhr/fetch/stylesheet
// are always allowed so JS rendering and data requests still work.
export const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);

// Listing collection keeps images: the card detector's 60px gate needs real
// rendered sizes, and lazy images with no HTML dimensions collapse to 0x0 when
// blocked. Costs roughly 0.5-2 MB of image bandwidth per listing page; fiche
// renders keep the full blocking above.
export const LISTING_BLOCKED_RESOURCE_TYPES = new Set(['media', 'font']);

/**
 * Whether a session should block heavy sub-resources. Only in headless mode and
 * when not explicitly disabled — NEVER when headful (manual intervention needs
 * the page to look normal for a human).
 */
export function shouldBlockResources(opts = {}) {
  return opts.disableResources !== false && opts.headless !== false;
}

/**
 * Runs IN THE PAGE (serialized by Playwright). Generic product-card detection by
 * repeated STRUCTURE, not URL pattern (so PrestaShop `/123-slug`, Magento,
 * Shopify, custom slugs all work): a card is the SMALLEST element that holds a
 * link + a price — an image enriches the card but is NOT required (image-less
 * or lazy-0x0 products still count). This is the DOM equivalent of "find
 * similar" and is robust across platforms. Returns one entry per unique product
 * URL; `priceText` is left raw for the Node side to parse (currency-aware).
 * @param {{ learnedContainer?: string|null }} [opts] — a learned link_filter
 *   container selector: when it matches, Pass B only harvests anchors under it.
 * Exported for offline tests (linkedom); production runs it via page.evaluate.
 */
export function _cardsInPage(opts) {
  const learnedContainer = (opts && typeof opts === 'object' && opts.learnedContainer) || null;
  const MONEY = /(?:€|\$|£|CHF|kr|zł)\s?\d[\d .,]*\d|\d[\d .,]*\d\s?(?:€|\$|£|CHF|EUR|USD|GBP|kr|zł)|\d+[.,]\d{2}\s?(?:€|\$|£)/i;
  const NON_PRODUCT = /\/(cart|panier|warenkorb|wishlist|favoris|verlanglijst|login|signin|account|mon-compte|compte|konto|compare|comparer|checkout|caisse)(\/|\?|$)/i;
  const abs = (h) => { try { return new URL(h, location.href).href.split('#')[0]; } catch { return null; } };
  const txt = (el) => (el && el.textContent || '').replace(/\s+/g, ' ').trim();
  // Text of a price element. A cents fragment set apart in <sup>/<sub> ("€" "15"
  // <sup>99</sup>) gets its decimal separator back — textContent glues it into
  // "€1599", a price 100 times too high. Same rule as priceFromEl
  // (shared/extract/card-recipe.mjs): only when the digits before carry no decimal
  // of their own. Inlined (runs in page context, no imports).
  const priceTxt = (el) => {
    let s = '';
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) { s += c.nodeValue; continue; }
        if (c.nodeType !== 1 || /^(script|style|noscript|template)$/i.test(c.tagName)) continue;
        if (/^(sup|sub)$/i.test(c.tagName)) {
          const d = (c.textContent || '').replace(/\s+/g, '');
          if (/^\d{1,3}$/.test(d) && /\d[.,]\d+\s*$/.test(s)) continue;   // footnote mark after a whole price ("€9,99" <sup>1</sup>)
          if (/^\d{1,3}$/.test(d) && /\d\s*$/.test(s)) { s += ',' + d; continue; }
        }
        walk(c);
      }
    };
    if (el) walk(el);
    return s.replace(/\s+/g, ' ').trim();
  };
  const host = location.hostname.replace(/^www\./, '');
  // Registrable domain, so a fiche on a locale/region subdomain (nl.aliexpress.com,
  // fr./m. twins) is still "same site". Inlined (runs in page context, no imports).
  const PUBLIC_SLD = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'go', 'or', 'ne', 'gouv']);
  const reg = (hn) => { const p = String(hn || '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean); return p.length <= 2 ? p.join('.') : p.slice(-(PUBLIC_SLD.has(p[p.length - 2]) ? 3 : 2)).join('.'); };
  const siteReg = reg(location.hostname);
  const MONEY_G = new RegExp(MONEY.source, 'ig');
  const realPrice = (s) => /[1-9]/.test(s || ''); // "€00"/"0,00" → not a real product price
  // A srcset parsed as the HTML spec says (this function runs inside the page: no import — the same algorithm
  // as shared/extract/images.mjs parseSrcset): a URL is a run of non-whitespace (commas inside it are part of
  // it), the largest candidate wins. Never a split on a bare comma.
  const bestOfSrcset = (ss) => {
    const s = String(ss || ''); let i = 0; let best = null; let score = -1;
    const sp = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
    while (i < s.length) {
      while (i < s.length && (sp(s[i]) || s[i] === ',')) i++;
      if (i >= s.length) break;
      const st = i; while (i < s.length && !sp(s[i])) i++;
      let u = s.slice(st, i); let d = '';
      if (/,$/.test(u)) u = u.replace(/,+$/, ''); else { while (i < s.length && s[i] !== ',') d += s[i++]; i++; }
      if (!u || /^data:/i.test(u)) continue;
      const m = /(\d+(?:\.\d+)?)([wx])/i.exec(d); const sc = m ? Number(m[1]) * (m[2].toLowerCase() === 'x' ? 1000 : 1) : 0;
      if (sc > score) { best = u; score = sc; }
    }
    return best;
  };
  const imgSrc = (img) => {
    const s = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || '';
    if (s && !/^data:/.test(s)) return s;
    return bestOfSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset'));
  };
  const byUrl = new Map();
  const cardEls = new Set(); // card elements already emitted by either pass (same element -> one card)
  // A rating as a card writes it: "4,75 sur 5" / "4.6 out of 5" / "4,62 (134)" / "★ 4.8".
  const RATING = /(\d(?:[.,]\d{1,2})?)\s*(?:\/\s*5|sur\s*5|out of 5|von 5|op 5|de 5|su 5)\b|(?:^|[^\d.,])(\d(?:[.,]\d{1,2})?)\s*\(\s*(\d[\d\s.,]*)\s*\)|^[★☆⭐]\s*(\d(?:[.,]\d{1,2}))$/i;
  const ownTxt = (el) => { let s = ''; for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent; return s.replace(/\s+/g, ' ').trim(); };
  // The CONTAINER test for a climb: an element holding several distinct same-site
  // links and several money tokens is a row / grid of cards, never one card. (One
  // card may carry a few links to its own page and a price repeated for screen
  // readers — those are not distinct links.)
  const isContainer = (el) => {
    const hrefs = new Set(); let money = 0;
    for (const x of el.querySelectorAll('a[href]')) { const u = abs(x.getAttribute('href')); if (u && !NON_PRODUCT.test(u)) { try { if (reg(new URL(u).hostname) === siteReg) hrefs.add(u); } catch { /* bad url */ } } if (hrefs.size >= 3) break; }
    if (hrefs.size < 3) return false;
    for (const x of el.querySelectorAll('*')) { const t = ownTxt(x); if (t && t.length <= 40 && MONEY.test(t)) { money++; if (money >= 3) return true; } }
    return false;
  };
  // Shared card emitter; `img` is null for price-anchored (image-less) cards.
  const emit = (card, img, seedAnchor) => {
    if (cardEls.has(card)) return;
    const anchors = [...card.querySelectorAll('a[href]')];
    const a = seedAnchor || anchors.find((x) => { const u = abs(x.getAttribute('href')); return u && !NON_PRODUCT.test(u); }) || anchors[0];
    const url = a && abs(a.getAttribute('href'));
    if (!url || NON_PRODUCT.test(url) || byUrl.has(url)) return;
    let sameSite = false, path = ''; try { const uu = new URL(url); sameSite = reg(uu.hostname) === siteReg; path = uu.pathname; } catch { /* bad url */ }
    if (!sameSite) return;
    if (path === '/' || path.length < 2 || /^\/[a-z]{2}(_[A-Z]{2})?\/?$/.test(path)) return; // homepage / locale-root banner, not a product
    // Name: a real heading is cleanest (a tag, or an element whose attribute names it
    // a title). When there is none, the card's own ARIA name (aria-labelledby /
    // aria-label — the way a listing card names itself), then a descriptive img alt,
    // else the link text stripped of the price token and trailing CTA word, else the
    // first short text line that is neither a price nor a rating.
    const heading = card.querySelector('h1,h2,h3,h4,[class*="name" i],[class*="title" i],[data-testid*="title" i],[data-testid*="name" i],[id*="title" i]');
    let name = (heading && txt(heading)) || null;
    if (!name) {
      const labelled = card.getAttribute('aria-labelledby') || (card.querySelector('[aria-labelledby]') && card.querySelector('[aria-labelledby]').getAttribute('aria-labelledby'));
      if (labelled) name = labelled.split(/\s+/).map((id) => { const el = document.getElementById(id); return el ? txt(el) : ''; }).filter(Boolean).join(' ').trim() || null;
    }
    if (!name) { const al = (card.getAttribute('aria-label') || '').trim(); if (al.length >= 3 && al.length <= 200 && !MONEY.test(al)) name = al; }
    if (!name) {
      const alt = (img && (img.getAttribute('alt') || '').trim()) || '';
      const cleaned = ((a && txt(a)) || '').replace(MONEY_G, ' ').replace(/\b(d[ée]tails?|details|voir(?: plus)?|bekijk|see|ver|kopen|buy)\b/ig, ' ').replace(/\s{2,}/g, ' ').trim();
      name = (alt.length >= 5 ? alt : '') || cleaned || alt || null;
    }
    // Secondary lines (sub-title, dates, host type) + rating, from the card's own
    // short text leaves — never the name, never a money token, never a bare number.
    const lines = []; let rating = null; let reviewCount = null;
    for (const el of card.querySelectorAll('*')) {
      const t = ownTxt(el);
      if (!t || t.length > 80) continue;
      const rm = t.match(RATING);
      if (rm) { const r = parseFloat((rm[1] || rm[2] || rm[4] || '').replace(',', '.')); if (r >= 0 && r <= 5) { if (rating == null) rating = r; if (rm[3] && reviewCount == null) { const c = parseInt(rm[3].replace(/[\s.,]/g, ''), 10); if (Number.isFinite(c)) reviewCount = c; } } continue; }
      if (MONEY.test(t) || /^[\d\s.,:/%-]+$/.test(t) || t.length < 2 || /^(script|style|noscript|template)$/i.test(el.tagName)) continue;
      if (/^(photo|image|slide|diapo|foto|afbeelding|bild)\s*\d+/i.test(t)) continue; // a carousel counter ("Photo 1 sur 6"), not a line of the card
      if (!lines.includes(t) && lines.length < 4) lines.push(t);
    }
    if (!name) name = lines[0] || null;
    if (!name || name.length < 2) return; // a product card has a name
    const subtitle = lines.filter((l) => l !== name && !name.includes(l)).slice(0, 3);
    // Price: read it from the SMALLEST element whose own text is a money token, not
    // the whole card — card text glues the price to sibling rating/review numbers
    // ("€1,473.74" + "4.9" + "311"), which makes the greedy regex over-capture.
    let priceText = null;
    for (const el of card.querySelectorAll('*')) { const t = priceTxt(el); if (t && t.length <= 40 && MONEY.test(t)) { const m = t.match(MONEY); if (m && realPrice(m[0]) && (!priceText || t.length < priceText.length)) priceText = t; } }
    const pm = (priceText || priceTxt(card)).match(MONEY);
    const src = img ? imgSrc(img) : null;
    const out = { url, name: name.slice(0, 300), priceText: pm ? pm[0].trim() : null, image: src ? abs(src) : null };
    // The words after the amount ("au total", "par nuit") travel with the price text.
    if (priceText && pm && priceText.length > pm[0].length) out.priceLine = priceText.slice(0, 60);
    if (subtitle.length) out.subtitle = subtitle.join(' · ').slice(0, 200);
    if (rating != null) { out.rating = rating; if (reviewCount != null) out.reviewCount = reviewCount; }
    byUrl.set(url, out);
    cardEls.add(card);
  };
  // Pass A1 — image-anchored (images are far fewer than all elements). For each
  // sizeable image, climb to the smallest ancestor that also holds a link and a
  // real price: that ancestor is the card. Fast: bounded climb, textContent only
  // on ancestors, no getComputedStyle sweep. The 60px gate stays (icons/logos).
  // The climb reaches 16 levels (a listing card nests its price 10 to 12 levels
  // deep) and stops at a row / grid container instead of emitting it as a card.
  for (const img of document.querySelectorAll('img')) {
    const r = img.getBoundingClientRect();
    if (r.width < 60 || r.height < 60) continue; // skip icons / logos / trackers
    let card = null;
    for (let el = img.parentElement, up = 0; el && el !== document.body && up < 16; el = el.parentElement, up++) {
      if (el.querySelector('a[href]')) { const pm = txt(el).match(MONEY); if (pm && realPrice(pm[0])) { if (!isContainer(el)) card = el; break; } }
    }
    if (!card) continue;
    emit(card, img, img.closest('a[href]'));
  }
  // Pass A2 — price-anchored complement: a link+price product with no usable
  // image (missing, lazy at 0x0, or under the 60px gate) still makes a card
  // (image: null; downstream tolerates it). Only OWN-text money tokens seed the
  // climb, so a grid container's glued text never matches.
  for (const el of (document.body ? document.body.querySelectorAll('*') : [])) {
    if (/^(script|style|noscript|template)$/i.test(el.tagName)) continue;
    const t = ownTxt(el);
    if (!t || t.length > 40 || !MONEY.test(t)) continue;
    const m = t.match(MONEY); if (!m || !realPrice(m[0])) continue;
    let card = null;
    for (let node = el, up = 0; node && node !== document.body && up < 16; node = node.parentElement, up++) {
      if (node.querySelector('a[href]')) { if (!isContainer(node)) card = node; break; }
    }
    if (!card) continue;
    emit(card, null, el.closest('a[href]'));
  }
  // Pass B — recall via the learned product-URL template. When a card's price sits
  // OUTSIDE its tight element, the image climb overshoots to a grid-level ancestor
  // and several images dedupe onto one URL (measured on 2ememain: ~12 of ~30). Here
  // we learn the URL signature (first path segment + a trailing numeric id) of the
  // price-validated cards, then harvest every same-signature anchor — so the whole
  // grid comes through. Safe: with zero price-validated cards there is no signature,
  // so nav/menu links never turn into products.
  const idRe = /(?:^|[\/_-])[a-z]?\d{4,}(?:[-._]|$)/i;
  const sig = (u) => { try { const uu = new URL(u); if (reg(uu.hostname) !== siteReg) return null; const segs = uu.pathname.split('/').filter(Boolean); if (!segs.length) return null; return segs[0] + '|' + (segs.some((s) => idRe.test(s)) ? 'id' : 'x'); } catch { return null; } };
  const productSigs = new Set();
  for (const u of byUrl.keys()) { const s = sig(u); if (s && s.endsWith('|id')) productSigs.add(s); }
  // Learned link_filter container (recipe): when it matches, harvest only the
  // anchors UNDER it — nav/header/footer twins stay out. No recipe, or a
  // non-matching selector -> page-wide sweep, unchanged.
  const scopeRoot = (() => { if (!learnedContainer) return document; try { return document.querySelector(learnedContainer) || document; } catch { return document; } })();
  if (productSigs.size) {
    for (const a of scopeRoot.querySelectorAll('a[href]')) {
      const url = abs(a.getAttribute('href'));
      if (!url || byUrl.has(url) || NON_PRODUCT.test(url)) continue;
      const s = sig(url); if (!s || !productSigs.has(s)) continue;
      const scope = a.closest('li,article') || a.parentElement || a;
      const img2 = a.querySelector('img') || (scope && scope.querySelector('img'));
      const heading = scope && scope.querySelector('h1,h2,h3,h4,[class*="name" i],[class*="title" i]');
      let name = (heading && txt(heading)) || (img2 && img2.getAttribute('alt')) || (a && txt(a)) || null;
      if (name) name = name.replace(MONEY_G, ' ').replace(/\b(d[ée]tails?|details|voir(?: plus)?|bekijk|see|ver|kopen|buy)\b/ig, ' ').replace(/\s{2,}/g, ' ').trim();
      if (!name || name.length < 2) continue;
      let priceText = null;
      if (scope) for (const el of scope.querySelectorAll('*')) { const t = priceTxt(el); if (t && t.length <= 40 && MONEY.test(t)) { const m = t.match(MONEY); if (m && realPrice(m[0]) && (!priceText || t.length < priceText.length)) priceText = t; } }
      const src = img2 ? imgSrc(img2) : null;
      byUrl.set(url, { url, name: name.slice(0, 300), priceText, image: src ? abs(src) : null });
    }
  }
  return [...byUrl.values()];
}

/**
 * Runs IN THE PAGE (serialized by Playwright), armed by BrowserSession.captureClick.
 * Two jobs:
 *  1. Paints an on-page guidance overlay — a fixed top bar telling the user what to
 *     do ("Click a product to teach this site") with a persistent Cancel — so the
 *     headful window is never a bare, mysterious Chromium. Same "act in this window"
 *     idiom as the app's manual-intervention flow, injected onto the target page.
 *  2. Installs a ONE-SHOT capture-phase click listener that intercepts the first
 *     product-anchor click: it stops the click from navigating/routing, records the
 *     clicked anchor's ancestor path (tag + id + classes, bounded) and the full
 *     rendered DOM, and posts them to the `__eloshonTeachCapture` binding. Clicks
 *     that resolve to no `a[href]` (consent buttons, scrollbars, plain controls) —
 *     and any click inside the overlay — are left alone so the user can reach the
 *     grid first. Cancel posts to `__eloshonTeachCancel`.
 * `labels` carries the localized strings ({instruction, cancel}); it falls back to
 * English so the overlay is never blank. Self-contained: no imports, no outer refs
 * (Playwright ships only the function body to the browser).
 * Exported for the capture-mechanism test (driven via page.evaluate).
 */
export function _installTeachCapture(labels) {
  if (window.__eloshonTeachArmed) return;
  window.__eloshonTeachArmed = true;
  const L = labels || {};
  const OVERLAY_ID = '__eloshon_teach_overlay';
  try {
    if (!document.getElementById(OVERLAY_ID)) {
      const bar = document.createElement('div');
      bar.id = OVERLAY_ID;
      bar.setAttribute('role', 'status');
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;align-items:center;gap:14px;padding:13px 18px;background:#0A1650;color:#fff;font:600 14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 2px 16px rgba(0,0,0,.35);';
      const dot = document.createElement('span');
      dot.style.cssText = 'flex:0 0 auto;width:9px;height:9px;border-radius:50%;background:#8AB4FF;';
      const txt = document.createElement('span');
      txt.style.cssText = 'flex:1 1 auto;';
      txt.textContent = L.instruction || 'Click a product to teach this site';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = L.cancel || 'Cancel';
      btn.style.cssText = 'flex:0 0 auto;cursor:pointer;border:1px solid rgba(255,255,255,.55);background:transparent;color:#fff;font:600 13px system-ui,sans-serif;padding:6px 15px;border-radius:8px;';
      btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); try { window.__eloshonTeachCancel(); } catch (_e) { /* torn down */ } }, true);
      bar.appendChild(dot); bar.appendChild(txt); bar.appendChild(btn);
      (document.body || document.documentElement).appendChild(bar);
    }
  } catch (_e) { /* overlay is best-effort; capture still works without it */ }
  const pathOf = (el) => {
    const out = [];
    for (let e = el; e && e.nodeType === 1 && out.length < 6; e = e.parentElement) {
      out.push({ tag: e.tagName.toLowerCase(), id: e.id || undefined, classes: [...e.classList] });
      if (e.tagName === 'BODY') break;
    }
    return out;
  };
  const onClick = (ev) => {
    if (window.__eloshonTeachDone) return;
    if (ev.target && ev.target.closest && ev.target.closest('#' + OVERLAY_ID)) return; // the overlay's own controls
    const a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;                                      // not a link — consent/nav/scroll, let it through
    const href = a.getAttribute('href') || '';
    if (!href || href === '#' || /^(javascript:|mailto:|tel:)/i.test(href)) return;
    ev.preventDefault(); ev.stopPropagation();           // don't let the card route away before we snapshot
    window.__eloshonTeachDone = true;
    try {
      window.__eloshonTeachCapture({
        role: 'product-link',
        pageUrl: location.href,
        href,
        anchorPath: pathOf(a),
        domSnapshot: '<!doctype html>' + document.documentElement.outerHTML,
      });
    } catch (_e) { /* binding already torn down */ }
  };
  document.addEventListener('click', onClick, true);
}

export async function browserAvailable() {
  if (_pw === false) return false;
  if (_pw) return true;
  try { _pw = await import('playwright'); return true; } catch { _pw = false; return false; }
}

/**
 * A reusable browser session: one Chromium instance + context shared across
 * many renders (fast), closed once at the end of a run.
 */
/**
 * BCP-47 context locale derived from the TARGET URL (/nl-BE/, /de-DE/, a ccTLD),
 * so the render speaks the URL's own language. A fr-BE context on an nl-BE
 * listing makes the SPA rebuild its product links in French, and the discovery
 * locale filter then (correctly) drops every one of them — the browser lane's
 * version of the wrong-language-catalogue bug. Null when the URL says nothing.
 */
export function contextLocaleFor(url) {
  if (!url) return null;
  try {
    const loc = detectLocale(url);
    let country = loc.country;
    if (!country) {
      const tld = (new URL(url).hostname.split('.').pop() || '').toUpperCase();
      if (/^[A-Z]{2}$/.test(tld) && tld !== 'CO') country = tld;
    }
    if (!loc.language) return null; // a country alone does not pick a language
    return country ? `${loc.language}-${country.toUpperCase()}` : loc.language;
  } catch { return null; }
}

export class BrowserSession {
  /** @param {{ headless?:boolean, userAgent?:string, userDataDir?:string, locale?:string,
   *            onIntervention?:(info:{url:string,code:string,reason:string,page:object})=>Promise<'retry'|'skip'>}} [opts] */
  constructor(opts = {}) { this.opts = opts; this._browser = null; this._ctx = null; this.stats = { bytes: 0, responses: 0 }; }

  async _ensure(forUrl) {
    if (this._ctx) return this._ctx;
    if (!(await browserAvailable())) throw new Error('playwright not installed');
    const headless = this.opts.headless !== false;
    // Light, Node-native anti-automation hardening (opt-out via stealth:false).
    // Removes the obvious "I'm automated" signals (the AutomationControlled blink
    // feature + navigator.webdriver + missing chrome/languages/plugins) so
    // mid-tier bot walls treat the session like an ordinary Chromium. It does NOT
    // solve CAPTCHAs and does NOT reliably pass Cloudflare Turnstile — hard
    // challenges still surface for manual intervention (never auto-bypassed).
    const stealth = this.opts.stealth !== false;
    const args = stealth ? ['--disable-blink-features=AutomationControlled'] : [];
    // Explicit opts.locale wins; otherwise the FIRST rendered URL pins the
    // context locale (one session serves one job/origin); fr-BE stays the
    // historical fallback for URLs that carry no locale at all.
    const locale = this.opts.locale || contextLocaleFor(forUrl) || 'fr-BE';
    const ctxOpts = { userAgent: this.opts.userAgent, locale, viewport: { width: 1366, height: 900 } };
    if (this.opts.userDataDir) {
      // Persistent profile → keeps cookies/logins across pages and jobs.
      this._ctx = await _pw.chromium.launchPersistentContext(this.opts.userDataDir, { headless, args, ...ctxOpts });
    } else {
      this._browser = await _pw.chromium.launch({ headless, args });
      this._ctx = await this._browser.newContext(ctxOpts);
    }
    // Bytes-downloaded accounting (Item 6 — measure real bandwidth per job before
    // any proxy is connected; proxies bill per GB). ZERO-OVERHEAD by design: read
    // the already-parsed `content-length` from each response header synchronously —
    // no CDP round-trip and no `response.body()`/`request.sizes()` call, so it never
    // slows a render or reduces crawl throughput. It undercounts chunked responses
    // that omit content-length, so it is a documented LOWER BOUND (compressed wire
    // size when gzipped — the figure a per-GB proxy would actually bill). Never
    // fatal: any error just skips that response.
    try {
      this._ctx.on('response', (resp) => {
        try { const cl = resp.headers()['content-length']; if (cl) { this.stats.bytes += parseInt(cl, 10) || 0; this.stats.responses += 1; } } catch { /* skip */ }
      });
    } catch { /* proceed without byte accounting */ }
    if (stealth) {
      try {
        await this._ctx.addInitScript(() => {
          try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch { /* ignore */ }
          try { if (!window.chrome) window.chrome = { runtime: {} }; } catch { /* ignore */ }
          try { if (!navigator.plugins || !navigator.plugins.length) Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] }); } catch { /* ignore */ }
        });
        // languages must match the context locale (a fr-BE list under an nl-BE
        // context is itself an automation signal — and the wrong catalogue hint).
        await this._ctx.addInitScript((langs) => {
          try { if (!navigator.languages || !navigator.languages.length) Object.defineProperty(navigator, 'languages', { get: () => langs }); } catch { /* ignore */ }
        }, [...new Set([locale, locale.split('-')[0], 'en'])]);
      } catch { /* proceed without init script */ }
    }
    return this._ctx;
  }

  /**
   * Speed: drop heavy sub-resources on headless renders (never headful, so a
   * human solving a challenge still sees a normal page). PER PAGE, not per
   * context, so listings and fiche renders can block different sets (listings
   * keep images for the card-size gate). Non-fatal if routing fails.
   */
  async _blockResources(page, types) {
    if (!shouldBlockResources(this.opts)) return;
    try {
      await page.route('**/*', (route) => {
        if (types.has(route.request().resourceType())) route.abort('aborted').catch(() => {});
        else route.continue().catch(() => {});
      });
    } catch { /* proceed without resource blocking */ }
  }

  /**
   * Render one URL. Waits for a useful signal (JSON-LD / Product), not a fixed
   * sleep. If a protection/login is detected AND an onIntervention handler is
   * set, it PAUSES for a human to act manually (no bypass), then re-reads the
   * page. Returns rendered HTML + a block classification.
   * @returns {Promise<{ html:string|null, status:number, block:object|null, error:string|null }>}
   */
  async render(url, { timeoutMs = 30000, waitFor, intervene = true, expand = false } = {}) {
    let ctx;
    try { ctx = await this._ensure(url); } catch (e) { return { html: null, status: 0, block: null, error: e.message }; }
    const page = await ctx.newPage();
    try {
      await this._blockResources(page, BLOCKED_RESOURCE_TYPES);
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      try { await page.waitForSelector(waitFor || 'script[type="application/ld+json"], [itemtype*="Product"]', { timeout: 8000 }); } catch { /* proceed */ }
      // A product page read for its taught blocks: its folded sections are opened first (same code as the extension).
      if (expand) { try { const n = await page.evaluate(`(${expandFoldedSections.toString()})(document, 12)`); if (n) await page.waitForTimeout(900); } catch { /* read what is there */ } }
      let status = resp ? resp.status() : 200;
      let html = await page.content();
      let block = classifyResponse({ status, url: page.url(), requestedUrl: url, body: html });

      // Manual intervention loop (CAPTCHA / challenge / login / consent).
      for (let round = 0; block.terminal && intervene !== false && this.opts.onIntervention && round < 3; round++) {
        const decision = await this.opts.onIntervention({ url, code: block.code, reason: block.reason, page });
        if (decision === 'skip') break;
        try { await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs }); } catch { /* keep current */ }
        html = await page.content();
        block = classifyResponse({ status: 200, url: page.url(), requestedUrl: url, body: html });
      }
      return { html, status, block, error: null };
    } catch (e) {
      return { html: null, status: 0, block: classifyResponse({ status: 0, error: e?.name === 'TimeoutError' ? 'timeout' : (e?.message || 'render error') }), error: e?.message || String(e) };
    } finally {
      try { await page.close(); } catch { /* ignore */ }
    }
  }

  /** Best-effort accept of a cookie/consent banner (top document + iframes) so the
   *  catalogue content actually loads. Generic label match; a miss is harmless. */
  async _acceptConsent(page) {
    const rxSrc = "^(accept all|accept|agree|allow all|allow cookies|i agree|tout accepter|j.accepte|accepter( tout)?|alles accepteren|alles toestaan|alle akzeptieren|akzeptieren|zustimmen|aceptar( todo)?|accetta( tutto)?|consent|got it|ok(,? got it)?|continue)$";
    for (const frame of page.frames()) {
      try {
        const clicked = await frame.evaluate((s) => {
          const rx = new RegExp(s, 'i');
          const el = [...document.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]')]
            .find((b) => rx.test(((b.textContent || b.value || '').replace(/\s+/g, ' ').trim())));
          if (el) { el.click(); return true; } return false;
        }, rxSrc);
        if (clicked) return true;
      } catch { /* frame not accessible */ }
    }
    return false;
  }

  /**
   * Render a listing/catalogue page (JS run, cookie banner accepted, load-more +
   * infinite-scroll exhausted) and return, from the RENDERED DOM: the product
   * CARDS (url + name + priceText + image, via generic repeated-structure
   * detection), every anchor href, and the final HTML (so the structured
   * extractors can also run on it). No product classification here — that stays
   * in discover.mjs. Honours the intervention handler; never bypasses a block.
   * Opts: `learnedContainer` (learned link_filter container selector — scopes
   * Pass B of the card detector) and `consentSelector` (learned consent button,
   * clicked best-effort before collection).
   * @returns {Promise<{ cards:object[], links:string[], html:string|null, blocked:object|null, error:string|null }>}
   */
  async collectListing(url, { timeoutMs = 30000, maxScrolls = 12, productReSource = '\\/(product|produit|products|produits|p|dp|item|artikel|pd)\\/', learnedContainer = null, consentSelector = null, recipeCard = null, recipeUrlSelector = null, stopAt = null, overallTimeoutMs = null, captureApi = null } = {}) {
    let ctx;
    try { ctx = await this._ensure(url); } catch (e) { return { cards: [], links: [], html: null, blocked: null, error: e.message }; }
    const page = await ctx.newPage();
    // Hard ceiling for the WHOLE collection, enforced on the Node side: a page call
    // can stay pending forever (measured: a call issued while the page reloads itself
    // after the cookie banner click stays bound to the dead document, and even
    // page.close() then does not settle). Past the deadline the function returns
    // what was already collected with error 'deadline' — the job never hangs here.
    // The clock is paused while a human handles a manual intervention.
    const budgetMs = overallTimeoutMs != null ? overallTimeoutMs : timeoutMs + 15000 + maxScrolls * 6000;
    let deadlineHit = false, deadline = null, left = budgetMs, armedAt = 0, fire;
    const deadlineP = new Promise((resolve) => { fire = () => { deadlineHit = true; resolve(); }; });
    const arm = () => { armedAt = Date.now(); deadline = setTimeout(fire, Math.max(0, left)); };
    const pause = () => { clearTimeout(deadline); left -= Date.now() - armedAt; };
    arm();
    const cardsByUrl = new Map();
    const linksSet = new Set();
    // Learned recipe card (optional): every matching card's outerHTML is kept,
    // keyed by its product URL, on EVERY step — so a virtualized list that
    // recycles rows still yields each card once; the caller replays its recipe
    // on these snapshots (same field rules as the HTTP replay).
    const recipeCards = new Map();
    // Optional: watch the requests the page itself sends to its listing API (same
    // path as the API request the HTTP pagination could not complete). Keep the
    // request headers — filtered: never a cookie or a credential — and the latest
    // JSON answer, so the caller can continue that pagination over plain HTTP.
    const apiCap = { headers: null, lastUrl: null, lastJson: null, requests: 0 };
    if (captureApi && captureApi.pathname) {
      const match = (u) => { try { return new URL(u).pathname === captureApi.pathname; } catch { return false; } };
      page.on('request', (req) => { try { if (req.method() !== 'GET' || !match(req.url())) return; apiCap.requests++; req.allHeaders().then((h) => { const f = extraHeaders(h); if (Object.keys(f).length) apiCap.headers = f; }).catch(() => {}); } catch { /* ignore */ } });
      page.on('response', (resp) => { try { if (resp.request().method() !== 'GET' || !match(resp.url()) || !resp.ok()) return; resp.json().then((j) => { apiCap.lastUrl = resp.url(); apiCap.lastJson = j; }).catch(() => {}); } catch { /* ignore */ } });
    }
    const apiCapture = () => (apiCap.headers ? { headers: apiCap.headers, lastUrl: apiCap.lastUrl, lastJson: apiCap.lastJson, requests: apiCap.requests } : null);
    const partial = (error) => ({ cards: [...cardsByUrl.values()], links: [...linksSet], html: null, blocked: null, error, recipeCardsHtml: recipeCard ? [...recipeCards.values()] : null, apiCapture: apiCapture() });
    // One page call, bounded: a call that does not answer in time, or whose document
    // was replaced by a navigation, is retried on the current document after a short
    // settle (twice at most), then gives up.
    const EVAL_MS = 15000;
    const ev = async (fn, arg) => {
      for (let attempt = 0; ; attempt++) {
        if (deadlineHit) throw new Error('deadline');
        let timer;
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('evaluate_timeout')), EVAL_MS); });
        try { return await Promise.race([page.evaluate(fn, arg), timeout]); }
        catch (e) {
          const msg = String(e && e.message || e);
          if (attempt >= 2 || !/evaluate_timeout|context was destroyed|navigation/i.test(msg)) throw e;
          try { await page.waitForLoadState('domcontentloaded', { timeout: 5000 }); } catch { /* proceed */ }
          await new Promise((r) => setTimeout(r, 1000));
        } finally { clearTimeout(timer); }
      }
    };
    const pageHtml = () => ev(() => (document.doctype ? '<!DOCTYPE html>' : '') + document.documentElement.outerHTML);
    const work = async () => {
      await this._blockResources(page, LISTING_BLOCKED_RESOURCE_TYPES); // images stay on: the card gate measures real sizes
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* proceed */ }
      // Learned consent selector (captured from a user click) first, then the
      // generic label matcher. Both best-effort; a miss is harmless. Accepting the
      // banner may reload the page: let that navigation start and settle first.
      let consentClicked = false;
      if (consentSelector) { try { await page.click(consentSelector, { timeout: 1500 }); consentClicked = true; } catch { /* best-effort */ } }
      try { consentClicked = (await this._acceptConsent(page)) || consentClicked; } catch { /* non-fatal */ }
      if (consentClicked) {
        await new Promise((r) => setTimeout(r, 1500));
        try { await page.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch { /* proceed */ }
      }

      // Protection detection + optional manual intervention (no bypass).
      let block = classifyResponse({ status: 200, url: page.url(), requestedUrl: url, body: await pageHtml() });
      for (let round = 0; block.terminal && this.opts.onIntervention && round < 3; round++) {
        pause();
        let d; try { d = await this.opts.onIntervention({ url, code: block.code, reason: block.reason, page }); } finally { arm(); }
        if (d === 'skip') break;
        try { await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs }); } catch { /* keep */ }
        try { await this._acceptConsent(page); } catch { /* non-fatal */ }
        block = classifyResponse({ status: 200, url: page.url(), requestedUrl: url, body: await pageHtml() });
      }
      if (block.terminal) return { cards: [], links: [], html: null, blocked: { code: block.code, reason: block.reason }, error: null };

      // Load-more / infinite-scroll loop, bounded. Cards + links are ACCUMULATED on
      // every step (not read once at the end): a virtualized list recycles the top
      // rows out of the DOM as you scroll, so a single final pass would only ever
      // see the current ~window. Keyed by URL, so re-seen rows merge for free.
      const LOAD_MORE = /load more|charger plus|voir plus|afficher plus|show more|plus de produits|see more|more products|meer|mehr|más|charger|weitere/i;
      const collect = async () => {
        // With a learned recipe card the generic card detector is not needed (the
        // caller reads the recipe snapshots) — and it is the costly pass on a heavy DOM.
        if (!recipeCard) {
          const cs = await ev(_cardsInPage, { learnedContainer, productReSource });
          for (const c of (cs || [])) if (c && c.url && !cardsByUrl.has(c.url)) cardsByUrl.set(c.url, c);
        }
        const ls = await ev(() => [...document.querySelectorAll('a[href]')].map((a) => a.href));
        for (const l of ls) linksSet.add(l);
        if (recipeCard) {
          const rc = await ev(({ card, urlSel }) => {
            const out = [];
            let els = []; try { els = [...document.querySelectorAll(card)]; } catch { return out; }
            for (const el of els) {
              let a = null; try { a = urlSel ? el.querySelector(urlSel) : null; } catch { a = null; }
              if (!a) a = el.querySelector('a[href]') || el.closest('a[href]');
              const key = (a && a.href) || (el.textContent || '').trim().slice(0, 120);
              if (key) out.push({ key, html: el.outerHTML });
            }
            return out;
          }, { card: recipeCard, urlSel: recipeUrlSelector });
          for (const c of (rc || [])) if (!recipeCards.has(c.key)) recipeCards.set(c.key, c.html);
        }
      };
      const size = () => (recipeCard ? recipeCards.size : cardsByUrl.size);
      // The list must stay on its own page: a click that leads elsewhere (a menu
      // link whose text happens to contain "mehr"/"more") ends the collection, and
      // nothing from the other page is read.
      const pathOf = (u) => { try { return new URL(u).pathname.replace(/\/+$/, ''); } catch { return null; } };
      const listPath = pathOf(page.url());
      const onList = () => pathOf(page.url()) === listPath;
      await collect(); // initial viewport (a short, non-virtualized page may be complete here)
      let stale = 0;
      let clickUseless = false; // a "load more" match that loaded nothing is not clicked again
      for (let i = 0; i < maxScrolls; i++) {
        if (stopAt != null && size() >= stopAt) break; // enough products for the job
        const beforeCards = size();
        const beforeLinks = await ev(() => document.querySelectorAll('a[href]').length);
        // "Load more" control: a button (or button-like element), or a link that stays
        // on this same list page (#, javascript:, or the same path with a page query).
        // Short label only, so a whole menu or a "learn more" block never matches.
        const clicked = clickUseless ? false : await ev((rxSrc) => {
          const rx = new RegExp(rxSrc, 'i');
          const here = location.pathname.replace(/\/+$/, '');
          const staysHere = (a) => {
            const h = (a.getAttribute('href') || '').trim();
            if (!h || h === '#' || /^javascript:/i.test(h)) return true;
            try { return new URL(h, location.href).pathname.replace(/\/+$/, '') === here; } catch { return false; }
          };
          const el = [...document.querySelectorAll('button, a, [role="button"]')].find((b) => {
            const t = (b.textContent || '').replace(/\s+/g, ' ').trim();
            if (!t || t.length > 40 || !rx.test(t)) return false;
            if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
            return b.tagName !== 'A' || staysHere(b);
          });
          if (el) { el.click(); return true; }
          return false;
        }, LOAD_MORE.source);
        // Always scroll too: infinite lists load on scroll, and a matched control may not be the real one.
        await ev(() => window.scrollTo(0, document.body.scrollHeight));
        // NOTE: Playwright signature is (fn, arg, options) — the timeout MUST be the
        // 3rd arg (a previous order put it as the arg, ignored, so every scroll waited
        // the 30s default). Growth may be in anchors OR in newly-rendered virtualized
        // rows, so we also give a short settle before re-collecting.
        try { await page.waitForFunction((n) => document.querySelectorAll('a[href]').length > n, beforeLinks, { timeout: 4000 }); }
        catch { /* virtualized lists may not grow the anchor count — collect anyway */ }
        await page.waitForTimeout(350); // let just-revealed rows load their images (card needs a sized <img>)
        if (listPath != null && !onList()) break; // navigated away: keep what this list gave
        await collect();
        // Stop when neither cards nor the DOM keep growing for two rounds.
        if (size() <= beforeCards) { if (clicked) clickUseless = true; if (++stale >= 2) break; } else stale = 0;
      }

      const links = [...linksSet];
      const cards = [...cardsByUrl.values()];
      // Pagination targets read from RENDERED anchor semantics (aria-label / rel /
      // numbered text), not URL guessing — so a "/p/2/" path (2ememain), a "?page=2"
      // query, or a numbered control are all followed generically, and we don't
      // mistake a "/p/2" page link for a "/p/<slug>" product. Absolute hrefs.
      const away = listPath != null && !onList(); // another page: its links/HTML are not this list's
      let pageLinks = [];
      if (!away) try { pageLinks = await ev(() => {
        const rx = /\b(next|suivant|volgende|weiter|siguiente|n[aä]chste|pagina|p[aá]gina|page)\b/i;
        const out = new Set();
        for (const a of document.querySelectorAll('a[href]')) {
          const aria = a.getAttribute('aria-label') || '';
          const rel = a.getAttribute('rel') || '';
          const t = (a.textContent || '').trim();
          const href = a.getAttribute('href') || '';
          if (rel === 'next' || rx.test(aria) || (/^\d{1,3}$/.test(t) && /(\/p(?:age)?\/\d|[?&](?:page|p)=\d|page-\d)/i.test(href))) out.add(a.href);
        }
        return [...out];
      }); } catch { /* optional: the cards already collected stand */ }
      let html = null; if (!away) try { html = await pageHtml(); } catch { /* the cards already collected stand */ }
      return { cards: cards || [], links: [...new Set(links)], pageLinks, html, blocked: null, error: null, recipeCardsHtml: recipeCard ? [...recipeCards.values()] : null, apiCapture: apiCapture() };
    };
    try {
      const r = await Promise.race([work().catch((e) => partial(deadlineHit ? 'deadline' : (e?.message || String(e)))), deadlineP.then(() => partial('deadline'))]);
      return r;
    } finally {
      clearTimeout(deadline);
      // Never wait on a page that stopped answering (close is bounded too).
      await Promise.race([page.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    }
  }

  /**
   * Render ONE page and return the JSON answers to the requests the page itself
   * makes (fetch / XHR, GET, HTTP 2xx): their URL, their request headers (filtered:
   * never a cookie, a credential or a browser-managed header) and the parsed body
   * (bounded). Used to learn where a product page gets its stock and reviews.
   * Scrolls once (reviews often load near the bottom). Bounded on the Node side.
   * @returns {Promise<{captures:Array<{url:string, headers:object, json:any, bytes:number}>, error:string|null}>}
   */
  async captureJson(url, { timeoutMs = 30000, maxCaptures = 60, maxBytes = 400000 } = {}) {
    let ctx;
    try { ctx = await this._ensure(url); } catch (e) { return { captures: [], error: e.message }; }
    const page = await ctx.newPage();
    const captures = [];
    const pending = new Set();
    page.on('response', (resp) => {
      const p = (async () => {
        try {
          const req = resp.request();
          if (req.method() !== 'GET' || !['fetch', 'xhr'].includes(req.resourceType()) || resp.status() < 200 || resp.status() >= 300) return;
          if (captures.length >= maxCaptures) return;
          const body = await resp.text();
          if (!body || body.length > maxBytes || !/^\s*[[{]/.test(body)) return;
          let json; try { json = JSON.parse(body); } catch { return; }
          const headers = extraHeaders(await req.allHeaders());
          captures.push({ url: resp.url(), headers, json, bytes: body.length });
        } catch { /* body gone / page closed */ }
      })();
      pending.add(p); p.finally(() => pending.delete(p));
    });
    const work = async () => {
      await this._blockResources(page, BLOCKED_RESOURCE_TYPES);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch { /* proceed */ }
      let clicked = false; try { clicked = await this._acceptConsent(page); } catch { /* non-fatal */ }
      if (clicked) { await new Promise((r) => setTimeout(r, 1500)); try { await page.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch { /* proceed */ } }
      try { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); } catch { /* proceed */ }
      try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* proceed */ }
      await new Promise((r) => setTimeout(r, 1500));
      await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, 3000))]);
      return { captures, error: null };
    };
    let timer;
    try {
      return await Promise.race([
        work().catch((e) => ({ captures, error: e?.message || String(e) })),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ captures, error: 'deadline' }), timeoutMs + 30000); }),
      ]);
    } finally {
      clearTimeout(timer);
      await Promise.race([page.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    }
  }

  /** Backward-compatible wrapper: rendered anchor hrefs only. */
  async collectLinks(url, opts = {}) {
    const r = await this.collectListing(url, opts);
    return { links: r.links, blocked: r.blocked, error: r.error };
  }

  /**
   * Click-to-learn CAPTURE. Opens the page in the (headful) session and waits for
   * the user to click ONE product link, then returns the capture the pure
   * derivers (core/link-learn.mjs) consume: `{ role, pageUrl, href, anchorPath,
   * domSnapshot }`. A capture-phase listener PREVENTS the navigation the click
   * would trigger (so an SPA card doesn't route away before we snapshot), records
   * the anchor's ancestor path + the full rendered DOM, and hands it back over an
   * exposed binding. The listener re-installs after every in-page navigation, so
   * the user may browse to the right listing first. Only anchor clicks are
   * intercepted — cookie/consent buttons, scrolling and non-link controls pass
   * through untouched, so the user can reach the grid normally.
   *
   * Never bypasses anything and never guesses: it returns exactly what the human
   * pointed at; the derivers decide whether that yields a valid recipe.
   * @param {string} url
   * @param {{ timeoutMs?:number, signal?:AbortSignal, labels?:{instruction?:string,cancel?:string} }} [opts]
   *   `signal` lets the caller cancel (the user closed the teach panel); `timeoutMs`
   *   bounds the wait; `labels` localizes the on-page guidance overlay.
   * @returns {Promise<{ capture:object|null, error:string|null }>}
   *   error is 'cancelled' | 'closed' | 'timeout' | a launch/nav message.
   */
  async captureClick(url, { timeoutMs = 180000, signal, labels } = {}) {
    let ctx;
    try { ctx = await this._ensure(url); } catch (e) { return { capture: null, error: e.message }; }
    const page = await ctx.newPage();
    let settle;
    const captured = new Promise((resolve) => { settle = resolve; });
    try {
      // Bindings persist across this page's navigations, so they are installed once,
      // before the first goto: one for the captured click, one for the overlay Cancel.
      await page.exposeFunction('__eloshonTeachCapture', (payload) => settle({ capture: payload, error: null }));
      await page.exposeFunction('__eloshonTeachCancel', () => settle({ capture: null, error: 'cancelled' }));
      const install = () => page.evaluate(_installTeachCapture, labels || null).catch(() => { /* frame gone / not ready */ });
      page.on('load', install);                          // re-arm after each in-page navigation
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try { await this._acceptConsent(page); } catch { /* non-fatal */ }
      await install();                                   // arm the current document
      const timeout = new Promise((resolve) => setTimeout(() => resolve({ capture: null, error: 'timeout' }), timeoutMs));
      const cancel = new Promise((resolve) => {
        if (!signal) return;
        if (signal.aborted) return resolve({ capture: null, error: 'cancelled' });
        signal.addEventListener('abort', () => resolve({ capture: null, error: 'cancelled' }), { once: true });
      });
      const closed = new Promise((resolve) => { page.on('close', () => resolve({ capture: null, error: 'closed' })); });
      return await Promise.race([captured, timeout, cancel, closed]);
    } catch (e) {
      return { capture: null, error: e?.message || String(e) };
    } finally {
      try { await page.close(); } catch { /* ignore */ }
    }
  }

  /** Cookies this session's context has accumulated (for a browser→HTTP handoff). */
  async cookies() {
    try { return this._ctx ? await this._ctx.cookies() : []; } catch { return []; }
  }

  /** Close the session within `timeoutMs`; past it, the browser process is killed, so
   *  a close that hangs never holds the job (pending page operations then reject). */
  async close({ timeoutMs = 10000 } = {}) {
    const ctx = this._ctx; const browser = this._browser;
    this._ctx = null; this._browser = null;
    const graceful = (async () => {
      try { if (ctx) await ctx.close(); } catch { /* ignore */ }
      try { if (browser) await browser.close(); } catch { /* ignore */ }
    })();
    let timer;
    const late = new Promise((r) => { timer = setTimeout(() => r('late'), timeoutMs); });
    const outcome = await Promise.race([graceful.then(() => 'closed'), late]);
    clearTimeout(timer);
    if (outcome === 'late') {
      for (const owner of [browser, ctx && typeof ctx.browser === 'function' ? ctx.browser() : null]) {
        try { const p = owner && typeof owner.process === 'function' ? owner.process() : null; if (p) p.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }
  }
}

/** One-off render (kept for convenience / tests). Prefer BrowserSession in a run. */
export async function renderPage(url, opts = {}) {
  if (!(await browserAvailable())) return { html: null, available: false, error: 'playwright not installed' };
  const s = new BrowserSession({ userAgent: opts.userAgent });
  try { const r = await s.render(url, opts); return { html: r.html, available: true, error: r.error, block: r.block }; }
  finally { await s.close(); }
}
