/**
 * .eloshon file format I/O — a versioned JSON envelope.
 *
 *   { eloshon:{kind,version,generator,createdAt}, source:{…}, catalog:{products…},
 *     edits:{revision,commands}, meta?:{…} }
 *
 * Rules:
 *  • SOURCE is frozen; user modifications live in `edits` (a command log).
 *  • ADDITIVE changes never bump `version` — extra/unknown fields are preserved
 *    on round-trip, so a file written by a newer app is not lossy when read by
 *    an older one. `version` bumps ONLY for breaking changes (require a migration).
 *  • Migrations run ascending (v → v+1) until the current version.
 */

export const ELOSHON_KIND = 'catalog';
export const ELOSHON_VERSION = 1;

const clone = (x) => (typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x)));

/** Build a fresh .eloshon file from a catalog. */
export function newEloshon({ products, categories, customers, orders, source = {}, generator = 'eloshon', meta } = {}) {
  const catalog = { products: Array.isArray(products) ? products : [] };
  if (categories) catalog.categories = categories;
  if (customers) catalog.customers = customers;
  if (orders) catalog.orders = orders;
  const file = {
    eloshon: { kind: ELOSHON_KIND, version: ELOSHON_VERSION, generator, createdAt: new Date().toISOString() },
    source: { type: source.type || 'manual', ...source },
    catalog,
    edits: { revision: 0, commands: [] },
  };
  if (meta) file.meta = meta;
  return file;
}

export function stringifyEloshon(file) { return JSON.stringify(file, null, 2); }

// fromVersion → upgrade function. Each returns a file at fromVersion+1, keeping
// unknown fields. (v0 = hypothetical pre-release envelope.)
const MIGRATIONS = {
  0: (f) => ({
    ...f,
    eloshon: { ...(f.eloshon || {}), kind: ELOSHON_KIND, version: 1 },
    source: f.source || { type: 'import' },
    catalog: f.catalog || { products: [] },
    edits: f.edits || { revision: 0, commands: [] },
  }),
};

/**
 * Parse + validate + migrate an .eloshon file, preserving unknown fields.
 * @param {string|object} input  JSON text or an already-parsed object
 * @returns {{ file: object, migratedFrom: number|null }}
 */
export function readEloshon(input) {
  let obj;
  if (typeof input === 'string') obj = JSON.parse(input);
  else if (input && typeof input === 'object') obj = clone(input);
  else throw new Error('readEloshon: expected a JSON string or object');

  if (!obj.eloshon || obj.eloshon.kind !== ELOSHON_KIND) throw new Error('readEloshon: not an .eloshon catalog file');
  let v = Number(obj.eloshon.version);
  if (!Number.isFinite(v)) throw new Error('readEloshon: missing/invalid version');

  const migratedFrom = v < ELOSHON_VERSION ? v : null;
  while (v < ELOSHON_VERSION) {
    const m = MIGRATIONS[v];
    if (!m) throw new Error(`readEloshon: no migration path from version ${v}`);
    obj = m(obj);
    const nv = Number(obj.eloshon.version);
    if (!(nv > v)) throw new Error(`readEloshon: migration from ${v} did not advance the version`);
    v = nv;
  }
  if (v > ELOSHON_VERSION) throw new Error(`readEloshon: file version ${v} is newer than supported ${ELOSHON_VERSION} (upgrade the app)`);

  // Ensure required containers WITHOUT dropping any unknown fields.
  if (!obj.source || typeof obj.source !== 'object') obj.source = { type: 'import' };
  if (!obj.catalog || typeof obj.catalog !== 'object') obj.catalog = { products: [] };
  if (!Array.isArray(obj.catalog.products)) obj.catalog.products = [];
  if (!obj.edits || typeof obj.edits !== 'object') obj.edits = { revision: 0, commands: [] };
  if (!Array.isArray(obj.edits.commands)) obj.edits.commands = [];
  return { file: obj, migratedFrom };
}
