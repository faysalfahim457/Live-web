const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { chromium } = require('playwright');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 7860;
const HOST = '0.0.0.0';
const TEMP_ROOT = process.env.TEMP_ROOT || '/tmp/webcollector';
const PUBLIC_DIR = path.join(process.cwd(), 'public');

if (!fs.existsSync(TEMP_ROOT)) fs.mkdirSync(TEMP_ROOT, { recursive: true });

// সেশন ম্যানেজার
const session = {
  id: 'active_session',
  dir: path.join(TEMP_ROOT, 'active_session'),
  siteDir: path.join(TEMP_ROOT, 'active_session', 'site'),
  browser: null,
  context: null,
  page: null,
  cdp: null,
  ws: null,
  resources: new Map(),
  pages: new Map(),
  collecting: true,
  lastUrl: '',
  viewport: { width: 390, height: 844 }
};

if (!fs.existsSync(session.siteDir)) fs.mkdirSync(session.siteDir, { recursive: true });

// ফাইল টাইপ সনাক্তকরণ
function categorize(urlStr, contentType = '') {
  try {
    const p = new URL(urlStr).pathname.toLowerCase();
    if (contentType.includes('text/html') || p.endsWith('.html') || p.endsWith('/')) return 'html';
    if (contentType.includes('text/css') || p.endsWith('.css')) return 'css';
    if (contentType.includes('javascript') || p.endsWith('.js')) return 'js';
    if (contentType.includes('image') || /\.(png|jpg|jpeg|gif|webp|svg|ico)$/i.test(p)) return 'images';
    if (contentType.includes('font') || /\.(woff|woff2|ttf|otf|eot)$/i.test(p)) return 'fonts';
    return 'other';
  } catch {
    return 'other';
  }
}

// সাইটের আসল পাথে ফাইল সেভ করা
function saveResource(urlStr, buffer, contentType) {
  try {
    const u = new URL(urlStr);
    let pathname = decodeURIComponent(u.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    if (!path.extname(pathname) && (contentType.includes('text/html') || pathname.endsWith('/'))) {
      pathname = path.join(pathname, 'index.html');
    }

    const localRel = pathname.startsWith('/') ? pathname.slice(1) : pathname;
    const targetPath = path.join(session.siteDir, localRel);

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, buffer);

    const type = categorize(urlStr, contentType);
    const item = { url: urlStr, path: localRel, type, size: buffer.length };
    session.resources.set(urlStr, item);

    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({
        type: 'resource_collected',
        count: session.resources.size,
        resource: item
      }));
    }
  } catch (err) {}
}

// ব্রাউজার ইঞ্জিন ইনিশিয়ালাইজ
async function initBrowser() {
  if (session.browser) return;

  session.browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--js-flags=--max-old-space-size=256'
    ]
  });

  session.context = await session.browser.newContext({
    viewport: session.viewport,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: true,
    bypassCSP: true
  });

  // পপ-আপ বা নতুন ট্যাবের লিংক সরাসরি বর্তমান ট্যাবেই আনা
  session.context.on('page', async (newPage) => {
    try {
      const targetUrl = newPage.url();
      await newPage.close().catch(() => {});
      if (targetUrl && targetUrl !== 'about:blank' && session.page) {
        await session.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }
    } catch {}
  });

  session.page = await session.context.newPage();
  
  // বট ডিটেকশন বাইপাস স্ক্রিপ্ট
  await session.page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.open = (url) => { if (url) window.location.href = url; return window; };
  });

  session.cdp = await session.context.newCDPSession(session.page);

  // সব ফাইল অটো-ক্যাপচার
  session.page.on('response', async (resp) => {
    if (!session.collecting) return;
    try {
      const url = resp.url();
      if (url.startsWith('http')) {
        const ct = resp.headers()['content-type'] || '';
        const body = await resp.body().catch(() => null);
        if (body && body.length > 0) {
          saveResource(url, body, ct);
        }
      }
    } catch {}
  });

  // স্ক্রিনকাস্ট স্ট্রিম
  await session.cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 45,
    maxWidth: session.viewport.width,
    maxHeight: session.viewport.height,
    everyNthFrame: 1
  });

  session.cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
    try {
      await session.cdp.send('Page.screencastFrameAck', { sessionId });
    } catch {}

    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: 'frame', data }));
    }
  });

  session.page.on('framenavigated', () => {
    const curUrl = session.page.url();
    if (curUrl && curUrl !== 'about:blank') {
      session.lastUrl = curUrl;
      session.pages.set(curUrl, true);
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({
          type: 'navigated',
          url: curUrl,
          pagesCount: session.pages.size
        }));
      }
    }
  });
}

// জিপ তৈরি করার ফাংশন (Zero-dependency ZIP stream)
function createZipStream(sourceDir) {
  const files = [];
  function scan(dir, base = '') {
    if (!fs.existsSync(dir)) return;
    for (const item of fs.readdirSync(dir)) {
      const full = path.join(dir, item);
      const rel = path.join(base, item).replace(/\\/g, '/');
      if (fs.statSync(full).isDirectory()) scan(full, rel);
      else files.push({ rel, full, size: fs.statSync(full).size });
    }
  }
  scan(sourceDir);

  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
    crcTable[n] = c >>> 0;
  }
  function getCrc32(buf) {
    let crc = 0 ^ (-1);
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
    return (crc ^ (-1)) >>> 0;
  }

  const parts = [];
  const cdEntries = [];
  let offset = 0;

  for (const f of files) {
    const data = fs.readFileSync(f.full);
    const crc = getCrc32(data);
    const nameBuf = Buffer.from(f.rel, 'utf8');

    // Local Header
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0, 6);
    h.writeUInt16LE(0, 8); // No compression (store mode)
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(0, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28);

    parts.push(h, nameBuf, data);

    // Central Directory Entry
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);

    cdEntries.push(cd, nameBuf);
    offset += h.length + nameBuf.length + data.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const b of cdEntries) cdSize += b.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, ...cdEntries, eocd]);
}

