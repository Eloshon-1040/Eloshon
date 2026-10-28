/**
 * The export manifest an Eloshon export carries (contract: C:\eloshon-scraper\docs\EXPORT-MANIFEST.md, built by
 * shared/export/manifest.mjs in the Scraper): what the file really holds — a preview of the extension's list,
 * a complete or a partial result — the product pages read, blocked or never opened, the fill rate of each
 * column, and each column's role. The Converter reads it beside the file (`<name>.manifest.json`, or
 * `manifest.json` beside a job's products.json) or in an .eloshon header (`eloshon.manifest`), shows it at
 * import, and recognises the file by its column roles when the column names were changed.
 */

export const MANIFEST_KIND = 'eloshon.export-manifest';
const STATUSES = new Set(['preview', 'complete', 'partial']);

/** A manifest this Converter can read (a newer contract is read as far as it goes). */
export function readManifest(value) {
  let m = value;
  if (typeof m === 'string') { try { m = JSON.parse(m.replace(/^\uFEFF/, '')); } catch { return null; } }
  if (!m || typeof m !== 'object' || m.kind !== MANIFEST_KIND || !Number.isInteger(m.contract) || !STATUSES.has(m.status)) return null;
  const p = m.productPages && typeof m.productPages === 'object' ? m.productPages : {};
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);
  return {
    contract: m.contract, status: m.status, source: m.source === 'extension' ? 'extension' : 'app',
    site: typeof m.site === 'string' ? m.site.slice(0, 120) : '', jobId: typeof m.jobId === 'string' ? m.jobId.slice(0, 64) : null,
    rows: n(m.rows),
    productPages: { toRead: n(p.toRead), read: n(p.read), blocked: n(p.blocked), notOpened: n(p.notOpened), humanCheck: n(p.byReason && p.byReason.human_check), limit: p.limit && n(p.limit.max) ? n(p.limit.max) : null },
    rulesFailing: Array.isArray(m.rulesFailing) ? m.rulesFailing.filter((r) => r && r.field).map((r) => String(r.field)).slice(0, 20) : [],
    truncated: m.truncated && n(m.truncated.rows) ? n(m.truncated.rows) : 0,
    fill: m.fill && typeof m.fill === 'object' ? Object.fromEntries(Object.entries(m.fill).filter(([, f]) => f && typeof f === 'object').slice(0, 80).map(([k, f]) => [k, { label: String(f.label || k).slice(0, 80), filled: n(f.filled), total: n(f.total) }])) : {},
    columns: Array.isArray(m.columns) ? m.columns.filter((c) => c && typeof c.label === 'string').slice(0, 80).map((c) => ({ key: String(c.key || ''), label: c.label.slice(0, 80), role: typeof c.role === 'string' ? c.role : null, axis: typeof c.axis === 'string' && c.axis.trim() ? c.axis.trim().slice(0, 30) : null })) : [],
  };
}

