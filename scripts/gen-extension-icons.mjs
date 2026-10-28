/**
 * One-off generator for the extension's placeholder icons (brand purple with a
 * lighter diagonal band). Zero dependencies — a minimal PNG encoder over zlib.
 * Replace extension/icons/*.png with real brand art before store submission.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(OUT, { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function png(size) {
  const [r1, g1, b1] = [0x8b, 0x5c, 0xf6];   // brand purple
  const [r2, g2, b2] = [0xb9, 0x9a, 0xfb];   // lighter band
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const band = Math.abs((x + y) - size) < size * 0.16;
      raw[o++] = band ? r2 : r1;
      raw[o++] = band ? g2 : g1;
      raw[o++] = band ? b2 : b1;
      raw[o++] = 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const idat = zlib.deflateSync(raw);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

for (const s of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(OUT, `icon-${s}.png`), png(s));
  console.log(`wrote extension/icons/icon-${s}.png`);
}
