/**
 * "Is this a product page?" — the ONE set of rules both engines use (the standard
 * engine on fetched/rendered HTML, the extension tier on the live page's
 * outerHTML). A page is firmly REJECTED (not found / listing / non-product),
 * firmly ACCEPTED as a product, or marked UNCERTAIN (kept, but "to verify" with a
 * reason) — never silently treated as a product on thin evidence.
 *
 * GENERIC: no site names. Signals are schema.org types, OpenGraph, page
 * structure (how many prices / product blocks / add-to-cart controls), a
 * multilingual "page not found" wording, and URL path segments — the segment
 * lists are DATA (DEFAULT_PAGE_RULES), extendable/overridable from config, and a
 * product segment followed by an id/slug always wins over a non-product one.
 *
 * PORTABLE: zero dependencies, zero Node built-ins, regex on an HTML string — it
 * runs unchanged in Node and in the extension's service worker.
 */
import { CUR } from '../extract/money.mjs';
import { mainMicrodataProduct } from '../extract/microdata.mjs';

export const PAGE_KIND = Object.freeze({
  PRODUCT: 'product', LISTING: 'listing', NOT_FOUND: 'not_found', NON_PRODUCT: 'non_product', UNCERTAIN: 'uncertain',
  /** A page's own video (content type "video", core/content-reader.mjs) — kept, never rejected. */
  VIDEO: 'video',
});

/** Kinds that must never produce a product. */
export const REJECTED_KINDS = Object.freeze([PAGE_KIND.NOT_FOUND, PAGE_KIND.LISTING, PAGE_KIND.NON_PRODUCT]);

export const DEFAULT_PAGE_RULES = Object.freeze({
  /** ≥ this many price tokens in the visible text, with no single product schema → a grid. */
  listingPriceMin: 8,
  /** ≥ this many microdata Product scopes → a grid. */
  listingMicrodataMin: 3,
  productTypes: ['product', 'productgroup', 'productmodel', 'individualproduct', 'vehicle', 'book', 'foodproduct'],
  listingTypes: ['collectionpage', 'searchresultspage', 'itemlist', 'offercatalog'],
  /** Path segments that mean "a product follows" (only when followed by another segment). */
  productSegments: ['p', 'product', 'products', 'produit', 'produits', 'prod', 'dp', 'item', 'items', 'artikel', 'articulo', 'articolo', 'pd'],
  /** Path segments typical of category / service / account / editorial pages (exact segment match). */
  nonProductSegments: [
    'c', 'cat', 'category', 'categories', 'categorie', 'categorieen', 'kategorie', 'kategorien', 'categoria', 'categorias', 'collections',
    'search', 'recherche', 'zoeken', 'suche', 'buscar', 'cerca',
    'cart', 'panier', 'basket', 'winkelwagen', 'warenkorb', 'carrito', 'checkout', 'caisse', 'kassa', 'kasse',
    'account', 'compte', 'mon-compte', 'login', 'signin', 'sign-in', 'register', 'inscription', 'wishlist', 'favoris', 'favorites',
    'blog', 'magazine', 'inspiration', 'inspiratie', 'news', 'actualites', 'guides', 'conseils',
    'help', 'aide', 'faq', 'contact', 'service', 'services', 'legal', 'mentions-legales', 'cgv', 'privacy', 'cookies', 'newsletter',
    'stores', 'magasins', 'store-locator', 'winkels', 'filialen',
  ],
  /** Wording of an error page, matched on <title>/<h1>/og:title only (never the body). */
  // Error WORDING, never a bare number or word that a real product name could
  // carry ("Peugeot 404", "Le livre introuvable").
  notFoundPatterns: [
    '^\\s*(?:erreur|error|fehler|fout|errore)?\\s*40[34]\\s*(?:$|[-–—:|!.])', '(?:erreur|error|fehler|fout|errore)\\s*40[34]\\b', '\\bpage\\s*40[34]\\b',
    'page not found', '^\\s*not found\\b', 'page introuvable', 'produit introuvable', '^\\s*introuvable\\b',
    "(?:page|annonce|produit)[^.|]{0,40}n['’]a pas été trouvée", "n['’]existe plus", "cette page n['’]existe pas", "(?:page|annonce|offre)[^.|]{0,30}n['’]est plus disponible",
    'pagina niet gevonden', 'pagina bestaat niet', 'seite (?:wurde )?nicht gefunden', 'seite existiert nicht',
    'p[áa]gina no encontrada', 'pagina non trovata', "page d['’]erreur",
  ],
  /** Listing tiles that are calls-to-action, not products (matched on the tile name). */
  ctaPatterns: ['^voir (tout|plus|l[ae]s?)\\b', '^d[ée]couvr', '^shop (now|all)\\b', '^(see|view) (all|more)\\b', '^en savoir plus', '^bekijk (alles|meer)', '^alles bekijken', '^mehr (erfahren|anzeigen)', '^alle anzeigen', '^ver (todo|más)'],
});

