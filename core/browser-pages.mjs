/**
 * Read pages in the LOCAL browser when a site refuses plain HTTP (an anti-bot
 * waiting page) but lets a browser in. Polite and bounded, never insistent:
 *   - pages are spaced (measured: a protected shop let a browser read about four
 *     pages in a row at a human pace, then asked for a human check);
 *   - the FIRST page the site answers with a check stops the reader for the rest of
 *     the run — no manual-intervention prompt in the middle of a completion, no
 *     retry, no bypass; the products keep what the listing gave;
 *   - at most `budget` pages.
 * `stats`: pages tried, pages read (`ok`), pages asked for but not re-read (`notRead`: after a check, past the
 * budget, no browser) and the time spent (`ms`), for the report — never a silent gap.
 */
export function browserPageReader({ getSession, budget = 40, minGapMs = 3000, isStopped = () => false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const stats = { pages: 0, ok: 0, notRead: 0, ms: 0, stoppedBy: null };
  let last = 0;
  const read = async (url) => {
    if (stats.stoppedBy === 'human_check' || isStopped()) { stats.notRead++; return null; }
    if (stats.pages >= budget) { stats.stoppedBy = 'budget'; stats.notRead++; return null; }
    let s = null; try { s = getSession ? await getSession() : null; } catch { s = null; }
    if (!s || typeof s.render !== 'function') { stats.stoppedBy = stats.stoppedBy || 'browser_unavailable'; stats.notRead++; return null; }
    const wait = last + minGapMs - now();
    if (last && wait > 0) await sleep(wait);
    stats.pages++; last = now();
    const t0 = now();
    let rr = null; try { rr = await s.render(url, { intervene: false, expand: true }); } catch { rr = null; }
    stats.ms += Math.max(0, now() - t0);
    if (rr && rr.html && !(rr.block && rr.block.terminal)) { stats.ok++; return { ok: true, html: rr.html, status: rr.status || 200 }; }
    stats.notRead++;
    if (rr && rr.block && rr.block.terminal) { stats.stoppedBy = 'human_check'; return { ok: false, status: rr.status, blocked: true }; }
    return { ok: false, status: rr && rr.status };
  };
  return { read, stats };
}
