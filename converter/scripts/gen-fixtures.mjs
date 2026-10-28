/**
 * Generates the regression FIXTURES (test/fixtures/*.csv) — realistic,
 * anonymized source exports for every detected format. Authored as row-objects
 * and written with a delimiter-aware CSV writer, so columns can never misalign.
 * These are INPUTS (not engine output); committed as .csv. Re-run only to add or
 * change a fixture — then regenerate goldens (gen-golden.mjs) and eyeball the
 * diff. No dependency on the engine (a fixture must not depend on what it tests).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'test', 'fixtures');
fs.mkdirSync(DIR, { recursive: true });

/** Minimal RFC-4180 writer with a chosen delimiter. Quotes only when needed. */
function toCsv(headers, rows, delim = ',') {
  const q = (v) => {
    const s = v == null ? '' : String(v);
    return new RegExp(`["${delim === '\t' ? '\\t' : delim}\\r\\n]`).test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(q).join(delim)];
  for (const r of rows) lines.push(headers.map((h) => q(r[h] ?? '')).join(delim));
  return lines.join('\r\n') + '\r\n';
}
function write(name, headers, rows, delim = ',') {
  fs.writeFileSync(path.join(DIR, name), toCsv(headers, rows, delim));
  console.log('  fixture', name, `(${rows.length} rows, ${headers.length} cols)`);
}

// ── Shopify products ─────────────────────────────────────────────────────────
const SHOPIFY_P = ['Handle', 'Title', 'Body (HTML)', 'Vendor', 'Type', 'Tags', 'Published',
  'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value', 'Option3 Name', 'Option3 Value',
  'Variant SKU', 'Variant Grams', 'Variant Inventory Qty', 'Variant Price', 'Variant Compare At Price',
  'Variant Requires Shipping', 'Variant Taxable', 'Variant Barcode', 'Cost per item',
  'Image Src', 'Image Position', 'Image Alt Text', 'Variant Image', 'SEO Title', 'SEO Description',
  'Status', 'Product Category', 'Matiere (product.metafields.custom.matiere)'];
write('shopify_products.csv', SHOPIFY_P, [
  // Multi-variant (Taille), accents, metafield, one image.
  { Handle: 'chemise-lin-ecru', Title: 'Chemise en lin — Écru', 'Body (HTML)': '<p>Chemise 100% lin.</p>', Vendor: 'Atelier Léon', Type: 'Chemises', Tags: 'femme, lin, été', Published: 'true', 'Option1 Name': 'Taille', 'Option1 Value': '38', 'Variant SKU': 'CHM-LIN-38', 'Variant Grams': '250', 'Variant Inventory Qty': '12', 'Variant Price': '89.00', 'Variant Requires Shipping': 'true', 'Variant Taxable': 'true', 'Variant Barcode': '3401234567890', 'Cost per item': '32.50', 'Image Src': 'https://cdn.example.com/chemise-lin-1.jpg', 'Image Position': '1', 'Image Alt Text': 'Chemise lin écru', 'SEO Title': 'Chemise en lin écru', 'SEO Description': 'Chemise légère en lin.', Status: 'active', 'Product Category': 'Apparel > Tops', 'Matiere (product.metafields.custom.matiere)': 'Lin' },
  { Handle: 'chemise-lin-ecru', 'Option1 Value': '40', 'Variant SKU': 'CHM-LIN-40', 'Variant Grams': '260', 'Variant Inventory Qty': '4', 'Variant Price': '89.00', 'Variant Requires Shipping': 'true', 'Variant Taxable': 'true', 'Variant Barcode': '3401234567891', 'Cost per item': '32.50', Status: 'active' },
  // Two options (Taille + Couleur), one variant on promo, two images.
  { Handle: 'pull-cotele', Title: 'Pull côtelé', 'Body (HTML)': '<p>Pull chaud.</p>', Vendor: 'La Maille', Type: 'Mailles', Tags: 'hiver, laine', Published: 'true', 'Option1 Name': 'Taille', 'Option1 Value': 'M', 'Option2 Name': 'Couleur', 'Option2 Value': 'Noir', 'Variant SKU': 'PULL-M-NOIR', 'Variant Grams': '600', 'Variant Inventory Qty': '8', 'Variant Price': '45.00', 'Variant Compare At Price': '59.00', 'Variant Requires Shipping': 'true', 'Variant Taxable': 'true', 'Image Src': 'https://cdn.example.com/pull-1.jpg', 'Image Position': '1', 'Image Alt Text': 'Pull noir', Status: 'active', 'Matiere (product.metafields.custom.matiere)': 'Laine' },
  { Handle: 'pull-cotele', 'Option1 Value': 'L', 'Option2 Value': 'Noir', 'Variant SKU': 'PULL-L-NOIR', 'Variant Grams': '650', 'Variant Inventory Qty': '2', 'Variant Price': '59.00', 'Variant Requires Shipping': 'true', 'Variant Taxable': 'true', 'Image Src': 'https://cdn.example.com/pull-2.jpg', 'Image Position': '2', 'Image Alt Text': 'Pull détail' },
  // Special chars: comma + apostrophe in title, quotes + ampersand in body; single variant (Default Title path).
  { Handle: 'robe-ete', Title: "Robe d'été, coupe droite", 'Body (HTML)': '<p>Tissu "premium" & doux</p>', Vendor: 'Studio', Type: 'Robes', Published: 'true', 'Variant SKU': 'ROBE-01', 'Variant Grams': '300', 'Variant Inventory Qty': '15', 'Variant Price': '120.00', 'Variant Requires Shipping': 'true', 'Variant Taxable': 'true', 'Image Src': 'https://cdn.example.com/robe.jpg', 'Image Position': '1', Status: 'active' },
  // No title → RowError product_no_title (dropped from output).
  { Handle: 'orphan-sku', 'Variant SKU': 'ORP-1', 'Variant Price': '10.00', Status: 'active' },
  // Draft, empty price (untracked), no image.
  { Handle: 'archive-modele', Title: 'Ancien modèle', Vendor: 'Studio', Published: 'false', 'Variant SKU': 'ARC-1', 'Variant Inventory Qty': '0', Status: 'draft' },
]);

