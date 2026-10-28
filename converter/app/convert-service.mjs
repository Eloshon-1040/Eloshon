/**
 * Conversion service — the app-side billing policy around the pure engine
 * (Phase 1, owner decision: previews are FREE; one credit consume per
 * successful export, never on previews or step transitions).
 *
 * Two modes travel on the conv:run input:
 *   mode 'preview' (default) — step-3 previews, step transitions, question
 *     re-runs. Runs the engine only: no credit check, no consume, no cap.
 *   mode 'export' — the run whose output will be written to disk. A licensed
 *     user is checked BEFORE the run (fail fast on an empty balance) and the
 *     consume is armed on success; it fires once, in consumePending(), AFTER
 *     the file is actually written (conv:save). A cancelled save dialog never
 *     bills. An unlicensed user has no credit flow at all.
 *
 * The edge-function contract is unchanged: converter_check / converter_consume
 * with { items_count } — only WHEN they are called moved.
 *
 * Pure dependency injection (getLicense / callEdge / run) so the whole policy
 * is testable under node:test without Electron. `run` is the engine runner —
 * in the app the engine-host worker (convert-host.mjs), which also owns the
 * Reference ⊕ Learned knowledge loading; in tests runConversion directly.
 */

import { DIRECTIONS, DEFAULT_FREE_LIMIT } from '../core/directions.mjs';

// ── Free-tier export cap (Phase 1, owner decision A) ─────────────────────────
// An unlicensed EXPORT is capped to the direction's freeLimit (10) units —
// at most 10 products in the output file, which is what the UI copy
// "Version gratuite — 10 lignes" promises. Previews are never capped.
// The cap VALUE lives in core/directions.mjs (freeLimit / DEFAULT_FREE_LIMIT).
// BASIS FLIP POINT: today the cap rides the engine's existing limitUnits
// option (caps the OUTPUT units). If the owner later wants to cap INPUT rows
// instead, this function is the single place to change: truncate the parsed
// input before the run instead of returning limitUnits.
export const ENFORCE_LIMITS = false;

function freeExportCap(direction) {
  return DIRECTIONS.find((d) => d.direction === direction)?.freeLimit ?? DEFAULT_FREE_LIMIT;
}

export function createConvertService({ getLicense, callEdge, run }) {
  // Armed by a successful export-mode run; fired once by consumePending().
  // Only ever one export in flight (the wizard is a single linear flow), so a
  // newer export run simply replaces an unfired pending consume.
  let pending = null;

  async function convRun(input) {
    const mode = input.mode === 'export' ? 'export' : 'preview';
    if (mode === 'preview') {
      return run(input);
    }

    // Owner decision (2026-10-27): no limitation for anyone — no row cap and no
    // credit flow, licensed or not. The cap/credit code below stays reachable
    // by flipping this switch back if a paid tier ever returns.
    if (!ENFORCE_LIMITS) {
      pending = null;
      return run(input);
    }

    const lic = getLicense();
    const licensed = !!(lic.activated && lic.key);
    if (!licensed) {
      // Free tier: no credit flow at all — the export is capped instead.
      pending = null;
      const cap = freeExportCap(input.direction);
      const result = await run({ ...input, limitUnits: cap });
      if (!result.ok) return result;
      return { ...result, freeCap: { limit: cap, applied: (result.counts?.outputUnits ?? 0) > cap } };
    }

    // Count input rows for the credit check (fast pre-pass, no engine needed).
    const rawLines = (input.csvText || '').split(/\r?\n/).filter((l) => l.trim());
    const itemsCount = Math.max(0, rawLines.length - 1); // subtract header

    // Server-side credit check — never consume silently what doesn't exist.
    const check = await callEdge('converter_check', { items_count: itemsCount }, lic.key);
    if (!check?.allowed) {
      pending = null;
      return { ok: false, reason: check?.reason || 'no_converter_credits', converter_credits: check?.converter_credits ?? 0 };
    }

    const result = await run(input);
    pending = result.ok ? { key: lic.key, units: result.counts?.inputUnits ?? itemsCount } : null;
    return result;
  }

  /** Fire the armed consume (called by conv:save after a successful write).
   *  Idempotent: a second call without a new export run is a no-op. */
  async function consumePending() {
    if (!pending) return { consumed: false };
    const { key, units } = pending;
    pending = null;
    await callEdge('converter_consume', { items_count: units }, key);
    return { consumed: true, units };
  }

  return { run: convRun, consumePending };
}
