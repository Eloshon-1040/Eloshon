// CSV core for the migration converter. Pure, dependency-free, and shared by the
// browser (instant preview + free file) and the edge function (paid full file),
// so the preview is byte-for-byte what she pays for.
//
// Beyond RFC 4180 parsing this repairs the damage real exports carry — because
// the community "fix" is to launder the file through Google Sheets, and we
// refuse to send anyone away to re-save their export before we will read it:
//   • a UTF-8 BOM at the start of the file
//   • CRLF / lone-CR line endings
//   • curly quotes and other Word/Excel "smart" punctuation
//   • Windows-1252 / Latin-1 mojibake (Ã© for é) from a mis-saved UTF-8 file
//   • stray whitespace and embedded newlines inside cells (seen in real Woo
//     customer exports: "Lori \n\n")
// Leading zeros are preserved by keeping every value a STRING — we never coerce
// a SKU like "00342" to a number, which is how spreadsheets lose them.

export type Row = Record<string, string>;
// `malformed` = spreadsheet row numbers whose field count EXCEEDS the header
// count — the classic "column shift" (an unescaped comma in a text field, or the
// wrong separator) that makes an import fail with a nonsense message like
// "available_for_order contains an image URL". We surface it before producing
// anything.
// `repaired` names the damage parseCsv undid so the caller can tell the user (e.g. 'wrapped_rows').
export type Table = { headers: string[]; rows: Row[]; malformed: number[]; repaired?: string[]; unwrappedLines?: number[] };

// ── Smart-punctuation + mojibake repair ──────────────────────────────────────
// Smart punctuation and scalar cleaning live in the knowledge runtime's shared
// value module, so the generic parser reads a cell exactly like these parsers.
import { cleanScalar } from '../knowledge-proposal/values.mjs';
import { canonicalizeHeaders } from './localized-headers';
export { cleanScalar };

// Detect the classic "UTF-8 bytes decoded as Latin-1" mojibake (Ã©, Ã¨, â€™ …)
// and undo it. Only applied when the signature is present, so clean text is
// untouched.
const MOJIBAKE_RE = /Ã[-¿]|â€|Â[\u00A0-¿]/;
function fixMojibake(s: string): string {
  if (!MOJIBAKE_RE.test(s)) return s;
  try {
    // Re-encode the string's chars as bytes (Latin-1) and decode as UTF-8.
    const bytes = new Uint8Array(Array.from(s, (ch) => ch.charCodeAt(0) & 0xff));
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    // Keep the repair only if it didn't introduce replacement chars.
    return decoded.includes('�') ? s : decoded;
  } catch {
    return s;
  }
}

// ── Parse ────────────────────────────────────────────────────────────────────
// Returns raw string cells (no per-value cleaning — the transform decides which
// fields are scalars vs HTML). BOM, CRLF and mojibake are handled at the file
// level here.
// Sniff the delimiter. Shopify/Woo use commas, BigBuy and PrestaShop exports are
// semicolon-separated, some tools use tabs. The first line alone is a poor judge
// (a header like "Prix (EUR, TTC);Description, courte" holds more commas than
// semicolons), so up to 20 records vote: for each candidate we look at how many
// of them have the SAME non-zero count outside quotes; the most consistent wins,
// then the highest count, then ';' > tab > ','.
function sniffDelimiter(text: string): ',' | ';' | '\t' {
  const records: string[] = [];
  let rec = '', q = false;
  for (let i = 0; i < text.length && records.length < 20; i++) {
    const c = text[i];
    if (c === '"') { q = !q; rec += c; }
    else if ((c === '\n' || c === '\r') && !q) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (rec.trim() !== '') records.push(rec);
      rec = '';
    } else rec += c;
  }
  if (rec.trim() !== '' && records.length < 20) records.push(rec);

  const countOutsideQuotes = (line: string, ch: string): number => {
    let n = 0, inQ = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') inQ = !inQ;
      else if (line[i] === ch && !inQ) n++;
    }
    return n;
  };
  let best: ',' | ';' | '\t' = ',';
  let bestVotes = 0, bestCount = 0;
  for (const ch of [';', '\t', ','] as const) {
    const freq = new Map<number, number>();
    for (const line of records) {
      const n = countOutsideQuotes(line, ch);
      if (n > 0) freq.set(n, (freq.get(n) ?? 0) + 1);
    }
    for (const [n, votes] of freq) {
      if (votes > bestVotes || (votes === bestVotes && n > bestCount)) { best = ch; bestVotes = votes; bestCount = n; }
    }
  }
  return best;
}

// Text → records of raw cells, RFC 4180 with the lenient quote rules above.
function tokenize(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let field = '', row: string[] = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        const n = text[i + 1];
        if (n === '"') { field += '"'; i++; }
        else if (n === undefined || n === delim || n === '\n' || n === '\r') inQuotes = false;
        else field += c; // 12" pipe inside a quoted cell: a literal inch mark
      } else field += c;
    } else if (c === '"' && field === '') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c === '\r') {
      // swallow; the following \n (if any) closes the row
      if (text[i + 1] !== '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Two columns with the same header (Image, Image, Image) must not overwrite each
// other: the 2nd and later are suffixed "__2", "__3" so every value survives and
// the recognizer can read them as one numbered family.
function uniqueHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h) => {
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return n === 1 || h === '' ? h : `${h}__${n}`;
  });
}

