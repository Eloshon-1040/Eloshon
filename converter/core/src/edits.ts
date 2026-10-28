// Edits: the user's own changes to a file BEFORE it is converted — rename or add a
// column, replace / remove / add text, cut a prefix or a suffix, insert a character at
// chosen positions, fix a decimal point, slugify, de-duplicate repeated words… Each
// operation is a named, ready-made "formula" (the Google Sheets equivalent is stated in
// the catalogue), applied to ONE column or to all of them, optionally only on the rows
// that match a condition. Pure and deterministic: the same edits on the same file always
// give the same table, so they can be saved in a template and replayed on the next file.
//
// The file on disk is never touched: edits run on the parsed table, in memory, before
// detection, mapping and conversion all see it.
import type { Table, Row } from './csv';
import { parseCsv, serializeCsv } from './csv';
import { toNumber } from '../knowledge-proposal/transforms.mjs';
import { EDIT_PRESETS } from './edit-catalog';

export type EditArg = string | number | boolean | string[];
export type EditCondition = {
  column?: string;            // defaults to the edited column
  contains?: string; equals?: string; startsWith?: string; endsWith?: string;
  regex?: string; empty?: boolean; notEmpty?: boolean;
  ignoreCase?: boolean;
};
export type Edit = { id: string; op: string; column: string; args?: Record<string, EditArg>; when?: EditCondition };
export type EditResult = { id: string; changed: number; error?: 'column_missing' | 'column_exists' | 'regex_invalid' | 'unknown_op' | 'bad_args' };
export type EditOutcome = { table: Table; report: EditResult[] };

export const ALL_COLUMNS = '*';

// ── cell operations: (value, args, row) → new value ─────────────────────────
const str = (v: EditArg | undefined, d = ''): string => (v === undefined || v === null ? d : Array.isArray(v) ? v.join(',') : String(v));
const int = (v: EditArg | undefined, d = 0): number => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : d; };
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripAccents = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&apos;': "'" };

// ── "Clean the code": HTML pasted into a text (a description, a category) made readable ──
// Named entities met in shop exports; numeric ones (&#8243; &#x2033; &#038;) are decoded by code point.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·', prime: '′', Prime: '″',
  deg: '°', euro: '€', pound: '£', cent: '¢', yen: '¥', copy: '©', reg: '®', trade: '™', sect: '§', para: '¶',
  times: '×', divide: '÷', plusmn: '±', micro: 'µ', frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³',
  iexcl: '¡', iquest: '¿', szlig: 'ß', oelig: 'œ', OElig: 'Œ', aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø',
  aring: 'å', Aring: 'Å', ccedil: 'ç', Ccedil: 'Ç', ntilde: 'ñ', Ntilde: 'Ñ',
};
for (const [base, marks] of Object.entries({ a: 'grave acute circ tilde uml', e: 'grave acute circ uml', i: 'grave acute circ uml', o: 'grave acute circ tilde uml', u: 'grave acute circ uml', y: 'acute uml' })) {
  const combining: Record<string, string> = { grave: '̀', acute: '́', circ: '̂', tilde: '̃', uml: '̈' };
  for (const m of marks.split(' ')) {
    NAMED_ENTITIES[base + m] = (base + combining[m]).normalize('NFC');
    NAMED_ENTITIES[base.toUpperCase() + m] = (base.toUpperCase() + combining[m]).normalize('NFC');
  }
}
/** Decode HTML entities in one pass. `keepMarkup`: <, > and & stay written &lt; &gt; &amp; (they would become code). */
function decodeEntities(s: string, keepMarkup: boolean): string {
  return s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,8});/gi, (m, body: string) => {
    let ch: string | undefined;
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      ch = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : undefined;
    } else ch = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    if (ch === undefined) return m;
    if (keepMarkup && (ch === '<' || ch === '>' || ch === '&')) return ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&amp;';
    return ch;
  });
}
// a tag, its attributes read with their quotes (a ">" inside title="a>b" does not end it)
const TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const DROP_WITH_CONTENT = /<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<![^>]*>/gi;
// the tags that end a line in « Text only »
const LINE_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'tr', 'blockquote', 'section', 'article', 'header', 'footer', 'pre', 'dl', 'dt', 'dd', 'hr', 'br']);
// « Clean HTML »: what is kept, and the few tags renamed into one of them
const KEPT_TAGS = new Set(['p', 'br', 'ul', 'ol', 'li', 'strong', 'em', 'h2', 'h3', 'h4', 'table', 'tr', 'th', 'td']);
const RENAMED_TAGS: Record<string, string> = { b: 'strong', i: 'em', h1: 'h2', h5: 'h4', h6: 'h4' };
// an element left with nothing inside (cells stay: an empty cell keeps the table's columns in place)
const EMPTY_ELEMENT = /<(p|ul|ol|li|strong|em|h2|h3|h4|table|tr)>(?:\s|<br>)*<\/\1>/g;

