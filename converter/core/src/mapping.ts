import type { FormatId, Entity, Row } from './types';
import type { Table } from './csv';
import type { SemanticReport } from '../knowledge-proposal/semantic.mjs';
import type { LearnedDecision } from '../knowledge-proposal/schema';
import { recognizeColumns } from '../knowledge-proposal/semantic.mjs';
import { loadCanonCatalogSync, loadRecognitionConfigSync } from '../knowledge-proposal/reference.mjs';
import { productDestinations } from './destinations';
import type { ProductTarget } from './destinations';

// ── Declarative correspondence layer (ÉTAPE 2) ───────────────────────────────
// The engine's real correspondence is imperative and split across parsers
// (source column → canonical field) and serializers (canonical field → target
// column), meeting at the canonical IR. This module makes that correspondence
// VISIBLE and, for the simple scalar fields, EDITABLE — without rewriting a
// single transform.
//
// Two joinable tables describe what the code already does:
//   SOURCE_FIELDS[sourceFormat] — each fixed column a parser reads, its canon
//                                 field, transform, whether it is re-pointable.
//   TARGET_FIELDS[targetFormat] — for each canon field, the target column(s) a
//                                 serializer writes (empty = not carried over).
// A plan for (source → target) is the JOIN on canon field. This also surfaces
// real losses honestly (a source field whose canon key has no target column).
//
// Editing is SAFE by construction: an override re-points or drops a scalar
// SOURCE column, applied as an alias on the parsed Table BEFORE the unchanged
// parser runs (applyOverridesToTable). With no overrides, nothing changes, so
// the output is byte-for-byte identical to today (guarded by the golden tests).

export const MAPPING_RULES_VERSION = 1;

// Deterministic confidence in how a source column was matched to its field.
//   high  (Élevée)      — the field's default column is present, exact name.
//   check (À vérifier)  — matched via a known near-name/alias, OR the user
//                         re-pointed it, OR the field is semantically tricky
//                         (e.g. compare-at price vs sale price).
//   low   (Faible)      — matched by a value heuristic (cell contents), no name.
//   none  (Non utilisée)— a source column present in the file with no destination.
export type Confidence = 'high' | 'check' | 'low' | 'none';

// A transform is referenced by a stable id; complex ones stay as code in the
// parsers/serializers. This is documentation + a UI label, not an interpreter.
export type TransformId =
  | 'copy' | 'text' | 'html' | 'list' | 'bool' | 'enum' | 'money'
  | 'int' | 'grams_from_kg' | 'kg_from_grams' | 'price_promo' | 'url'
  | 'images' | 'options' | 'metafields' | 'category_path' | 'derived'
  | 'consent' | 'state' | 'address' | 'lineitems' | 'order_status'
  | 'vat_rate' | 'currency' | 'unit_price';

// One correspondence line, source side. `column` is the default column the
// parser reads; `aliases` are known near-names that count as "À vérifier".
export type SourceField = {
  id: string;               // stable, usually the canon key
  canon: string;            // canonical field key (join key to TARGET_FIELDS)
  scope: 'product' | 'variant';
  column: string;           // default source column name
  aliases?: string[];       // known near-names (→ confidence 'check')
  transform: TransformId;
  editable: boolean;        // re-pointable/excludable (simple single-column copy)
  reviewAlways?: boolean;   // force ≥ 'check' even on an exact match (tricky field)
  sourceRequired?: boolean; // the SOURCE must provide this (e.g. product title)
  descFr: string;
  descEn: string;
};

export type TargetField = { cols: string[]; required?: boolean };

export type MappingOverride = { column: string | null }; // null = do not import
export type MappingOverrides = Record<string, MappingOverride>; // by SourceField.id

// A resolved line for the UI: the rule + how it bound to THIS file.
export type FieldBinding = {
  id: string;
  canon: string;
  scope: 'product' | 'variant';
  transform: TransformId;
  editable: boolean;
  defaultColumn: string;    // the parser's expected column
  resolvedColumn: string | null; // the column actually feeding it (after override)
  present: boolean;         // resolvedColumn exists in the file
  overridden: boolean;      // the user changed it
  // true = the parser reads resolvedColumn as-is (exact match or an override).
  // false = a near-name SUGGESTION only; it feeds the conversion only once
  // accepted (via suggestedOverrides / a user override), never silently.
  applied: boolean;
  confidence: Confidence;
  // 0..1 — how sure the match is: 1 exact name, the alias tier for a known
  // near-name, null when the user chose the column (their word, not a score).
  score: number | null;
  sample: string;           // first non-empty value of resolvedColumn ('' without sample rows)
  prefilled: boolean;       // the override is the engine's own suggestion, not yet the user's choice
  targetColumns: string[];  // where it lands in the target ([] = not carried over)
  carried: boolean;         // has a destination in the target
  descFr: string;
  descEn: string;
};

export type UnusedColumn = { column: string; confidence: 'none'; sample: string };

export type AnalyzedPlan = {
  version: number;
  sourceFormat: FormatId;
  targetFormat: FormatId;
  entity: Entity;
  bindings: FieldBinding[];      // one per rule whose source column is present
  unused: UnusedColumn[];        // source columns present with no destination
  missingRequiredSource: FieldBinding[]; // source-required fields absent in file
  reassignTargets: { canon: string; label: string; targetColumns: string[] }[]; // choices for a re-point
  // Near-name matches the app should pre-fill (and show as "À vérifier") so an
  // accepted suggestion actually feeds the conversion. Empty when every field
  // matched exactly. The raw engine default (no mapping) never uses these.
  suggestedOverrides: MappingOverrides;
  // Phase 5.4 — present only when analyzePlan ran with recognize:'semantic'.
  // Per-column candidates (auto / suggest / none / decided / ignored) with
  // value profiles and bounded, redacted samples. The default engine path
  // never computes it.
  semantic?: SemanticReport;
  // With `semantic`: which editable rule (by id) receives a canon field, so the
  // UI can turn an accepted candidate into an override without knowing rules.
  ruleByCanon?: Record<string, string>;
};

// Phase 5.4 — opt-in semantic column recognition. Default = today's exact +
// alias behaviour; 'semantic' adds the scored pipeline (name similarity,
// value profiling, structural context) and Learned decisions.
export type AnalyzeOptions = {
  recognize?: 'exact' | 'semantic';
  rows?: Row[];                  // sample rows for value profiling (first ~200 are used)
  formatId?: string;             // KnowledgeStore format id (scopes decisions)
  decisions?: LearnedDecision[]; // Learned decisions for this format (from the store)
};

// ── SOURCE tables — the fixed columns each parser reads, in display order ─────
// Structural fields (images/options/metafields, multi-column transforms) are
// listed with editable:false — shown and described, but not re-pointable,
// because their transform reads several columns or groups rows.

const F = (o: SourceField): SourceField => o; // brevity helper