const T = {
  fr: { preview: 'Aperçu de l’extension', complete: 'Export complet', partial: 'Export partiel', app: 'de l’application', ext: 'de l’extension',
    read: (r, t) => `${r} fiche${r > 1 ? 's' : ''} lue${r > 1 ? 's' : ''} sur ${t}`, none: 'aucune fiche produit à lire',
    human: (n) => `${n} bloquée${n > 1 ? 's' : ''} par une vérification humaine`, notOpened: (n) => `${n} non ouverte${n > 1 ? 's' : ''}`, blocked: (n) => `${n} en échec`,
    rules: (f) => `règles du site en échec : ${f}`, cut: (n) => `${n} ligne${n > 1 ? 's' : ''} manquante${n > 1 ? 's' : ''}`,
    opened: (o, t) => `${o} fiche${o > 1 ? 's' : ''} produit ouverte${o > 1 ? 's' : ''} sur ${t} à lire`, readN: (n) => `${n} lue${n > 1 ? 's' : ''}`, sep: ' ; ',
    waiting: (n) => (n > 1 ? `les ${n} autres ne sont pas encore lues : l’aperçu n’en ouvre que quelques-unes` : 'l’autre n’est pas encore lue : l’aperçu n’en ouvre que quelques-unes') },
  en: { preview: 'Extension preview', complete: 'Complete export', partial: 'Partial export', app: 'from the app', ext: 'from the extension',
    read: (r, t) => `${r} product page${t > 1 ? 's' : ''} read out of ${t}`, none: 'no product page to read',
    human: (n) => `${n} blocked by a human check`, notOpened: (n) => `${n} not opened`, blocked: (n) => `${n} failed`,
    rules: (f) => `site rules failing: ${f}`, cut: (n) => `${n} row${n > 1 ? 's' : ''} missing`,
    opened: (o, t) => `${o} product page${o > 1 ? 's' : ''} opened out of ${t} to read`, readN: (n) => `${n} read`, sep: '; ',
    waiting: (n) => (n > 1 ? `the other ${n} are not read yet: the preview opens only a few` : 'the other one is not read yet: the preview opens only a few') },
  nl: { preview: 'Voorbeeld van de extensie', complete: 'Volledige export', partial: 'Gedeeltelijke export', app: 'van de app', ext: 'van de extensie',
    read: (r, t) => `${r} van ${t} productpagina’s gelezen`, none: 'geen productpagina te lezen',
    human: (n) => `${n} geblokkeerd door een menselijke controle`, notOpened: (n) => `${n} niet geopend`, blocked: (n) => `${n} mislukt`,
    rules: (f) => `siteregels mislukt: ${f}`, cut: (n) => `${n} rij(en) ontbreken`,
    opened: (o, t) => `${o} van ${t} te lezen productpagina’s geopend`, readN: (n) => `${n} gelezen`, sep: '; ',
    waiting: (n) => (n > 1 ? `de andere ${n} zijn nog niet gelezen: het voorbeeld opent er maar een paar` : 'de andere is nog niet gelezen: het voorbeeld opent er maar een paar') },
  es: { preview: 'Vista previa de la extensión', complete: 'Exportación completa', partial: 'Exportación parcial', app: 'de la aplicación', ext: 'de la extensión',
    read: (r, t) => `${r} de ${t} fichas de producto leídas`, none: 'ninguna ficha de producto que leer',
    human: (n) => `${n} bloqueada(s) por una verificación humana`, notOpened: (n) => `${n} sin abrir`, blocked: (n) => `${n} con error`,
    rules: (f) => `reglas del sitio con error: ${f}`, cut: (n) => `faltan ${n} fila(s)`,
    opened: (o, t) => `${o} ficha${o > 1 ? 's' : ''} de producto abierta${o > 1 ? 's' : ''} de ${t} por leer`, readN: (n) => `${n} leída${n > 1 ? 's' : ''}`, sep: '; ',
    waiting: (n) => (n > 1 ? `las otras ${n} aún no se han leído: la vista previa solo abre algunas` : 'la otra aún no se ha leído: la vista previa solo abre algunas') },
};

/**
 * One line a person reads at import: « Export partiel de l’extension : 30 fiches lues sur 32 (2 en échec) ». A preview
 * says what the extension opened for it and that the others WAIT for « Accepter » (they are not lost): « Aperçu de
 * l’extension : 3 fiches produit ouvertes sur 864 à lire (2 lues, 1 bloquée par une vérification humaine) ; les 861
 * autres ne sont pas encore lues : l’aperçu n’en ouvre que quelques-unes ».
 * @returns {{ status:string, text:string, warn:boolean }}
 */
