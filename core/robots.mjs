/**
 * robots.txt reader — used for TWO things only:
 *   1. discover declared Sitemap: URLs (useful),
 *   2. surface Disallow rules as INFORMATION in the probe/report.
 *
 * Per project directive, robots is not a hard blocker in the engine. It still
 * lets the operator see what a site asks of crawlers so they can decide.
 */

export function parseRobots(txt) {
  const sitemaps = [];
  /** @type {{disallow:string[], allow:string[], crawlDelay:number|null}} */
  const star = { disallow: [], allow: [], crawlDelay: null };
  let appliesToStar = false;
  for (const rawLine of String(txt || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [k0, ...rest] = line.split(':');
    const key = k0.toLowerCase().trim();
    const val = rest.join(':').trim();
    if (key === 'sitemap') { if (val) sitemaps.push(val); continue; }
    if (key === 'user-agent') { appliesToStar = (val === '*'); continue; }
    if (!appliesToStar) continue;
    if (key === 'disallow') star.disallow.push(val);
    else if (key === 'allow') star.allow.push(val);
    else if (key === 'crawl-delay') { const n = parseFloat(val); if (Number.isFinite(n)) star.crawlDelay = n; }
  }
  return { sitemaps, star };
}

/** Informational: is `pathname` covered by a `*` Disallow rule? (longest-match, Allow wins) */
export function isDisallowed(robots, pathname) {
  if (!robots) return false;
  const match = (rules) => rules
    .filter((r) => r !== '')
    .map((r) => r.replace(/\*+/g, '.*').replace(/[.+?^${}()|[\]\\]/g, (m) => (m === '.*' ? m : `\\${m}`)))
    .filter((re) => { try { return new RegExp('^' + re).test(pathname); } catch { return false; } })
    .reduce((max, re) => Math.max(max, re.length), -1);
  const dis = match(robots.star.disallow);
  const alw = match(robots.star.allow);
  return dis > alw;
}
