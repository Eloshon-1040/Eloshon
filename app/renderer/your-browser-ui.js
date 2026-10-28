/* "Scraper via votre navigateur" — renderer pieces for the New-scrape form and the
 * running screen. Pure string builders + a tiny state reducer (no DOM access), so
 * they are unit-tested in Node. All text goes through i18n; nothing here knows a
 * site name — the domain always comes from the address the user typed. */
import { t } from './i18n/index.js';
import { CI, chip, progressCardHTML } from './ui-kit.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtN = (n) => (n == null ? '—' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));

/** Terminal phases of a your-browser run (the extension's result vocabulary). */
export const YB_TERMINAL = Object.freeze(['done', 'blocked', 'stopped', 'error']);

/** Localised text for a {ok:false, code, message} answer — never a raw code. */
export function ybErrorText(res) {
  const code = res && res.code;
  if (code) { const s = t('yb.err.' + code); if (s !== 'yb.err.' + code) return s; }
  return (res && res.message) || t('yb.err.invalid_request');
}

/**
 * What the "via votre navigateur" option shows for the current address.
 * `selectable` = the site is opted in (the user may pick the mode; if the
 * extension is not connected the attempt explains how to connect it).
 * @param {object|null} av availability answer from the main process
 */
export function ybModeView(av) {
  if (!av || av.code === 'invalid_url') return { selectable: false, tone: 'muted', note: t('yb.enterUrl') };
  // Connected but the site is not authorized in the extension yet: actionable —
  // the user clicks "Activer ce domaine" and it becomes usable live (no restart).
  if (av.code === 'domain_not_activated') return { selectable: false, tone: 'warn', note: t('yb.err.domain_not_activated') };
  if (av.code === 'domain_not_enabled') return { selectable: false, tone: 'muted', note: t('yb.err.domain_not_enabled') };
  if (av.code === 'restart_required') return { selectable: false, tone: 'warn', note: t('yb.err.restart_required') };
  if (av.code === 'extension_not_connected') return { selectable: true, tone: 'warn', note: t('yb.err.extension_not_connected') };
  if (av.code === 'busy') return { selectable: true, tone: 'warn', note: t('yb.err.busy') };
  if (av.ok) return { selectable: true, tone: 'ok', note: av.browser ? t('yb.readyBrowser', { browser: t('yb.browser.' + av.browser) }) : t('yb.ready') };
  return { selectable: false, tone: 'muted', note: ybErrorText(av) };
}

/** The mode picker (standard vs via your browser), reusing the .radio-row style. */
export function ybModeHTML(av, mode, I = {}) {
  const v = ybModeView(av);
  const yb = mode === 'yb' && v.selectable;
  const noteTone = v.tone === 'warn' ? 'warn' : (v.tone === 'ok' ? 'ok' : 'muted');
  return `<div class="sect"><span class="sect-t" id="yb-mode-t">${esc(t('yb.modeTitle'))}</span><span class="sect-line"></span></div>
    <div role="radiogroup" aria-labelledby="yb-mode-t">
    <div class="radio-row ${yb ? '' : 'active'}" data-act="yb-mode" data-mode="standard" role="radio" tabindex="0" aria-checked="${yb ? 'false' : 'true'}"><div class="rdot"></div><div><div class="tog-name">${esc(t('yb.modeStandard'))}</div><div class="tog-desc">${esc(t('yb.modeStandardDesc'))}</div></div></div>
    <div class="radio-row ${yb ? 'active' : ''}${v.selectable ? '' : ' disabled'}" data-act="yb-mode" data-mode="yb" role="radio" tabindex="0" aria-checked="${yb ? 'true' : 'false'}"${v.selectable ? '' : ' aria-disabled="true" aria-describedby="yb-note"'}><div class="rdot"></div><div>
      <div class="tog-name">${I.browser || ''} ${esc(t('yb.modeYb'))}</div><div class="tog-desc">${esc(t('yb.modeYbDesc'))}</div>
      <div id="yb-note" class="yb-note note-tone-${noteTone}">${esc(v.note)}</div></div></div></div>`;
}

/** Bounded limits for a run (min/max come from the main process; clamped there again). */
export function ybLimitsHTML(limits = {}, bounds = {}) {
  const f = (id, key, label) => {
    const b = bounds[key] || {};
    return `<div class="field"><label class="label" for="${id}">${esc(label)}</label><div class="control"><input id="${id}" type="number" min="${esc(b.min ?? 0)}" max="${esc(b.max ?? '')}" value="${esc(limits[key] ?? '')}"></div></div>`;
  };
  return `<div class="sect"><span class="sect-t">${esc(t('yb.limitsTitle'))}</span><span class="sect-line"></span><span class="chip-note">${esc(t('yb.limitsNote'))}</span></div>
    <div class="grid4 fit">${f('yb-maxp', 'maxProducts', t('yb.maxProducts'))}${f('yb-maxlp', 'maxListPages', t('yb.maxListPages'))}${f('yb-maxdp', 'maxDetailPages', t('yb.maxDetailPages'))}</div>
    <div class="noteline">${esc(t('yb.tabNote'))}</div>`;
}

