'use strict';
const crypto = require('crypto');
const path = require('path');
const zlib = require('zlib');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const crc32 = (buf) => zlib.crc32(buf);

const MIME_EXT = {
  'text/html': 'html', 'application/xhtml+xml': 'html', 'text/css': 'css',
  'text/javascript': 'js', 'application/javascript': 'js', 'application/x-javascript': 'js', 'application/ecmascript': 'js',
  'application/json': 'json', 'application/manifest+json': 'webmanifest', 'application/ld+json': 'json',
  'text/plain': 'txt', 'application/wasm': 'wasm', 'text/xml': 'xml', 'application/xml': 'xml',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'image/avif': 'avif', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/bmp': 'bmp',
  'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf', 'font/sfnt': 'ttf',
  'application/font-woff': 'woff', 'application/font-woff2': 'woff2', 'application/x-font-ttf': 'ttf',
  'application/x-font-otf': 'otf', 'application/vnd.ms-fontobject': 'eot',
};
const EXT_MIME = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', map: 'application/json', webmanifest: 'application/manifest+json', txt: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf',
  otf: 'font/otf', eot: 'application/vnd.ms-fontobject', wasm: 'application/wasm', xml: 'application/xml',
};
const extFromMime = (m) => MIME_EXT[m] || null;
const mimeFromExt = (e) => EXT_MIME[(e || '').toLowerCase()] || null;

// Already-compressed formats are stored, not deflated, in ZIP exports.
const INCOMPRESSIBLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'font/woff2', 'font/woff', 'application/font-woff', 'application/font-woff2']);

function safeFilename(name, fallback = 'file', max = 100) {
  let n = String(name || '');
  try { n = decodeURIComponent(n); } catch { /* keep raw */ }
  n = n.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
  n = n.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n)) n = '_' + n;
  if (n.length > max) { const ext = path.extname(n).slice(0, 12); n = n.slice(0, max - ext.length) + ext; }
  return n || fallback;
}

// Reserve a unique (case-insensitive) path inside `used`.
function uniquePath(used, dir, name) {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let candidate = dir ? `${dir}/${name}` : name;
  let i = 2;
  while (used.has(candidate.toLowerCase())) { candidate = `${dir ? dir + '/' : ''}${stem}-${i}${ext}`; i++; }
  used.add(candidate.toLowerCase());
  return candidate;
}

const SENSITIVE_KEY = /(^|[-_])(token|secret|password|passwd|pwd|auth|authorization|sessionid|session|sid|apikey|api[-_]?key|key|signature|sig|jwt|credentials?|code)$/i;
// Strip credentials, fragment and secret-looking query values. Used for anything stored or exported.
function redactUrl(raw) {
  try {
    const u = new URL(raw);
    u.username = ''; u.password = ''; u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (SENSITIVE_KEY.test(k)) u.searchParams.set(k, 'REDACTED');
    return u.toString();
  } catch { return String(raw).slice(0, 2048); }
}
const stripHash = (raw) => { try { const u = new URL(raw); u.hash = ''; return u.toString(); } catch { return raw; } };

const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < 2);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
};

module.exports = { sha256, crc32, extFromMime, mimeFromExt, INCOMPRESSIBLE, safeFilename, uniquePath, redactUrl, stripHash, fmtBytes };