/** Trim each line, collapse spaces (non-breaking ones too), drop the empty lines. */
const tidyLines = (s: string): string => s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t\f\v ]+/g, ' ').trim()).filter((l) => l !== '' && l !== '•').join('\n');

export function cleanCode(v: string, mode: string): string {
  const s = v.replace(DROP_WITH_CONTENT, '');
  if (mode === 'html') {
    let out = s.replace(TAG_RE, (_m, close: string, raw: string) => {
      const name = RENAMED_TAGS[raw.toLowerCase()] ?? raw.toLowerCase();
      if (!KEPT_TAGS.has(name)) return LINE_TAGS.has(name) ? ' ' : '';
      return name === 'br' ? '<br>' : `<${close}${name}>`;
    });
    out = tidyLines(decodeEntities(out, true));
    for (let prev = ''; prev !== out;) { prev = out; out = out.replace(EMPTY_ELEMENT, ''); }
    return out.replace(/^(?:\s|<br>)+|(?:\s|<br>)+$/g, '');
  }
  const text = s.replace(TAG_RE, (_m, close: string, raw: string) => {
    const name = raw.toLowerCase();
    if (name === 'li' && !close) return '\n• ';
    if (LINE_TAGS.has(name)) return '\n';
    return name === 'td' || name === 'th' ? (close ? ' ' : '') : '';
  });
  return tidyLines(decodeEntities(text, false));
}

function regexOf(pattern: string, flags: string): RegExp | null {
  if (!pattern || pattern.length > 300) return null;
  try { return new RegExp(pattern, flags); } catch { return null; }
}

const proper = (s: string): string => s.toLowerCase().replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());

type CellOp = (v: string, a: Record<string, EditArg>) => string | { error: EditResult['error'] };

