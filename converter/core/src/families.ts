// Product families of a scraped catalogue (roadmap phase 6, 28/10/2026):
//  - an option axis a source names generically (« option », « variant ») is named from its values (Taille,
//    Contenance, else Variante) — never imported as « option » in the store;
//  - colourways a shop sells as separate pages (each colour its own address and reference, the others listed as
//    siblings on each page) become ONE parent product when the file holds them all: a Couleur axis (each page's
//    colour, with its pictures) × the size axis read on the page, every combination a variant. A family where one
//    page has no colour, or whose pages have different axes, is left as it is and said: nothing is guessed.
import type { CanonProduct, CanonVariant, Warning } from './types';
import { axisNameFor, isGenericAxis } from '../knowledge-proposal/variant-text.mjs';

/** Renames generic option axes from their values (in place). */
export function nameGenericAxes(products: CanonProduct[]): Warning[] {
  let n = 0;
  for (const p of products) {
    const taken = new Set(p.options.map((o) => o.name.toLowerCase()));
    for (const o of p.options) {
      // A « taille » axis of volumes (10 ml, 25 ml) is a Contenance; a source's lowercase name gets its capital.
      const sizeOfVolumes = /^(taille|size|maat|talla|grösse|groesse)$/i.test(o.name.trim()) && axisNameFor(o.values) === 'Contenance';
      if (!isGenericAxis(o.name) && !sizeOfVolumes) {
        o.name = o.name.charAt(0).toUpperCase() + o.name.slice(1);
        continue;
      }
      const name = axisNameFor(o.values);
      if (name.toLowerCase() === o.name.toLowerCase() || taken.has(name.toLowerCase())) continue;
      taken.delete(o.name.toLowerCase()); taken.add(name.toLowerCase());
      o.name = name; n++;
    }
  }
  return n ? [{ code: 'option_axis_named', params: { count: n } }] : [];
}

/**
 * A page listing two or more axes as one flat list (each entry one value of one axis: the colours, then the sizes)
 * gives one variant per VALUE; the store needs one per COMBINATION. Every combination is built (the site's
 * availability per combination is not known); a value's own price and picture go to its combinations; no SKU is
 * invented (the entries' codes belong to single values), which the notice says.
 */
export function combineFlatAxes(products: CanonProduct[]): Warning[] {
  let n = 0; let made = 0;
  for (const p of products) {
    if (p.options.length < 2 || p.variants.length < 2) continue;
    const single = p.variants.every((v) => v.optionValues.filter((x) => String(x ?? '').trim() !== '').length === 1);
    if (!single) continue;
    const byValue = p.options.map((_, oi) => new Map(p.variants.filter((v) => String(v.optionValues[oi] ?? '').trim()).map((v) => [v.optionValues[oi], v])));
    let combos: string[][] = [[]];
    for (const o of p.options) combos = combos.flatMap((c) => o.values.map((val) => [...c, val]));
    const base = p.variants[0];
    // The product's price is the one most values inherit; a value priced otherwise (« L : 55 ») gives its price.
    const counts = new Map<number, number>();
    for (const v of p.variants) if (v.price != null) counts.set(v.price, (counts.get(v.price) ?? 0) + 1);
    const usual = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    p.variants = combos.map((vals) => {
      const own = vals.map((val, oi) => byValue[oi].get(val)).filter((v): v is CanonVariant => !!v);
      const priced = own.find((v) => v.price != null && v.price !== usual) ?? own.find((v) => v.price != null);
      const pictured = own.find((v) => v.imageSrc);
      const nv = structuredClone(base) as CanonVariant;
      nv.optionValues = vals; nv.sku = '';
      nv.price = priced ? priced.price : base.price;
      nv.compareAtPrice = priced ? priced.compareAtPrice : base.compareAtPrice;
      nv.imageSrc = pictured ? pictured.imageSrc : (p.images[0]?.src ?? '');
      if (pictured && pictured.images) nv.images = structuredClone(pictured.images);
      return nv;
    });
    n++; made += combos.length;
  }
  return n ? [{ code: 'variants_combined', params: { count: n, variants: made } }] : [];
}

const COLOUR = /^(couleur|coloris|colou?r|kleur|farbe|color)$/i;
type Ext = { siblings?: Array<Record<string, unknown>>; source_url?: string } & Record<string, unknown>;
const extOf = (p: CanonProduct): Ext => ((p.sourceExtension as Record<string, Ext> | undefined)?.eloshon ?? {}) as Ext;
const idOf = (p: CanonProduct): string => String(p.identity?.sourceId ?? '').trim();