const SHOPIFY_P: SourceField[] = [
  F({ id: 'handle', canon: 'handle', scope: 'product', column: 'Handle', transform: 'copy', editable: true, descFr: 'Identifiant/URL du produit (clé de regroupement des variantes).', descEn: 'Product handle/URL slug (groups a product’s variant rows).' }),
  F({ id: 'title', canon: 'title', scope: 'product', column: 'Title', aliases: ['Name', 'Nom', 'Product Title'], transform: 'text', editable: true, sourceRequired: true, descFr: 'Nom du produit. Obligatoire : une ligne sans titre est rejetée.', descEn: 'Product name. Required: a row with no title is dropped.' }),
  F({ id: 'bodyHtml', canon: 'bodyHtml', scope: 'product', column: 'Body (HTML)', aliases: ['Description', 'Body'], transform: 'html', editable: true, descFr: 'Description HTML du produit.', descEn: 'Product HTML description.' }),
  F({ id: 'vendor', canon: 'vendor', scope: 'product', column: 'Vendor', aliases: ['Brand', 'Marque'], transform: 'text', editable: true, descFr: 'Marque / fournisseur.', descEn: 'Brand / vendor.' }),
  F({ id: 'productType', canon: 'productType', scope: 'product', column: 'Type', aliases: ['Product Type'], transform: 'text', editable: true, descFr: 'Type de produit.', descEn: 'Product type.' }),
  F({ id: 'tags', canon: 'tags', scope: 'product', column: 'Tags', transform: 'list', editable: true, descFr: 'Étiquettes séparées par des virgules.', descEn: 'Comma-separated tags.' }),
  F({ id: 'published', canon: 'published', scope: 'product', column: 'Published', transform: 'bool', editable: true, descFr: 'Publié (true/false).', descEn: 'Published (true/false).' }),
  F({ id: 'status', canon: 'status', scope: 'product', column: 'Status', transform: 'enum', editable: true, descFr: 'Statut : active / draft / archived.', descEn: 'Status: active / draft / archived.' }),
  F({ id: 'categories', canon: 'categories', scope: 'product', column: 'Product Category', transform: 'copy', editable: true, descFr: 'Catégorie standard du produit.', descEn: 'Standard product category.' }),
  F({ id: 'seoTitle', canon: 'seoTitle', scope: 'product', column: 'SEO Title', transform: 'text', editable: true, descFr: 'Titre SEO.', descEn: 'SEO title.' }),
  F({ id: 'seoDescription', canon: 'seoDescription', scope: 'product', column: 'SEO Description', transform: 'text', editable: true, descFr: 'Méta-description SEO.', descEn: 'SEO meta description.' }),
  F({ id: 'sku', canon: 'sku', scope: 'variant', column: 'Variant SKU', aliases: ['SKU'], transform: 'copy', editable: true, descFr: 'Référence (SKU) de la variante.', descEn: 'Variant SKU.' }),
  F({ id: 'price', canon: 'price', scope: 'variant', column: 'Variant Price', aliases: ['Price', 'Prix'], transform: 'money', editable: true, descFr: 'Prix de vente de la variante.', descEn: 'Variant selling price.' }),
  F({ id: 'compareAtPrice', canon: 'compareAtPrice', scope: 'variant', column: 'Variant Compare At Price', transform: 'money', editable: true, reviewAlways: true, descFr: 'Prix barré (ancien prix). À ne pas confondre avec un prix promo.', descEn: 'Compare-at (was) price. Not the same as a sale price.' }),
  F({ id: 'cost', canon: 'cost', scope: 'variant', column: 'Cost per item', transform: 'money', editable: true, descFr: 'Coût unitaire (marge).', descEn: 'Cost per item (margin).' }),
  F({ id: 'barcode', canon: 'barcode', scope: 'variant', column: 'Variant Barcode', aliases: ['Variant Barcodes', 'Barcode', 'EAN', 'UPC'], transform: 'copy', editable: true, descFr: 'Code-barres (EAN/UPC).', descEn: 'Barcode (EAN/UPC).' }),
  F({ id: 'grams', canon: 'grams', scope: 'variant', column: 'Variant Grams', transform: 'copy', editable: true, descFr: 'Poids en grammes.', descEn: 'Weight in grams.' }),
  F({ id: 'inventoryQty', canon: 'inventoryQty', scope: 'variant', column: 'Variant Inventory Qty', aliases: ['Inventory', 'Stock'], transform: 'int', editable: true, descFr: 'Quantité en stock.', descEn: 'Inventory quantity.' }),
  F({ id: 'requiresShipping', canon: 'requiresShipping', scope: 'variant', column: 'Variant Requires Shipping', transform: 'bool', editable: true, descFr: 'Produit physique à expédier.', descEn: 'Physical, requires shipping.' }),
  F({ id: 'taxable', canon: 'taxable', scope: 'variant', column: 'Variant Taxable', transform: 'bool', editable: true, descFr: 'Soumis à la taxe.', descEn: 'Taxable.' }),
  F({ id: 'variantImage', canon: 'variantImage', scope: 'variant', column: 'Variant Image', transform: 'url', editable: true, descFr: 'Image spécifique à la variante.', descEn: 'Variant-specific image.' }),
  F({ id: 'images', canon: 'images', scope: 'product', column: 'Image Src', transform: 'images', editable: false, descFr: 'Images produit (une par ligne, regroupées).', descEn: 'Product images (one per row, grouped).' }),
  F({ id: 'options', canon: 'options', scope: 'product', column: 'Option1 Name', transform: 'options', editable: false, descFr: 'Options/variantes (Nom + Valeur, 1 à 3).', descEn: 'Options/variants (Name + Value, 1–3).' }),
  F({ id: 'metafields', canon: 'metafields', scope: 'product', column: '(product.metafields.*)', transform: 'metafields', editable: false, descFr: 'Champs personnalisés (métachamps).', descEn: 'Custom fields (metafields).' }),
];

const WOO_MODERN_P: SourceField[] = [
  F({ id: 'handle', canon: 'handle', scope: 'product', column: 'SKU', transform: 'copy', editable: true, descFr: 'SKU parent = clé de regroupement des variations.', descEn: 'Parent SKU = variation grouping key.' }),
  F({ id: 'title', canon: 'title', scope: 'product', column: 'Name', aliases: ['Title', 'Nom'], transform: 'text', editable: true, sourceRequired: true, descFr: 'Nom du produit. Obligatoire.', descEn: 'Product name. Required.' }),
  F({ id: 'bodyHtml', canon: 'bodyHtml', scope: 'product', column: 'Description', transform: 'html', editable: true, descFr: 'Description longue (HTML).', descEn: 'Long description (HTML).' }),
  F({ id: 'shortDescription', canon: 'shortDescription', scope: 'product', column: 'Short description', transform: 'html', editable: true, descFr: 'Description courte → méta-description.', descEn: 'Short description → SEO meta.' }),
  F({ id: 'vendor', canon: 'vendor', scope: 'product', column: 'Brands', aliases: ['Brand', 'Vendor', 'Marque'], transform: 'text', editable: true, descFr: 'Marques WC 9.6+ (première = marque ; les autres conservées).', descEn: 'WC 9.6+ brands (first = vendor; others kept).' }),
  F({ id: 'barcode', canon: 'barcode', scope: 'variant', column: 'GTIN, UPC, EAN, or ISBN', aliases: ['GTIN', 'EAN', 'UPC', 'Barcode'], transform: 'copy', editable: true, descFr: 'Code-barres (colonne WC 9.2+).', descEn: 'Barcode (WC 9.2+ column).' }),
  F({ id: 'tags', canon: 'tags', scope: 'product', column: 'Tags', transform: 'list', editable: true, descFr: 'Étiquettes (virgules).', descEn: 'Tags (commas).' }),
  F({ id: 'categories', canon: 'categories', scope: 'product', column: 'Categories', transform: 'category_path', editable: true, descFr: 'Catégories (hiérarchie « A > B »).', descEn: 'Categories (“A > B” hierarchy).' }),
  F({ id: 'published', canon: 'published', scope: 'product', column: 'Published', transform: 'bool', editable: true, descFr: 'Publié (1/0).', descEn: 'Published (1/0).' }),
  F({ id: 'price', canon: 'price', scope: 'variant', column: 'Regular price', aliases: ['Price'], transform: 'price_promo', editable: false, reviewAlways: true, descFr: 'Prix normal + prix promo (Sale price) combinés en prix payé/barré.', descEn: 'Regular + Sale price combined into charged/was price.' }),
  F({ id: 'sku', canon: 'sku', scope: 'variant', column: 'SKU', transform: 'copy', editable: true, descFr: 'Référence variante.', descEn: 'Variant SKU.' }),
  F({ id: 'inventoryQty', canon: 'inventoryQty', scope: 'variant', column: 'Stock', aliases: ['Inventory'], transform: 'int', editable: true, descFr: 'Stock.', descEn: 'Stock.' }),
  F({ id: 'grams', canon: 'grams', scope: 'variant', column: 'Weight (kg)', transform: 'grams_from_kg', editable: false, descFr: 'Poids (kg) → grammes.', descEn: 'Weight (kg) → grams.' }),
  F({ id: 'lengthCm', canon: 'lengthCm', scope: 'variant', column: 'Length (cm)', transform: 'copy', editable: true, descFr: 'Longueur (cm).', descEn: 'Length (cm).' }),
  F({ id: 'widthCm', canon: 'widthCm', scope: 'variant', column: 'Width (cm)', transform: 'copy', editable: true, descFr: 'Largeur (cm).', descEn: 'Width (cm).' }),
  F({ id: 'heightCm', canon: 'heightCm', scope: 'variant', column: 'Height (cm)', transform: 'copy', editable: true, descFr: 'Hauteur (cm).', descEn: 'Height (cm).' }),
  F({ id: 'taxable', canon: 'taxable', scope: 'variant', column: 'Tax status', transform: 'enum', editable: true, descFr: 'Statut de taxe (taxable/none).', descEn: 'Tax status (taxable/none).' }),
  F({ id: 'requiresShipping', canon: 'requiresShipping', scope: 'variant', column: 'Virtual', transform: 'bool', editable: true, descFr: 'Virtuel (oui) = pas d’expédition.', descEn: 'Virtual (yes) = no shipping.' }),
  F({ id: 'images', canon: 'images', scope: 'product', column: 'Images', transform: 'images', editable: false, descFr: 'Images (liste, virgules).', descEn: 'Images (comma list).' }),
  F({ id: 'options', canon: 'options', scope: 'product', column: 'Attribute 1 name', transform: 'options', editable: false, descFr: 'Attributs → options si remplis par toutes les variations.', descEn: 'Attributes → options when every variation fills them.' }),
  F({ id: 'metafields', canon: 'metafields', scope: 'product', column: 'Meta: *', transform: 'metafields', editable: false, descFr: 'Métachamps (hors clés internes _*).', descEn: 'Metafields (excluding internal _* keys).' }),
];

