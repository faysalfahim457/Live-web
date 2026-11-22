# WebCollector Studio

Open a website in a **real remote Chromium** (Playwright), browse it normally, and have its public frontend files collected live
(HTML, rendered DOM, CSS, JS, images, SVG/icons, fonts, JSON, source maps, screenshots). Download everything as a streamed ZIP,
then replace it with a new collection. No login, no admin, **no database**: state is in memory, files live in a per-session temp directory.

Stack: Node.js 22 · Playwright + Chromium · `ws` WebSocket · vanilla HTML/CSS/JS. Two runtime dependencies (`playwright`, `ws`).

## Run
```bash
npm install            # installs playwright + ws and downloads Chromium
cp .env.example .env   # optional
npm start              # http://127.0.0.1:3000
```
Open the URL, enter a site address, **Open Website**. Browse in the remote view (mouse, wheel, keyboard; touch scroll/tap on phones).
`Collector` toggles collection, `Scan Current Page` auto-scrolls and captures lazy content + a full-page screenshot,
`Finish` marks the collection **Completed**. **Download ZIP** (menu: current page / HTML / CSS / JS / images / fonts / selected files).
**Replace / New Collection** asks for confirmation, stops the browser, deletes the temp files, clears stats and URL.
Status shows: *Collecting · Completed · Downloading · Ready for New Collection*.

## ZIP layout
```
WebCollector-Project/
  original/          captured bytes exactly as received (index.html, pages/, assets/css|js|images|fonts|other)
  snapshots/         rendered DOM snapshots + screenshots
  reconstructed/     OPTIONAL modified static copy with local relative links (clearly separate)
  metadata/          pages.json, resources.json (URL, type, filename, MIME, size, HTTP status, time, source page, path, SHA-256)
  collector-report.json, README.txt
```
`original/` is never altered. Deviation from the spec's literal tree: the spec's `index.html/pages/assets` live under `original/` so originals and reconstructed output are unmistakably separate.

## Security model
* **Egress proxy** (`src/egress-proxy.js`): Chromium is started with `--proxy-server` pointing to an in-process filtering proxy. Every request,
  redirect hop and WebSocket is validated; DNS is resolved *once by the proxy*, all addresses checked, and the connection is made to that IP
  (stops DNS rebinding). Blocks loopback, RFC1918, link-local/metadata (169.254.169.254), CGNAT, IPv6 private/mapped/6to4, `.local/.internal`, single-label hosts, non-allowed ports, non-http(s).
* URL validation rejects credentials, `file:`, `ftp:`, `javascript:`, obfuscated IPs (`0x7f.1`, decimal, octal).
* Per-session random token in an `HttpOnly; SameSite=Strict` cookie; WebSocket requires cookie **and** matching Origin; POST needs same Origin.
* Collected content is served as `text/plain` / sandboxed with `nosniff`; HTML snapshots render only in a script-less sandboxed iframe.
* Never collected: cookies, storage, request headers, password/hidden-token field values; URL credentials removed and secret-looking query values replaced by `REDACTED`; JSON with `Authorization`, `Cache-Control: private/no-store` or `Set-Cookie` skipped.
* ZIP entry names are validated (no `..`, absolute paths, backslashes). File names sanitised. Temp dir is `0700`, sessions are separate, expire when idle (default 45 min) or after max age (4 h), stale dirs are wiped on start, and **a session is never deleted while a download is streaming**.
* The tool follows pages you open; it does not crawl. Use only on sites you are authorised to inspect. It does not bypass logins, paywalls or CAPTCHAs.

### Production hardening (important)
This service fetches arbitrary URLs for anyone who can reach it. **Put it behind HTTPS and access control** (VPN, basic auth or SSO at nginx/Caddy) — the app itself has no login by design. Run in Docker with CPU/memory limits and a network policy that denies private ranges as a second layer:
```bash
docker build -t webcollector .
docker run -d --name wc -p 127.0.0.1:3000:3000 --memory 2g --cpus 2 --pids-limit 512 --read-only --tmpfs /tmp:size=1g \
  -e CHROMIUM_NO_SANDBOX=true -e TRUST_PROXY=true --restart unless-stopped webcollector
```
Example Caddy: `collector.example.com { basicauth { user <hash> } reverse_proxy 127.0.0.1:3000 }` (WebSocket works automatically).
Systemd alternative: install Node 22 + `npx playwright install --with-deps chromium`, run `node server.js` as an unprivileged user, set `TEMP_ROOT` on a disk with enough space.

## Tests
`npm test` (needs Chromium, `unzip`, `python3`). Suites: security (SSRF, rebinding pinning, filenames), ZIP writer, end-to-end against local fixture
sites (real Chromium: collection, lazy/infinite scroll, scan, multi-page, history, viewport, dedupe, export verification incl. hashes, SSRF probes through the browser,
auth/origin/traversal, replace, download lock, abort, expiry, browser termination, error codes, limits, 400-file project) and UI tests (desktop + Pixel 7 emulation, no horizontal overflow).

## Known limitations (honest list)
* Mobile testing used Chromium **emulation** of an Android phone, not a physical device. Reconnect was tested by closing the socket, not by cutting the network.
* Single remote tab; popups/`target=_blank` navigate that tab. Video/audio are not collected by default.
* CSS-referenced assets are captured only if the browser actually loaded them; unloaded `url()` targets are not fetched.
* Reconstructed copy is best-effort: scripts are kept as captured and may not run offline. ZIPs are limited to 4 GiB (no ZIP64).
* Remote-browser streaming is CDP screencast (JPEG over WebSocket), not WebRTC.
* Sites that block headless/automated browsers or require login/CAPTCHA will not work (by design nothing bypasses them).
* Laravel/MySQL/Redis from the original brief were dropped per the "Temporary Collection Mode" requirements.