export function manifestSummary(m, lang = 'fr') {
  const t = T[lang] || T.fr;
  if (!m) return null;
  const p = m.productPages;
  if (m.status === 'preview' && p.toRead) {
    const opened = p.read + p.blocked;
    const how = opened ? [t.readN(p.read)] : [];
    if (p.humanCheck) how.push(t.human(p.humanCheck));
    if (p.blocked - p.humanCheck > 0) how.push(t.blocked(p.blocked - p.humanCheck));
    if (m.rulesFailing.length) how.push(t.rules(m.rulesFailing.join(', ')));
    if (m.truncated) how.push(t.cut(m.truncated));
    const text = `${t.preview}${lang === 'fr' ? ' : ' : ': '}${t.opened(opened, p.toRead)}${how.length ? ` (${how.join(', ')})` : ''}${p.notOpened ? `${t.sep}${t.waiting(p.notOpened)}` : ''}`;
    return { status: m.status, text, warn: true };
  }
  const head = m.status === 'preview' ? t.preview : `${m.status === 'complete' ? t.complete : t.partial} ${m.source === 'extension' ? t.ext : t.app}`;
  const parts = [];
  if (p.humanCheck) parts.push(t.human(p.humanCheck));
  if (p.blocked - p.humanCheck > 0) parts.push(t.blocked(p.blocked - p.humanCheck));
  if (p.notOpened) parts.push(t.notOpened(p.notOpened));
  if (m.rulesFailing.length) parts.push(t.rules(m.rulesFailing.join(', ')));
  if (m.truncated) parts.push(t.cut(m.truncated));
  const main = p.toRead ? t.read(p.read, p.toRead) : t.none;
  return { status: m.status, text: `${head} : ${main}${parts.length ? ` (${parts.join(', ')})` : ''}`.replace(' : ', lang === 'fr' ? ' : ' : ': '), warn: m.status !== 'complete' };
}

const AXIS_ROLES = new Set(['variant_name', 'option', 'size', 'color']);
const AVAILABILITY_RULES = [{ pattern: 'out ?of ?stock|sold ?out|discontinued|rupture|épuisé|epuise|indisponible|ausverkauft|uitverkocht', flags: 'i', value: 0 }];

/**
 * A format built from the manifest's column roles, for a file whose column names the user changed (the
 * Reference entry of the panel CSV no longer matches). Only columns present in the file are used; a file
 * without a title column gets no format (the usual recognition takes over).
 * @param {object} m  readManifest() output   @param {string[]} headers
 */