export function parseCsv(input: string, unwrap = true, forceDelim?: string): Table {
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  text = fixMojibake(text);
  const delim = forceDelim ?? sniffDelimiter(text);

  const rows = tokenize(text, delim);

  if (rows.length === 0) return { headers: [], rows: [], malformed: [] };
  const localized = canonicalizeHeaders(rows[0].map((h) => h.trim()));
  const headers = uniqueHeaders(localized.headers);
  const out: Row[] = [];
  const malformed: number[] = [];
  const unwrappedLines: number[] = [];
  for (let r = 1; r < rows.length; r++) {
    let raw = rows[r];
    // A line pasted into the first cell by a spreadsheet ("a,b,c,..." in column A, the other
    // cells empty) is read again with the file's own delimiter and takes its real columns.
    if (headers.length >= 4 && raw[0] !== undefined && raw[0].split(delim).length > headers.length / 2 && raw.slice(1).every((c) => c.trim() === '')) {
      const again = tokenize(raw[0], delim)[0] ?? [];
      if (again.length >= headers.length - 3 && again.length <= headers.length + 3) { raw = again; unwrappedLines.push(r + 1); }
    }
    // Skip fully-blank lines (a trailing newline, or Excel's empty tail rows
    // such as ";;;;").
    if (raw.every((cell) => cell.trim() === '')) continue;
    // More fields than headers ⇒ a column shift (unescaped delimiter). Record
    // the spreadsheet row number so we can name it.
    if (raw.length > headers.length) malformed.push(r + 1);
    const obj: Row = {};
    headers.forEach((h, i) => { obj[h] = raw[i] ?? ''; });
    out.push(obj);
  }
  const repaired = [...(localized.locale ? [`headers:${localized.locale}`] : []), ...(unwrappedLines.length ? ['wrapped_lines'] : [])];
  const table: Table = { headers, rows: out, malformed, ...(repaired.length ? { repaired } : {}), ...(unwrappedLines.length ? { unwrappedLines } : {}) };
  return (unwrap && unwrapWrappedRows(table)) || table;
}

// A CSV re-saved by a spreadsheet in a locale whose separator is ";" can come back
// with every LINE wrapped into one quoted cell followed by a run of empty
// columns:   "ID,Type,SKU,Name";;;;;;   — the real header and rows are the text
// of the first cell. When the first column carries all the content and each of its
// cells still holds the real delimiter, that text is parsed again.
function unwrapWrappedRows(t: Table): Table | null {
  const named = t.headers.filter((h) => h !== '');
  if (named.length !== 1 || t.rows.length === 0) return null;
  const first = named[0];
  const delim = [',', ';', '\t'].find((d) => first.split(d).length - 1 >= 2);
  if (!delim) return null;
  const lone = t.rows.filter((r) => (r[first] ?? '') !== '' && Object.entries(r).every(([k, v]) => k === first || v === ''));
  if (lone.length < t.rows.length * 0.8) return null;
  const text = [first, ...lone.map((r) => r[first])].join('\n');
  // the delimiter is known from the header cell: do not let the cell contents (HTML entities…) vote again
  const again = parseCsv(text, false, delim);
  if (again.headers.length < 3) return null;
  return { ...again, repaired: [...(again.repaired ?? []), 'wrapped_rows'] };
}

// ── Serialize ────────────────────────────────────────────────────────────────
function quote(v: string): string {
  const s = v ?? '';
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function serializeCsv(headers: string[], rows: Row[]): string {
  const lines = [headers.map(quote).join(',')];
  for (const r of rows) lines.push(headers.map((h) => quote(r[h] ?? '')).join(','));
  // CRLF — the line ending Excel and both platforms expect on import.
  return lines.join('\r\n') + '\r\n';
}

// Split a delimited cell, tolerating the pipe-with-spaces Woo uses ("A | B")
// and plain comma lists ("A, B"). Empty entries dropped.
export function splitList(v: string, sep: ',' | '|'): string[] {
  if (!v) return [];
  return v.split(sep).map((s) => s.trim()).filter((s) => s.length > 0);
}

// WooCommerce's own CSV importer/exporter escape a comma INSIDE a value of a
// comma-separated list as `\,` (WC_Product_CSV_Importer::explode_values /
// WC_Product_CSV_Exporter::implode_values). A category named "Baby, Kind &
// Spielzeug" would otherwise split in two. Mirror both sides exactly.
export function splitWooList(v: string): string[] {
  if (!v) return [];
  const SEP = '\u0000';
  return v.replace(/\\,/g, SEP).split(',').map((s) => s.split(SEP).join(',').trim()).filter((s) => s.length > 0);
}
export function joinWooList(values: string[]): string {
  return values.map((s) => s.replace(/,/g, '\\,')).join(', ');
}
