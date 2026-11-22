/* WebCollector Studio — browser UI.
 * Talks to server.js over REST (/api/session/...) and one WebSocket (/ws) that streams the remote
 * browser as JPEG frames and carries mouse / keyboard input back. */
(function () {
  'use strict';

  // ------------------------------------------------------------------ elements
  const $ = (id) => document.getElementById(id);
  const app = $('app'), stage = $('stage'), frameWrap = $('frame'), screen = $('screen'), ctx = screen.getContext('2d');
  const welcome = $('welcome'), spinner = $('spinner'), loadbar = $('loadbar');
  const urlForm = $('url-form'), urlInput = $('url'), welcomeForm = $('welcome-form'), welcomeUrl = $('welcome-url');
  const statusPill = $('status-pill'), statusText = $('status-text');
  const sbUrl = $('sb-url'), sbState = $('sb-state'), statsEl = $('stats'), statsM = $('stats-m'), dlSum = $('dl-sum'), bnCount = $('bn-count');
  const banner = $('banner'), bannerText = $('banner-text'), bannerRetry = $('banner-retry');
  const fileList = $('list'), pagesEl = $('pages'), qInput = $('q'), chips = $('chips'), sideTools = $('side-tools');
  const selAll = $('sel-all'), selCount = $('sel-count'), moreFilesBtn = $('btn-more-files');
  const btnKbd = $('btn-kbd'), kbdInput = $('kbd-input');
  const dlMenu = $('dl-menu'), chkRecon = $('chk-recon');
  const exportBox = $('export'), exportBar = $('export-bar'), exportText = $('export-text');
  const actions = $('actions');
  const modalBg = $('modal-bg'), modal = $('modal');

  // ------------------------------------------------------------------ state
  const PRESETS = { desktop: { width: 1440, height: 900 }, tablet: { width: 768, height: 1024 }, mobile: { width: 390, height: 844 } };
  const S = {
    has: false, session: null, stats: null,
    vp: { width: 390, height: 844 },
    pending: null,                 // viewport chosen before a session exists: {preset} or {width,height}
    tab: 'files', filter: 'all', q: '',
    files: [], total: 0, page: 1, fileMap: new Map(), selected: new Set(),
    pages: [], pagesDirty: true, filesDirty: true,
    ws: null, wsIntentional: false, reconnectTimer: null, pingTimer: null,
    bannerCode: null,
  };

  // ------------------------------------------------------------------ utils
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtBytes = (n) => {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB']; let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < 2);
    return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
  };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const icon = (id) => `<svg><use href="#i-${id}"/></svg>`;

  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'err' ? 6500 : 4000);
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* not json */ }
    if (!res.ok) {
      const err = new Error((data && data.error && data.error.message) || `Request failed (${res.status})`);
      err.status = res.status; err.code = data && data.error && data.error.code; err.retryable = !!(data && data.error && data.error.retryable);
      throw err;
    }
    return data;
  }
  const act = async (fn) => { try { return await fn(); } catch (e) { handleApiError(e); return null; } };
  function handleApiError(e) {
    if (e.status === 401 && S.has) { resetUi('The collection has ended. Start a new one.'); return; }
    toast(e.message || 'Something went wrong.', 'err');
  }

  // ------------------------------------------------------------------ views (mobile bottom nav)
  const navButtons = document.querySelectorAll('#bottomnav button');
  function switchView(view) {
    app.setAttribute('data-view', view);
    navButtons.forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    if (view === 'files') { S.tab = S.tab || 'files'; refreshSide(true); }
    if (view === 'downloads') renderStats();
    if (view === 'browser') requestAnimationFrame(fit);
  }
  navButtons.forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  $('side-close').addEventListener('click', () => switchView('browser'));

  // ------------------------------------------------------------------ websocket
  function connect() {
    if (S.ws || !S.has) return;
    S.wsIntentional = false;
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.binaryType = 'blob';
    S.ws = ws;
    ws.onopen = () => {
      clearInterval(S.pingTimer);
      S.pingTimer = setInterval(() => wsSend({ t: 'ping' }), 20000);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') { let m; try { m = JSON.parse(e.data); } catch { return; } onServer(m); } else drawFrame(e.data);
    };
    ws.onclose = () => {
      clearInterval(S.pingTimer);
      if (S.ws === ws) S.ws = null;
      if (S.wsIntentional || !S.has) return;
      setStatus('terminated', 'Reconnecting…');
      scheduleReconnect(1500);
    };
    ws.onerror = () => {};
  }
  function scheduleReconnect(ms) {
    clearTimeout(S.reconnectTimer);
    S.reconnectTimer = setTimeout(async () => {
      if (!S.has || S.wsIntentional) return;
      try { const r = await api('/api/session'); applyState(r.session); applyStats(r.stats); connect(); }
      catch (err) { if (err.status === 401) resetUi('The collection expired or was replaced.'); else scheduleReconnect(3000); }
    }, ms);
  }
  function disconnect() {
    S.wsIntentional = true; clearTimeout(S.reconnectTimer); clearInterval(S.pingTimer);
    if (S.ws) { try { S.ws.close(); } catch { /* ignore */ } S.ws = null; }
  }
  function wsSend(o) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); }

  function onServer(m) {
    switch (m.type) {
      case 'hello': applyState(m.state); applyStats(m.stats); S.filesDirty = S.pagesDirty = true; refreshSide(); break;
      case 'state': applyState(m.state); break;
      case 'stats': applyStats(m.stats); break;
      case 'resource': case 'resource-updated': S.filesDirty = true; refreshSideSoon(); break;
      case 'pages': S.pagesDirty = true; refreshSideSoon(); break;
      case 'failures': if (modal.dataset.kind === 'failures') openFailures(); break;
      case 'error': showBanner(m.error); break;
      case 'export': onExport(m); break;
      default: break;
    }
  }

  // ------------------------------------------------------------------ frames
  let decoding = false, nextBlob = null;
  async function drawFrame(blob) {
    if (decoding) { nextBlob = blob; return; }
    decoding = true;
    try {
      const bmp = await createImageBitmap(blob);
      if (screen.width !== bmp.width || screen.height !== bmp.height) { screen.width = bmp.width; screen.height = bmp.height; }
      ctx.drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      if (frameWrap.hidden) { frameWrap.hidden = false; btnKbd.hidden = false; }
      fit();
    } catch { /* corrupt frame */ }
    decoding = false;
    if (nextBlob) { const b = nextBlob; nextBlob = null; drawFrame(b); }
  }

  function fit() {
    const w = screen.width || S.vp.width, h = screen.height || S.vp.height;
    const maxW = stage.clientWidth - 12, maxH = stage.clientHeight - 12;
    if (maxW <= 0 || maxH <= 0) return;
    const k = Math.min(maxW / w, maxH / h, 1);
    frameWrap.style.width = Math.round(w * k) + 'px';
    frameWrap.style.height = Math.round(h * k) + 'px';
  }
  if (window.ResizeObserver) new ResizeObserver(fit).observe(stage); else window.addEventListener('resize', fit);

  // ------------------------------------------------------------------ state rendering
  const STATUS_TEXT = { collecting: 'Collecting', completed: 'Completed', downloading: 'Downloading…', terminated: 'Session ended' };
  function setStatus(s, text) {
    statusPill.dataset.s = s; statusText.textContent = text; sbState.textContent = text;
  }

  function applyState(st) {
    if (!st) return;
    S.session = st; S.has = true;
    app.dataset.has = 'yes';
    setStatus(st.status, STATUS_TEXT[st.status] || st.status);
    const b = st.browser || {};
    if (b.url) { if (document.activeElement !== urlInput) urlInput.value = b.url; sbUrl.textContent = b.url; }
    else sbUrl.textContent = '—';
    $('btn-back').disabled = !b.canGoBack; $('btn-fwd').disabled = !b.canGoForward;
    const ended = st.phase === 'terminated';
    ['btn-reload', 'btn-stop', 'btn-home', 'btn-open'].forEach((id) => { $(id).disabled = false; });
    $('btn-reload').disabled = ended; $('btn-home').disabled = ended || !b.homeUrl;
    spinner.hidden = !(b.loading || b.scanning);
    loadbar.classList.toggle('on', !!b.loading);
    const scanBtn = $('btn-scan');
    scanBtn.disabled = !!b.scanning || ended || !st.collectorOn;
    scanBtn.querySelector('span').textContent = b.scanning ? 'Scanning…' : 'Scan Current Page';
    const sw = $('sw-collector'); sw.checked = !!st.collectorOn; sw.disabled = ended;
    $('btn-finish').disabled = st.phase === 'completed' || st.status === 'downloading';
    $('btn-zip').classList.toggle('pulse', st.phase === 'completed');
    $('btn-new').disabled = st.status === 'downloading'; $('m-new').disabled = st.status === 'downloading';
    if (b.viewport) {
      S.vp = { width: b.viewport.width, height: b.viewport.height };
      document.querySelectorAll('[data-vp]').forEach((x) => x.classList.toggle('on', x.dataset.vp === b.viewport.preset));
      if (document.activeElement !== $('vp-w') && document.activeElement !== $('vp-h')) { $('vp-w').value = S.vp.width; $('vp-h').value = S.vp.height; }
      fit();
    }
    welcome.hidden = true;
    if (b.lastError) showBanner(b.lastError, 'nav');
    else if (S.bannerCode && banner.dataset.src === 'nav') hideBanner();
  }

  function applyStats(st) {
    if (!st) return;
    S.stats = st;
    bnCount.textContent = st.files > 0 ? st.files : '';
    const item = (label, v) => `<span>${label} <b>${esc(v)}</b></span>`;
    const parts = [item('Pages', st.pages), item('Files', st.files), item('HTML', st.html), item('CSS', st.css), item('JS', st.js), item('Images', st.images), item('Fonts', st.fonts), item('Other', st.other), item('Size', fmtBytes(st.bytes))];
    if (st.queue) parts.push(item('Queue', st.queue));
    if (st.failed) parts.push(`<span class="warn" data-act="failures" title="Show failed requests">Failed <b>${st.failed}</b></span>`);
    if (st.full) parts.push('<span class="warn" style="color:var(--err)">Storage full</span>');
    statsEl.innerHTML = parts.join('');
    renderStats();
  }
  function renderStats() {
    const st = S.stats;
    if (!st) { dlSum.textContent = 'Nothing collected yet.'; statsM.innerHTML = ''; return; }
    dlSum.textContent = st.files ? `${st.files} files (${fmtBytes(st.bytes)}) from ${st.pages} page${st.pages === 1 ? '' : 's'} collected.` : 'Nothing collected yet.';
    const cell = (n, l) => `<div><b>${esc(n)}</b><span>${l}</span></div>`;
    statsM.innerHTML = cell(st.pages, 'Pages') + cell(st.files, 'Files') + cell(st.html, 'HTML') + cell(st.css, 'CSS') + cell(st.js, 'JS') + cell(st.images, 'Images') + cell(st.fonts, 'Fonts') + cell(st.failed, 'Failed');
  }
  statsEl.addEventListener('click', (e) => { if (e.target.closest('[data-act=failures]')) openFailures(); });

  function showBanner(err, src) {
    S.bannerCode = err.code; banner.dataset.src = src || 'event';
    bannerText.textContent = err.message;
    banner.classList.toggle('info', err.code === 'STORAGE_FULL');
    bannerRetry.hidden = !err.retryable;
    banner.hidden = false;
    requestAnimationFrame(fit);
  }
  function hideBanner() { banner.hidden = true; S.bannerCode = null; requestAnimationFrame(fit); }
  $('banner-x').addEventListener('click', hideBanner);
  bannerRetry.addEventListener('click', () => { hideBanner(); act(() => api('/api/session/nav', { method: 'POST', body: { action: 'reload' } })); });

  function resetUi(message) {
    disconnect();
    S.has = false; S.session = null; S.stats = null;
    S.files = []; S.total = 0; S.page = 1; S.fileMap.clear(); S.selected.clear(); S.pages = [];
    delete app.dataset.has;
    welcome.hidden = false; frameWrap.hidden = true; btnKbd.hidden = true; spinner.hidden = true; loadbar.classList.remove('on');
    ctx.clearRect(0, 0, screen.width, screen.height);
    urlInput.value = ''; welcomeUrl.value = ''; sbUrl.textContent = '—'; statsEl.innerHTML = ''; statsM.innerHTML = ''; bnCount.textContent = '';
    dlSum.textContent = 'Nothing collected yet.';
    setStatus('ready', 'Ready for New Collection');
    ['btn-back', 'btn-fwd'].forEach((id) => { $(id).disabled = true; });
    $('btn-scan').disabled = false; $('btn-scan').querySelector('span').textContent = 'Scan Current Page';
    $('btn-finish').disabled = false; $('btn-zip').classList.remove('pulse'); $('btn-new').disabled = false; $('m-new').disabled = false;
    $('sw-collector').checked = true; $('sw-collector').disabled = false;
    hideBanner(); closeModal(); exportBox.hidden = true;
    renderFiles(); renderPages(); updateSelCount(); switchView('browser');
    if (message) toast(message);
  }

  // ------------------------------------------------------------------ opening websites
  function defaultPreset() { return window.innerWidth < 900 ? 'mobile' : 'desktop'; }

  async function openSite(raw) {
    const target = String(raw || '').trim();
    if (!target) { toast('Enter a website address first.', 'err'); return; }
    switchView('browser');
    setStatus('collecting', 'Loading site…');
    spinner.hidden = false;
    try {
      if (S.has && S.session && S.session.phase !== 'terminated') {
        await api('/api/session/navigate', { method: 'POST', body: { url: target } });
      } else {
        const body = { url: target };
        const p = S.pending || { preset: defaultPreset() };
        if (p.preset) body.preset = p.preset; else { body.viewport = { width: p.width, height: p.height }; body.preset = 'custom'; }
        const r = await api('/api/session', { method: 'POST', body });
        disconnect();
        S.has = true; S.files = []; S.fileMap.clear(); S.selected.clear(); S.pending = null;
        S.filesDirty = S.pagesDirty = true;
        frameWrap.hidden = false; // canvas appears with first frame
        applyState(r.session); applyStats(r.stats);
        connect();
      }
    } catch (e) {
      if (!S.has) { setStatus('ready', 'Ready for New Collection'); welcome.hidden = false; }
      else if (S.session) applyState(S.session);
      spinner.hidden = true;
      handleApiError(e);
    }
  }
  urlForm.addEventListener('submit', (e) => { e.preventDefault(); openSite(urlInput.value); });
  welcomeForm.addEventListener('submit', (e) => { e.preventDefault(); openSite(welcomeUrl.value); });

  // ------------------------------------------------------------------ toolbar actions
  const nav = (action) => act(() => api('/api/session/nav', { method: 'POST', body: { action } }));
  $('btn-back').addEventListener('click', () => nav('back'));
  $('btn-fwd').addEventListener('click', () => nav('forward'));
  $('btn-reload').addEventListener('click', () => { if (S.has) nav('reload'); });
  $('btn-stop').addEventListener('click', () => { if (S.has) nav('stop'); });
  $('btn-home').addEventListener('click', () => { if (S.has) nav('home'); });

  document.querySelectorAll('[data-vp]').forEach((b) => b.addEventListener('click', () => setViewport({ preset: b.dataset.vp })));
  $('vp-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const width = parseInt($('vp-w').value, 10), height = parseInt($('vp-h').value, 10);
    if (!(width >= 200 && width <= 3840 && height >= 200 && height <= 2400)) { toast('Width 200–3840 and height 200–2400.', 'err'); return; }
    setViewport({ width, height });
  });
  async function setViewport(v) {
    if (!S.has) {
      S.pending = v;
      const pv = v.preset ? PRESETS[v.preset] : v;
      S.vp = { width: pv.width, height: pv.height };
      document.querySelectorAll('[data-vp]').forEach((x) => x.classList.toggle('on', x.dataset.vp === v.preset));
      $('vp-w').value = pv.width; $('vp-h').value = pv.height;
      toast(`Viewport ${pv.width}×${pv.height} will be used for the next collection.`);
      return;
    }
    const r = await act(() => api('/api/session/viewport', { method: 'POST', body: v }));
    if (r) applyState(r.session);
  }

  $('sw-collector').addEventListener('change', async (e) => {
    const on = e.target.checked;
    if (!S.has) { e.target.checked = true; toast('Open a website first.'); return; }
    const r = await act(() => api('/api/session/collector', { method: 'POST', body: { on } }));
    if (r) applyState(r.session); else e.target.checked = !on;
  });
  $('btn-scan').addEventListener('click', async () => {
    if (!S.has) { toast('Open a website first.'); return; }
    toast('Scanning page — scrolling to load lazy content…');
    const r = await act(() => api('/api/session/scan', { method: 'POST' }));
    if (r) { toast('Scan finished.', 'ok'); S.filesDirty = S.pagesDirty = true; refreshSideSoon(); }
  });
  $('btn-finish').addEventListener('click', async () => {
    if (!S.has) { toast('Nothing to finish yet.'); return; }
    toast('Finishing — waiting for pending files…');
    const r = await act(() => api('/api/session/finish', { method: 'POST' }));
    if (r) { applyState(r.session); applyStats(r.stats); toast('Collection completed. You can download the ZIP now.', 'ok'); }
  });
  $('btn-full').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen(); else if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
  });
  document.addEventListener('fullscreenchange', () => setTimeout(fit, 100));
  $('btn-side').addEventListener('click', () => {
    app.dataset.side = app.dataset.side === 'open' ? 'closed' : 'open';
    $('btn-side').classList.toggle('on', app.dataset.side === 'open');
    setTimeout(fit, 50);
    if (app.dataset.side === 'open') refreshSide(true);
  });
  $('btn-more').addEventListener('click', (e) => { e.stopPropagation(); actions.classList.toggle('as-pop'); setTimeout(fit, 50); });
  document.addEventListener('click', (e) => {
    if (actions.classList.contains('as-pop') && !e.target.closest('#actions') && !e.target.closest('#btn-more')) actions.classList.remove('as-pop');
    if (!dlMenu.hidden && !e.target.closest('.dl-wrap')) dlMenu.hidden = true;
  });

  async function newCollection() {
    if (!S.has) { resetUi(); return; }
    if (!confirm('Start a new collection? The browser will close and all collected files will be deleted.')) return;
    const r = await act(() => api('/api/session', { method: 'DELETE' }));
    if (r) resetUi('Collection replaced. Ready for a new website.');
  }
  $('btn-new').addEventListener('click', newCollection);
  $('m-new').addEventListener('click', newCollection);

  // ------------------------------------------------------------------ downloads
  $('btn-zip-menu').addEventListener('click', (e) => { e.stopPropagation(); dlMenu.hidden = !dlMenu.hidden; });
  $('btn-zip').addEventListener('click', () => download('all'));
  $('m-zip').addEventListener('click', () => download('all'));
  dlMenu.addEventListener('click', (e) => { const b = e.target.closest('button[data-scope]'); if (b) { dlMenu.hidden = true; download(b.dataset.scope); } });
  document.querySelectorAll('.grid-btns [data-scope]').forEach((b) => b.addEventListener('click', () => download(b.dataset.scope)));

  async function currentPageId() {
    const r = await api('/api/session/pages');
    const strip = (u) => String(u || '').split('#')[0];
    const cur = S.session && S.session.browser && S.session.browser.url;
    const hit = r.pages.find((p) => strip(p.url) === strip(cur));
    return (hit || r.pages[r.pages.length - 1] || {}).id || null;
  }

  async function download(scope, extra) {
    if (!S.has) { toast('Nothing collected yet. Open a website first.'); return; }
    if (S.session && S.session.status === 'downloading') { toast('A download is already running.'); return; }
    try {
      const body = Object.assign({ scope, recon: chkRecon.checked }, extra || {});
      if (scope === 'selected') body.ids = [...S.selected];
      if (scope === 'page' && !body.pageId) { body.pageId = await currentPageId(); if (!body.pageId) throw new Error('No page has been collected yet.'); }
      await api('/api/session/export-check', { method: 'POST', body });
      toast('Preparing ZIP…');
      postToFrame('/api/session/download', body);
    } catch (e) { handleApiError(e); }
  }
  function postToFrame(action, fields) {
    const f = document.createElement('form');
    f.method = 'POST'; f.action = action; f.target = 'dlframe'; f.hidden = true;
    for (const [k, v] of Object.entries(fields)) {
      const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = Array.isArray(v) ? v.join(',') : String(v); f.appendChild(i);
    }
    document.body.appendChild(f); f.submit(); f.remove();
  }
  function onExport(m) {
    if (m.done) {
      exportText.textContent = m.failed ? 'Download failed' : 'Download complete';
      setTimeout(() => { exportBox.hidden = true; }, 1800);
      if (!m.failed) toast('ZIP download finished.', 'ok');
      return;
    }
    exportBox.hidden = false;
    exportBar.style.width = Math.round((m.filesDone / Math.max(1, m.filesTotal)) * 100) + '%';
    exportText.textContent = `Building ZIP ${m.filesDone}/${m.filesTotal} · ${fmtBytes(m.bytes)}`;
  }

  // ------------------------------------------------------------------ side panel: files / images / pages
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => {
    S.tab = b.dataset.tab;
    document.querySelectorAll('.tabs [data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    S.filesDirty = true; S.pagesDirty = true;
    refreshSide(true);
  }));
  chips.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    chips.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on');
    S.filter = b.dataset.type; S.filesDirty = true; loadFiles(true);
  }));
  qInput.addEventListener('input', debounce(() => { S.q = qInput.value.trim(); S.filesDirty = true; loadFiles(true); }, 250));
  moreFilesBtn.addEventListener('click', () => loadFiles(false));

  const refreshSideSoon = debounce(() => refreshSide(), 500);
  function sideVisible() { return app.dataset.side === 'open' || app.dataset.view === 'files'; }

  function refreshSide(force) {
    const isPages = S.tab === 'pages';
    fileList.hidden = isPages; pagesEl.hidden = !isPages;
    fileList.classList.toggle('grid', S.tab === 'images');
    chips.hidden = S.tab !== 'files'; sideTools.querySelector('.selbar').hidden = isPages;
    sideTools.querySelector('.search').hidden = isPages;
    if (!S.has || !sideVisible()) { if (!S.has) { renderFiles(); renderPages(); } return; }
    if (isPages) { if (force || S.pagesDirty) loadPages(); } else if (force || S.filesDirty) loadFiles(true);
  }

  let filesReq = 0;
  async function loadFiles(reset) {
    if (!S.has) return;
    const my = ++filesReq;
    const page = reset ? 1 : S.page + 1;
    const pageSize = S.tab === 'images' ? 60 : 50;
    const type = S.tab === 'images' ? 'images' : S.filter;
    const qs = new URLSearchParams({ type, page, pageSize, q: S.q });
    try {
      const r = await api('/api/session/files?' + qs);
      if (my !== filesReq) return;
      S.total = r.total; S.page = r.page; S.filesDirty = false;
      S.files = reset ? r.items : S.files.concat(r.items);
      r.items.forEach((f) => S.fileMap.set(f.id, f));
      renderFiles();
    } catch (e) { if (e.status === 401) handleApiError(e); }
  }

  function fileRow(f) {
    const meta = [fmtBytes(f.size), f.mime, f.httpStatus ? 'HTTP ' + f.httpStatus : null, f.kind !== 'network' ? f.kind : null].filter(Boolean).join(' · ');
    return `<div class="row-item" role="listitem" data-id="${f.id}">
      <label style="display:flex;gap:6px;align-items:center;min-width:92px"><input type="checkbox" class="sel" ${S.selected.has(f.id) ? 'checked' : ''} aria-label="Select ${esc(f.filename)}"><span class="tag">${esc(f.type)}</span></label>
      <div class="fi-main"><div class="fi-name" title="${esc(f.filename)}">${esc(f.filename)}</div><div class="fi-url" title="${esc(f.url)}">${esc(f.url)}</div><div class="fi-meta">${esc(meta)}</div></div>
      <div class="fi-act"><button class="ib sm" data-act="view" title="Preview" aria-label="Preview">${icon('eye')}</button><button class="ib sm" data-act="copy" title="Copy URL" aria-label="Copy URL">${icon('copy')}</button><button class="ib sm" data-act="dl" title="Download file" aria-label="Download file">${icon('dl')}</button></div>
    </div>`;
  }
  function thumb(f) {
    return `<div class="thumb" data-id="${f.id}"><input type="checkbox" class="sel" ${S.selected.has(f.id) ? 'checked' : ''} aria-label="Select ${esc(f.filename)}"><img loading="lazy" alt="${esc(f.filename)}" src="/api/session/file/${f.id}?mode=image"><div class="cap">${esc(f.filename)}</div></div>`;
  }
  function renderFiles() {
    if (!S.has || !S.files.length) {
      fileList.innerHTML = `<div class="empty">${S.has ? (S.q || S.filter !== 'all' ? 'No files match this filter.' : 'Files will appear here as pages load.') : 'No files collected yet.'}</div>`;
      moreFilesBtn.hidden = true; updateSelCount(); return;
    }
    fileList.innerHTML = S.tab === 'images' ? S.files.map(thumb).join('') : S.files.map(fileRow).join('');
    moreFilesBtn.hidden = S.files.length >= S.total;
    moreFilesBtn.textContent = `Load more (${S.total - S.files.length} left)`;
    updateSelCount();
  }

  function updateSelCount() {
    selCount.textContent = `${S.selected.size} selected`;
    const shown = S.files.length;
    selAll.checked = shown > 0 && S.files.every((f) => S.selected.has(f.id));
  }
  selAll.addEventListener('change', () => {
    S.files.forEach((f) => { if (selAll.checked) S.selected.add(f.id); else S.selected.delete(f.id); });
    renderFiles();
  });
  $('sel-clear').addEventListener('click', () => { S.selected.clear(); renderFiles(); });

  fileList.addEventListener('click', (e) => {
    const holder = e.target.closest('[data-id]'); if (!holder) return;
    const id = holder.dataset.id;
    if (e.target.classList.contains('sel')) {
      if (e.target.checked) S.selected.add(id); else S.selected.delete(id);
      updateSelCount(); return;
    }
    const btn = e.target.closest('button[data-act]');
    if (btn) {
      const f = S.fileMap.get(id); if (!f) return;
      if (btn.dataset.act === 'view') openPreview(id);
      if (btn.dataset.act === 'copy') copyText(f.url, 'URL copied.');
      if (btn.dataset.act === 'dl') downloadOne(id);
      return;
    }
    if (holder.classList.contains('thumb')) openPreview(id);
  });
  function downloadOne(id) {
    const a = document.createElement('a'); a.href = `/api/session/file/${id}?mode=download`; a.hidden = true; document.body.appendChild(a); a.click(); a.remove();
  }
  async function copyText(text, okMsg) {
    try { await navigator.clipboard.writeText(text); toast(okMsg || 'Copied.', 'ok'); }
    catch {
      const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); toast(okMsg || 'Copied.', 'ok'); } catch { toast('Copy failed.', 'err'); } t.remove();
    }
  }

  // ---- pages tab
  async function loadPages() {
    if (!S.has) return;
    try { const r = await api('/api/session/pages'); S.pages = r.pages; S.pagesDirty = false; renderPages(); } catch (e) { if (e.status === 401) handleApiError(e); }
  }
  function renderPages() {
    if (!S.has || !S.pages.length) { pagesEl.innerHTML = '<div class="empty">Visited pages will be listed here.</div>'; return; }
    pagesEl.innerHTML = S.pages.slice().reverse().map((p) => `<div class="page-item" data-pid="${p.id}">
      <div class="t">${esc(p.title || '(untitled)')}</div><div class="u">${esc(p.url)}</div>
      ${p.error ? `<div class="u" style="color:var(--err)">${esc(p.error)}</div>` : ''}
      <div class="act"><span class="st ${esc(p.status)}">${esc(p.status)}</span><span class="muted">${p.files} files · ${p.snapshots} snapshots</span><span class="grow"></span>
      <button class="btn sm" data-act="open">Open</button><button class="btn sm" data-act="zip">ZIP</button></div></div>`).join('');
  }
  pagesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]'); const item = e.target.closest('[data-pid]'); if (!btn || !item) return;
    const p = S.pages.find((x) => x.id === item.dataset.pid); if (!p) return;
    if (btn.dataset.act === 'open') { openSite(p.url); if (app.dataset.view === 'files') switchView('browser'); }
    if (btn.dataset.act === 'zip') download('page', { pageId: p.id });
  });

  // ------------------------------------------------------------------ modal (preview / failures)
  function openModal(html, { small = false, kind = '' } = {}) {
    modal.className = 'modal' + (small ? ' small' : ''); modal.dataset.kind = kind; modal.innerHTML = html; modalBg.hidden = false;
  }
  function closeModal() { modalBg.hidden = true; modal.innerHTML = ''; modal.dataset.kind = ''; }
  modalBg.addEventListener('click', (e) => { if (e.target === modalBg || e.target.closest('[data-m=close]')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modalBg.hidden) closeModal(); });

  const TEXT_TYPES = /^(html|css|js)$/;
  function isTextFile(f) { return TEXT_TYPES.test(f.type) || /json|xml|text|svg|javascript|manifest/.test(f.mime) || ['json', 'map', 'txt', 'svg', 'xml', 'webmanifest'].includes(f.ext); }
  function isImageFile(f) { return /^image\//.test(f.mime) && f.type !== 'html'; }

  function highlight(text, type) {
    if (text.length > 250000) return esc(text);
    let re;
    if (type === 'html') re = /(<!--[\s\S]*?-->)|(<\/?[a-zA-Z][^>]*>)/g;
    else re = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d.]*\b)|(\b(?:function|return|const|let|var|if|else|for|while|new|class|import|export|from|default|async|await|try|catch|throw|typeof|this|null|undefined|true|false)\b)/g;
    let out = '', last = 0, m;
    while ((m = re.exec(text))) {
      out += esc(text.slice(last, m.index));
      const cls = type === 'html' ? (m[1] ? 'tk-c' : 'tk-t') : (m[1] ? 'tk-c' : m[2] ? 'tk-s' : m[3] ? 'tk-n' : 'tk-k');
      out += `<span class="${cls}">${esc(m[0])}</span>`;
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;
    }
    return out + esc(text.slice(last));
  }

  async function openPreview(id) {
    const f = S.fileMap.get(id); if (!f) return;
    const canRender = f.type === 'html';
    const head = `<div class="m-head"><h3>${esc(f.filename)}</h3><button class="ib" data-m="close" aria-label="Close">${icon('x')}</button></div>`;
    const sub = `<div class="m-sub">${esc(f.url)} · ${fmtBytes(f.size)} · ${esc(f.mime)}</div>`;
    const foot = (extra) => `<div class="m-foot">${extra || ''}<button class="btn" id="pv-dl">${icon('dl')}Download</button><button class="btn" data-m="close">Close</button></div>`;
    let body = '', extra = '';
    if (isImageFile(f)) body = `<img class="prev-img" alt="${esc(f.filename)}" src="/api/session/file/${id}?mode=image">`;
    else if (isTextFile(f)) {
      if (f.size > 4 * 1024 * 1024) body = '<div class="empty">This file is too large to preview. Download it instead.</div>';
      else { body = '<div class="empty">Loading…</div>'; extra = `<button class="btn" id="pv-copy">${icon('copy')}Copy source</button>` + (canRender ? '<button class="btn" id="pv-render">Render (no scripts)</button>' : ''); }
    } else body = '<div class="empty">No preview for this file type. Use Download to save it.</div>';
    openModal(head + `<div class="m-body">${sub}<div id="pv-body">${body}</div></div>` + foot(extra), { kind: 'preview' });
    $('pv-dl').addEventListener('click', () => downloadOne(id));
    if (isTextFile(f) && f.size <= 4 * 1024 * 1024 && !isImageFile(f)) {
      let text = '';
      try { const r = await fetch(`/api/session/file/${id}`, { credentials: 'same-origin' }); text = await r.text(); }
      catch { if ($('pv-body')) $('pv-body').innerHTML = '<div class="empty">Could not load this file.</div>'; return; }
      if (modal.dataset.kind !== 'preview' || !$('pv-body')) return;
      const shown = text.length > 400000 ? text.slice(0, 400000) : text;
      const showSource = () => { $('pv-body').innerHTML = `<pre class="code">${highlight(shown, f.type === 'html' ? 'html' : 'code')}</pre>${text.length > shown.length ? '<div class="m-sub">Preview truncated — download the file for the full content.</div>' : ''}`; };
      showSource();
      const copy = $('pv-copy'); if (copy) copy.addEventListener('click', () => copyText(text, 'Source copied.'));
      const rend = $('pv-render');
      if (rend) {
        let rendering = false;
        rend.addEventListener('click', () => {
          rendering = !rendering;
          if (rendering) { $('pv-body').innerHTML = `<iframe class="render" sandbox="" title="Rendered snapshot" src="/api/session/file/${id}?mode=render"></iframe>`; rend.textContent = 'Show source'; }
          else { showSource(); rend.textContent = 'Render (no scripts)'; }
        });
      }
    }
  }

  async function openFailures() {
    const r = await act(() => api('/api/session/failures'));
    if (!r) return;
    const rows = r.failures.length ? r.failures.slice().reverse().map((f) => `<div class="fail-row"><b>${esc(f.reason)}</b><br>${esc(f.url)}</div>`).join('') : '<div class="empty">No failed requests.</div>';
    openModal(`<div class="m-head"><h3>Failed requests (${r.failures.length})</h3><button class="ib" data-m="close" aria-label="Close">${icon('x')}</button></div><div class="m-body">${rows}</div><div class="m-foot"><button class="btn primary" id="retry-failed">Retry failed files</button><button class="btn" data-m="close">Close</button></div>`, { kind: 'failures' });
    $('retry-failed').addEventListener('click', async () => {
      $('retry-failed').disabled = true;
      const res = await act(() => api('/api/session/failures/retry', { method: 'POST' }));
      if (res) toast(`Recovered ${res.recovered} of ${res.attempted} files.`, res.recovered ? 'ok' : undefined);
      openFailures();
    });
  }

  // ------------------------------------------------------------------ remote input (mouse / touch / keyboard)
  function coords(e) {
    const r = screen.getBoundingClientRect();
    return { x: Math.round(((e.clientX - r.left) / r.width) * S.vp.width), y: Math.round(((e.clientY - r.top) / r.height) * S.vp.height) };
  }
  const BTN = ['left', 'middle', 'right'];
  let lastMove = 0, touch = null;

  screen.addEventListener('pointerdown', (e) => {
    if (!S.has) return;
    e.preventDefault(); screen.focus({ preventScroll: true });
    try { screen.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (e.pointerType === 'mouse') { const c = coords(e); wsSend({ t: 'down', x: c.x, y: c.y, button: BTN[e.button] || 'left' }); }
    else touch = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
  });
  screen.addEventListener('pointermove', (e) => {
    if (!S.has) return;
    if (e.pointerType === 'mouse') {
      const now = performance.now(); if (now - lastMove < 40) return; lastMove = now;
      const c = coords(e); wsSend({ t: 'move', x: c.x, y: c.y });
    } else if (touch && touch.id === e.pointerId) {
      if (!touch.moved && Math.hypot(e.clientX - touch.sx, e.clientY - touch.sy) > 8) touch.moved = true;
      if (touch.moved) {
        const r = screen.getBoundingClientRect(); const k = S.vp.width / r.width;
        const c = coords(e);
        wsSend({ t: 'wheel', x: c.x, y: c.y, dx: (touch.x - e.clientX) * k, dy: (touch.y - e.clientY) * k });
        touch.x = e.clientX; touch.y = e.clientY;
      }
    }
  });
  screen.addEventListener('pointerup', (e) => {
    if (!S.has) return;
    e.preventDefault();
    if (e.pointerType === 'mouse') { const c = coords(e); wsSend({ t: 'up', x: c.x, y: c.y, button: BTN[e.button] || 'left' }); }
    else if (touch && touch.id === e.pointerId) {
      if (!touch.moved && Date.now() - touch.t < 600) { const c = coords({ clientX: touch.sx, clientY: touch.sy }); wsSend({ t: 'click', x: c.x, y: c.y }); }
      touch = null;
    }
  });
  screen.addEventListener('pointercancel', () => { touch = null; });
  screen.addEventListener('contextmenu', (e) => e.preventDefault());
  screen.addEventListener('wheel', (e) => {
    if (!S.has) return; e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? S.vp.height : 1;
    const c = coords(e); wsSend({ t: 'wheel', x: c.x, y: c.y, dx: e.deltaX * k, dy: e.deltaY * k });
  }, { passive: false });

  const IGNORE_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Process', 'Unidentified', 'AltGraph', 'NumLock', 'ContextMenu']);
  screen.addEventListener('keydown', (e) => {
    if (!S.has || IGNORE_KEYS.has(e.key) || e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'v') return;     // let the paste event deliver the clipboard text
    e.preventDefault();
    if (e.key.length === 1 && !mod && !e.altKey) {
      if (e.key.charCodeAt(0) < 128) wsSend({ t: 'key', key: e.key }); else wsSend({ t: 'text', text: e.key });
      return;
    }
    const mods = [];
    if (mod) mods.push('Control'); if (e.altKey) mods.push('Alt'); if (e.shiftKey && e.key.length > 1) mods.push('Shift');
    wsSend({ t: 'key', key: [...mods, e.key.length === 1 ? e.key.toLowerCase() : e.key].join('+') });
  });
  screen.addEventListener('paste', (e) => {
    if (!S.has) return; e.preventDefault();
    const t = (e.clipboardData && e.clipboardData.getData('text')) || ''; if (t) wsSend({ t: 'text', text: t });
  });

  // on-screen keyboard for phones: a hidden input with a sentinel so Backspace is detectable
  const SENT = '​​';
  function resetKbd() { kbdInput.value = SENT; try { kbdInput.setSelectionRange(SENT.length, SENT.length); } catch { /* ignore */ } }
  btnKbd.addEventListener('click', () => { kbdInput.tabIndex = 0; kbdInput.focus(); resetKbd(); });
  kbdInput.addEventListener('input', () => {
    const v = kbdInput.value;
    if (v.length < SENT.length) wsSend({ t: 'key', key: 'Backspace' });
    else if (v.length > SENT.length) wsSend({ t: 'text', text: v.slice(SENT.length) });
    resetKbd();
  });
  kbdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); wsSend({ t: 'key', key: 'Enter' }); }
    else if (e.key === 'Tab') { e.preventDefault(); wsSend({ t: 'key', key: 'Tab' }); }
  });

  // ------------------------------------------------------------------ boot
  async function boot() {
    setStatus('ready', 'Ready for New Collection');
    $('btn-back').disabled = true; $('btn-fwd').disabled = true;
    $('btn-side').classList.add('on');
    document.querySelector('.tabs [data-tab=files]').classList.add('on');
    refreshSide();
    try {
      const r = await api('/api/session');
      S.has = true; frameWrap.hidden = false;
      applyState(r.session); applyStats(r.stats); connect();
    } catch { /* no session yet: welcome screen stays */ }
  }
  window.addEventListener('beforeunload', () => { S.wsIntentional = true; });
  boot();
})();