// ── WooCommerce products (modern exporter) ───────────────────────────────────
const WOO_MODERN = ['ID', 'Type', 'SKU', 'Name', 'Published', 'Is featured?', 'Visibility in catalog',
  'Short description', 'Description', 'In stock?', 'Stock', 'Regular price', 'Sale price',
  'Tax status', 'Virtual', 'Weight (kg)', 'Length (cm)', 'Width (cm)', 'Height (cm)',
  'Categories', 'Tags', 'Brands', 'Images', 'Parent',
  'Attribute 1 name', 'Attribute 1 value(s)', 'Attribute 2 name', 'Attribute 2 value(s)',
  'Meta: gender', 'Meta: _edit_lock'];
write('woo_products_modern.csv', WOO_MODERN, [
  // Variable parent: Attribute 1 (Couleur) used by all variations → option; Attribute 2 (Matière) only on parent → metafield.
  { ID: '1001', Type: 'variable', SKU: 'PULL-COT', Name: 'Pull côtelé', Published: '1', 'Visibility in catalog': 'visible', 'Short description': 'Doux et chaud', Description: '<p>Pull chaud.</p>', Categories: 'Femme > Mailles', Tags: 'hiver, laine', Brand: 'La Maille', Images: 'https://cdn.example.com/pull-1.jpg, https://cdn.example.com/pull-2.jpg', 'Attribute 1 name': 'Couleur', 'Attribute 1 value(s)': 'Noir | Écru', 'Attribute 2 name': 'Matière', 'Attribute 2 value(s)': 'Laine', 'Meta: gender': 'Femme', 'Meta: _edit_lock': '1600000000:1' },
  { ID: '1002', Type: 'variation', SKU: 'PULL-COT-NOIR', Name: 'Pull côtelé - Noir', Published: '1', 'In stock?': '1', Stock: '8', 'Regular price': '79.00', 'Sale price': '59.00', 'Tax status': 'taxable', Virtual: 'no', 'Weight (kg)': '0.6', Parent: 'id:1001', 'Attribute 1 value(s)': 'Noir' },
  { ID: '1003', Type: 'variation', SKU: 'PULL-COT-ECRU', Name: 'Pull côtelé - Écru', Published: '1', 'In stock?': '1', Stock: '3', 'Regular price': '79.00', 'Tax status': 'taxable', Virtual: 'no', 'Weight (kg)': '0.6', Parent: 'id:1001', 'Attribute 1 value(s)': 'Écru' },
  // Simple product on promo (sale < regular), physical, dimensions.
  { ID: '1004', Type: 'simple', SKU: 'CEINTURE-TAN', Name: 'Ceinture cuir — Tan', Published: '1', 'Visibility in catalog': 'visible', Description: '<p>Cuir pleine fleur.</p>', 'In stock?': '1', Stock: '31', 'Regular price': '65.00', 'Sale price': '49.00', 'Tax status': 'taxable', Virtual: 'no', 'Weight (kg)': '0.2', 'Length (cm)': '110', 'Width (cm)': '4', Categories: 'Accessoires > Ceintures', Brand: 'Cuirs & Co', Images: 'https://cdn.example.com/ceinture.jpg' },
  // Simple, draft, no price (untracked).
  { ID: '1005', Type: 'simple', SKU: 'ECHARPE-01', Name: 'Écharpe alpaga', Published: '0', 'Visibility in catalog': 'hidden', 'In stock?': '1', 'Tax status': 'taxable', Virtual: 'no', Categories: 'Accessoires > Écharpes' },
]);

