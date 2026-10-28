/**
 * Atomic config.json updates (MAIN process). Used by the admin page for the
 * per-domain opt-in lists and the cost settings, and by every other config write
 * so two writers never leave a half-written file.
 *
 *   1. read + parse the current file (a corrupt file is NEVER overwritten);
 *   2. apply the change to a copy, validate it;
 *   3. optional backup: copy the current file to config.previous.json;
 *   4. write a temp file next to it, then rename over config.json (atomic);
 *   5. re-read and compare; on any mismatch restore the backup (rollback).
 */
import fs from 'node:fs';
import path from 'node:path';

export const BACKUP_NAME = 'config.previous.json';

/** Write `obj` to `file` atomically. Returns {ok, backupPath?, error?}.
 *  `backupName`: the previous version's file name, next to `file`. */
export function writeJsonAtomic(file, obj, { backup = false, backupName = BACKUP_NAME } = {}) {
  const text = JSON.stringify(obj, null, 2);
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const bak = path.join(dir, backupName);
  let backedUp = false;
  try {
    JSON.parse(text); // never write something we could not read back
    fs.mkdirSync(dir, { recursive: true });
    if (backup && fs.existsSync(file)) { fs.copyFileSync(file, bak); backedUp = true; }
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: 'write_failed', code: String((e && e.code) || 'error') };
  }
  // Verify what landed on disk; roll back to the backup if it differs.
  let back = null;
  try { back = fs.readFileSync(file, 'utf8'); } catch { back = null; }
  if (back !== text) {
    if (backedUp) { try { fs.copyFileSync(bak, file); } catch { /* best effort */ } }
    return { ok: false, error: 'verify_failed', rolledBack: backedUp };
  }
  return { ok: true, ...(backedUp ? { backupPath: bak } : {}) };
}

/**
 * Read-modify-write config.json. `mutate(copy)` returns the next object;
 * `validate(next)` returns {ok, error?}. A missing file counts as {}; a file
 * that exists but cannot be parsed is left untouched.
 */
export function updateConfig(file, mutate, { backup = false, validate = () => ({ ok: true }) } = {}) {
  let cur = {};
  if (fs.existsSync(file)) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, error: 'config_unreadable' }; }
    try { cur = raw.trim() ? JSON.parse(raw) : {}; } catch { return { ok: false, error: 'config_corrupt' }; }
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return { ok: false, error: 'config_not_object' };
  }
  let next;
  try { next = mutate(JSON.parse(JSON.stringify(cur))); } catch (e) { return { ok: false, error: String((e && e.message) || 'mutate_failed') }; }
  const v = validate(next);
  if (!v || !v.ok) return { ok: false, error: (v && v.error) || 'invalid' };
  const w = writeJsonAtomic(file, next, { backup });
  return w.ok ? { ok: true, config: next, ...(w.backupPath ? { backupPath: w.backupPath } : {}) } : w;
}