/** Initial running-screen state for a launched run (same fields vRunning reads). */
export function ybRunning({ url, store, jobId, domain }) {
  return { mode: 'yb', ybJobId: jobId, domain, ybPhase: 'connecting', startedAt: Date.now(), source: (store ? store + ' · ' : '') + url, url, sourceId: null, phase: 'running', progress: { done: 0, total: 0 }, counters: {}, products: [], paused: false, intervention: null, discovered: null, message: null };
}

/**
 * Apply a 'yourBrowser' state event to the running state. Returns true when the
 * screen should repaint. Ignores events for another job (never mixes runs).
 */
export function applyYbState(r, payload) {
  if (!r || r.mode !== 'yb' || !payload || payload.kind !== 'state') return false;
  const j = payload.job;
  if (!j || j.id !== r.ybJobId) return false;
  r.ybPhase = j.phase || r.ybPhase;
  r.message = j.message || null;
  r.ybStep = j.step || null;
  r.paused = r.ybPhase === 'paused';
  r.stopping = r.ybPhase === 'stopping';
  if (j.total) { if (j.total !== (r.progress && r.progress.total)) r.totalSince = Date.now(); r.progress = { done: j.done || 0, total: j.total }; }
  else if (j.done != null) r.stepFound = j.done;
  return true;
}

/**
 * Status chip for a your-browser phase (system.md §5.4). A challenge waiting in the user's tab is
 * « CAPTCHA requis » (the user acts); red only for a block or a failure.
 */
export function ybPill(phase) {
  const word = t('yb.phase.' + (phase || 'connecting'));
  switch (phase) {
    case 'paused': return chip('warn', 'attention', CI.hand, t('status.captcha'));
    case 'done': return chip('ok', 'settled', CI.check, word);
    case 'blocked': return chip('danger', 'attention', CI.octX, word);
    case 'error': return chip('danger', 'attention', CI.xC, word);
    case 'stopped': return chip('neutral', 'settled', CI.stopC, word);
    default: return chip('neutral', 'settled', '', word, true); // connecting, running, stopping
  }
}

/** Head + challenge banner + progress card of the running screen for this mode. */
export function ybRunningTopHTML(r, I = {}) {
  const phase = r.ybPhase || 'connecting';
  const terminal = YB_TERMINAL.includes(phase);
  const p = r.progress || { done: 0, total: 0 };
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const count = p.total ? `<b>${fmtN(p.done)}</b> / ${fmtN(p.total)} · ${pct}%` : (r.stepFound != null ? esc(t('running.foundN', { n: fmtN(r.stepFound) })) : esc(t('running.working')));
  const resumeBtn = phase === 'paused' ? `<button class="btn btn-primary" data-act="yb-resume">${I.play || ''} ${esc(t('common.resume'))}</button>` : '';
  const stopBtn = terminal ? '' : `<button class="btn btn-danger" data-act="yb-stop"${phase === 'stopping' ? ' aria-disabled="true"' : ''}>${I.stop || ''} ${esc(phase === 'stopping' ? t('yb.stopping') : t('yb.abandonAsk'))}</button>`;
  const challenge = phase === 'paused'
    ? `<div class="banner banner-amber gap-bottom" role="alert"><div class="bic">${I.shield || ''}</div><div><div class="banner-t">${esc(t('yb.challengeTitle'))}</div><div class="banner-d">${esc(r.message || t('yb.challengeDesc'))}</div><div class="banner-d">${esc(t('yb.challengeNote'))}</div></div></div>`
    : '';
  const stepText = phase === 'connecting' ? t('yb.connecting') : (phase === 'stopping' ? t('yb.stopping') : (r.message || (r.ybStep === 'detail' ? t('yb.detailStep') : t('yb.runningStep'))));
  const tab = `<div class="prog-note">${I.browser || ''}<span>${esc(t('yb.tabNote'))}</span></div>`;
  return `<div class="page-head"><div><h1 class="h1">${esc(t('yb.runningTitle'))}</h1><p class="sub">${esc(r.source || '')}</p></div>
      <div class="btn-row">${resumeBtn}${stopBtn}</div></div>
    ${challenge}
    ${progressCardHTML(r, { count, step: stepText, chipHTML: ybPill(phase), paused: phase === 'paused', extra: tab })}`;
}
