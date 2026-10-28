/**
 * Guard against Chrome/Edge "reserved name" load failures. Chrome refuses to load
 * an unpacked extension containing any file or directory whose name starts with
 * "_" (reserved for the system) — the ONLY exception is `_locales`. This scans the
 * extension folder and reports every offending path so the failure can never come
 * back silently. Shared by ext:build and verify:extension (single source).
 */
import fs from 'node:fs';
import path from 'node:path';

const ALLOWED = new Set(['_locales']);

/**
 * Return repo-relative (to `dir`) paths whose final segment is a Chrome-reserved
 * name (starts with "_", except `_locales`). Recurses the whole tree.
 * @param {string} dir extension folder
 * @returns {string[]}
 */
export function findReservedNames(dir) {
  const bad = [];
  (function walk(abs, rel) {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.startsWith('_') && !ALLOWED.has(e.name)) bad.push(childRel);
      if (e.isDirectory()) walk(path.join(abs, e.name), childRel);
    }
  })(dir, '');
  return bad;
}

/**
 * Throw a clear FRENCH error listing every offending path when a reserved name is
 * present. No-op when the folder is clean.
 * @param {string} dir
 */
export function assertNoReservedNames(dir) {
  const bad = findReservedNames(dir);
  if (bad.length) {
    throw new Error(
      'Noms réservés par Chrome (préfixe « _ ») dans le dossier de l\'extension — Chrome/Edge refuseront de la charger. '
      + 'Seul « _locales » est autorisé.\nChemins à corriger :\n  - ' + bad.join('\n  - '),
    );
  }
}
