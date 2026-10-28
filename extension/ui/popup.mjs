/**
 * Popup — the pairing/status/control surface (Requirement F). Shows app link
 * status, browser, active domain + permission, and any running/paused/blocked
 * job with "Reprendre" / "Abandonner" actions. The domain-activation button is
 * the required user gesture for chrome.permissions.request (per-domain opt-in).
 */
import { requestDomainPermission, hasDomainPermission, originsForDomain } from '../background/permissions.mjs';

const $ = (id) => document.getElementById(id);
const setPill = (el, text, cls) => { el.textContent = text; el.className = 'pill ' + (cls || 'neutral'); };

document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;

// Detect browser for display.
(function browser() {
  const ua = navigator.userAgent || '';
  const b = /Edg\//.test(ua) ? 'Edge' : (navigator.brave ? 'Brave' : 'Chrome');
  setPill($('browser'), b, 'neutral');
})();

// Show the active tab's domain and whether it is authorized.
async function refreshActiveDomain() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !/^https?:/.test(tab.url)) { setPill($('domain'), '—', 'neutral'); setPill($('perm-status'), '—', 'neutral'); return; }
    const host = new URL(tab.url).hostname.replace(/^www\./, '');
    setPill($('domain'), host, 'neutral');
    $('domain-input').value = host;
    const granted = await hasDomainPermission(chrome, host);
    setPill($('perm-status'), granted ? 'accordée' : 'non accordée', granted ? 'ok' : 'warn');
  } catch { /* ignore */ }
}

// Live link status + job updates via a long-lived port.
const port = chrome.runtime.connect({ name: 'popup' });
port.onMessage.addListener((msg) => {
  if (msg.kind === 'link_status') {
    const map = { connected: ['connectée', 'ok'], app_not_running: ['application fermée', 'warn'], disconnected: ['déconnectée', 'err'] };
    const [t, c] = map[msg.status] || [msg.status, 'neutral'];
    setPill($('link-status'), t, c);
  } else if (msg.kind === 'progress') {
    showJob('running', `Produits : ${msg.data && msg.data.total != null ? msg.data.total : (msg.data && msg.data.count) || ''}`, msg.job_id);
  } else if (msg.kind === 'challenge') {
    showJob('paused', msg.message || 'Action requise dans l\'onglet.', msg.job_id, { resume: false });
  } else if (msg.kind === 'challenge_resolved') {
    showJob('running', 'Défi résolu — reprise.', msg.job_id);
  } else if (msg.kind === 'job_resumed') {
    showJob('running', 'Reprise…', msg.job_id);
  }
});

let currentJob = null;
function showJob(state, message, jobId, { resume } = {}) {
  currentJob = jobId || currentJob;
  $('job').classList.remove('hidden');
  const label = { running: ['en cours', 'ok'], paused: ['en pause (défi)', 'warn'], blocked: ['bloqué', 'err'], done: ['terminé', 'ok'] }[state] || [state, 'neutral'];
  setPill($('job-state'), label[0], label[1]);
  $('job-msg').textContent = message || '';
  $('btn-stop').classList.toggle('hidden', state === 'done');
  $('btn-resume').classList.toggle('hidden', resume === false || state !== 'paused');
}

$('btn-activate').addEventListener('click', async () => {
  const host = ($('domain-input').value || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!originsForDomain(host).length) { $('activate-result').textContent = 'Domaine invalide.'; return; }
  const granted = await requestDomainPermission(chrome, host);
  $('activate-result').textContent = granted ? `Domaine ${host} autorisé.` : 'Autorisation refusée.';
  refreshActiveDomain();
});

$('btn-stop').addEventListener('click', () => { if (currentJob) chrome.runtime.sendMessage({ kind: 'stop', job_id: currentJob }, () => showJob('done', 'Travail abandonné.', currentJob)); });
$('btn-resume').addEventListener('click', () => { if (currentJob) chrome.runtime.sendMessage({ kind: 'resume', job_id: currentJob }, () => showJob('running', 'Reprise…', currentJob)); });

chrome.runtime.sendMessage({ kind: 'status' }, (r) => { if (r && r.jobs && r.jobs.length) showJob('running', '', r.jobs[0]); });
refreshActiveDomain();
