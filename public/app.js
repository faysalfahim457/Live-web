'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const app = $('#app');
  const S = { active: false, session: null, stats: null, type: 'all', tab: 'files', q: '', items: [], total: 0, page: 1, selected: new Set(), pages: [], vw: 1440, vh: 900, ws: null, wsTry: 0, closingWs: false, exporting: null };
  const LABEL = { ready: 'Ready for New Collection', collecting: 'Collecting', completed: 'Completed', downloading: 'Downloading', terminated: 'Session ended' };

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => { if (n < 1024) return n + ' B'; const u = ['KB', 'MB', 'GB']; let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < 2); return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i]; };
  const num = (n) => Number(n || 0).toLocaleString();
  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function toast(msg, kind = '', ms = 5000) {
    const t = el(`<div class="toast ${kind}">${esc(msg)}</div>`); $('#toasts').append(t);
    setTimeout(() => t.remove(), ms); t.addEventListener('click', () => t.remove());
  }
  async function api(method, path, body) {
    let res;
    try { res = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); }
    catch { throw { code: 'NETWORK', message: 'Cannot reach the server. Check your connection and retry.', retryable: true }; }
    let j = null; try { j = await res.json(); } catch { /* non-json */ }
    if (!res.ok) throw (j && j.error) || { code: 'HTTP_' + res.status, message: `Request failed (${res.status}).`, retryable: true };
    return j;
  }
  const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { showError(e); } };

  // ---------- banner ----------
  let bannerRetry = null;
  function showBanner(msg, { info = false, retry = null } = {}) {
    $('#banner').classList.toggle('info', info); $('#banner-text').textContent = msg; $('#banner').hidden = false;
    bannerRetry = retry; $('#banner-retry').hidden = !retry;
  }
  const hideBanner = () => { $('#banner').hidden = true; bannerRetry = null; };
  function showError(e) {
    if (!e) return;
    const retry = e.retryable ? () => { hideBanner(); if (e.code === 'NETWORK') refreshSession(); else if (S.active) api('POST', '/api/session/reload').catch(showError); else $('#url-form').requestSubmit(); } : null;
    showBanner(e.message || 'Something went wrong.', { retry });
  }
  $('#banner-x').onclick = hideBanner; $('#banner-retry').onclick = () => bannerRetry && bannerRetry();

  // ---------- status / toolbar ----------
  function statusKey() { return !S.active ? 'ready' : (S.session ? S.session.status : 'collecting'); }
  function renderStatus() {
    const k = statusKey(); const pill = $('#status-pill'); pill.dataset.s = k; $('#status-text').textContent = LABEL[k];
    $('#sb-state').textContent = LABEL[k];
    const b = S.session && S.session.browser; const st = S.stats || {};
    $('#sb-url').textContent = (b && b.url) || (S.active ? 'Loading…' : '—');
    const has = S.active && st.files > 0; app.dataset.has = has ? 'yes' : 'no';
    const dead = !S.active || (S.session && S.session.phase === 'terminated');
    $('#btn-back').disabled = !S.active || dead || !b.canGoBack; $('#btn-fwd').disabled = !S.active || dead || !b.canGoForward;
    for (const id of ['reload', 'home']) $('#btn-' + id).disabled = !S.active || dead;
    $('#btn-stop').disabled = !S.active || dead || !(b && (b.loading || b.scanning));
    $('#btn-scan').disabled = !S.active || dead || !(S.session && S.session.collectorOn) || (b && b.scanning);
    $('#btn-scan span').textContent = b && b.scanning ? 'Scanning…' : 'Scan Current Page';
    $('#btn-finish').disabled = !S.active || (S.session && S.session.phase === 'completed');
    $('#btn-full').disabled = !S.active; $('#sw-collector').disabled = !S.active || dead;
    $('#sw-collector').checked = !!(S.session && S.session.collectorOn);
    const canDl = has; for (const id of ['btn-zip', 'btn-zip-menu', 'm-zip']) $('#' + id).disabled = !canDl;
    $('#btn-zip').classList.toggle('pulse', canDl && k === 'completed'); $('#m-zip').classList.toggle('pulse', canDl && k === 'completed');
    $('#btn-new').disabled = !S.active; $('#m-new').disabled = !S.active;
    $$('[data-vp]').forEach((x) => x.classList.toggle('on', !!b && b.viewport.preset === x.dataset.vp));
    if (b && document.activeElement !== $('#url') && document.activeElement !== $('#welcome-url')) $('#url').value = b.url || $('#url').value;
    if (b) { if (document.activeElement !== $('#vp-w')) $('#vp-w').value = b.viewport.width; if (document.activeElement !== $('#vp-h')) $('#vp-h').value = b.viewport.height; }
    const loading = !!(b && (b.loading || b.scanning));
    $('#spinner').hidden = !loading; $('#loadbar').classList.toggle('on', !!(b && b.loading));
    $('#btn-reload').hidden = false;
    $('#welcome').hidden = S.active; $('#frame').hidden = !S.active;
    $('#btn-kbd').hidden = !(S.active && matchMedia('(pointer:coarse)').matches);
    if (b && b.lastError && b.lastError.message !== S.lastErrShown) { S.lastErrShown = b.lastError.message; showError(b.lastError); }
    if (b && !b.lastError) S.lastErrShown = null;
    $('#bn-count').textContent = has ? num(st.files) : '';
    $('#dl-selected').disabled = S.selected.size === 0;
    renderDownloadsPanel(); layout();
  }
  function renderStats() {
    const s = S.stats; const box = $('#stats');
    if (!s || !S.active) { box.innerHTML = '<span>No collection running.</span>'; $('#stats-m').innerHTML = ''; return; }
    const cells = [['Collector', s.collector ? 'Active' : 'Paused'], ['Pages visited', num(s.pages)], ['Files', num(s.files)], ['HTML', num(s.html)], ['CSS', num(s.css)], ['JavaScript', num(s.js)], ['Images', num(s.images)], ['Fonts', num(s.fonts)], ['Total size', fmt(s.bytes)], ['Failed', num(s.failed)], ['Duplicates skipped', num(s.duplicates)]];
    box.innerHTML = cells.map(([k, v]) => `<span class="${k === 'Failed' && s.failed ? 'warn' : ''}" data-k="${esc(k)}">${esc(k)}: <b>${esc(v)}</b></span>`).join('');
    $('#stats-m').innerHTML = cells.map(([k, v]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
    const fw = $('[data-k=Failed]', box); if (fw && s.failed) fw.onclick = openFailures;
    $('#bn-count').textContent = s.files ? num(s.files) : '';
    renderDownloadsPanel();
  }
  function renderDownloadsPanel() {
    const s = S.stats; $('#dl-sum').textContent = S.active && s && s.files ? `${num(s.files)} files · ${fmt(s.bytes)} · ${num(s.pages)} page(s)` : 'Nothing collected yet.';
  }

  // ---------- session ----------
  function applyHello(j) { S.active = true; S.session = j.session; S.stats = j.stats; if (j.session.browser) { S.vw = j.session.browser.viewport.width; S.vh = j.session.browser.viewport.height; } renderStatus(); renderStats(); refreshAll(); }
  function resetUi(msg) {
    S.active = false; S.session = null; S.stats = null; S.items = []; S.total = 0; S.page = 1; S.selected.clear(); S.pages = []; S.exporting = null; S.lastErrShown = null;
    closeWs(); $('#url').value = ''; $('#welcome-url').value = ''; $('#export').hidden = true; hideBanner(); closeModal();
    app.dataset.view = 'browser'; renderStatus(); renderStats(); renderList(); renderPages(); if (msg) toast(msg, 'ok');
  }
  const refreshSession = guard(async () => {
    const j = await api('GET', '/api/session');
    if (j.active) { applyHello(j); connectWs(); } else if (S.active) resetUi('The session ended. Start a new collection.');
  });
  const autoPreset = () => (innerWidth < 900 ? 'mobile' : 'desktop');
  const submitUrl = guard(async (raw) => {
    raw = raw.trim(); if (!raw) { toast('Enter a website address first.'); return; }
    hideBanner();
    if (!S.active) {
      $('#btn-open').disabled = true;
      try { const j = await api('POST', '/api/session', { url: raw, viewport: { preset: autoPreset() } }); applyHello(j); connectWs(); app.dataset.view = 'browser'; }
      finally { $('#btn-open').disabled = false; }
    } else { await api('POST', '/api/session/navigate', { url: raw }); }
  });
  $('#url-form').onsubmit = (e) => { e.preventDefault(); submitUrl($('#url').value); };
  $('#welcome-form').onsubmit = (e) => { e.preventDefault(); $('#url').value = $('#welcome-url').value; submitUrl($('#welcome-url').value); };
  const act = (name, body) => guard(() => api('POST', '/api/session/' + name, body));
  $('#btn-back').onclick = act('back'); $('#btn-fwd').onclick = act('forward'); $('#btn-reload').onclick = act('reload'); $('#btn-home').onclick = act('home'); $('#btn-stop').onclick = act('stop');
  $('#btn-scan').onclick = act('scan');
  $('#btn-finish').onclick = guard(async () => { $('#btn-finish').disabled = true; try { const j = await api('POST', '/api/session/finish'); S.session = j.session; renderStatus(); toast('Collection completed. Download the ZIP when ready.', 'ok'); } finally { renderStatus(); } });
  $('#sw-collector').onchange = guard(async (e) => { try { const j = await api('POST', '/api/session/collector', { on: e.target.checked }); S.session = j.session; } finally { renderStatus(); } });
  $$('[data-vp]').forEach((b) => (b.onclick = guard(async () => { const j = await api('POST', '/api/session/viewport', { preset: b.dataset.vp }); S.session = j.session; S.vw = j.session.browser.viewport.width; S.vh = j.session.browser.viewport.height; renderStatus(); })));
  $('#vp-form').onsubmit = guard(async (e) => { e.preventDefault(); const j = await api('POST', '/api/session/viewport', { width: +$('#vp-w').value, height: +$('#vp-h').value }); S.session = j.session; S.vw = j.session.browser.viewport.width; S.vh = j.session.browser.viewport.height; renderStatus(); });
  $('#btn-full').onclick = () => { const w = $('#stage-wrap'); if (document.fullscreenElement) document.exitFullscreen(); else if (w.requestFullscreen) w.requestFullscreen().catch(() => toast('Fullscreen is not available in this browser.')); };
  $('#btn-side').onclick = () => { app.dataset.side = app.dataset.side === 'open' ? 'closed' : 'open'; layout(); };
  $('#btn-more').onclick = () => $('#actions').classList.toggle('as-pop');
  document.addEventListener('click', (e) => { if (!e.target.closest('#actions') && !e.target.closest('#btn-more')) $('#actions').classList.remove('as-pop'); if (!e.target.closest('.dl-wrap')) $('#dl-menu').hidden = true; });
  $$('#bottomnav button').forEach((b) => (b.onclick = () => { app.dataset.view = b.dataset.view; $$('#bottomnav button').forEach((x) => x.classList.toggle('on', x === b)); layout(); }));
  $('#side-close').onclick = () => { app.dataset.view = 'browser'; $$('#bottomnav button').forEach((x) => x.classList.toggle('on', x.dataset.view === 'browser')); layout(); };

  // ---------- replace / new ----------
  function confirmModal({ title, body, ok, danger, onOk }) {
    openModal(`<div class="m-head"><h3>${esc(title)}</h3></div><div class="m-body">${body}</div><div class="m-foot"><button class="btn" id="m-cancel">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="m-ok">${esc(ok)}</button></div>`, true);
    $('#m-cancel').onclick = closeModal; $('#m-ok').onclick = async () => { $('#m-ok').disabled = true; try { await onOk(); } finally { closeModal(); } };
  }
  const newCollection = () => {
    if (!S.active) return;
    const dl = S.session && S.session.downloads > 0;
    confirmModal({
      title: 'Replace / New Collection', danger: true, ok: 'Delete and start fresh',
      body: `<p>This will <b>stop the remote browser</b> and <b>permanently delete</b> everything collected from <code>${esc((S.session.startUrl || '').slice(0, 80))}</code> (${num(S.stats ? S.stats.files : 0)} files, ${fmt(S.stats ? S.stats.bytes : 0)}), clear all statistics and the website address.</p><p class="muted">${dl ? 'A download is still running — wait for it to finish first.' : 'Download the ZIP first if you want to keep it. This cannot be undone.'}</p>`,
      onOk: async () => { try { await api('DELETE', '/api/session'); resetUi('Previous collection deleted. Enter a new website address.'); setTimeout(() => $('#welcome-url').focus(), 50); } catch (e) { toast(e.message, 'err', 7000); } },
    });
  };
  $('#btn-new').onclick = newCollection; $('#m-new').onclick = newCollection;

  // ---------- downloads ----------
  function exportZip(scope, extra = {}) {
    if (!S.active) return;
    const f = document.createElement('form'); f.method = 'POST'; f.action = '/api/export'; f.target = 'dlframe'; f.hidden = true;
    const add = (k, v) => { const i = document.createElement('input'); i.name = k; i.value = v; f.append(i); };
    add('scope', scope); add('reconstructed', $('#chk-recon').checked ? '1' : '0');
    if (scope === 'selected') add('ids', JSON.stringify([...S.selected]));
    if (extra.pageId) add('pageId', extra.pageId);
    document.body.append(f); f.submit(); f.remove();
    toast('Preparing ZIP…');
  }
  $('#btn-zip').onclick = () => exportZip('all');
  $('#m-zip').onclick = () => exportZip('all');
  $('#btn-zip-menu').onclick = (e) => { e.stopPropagation(); $('#dl-menu').hidden = !$('#dl-menu').hidden; };
  $$('#dl-menu button[data-scope]').forEach((b) => (b.onclick = () => { $('#dl-menu').hidden = true; if (b.dataset.scope === 'selected' && !S.selected.size) return toast('Select files in the Files tab first.'); exportZip(b.dataset.scope); }));
  $$('.grid-btns [data-scope]').forEach((b) => (b.onclick = () => exportZip(b.dataset.scope)));
  function onExport(m) {
    const box = $('#export'); S.exporting = m.id;
    if (m.state === 'running') { box.hidden = false; const pct = m.filesTotal ? Math.round((m.filesDone / m.filesTotal) * 100) : 0; $('#export-bar').style.width = pct + '%'; $('#export-text').textContent = `Building ZIP: ${m.filesDone}/${m.filesTotal} files · ${fmt(m.bytes)}`; }
    else if (m.state === 'done') { $('#export-bar').style.width = '100%'; $('#export-text').textContent = `ZIP ready: ${m.filesTotal} files · ${fmt(m.bytes)}`; toast('ZIP download complete.', 'ok'); setTimeout(() => { if (S.exporting === m.id) box.hidden = true; }, 6000); }
    else if (m.state === 'aborted') { box.hidden = true; toast('Download was interrupted. You can retry — the collection is intact.', 'err'); }
    else if (m.state === 'error') { box.hidden = true; toast((m.error && m.error.message) || 'ZIP generation failed.', 'err', 8000); }
  }

  // ---------- websocket ----------
  function connectWs() {
    if (S.ws && S.ws.readyState <= 1) return; S.closingWs = false;
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); ws.binaryType = 'arraybuffer'; S.ws = ws;
    ws.onopen = () => { S.wsTry = 0; if (!$('#banner').classList.contains('info')) { /* keep other banners */ } else hideBanner(); };
    ws.onmessage = (ev) => { if (ev.data instanceof ArrayBuffer) return onFrame(ev.data); let m; try { m = JSON.parse(ev.data); } catch { return; } onMsg(m); };
    ws.onclose = (ev) => {
      if (S.closingWs || ev.code === 4000) return;
      if (!S.active) return;
      showBanner('Connection lost. Reconnecting…', { info: true });
      const wait = Math.min(8000, 500 * 2 ** S.wsTry++); setTimeout(async () => { if (!S.active) return; try { const j = await api('GET', '/api/session'); if (!j.active) return resetUi('The session expired or was closed.'); applyHello(j); connectWs(); } catch { S.ws = null; ws.onclose({ code: 1006 }); } }, wait);
    };
  }
  function closeWs() { S.closingWs = true; if (S.ws) { try { S.ws.close(); } catch { /* ignore */ } } S.ws = null; }
  let listTimer = null;
  function onMsg(m) {
    switch (m.type) {
      case 'hello': S.session = m.state; S.stats = m.stats; if (!$('#banner').hidden && $('#banner').classList.contains('info')) hideBanner(); renderStatus(); renderStats(); break;
      case 'state': S.session = m.state; if (m.state.browser) { S.vw = m.state.browser.viewport.width; S.vh = m.state.browser.viewport.height; } renderStatus(); break;
      case 'stats': S.stats = m.stats; renderStats(); renderStatus(); break;
      case 'resource': case 'resource-updated': clearTimeout(listTimer); listTimer = setTimeout(refreshAll, 500); break;
      case 'pages': clearTimeout(listTimer); listTimer = setTimeout(refreshAll, 500); break;
      case 'error': showError(m.error); if (m.error.code === 'STORAGE_FULL') toast(m.error.message, 'err', 9000); break;
      case 'export': onExport(m); break;
      default: break;
    }
  }
  setInterval(() => { if (S.ws && S.ws.readyState === 1) S.ws.send('{"t":"ping"}'); }, 25000);

  // ---------- remote screen ----------
  const canvas = $('#screen'); const ctx = canvas.getContext('2d'); let decoding = false; let pendingFrame = null;
  async function onFrame(buf) {
    pendingFrame = buf; if (decoding) return; decoding = true;
    while (pendingFrame) {
      const b = pendingFrame; pendingFrame = null;
      try { const bmp = await createImageBitmap(new Blob([b], { type: 'image/jpeg' })); if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height; } ctx.drawImage(bmp, 0, 0); bmp.close(); } catch { /* skip bad frame */ }
    }
    decoding = false;
  }
  function layout() {
    const stage = $('#stage'); if (!stage || $('#frame').hidden) return;
    const w = stage.clientWidth - 2, h = stage.clientHeight - 2; if (w <= 0 || h <= 0) return;
    const sc = Math.min(w / S.vw, h / S.vh, 1);
    $('#frame').style.width = Math.floor(S.vw * sc) + 'px'; $('#frame').style.height = Math.floor(S.vh * sc) + 'px';
  }
  new ResizeObserver(layout).observe($('#stage')); addEventListener('resize', layout); document.addEventListener('fullscreenchange', () => setTimeout(layout, 50));
  const send = (o) => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); };
  const pt = (e) => { const r = canvas.getBoundingClientRect(); return { x: Math.round(((e.clientX - r.left) * S.vw) / r.width), y: Math.round(((e.clientY - r.top) * S.vh) / r.height) }; };
  const BTN = ['left', 'middle', 'right']; let touch = null; let moveRaf = 0; let lastMove = null; const kbd = $('#kbd-input');
  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    if (e.pointerType === 'touch') { touch = { x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, p: pt(e) }; return; }
    kbd.focus({ preventScroll: true }); send({ t: 'down', ...pt(e), button: BTN[e.button] || 'left' });
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') {
      if (!touch) return; const r = canvas.getBoundingClientRect(); const k = S.vw / r.width;
      if (Math.hypot(e.clientX - touch.x0, e.clientY - touch.y0) > 8) touch.moved = true;
      if (touch.moved) { send({ t: 'wheel', ...touch.p, dx: (touch.lx - e.clientX) * k, dy: (touch.ly - e.clientY) * k }); }
      touch.lx = e.clientX; touch.ly = e.clientY; return;
    }
    lastMove = pt(e); if (!moveRaf) moveRaf = requestAnimationFrame(() => { moveRaf = 0; send({ t: 'move', ...lastMove }); });
  });
  canvas.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'touch') { if (touch && !touch.moved) send({ t: 'click', ...touch.p, button: 'left' }); touch = null; return; }
    send({ t: 'up', ...pt(e), button: BTN[e.button] || 'left' });
  });
  canvas.addEventListener('pointercancel', () => { touch = null; });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 600 : 1; send({ t: 'wheel', ...pt(e), dx: e.deltaX * k, dy: e.deltaY * k }); }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  $('#btn-kbd').onclick = () => { kbd.focus(); };
  const MODS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Dead', 'Process']);
  kbd.addEventListener('keydown', (e) => {
    if (MODS.has(e.key) || e.key === 'Unidentified') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return; // handled by paste event
    e.preventDefault(); let k = e.key;
    if (e.ctrlKey || e.metaKey || e.altKey) k = [e.ctrlKey ? 'Control' : '', e.metaKey ? 'Meta' : '', e.altKey ? 'Alt' : '', e.key.length === 1 ? e.key.toLowerCase() : e.key].filter(Boolean).join('+');
    send({ t: 'key', key: k });
  });
  kbd.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'insertText' && e.data) { e.preventDefault(); send({ t: 'text', text: e.data }); }
    else if (e.inputType === 'deleteContentBackward') { e.preventDefault(); send({ t: 'key', key: 'Backspace' }); }
    else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') { e.preventDefault(); send({ t: 'key', key: 'Enter' }); }
  });
  kbd.addEventListener('paste', (e) => { e.preventDefault(); const t = e.clipboardData && e.clipboardData.getData('text'); if (t) send({ t: 'text', text: t }); });
  kbd.addEventListener('input', () => { kbd.value = ''; });

  // ---------- resource list ----------
  const ICON = { html: 'HTML', css: 'CSS', js: 'JS', images: 'IMG', fonts: 'FONT', other: 'FILE', screenshots: 'SHOT' };
  async function loadList(append) {
    if (!S.active) return;
    const type = S.tab === 'images' ? 'images' : S.type; const size = 50;
    const page = append ? S.page + 1 : 1; const want = append ? size : Math.min(200, Math.max(size, S.items.length));
    const j = await api('GET', `/api/resources?type=${type}&q=${encodeURIComponent(S.q)}&page=${append ? page : 1}&pageSize=${want}`);
    if (append) { S.items = S.items.concat(j.items); S.page = page; } else { S.items = j.items; S.page = Math.max(1, Math.ceil(j.items.length / size)); }
    S.total = j.total; renderList();
  }
  async function loadPages() { if (!S.active) return; const j = await api('GET', '/api/pages'); S.pages = j.pages; renderPages(); }
  const refreshAll = () => { if (!S.active) return; loadList(false).catch(() => {}); loadPages().catch(() => {}); };
  function renderList() {
    const list = $('#list'); const grid = S.tab === 'images'; list.classList.toggle('grid', grid);
    list.hidden = S.tab === 'pages'; $('#pages').hidden = S.tab !== 'pages'; $('#side-tools').hidden = S.tab === 'pages'; $('#chips').hidden = grid;
    $('#btn-more-files').hidden = S.tab === 'pages' || S.items.length >= S.total;
    $('#sel-count').textContent = `${S.selected.size} selected`;
    if (!S.items.length) { list.innerHTML = `<div class="empty">${S.active ? (S.q ? 'No files match your search.' : 'No files collected yet.') : 'Collected files appear here.'}</div>`; return; }
    list.innerHTML = grid ? S.items.map((r) => `<div class="thumb" data-id="${r.id}" role="listitem"><input type="checkbox" data-sel="${r.id}" ${S.selected.has(r.id) ? 'checked' : ''} aria-label="Select"><img loading="lazy" alt="${esc(r.filename)}" src="/api/resources/${r.id}/content"><div class="cap">${esc(r.filename)} · ${fmt(r.size)}</div></div>`).join('')
      : S.items.map((r) => `<div class="row-item" data-id="${r.id}" role="listitem"><input type="checkbox" data-sel="${r.id}" ${S.selected.has(r.id) ? 'checked' : ''} aria-label="Select ${esc(r.filename)}"><div class="fi-main"><div class="fi-name" title="${esc(r.filename)}">${esc(r.filename)}</div><div class="fi-meta"><span class="tag">${ICON[r.type] || 'FILE'}</span><span>${fmt(r.size)}</span><span class="badge-ok">✓ ${esc(r.status)}</span>${r.httpStatus ? `<span>HTTP ${r.httpStatus}</span>` : ''}${r.kind !== 'network' ? `<span>${esc(r.kind)}</span>` : ''}</div><div class="fi-url" title="${esc(r.url)}">${esc(r.url)}</div></div><div class="fi-act"><button class="ib sm" data-view="${r.id}" title="Preview" aria-label="Preview"><svg><use href="#i-eye"/></svg></button><button class="ib sm" data-dl="${r.id}" title="Download" aria-label="Download"><svg><use href="#i-dl"/></svg></button></div></div>`).join('');
  }
  $('#list').addEventListener('click', (e) => {
    const sel = e.target.closest('[data-sel]'); if (sel) { sel.checked ? S.selected.add(sel.dataset.sel) : S.selected.delete(sel.dataset.sel); $('#sel-count').textContent = `${S.selected.size} selected`; $('#dl-selected').disabled = !S.selected.size; return; }
    const dl = e.target.closest('[data-dl]'); if (dl) { dlFile(dl.dataset.dl); return; }
    const row = e.target.closest('[data-id]'); if (row) openViewer(S.items.find((r) => r.id === row.dataset.id));
  });
  $('#sel-all').onchange = (e) => { for (const r of S.items) e.target.checked ? S.selected.add(r.id) : S.selected.delete(r.id); renderList(); $('#dl-selected').disabled = !S.selected.size; };
  $('#sel-clear').onclick = () => { S.selected.clear(); $('#sel-all').checked = false; renderList(); $('#dl-selected').disabled = true; };
  const dlFile = (id) => { const a = document.createElement('a'); a.href = `/api/resources/${id}/download`; a.target = 'dlframe'; document.body.append(a); a.click(); a.remove(); };
  $('#chips').addEventListener('click', (e) => { const b = e.target.closest('[data-type]'); if (!b) return; S.type = b.dataset.type; $$('#chips button').forEach((x) => x.classList.toggle('on', x === b)); loadList(false).catch(showError); });
  let qT; $('#q').oninput = (e) => { clearTimeout(qT); qT = setTimeout(() => { S.q = e.target.value.trim(); loadList(false).catch(showError); }, 250); };
  $('#btn-more-files').onclick = () => loadList(true).catch(showError);
  $$('.tabs button').forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b)); S.items = []; renderList(); S.tab === 'pages' ? loadPages().catch(showError) : loadList(false).catch(showError); }));

  function renderPages() {
    const box = $('#pages');
    if (!S.pages.length) { box.innerHTML = '<div class="empty">Pages you visit appear here.</div>'; return; }
    box.innerHTML = S.pages.map((p) => `<div class="page-item"><div class="t">${esc(p.title || '(untitled)')}</div><div class="u">${esc(p.url)}</div><div class="act"><span class="st ${esc(p.status)}">${esc(p.status)}</span><span class="muted">${num(p.files)} files</span><button class="btn sm" data-snap="${p.id}">View snapshot</button><button class="btn sm" data-pdl="${p.id}">Download page</button></div>${p.error ? `<div class="u">${esc(p.error)}</div>` : ''}</div>`).join('');
  }
  $('#pages').addEventListener('click', guard(async (e) => {
    const s = e.target.closest('[data-snap]'); const d = e.target.closest('[data-pdl]');
    if (d) return exportZip('page', { pageId: d.dataset.pdl });
    if (s) { const j = await api('GET', `/api/resources?type=html&pageId=${s.dataset.snap}&pageSize=200`); const snaps = j.items.filter((r) => r.kind === 'snapshot'); const pick = snaps[0] || j.items[0]; if (!pick) return toast('No snapshot saved for this page yet.'); openViewer(pick); }
  }));

  // ---------- modal / viewer ----------
  function openModal(html, small) { $('#modal').className = 'modal' + (small ? ' small' : ''); $('#modal').innerHTML = html; $('#modal-bg').hidden = false; }
  function closeModal() { $('#modal-bg').hidden = true; $('#modal').innerHTML = ''; }
  $('#modal-bg').addEventListener('mousedown', (e) => { if (e.target === $('#modal-bg')) closeModal(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal-bg').hidden) closeModal(); });

  const RULES = {
    js: [['\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/', 'tk-c'], ['"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`', 'tk-s'], ['\\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|null|undefined|true|false|void|delete|yield|static|super)\\b', 'tk-k'], ['\\b(?:0x[0-9a-fA-F]+|\\d+\\.?\\d*(?:e[+-]?\\d+)?)\\b', 'tk-n']],
    css: [['\\/\\*[\\s\\S]*?\\*\\/', 'tk-c'], ['"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'', 'tk-s'], ['@[\\w-]+', 'tk-k'], ['[\\w-]+(?=\\s*:)', 'tk-p'], ['#[0-9a-fA-F]{3,8}\\b|-?\\d*\\.?\\d+(?:px|em|rem|%|vh|vw|s|ms|deg)?\\b', 'tk-n']],
    html: [['<!--[\\s\\S]*?-->', 'tk-c'], ['<\\/?[a-zA-Z][\\w:-]*', 'tk-t'], ['"[^"\\n]*"|\'[^\'\\n]*\'', 'tk-s'], ['\\s[\\w:-]+(?==)', 'tk-a']],
    json: [['"(?:[^"\\\\\\n]|\\\\.)*"(?=\\s*:)', 'tk-p'], ['"(?:[^"\\\\\\n]|\\\\.)*"', 'tk-s'], ['-?\\b\\d+\\.?\\d*(?:e[+-]?\\d+)?\\b', 'tk-n'], ['\\b(?:true|false|null)\\b', 'tk-k']],
  };
  const COMPILED = {}; for (const [k, r] of Object.entries(RULES)) COMPILED[k] = [new RegExp(r.map((x) => `(${x[0]})`).join('|'), 'g'), r.map((x) => x[1])];
  function highlight(text, lang) {
    const c = COMPILED[lang]; if (!c) return esc(text);
    const [re, cls] = c; re.lastIndex = 0; let out = ''; let last = 0; let m;
    while ((m = re.exec(text))) {
      if (m.index > last) out += esc(text.slice(last, m.index));
      let i = 1; while (i < m.length && m[i] === undefined) i++;
      out += `<span class="${cls[i - 1]}">${esc(m[0])}</span>`; last = re.lastIndex; if (m[0].length === 0) re.lastIndex++;
    }
    return out + esc(text.slice(last));
  }
  const langOf = (r) => (r.type === 'html' ? 'html' : r.type === 'css' ? 'css' : r.type === 'js' ? 'js' : /json/.test(r.mime) || r.ext === 'map' ? 'json' : r.ext === 'svg' ? 'html' : null);
  const isText = (r) => ['html', 'css', 'js'].includes(r.type) || /json|text\/|xml|svg/.test(r.mime);

  async function openViewer(r) {
    if (!r) return;
    const text = isText(r); const img = r.type === 'images' || r.type === 'screenshots'; const font = r.type === 'fonts';
    openModal(`<div class="m-head"><h3 title="${esc(r.filename)}">${esc(r.filename)}</h3><span class="tag">${esc(r.type)}</span><button class="ib" id="v-close" aria-label="Close"><svg><use href="#i-x"/></svg></button></div>
      <div class="m-body"><div class="m-sub">${esc(r.url)}<br>${fmt(r.size)} · ${esc(r.mime)} · sha256 ${esc(r.sha256.slice(0, 16))}… · ${esc(r.collectedAt)}</div>
      <div class="tabs" id="v-tabs" ${(r.type === 'html' && r.kind !== 'screenshot') || r.ext === 'svg' ? '' : 'hidden'}><button class="on" data-m="code">Code</button><button data-m="render">${r.type === 'html' ? 'Rendered (sandboxed, no scripts)' : 'Preview'}</button></div>
      <div id="v-body"><div class="empty">Loading…</div></div></div>
      <div class="m-foot">${text ? '<button class="btn" id="v-copy"><svg><use href="#i-copy"/></svg>Copy contents</button>' : ''}<button class="btn" id="v-dl"><svg><use href="#i-dl"/></svg>Download</button><button class="btn primary" id="v-ok">Close</button></div>`);
    $('#v-close').onclick = closeModal; $('#v-ok').onclick = closeModal; $('#v-dl').onclick = () => dlFile(r.id);
    const body = $('#v-body'); let fullText = null; let truncated = false;
    const showCode = async () => {
      body.innerHTML = '<div class="empty">Loading…</div>';
      try {
        const res = await fetch(`/api/resources/${r.id}/content?max=300000`, { credentials: 'same-origin' }); truncated = res.headers.get('x-truncated') === '1'; fullText = await res.text();
        const pre = el('<pre class="code"></pre>'); pre.innerHTML = highlight(fullText, langOf(r)); body.innerHTML = ''; body.append(pre);
        if (truncated) body.append(el(`<p class="muted">Showing the first 300 KB of ${fmt(r.size)}. Use Download or Copy for the full file.</p>`));
      } catch { body.innerHTML = '<div class="empty">Could not load this file.</div>'; }
    };
    const showImg = () => { body.innerHTML = ''; const i = el('<img class="prev-img" alt="">'); i.src = `/api/resources/${r.id}/content`; i.alt = r.filename; body.append(i); };
    const showRender = () => { body.innerHTML = ''; if (r.type === 'html') { const f = el('<iframe class="render" sandbox="" title="Snapshot"></iframe>'); f.src = `/api/resources/${r.id}/render`; body.append(f); } else showImg(); };
    if (text) await showCode(); else if (img) showImg();
    else if (font) {
      body.innerHTML = '<div class="empty">Loading font…</div>';
      try { const ff = new FontFace('wcprev' + r.id, `url(/api/resources/${r.id}/content)`); await ff.load(); document.fonts.add(ff); body.innerHTML = ''; const d = el('<div class="font-prev"></div>'); d.style.fontFamily = `wcprev${r.id}`; d.style.fontSize = '28px'; d.style.lineHeight = '1.4'; d.textContent = 'The quick brown fox jumps over the lazy dog 0123456789'; body.append(d); }
      catch { body.innerHTML = '<div class="empty">Font preview is not available for this file. Use Download.</div>'; }
    } else body.innerHTML = '<div class="empty">No preview for this file type. Use Download.</div>';
    $$('#v-tabs button').forEach((b) => (b.onclick = () => { $$('#v-tabs button').forEach((x) => x.classList.toggle('on', x === b)); b.dataset.m === 'code' ? showCode() : showRender(); }));
    const cp = $('#v-copy');
    if (cp) cp.onclick = async () => {
      try { let t = fullText; if (truncated || t === null) t = await (await fetch(`/api/resources/${r.id}/content?max=4194304`, { credentials: 'same-origin' })).text(); await navigator.clipboard.writeText(t); toast('Copied to clipboard.', 'ok'); }
      catch { toast('Copy was blocked by the browser. Use Download instead.', 'err'); }
    };
  }

  async function openFailures() {
    try {
      const j = await api('GET', '/api/failures');
      openModal(`<div class="m-head"><h3>Failed requests (${j.failures.length})</h3><button class="ib" id="f-x" aria-label="Close"><svg><use href="#i-x"/></svg></button></div><div class="m-body">${j.failures.length ? j.failures.map((f) => `<div class="fail-row"><b>${esc(f.reason)}</b> — ${esc(f.url)}</div>`).join('') : '<div class="empty">No failed requests.</div>'}</div><div class="m-foot"><button class="btn" id="f-retry">Retry retryable</button><button class="btn primary" id="f-ok">Close</button></div>`);
      $('#f-x').onclick = closeModal; $('#f-ok').onclick = closeModal;
      $('#f-retry').onclick = guard(async () => { const r = await api('POST', '/api/session/retry-failures'); toast(`Retried ${r.attempted}, recovered ${r.recovered}.`, r.recovered ? 'ok' : ''); closeModal(); });
    } catch (e) { showError(e); }
  }

  // ---------- boot ----------
  renderStatus(); renderStats(); renderList(); renderPages();
  refreshSession();
  addEventListener('online', () => { if (S.active) refreshSession(); });
})();
