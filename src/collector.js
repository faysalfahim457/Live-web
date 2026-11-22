'use strict';
// Collection engine: records every permitted public frontend resource of pages the user visits.
// Stores bodies on disk (content-addressed by SHA-256), metadata in memory only.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { sha256, crc32, extFromMime, mimeFromExt, safeFilename, redactUrl, stripHash } = require('./util');
const { safeFetch } = require('./security');

const TYPES = ['html', 'css', 'js', 'images', 'fonts', 'other', 'screenshots'];

// Serialises the DOM in-page. Password values / token-like hidden inputs are never exported.
const SERIALIZE_DOM = `() => {
  const clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll('input').forEach((i) => {
    const t = (i.getAttribute('type') || '').toLowerCase();
    const n = (i.getAttribute('name') || i.id || '');
    if (t === 'password' || (t === 'hidden' && /token|csrf|xsrf|auth|secret|session|nonce|key/i.test(n))) i.removeAttribute('value');
  });
  const dt = document.doctype ? new XMLSerializer().serializeToString(document.doctype) : '<!DOCTYPE html>';
  return dt + '\\n' + clone.outerHTML;
}`;
const INLINE_STYLES = `() => {
  const out = [];
  document.querySelectorAll('style').forEach((s) => { if (s.textContent && s.textContent.trim()) out.push(s.textContent); });
  try { for (const sh of document.adoptedStyleSheets || []) out.push([...sh.cssRules].map((r) => r.cssText).join('\\n')); } catch (e) {}
  return out;
}`;

class Queue {
  constructor(concurrency) { this.c = concurrency; this.running = 0; this.items = []; this.idleWaiters = []; }
  get size() { return this.items.length + this.running; }
  push(fn) { this.items.push(fn); this._next(); }
  cancel() { const n = this.items.length; this.items = []; this._maybeIdle(); return n; }
  _next() {
    while (this.running < this.c && this.items.length) {
      const fn = this.items.shift(); this.running++;
      Promise.resolve().then(fn).catch(() => {}).finally(() => { this.running--; this._next(); this._maybeIdle(); });
    }
  }
  _maybeIdle() { if (this.size === 0) { const w = this.idleWaiters; this.idleWaiters = []; w.forEach((r) => r()); } }
  idle(timeoutMs = 15000) {
    if (this.size === 0) return Promise.resolve(true);
    return new Promise((res) => { const t = setTimeout(() => res(false), timeoutMs); this.idleWaiters.push(() => { clearTimeout(t); res(true); }); });
  }
}

class Collector extends EventEmitter {
  constructor({ cfg, dir, log }) {
    super();
    this.cfg = cfg; this.dir = dir; this.log = log;
    this.storeDir = path.join(dir, 'store');
    fs.mkdirSync(this.storeDir, { recursive: true, mode: 0o700 });
    this.enabled = true;
    this.queue = new Queue(cfg.maxConcurrentCollect);
    this.resources = new Map(); // id -> record
    this.byUrl = new Map(); // normalised url -> id (network resources)
    this.byHash = new Map(); // sha -> id
    this.pages = new Map(); // key -> page
    this.currentUrl = null;
    this.failures = [];
    this.totalBytes = 0; this.duplicates = 0; this.skipped = 0; this.failedCount = 0;
    this.seq = 0; this.pageSeq = 0; this.full = false;
    this._statsTimer = null;
  }

  // ---------- events ----------
  _touch() {
    if (this._statsTimer) return;
    this._statsTimer = setTimeout(() => { this._statsTimer = null; this.emit('stats', this.stats()); }, 200);
  }
  setEnabled(on) {
    this.enabled = !!on;
    if (!on) this.queue.cancel();
    this._touch();
  }

  // ---------- pages ----------
  ensurePage(url) {
    const key = stripHash(url);
    let p = this.pages.get(key);
    if (!p) {
      if (this.pages.size >= this.cfg.maxPages) return null;
      p = { id: `p${++this.pageSeq}`, key, url: redactUrl(url), title: '', status: 'loading', firstVisit: Date.now(), fileIds: new Set(), snapshotIds: [], screenshotIds: [], error: null };
      this.pages.set(key, p);
    }
    return p;
  }
  onNavigated(url) {
    if (!/^https?:/i.test(url)) return null;
    this.currentUrl = url;
    const p = this.ensurePage(url);
    if (p && p.status !== 'loading') p.status = 'loading';
    this._touch(); this.emit('pages');
    return p;
  }
  pageFor(url) { return this.pages.get(stripHash(url)) || null; }
  pageSummary(p) {
    return { id: p.id, url: p.url, title: p.title, status: p.status, files: p.fileIds.size, snapshots: p.snapshotIds.length, firstVisit: p.firstVisit, error: p.error };
  }
  pageList() { return [...this.pages.values()].map((p) => this.pageSummary(p)); }

