(function () {
  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  let ws = null;

  const app = document.getElementById('app');
  const stage = document.getElementById('stage');
  const frameWrap = document.getElementById('frame');
  const screen = document.getElementById('screen');
  const ctx = screen.getContext('2d');
  const welcome = document.getElementById('welcome');
  const urlForm = document.getElementById('url-form');
  const urlInput = document.getElementById('url');
  const statusPill = document.getElementById('status-pill');
  const statusText = document.getElementById('status-text');
  const sbUrl = document.getElementById('sb-url');
  const sbState = document.getElementById('sb-state');
  const bnCount = document.getElementById('bn-count');
  const fileList = document.getElementById('list');
  const qInput = document.getElementById('q');
  const chips = document.getElementById('chips');
  const dlSum = document.getElementById('dl-sum');

  const btnKbd = document.getElementById('btn-kbd');
  const kbdInput = document.getElementById('kbd-input');
  const btnBack = document.getElementById('btn-back');
  const btnFwd = document.getElementById('btn-fwd');
  const btnReload = document.getElementById('btn-reload');
  const btnNew = document.getElementById('btn-new');
  const mNew = document.getElementById('m-new');
  const btnScan = document.getElementById('btn-scan');
  const btnZip = document.getElementById('btn-zip');
  const mZip = document.getElementById('m-zip');

  let activeFilter = 'all';
  const collectedFiles = [];
  const currentImage = new Image();

  // ১. ভিউ সুইচ (Browser / Files / Downloads)
  const bottomNavButtons = document.querySelectorAll('#bottomnav button');
  bottomNavButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.getAttribute('data-view');
      switchView(view);
    });
  });

  function switchView(view) {
    app.setAttribute('data-view', view);
    bottomNavButtons.forEach(b => {
      b.classList.toggle('on', b.getAttribute('data-view') === view);
    });
    if (view === 'files') renderFiles();
    if (view === 'downloads') updateDownloadStats();
  }

  // ২. লাইভ স্ক্রিনকাস্ট ও সকেট কানেকশন
  function connect() {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => setStatus('ready', 'Connected & Ready');

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);

        if (msg.type === 'frame') {
          welcome.hidden = true;
          frameWrap.hidden = false;
          if (btnKbd) btnKbd.hidden = false;

          currentImage.onload = () => {
            const w = currentImage.width || 390;
            const h = currentImage.height || 844;

            if (screen.width !== w || screen.height !== h) {
              screen.width = w;
              screen.height = h;
            }

            const maxW = stage.clientWidth - 12;
            const maxH = stage.clientHeight - 12;
            const scale = Math.min(maxW / w, maxH / h, 1);
            frameWrap.style.width = Math.round(w * scale) + 'px';
            frameWrap.style.height = Math.round(h * scale) + 'px';

            ctx.drawImage(currentImage, 0, 0);
          };
          currentImage.src = 'data:image/jpeg;base64,' + msg.data;
        }

        if (msg.type === 'status' || msg.type === 'navigated') {
          if (msg.url && msg.url !== 'about:blank') {
            urlInput.value = msg.url;
            sbUrl.textContent = msg.url;
          }
          if (msg.state) setStatus(msg.state, msg.state === 'collecting' ? 'Collecting' : 'Ready');
          if (msg.count !== undefined) updateBadge(msg.count);
        }

        if (msg.type === 'resource_collected') {
          collectedFiles.unshift(msg.resource);
          updateBadge(msg.count);
          if (app.getAttribute('data-view') === 'files') renderFiles();
        }
      } catch (err) {}
    };

    ws.onclose = () => {
      setStatus('terminated', 'Reconnecting...');
      setTimeout(connect, 2000);
    };
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function setStatus(state, txt) {
    statusPill.setAttribute('data-s', state);
    statusText.textContent = txt;
    sbState.textContent = txt;
  }

  function updateBadge(c) {
    if (bnCount) bnCount.textContent = c > 0 ? c : '';
  }

  // ৩. ফাইল তালিকা রেন্ডার
  function renderFiles() {
    if (!fileList) return;
    const q = (qInput.value || '').toLowerCase();
    const filtered = collectedFiles.filter(f => {
      const matchType = activeFilter === 'all' || f.type === activeFilter;
      const matchQuery = !q || f.path.toLowerCase().includes(q) || f.url.toLowerCase().includes(q);
      return matchType && matchQuery;
    });

    if (filtered.length === 0) {
      fileList.innerHTML = '<div class="empty">No files collected yet.</div>';
      return;
    }

    fileList.innerHTML = filtered.map(f => `
      <div class="row-item">
        <span class="tag">${f.type}</span>
        <div class="fi-main">
          <div class="fi-name">${f.path}</div>
          <div class="fi-url">${f.url}</div>
        </div>
        <span class="fi-meta">${Math.round(f.size / 1024)} KB</span>
      </div>
    `).join('');
  }

  if (chips) {
    chips.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        chips.querySelectorAll('button').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        activeFilter = btn.getAttribute('data-type');
        renderFiles();
      });
    });
  }
  if (qInput) qInput.addEventListener('input', renderFiles);

  // ৪. টাচ ও ক্লিক হ্যান্ডলার
  function getCanvasCoords(clientX, clientY) {
    const rect = screen.getBoundingClientRect();
    const scaleX = screen.width / rect.width;
    const scaleY = screen.height / rect.height;
    return {
      x: Math.round((clientX - rect.left) * scaleX),
      y: Math.round((clientY - rect.top) * scaleY)
    };
  }

  let touchStartY = 0;
  let touchStartX = 0;
  let isScrolling = false;
  let touchStartTime = 0;

  screen.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      touchStartX = t.clientX;
      touchStartY = t.clientY;
      touchStartTime = Date.now();
      isScrolling = false;
    }
  }, { passive: true });

  screen.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      const deltaX = touchStartX - t.clientX;
      const deltaY = touchStartY - t.clientY;

      if (Math.abs(deltaY) > 5 || Math.abs(deltaX) > 5) {
        isScrolling = true;
        const c = getCanvasCoords(t.clientX, t.clientY);
        send({
          type: 'wheel',
          x: c.x,
          y: c.y,
          deltaX: deltaX * 1.6,
          deltaY: deltaY * 1.6
        });
        touchStartX = t.clientX;
        touchStartY = t.clientY;
      }
    }
  }, { passive: true });

  screen.addEventListener('touchend', () => {
    const duration = Date.now() - touchStartTime;
    if (!isScrolling && duration < 350) {
      const c = getCanvasCoords(touchStartX, touchStartY);
      send({ type: 'mouse', event: 'mousedown', x: c.x, y: c.y });
      setTimeout(() => send({ type: 'mouse', event: 'mouseup', x: c.x, y: c.y }), 50);
    }
    isScrolling = false;
  });

  screen.addEventListener('mousedown', (e) => {
    const c = getCanvasCoords(e.clientX, e.clientY);
    send({ type: 'mouse', event: 'mousedown', x: c.x, y: c.y });
  });
  screen.addEventListener('mouseup', (e) => {
    const c = getCanvasCoords(e.clientX, e.clientY);
    send({ type: 'mouse', event: 'mouseup', x: c.x, y: c.y });
  });

  if (btnKbd && kbdInput) {
    btnKbd.addEventListener('click', () => kbdInput.focus());
    kbdInput.addEventListener('input', () => {
      if (kbdInput.value) {
        send({ type: 'type', text: kbdInput.value });
        kbdInput.value = '';
      }
    });
  }

  // ৫. নেভিগেশন ও অ্যাকশন
  urlForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const u = urlInput.value.trim();
    if (u && u !== 'about:blank') {
      setStatus('collecting', 'Loading site...');
      switchView('browser');
      send({ type: 'navigate', url: u });
    }
  });

  btnBack.addEventListener('click', () => send({ type: 'nav_action', action: 'back' }));
  btnFwd.addEventListener('click', () => send({ type: 'nav_action', action: 'fwd' }));
  btnReload.addEventListener('click', () => send({ type: 'nav_action', action: 'reload' }));
  if (btnScan) btnScan.addEventListener('click', () => send({ type: 'scan' }));

  function triggerDownload() {
    window.location.href = '/api/download';
  }
  if (btnZip) btnZip.addEventListener('click', triggerDownload);
  if (mZip) mZip.addEventListener('click', triggerDownload);

  function updateDownloadStats() {
    if (dlSum) dlSum.textContent = `${collectedFiles.length} files collected so far.`;
  }

  function resetAll() {
    if (confirm('Start a new collection? All current files will be cleared.')) {
      send({ type: 'reset' });
      collectedFiles.length = 0;
      updateBadge(0);
      urlInput.value = '';
      welcome.hidden = false;
      frameWrap.hidden = true;
      switchView('browser');
    }
  }
  btnNew.addEventListener('click', resetAll);
  if (mNew) mNew.addEventListener('click', resetAll);

  connect();
})();
