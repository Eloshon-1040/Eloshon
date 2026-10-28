// Decode the bytes of an opened file into text. The app used to read everything
// as UTF-8, so a CSV saved by Excel in Windows-1252 turned "Ébène" into "�b�ne"
// with no warning (the information is gone before the engine even sees it).
//
// Order: BOM → UTF-16 without BOM (every other byte is zero) → strict UTF-8 →
// Windows-1252. The caller shows the detected encoding to the user whenever it
// is not plain UTF-8.

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function utf16Guess(b) {
  // Latin text in UTF-16 has a zero byte in every other position.
  const n = Math.min(b.length, 2000) & ~1;
  if (n < 4) return null;
  let even = 0, odd = 0;
  for (let i = 0; i < n; i += 2) { if (b[i] === 0) even++; if (b[i + 1] === 0) odd++; }
  const half = n / 2;
  if (odd > half * 0.3 && even === 0) return 'utf-16le';
  if (even > half * 0.3 && odd === 0) return 'utf-16be';
  return null;
}

/** @param {Uint8Array} bytes @returns {{ text: string, encoding: string, replacementChars: number }} */
export function decodeBytes(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let encoding;
  let text;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    encoding = 'utf-8';
    text = new TextDecoder('utf-8').decode(b); // strips the BOM
  } else if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    encoding = 'utf-16le';
    text = new TextDecoder('utf-16le').decode(b);
  } else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    encoding = 'utf-16be';
    text = new TextDecoder('utf-16be').decode(b);
  } else {
    const guess = utf16Guess(b);
    if (guess) {
      encoding = guess;
      text = new TextDecoder(guess).decode(b);
    } else {
      try {
        text = strictUtf8.decode(b);
        encoding = 'utf-8';
      } catch {
        // Not valid UTF-8: the usual cause is a Western-European Excel export.
        encoding = 'windows-1252';
        text = new TextDecoder('windows-1252').decode(b);
      }
    }
  }
  return { text, encoding, replacementChars: (text.match(/�/g) || []).length };
}