// ── WooCommerce products (legacy flat exporter) ──────────────────────────────
const WOO_LEGACY = ['post_name', 'post_title', 'post_content', 'post_status', 'sku',
  'regular_price', 'sale_price', 'stock', 'weight', 'length', 'width', 'height',
  'tax:product_cat', 'tax:product_tag', 'tax:product_brand', 'attribute:Taille', 'attribute:Couleur'];
write('woo_products_legacy.csv', WOO_LEGACY, [
  { post_name: 'tshirt-bio', post_title: 'T-shirt bio', post_content: '<p>Coton biologique.</p>', post_status: 'publish', sku: 'TS-BIO', regular_price: '25.00', sale_price: '19.00', stock: '50', weight: '0.18', 'tax:product_cat': 'Homme > Hauts', 'tax:product_tag': 'coton, bio', 'tax:product_brand': 'Marques > ÉcoWear', 'attribute:Taille': 'S | M | L', 'attribute:Couleur': 'Blanc | Noir' },
  { post_name: 'mug-email', post_title: 'Mug émaillé', post_content: '<p>Mug 30cl.</p>', post_status: 'publish', sku: 'MUG-30', regular_price: '14.50', stock: '200', weight: '0.35', 'tax:product_cat': 'Maison > Cuisine', 'tax:product_brand': 'AtelierCéramique' },
  { post_name: 'draft-item', post_title: 'Brouillon', post_status: 'draft', sku: 'DRAFT-1', regular_price: '9.99', stock: '0', 'tax:product_cat': 'Divers' },
]);

// ── Wix Stores products ──────────────────────────────────────────────────────
const WIX = ['handleId', 'fieldType', 'name', 'description', 'productImageUrl', 'collection', 'sku',
  'ribbon', 'price', 'surcharge', 'visible', 'discountMode', 'discountValue', 'inventory', 'weight', 'cost',
  'productOptionName1', 'productOptionType1', 'productOptionDescription1',
  'productOptionName2', 'productOptionType2', 'productOptionDescription2',
  'additionalInfoTitle1', 'additionalInfoDescription1', 'customTextField1', 'brand'];
write('wix_products.csv', WIX, [
  // Product with COLOR option (hex) + DROP_DOWN, product-level percent discount, ribbon, info section, custom text, images (;).
  { handleId: 'sac-cuir', fieldType: 'Product', name: 'Sac en cuir', description: '<p>Cuir tanné végétal.</p>', productImageUrl: 'https://cdn.example.com/sac-1.jpg;https://cdn.example.com/sac-2.jpg', collection: 'Sacs;Nouveautés', sku: '', ribbon: 'Nouveau', price: '150.00', visible: 'TRUE', discountMode: 'PERCENT', discountValue: '10', inventory: 'InStock', weight: '0.8', cost: '70.00', productOptionName1: 'Couleur', productOptionType1: 'COLOR', productOptionDescription1: '#8B5A2B:Tan;#000000:Noir', productOptionName2: 'Format', productOptionType2: 'DROP_DOWN', productOptionDescription2: 'Petit;Grand', additionalInfoTitle1: 'Entretien', additionalInfoDescription1: 'Nettoyer avec un chiffon doux.', customTextField1: 'Gravure (offerte)', brand: 'Maroquinerie' },
  { handleId: 'sac-cuir', fieldType: 'Variant', sku: 'SAC-TAN-P', price: '150.00', visible: 'TRUE', inventory: '5', weight: '0.8', productOptionDescription1: 'Tan', productOptionDescription2: 'Petit' },
  { handleId: 'sac-cuir', fieldType: 'Variant', sku: 'SAC-NOIR-G', price: '170.00', visible: 'TRUE', inventory: '3', weight: '0.9', productOptionDescription1: 'Noir', productOptionDescription2: 'Grand' },
  // Simple product, no variants, out of stock literal, no discount.
  { handleId: 'bougie-cire', fieldType: 'Product', name: 'Bougie cire de soja', description: '<p>Parfum figue.</p>', productImageUrl: 'https://cdn.example.com/bougie.jpg', collection: 'Maison', sku: 'BOUGIE-FIGUE', price: '24.00', visible: 'TRUE', inventory: 'OutOfStock', weight: '0.4', brand: 'ChezSoi' },
  // Hidden (visible FALSE).
  { handleId: 'test-cache', fieldType: 'Product', name: 'Produit test', description: '', productImageUrl: '', collection: '', sku: 'TEST-1', price: '5.00', visible: 'FALSE', inventory: '0' },
]);