const CELL_OPS: Record<string, CellOp> = {
  replace: (v, a) => {
    const find = str(a.find); if (find === '') return v;
    const whole = a.whole === true || a.whole === 'true';
    if (whole) return (a.matchCase ? v === find : v.toLowerCase() === find.toLowerCase()) ? str(a.with) : v;
    return v.replace(new RegExp(escapeRe(find), a.matchCase ? 'g' : 'gi'), () => str(a.with));
  },
  regex_replace: (v, a) => {
    const re = regexOf(str(a.pattern), str(a.flags, 'g').replace(/[^gimsu]/g, '') || 'g');
    return re ? v.replace(re, str(a.with)) : { error: 'regex_invalid' };
  },
  remove: (v, a) => { const t = str(a.text); return t === '' ? v : v.split(t).join(''); },
  remove_chars: (v, a) => { const set = new Set(Array.from(str(a.chars))); return set.size ? Array.from(v).filter((c) => !set.has(c)).join('') : v; },
  prefix_add: (v, a) => str(a.text) + v,
  suffix_add: (v, a) => v + str(a.text),
  prefix_remove: (v, a) => { const t = str(a.text); return t && v.startsWith(t) ? v.slice(t.length) : v; },
  suffix_remove: (v, a) => { const t = str(a.text); return t && v.endsWith(t) ? v.slice(0, v.length - t.length) : v; },
  keep_left: (v, a) => Array.from(v).slice(0, Math.max(0, int(a.n))).join(''),
  keep_right: (v, a) => { const n = Math.max(0, int(a.n)); const c = Array.from(v); return n === 0 ? '' : c.slice(-n).join(''); },
  drop_left: (v, a) => Array.from(v).slice(Math.max(0, int(a.n))).join(''),
  drop_right: (v, a) => { const n = Math.max(0, int(a.n)); const c = Array.from(v); return n === 0 ? v : c.slice(0, Math.max(0, c.length - n)).join(''); },
  // "add a comma at these places": 1-based positions counted from the start (or the end)
  insert_at: (v, a) => {
    const text = str(a.text); if (text === '') return v;
    const fromEnd = a.fromEnd === true || a.fromEnd === 'true';
    const chars = Array.from(v);
    const positions = str(a.positions).split(/[,;\s]+/).map((p) => Math.trunc(Number(p))).filter((p) => Number.isFinite(p) && p >= 1);
    // from the end: position p means "p characters before the end"; either way insert right-to-left
    const idx = Array.from(new Set(positions.map((p) => (fromEnd ? chars.length - p + 1 : p)))).filter((i) => i >= 1 && i <= chars.length + 1).sort((x, y) => y - x);
    for (const i of idx) chars.splice(i - 1, 0, text);
    return chars.join('');
  },
  delete_at: (v, a) => {
    const chars = Array.from(v); const start = int(a.position, 1); const count = Math.max(1, int(a.count, 1));
    return start < 1 || start > chars.length ? v : (chars.splice(start - 1, count), chars.join(''));
  },
  trim: (v) => v.replace(/[\s ]+/g, ' ').trim(),
  upper: (v) => v.toUpperCase(),
  lower: (v) => v.toLowerCase(),
  proper,
  split_take: (v, a) => {
    const sep = str(a.sep, ' '); if (sep === '') return v;
    const parts = v.split(sep).map((p) => p.trim());
    const n = int(a.index, 1); const i = n > 0 ? n - 1 : parts.length + n;
    return parts[i] ?? '';
  },
  keep_before: (v, a) => { const t = str(a.text); if (!t) return v; const i = a.last ? v.lastIndexOf(t) : v.indexOf(t); return i < 0 ? v : v.slice(0, i); },
  keep_after: (v, a) => { const t = str(a.text); if (!t) return v; const i = a.last ? v.lastIndexOf(t) : v.indexOf(t); return i < 0 ? v : v.slice(i + t.length); },
  regex_extract: (v, a) => {
    const re = regexOf(str(a.pattern), 'u'); if (!re) return { error: 'regex_invalid' };
    const m = v.match(re); return m ? (m[int(a.group, 0)] ?? '') : '';
  },
  dedupe_words: (v) => {
    const seen = new Set();
    return v.split(/(\s+)/).filter((tok) => {
      if (/^\s*$/.test(tok)) return true;
      const key = tok.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (!key) return true; // a lone "|" or "-" separator is not a word
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).join('').replace(/\s{2,}/g, ' ').trim();
  },
  dedupe_segments: (v, a) => {
    const sep = str(a.sep, '|'); if (sep === '') return v;
    const seen = new Set(); const out: string[] = [];
    for (const seg of v.split(sep)) { const k = seg.trim().toLowerCase(); if (k === '' || seen.has(k)) continue; seen.add(k); out.push(seg.trim()); }
    return out.join(sep === '|' ? ' | ' : sep === ',' ? ', ' : sep);
  },
  join_segments: (v, a) => { const from = str(a.sep, '|'); return from === '' ? v : v.split(from).map((s) => s.trim()).filter(Boolean).join(str(a.with, ' ')); },
  slugify: (v, a) => {
    const s = stripAccents(v).toLowerCase().replace(/&/g, ' et ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const max = int(a.maxLength, 0);
    return max > 0 ? s.slice(0, max).replace(/-+$/, '') : s;
  },
  strip_html: (v) => v.replace(/<br\s*\/?>|<\/p>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? e).replace(/\s{2,}/g, ' ').trim(),
  clean_code: (v, a) => cleanCode(v, str(a.mode, 'text')),
  number: (v, a) => {
    const n = toNumber(v); if (n === null) return v;
    const x = Number(a.value);
    const action = str(a.action, 'divide');
    let r = n;
    if (action === 'divide') { if (!x) return v; r = n / x; }
    else if (action === 'multiply') r = n * x;
    else if (action === 'add') r = n + x;
    else if (action === 'subtract') r = n - x;
    else if (action === 'round') { const d = Math.max(0, int(a.value, 0)); return n.toFixed(d); }
    else return v;
    return String(Math.round(r * 1e6) / 1e6);
  },
  decimal_point: (v) => { const n = toNumber(v); return n === null ? v : String(n); },
  set: (_v, a) => str(a.text),
  fill_empty: (v, a) => (v.trim() === '' ? str(a.text) : v),
};

// ── conditions ──────────────────────────────────────────────────────────────
function matches(row: Row, defaultColumn: string, w: EditCondition | undefined): boolean {
  if (!w) return true;
  const col = w.column && w.column !== '' ? w.column : defaultColumn;
  const raw = String(row[col] ?? '');
  const v = w.ignoreCase ? raw.toLowerCase() : raw;
  const n = (s: string) => (w.ignoreCase ? s.toLowerCase() : s);
  if (w.empty && raw.trim() !== '') return false;
  if (w.notEmpty && raw.trim() === '') return false;
  if (w.equals !== undefined && w.equals !== '' && v !== n(w.equals)) return false;
  if (w.contains && !v.includes(n(w.contains))) return false;
  if (w.startsWith && !v.startsWith(n(w.startsWith))) return false;
  if (w.endsWith && !v.endsWith(n(w.endsWith))) return false;
  if (w.regex) { const re = regexOf(w.regex, w.ignoreCase ? 'iu' : 'u'); if (!re || !re.test(raw)) return false; }
  return true;
}

// ── column operations ───────────────────────────────────────────────────────
function renameKey(rows: Row[], from: string, to: string): void {
  for (const r of rows) { const v = r[from]; delete r[from]; r[to] = v; }
}

function ensureColumn(table: Table, name: string): void {
  if (table.headers.includes(name)) return;
  table.headers = [...table.headers, name];
  for (const r of table.rows) r[name] = '';
}

/** Known names, one per line or separated by ";" — longest first so "Under Armour" wins over "Under". */
export function parseKnown(v: EditArg | undefined): string[][] {
  const list = (Array.isArray(v) ? v : str(v).split(/[\n;]+/)).map((s) => s.trim()).filter(Boolean);
  return Array.from(new Set(list)).map((s) => s.split(/\s+/)).sort((x, y) => y.length - x.length);
}
const foldWord = (s: string): string => stripAccents(s).toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/** The leading words of a text: a known name when one starts it, else the first `count` words. */
export function leadingWords(text: string, count: number, known: string[][], noFallback = false): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  for (const k of known) {
    if (k.length <= words.length && k.every((w, i) => foldWord(w) === foldWord(words[i]))) return words.slice(0, k.length).join(' ');
  }
  return noFallback ? '' : words.slice(0, count).join(' ');
}

function applyOne(table: Table, e: Edit): EditResult {
  const res: EditResult = { id: e.id, changed: 0 };
  const a = e.args ?? {};
  const has = (c: string) => table.headers.includes(c);

  switch (e.op) {
    case 'rename_column': {
      const to = str(a.to).trim();
      if (!has(e.column)) return { ...res, error: 'column_missing' };
      if (!to) return { ...res, error: 'bad_args' };
      if (to !== e.column && has(to)) return { ...res, error: 'column_exists' };
      table.headers = table.headers.map((h) => (h === e.column ? to : h));
      renameKey(table.rows, e.column, to);
      return { ...res, changed: table.rows.length };
    }
    case 'delete_column': {
      if (!has(e.column)) return { ...res, error: 'column_missing' };
      table.headers = table.headers.filter((h) => h !== e.column);
      for (const r of table.rows) delete r[e.column];
      return { ...res, changed: table.rows.length };
    }
    case 'copy_column':
    case 'add_column': {
      const to = str(a.to).trim();
      if (!to) return { ...res, error: 'bad_args' };
      if (has(to)) return { ...res, error: 'column_exists' };
      const copy = e.op === 'copy_column';
      if (copy && !has(e.column)) return { ...res, error: 'column_missing' };
      const at = copy ? table.headers.indexOf(e.column) + 1 : table.headers.length;
      table.headers = [...table.headers.slice(0, at), to, ...table.headers.slice(at)];
      for (const r of table.rows) { if (matches(r, copy ? e.column : to, e.when)) { r[to] = copy ? (r[e.column] ?? '') : str(a.text); res.changed++; } else r[to] = ''; }
      return res;
    }
    case 'join_columns': {
      const to = str(a.to).trim();
      const cols = (Array.isArray(a.columns) ? a.columns : str(a.columns).split(';')).map((c) => c.trim()).filter(Boolean);
      if (!to || cols.length < 2) return { ...res, error: 'bad_args' };
      if (cols.some((c) => !has(c))) return { ...res, error: 'column_missing' };
      if (has(to)) return { ...res, error: 'column_exists' };
      const sep = str(a.sep, ' ');
      const at = Math.max(...cols.map((c) => table.headers.indexOf(c))) + 1;
      table.headers = [...table.headers.slice(0, at), to, ...table.headers.slice(at)];
      for (const r of table.rows) { r[to] = cols.map((c) => String(r[c] ?? '').trim()).filter(Boolean).join(sep); if (r[to]) res.changed++; }
      return res;
    }
    // Fill THIS column from another one: the first N words ("adidas Samba OG" → "adidas"), or a
    // known multi-word name ("Under Armour Hovr…" → "Under Armour"). args.from = source column,
    // args.count = words to take when no known name starts the text, args.known = known names
    // (one per line or separated by ";"), args.fallback = 'first' (default) | 'none'.
    case 'words_from': {
      const from = str(a.from).trim();
      if (!from) return { ...res, error: 'bad_args' };
      if (!has(from)) return { ...res, error: 'column_missing' };
      ensureColumn(table, e.column);
      const known = parseKnown(a.known);
      const count = Math.max(1, int(a.count, 1));
      const onlyEmpty = a.onlyEmpty === true || a.onlyEmpty === 'true';
      const noFallback = str(a.fallback, 'first') === 'none';
      for (const r of table.rows) {
        if (!matches(r, e.column, e.when)) continue;
        if (onlyEmpty && String(r[e.column] ?? '').trim() !== '') continue;
        const out = leadingWords(String(r[from] ?? ''), count, known, noFallback);
        if (out !== String(r[e.column] ?? '')) { r[e.column] = out; res.changed++; }
      }
      return res;
    }
    // A text with the other columns dropped in where you want them: "{brand} - {title}", "{this} 70 cl".
    case 'template': {
      const text = str(a.text);
      if (!text) return { ...res, error: 'bad_args' };
      ensureColumn(table, e.column);
      const byLower = new Map(table.headers.map((h) => [h.toLowerCase(), h]));
      for (const r of table.rows) {
        if (!matches(r, e.column, e.when)) continue;
        const cur = String(r[e.column] ?? '');
        const out = text.replace(/\{([^{}]+)\}/g, (m, name: string) => {
          const n = name.trim();
          if (n.toLowerCase() === 'this') return cur;
          const col = table.headers.includes(n) ? n : byLower.get(n.toLowerCase());
          return col === undefined ? m : String(r[col] ?? '').trim();
        }).replace(/[ \t]{2,}/g, ' ').trim();
        if (out !== cur) { r[e.column] = out; res.changed++; }
      }
      return res;
    }
    // One cell typed by hand in the preview table: args.row = 1-based data row, args.text = new value.
    // Not in the catalogue (no formula to pick): the table itself creates it.
    case 'set_cell': {
      if (!has(e.column)) return { ...res, error: 'column_missing' };
      const n = Math.trunc(Number(a.row));
      if (!Number.isFinite(n) || n < 1) return { ...res, error: 'bad_args' };
      const r = table.rows[n - 1];
      if (!r) return res; // fewer rows than when the edit was made: nothing to touch
      const text = str(a.text);
      if (String(r[e.column] ?? '') !== text) { r[e.column] = text; res.changed = 1; }
      return res;
    }
  }

  const op = CELL_OPS[e.op];
  if (!op) return { ...res, error: 'unknown_op' };
  const targets = e.column === ALL_COLUMNS ? table.headers : [e.column];
  if (e.column !== ALL_COLUMNS && !has(e.column)) return { ...res, error: 'column_missing' };
  for (const r of table.rows) {
    for (const col of targets) {
      if (!matches(r, col, e.when)) continue;
      const before = String(r[col] ?? '');
      const out = op(before, a);
      if (typeof out !== 'string') return { ...res, error: out.error };
      if (out !== before) { r[col] = out; res.changed++; }
    }
  }
  return res;
}

/** Apply the edits in order. Never throws: a failing edit is reported and skipped. */
export function applyEdits(table: Table, edits: Edit[] | undefined | null): EditOutcome {
  if (!edits || edits.length === 0) return { table, report: [] };
  const work: Table = { ...table, headers: [...table.headers], rows: table.rows.map((r) => ({ ...r })) };
  const report: EditResult[] = [];
  for (const e of edits) {
    if (!e || typeof e.op !== 'string') continue;
    try { report.push(applyOne(work, e)); } catch { report.push({ id: e.id, changed: 0, error: 'bad_args' }); }
  }
  return { table: work, report };
}

/** CSV text → CSV text with the edits applied (JSON / .eloshon text is returned untouched). */
export function applyEditsToText(text: string, edits: Edit[] | undefined | null): string {
  if (!edits || edits.length === 0 || typeof text !== 'string') return text;
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) return text;
  const { table } = applyEdits(parseCsv(text), edits);
  return serializeCsv(table.headers, table.rows);
}

