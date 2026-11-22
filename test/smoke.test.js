'use strict';
// End-to-end smoke test: starts the real server, a local fixture website and drives the whole API
// (session start, live collection, WebSocket frames + input, previews, ZIP export, SSRF block, replace).
// Needs Chromium (npx playwright install chromium) and `unzip`.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let fixture, fixturePort, srv, srvPort, tmp, cookie = '';
const log = [];

before(async () => {
  fixture = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Fixture Home</title><link rel="stylesheet" href="/s.css"><body><h1>Hello</h1><img src="/p.png"><a href="/two">two</a><input id="i"><script src="/a.js"></script></body>');
    } else if (req.url === '/two') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Two</title><link rel="stylesheet" href="/s.css"><p>page two</p>'); }
    else if (req.url === '/s.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end('body{background:#eef;font-family:sans-serif}'); }
    else if (req.url === '/a.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end('window.__ok=1;'); }
    else if (req.url === '/p.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); }
    else { res.writeHead(404); res.end('nope'); }
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  fixturePort = fixture.address().port;

  srvPort = 20000 + Math.floor(Math.random() * 20000);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-test-'));
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(srvPort), TEMP_ROOT: tmp, CHROMIUM_NO_SANDBOX: 'true', TEST_ALLOW_HOSTS: `127.0.0.1:${fixturePort}`, ALLOWED_PORTS: `80,443,${fixturePort}`, LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', (d) => log.push(String(d))); srv.stderr.on('data', (d) => log.push(String(d)));
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${srvPort}/healthz`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start: ' + log.join(''));
});

after(async () => {
  if (srv) { srv.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 500)); }
  if (fixture) fixture.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${srvPort}`;
async function call(p, { method = 'GET', body } = {}) {
  const res = await fetch(base() + p, { method, headers: { Cookie: cookie, Origin: base(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return res;
}
const json = async (p, o) => { const r = await call(p, o); return { status: r.status, ...(await r.json()) }; };
async function until(fn, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 300)); } throw new Error('timeout waiting for condition\n' + log.join('')); }

test('index.html is served from the main folder with working asset links', async () => {
  const html = await (await fetch(base() + '/')).text();
  assert.match(html, /href="public\/app\.css"/); assert.match(html, /src="public\/app\.js"/);
  for (const p of ['/public/app.css', '/public/app.js', '/public/icon.svg', '/app.js', '/app.css']) assert.equal((await fetch(base() + p)).status, 200, p);
  assert.equal((await fetch(base() + '/public/../server.js')).status, 404);
  assert.equal((await fetch(base() + '/..%2fserver.js')).status, 404);
});

test('no session -> 401, private addresses blocked, cross-origin POST refused', async () => {
  assert.equal((await json('/api/session')).status, 401);
  const blocked = await json('/api/session', { method: 'POST', body: { url: 'http://169.254.169.254/latest/meta-data' } });
  assert.equal(blocked.status, 400); assert.equal(blocked.error.code, 'BLOCKED_URL');
  const r = await fetch(base() + '/api/session', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{"url":"x"}' });
  assert.equal(r.status, 403);
});

test('full collection flow', { timeout: 120000 }, async () => {
  const started = await json('/api/session', { method: 'POST', body: { url: `http://127.0.0.1:${fixturePort}/`, preset: 'desktop' } });
  assert.equal(started.status, 201); assert.ok(cookie.startsWith('wcs='));

  // live stream over WebSocket
  const ws = new WebSocket(`ws://127.0.0.1:${srvPort}/ws`, { headers: { Cookie: cookie, Origin: base() } });
  const got = { hello: false, frames: 0 };
  ws.on('message', (d, bin) => { if (bin) got.frames++; else if (JSON.parse(d).type === 'hello') got.hello = true; });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  await until(() => got.hello && got.frames > 0);
  ws.send(JSON.stringify({ t: 'click', x: 50, y: 50 })); ws.send(JSON.stringify({ t: 'wheel', x: 50, y: 50, dx: 0, dy: 100 })); ws.send(JSON.stringify({ t: 'key', key: 'a' }));
  // a socket without cookie/origin is refused
  await assert.rejects(new Promise((r, j) => { const w = new WebSocket(`ws://127.0.0.1:${srvPort}/ws`); w.on('open', r); w.on('error', j); }));

  const stats = await until(async () => { const s = (await json('/api/session/stats')).stats; return s.files >= 4 && s.css >= 1 && s.js >= 1 && s.images >= 1 && s.html >= 1 ? s : null; });
  assert.ok(stats.pages >= 1);

  const files = await json('/api/session/files?type=all');
  const names = files.items.map((f) => f.filename);
  assert.ok(names.includes('s.css') && names.includes('a.js') && names.includes('p.png'), names.join(','));
  const css = files.items.find((f) => f.filename === 's.css');
  const prev = await call(`/api/session/file/${css.id}`);
  assert.match(prev.headers.get('content-type'), /text\/plain/); assert.match(await prev.text(), /background/);
  const png = files.items.find((f) => f.filename === 'p.png');
  assert.equal((await call(`/api/session/file/${png.id}?mode=image`)).headers.get('content-type'), 'image/png');

  // second page via navigate API
  assert.equal((await json('/api/session/navigate', { method: 'POST', body: { url: `http://127.0.0.1:${fixturePort}/two` } })).status, 202);
  const pages = await until(async () => { const p = (await json('/api/session/pages')).pages; return p.length >= 2 ? p : null; });
  assert.ok(pages.some((p) => /\/two$/.test(p.url)));
  assert.equal((await json('/api/session/navigate', { method: 'POST', body: { url: 'http://localhost:1/' } })).status, 400);

  // nav / viewport / collector / scan / finish
  assert.equal((await json('/api/session/nav', { method: 'POST', body: { action: 'back' } })).status, 202);
  const vp = await json('/api/session/viewport', { method: 'POST', body: { preset: 'mobile' } });
  assert.deepEqual([vp.session.browser.viewport.width, vp.session.browser.viewport.height], [390, 844]);
  assert.equal((await json('/api/session/viewport', { method: 'POST', body: { width: 50, height: 50 } })).status, 400);
  assert.equal((await json('/api/session/collector', { method: 'POST', body: { on: false } })).session.collectorOn, false);
  assert.equal((await json('/api/session/collector', { method: 'POST', body: { on: true } })).session.collectorOn, true);
  assert.equal((await json('/api/session/scan', { method: 'POST' })).status, 200);
  const fin = await json('/api/session/finish', { method: 'POST' });
  assert.equal(fin.session.status, 'completed');

  // exports
  assert.equal((await json('/api/session/export-check', { method: 'POST', body: { scope: 'selected', ids: [] } })).status, 400);
  assert.equal((await json('/api/session/export-check', { method: 'POST', body: { scope: 'css' } })).status, 200);
  const dir = path.join(tmp, '_zip'); fs.mkdirSync(dir, { recursive: true });
  for (const [scope, extra] of [['all', ''], ['site', ''], ['css', ''], ['selected', `&ids=${css.id},${png.id}`]]) {
    const r = await call(`/api/session/download?scope=${scope}${extra}`);
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/zip');
    const f = path.join(dir, scope + '.zip'); fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
    const list = execFileSync('unzip', ['-l', f]).toString();
    execFileSync('unzip', ['-tq', f]);
    if (scope === 'all') { assert.match(list, /original\/assets\/css\/s\.css/); assert.match(list, /site\/s\.css/); assert.match(list, /metadata\/pages\.json/); assert.match(list, /reconstructed\//); }
    if (scope === 'site') assert.match(list, /index\.html/);
    if (scope === 'selected') { assert.match(list, /s\.css/); assert.match(list, /p\.png/); assert.doesNotMatch(list, /a\.js/); }
  }

  // replace
  ws.close();
  assert.equal((await json('/api/session', { method: 'DELETE' })).status, 200);
  cookie = '';
  assert.equal((await json('/api/session')).status, 401);
  await until(() => fs.readdirSync(tmp).filter((d) => d !== '_zip').length === 0, 8000);
});
