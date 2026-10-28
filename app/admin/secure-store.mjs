/**
 * Secure credential store (MAIN process only). Secret VALUES are encrypted with
 * Electron `safeStorage` (OS keychain / DPAPI) and persisted as an opaque blob in
 * userData. Values NEVER appear in config.json, logs, IPC messages or reports; the
 * renderer only ever receives masked state from the registry.
 *
 * Injected io ({ safeStorage, readBlob, writeBlob, deleteBlob }) keeps it testable
 * without Electron. If encryption is unavailable, writes REFUSE (clear French
 * message) and the env-var-NAME fallback in the registry still works.
 *
 * NOTE: `getAll()` returns decrypted values and is for the credential RESOLVER in
 * the main process only — it is never sent over IPC.
 */
export class SecureStore {
  /** @param {{ safeStorage:{isEncryptionAvailable:()=>boolean, encryptString:(s:string)=>Buffer, decryptString:(b:Buffer)=>string}, readBlob:()=>(string|null), writeBlob:(b64:string)=>void, deleteBlob:()=>void, log?:Function }} io */
  constructor(io) {
    this.ss = io.safeStorage;
    this.readBlob = io.readBlob;
    this.writeBlob = io.writeBlob;
    this.deleteBlob = io.deleteBlob;
    this.log = io.log || (() => {}); // NEVER pass a secret to this
  }

  available() { try { return !!this.ss && this.ss.isEncryptionAvailable(); } catch { return false; } }

  _load() {
    if (!this.available()) return {};
    let b64; try { b64 = this.readBlob(); } catch { b64 = null; }
    if (!b64) return {};
    try { return JSON.parse(this.ss.decryptString(Buffer.from(b64, 'base64'))) || {}; }
    catch { this.log('secure-store: blob illisible (ignoré)'); return {}; }
  }

  _save(store) {
    const enc = this.ss.encryptString(JSON.stringify(store));
    this.writeBlob(Buffer.from(enc).toString('base64'));
  }

  /** Refusal object when encryption is off. */
  _refuse() { return { ok: false, reason: 'safe_storage_unavailable', message: 'Stockage sécurisé indisponible sur ce système : impossible d\'enregistrer une clé. Utilisez les variables d\'environnement en attendant.' }; }

  /** Set/replace fields for a provider (merge). `fields` = { key: value }. */
  setFields(providerId, fields) {
    if (!this.available()) return this._refuse();
    if (!providerId || !fields || typeof fields !== 'object') return { ok: false, reason: 'bad_input' };
    const store = this._load();
    store[providerId] = { ...(store[providerId] || {}) };
    for (const [k, v] of Object.entries(fields)) { if (v == null || v === '') delete store[providerId][k]; else store[providerId][k] = String(v); }
    if (Object.keys(store[providerId]).length === 0) delete store[providerId];
    this._save(store);
    return { ok: true }; // no value echoed
  }

  /** Delete one field, or the whole provider when `field` omitted. */
  deleteField(providerId, field) {
    if (!this.available()) return this._refuse();
    const store = this._load();
    if (!store[providerId]) return { ok: true };
    if (field) { delete store[providerId][field]; if (Object.keys(store[providerId]).length === 0) delete store[providerId]; }
    else delete store[providerId];
    this._save(store);
    return { ok: true };
  }

  /** True if the provider has any stored field. */
  has(providerId) { const s = this._load(); return !!(s[providerId] && Object.keys(s[providerId]).length); }

  /** MAIN-ONLY: decrypted map { providerId: { field: value } } for the resolver. */
  getAll() { return this._load(); }

  /** Import many at once: { providerId: { field: value } }. */
  importValues(map) {
    if (!this.available()) return this._refuse();
    if (!map || typeof map !== 'object') return { ok: false, reason: 'bad_input' };
    const store = this._load();
    let count = 0;
    for (const [pid, fields] of Object.entries(map)) {
      if (!fields || typeof fields !== 'object') continue;
      store[pid] = { ...(store[pid] || {}) };
      for (const [k, v] of Object.entries(fields)) { if (v != null && v !== '') { store[pid][k] = String(v); count++; } }
    }
    this._save(store);
    return { ok: true, count }; // count of fields, no values
  }

  /** Wipe everything (used by admin reset). */
  wipe() { try { this.deleteBlob(); } catch { /* */ } return { ok: true }; }

  /** Local availability check (no network, never billable). */
  test() { return this.available() ? { ok: true } : this._refuse(); }
}
