/**
 * Action DSL — a versioned, DATA-ONLY instruction set the interpreter executes
 * inside a real page (Requirement C). No code, no expressions to eval: every
 * action is a plain object `{ op, ...params }`. This is what a recipe's
 * `actions: [...]` array contains.
 *
 * PORTABLE: zero Node built-ins, zero dependencies.
 *
 * Design rules that must stay fixed (so recipes written today keep running):
 *   - Adding a NEW op is backward-compatible; changing an existing op's required
 *     params is not — bump DSL_VERSION and add a migration instead.
 *   - Every op is declared here with its param spec; the validator (validate.mjs)
 *     is generated FROM this catalogue, so there is one source of truth.
 *   - Selectors, URLs, markers, counts are DATA; nothing is hardcoded per site.
 */

export const DSL_VERSION = 1;

/**
 * Param spec primitives. `type` is checked structurally; `required` gates
 * validation; `enum` restricts strings; `of` types array items.
 */
const S = {
  str: (o = {}) => ({ type: 'string', ...o }),
  int: (o = {}) => ({ type: 'integer', ...o }),
  bool: (o = {}) => ({ type: 'boolean', ...o }),
  obj: (o = {}) => ({ type: 'object', ...o }),
  arr: (of, o = {}) => ({ type: 'array', of, ...o }),
};

/**
 * The op catalogue. Each entry: { summary, params:{name:spec}, fr } where `fr`
 * is the French label used in user-facing validation/status messages.
 */
export const OPS = Object.freeze({
  waitFor: {
    summary: 'Wait until a selector appears / a condition holds, then continue.',
    fr: 'attendre un élément',
    params: {
      selector: S.str({ required: false }),
      url_includes: S.str({ required: false }),
      state_key: S.str({ required: false }),      // an embedded-state key that must be present
      timeout_ms: S.int({ required: false }),
    },
    // at least one of selector/url_includes/state_key
    anyOf: ['selector', 'url_includes', 'state_key'],
  },
  click: {
    summary: 'Click the first element matching a selector.',
    fr: 'cliquer',
    params: { selector: S.str({ required: true }), optional: S.bool({ required: false }) },
  },
  type: {
    summary: 'Type text into an input (never used for secrets — values come from config, never hardcoded credentials).',
    fr: 'saisir du texte',
    params: {
      selector: S.str({ required: true }),
      value_from: S.str({ required: false }),      // read from config/siteContext by key
      value: S.str({ required: false }),           // literal, non-secret
      submit: S.bool({ required: false }),
    },
    anyOf: ['value', 'value_from'],
  },
  select: {
    summary: 'Choose an <option> in a <select> by value or label.',
    fr: 'choisir une option',
    params: { selector: S.str({ required: true }), value: S.str({ required: false }), value_from: S.str({ required: false }), label: S.str({ required: false }) },
    anyOf: ['value', 'value_from', 'label'],
  },
  scroll: {
    summary: 'Scroll the page or an element to trigger lazy loading.',
    fr: 'faire défiler',
    params: { selector: S.str({ required: false }), to: S.str({ required: false, enum: ['bottom', 'top'] }), times: S.int({ required: false }), pause_ms: S.int({ required: false }) },
  },
  paginate: {
    summary: 'Advance to the next page of a listing.',
    fr: 'page suivante',
    params: {
      style: S.str({ required: true, enum: ['url_param', 'next_button', 'infinite_scroll', 'cursor'] }),
      param: S.str({ required: false }),           // url_param: the query key to increment
      selector: S.str({ required: false }),        // next_button: the "next" control
      cursor_json_path: S.str({ required: false }),// cursor: where the next cursor lives
      max_pages: S.int({ required: false }),        // per-recipe cap; run-time also capped by job
    },
  },
  followLinks: {
    summary: 'For each item found so far, open its detail page and extract there.',
    fr: 'suivre les liens (fiches produit)',
    params: {
      url_field: S.str({ required: false }),        // field on the item holding the detail URL (default "url")
      max_links: S.int({ required: false }),
      extract: S.obj({ required: false }),          // detail-page extract spec (field_map/selectors)
    },
  },
  extract: {
    summary: 'Extract products from the current page using an extractor spec.',
    fr: 'extraire les produits',
    params: {
      using: S.str({ required: true, enum: ['embedded_state', 'dom', 'json_ld', 'internal_api', 'auto'] }),
      json_path: S.str({ required: false }),
      field_map: S.obj({ required: false }),
      item_selector: S.str({ required: false }),    // dom mode: repeated card selector
      selectors: S.obj({ required: false }),        // dom mode: per-field selectors
    },
  },
  assert: {
    summary: 'Fail the job with a clear message if a condition is not met.',
    fr: 'vérifier une condition',
    params: {
      selector: S.str({ required: false }),
      min_items: S.int({ required: false }),
      message: S.str({ required: false }),
    },
    anyOf: ['selector', 'min_items'],
  },
  branchOnMarker: {
    summary: 'If a challenge/marker matches, run one of the challenge strategies; else continue.',
    fr: 'brancher selon un marqueur',
    params: {
      // marker set is a reference into recipe.challenge (config-driven detection)
      when: S.str({ required: true, enum: ['challenge', 'captcha', 'auth_required', 'rate_limited', 'blocked'] }),
      strategy: S.str({ required: false }),         // named ChallengeStrategy; default from recipe.challenge
      else_continue: S.bool({ required: false }),
    },
  },
});

export const OP_NAMES = Object.freeze(Object.keys(OPS));
