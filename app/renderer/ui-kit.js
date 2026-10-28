/* Shared renderer pieces for the design system (.interface-design/system.md): status chips (§5.4) and the
 * long-task progress card (§7.4). Pure string builders (no DOM access) so they are unit-tested in Node and used
 * by both app.js and your-browser-ui.js. Every visible word goes through i18n. */
import { t, getLang } from './i18n/index.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Status-chip icons: one shape per meaning, drawn at stroke 2, sized 12 px by the status-chip component.
const SV = (d, cls) => `<svg${cls ? ` class="${cls}"` : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const CI = Object.freeze({
  ring: SV('<path d="M12 4a8 8 0 1 1-8 8"/>', 'moving'),
  still: SV('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 'still'),
  clock: SV('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  pause: SV('<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>'),
  check: SV('<path d="m5 12 5 5 9-10"/>'),
  checkC: SV('<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>'),
  alert: SV('<path d="M12 4 2.8 19.5a1 1 0 0 0 .9 1.5h16.6a1 1 0 0 0 .9-1.5L12 4z"/><path d="M12 10v4M12 17.5h.01"/>'),
  octX: SV('<path d="M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2z"/><path d="m9 9 6 6M15 9l-6 6"/>'),
  xC: SV('<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>'),
  hand: SV('<path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12"/><path d="M11 11V4.5a1.5 1.5 0 0 1 3 0V12"/><path d="M14 11.5V6a1.5 1.5 0 0 1 3 0v7"/><path d="M8 13 6.4 11a1.6 1.6 0 0 0-2.6 1.8L7 17.5A6 6 0 0 0 12.2 21h.8a5 5 0 0 0 5-5v-3"/>'),
  minusC: SV('<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>'),
  stopC: SV('<circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1"/>'),
});

/** Status chip (shared `status-chip` component, tokens.base.css): tone + shape + icon + word, never color alone.
 *  `moving` draws the turning ring, replaced by a still clock under reduced motion. Never clickable. */
export const chip = (tone, shape, icon, word, moving = false) =>
  `<span class="status-chip" data-tone="${tone}" data-shape="${shape}">${moving ? CI.ring + CI.still : icon}${esc(word)}</span>`;

// Durations through Intl (system.md §3.1), in the interface language: « 2 min 14 s », « 1 h 05 min ».
export function unitFmt(n, unit, pad) {
  return new Intl.NumberFormat(getLang(), { style: 'unit', unit, unitDisplay: 'short', minimumIntegerDigits: pad ? 2 : 1 }).format(n);
}
export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  try {
    if (h) return `${unitFmt(h, 'hour')} ${unitFmt(m, 'minute', true)}`;
    if (m) return `${unitFmt(m, 'minute')} ${unitFmt(sec, 'second', true)}`;
    return unitFmt(sec, 'second');
  } catch { return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`; }
}
export const runElapsed = (r, now = Date.now()) => (r && r.startedAt ? now - r.startedAt : 0);
/** Remaining time, shown only once the estimate is stable (system.md §7.4): total known and unchanged for 10 s,
 *  at least 3 items done, 15 s elapsed, not paused. Otherwise « Calcul en cours… ». Uses data the run already has. */
export function etaText(r, now = Date.now()) {
  const p = (r && r.progress) || {}; const el = runElapsed(r, now);
  if (!p.total || r.paused || (p.done || 0) < 3 || el < 15000 || !r.totalSince || now - r.totalSince < 10000) return t('running.etaCalc');
  const left = Math.max(0, (p.total - p.done) * (el / p.done));
  if (left < 60000) return t('running.etaUnderMin');
  return t('running.etaAbout', { t: unitFmt(Math.ceil(left / 60000), 'minute') });
}

/**
 * Progress card of a running job: what is happening, the state chip, a 4 px bar (neutral when paused), then
 * pages read / planned, elapsed time and remaining time in tabular figures. `count` is trusted HTML (built by the
 * caller from numbers), `step` is plain text.
 */
export function progressCardHTML(r, { count, step, chipHTML, paused = false, extra = '' }) {
  const p = r.progress || { done: 0, total: 0 }; const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const indeterminate = !p.total; // total unknown (discovery/render/pagination): a moving bar + the real step, not a dead 0/0
  return `<div class="card card-pad prog-card">
      <div class="prog-top"><span class="prog-lab">${esc(t('running.progress'))}</span>${chipHTML}</div>
      <div class="bar${indeterminate ? ' indeterminate' : ''}${paused ? ' paused' : ''}" role="progressbar" aria-label="${esc(t('running.pages'))}"${indeterminate ? '' : ` aria-valuemin="0" aria-valuemax="${p.total}" aria-valuenow="${p.done}"`}><div class="bar-fill" style="width:${indeterminate ? 100 : pct}%"></div></div>
      <p class="prog-step">${esc(step)}</p>
      <div class="meta">
        <span>${esc(t('running.pages'))}<span class="mv prog-count">${count}</span></span>
        <span>${esc(t('running.elapsed'))}<span class="mv" id="run-elapsed">${esc(fmtDuration(runElapsed(r)))}</span></span>
        <span>${esc(t('running.remaining'))}<span class="mv" id="run-eta">${esc(etaText(r))}</span></span>
      </div>${extra}</div>`;
}
