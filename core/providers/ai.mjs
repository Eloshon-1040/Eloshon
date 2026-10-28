/**
 * AI-assist provider descriptor — kept SEPARATE from the paid-scrape PROVIDERS tier
 * chain (this is an optional, user-invoked structure helper, not a scraping executor,
 * so it must never enter the provider gate / quota logic). It reuses the same field
 * resolution (secure store → config → env → default) so the admin sets the key in the
 * exact same encrypted store — never in the installer, never in the extension.
 *
 * PORTABLE-ish: pure logic; `secure`/`config`/`env` injected.
 */
import { resolveField } from './registry.mjs';

const F = (key, label, { secret = false, required = false, def = undefined } = {}) => ({ key, label, secret, required, default: def });

/** The AI-assist provider: Anthropic (Claude). Admin supplies the API key. */
export const AI_PROVIDER = Object.freeze({
  id: 'ai.anthropic',
  label: 'Assistance IA — Claude (Anthropic)',
  configPath: 'ai',
  fields: [
    F('apiKey', 'Clé API', { secret: true, required: true }),
    F('model', 'Modèle', { secret: false, required: false, def: 'claude-haiku-4-5-20251001' }),
  ],
  envNames: { apiKey: ['ANTHROPIC_API_KEY', 'ANTHROPIC-API-KEY'], model: ['ANTHROPIC_MODEL'] },
});

/** Resolve {apiKey, model} in the main process only. */
export function resolveAiCredentials(io = {}) {
  const out = {};
  for (const f of AI_PROVIDER.fields) { const { value } = resolveField(AI_PROVIDER, f, io); if (value != null && value !== '') out[f.key] = value; }
  return out;
}

/** True when the required AI key resolves to a value. */
export function isAiConfigured(io = {}) {
  return AI_PROVIDER.fields.filter((f) => f.required).every((f) => { const { value } = resolveField(AI_PROVIDER, f, io); return value != null && String(value) !== ''; });
}

/** Renderer-safe state: presence/source per field, never a value. */
export function maskAiState(io = {}) {
  const fields = AI_PROVIDER.fields.map((f) => { const { source } = resolveField(AI_PROVIDER, f, io); return { key: f.key, label: f.label, secret: f.secret, required: f.required, present: source != null && source !== 'default', source: source || null }; });
  return { id: AI_PROVIDER.id, label: AI_PROVIDER.label, fields, configured: fields.filter((f) => f.required).every((f) => f.present) };
}