const WOO_LEGACY_P: SourceField[] = [
  F({ id: 'handle', canon: 'handle', scope: 'product', column: 'post_name', transform: 'copy', editable: true, descFr: 'Slug du produit.', descEn: 'Product slug.' }),
  F({ id: 'title', canon: 'title', scope: 'product', column: 'post_title', transform: 'text', editable: true, sourceRequired: true, descFr: 'Titre. Obligatoire.', descEn: 'Title. Required.' }),
  F({ id: 'bodyHtml', canon: 'bodyHtml', scope: 'product', column: 'post_content', transform: 'html', editable: true, descFr: 'Contenu HTML.', descEn: 'HTML content.' }),
  F({ id: 'vendor', canon: 'vendor', scope: 'product', column: 'tax:product_brand', transform: 'text', editable: true, descFr: 'Marque (dernier niveau).', descEn: 'Brand (leaf).' }),
  F({ id: 'tags', canon: 'tags', scope: 'product', column: 'tax:product_tag', transform: 'list', editable: true, descFr: 'Étiquettes.', descEn: 'Tags.' }),
  F({ id: 'categories', canon: 'categories', scope: 'product', column: 'tax:product_cat', transform: 'category_path', editable: true, descFr: 'Catégories.', descEn: 'Categories.' }),
  F({ id: 'published', canon: 'published', scope: 'product', column: 'post_status', transform: 'enum', editable: true, descFr: 'post_status = publish → publié.', descEn: 'post_status = publish → published.' }),
  F({ id: 'sku', canon: 'sku', scope: 'variant', column: 'sku', transform: 'copy', editable: true, descFr: 'Référence.', descEn: 'SKU.' }),
  F({ id: 'price', canon: 'price', scope: 'variant', column: 'regular_price', transform: 'price_promo', editable: false, reviewAlways: true, descFr: 'Prix normal + promo.', descEn: 'Regular + sale price.' }),
  F({ id: 'inventoryQty', canon: 'inventoryQty', scope: 'variant', column: 'stock', transform: 'int', editable: true, descFr: 'Stock.', descEn: 'Stock.' }),
  F({ id: 'grams', canon: 'grams', scope: 'variant', column: 'weight', transform: 'grams_from_kg', editable: false, descFr: 'Poids (kg) → grammes.', descEn: 'Weight (kg) → grams.' }),
  F({ id: 'options', canon: 'options', scope: 'product', column: 'attribute:*', transform: 'options', editable: false, descFr: 'Attributs (valeurs séparées par « | »).', descEn: 'Attributes (pipe-separated values).' }),
];

const WIX_P: SourceField[] = [
  F({ id: 'handle', canon: 'handle', scope: 'product', column: 'handleId', aliases: ['handle'], transform: 'copy', editable: true, descFr: 'Identifiant Wix (regroupe Produit + Variantes).', descEn: 'Wix handleId (groups Product + Variant rows).' }),
  F({ id: 'title', canon: 'title', scope: 'product', column: 'name', transform: 'text', editable: true, sourceRequired: true, descFr: 'Nom. Obligatoire.', descEn: 'Name. Required.' }),
  F({ id: 'bodyHtml', canon: 'bodyHtml', scope: 'product', column: 'description', aliases: ['plainDescription'], transform: 'html', editable: true, descFr: 'Description.', descEn: 'Description.' }),
  F({ id: 'vendor', canon: 'vendor', scope: 'product', column: 'brand', transform: 'text', editable: true, descFr: 'Marque.', descEn: 'Brand.' }),
  F({ id: 'categories', canon: 'categories', scope: 'product', column: 'collection', aliases: ['categorySlugs'], transform: 'category_path', editable: true, descFr: 'Collections (séparées par « ; »).', descEn: 'Collections (semicolon-separated).' }),
  F({ id: 'published', canon: 'published', scope: 'product', column: 'visible', transform: 'bool', editable: true, descFr: 'Visible (TRUE/FALSE).', descEn: 'Visible (TRUE/FALSE).' }),
  F({ id: 'price', canon: 'price', scope: 'variant', column: 'price', transform: 'price_promo', editable: false, reviewAlways: true, descFr: 'Prix liste + remise produit → prix payé/barré.', descEn: 'List price + discount → charged/was price.' }),
  F({ id: 'sku', canon: 'sku', scope: 'variant', column: 'sku', transform: 'copy', editable: true, descFr: 'Référence.', descEn: 'SKU.' }),
  F({ id: 'inventoryQty', canon: 'inventoryQty', scope: 'variant', column: 'inventory', transform: 'int', editable: true, descFr: 'Stock (nombre ou InStock/OutOfStock).', descEn: 'Inventory (number or InStock/OutOfStock).' }),
  F({ id: 'grams', canon: 'grams', scope: 'variant', column: 'weight', transform: 'grams_from_kg', editable: false, descFr: 'Poids (kg) → grammes.', descEn: 'Weight (kg) → grams.' }),
  F({ id: 'cost', canon: 'cost', scope: 'variant', column: 'cost', transform: 'money', editable: true, descFr: 'Coût unitaire.', descEn: 'Cost per item.' }),
  F({ id: 'images', canon: 'images', scope: 'product', column: 'productImageUrl', aliases: ['media'], transform: 'images', editable: false, descFr: 'Images (séparées par « ; »).', descEn: 'Images (semicolon-separated).' }),
  F({ id: 'options', canon: 'options', scope: 'product', column: 'productOptionName1', transform: 'options', editable: false, descFr: 'Options typées (COLOR garde le libellé ; le hex devient métachamp).', descEn: 'Typed options (COLOR keeps the label; the hex becomes a metafield).' }),
];

const BC_P: SourceField[] = [
  F({ id: 'handle', canon: 'handle', scope: 'product', column: 'Product URL', transform: 'copy', editable: true, descFr: 'URL produit → identifiant.', descEn: 'Product URL → handle.' }),
  F({ id: 'title', canon: 'title', scope: 'product', column: 'Name', transform: 'text', editable: true, sourceRequired: true, descFr: 'Nom. Obligatoire.', descEn: 'Name. Required.' }),
  F({ id: 'bodyHtml', canon: 'bodyHtml', scope: 'product', column: 'Description', transform: 'html', editable: true, descFr: 'Description.', descEn: 'Description.' }),
  F({ id: 'seoTitle', canon: 'seoTitle', scope: 'product', column: 'Page Title', transform: 'text', editable: true, descFr: 'Titre de page (SEO).', descEn: 'Page Title (SEO).' }),
  F({ id: 'seoDescription', canon: 'seoDescription', scope: 'product', column: 'Meta Description', transform: 'text', editable: true, descFr: 'Méta-description.', descEn: 'Meta description.' }),
  F({ id: 'published', canon: 'published', scope: 'product', column: 'Is Visible', transform: 'bool', editable: true, descFr: 'Visible (TRUE/FALSE).', descEn: 'Visible (TRUE/FALSE).' }),
  F({ id: 'price', canon: 'price', scope: 'variant', column: 'Price', transform: 'price_promo', editable: false, reviewAlways: true, descFr: 'Prix + Sale Price → prix payé/barré.', descEn: 'Price + Sale Price → charged/was price.' }),
  F({ id: 'cost', canon: 'cost', scope: 'variant', column: 'Cost Price', transform: 'money', editable: true, descFr: 'Coût unitaire.', descEn: 'Cost price.' }),
  F({ id: 'sku', canon: 'sku', scope: 'variant', column: 'SKU', transform: 'copy', editable: true, descFr: 'Référence.', descEn: 'SKU.' }),
  F({ id: 'barcode', canon: 'barcode', scope: 'variant', column: 'UPC/EAN', transform: 'copy', editable: true, descFr: 'Code-barres.', descEn: 'Barcode.' }),
  F({ id: 'inventoryQty', canon: 'inventoryQty', scope: 'variant', column: 'Current Stock', transform: 'int', editable: true, descFr: 'Stock.', descEn: 'Stock.' }),
  F({ id: 'grams', canon: 'grams', scope: 'variant', column: 'Weight', transform: 'grams_from_kg', editable: false, descFr: 'Poids (kg) → grammes.', descEn: 'Weight (kg) → grams.' }),
  F({ id: 'widthCm', canon: 'widthCm', scope: 'variant', column: 'Width', transform: 'copy', editable: true, descFr: 'Largeur.', descEn: 'Width.' }),
  F({ id: 'heightCm', canon: 'heightCm', scope: 'variant', column: 'Height', transform: 'copy', editable: true, descFr: 'Hauteur.', descEn: 'Height.' }),
  F({ id: 'lengthCm', canon: 'lengthCm', scope: 'variant', column: 'Depth', transform: 'copy', editable: true, descFr: 'Profondeur → longueur.', descEn: 'Depth → length.' }),
  F({ id: 'images', canon: 'images', scope: 'product', column: 'Internal Image URL (Export)', transform: 'images', editable: false, descFr: 'Images (lignes Item=Image).', descEn: 'Images (Item=Image rows).' }),
  F({ id: 'options', canon: 'options', scope: 'product', column: 'Options', transform: 'options', editable: false, descFr: 'Options empaquetées (lignes Item=Variant).', descEn: 'Packed options (Item=Variant rows).' }),
];

