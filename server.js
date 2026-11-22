'use strict';
// WebCollector Studio — HTTP + WebSocket server.
// Wires together: config, egress proxy (SSRF protection), session manager (one remote Chromium per
// collection), collector (resource capture) and the streaming ZIP exporter.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const { loadConfig } = require('./src/config');
const { EgressProxy } = require('./src/egress-proxy');
const { SessionManager, AppError, COOKIE, PRESETS, clampViewport } = require('./src/session');
const { validateUrl, PolicyError } = require('./src/security');
const { buildPlan, streamExport, SCOPES } = require('./src/export');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const INDEX_FILE = path.join(ROOT_DIR, 'index.html');

const cfg = loadConfig();

// ---------------------------------------------------------------- logging
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function log(level, msg, meta) {
  if ((LEVELS[level] || 20) < (LEVELS[cfg.logLevel] || 20)) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`;
  (level === 'error' ? console.error : console.log)(line);
}

process.on('uncaughtException', (err) => log('error', 'uncaughtException', { err: err && err.stack || String(err) }));
process.on('unhandledRejection', (reason) => log('error', 'unhandledRejection', { reason: String(reason && reason.stack || reason) }));

// ---------------------------------------------------------------- helpers
const MIMES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const APP_CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'";

function clientIp(req) {
  if (cfg.trustProxy) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || 'unknown';
}

function isSecure(req) {
  if (cfg.cookieSecure === 'always') return true;
  if (cfg.cookieSecure === 'never') return false;
  return !!(req.socket.encrypted || (cfg.trustProxy && /https/i.test(String(req.headers['x-forwarded-proto'] || ''))));
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  res.end(body);
}

function sendError(res, e) {
  let status = 500; let code = 'INTERNAL'; let message = 'Something went wrong on the server.'; let retryable = false;
  if (e instanceof AppError) { status = e.status; code = e.code; message = e.message; retryable = e.retryable; }
  else if (e instanceof PolicyError) { status = 400; code = e.code; message = e.message; }
  else if (e && e.code === 'BAD_REQUEST') { status = 400; code = 'BAD_REQUEST'; message = e.message; }
  else if (e && e.code === 'NOTHING_TO_EXPORT') { status = 400; code = 'NOTHING_TO_EXPORT'; message = e.message; }
  else log('error', 'request failed', { err: e && e.stack || String(e) });
  if (res.headersSent) { try { res.destroy(); } catch { /* ignore */ } return; }
  sendJson(res, status, { error: { code, message, retryable } });
}

async function readBody(req, limit = 256 * 1024) {
  const chunks = []; let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new AppError(413, 'TOO_LARGE', 'Request body is too large.');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readParams(req, url) {
  if (req.method === 'GET' || req.method === 'HEAD') return Object.fromEntries(url.searchParams);
  const raw = await readBody(req);
  if (!raw) return {};
  const ct = String(req.headers['content-type'] || '');
  if (ct.includes('application/json')) {
    try { const o = JSON.parse(raw); return o && typeof o === 'object' ? o : {}; } catch { throw new AppError(400, 'BAD_REQUEST', 'Invalid JSON.'); }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function originOk(req, { required = false } = {}) {
  const o = req.headers.origin;
  if (!o) return !required;
  if (cfg.allowedOrigins.includes(o)) return true;
  try {
    const u = new URL(o);
    const host = cfg.trustProxy && req.headers['x-forwarded-host'] ? String(req.headers['x-forwarded-host']).split(',')[0].trim() : req.headers.host;
    return u.host === host || u.host === req.headers.host;
  } catch { return false; }
}

// very small fixed-window rate limiter (per IP + bucket)
const hits = new Map();
function rateLimited(ip, bucket, limit) {
  const minute = Math.floor(Date.now() / 60000);
  const key = `${bucket}|${ip}`;
  const h = hits.get(key);
  if (!h || h.minute !== minute) { hits.set(key, { minute, n: 1 }); } else { h.n++; if (h.n > limit) return true; }
  if (hits.size > 5000) for (const [k, v] of hits) if (v.minute !== minute) hits.delete(k);
  return false;
}

const boolish = (v) => v === true || v === 'true' || v === '1' || v === 1 || v === 'on';

// ---------------------------------------------------------------- app state
const proxy = new EgressProxy(cfg);
const manager = new SessionManager({ cfg, proxy, log });

function requireSession(req) {
  const s = manager.authenticate(req.headers.cookie);
  if (!s) throw new AppError(401, 'NO_SESSION', 'There is no active collection. Open a website to start one.');
  s.touch();
  return s;
}

// ---------------------------------------------------------------- static files
function serveStatic(req, res, pathname) {
  let file;
  if (pathname === '/' || pathname === '/index.html') file = INDEX_FILE;
  else {
    // /public/app.js and the short form /app.js both work
    const rel = pathname.replace(/^\/public\//, '/');
    let decoded;
    try { decoded = decodeURIComponent(rel); } catch { res.writeHead(400); return res.end('Bad request'); }
    file = path.join(PUBLIC_DIR, path.normalize(decoded).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not Found'); }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIMES[ext] || 'application/octet-stream', 'Content-Length': st.size, 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    };
    if (ext === '.html') headers['Content-Security-Policy'] = APP_CSP;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

// ---------------------------------------------------------------- collected file serving (preview / download)
const IMAGE_PREVIEW = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/svg+xml']);
function serveCollected(req, res, s, id, url) {
  const r = s.collector.resources.get(id);
  if (!r) throw new AppError(404, 'NOT_FOUND', 'That file is not part of the collection.');
  const file = s.collector.filePath(r);
  const headers = {
    'Content-Length': r.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=60', 'Referrer-Policy': 'no-referrer',
    // Collected content is untrusted: never let it run scripts or load anything.
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:",
  };
  const mode = url.searchParams.get('mode');
  if (mode === 'download') {
    headers['Content-Type'] = 'application/octet-stream';
    headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(r.filename).replace(/%20/g, ' ')}"; filename*=UTF-8''${encodeURIComponent(r.filename)}`;
  } else if (mode === 'render' && r.type === 'html') {
    headers['Content-Type'] = 'text/html; charset=utf-8';
  } else if (mode === 'image' && IMAGE_PREVIEW.has(r.mime)) {
    headers['Content-Type'] = r.mime;
  } else {
    headers['Content-Type'] = 'text/plain; charset=utf-8';
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

// ---------------------------------------------------------------- export
function exportOptions(p) {
  const scope = String(p.scope || 'all');
  if (!SCOPES.has(scope)) throw new AppError(400, 'BAD_REQUEST', 'Unknown download type.');
  let ids = [];
  if (Array.isArray(p.ids)) ids = p.ids.map(String);
  else if (typeof p.ids === 'string' && p.ids) ids = p.ids.split(',');
  ids = ids.filter((x) => /^r\d+$/.test(x)).slice(0, 20000);
  if (scope === 'selected' && !ids.length) throw new AppError(400, 'BAD_REQUEST', 'Select at least one file first.');
  const pageId = p.pageId && /^p\d+$/.test(String(p.pageId)) ? String(p.pageId) : null;
  if (scope === 'page' && !pageId) throw new AppError(400, 'BAD_REQUEST', 'No page selected.');
  const reconstructed = p.recon === undefined ? true : boolish(p.recon);
  return { scope, ids, pageId, reconstructed };
}

async function handleDownload(req, res, s, p) {
  const opts = exportOptions(p);
  const plan = buildPlan(s.collector, s, opts);
  if (!s.acquireDownload()) throw new AppError(409, 'SESSION_CLOSING', 'The collection is being replaced.');
  let released = false;
  const release = () => { if (!released) { released = true; s.releaseDownload(); } };
  res.on('close', release);
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  res.writeHead(200, {
    'Content-Type': 'application/zip', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `attachment; filename="webcollector-${opts.scope}-${stamp}.zip"`,
  });
  let lastSent = 0;
  try {
    await streamExport(plan, res, (pr) => {
      const now = Date.now();
      if (now - lastSent > 150) { lastSent = now; s.broadcast({ type: 'export', ...pr }); }
    });
    s.broadcast({ type: 'export', done: true });
    res.end();
  } catch (e) {
    if (!e || e.code !== 'ABORTED') log('warn', 'export failed', { err: e && e.message });
    s.broadcast({ type: 'export', done: true, failed: true });
    res.destroy();
  } finally { release(); }
}

// ---------------------------------------------------------------- API
async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;
  const ip = clientIp(req);

  if (rateLimited(ip, 'api', cfg.rateLimitPerMinute)) throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Please slow down.', true);
  if (method !== 'GET' && method !== 'HEAD' && !originOk(req)) throw new AppError(403, 'BAD_ORIGIN', 'Cross-site requests are not allowed.');

  // ---- session lifecycle
  if (p === '/api/session' && method === 'POST') {
    if (rateLimited(ip, 'start', cfg.startLimitPerMinute)) throw new AppError(429, 'RATE_LIMITED', 'Too many new collections started. Wait a minute and try again.', true);
    const body = await readParams(req, url);
    const u = await validateUrl(String(body.url || ''), cfg);
    // Opening a website while a collection exists starts a fresh one (same as "Replace").
    const existing = manager.authenticate(req.headers.cookie);
    if (existing) await manager.destroy(existing);
    const preset = PRESETS[body.preset] ? body.preset : 'desktop';
    const viewport = clampViewport(body.viewport) || PRESETS[preset];
    const s = await manager.create(u.toString(), viewport, clampViewport(body.viewport) ? (body.preset || 'custom') : preset);
    s.browser.navigate(u.toString()).catch(() => {});
    const secure = isSecure(req) ? '; Secure' : '';
    return sendJson(res, 201, { session: s.summary(), stats: s.collector.stats() }, { 'Set-Cookie': `${COOKIE}=${manager.cookieFor(s)}; Path=/; HttpOnly; SameSite=Strict${secure}` });
  }

  const s = requireSession(req);

  if (p === '/api/session' && method === 'GET') return sendJson(res, 200, { session: s.summary(), stats: s.collector.stats() });

  if (p === '/api/session' && method === 'DELETE') {
    await manager.destroy(s);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
  }

  if (p === '/api/session/navigate' && method === 'POST') {
    const body = await readParams(req, url);
    if (s.phase === 'terminated') throw new AppError(409, 'SESSION_TERMINATED', 'The browser session has ended. Start a new collection.');
    const u = await validateUrl(String(body.url || ''), cfg);
    s.browser.navigate(u.toString()).catch(() => {});
    return sendJson(res, 202, { ok: true });
  }

  if (p === '/api/session/nav' && method === 'POST') {
    const body = await readParams(req, url);
    if (s.phase === 'terminated') throw new AppError(409, 'SESSION_TERMINATED', 'The browser session has ended. Start a new collection.');
    const b = s.browser;
    const act = { back: () => b.back(), forward: () => b.forward(), reload: () => b.reload(), stop: () => b.stop(), home: () => b.home() }[body.action];
    if (!act) throw new AppError(400, 'BAD_REQUEST', 'Unknown navigation action.');
    act().catch(() => {});
    return sendJson(res, 202, { ok: true });
  }

  if (p === '/api/session/viewport' && method === 'POST') {
    const body = await readParams(req, url);
    let vp = clampViewport(body);
    let preset = body.preset;
    if (PRESETS[body.preset] && !vp) vp = PRESETS[body.preset];
    if (!vp) throw new AppError(400, 'BAD_REQUEST', 'Viewport must be 200–3840 wide and 200–2400 high.');
    if (preset && !PRESETS[preset]) preset = 'custom';
    await s.browser.setViewport(vp, preset || 'custom');
    return sendJson(res, 200, { ok: true, session: s.summary() });
  }

  if (p === '/api/session/collector' && method === 'POST') {
    const body = await readParams(req, url);
    s.setCollector(boolish(body.on));
    return sendJson(res, 200, { ok: true, session: s.summary() });
  }

  if (p === '/api/session/scan' && method === 'POST') {
    if (s.phase === 'terminated') throw new AppError(409, 'SESSION_TERMINATED', 'The browser session has ended.');
    if (!s.collector.enabled) throw new AppError(409, 'COLLECTOR_OFF', 'Turn the Collector on first.');
    await s.browser.scanCurrentPage();
    return sendJson(res, 200, { ok: true, stats: s.collector.stats() });
  }

  if (p === '/api/session/finish' && method === 'POST') {
    await s.finish();
    return sendJson(res, 200, { ok: true, session: s.summary(), stats: s.collector.stats() });
  }

  // ---- data
  if (p === '/api/session/stats' && method === 'GET') return sendJson(res, 200, { stats: s.collector.stats(), session: s.summary() });

  if (p === '/api/session/files' && method === 'GET') {
    const q = url.searchParams;
    const out = s.collector.list({
      type: q.get('type') || 'all', q: (q.get('q') || '').slice(0, 200), page: parseInt(q.get('page'), 10) || 1,
      pageSize: parseInt(q.get('pageSize'), 10) || 50, pageId: /^p\d+$/.test(q.get('pageId') || '') ? q.get('pageId') : undefined,
    });
    return sendJson(res, 200, out);
  }

  if (p === '/api/session/pages' && method === 'GET') return sendJson(res, 200, { pages: s.collector.pageList() });

  if (p === '/api/session/failures' && method === 'GET') return sendJson(res, 200, { failures: s.collector.failureList() });

  if (p === '/api/session/failures/retry' && method === 'POST') {
    const r = await s.collector.retryFailures();
    return sendJson(res, 200, r);
  }

  let m = /^\/api\/session\/file\/(r\d+)$/.exec(p);
  if (m && (method === 'GET' || method === 'HEAD')) return serveCollected(req, res, s, m[1], url);

  // ---- export
  if (p === '/api/session/export-check' && method === 'POST') {
    const body = await readParams(req, url);
    const plan = buildPlan(s.collector, s, exportOptions(body));
    return sendJson(res, 200, { ok: true, files: plan.selected, entries: plan.count });
  }
  if (p === '/api/session/download' && (method === 'GET' || method === 'POST')) {
    return handleDownload(req, res, s, await readParams(req, url));
  }

  throw new AppError(404, 'NOT_FOUND', 'Unknown API endpoint.');
}

