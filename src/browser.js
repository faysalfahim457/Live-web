'use strict';
// One isolated Chromium (Playwright) per collection session. Streams the page as CDP screencast frames
// and accepts remote input. All network traffic is forced through the filtering egress proxy.
const { chromium } = require('playwright');
const { EventEmitter } = require('events');
const { redactUrl } = require('./util');

const PRESETS = { desktop: { width: 1440, height: 900 }, tablet: { width: 768, height: 1024 }, mobile: { width: 390, height: 844 } };

const MUTATION_SCRIPT = `(() => {
  if (window.__wcm) return;
  Object.defineProperty(window, '__wcm', { value: { n: 0 }, enumerable: false });
  try {
    new MutationObserver(() => { window.__wcm.n++; }).observe(document, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['src', 'srcset', 'href', 'data-src', 'data-srcset', 'poster'] });
  } catch (e) {}
})();`;

const AUTOSCROLL = `async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const startY = window.scrollY; let lastH = -1;
  for (let i = 0; i < 40; i++) {
    window.scrollBy(0, Math.round(window.innerHeight * 0.8));
    await sleep(350);
    const h = document.documentElement.scrollHeight;
    if (Math.ceil(window.scrollY + window.innerHeight) >= h - 2) { await sleep(600); if (document.documentElement.scrollHeight === lastH) break; lastH = document.documentElement.scrollHeight; }
  }
  window.scrollTo(0, startY);
}`;

function clampViewport(v) {
  const w = Math.round(Number(v && v.width)); const h = Math.round(Number(v && v.height));
  if (!(w >= 200 && w <= 3840 && h >= 200 && h <= 2400)) return null;
  return { width: w, height: h };
}

class BrowserController extends EventEmitter {
  constructor({ cfg, proxy, collector, log }) {
    super();
    this.cfg = cfg; this.proxy = proxy; this.collector = collector; this.log = log;
    this.closed = false; this.loading = false; this.scanning = false; this.scanAbort = false;
    this.homeUrl = null; this.lastError = null; this.preset = 'desktop';
    this.nav = { canGoBack: false, canGoForward: false };
    this.streaming = false; this._inq = Promise.resolve(); this._pending = 0;
    this._mut = { last: -1, seen: -1, snapped: -1, busy: false };
  }

