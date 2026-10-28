/**
 * What the panel shows under « Compris : … » after a 🎯: the sample of a designated block, one line per
 * entry, typed by field. The sample is whatever the reader returned — ProductImage objects for pictures,
 * {name, value} pairs for specifications, variant entries, a text — and this is the ONLY place that turns
 * it into lines, so no shape ever prints a property it does not have ("undefined").
 * Portable (no DOM): the panel renders the lines, the tests check them.
 */
import { imageUrls, isProductImage } from '../extract/images.mjs';

const text = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();

/**
 * @param {string} field
 * @param {any} sample  what pick() returned (array of entries, or a text)
 * @returns {Array<{text:string, image?:string}>}  image: a picture address to show as a thumbnail
 */
export function previewLines(field, sample) {
  if (sample == null) return [];
  if (!Array.isArray(sample)) { const t = text(sample); return t ? [{ text: t }] : []; }
  const out = [];
  for (const p of sample) {
    if (p == null) continue;
    if (typeof p === 'string' || typeof p === 'number') { const t = text(p); if (t) out.push(/^https?:\/\//i.test(t) ? { text: t, image: t } : { text: t }); continue; }
    if (typeof p !== 'object') continue;
    // A picture (ProductImage, or any object with a url / src).
    if (isProductImage(p) || typeof p.url === 'string' && !('name' in p) || typeof p.src === 'string') {
      const url = imageUrls([p])[0] || text(p.src);
      if (url) out.push({ text: `${p.position != null ? `${p.position}. ` : ''}${url}${p.alt ? ` — ${text(p.alt)}` : ''}`, image: url });
      continue;
    }
    // A specification pair.
    if (p.value != null && p.name != null) { out.push({ text: `${text(p.name)} : ${text(p.value)}` }); continue; }
    // A variant entry: "30 ml — 49.99 € (épuisé) · CODE".
    if (p.name != null) {
      const price = p.price != null ? ` — ${text(p.price)} ${text(p.currency)}`.replace(/\s+$/, '') : '';
      out.push({ text: `${text(p.name)}${price}${p.availability === 'OutOfStock' ? ' (épuisé)' : ''}${p.code ? ` · ${text(p.code)}` : ''}` });
      continue;
    }
    // A price { price, currency }.
    if (p.price != null) { out.push({ text: `${text(p.price)} ${text(p.currency)}`.trim() }); continue; }
    // Anything else: its readable fields, never "[object Object]".
    const t = Object.entries(p).filter(([, v]) => v != null && typeof v !== 'object').map(([k, v]) => `${k} : ${text(v)}`).join(' · ');
    if (t) out.push({ text: t });
  }
  return out;
}

/** The lines as one text (the sample box), for a panel without thumbnails. */
export const previewText = (field, sample) => previewLines(field, sample).map((l) => l.text).join('\n');