const lc = (s) => String(s == null ? '' : s).toLowerCase();
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
// Currency-broad price token counter (multilingual listings), built from the shared
// currency set so it stays in sync with the money parser.
const MONEY_RE = new RegExp(`(?:${CUR})\\s?\\d[\\d .,]*\\d|\\d[\\d .,]*\\d\\s?(?:${CUR})|\\d+[.,]\\d{2}\\s?(?:${CUR})`, 'gi');
const ADD_TEXT_RE = /(add to (cart|basket|bag)|ajouter au (panier|caddie)|in (de |het )?(winkelwagen|winkelmandje|mandje)|in den (warenkorb|einkaufswagen)|a[ñn]adir al (carrito|cesta)|aggiungi al carrello|buy now|acheter maintenant)/gi;
const ADD_ATTR_RE = /<(?:button|a|input|form)\b[^>]*(?:add[-_]?to[-_]?(?:cart|basket|bag)|addtocart|add-to-cart|btn-cart|product-form__submit)[^>]*>/gi;

/**
 * Merge config overrides onto the defaults. Arrays EXTEND the defaults; a
 * segment listed in `allowSegments` is removed from `nonProductSegments` (for a
 * site whose products genuinely live under, say, /c/).
 */
export function mergeRules(overrides) {
  const o = (overrides && typeof overrides === 'object') ? overrides : {};
  const R = { ...DEFAULT_PAGE_RULES };
  for (const k of ['listingPriceMin', 'listingMicrodataMin']) if (Number.isFinite(Number(o[k])) && Number(o[k]) > 0) R[k] = Number(o[k]);
  for (const k of ['productTypes', 'listingTypes', 'productSegments', 'nonProductSegments', 'notFoundPatterns', 'ctaPatterns']) {
    if (Array.isArray(o[k])) R[k] = [...new Set([...DEFAULT_PAGE_RULES[k], ...o[k].map((x) => (k.endsWith('Patterns') ? String(x) : lc(x)))])];
  }
  if (Array.isArray(o.allowSegments)) { const allow = new Set(o.allowSegments.map(lc)); R.nonProductSegments = R.nonProductSegments.filter((s) => !allow.has(s)); }
  Object.defineProperty(R, '__merged', { value: true, enumerable: false });
  return R;
}

const decode = (s) => String(s || '')
  .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;|&#x27;/gi, "'").replace(/\s+/g, ' ').trim();
const stripTags = (s) => decode(String(s || '').replace(/<[^>]+>/g, ' '));

function metaContent(html, prop) {
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? decode(m[1]) : null;
}

function jsonLdNodes(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const visit = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(visit); return; }
      if (Array.isArray(n['@graph'])) n['@graph'].forEach(visit);
      out.push(n);
    };
    visit(data);
  }
  return out;
}

const typesOf = (n) => asArray(n && n['@type']).map(lc);
const normName = (s) => lc(s).replace(/[^a-z0-9à-ÿ]+/g, ' ').trim();

/**
 * Collect the page-level signals from an HTML string. Cheap, regex-based.
 * @param {string} html
 * @param {{url?:string, status?:number|null, rules?:object}} [opts]
 */