export function formatFromManifest(m, headers) {
  if (!m || !m.columns.length) return null;
  const has = new Set((headers || []).map((h) => String(h)));
  const cols = m.columns.filter((c) => c.role && has.has(c.label));
  const by = (role) => cols.filter((c) => c.role === role).map((c) => c.label);
  const title = by('title')[0];
  if (!title) return null;
  const price = by('price')[0] || null;
  const list = by('list_price')[0] || null;
  const variantsCol = by('variants')[0] || null;
  const fields = [{ path: title, canon: 'title', transform: 'text' }];
  const add = (f) => fields.push({ confidence: 'manifest', ...f });
  if (price) add({ path: price, canon: 'variants[].price', transform: 'money', when: 'self' });
  if (list) {
    add({ path: list, inputs: [list, price || list], canon: 'variants[].compareAtPrice', transform: 'money_if_above', when: 'self' });
    add({ path: list, canon: 'sourceExtension.eloshon.list_price', transform: 'copy_present' });
  }
  for (const c of by('brand')) add({ path: c, canon: 'vendor', transform: 'text' });
  for (const c of by('category')) add({ path: c, canon: 'categories', transform: 'category_path_split', args: { sep: '>', listSep: '\n' } });
  for (const c of by('image')) add({ path: c, canon: 'images', transform: 'images_from_urls' });
  for (const c of by('url')) add({ path: c, canon: 'sourceExtension.eloshon.source_url', transform: 'copy_present' });
  for (const c of by('sku')) { add({ path: c, canon: 'identity.sourceId', transform: 'string_id' }); add({ path: c, canon: 'variants[].sku', transform: 'text', when: 'self' }); }
  for (const c of by('ean')) add({ path: c, canon: 'variants[].barcode', transform: 'text', when: 'self' });
  for (const c of by('description')) add({ path: c, canon: 'bodyHtml', transform: 'html' });
  for (const c of by('technical_specs')) add({ path: c, canon: 'descriptionSections[]', transform: 'description_section', args: { label: c, pairSep: ' ; ', kv: ' : ' } });
  for (const c of by('availability')) { add({ path: c, canon: 'variants[].inventoryQty', transform: 'regex_map', args: { rules: AVAILABILITY_RULES }, when: 'self' }); add({ path: c, canon: 'sourceExtension.eloshon.availability', transform: 'copy_present' }); }
  for (const c of by('attribute')) add({ path: c, canon: 'attributesRich[]', transform: 'attribute_single', args: { name: c, visible: true } });
  // The panel's fixed values (« Valeurs fixes »): product type, tags, status at import.
  for (const c of by('product_type')) add({ path: c, canon: 'productType', transform: 'text' });
  for (const c of by('tags')) add({ path: c, canon: 'tags', transform: 'list', args: { sep: ',' } });
  for (const c of by('status')) add({ path: c, canon: 'status', transform: 'enum_map', args: { map: { draft: 'draft', active: 'active' }, default: 'active' } });
  const axisCols = cols.filter((c) => AXIS_ROLES.has(c.role));
  const axes = axisCols.map((c) => c.label);
  // The option name: the one the page writes next to its picker (« Taille »), else the column's own name.
  const axisName = (label) => { const c = axisCols.find((x) => x.label === label); return (c && c.axis) || label; };
  let structure = { unit: 'product', variants: { selfWhenNone: true } };
  if (variantsCol) {
    // The « Variantes » cell: values with their own price (and « épuisé »).
    structure = { unit: 'product', variants: { inlinePath: variantsCol, parseText: { itemSep: '|', kvSep: ':' }, selfWhenNone: true }, options: { fromVariants: { name: 'type', value: 'name' } } };
    add({ path: variantsCol, canon: null, transform: 'ignore' });
    add({ path: 'type', canon: 'variants[].optionValues', transform: 'option_values_from_typed', args: { name: 'type', value: 'name' }, when: 'child' });
    add({ path: 'name', canon: null, transform: 'ignore', when: 'child' });
    add({ path: 'price', canon: 'variants[].price', transform: 'inherit_from_parent', args: { parentPath: price || 'price', as: 'money' }, when: 'child' });
    add({ path: 'availability', canon: 'variants[].inventoryQty', transform: 'regex_map', args: { rules: AVAILABILITY_RULES }, when: 'child' });
    for (const c of axes) add({ path: c, canon: 'attributesRich[]', transform: 'attribute_single', args: { name: c, visible: true } });
  } else if (axes.length) {
    // Columns that each list the values of one axis (« Taille » = "28 | 29 | 30"): every combination is a variant.
    structure = { unit: 'product', variants: { axes: axes.map((a) => ({ path: a, name: axisName(a) })), selfWhenNone: true }, options: { fromVariants: { columns: axes.map(axisName) } } };
    for (const c of axes) add({ path: c, canon: null, transform: 'ignore' });
    add({ path: '__kid', canon: 'variants[].optionValues', transform: 'option_values_by_name', when: 'child' });
    if (price) add({ path: '__price', canon: 'variants[].price', transform: 'inherit_from_parent', args: { parentPath: price, as: 'money' }, when: 'child' });
  }
  const required = [title, ...(price ? [price] : [])];
  return {
    schemaVersion: 1, id: `manifest.${m.source}.v1`, displayName: m.source === 'extension' ? 'Eloshon Scraper, export de l’extension (colonnes du manifeste)' : 'Eloshon Scraper, export de l’application (colonnes du manifeste)',
    provenance: 'scraper-generated', medium: 'csv', platformHint: 'eloshon', entity: 'products',
    signatures: [{ kind: 'csv-header-set', required, hints: cols.map((c) => c.label).filter((l) => !required.includes(l)), separator: ',' }],
    structure, routing: { platform: 'eloshon', entity: 'products' }, fields,
    history: [{ at: new Date(0).toISOString(), op: 'seed', origin: 'manifest', from: 'export manifest columns', diff: [] }],
  };
}