/** A page's colour: its colour attribute, else the name its own entry carries in the sibling list. */
function colourOf(p: CanonProduct): string {
  const attr = (p.attributesRich ?? []).find((a) => COLOUR.test(String(a.name || '').trim()));
  const v = attr && Array.isArray(attr.values) ? String(attr.values[0] ?? '').trim() : '';
  if (v) return v;
  const own = (extOf(p).siblings ?? []).find((s) => String(s.code ?? '') === idOf(p));
  return own ? String(own.name ?? '').trim() : '';
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A title without its trailing colour (« X — bleu », « X - Bleu », « X, bleu », « X (bleu) »); unchanged otherwise. */
export function withoutColour(title: string, colour: string): string {
  const c = escapeRe(colour.trim());
  if (!c) return title;
  const out = title.replace(new RegExp(`\\s*(?:[—–\\-,|/:]\\s*${c}|\\(\\s*${c}\\s*\\))\\s*$`, 'i'), '').trim();
  return out || title;
}

/** Groups colour siblings present in the same file into one parent product each (returns the new list). */
export function groupColourFamilies(products: CanonProduct[]): { products: CanonProduct[]; warnings: Warning[] } {
  const byId = new Map<string, number>();
  products.forEach((p, i) => { const id = idOf(p); if (id && !byId.has(id)) byId.set(id, i); });
  // Families: pages linked by their sibling lists (union-find over the file's own products).
  const parent = products.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  products.forEach((p, i) => {
    for (const r of p.merchandising?.related ?? []) { const j = byId.get(String(r)); if (j != null) parent[find(j)] = find(i); }
  });
  const families = new Map<number, number[]>();
  products.forEach((_, i) => { const r = find(i); families.set(r, [...(families.get(r) ?? []), i]); });
  const warnings: Warning[] = [];
  const merged = new Map<number, CanonProduct>(); const dropped = new Set<number>();
  let grouped = 0; let left = 0;
  for (const members of families.values()) {
    if (members.length < 2) continue;
    const ps = members.map((i) => products[i]);
    const colours = ps.map(colourOf);
    const axes = ps.map((p) => p.options.map((o) => o.name.toLowerCase()).join('|'));
    // Nothing is guessed: every page needs its own colour, distinct, and the same other axes.
    if (colours.some((c) => !c) || new Set(colours.map((c) => c.toLowerCase())).size !== colours.length || new Set(axes).size !== 1 || ps[0].options.length >= 3) { left += ps.length; continue; }
    const head = structuredClone(ps[0]) as CanonProduct;
    const other = ps[0].options.map((o) => o.name);
    head.options = [{ name: 'Couleur', values: colours }, ...other.map((name) => ({ name, values: [...new Set(ps.flatMap((p) => p.options.find((o) => o.name === name)?.values ?? []))] }))];
    const variants: CanonVariant[] = [];
    ps.forEach((p, k) => {
      const firstImage = p.images[0]?.src ?? '';
      for (const v of p.variants) {
        const nv = structuredClone(v) as CanonVariant;
        nv.optionValues = [colours[k], ...(p.options.length ? v.optionValues : [])];
        if (!nv.imageSrc) nv.imageSrc = firstImage;
        if (!nv.images || !nv.images.length) nv.images = structuredClone(p.images);
        variants.push(nv);
      }
    });
    head.variants = variants;
    // The parent is the model, not its first colour: « Housse en lin — bleu » → « Housse en lin » (the colour only
    // when the page title ends with it after a separator), and the same in its handle.
    head.title = withoutColour(head.title, colours[0]);
    const slugColour = colours[0].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (slugColour && head.handle) head.handle = head.handle.replace(new RegExp(`-${slugColour}(?=-|$)`), '');
    const seen = new Set<string>();
    head.images = ps.flatMap((p) => p.images).filter((im) => (seen.has(im.src) ? false : (seen.add(im.src), true))).map((im, i) => ({ ...structuredClone(im), position: i + 1 }));
    const ids = new Set(ps.map(idOf));
    head.merchandising = { ...(head.merchandising ?? {}), related: (head.merchandising?.related ?? []).filter((r) => !ids.has(String(r))) };
    head.attributesRich = (head.attributesRich ?? []).filter((a) => !COLOUR.test(String(a.name || '').trim()));
    const ext = (head.sourceExtension ?? {}) as Record<string, Record<string, unknown>>;
    ext.eloshon = { ...(ext.eloshon ?? {}), family: ps.map((p) => ({ sourceId: idOf(p), colour: colourOf(p), source_url: extOf(p).source_url ?? '' })) };
    head.sourceExtension = ext as CanonProduct['sourceExtension'];
    merged.set(members[0], head);
    for (const i of members.slice(1)) dropped.add(i);
    grouped++;
  }
  if (grouped) warnings.push({ code: 'colour_family_grouped', params: { count: grouped } });
  if (left) warnings.push({ code: 'colour_family_not_grouped', params: { count: left } });
  if (!grouped) return { products, warnings };
  return { products: products.flatMap((p, i) => (dropped.has(i) ? [] : [merged.get(i) ?? p])), warnings };
}
