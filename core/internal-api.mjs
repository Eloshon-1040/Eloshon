/**
 * Internal-API replay lane. The implementation now lives in shared/ (portable,
 * zero Node built-ins) so the desktop app AND the browser extension run the exact
 * same lane from one source of truth. This module re-exports it unchanged.
 */
export * from '../shared/internal-api.mjs';
