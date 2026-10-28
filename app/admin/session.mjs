/**
 * Admin session — owner-only lock, enforced in the MAIN process. The passphrase
 * is stored ONLY as a salted scrypt hash (node:crypto, no dependency), never in
 * plaintext, never logged, never in config.json. No backdoor: a forgotten
 * passphrase is handled by reset() which the caller pairs with wiping the secure
 * store.
 *
 * Storage is injected ({ readAdmin(): object|null, writeAdmin(obj): void }) so this
 * is unit-testable without the filesystem. The unlocked SESSION is in-memory only
 * (so the app is locked again on restart). Persisted: hash params, autoLockMs,
 * failCount, lockedUntil.
 */
import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
export const DEFAULT_AUTO_LOCK_MS = 15 * 60 * 1000;
const MAX_DELAY_MS = 5 * 60 * 1000;

/** Growing delay after `fails` consecutive failures. */
export function failDelayMs(fails) { return Math.min(MAX_DELAY_MS, Math.max(0, (2 ** Math.max(0, fails)) * 1000 - 1000)); }

function derive(passphrase, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  return crypto.scryptSync(String(passphrase), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex');
}

export class AdminSession {
  /** @param {{readAdmin:()=>(object|null), writeAdmin:(o:object)=>void}} store @param {{now?:()=>number}} io */
  constructor(store, io = {}) {
    this.store = store;
    this.now = io.now || Date.now;
    this._unlockedUntil = 0; // in-memory session expiry
    const rec = this._rec();
    if (rec.autoLockMs == null) { rec.autoLockMs = DEFAULT_AUTO_LOCK_MS; this._write(rec); }
  }

  _rec() { return this.store.readAdmin() || {}; }
  _write(rec) { this.store.writeAdmin(rec); return rec; }

  hasPassphrase() { const r = this._rec(); return !!(r.scrypt && r.scrypt.hashHex && r.scrypt.salt); }
  get autoLockMs() { return this._rec().autoLockMs || DEFAULT_AUTO_LOCK_MS; }
  setAutoLockMs(ms) { if (!this.isUnlocked()) return { ok: false, locked: true }; const r = this._rec(); r.autoLockMs = Math.max(60 * 1000, Math.min(8 * 60 * 60 * 1000, Number(ms) || DEFAULT_AUTO_LOCK_MS)); this._write(r); return { ok: true, autoLockMs: r.autoLockMs }; }

  /** First-run: create the passphrase (entered twice). */
  createPassphrase(passphrase, confirm) {
    if (this.hasPassphrase()) return { ok: false, error: 'Une phrase secrète existe déjà. Utilisez « Réinitialiser » pour la remplacer.' };
    if (!passphrase || String(passphrase).length < 8) return { ok: false, error: 'La phrase secrète doit contenir au moins 8 caractères.' };
    if (passphrase !== confirm) return { ok: false, error: 'Les deux phrases secrètes ne correspondent pas.' };
    const salt = crypto.randomBytes(32).toString('hex');
    const rec = this._rec();
    rec.scrypt = { salt, N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, hashHex: derive(passphrase, salt) };
    rec.failCount = 0; rec.lockedUntil = 0;
    if (rec.autoLockMs == null) rec.autoLockMs = DEFAULT_AUTO_LOCK_MS;
    this._write(rec);
    this._unlockedUntil = this.now() + rec.autoLockMs; // creating unlocks
    return { ok: true };
  }

  /** Unlock by passphrase; honours the growing lockout and resets failCount on success. */
  unlock(passphrase) {
    const rec = this._rec();
    if (!this.hasPassphrase()) return { ok: false, error: 'Aucune phrase secrète : créez-la d\'abord.' };
    const now = this.now();
    if (rec.lockedUntil && now < rec.lockedUntil) return { ok: false, error: `Trop de tentatives. Réessayez dans ${Math.ceil((rec.lockedUntil - now) / 1000)} s.`, waitMs: rec.lockedUntil - now };
    const candidate = derive(passphrase, rec.scrypt.salt);
    const ok = crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(rec.scrypt.hashHex, 'hex'));
    if (!ok) {
      rec.failCount = (rec.failCount || 0) + 1;
      rec.lockedUntil = now + failDelayMs(rec.failCount);
      this._write(rec);
      return { ok: false, error: 'Phrase secrète incorrecte.' };
    }
    rec.failCount = 0; rec.lockedUntil = 0; this._write(rec);
    this._unlockedUntil = now + this.autoLockMs;
    return { ok: true };
  }

  isUnlocked() { return this.now() < this._unlockedUntil; }
  /** Activity extends the session (called on each successful admin action). */
  touch() { if (this.isUnlocked()) this._unlockedUntil = this.now() + this.autoLockMs; }
  lock() { this._unlockedUntil = 0; }

  /**
   * Reset: forget the passphrase. The caller MUST also wipe the secure store
   * (keys re-imported afterwards). Returns { ok, wipeStore:true }.
   */
  reset() {
    this._write({ autoLockMs: this._rec().autoLockMs || DEFAULT_AUTO_LOCK_MS });
    this.lock();
    return { ok: true, wipeStore: true };
  }

  /** Public status for the renderer (no secrets). */
  status() {
    const rec = this._rec();
    const now = this.now();
    return {
      hasPassphrase: this.hasPassphrase(),
      unlocked: this.isUnlocked(),
      autoLockMs: this.autoLockMs,
      lockedForMs: rec.lockedUntil && now < rec.lockedUntil ? rec.lockedUntil - now : 0,
    };
  }
}