// ── Customers ────────────────────────────────────────────────────────────────
const SHOPIFY_C: SourceField[] = [
  F({ id: 'firstName', canon: 'firstName', scope: 'product', column: 'First Name', transform: 'copy', editable: true, descFr: 'Prénom.', descEn: 'First name.' }),
  F({ id: 'lastName', canon: 'lastName', scope: 'product', column: 'Last Name', transform: 'copy', editable: true, descFr: 'Nom.', descEn: 'Last name.' }),
  F({ id: 'email', canon: 'email', scope: 'product', column: 'Email', transform: 'copy', editable: true, sourceRequired: true, descFr: 'E-mail. Obligatoire (doublons signalés).', descEn: 'Email. Required (duplicates flagged).' }),
  F({ id: 'phone', canon: 'phone', scope: 'product', column: 'Phone', transform: 'copy', editable: true, descFr: 'Téléphone.', descEn: 'Phone.' }),
  F({ id: 'company', canon: 'company', scope: 'product', column: 'Default Address Company', transform: 'copy', editable: true, descFr: 'Société (adresse).', descEn: 'Company (address).' }),
  F({ id: 'address1', canon: 'address1', scope: 'product', column: 'Default Address Address1', transform: 'copy', editable: true, descFr: 'Adresse ligne 1.', descEn: 'Address line 1.' }),
  F({ id: 'address2', canon: 'address2', scope: 'product', column: 'Default Address Address2', transform: 'copy', editable: true, descFr: 'Adresse ligne 2.', descEn: 'Address line 2.' }),
  F({ id: 'city', canon: 'city', scope: 'product', column: 'Default Address City', transform: 'copy', editable: true, descFr: 'Ville.', descEn: 'City.' }),
  F({ id: 'province', canon: 'province', scope: 'product', column: 'Default Address Province Code', transform: 'state', editable: true, descFr: 'Région/État (code ↔ nom selon la cible).', descEn: 'Province/state (code ↔ name per target).' }),
  F({ id: 'country', canon: 'country', scope: 'product', column: 'Default Address Country Code', transform: 'copy', editable: true, descFr: 'Pays.', descEn: 'Country.' }),
  F({ id: 'zip', canon: 'zip', scope: 'product', column: 'Default Address Zip', transform: 'copy', editable: true, descFr: 'Code postal.', descEn: 'Postal code.' }),
  F({ id: 'addrPhone', canon: 'addrPhone', scope: 'product', column: 'Default Address Phone', transform: 'copy', editable: true, descFr: 'Téléphone (adresse).', descEn: 'Address phone.' }),
  F({ id: 'acceptsEmail', canon: 'acceptsEmail', scope: 'product', column: 'Accepts Email Marketing', transform: 'consent', editable: true, descFr: 'Consentement e-mail marketing.', descEn: 'Email marketing consent.' }),
  F({ id: 'acceptsSms', canon: 'acceptsSms', scope: 'product', column: 'Accepts SMS Marketing', transform: 'consent', editable: true, descFr: 'Consentement SMS.', descEn: 'SMS consent.' }),
  F({ id: 'note', canon: 'note', scope: 'product', column: 'Note', transform: 'text', editable: true, descFr: 'Note interne.', descEn: 'Internal note.' }),
  F({ id: 'tags', canon: 'tags', scope: 'product', column: 'Tags', transform: 'list', editable: true, descFr: 'Étiquettes.', descEn: 'Tags.' }),
  F({ id: 'taxExempt', canon: 'taxExempt', scope: 'product', column: 'Tax Exempt', transform: 'bool', editable: true, descFr: 'Exonéré de taxe.', descEn: 'Tax exempt.' }),
];
const WOO_C: SourceField[] = [
  F({ id: 'firstName', canon: 'firstName', scope: 'product', column: 'first_name', aliases: ['billing_first_name'], transform: 'copy', editable: true, descFr: 'Prénom.', descEn: 'First name.' }),
  F({ id: 'lastName', canon: 'lastName', scope: 'product', column: 'last_name', aliases: ['billing_last_name'], transform: 'copy', editable: true, descFr: 'Nom.', descEn: 'Last name.' }),
  F({ id: 'email', canon: 'email', scope: 'product', column: 'user_email', aliases: ['billing_email'], transform: 'copy', editable: true, sourceRequired: true, descFr: 'E-mail. Obligatoire.', descEn: 'Email. Required.' }),
  F({ id: 'phone', canon: 'phone', scope: 'product', column: 'billing_phone', transform: 'copy', editable: true, descFr: 'Téléphone.', descEn: 'Phone.' }),
  F({ id: 'company', canon: 'company', scope: 'product', column: 'billing_company', transform: 'copy', editable: true, descFr: 'Société.', descEn: 'Company.' }),
  F({ id: 'address1', canon: 'address1', scope: 'product', column: 'billing_address_1', transform: 'copy', editable: true, descFr: 'Adresse 1.', descEn: 'Address 1.' }),
  F({ id: 'address2', canon: 'address2', scope: 'product', column: 'billing_address_2', transform: 'copy', editable: true, descFr: 'Adresse 2.', descEn: 'Address 2.' }),
  F({ id: 'city', canon: 'city', scope: 'product', column: 'billing_city', transform: 'copy', editable: true, descFr: 'Ville.', descEn: 'City.' }),
  F({ id: 'province', canon: 'province', scope: 'product', column: 'billing_state', transform: 'state', editable: true, descFr: 'État/région.', descEn: 'State/region.' }),
  F({ id: 'country', canon: 'country', scope: 'product', column: 'billing_country', transform: 'copy', editable: true, descFr: 'Pays.', descEn: 'Country.' }),
  F({ id: 'zip', canon: 'zip', scope: 'product', column: 'billing_postcode', transform: 'copy', editable: true, descFr: 'Code postal.', descEn: 'Postal code.' }),
  F({ id: 'roles', canon: 'roles', scope: 'product', column: 'roles', transform: 'derived', editable: false, descFr: 'Rôle WordPress : seuls les « customer » sont convertis.', descEn: 'WordPress role: only “customer” rows are converted.' }),
  F({ id: 'shipping', canon: 'shipping', scope: 'product', column: 'shipping_address_1', transform: 'address', editable: false, descFr: 'Seconde adresse (livraison), reprise si non vide.', descEn: 'Second (shipping) address, carried if present.' }),
];
const BC_C: SourceField[] = [
  F({ id: 'email', canon: 'email', scope: 'product', column: 'Email', transform: 'copy', editable: true, sourceRequired: true, descFr: 'E-mail. Obligatoire.', descEn: 'Email. Required.' }),
  F({ id: 'firstName', canon: 'firstName', scope: 'product', column: 'First Name', transform: 'copy', editable: true, descFr: 'Prénom.', descEn: 'First name.' }),
  F({ id: 'lastName', canon: 'lastName', scope: 'product', column: 'Last Name', transform: 'copy', editable: true, descFr: 'Nom.', descEn: 'Last name.' }),
  F({ id: 'phone', canon: 'phone', scope: 'product', column: 'Phone', transform: 'copy', editable: true, descFr: 'Téléphone.', descEn: 'Phone.' }),
  F({ id: 'company', canon: 'company', scope: 'product', column: 'Address Company', aliases: ['Company'], transform: 'copy', editable: true, descFr: 'Société.', descEn: 'Company.' }),
  F({ id: 'address1', canon: 'address1', scope: 'product', column: 'Address Line 1', transform: 'copy', editable: true, descFr: 'Adresse 1.', descEn: 'Address 1.' }),
  F({ id: 'address2', canon: 'address2', scope: 'product', column: 'Address Line 2', transform: 'copy', editable: true, descFr: 'Adresse 2.', descEn: 'Address 2.' }),
  F({ id: 'city', canon: 'city', scope: 'product', column: 'City/Suburb', transform: 'copy', editable: true, descFr: 'Ville.', descEn: 'City.' }),
  F({ id: 'province', canon: 'province', scope: 'product', column: 'State/Province', transform: 'state', editable: true, descFr: 'État/région.', descEn: 'State/region.' }),
  F({ id: 'country', canon: 'country', scope: 'product', column: 'Country', transform: 'copy', editable: true, descFr: 'Pays.', descEn: 'Country.' }),
  F({ id: 'zip', canon: 'zip', scope: 'product', column: 'Zip/Postcode', transform: 'copy', editable: true, descFr: 'Code postal.', descEn: 'Postal code.' }),
  F({ id: 'addrPhone', canon: 'addrPhone', scope: 'product', column: 'Address Phone', transform: 'copy', editable: true, descFr: 'Téléphone (adresse).', descEn: 'Address phone.' }),
  F({ id: 'acceptsEmail', canon: 'acceptsEmail', scope: 'product', column: 'Receive Marketing Emails', transform: 'consent', editable: true, descFr: 'Consentement e-mail.', descEn: 'Email consent.' }),
  F({ id: 'note', canon: 'note', scope: 'product', column: 'Notes', transform: 'text', editable: true, descFr: 'Notes (+ avoir en note).', descEn: 'Notes (+ store credit as note).' }),
  F({ id: 'tags', canon: 'tags', scope: 'product', column: 'Customer Group', transform: 'list', editable: true, descFr: 'Groupe client → étiquette.', descEn: 'Customer group → tag.' }),
];

