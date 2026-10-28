/**
 * Patterns from recipes (they may come from the recipe server) are checked before
 * they run, and the text they read is capped. JavaScript gives a regex no time
 * limit: one catastrophic pattern over a page freezes the process (measured on
 * 2026-10-21: "(a+)+$" took 18 s on 27 characters, doubling with each one).
 *
 * Refused (regexRisk returns the reason):
 *   - a pattern longer than MAX_PATTERN, flags other than i m s u;
 *   - back-references (\1…, \k<name>);
 *   - an unbounded-repeated group (*, +, {n,}) or a group repeated more than
 *     MAX_REPEAT times that itself holds an unbounded repetition — unless the group
 *     holds a mandatory atom (a character or a class) that none of its repetitions can take
 *     ("(?:\d+/)*" is fine: \d never takes "/"; "(.*a){20}" is not: "." takes "a");
 *   - an unbounded-repeated group with an alternation ("(x|y)*");
 *   - two unbounded repetitions side by side that can take the same characters
 *     ("\w*\w*"), with no mandatory literal between them.
 * Over-sampled character test (ASCII + a few others) decides "can take".
 *
 * PORTABLE: zero Node built-ins, zero dependencies.
 */

export const MAX_PATTERN = 400;
export const MAX_INPUT = 1000000; // characters a recipe pattern may read
const MAX_REPEAT = 10;
const ALLOWED_FLAGS = /^[imsu]*$/;
const SAMPLE = (() => { const out = []; for (let c = 9; c < 127; c++) out.push(String.fromCharCode(c)); return out.concat(['é', '€', ' ', 'ß', '中']); })();
const CLASS_ESC = new Set(['d', 'D', 'w', 'W', 's', 'S']);

/** The characters of SAMPLE an atom's source can match. */
function takes(src, flags) {
  let re; try { re = new RegExp(`^(?:${src})$`, flags.replace(/[^imsu]/g, '')); } catch { return new Set(SAMPLE); }
  return new Set(SAMPLE.filter((ch) => re.test(ch)));
}
const overlaps = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };

/** Read a quantifier at s[i]: { min, max (Infinity), len } or null. */
function quantAt(s, i) {
  const c = s[i];
  let q = null;
  if (c === '*') q = { min: 0, max: Infinity, len: 1 };
  else if (c === '+') q = { min: 1, max: Infinity, len: 1 };
  else if (c === '?') q = { min: 0, max: 1, len: 1 };
  else if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(s.slice(i));
    if (m) q = { min: Number(m[1]), max: m[2] ? (m[3] === '' ? Infinity : Number(m[3])) : Number(m[1]), len: m[0].length };
  }
  if (q && s[i + q.len] === '?') q.len += 1; // lazy
  return q;
}