// ── BigCommerce products (Item-typed, positional) ────────────────────────────
const BC_P = ['Item', 'ID', 'Name', 'Type', 'SKU', 'Options', 'Inventory Tracking', 'Current Stock',
  'Price', 'Cost Price', 'Retail Price', 'Sale Price', 'Brand ID', 'Categories', 'Description',
  'Page Title', 'Product URL', 'Meta Description', 'Bin Picking Number', 'UPC/EAN', 'Free Shipping',
  'Weight', 'Width', 'Height', 'Depth', 'Is Visible', 'Warranty',
  'Variant Image URL', 'Internal Image URL (Export)', 'Image URL (Import)', 'Image Description', 'Image Sort Order'];
write('bigcommerce_products.csv', BC_P, [
  // Variable product with two Variant rows (Options packed), then Image rows.
  { Item: 'Product', ID: '55', Name: 'Casque audio', Type: 'physical', SKU: 'CASQUE', 'Inventory Tracking': 'variant', Price: '199.00', 'Cost Price': '90.00', 'Retail Price': '229.00', 'Brand ID': '12', Categories: '23;18', Description: '<p>Casque sans fil.</p>', 'Page Title': 'Casque audio sans fil', 'Product URL': '/casque-audio/', 'Meta Description': 'Son haute fidélité.', 'Bin Picking Number': 'A-12', 'UPC/EAN': '', Weight: '0.35', 'Is Visible': 'TRUE', Warranty: '2 ans' },
  { Item: 'Variant', SKU: 'CASQUE-NOIR', Options: 'Type=Swatch|Name=Couleur|Value=Noir[#000000]', 'Current Stock': '20', Price: '199.00', Weight: '0.35' },
  { Item: 'Variant', SKU: 'CASQUE-BLANC', Options: 'Type=Swatch|Name=Couleur|Value=Blanc[#ffffff]', 'Current Stock': '7', 'Sale Price': '179.00', Price: '199.00', Weight: '0.35' },
  { Item: 'Image', 'Internal Image URL (Export)': 'https://cdn.example.com/casque-1.jpg', 'Image Description': 'Casque noir', 'Image Sort Order': '0' },
  { Item: 'Image', 'Internal Image URL (Export)': 'https://cdn.example.com/casque-2.jpg', 'Image Description': 'Casque profil', 'Image Sort Order': '1' },
  // Simple product, digital (no shipping), on promo.
  { Item: 'Product', ID: '56', Name: 'Guide PDF', Type: 'digital', SKU: 'GUIDE-PDF', 'Inventory Tracking': 'none', Price: '15.00', 'Sale Price': '9.00', Categories: '30', Description: '<p>Guide numérique.</p>', 'Product URL': '/guide-pdf/', 'Is Visible': 'TRUE' },
]);

// ── BigBuy: standard catalogue (semicolon) + categories companion ─────────────
const BIGBUY_STD = ['ID', 'NAME', 'DESCRIPTION', 'CATEGORY', 'PVD', 'PVP_BIGBUY', 'EAN13', 'WEIGHT',
  'DEPTH', 'WIDTH', 'HEIGHT', 'STOCK', 'ATTRIBUTE1', 'VALUE1', 'ATTRIBUTE2', 'VALUE2',
  'BRAND', 'INTRASTAT', 'IVA', 'IMAGE1', 'IMAGE2', 'IMAGE3'];
