'use strict';
// Filtering forward proxy. Chromium is launched with --proxy-server pointing here, so EVERY request
// (document, subresource, redirect hop, websocket) passes SSRF checks. The proxy resolves DNS itself,
// validates the addresses and connects to the validated IP, so Chromium never gets a second, different
// DNS answer (DNS rebinding protection).
const http = require('http');
const net = require('net');
const { EventEmitter } = require('events');
const { resolveTarget, PolicyError, bareHost } = require('./security');

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

class EgressProxy extends EventEmitter {
  constructor(cfg, { lookup } = {}) {
    super();
    this.cfg = cfg;
    this.lookup = lookup;
    this.blocked = new Map(); // host -> reason (recent)
    this.upstreamErrors = new Map(); // host -> errno code of the last failed upstream connection
    this.sockets = new Set();
    this.server = http.createServer((req, res) => this.onHttp(req, res));
    this.server.on('connect', (req, sock, head) => this.onConnect(req, sock, head));
    this.server.on('connection', (s) => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); });
    this.server.keepAliveTimeout = 30000;
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; resolve(this.port); });
    });
  }

  close() { for (const s of this.sockets) s.destroy(); return new Promise((r) => this.server.close(() => r())); }

  noteBlocked(host, reason) {
    this.blocked.set(host, reason);
    if (this.blocked.size > 200) this.blocked.delete(this.blocked.keys().next().value);
    this.emit('blocked', { host, reason });
  }

  async onConnect(req, clientSock, head) {
    clientSock.on('error', () => {});
    let host; let port;
    try {
      const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url);
      if (!m) throw new PolicyError('INVALID_URL', 'bad CONNECT target');
      host = bareHost(m[1]); port = Number(m[2]);
      const target = await resolveTarget(host, port, this.cfg, this.lookup);
      const upstream = net.connect({ host: target.address, port, family: target.family });
      upstream.setTimeout(120000, () => upstream.destroy());
      upstream.on('error', (e) => { this.upstreamErrors.set(host, e.code || 'ECONNRESET'); if (this.upstreamErrors.size > 200) this.upstreamErrors.delete(this.upstreamErrors.keys().next().value); clientSock.destroy(); });
      clientSock.on('close', () => upstream.destroy());
      upstream.on('connect', () => {
        clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSock); clientSock.pipe(upstream);
      });
    } catch (e) {
      if (host) this.noteBlocked(host, e.message);
      clientSock.end(`HTTP/1.1 403 Forbidden\r\nX-WebCollector-Blocked: ${encodeURIComponent(e.message)}\r\nContent-Length: 0\r\n\r\n`);
    }
  }

  async onHttp(req, res) {
    let host;
    try {
      let u;
      try { u = new URL(req.url); } catch { throw new PolicyError('INVALID_URL', 'Proxy requests must use absolute URLs.'); }
      if (u.protocol !== 'http:') throw new PolicyError('UNSUPPORTED_PROTOCOL', 'Only http: is proxied in plain mode.');
      host = bareHost(u.hostname);
      const port = Number(u.port) || 80;
      const target = await resolveTarget(host, port, this.cfg, this.lookup);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
      headers.host = u.host;
      const up = http.request({ host: target.address, port, family: target.family, method: req.method, path: u.pathname + u.search, headers, timeout: 60000 }, (ur) => {
        const out = {};
        for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k)) out[k] = v;
        res.writeHead(ur.statusCode, out);
        ur.pipe(res);
      });
      up.on('timeout', () => up.destroy());
      up.on('error', (e) => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain', 'x-webcollector-upstream-error': e.code || 'ECONNRESET' }); res.end('Upstream connection failed\n'); });
      res.on('close', () => up.destroy());
      req.pipe(up);
    } catch (e) {
      if (host) this.noteBlocked(host, e.message);
      if (!res.headersSent) res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'x-webcollector-blocked': encodeURIComponent(e.message) });
      res.end(`Blocked by WebCollector network policy: ${e.message}\n`);
    }
  }
}

module.exports = { EgressProxy };