/** Before / after of one column over the first rows, for the live preview in the editor. */
export function previewEdits(text: string, edits: Edit[], column: string, limit = 8): { headers: string[]; before: string[]; after: string[]; report: EditResult[] } {
  const parsed = parseCsv(text);
  const before = parsed.rows.slice(0, limit).map((r) => String(r[column] ?? ''));
  const { table, report } = applyEdits({ ...parsed, rows: parsed.rows.slice(0, 200) }, edits);
  const last = edits[edits.length - 1];
  const shown = last && last.op === 'rename_column' ? str(last.args?.to) : column;
  const after = table.rows.slice(0, limit).map((r) => String(r[shown] ?? r[column] ?? ''));
  return { headers: table.headers, before, after, report };
}

/** A one-click recipe → the edits it stands for, aimed at one column. */
export function expandPreset(presetId: string, column: string, ids: () => string = () => Math.random().toString(36).slice(2, 10)): Edit[] {
  const preset = EDIT_PRESETS.find((p) => p.id === presetId);
  if (!preset) return [];
  return preset.edits.map((e) => ({
    id: ids(),
    op: e.op,
    column: e.suffixColumn ? column + e.suffixColumn : column,
    args: Object.fromEntries(Object.entries(e.args).map(([k, v]) => [k, typeof v === 'string' ? v.replace('{col}', column) : v])),
  }));
}

