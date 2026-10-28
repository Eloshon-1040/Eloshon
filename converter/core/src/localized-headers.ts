// A WooCommerce store exports its product CSV with the headers translated into the
// admin's language ("UGS", "Tarif régulier", "Méta : x" for "SKU", "Regular price",
// "Meta: x"). The format detector and the importers speak the English headers, so
// a French export came back `unrecognized`. When a file is recognisably a
// localised WooCommerce export, its headers are put back to English at parse time:
// the user's file is not altered, only how it is read.
//
// Certain (read from a real French export): ID, Type, UGS, Nom, Description courte,
// Description, Tarif promo, Tarif régulier, Catégories, Étiquettes, URL externe,
// Marques, "Méta : <clé>". The others are WooCommerce's French labels as best known;
// a header that does not match exactly is simply left as it is.

const WOO_FR: Record<string, string> = {
  'ID': 'ID', 'Type': 'Type', 'UGS': 'SKU', 'GTIN, UPC, EAN ou ISBN': 'GTIN, UPC, EAN, or ISBN',
  'Nom': 'Name', 'Publié': 'Published', 'Est mis en avant ?': 'Is featured?', 'Mis en avant ?': 'Is featured?',
  'Visibilité dans le catalogue': 'Visibility in catalog',
  'Description courte': 'Short description', 'Description': 'Description',
  'Date de début de promo': 'Date sale price starts', 'Date de fin de promo': 'Date sale price ends',
  'Statut de taxe': 'Tax status', 'Statut de la taxe': 'Tax status', 'Classe de taxe': 'Tax class',
  'En stock ?': 'In stock?', 'Stock': 'Stock', 'Quantité de stock': 'Stock',
  'Montant de stock faible': 'Low stock amount', 'Seuil de stock bas': 'Low stock amount',
  'Autoriser les commandes en rupture ?': 'Backorders allowed?', 'Autoriser les commandes différées ?': 'Backorders allowed?',
  'Vendu individuellement ?': 'Sold individually?',
  'Poids (kg)': 'Weight (kg)', 'Longueur (cm)': 'Length (cm)', 'Largeur (cm)': 'Width (cm)', 'Hauteur (cm)': 'Height (cm)',
  'Autoriser les avis clients ?': 'Allow customer reviews?', 'Note d’achat': 'Purchase note', "Note d'achat": 'Purchase note',
  'Tarif promo': 'Sale price', 'Tarif régulier': 'Regular price',
  'Catégories': 'Categories', 'Étiquettes': 'Tags', 'Classe d’expédition': 'Shipping class', "Classe d'expédition": 'Shipping class',
  'Images': 'Images', 'Limite de téléchargement': 'Download limit', 'Jours d’expiration du téléchargement': 'Download expiry days',
  "Jours d'expiration du téléchargement": 'Download expiry days',
  'Parent': 'Parent', 'Produits groupés': 'Grouped products', 'Montées en gamme': 'Upsells', 'Produits suggérés': 'Upsells',
  'Ventes croisées': 'Cross-sells', 'URL externe': 'External URL', 'Texte du bouton': 'Button text', 'Position': 'Position', 'Marques': 'Brands',
};

const ATTR: [RegExp, (n: string) => string][] = [
  [/^Nom de l[’']attribut (\d+)$/, (n) => `Attribute ${n} name`],
  [/^Valeur\(s\) de l[’']attribut (\d+)$/, (n) => `Attribute ${n} value(s)`],
  [/^Attribut (\d+) visible$/, (n) => `Attribute ${n} visible`],
  [/^Attribut (\d+) global$/, (n) => `Attribute ${n} global`],
  [/^Attribut (\d+) par défaut$/, (n) => `Attribute ${n} default`],
];

export type LocalizedHeaders = { headers: string[]; locale?: 'woocommerce-fr' };

/** The English headers of a localised WooCommerce product export, or the headers untouched. */
export function canonicalizeHeaders(headers: string[]): LocalizedHeaders {
  const has = new Set(headers);
  // "UGS" + "Tarif régulier" together only exist in a French WooCommerce export.
  if (!(has.has('UGS') && has.has('Tarif régulier'))) return { headers };
  const out = headers.map((h) => {
    if (WOO_FR[h]) return WOO_FR[h];
    if (/^Méta ?: /.test(h)) return h.replace(/^Méta ?: /, 'Meta: ');
    for (const [re, to] of ATTR) { const m = h.match(re); if (m) return to(m[1]); }
    return h;
  });
  return { headers: out, locale: 'woocommerce-fr' };
}