// HTTP Server
const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);

  // ডাউনলোড এন্ডপয়েন্ট
  if (parsed.pathname === '/api/download') {
    const zipBuffer = createZipStream(session.siteDir);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="collected-site.zip"',
      'Content-Length': zipBuffer.length
    });
    return res.end(zipBuffer);
  }

  // স্ট্যাটিক ফাইল সার্ভিং
  let filePath = path.join(PUBLIC_DIR, parsed.pathname === '/' ? 'index.html' : parsed.pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const mimes = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.svg': 'image/svg+xml',
      '.png': 'image/png'
    };
    res.writeHead(200, { 'Content-Type': mimes[ext] || 'text/plain' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// WebSocket Server
const wss = new WebSocketServer({ server });

wss.on('connection', async (ws) => {
  session.ws = ws;
  await initBrowser();

  ws.send(JSON.stringify({
    type: 'status',
    state: 'ready',
    count: session.resources.size,
    pages: session.pages.size,
    url: session.lastUrl
  }));

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);

      // ১. পেজ নেভিগেশন (সম্পূর্ণ রিবুট ও ফ্রেশ ভিজিট)
      if (msg.type === 'navigate') {
        let target = msg.url.trim();
        if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

        ws.send(JSON.stringify({ type: 'status', state: 'collecting', url: target }));

        try {
          await session.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 35000 });
          session.lastUrl = session.page.url();
          session.pages.set(session.lastUrl, true);
        } catch (e) {}

        ws.send(JSON.stringify({
          type: 'status',
          state: 'collecting',
          url: session.lastUrl || target,
          count: session.resources.size
        }));
      }

      // ২. মাউস ও টাচ ইভেন্ট
      if (msg.type === 'mouse' && session.cdp) {
        if (msg.event === 'mousedown' || msg.event === 'mouseup') {
          await session.cdp.send('Input.dispatchMouseEvent', {
            type: msg.event === 'mousedown' ? 'mousePressed' : 'mouseReleased',
            x: msg.x,
            y: msg.y,
            button: 'left',
            clickCount: 1
          });
        }
      }

      // ৩. স্ক্রোলিং ও হুইল
      if (msg.type === 'wheel' && session.cdp) {
        await session.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: msg.x || 195,
          y: msg.y || 422,
          deltaX: msg.deltaX || 0,
          deltaY: msg.deltaY || 0
        });
      }

      // ৪. অটো-স্ক্যান (Lazy Chunk ও ছবি সংগ্রহের জন্য পেজ অটো-স্ক্রোল)
      if (msg.type === 'scan' && session.page) {
        ws.send(JSON.stringify({ type: 'status', state: 'collecting', message: 'Scanning page...' }));
        await session.page.evaluate(async () => {
          await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 300;
            const timer = setInterval(() => {
              const scrollHeight = document.body.scrollHeight;
              window.scrollBy(0, distance);
              totalHeight += distance;
              if (totalHeight >= scrollHeight) {
                clearInterval(timer);
                window.scrollTo(0, 0);
                resolve();
              }
            }, 100);
          });
        });
      }

      // ৫. ভিউপোর্ট পরিবর্তন (মোবাইল / ট্যাব / ডেস্কটপ)
      if (msg.type === 'set_viewport' && session.page) {
        session.viewport = { width: msg.width, height: msg.height };
        await session.page.setViewportSize(session.viewport);
        await session.cdp.send('Page.startScreencast', {
          format: 'jpeg',
          quality: 45,
          maxWidth: msg.width,
          maxHeight: msg.height,
          everyNthFrame: 1
        });
      }

      // ৬. টাইপিং
      if (msg.type === 'type' && session.page) {
        await session.page.keyboard.type(msg.text);
      }

      // ৭. ব্রাউজার ব্যাক / ফরোয়ার্ড / রিলোড
      if (msg.type === 'nav_action' && session.page) {
        if (msg.action === 'back') await session.page.goBack().catch(() => {});
        if (msg.action === 'fwd') await session.page.goForward().catch(() => {});
        if (msg.action === 'reload') await session.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      }

      // ৮. নতুন কালেকশন রিসেট
      if (msg.type === 'reset') {
        session.resources.clear();
        session.pages.clear();
        session.lastUrl = '';
        if (fs.existsSync(session.siteDir)) {
          fs.rmSync(session.siteDir, { recursive: true, force: true });
          fs.mkdirSync(session.siteDir, { recursive: true });
        }
        if (session.page) await session.page.goto('about:blank');
        ws.send(JSON.stringify({ type: 'status', state: 'ready', count: 0, pages: 0, url: '' }));
      }
    } catch (e) {}
  });
});

server.listen(PORT, HOST, () => {
  console.log(`WebCollector Studio listening on port ${PORT}`);
});