write('bigbuy_standard.csv', BIGBUY_STD, [
  { ID: 'S1001', NAME: 'Gourde inox 500ml', DESCRIPTION: '<p>Isotherme.</p>', CATEGORY: '201', PVD: '4.20', PVP_BIGBUY: '9.90', EAN13: '8412345000019', WEIGHT: '0.30', DEPTH: '7', WIDTH: '7', HEIGHT: '22', STOCK: '340', ATTRIBUTE1: 'Couleur', VALUE1: 'Argent', BRAND: '77', INTRASTAT: '96170000', IVA: '21', IMAGE1: 'https://img.bigbuy.eu/s1001-1.jpg', IMAGE2: 'https://img.bigbuy.eu/s1001-2.jpg' },
  { ID: 'S1002', NAME: 'Écouteurs Bluetooth', DESCRIPTION: '<p>Sans fil.</p>', CATEGORY: '202', PVD: '11.50', PVP_BIGBUY: '24.90', EAN13: '8412345000026', WEIGHT: '0.08', STOCK: '120', BRAND: '77', IVA: '21', IMAGE1: 'https://img.bigbuy.eu/s1002-1.jpg' },
  // No name → error product_no_name_supplier (dropped).
  { ID: 'S1003', NAME: '', DESCRIPTION: '<p>?</p>', CATEGORY: '999', PVD: '1.00', PVP_BIGBUY: '2.00', STOCK: '5', IMAGE1: 'https://img.bigbuy.eu/s1003.jpg' },
], ';');
const PRESTA_CATS = ['ID', 'NAME', 'PARENT_CATEGORY', 'ROOT_CATEGORY'];
write('presta_categories.csv', PRESTA_CATS, [
  { ID: '1', NAME: 'Accueil', PARENT_CATEGORY: '0', ROOT_CATEGORY: '1' },
  { ID: '200', NAME: 'Maison', PARENT_CATEGORY: 'Accueil', ROOT_CATEGORY: '1' },
  { ID: '201', NAME: 'Cuisine', PARENT_CATEGORY: 'Maison', ROOT_CATEGORY: '1' },
  { ID: '202', NAME: 'Audio', PARENT_CATEGORY: 'Maison', ROOT_CATEGORY: '1' },
], ';');

// ── BigBuy: PrestaShop-format catalogue (semicolon) ──────────────────────────
const BIGBUY_PRESTA = ['ID', 'bb_REFERENCE', 'NAME', 'DESCRIPTION', 'SHORT_DESCRIPTION', 'CATEGORIES',
  'PRICE_TAX_EXCLUDE', 'WHOLESALE_PRICE', 'EAN13', 'UPC', 'WEIGHT', 'DEPTH', 'WIDTH', 'HEIGHT',
  'QUANTITY', 'TAX_RULE_ID', 'ACTIVE', 'MANUFACTER', 'URL_REWRITTEN', 'META_TITLE', 'TAGS', 'IMAGES_URL'];
write('bigbuy_presta.csv', BIGBUY_PRESTA, [
  { ID: 'P2001', bb_REFERENCE: 'REF-2001', NAME: 'Lampe de bureau LED', DESCRIPTION: '<p>Réglable.</p>', SHORT_DESCRIPTION: 'Lampe LED', CATEGORIES: '201', PRICE_TAX_EXCLUDE: '12.90', WHOLESALE_PRICE: '6.10', EAN13: '8412345111019', WEIGHT: '0.7', DEPTH: '15', WIDTH: '12', HEIGHT: '40', QUANTITY: '80', TAX_RULE_ID: '1', ACTIVE: '1', MANUFACTER: '88', URL_REWRITTEN: 'lampe-bureau-led', META_TITLE: 'Lampe de bureau LED', TAGS: 'bureau, led', IMAGES_URL: 'https://img.bigbuy.eu/p2001-1.jpg, https://img.bigbuy.eu/p2001-2.jpg' },
  { ID: 'P2002', bb_REFERENCE: 'REF-2002', NAME: 'Enceinte portable', DESCRIPTION: '<p>Bluetooth.</p>', CATEGORIES: '202', PRICE_TAX_EXCLUDE: '19.90', WHOLESALE_PRICE: '9.50', UPC: '712345678902', WEIGHT: '0.5', QUANTITY: '45', TAX_RULE_ID: '1', ACTIVE: '1', MANUFACTER: '88', IMAGES_URL: 'https://img.bigbuy.eu/p2002-1.jpg' },
], ';');

// ── Shopify customers ────────────────────────────────────────────────────────
const SHOPIFY_C = ['First Name', 'Last Name', 'Email', 'Phone', 'Accepts Email Marketing', 'Accepts SMS Marketing',
  'Default Address Company', 'Default Address Address1', 'Default Address Address2', 'Default Address City',
  'Default Address Province Code', 'Default Address Country Code', 'Default Address Zip', 'Default Address Phone',
  'Note', 'Tags', 'Tax Exempt'];