// ── Orders ───────────────────────────────────────────────────────────────────
// Order-level scalars are editable; the address blocks and line-item lists are
// structural (grouped, multi-column) and shown read-only.
const SHOPIFY_O: SourceField[] = [
  F({ id: 'number', canon: 'number', scope: 'product', column: 'Name', transform: 'copy', editable: true, sourceRequired: true, descFr: 'Numéro de commande. Obligatoire.', descEn: 'Order number. Required.' }),
  F({ id: 'email', canon: 'email', scope: 'product', column: 'Email', transform: 'copy', editable: true, descFr: 'E-mail client.', descEn: 'Customer email.' }),
  F({ id: 'createdAt', canon: 'createdAt', scope: 'product', column: 'Created at', transform: 'copy', editable: true, descFr: 'Date de création.', descEn: 'Created date.' }),
  F({ id: 'financialStatus', canon: 'financialStatus', scope: 'product', column: 'Financial Status', transform: 'enum', editable: true, descFr: 'Statut de paiement.', descEn: 'Financial status.' }),
  F({ id: 'fulfillmentStatus', canon: 'fulfillmentStatus', scope: 'product', column: 'Fulfillment Status', transform: 'enum', editable: true, descFr: 'Statut d’exécution.', descEn: 'Fulfillment status.' }),
  F({ id: 'currency', canon: 'currency', scope: 'product', column: 'Currency', transform: 'copy', editable: true, descFr: 'Devise.', descEn: 'Currency.' }),
  F({ id: 'subtotal', canon: 'subtotal', scope: 'product', column: 'Subtotal', transform: 'money', editable: true, descFr: 'Sous-total.', descEn: 'Subtotal.' }),
  F({ id: 'shippingAmount', canon: 'shippingAmount', scope: 'product', column: 'Shipping', transform: 'money', editable: true, descFr: 'Frais de port.', descEn: 'Shipping amount.' }),
  F({ id: 'taxes', canon: 'taxes', scope: 'product', column: 'Taxes', transform: 'money', editable: true, descFr: 'Taxes.', descEn: 'Taxes.' }),
  F({ id: 'total', canon: 'total', scope: 'product', column: 'Total', transform: 'money', editable: true, descFr: 'Total.', descEn: 'Total.' }),
  F({ id: 'discountCode', canon: 'discountCode', scope: 'product', column: 'Discount Code', transform: 'copy', editable: true, descFr: 'Code de réduction.', descEn: 'Discount code.' }),
  F({ id: 'discountAmount', canon: 'discountAmount', scope: 'product', column: 'Discount Amount', transform: 'money', editable: true, descFr: 'Montant de la réduction.', descEn: 'Discount amount.' }),
  F({ id: 'paymentMethod', canon: 'paymentMethod', scope: 'product', column: 'Payment Method', transform: 'copy', editable: true, descFr: 'Moyen de paiement.', descEn: 'Payment method.' }),
  F({ id: 'note', canon: 'note', scope: 'product', column: 'Notes', transform: 'text', editable: true, descFr: 'Note de commande.', descEn: 'Order note.' }),
  F({ id: 'billing', canon: 'billing', scope: 'product', column: 'Billing Name', transform: 'address', editable: false, descFr: 'Adresse de facturation (bloc).', descEn: 'Billing address (block).' }),
  F({ id: 'shipping', canon: 'shipping', scope: 'product', column: 'Shipping Name', transform: 'address', editable: false, descFr: 'Adresse de livraison (bloc).', descEn: 'Shipping address (block).' }),
  F({ id: 'lineItems', canon: 'lineItems', scope: 'product', column: 'Lineitem name', transform: 'lineitems', editable: false, descFr: 'Articles (une ligne par article).', descEn: 'Line items (one row each).' }),
];
const WOO_O: SourceField[] = [
  F({ id: 'number', canon: 'number', scope: 'product', column: 'ORDERID', transform: 'copy', editable: true, sourceRequired: true, descFr: 'Numéro de commande. Obligatoire.', descEn: 'Order number. Required.' }),
  F({ id: 'email', canon: 'email', scope: 'product', column: 'billing_email', aliases: ['customer_user'], transform: 'copy', editable: true, descFr: 'E-mail client.', descEn: 'Customer email.' }),
  F({ id: 'createdAt', canon: 'createdAt', scope: 'product', column: 'order_date', transform: 'copy', editable: true, descFr: 'Date (MM/JJ ou JJ/MM détecté).', descEn: 'Date (MM/DD or DD/MM detected).' }),
  F({ id: 'status', canon: 'status', scope: 'product', column: 'order_status', transform: 'order_status', editable: false, descFr: 'Statut wc-* → paiement + exécution.', descEn: 'wc-* status → financial + fulfillment.' }),
  F({ id: 'currency', canon: 'currency', scope: 'product', column: 'order_currency', transform: 'copy', editable: true, descFr: 'Devise.', descEn: 'Currency.' }),
  F({ id: 'total', canon: 'total', scope: 'product', column: 'order_total', transform: 'money', editable: true, descFr: 'Total.', descEn: 'Total.' }),
  F({ id: 'taxes', canon: 'taxes', scope: 'product', column: 'order_tax', transform: 'money', editable: true, descFr: 'Taxes.', descEn: 'Taxes.' }),
  F({ id: 'shippingAmount', canon: 'shippingAmount', scope: 'product', column: 'order_shipping', transform: 'money', editable: true, descFr: 'Frais de port.', descEn: 'Shipping amount.' }),
  F({ id: 'discountAmount', canon: 'discountAmount', scope: 'product', column: 'cart_discount', transform: 'money', editable: true, descFr: 'Réduction.', descEn: 'Discount.' }),
  F({ id: 'paymentMethod', canon: 'paymentMethod', scope: 'product', column: 'payment_method_title', transform: 'copy', editable: true, descFr: 'Moyen de paiement.', descEn: 'Payment method.' }),
  F({ id: 'transactionId', canon: 'transactionId', scope: 'product', column: 'transaction_id', transform: 'copy', editable: true, descFr: 'ID de transaction.', descEn: 'Transaction ID.' }),
  F({ id: 'note', canon: 'note', scope: 'product', column: 'customer_note', transform: 'text', editable: true, descFr: 'Note.', descEn: 'Note.' }),
  F({ id: 'billing', canon: 'billing', scope: 'product', column: 'billing_first_name', transform: 'address', editable: false, descFr: 'Adresse de facturation (bloc).', descEn: 'Billing address (block).' }),
  F({ id: 'shipping', canon: 'shipping', scope: 'product', column: 'shipping_first_name', transform: 'address', editable: false, descFr: 'Adresse de livraison (bloc).', descEn: 'Shipping address (block).' }),
  F({ id: 'lineItems', canon: 'lineItems', scope: 'product', column: 'item_name', transform: 'lineitems', editable: false, descFr: 'Articles (listes empaquetées, coupons filtrés).', descEn: 'Line items (packed lists, coupons filtered).' }),
];
const BC_O: SourceField[] = [
  F({ id: 'number', canon: 'number', scope: 'product', column: 'Order ID', transform: 'copy', editable: true, sourceRequired: true, descFr: 'Numéro de commande. Obligatoire.', descEn: 'Order number. Required.' }),
  F({ id: 'email', canon: 'email', scope: 'product', column: 'Customer Email', transform: 'copy', editable: true, descFr: 'E-mail client.', descEn: 'Customer email.' }),
  F({ id: 'createdAt', canon: 'createdAt', scope: 'product', column: 'Order Date', transform: 'copy', editable: true, descFr: 'Date.', descEn: 'Date.' }),
  F({ id: 'status', canon: 'status', scope: 'product', column: 'Order Status', transform: 'order_status', editable: false, descFr: 'Statut → paiement + exécution.', descEn: 'Status → financial + fulfillment.' }),
  F({ id: 'currency', canon: 'currency', scope: 'product', column: 'Order Currency Code', transform: 'copy', editable: true, descFr: 'Devise.', descEn: 'Currency.' }),
  F({ id: 'subtotal', canon: 'subtotal', scope: 'product', column: 'Subtotal (inc tax)', transform: 'money', editable: true, descFr: 'Sous-total (TTC).', descEn: 'Subtotal (inc tax).' }),
  F({ id: 'shippingAmount', canon: 'shippingAmount', scope: 'product', column: 'Shipping Cost (inc tax)', transform: 'money', editable: true, descFr: 'Frais de port (TTC).', descEn: 'Shipping (inc tax).' }),
  F({ id: 'taxes', canon: 'taxes', scope: 'product', column: 'Tax Total', transform: 'money', editable: true, descFr: 'Taxes.', descEn: 'Taxes.' }),
  F({ id: 'total', canon: 'total', scope: 'product', column: 'Order Total (inc tax)', transform: 'money', editable: true, descFr: 'Total (TTC).', descEn: 'Total (inc tax).' }),
  F({ id: 'discountCode', canon: 'discountCode', scope: 'product', column: 'Coupon Code', transform: 'copy', editable: true, descFr: 'Code coupon.', descEn: 'Coupon code.' }),
  F({ id: 'discountAmount', canon: 'discountAmount', scope: 'product', column: 'Coupon Value', transform: 'money', editable: true, descFr: 'Valeur coupon.', descEn: 'Coupon value.' }),
  F({ id: 'paymentMethod', canon: 'paymentMethod', scope: 'product', column: 'Payment Method', transform: 'copy', editable: true, descFr: 'Moyen de paiement.', descEn: 'Payment method.' }),
  F({ id: 'transactionId', canon: 'transactionId', scope: 'product', column: 'Transaction ID', transform: 'copy', editable: true, descFr: 'ID de transaction.', descEn: 'Transaction ID.' }),
  F({ id: 'note', canon: 'note', scope: 'product', column: 'Customer Message', transform: 'text', editable: true, descFr: 'Message client.', descEn: 'Customer message.' }),
  F({ id: 'billing', canon: 'billing', scope: 'product', column: 'Billing First Name', transform: 'address', editable: false, descFr: 'Adresse de facturation (bloc).', descEn: 'Billing address (block).' }),
  F({ id: 'shipping', canon: 'shipping', scope: 'product', column: 'Shipping First Name', transform: 'address', editable: false, descFr: 'Adresse de livraison (bloc).', descEn: 'Shipping address (block).' }),
  F({ id: 'lineItems', canon: 'lineItems', scope: 'product', column: 'Product Name', transform: 'lineitems', editable: false, descFr: 'Articles (lignes par Order ID).', descEn: 'Line items (rows per Order ID).' }),
];

