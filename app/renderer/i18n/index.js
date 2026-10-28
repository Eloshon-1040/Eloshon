/* i18n — renderer only. The core/engine never imports this. Add a language by
 * creating a new dict file and registering it in LANGS below. Keys are stable
 * and organised by screen/feature. Only UI strings are translated — never
 * product names, source names, URLs or extracted data. */
import fr from './fr.js';
import en from './en.js';
import es from './es.js';
import nl from './nl.js';
import de from './de.js';

export const LANGS = { fr, en, es, nl, de };
export const LANG_LABELS = { fr: 'Français', en: 'English', es: 'Español', nl: 'Nederlands', de: 'Deutsch' };
export const DEFAULT_LANG = 'fr';

let current = DEFAULT_LANG;
export function setLang(l) { if (LANGS[l]) current = l; return current; }
export function getLang() { return current; }
export function availableLangs() { return Object.keys(LANGS); }

function lookup(dict, key) { return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), dict); }

/** Translate a dotted key with {var} interpolation. Falls back to fr, then the key. */
export function t(key, vars) {
  let s = lookup(LANGS[current], key);
  if (s == null) s = lookup(LANGS[DEFAULT_LANG], key);
  if (s == null) return key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = String(s).replace(new RegExp('\\{' + k + '\\}', 'g'), v);
  return s;
}

/** Translate a machine code via a namespace, falling back to a provided default. */
export function tc(ns, code, fallback) {
  const s = lookup(LANGS[current], ns + '.' + code) ?? lookup(LANGS[DEFAULT_LANG], ns + '.' + code);
  return s != null ? s : (fallback != null ? fallback : code);
}
