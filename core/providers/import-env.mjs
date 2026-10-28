/**
 * Import provider credentials from a .env file (admin only). Two phases so the
 * PREVIEW never carries a value:
 *   - planImport(envText): NAMES only → { mapped:[{name,providerId,providerLabel,field}], unmapped:[name] }
 *   - extractValues(envText, plan): { providerId: {field:value} } for the secure store (main process only)
 *
 * SECRETS HYGIENE: planImport discards values entirely. extractValues returns
 * values only to the secure store; it never logs them and the caller never sends
 * them to the renderer.
 */
import { PROVIDERS } from './registry.mjs';

/** { ENV_NAME: {providerId, providerLabel, field} } from the descriptors. */
function envIndex() {
  const idx = {};
  for (const p of PROVIDERS) {
    for (const [field, names] of Object.entries(p.envNames || {})) {
      for (const n of names) idx[n] = { providerId: p.id, providerLabel: p.label, field };
    }
  }
  return idx;
}

/**
 * One-pass .env scanner shared by planImport and extractValues, hardened for
 * the files people actually write (Phase 0): a BOM on line 1, `export KEY=…`
 * prefixes, `KEY: value` (colon instead of '='), decorative prose lines.
 * Hard rules: never crash; never swallow a real assignment; a line that is
 * NOT an assignment yields a warning that carries line number + reason + at
 * most an identifier-shaped NAME — never a value, never free text.
 */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
function scan(envText) {
  const assignments = []; const warnings = [];
  const knownNames = Object.keys(envIndex());
  const lines = String(envText || '').replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((rawLine, i) => {
    const line = i + 1;
    let s = rawLine.trim();
    if (!s || s.startsWith('#')) return;                   // blank / comment: silent
    if (s.startsWith('export ')) s = s.slice(7).trim();    // sh-style prefix
    const eq = s.indexOf('=');
    if (eq < 0) {
      const colon = s.indexOf(':');
      if (colon > 0) {
        // "KEY: value" — surface the name ONLY when it is a KNOWN provider env
        // name (closed vocabulary). The text before a ':' on a non-assignment
        // line can be half of a user:pass credential (BROWSER_AUTH is exactly
        // that shape), and "identifier-shaped" is not a safety test.
        const name = s.slice(0, colon).trim();
        warnings.push({ line, reason: 'colon-separator', name: knownNames.includes(name) ? name : null, mentions: [] });
      } else {
        // decorative prose — surface only KNOWN provider env names it mentions
        // (closed vocabulary from the registry: zero leak risk).
        warnings.push({ line, reason: 'no-separator', name: null, mentions: knownNames.filter((n) => s.includes(n)) });
      }
      return;
    }
    const name = s.slice(0, eq).trim();
    if (!IDENT_RE.test(name)) { warnings.push({ line, reason: 'invalid-name', name: null, mentions: [] }); return; }
    const value = s.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    assignments.push({ line, name, value });
  });
  return { assignments, warnings };
}

/** Preview plan — names/mapping/warnings only, no values. */
export function planImport(envText) {
  const idx = envIndex();
  const { assignments, warnings } = scan(envText);
  const mapped = []; const unmapped = [];
  for (const { name } of assignments) {
    const hit = idx[name];
    if (hit) mapped.push({ name, providerId: hit.providerId, providerLabel: hit.providerLabel, field: hit.field });
    else unmapped.push(name);
  }
  return { mapped, unmapped, warnings };
}

/**
 * Extract the VALUES for the mapped names (main process only). Returns
 * { providerId: { field: value } }. Never logs; the caller writes straight to the
 * secure store and discards this object.
 */
export function extractValues(envText, plan) {
  const wanted = new Map((plan && plan.mapped ? plan.mapped : planImport(envText).mapped).map((m) => [m.name, m]));
  const out = {};
  // Same scanner as planImport, so a variable the plan saw (BOM'd line 1,
  // export-prefixed) is extracted identically — never swallowed, and a
  // malformed line can never resurface here as a value.
  for (const { name, value } of scan(envText).assignments) {
    const m = wanted.get(name);
    if (!m || value === '') continue;
    out[m.providerId] = out[m.providerId] || {};
    out[m.providerId][m.field] = value;
  }
  return out;
}
