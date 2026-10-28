/**
 * In-page runner — injected into the target tab by the service worker via
 * chrome.scripting. It is the "hands" in the real page: it reads the live DOM and
 * embedded state, drives waits/clicks/typing, and (for the internal-api mode)
 * runs fetch in the page so the site's own cookies/session apply. It never
 * clicks or types inside a challenge and never handles secrets.
 *
 * Injected as a classic content script; it dynamically imports the VENDORED
 * shared modules (web-accessible) so extraction uses the same code as the app —
 * no remote code, no eval.
 *
 * Exposes globalThis.__eloRunner with async methods the service worker calls via
 * chrome.scripting.executeScript(func).
 */
(() => {
  if (globalThis.__eloRunner) return; // idempotent injection

  const url = (p) => chrome.runtime.getURL(p);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lc = (s) => String(s == null ? '' : s).toLowerCase();
  const absUrl = (v) => { if (!v || typeof v !== 'string') return v || null; try { return new URL(v, location.href).href; } catch { return v; } };

  async function sharedFieldMap() { return import(url('vendor/shared/extract/field-map.mjs')); }

  function readContext() {
    // The server's own answer time (request → first byte), from Navigation Timing: what the pacer must
    // weigh, not the whole page build (scripts, images, trackers), which says nothing about a strained site.
    let serverMs = null;
    try { const n = performance.getEntriesByType('navigation')[0]; if (n && n.responseStart > 0 && n.requestStart > 0) serverMs = Math.round(n.responseStart - n.requestStart); } catch { serverMs = null; }
    return { url: location.href, body: document.documentElement ? document.documentElement.outerHTML : '', serverMs };
  }

  async function waitFor({ selector, url_includes, state_key, timeout_ms } = {}) {
    const deadline = Date.now() + (timeout_ms || 10000);
    for (;;) {
      if (selector && document.querySelector(selector)) return true;
      if (url_includes && location.href.includes(url_includes)) return true;
      if (state_key && findState(state_key) != null) return true;
      if (!selector && !url_includes && !state_key) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  }

  async function click(selector, { optional, reveal } = {}) {
    const el = document.querySelector(selector);
    if (!el) { if (optional) return false; throw new Error(`élément introuvable: ${selector}`); }
    // A pagination control: brought into view first (some lists only arm it once seen), then clicked.
    if (reveal) { try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch { /* old engine */ } await sleep(300); }
    el.click();
    return true;
  }

  // Shown on screen (laid out, not hidden): a control the user could click.
  const shown = (el) => { try { if (!el.getClientRects().length) return false; const st = getComputedStyle(el); return st.visibility !== 'hidden' && st.display !== 'none'; } catch { return true; } };

  async function typeInto(selector, value, { submit } = {}) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`champ introuvable: ${selector}`);
    el.focus();
    el.value = value == null ? '' : String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (submit && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
    return true;
  }

  async function selectOption(selector, { value, label } = {}) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`select introuvable: ${selector}`);
    if (value != null) el.value = String(value);
    else if (label != null) {
      const opt = [...el.options].find((o) => lc(o.textContent).includes(lc(label)));
      if (opt) el.value = opt.value;
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  async function scroll({ selector, to, times, pause_ms } = {}) {
    const target = selector ? document.querySelector(selector) : window;
    const n = times || 1;
    for (let i = 0; i < n; i++) {
      if (target === window) window.scrollTo(0, to === 'top' ? 0 : document.body.scrollHeight);
      else if (target) target.scrollTop = to === 'top' ? 0 : target.scrollHeight;
      await sleep(pause_ms || 400);
    }
    return true;
  }

  // Find an embedded-state blob by a known global/script key (generic).
  function findState(key) {
    try {
      if (key && key in window && window[key] != null) return window[key];
      const el = document.querySelector(`script#${CSS.escape(key)}`) || [...document.scripts].find((s) => s.id === key);
      if (el && el.textContent) { try { return JSON.parse(el.textContent); } catch { return el.textContent; } }
    } catch { /* ignore */ }
    return null;
  }

  // Generic DOM extraction: a repeated item selector + per-field selectors, then
  // the shared mapItem bridge. Values are read as text or an attribute (sel@attr).
  async function extractDom(spec) {
    const { mapItem } = await sharedFieldMap();
    const items = spec.item_selector ? [...document.querySelectorAll(spec.item_selector)] : [];
    const selectors = spec.selectors || {};
    const out = [];
    for (const root of items) {
      const raw = {};
      for (const [field, sel] of Object.entries(selectors)) {
        const [css, attr] = String(sel).split('@');
        const node = css ? root.querySelector(css) : root;
        if (!node) continue;
        const v = attr ? node.getAttribute(attr) : node.textContent;
        if (v != null && String(v).trim() !== '') raw[field] = String(v).trim();
      }
      // Links/images read from attributes are often relative: make them absolute
      // so the product keeps its URL and a followLinks step can open it.
      for (const f of ['url', 'image']) if (raw[f]) raw[f] = absUrl(raw[f]);
      const mapped = mapItem(raw, spec.field_map || Object.fromEntries(Object.keys(selectors).map((k) => [k, k])), { strategy: 'dom' });
      if (Object.keys(mapped).length > 1) out.push(mapped);
    }
    return out;
  }

  // Generic JSON-LD Product extraction (name/price/image/url/sku), no site rules.
  async function extractJsonLd() {
    const out = [];
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data; try { data = JSON.parse(s.textContent); } catch { continue; }
      const nodes = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const n of nodes) {
        const t = n && (Array.isArray(n['@type']) ? n['@type'] : [n['@type']]);
        if (!t || !t.map(lc).includes('product')) continue;
        const offers = Array.isArray(n.offers) ? n.offers[0] : n.offers;
        out.push({
          name: n.name, sku: n.sku || n.mpn || n.gtin13 || n.gtin,
          price: offers && (offers.price || offers.lowPrice),
          image: absUrl(Array.isArray(n.image) ? (typeof n.image[0] === 'object' ? n.image[0] && n.image[0].url : n.image[0]) : (n.image && typeof n.image === 'object' ? n.image.url : n.image)),
          url: absUrl(n.url || (offers && offers.url)), strategy: 'json_ld',
        });
      }
    }
    return out;
  }

  async function fetchInPage(reqUrl, { headers = {}, method = 'GET', as = 'json', body: reqBody = null } = {}) {
    const opts = { method, headers, credentials: 'include' };
    if (reqBody != null && method !== 'GET' && method !== 'HEAD') opts.body = reqBody;
    const r = await fetch(reqUrl, opts);
    let body = null;
    try { body = as === 'json' ? await r.json() : await r.text(); } catch { body = null; }
    return { status: r.status, body };
  }

  // Ask the MAIN-world net interceptor (net-capture.mjs) for the JSON/GraphQL
  // responses the page fetched. Same-window postMessage handshake; empty on timeout
  // (the interceptor may not be installed, e.g. capture disabled).
  async function getCapturedResponses() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (settled) return; settled = true; window.removeEventListener('message', onMsg); resolve(v); };
      const onMsg = (e) => { if (e.source === window && e.data && e.data.__eloNet === 'data') done(Array.isArray(e.data.captures) ? e.data.captures : []); };
      window.addEventListener('message', onMsg);
      try { window.postMessage({ __eloNet: 'dump' }, '*'); } catch { done([]); }
      setTimeout(() => done([]), 900);
    });
  }

  // The UNFILTERED request trace (method+url+status+contentType+head, no full body) —
  // for diagnosing a price/product channel we don't yet parse (RSC flight, beacon…).
  async function getRequestLog() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (settled) return; settled = true; window.removeEventListener('message', onMsg); resolve(v); };
      const onMsg = (e) => { if (e.source === window && e.data && e.data.__eloNet === 'data') done(Array.isArray(e.data.requestLog) ? e.data.requestLog : []); };
      window.addEventListener('message', onMsg);
      try { window.postMessage({ __eloNet: 'dump' }, '*'); } catch { done([]); }
      setTimeout(() => done([]), 900);
    });
  }

  async function extract(spec = {}) {
    const using = spec.using || 'auto';
    if (using === 'json_ld') return extractJsonLd();
    if (using === 'dom') return extractDom(spec);
    if (using === 'auto') {
      const ld = await extractJsonLd();
      if (ld.length) return ld;
      if (spec.item_selector) return extractDom(spec);
      return [];
    }
    // embedded_state / internal_api are orchestrated by the service worker.
    return [];
  }

  // ---- Side panel: learned-recipe read, "load more", mouse designation -------

  // Read every card of the live page with a card recipe (card + field selectors).
  async function readRecipeCards(recipe) {
    const { readCards } = await import(url('vendor/shared/extract/card-recipe.mjs'));
    return readCards(document, recipe, location.href);
  }

  // Click ONE "load more" control, if the page has a real one: the one the user showed for this site
  // (its cues), else a button (or button-like element) or a link that stays on this list page, by its
  // label — short labels only, a whole phrase (« Télécharger », « Meer info » are not « load more »).
  const LOAD_MORE = /(load more|show more|see more|view more|more (products|results|items)|charger plus|voir plus|afficher plus|plus de (produits|résultats|articles)|meer (laden|tonen|producten|weergeven)|toon meer|bekijk meer|mehr (laden|anzeigen|produkte)|weitere (laden|produkte|artikel|anzeigen)|cargar más|ver más|mostrar más|carica altri|mostra altri)/i;
  const LOAD_MORE_WORD = /^(charger|meer|mehr|más|plus|more|weitere)$/i;
  const staysHere = (a) => {
    const here = location.pathname.replace(/\/+$/, '');
    const h = (a.getAttribute('href') || '').trim();
    if (!h || h === '#' || /^javascript:/i.test(h)) return true;
    try { return new URL(h, location.href).pathname.replace(/\/+$/, '') === here; } catch { return false; }
  };
  /** The « load more » control now: {el, how, disabled} or null. */
  async function loadMoreControl(learned) {
    if (learned) {
      const { findControl } = await import(url('vendor/shared/extract/page-control.mjs'));
      const hit = findControl(document, learned, { visible: shown });
      if (hit) return hit;
    }
    const el = [...document.querySelectorAll('button, a, [role="button"]')].find((b) => {
      const t = (b.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 40 || !(LOAD_MORE.test(t) || LOAD_MORE_WORD.test(t))) return false;
      if (b.disabled || b.getAttribute('aria-disabled') === 'true' || !shown(b)) return false;
      return b.tagName !== 'A' || staysHere(b);
    });
    return el ? { el, how: 'label', disabled: false } : null;
  }
  async function loadMoreOnce({ learned = null } = {}) {
    const hit = await loadMoreControl(learned);
    if (!hit || hit.disabled) return false;
    try { hit.el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch { /* old engine */ }
    await sleep(300);
    hit.el.click();
    return true;
  }

  // ---- What stands between the list and a click; what the list announces ---------------

  // Close cookie banners and pop-ups the private way (« Refuser », else ×; never « Accepter »).
  async function dismissOverlays() {
    const { overlayControls } = await import(url('vendor/shared/extract/overlays.mjs'));
    const fixed = (el) => { for (let cur = el, i = 0; cur && i < 4; i++, cur = cur.parentElement) { try { const p = getComputedStyle(cur).position; if (p === 'fixed' || p === 'sticky') return true; } catch { return false; } } return false; };
    // Pop-ups without a telling name: a fixed block, direct child of the page, of a real size.
    const extra = [];
    try {
      for (const el of document.body.querySelectorAll(':scope > *, :scope > * > *')) {
        if (extra.length >= 30) break;
        const st = getComputedStyle(el); if (st.position !== 'fixed' || st.display === 'none' || st.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect(); if (r.width * r.height >= 0.08 * innerWidth * innerHeight) extra.push(el);
      }
    } catch { /* hinted ones only */ }
    let found = { controls: [], acceptOnly: 0 }; try { found = overlayControls(document, { isOverlay: fixed, visible: shown, extra }); } catch { /* nothing closed */ }
    const closed = [];
    for (const c of found.controls) { try { c.click(); closed.push((c.textContent || c.getAttribute('aria-label') || '×').replace(/\s+/g, ' ').trim().slice(0, 30)); } catch { /* next */ } }
    if (closed.length) await sleep(400);
    return { closed, acceptOnly: found.acceptOnly };
  }

  // The total the list announces (« Résultats 1 - 24 sur 32 »), or null.
  async function announcedTotal() {
    const { readAnnouncedTotal } = await import(url('vendor/shared/extract/list-total.mjs'));
    try { return readAnnouncedTotal(document); } catch { return null; }
  }

  // Where the control of a pagination mode is now, for the « Tester » report: found / disabled / absent.
  async function locateControl({ kind = 'next', learned = null, mode = 'auto' } = {}) {
    if (kind === 'load_more') { const hit = await loadMoreControl(learned); return hit ? { found: true, disabled: !!hit.disabled, how: hit.how, text: (hit.el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) } : { found: false }; }
    const cand = await findNextPage({ learned, mode });
    return cand ? { found: true, disabled: false, how: cand.how, href: cand.href || null } : { found: false };
  }

  // Learn a card recipe on this page from rows already read correctly (structured
  // data), so the cards loaded later on scroll are read the same way.
  async function learnRecipe(rows) {
    const { learnRecipeFromRows } = await import(url('vendor/shared/extract/learn-from-rows.mjs'));
    return learnRecipeFromRows(document, rows || [], location.href);
  }

  // The category trail of the page (breadcrumb, else its title) — sent with the
  // accepted rows so their category reads e.g. "Homme > Sneakers".
  async function pageTrail() {
    const { trailFromDocument } = await import(url('vendor/shared/extract/listing-trail.mjs'));
    return trailFromDocument(document, location.href);
  }

  function pagePath() { return location.pathname.replace(/\/+$/, ''); }

  // "Désigner à la souris": highlight what is under the pointer, wait for ONE click
  // (the page's own click handlers never run), then return the repeated card + the
  // field selector relative to it. Escape cancels; no click within the delay → stop.
  let activePick = null; // finish() of the designation in progress, for "cancel"
  // A designation never outlives the user's attention: another tab (the page is hidden) or leaving the page ends it.
  const endPickWhenHidden = () => { if (activePick && (document.hidden || document.visibilityState === 'hidden')) activePick({ ok: false, reason: 'annulé (onglet quitté)' }); };
  try { document.addEventListener('visibilitychange', endPickWhenHidden); window.addEventListener('pagehide', () => { if (activePick) activePick({ ok: false, reason: 'annulé (page quittée)' }); }); } catch { /* no window */ }

  // The box around the characters [start, end) of `el`'s text (same counting as
  // charOffsetAt), to highlight one piece of a line.
  function textRect(el, start, end) {
    try {
      const skip = (n) => { const s = n.parentElement && n.parentElement.closest('style,script,noscript,template'); return !!(s && el.contains(s)); };
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const r = document.createRange(); let pos = 0; let started = false;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (skip(n)) continue;
        const len = n.textContent.length;
        if (!started && start <= pos + len) { r.setStart(n, Math.max(0, start - pos)); started = true; }
        if (started && end <= pos + len) { r.setEnd(n, Math.max(0, end - pos)); const b = r.getBoundingClientRect(); return b.width > 0 ? b : null; }
        pos += len;
      }
    } catch { /* geometry unavailable */ }
    return null;
  }

  // Which character of `el`'s text is at (x, y) — by geometry, so a transparent link
  // laid over the card does not hide it. Same counting as pick-selector's rawText
  // (style sheets and scripts excluded). -1 when the point is on no character.
  function charOffsetAt(el, x, y) {
    try {
      const skip = (n) => { const s = n.parentElement && n.parentElement.closest('style,script,noscript,template'); return !!(s && el.contains(s)); };
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const r = document.createRange(); let pos = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (skip(n)) continue;
        const len = n.textContent.length;
        for (let i = 0; i < len && i < 500; i++) {
          r.setStart(n, i); r.setEnd(n, i + 1);
          for (const b of r.getClientRects()) if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return pos + i;
        }
        pos += len;
      }
    } catch { /* geometry unavailable */ }
    return -1;
  }
  async function pick({ card = null, fieldKey = '', label = '', timeoutMs = 120000 } = {}) {
    const { pickField, chooseFromStack, rawText, isWholeRole } = await import(url('vendor/shared/extract/pick-selector.mjs'));
    const { textPart } = await import(url('vendor/shared/extract/card-recipe.mjs'));
    const { fieldMeaning, isListField } = await import(url('vendor/shared/extract/field-meaning.mjs'));
    const { classifyHtmlPage } = await import(url('vendor/shared/classify/page-kind.mjs'));
    // What the field holds, from its name: a "Prix promo" field picks a whole price,
    // a "Tailles" / "Longueurs" / "Couleurs" field the whole group of entries.
    const meaning = fieldMeaning({ key: fieldKey, label });
    const role = ['price', 'list_price', 'url', 'image'].includes(meaning) ? meaning : fieldKey;
    const list = isListField({ label });
    // A product page (one product, not a list of cards): the page itself is the card.
    let page = false;
    if (card === 'body') page = true;
    else if (!card) { try { page = classifyHtmlPage(document.documentElement.outerHTML, { url: location.href }).kind === 'product'; } catch { page = false; } }
    // A free column ("Ville"): the piece of the line under the pointer is what a click takes.
    const partMode = !list && !isWholeRole(role);
    if (activePick) activePick({ ok: false, reason: 'remplacé par une nouvelle désignation' });
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #7c5cff;background:rgba(124,92,255,.14);border-radius:3px;display:none';
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:90vw;background:#1f1b2e;color:#fff;font:600 13px/1.4 system-ui,sans-serif;padding:8px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none';
      bar.textContent = `Cliquez sur « ${String(label || fieldKey).slice(0, 40)} »${page ? ' dans cette fiche produit' : ' dans une fiche produit'}${list ? ' (une des valeurs : toute la liste est prise)' : ''}. Clic droit ou Échap pour annuler.`;
      document.documentElement.append(box, bar);
      const under = (x, y) => chooseFromStack(document.elementsFromPoint(x, y).filter((e) => e !== box && e !== bar), role);
      let raf = 0;
      const move = (e) => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          const el = under(e.clientX, e.clientY); if (!el) { box.style.display = 'none'; return; }
          let r = el.getBoundingClientRect();
          if (partMode) {
            const off = charOffsetAt(el, e.clientX, e.clientY);
            const p = off >= 0 ? textPart(rawText(el), off) : null;
            const pr = p ? textRect(el, p.start, p.end) : null;
            if (pr) r = pr; // highlight "Liège", not the whole "Appartement ⋅ Liège"
          }
          Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        });
      };
      const TYPES = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick'];
      const swallow = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
      let timer = 0;
      const finish = (res) => {
        if (activePick !== finish) return; // already finished
        activePick = null;
        clearTimeout(timer); if (raf) cancelAnimationFrame(raf);
        window.removeEventListener('mousemove', move, true);
        for (const t of TYPES) window.removeEventListener(t, onPointer, true);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('contextmenu', onMenu, true);
        box.remove(); bar.remove();
        resolve(res);
      };
      activePick = finish;
      const onPointer = (e) => {
        swallow(e);
        if (e.type !== 'click') return;
        const el = under(e.clientX, e.clientY);
        let res; try { res = el ? pickField(el, { doc: document, card, fieldKey: role, offset: charOffsetAt(el, e.clientX, e.clientY), list, page }) : { ok: false, reason: 'aucun élément sous le pointeur' }; } catch (err) { res = { ok: false, reason: String(err && err.message || err).slice(0, 120) }; }
        finish(res);
      };
      // The keyboard usually stays in the side panel (the panel cancels through
      // cancelPick); Escape here works when the page has the focus, a right click always.
      const onKey = (e) => { if (e.key === 'Escape') { swallow(e); finish({ ok: false, reason: 'annulé' }); } };
      const onMenu = (e) => { swallow(e); finish({ ok: false, reason: 'annulé' }); };
      timer = setTimeout(() => finish({ ok: false, reason: 'délai dépassé' }), timeoutMs);
      window.addEventListener('mousemove', move, true);
      for (const t of TYPES) window.addEventListener(t, onPointer, true);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('contextmenu', onMenu, true);
    });
  }


  // ---- Site knowledge: designate a BLOCK of a product page (description, specs…) -------

  /** What kind of page this is (product / listing / …), by the shared classifier. */
  async function pageKind() {
    const { classifyHtmlPage } = await import(url('vendor/shared/classify/page-kind.mjs'));
    try { return classifyHtmlPage(document.documentElement.outerHTML, { url: location.href }).kind; } catch { return 'unknown'; }
  }

  /** Links of this page that look like other product pages of the site (to check a rule on them). */
  async function sameShapeLinksOfPage() {
    const { sameShapeLinks } = await import(url('vendor/shared/knowledge/pick-block.mjs'));
    return sameShapeLinks(document, location.href, { max: 8 });
  }

  // Highlight the block under the pointer (grown to the whole description / the whole spec table),
  // the wheel widens or narrows it, ONE click takes it. Returns the rule the engine will use
  // (selector + fingerprint + how to read it) and what was understood — nothing is stored here.
  async function pickKnowledge({ field = 'description', label = '', timeoutMs = 120000 } = {}) {
    const { chooseFromStack } = await import(url('vendor/shared/extract/pick-selector.mjs'));
    const { growBlock, describeBlock, sameShapeLinks } = await import(url('vendor/shared/knowledge/pick-block.mjs'));
    const { ruleFromElement } = await import(url('vendor/shared/knowledge/apply.mjs'));
    if (activePick) activePick({ ok: false, reason: 'remplacé par une nouvelle désignation' });
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #35c28a;background:rgba(53,194,138,.14);border-radius:3px;display:none';
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:90vw;background:#1f1b2e;color:#fff;font:600 13px/1.4 system-ui,sans-serif;padding:8px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none';
      const base = `Cliquez sur le bloc « ${String(label || field).slice(0, 40)} ». Molette : agrandir / réduire. Clic droit ou Échap : annuler.`;
      bar.textContent = base;
      document.documentElement.append(box, bar);
      let level = 0; let underEl = null; let current = null; let raf = 0; let lastXY = [0, 0];
      const ancestor = (el, n) => { let e = el; for (let i = 0; i < n && e.parentElement && !/^(body|html)$/i.test(e.parentElement.tagName); i++) e = e.parentElement; return e; };
      const resolveBlock = () => { current = underEl ? ancestor(growBlock(underEl, field), level) : null; };
      const draw = () => {
        resolveBlock();
        if (!current) { box.style.display = 'none'; bar.textContent = base; return; }
        const r = current.getBoundingClientRect();
        Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        bar.textContent = `${base}  →  ${describeBlock(current, field)}`;
      };
      const move = (e) => {
        lastXY = [e.clientX, e.clientY];
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          const el = chooseFromStack(document.elementsFromPoint(lastXY[0], lastXY[1]).filter((x) => x !== box && x !== bar), field);
          if (el !== underEl) { underEl = el; level = 0; }
          draw();
        });
      };
      const onWheel = (e) => { e.preventDefault(); e.stopPropagation(); level = Math.max(0, level + (e.deltaY < 0 ? 1 : -1)); draw(); };
      const TYPES = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick'];
      const swallow = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
      let timer = 0;
      const finish = (res) => {
        if (activePick !== finish) return;
        activePick = null;
        clearTimeout(timer); if (raf) cancelAnimationFrame(raf);
        window.removeEventListener('mousemove', move, true); window.removeEventListener('wheel', onWheel, true);
        for (const t of TYPES) window.removeEventListener(t, onPointer, true);
        window.removeEventListener('keydown', onKey, true); window.removeEventListener('contextmenu', onMenu, true);
        box.remove(); bar.remove();
        resolve(res);
      };
      activePick = finish;
      const onPointer = (e) => {
        swallow(e);
        if (e.type !== 'click') return;
        const el = chooseFromStack(document.elementsFromPoint(e.clientX, e.clientY).filter((x) => x !== box && x !== bar), field);
        if (el !== underEl) { underEl = el; level = 0; }
        resolveBlock();
        if (!current) return finish({ ok: false, reason: 'aucun bloc sous le pointeur' });
        let out;
        try {
          const { rule, read, count } = ruleFromElement(current, document, { field, label, url: location.href });
          const sample = Array.isArray(read.value) ? read.value.slice(0, 5) : String(read.value || rule.example || '').slice(0, 400);
          out = read.ok
            ? { ok: true, field, rule, summary: describeBlock(current, field), count, sample, pageUrl: location.href, sampleUrls: sameShapeLinks(document, location.href, { max: 8 }) }
            : { ok: false, field, reason: `ce bloc ne ressemble pas à ce champ : ${read.reason}`, summary: describeBlock(current, field), sample };
        } catch (err) { out = { ok: false, reason: String(err && err.message || err).slice(0, 120) }; }
        finish(out);
      };
      const onKey = (e) => { if (e.key === 'Escape') { swallow(e); finish({ ok: false, reason: 'annulé' }); } };
      const onMenu = (e) => { swallow(e); finish({ ok: false, reason: 'annulé' }); };
      timer = setTimeout(() => finish({ ok: false, reason: 'délai dépassé' }), timeoutMs);
      window.addEventListener('mousemove', move, true);
      window.addEventListener('wheel', onWheel, { capture: true, passive: false });
      for (const t of TYPES) window.addEventListener(t, onPointer, true);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('contextmenu', onMenu, true);
    });
  }

  // The site's taught product rules (from the app) read on THIS page, as the app reads them on a run:
  // { values, sources, trace } — the panel preview merges `values` into the row with the same priority.
  async function applyKnowledgeHere(knowledge, { name = '' } = {}) {
    const { applyKnowledge } = await import(url('vendor/shared/knowledge/apply.mjs'));
    const { pageJsonPayloads } = await import(url('vendor/shared/extract/product-group.mjs'));
    const { productIdsOf } = await import(url('vendor/shared/knowledge/state-values.mjs'));
    const html = document.documentElement ? document.documentElement.outerHTML : '';
    let payloads = { json: [], jsonLd: [] }; try { payloads = pageJsonPayloads(html); } catch { /* none */ }
    const r = applyKnowledge(document, knowledge, { scope: 'product', name, url: location.href, html, payloads: payloads.json, productIds: productIdsOf({ url: location.href, jsonLd: payloads.jsonLd }) });
    return { values: r.values, sources: r.sources, trace: r.trace.map((t) => ({ field: t.field, ok: t.ok, strategy: t.strategy || null, reason: t.reason || null, origin: t.origin })) };
  }

  // The chat agent shows the user an element: scrolled into view, outlined a few seconds, with a short label.
  function highlight(selector, label = '') {
    let el = null; try { el = document.querySelector(String(selector || '')); } catch { el = null; }
    if (!el) return { ok: false };
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* old browser */ }
    const r = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.style.cssText = `position:fixed;pointer-events:none;z-index:2147483646;border:3px solid #8b5cf6;background:rgba(139,92,246,.12);border-radius:4px;left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;transition:opacity .4s`;
    const tag = document.createElement('div');
    tag.textContent = String(label || '').slice(0, 60);
    tag.style.cssText = `position:fixed;pointer-events:none;z-index:2147483647;background:#8b5cf6;color:#fff;font:600 12px system-ui,sans-serif;padding:2px 6px;border-radius:4px;left:${r.left}px;top:${Math.max(0, r.top - 22)}px`;
    document.documentElement.append(box); if (label) document.documentElement.append(tag);
    // Follow the element while the page scrolls to it.
    const follow = () => { const q = el.getBoundingClientRect(); Object.assign(box.style, { left: `${q.left - 3}px`, top: `${q.top - 3}px` }); Object.assign(tag.style, { left: `${q.left}px`, top: `${Math.max(0, q.top - 22)}px` }); };
    const iv = setInterval(follow, 100);
    setTimeout(() => { clearInterval(iv); box.style.opacity = '0'; tag.style.opacity = '0'; setTimeout(() => { box.remove(); tag.remove(); }, 450); }, 6000);
    return { ok: true };
  }

  // Make a product page load what it only loads on sight: scroll through it in steps (lazy-loaded gallery
  // pictures and blocks appear as they come into view), ask lazy pictures to load now, then come back to
  // the top. Generic: no site rule, no click, nothing left changed but the scroll position.
  async function revealLazy({ steps = 6, stepMs = 220, maxMs = 4000 } = {}) {
    const t0 = Date.now();
    let lazy = 0;
    try { for (const img of document.querySelectorAll('img[loading="lazy"]')) { img.loading = 'eager'; lazy++; } } catch { /* read what is there */ }
    const total = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    const view = window.innerHeight || 800;
    for (let i = 1; i <= steps && Date.now() - t0 < maxMs; i++) {
      window.scrollTo(0, Math.min(total, Math.round((total * i) / steps)));
      await sleep(stepMs);
    }
    window.scrollTo(0, 0);
    await sleep(Math.min(300, stepMs));
    // Pictures that still show no address after the pass (a loader that waits for something else).
    let pending = 0; try { pending = [...document.querySelectorAll('img')].filter((im) => !im.currentSrc && !im.getAttribute('src') && (im.getAttribute('data-src') || im.getAttribute('data-srcset'))).length; } catch { pending = 0; }
    return { scrolled: total > view, lazy, pending, ms: Date.now() - t0 };
  }

  // Open the sections a product page keeps folded (accordions, <details>) so their content is in the page
  // read: many shops build a tab's text only when it is opened. Only toggles that open a panel of this page
  // (aria-controls / details) — never a link that leaves the page, never in a menu, header, form or dialog.
  async function expandSections({ max = 12 } = {}) {
    const { expandFoldedSections } = await import(url('vendor/shared/knowledge/pick-block.mjs'));
    let n = 0; try { n = expandFoldedSections(document, max); } catch { n = 0; }
    if (n) await sleep(700);
    return { opened: n };
  }

  // Is this page a human check / block page (shared markers), rather than the page asked for? A page
  // that reads as a product page is never one (a captcha widget merely embedded on it is no block).
  async function challengeHere() {
    const { detectChallenge } = await import(url('vendor/shared/challenge/detect.mjs'));
    let hit = null; try { hit = detectChallenge(readContext(), {}); } catch { hit = null; }
    if (!hit) return null;
    if ((await pageKind()) === 'product') return null;
    return { category: hit.category };
  }

  // ---- Sub-pages read in the user's browser ------------------------------------------

  // Wait until the page has finished building itself: no DOM change and no new network request for
  // `quietMs` (an SPA keeps filling its blocks after "load"), at most `maxMs`.
  async function settle({ quietMs = 1000, maxMs = 10000, minMs = 1500 } = {}) {
    // Never less than `minMs`: many shops start fetching their blocks a moment after "load".
    const t0 = Date.now(); let last = Date.now();
    const bump = () => { last = Date.now(); };
    let mo = null; let po = null;
    try { mo = new MutationObserver(bump); mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true }); } catch { mo = null; }
    try { po = new PerformanceObserver(bump); po.observe({ type: 'resource', buffered: false }); } catch { po = null; }
    while (Date.now() - t0 < maxMs) { if (Date.now() - t0 >= minMs && Date.now() - last >= quietMs && document.readyState === 'complete') break; await sleep(150); }
    try { if (mo) mo.disconnect(); if (po) po.disconnect(); } catch { /* */ }
    return { ms: Date.now() - t0 };
  }

  // The rendered page, lightened for the trip to the app: the DOM as built (blocks rendered in the browser),
  // the data scripts (JSON-LD, page state) kept, styles / SVG / frames / other scripts dropped.
  function compactHtml({ maxBytes = 8 * 1024 * 1024 } = {}) {
    const root = document.documentElement.cloneNode(true);
    for (const n of root.querySelectorAll('style, link[rel="stylesheet"], svg, noscript, iframe, canvas, video, audio, template')) n.remove();
    for (const sc of root.querySelectorAll('script')) {
      const type = (sc.getAttribute('type') || '').toLowerCase();
      const t = sc.textContent || '';
      // A data script: JSON, or one that STARTS by assigning the page state ("window.__PRELOADED_STATE__ = {…}",
      // "self.__next_f.push(…)") — not a code bundle that merely mentions such a name.
      const data = /json/.test(type) || /^\s*(?:(?:window|self)\.)?__[A-Za-z0-9_$]+\s*(?:=|\.push\()/.test(t) || /^\s*(?:window|self)\[\s*['"]__/.test(t);
      if (!data || sc.src) sc.remove();
    }
    let html = '<!doctype html>' + root.outerHTML;
    if (html.length > maxBytes) html = html.slice(0, maxBytes);
    return { url: location.href, html };
  }

  // ---- Next page of a list ----------------------------------------------------------

  /** Where the next page of this list is: {href} to open, or {selector} to click — null at the last page. */
  async function findNextPage({ learned = null, mode = 'auto' } = {}) {
    const { findNextPage: find } = await import(url('vendor/shared/extract/next-page.mjs'));
    return find(document, location.href, { learned, mode, visible: shown });
  }

  // The user points at the « next page » (or « load more ») control once; several cues are kept for the
  // site (selector, text, block, place, page parameter), taken on the real link / button around the click.
  async function pickNextButton({ timeoutMs = 120000, kind = 'next' } = {}) {
    const { controlCues, clickableOf, usableCues } = await import(url('vendor/shared/extract/page-control.mjs'));
    if (activePick) activePick({ ok: false, reason: 'remplacé par une nouvelle désignation' });
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #f2b84b;background:rgba(242,184,75,.15);border-radius:3px;display:none';
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1f1b2e;color:#fff;font:600 13px/1.4 system-ui,sans-serif;padding:8px 14px;border-radius:8px;pointer-events:none';
      bar.textContent = kind === 'load_more' ? 'Cliquez sur le bouton « charger plus » de la liste. Clic droit ou Échap : annuler.' : 'Cliquez sur le bouton « page suivante » de la liste. Clic droit ou Échap : annuler.';
      document.documentElement.append(box, bar);
      const control = (x, y) => { const el = document.elementsFromPoint(x, y).find((e) => e !== box && e !== bar); return el ? clickableOf(el) : null; };
      const move = (e) => { const el = control(e.clientX, e.clientY); if (!el) return; const r = el.getBoundingClientRect(); Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` }); };
      const TYPES = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick'];
      const swallow = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
      let timer = 0;
      const finish = (res) => {
        if (activePick !== finish) return; activePick = null; clearTimeout(timer);
        window.removeEventListener('mousemove', move, true); for (const t of TYPES) window.removeEventListener(t, onPointer, true);
        window.removeEventListener('keydown', onKey, true); window.removeEventListener('contextmenu', onMenu, true);
        box.remove(); bar.remove(); resolve(res);
      };
      activePick = finish;
      const onPointer = (e) => {
        swallow(e); if (e.type !== 'click') return;
        const el = control(e.clientX, e.clientY);
        if (!el) { finish({ ok: false, reason: 'rien sous le pointeur' }); return; }
        let cues = null; try { cues = controlCues(el, document, { kind, pageUrl: location.href }); } catch { cues = null; }
        if (!usableCues(cues)) { finish({ ok: false, reason: 'cet élément n’a ni texte ni repère stable : montrez le lien ou le bouton lui-même' }); return; }
        finish({ ok: true, cues, selector: cues.selector || null, text: (cues.text || cues.label || '').slice(0, 40) });
      };
      const onKey = (e) => { if (e.key === 'Escape') { swallow(e); finish({ ok: false, reason: 'annulé' }); } };
      const onMenu = (e) => { swallow(e); finish({ ok: false, reason: 'annulé' }); };
      timer = setTimeout(() => finish({ ok: false, reason: 'délai dépassé' }), timeoutMs);
      window.addEventListener('mousemove', move, true); for (const t of TYPES) window.addEventListener(t, onPointer, true);
      window.addEventListener('keydown', onKey, true); window.addEventListener('contextmenu', onMenu, true);
    });
  }

  // ---- The product card, learned from one click; « pas un produit »; the hub's block of sub-collections -------

  // One designation: the element under the pointer (the wheel grows / shrinks it), returned on click.
  function pickOnce({ text, color = '#35c28a', timeoutMs = 120000 } = {}) {
    if (activePick) activePick(null);
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.style.cssText = `position:fixed;pointer-events:none;z-index:2147483646;border:2px solid ${color};background:${color}22;border-radius:3px;display:none`;
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:90vw;background:#1f1b2e;color:#fff;font:600 13px/1.4 system-ui,sans-serif;padding:8px 14px;border-radius:8px;pointer-events:none';
      bar.textContent = `${text} Molette : agrandir / réduire. Clic droit ou Échap : annuler.`;
      document.documentElement.append(box, bar);
      let under = null; let level = 0;
      const pick = () => { let e = under; for (let i = 0; e && i < level && e.parentElement && !/^(body|html)$/i.test(e.parentElement.tagName); i++) e = e.parentElement; return e; };
      const draw = () => { const el = pick(); if (!el) { box.style.display = 'none'; return; } const r = el.getBoundingClientRect(); Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` }); };
      const at = (x, y) => document.elementsFromPoint(x, y).find((e) => e !== box && e !== bar) || null;
      const move = (e) => { const el = at(e.clientX, e.clientY); if (el !== under) { under = el; level = 0; } draw(); };
      const onWheel = (e) => { e.preventDefault(); e.stopPropagation(); level = Math.max(0, level + (e.deltaY < 0 ? 1 : -1)); draw(); };
      const TYPES = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick'];
      const swallow = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
      let timer = 0;
      // `finish` itself is the designation in progress (activePick): a cancel from anywhere (Escape in the page or in
      // the panel, right-click, another tab, the panel closed, a new designation) ends it — never a wrapper, which made
      // every exit return early and left the page swallowing its clicks (28/10).
      const finish = (r) => {
        if (activePick !== finish) return; activePick = null; clearTimeout(timer);
        window.removeEventListener('mousemove', move, true); window.removeEventListener('wheel', onWheel, true);
        for (const t of TYPES) window.removeEventListener(t, onPointer, true);
        window.removeEventListener('keydown', onKey, true); window.removeEventListener('contextmenu', onMenu, true);
        box.remove(); bar.remove(); resolve(r && r.nodeType === 1 ? r : null);
      };
      activePick = finish;
      const onPointer = (e) => { swallow(e); if (e.type !== 'click') return; const el = at(e.clientX, e.clientY); if (el !== under) { under = el; level = 0; } finish(pick()); };
      const onKey = (e) => { if (e.key === 'Escape') { swallow(e); finish(null); } };
      const onMenu = (e) => { swallow(e); finish(null); };
      timer = setTimeout(() => finish(null), timeoutMs);
      window.addEventListener('mousemove', move, true); window.addEventListener('wheel', onWheel, { capture: true, passive: false });
      for (const t of TYPES) window.addEventListener(t, onPointer, true);
      window.addEventListener('keydown', onKey, true); window.addEventListener('contextmenu', onMenu, true);
    });
  }

  // Every kept card outlined in green, every rejected one in red with its reason, and the count — for a few seconds.
  let cardMarks = [];
  async function highlightCards(model, { ms = 9000 } = {}) {
    const { classifyCards, REJECT_REASONS } = await import(url('vendor/shared/extract/card-model.mjs'));
    for (const m of cardMarks) m.remove(); cardMarks = [];
    const c = classifyCards(document, model, location.href);
    const mark = (el, color, label) => {
      const r = el.getBoundingClientRect(); if (!r.width && !r.height) return;
      const b = document.createElement('div');
      b.style.cssText = `position:absolute;pointer-events:none;z-index:2147483645;border:2px ${color === 'red' ? 'dashed #e5484d' : 'solid #35c28a'};border-radius:4px;left:${r.left + scrollX - 2}px;top:${r.top + scrollY - 2}px;width:${r.width + 4}px;height:${r.height + 4}px`;
      if (label) { const t = document.createElement('div'); t.textContent = label; t.style.cssText = 'position:absolute;top:-1px;left:-1px;background:#e5484d;color:#fff;font:600 11px system-ui,sans-serif;padding:1px 5px;border-radius:3px;max-width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis'; b.append(t); }
      document.documentElement.append(b); cardMarks.push(b);
    };
    for (const el of c.kept) mark(el, 'green', '');
    for (const r of c.rejected) mark(r.el, 'red', REJECT_REASONS[r.reason] || r.reason);
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1f1b2e;color:#fff;font:600 13px/1.4 system-ui,sans-serif;padding:8px 14px;border-radius:8px;pointer-events:none';
    bar.textContent = `${c.kept.length} carte(s) produit (cadre vert)${c.rejected.length ? ` · ${c.rejected.length} écartée(s) (cadre rouge, avec la raison)` : ''}`;
    document.documentElement.append(bar); cardMarks.push(bar);
    const fade = setTimeout(() => { for (const m of cardMarks) m.remove(); cardMarks = []; }, ms);
    if (fade && typeof fade.unref === 'function') fade.unref(); // (Node tests only: a browser timer is a number)
    return { kept: c.kept.length, rejected: c.rejected.length, byReason: c.byReason };
  }

  // « 🎯 Montrer une carte produit »: one click on a card of the list (another click on a card of another section adds it).
  async function learnCard({ previous = null } = {}) {
    const { learnCardModel } = await import(url('vendor/shared/extract/card-model.mjs'));
    const el = await pickOnce({ text: previous ? 'Cliquez sur une carte produit d’une autre section de la liste (ou la même carte pour recompter).' : 'Cliquez sur une carte produit de la liste (sa photo, son titre ou son prix).' });
    if (!el) return { ok: false, reason: 'annulé' };
    let r; try { r = learnCardModel(el, document, location.href, { previous }); } catch (e) { r = { ok: false, reason: String(e && e.message || e).slice(0, 160) }; }
    if (!r.ok) return r;
    const shown = await highlightCards(r.model);
    return { ok: true, model: r.model, added: !!r.added, ...shown };
  }

  // « 🎯 Pas un produit »: one click on a card wrongly kept; its signature is added to the model.
  async function markNotProduct({ model } = {}) {
    const { negativeSignature } = await import(url('vendor/shared/extract/card-model.mjs'));
    if (!model) return { ok: false, reason: 'montrez d’abord une carte produit' };
    const el = await pickOnce({ text: 'Cliquez sur l’élément qui n’est PAS un produit (bannière, bloc, carte d’une autre liste).', color: '#e5484d' });
    if (!el) return { ok: false, reason: 'annulé' };
    const sig = negativeSignature(el, document, model, location.href);
    const next = { ...model, negatives: [...(model.negatives || []), sig].slice(-30) };
    const shown = await highlightCards(next);
    return { ok: true, model: next, ...shown };
  }

  // The learned card read on this page: the rows of the kept cards, and the rejected ones with their reason.
  async function readModelCards(model, recipe) {
    const { classifyCards } = await import(url('vendor/shared/extract/card-model.mjs'));
    const { readCardElements } = await import(url('vendor/shared/extract/card-recipe.mjs'));
    const c = classifyCards(document, model, location.href);
    const rows = readCardElements(c.kept, recipe || { card: model.card, fields: model.fields }, location.href);
    return { rows, rejected: c.rejected.slice(0, 300).map((r) => ({ reason: r.reason, name: r.name, url: r.url })), byReason: c.byReason };
  }

  // « 🎯 Montrer le bloc des sous-collections » (page hub): the links of the block, one per sub-collection.
  async function pickHub() {
    const el = await pickOnce({ text: 'Cliquez sur le bloc qui regroupe les liens des sous-collections (séries, gammes).', color: '#8b5cf6' });
    if (!el) return { ok: false, reason: 'annulé' };
    const here = location.href.split('#')[0];
    const seen = new Set(); const links = [];
    for (const a of el.querySelectorAll('a[href]')) {
      let u; try { u = new URL(a.getAttribute('href'), location.href); } catch { continue; }
      if (!/^https?:$/.test(u.protocol) || u.hostname !== location.hostname) continue;
      u.hash = ''; const k = u.href; if (k === here || seen.has(k)) continue;
      const name = (a.textContent || a.getAttribute('title') || a.getAttribute('aria-label') || (a.querySelector('img') && a.querySelector('img').getAttribute('alt')) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      seen.add(k); links.push({ name: name || u.pathname.split('/').filter(Boolean).pop() || k, url: k });
      if (links.length >= 50) break;
    }
    if (!links.length) return { ok: false, reason: 'aucun lien vers une autre page de ce site dans ce bloc : agrandissez-le avec la molette' };
    return { ok: true, links };
  }

  /** Cancel the designation in progress (Escape pressed in the side panel). */
  function cancelPick() { if (!activePick) return false; activePick({ ok: false, reason: 'annulé' }); return true; }

  globalThis.__eloRunner = { readContext, waitFor, click, type: typeInto, select: selectOption, scroll, extract, fetchInPage, findState, getCapturedResponses, getRequestLog, readRecipeCards, loadMoreOnce, pagePath, pick, cancelPick, learnRecipe, pageTrail, pageKind, pickKnowledge, sameShapeLinks: sameShapeLinksOfPage, settle, compactHtml, findNextPage, pickNextButton, dismissOverlays, announcedTotal, locateControl, learnCard, markNotProduct, highlightCards, readModelCards, pickHub, applyKnowledge: applyKnowledgeHere, challengeHere, expandSections, revealLazy, highlight };
})();
