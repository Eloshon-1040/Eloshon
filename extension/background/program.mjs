/**
 * Pure job helpers used by the service worker — kept free of any chrome.* side
 * effects so they are unit-testable in Node. Maps a recipe mode to a default
 * single-lane action program, and the interpreter status to a job-store state.
 */
import { JOB_STATUS } from '../vendor/shared/protocol/messages.mjs';
import { STATE } from '../vendor/shared/job/machine.mjs';

/**
 * A recipe with no explicit `actions` gets a default one-step program from its
 * mode, so simple internal-api / embedded-state / dom recipes need no DSL.
 */
export function defaultProgram(recipe, { detail = null } = {}) {
  const using = recipe.mode === 'internal_api' ? 'internal_api'
    : recipe.mode === 'embedded_state' ? 'embedded_state'
    : recipe.mode === 'dom' ? 'dom' : 'auto';
  const actions = [{
    op: 'extract', using,
    json_path: recipe.json_path, field_map: recipe.field_map,
    item_selector: recipe.item_selector, selectors: recipe.selectors,
  }];
  // The app asked for the product pages too (« Fiches produit » limit): opened in this tab, one by one.
  const plan = detailPlanOf(detail);
  if (plan) actions.push({ op: 'followLinks', max_links: plan.max });
  return { ...recipe, actions };
}

/** The product-page plan the app sent with a job ({follow, max}), or null when none is to be opened. */
export function detailPlanOf(detail) {
  const max = Math.floor(Number(detail && detail.max) || 0);
  return detail && detail.follow === true && max > 0 ? { max: Math.min(max, 500) } : null;
}

/** A detail URL the job may open: http(s), on the job's site (www., country subdomains included). */
export function sameSiteUrl(u, domain) {
  try {
    const x = new URL(u); if (!/^https?:$/.test(x.protocol)) return false;
    const h = x.hostname.replace(/^www\./, ''); const d = String(domain || '').replace(/^www\./, '');
    return !!d && (h === d || h.endsWith(`.${d}`) || d.endsWith(`.${h}`));
  } catch { return false; }
}

/** Map an interpreter/protocol status to a persisted job state. */
export function mapState(status) {
  switch (status) {
    case JOB_STATUS.DONE: return STATE.DONE;
    case JOB_STATUS.BLOCKED: return STATE.BLOCKED;
    case JOB_STATUS.STOPPED: return STATE.STOPPED;
    case JOB_STATUS.ERROR: return STATE.ERROR;
    default: return STATE.DONE;
  }
}

/**
 * Turn a runRecipeLane() result into the extractor's product list WITHOUT losing
 * its error (the silent "done, 0 products" of job 20260929222644-dm2zb):
 *  - no product + an error → throw, so the interpreter ends the job in ERROR
 *    with the reason (the app records it);
 *  - partial products + an error → keep the products, remember the error.
 * `diag` (mutated) collects names only — never a var/header VALUE:
 *   { varsResolved:[names], varsMissing:[names], laneError }.
 * @param {object} r      runRecipeLane result
 * @param {object} recipe the recipe (for its declared var names)
 * @param {object} diag
 */
export function laneProducts(r, recipe, diag) {
  const res = r || {};
  const products = Array.isArray(res.products) ? res.products : [];
  const declared = Object.keys((recipe && recipe.vars) || {});
  const resolved = Object.keys(res.vars || {}).filter((k) => res.vars[k] != null && res.vars[k] !== '');
  if (diag) {
    diag.varsResolved = resolved;
    diag.varsMissing = declared.filter((k) => !resolved.includes(k));
    diag.laneError = res.error ? String(res.error).slice(0, 240) : null;
  }
  if (res.error && !products.length) throw new Error(String(res.error).slice(0, 240));
  if (!res.error && res.ok === false && !products.length) throw new Error('recette : aucun résultat exploitable');
  return products;
}