// ---------------------------------------------------------------- HTTP server
const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url || '/', 'http://localhost'); } catch { res.writeHead(400); return res.end('Bad request'); }
  const pathname = url.pathname;

  if (pathname === '/healthz' || pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    return res.end('OK');
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => sendError(res, e));
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  serveStatic(req, res, pathname);
});
server.requestTimeout = 0; // ZIP downloads can be long-running
server.headersTimeout = 30000;

// ---------------------------------------------------------------- WebSocket (frames out, input in)
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const reject = (code, text) => { try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* ignore */ } socket.destroy(); };
  let pathname = '';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { return reject(400, 'Bad Request'); }
  if (pathname !== '/ws') return reject(404, 'Not Found');
  if (!originOk(req, { required: true })) return reject(403, 'Forbidden');
  const s = manager.authenticate(req.headers.cookie);
  if (!s) return reject(401, 'Unauthorized');
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {});
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      s.touch();
      let msg; try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (!msg || msg.t === 'ping') return;
      s.browser.input(msg);
    });
    ws.on('close', () => { s.removeClient(ws).catch(() => {}); });
    s.addClient(ws).catch((e) => log('warn', 'addClient failed', { err: e && e.message }));
  });
});

// drop dead sockets
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000).unref();

// ---------------------------------------------------------------- start / stop
async function start() {
  await proxy.listen();
  await manager.init();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, cfg.host, resolve); });
  log('info', `WebCollector Studio running on http://${cfg.host}:${cfg.port}`, { proxyPort: proxy.port, maxSessions: cfg.maxSessions, tempRoot: cfg.tempRoot });
}

let stopping = false;
async function stop(signal) {
  if (stopping) return; stopping = true;
  log('info', `${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(0), 8000); force.unref();
  try { await manager.shutdown(); } catch { /* ignore */ }
  try { await proxy.close(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  for (const ws of wss.clients) ws.terminate();
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

if (require.main === module) {
  start().catch((e) => { log('error', 'failed to start', { err: e && e.stack || String(e) }); process.exit(1); });
}

module.exports = { start, stop, server, cfg, manager };
