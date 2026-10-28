/**
 * Sub-pages read in the USER'S browser (what Thunderbit's browser mode, Bardeen and Simplescraper do):
 * after the list is read, each product page is opened in the user's own Chrome — their session, their
 * IP, the page built by its scripts — and the rendered page is handed to the app, which completes the
 * row with it (taught rules, structured data, embedded state). A plain HTTP re-read misses what shops
 * build in the browser (descriptions, spec tables) and is what anti-bot systems refuse.
 *
 * The loop is free of chrome.*: opening / visiting / closing a worker tab and sending a page are
 * injected, so it is unit-tested in Node. A few pages at a time, a pause between pages; no cap on the
 * number of pages (a limit is the caller's, announced and reported: enrich-queue.mjs).
 */

const sameSite = (a, b) => {
  try { const h = (u) => new URL(u).hostname.replace(/^www\./, '').split('.').slice(-2).join('.'); return h(a) === h(b); } catch { return false; }
};

/**
 * The product pages to open: each row's own page once, on the list's site, in list order.
 * @param {object[]} rows  @param {string} listUrl
 */
export function subpageUrls(rows, listUrl, max = Number.MAX_SAFE_INTEGER) {
  const seen = new Set(); const out = [];
  for (const r of rows || []) {
    const u = r && (r.sourceUrl || r.canonicalUrl || r.url);
    if (typeof u !== 'string' || !/^https?:/i.test(u)) continue;
    const k = u.split('#')[0];
    if (seen.has(k) || (listUrl && !sameSite(u, listUrl))) continue;
    seen.add(k); out.push(k);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * @param {string[]} urls
 * @param {{ open:()=>Promise<any>, visit:(worker:any, url:string)=>Promise<{html:string,url?:string}|{challenge:true}|{error:string}|null>,
 *   close:(worker:any)=>Promise<void>, send:(url:string, html:string)=>Promise<boolean|string>,
 *   concurrency?:number, pauseMs?:[number,number], budgetMs?:number, retries?:number, onProgress?:(done:number,total:number)=>void,
 *   isStopped?:()=>boolean|string, onOutcome?:(url:string, outcome:string, reason?:string|null)=>any, sleep?:(ms:number)=>Promise<void>, now?:()=>number, random?:()=>number }} io
 * @returns {Promise<{ total:number, read:number, failed:number, challenged:number, sent:number, retried:number, stoppedBy:string|null,
 *   outcomes: Map<string,'read'|'human_check'|'failed'>, reasons: Map<string,string>, notOpened: string[] }>}
 *   `visit` may answer `{ challenge: true }`: the page showed a human check (counted in `failed` too), or
 *   `{ error }`: why the page could not be read. `send` answers true, or false / why the app did not keep it.
 *   A page that FAILED (never a human check) is tried again `retries` times (1 by default) at the end of the
 *   list: one failure never stops the others, and a slow page gets a second chance. `outcomes` says what
 *   happened to each page opened (its last try), `reasons` why a page failed; `notOpened` lists the pages a
 *   stop or the time budget left unopened: never a silent gap.
 */
export async function readSubpages(urls, io) {
  const total = urls.length;
  const rep = { total, read: 0, failed: 0, challenged: 0, sent: 0, retried: 0, stoppedBy: null, outcomes: new Map(), reasons: new Map(), notOpened: [] };
  if (!total) return rep;
  const sleep = io.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = io.now || Date.now; const random = io.random || Math.random;
  const [pMin, pMax] = io.pauseMs || [700, 1500];
  const budgetMs = io.budgetMs != null ? io.budgetMs : Infinity; // no time cut unless the caller sets one
  const retries = Math.max(0, Math.min(3, io.retries != null ? Number(io.retries) || 0 : 1));
  const isStopped = io.isStopped || (() => false);
  const t0 = now();
  const list = [...urls]; const tries = new Map(); // a failed page goes back at the end of `list`
  let next = 0; let done = 0;
  const progress = () => { try { if (io.onProgress) io.onProgress(done, total); } catch { /* never break */ } };
  const worker = async () => {
    let w = null;
    try { w = await io.open(); } catch { w = null; }
    if (!w) return;
    try {
      while (next < list.length) {
        const stop = isStopped(); // true, or why ('human_check': the run pauses for the user)
        if (stop) { rep.stoppedBy = rep.stoppedBy || (typeof stop === 'string' ? stop : 'stopped'); break; }
        if (now() - t0 > budgetMs) { rep.stoppedBy = rep.stoppedBy || 'time'; break; }
        const url = list[next++];
        const again = rep.outcomes.get(url) === 'failed'; // this is a retry
        if (again) { rep.failed--; rep.retried++; }
        tries.set(url, (tries.get(url) || 0) + 1);
        let page = null; let why = null;
        try { page = await io.visit(w, url); } catch (e) { page = null; why = String((e && e.message) || e).slice(0, 120); }
        if (page && page.html) {
          rep.read++;
          let res = false; try { res = await io.send(url, page.html); } catch (e) { res = String((e && e.message) || e).slice(0, 120); }
          const ok = res === true;
          if (ok) rep.sent++; else { rep.read--; rep.failed++; why = typeof res === 'string' && res ? res : 'la page n’a pas été reçue par l’application'; }
          rep.outcomes.set(url, ok ? 'read' : 'failed'); // a page the app never received was not read for the export
        } else {
          rep.failed++;
          if (page && page.challenge) { rep.challenged++; rep.outcomes.set(url, 'human_check'); }
          else { rep.outcomes.set(url, 'failed'); why = why || (page && page.error) || 'la page n’a rien rendu de lisible'; }
        }
        if (rep.outcomes.get(url) === 'failed') rep.reasons.set(url, why); else rep.reasons.delete(url);
        try { if (io.onOutcome) await io.onOutcome(url, rep.outcomes.get(url), rep.reasons.get(url) || null); } catch { /* the run goes on */ }
        if (rep.outcomes.get(url) === 'failed' && tries.get(url) <= retries) list.push(url); // one more try, at the end
        else { done++; progress(); }
        if (next < list.length) await sleep(Math.round(pMin + random() * (pMax - pMin))); // polite, irregular pace
      }
    } finally { try { await io.close(w); } catch { /* already gone */ } }
  };
  const n = Math.max(1, Math.min(io.concurrency || 2, 4, total));
  await Promise.all(Array.from({ length: n }, () => worker()));
  rep.notOpened = [...new Set(list.slice(next))].filter((u) => !rep.outcomes.has(u));
  return rep;
}
