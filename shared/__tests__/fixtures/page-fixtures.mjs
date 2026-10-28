/**
 * Realistic page fixtures for the "is this a product page?" rules — clear product
 * pages, clear non-product pages (collection, promo, service, 404…) and ambiguous
 * edge cases. Generic hosts (*.test / *.example): no real site. Shared by the
 * shared-rules tests, the standard-engine tests and the extension-path tests so
 * all three prove the SAME verdicts.
 *
 * Each fixture: { id, url, status, html, extracted (what an extractor would get
 * from the page), expect: kind, note }.
 */
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const page = ({ title, head = '', body = '' }) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><header><nav><a href="/">Accueil</a> <a href="/c/promos">Promos</a> <a href="/panier">Panier</a></nav></header>${body}<footer><a href="/aide">Aide</a> <a href="/cookies">Cookies</a></footer></body></html>`;
const card = (i, price) => `<article class="product-tile"><a href="/p/tile-${i}"><img src="/img/${i}.jpg" alt=""><h3>Produit ${i}</h3></a><span class="price">${price} €</span></article>`;
const grid = (n, from = 10) => `<section class="grid">${Array.from({ length: n }, (_, i) => card(i + 1, `${from + i},99`)).join('')}</section>`;
const related = (n) => `<aside class="related"><h2>Vous aimerez aussi</h2>${Array.from({ length: n }, (_, i) => `<div class="mini"><a href="/p/rel-${i}">Article ${i}</a><span>${20 + i},50 €</span></div>`).join('')}</aside>`;
const buy = '<button type="submit" class="btn add-to-cart" data-action="add-to-cart">Ajouter au panier</button>';

export const PRODUCT_FIXTURES = [
  {
    id: 'P1-jsonld-product', note: 'fiche JSON-LD Product + ItemList "related" + carrousel de prix',
    url: 'https://www.boutique-alpha.test/p/chaise-oslo-123', status: 200,
    html: page({
      title: 'Chaise Oslo chêne | Boutique Alpha',
      head: `<meta property="og:type" content="product">${ld({ '@context': 'https://schema.org', '@type': 'Product', name: 'Chaise Oslo chêne', sku: 'OSL-123', gtin13: '5410000000017', image: '/img/oslo.jpg', offers: { '@type': 'Offer', price: '89.00', priceCurrency: 'EUR' } })}${ld({ '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', position: 1, url: '/p/a' }, { '@type': 'ListItem', position: 2, url: '/p/b' }, { '@type': 'ListItem', position: 3, url: '/p/c' }] })}`,
      body: `<main><h1>Chaise Oslo chêne</h1><span class="price">89,00 €</span>${buy}${related(10)}</main>`,
    }),
    extracted: { name: 'Chaise Oslo chêne', price: 89, sku: 'OSL-123', gtin: '5410000000017' },
    expect: 'product',
  },
  {
    id: 'P2-og-product-no-jsonld', note: 'fiche sans JSON-LD mais og:type=product, formulaire d’ajout au panier',
    url: 'https://shop.magasin-beta.example/products/lampe-arc', status: 200,
    html: page({
      title: 'Lampe arc laiton – Magasin Beta',
      head: '<meta property="og:type" content="product"><meta property="og:title" content="Lampe arc laiton"><meta property="product:price:amount" content="149.00">',
      body: `<main><h1>Lampe arc laiton</h1><div class="price">149,00 €</div><form action="/cart/add" method="post"><button class="product-form__submit">Ajouter au panier</button></form></main>`,
    }),
    extracted: { name: 'Lampe arc laiton', price: 149 },
    expect: 'product',
  },
  {
    id: 'P3-quote-only-product', note: 'produit « sur devis » : Product sans offre (pas de prix) — reste un produit',
    url: 'https://www.pro-gamma.test/fr/machines/presse-hydraulique-p42', status: 200,
    html: page({
      title: 'Presse hydraulique 42 t',
      head: ld({ '@type': 'Product', name: 'Presse hydraulique 42 t', sku: 'PH-42', brand: { '@type': 'Brand', name: 'Gamma' } }),
      body: '<main><h1>Presse hydraulique 42 t</h1><p>Prix sur demande.</p><a href="/devis?ref=PH-42" class="btn">Demander un devis</a></main>',
    }),
    extracted: { name: 'Presse hydraulique 42 t', price: null, sku: 'PH-42' },
    expect: 'product',
  },
  {
    id: 'P4-main-product-among-related-nodes', note: 'plusieurs Product JSON-LD de premier niveau, dont celui de la page (= h1)',
    url: 'https://www.boutique-alpha.test/p/table-nord-9', status: 200,
    html: page({
      title: 'Table Nord | Boutique Alpha',
      head: ld([{ '@type': 'Product', name: 'Table Nord', sku: 'TN-9', offers: { price: '299', priceCurrency: 'EUR' } }, { '@type': 'Product', name: 'Banc Nord', offers: { price: '129', priceCurrency: 'EUR' } }, { '@type': 'Product', name: 'Chaise Nord', offers: { price: '79', priceCurrency: 'EUR' } }]),
      body: `<main><h1>Table Nord</h1><span>299,00 €</span>${buy}</main>`,
    }),
    extracted: { name: 'Table Nord', price: 299, sku: 'TN-9' },
    expect: 'product',
  },
  {
    id: 'P5-name-with-404', note: 'nom de produit contenant « 404 » — ne doit PAS passer pour une page d’erreur',
    url: 'https://www.auto-delta.test/annonces/peugeot-404-berline-1965', status: 200,
    html: page({ title: 'Peugeot 404 berline 1965 | Auto Delta', body: '<main><h1>Peugeot 404 berline 1965</h1><p class="price">8 500 €</p><p>Contrôle technique OK.</p></main>' }),
    extracted: { name: 'Peugeot 404 berline 1965', price: 8500 },
    expect: 'product',
  },
];

export const NON_PRODUCT_FIXTURES = [
  {
    id: 'N1-collection-page', note: 'page catégorie : CollectionPage + ItemList, 12 prix, URL /c/',
    url: 'https://www.boutique-alpha.test/c/chaises', status: 200,
    html: page({
      title: 'Chaises | Boutique Alpha',
      head: `<meta property="og:type" content="website">${ld({ '@type': 'CollectionPage', name: 'Chaises', mainEntity: { '@type': 'ItemList', itemListElement: Array.from({ length: 12 }, (_, i) => ({ '@type': 'ListItem', position: i + 1, url: `/p/tile-${i + 1}` })) } })}`,
      body: `<main><h1>Chaises</h1>${grid(12)}</main>`,
    }),
    extracted: { name: 'Chaises', price: 10.99 },
    expect: 'listing',
  },
  {
    id: 'N2-grid-one-product-schema-per-tile', note: 'grille avec un bloc Product JSON-LD par vignette (6 produits)',
    url: 'https://www.magasin-beta.example/luminaires', status: 200,
    html: page({
      title: 'Luminaires – Magasin Beta',
      head: Array.from({ length: 6 }, (_, i) => ld({ '@type': 'Product', name: `Lampe ${i + 1}`, offers: { price: `${30 + i}.00`, priceCurrency: 'EUR' } })).join(''),
      body: `<main><h1>Luminaires</h1>${grid(6, 30)}</main>`,
    }),
    extracted: { name: 'Lampe 1', price: 30 },
    expect: 'listing',
  },
  {
    id: 'N3-soft-404', note: 'annonce expirée : 200 + titre « page n’a pas été trouvée » (cas du job 20260929165036-g8hh3)',
    url: 'https://www.annonces-epsilon.test/v/animaux/m2448051103-couple-reproducteur', status: 200,
    html: page({ title: "Malheureusement, la page n'a pas été trouvée.", head: `<meta property="og:title" content="Malheureusement, la page n'a pas été trouvée."><meta property="og:image" content="/logo.png">`, body: "<main><h1>Malheureusement, la page n'a pas été trouvée.</h1><p>Retournez à l’accueil.</p></main>" }),
    extracted: { name: "Malheureusement, la page n'a pas été trouvée.", price: null },
    expect: 'not_found',
  },
  {
    id: 'N4-http-404', note: 'réponse HTTP 404',
    url: 'https://www.boutique-alpha.test/p/disparu-9', status: 404,
    html: page({ title: 'Oups', body: '<main><h1>Oups</h1></main>' }),
    extracted: { name: 'Oups', price: null },
    expect: 'not_found',
  },
  {
    id: 'N5-promo-page', note: 'page promo « Actions de la semaine » : 9 prix, pas de schéma, pas de bouton d’achat',
    url: 'https://www.discount-zeta.test/c/fr-BE/actions-cette-semaine/a10082242', status: 200,
    html: page({ title: 'Actions de la semaine', body: `<main><h1>Actions de la semaine</h1>${Array.from({ length: 9 }, (_, i) => `<div class="teaser"><a href="/p/promo-${i}">Offre ${i}</a><span>${2 + i},49 €</span><span class="old">${3 + i},99 €</span></div>`).join('')}</main>` }),
    extracted: { name: 'Actions de la semaine', price: 2.49 },
    expect: 'listing',
  },
  {
    id: 'N6-csr-category-no-price', note: 'catégorie rendue en JS : titre « X | Site », URL /c/, aucun prix (cas Levi/Lidl/leboncoin)',
    url: 'https://www.denim-eta.test/BE/fr_BE/vetements/homme/jeans/c/eta_men_jeans', status: 200,
    html: page({ title: 'Jeans Homme | Denim-eta', head: '<meta property="og:type" content="website"><meta property="og:title" content="Jeans Homme | Denim-eta">', body: '<div id="app"></div>' }),
    extracted: { name: 'Jeans Homme | Denim-eta', price: null },
    expect: 'non_product',
  },
  {
    id: 'N7-legal-page', note: 'page légale « cookies » sous /c/',
    url: 'https://www.discount-zeta.test/c/fr-BE/declaration-relative-aux-cookies/s10005724', status: 200,
    html: page({ title: 'Déclaration relative aux cookies | Discount Zeta', body: '<main><h1>Déclaration relative aux cookies</h1><p>Texte légal…</p></main>' }),
    extracted: { name: 'Déclaration relative aux cookies', price: null },
    expect: 'non_product',
  },
  {
    id: 'N8-home-page', note: 'page d’accueil (racine de langue)',
    url: 'https://www.video-theta.test/fr', status: 200,
    html: page({ title: 'Video-theta', head: '<meta property="og:type" content="website">', body: '<main><h1>Bienvenue</h1></main>' }),
    extracted: { name: 'Video-theta', price: null },
    expect: 'non_product',
  },
  {
    id: 'N9-search-results', note: 'résultats de recherche ?q=',
    url: 'https://www.boutique-alpha.test/recherche?q=chaise', status: 200,
    html: page({ title: 'Recherche « chaise »', head: ld({ '@type': 'SearchResultsPage', name: 'chaise' }), body: `<main>${grid(4)}</main>` }),
    extracted: { name: 'Recherche « chaise »', price: 10.99 },
    expect: 'listing',
  },
  {
    id: 'N10-microdata-grid', note: 'grille en microdonnées : 4 itemscope Product',
    url: 'https://www.brico-iota.test/fr/outillage', status: 200,
    html: page({ title: 'Outillage', body: `<main><h1>Outillage</h1>${Array.from({ length: 4 }, (_, i) => `<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Outil ${i}</span><span itemprop="price" content="${15 + i}">${15 + i},00 €</span></div>`).join('')}</main>` }),
    extracted: { name: 'Outil 0', price: 15 },
    expect: 'listing',
  },
];

export const AMBIGUOUS_FIXTURES = [
  {
    id: 'A1-no-evidence-neutral-url', note: 'ni prix, ni identifiant, ni schéma, URL neutre — gardé « à vérifier »',
    url: 'https://www.micro-kappa.test/fr/40-extracteurs-vents', status: 200,
    html: page({ title: 'Extracteurs Vents', body: '<main><h1>Extracteurs Vents</h1><div id="products"></div></main>' }),
    extracted: { name: 'Extracteurs Vents', price: null },
    expect: 'uncertain',
  },
  {
    id: 'A2-dom-fiche-with-carousel', note: 'fiche sans aucune donnée structurée + carrousel de 10 prix + 1 bouton d’achat',
    url: 'https://www.boutique-lambda.test/table-basse-noyer', status: 200,
    html: page({ title: 'Table basse noyer', body: `<main><h1>Table basse noyer</h1><span class="price">249,00 €</span>${buy}${related(10)}</main>` }),
    extracted: { name: 'Table basse noyer', price: 249 },
    expect: 'uncertain',
  },
  {
    id: 'A3-service-page-with-teaser-price', note: 'page de service « Newsletter » avec un prix d’accroche (cas Lidl « Newsletter » accepté)',
    url: 'https://www.discount-zeta.test/c/fr-BE/abonner/s10008105', status: 200,
    html: page({ title: 'Newsletter', head: '<meta property="og:type" content="website">', body: '<main><h1>Newsletter</h1><div class="teaser"><span class="price">60,00 €</span> bon d’achat à gagner</div></main>' }),
    extracted: { name: 'Newsletter', price: 60 },
    expect: 'uncertain',
  },
];

export const ALL_FIXTURES = [...PRODUCT_FIXTURES, ...NON_PRODUCT_FIXTURES, ...AMBIGUOUS_FIXTURES];
