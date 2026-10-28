/**
 * Sitemap discovery. Handles sitemap.xml, sitemap index (nested), gzipped
 * sitemaps (.gz, native decompression via the fetcher), and multiple product
 * sitemaps. When product-specific sitemaps exist, they are preferred over
 * generic ones so we discover product URLs without crawling the whole site.
 */

/** Extract <loc> values from a sitemap/urlset/sitemapindex XML string. */
export function parseLocs(xml) {
  const locs = [];
  const re = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const v = m[1].trim().replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
    if (v) locs.push(v);
  }
  return locs;
}

export function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(xml);
}

const defaultLooksProduct = (u) => /product|produit|artikel|-p-|\/p\//i.test(u);

/**
 * Discover candidate product URLs from a site's sitemaps.
 *
 * Traversal is LEAF-FIRST, not breadth-first: product-looking sitemaps are read
 * before more index files. Index-heavy catalogues (large multi-locale retailers,
 * marketplaces — e.g. a robots.txt that lists 60+ country sitemap indexes, each
 * an index of 100+ product sitemaps) previously starved: a flat FIFO queue read
 * index after index until `maxSitemaps` was spent, reaching ZERO leaf sitemaps
 * and returning zero URLs even though every product URL was one hop away. Here a
 * product-looking candidate always outranks a non-product one, indexes have
 * their own budget, and the walk stops as soon as `max` product URLs are found —
 * so one locale's product sitemaps are read instead of every country's index.
 *
 * @param {import('./http-fetcher.mjs').Fetcher} fetcher
 * @param {string} origin  e.g. https://example.com
 * @param {{ max?:number, maxSitemaps?:number, maxIndexes?:number, hint?:string[],
 *          looksLike?:(url:string)=>boolean, parseEntries?:(xml:string)=>Array<{url:string, card:object}> }} [opts]
 *   `looksLike` — what an ITEM URL / sitemap name looks like for the content type
 *   (default: a product); `parseEntries` — the entries a sitemap describes itself
 *   (a video sitemap's <video:video>): their URLs are items whatever their shape,
 *   and their cards come back as `entries` (seeds for the engine).
 *   `accept(url, sitemapUrl)` — a scope: an item URL it rejects is not kept and
 *   does not count toward `max` (counted in `rejected`); `rank(sitemapUrl)` —
 *   read order among candidates of the same tier (higher first, stable);
 *   `maxBarrenLeaves` — with `accept`, stop after this many leaf sitemaps in a
 *   row that gave no accepted URL (bounds a scope nothing in the site matches).
 * @returns {Promise<{ urls:string[], sitemapsRead:string[], notes:string[], entries:Array<{url:string, card:object}>,
 *          sources:Map<string,string>, truncated:boolean, rejected:number }>}
 */
export async function discoverFromSitemaps(fetcher, origin, opts = {}) {
  const looksProduct = typeof opts.looksLike === 'function' ? opts.looksLike : defaultLooksProduct;
  const entries = [];
  const max = opts.max ?? 5000;
  const maxSitemaps = opts.maxSitemaps ?? 60;
  const maxIndexes = opts.maxIndexes ?? 40; // guard against index-of-index bombs
  const notes = [];
  const seen = new Set();
  const sitemapsRead = [];
  const productUrls = [];
  const otherUrls = [];

  // Two priority tiers. `hot` = product-looking candidates (read first); `cold` =
  // everything else. Whether a candidate is an index or a leaf is only known
  // after fetching, so the tiers are a read-order hint, not a type. `hot` drains
  // before `cold`, so an index's product children jump ahead of sibling indexes.
  const hot = [];
  const cold = [];
  const push = (u) => { if (u && !seen.has(u)) { seen.add(u); (looksProduct(u) ? hot : cold).push(u); } };
  const rank = typeof opts.rank === 'function' ? opts.rank : null;
  const take = (tier) => {
    if (!rank || tier.length < 2) return tier.shift();
    let best = 0, bestR = rank(tier[0]);
    for (let i = 1; i < tier.length; i++) { const r = rank(tier[i]); if (r > bestR) { best = i; bestR = r; } }
    return tier.splice(best, 1)[0];
  };
  const accept = typeof opts.accept === 'function' ? opts.accept : null;
  const maxBarrenLeaves = opts.maxBarrenLeaves ?? Infinity;
  const sources = new Map();   // item URL → the sitemap file that listed it
  let rejected = 0;
  let barrenLeaves = 0;
  let truncated = false;       // more item URLs were left unread past `max`

  // Candidate entry points: robots-declared sitemaps + conventional locations.
  for (const e of [...(opts.hint || []), `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/sitemap-index.xml`]) push(e);

  let productSitemapSeen = false;
  let indexesRead = 0;
  let productChildrenFound = 0;
  while ((hot.length || cold.length) && sitemapsRead.length < maxSitemaps && productUrls.length < max) {
    if (accept && barrenLeaves >= maxBarrenLeaves) { notes.push(`sitemap scope: ${barrenLeaves} sitemap(s) in a row without an in-scope URL — stopped`); break; }
    const sm = hot.length ? take(hot) : take(cold);
    const r = await fetcher.getText(sm);
    if (!r.ok || !r.body || !/<(urlset|sitemapindex)[\s>]/i.test(r.body)) {
      if (r.status && r.status !== 404) notes.push(`sitemap ${sm} → HTTP ${r.status}`);
      continue;
    }
    sitemapsRead.push(sm);
    const locs = parseLocs(r.body);
    if (isSitemapIndex(r.body)) {
      if (indexesRead++ >= maxIndexes) { notes.push(`sitemap index budget (${maxIndexes}) reached`); continue; }
      // Enqueue children; product-looking ones land in `hot` and are read next.
      const products = locs.filter(looksProduct);
      if (products.length) { productSitemapSeen = true; productChildrenFound += products.length; }
      for (const l of locs) push(l);
    } else {
      // A leaf reached via a product-named sitemap yields product URLs even when
      // an individual <loc> carries no product keyword (generic per-locale case).
      const fromProductSm = productSitemapSeen && looksProduct(sm);
      // Entries the sitemap describes itself (a video sitemap): known items, whatever
      // the shape of their URL; their cards seed the engine.
      let known = null;
      if (typeof opts.parseEntries === 'function') {
        try {
          const ents = opts.parseEntries(r.body) || [];
          if (ents.length) { known = new Set(); for (const e of ents) { if (!e || !e.url) continue; known.add(e.url); entries.push(e); } }
        } catch { known = null; }
      }
      let acceptedHere = 0;
      for (let i = 0; i < locs.length; i++) {
        const l = locs[i];
        if (accept && !accept(l, sm)) { rejected++; continue; }
        if (!sources.has(l)) sources.set(l, sm);
        if ((known && known.has(l)) || looksProduct(l) || fromProductSm) { productUrls.push(l); acceptedHere++; }
        else otherUrls.push(l);
        if (productUrls.length >= max) { if (i < locs.length - 1) truncated = true; break; }
      }
      barrenLeaves = acceptedHere ? 0 : barrenLeaves + 1;
    }
  }
  if (productChildrenFound) notes.push(`found ${productChildrenFound} product sitemap(s)`);
  if (productUrls.length >= max && (hot.length || cold.length)) truncated = true;

  const urls = (productUrls.length ? productUrls : otherUrls).slice(0, max);
  if (!productUrls.length && otherUrls.length) notes.push('no product-specific sitemap; returning generic URLs (filter/probe recommended)');
  if (entries.length) notes.push(`${entries.length} item(s) described by the sitemap itself`);
  return { urls, sitemapsRead, notes, entries, sources, truncated, rejected };
}