export const SOURCE_FIELDS: Partial<Record<FormatId, SourceField[]>> = {
  shopify_products: SHOPIFY_P,
  woo_products_modern: WOO_MODERN_P,
  woo_products_legacy: WOO_LEGACY_P,
  wix_products: WIX_P,
  bigcommerce_products: BC_P,
  shopify_customers: SHOPIFY_C,
  woo_customers: WOO_C,
  bigcommerce_customers: BC_C,
  shopify_orders: SHOPIFY_O,
  woo_orders: WOO_O,
  bigcommerce_orders: BC_O,
};

// ── TARGET tables — for each canon field, where the serializer writes it ──────
// [] cols (or an absent key) = the target does not carry this field over (a loss).
// Product targets: READ FROM THE SERIALISERS (core/src/destinations.ts probes each field through the real parser and
// serialiser), never copied by hand — the hand tables had drifted (WooCommerce « handle → SKU (parent) » after the SKU
// rule; barcodes, technical sheet, availability said « not carried »). REQUIRED_P = the platform's own import rule
// (WooCommerce writes no handle: its rows are keyed by SKU / parent SKU).
const REQUIRED_P: Record<ProductTarget, string[]> = { shopify: ['handle', 'title'], woocommerce: ['title'], wix: ['handle', 'title'], bigcommerce: ['handle', 'title'] };
function productTargetTable(t: ProductTarget): Record<string, TargetField> {
  return Object.fromEntries(Object.entries(productDestinations(t)).map(([canon, cols]) => [canon, REQUIRED_P[t].includes(canon) ? { cols, required: true } : { cols }]));
}

// Customers targets
const T_SHOPIFY_C: Record<string, TargetField> = {
  firstName: { cols: ['First Name'] }, lastName: { cols: ['Last Name'] }, email: { cols: ['Email'], required: true }, phone: { cols: ['Phone'] },
  acceptsEmail: { cols: ['Accepts Email Marketing'] }, acceptsSms: { cols: ['Accepts SMS Marketing'] },
  company: { cols: ['Default Address Company'] }, address1: { cols: ['Default Address Address1'] }, address2: { cols: ['Default Address Address2'] },
  city: { cols: ['Default Address City'] }, province: { cols: ['Default Address Province Code'] }, country: { cols: ['Default Address Country Code'] },
  zip: { cols: ['Default Address Zip'] }, addrPhone: { cols: ['Default Address Phone'] }, note: { cols: ['Note'] }, tags: { cols: ['Tags'] },
  taxExempt: { cols: ['Tax Exempt'] }, shipping: { cols: [] }, roles: { cols: [] },
};
const T_WOO_C: Record<string, TargetField> = {
  firstName: { cols: ['first_name', 'billing_first_name'] }, lastName: { cols: ['last_name', 'billing_last_name'] },
  email: { cols: ['user_email', 'billing_email'], required: true }, phone: { cols: ['billing_phone'] }, company: { cols: ['billing_company'] },
  address1: { cols: ['billing_address_1'] }, address2: { cols: ['billing_address_2'] }, city: { cols: ['billing_city'] },
  province: { cols: ['billing_state'] }, country: { cols: ['billing_country'] }, zip: { cols: ['billing_postcode'] },
  shipping: { cols: ['shipping_address_1…'] }, acceptsEmail: { cols: [] }, acceptsSms: { cols: [] }, note: { cols: [] },
  tags: { cols: [] }, taxExempt: { cols: [] }, addrPhone: { cols: [] }, roles: { cols: ['roles'] },
};
const T_BC_C: Record<string, TargetField> = {
  email: { cols: ['Email'], required: true }, firstName: { cols: ['First Name'] }, lastName: { cols: ['Last Name'] },
  company: { cols: ['Company', 'Address Company'] }, phone: { cols: ['Phone'] }, note: { cols: ['Notes'] }, tags: { cols: ['Customer Group'] },
  address1: { cols: ['Address Line 1'] }, address2: { cols: ['Address Line 2'] }, city: { cols: ['City/Suburb'] },
  province: { cols: ['State/Province'] }, country: { cols: ['Country'] }, zip: { cols: ['Zip/Postcode'] }, addrPhone: { cols: ['Address Phone'] },
  acceptsEmail: { cols: ['Receive Marketing Emails'] }, acceptsSms: { cols: [] }, taxExempt: { cols: [] }, shipping: { cols: [] },
};
// Orders targets (BigCommerce is never an order target — impossible by capability)
const T_SHOPIFY_O: Record<string, TargetField> = {
  // 7.4 (B2): the source number is carried as a note attribute, never as the target's Name
  number: { cols: ['Note Attributes'], required: true }, email: { cols: ['Email'] }, createdAt: { cols: ['Created at'] },
  financialStatus: { cols: ['Financial Status'] }, fulfillmentStatus: { cols: ['Fulfillment Status'] }, status: { cols: ['Financial Status', 'Fulfillment Status'] },
  currency: { cols: ['Currency'] }, subtotal: { cols: ['Subtotal'] }, shippingAmount: { cols: ['Shipping'] }, taxes: { cols: ['Taxes'] }, total: { cols: ['Total'] },
  discountCode: { cols: ['Discount Code'] }, discountAmount: { cols: ['Discount Amount'] }, paymentMethod: { cols: ['Payment Method'] }, note: { cols: ['Notes'] },
  transactionId: { cols: [] }, billing: { cols: ['Billing …'] }, shipping: { cols: ['Shipping …'] }, lineItems: { cols: ['Lineitem …'] },
};
const T_WOO_O: Record<string, TargetField> = {
  // 7.4: the source number is carried as order meta, never as WooCommerce's own ID (ORDERID stays empty → native sequence)
  number: { cols: ['meta:_source_order_number'], required: true }, email: { cols: ['billing_email'] }, createdAt: { cols: ['order_date'] },
  financialStatus: { cols: ['order_status'] }, fulfillmentStatus: { cols: ['order_status'] }, status: { cols: ['order_status'] },
  currency: { cols: ['order_currency'] }, subtotal: { cols: [] }, shippingAmount: { cols: ['order_shipping'] }, taxes: { cols: ['order_tax'] }, total: { cols: ['order_total'] },
  discountCode: { cols: [] }, discountAmount: { cols: ['cart_discount'] }, paymentMethod: { cols: ['payment_method_title'] }, transactionId: { cols: ['transaction_id'] },
  note: { cols: ['customer_note'] }, billing: { cols: ['billing_…'] }, shipping: { cols: ['shipping_…'] }, lineItems: { cols: ['item_…'] },
};

