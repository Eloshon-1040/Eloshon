/**
 * Data literal → value, for the state a page assigns in a script
 * (`window.__STATE__ = {…}`). Many servers serialise their store with a JS
 * serialiser, not JSON.stringify, so the literal carries JS-only tokens —
 * `undefined` most often, sometimes `NaN` / `Infinity` — and JSON.parse rejects
 * the whole blob (hundreds of KB of product data lost for one `undefined`).
 *
 * parseDataLiteral() tries JSON first, then rewrites ONLY those three tokens to
 * `null`, outside strings. Anything else that is not JSON (unquoted keys,
 * single-quoted strings, functions, calls, comments) still fails: the result is
 * null, never a guess.
 *
 * PORTABLE: zero Node built-ins, zero dependencies.
 */

const JS_ONLY = new Set(['undefined', 'NaN', 'Infinity']);
const JSON_WORDS = new Set(['true', 'false', 'null']);

/** The literal with JS-only tokens replaced by null, or null when it holds anything else non-JSON. */
export function jsTokensToJson(text) {
  const s = String(text == null ? '' : text);
  let out = ''; let i = 0; let changed = false;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') { // a JSON string: copy it verbatim, escapes included
      let j = i + 1;
      while (j < s.length) { const d = s[j]; if (d === '\\') { j += 2; continue; } if (d === '"') break; j += 1; }
      if (j >= s.length) return null;
      out += s.slice(i, j + 1); i = j + 1; continue;
    }
    if (/[0-9]/.test(c)) { // a number, exponent included (1e-7)
      let j = i + 1; while (j < s.length && /[0-9.eE+-]/.test(s[j])) j += 1;
      out += s.slice(i, j); i = j; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1; while (j < s.length && /[\w$]/.test(s[j])) j += 1;
      const word = s.slice(i, j);
      if (JSON_WORDS.has(word)) { out += word; i = j; continue; }
      if (!JS_ONLY.has(word)) return null; // an unquoted key, a call, a function: not a data literal
      // "-Infinity" → "null": drop the sign already copied.
      if (word === 'Infinity' && out.endsWith('-')) out = out.slice(0, -1);
      out += 'null'; i = j; changed = true; continue;
    }
    if (c === "'" || c === '`' || (c === '/' && (s[i + 1] === '/' || s[i + 1] === '*'))) return null;
    out += c; i += 1;
  }
  return changed ? out : null;
}

/**
 * Parse a page's data literal: JSON, else JSON once its JS-only tokens are nulled.
 * Throws like JSON.parse when neither works, so callers keep their try/catch.
 */
export function parseDataLiteral(text) {
  try { return JSON.parse(text); } catch (e) {
    const fixed = jsTokensToJson(text);
    if (fixed == null) throw e;
    return JSON.parse(fixed);
  }
}
