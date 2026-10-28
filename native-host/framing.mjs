/**
 * Native Messaging stdio framing (Chrome/Edge/Brave): each message is a 4-byte
 * UInt32 length prefix (native byte order) followed by that many bytes of UTF-8
 * JSON. Pure and unit-tested; no Node stream wiring here.
 *
 * Chrome also caps a single message at 1 MB inbound (extension -> host) and 64 MB
 * outbound; we enforce a conservative cap so a runaway payload can't wedge the host.
 */

export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024; // 64 MB hard ceiling

/** Encode an object to a length-prefixed Buffer. */
export function encodeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  if (json.length > MAX_MESSAGE_BYTES) throw new Error(`message too large (${json.length} bytes)`);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0); // native LE on Windows/macOS x64/arm64
  return Buffer.concat([header, json]);
}

/**
 * Incremental decoder: feed it Buffers as they arrive; it returns any complete
 * messages parsed so far. Handles partial headers and partial/split bodies.
 */
export class MessageDecoder {
  constructor({ maxBytes = MAX_MESSAGE_BYTES } = {}) {
    this.buf = Buffer.alloc(0);
    this.maxBytes = maxBytes;
  }

  /** @param {Buffer} chunk @returns {object[]} complete messages */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const len = this.buf.readUInt32LE(0);
      if (len > this.maxBytes) throw new Error(`framed message exceeds cap (${len})`);
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      out.push(JSON.parse(body.toString('utf8')));
    }
    return out;
  }
}
