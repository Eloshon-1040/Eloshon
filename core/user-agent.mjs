/**
 * Default User-Agent of the HTTP lane — computed from the Chromium the app ships,
 * never from a version written in the code.
 *
 * Why: the HTTP fetcher and the local browser lane share one User-Agent
 * (app/controller.mjs passes the fetcher's UA to BrowserSession). A UA that names
 * an old Chrome while the real Chromium is twenty versions newer is a mismatch a
 * site can read. The version therefore comes from the browser we actually run:
 *   1. playwright-core/browsers.json — `browserVersion` of the bundled Chromium
 *      (the binary the local browser lane launches; unpacked in the installer);
 *   2. process.versions.chrome — the Electron runtime's own Chromium (main process);
 *   3. none: a clear error (the engine cannot invent a browser version).
 *
 * The string follows Chrome's reduced User-Agent (major version only, frozen OS
 * token per platform): that is what a real Chrome sends since version 101.
 *
 * Client hints (Sec-CH-UA…) are NOT added — decision recorded in the project skill,
 * §6: Node's fetch (undici) forces `sec-fetch-mode: cors` on every request and lets
 * nothing override it, so no set of sec-* headers could match a real Chrome
 * navigation; a partial set would be more telling than none. The TLS stack and the
 * HTTP version stay Node's; only the UA string is aligned.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** Frozen OS tokens of Chrome's reduced User-Agent. */
export const PLATFORM_TOKENS = Object.freeze({
  win32: 'Windows NT 10.0; Win64; x64',
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  linux: 'X11; Linux x86_64',
});

/** The OS token for a Node platform id (Linux's token for any other Unix). */
export function platformToken(platform = process.platform) {
  return PLATFORM_TOKENS[platform] || PLATFORM_TOKENS.linux;
}

/** `{ version, major, source }` of the Chromium that playwright-core ships, or null. */
export function bundledChromiumVersion({ readFile = (p) => fs.readFileSync(p, 'utf8'), resolve = null } = {}) {
  try {
    const req = resolve || createRequire(import.meta.url).resolve;
    const pkg = req('playwright-core/package.json');
    const list = JSON.parse(readFile(path.join(path.dirname(pkg), 'browsers.json')));
    const entry = (list.browsers || []).find((b) => b.name === 'chromium' && b.browserVersion);
    const major = entry ? Number(String(entry.browserVersion).split('.')[0]) : NaN;
    if (!Number.isInteger(major) || major <= 0) return null;
    return { version: String(entry.browserVersion), major, source: 'playwright-core' };
  } catch { return null; }
}

/** `{ version, major, source }` of the Electron runtime's Chromium, or null outside Electron. */
export function runtimeChromiumVersion(versions = process.versions) {
  const v = versions && versions.chrome;
  const major = v ? Number(String(v).split('.')[0]) : NaN;
  return Number.isInteger(major) && major > 0 ? { version: String(v), major, source: 'electron' } : null;
}

/** Chrome's reduced User-Agent for a major version and a platform. */
export function userAgentFor({ major, platform = process.platform }) {
  if (!Number.isInteger(major) || major <= 0) throw new Error('user-agent: a Chromium major version is required');
  return `Mozilla/5.0 (${platformToken(platform)}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * The default User-Agent and where its version comes from.
 * @returns {{ userAgent:string, major:number, version:string, source:'playwright-core'|'electron' }}
 */
export function resolveDefaultUserAgent({ platform = process.platform, versions = process.versions, readFile, resolve } = {}) {
  const found = bundledChromiumVersion({ readFile, resolve }) || runtimeChromiumVersion(versions);
  if (!found) throw new Error('user-agent: no Chromium version source (playwright-core/browsers.json unreadable and not running in Electron)');
  return { userAgent: userAgentFor({ major: found.major, platform }), major: found.major, version: found.version, source: found.source };
}
