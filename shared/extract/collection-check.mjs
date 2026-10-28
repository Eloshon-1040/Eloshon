/**
 * Does a product belong to the collection it was listed in? Its OWN product page's breadcrumb (« Accueil > Kits de
 * tentes ») against the list's trail (« Lampe de culture LED ») — or the sub-collection it was read in (a hub page).
 * A product whose page names none of them is OUT of the collection: flagged « à vérifier », never imported as if it
 * were in. No verdict when the page shows no breadcrumb (nothing to compare): never a guess. Portable.
 */
const ROOT = /^(accueil|home|homepage|start|startseite|inicio|inizio|boutique|shop|store|magasin|winkel|tous les produits|all products|produits|products|non classe|uncategorized)$/;
const norm = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const stem = (w) => (w.length > 3 ? w.replace(/[sx]$/, '') : w); // « lampes » = « lampe », « séries » = « série »
const words = (s) => norm(s).split(' ').filter((w) => w && w.length > 1 && !/^(de|du|des|la|le|les|et|en|pour|the|and|for|of|van|het|voor|el|los|para)$/.test(w)).map(stem);
/** Two category names say the same thing: equal, or every word of the shorter is in the longer (« Série FC-E » ⊂ « FC-E Série - LED Bridgelux »). */
export function sameCategory(a, b) {
  const x = words(a); const y = words(b);
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, new Set(y)] : [y, new Set(x)];
  return short.every((w) => long.has(w));
}

// The audience a text names (a list « chaussures-hommes », a card « Femmes Originals »), or null. Unisex says unisex.
const AUDIENCE = [
  ['unisex', /\b(unisexe?|mixte|unisex)\b/],
  ['kids', /\b(enfants?|kids?|junior|juniors|kinderen|kinder|ninos|ninas|bambini|bebes?|babys?|baby|garcons?|filles?|boys|girls)\b/],
  ['women', /\b(femmes?|women|womens|woman|ladies|dames|damen|mujer|mujeres|donna|donne|vrouwen)\b/],
  ['men', /\b(hommes?|men|mens|man|heren|herren|hombres?|uomo|uomini|mannen)\b/],
];
export function audienceOf(text) {
  const t = norm(text); if (!t) return null;
  const hits = AUDIENCE.filter(([, re]) => re.test(t)).map(([a]) => a);
  if (hits.includes('unisex')) return 'unisex';
  return hits.length === 1 ? hits[0] : null; // « hommes et femmes »: not one audience
}
const AUDIENCE_TEXT = { men: 'hommes', women: 'femmes', kids: 'enfants' };

/**
 * The list is for one audience (« chaussures-hommes ») and the product says another (its card « Femmes Originals »,
 * its page): out of the collection. A unisex product, or one that says nothing, belongs.
 * @param {{listText?:string, productTexts?:string[]}} o
 */
export function audienceVerdict({ listText = '', productTexts = [] } = {}) {
  const want = audienceOf(listText);
  if (!want || want === 'unisex') return null;
  for (const t of productTexts) {
    if (typeof t !== 'string' || !t.trim() || t.length > 80) continue; // a short label, never a whole description
    const got = audienceOf(t);
    if (!got) continue;
    if (got === 'unisex' || got === want) return null;
    return { code: 'out_of_collection', reason: `hors de la collection : le produit est indiqué « ${t.trim().slice(0, 60)} » (${AUDIENCE_TEXT[got]}), la liste lue est pour les ${AUDIENCE_TEXT[want]}` };
  }
  return null;
}

/**
 * @param {{listTrail?:string[], expected?:string|null, crumb?:string[]|null}} o  crumb: the product page's own breadcrumb
 * @returns {null|{code:'out_of_collection', reason:string}}
 */
export function collectionVerdict({ listTrail = [], expected = null, crumb = null } = {}) {
  const own = (Array.isArray(crumb) ? crumb : []).filter((c) => typeof c === 'string' && c.trim() && !ROOT.test(norm(c)));
  if (!own.length) return null; // the page says nothing: no verdict
  const want = [...(Array.isArray(listTrail) ? listTrail : []), ...(expected ? [expected] : [])].filter((c) => typeof c === 'string' && c.trim() && !ROOT.test(norm(c)));
  if (!want.length) return null;
  if (want.some((w) => own.some((c) => sameCategory(w, c)))) return null;
  return { code: 'out_of_collection', reason: `hors de la collection : la fiche est classée « ${own.join(' > ').slice(0, 120)} », la liste lue est « ${want.join(' > ').slice(0, 120)} »` };
}
