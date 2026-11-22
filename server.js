'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { loadConfig } = require('./src/config');
const { EgressProxy } = require('./src/egress-proxy');
const { SessionManager, AppError, COOKIE, PRESETS, clampViewport } = require('./src/session');
const { validateUrl, PolicyError } = require('./src/security');
const { buildPlan, streamExport } = require('./src/export');
const { safeFilename } = require('./src/util');

const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const UI_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self' blob: data:; connect-src 'self' ws: wss:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const TEXT_TYPES = new Set(['html', 'css', 'js']);

function createApp(overrides = {}) {
  const cfg = loadConfig(overrides);
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const log = (level, msg, meta) => { if ((levels[level] ?? 1) >= (levels[cfg.logLevel] ?? 1)) console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...meta })); };
  const proxy = new EgressProxy(cfg);
  proxy.on('blocked', (b) => log('warn', 'egress blocked', b));
  const manager = new SessionManager({ cfg, proxy, log });

  // ---------- helpers ----------
  const buckets = new Map();
  const clientIp = (req) => (cfg.trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || '?';
  function rateLimit(req, kind, limit) {
    const key = `${kind}:${clientIp(req)}`; const now = Date.now();
    let b = buckets.get(key);
    if (!b || now > b.reset) { b = { n: 0, reset: now + 60000 }; buckets.set(key, b); }
    if (++b.n > limit) throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Please slow down and retry in a moment.', true);
  }
  setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60000).unref();

  const originOk = (req) => {
    const o = req.headers.origin; if (!o) return true;
    try { const u = new URL(o); return u.host === req.headers.host || cfg.allowedOrigins.includes(o); } catch { return false; }
  };
  const isHttps = (req) => req.socket.encrypted || (cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https');
  const cookieHeader = (req, value, clear) => {
    const secure = cfg.cookieSecure === 'always' || (cfg.cookieSecure === 'auto' && isHttps(req));
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}${clear ? '; Max-Age=0' : ''}`;
  };

  function baseHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Cache-Control', 'no-store');
  }
  function sendJson(res, status, body, extra = {}) {
    const s = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s), ...extra });
    res.end(s);
  }
  function sendError(res, e) {
    if (e instanceof AppError) return sendJson(res, e.status, { ok: false, error: { code: e.code, message: e.message, retryable: e.retryable } });
    if (e instanceof PolicyError) return sendJson(res, e.code === 'DNS_FAILURE' ? 422 : 400, { ok: false, error: { code: e.code, message: e.message, retryable: e.code === 'DNS_FAILURE' } });
    if (e && e.code === 'BAD_REQUEST') return sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: e.message, retryable: false } });
    if (e && e.code === 'NOTHING_TO_EXPORT') return sendJson(res, 409, { ok: false, error: { code: 'NOTHING_TO_EXPORT', message: e.message, retryable: false } });
    log('error', 'unhandled', { err: e && e.message, stack: e && e.stack });
    if (!res.headersSent) return sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong on the server. Please try again.', retryable: true } });
    res.destroy();
  }
  function readBody(req, max = 64 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = []; let n = 0;
      req.on('data', (c) => { n += c.length; if (n > max) { reject(new AppError(413, 'BAD_REQUEST', 'Request body too large.')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  async function readParams(req) {
    const raw = await readBody(req);
    const ct = String(req.headers['content-type'] || '');
    if (!raw) return {};
    if (ct.includes('application/json')) { try { const j = JSON.parse(raw); return j && typeof j === 'object' ? j : {}; } catch { throw new AppError(400, 'BAD_REQUEST', 'Malformed JSON body.'); } }
    if (ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
    throw new AppError(415, 'BAD_REQUEST', 'Unsupported content type.');
  }
  function needSession(req) {
    const s = manager.authenticate(req.headers.cookie);
    if (!s) throw new AppError(401, 'NO_SESSION', 'There is no active collection. Enter a website address to start one.');
    s.touch();
    return s;
  }
  function parseViewport(body) {
    const preset = ['desktop', 'tablet', 'mobile'].includes(body.preset) ? body.preset : null;
    if (preset) return { viewport: { ...PRESETS[preset] }, preset };
    const v = clampViewport(body);
    if (!v) throw new AppError(400, 'BAD_REQUEST', 'Viewport must be 200–3840 px wide and 200–2400 px high.');
    return { viewport: v, preset: 'custom' };
  }

  // ---------- resource serving ----------
  function getResource(s, id) {
    const r = /^r\d+$/.test(id) ? s.collector.resources.get(id) : null;
    if (!r) throw new AppError(404, 'NOT_FOUND', 'That file is not part of this collection.');
    return r;
  }
  const contentTypeFor = (r, raw) => {
    if (raw) {
      if (TEXT_TYPES.has(r.type) || /json|xml|text\//.test(r.mime)) return 'text/plain; charset=utf-8';
      if (r.type === 'images' || r.type === 'screenshots' || r.type === 'fonts') return r.mime;
      return 'application/octet-stream';
    }
    return 'application/octet-stream';
  };
  function sendFile(req, res, s, r, { download, max, render }) {
    if (!s.acquireDownload()) throw new AppError(409, 'SESSION_CLOSING', 'The collection is being closed.');
    const file = s.collector.filePath(r);
    let released = false;
    const release = () => { if (!released) { released = true; s.releaseDownload(); } };
    res.on('close', release);
    const headers = {
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=60', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': render ? "sandbox; default-src 'none'; img-src * data: blob:; style-src * 'unsafe-inline'; font-src * data:; media-src 'none'" : "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      'X-Total-Size': String(r.size),
    };
    if (download) {
      headers['Content-Type'] = 'application/octet-stream';
      headers['Content-Disposition'] = `attachment; filename="${safeFilename(r.filename).replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(r.filename)}`;
      headers['Content-Length'] = String(r.size);
    } else if (render) {
      headers['Content-Type'] = 'text/html; charset=utf-8';
    } else {
      headers['Content-Type'] = contentTypeFor(r, true);
    }
    const limit = max && max < r.size ? max : null;
    if (limit) { headers['X-Truncated'] = '1'; headers['Content-Length'] = String(limit); }
    else if (!headers['Content-Length']) headers['Content-Length'] = String(r.size);
    res.writeHead(200, headers);
    const rs = fs.createReadStream(file, limit ? { start: 0, end: limit - 1 } : {});
    rs.on('error', () => res.destroy());
    rs.pipe(res);
  }

  // ---------- API ----------
  async function api(req, res, url) {
    const p = url.pathname; const m = req.method;
    if (m !== 'GET' && m !== 'HEAD' && !originOk(req)) throw new AppError(403, 'FORBIDDEN', 'Cross-origin requests are not allowed.');
    rateLimit(req, 'all', cfg.rateLimitPerMinute);

    if (p === '/api/health') return sendJson(res, 200, { ok: true, sessions: manager.sessions.size });

    if (p === '/api/session' && m === 'GET') {
      const s = manager.authenticate(req.headers.cookie);
      if (!s) return sendJson(res, 200, { active: false });
      s.touch();
      return sendJson(res, 200, { active: true, session: s.summary(), stats: s.collector.stats() });
    }
    if (p === '/api/session' && m === 'POST') {
      rateLimit(req, 'start', cfg.startLimitPerMinute);
      if (manager.authenticate(req.headers.cookie)) throw new AppError(409, 'SESSION_EXISTS', 'A collection is already active. Use "Replace / New Collection" first.');
      const body = await readParams(req);
      const u = await validateUrl(body.url, cfg);
      const { viewport, preset } = parseViewport(body.viewport || { preset: 'desktop' });
      const s = await manager.create(u.toString(), viewport, preset);
      res.setHeader('Set-Cookie', cookieHeader(req, manager.cookieFor(s)));
      s.browser.navigate(u.toString()).catch(() => {});
      return sendJson(res, 201, { ok: true, session: s.summary(), stats: s.collector.stats() });
    }
    if (p === '/api/session' && m === 'DELETE') {
      const s = manager.authenticate(req.headers.cookie);
      if (s) await manager.destroy(s);
      res.setHeader('Set-Cookie', cookieHeader(req, '', true));
      return sendJson(res, 200, { ok: true });
    }

    const act = /^\/api\/session\/([a-z-]+)$/.exec(p);
    if (act && m === 'POST') {
      const s = needSession(req); const b = s.browser;
      const live = () => { if (s.phase === 'terminated' || b.closed) throw new AppError(409, 'SESSION_TERMINATED', 'The browser session has ended. Download your files or start a new collection.'); };
      switch (act[1]) {
        case 'navigate': { live(); const body = await readParams(req); const u = await validateUrl(body.url, cfg); b.navigate(u.toString()).catch(() => {}); if (s.phase === 'completed') s.setCollector(true); return sendJson(res, 200, { ok: true }); }
        case 'back': live(); b.back().catch(() => {}); return sendJson(res, 200, { ok: true });
        case 'forward': live(); b.forward().catch(() => {}); return sendJson(res, 200, { ok: true });
        case 'reload': live(); b.reload().catch(() => {}); return sendJson(res, 200, { ok: true });
        case 'stop': live(); await b.stop(); return sendJson(res, 200, { ok: true });
        case 'home': live(); b.home().catch(() => {}); return sendJson(res, 200, { ok: true });
        case 'scan': live(); if (!s.collector.enabled) throw new AppError(409, 'BAD_REQUEST', 'Turn the collector on to scan the page.'); b.scanCurrentPage().catch((e) => s.broadcast({ type: 'error', error: { code: 'SCAN_FAILED', message: e.message || 'Scan failed.', retryable: true } })); return sendJson(res, 200, { ok: true });
        case 'finish': await s.finish(); return sendJson(res, 200, { ok: true, session: s.summary() });
        case 'collector': { const body = await readParams(req); s.setCollector(body.on === true || body.on === 'true' || body.on === '1'); return sendJson(res, 200, { ok: true, session: s.summary() }); }
        case 'viewport': { live(); const body = await readParams(req); const { viewport, preset } = parseViewport(body); await b.setViewport(viewport, preset); return sendJson(res, 200, { ok: true, session: s.summary() }); }
        case 'retry-failures': { const r = await s.collector.retryFailures(); return sendJson(res, 200, { ok: true, ...r }); }
        default: throw new AppError(404, 'NOT_FOUND', 'Unknown action.');
      }
    }

    if (p === '/api/stats' && m === 'GET') { const s = needSession(req); return sendJson(res, 200, { stats: s.collector.stats() }); }
    if (p === '/api/pages' && m === 'GET') { const s = needSession(req); return sendJson(res, 200, { pages: s.collector.pageList() }); }
    if (p === '/api/failures' && m === 'GET') { const s = needSession(req); return sendJson(res, 200, { failures: s.collector.failureList() }); }
    if (p === '/api/resources' && m === 'GET') {
      const s = needSession(req); const q = url.searchParams;
      const type = q.get('type') || 'all';
      if (!['all', 'html', 'css', 'js', 'images', 'fonts', 'other', 'screenshots'].includes(type)) throw new AppError(400, 'BAD_REQUEST', 'Unknown type.');
      return sendJson(res, 200, s.collector.list({ type, q: (q.get('q') || '').slice(0, 200), page: parseInt(q.get('page'), 10) || 1, pageSize: parseInt(q.get('pageSize'), 10) || 50, pageId: /^p\d+$/.test(q.get('pageId') || '') ? q.get('pageId') : undefined }));
    }
    const rm = /^\/api\/resources\/(r\d+)(?:\/(content|download|render))?$/.exec(p);
    if (rm && m === 'GET') {
      const s = needSession(req); const r = getResource(s, rm[1]);
      if (!rm[2]) return sendJson(res, 200, { resource: s.collector.publicRecord(r) });
      if (rm[2] === 'render' && r.type !== 'html') throw new AppError(400, 'BAD_REQUEST', 'Only HTML can be rendered.');
      const binary = ['images', 'screenshots', 'fonts'].includes(r.type);
      const reqMax = parseInt(url.searchParams.get('max'), 10);
      const max = rm[2] === 'content' ? (binary && !reqMax ? null : Math.min(reqMax || 400 * 1024, 4 * 1024 * 1024)) : null;
      return sendFile(req, res, s, r, { download: rm[2] === 'download', max, render: rm[2] === 'render' });
    }

    if (p === '/api/export' && m === 'POST') return exportZip(req, res);

    throw new AppError(404, 'NOT_FOUND', 'Unknown endpoint.');
  }

  async function exportZip(req, res) {
    const s = needSession(req);
    const body = await readParams(req);
    let ids = [];
    if (body.ids) { try { ids = Array.isArray(body.ids) ? body.ids : JSON.parse(body.ids); } catch { ids = String(body.ids).split(','); } }
    ids = ids.filter((x) => /^r\d+$/.test(String(x))).slice(0, cfg.maxFiles);
    const exportId = crypto.randomBytes(6).toString('hex');
    const fail = (e) => { s.broadcast({ type: 'export', id: exportId, state: 'error', error: { code: e.code || 'ZIP_FAILED', message: e.message || 'ZIP generation failed.', retryable: e.code !== 'NOTHING_TO_EXPORT' } }); throw e; };
    let plan;
    try {
      plan = buildPlan(s.collector, s, { scope: body.scope || 'all', ids, pageId: /^p\d+$/.test(body.pageId || '') ? body.pageId : (() => { const pg = s.collector.currentUrl && s.collector.pageFor(s.collector.currentUrl); return pg ? pg.id : null; })(), reconstructed: !(body.reconstructed === '0' || body.reconstructed === false || body.reconstructed === 'false') });
    } catch (e) { fail(e); }
    if (!s.acquireDownload()) fail(new AppError(409, 'SESSION_CLOSING', 'The collection is being closed.'));
    let host = 'site'; try { host = new URL(s.startUrl).hostname.replace(/[^a-z0-9.-]/gi, '_'); } catch { /* ignore */ }
    const fname = `WebCollector-${host}-${new Date().toISOString().slice(0, 10)}${plan.scope === 'all' ? '' : '-' + plan.scope}.zip`;
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${fname}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Export-Id': exportId });
    let released = false; let finished = false;
    const release = () => { if (!released) { released = true; s.releaseDownload(); } };
    res.on('close', () => { release(); if (!finished) s.broadcast({ type: 'export', id: exportId, state: 'aborted' }); });
    let last = 0;
    s.broadcast({ type: 'export', id: exportId, state: 'running', filesDone: 0, filesTotal: plan.entries.length, bytes: 0 });
    try {
      const bytes = await streamExport(plan, res, (p) => { const now = Date.now(); if (now - last > 120) { last = now; s.broadcast({ type: 'export', id: exportId, state: 'running', ...p }); } });
      finished = true;
      res.end();
      s.broadcast({ type: 'export', id: exportId, state: 'done', filesDone: plan.entries.length, filesTotal: plan.entries.length, bytes });
    } catch (e) {
      if (e && e.code === 'ABORTED') return;
      log('error', 'zip failed', { err: e.message });
      s.broadcast({ type: 'export', id: exportId, state: 'error', error: { code: 'ZIP_FAILED', message: 'ZIP generation failed. Please retry.', retryable: true } });
      res.destroy(); // truncated stream => browser reports a failed download rather than a corrupt "success"
    }
  }

  // ---------- static ----------
  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    let rel = pathname === '/' ? '/index.html' : pathname;
    try { rel = decodeURIComponent(rel); } catch { res.writeHead(400); return res.end(); }
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep) || rel.includes('\0')) { res.writeHead(404); return res.end('Not found'); }
    let st; try { st = await fs.promises.stat(file); } catch { st = null; }
    if (!st || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' };
    if (ext === '.html') h['Content-Security-Policy'] = UI_CSP;
    res.writeHead(200, h);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      baseHeaders(res);
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname.startsWith('/api/resources/') && /\/(content|download|render)$/.test(url.pathname)) res.removeHeader('Cache-Control');
        return await api(req, res, url);
      }
      return await serveStatic(req, res, url.pathname);
    } catch (e) { sendError(res, e); }
  });
  server.headersTimeout = 20000; server.requestTimeout = 0; // exports may stream for a long time

  // ---------- websocket ----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const reject = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    try {
      if (new URL(req.url, 'http://x').pathname !== '/ws') return reject(404, 'Not Found');
      if (!originOk(req) || !req.headers.origin) return reject(403, 'Forbidden');
      const s = manager.authenticate(req.headers.cookie);
      if (!s) return reject(401, 'Unauthorized');
      wss.handleUpgrade(req, socket, head, (ws) => onWs(ws, s));
    } catch { reject(400, 'Bad Request'); }
  });
  function onWs(ws, s) {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {});
    s.addClient(ws).catch(() => {});
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'ping') { ws.send('{"type":"pong"}'); return; }
      if (m.t === 'frame') { s.browser.sendOneFrame(); return; }
      s.touch();
      if (s.phase !== 'terminated') s.browser.input(m);
    });
    ws.on('close', () => { s.removeClient(ws).catch(() => {}); });
  }
  const hb = setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 20000);
  hb.unref();

  return {
    cfg, server, manager, proxy, log,
    async start() {
      await proxy.listen(); await manager.init();
      await new Promise((r, j) => { server.once('error', j); server.listen(cfg.port, cfg.host, r); });
      log('info', 'WebCollector Studio listening', { host: cfg.host, port: server.address().port, tempRoot: cfg.tempRoot });
      return server.address().port;
    },
    async stop() {
      clearInterval(hb);
      for (const ws of wss.clients) ws.terminate();
      await manager.shutdown(); await proxy.close();
      server.closeAllConnections(); await new Promise((r) => server.close(() => r()));
    },
  };
}

module.exports = { createApp };

if (require.main === module) {
  const app = createApp();
  app.start().catch((e) => { console.error('Failed to start:', e.message); process.exit(1); });
  let stopping = false;
  const shutdown = async () => { if (stopping) return; stopping = true; await app.stop().catch(() => {}); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (e) => app.log('error', 'unhandledRejection', { err: e && e.message }));
}