/** null when the pattern is acceptable, else a short reason. */
export function regexRisk(pattern, flags = '') {
  const s = String(pattern == null ? '' : pattern);
  if (!s) return 'empty pattern';
  if (s.length > MAX_PATTERN) return `pattern too long (${s.length} > ${MAX_PATTERN})`;
  if (!ALLOWED_FLAGS.test(flags || '')) return `flags "${flags}" not allowed`;
  try { new RegExp(s, flags || ''); } catch (e) { return `invalid pattern (${e.message})`; }
  // A frame per group: its unbounded atoms (char sets), mandatory atoms, alternation.
  // `mandatory`: char sets of the atoms that must match (a literal, or a class).
  const mk = () => ({ unbounded: [], mandatory: [], alt: false, lastUnbounded: null, zeroWidth: false });
  const stack = [mk()];
  let i = 0;
  const top = () => stack[stack.length - 1];
  const addAtom = (src, isLiteral, ch, q) => {
    const f = top();
    const unbounded = q && q.max === Infinity;
    if (unbounded) {
      const set = takes(src, flags);
      if (f.lastUnbounded && overlaps(f.lastUnbounded, set)) return 'overlapping unbounded repetitions side by side';
      f.unbounded.push(set); f.lastUnbounded = set;
    } else if (!q || q.min >= 1) {
      // A mandatory atom separates two repetitions only if neither can take it.
      const set = isLiteral ? new Set([ch]) : takes(src, flags);
      f.mandatory.push(set);
      if (f.lastUnbounded && !overlaps(f.lastUnbounded, set)) f.lastUnbounded = null;
    }
    return null;
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (/[1-9]/.test(n) || (n === 'k' && s[i + 2] === '<')) return 'back-reference';
      const src = s.slice(i, i + 2); i += 2;
      if (n === 'u' || n === 'x') { const m = /^\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2})/.exec(s.slice(i - 2)); if (m) i = i - 2 + m[0].length; }
      if (n === 'b' || n === 'B') continue; // zero-width
      const q = quantAt(s, i); if (q) i += q.len;
      const literal = !CLASS_ESC.has(n) && n !== 'p' && n !== 'P';
      const atomSrc = s.slice(i - (q ? q.len : 0) - src.length, i - (q ? q.len : 0));
      const CTRL = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', 0: '\0' };
      const ch = !literal ? null : (CTRL[n] ?? (n === 'u' || n === 'x' ? null : n));
      const r = addAtom(atomSrc, literal && ch != null, ch, q); if (r) return r;
      continue;
    }
    if (c === '[') {
      let j = i + 1; if (s[j] === '^') j++; if (s[j] === ']') j++;
      while (j < s.length && s[j] !== ']') { if (s[j] === '\\') j++; j++; }
      const src = s.slice(i, j + 1); i = j + 1;
      const q = quantAt(s, i); if (q) i += q.len;
      const r = addAtom(src, false, null, q); if (r) return r;
      continue;
    }
    if (c === '(') {
      const f = mk();
      if (s.startsWith('(?=', i) || s.startsWith('(?!', i)) { f.zeroWidth = true; i += 3; }
      else if (s.startsWith('(?<=', i) || s.startsWith('(?<!', i)) { f.zeroWidth = true; i += 4; }
      else if (s.startsWith('(?:', i)) i += 3;
      else if (s.startsWith('(?<', i)) { i = s.indexOf('>', i) + 1; }
      else i += 1;
      stack.push(f); continue;
    }
    if (c === ')') {
      const g = stack.pop(); i += 1;
      const q = quantAt(s, i); if (q) i += q.len;
      const parent = top();
      if (g.zeroWidth) continue;
      const repeated = q && (q.max === Infinity || q.max > MAX_REPEAT);
      if (repeated && g.unbounded.length) {
        const separated = g.mandatory.some((m) => g.unbounded.every((set) => !overlaps(set, m)));
        if (!separated) return 'nested unbounded repetition';
      }
      if (q && q.max === Infinity && g.alt) return 'repeated alternation';
      // The group, seen from its parent: unbounded if it or its content repeats freely.
      const all = new Set(); for (const set of g.unbounded) for (const x of set) all.add(x);
      if ((q && q.max === Infinity) || g.unbounded.length) {
        // A freely repeated group can take what all its atoms take.
        const set = new Set(all); for (const m of g.mandatory) for (const x of m) set.add(x);
        // A group that ENDS with a mandatory literal ("([a-z]+-)*") cannot share its
        // last characters with what follows: no side-by-side overlap from it.
        if (q && q.max === Infinity) { parent.unbounded.push(set); parent.lastUnbounded = g.lastUnbounded ? set : null; }
        else { parent.unbounded.push(...g.unbounded); parent.lastUnbounded = g.lastUnbounded ? all : null; }
      } else parent.lastUnbounded = null;
      if (!q || q.min >= 1) parent.mandatory.push(...g.mandatory);
      continue;
    }
    if (c === '|') { top().alt = true; top().lastUnbounded = null; i += 1; continue; }
    if (c === '^' || c === '$') { i += 1; continue; }
    // A plain character or ".".
    i += 1;
    const q = quantAt(s, i); if (q) i += q.len;
    const r = addAtom(c === '.' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), c !== '.', c !== '.' ? c : null, q); if (r) return r;
  }
  return null;
}

/** { re } for an acceptable pattern, else { error: 'unsafe pattern (…)' }. */
export function safeRegExp(pattern, flags = '') {
  const risk = regexRisk(pattern, flags || '');
  if (risk) return { error: /invalid pattern/.test(risk) ? risk : (/flags/.test(risk) ? risk : `unsafe pattern (${risk})`) };
  return { re: new RegExp(String(pattern), flags || '') };
}

/** `text.match(re)` on at most MAX_INPUT characters. */
export function boundedMatch(text, re) {
  const t = String(text == null ? '' : text);
  return (t.length > MAX_INPUT ? t.slice(0, MAX_INPUT) : t).match(re);
}