write('shopify_customers.csv', SHOPIFY_C, [
  { 'First Name': 'Camille', 'Last Name': 'Durand', Email: 'camille.durand@example.com', Phone: "'+33612345678", 'Accepts Email Marketing': 'yes', 'Accepts SMS Marketing': 'no', 'Default Address Address1': '12 rue des Fleurs', 'Default Address City': 'Lyon', 'Default Address Country Code': 'FR', 'Default Address Zip': '69001', Note: 'Cliente fidèle', Tags: 'vip, newsletter', 'Tax Exempt': 'no' },
  { 'First Name': 'John', 'Last Name': 'Smith', Email: 'john.smith@example.com', 'Accepts Email Marketing': 'no', 'Default Address Address1': '5 Main St', 'Default Address City': 'Austin', 'Default Address Province Code': 'TX', 'Default Address Country Code': 'US', 'Default Address Zip': '73301', 'Tax Exempt': 'yes' },
  // Duplicate email → warning.
  { 'First Name': 'Camille', 'Last Name': 'D.', Email: 'camille.durand@example.com', 'Accepts Email Marketing': 'yes', 'Default Address City': 'Paris', 'Default Address Country Code': 'FR' },
  // Missing email → error customer_no_email (dropped).
  { 'First Name': 'Sans', 'Last Name': 'Email', 'Default Address City': 'Nice', 'Default Address Country Code': 'FR' },
]);

// ── WooCommerce customers (WordPress user export) ─────────────────────────────
const WOO_C = ['user_login', 'user_email', 'first_name', 'last_name', 'roles',
  'billing_first_name', 'billing_last_name', 'billing_company', 'billing_email', 'billing_phone',
  'billing_address_1', 'billing_address_2', 'billing_city', 'billing_state', 'billing_postcode', 'billing_country',
  'shipping_first_name', 'shipping_last_name', 'shipping_company',
  'shipping_address_1', 'shipping_address_2', 'shipping_city', 'shipping_state', 'shipping_postcode', 'shipping_country'];
write('woo_customers.csv', WOO_C, [
  { user_login: 'marie', user_email: 'marie@example.com', first_name: 'Marie', last_name: 'Lefèvre', roles: 'customer', billing_first_name: 'Marie', billing_last_name: 'Lefèvre', billing_email: 'marie@example.com', billing_phone: '0498765432', billing_address_1: '3 avenue du Parc', billing_city: 'Bruxelles', billing_state: '', billing_postcode: '1000', billing_country: 'BE', shipping_first_name: 'Marie', shipping_last_name: 'Lefèvre', shipping_address_1: '3 avenue du Parc', shipping_city: 'Bruxelles', shipping_postcode: '1000', shipping_country: 'BE' },
  // US customer, state spelled out → code on export; distinct shipping address.
  { user_login: 'dave', user_email: 'dave@example.com', first_name: 'Dave', last_name: 'Miller', roles: 'customer', billing_first_name: 'Dave', billing_last_name: 'Miller', billing_email: 'dave@example.com', billing_address_1: '100 Oak Ave', billing_city: 'Sacramento', billing_state: 'California', billing_postcode: '95814', billing_country: 'US', shipping_address_1: '200 Pine Rd', shipping_city: 'Reno', shipping_state: 'Nevada', shipping_postcode: '89501', shipping_country: 'US' },
  // Non-customer role → skipped (warning skipped_non_customers).
  { user_login: 'admin', user_email: 'admin@example.com', first_name: 'Site', last_name: 'Admin', roles: 'administrator' },
]);

// ── BigCommerce customers ────────────────────────────────────────────────────
const BC_C = ['Email', 'First Name', 'Last Name', 'Company', 'Phone', 'Notes', 'Store Credit', 'Customer Group',
  'Address Company', 'Address Line 1', 'Address Line 2', 'City/Suburb', 'State/Province', 'Zip/Postcode', 'Country',
  'Address Phone', 'Receive Marketing Emails', 'Tax Exempt Code'];
