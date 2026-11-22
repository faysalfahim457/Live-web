import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = process.env.PORT || 7860;
const HOST = process.env.HOST || '0.0.0.0';
const TEMP_ROOT = process.env.TEMP_ROOT || '/tmp/webcollector';
const PUBLIC_DIR = path.join(process.cwd(), 'public');

if (!fs.existsSync(TEMP_ROOT)) fs.mkdirSync(TEMP_ROOT, { recursive: true });

// সেশন স্টোরেজ (মেমরিতে স্টেট রাখা)
const sessions = new Map();

function getOrCreateSession(token) {
  if (!token || !sessions.has(token)) {
    const id = token || crypto.randomBytes(16).toString('hex');
    const dir = path.join(TEMP_ROOT, id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    // সাইটের ফাইল আসল পাথে সাজানোর সাব-ডিরেক্টরি
    const siteDir = path.join(dir, 'site');
    const originalDir = path.join(dir, 'original');
    fs.mkdirSync(siteDir, { recursive: true });
    fs.mkdirSync(originalDir, { recursive: true });

    const session = {
      id,
      dir,
      siteDir,
      originalDir,
      browser: null,
      context: null,
      page: null,
      cdp: null,
      ws: null,
      resources: new Map(),
      pages: new Set(),
      collecting: true,
      lastUrl: '',
      title: ''
    };
    sessions.set(id, session);
    return session;
  }
  return sessions.get(token);
}

// ফাইল এক্সটেনশন ও টাইপ শনাক্তকারী
function categorizeUrl(urlStr, contentType = '') {
  try {
    const u = new URL(urlStr);
    const p = u.pathname;
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

// সাইটের আসল গঠন অনুযায়ী সেভ করা যাতে আসল কোডিং লজিক ঠিক থাকে
async function saveResource(session, urlStr, buffer, contentType) {
  try {
    const u = new URL(urlStr);
    let pathname = decodeURIComponent(u.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    if (!path.extname(pathname) && contentType.includes('text/html')) pathname += '/index.html';

    const localRelPath = pathname.startsWith('/') ? pathname.slice(1) : pathname;
    const targetFile = path.join(session.siteDir, localRelPath);

    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, buffer);

    const type = categorizeUrl(urlStr, contentType);
    session.resources.set(urlStr, {
      url: urlStr,
      path: localRelPath,
      type,
      size: buffer.length
    });

    // ক্লায়েন্টকে রিয়েল-টাইম আপডেট পাঠানো
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({
        type: 'resource_collected',
        count: session.resources.size,
        resource: { url: urlStr, type, size: buffer.length, path: localRelPath }
      }));
    }
  } catch (err) {
    // অকার্যকর URL স্কিপ
  }
}

async function initBrowser(session) {
  if (session.browser) return;

  // Render 512MB RAM এর জন্য ক্রোমিয়াম অপ্টিমাইজেশন
  session.browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // র‍্যাম ক্র্যাশ ঠেকাবে
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-extensions',
      '--mute-audio',
      '--no-first-run',
      '--js-flags=--max-old-space-size=256'
    ]
  });

  session.context = await session.browser.newContext({
    viewport: { width: 390, height: 844 }, // মোবাইল সাইজ ডিফল্ট
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
  });

  session.page = await session.context.newPage();
  session.cdp = await session.page.context().newCDPSession(session.page);

  // সব ধরনের নেটওয়ার্ক রিকোয়েস্ট লাইভ ক্যাপচার
  session.page.on('response', async (resp) => {
    if (!session.collecting) return;
    try {
      const status = resp.status();
      if (status >= 200 && status < 300) {
        const url = resp.url();
        if (url.startsWith('http')) {
          const buffer = await resp.body().catch(() => null);
          const ct = resp.headers()['content-type'] || '';
          if (buffer && buffer.length > 0) {
            await saveResource(session, url, buffer, ct);
          }
        }
      }
    } catch {}
  });

  // CDP Screencast - ফ্রেম আটকানো বন্ধের জন্য রিয়েল-টাইম ACK লজিক
  await session.cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 35,
    maxWidth: 390,
    maxHeight: 844,
    everyNthFrame: 2
  });

  session.cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
    // ক্রোমিয়াম যাতে পরবর্তী ফ্রেম না আটকে রাখে সেজন্য সাথে সাথে ACK দিতে হবে
    try {
      await session.cdp.send('Page.screencastFrameAck', { sessionId });
    } catch {}

    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({
        type: 'frame',
        data
      }));
    }
  });

  // পেজ লোড শেষ বা টাইটেল চেঞ্জ হলে ফ্রন্টএন্ড জানানো
  session.page.on('framenavigated', async () => {
    session.lastUrl = session.page.url();
    session.pages.add(session.lastUrl);
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({
        type: 'navigated',
        url: session.lastUrl,
        pagesCount: session.pages.size
      }));
    }
  });
}