export function pageSignals(html, { url = '', status = null, rules } = {}) {
  const R = rules && rules.__merged ? rules : mergeRules(rules);
  const s = String(html || '');
  const title = decode((s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const h1 = stripTags((s.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
  const ogType = lc(metaContent(s, 'og:type') || '');
  const ogTitle = metaContent(s, 'og:title') || '';

  // schema.org (JSON-LD): product nodes (distinct by name), declared page/list types.
  const nodes = jsonLdNodes(s);
  const productNodes = nodes.filter((n) => typesOf(n).some((t) => R.productTypes.includes(t)));
  const productNames = new Set(productNodes.map((n) => normName(n.name || n.url || n.sku || '')).filter(Boolean));
  const mainEntityProduct = nodes.some((n) => asArray(n.mainEntity).some((e) => typesOf(e).some((t) => R.productTypes.includes(t))))
    // the page's own product: the one whose name is the <h1> or whose url is this page
    || (productNodes.length > 1 && productNodes.some((n) => (h1 && normName(n.name) === normName(h1)) || (url && lc(n.url || '').replace(/[?#].*$/, '') === lc(url).replace(/[?#].*$/, ''))));
  let listingType = null; let itemListSize = 0;
  for (const n of nodes) {
    for (const t of typesOf(n)) {
      if (!R.listingTypes.includes(t)) continue;
      const size = Array.isArray(n.itemListElement) ? n.itemListElement.length : 0;
      if (t !== 'itemlist' || size >= 2) { listingType = listingType || n['@type']; itemListSize = Math.max(itemListSize, size); }
    }
    for (const e of asArray(n.mainEntity)) if (typesOf(e).some((t) => R.listingTypes.includes(t))) listingType = listingType || e['@type'];
  }
  const microdataProducts = (s.match(/itemtype=["'][^"']*schema\.org\/(?:Product|IndividualProduct|ProductModel)["']/gi) || []).length;
  // Several microdata Products, but the page's <h1> sits inside one of them: that one
  // is the page's own product, the others its related products (a product page).
  const mainMicrodata = microdataProducts >= 2 && !!h1 && mainMicrodataProduct(s);

  // Visible text → price tokens + add-to-cart affordances.
  const text = decode(s.replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '));
  const priceCount = (text.match(MONEY_RE) || []).length;
  const addToCart = Math.max((text.match(ADD_TEXT_RE) || []).length, (s.match(ADD_ATTR_RE) || []).length);

  // "Page not found" wording on the page's own headline (never the body).
  const nf = new RegExp(R.notFoundPatterns.join('|'), 'i');
  const soft404 = [title, h1, ogTitle].find((x) => x && nf.test(x)) || null;

  // URL path.
  let segs = []; let search = ''; let host = '';
  try { const u = new URL(url); segs = u.pathname.split('/').filter(Boolean).map((x) => lc(decodeURIComponent(x))); search = u.search; host = u.hostname.replace(/^www\./, ''); } catch { /* no url */ }
  const productPath = segs.some((seg, i) => R.productSegments.includes(seg) && i < segs.length - 1);
  const nonProductSegment = productPath ? null : (segs.find((seg) => R.nonProductSegments.includes(seg)) || null);
  const isHome = !!host && (segs.length === 0 || (segs.length === 1 && /^[a-z]{2}(?:[-_][a-z]{2})?$/.test(segs[0])));
  const searchQuery = /[?&](q|query|search|s|keyword|k|term)=/i.test(search);
  const hostLabel = host ? host.split('.').slice(-2, -1)[0] || host : '';

  return {
    url, status, title, h1, ogType, ogTitle,
    productSchemaCount: productNames.size || (productNodes.length ? 1 : 0), mainEntityProduct,
    listingType: listingType ? String(asArray(listingType)[0]) : null, itemListSize, microdataProducts, mainMicrodata,
    priceCount, addToCart, soft404, productPath, nonProductSegment, isHome, searchQuery, hostLabel,
    __rules: R,
  };
}

/** Does a name read like the site's own page title ("Jeans Homme | Levi", "Dailymotion")? */
function looksLikeSiteTitle(name, hostLabel) {
  if (!name || !hostLabel) return false;
  const n = normName(name); const h = normName(hostLabel);
  if (!h) return false;
  if (n === h) return true;
  const parts = String(name).split(/\s(?:\||–|—|-|::|·|›)\s/);
  return parts.length > 1 && normName(parts[parts.length - 1]).replace(/\s/g, '').includes(h.replace(/\s/g, ''));
}

export const REASON_TEXT = Object.freeze({
  http_not_found: (d) => `page introuvable (${d})`,
  soft_404: (d) => `page d’erreur « introuvable » (titre : « ${d} »)`,
  multi_product_schema: (d) => `plusieurs blocs produit sur la page (${d} produits schema.org) — page de liste`,
  multi_product_microdata: (d) => `plusieurs blocs produit sur la page (${d} produits en microdonnées) — page de liste`,
  listing_schema: (d) => `type schema.org = ${d}, pas Product`,
  many_prices: (d) => `${d} prix sur la page — grille de produits`,
  many_prices_one_buy: (d) => `${d} prix sur la page (grille ou carrousel ?) et aucune donnée produit structurée, malgré un bouton d’achat`,
  home_page: () => 'page d’accueil du site',
  listing_links: (d) => `${d} liens produits et aucun prix — page de liste (liens récupérés)`,
  editorial_page: () => 'page éditoriale (article / guide / FAQ), pas un produit',
  no_product_signal: (d) => `aucun signal produit (ni prix, ni identifiant, ni schéma Product) — ${d}`,
  no_price_no_identity: () => 'ni prix ni identifiant détectés (produit sur devis ?)',
  weak_product_evidence: (d) => `prix trouvé hors données produit structurées, sans identifiant — ${d}`,
  item_empty: () => 'vignette sans nom ni lien',
  item_cta_tile: (d) => `vignette d’appel à l’action (« ${d} »), pas un produit`,
  // Content type "video" (core/content-reader.mjs).
  video_page: () => 'page vidéo (titre et adresse lus)',
  video_listing: (d) => `${d} vidéos listées sur la page — page de liste`,
  video_links: (d) => `${d} liens vidéo et aucune vidéo propre — page de liste`,
  no_video_signal: () => 'aucun signal vidéo (ni VideoObject, ni og:video, ni lecteur)',
});
/** Short labels for report breakdowns (code → French). */
export const REASON_LABEL = Object.freeze({
  http_not_found: 'page introuvable (404/410)', soft_404: 'page d’erreur « introuvable »',
  multi_product_schema: 'plusieurs blocs produit (schema.org)', multi_product_microdata: 'plusieurs blocs produit (microdonnées)',
  listing_schema: 'type schema.org de liste, pas Product', many_prices: 'grille de prix', many_prices_one_buy: 'beaucoup de prix, 1 bouton d’achat',
  home_page: 'page d’accueil', listing_links: 'liste de liens produits', editorial_page: 'page éditoriale', no_product_signal: 'aucun signal produit', no_price_no_identity: 'ni prix ni identifiant',
  weak_product_evidence: 'preuve produit faible', item_empty: 'vignette vide', item_cta_tile: 'vignette d’appel à l’action',
  video_page: 'page vidéo', video_listing: 'liste de vidéos', video_links: 'liste de liens vidéo', no_video_signal: 'aucun signal vidéo',
});

const hintText = {
  segment: (s) => `chemin d’URL de type catégorie/service (« ${s} »)`,
  search: () => 'page de recherche',
  home: () => 'page d’accueil',
  site_title: () => 'nom = titre du site',
  og_website: (t) => `og:type = ${t}`,
  listing: (t) => `type schema.org = ${t}`,
};

/**
 * Decide what a page is, given its signals and what was extracted from it.
 * @param {ReturnType<typeof pageSignals>} sig
 * @param {{name?:string, price?:number|null, gtin?:string, sku?:string}} [extracted]
 * @returns {{kind:string, firm:boolean, reasons:Array<{code:string, detail:string|number|null, text:string}>}}
 */
export function classifyPage(sig, extracted = {}) {
  const reasons = [];
  const add = (code, detail = null) => reasons.push({ code, detail, text: REASON_TEXT[code] ? REASON_TEXT[code](detail) : code });
  const out = (kind, firm = true) => ({ kind, firm, reasons });
  const x = extracted || {};
  const hasPrice = x.price != null && x.price !== '' && Number.isFinite(Number(x.price));
  const hasIdentity = !!(x.gtin || x.sku);
  const singleSchema = sig.productSchemaCount === 1 || sig.mainEntityProduct || !!sig.mainMicrodata;
  const ogProduct = /product/.test(sig.ogType || '');
  const structured = singleSchema || ogProduct || sig.microdataProducts === 1;

  if (sig.status === 404 || sig.status === 410) { add('http_not_found', `HTTP ${sig.status}`); return out(PAGE_KIND.NOT_FOUND); }
  if (sig.soft404 && !(singleSchema && hasPrice)) { add('soft_404', sig.soft404.slice(0, 80)); return out(PAGE_KIND.NOT_FOUND); }
  if (sig.productSchemaCount >= 2 && !sig.mainEntityProduct) { add('multi_product_schema', sig.productSchemaCount); return out(PAGE_KIND.LISTING); }
  const R = sig.__rules || DEFAULT_PAGE_RULES;
  if (sig.microdataProducts >= R.listingMicrodataMin && !singleSchema) { add('multi_product_microdata', sig.microdataProducts); return out(PAGE_KIND.LISTING); }
  const oneBuyButton = sig.addToCart >= 1 && sig.addToCart <= 3;
  if (sig.listingType && !singleSchema) {
    add('listing_schema', sig.listingType);
    return (hasPrice && hasIdentity && oneBuyButton) ? out(PAGE_KIND.UNCERTAIN, false) : out(PAGE_KIND.LISTING);
  }
  if (sig.priceCount >= R.listingPriceMin && !structured && !hasIdentity) {
    if (oneBuyButton) { add('many_prices_one_buy', sig.priceCount); return out(PAGE_KIND.UNCERTAIN, false); }
    add('many_prices', sig.priceCount);
    return out(PAGE_KIND.LISTING);
  }
  if (sig.isHome && !structured && !hasIdentity) { add('home_page'); return out(PAGE_KIND.NON_PRODUCT); }

  if (!hasPrice && !hasIdentity && !structured) {
    // Strong hints alone reject; weak hints (site-title name, og:type website)
    // need to agree; nothing at all → keep as "to verify" (a quote-only product).
    const strong = []; const weak = [];
    if (sig.nonProductSegment) strong.push(hintText.segment(sig.nonProductSegment));
    if (sig.searchQuery) strong.push(hintText.search());
    if (looksLikeSiteTitle(x.name, sig.hostLabel)) weak.push(hintText.site_title());
    if (sig.ogType && /^(website|article|blog|profile)$/.test(sig.ogType)) weak.push(hintText.og_website(sig.ogType));
    if (strong.length || weak.length >= 2) { add('no_product_signal', [...strong, ...weak].join(', ')); return out(PAGE_KIND.NON_PRODUCT); }
    add('no_price_no_identity');
    return out(PAGE_KIND.UNCERTAIN, false);
  }
  if (!structured && !hasIdentity && !sig.productPath && (sig.nonProductSegment || sig.searchQuery)) {
    add('weak_product_evidence', sig.nonProductSegment ? hintText.segment(sig.nonProductSegment) : hintText.search());
    return out(PAGE_KIND.UNCERTAIN, false);
  }
  return out(PAGE_KIND.PRODUCT);
}

/** Convenience: signals + verdict in one call. */
export function classifyHtmlPage(html, { url, status, extracted, rules } = {}) {
  const sig = pageSignals(html, { url, status, rules });
  const v = classifyPage(sig, extracted);
  return { ...v, signals: { productSchemaCount: sig.productSchemaCount, listingType: sig.listingType, priceCount: sig.priceCount, addToCart: sig.addToCart, soft404: !!sig.soft404, nonProductSegment: sig.nonProductSegment } };
}

/**
 * Is ONE listing tile a product (vs an empty/promo/call-to-action tile)? Used on
 * every item an extractor returns from a listing page, in both engines.
 * @returns {{ok:boolean, code?:string, text?:string}}
 */
export function classifyItem(item, rules) {
  const R = rules && rules.__merged ? rules : mergeRules(rules);
  const i = item || {};
  const name = String(i.name || i.title || '').trim();
  const url = i.url || i.sourceUrl || i.canonicalUrl || i.source_url;
  const id = i.sku || i.gtin || i.id || i.source_product_id;
  const hasPrice = i.price != null && i.price !== '';
  const no = (code, d = null) => ({ ok: false, code, text: REASON_TEXT[code](d) });
  if (!name && !url && !id) return no('item_empty');
  if (name && !hasPrice && !id && new RegExp(R.ctaPatterns.join('|'), 'i').test(name)) return no('item_cta_tile', name.slice(0, 40));
  return { ok: true };
}

/** Tally helper for reports: {byReason:{code:n}, samples:[{url, kind, reasons:[text]}]} (bounded). */
export function tallyVerdict(bag, { url, kind, reasons }, maxSamples = 20) {
  const b = bag || { count: 0, byReason: {}, samples: [] };
  b.count += 1;
  for (const r of reasons || []) b.byReason[r.code] = (b.byReason[r.code] || 0) + 1;
  if (b.samples.length < maxSamples) b.samples.push({ url: url || null, kind: kind || null, reasons: (reasons || []).map((r) => r.text) });
  return b;
}
