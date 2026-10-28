/**
 * DSL validator — validates a recipe's `actions` program BEFORE execution and
 * returns clear FRENCH messages for the end user (Requirement C). Generated from
 * the op catalogue in schema.mjs, so the catalogue is the single source of truth.
 *
 * PORTABLE: zero Node built-ins, zero dependencies.
 *
 * Returns { ok, errors:[{path, message}], version }. Never throws on bad input.
 */
import { OPS, OP_NAMES, DSL_VERSION } from './schema.mjs';

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const typeOk = (v, spec) => {
  switch (spec.type) {
    case 'string': return typeof v === 'string';
    case 'integer': return isInt(v);
    case 'boolean': return typeof v === 'boolean';
    case 'object': return v != null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    default: return true;
  }
};
const frType = { string: 'texte', integer: 'entier', boolean: 'booléen', object: 'objet', array: 'liste' };

/**
 * Validate a full actions program.
 * @param {Array} actions
 * @param {{dsl_version?:number}} [meta]
 * @returns {{ok:boolean, errors:Array<{path:string,message:string}>, version:number}}
 */
export function validateActions(actions, meta = {}) {
  const errors = [];
  const push = (path, message) => errors.push({ path, message });

  if (meta.dsl_version != null && Number(meta.dsl_version) > DSL_VERSION) {
    push('dsl_version', `Recette écrite pour une version du DSL (${meta.dsl_version}) plus récente que celle de l'application (${DSL_VERSION}). Mettez à jour Eloshon Scraper.`);
    return { ok: false, errors, version: DSL_VERSION };
  }
  if (!Array.isArray(actions)) {
    push('actions', 'Le programme d\'actions doit être une liste.');
    return { ok: false, errors, version: DSL_VERSION };
  }
  if (actions.length === 0) {
    push('actions', 'Le programme d\'actions est vide : aucune étape à exécuter.');
  }

  actions.forEach((action, i) => {
    const at = `actions[${i}]`;
    if (action == null || typeof action !== 'object' || Array.isArray(action)) {
      push(at, 'Chaque étape doit être un objet { op, … }.');
      return;
    }
    const op = action.op;
    if (!op) { push(`${at}.op`, 'Étape sans champ « op » (l\'action à exécuter).'); return; }
    const def = OPS[op];
    if (!def) {
      push(`${at}.op`, `Action inconnue « ${op} ». Actions valides : ${OP_NAMES.join(', ')}.`);
      return;
    }
    // Required params + type checks.
    for (const [name, spec] of Object.entries(def.params)) {
      const has = Object.prototype.hasOwnProperty.call(action, name) && action[name] != null;
      if (spec.required && !has) {
        push(`${at}.${name}`, `L'action « ${def.fr} » exige le paramètre « ${name} ».`);
        continue;
      }
      if (has && !typeOk(action[name], spec)) {
        push(`${at}.${name}`, `Le paramètre « ${name} » doit être un ${frType[spec.type] || spec.type}.`);
      }
      if (has && spec.enum && !spec.enum.includes(action[name])) {
        push(`${at}.${name}`, `Le paramètre « ${name} » doit valoir l'une de : ${spec.enum.join(', ')}.`);
      }
    }
    // anyOf: at least one of a set must be present.
    if (def.anyOf && !def.anyOf.some((k) => action[k] != null)) {
      push(at, `L'action « ${def.fr} » exige au moins l'un de : ${def.anyOf.join(', ')}.`);
    }
    // Unknown params are a soft warning surfaced as an error path so recipes stay tight.
    for (const key of Object.keys(action)) {
      if (key === 'op') continue;
      if (!Object.prototype.hasOwnProperty.call(def.params, key)) {
        push(`${at}.${key}`, `Paramètre inconnu « ${key} » pour l'action « ${op} ».`);
      }
    }
  });

  return { ok: errors.length === 0, errors, version: DSL_VERSION };
}
