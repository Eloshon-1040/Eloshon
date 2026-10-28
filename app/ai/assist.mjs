/**
 * App-side AI assist orchestration — the piece the extension calls (over the native
 * link) when the user clicks "Détecter par IA" / runs AI extraction. It resolves the
 * admin's Claude key from the encrypted provider store, builds the asker, and runs the
 * shared model-agnostic core over the page's decoded JSON. The key stays here; the
 * extension only sends page structure and receives {cards, hints}.
 *
 * Main process only. `io` ({secure, config, env}) and `fetchImpl` are injectable for
 * tests, so the whole flow is unit-tested without a live key.
 */
import { resolveAiCredentials, isAiConfigured } from '../../core/providers/ai.mjs';
import { createAnthropicAsker } from './provider.mjs';
import { aiAssistJson } from '../../shared/extract/ai-assist.mjs';

const tryParse = (v) => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };

/**
 * @param {{sources:Array, baseUrl?:string, url?:string, lang?:string, fields?:Array,
 *          io?:object, fetchImpl?:Function}} input
 * @returns {Promise<{ok:boolean, cards?:Array, hints?:object, candidates?:number, reason?:string}>}
 */
export async function runAiAssist({ sources = [], baseUrl, url = '', lang = 'fr', fields, io = {}, fetchImpl, onCall } = {}) {
  if (!isAiConfigured(io)) return { ok: false, reason: 'ai_key_missing' };
  const { apiKey, model } = resolveAiCredentials(io);
  let askJson;
  try { askJson = createAnthropicAsker({ apiKey, model, fetchImpl, onCall }); } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
  // Decode + bundle every source blob (embedded state islands, captured XHR bodies)
  // under one wrapper so the core walks them all; paths resolve against the wrapper.
  const decoded = (Array.isArray(sources) ? sources : [sources]).map(tryParse).filter((v) => v != null);
  if (!decoded.length) return { ok: true, cards: [], hints: null, candidates: 0 };
  const value = { __sources: decoded };
  const res = await aiAssistJson(value, baseUrl || url || '', { askJson, url, lang, fields });
  if (res.error) return { ok: false, reason: res.error };
  return { ok: true, cards: res.cards, hints: res.hints, candidates: res.candidates };
}
