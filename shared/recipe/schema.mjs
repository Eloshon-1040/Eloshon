/**
 * Recipe format — the single, versioned DATA contract that both the desktop app
 * and the browser extension interpret. A recipe is JSON only: no code, no
 * functions. Code that already lives inside the app / extension interprets it.
 * This is what makes the extension Chrome-Web-Store-compliant (recipes are data,
 * never remotely-hosted code) and what lets a new site be "just data".
 *
 * PORTABLE: zero Node built-ins, zero dependencies. Imported by app AND extension.
 *
 * Compatibility with the shipped-recipe revision system (decided separately):
 *   - `revision` (integer, >= 1): a newer shipped recipe with a higher revision
 *     replaces a saved copy. Absent is treated as revision 0 (legacy) so old
 *     saved recipes still load and are always superseded by a shipped one.
 *   - `schema_version`: the shape version of THIS format. Migrations run on load
 *     (see migrate.mjs) so a v1 recipe keeps working when the format grows.
 *
 * A recipe never contains a secret. Dynamic values (an app key baked into page
 * JS, a store id) are declared as {source,...} descriptors and resolved at run
 * time from the page or from config — never stored here.
 */

/** Current shape version emitted by this build. Bump only for shape changes. */
export const SCHEMA_VERSION = 1;

/**
 * Execution modes a recipe can request (Requirement B). Chosen per recipe from
 * data — the interpreter dispatches on this, no per-site branching.
 */
export const EXECUTION_MODE = Object.freeze({
  /** Replay the site's own internal JSON API in the page runtime (2b). */
  INTERNAL_API: 'internal_api',
  /** Read a hydrated JSON blob from the page (__NEXT_DATA__, __NUXT__, JSON-LD…). */
  EMBEDDED_STATE: 'embedded_state',
  /** CSS-selector DOM extraction. */
  DOM: 'dom',
  /** Observe the page's own network calls and read their JSON. */
  OBSERVE_NETWORK: 'observe_network',
  /** Run an action DSL program (list -> detail, clicks, pagination, …). */
  ACTIONS: 'actions',
});

export const EXECUTION_MODES = Object.freeze(Object.values(EXECUTION_MODE));

/** Reserved recipe keys (used for shape validation and forward-compat docs). */
export const RECIPE_KEYS = Object.freeze([
  'domain', 'schema_version', 'revision', 'mode', 'type',
  'endpoint_tpl', 'method', 'static_headers', 'headers', 'vars', 'pagination',
  'json_path', 'field_map', 'actions', 'selectors', 'extract',
  'pacing', 'challenge', 'notes',
  // reserved-now for future features (never rewrite the format to add them):
  'teach', 'subpages', 'export_profiles', 'license_scope', 'reuse_of', 'status_rules',
]);

/**
 * Normalize a raw recipe object to canonical defaults WITHOUT changing shape
 * version (migration is a separate step). Fills revision/schema_version so
 * downstream code never special-cases "absent".
 * @param {object} raw
 * @returns {object} a shallow-normalized copy
 */
export function withDefaults(raw) {
  const r = { ...(raw || {}) };
  if (r.revision == null) r.revision = 0;
  if (r.schema_version == null) r.schema_version = SCHEMA_VERSION;
  // Back-compat: v0.5.9 recipes carry `type` (e.g. "internal_api"); expose it as `mode`.
  if (!r.mode && r.type) r.mode = r.type;
  return r;
}

/**
 * Decide whether `candidate` should replace `current` for the same domain, using
 * the shipped-recipe revision rule: strictly-higher revision wins. Equal or lower
 * never replaces (so a user edit at the same revision is preserved). A recipe for
 * a different domain never replaces.
 * @returns {boolean}
 */
export function supersedes(candidate, current) {
  if (!candidate) return false;
  if (!current) return true;
  if (candidate.domain && current.domain && candidate.domain !== current.domain) return false;
  const a = Number(withDefaults(candidate).revision) || 0;
  const b = Number(withDefaults(current).revision) || 0;
  return a > b;
}
