/**
 * Single source of truth for WHICH files make up the runtime extension package.
 * Used by package:extension (to build the zip) and verify:extension (to assert
 * the zip's file set equals the unpacked runtime file set — step 6 parity).
 */
import fs from 'node:fs';
import path from 'node:path';

/** Runtime directories that ship. Tests/docs/keys/scripts are excluded by omission. */
export const INCLUDE_DIRS = ['background', 'content', 'offscreen', 'ui', 'icons', '_locales', 'vendor'];
/** Names never packaged even inside an included dir. */
export const EXCLUDE = new Set(['.keys', '__tests__', 'extension-id.txt']);

/**
 * Collect runtime entries as [{name, data:Buffer}] with manifest.json first (dev
 * `key` stripped when stripKey). Names use forward slashes, manifest at root.
 * @param {string} extDir the extension folder
 * @param {{stripKey?:boolean}} [opts]
 */
export function collectRuntimeEntries(extDir, { stripKey = true } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  if (stripKey) delete manifest.key;
  const entries = [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'), manifest }];
  for (const d of INCLUDE_DIRS) {
    const abs = path.join(extDir, d);
    if (fs.existsSync(abs)) walk(abs, d, entries);
  }
  return entries;
}

function walk(absDir, relDir, out) {
  for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (EXCLUDE.has(ent.name)) continue;
    const abs = path.join(absDir, ent.name);
    const rel = `${relDir}/${ent.name}`;
    if (ent.isDirectory()) walk(abs, rel, out);
    else out.push({ name: rel, data: fs.readFileSync(abs) });
  }
}

/** Just the runtime file names (sorted) — for the folder↔zip parity check. */
export function runtimeFileNames(extDir) {
  return collectRuntimeEntries(extDir).map((e) => e.name).sort();
}
