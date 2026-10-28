/**
 * Values a page keeps in its embedded state (window.__PRELOADED_STATE__, Apollo cache,
 * Next/Nuxt data…) rather than in its HTML: many shops render the description block only
 * in the browser, while the page they send already holds the text in its state. These
 * helpers find such a text for the PAGE's product (never a related product's), and the
 * state key a designated block came from. Portable, no site rule.
 */

/** Keys that hold a product's long description, across shops and languages (compared lower-case, without _ or -). */
export const DESCRIPTION_KEYS = new Set(['description', 'longdescription', 'productdescription', 'fulldescription', 'marketingdescription', 'marketingtext', 'descriptionhtml', 'detaileddescription', 'beschreibung', 'omschrijving', 'descripcion']);
const ID_KEYS = new Set(['id', 'productid', 'sku', 'code', 'articlenumber', 'productnumber', 'itemid', 'mpn', 'gtin', 'ean']);
const normKey = (k) => String(k).toLowerCase().replace(/[_-]/g, '');

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return ' '; } }
  return ENT[e.toLowerCase()] ?? m;
});

/** HTML (or plain) text → lines: paragraphs, headings and list items on their own line, "• " before items. */
export function htmlToText(s) {
  if (s == null) return '';
  let t = String(s);
  if (!/<[a-z][^>]*>/i.test(t)) return t.split(/\r?\n/).map((l) => decode(l).replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  t = t.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol|section|article|blockquote)>/gi, '\n')
    .replace(/<(p|div|h[1-6]|tr|ul|ol|section|article|blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return t.split('\n').map((l) => decode(l).replace(/\s+/g, ' ').trim()).filter((l) => l && l !== '•').join('\n');
}

const norm = (s) => htmlToText(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Every string of the state with its key path and its owner object. */
function* strings(root, maxNodes = 400000) {
  let seen = 0;
  const stack = [{ n: root, path: [], owner: null }];
  while (stack.length) {
    const { n, path, owner } = stack.pop();
    if (++seen > maxNodes) return;
    if (typeof n === 'string') { yield { value: n, path, owner }; continue; }
    if (!n || typeof n !== 'object' || path.length > 40) continue;
    if (Array.isArray(n)) { for (let i = n.length - 1; i >= 0; i--) stack.push({ n: n[i], path: [...path, i], owner }); continue; }
    for (const [k, v] of Object.entries(n)) stack.push({ n: v, path: [...path, k], owner: n });
  }
}

/** Does this value belong to the page's product? (an id of the product in its key path, or in its owner's id fields) */
function owned(hit, ids) {
  if (!ids.length) return null; // unknown
  const p = hit.path.map(String).join('/');
  if (ids.some((id) => p.includes(id))) return true;
  const o = hit.owner || {};
  for (const [k, v] of Object.entries(o)) if (ID_KEYS.has(normKey(k)) && (typeof v === 'string' || typeof v === 'number') && ids.includes(String(v))) return true;
  return false;
}

/**
 * The longest text of the page product held under one of `keys` in the state.
 * @param {any[]} payloads  decoded JSON values of the page (pageJsonPayloads().json)
 * @param {{keys?:Set<string>, productIds?:string[], minLen?:number}} o
 * @returns {{text:string, path:string}|null}
 */
export function stateTextFor(payloads, { keys = DESCRIPTION_KEYS, productIds = [], minLen = 60 } = {}) {
  const ids = [...new Set((productIds || []).map((x) => String(x || '').trim()).filter((x) => x.length >= 3))];
  const mine = []; const unknown = [];
  for (const root of payloads || []) {
    for (const hit of strings(root)) {
      const leaf = hit.path[hit.path.length - 1];
      if (typeof leaf !== 'string' || !keys.has(normKey(leaf))) continue;
      const text = htmlToText(hit.value);
      if (text.length < minLen) continue;
      const own = owned(hit, ids);
      if (own === true) mine.push({ text, path: hit.path.join('.') });
      else if (own === null) unknown.push({ text, path: hit.path.join('.') });
    }
  }
  const pool = mine.length ? mine : (new Set(unknown.map((x) => x.text)).size === 1 ? unknown : []);
  if (!pool.length) return null;
  return pool.reduce((a, b) => (b.text.length > a.text.length ? b : a));
}

/**
 * The state key that holds a block the user designated: the key of the string whose text starts
 * like the block's text. Lets a rule read the state when the shop renders the block in the browser only.
 * @returns {string|null}
 */
export function stateKeyForText(payloads, blockText) {
  const want = norm(blockText).slice(0, 80);
  if (want.length < 20) return null;
  let best = null;
  for (const root of payloads || []) {
    for (const hit of strings(root)) {
      const leaf = hit.path[hit.path.length - 1];
      if (typeof leaf !== 'string' || hit.value.length < 20) continue;
      const got = norm(hit.value);
      if (!got.includes(want.slice(0, 40))) continue;
      // A fragment (a heading, one bold run) is not where the block lives: the text must be of the block's size.
      if (got.length < want.length || htmlToText(hit.value).length < htmlToText(blockText).length * 0.5) continue;
      if (!best || hit.value.length > best.len) best = { key: leaf, len: hit.value.length };
    }
  }
  return best ? best.key : null;
}

/**
 * Ids of the page's product, to tell its values apart from a related product's: the number
 * that ends the page URL ("…-2195579.html") and the sku / gtin / mpn / productID of a JSON-LD Product.
 * @param {{url?:string, jsonLd?:any[]}} o
 */
export function productIdsOf({ url = '', jsonLd = [] } = {}) {
  const ids = [];
  try { const m = new URL(url).pathname.match(/(\d{4,})(?:\.[a-z]{2,5})?\/?$/i); if (m) ids.push(m[1]); } catch { /* no url */ }
  const visit = (n, d) => {
    if (!n || typeof n !== 'object' || d > 6) return;
    if (Array.isArray(n)) { n.forEach((x) => visit(x, d + 1)); return; }
    const t = [].concat(n['@type'] || []).map((x) => String(x).toLowerCase());
    if (t.includes('product') || t.includes('productgroup')) for (const k of ['sku', 'gtin13', 'gtin', 'mpn', 'productID']) if (n[k] != null && String(n[k]).trim()) ids.push(String(n[k]).trim());
    for (const v of Object.values(n)) if (v && typeof v === 'object') visit(v, d + 1);
  };
  visit(jsonLd, 0);
  return [...new Set(ids)];
}
