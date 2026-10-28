/**
 * « Agent » tab — a chat with the app's assistant about the product page open in the tab. The extension
 * holds no AI key: each message goes to the service worker, which sends the page (as the browser built
 * it) to the app; the app runs the agent and its tools, saves the rules it is asked to save, and answers
 * with its reply and what to show in the page (an element outlined). One conversation per site and tab.
 */
const $ = (sel) => document.querySelector(sel);
const hasChrome = typeof chrome !== 'undefined' && chrome.runtime;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const chats = new Map(); // `${tabId}|${origin}` → { chatId, log:[{who, text}] }
let busy = false;

function send(kind, payload = {}) {
  return new Promise((resolve) => {
    if (!hasChrome) return resolve({ ok: false, reason: 'hors extension' });
    try { chrome.runtime.sendMessage({ kind, ...payload }, (r) => resolve(r || { ok: false, reason: chrome.runtime.lastError ? 'indisponible' : 'vide' })); }
    catch { resolve({ ok: false, reason: 'indisponible' }); }
  });
}
async function activeTab() {
  if (!hasChrome || !chrome.tabs) return null;
  try { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return t || null; } catch { return null; }
}
const keyOf = (tab) => { let o = ''; try { o = new URL(tab.url).origin; } catch { o = ''; } return `${tab && tab.id}|${o}`; };
async function current() { const tab = await activeTab(); if (!tab) return { tab: null, chat: null }; const k = keyOf(tab); if (!chats.has(k)) chats.set(k, { chatId: null, log: [] }); return { tab, chat: chats.get(k) }; }

function render(chat) {
  const box = $('#agent-log'); if (!box) return;
  box.innerHTML = (chat ? chat.log : []).map((m) => `<div class="msg ${m.who}">${esc(m.text)}</div>`).join('') || '<div class="hint">Pas encore de message. Commencez par « Que trouves-tu sur cette fiche ? ».</div>';
  box.lastElementChild && box.lastElementChild.scrollIntoView({ block: 'end' });
}
const toast = (m) => { const t = $('#agent-toast'); if (t) t.textContent = m || ''; };

async function ask(text) {
  const message = String(text || '').trim(); if (!message || busy) return;
  const { tab, chat } = await current(); if (!tab || !chat) { toast('Aucun onglet actif.'); return; }
  busy = true; $('#agent-send').disabled = true; $('#agent-first').disabled = true;
  chat.log.push({ who: 'me', text: message }); render(chat);
  toast('L’agent lit la page et cherche… (quelques secondes, parfois plus)');
  let r = null;
  try { r = await send('agent_chat', { tabId: tab.id, chatId: chat.chatId, message }); }
  finally { busy = false; $('#agent-send').disabled = false; $('#agent-first').disabled = false; }
  if (r && r.ok) {
    chat.chatId = r.chatId || chat.chatId;
    chat.log.push({ who: 'bot', text: r.reply || '(pas de réponse)' });
    toast(r.actions && r.actions.length ? 'L’élément concerné est entouré dans la page.' : '');
  } else {
    chat.log.push({ who: 'bot err', text: `Pas de réponse : ${(r && r.reason) || 'l’application ne répond pas'}.` });
    toast('');
  }
  render(chat);
}

function main() {
  const root = $('#pane-agent'); if (!root) return;
  $('#agent-send').addEventListener('click', () => { const i = $('#agent-input'); const v = i.value; i.value = ''; ask(v); });
  $('#agent-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#agent-send').click(); } });
  $('#agent-first').addEventListener('click', () => ask('Qu’est-ce que tu trouves sur cette fiche ? Champ par champ, et ce qui manque.'));
  $('#agent-new').addEventListener('click', async () => { const { tab } = await current(); if (tab) chats.set(keyOf(tab), { chatId: null, log: [] }); render(null); toast('Nouvelle conversation.'); });
  window.addEventListener('elo-tab', async (e) => { if (e.detail === 'agent') { const { chat } = await current(); render(chat); } });
}
main();