// HTTP Server
const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  let filePath = path.join(PUBLIC_DIR, parsed.pathname === '/' ? 'index.html' : parsed.pathname);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const mimeMap = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.svg': 'image/svg+xml',
      '.png': 'image/png'
    };
    res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'text/plain' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// WebSocket Server (রিয়েলটাইম টাচ, ক্লিক ও ব্রাউজার কমান্ড)
const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, req) => {
  const token = 'active_session';
  const session = getOrCreateSession(token);
  session.ws = ws;

  await initBrowser(session);

  // সংযোগ হওয়া মাত্র বর্তমান স্ট্যাটাস পাঠানো
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

      // ১. নেভিগেশন কমান্ড (নন-ব্লকিং, অনন্তকাল লোডিং হওয়া রোধ)
      if (msg.type === 'navigate') {
        let target = msg.url.trim();
        if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
        ws.send(JSON.stringify({ type: 'status', state: 'collecting', url: target }));

        try {
          // 'networkidle' পরিহার করা হয়েছে যাতে লাইভ সকেট পেজে আটকে না থাকে
          await session.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 35000 });
        } catch (e) {
          // কোনো এরর হলেও ফ্রন্টএন্ডে ব্রাউজার সচল থাকবে
        }
        ws.send(JSON.stringify({ type: 'status', state: 'collecting', url: session.page.url() }));
      }

      // ২. মাউস ও টাচ ক্লিক হ্যান্ডলার
      if (msg.type === 'mouse' && session.cdp) {
        if (msg.event === 'mousedown' || msg.event === 'mouseup') {
          await session.cdp.send('Input.dispatchMouseEvent', {
            type: msg.event === 'mousedown' ? 'mousePressed' : 'mouseReleased',
            x: msg.x,
            y: msg.y,
            button: 'left',
            clickCount: 1
          });
        } else if (msg.event === 'mousemove') {
          await session.cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: msg.x,
            y: msg.y
          });
        }
      }

      // ৩. স্ক্রোল ও টাচ হুইল হ্যান্ডলার
      if (msg.type === 'wheel' && session.cdp) {
        await session.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: msg.x || 195,
          y: msg.y || 422,
          deltaX: msg.deltaX || 0,
          deltaY: msg.deltaY || 0
        });
      }

      // ৪. মোবাইল কিবোর্ড টাইপিং
      if (msg.type === 'type' && session.page) {
        await session.page.keyboard.type(msg.text);
      }

      // ৫. ব্রাউজার অ্যাকশন (Back, Forward, Reload)
      if (msg.type === 'nav_action') {
        if (msg.action === 'back') await session.page.goBack().catch(() => {});
        if (msg.action === 'fwd') await session.page.goForward().catch(() => {});
        if (msg.action === 'reload') await session.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      }

      // ৬. নতুন কালেকশনের জন্য সেশন ক্লিয়ার
      if (msg.type === 'reset') {
        session.resources.clear();
        session.pages.clear();
        if (fs.existsSync(session.dir)) {
          fs.rmSync(session.dir, { recursive: true, force: true });
          fs.mkdirSync(session.siteDir, { recursive: true });
        }
        ws.send(JSON.stringify({ type: 'status', state: 'ready', count: 0, pages: 0, url: '' }));
      }
    } catch (err) {
      console.error('Socket message error:', err.message);
    }
  });

  ws.on('close', () => {
    if (session.ws === ws) session.ws = null;
  });
});

server.listen(PORT, HOST, () => {
  console.log(`WebCollector Server running on http://${HOST}:${PORT}`);
});