write('bigcommerce_customers.csv', BC_C, [
  { Email: 'lisa@example.com', 'First Name': 'Lisa', 'Last Name': 'Brown', Phone: '2025550143', Notes: 'Grossiste', 'Store Credit': '25.00', 'Customer Group': 'Wholesale', 'Address Line 1': '77 Market St', 'City/Suburb': 'Denver', 'State/Province': 'Colorado', 'Zip/Postcode': '80202', Country: 'US', 'Receive Marketing Emails': 'yes', 'Tax Exempt Code': 'RESALE' },
  { Email: 'tom@example.com', 'First Name': 'Tom', 'Last Name': 'García', 'Address Line 1': 'Calle Mayor 1', 'City/Suburb': 'Madrid', 'State/Province': 'Madrid', 'Zip/Postcode': '28013', Country: 'ES', 'Receive Marketing Emails': 'no' },
]);

// ── Shopify orders (one row per line item) ───────────────────────────────────
const SHOPIFY_O = ['Name', 'Email', 'Financial Status', 'Fulfillment Status', 'Currency', 'Subtotal', 'Shipping', 'Taxes', 'Total',
  'Discount Code', 'Discount Amount', 'Created at', 'Lineitem quantity', 'Lineitem name', 'Lineitem price', 'Lineitem sku',
  'Billing Name', 'Billing Company', 'Billing Address1', 'Billing Address2', 'Billing City', 'Billing Zip', 'Billing Province', 'Billing Country', 'Billing Phone',
  'Shipping Name', 'Shipping Company', 'Shipping Address1', 'Shipping Address2', 'Shipping City', 'Shipping Zip', 'Shipping Province', 'Shipping Country',
  'Payment Method', 'Notes'];
write('shopify_orders.csv', SHOPIFY_O, [
  { Name: '#1001', Email: 'camille.durand@example.com', 'Financial Status': 'paid', 'Fulfillment Status': 'fulfilled', Currency: 'EUR', Subtotal: '134.00', Shipping: '5.90', Taxes: '23.32', Total: '163.22', 'Created at': '2026-09-10T14:02:00Z', 'Lineitem quantity': '1', 'Lineitem name': 'Chemise en lin', 'Lineitem price': '89.00', 'Lineitem sku': 'CHM-LIN-38', 'Billing Name': 'Camille Durand', 'Billing Address1': '12 rue des Fleurs', 'Billing City': 'Lyon', 'Billing Zip': '69001', 'Billing Country': 'FR', 'Shipping Name': 'Camille Durand', 'Shipping Address1': '12 rue des Fleurs', 'Shipping City': 'Lyon', 'Shipping Zip': '69001', 'Shipping Country': 'FR', 'Payment Method': 'Carte', Notes: 'Livrer avant vendredi' },
  { Name: '#1001', 'Lineitem quantity': '1', 'Lineitem name': 'Ceinture cuir', 'Lineitem price': '45.00', 'Lineitem sku': 'CEINTURE-TAN' },
  { Name: '#1002', Email: 'john.smith@example.com', 'Financial Status': 'pending', 'Fulfillment Status': 'unfulfilled', Currency: 'EUR', Subtotal: '24.00', Shipping: '0.00', Taxes: '0.00', Total: '24.00', 'Created at': '2026-09-11T09:15:00Z', 'Lineitem quantity': '1', 'Lineitem name': 'Bougie', 'Lineitem price': '24.00', 'Lineitem sku': 'BOUGIE-FIGUE', 'Billing Name': 'John Smith', 'Billing City': 'Austin', 'Billing Province': 'TX', 'Billing Country': 'US', 'Payment Method': 'PayPal' },
]);

// ── WooCommerce orders (packed line-item lists, coupon, ambiguous date) ───────
const WOO_O = ['ORDERID', 'order_status', 'order_date', 'customer_note', 'order_currency', 'order_total', 'order_tax', 'order_shipping', 'cart_discount',
  'payment_method_title', 'transaction_id', 'customer_user',
  'billing_first_name', 'billing_last_name', 'billing_company', 'billing_email', 'billing_phone',
  'billing_address_1', 'billing_address_2', 'billing_city', 'billing_state', 'billing_postcode', 'billing_country',
  'shipping_first_name', 'shipping_last_name', 'shipping_address_1', 'shipping_city', 'shipping_state', 'shipping_postcode', 'shipping_country',
  'item_name', 'item_type', 'item_product_id', 'item_qty', 'item_line_total'];
