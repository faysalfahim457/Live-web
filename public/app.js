// WebCollector Frontend Engine - Touch, Click & Auto-sync Enabled
(function () {
  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  let ws = null;

  // DOM Elements
  const screen = document.getElementById('screen');
  const ctx = screen.getContext('2d');
  const frameWrap = document.getElementById('frame');
  const welcome = document.getElementById('welcome');
  const urlForm = document.getElementById('url-form');
  const urlInput = document.getElementById('url');
  const welcomeForm = document.getElementById('welcome-form');
  const welcomeInput = document.getElementById('welcome-url');
  const statusPill = document.getElementById('status-pill');
  const statusText = document.getElementById('status-text');
  const sbUrl = document.getElementById('sb-url');
  const sbState = document.getElementById('sb-state');
  const bnCount = document.getElementById('bn-count');
  const btnKbd = document.getElementById('btn-kbd');
  const kbdInput = document.getElementById('kbd-input');
  const btnBack = document.getElementById('btn-back');
  const btnFwd = document.getElementById('btn-fwd');
  const btnReload = document.getElementById('btn-reload');
  const btnNew = document.getElementById('btn-new');
  const fileList = document.getElementById('list');

  let resourceCount = 0;
  const currentImage = new Image();

  function connectSocket() {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setStatus('ready', 'Connected & Ready');
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);

        // লাইভ স্ক্রিন ফ্রেম রেন্ডার
        if (msg.type === 'frame') {
          welcome.hidden = true;
          frameWrap.hidden = false;
          if (btnKbd) btnKbd.hidden = false;

          currentImage.onload = () => {
            if (screen.width !== currentImage.width || screen.height !== currentImage.height) {
              screen.width = currentImage.width;
              screen.height = currentImage.height;
            }
            ctx.drawImage(currentImage, 0, 0);
          };
          currentImage.src = 'data:image/jpeg;base64,' + msg.data;
        }

        // স্ট্যাটাস ও কালেকশন আপডেট
        if (msg.type === 'status' || msg.type === 'navigated') {
          if (msg.url) {
            urlInput.value = msg.url;
            sbUrl.textContent = msg.url;
          }
          if (msg.state) setStatus(msg.state, msg.state === 'collecting' ? 'Collecting' : 'Ready');
          if (msg.count !== undefined) updateCount(msg.count);
        }

        // নতুন ফাইল যুক্ত হওয়া
        if (msg.type === 'resource_collected') {
          updateCount(msg.count);
          appendFileRow(msg.resource);
        }
      } catch (err) {}
    };

    ws.onclose = () => {
      setStatus('terminated', 'Disconnected. Retrying...');
      setTimeout(connectSocket, 2000);
    };
  }

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function setStatus(state, text) {
    statusPill.setAttribute('data-s', state);
    statusText.textContent = text;
    sbState.textContent = text;
  }

  function updateCount(c) {
    resourceCount = c;
    if (bnCount) bnCount.textContent = c > 0 ? c : '';
  }

  function appendFileRow(res) {
    if (!fileList) return;
    const row = document.createElement('div');
    row.className = 'row-item';
    row.innerHTML = `
      <span class="tag">${res.type}</span>
      <div class="fi-main">
        <div class="fi-name">${res.path}</div>
        <div class="fi-url">${res.url}</div>
      </div>
      <span class="fi-meta">${Math.round(res.size / 1024)} KB</span>
    `;
    fileList.prepend(row);
  }

  // --- স্পর্শ, স্ক্রোল ও ক্লিক হ্যান্ডলিং (মোবাইলের জন্য সম্পূর্ণ ঠিক করা) ---

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

  // মোবাইল টাচ শুরু
  screen.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      touchStartX = t.clientX;
      touchStartY = t.clientY;
      touchStartTime = Date.now();
      isScrolling = false;
    }
  }, { passive: true });

  // মোবাইল স্ক্রোল (Drag to scroll)
  screen.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      const deltaX = touchStartX - t.clientX;
      const deltaY = touchStartY - t.clientY;

      if (Math.abs(deltaY) > 6 || Math.abs(deltaX) > 6) {
        isScrolling = true;
        const coords = getCanvasCoords(t.clientX, t.clientY);

        // ব্রাউজারে হুইল স্ক্রোল পাঠানো
        send({
          type: 'wheel',
          x: coords.x,
          y: coords.y,
          deltaX: deltaX * 1.8,
          deltaY: deltaY * 1.8
        });

        touchStartX = t.clientX;
        touchStartY = t.clientY;
      }
    }
  }, { passive: true });

  // স্পর্শ শেষ হলে ক্লিক হিসেবে গণ্য করা (যদি স্ক্রোল না করে থাকে)
  screen.addEventListener('touchend', (e) => {
    const duration = Date.now() - touchStartTime;
    if (!isScrolling && duration < 350) {
      // এটি একটি খাঁটি ক্লিক/ট্যাপ
      const coords = getCanvasCoords(touchStartX, touchStartY);

      send({ type: 'mouse', event: 'mousedown', x: coords.x, y: coords.y });
      setTimeout(() => {
        send({ type: 'mouse', event: 'mouseup', x: coords.x, y: coords.y });
      }, 50);
    }
    isScrolling = false;
  });

  // ডেস্কটপ মাউস সাপোর্ট
  screen.addEventListener('mousedown', (e) => {
    const c = getCanvasCoords(e.clientX, e.clientY);
    send({ type: 'mouse', event: 'mousedown', x: c.x, y: c.y });
  });

  screen.addEventListener('mouseup', (e) => {
    const c = getCanvasCoords(e.clientX, e.clientY);
    send({ type: 'mouse', event: 'mouseup', x: c.x, y: c.y });
  });

  screen.addEventListener('wheel', (e) => {
    e.preventDefault();
    const c = getCanvasCoords(e.clientX, e.clientY);
    send({ type: 'wheel', x: c.x, y: c.y, deltaX: e.deltaX, deltaY: e.deltaY });
  }, { passive: false });

  // কিবোর্ড সাপোর্ট
  if (btnKbd && kbdInput) {
    btnKbd.addEventListener('click', () => {
      kbdInput.focus();
    });
    kbdInput.addEventListener('input', (e) => {
      if (kbdInput.value) {
        send({ type: 'type', text: kbdInput.value });
        kbdInput.value = '';
      }
    });
  }

  // ফর্ম সাবমিট
  function triggerNavigation(url) {
    if (!url) return;
    setStatus('collecting', 'Loading site...');
    send({ type: 'navigate', url });
  }

  urlForm.addEventListener('submit', (e) => {
    e.preventDefault();
    triggerNavigation(urlInput.value);
  });

  if (welcomeForm) {
    welcomeForm.addEventListener('submit', (e) => {
      e.preventDefault();
      triggerNavigation(welcomeInput.value);
    });
  }

  // ব্রাউজার অ্যাকশন বাটন
  btnBack.addEventListener('click', () => send({ type: 'nav_action', action: 'back' }));
  btnFwd.addEventListener('click', () => send({ type: 'nav_action', action: 'fwd' }));
  btnReload.addEventListener('click', () => send({ type: 'nav_action', action: 'reload' }));
  btnNew.addEventListener('click', () => {
    if (confirm('Are you sure you want to start a new collection?')) {
      send({ type: 'reset' });
      fileList.innerHTML = '';
      welcome.hidden = false;
      frameWrap.hidden = true;
      urlInput.value = '';
    }
  });

  connectSocket();
})();
