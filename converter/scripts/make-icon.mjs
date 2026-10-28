/**
 * Renders the Eloshon Converter icon (orange square + white swap-arrows) to
 * build/icon.png at 512×512, using Electron's renderer to rasterize an SVG.
 *   node node_modules/electron/cli.js scripts/make-icon.mjs
 */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 512;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="#F26B1D"/>
  <g stroke="#fff" stroke-width="34" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M128 208h224l-78-78"/>
    <path d="M384 304H160l78 78"/>
  </g>
</svg>`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: SIZE, height: SIZE, show: false, backgroundColor: '#00000000', frame: false, transparent: true });
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 350));
  const img = await w.webContents.capturePage();
  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), img.toPNG());
  const s = img.getSize();
  console.log('icon written', s.width + 'x' + s.height, '→ build/icon.png');
  app.exit(0);
});