write('woo_orders.csv', WOO_O, [
  // Two line items + one coupon in the packed lists (coupon filtered out, warned). Ambiguous date 03/04/2026.
  { ORDERID: '5001', order_status: 'wc-completed', order_date: '03/04/2026 10:30:00', customer_note: 'Cadeau', order_currency: 'EUR', order_total: '108.00', order_tax: '18.00', order_shipping: '6.00', cart_discount: '10.00', payment_method_title: 'Virement', transaction_id: 'TX-5001', billing_first_name: 'Marie', billing_last_name: 'Lefèvre', billing_email: 'marie@example.com', billing_phone: '0498765432', billing_address_1: '3 avenue du Parc', billing_city: 'Bruxelles', billing_postcode: '1000', billing_country: 'BE', shipping_first_name: 'Marie', shipping_last_name: 'Lefèvre', shipping_address_1: '3 avenue du Parc', shipping_city: 'Bruxelles', shipping_postcode: '1000', shipping_country: 'BE', item_name: 'T-shirt bio,Mug émaillé,PROMO10', item_type: 'line_item,line_item,coupon', item_product_id: '2001,2002', item_qty: '2,1', item_line_total: '38.00,14.50' },
  { ORDERID: '5002', order_status: 'wc-processing', order_date: '15/04/2026 16:05:00', order_currency: 'EUR', order_total: '25.00', order_tax: '0.00', order_shipping: '0.00', payment_method_title: 'Carte', billing_first_name: 'Dave', billing_last_name: 'Miller', billing_email: 'dave@example.com', billing_address_1: '100 Oak Ave', billing_city: 'Sacramento', billing_state: 'CA', billing_postcode: '95814', billing_country: 'US', item_name: 'Écharpe alpaga', item_type: 'line_item', item_product_id: '2005', item_qty: '1', item_line_total: '25.00' },
]);

// ── BigCommerce orders (SOURCE only; grouped by Order ID) ─────────────────────
const BC_O = ['Order ID', 'Order Status', 'Order Date', 'Customer Email', 'Order Currency Code',
  'Subtotal (inc tax)', 'Shipping Cost (inc tax)', 'Tax Total', 'Order Total (inc tax)',
  'Coupon Code', 'Coupon Value', 'Payment Method', 'Transaction ID', 'Customer Message',
  'Billing First Name', 'Billing Last Name', 'Billing Company', 'Billing Street 1', 'Billing Suburb', 'Billing State Abbreviation', 'Billing Zip', 'Billing Country', 'Billing Phone',
  'Shipping First Name', 'Shipping Last Name', 'Shipping Street 1', 'Shipping Suburb', 'Shipping State Abbreviation', 'Shipping Zip', 'Shipping Country',
  'Product Name', 'Product SKU', 'Product Qty', 'Product Unit Price'];
write('bigcommerce_orders.csv', BC_O, [
  { 'Order ID': '9001', 'Order Status': 'Shipped', 'Order Date': '2026-09-01', 'Customer Email': 'lisa@example.com', 'Order Currency Code': 'USD', 'Subtotal (inc tax)': '199.00', 'Shipping Cost (inc tax)': '12.00', 'Tax Total': '16.00', 'Order Total (inc tax)': '211.00', 'Payment Method': 'Credit Card', 'Transaction ID': 'BC-9001', 'Billing First Name': 'Lisa', 'Billing Last Name': 'Brown', 'Billing Street 1': '77 Market St', 'Billing Suburb': 'Denver', 'Billing State Abbreviation': 'CO', 'Billing Zip': '80202', 'Billing Country': 'United States', 'Shipping First Name': 'Lisa', 'Shipping Last Name': 'Brown', 'Shipping Street 1': '77 Market St', 'Shipping Suburb': 'Denver', 'Shipping State Abbreviation': 'CO', 'Shipping Zip': '80202', 'Shipping Country': 'United States', 'Product Name': 'Casque audio', 'Product SKU': 'CASQUE-NOIR', 'Product Qty': '1', 'Product Unit Price': '199.00' },
  { 'Order ID': '9002', 'Order Status': 'Awaiting Payment', 'Order Date': '2026-09-03', 'Customer Email': 'tom@example.com', 'Order Currency Code': 'EUR', 'Subtotal (inc tax)': '24.00', 'Shipping Cost (inc tax)': '0.00', 'Tax Total': '0.00', 'Order Total (inc tax)': '24.00', 'Payment Method': 'PayPal', 'Billing First Name': 'Tom', 'Billing Last Name': 'García', 'Billing Street 1': 'Calle Mayor 1', 'Billing Suburb': 'Madrid', 'Billing Zip': '28013', 'Billing Country': 'Spain', 'Product Name': 'Guide PDF', 'Product SKU': 'GUIDE-PDF', 'Product Qty': '1', 'Product Unit Price': '9.00' },
]);

console.log('fixtures written to', DIR);
