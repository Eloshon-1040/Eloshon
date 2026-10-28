// Text the main process shows itself (native dialog titles, file filter names, proposed file names, names
// it gives a template), in the four interface languages. Same keys in each (test/i18n-parity.test.mjs).
// The renderer's strings live in renderer/i18n.js; this file only holds what never crosses the bridge.

export const LANGS = ['fr', 'en', 'nl', 'es'];
export const uiLang = (v) => (LANGS.includes(v) ? v : 'fr');

export const MAIN_STRINGS = {
  fr: {
    open_title: 'Choisir un fichier', filter_catalog: 'CSV, JSON ou Eloshon', filter_all: 'Tous les fichiers',
    dir_title: 'Dossier de destination', tpl_export_title: 'Exporter le modèle', tpl_import_title: 'Importer un modèle',
    tpl_file_name: 'modele', tpl_copy: '{name} (copie)', tpl_imported: 'Modèle importé',
  },
  en: {
    open_title: 'Choose a file', filter_catalog: 'CSV, JSON or Eloshon', filter_all: 'All files',
    dir_title: 'Destination folder', tpl_export_title: 'Export the template', tpl_import_title: 'Import a template',
    tpl_file_name: 'template', tpl_copy: '{name} (copy)', tpl_imported: 'Imported template',
  },
  nl: {
    open_title: 'Kies een bestand', filter_catalog: 'CSV, JSON of Eloshon', filter_all: 'Alle bestanden',
    dir_title: 'Doelmap', tpl_export_title: 'Sjabloon exporteren', tpl_import_title: 'Sjabloon importeren',
    tpl_file_name: 'sjabloon', tpl_copy: '{name} (kopie)', tpl_imported: 'Geïmporteerd sjabloon',
  },
  es: {
    open_title: 'Elija un archivo', filter_catalog: 'CSV, JSON o Eloshon', filter_all: 'Todos los archivos',
    dir_title: 'Carpeta de destino', tpl_export_title: 'Exportar la plantilla', tpl_import_title: 'Importar una plantilla',
    tpl_file_name: 'plantilla', tpl_copy: '{name} (copia)', tpl_imported: 'Plantilla importada',
  },
};

/** The main-process text for `key` in `lang` (unknown language → French), with {params} filled in. */
export function mainText(lang, key, params) {
  const s = MAIN_STRINGS[uiLang(lang)][key] ?? MAIN_STRINGS.fr[key] ?? key;
  return params ? s.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : '')) : s;
}
