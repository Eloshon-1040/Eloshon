/**
 * OS abstraction — the only place aware of per-platform differences (app-data
 * paths, window chrome). UI + engine stay OS-agnostic. Pass Electron's
 * app.getPath('userData'). User data never lives in the repo/bundle.
 */
import path from 'node:path';
import fs from 'node:fs';

export const isMac = process.platform === 'darwin';
export const isWin = process.platform === 'win32';
export const isLinux = process.platform === 'linux';

export function appDirs(userDataPath) {
  const data = path.join(userDataPath, 'data');
  return {
    userData: userDataPath,
    data,
    outputs: path.join(data, 'outputs'),
    logs: path.join(userDataPath, 'logs'),
    configFile: path.join(userDataPath, 'config.json'),
    licenseFile: path.join(userDataPath, 'license.json'),
    recentFile: path.join(userDataPath, 'recent.json'),
    templatesFile: path.join(userDataPath, 'templates.json'),
    // Learned knowledge (Phase 5): user decisions / samples / taught formats.
    knowledgeDir: path.join(userDataPath, 'knowledge-local'),
  };
}

export function ensureDirs(d) {
  for (const x of [d.data, d.outputs, d.logs, d.knowledgeDir]) fs.mkdirSync(x, { recursive: true });
  return d;
}

/** macOS: native traffic lights (hidden title bar). Windows/Linux: frameless (custom controls). */
export function windowChrome() {
  if (isMac) return { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 14 } };
  return { frame: false };
}

export const modKey = isMac ? '⌘' : 'Ctrl';
