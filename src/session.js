'use strict';
// In-memory sessions with unique temp directories. No database. Everything is deleted on replace/expiry/shutdown.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Collector } = require('./collector');
const { BrowserController, PRESETS, clampViewport } = require('./browser');
const { redactUrl } = require('./util');

const COOKIE = 'wcs';

class AppError extends Error {
  constructor(status, code, message, retryable = false) { super(message); this.status = status; this.code = code; this.retryable = retryable; }
}

class Session extends EventEmitter {
  constructor({ id, token, dir, cfg, proxy, log, startUrl }) {
    super();
    this.id = id; this.token = token; this.dir = dir; this.cfg = cfg; this.proxy = proxy; this.log = log;
    this.startUrl = startUrl; this.startUrlRedacted = redactUrl(startUrl);
    this.createdAt = Date.now(); this.lastActivity = Date.now();
    this.phase = 'collecting'; // collecting | completed | terminated
    this.downloads = 0; this.closing = false; this.clients = new Set();
    this.collector = new Collector({ cfg, dir, log });
    this.browser = new BrowserController({ cfg, proxy, collector: this.collector, log });
    this._wire();
  }

  _wire() {
    const c = this.collector; const b = this.browser;
    c.on('stats', (stats) => this.broadcast({ type: 'stats', stats }));
    c.on('resource', (resource) => this.broadcast({ type: 'resource', resource }));
    c.on('resource-updated', () => this.broadcast({ type: 'resource-updated' }));
    c.on('pages', () => this.broadcast({ type: 'pages' }));
    c.on('failures', () => this.broadcast({ type: 'failures' }));
    c.on('problem', (error) => this.broadcast({ type: 'error', error }));
    b.on('state', () => this.broadcast({ type: 'state', state: this.summary() }));
    b.on('error-event', (error) => this.broadcast({ type: 'error', error }));
    b.on('frame', (buf) => this._frame(buf));
    b.on('terminated', (message) => {
      if (this.closing) return;
      this.phase = 'terminated';
      this.broadcast({ type: 'error', error: { code: 'SESSION_TERMINATED', message: `${message} Your collected files are still available — download them or start a new collection.`, retryable: false } });
      this.broadcast({ type: 'state', state: this.summary() });
    });
  }

  async start(viewport, preset) {
    await this.browser.launch(viewport, preset);
  }

  touch() { this.lastActivity = Date.now(); }

  status() {
    if (this.downloads > 0) return 'downloading';
    if (this.phase === 'completed') return 'completed';
    if (this.phase === 'terminated') return 'terminated';
    return 'collecting';
  }

  summary() {
    return { status: this.status(), phase: this.phase, downloads: this.downloads, startedAt: this.createdAt, startUrl: this.startUrlRedacted, browser: this.browser.state(), collectorOn: this.collector.enabled };
  }

  // ---------- websocket fan-out ----------
  broadcast(obj) {
    if (!this.clients.size) return;
    const s = JSON.stringify(obj);
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(s);
  }
  _frame(buf) {
    for (const ws of this.clients) if (ws.readyState === 1 && ws.bufferedAmount < 1.5 * 1024 * 1024) ws.send(buf, { binary: true });
  }
  async addClient(ws) {
    this.clients.add(ws);
    ws.send(JSON.stringify({ type: 'hello', state: this.summary(), stats: this.collector.stats() }));
    if (this.phase !== 'terminated' && !this.browser.closed) await this.browser.startStream();
  }
  async removeClient(ws) {
    this.clients.delete(ws);
    if (!this.clients.size && !this.browser.closed) await this.browser.stopStream();
  }

  // ---------- collection control ----------
  setCollector(on) {
    if (this.phase === 'terminated') throw new AppError(409, 'SESSION_TERMINATED', 'The browser session has ended.');
    this.collector.setEnabled(on);
    this.phase = on ? 'collecting' : this.phase;
    this.broadcast({ type: 'state', state: this.summary() });
  }
  async finish() {
    if (this.phase === 'terminated') { this.phase = 'completed'; this.broadcast({ type: 'state', state: this.summary() }); return; }
    await this.collector.queue.idle(15000);
    try { if (this.collector.enabled && !this.browser.closed) await this.collector.snapshotPage(this.browser.page, { reason: 'finish', screenshot: true }); } catch { /* best effort */ }
    await this.collector.queue.idle(5000);
    this.collector.setEnabled(false);
    this.phase = 'completed';
    this.broadcast({ type: 'state', state: this.summary() });
  }