  // ---------- storage ----------
  _fail(url, reason, extra = {}) {
    this.failedCount++;
    const key = `${url}|${reason}`;
    if (!this.failures.some((f) => f.key === key)) {
      this.failures.push({ key, id: `f${this.failedCount}`, url: redactUrl(url), rawUrl: url, reason, at: Date.now(), ...extra });
      if (this.failures.length > 300) this.failures.shift();
    }
    this._touch(); this.emit('failures');
  }
  _setFull(reason) {
    if (!this.full) { this.full = true; this.emit('problem', { code: 'STORAGE_FULL', message: reason, retryable: false }); }
  }

  /**
   * Store one body. Returns { res, duplicate } or null when refused.
   */
  async addBuffer({ url, rawUrl, type, mime, buf, httpStatus, pageKey, kind = 'network', filename, isFrame = false, countDuplicate = true, title }) {
    if (this.full) return null;
    if (this.resources.size >= this.cfg.maxFiles) { this._setFull(`File limit reached (${this.cfg.maxFiles}). Download the ZIP, then start a new collection.`); return null; }
    if (this.totalBytes + buf.length > this.cfg.maxTotalBytes) { this._setFull('Storage limit for this collection reached. Download the ZIP, then start a new collection.'); return null; }
    const page = pageKey ? this.pages.get(pageKey) : null;
    const hash = sha256(buf);
    const existingId = this.byHash.get(hash);
    if (existingId) {
      const ex = this.resources.get(existingId);
      if (countDuplicate) this.duplicates++;
      if (page) { page.fileIds.add(ex.id); if (!ex.pages.includes(page.id)) ex.pages.push(page.id); }
      if (ex.alsoSeenAt.length < 20 && url && redactUrl(url) !== ex.url && !ex.alsoSeenAt.includes(redactUrl(url))) ex.alsoSeenAt.push(redactUrl(url));
      if ((kind === 'network' || kind === 'sourcemap') && type !== 'html') {
        const nu = stripHash(rawUrl || url);
        if (nu !== stripHash(ex.rawUrl) && !this.byUrl.has(nu)) { this.byUrl.set(nu, ex.id); (ex.aliasRaw = ex.aliasRaw || []).push(nu); }
      }
      this._touch(); this.emit('resource-updated');
      return { res: ex, duplicate: true };
    }
    let name = filename;
    if (!name) {
      let seg = '';
      try { seg = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); } catch { /* keep */ }
      name = seg;
    }
    name = safeFilename(name, type === 'html' ? 'index' : 'file');
    const ext = path.extname(name).slice(1).toLowerCase();
    const wantExt = extFromMime(mime);
    if (!ext && wantExt) name += `.${wantExt}`;
    const res = {
      id: `r${++this.seq}`, url: redactUrl(url), rawUrl: rawUrl || url, type, kind, isFrame,
      filename: name, ext: path.extname(name).slice(1).toLowerCase(), mime: mime || mimeFromExt(ext) || 'application/octet-stream',
      size: buf.length, httpStatus: httpStatus ?? null, collectedAt: new Date().toISOString(), status: 'collected',
      sourcePage: page ? page.url : null, pages: page ? [page.id] : [], sha256: hash, crc32: crc32(buf), storage: `store/${hash}`,
      alsoSeenAt: [], title: title || null,
    };
    // Register synchronously (before any await) so concurrent identical bodies dedupe correctly.
    this.resources.set(res.id, res); this.byHash.set(hash, res.id); this.totalBytes += buf.length;
    try { await fs.promises.writeFile(path.join(this.storeDir, hash), buf, { flag: 'wx', mode: 0o600 }); } catch (e) {
      if (e.code !== 'EEXIST') {
        this.resources.delete(res.id); this.byHash.delete(hash); this.totalBytes -= buf.length;
        if (e.code === 'ENOSPC' || e.code === 'EDQUOT') { this._setFull('The server ran out of temporary storage. Download the ZIP, then start a new collection.'); return null; }
        throw e;
      }
    }
    if ((kind === 'network' || kind === 'sourcemap') && type !== 'html') this.byUrl.set(stripHash(rawUrl || url), res.id);
    if (page) page.fileIds.add(res.id);
    this._touch(); this.emit('resource', this.publicRecord(res));
    return { res, duplicate: false };
  }

  publicRecord(r) {
    return {
      id: r.id, url: r.url, type: r.type, kind: r.kind, filename: r.filename, ext: r.ext, mime: r.mime, size: r.size,
      httpStatus: r.httpStatus, collectedAt: r.collectedAt, status: r.status, sourcePage: r.sourcePage, sha256: r.sha256,
      pages: r.pages, alsoSeenAt: r.alsoSeenAt, title: r.title,
    };
  }
  filePath(r) { return path.join(this.storeDir, r.sha256); }

  list({ type, q, page = 1, pageSize = 50, pageId, ids } = {}) {
    let arr = [...this.resources.values()];
    if (type && type !== 'all') arr = arr.filter((r) => r.type === type);
    if (type === 'all' || !type) arr = arr.filter((r) => r.type !== 'screenshots');
    if (pageId) arr = arr.filter((r) => r.pages.includes(pageId));
    if (ids) { const s = new Set(ids); arr = arr.filter((r) => s.has(r.id)); }
    if (q) { const n = q.toLowerCase(); arr = arr.filter((r) => r.filename.toLowerCase().includes(n) || r.url.toLowerCase().includes(n) || r.mime.includes(n)); }
    arr.sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)));
    const total = arr.length;
    pageSize = Math.min(200, Math.max(1, pageSize | 0));
    page = Math.max(1, page | 0);
    return { total, page, pageSize, items: arr.slice((page - 1) * pageSize, page * pageSize).map((r) => this.publicRecord(r)) };
  }

  stats() {
    const s = { collector: this.enabled, currentUrl: this.currentUrl ? redactUrl(this.currentUrl) : null, pages: this.pages.size, files: 0, bytes: this.totalBytes, failed: this.failedCount, duplicates: this.duplicates, skipped: this.skipped, queue: this.queue.size, full: this.full };
    for (const t of TYPES) s[t] = 0;
    for (const r of this.resources.values()) { s.files++; s[r.type]++; }
    return s;
  }

  // ---------- network capture ----------
  classify(rt, mime, url) {
    let ext = '';
    try { ext = path.extname(new URL(url).pathname).slice(1).toLowerCase(); } catch { /* ignore */ }
    if (rt === 'document') return /html|xhtml/.test(mime) || !mime ? 'html' : 'other';
    if (rt === 'stylesheet') return 'css';
    if (rt === 'script') return 'js';
    if (rt === 'image') return ext === 'ico' || /x-icon|vnd.microsoft.icon/.test(mime) ? 'other' : 'images';
    if (rt === 'font') return 'fonts';
    if (rt === 'fetch' || rt === 'xhr') return this.cfg.collectJson && /json/.test(mime) ? 'other' : null;
    if (rt === 'manifest' || rt === 'texttrack') return 'other';
    if (rt === 'media') return this.cfg.collectMedia ? 'other' : null;
    if (rt === 'other') {
      if (/^image\//.test(mime) && !/x-icon|vnd.microsoft.icon/.test(mime)) return 'images';
      if (/font|woff|opentype|truetype/.test(mime) || ['woff', 'woff2', 'ttf', 'otf'].includes(ext)) return 'fonts';
      if (/javascript|ecmascript/.test(mime)) return 'js';
      if (/css/.test(mime)) return 'css';
      if (/json|manifest|wasm/.test(mime) || ['ico', 'wasm', 'webmanifest', 'map'].includes(ext)) return 'other';
      return null;
    }
    return null; // websocket, ping, eventsource, csp_report...
  }

  handleResponse(resp) {
    if (!this.enabled || this.full) return;
    let req; let url;
    try { req = resp.request(); url = resp.url(); } catch { return; }
    if (!/^https?:/i.test(url) || req.method() !== 'GET') return;
    const status = resp.status();
    if (status >= 300 && status < 400) return;
    let isMainDoc = false; let pageUrl = this.currentUrl;
    try {
      const f = req.frame();
      const main = f.page().mainFrame();
      isMainDoc = req.isNavigationRequest() && f === main;
      pageUrl = isMainDoc ? url : (main.url() && /^https?:/i.test(main.url()) ? main.url() : this.currentUrl);
    } catch { /* detached frame */ }
    const rt = req.resourceType();
    const headers = resp.headers();
    const mime = (headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const type = this.classify(rt, mime, url);
    if (status >= 400) { if (type || rt === 'document') this._fail(url, `HTTP ${status}`, { httpStatus: status, pageUrl: pageUrl && redactUrl(pageUrl), retryable: status >= 500 || status === 429 || status === 408 }); return; }
    if (!type) return;
    this.queue.push(() => this.processResponse(resp, { req, url, status, rt, type, mime, headers, pageUrl, isMainDoc }));
    this._touch();
  }

  async processResponse(resp, c) {
    if (!this.enabled) return;
    const pageKey = c.pageUrl ? stripHash(c.pageUrl) : null;
    if (pageKey && !this.pages.has(pageKey)) this.ensurePage(c.pageUrl);
    const nurl = stripHash(c.url);
    // Never re-read a resource we already hold (same URL) — just associate it with this page.
    if (c.type !== 'html' && this.byUrl.has(nurl)) {
      const ex = this.resources.get(this.byUrl.get(nurl)); const page = this.pages.get(pageKey);
      if (page && ex) { page.fileIds.add(ex.id); if (!ex.pages.includes(page.id)) ex.pages.push(page.id); }
      this.duplicates++; this._touch(); return;
    }
    const cl = Number(c.headers['content-length']);
    if (cl > this.cfg.maxFileBytes) { this.skipped++; this._fail(c.url, `Skipped: larger than ${Math.round(this.cfg.maxFileBytes / 1048576)} MB limit`, { retryable: false }); return; }
    if (c.type === 'other' && /json/.test(c.mime)) {
      // Do not collect personalised / authenticated API responses.
      const reqH = c.req.headers();
      const cc = (c.headers['cache-control'] || '').toLowerCase();
      if (reqH.authorization || reqH['x-api-key'] || reqH['x-auth-token'] || /private|no-store/.test(cc) || c.headers['set-cookie']) { this.skipped++; return; }
    }
    let body;
    try { body = await resp.body(); } catch { return; /* redirect, aborted, or page closed */ }
    if (!this.enabled) return;
    if (body.length > this.cfg.maxFileBytes) { this.skipped++; this._fail(c.url, `Skipped: larger than ${Math.round(this.cfg.maxFileBytes / 1048576)} MB limit`, { retryable: false }); return; }
    let filename;
    if (c.type === 'html') filename = pageFileBase(c.url) + '.html';
    const added = await this.addBuffer({ url: c.url, type: c.type, mime: c.mime, buf: body, httpStatus: c.status, pageKey, kind: 'network', filename, isFrame: c.type === 'html' && !c.isMainDoc });
    if (added && !added.duplicate) {
      if (c.type === 'js' && this.cfg.collectSourceMaps) this._maybeSourceMap(added.res, body, c.url, c.headers, pageKey);
      if (c.type === 'js' || (c.type === 'html' && c.isMainDoc)) this._discoverChunks(body, c.url, pageKey);
      if (c.type === 'html' && c.isMainDoc) { const p = this.pages.get(pageKey); if (p) p.originalId = added.res.id; }
    } else if (added && added.duplicate && c.type === 'html' && c.isMainDoc) {
      const p = this.pages.get(pageKey); if (p && !p.originalId) p.originalId = added.res.id;
    }
  }

  _maybeSourceMap(res, body, url, headers, pageKey) {
    let ref = headers.sourcemap || headers['x-sourcemap'];
    if (!ref) {
      const tail = body.subarray(Math.max(0, body.length - 1024)).toString('utf8');
      const m = /[#@]\s*sourceMappingURL=([^\s*'"]+)/.exec(tail);
      if (m) ref = m[1];
    }
    if (!ref || ref.startsWith('data:')) return;
    let mapUrl; try { mapUrl = new URL(ref, url).toString(); } catch { return; }
    if (!/^https?:/i.test(mapUrl) || this.byUrl.has(stripHash(mapUrl))) return;
    this.queue.push(async () => {
      if (!this.enabled) return;
      try {
        const r = await safeFetch(mapUrl, this.cfg, { maxBytes: this.cfg.maxFileBytes });
        if (r.status !== 200) return; // maps are optional; a 404 is not a failure
        await this.addBuffer({ url: mapUrl, type: 'other', mime: 'application/json', buf: r.body, httpStatus: r.status, pageKey, kind: 'sourcemap', filename: safeFilename(path.basename(new URL(mapUrl).pathname) || 'bundle.map') });
      } catch { /* optional resource */ }
    });
  }

  // Webpack-style apps load most of their code lazily as numbered chunks, so the browser only requests the ones the visitor happened to trigger.
  // The runtime contains the complete id -> file-name table; read it and fetch every chunk so the collection is complete.
  _discoverChunks(buf, baseUrl, pageKey) {
    if (!this.cfg.discoverChunks || buf.length > 3 * 1024 * 1024) return;
    const t = buf.toString('utf8');
    if (!/\.chunk\.js|\.js"/.test(t) || !/\.p\s*\+/.test(t)) return;
    const m = /\.p\s*\+\s*"([^"]*)"\s*\+\s*(?:\(\s*\{([^}]*)\}\s*\[(\w+)\]\s*\|\|\s*\3\s*\)|\w+)\s*\+\s*"\."\s*\+\s*\{([^}]*)\}\s*\[\w+\]\s*\+\s*"(\.[\w.]*)"/.exec(t);
    if (!m) return;
    const pp = /\.p\s*=\s*"([^"]*)"/.exec(t);
    const pub = pp ? pp[1] : '';
    const kv = (txt) => { const o = {}; if (txt) for (const x of txt.matchAll(/"?(\d+)"?\s*:\s*"([^"]*)"/g)) o[x[1]] = x[2]; return o; };
    const names = kv(m[2]); const hashes = kv(m[4]);
    this.chunksQueued = this.chunksQueued || 0;
    for (const id of Object.keys(hashes)) {
      if (this.chunksQueued >= this.cfg.maxChunks) break;
      let url; try { url = new URL(`${pub}${m[1]}${names[id] || id}.${hashes[id]}${m[5]}`, baseUrl).toString(); } catch { continue; }
      if (!/^https?:/i.test(url) || this.byUrl.has(stripHash(url))) continue;
      this.chunksQueued++;
      this.queue.push(async () => {
        if (!this.enabled || this.full || this.byUrl.has(stripHash(url))) return;
        try {
          const r = await safeFetch(url, this.cfg, { maxBytes: this.cfg.maxFileBytes });
          if (r.status !== 200) return;
          await this.addBuffer({ url, type: 'js', mime: 'application/javascript', buf: r.body, httpStatus: 200, pageKey, kind: 'network' });
        } catch { /* optional resource */ }
      });
    }
  }

  onRequestFailed(req) {
    if (!this.enabled) return;
    let err = ''; let url = '';
    try { err = (req.failure() || {}).errorText || ''; url = req.url(); } catch { return; }
    if (!/^https?:/i.test(url) || /ERR_ABORTED|ERR_BLOCKED_BY_ORB/.test(err)) return; // normal cancellations
    this._fail(url, err.replace(/^net::/, '') || 'Request failed', { retryable: !/TUNNEL|PROXY|BLOCKED/.test(err), pageUrl: this.currentUrl && redactUrl(this.currentUrl) });
  }

  // ---------- page snapshots ----------
  async snapshotPage(page, { reason = 'auto', screenshot = false, fullScreenshot = false } = {}) {
    if (!this.enabled) return null;
    const url = page.url();
    if (!/^https?:/i.test(url)) return null;
    const p = this.ensurePage(url);
    if (!p) return null;
    const key = p.key;
    let html;
    try { html = await page.evaluate(`(${SERIALIZE_DOM})()`); } catch { return null; }
    if (page.url() !== url) return null; // navigated away mid-snapshot
    let title = ''; try { title = await page.title(); } catch { /* ignore */ }
    p.title = title || p.title;
    let created = null;
    if (typeof html === 'string' && html.length) {
      const buf = Buffer.from(html, 'utf8');
      if (p.snapshotIds.length < this.cfg.maxSnapshotsPerPage || reason === 'scan') {
        const r = await this.addBuffer({ url: `${url}`, type: 'html', mime: 'text/html', buf, httpStatus: 200, pageKey: key, kind: 'snapshot', filename: `${pageFileBase(url)}.snapshot.html`, countDuplicate: false, title });
        if (r && !r.duplicate) { p.snapshotIds.push(r.res.id); created = r.res; }
        else if (r && r.duplicate && !p.snapshotIds.includes(r.res.id) && r.res.kind === 'snapshot') p.snapshotIds.push(r.res.id);
      }
    }
    try {
      const styles = await page.evaluate(`(${INLINE_STYLES})()`);
      let i = 0;
      for (const css of styles) {
        i++;
        await this.addBuffer({ url: `${url}#inline-style-${i}`, rawUrl: `${url}#inline-style-${i}`, type: 'css', mime: 'text/css', buf: Buffer.from(css, 'utf8'), httpStatus: null, pageKey: key, kind: 'inline-style', filename: `${pageFileBase(url)}-inline-${i}.css`, countDuplicate: false });
      }
    } catch { /* page navigated */ }
    if ((fullScreenshot && (p.fullShots || 0) < 3) || (screenshot && p.screenshotIds.length < this.cfg.maxScreenshotsPerPage)) {
      try {
        let buf;
        if (fullScreenshot) {
          const h = await page.evaluate('Math.min(12000, Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))');
          const vw = page.viewportSize().width;
          buf = await page.screenshot({ type: 'jpeg', quality: 70, timeout: 15000, fullPage: true, clip: { x: 0, y: 0, width: vw, height: Math.max(h, 1) } });
        } else buf = await page.screenshot({ type: 'jpeg', quality: 70, timeout: 5000 });
        if (page.url() === url) {
          const r = await this.addBuffer({ url: `${url}`, rawUrl: `${url}#screenshot-${Date.now()}`, type: 'screenshots', mime: 'image/jpeg', buf, pageKey: key, kind: 'screenshot', filename: `${pageFileBase(url)}${fullScreenshot ? '-full' : ''}.jpg`, countDuplicate: false });
          if (r && !r.duplicate) p.screenshotIds.push(r.res.id);
          if (fullScreenshot) p.fullShots = (p.fullShots || 0) + 1;
        }
      } catch { /* screenshot is best-effort */ }
    }
    p.status = 'collected'; p.error = null;
    this._touch(); this.emit('pages');
    return created;
  }

  markPageFailed(url, message) {
    const p = this.ensurePage(url);
    if (p) { p.status = 'failed'; p.error = message; this.emit('pages'); this._touch(); }
  }

  async retryFailures() {
    let ok = 0; const todo = this.failures.filter((f) => f.retryable !== false && f.rawUrl);
    for (const f of todo) {
      try {
        const r = await safeFetch(f.rawUrl, this.cfg, { maxBytes: this.cfg.maxFileBytes });
        if (r.status !== 200) continue;
        const mime = String(r.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        const type = this.classify(guessRt(mime, f.rawUrl), mime, f.rawUrl);
        if (!type) continue;
        const pageKey = f.pageUrl ? stripHash(f.pageUrl) : (this.currentUrl ? stripHash(this.currentUrl) : null);
        const a = await this.addBuffer({ url: f.rawUrl, type, mime, buf: r.body, httpStatus: 200, pageKey, kind: 'network' });
        if (a) { ok++; this.failures = this.failures.filter((x) => x !== f); this.failedCount = Math.max(0, this.failedCount - 1); }
      } catch { /* leave in list */ }
    }
    this._touch(); this.emit('failures');
    return { attempted: todo.length, recovered: ok };
  }
  failureList() { return this.failures.map(({ key, rawUrl, ...rest }) => rest); }
}

function guessRt(mime, url) {
  if (/^image\//.test(mime)) return 'image';
  if (/font|woff/.test(mime)) return 'font';
  if (/css/.test(mime)) return 'stylesheet';
  if (/javascript/.test(mime)) return 'script';
  if (/json/.test(mime)) return 'fetch';
  if (/html/.test(mime)) return 'document';
  void url; return 'other';
}

function pageFileBase(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean).slice(-2).join('_') || 'index';
    return safeFilename(`${u.hostname}_${p}`, 'page', 80).replace(/\.(html?|php|aspx?)$/i, '');
  } catch { return 'page'; }
}

module.exports = { Collector, TYPES, pageFileBase };
