/**
 * domain-profiles.json on disk — the learned recipes and per-site route memory.
 * Losing it means re-learning every site, so:
 *   - every write is atomic (temp file + rename + read-back, app/admin/config-store
 *     writeJsonAtomic) and keeps the previous version (domain-profiles.previous.json);
 *   - a file that exists but is not valid JSON (a crash, a disk error) is NEVER
 *     overwritten: it is renamed domain-profiles.corrupt-<time>.json and the previous
 *     version is used instead (or an empty store when there is none);
 *   - a file that exists but cannot be read for another reason (locked by another
 *     program, permission) makes the store read-only for the run: nothing is
 *     written, so nothing can be replaced by a partial view.
 * `fsImpl` is injectable for tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../app/admin/config-store.mjs';

export const PROFILES_BACKUP = 'domain-profiles.previous.json';

/** { ok:true, data } | { missing:true } | { corrupt:true } | { unreadable:true, code } */
function readJson(file, f) {
  let text;
  try { text = f.readFileSync(file, 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? { missing: true } : { unreadable: true, code: String((e && e.code) || 'error') }; }
  try { const data = JSON.parse(String(text).replace(/^﻿/, '')); return data && typeof data === 'object' && !Array.isArray(data) ? { ok: true, data } : { corrupt: true }; } catch { return { corrupt: true }; }
}

/**
 * read/write pair for createProfileStore. `read()` returns the profiles object, or
 * `{ __readOnly: true, data }` when the file could not be read (the store then
 * never writes during this run).
 */
export function profileFileIo(file, { fsImpl = fs, warn = (m) => console.warn(m), now = () => Date.now() } = {}) {
  const dir = path.dirname(file);
  const backup = path.join(dir, PROFILES_BACKUP);
  return {
    read() {
      const main = readJson(file, fsImpl);
      if (main.ok) return main.data;
      const prev = readJson(backup, fsImpl);
      if (main.missing) return prev.ok ? prev.data : {};
      if (main.corrupt) {
        const aside = path.join(dir, `domain-profiles.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.json`);
        try { fsImpl.renameSync(file, aside); warn(`[profiles] domain-profiles.json illisible : mis de côté sous ${path.basename(aside)}`); }
        catch (e) { warn(`[profiles] domain-profiles.json illisible et impossible à mettre de côté (${(e && e.code) || 'erreur'}) : aucune écriture pendant ce job`); return { __readOnly: true, data: prev.ok ? prev.data : {} }; }
        return prev.ok ? prev.data : {};
      }
      warn(`[profiles] lecture de domain-profiles.json impossible (${main.code}) : aucune écriture pendant ce job`);
      return { __readOnly: true, data: prev.ok ? prev.data : {} };
    },
    write(m) {
      const r = writeJsonAtomic(file, m, { backup: true, backupName: PROFILES_BACKUP });
      if (!r.ok) warn(`[profiles] écriture de domain-profiles.json impossible (${r.code || r.error})`);
      return r.ok;
    },
    // A one-time copy of the file as it is now (before a schema migration), kept beside it.
    // Never overwrites an existing copy: the first one is the file before any migration.
    snapshot(name) {
      if (!/^domain-profiles\.[\w.-]+\.json$/.test(String(name || ''))) return false;
      const target = path.join(dir, name);
      try { if (fsImpl.existsSync(target) || !fsImpl.existsSync(file)) return false; fsImpl.copyFileSync(file, target); return true; }
      catch (e) { warn(`[profiles] copie avant migration impossible (${(e && e.code) || 'erreur'})`); return false; }
    },
  };
}
