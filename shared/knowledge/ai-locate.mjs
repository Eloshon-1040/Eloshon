/**
 * AI ONCE PER SITE (the "generate once, verify, replay" design of Crawl4AI's generate_schema and the
 * AutoScraper paper): the model is shown ONE product page, condensed (no scripts / styles, every useful
 * element numbered, long texts cut, repeated siblings collapsed), plus the values we already know and a
 * summary of the page's embedded state. It answers with the NUMBER of the element holding each missing
 * field (or a path in the state). We turn those elements into ordinary site rules (fingerprint + selector),
 * check them on other product pages, and replay them afterwards WITHOUT the model.
 * Portable (browser + linkedom), model-agnostic: the call itself is injected.
 */

const DROP = /^(script|style|noscript|template|svg|iframe|canvas|video|audio|head|link|meta|header|footer|nav)$/i;
const KEEP_ATTR = ['id', 'itemprop', 'aria-label', 'data-testid', 'role', 'alt', 'title'];
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** The fields the model may be asked to locate, with what each one means. */
export const AI_FIELDS = {
  name: 'the name / title of THIS product (usually its main heading)',
  price: 'the current selling price of THIS product (the amount the buyer pays, with its currency)',
  list_price: 'the former / crossed-out price before a discount, only if the page shows one',
  ean: 'the EAN / GTIN barcode number of this product, only if the page shows it',
  description: 'the product description block (marketing text, paragraphs, bullet points) — the whole block',
  technical_specs: 'the technical specifications (a table / list of label → value pairs) — the whole block',
  variants: 'the product options the buyer chooses (sizes, volumes, colours) — the container of all options',
  brand: 'the brand / manufacturer name of THIS product',
  image: 'the main product image (or the gallery container)',
  category: 'the breadcrumb / category trail of the product',
  sku: 'the product reference / article number shown on the page',
  availability: 'the stock / availability statement of this product',
};

/**
 * The page as the model sees it: an indented outline, one numbered element per line.
 * @param {Document} doc
 * @returns {{ text:string, nodes:Map<number,Element> }}
 */
export function condensePage(doc, { maxChars = 60000, maxText = 140 } = {}) {
  const nodes = new Map(); let n = 0; const lines = []; let size = 0;
  const body = doc.body || doc.documentElement;
  const sig = (el) => `${el.tagName}.${el.getAttribute('class') || ''}`;
  const walk = (el, depth) => {
    if (size > maxChars || !el || el.nodeType !== 1 || DROP.test(el.tagName)) return;
    const tag = String(el.tagName).toLowerCase();
    const own = oneLine([...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join(' '));
    const attrs = KEEP_ATTR.map((a) => { const v = el.getAttribute(a); return v && v.length <= 60 ? `${a}="${oneLine(v)}"` : null; }).filter(Boolean);
    const cls = (el.getAttribute('class') || '').split(/\s+/).filter((c) => c && c.length <= 30 && !/\d{3,}|[0-9a-f]{6,}/i.test(c)).slice(0, 2);
    // A block of several text elements (a description of paragraphs, an option group) gets a number too, so
    // the model can point at the WHOLE block rather than one of its paragraphs.
    const block = el.children.length >= 2 && oneLine(el.textContent).length >= 20;
    const meaningful = own || tag === 'img' || attrs.length || block || /^(table|ul|ol|dl|select|section|article)$/.test(tag);
    if (meaningful) {
      const id = ++n; nodes.set(id, el);
      const line = `${'  '.repeat(Math.min(depth, 12))}[${id}] <${tag}${cls.length ? ` .${cls.join('.')}` : ''}${attrs.length ? ` ${attrs.join(' ')}` : ''}>${tag === 'img' ? ` src=${(el.getAttribute('src') || el.getAttribute('data-src') || '').slice(0, 80)}` : ''}${own ? ` ${own.slice(0, maxText)}${own.length > maxText ? '…' : ''}` : ''}`;
      lines.push(line); size += line.length + 1;
    }
    // Long runs of the same sibling (a product carousel, a long list) are shown by their first 3.
    const kids = [...el.children]; let run = 0; let prev = null;
    for (const k of kids) {
      const s = sig(k); run = s === prev ? run + 1 : 0; prev = s;
      if (run === 3) { lines.push(`${'  '.repeat(Math.min(depth + 1, 12))}… (more of the same)`); size += 30; }
      if (run >= 3) { continue; }
      walk(k, depth + (meaningful ? 1 : 0));
    }
  };
  walk(body, 0);
  return { text: lines.join('\n'), nodes };
}

/** Short key paths of the page's embedded state worth pointing at (long texts, lists of objects). */
export function stateSummary(payloads, { max = 40, maxChars = 4000 } = {}) {
  const out = []; let size = 0;
  const walk = (v, path, depth) => {
    if (out.length >= max || size > maxChars || depth > 12 || v == null) return;
    if (typeof v === 'string') { if (v.length >= 80) { const line = `${path} = "${oneLine(v.replace(/<[^>]+>/g, ' ')).slice(0, 70)}…"`; out.push(line); size += line.length; } return; }
    if (Array.isArray(v)) { if (v.length >= 2 && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) { const line = `${path}[] (${v.length} objects: ${Object.keys(v[0]).slice(0, 8).join(', ')})`; out.push(line); size += line.length; } v.slice(0, 2).forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1)); return; }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v).slice(0, 60)) walk(x, path ? `${path}.${k}` : k, depth + 1);
  };
  (payloads || []).forEach((p, i) => walk(p, `#${i}`, 0));
  return out.join('\n');
}

/** The single prompt: which numbered element holds each missing field. */
export function buildLocatePrompt({ condensed, url = '', missing = [], known = {}, state = '' }) {
  const want = missing.filter((f) => AI_FIELDS[f]);
  return [
    'You locate fields on ONE e-commerce product page. The page is given as an outline: one element per line,',
    '"[N] <tag .classes attributes> text". Answer with the NUMBER N of the element that CONTAINS each field',
    '(for a block — description, specifications, options — the smallest element containing the WHOLE block).',
    'If the field is not visible in the outline but clearly present in the page state, answer its state path instead.',
    'If a field is absent, answer null. Never invent. Answer with JSON only, no prose.',
    '',
    `Page URL: ${url}`,
    `Already known on this page: ${JSON.stringify(known).slice(0, 600)}`,
    '',
    'Fields to locate:',
    ...want.map((f) => `- ${f}: ${AI_FIELDS[f]}`),
    '',
    'Answer format: {"fields": {' + want.map((f) => `"${f}": {"e": N} | {"state": "path"} | null`).join(', ') + '}}',
    '',
    state ? `Page state (paths with a sample value):\n${state}\n` : '',
    'Page outline:',
    condensed,
  ].join('\n');
}

/** The model's answer → { field: {e:number} | {state:string} } (anything malformed dropped). */
export function parseLocateAnswer(text, { missing = [] } = {}) {
  const s = String(text || ''); const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return {};
  let j; try { j = JSON.parse(s.slice(a, b + 1)); } catch { return {}; }
  const f = (j && j.fields) || {}; const out = {};
  for (const k of missing) {
    const v = f[k];
    if (v && Number.isInteger(v.e) && v.e > 0) out[k] = { e: v.e };
    else if (v && typeof v.state === 'string' && /^[#\w.[\]$:-]{1,200}$/.test(v.state)) out[k] = { state: v.state };
  }
  return out;
}
