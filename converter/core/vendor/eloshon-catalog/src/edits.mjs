/**
 * Edit command log — user modifications as replayable DATA over an IMMUTABLE
 * source. The working model is always `source` with the applied commands
 * replayed on top, so undo/redo is just "replay the list without the last one".
 * Commands carry no functions (they are serialised inside .eloshon). AI edits,
 * later, are simply more command kinds.
 *
 * Non-destructive guarantee: the source array passed in is never mutated; a deep
 * copy is the baseline and each rebuild clones it again.
 */

const clone = (x) => (typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x)));
const uid = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

// kind → apply(model, cmd). Each mutates the (already-cloned) working model.
const HANDLERS = {
  'set-field'(model, cmd) {
    const p = model.find((x) => x.id === cmd.productId);
    if (!p) throw new Error(`set-field: unknown productId ${cmd.productId}`);
    p[cmd.field] = clone(cmd.value);
  },
  'bulk-set-field'(model, cmd) {
    const ids = new Set(cmd.productIds || []);
    for (const p of model) if (ids.has(p.id)) p[cmd.field] = clone(cmd.value);
  },
  remove(model, cmd) {
    const i = model.findIndex((x) => x.id === cmd.productId);
    if (i >= 0) model.splice(i, 1);
  },
};

export class CommandLog {
  /**
   * @param {object[]} source  immutable baseline products (each with a stable `id`)
   * @param {{revision?:number, commands?:object[]}|null} [edits]
   */
  constructor(source, edits = null) {
    this._source = clone(Array.isArray(source) ? source : []);
    this._applied = Array.isArray(edits?.commands) ? clone(edits.commands) : [];
    this._redo = [];
    this._model = null; // lazy
  }

  static fromFile(file) {
    return new CommandLog(file?.catalog?.products || [], file?.edits || null);
  }

  _rebuild() {
    const model = clone(this._source);
    for (const cmd of this._applied) {
      const h = HANDLERS[cmd.kind];
      if (h) h(model, cmd);
    }
    this._model = model;
  }

  get products() { if (!this._model) this._rebuild(); return this._model; }
  get count() { return this._applied.length; }          // modification counter
  get revision() { return this._applied.length; }
  get canUndo() { return this._applied.length > 0; }
  get canRedo() { return this._redo.length > 0; }

  /** Apply a command (validated by replaying), clearing the redo stack. */
  apply(command) {
    if (!command || !HANDLERS[command.kind]) throw new Error(`apply: unsupported command kind ${command && command.kind}`);
    const cmd = { id: uid(), at: new Date().toISOString(), ...command };
    const next = [...this._applied, cmd];
    // Validate by rebuilding on a trial model; throws propagate before committing.
    const model = clone(this._source);
    for (const c of next) { const h = HANDLERS[c.kind]; if (h) h(model, c); }
    this._applied = next;
    this._model = model;
    this._redo = [];
    return cmd;
  }

  setField(productId, field, value, label) { return this.apply({ kind: 'set-field', productId, field, value, label }); }
  bulkSetField(productIds, field, value, label) { return this.apply({ kind: 'bulk-set-field', productIds, field, value, label }); }
  remove(productId, label) { return this.apply({ kind: 'remove', productId, label }); }

  undo() {
    if (!this._applied.length) return null;
    const cmd = this._applied.pop();
    this._redo.push(cmd);
    this._rebuild();
    return cmd;
  }

  redo() {
    if (!this._redo.length) return null;
    const cmd = this._redo.pop();
    this._applied.push(cmd);
    this._rebuild();
    return cmd;
  }

  toJSON() { return { revision: this.revision, commands: clone(this._applied) }; }

  /** Return `file` with the source kept FROZEN and this log persisted in `edits`. */
  writeInto(file) {
    const out = clone(file);
    out.edits = this.toJSON();
    return out;
  }
}
