#!/usr/bin/env python3
"""
Eloshon Scraper — HARD-UNLOCK sidecar (optional, escalation-only).

Renders ONE url with nodriver (real Chrome over CDP, no automation flags), which
passes anti-bot walls that headless Playwright cannot (e.g. Cloudflare Turnstile).
It does NOT solve CAPTCHAs and does not touch any account — it just lets a real
browser load a public page. Called by the Node engine ONLY when the normal
HTTP → Playwright ladder hits a terminal Cloudflare/anti-bot block.

Contract (kept dead simple so the Node side stays in control):
  python unlock.py --url <URL> [--timeout 45] [--chrome <path>] [--headless]
  → prints the rendered HTML to STDOUT, exits 0
  → on failure prints a one-line JSON error to STDERR, exits non-zero

Node passes the Chrome path it resolved (system Chrome or the bundled Chromium).
"""
import argparse
import asyncio
import re
import sys

CHALLENGE_TITLE = re.compile(r"just a moment|un instant|checking your browser|attention required|verifying you are human", re.I)


def _log(m: str) -> None:
    # Stage trace on STDERR (stdout is reserved for the HTML). Flushed so a hang
    # still shows the last stage reached.
    sys.stderr.write(f"[UNLOCK] {m}\n")
    sys.stderr.flush()


async def render(url: str, timeout: float, chrome_path: str | None, headless: bool) -> str:
    import nodriver as uc
    _log("nodriver imported")
    kwargs = {}
    if chrome_path:
        kwargs["browser_executable_path"] = chrome_path
    if headless:
        kwargs["headless"] = True
    browser = await uc.start(**kwargs)
    _log("nodriver started (real Chrome)")
    try:
        _log(f"navigation started: {url}")
        page = await browser.get(url)
        _log("page opened")
        deadline = asyncio.get_event_loop().time() + timeout
        html = ""
        while asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(2)
            html = await page.get_content()
            m = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
            title = (m.group(1).strip() if m else "")
            _log(f"poll: title={title[:40]!r} bytes={len(html)}")
            # Cleared when the title is no longer a challenge AND the body is real.
            if html and not CHALLENGE_TITLE.search(title) and len(html) > 40000:
                _log("challenge cleared")
                break
        _log(f"page loaded, html bytes = {len(html)}")
        return html
    finally:
        try:
            browser.stop()
        except Exception:
            pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=None)
    ap.add_argument("--timeout", type=float, default=45.0)
    ap.add_argument("--chrome", default=None)
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--selfcheck", action="store_true", help="verify nodriver imports, then exit 0")
    args = ap.parse_args()
    if args.selfcheck:
        # Report the interpreter version alongside the result so the Node side can
        # tell WHICH Python answered (a GUI launch may pick a different one than a
        # shell) and flag a too-new Python (e.g. 3.14) that nodriver can't import yet.
        ver = "%d.%d.%d" % sys.version_info[:3]
        try:
            import nodriver  # noqa: F401
            nv = getattr(nodriver, "__version__", "?")
            print("ok %s nodriver=%s" % (ver, nv))
            return 0
        except Exception as e:  # pragma: no cover
            sys.stderr.write('{"error":"nodriver import failed: %s","python":"%s"}' % (str(e).replace('"', "'")[:240], ver))
            return 3
    if not args.url:
        sys.stderr.write('{"error":"missing --url"}')
        return 64
    try:
        html = asyncio.run(render(args.url, args.timeout, args.chrome, args.headless))
        if not html or len(html) < 500:
            sys.stderr.write('{"error":"empty render"}')
            return 2
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdout.write(html)
        return 0
    except Exception as e:
        sys.stderr.write('{"error":"%s"}' % str(e).replace('"', "'")[:300])
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