export const TARGET_FIELDS: Partial<Record<FormatId, Record<string, TargetField>>> = {
  shopify_customers: T_SHOPIFY_C,
  woo_customers: T_WOO_C,
  bigcommerce_customers: T_BC_C,
  shopify_orders: T_SHOPIFY_O,
  woo_orders: T_WOO_O,
};
// Product targets are computed on first use (a few dozen probe serialisations), then memoised.
for (const [fid, t] of [['shopify_products', 'shopify'], ['woo_products_modern', 'woocommerce'], ['wix_products', 'wix'], ['bigcommerce_products', 'bigcommerce']] as const) {
  Object.defineProperty(TARGET_FIELDS, fid, { enumerable: true, get: () => productTargetTable(t) });
}

// True when both a source and target table exist for the pair (mapping offered).
export function hasMappingPlan(sourceFormat: FormatId, targetFormat: FormatId): boolean {
  return !!SOURCE_FIELDS[sourceFormat] && !!TARGET_FIELDS[targetFormat];
}

// ── Analyze: bind the plan to a REAL file's columns + confidence ──────────────
function pickColumn(rule: SourceField, headerSet: Set<string>): { column: string | null; via: 'exact' | 'alias' | 'none' } {
  if (headerSet.has(rule.column)) return { column: rule.column, via: 'exact' };
  for (const a of rule.aliases ?? []) if (headerSet.has(a)) return { column: a, via: 'alias' };
  return { column: null, via: 'none' };
}

export function analyzePlan(
  headers: string[], sourceFormat: FormatId, targetFormat: FormatId, entity: Entity, overrides: MappingOverrides = {},
  options: AnalyzeOptions = {},
): AnalyzedPlan {
  const rules = SOURCE_FIELDS[sourceFormat] ?? [];
  const targets = TARGET_FIELDS[targetFormat] ?? {};
  const headerSet = new Set(headers);
  const consumed = new Set<string>(); // source columns a rule accounts for
  const recognition = loadRecognitionConfigSync();
  // Samples come from the first rows only: a column's meaning is read from a
  // handful of cells, never from the whole file.
  const sampleRows = (options.rows ?? []).slice(0, SAMPLE_ROWS);

  const bindings: FieldBinding[] = [];
  const missingRequiredSource: FieldBinding[] = [];
  const suggestedOverrides: MappingOverrides = {};

  for (const rule of rules) {
    const ov = overrides[rule.id];
    const overridden = ov !== undefined && rule.editable;
    let resolvedColumn: string | null;
    let via: 'exact' | 'alias' | 'none' | 'override';
    if (overridden) {
      resolvedColumn = ov.column; // may be null (excluded) or a chosen column
      via = 'override';
    } else {
      const picked = pickColumn(rule, headerSet);
      resolvedColumn = picked.column;
      via = picked.via;
    }
    // The parser reads resolvedColumn as-is only for an exact match or an
    // override. A near-name match is a SUGGESTION: recorded so the app can
    // pre-fill it, but never fed to the conversion until accepted.
    const applied = via === 'exact' || via === 'override';
    if (via === 'alias' && resolvedColumn) suggestedOverrides[rule.id] = { column: resolvedColumn };

    // Structural rules (images/options/metafields) consume columns by pattern,
    // not a single name — mark their default column family as consumed loosely.
    if (resolvedColumn) consumed.add(resolvedColumn);
    let structuralHits = 0;
    if (!rule.editable) structuralHits = markStructuralConsumed(rule, headers, consumed);

    // 6.7 — a structural rule whose default column is a PATTERN ("Meta: *",
    // "(product.metafields.*)") is present when its family matches: the
    // columns it consumes were invisible in the plan (consumed, listed nowhere).
    let present = resolvedColumn != null && (headerSet.has(resolvedColumn) || !rule.editable);
    if (!present && !rule.editable && structuralHits > 0) { present = true; resolvedColumn = rule.column; }
    const target = targets[rule.canon];
    const targetColumns = target?.cols ?? [];
    const carried = targetColumns.length > 0;

    let confidence: Confidence;
    if (!present || resolvedColumn == null) confidence = 'none';
    else if (via === 'override' || via === 'alias' || rule.reviewAlways) confidence = 'check';
    else confidence = 'high';

    // An override equal to the near-name the engine would suggest is still the
    // engine's proposal (pre-filled by the app), scored as such.
    const engineGuess = overridden ? pickColumn(rule, headerSet) : null;
    const prefilled = !!engineGuess && engineGuess.via === 'alias' && engineGuess.column === resolvedColumn;
    const score = !present || resolvedColumn == null ? null : via === 'exact' ? 1 : via === 'alias' || prefilled ? recognition.name.alias : null;
    const binding: FieldBinding = {
      id: rule.id, canon: rule.canon, scope: rule.scope, transform: rule.transform, editable: rule.editable,
      defaultColumn: rule.column, resolvedColumn, present, overridden, applied, confidence, score, prefilled,
      sample: resolvedColumn && rule.editable ? sampleOf(sampleRows, resolvedColumn) : '',
      targetColumns, carried, descFr: rule.descFr, descEn: rule.descEn,
    };
    if (present) bindings.push(binding);
    else if (rule.sourceRequired && !overridden) missingRequiredSource.push(binding);
  }

  // Source columns present in the file but consumed by no rule → "Non utilisée".
  const unused: UnusedColumn[] = headers
    .filter((h) => !consumed.has(h))
    .map((h) => ({ column: h, confidence: 'none' as const, sample: sampleOf(sampleRows, h) }));

  // Choices offered when re-pointing a column: canon fields that HAVE a target.
  const reassignTargets = Object.keys(targets)
    .filter((canon) => (targets[canon]?.cols.length ?? 0) > 0)
    .map((canon) => ({ canon, label: canon, targetColumns: targets[canon]!.cols }));

  const plan: AnalyzedPlan = { version: MAPPING_RULES_VERSION, sourceFormat, targetFormat, entity, bindings, unused, missingRequiredSource, reassignTargets, suggestedOverrides };

  if (options.recognize === 'semantic') {
    plan.semantic = semanticAnalyze(headers, options.rows ?? [], entity, { formatId: options.formatId, decisions: options.decisions });
    plan.ruleByCanon = Object.fromEntries(rules.filter((r) => r.editable).map((r) => [r.canon, r.id]));
    // 6.3 — a canon field the catalogue DERIVES another one from (identifiers.ean
    // → barcode) reaches the derived field's rule: the derivation is the bridge,
    // so a column recognised as a typed identifier still pre-fills `barcode`
    // on a format whose rules predate the typed split. Data, not a special case.
    for (const d of loadCanonCatalogSync().derivations ?? []) {
      if (d.scope && d.scope !== 'product' && d.scope !== 'variant') continue; // 7.2: order / customer rules are not column bridges
      const target = plan.ruleByCanon[d.path];
      if (!target) continue;
      for (const from of d.from) if (!plan.ruleByCanon[from]) plan.ruleByCanon[from] = target;
    }
    // Bridge: an AUTO/decided column for a canon whose rule is unresolved
    // becomes a pre-filled suggestion — it feeds the conversion only once
    // accepted (same contract as near-name aliases), never silently.
    const boundCanon = new Set(bindings.map((b) => b.canon));
    for (const col of plan.semantic.columns) {
      if (!(col.status === 'auto' || col.status === 'decided') || !col.best) continue;
      const ruleId = plan.ruleByCanon[col.best.canon];
      const rule = ruleId ? rules.find((r) => r.id === ruleId && r.editable) : undefined;
      if (!rule || boundCanon.has(rule.canon) || overrides[rule.id] !== undefined) continue;
      if (!suggestedOverrides[rule.id]) suggestedOverrides[rule.id] = { column: col.column };
    }
    // A pre-filled semantic suggestion keeps its recogniser score (and stays
    // "to review" in the summary) until the user picks something else.
    const semByCol = new Map(plan.semantic.columns.map((c) => [c.column, c]));
    for (const b of bindings) {
      if (!b.overridden || b.prefilled || !b.resolvedColumn) continue;
      const c = semByCol.get(b.resolvedColumn);
      if (c && c.status === 'auto' && c.best && plan.ruleByCanon[c.best.canon] === b.id) { b.prefilled = true; b.score = c.best.score; }
    }
  }
  return plan;
}

