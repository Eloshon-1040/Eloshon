// Copies the shared design tokens and fonts into the Converter renderer.
// The Converter is packaged from converter/ only, so it cannot load ../shared/design/ at run time: it ships this
// committed copy instead. test/design-sync.test.mjs fails when the copy differs from shared/design/.
//   npm run sync:design      (also the first step of `npm run dist`)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SRC = path.resolve(ROOT, '../shared/design');
export const DEST = path.join(ROOT, 'app/renderer/design');
// The Converter takes the base and its own accent file; tokens.scraper.css is not shipped.
export const FILES = ['tokens.base.css', 'tokens.converter.css'];

export function designFiles() {
  const fonts = fs.readdirSync(path.join(SRC, 'fonts')).filter((f) => /\.(woff2|txt)$/.test(f)).sort().map((f) => `fonts/${f}`);
  return [...FILES, ...fonts];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!fs.existsSync(SRC)) { console.error(`sync-design: ${SRC} not found`); process.exit(1); }
  fs.rmSync(DEST, { recursive: true, force: true });
  for (const f of designFiles()) {
    fs.mkdirSync(path.dirname(path.join(DEST, f)), { recursive: true });
    fs.copyFileSync(path.join(SRC, f), path.join(DEST, f));
  }
  console.log(`sync-design: copied ${designFiles().length} files -> app/renderer/design/`);
}