  async launch(viewport, preset = 'desktop') {
    this.viewport = viewport; this.preset = preset;
    this.browser = await chromium.launch({
      headless: true,
      chromiumSandbox: !this.cfg.chromiumNoSandbox,
      proxy: { server: `http://127.0.0.1:${this.proxy.port}`, bypass: '<-loopback>' },
      args: ['--disable-dev-shm-usage', '--disable-background-networking', '--disable-extensions', '--disable-sync', '--no-first-run', '--mute-audio',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--deny-permission-prompts', '--disable-component-update', '--disable-features=Translate,MediaRouter'],
    });
    this.browser.on('disconnected', () => { if (!this.closed) this.emit('terminated', 'The browser process ended unexpectedly.'); });
    const major = (this.browser.version() || '120').split('.')[0];
    this.uaDesktop = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    this.uaMobile = `Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
    this.context = await this.browser.newContext({
      viewport, userAgent: preset === 'desktop' ? this.uaDesktop : this.uaMobile, serviceWorkers: 'block', acceptDownloads: false,
      locale: 'en-US', permissions: [], ignoreHTTPSErrors: false, bypassCSP: false,
    });
    await this.context.addInitScript(MUTATION_SCRIPT);
    this.context.on('response', (r) => { this._checkBlocked(r); this.collector.handleResponse(r); });
    this.context.on('requestfailed', (r) => this.collector.onRequestFailed(r));
    this.page = await this.context.newPage();
    this._wirePage(this.page);
    this.context.on('page', (p) => this._onNewPage(p));
    this.cdp = await this.context.newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', (f) => this._onFrame(f));
    this._poller = setInterval(() => this._poll().catch(() => {}), 1200);
  }

  _wirePage(page) {
    page.on('framenavigated', (f) => {
      if (f !== page.mainFrame()) return;
      const u = f.url();
      if (/^https?:/i.test(u)) { this.collector.onNavigated(u); this._mut = { last: -1, seen: -1, snapped: -1, busy: false }; }
      this._refreshNav();
    });
    page.on('domcontentloaded', () => { this.loading = false; this._emitState(); });
    page.on('load', () => {
      this.loading = false; this._emitState();
      setTimeout(() => this.collector.snapshotPage(page, { reason: 'load', screenshot: true }).catch(() => {}), 900);
    });
    page.on('dialog', (d) => { (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {}); });
    page.on('close', () => { if (!this.closed && page === this.page) this.emit('terminated', 'The browser page was closed.'); });
    page.on('crash', () => this.emit('terminated', 'The browser page crashed.'));
  }

  // Popups / target=_blank stay inside the single remote tab.
  async _onNewPage(np) {
    if (np === this.page) return;
    try {
      let u = 'about:blank';
      for (let i = 0; i < 40 && (u === 'about:blank' || u === ''); i++) { await new Promise((r) => setTimeout(r, 100)); u = np.url(); }
      await np.close({ runBeforeUnload: false }).catch(() => {});
      if (/^https?:/i.test(u)) this.navigate(u).catch(() => {});
    } catch { /* ignore */ }
  }

  upstreamError(code, host) {
    if (code === 'ECONNREFUSED') return { code: 'CONNECTION_REFUSED', message: `The server at "${host}" refused the connection.`, retryable: true };
    if (code === 'ETIMEDOUT') return { code: 'TIMEOUT', message: `"${host}" did not respond in time.`, retryable: true };
    if (code === 'ENOTFOUND') return { code: 'DNS_FAILURE', message: `The domain "${host}" could not be found (DNS failure).`, retryable: true };
    return { code: 'CONNECTION_FAILED', message: `Could not connect to "${host}".`, retryable: true };
  }

  _checkBlocked(resp) {
    const up = resp.headers()['x-webcollector-upstream-error'];
    if (up) { let host = ''; try { host = new URL(resp.url()).hostname; } catch { /* ignore */ } try { if (resp.request().isNavigationRequest()) this._error(this.upstreamError(up, host)); } catch { /* ignore */ } return; }
    const h = resp.headers()['x-webcollector-blocked'];
    if (h) {
      let msg = h; try { msg = decodeURIComponent(h); } catch { /* raw */ }
      this._error({ code: 'BLOCKED_URL', message: `Blocked by network policy: ${msg}`, retryable: false });
      return;
    }
    try {
      const rq = resp.request();
      if (rq.isNavigationRequest() && rq.frame() === this.page.mainFrame() && resp.status() >= 400) {
        this._error({ code: 'HTTP_ERROR', message: `The website answered with HTTP ${resp.status()}. It may be blocking automated browsers or the page does not exist.`, retryable: true });
      }
    } catch { /* ignore */ }
  }

  _error(err) { this.lastError = err; this.emit('error-event', err); this._emitState(); }

  mapNavError(e, url) {
    const msg = String(e && e.message || e);
    let host = ''; try { host = new URL(url).hostname; } catch { /* ignore */ }
    if (/ERR_ABORTED|interrupted by another navigation/.test(msg)) return null;
    if (/Target (page, context or browser )?has been closed|browser has been closed|Target closed/.test(msg)) return { code: 'SESSION_TERMINATED', message: 'The browser session was terminated.', retryable: false };
    if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/.test(msg)) return { code: 'DNS_FAILURE', message: `The domain "${host}" could not be found (DNS failure).`, retryable: true };
    if (/ERR_CONNECTION_REFUSED/.test(msg)) return { code: 'CONNECTION_REFUSED', message: `The server at "${host}" refused the connection.`, retryable: true };
    if (/Timeout|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT/.test(msg)) return { code: 'TIMEOUT', message: `"${host}" did not respond in time.`, retryable: true };
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(msg)) {
      const why = this.proxy.blocked.get(host.toLowerCase());
      const up = this.proxy.upstreamErrors.get(host.toLowerCase());
      if (!why && up) return this.upstreamError(up, host);
      return why ? { code: 'BLOCKED_URL', message: `Blocked by network policy: ${why}`, retryable: false } : { code: 'CONNECTION_FAILED', message: `Could not connect to "${host}".`, retryable: true };
    }
    if (/ERR_CERT|ERR_SSL|SSL_PROTOCOL/.test(msg)) return { code: 'BLOCKED_RENDER', message: `"${host}" has an invalid or unsupported TLS certificate, so it cannot be rendered.`, retryable: false };
    if (/ERR_BLOCKED_BY|ERR_INVALID_AUTH|ERR_UNSAFE_PORT/.test(msg)) return { code: 'BLOCKED_RENDER', message: 'The website refused to be displayed.', retryable: false };
    if (/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_FAILED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/.test(msg)) return { code: 'CONNECTION_FAILED', message: `The connection to "${host}" was lost.`, retryable: true };
    return { code: 'NAVIGATION_FAILED', message: 'The page could not be loaded.', retryable: true };
  }

  async navigate(url) {
    this.lastError = null; this.loading = true;
    if (!this.homeUrl) this.homeUrl = url;
    this._emitState();
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.cfg.navTimeoutMs });
    } catch (e) {
      this.loading = false;
      const err = this.mapNavError(e, url);
      if (err) { this.collector.markPageFailed(url, err.message); this._error(err); } else this._emitState();
      return;
    }
    this.loading = false; this._emitState();
  }

  async _history(dir) {
    this.lastError = null;
    try {
      this.loading = true; this._emitState();
      if (dir === 'back') await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: this.cfg.navTimeoutMs });
      else if (dir === 'forward') await this.page.goForward({ waitUntil: 'domcontentloaded', timeout: this.cfg.navTimeoutMs });
      else await this.page.reload({ waitUntil: 'domcontentloaded', timeout: this.cfg.navTimeoutMs });
    } catch (e) {
      const err = this.mapNavError(e, this.page.url());
      if (err) this._error(err);
    }
    this.loading = false; await this._refreshNav();
  }
  back() { return this._history('back'); }
  forward() { return this._history('forward'); }
  reload() { return this._history('reload'); }
  home() { return this.homeUrl ? this.navigate(this.homeUrl) : Promise.resolve(); }
  async stop() {
    this.scanAbort = true;
    try { await this.cdp.send('Page.stopLoading'); } catch { /* ignore */ }
    this.loading = false; this._emitState();
  }

  async _refreshNav() {
    try {
      const h = await this.cdp.send('Page.getNavigationHistory');
      this.nav = { canGoBack: h.currentIndex > 0, canGoForward: h.currentIndex < h.entries.length - 1 };
    } catch { /* ignore */ }
    this._emitState();
  }

  async setViewport(viewport, preset) {
    const v = clampViewport(viewport);
    if (!v) throw Object.assign(new Error('Viewport must be 200–3840 wide and 200–2400 high.'), { code: 'BAD_REQUEST' });
    this.viewport = v; this.preset = preset || 'custom';
    await this.page.setViewportSize(v);
    try { await this.cdp.send('Emulation.setUserAgentOverride', { userAgent: this.preset === 'desktop' || (this.preset === 'custom' && v.width >= 1000) ? this.uaDesktop : this.uaMobile }); } catch { /* ignore */ }
    if (this.streaming) { await this._stopCast(); await this._startCast(); }
    this._emitState();
  }

  state() {
    let url = null; try { url = this.page && this.page.url(); } catch { /* ignore */ }
    return {
      url: url && url !== 'about:blank' ? redactUrl(url) : null, loading: this.loading, scanning: this.scanning,
      canGoBack: this.nav.canGoBack, canGoForward: this.nav.canGoForward,
      viewport: { ...this.viewport, preset: this.preset }, homeUrl: this.homeUrl ? redactUrl(this.homeUrl) : null, lastError: this.lastError,
    };
  }
  _emitState() { if (!this.closed) this.emit('state', this.state()); }

  // ---------- streaming ----------
  async startStream() { if (this.streaming) return; this.streaming = true; await this._startCast(); await this.sendOneFrame(); }
  async stopStream() { if (!this.streaming) return; this.streaming = false; await this._stopCast(); }
  async _startCast() {
    try { await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: this.cfg.screencastQuality, maxWidth: this.viewport.width, maxHeight: this.viewport.height, everyNthFrame: 1 }); } catch { /* page closing */ }
  }
  async _stopCast() { try { await this.cdp.send('Page.stopScreencast'); } catch { /* ignore */ } }
  _onFrame(f) {
    this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    if (this.streaming) this.emit('frame', Buffer.from(f.data, 'base64'));
  }
  async sendOneFrame() {
    try { const b = await this.page.screenshot({ type: 'jpeg', quality: this.cfg.screencastQuality, timeout: 5000 }); this.emit('frame', b); } catch { /* ignore */ }
  }

  // ---------- input ----------
  input(m) {
    if (this.closed || !m || typeof m !== 'object') return;
    if (this._pending > 40 && (m.t === 'move')) return; // drop stale pointer moves under load
    this._pending++;
    this._inq = this._inq.then(() => this._doInput(m)).catch(() => {}).finally(() => { this._pending--; });
  }
  async _doInput(m) {
    const p = this.page; const num = (v) => (Number.isFinite(+v) ? +v : 0);
    const x = Math.max(0, Math.min(this.viewport.width, num(m.x))); const y = Math.max(0, Math.min(this.viewport.height, num(m.y)));
    const button = ['left', 'right', 'middle'].includes(m.button) ? m.button : 'left';
    switch (m.t) {
      case 'move': await p.mouse.move(x, y); break;
      case 'down': await p.mouse.move(x, y); await p.mouse.down({ button }); break;
      case 'up': await p.mouse.move(x, y); await p.mouse.up({ button }); break;
      case 'click': await p.mouse.click(x, y, { button }); break;
      case 'wheel': await p.mouse.move(x, y); await p.mouse.wheel(Math.max(-3000, Math.min(3000, num(m.dx))), Math.max(-3000, Math.min(3000, num(m.dy)))); this.emit('scroll'); break;
      case 'key': { const k = String(m.key || '').slice(0, 40); if (k) await p.keyboard.press(k === ' ' ? 'Space' : k); break; }
      case 'text': { const t = String(m.text || '').slice(0, 2000); if (t) await p.keyboard.insertText(t); break; }
      default: break;
    }
  }

  // ---------- DOM change polling ----------
  async _poll() {
    if (this.closed || !this.collector.enabled || this.loading || this.scanning || this._mut.busy) return;
    const u = this.page.url(); if (!/^https?:/i.test(u)) return;
    let n; try { n = await this.page.evaluate('window.__wcm ? window.__wcm.n : -1'); } catch { return; }
    const m = this._mut;
    if (n < m.snapped) m.snapped = -1; // new document
    if (n !== m.seen) { m.seen = n; return; } // still changing
    if (n !== m.snapped && n >= 0) {
      m.busy = true;
      try { await this.collector.snapshotPage(this.page, { reason: 'dom-change' }); m.snapped = n; } finally { m.busy = false; }
    }
  }

  async scanCurrentPage() {
    if (this.scanning) return;
    if (!/^https?:/i.test(this.page.url())) throw Object.assign(new Error('Open a website first.'), { code: 'BAD_REQUEST' });
    this.scanning = true; this.scanAbort = false; this._emitState();
    try {
      await Promise.race([this.page.evaluate(`(${AUTOSCROLL})()`), new Promise((r) => setTimeout(r, 30000))]).catch(() => {});
      await this.collector.queue.idle(10000);
      await this.collector.snapshotPage(this.page, { reason: 'scan', screenshot: false, fullScreenshot: true });
      await this.collector.queue.idle(5000);
    } finally { this.scanning = false; this._emitState(); }
  }

  async close() {
    if (this.closed) return; this.closed = true;
    clearInterval(this._poller);
    const t = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 4000))]).catch(() => {});
    try { if (this.cdp) await t(this.cdp.detach()); } catch { /* ignore */ }
    if (this.context) await t(this.context.close());
    if (this.browser) await t(this.browser.close());
    this.removeAllListeners();
  }
}

module.exports = { BrowserController, PRESETS, clampViewport };
