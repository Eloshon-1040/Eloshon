/**
 * App-side host bridge (Requirement E). The desktop app listens on a local named
 * pipe / unix socket; the native host (launched by the browser) connects and
 * authenticates with the per-install pairing secret. The app then exchanges the
 * shared protocol with the extension THROUGH the host. No secret ever leaves the
 * user profile; the pairing secret is created here on first run.
 *
 * Pure, tested bits: authenticate(), ensurePairingSecret(). The net server is thin
 * wiring around them + framing.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { encodeMessage, MessageDecoder } from '../../native-host/framing.mjs';
import { appEndpoint, appDataDir } from '../../native-host/host-config.mjs';
import { validateMessage, MSG, PROTOCOL_VERSION } from '../../shared/protocol/messages.mjs';

/** Create (once) or read the per-install pairing secret. 0600, user profile only. */
export function ensurePairingSecret(dir = appDataDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'pairing.secret');
  try { const s = fs.readFileSync(f, 'utf8').trim(); if (s) return s; } catch { /* create below */ }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, secret, { mode: 0o600 });
  return secret;
}

/**
 * Validate the host's opening hello. Pure. Requires role 'host', a matching
 * secret, and a compatible protocol version.
 * @returns {{ok:boolean, reason?:string}}
 */
export function authenticate(helloMsg, expectedSecret) {
  const v = validateMessage(helloMsg);
  if (!v.ok) return { ok: false, reason: v.versionMismatch ? 'protocol_version' : 'bad_message' };
  if (helloMsg.type !== MSG.HELLO) return { ok: false, reason: 'not_hello' };
  const p = helloMsg.payload || {};
  if (p.role !== 'host') return { ok: false, reason: 'not_host' };
  if (!expectedSecret || p.secret !== expectedSecret) return { ok: false, reason: 'bad_secret' };
  return { ok: true };
}

export class HostBridge {
  /** @param {{onMessage:(msg:object)=>void, onStatus?:(s:string)=>void, dir?:string, log?:Function}} io */
  constructor(io = {}) {
    this.onMessage = io.onMessage || (() => {});
    this.onStatus = io.onStatus || (() => {});
    this.log = io.log || (() => {});
    this.dir = io.dir || appDataDir();
    this.endpoint = io.endpoint || appEndpoint();   // injectable for tests
    this.secret = ensurePairingSecret(this.dir);
    this.server = null;
    this.sock = null;      // the authenticated host socket
    this.authed = false;
  }

  start() {
    const endpoint = this.endpoint;
    // On Windows a stale pipe is fine; on POSIX remove a stale socket file first.
    if (process.platform !== 'win32') { try { fs.unlinkSync(endpoint); } catch { /* none */ } }
    this.server = net.createServer((sock) => this._onConn(sock));
    this.server.on('error', (e) => { this.log({ event: 'bridge_error', code: e && e.code }); this.onStatus('error'); });
    this.server.listen(endpoint, () => this.onStatus('listening'));
  }

  _onConn(sock) {
    const dec = new MessageDecoder();
    this.sock = sock; this.authed = false;
    sock.on('data', (chunk) => {
      let msgs; try { msgs = dec.push(chunk); } catch { sock.destroy(); return; }
      for (const m of msgs) {
        if (!this.authed) {
          const a = authenticate(m, this.secret);
          if (!a.ok) { this.log({ event: 'auth_fail', reason: a.reason }); sock.destroy(); this.onStatus('auth_failed'); return; }
          this.authed = true; this.onStatus('connected');
          continue;
        }
        this.onMessage(m);
      }
    });
    sock.on('close', () => { if (this.sock === sock) { this.sock = null; this.authed = false; this.onStatus('disconnected'); } });
    sock.on('error', () => {});
  }

  /** Send a protocol message to the extension (through the host). */
  send(msg) { if (this.sock && this.authed) { try { this.sock.write(encodeMessage(msg)); return true; } catch { return false; } } return false; }

  get connected() { return this.authed; }
  get protocolVersion() { return PROTOCOL_VERSION; }

  stop() {
    try { if (this.sock) this.sock.destroy(); } catch { /* */ }
    try { if (this.server) { this.server.close(); this.server.unref(); } } catch { /* */ }
    this.sock = null; this.authed = false;
  }
}
