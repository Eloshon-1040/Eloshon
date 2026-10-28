#!/usr/bin/env node
/**
 * Eloshon Scraper native messaging host. Chrome/Edge/Brave launch this as their
 * own child process; it relays the shared protocol between the extension (over
 * stdio native messaging) and the running desktop app (over a local named pipe /
 * unix socket, authenticated with the per-install pairing secret).
 *
 * It is a thin relay: no engine, no config, no credentials. If the app is not
 * running, it answers the extension with a clean E_APP_DOWN, keeps trying for a few
 * seconds, then exits (see idle.mjs): it never lingers once the app is closed.
 *
 * Run `node host.mjs --selftest` for an offline framing round-trip check.
 */
import net from 'node:net';
import { encodeMessage, MessageDecoder } from './framing.mjs';
import { createRelay } from './relay.mjs';
import { appEndpoint, readPairingSecret } from './host-config.mjs';
import { hello, PROTOCOL_VERSION } from '../shared/protocol/messages.mjs';
import { createIdleExit } from './idle.mjs';

if (process.argv.includes('--selftest')) { selftest(); }
else { main(); }

function selftest() {
  const dec = new MessageDecoder();
  const round = dec.push(encodeMessage({ type: 'hello', ok: true }));
  const ok = round.length === 1 && round[0].ok === true;
  process.stdout.write(`selftest: framing ${ok ? 'OK' : 'FAIL'}\n`);
  process.exit(ok ? 0 : 1);
}

function main() {
  // --- extension side (stdio) ---
  // Inbound (extension → host) cap: Chrome allows 64 MiB in this direction (1 MB only host → extension);
  // a rendered product page sent for completion is often over 1 MB.
  const inDec = new MessageDecoder({ maxBytes: 64 * 1024 * 1024 });
  const sendExtension = (msg) => { try { process.stdout.write(encodeMessage(msg)); } catch { /* stdout closed */ } };

  // --- app side (named pipe / socket) ---
  let appSock = null;
  const appDec = new MessageDecoder();
  const appConnected = () => !!(appSock && !appSock.destroyed && appSock.writable);
  const sendApp = (msg) => { if (!appConnected()) return false; try { appSock.write(encodeMessage(msg)); return true; } catch { return false; } };

  const relay = createRelay({ sendExtension, sendApp, appConnected, log: () => {} });

  let backoff = 500;
  function connectApp() {
    const sock = net.connect(appEndpoint());
    sock.on('connect', () => {
      appSock = sock; backoff = 500;
      // Authenticate to the app with the pairing secret (never sent to the extension).
      const secret = readPairingSecret();
      sock.write(encodeMessage(hello('host', { protocol_version: PROTOCOL_VERSION, secret: secret || null })));
    });
    sock.on('data', (chunk) => { try { for (const m of appDec.push(chunk)) relay.onAppMessage(m); } catch { /* drop */ } });
    sock.on('error', () => {});
    sock.on('close', () => { appSock = null; setTimeout(connectApp, backoff); backoff = Math.min(15000, Math.round(backoff * 1.8)); });
  }
  connectApp();
  // Leave once the app has been unreachable for a few seconds (closed app, or not started).
  const idle = createIdleExit({ isUp: appConnected, exit: () => process.exit(0) });
  setInterval(() => idle.tick(), 1000);

  process.stdin.on('data', (chunk) => { try { for (const m of inDec.push(chunk)) relay.onExtensionMessage(m); } catch { /* drop malformed */ } });
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
}