  // ---------- download lock ----------
  acquireDownload() {
    if (this.closing) return false;
    this.downloads++; this.touch();
    this.broadcast({ type: 'state', state: this.summary() });
    return true;
  }
  releaseDownload() {
    this.downloads = Math.max(0, this.downloads - 1); this.touch();
    this.broadcast({ type: 'state', state: this.summary() });
  }

  async destroy() {
    this.closing = true;
    for (const ws of this.clients) { try { ws.close(4000, 'session closed'); } catch { /* ignore */ } }
    this.clients.clear();
    this.collector.setEnabled(false);
    await this.browser.close();
    await rmDir(this.dir);
  }
}

async function rmDir(dir) {
  for (let i = 0; i < 4; i++) {
    try { await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* retry */ }
    if (!fs.existsSync(dir)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

class SessionManager {
  constructor({ cfg, proxy, log }) {
    this.cfg = cfg; this.proxy = proxy; this.log = log; this.sessions = new Map(); this.timer = null;
  }

  async init() {
    await fs.promises.mkdir(this.cfg.tempRoot, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(this.cfg.tempRoot, 0o700).catch(() => {});
    // Leftovers from a previous crashed run are never reachable again: delete them.
    for (const d of await fs.promises.readdir(this.cfg.tempRoot)) await rmDir(path.join(this.cfg.tempRoot, d));
    this.timer = setInterval(() => this.sweep().catch((e) => this.log('error', 'sweep failed', { err: e.message })), this.cfg.cleanupIntervalSec * 1000);
    this.timer.unref();
  }

  async create(startUrl, viewport, preset) {
    if (this.sessions.size >= this.cfg.maxSessions) throw new AppError(503, 'BUSY', 'The server is at capacity. Please try again in a few minutes.', true);
    const id = crypto.randomBytes(16).toString('hex'); const token = crypto.randomBytes(32).toString('base64url');
    const dir = path.join(this.cfg.tempRoot, id);
    await fs.promises.mkdir(dir, { mode: 0o700 });
    const s = new Session({ id, token, dir, cfg: this.cfg, proxy: this.proxy, log: this.log, startUrl });
    this.sessions.set(id, s);
    try { await s.start(viewport, preset); } catch (e) {
      this.log('error', 'browser launch failed', { err: e.message });
      this.sessions.delete(id); s.closing = true;
      await s.browser.close().catch(() => {}); await rmDir(dir);
      throw new AppError(500, 'BROWSER_LAUNCH_FAILED', 'The remote browser could not be started. Please try again.', true);
    }
    return s;
  }

  cookieFor(s) { return `${s.id}.${s.token}`; }

  authenticate(cookieHeader) {
    if (!cookieHeader) return null;
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{32})\\.([A-Za-z0-9_-]{43})`).exec(cookieHeader);
    if (!m) return null;
    const s = this.sessions.get(m[1]);
    if (!s || s.closing) return null;
    const a = Buffer.from(m[2]); const b = Buffer.from(s.token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return s;
  }

  async destroy(session, { force = false } = {}) {
    if (!force && session.downloads > 0) throw new AppError(409, 'DOWNLOAD_IN_PROGRESS', 'A download is still running. Wait for it to finish before replacing the collection.');
    session.closing = true; // synchronous: no new download can start from here on
    this.sessions.delete(session.id);
    await session.destroy();
  }

  async sweep() {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) {
      if (s.downloads > 0) continue; // never delete while a ZIP is streaming
      const idle = now - s.lastActivity > this.cfg.sessionIdleMinutes * 60000;
      const old = now - s.createdAt > this.cfg.sessionMaxMinutes * 60000;
      if (idle || old) { this.log('info', 'expiring session', { id: s.id.slice(0, 8), idle, old }); await this.destroy(s).catch(() => {}); }
    }
    // orphaned directories (failed deletes)
    try {
      for (const d of await fs.promises.readdir(this.cfg.tempRoot)) {
        if (this.sessions.has(d)) continue;
        const p = path.join(this.cfg.tempRoot, d);
        const st = await fs.promises.stat(p).catch(() => null);
        if (st && now - st.mtimeMs > 60000) await rmDir(p);
      }
    } catch { /* ignore */ }
  }

  async shutdown() {
    clearInterval(this.timer);
    for (const s of [...this.sessions.values()]) { await this.destroy(s, { force: true }).catch(() => {}); }
  }
}

module.exports = { Session, SessionManager, AppError, COOKIE, PRESETS, clampViewport };
