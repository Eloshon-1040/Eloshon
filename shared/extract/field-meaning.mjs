/**
 * What a side-panel field MEANS, from the name the user gave it (and its AI hint):
 * the product name, the selling price, the list (struck) price, the image, the
 * link, the reference, the EAN — or a free extra column. Multilingual keywords, no
 * site rule. A template field the user renamed takes the meaning of its NEW name:
 * "Nom" renamed "Valeur de réduction" is no longer the product name.
 */

const strip = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const slug = (s) => strip(s).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24);

const PRICE = /\b(prix|price|tarif|preis|prijs|precio|prezzo|cout|kosten)\b/;
const LIST = /\b(base|barre|initial|origin|original|avant|ancien|catalogue|conseille|list|regulier|normal|habituel|plein|was|before|uvp|statt|vorher|oud|oorspronkelijk|van)\b/;
const SALE = /\b(apres|reduit|solde|soldes|promo|promotion|actuel|vente|final|now|sale|current|aktuell|reduziert|nu|actie|avec reduction|remise)\b/;
const DISCOUNT = /\b(reduction|remise|rabais|discount|rabatt|korting|descuento|sconto|pourcentage|percent)\b|%/;
const RULES = [
  ['image', /\b(image|images|photo|photos|visuel|vignette|picture|bild|afbeelding|imagen|thumbnail)\b/],
  // Technical specifications are PAIRS (label → value), not a description text: matched
  // first, so "Caractéristiques techniques" / "Fiche technique" never collide with the description.
  ['technical_specs', /\b(caracteristique|caracteristiques|fiche technique|donnees techniques|specification|specifications|specs|technical|technique|techniques|technische daten|kenmerken|eigenschappen|ficha tecnica|scheda tecnica)\b/],
  // Before the link and the name: "Détail de produit" is a text.
  ['description', /\b(description|descriptif|detail|details|beschreibung|omschrijving|descripcion|descrizione)\b/],
  ['brand', /\b(marque|marques|brand|brands|merk|marca|marke|fabricant|manufacturer)\b/],
  // A product collection / range / department: the product's category.
  ['category', /\b(collection|collections|categorie|categories|category|gamme|rayon|univers|famille|departement|department|kategorie|categoria|categoria)\b/],
  ['url', /\b(lien|url|link|adresse|href|fiche|page)\b/],
  ['ean', /\b(ean|gtin|upc|code barre|code-barre|barcode|codebarre)\b/],
  ['sku', /\b(reference|ref|sku|code article|article|artikel|modele code|style)\b/],
  ['name', /\b(nom|name|titre|title|produit|product|designation|libelle|intitule|naam|nombre|titel)\b/],
];

/**
 * @param {{key?:string, label?:string, hint?:string}} f
 * @returns {string} 'name' | 'price' | 'list_price' | 'image' | 'url' | 'sku' | 'ean' | a free key (slug)
 */
export function fieldMeaning(f) {
  const label = strip(f && f.label);
  const text = `${label} ${strip(f && f.hint)}`.replace(/[_-]+/g, ' ');
  if (PRICE.test(text)) {
    if (SALE.test(text)) return 'price';
    if (LIST.test(text)) return 'list_price';
    if (!DISCOUNT.test(label)) return 'price';
  }
  if (DISCOUNT.test(label)) return slug(f.label) || 'reduction';
  for (const [key, re] of RULES) if (re.test(label)) return key;
  return slug(f && f.label) || (f && f.key) || 'champ';
}

/**
 * Keys for a whole field list: a template field keeps its key while it keeps its
 * template name; any other field gets the meaning of its name. A meaning already
 * taken by an earlier field becomes a free column, so two fields never overwrite
 * each other.
 * @param {Array<{key:string, label:string, hint?:string}>} fields
 * @param {Object<string,string>} defaultLabels  template key → template label
 * @returns {string[]} one key per field
 */
export function fieldKeys(fields, defaultLabels = {}) {
  const used = new Set();
  return (fields || []).map((f, i) => {
    // A role the user chose wins over the name: « Nom de variante » set to « nom de variante » is a column of its
    // own, « Tarif » set to « prix de vente » reads the price. ('auto' or none = the meaning of the name.)
    const chosen = f && f.role && f.role !== 'auto' && ROLES.includes(f.role) ? (keyOfRole(f.role) || slug(f.label) || `champ_${i + 1}`) : null;
    let k = chosen || (f && defaultLabels[f.key] && strip(defaultLabels[f.key]) === strip(f.label) ? f.key : fieldMeaning(f || {}));
    if (used.has(k)) k = slug(f && f.label) && !used.has(slug(f.label)) ? slug(f.label) : `champ_${i + 1}`;
    used.add(k);
    return k;
  });
}

/** Short French description of a meaning, for the panel. */
export function meaningLabel(key) {
  return ({ name: 'nom du produit', price: 'prix de vente', list_price: 'prix barré (avant réduction)', image: 'image', url: 'lien de la fiche', sku: 'référence', ean: 'code EAN', description: 'description', technical_specs: 'caractéristiques techniques (liste nom → valeur)', brand: 'marque', category: 'collection / catégorie' })[key] || 'colonne libre';
}

