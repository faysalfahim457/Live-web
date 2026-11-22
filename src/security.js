'use strict';
// URL validation, SSRF protection and a pinned-IP safe fetcher.
const net = require('net');
const dns = require('dns');
const http = require('http');
const https = require('https');

class PolicyError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'PolicyError'; }
}

const V4_BLOCKS = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) V4_BLOCKS.addSubnet(a, p, 'ipv4');

function parseV6(input) {
  let str = String(input).split('%')[0];
  let tail = null;
  if (str.includes('.')) {
    const i = str.lastIndexOf(':');
    const p = str.slice(i + 1).split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !(n >= 0 && n <= 255))) return null;
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    str = `${str.slice(0, i + 1)}0:0`;
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const parse = (s) => (s === '' ? [] : s.split(':').map((h) => (/^[0-9a-fA-F]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  const left = parse(halves[0]);
  let groups;
  if (halves.length === 2) {
    const right = parse(halves[1]);
    const fill = 8 - left.length - right.length;
    if (fill < 1) return null;
    groups = [...left, ...Array(fill).fill(0), ...right];
  } else groups = left;
  if (groups.length !== 8 || groups.some(Number.isNaN)) return null;
  if (tail) { groups[6] = tail[0]; groups[7] = tail[1]; }
  return groups;
}

// true if the literal IP must never be contacted
function isBlockedIp(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return V4_BLOCKS.check(ip, 'ipv4');
  if (fam === 6) {
    const g = parseV6(ip);
    if (!g) return true;
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
      return V4_BLOCKS.check(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`, 'ipv4');
    }
    if (g.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1, IPv4-compatible
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local
    if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
    if (g[0] === 0x2001 && g[1] === 0) return true; // teredo
    if (g[0] === 0x2002) return true; // 6to4
    if (g[0] === 0x0064 && g[1] === 0xff9b) return true; // NAT64
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard
    return false;
  }
  return true;
}

const BLOCKED_NAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data', 'kubernetes.default']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.home', '.corp', '.intranet', '.svc', '.cluster.local'];

function blockedHostname(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_NAMES.has(h)) return true;
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (!net.isIP(h) && !h.includes('.')) return true; // single-label intranet names
  return false;
}

const bareHost = (hostname) => hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');

function testAllowed(cfg, host, port) {
  const list = cfg.testAllowHosts || [];
  return list.includes(`${host}:${port}`) || list.includes(`${host}:*`);
}

function effectivePort(u) { return Number(u.port) || (u.protocol === 'https:' ? 443 : 80); }

function checkPort(cfg, host, port) {
  if (testAllowed(cfg, host, port)) return;
  if (!cfg.allowedPorts.includes(port)) throw new PolicyError('BLOCKED_URL', `Port ${port} is not allowed by the network policy.`);
}

// Parse + syntactic checks. Throws PolicyError. Does not resolve DNS.
function validateUrlSyntax(raw, cfg) {
  if (typeof raw !== 'string') throw new PolicyError('INVALID_URL', 'Enter a website address.');
  let s = raw.trim();
  if (!s) throw new PolicyError('INVALID_URL', 'Enter a website address.');
  if (s.length > 2048) throw new PolicyError('INVALID_URL', 'The address is too long.');
  if (/[\u0000- \u007f]/.test(s)) throw new PolicyError('INVALID_URL', 'The address contains invalid characters.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^[^/:]+:\d+(\/|$|\?|#)/.test(s)) s = `https://${s}`; // host:port
    else if (/^[a-z][a-z0-9+.-]*:/i.test(s)) throw new PolicyError('UNSUPPORTED_PROTOCOL', 'Only http:// and https:// addresses are supported.');
    else s = `https://${s}`;
  }
  let u;
  try { u = new URL(s); } catch { throw new PolicyError('INVALID_URL', 'That does not look like a valid web address.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new PolicyError('UNSUPPORTED_PROTOCOL', 'Only http:// and https:// addresses are supported.');
  if (u.username || u.password) throw new PolicyError('INVALID_URL', 'Addresses with embedded credentials are not allowed.');
  const host = bareHost(u.hostname);
  if (!host) throw new PolicyError('INVALID_URL', 'The address has no host name.');
  const port = effectivePort(u);
  if (testAllowed(cfg, host, port)) return u;
  checkPort(cfg, host, port);
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new PolicyError('BLOCKED_URL', 'Private, loopback and reserved addresses are blocked.');
  } else if (blockedHostname(host)) {
    throw new PolicyError('BLOCKED_URL', 'Internal host names are blocked.');
  }
  return u;
}

// Resolve + validate every address. Rejects if ANY address is private (strict).
async function resolveTarget(hostname, port, cfg, lookup = dns.promises.lookup) {
  const host = bareHost(hostname);
  if (testAllowed(cfg, host, port) && net.isIP(host)) return { address: host, family: net.isIP(host) };
  checkPort(cfg, host, port);
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new PolicyError('BLOCKED_URL', 'Private, loopback and reserved addresses are blocked.');
    return { address: host, family: net.isIP(host) };
  }
  if (!testAllowed(cfg, host, port) && blockedHostname(host)) throw new PolicyError('BLOCKED_URL', 'Internal host names are blocked.');
  let addrs;
  try { addrs = await lookup(host, { all: true, verbatim: true }); } catch (e) {
    const code = e && e.code;
    throw new PolicyError(code === 'ENOTFOUND' || code === 'ENODATA' ? 'DNS_FAILURE' : 'DNS_FAILURE', `Could not resolve "${host}" (DNS lookup failed).`);
  }
  if (!addrs || !addrs.length) throw new PolicyError('DNS_FAILURE', `Could not resolve "${host}".`);
  if (!testAllowed(cfg, host, port)) {
    for (const a of addrs) {
      if (isBlockedIp(a.address)) throw new PolicyError('BLOCKED_URL', `"${host}" resolves to a private or reserved address and was blocked.`);
    }
  }
  return { address: addrs[0].address, family: addrs[0].family };
}

async function validateUrl(raw, cfg, lookup) {
  const u = validateUrlSyntax(raw, cfg);
  await resolveTarget(u.hostname, effectivePort(u), cfg, lookup);
  return u;
}

// GET a URL without browser cookies, pinning the validated IP and re-validating each redirect hop.
async function safeFetch(rawUrl, cfg, { maxBytes = 5 * 1024 * 1024, timeoutMs = 15000, maxRedirects = 3, lookup } = {}) {
  let url = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = validateUrlSyntax(url, cfg);
    const port = effectivePort(u);
    const target = await resolveTarget(u.hostname, port, cfg, lookup);
    const res = await new Promise((resolve, reject) => {
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        protocol: u.protocol, hostname: bareHost(u.hostname), port, path: u.pathname + u.search, method: 'GET',
        headers: { 'user-agent': 'Mozilla/5.0 WebCollectorStudio', accept: '*/*', 'accept-encoding': 'identity' },
        lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address: target.address, family: target.family }]) : cb(null, target.address, target.family)),
        timeout: timeoutMs,
      }, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return resolve({ redirect: r.headers.location, status: r.statusCode }); }
        const chunks = []; let n = 0;
        r.on('data', (c) => { n += c.length; if (n > maxBytes) { req.destroy(new PolicyError('TOO_LARGE', 'Resource exceeds the size limit.')); return; } chunks.push(c); });
        r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks), finalUrl: u.toString() }));
        r.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new PolicyError('TIMEOUT', 'The request timed out.')));
      req.on('error', reject);
      req.end();
    });
    if (res.redirect) { url = new URL(res.redirect, u).toString(); continue; }
    return res;
  }
  throw new PolicyError('BLOCKED_URL', 'Too many redirects.');
}

module.exports = { PolicyError, isBlockedIp, blockedHostname, validateUrlSyntax, validateUrl, resolveTarget, safeFetch, effectivePort, bareHost, parseV6 };