// Phase 5.4 — standalone semantic pass: works for ANY header set, including
// formats the engine cannot detect (the 5.7 Scraper case). Reads the canon
// catalogue + recognition config from the Reference strata.
export function semanticAnalyze(
  headers: string[], rows: Row[], entity: Entity | null, opts: { formatId?: string; decisions?: LearnedDecision[] } = {},
): SemanticReport {
  // Recognition reads column NAMES first; values only confirm the type. A bounded sample keeps a 50 000-row
  // CSV instant: rows spread over the whole file (start, middle, end), never only its head.
  const config = loadRecognitionConfigSync();
  const limit = Number((config.profiles as { sampleRows?: number }).sampleRows) || 200;
  const sample = rows.length > limit ? Array.from({ length: limit }, (_, i) => rows[Math.floor((i * rows.length) / limit)]) : rows;
  return recognizeColumns({
    headers, rows: sample, entity: entity ?? undefined,
    catalog: loadCanonCatalogSync(), config,
    formatId: opts.formatId, decisions: opts.decisions ?? [],
  });
}

const SAMPLE_ROWS = 50;
const SAMPLE_MAX = 60;
function sampleOf(rows: Row[], column: string): string {
  for (const r of rows) {
    const v = String(r[column] ?? '').trim();
    if (v) return v.length > SAMPLE_MAX ? v.slice(0, SAMPLE_MAX) + '…' : v;
  }
  return '';
}

// ── Column summary — what step 3 and the conversion report count ─────────────
// Every source column lands in exactly ONE bucket, so the counts add up to the
// header count (nothing silently missing):
//   auto      — matched by name with high confidence, no action needed
//   check     — matched, but to review (near-name, tricky field, semantic suggestion)
//   manual    — the user chose or confirmed it (override / decision)
//   ignored   — the user said "do not import"
//   unknown   — no field identified: kept aside and listed, never dropped
//   notCarried— matched, but the TARGET has no column for that field
export type ColumnSummary = { total: number; auto: number; check: number; manual: number; ignored: number; unknown: number; notCarried: number; notCarriedFields: string[] };

// `learn` = an unknown file whose every column goes through recognition: an
// AUTO column there IS the mapping (it is what "remember this format" keeps).
export function summarizeColumns(plan: Pick<AnalyzedPlan, 'bindings' | 'unused' | 'semantic'>, overrides: MappingOverrides = {}, opts: { learn?: boolean } = {}): ColumnSummary {
  const s: ColumnSummary = { total: 0, auto: 0, check: 0, manual: 0, ignored: 0, unknown: 0, notCarried: 0, notCarriedFields: [] };
  const sem = new Map((plan.semantic?.columns ?? []).map((c) => [c.column, c]));
  const pointed = new Set(Object.values(overrides).map((o) => o?.column).filter((c): c is string => !!c));
  for (const b of plan.bindings) {
    s.total++;
    const ov = overrides[b.id];
    if (ov && ov.column === null) s.ignored++;
    else if (!b.carried) { s.notCarried++; s.notCarriedFields.push(b.canon); }
    else if (b.overridden && !b.prefilled) s.manual++;
    else if (b.confidence === 'high') s.auto++;
    else s.check++;
  }
  for (const u of plan.unused) {
    s.total++;
    const c = sem.get(u.column);
    if (c?.status === 'ignored') s.ignored++;
    else if (c?.status === 'decided') s.manual++;
    else if (opts.learn && c?.status === 'auto') s.auto++;
    else if (pointed.has(u.column) || c?.status === 'auto' || c?.status === 'suggest') s.check++;
    else s.unknown++;
  }
  return s;
}

/** The columns of a header set a structural rule reads as one family (options, images, metafields…): step 3 shows
 *  each of them as one line of the file, read with its family. Same patterns as the plan's own consumption. */
export function structuralColumns(transform: TransformId, headers: string[]): string[] {
  const consumed = new Set<string>();
  markStructuralConsumed({ transform } as SourceField, headers, consumed);
  return headers.filter((h) => consumed.has(h));
}

// Structural fields read families of columns (Option1 Name/Value…, Meta:*, etc.).
// Mark those present columns consumed so they don't show as "Non utilisée".
function markStructuralConsumed(rule: SourceField, headers: string[], consumed: Set<string>): number {
  let hits = 0;
  const add = (pred: (h: string) => boolean) => headers.forEach((h) => { if (pred(h)) { consumed.add(h); hits++; } });
  switch (rule.transform) {
    case 'images':
      add((h) => /^Image /.test(h) || h === 'Image Src' || h === 'Images' || h === 'productImageUrl' || /Image URL|Internal Image/.test(h));
      break;
    case 'options':
      add((h) => /^Option\d /.test(h) || /^Attribute \d/.test(h) || /^attribute:/.test(h) || /^productOption(Name|Type|Description)\d/.test(h) || h === 'Options');
      break;
    case 'metafields':
      add((h) => /\(product\.metafields\.[^)]+\)$/.test(h) || h.startsWith('Meta:'));
      break;
    case 'address':
      add((h) => /^(Billing|Shipping) /.test(h) || /^(billing|shipping)_/.test(h) || /^Address (Line|Company|Phone|First|Last)/.test(h));
      break;
    case 'lineitems':
      add((h) => /^Lineitem /.test(h) || /^item_/.test(h) || /^Product (Name|SKU|Qty|Unit Price)$/.test(h));
      break;
    default:
      break;
  }
  return hits;
}

// ── Validate: required target not covered, source absent, conflicts ───────────
export type PlanValidation = { errors: { code: string; params?: Record<string, string> }[]; warnings: { code: string; params?: Record<string, string> }[] };

export function validatePlan(plan: AnalyzedPlan, overrides: MappingOverrides = {}): PlanValidation {
  const errors: PlanValidation['errors'] = [];
  const warnings: PlanValidation['warnings'] = [];
  const rules = SOURCE_FIELDS[plan.sourceFormat] ?? [];
  const targets = TARGET_FIELDS[plan.targetFormat] ?? {};

  // A source-required field with no column (and not overridden with one).
  for (const b of plan.missingRequiredSource) {
    errors.push({ code: 'map_source_required_missing', params: { field: b.id } });
  }
  // A required TARGET field left uncovered (no bound source contributes its canon).
  const coveredCanon = new Set(plan.bindings.filter((b) => b.present).map((b) => b.canon));
  for (const [canon, tf] of Object.entries(targets)) {
    if (tf.required && !coveredCanon.has(canon)) errors.push({ code: 'map_target_required_uncovered', params: { field: canon } });
  }
  // An override pointing at a column that isn't in the file, or at a non-editable field.
  for (const [id, ov] of Object.entries(overrides)) {
    const rule = rules.find((r) => r.id === id);
    if (!rule) { warnings.push({ code: 'map_unknown_field', params: { field: id } }); continue; }
    if (!rule.editable) errors.push({ code: 'map_field_not_editable', params: { field: id } });
  }
  return { errors, warnings };
}

// ── Apply overrides to a parsed Table (the SAFE editing mechanism) ────────────
// Re-point or drop scalar SOURCE columns by writing into the column the parser
// expects, BEFORE the unchanged parser runs. No overrides → returns the table
// unchanged (same reference), so output is byte-for-byte identical.
/** The effective step-3 re-points as { declared column → chosen column | null
 *  (excluded) } — what the preservation pass needs to trace a re-pointed field
 *  to the column the user picked (and not report that column as unknown). */
export function overrideColumnsFor(sourceFormat: FormatId, overrides?: MappingOverrides): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (!overrides) return out;
  const rules = SOURCE_FIELDS[sourceFormat] ?? [];
  for (const [id, ov] of Object.entries(overrides)) {
    const rule = rules.find((x) => x.id === id);
    if (rule && rule.editable) out[rule.column] = ov.column;
  }
  return out;
}

export function applyOverridesToTable(table: Table, sourceFormat: FormatId, overrides?: MappingOverrides): Table {
  if (!overrides || Object.keys(overrides).length === 0) return table;
  const rules = SOURCE_FIELDS[sourceFormat] ?? [];
  const effective = Object.entries(overrides).filter(([id]) => {
    const r = rules.find((x) => x.id === id);
    return r && r.editable;
  });
  if (effective.length === 0) return table;

  const rows: Row[] = table.rows.map((r) => ({ ...r }));
  const extraHeaders: string[] = [];
  for (const [id, ov] of effective) {
    const rule = rules.find((x) => x.id === id)!;
    const expected = rule.column;
    if (!table.headers.includes(expected) && !extraHeaders.includes(expected)) extraHeaders.push(expected);
    for (const r of rows) {
      if (ov.column === null) r[expected] = '';                 // exclude → blank the field
      else r[expected] = r[ov.column] ?? '';                    // re-point → copy chosen column in
    }
  }
  return { headers: [...table.headers, ...extraHeaders.filter((h) => !table.headers.includes(h))], rows, malformed: table.malformed };
}