/** Things the user would probably want to fix, found by looking at the data: a price column
 *  whose values are whole numbers that look like cents (1599, 1479 for 15.99, 14.79). Only a
 *  suggestion — the editor shows it with a one-click fix and a preview. */
export type EditHint = { kind: 'cents'; column: string; sample: string };
const PRICE_HEADER = /^(price|prix|preis|prijs|precio|prezzo|preu|tarif|pvp)([\s_\-.(]|$)/i;
export function suggestEdits(text: string): EditHint[] {
  if (typeof text !== 'string') return [];
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) return [];
  const table = parseCsv(text);
  const hints: EditHint[] = [];
  for (const h of table.headers) {
    if (!PRICE_HEADER.test(h) || /unit|kg|litre|liter|per\b|par\b/i.test(h)) continue;
    const values = table.rows.map((r) => String(r[h] ?? '').trim()).filter((v) => v !== '');
    if (values.length < 5 || !values.every((v) => /^\d{3,6}$/.test(v))) continue;
    const nums = values.map(Number).sort((a, b) => a - b);
    const median = nums[Math.floor(nums.length / 2)];
    const notRound = values.filter((v) => !v.endsWith('00')).length / values.length;
    if (median >= 300 && notRound >= 0.5) hints.push({ kind: 'cents', column: h, sample: `${values[0]} → ${(Number(values[0]) / 100).toFixed(2)}` });
  }
  return hints;
}