// Names of a field that holds a LIST of values on one product (the sizes, lengths,
// colours offered): the click takes the whole group of entries, "28 | 29 | 30".
const LIST_RE = /\b(tailles?|sizes?|pointures?|longueurs?|lengths?|waist|inseam|largeurs?|couleurs?|coloris|colou?rs?|variantes?|variants?|options?|declinaisons?|formats?|contenances?|capacites?|maten|lengtes?|kleuren|groessen|grossen|farben)\b/;
/** Does this field (by its name or hint) hold a list of values? */
export function isListField(f) {
  const text = `${strip(f && f.label)} ${strip(f && f.hint)}`.replace(/[_-]+/g, ' ');
  return LIST_RE.test(text);
}

// ---- Roles for the Converter -----------------------------------------------------------------------------
// The NAME a user types for a field is kept as typed (it becomes the column header). Its ROLE — what the
// Converter does with the column — is a separate choice, suggested from the name and changed at will. A
// field may look like another one (« Nom de variante » contains « nom »): that suggests, it never blocks.

/** Every role, in the order a person picks from. */
export const ROLES = ['title', 'price', 'list_price', 'description', 'technical_specs', 'brand', 'category', 'image', 'url', 'sku', 'ean', 'availability', 'variants', 'variant_name', 'option', 'size', 'color', 'attribute', 'product_type', 'tags', 'status'];
/** French label of a role (the panel's language). */
export const ROLE_LABEL = {
  title: 'titre du produit', price: 'prix de vente', list_price: 'prix barré', description: 'description',
  technical_specs: 'caractéristiques techniques', brand: 'marque', category: 'collection / catégorie', image: 'image(s)',
  url: 'lien de la fiche', sku: 'référence', ean: 'code EAN', availability: 'disponibilité', variants: 'variantes (liste avec prix)',
  variant_name: 'nom de variante', option: 'option (axe de variantes)', size: 'taille', color: 'couleur', attribute: 'personnalisée (sa colonne se choisit dans le Converter)',
  product_type: 'type de produit', tags: 'étiquettes', status: 'statut à l’import',
};
// The row key a role reads into (the extraction keys the app and the extension already use). The variant
// roles and the free attribute have no key of their own: the column keeps its own key (raw.columns).
const KEY_OF_ROLE = { title: 'name', price: 'price', list_price: 'list_price', description: 'description', technical_specs: 'technical_specs', brand: 'brand', category: 'category', image: 'image', url: 'url', sku: 'sku', ean: 'ean', availability: 'availability', variants: 'variants', product_type: 'product_type', tags: 'tags', status: 'status' };
const ROLE_OF_KEY = Object.fromEntries(Object.entries(KEY_OF_ROLE).map(([r, k]) => [k, r]));

const VARIANT_WORD = /\b(variantes?|variants?|declinaisons?|varianten?|variaciones?)\b/;
const NAME_WORD = /\b(nom|name|naam|nombre|libelle|titre|title|titel|intitule)\b/;
const SIZE_WORD = /\b(tailles?|sizes?|pointures?|maten|maat|groessen?|grossen?|tallas?|longueurs?|lengths?|waist|inseam)\b/;
const COLOR_WORD = /\b(couleurs?|coloris|colou?rs?|kleur|kleuren|farben?|colores?|teintes?)\b/;
const OPTION_WORD = /\b(options?|formats?|contenances?|capacites?|volumes?|parfums?|saveurs?|materiaux|matiere)\b/;

/**
 * The role suggested for a field from its name (and hint). Never final: the user changes it.
 * @param {{label?:string, hint?:string, key?:string}} f
 * @returns {string} one of ROLES
 */
export function suggestRole(f) {
  const text = `${strip(f && f.label)} ${strip(f && f.hint)}`.replace(/[_-]+/g, ' ');
  if (!PRICE.test(text)) {
    if (VARIANT_WORD.test(text) && NAME_WORD.test(text)) return 'variant_name';
    if (SIZE_WORD.test(text)) return 'size';
    if (COLOR_WORD.test(text)) return 'color';
    if (VARIANT_WORD.test(text)) return 'variants';
    if (OPTION_WORD.test(text)) return 'option';
  }
  const m = fieldMeaning(f || {});
  return ROLE_OF_KEY[m] || 'attribute';
}

/** The role of a field: the one the user chose, else the one its name suggests. */
export function roleOf(f) {
  return f && f.role && ROLES.includes(f.role) ? f.role : suggestRole(f || {});
}

/** The row key a chosen role reads into (null for the variant roles and the free attribute). */
export const keyOfRole = (role) => KEY_OF_ROLE[role] || null;

/** A column key free in `used`, from the label (« Nom de variante » → nom_de_variante, then _2, _3…). */
export function freeKey(label, used = new Set()) {
  const base = slug(label) || 'champ';
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) { const k = `${base.slice(0, 21)}_${i}`; if (!used.has(k)) return k; }
}
