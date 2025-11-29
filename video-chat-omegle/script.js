// File: script.fixed.with-local-detection.js
// TL;DR: زيادة حساسية الكشف، فحص NSFW محلي (كاميرتك)، حظر ذاتي، وإرسال لقطات للسيرفر.
// Minimal essential comments only (why-critical).

window.addEventListener('DOMContentLoaded', () => {

  const socket = io();

  // ---------------------- DOM ELEMENTS ----------------------
  const notifyBell = document.getElementById('notifyIcon');
  const notifyDot = document.getElementById('notifyDot');
  const notifyMenu = document.getElementById('notifyMenu');

  const localVideo = document.getElementById('localVideo');
  const remoteVideo = document.getElementById('remoteVideo');

  const localSpinner = document.getElementById('localSpinner');
  const remoteSpinner = document.getElementById('remoteSpinner');

  const reportBtn = document.getElementById('reportBtn');
  const micBtn = document.getElementById('micBtn');

  const chatMessages = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const skipBtn = document.getElementById('skipBtn');
  const statusText = document.getElementById('status');

  const exitBtn = document.getElementById('exitBtn');

  // ---------------------- GLOBAL STATE ----------------------
  let localStream = null;
  let peerConnection = null;
  let partnerId = null;
  let isInitiator = false;

  let micEnabled = true;
  let autoReconnect = true;

  let searchTimer = null;
  let pauseTimer = null;

  const servers = { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };

  // ---------------------- HELPERS ----------------------
  function addMessage(msg, type = 'system') {
    const d = document.createElement('div');
    d.className = `msg ${type}`;
    d.textContent = msg;

    const typing = document.querySelector('.msg.system[style*="italic"]');

    if (typing && typing.parentNode === chatMessages) {
      chatMessages.insertBefore(d, typing);
    } else {
      chatMessages.appendChild(d);
    }

    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function pushAdminNotification(text) {
    const item = document.createElement('div');
    item.className = 'notify-item';
    item.textContent = text;

    notifyMenu.prepend(item);

    const empty = notifyMenu.querySelector('.notify-empty');
    if (empty) empty.remove();
  }

  function ensureNotifyEmpty() {
    if (notifyMenu.children.length === 0) {
      const d = document.createElement('div');
      d.textContent = 'No notifications';
      d.className = 'notify-empty';
      notifyMenu.appendChild(d);
    }
  }

  // ---------------------- NOTIFICATION MENU ----------------------
  notifyBell.onclick = (e) => {
    e.stopPropagation();
    if (notifyDot) notifyDot.style.display = 'none';
    notifyBell.classList.remove('shake');

    notifyMenu.style.display = notifyMenu.style.display === 'block'
      ? 'none'
      : 'block';
  };

  document.onclick = () => {
    notifyMenu.style.display = 'none';
  };

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') notifyMenu.style.display = 'none';
  });

  // ---------------------- TYPING INDICATOR ----------------------
  const typingIndicator = document.createElement('div');
  typingIndicator.className = 'msg system';
  typingIndicator.style.display = 'none';
  typingIndicator.style.fontStyle = 'italic';
  typingIndicator.textContent = 'Stranger is typing...';

  chatMessages.appendChild(typingIndicator);

  let typing = false;
  let typingTimer = null;
  const TYPING_PAUSE = 1500;

  function sendTyping() {
    if (!partnerId) return;

    if (!typing) {
      typing = true;
      socket.emit('typing', { to: partnerId });
    }

    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      typing = false;
      socket.emit('stop-typing', { to: partnerId });
    }, TYPING_PAUSE);
  }

  chatInput.oninput = () => {
    if (!chatInput.disabled) sendTyping();
  };

  // ---------------------- SEND CHAT ----------------------
  function sendMessage() {
    const msg = chatInput.value.trim();
    if (!msg || !partnerId) return;

    addMessage(msg, 'you');
    socket.emit('chat-message', { to: partnerId, message: msg });

    chatInput.value = '';
    typing = false;
    socket.emit('stop-typing', { to: partnerId });
  }

  sendBtn.onclick = sendMessage;
  chatInput.onkeypress = e => { if (e.key === 'Enter') sendMessage(); };

  // ---------------------- MIC CONTROL ----------------------
  function updateMicButton() {
    micBtn.textContent = micEnabled ? '🎤' : '🔇';
    micBtn.disabled = !localStream;
    micBtn.style.opacity = localStream ? '1' : '0.8';
  }

  micBtn.onclick = () => {
    if (!localStream) return alert('Microphone not ready yet.');

    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    updateMicButton();
  };

  // ---------------------- REPORT BUTTON — REMOVED MANUAL REPORTING ----------------------
  if (reportBtn) reportBtn.style.display = 'none';

  // ---------------------- UI ----------------------
  function enableChat() {
    chatInput.disabled = false;
    sendBtn.disabled = false;
  }

  function disableChat() {
    chatInput.disabled = true;
    sendBtn.disabled = true;
  }

  function showRemoteSpinnerOnly(show) {
    remoteSpinner.style.display = show ? 'block' : 'none';
    remoteVideo.style.display = show ? 'none' : 'block';
  }

  function hideAllSpinners() {
    remoteSpinner.style.display = 'none';
    localSpinner.style.display = 'none';
    remoteVideo.style.display = 'block';
    localVideo.style.display = 'block';
  }

  // ---------------------- DEVICE FINGERPRINT (client-side, persistent) ----------------------
  const DeviceFingerprint = (function () {
    const STORAGE_KEY_ID = 'spark_device_id_v1';
    const STORAGE_KEY_FP = 'spark_fingerprint_v1';

    function uuidv4() {
      const arr = new Uint8Array(16);
      crypto.getRandomValues(arr);
      arr[6] = (arr[6] & 0x0f) | 0x40;
      arr[8] = (arr[8] & 0x3f) | 0x80;
      const hex = [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    }

    function getStored(key) {
      try { return localStorage.getItem(key); } catch (e) { return null; }
    }
    function setStored(key, v) {
      try { localStorage.setItem(key, v); } catch (e) { /* ignore */ }
    }

    function collectAttrs() {
      const nav = navigator || {};
      const screenObj = screen || {};
      const attrs = [
        nav.userAgent || '',
        nav.language || '',
        screenObj.width || '',
        screenObj.height || '',
        screenObj.colorDepth || '',
        (new Date()).getTimezoneOffset(),
        navigator.platform || '',
        navigator.hardwareConcurrency || '',
      ];
      return attrs.join('||');
    }

    async function sha256hex(str) {
      const enc = new TextEncoder();
      const data = enc.encode(str);
      const hash = await crypto.subtle.digest('SHA-256', data);
      const b = Array.from(new Uint8Array(hash)).map(n => n.toString(16).padStart(2, '0')).join('');
      return b;
    }

    return {
      async ensure() {
        let id = getStored(STORAGE_KEY_ID);
        let fp = getStored(STORAGE_KEY_FP);
        if (!id) {
          id = uuidv4();
          setStored(STORAGE_KEY_ID, id);
        }
        if (!fp) {
          const attrs = collectAttrs() + '||' + id;
          fp = await sha256hex(attrs);
          setStored(STORAGE_KEY_FP, fp);
        }
        return { deviceId: id, fingerprint: fp };
      },
      getDeviceId() {
        return getStored(STORAGE_KEY_ID) || null;
      },
      getFingerprint() {
        return getStored(STORAGE_KEY_FP) || null;
      }
    };
  })();

  DeviceFingerprint.ensure().then(fp => {
    try {
      socket.emit('identify', { fingerprint: fp.fingerprint });
    } catch (e) { console.error('identify emit failed', e); }
  }).catch(console.error);

  // ---------------------- NSFW DETECTOR (client-side using nsfwjs + tfjs) ----------------------
  // SENSITIVITY TUNED: lower threshold -> more sensitive; faster interval; fewer consecutive required.
  const DETECT_INTERVAL_MS = 1500;  // faster checks
  const DOWNSAMPLE_WIDTH = 224;
  let PORN_THRESHOLD = 0.60;        // lowered threshold -> higher sensitivity
  let CONSECUTIVE_REQUIRED = 1;     // detect on single hit if strong
  const COOLDOWN_AFTER_REPORT_MS = 60 * 1000; // 1 min cooldown local

  const TF_CDN = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0/dist/tf.min.js';
  const NSFWJS_CDN = 'https://cdn.jsdelivr.net/npm/nsfwjs@2.4.0/dist/nsfwjs.min.js';

  let nsfwModel = null;
  let detectIntervalHandleRemote = null;
  let detectIntervalHandleLocal = null;
  let consecutiveRemoteHits = 0;
  let consecutiveLocalHits = 0;
  let lastReportTsRemote = 0;
  let lastReportTsLocal = 0;

  const detectorCanvas = document.createElement('canvas');
  detectorCanvas.style.display = 'none';
  const detectorCtx = detectorCanvas.getContext('2d');
  document.body.appendChild(detectorCanvas);

  const blockOverlay = document.createElement('div');
  blockOverlay.style.position = 'absolute';
  blockOverlay.style.display = 'none';
  blockOverlay.style.alignItems = 'center';
  blockOverlay.style.justifyContent = 'center';
  blockOverlay.style.pointerEvents = 'none';
  blockOverlay.style.zIndex = 9999;
  blockOverlay.style.background = 'rgba(0,0,0,0.7)';
  blockOverlay.style.color = '#fff';
  blockOverlay.style.fontSize = '18px';
  blockOverlay.style.fontWeight = '600';
  blockOverlay.textContent = 'تم حظر العرض: محتوى غير لائق مُكتشف';
  document.body.appendChild(blockOverlay);

  const selfBlockOverlay = document.createElement('div');
  selfBlockOverlay.style.position = 'fixed';
  selfBlockOverlay.style.display = 'none';
  selfBlockOverlay.style.left = '0';
  selfBlockOverlay.style.top = '0';
  selfBlockOverlay.style.width = '100%';
  selfBlockOverlay.style.height = '100%';
  selfBlockOverlay.style.zIndex = 10000;
  selfBlockOverlay.style.background = 'rgba(0,0,0,0.85)';
  selfBlockOverlay.style.color = '#fff';
  selfBlockOverlay.style.display = 'flex';
  selfBlockOverlay.style.alignItems = 'center';
  selfBlockOverlay.style.justifyContent = 'center';
  selfBlockOverlay.style.fontSize = '20px';
  selfBlockOverlay.style.fontWeight = '700';
  selfBlockOverlay.textContent = 'تم حظرك ذاتياً: تم اكتشاف سلوك غير لائق من جهازك. اتصل بالمشرف إذا رغبت بالاستئناف.';
  document.body.appendChild(selfBlockOverlay);

  function updateBlockOverlayPos() {
    if (!remoteVideo) return;
    const r = remoteVideo.getBoundingClientRect();
    blockOverlay.style.left = `${r.left + window.scrollX}px`;
    blockOverlay.style.top = `${r.top + window.scrollY}px`;
    blockOverlay.style.width = `${r.width}px`;
    blockOverlay.style.height = `${r.height}px`;
  }
  window.addEventListener('resize', updateBlockOverlayPos);
  window.addEventListener('scroll', updateBlockOverlayPos);
  if (remoteVideo) {
    remoteVideo.addEventListener('loadedmetadata', updateBlockOverlayPos);
    remoteVideo.addEventListener('play', updateBlockOverlayPos);
  }

  function loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`)) return res();
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => res();
      s.onerror = () => rej(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  async function loadNsfwModel() {
    if (nsfwModel) return nsfwModel;
    if (!window.tf) await loadScript(TF_CDN);
    if (!window.nsfwjs) await loadScript(NSFWJS_CDN);
    nsfwModel = await nsfwjs.load();
    return nsfwModel;
  }

  // create smaller dataURL to limit payload
  function makeThumbnailDataURL(videoEl, maxWidth = 640) {
    if (!videoEl || videoEl.videoWidth === 0) return null;
    const aspect = videoEl.videoWidth / videoEl.videoHeight;
    const w = Math.min(maxWidth, videoEl.videoWidth);
    const h = Math.round(w / aspect);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    try {
      ctx.drawImage(videoEl, 0, 0, w, h);
      return c.toDataURL('image/jpeg', 0.75); // compressed
    } catch (err) {
      console.error('thumbnail draw error', err);
      return null;
    }
  }

  async function analyzeFrameProbForVideo(videoEl) {
    if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0) return null;
    const aspect = videoEl.videoWidth / videoEl.videoHeight;
    detectorCanvas.width = DOWNSAMPLE_WIDTH;
    detectorCanvas.height = Math.round(DOWNSAMPLE_WIDTH / aspect);
    try {
      detectorCtx.drawImage(videoEl, 0, 0, detectorCanvas.width, detectorCanvas.height);
    } catch (e) {
      console.warn('drawImage failed', e);
      return null;
    }
    try {
      const preds = await nsfwModel.classify(detectorCanvas);
      let prob = 0;
      for (const p of preds) {
        const name = p.className.toLowerCase();
        if (name.includes('porn') || name.includes('hentai')) {
          prob = Math.max(prob, p.probability);
        } else if (name.includes('sexy')) {
          // sexy contributes but with weight
          prob = Math.max(prob, p.probability * 0.7);
        } else if (name.includes('neutral')) {
          // ignore neutral
        }
      }
      return prob;
    } catch (err) {
      console.error('nsfw classify error', err);
      return null;
    }
  }

  // send screenshot to server (as compressed thumbnail) with metadata
  async function sendScreenshotToServer(kind, videoEl, reason, partnerIdParam) {
    const thumb = makeThumbnailDataURL(videoEl, 640);
    if (!thumb) return;
    const { deviceId, fingerprint } = await DeviceFingerprint.ensure().catch(() => ({ deviceId: DeviceFingerprint.getDeviceId(), fingerprint: DeviceFingerprint.getFingerprint() }));
    try {
      socket.emit('reportImage', {
        kind, // 'remote' | 'self'
        fingerprint,
        deviceId,
        partnerId: partnerIdParam || null,
        reason,
        dataURL: thumb,
        ts: Date.now()
      });
    } catch (e) { console.error('emit reportImage failed', e); }
  }

  // ---------------- Remote detection handling ----------------
  async function handleAutoDetectionRemote(prob) {
    const now = Date.now();
    if (now - lastReportTsRemote < COOLDOWN_AFTER_REPORT_MS) return;
    lastReportTsRemote = now;

    blockOverlay.style.display = 'flex';
    updateBlockOverlayPos();
    if (remoteVideo) remoteVideo.style.filter = 'blur(12px)';

    // send screenshot to server
    await sendScreenshotToServer('remote', remoteVideo, 'explicit-content-auto', partnerId);

    // send requestBan for partner (server-side to ban partner)
    try {
      const { deviceId, fingerprint } = await DeviceFingerprint.ensure().catch(() => ({ deviceId: DeviceFingerprint.getDeviceId(), fingerprint: DeviceFingerprint.getFingerprint() }));
      socket.emit('requestBan', {
        partnerId,
        fingerprint,
        deviceId,
        reason: 'explicit-content-auto'
      });
      addMessage('🚨 Automatic request to ban partner sent.', 'system');
    } catch (e) { console.error('emit requestBan failed', e); }

    // local block to prevent rejoin
    try {
      localStorage.setItem('spark_local_banned_device_v1', DeviceFingerprint.getFingerprint() || ('device:' + (DeviceFingerprint.getDeviceId() || 'unknown')));
    } catch (e) { /* ignore */ }

    // teardown local connection
    try {
      if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
      }
      partnerId = null;
    } catch (e) {}

    // stop detection loop
    stopNsfwDetectionRemote();
  }

  // ---------------- Local detection handling (self-ban) ----------------
  async function handleAutoDetectionLocal(prob) {
    const now = Date.now();
    if (now - lastReportTsLocal < COOLDOWN_AFTER_REPORT_MS) return;
    lastReportTsLocal = now;

    // mark local banned (self-ban)
    try {
      const fp = DeviceFingerprint.getFingerprint() || (await DeviceFingerprint.ensure()).fingerprint;
      if (fp) localStorage.setItem('spark_local_banned_device_v1', fp);
    } catch (e) {}

    // send self-report to server with screenshot
    await sendScreenshotToServer('self', localVideo, 'self-explicit-detected', null);

    // stop media and block UI
    try {
      if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
      }
    } catch (e) {}

    updateMicButton();
    stopNsfwDetectionLocal();

    // show self block overlay
    selfBlockOverlay.style.display = 'flex';
    statusText.textContent = 'Blocked (self).';
    addMessage('تم حظرك محلياً تلقائياً بسبب سلوك غير لائق من جهازك.', 'system');

    // notify server to take any additional server-side action
    try {
      const { deviceId, fingerprint } = await DeviceFingerprint.ensure().catch(() => ({ deviceId: DeviceFingerprint.getDeviceId(), fingerprint: DeviceFingerprint.getFingerprint() }));
      socket.emit('selfBan', {
        fingerprint,
        deviceId,
        reason: 'self-explicit-detected'
      });
    } catch (e) { console.error('emit selfBan failed', e); }
  }

  async function nsfwTickRemote() {
    if (!partnerId || !remoteVideo || remoteVideo.paused || remoteVideo.readyState < 2) {
      consecutiveRemoteHits = 0;
      return;
    }
    const prob = await analyzeFrameProbForVideo(remoteVideo);
    if (prob === null) return;
    if (prob >= PORN_THRESHOLD) {
      consecutiveRemoteHits++;
    } else {
      consecutiveRemoteHits = Math.max(0, consecutiveRemoteHits - 1);
    }
    if (consecutiveRemoteHits >= CONSECUTIVE_REQUIRED) {
      await handleAutoDetectionRemote(prob);
    }
  }

  async function nsfwTickLocal() {
    if (!localVideo || localVideo.paused || localVideo.readyState < 2) {
      consecutiveLocalHits = 0;
      return;
    }
    const prob = await analyzeFrameProbForVideo(localVideo);
    if (prob === null) return;
    if (prob >= PORN_THRESHOLD) {
      consecutiveLocalHits++;
    } else {
      consecutiveLocalHits = Math.max(0, consecutiveLocalHits - 1);
    }
    if (consecutiveLocalHits >= CONSECUTIVE_REQUIRED) {
      await handleAutoDetectionLocal(prob);
    }
  }

  async function startNsfwDetectionRemote() {
    if (detectIntervalHandleRemote) return;
    try {
      await loadNsfwModel();
    } catch (e) {
      console.error('Failed to load nsfw model', e);
      return;
    }
    consecutiveRemoteHits = 0;
    detectIntervalHandleRemote = setInterval(nsfwTickRemote, DETECT_INTERVAL_MS);
  }

  function stopNsfwDetectionRemote() {
    if (detectIntervalHandleRemote) {
      clearInterval(detectIntervalHandleRemote);
      detectIntervalHandleRemote = null;
    }
    consecutiveRemoteHits = 0;
    blockOverlay.style.display = 'none';
    if (remoteVideo) remoteVideo.style.filter = '';
  }

  async function startNsfwDetectionLocal() {
    if (detectIntervalHandleLocal) return;
    try {
      await loadNsfwModel();
    } catch (e) {
      console.error('Failed to load nsfw model', e);
      return;
    }
    consecutiveLocalHits = 0;
    detectIntervalHandleLocal = setInterval(nsfwTickLocal, DETECT_INTERVAL_MS);
  }

  function stopNsfwDetectionLocal() {
    if (detectIntervalHandleLocal) {
      clearInterval(detectIntervalHandleLocal);
      detectIntervalHandleLocal = null;
    }
    consecutiveLocalHits = 0;
  }

  function stopNsfwDetection() {
    stopNsfwDetectionLocal();
    stopNsfwDetectionRemote();
  }

  // control API
  window.NSFW_DETECTOR = {
    startRemote: startNsfwDetectionRemote,
    stopRemote: stopNsfwDetectionRemote,
    startLocal: startNsfwDetectionLocal,
    stopLocal: stopNsfwDetectionLocal,
    startAll: () => { startNsfwDetectionLocal().catch(console.error); startNsfwDetectionRemote().catch(console.error); },
    stopAll: stopNsfwDetection,
    setSensitivity: (threshold, consecutive, intervalMs) => {
      if (typeof threshold === 'number') PORN_THRESHOLD = threshold;
      if (typeof consecutive === 'number') CONSECUTIVE_REQUIRED = consecutive;
      if (typeof intervalMs === 'number') {
        // restart intervals with new timing
        const wasRemote = !!detectIntervalHandleRemote;
        const wasLocal = !!detectIntervalHandleLocal;
        stopNsfwDetection();
        if (wasRemote) detectIntervalHandleRemote = setInterval(nsfwTickRemote, intervalMs);
        if (wasLocal) detectIntervalHandleLocal = setInterval(nsfwTickLocal, intervalMs);
      }
    },
    forceReport: async (note) => {
      // forces a manual report of remote with screenshot
      if (!partnerId) { addMessage('No partner to report.', 'system'); return; }
      const thumb = makeThumbnailDataURL(remoteVideo, 640);
      if (!thumb) { addMessage('Unable to capture screenshot.', 'system'); return; }
      const { deviceId, fingerprint } = await DeviceFingerprint.ensure().catch(() => ({ deviceId: DeviceFingerprint.getDeviceId(), fingerprint: DeviceFingerprint.getFingerprint() }));
      try {
        socket.emit('reportImage', {
          kind: 'remote',
          fingerprint,
          deviceId,
          partnerId,
          reason: 'manual:' + (note || ''),
          dataURL: thumb,
          ts: Date.now()
        });
        socket.emit('requestBan', {
          partnerId,
          fingerprint,
          deviceId,
          reason: 'manual:' + (note || '')
        });
        addMessage('🚨 Manual request to ban partner sent.', 'system');
      } catch (e) { console.error('emit requestBan failed', e); }
    }
  };

  // start remote detection automatically when remote plays
  if (remoteVideo) {
    remoteVideo.addEventListener('play', () => {
      const localBan = localStorage.getItem('spark_local_banned_device_v1');
      if (localBan) {
        addMessage('This device is locally banned — you are blocked from matching.', 'system');
        showRemoteSpinnerOnly(true);
        return;
      }
      setTimeout(() => { startNsfwDetectionRemote().catch(console.error); }, 300);
    });
    remoteVideo.addEventListener('pause', () => {
      stopNsfwDetectionRemote();
      remoteSpinner.style.display = 'none';
    });
  }

  // start local detection automatically when local plays
  if (localVideo) {
    localVideo.addEventListener('play', () => {
      // don't start local detection if user already locally banned
      const localBan = localStorage.getItem('spark_local_banned_device_v1');
      if (localBan) {
        addMessage('This device is locally banned — you are blocked from matching.', 'system');
        try { if (localStream) localStream.getTracks().forEach(t => t.stop()); } catch (e) {}
        selfBlockOverlay.style.display = 'flex';
        statusText.textContent = 'Blocked.';
        return;
      }
      setTimeout(() => { startNsfwDetectionLocal().catch(console.error); }, 300);
    });
    localVideo.addEventListener('pause', () => {
      stopNsfwDetectionLocal();
      localSpinner.style.display = 'none';
    });
  }

  // ---------------------- MATCHMAKING ----------------------
  function startSearchLoop() {
    if (partnerId) return;

    const localBan = localStorage.getItem('spark_local_banned_device_v1');
    if (localBan) {
      addMessage('Your device is blocked due to previous violation. Contact admin to appeal.', 'system');
      showRemoteSpinnerOnly(true);
      statusText.textContent = 'Blocked.';
      return;
    }

    showRemoteSpinnerOnly(true);
    statusText.textContent = 'Searching...';

    socket.emit('find-partner');

    searchTimer = setTimeout(() => {
      if (!partnerId) {
        try { socket.emit('stop'); } catch (e) {}
        statusText.textContent = 'Pausing...';
        pauseTimer = setTimeout(startSearchLoop, 1800);
      }
    }, 3500);
  }

  async function startSearch() {
    if (!(await initMedia())) return;

    const localBan = localStorage.getItem('spark_local_banned_device_v1');
    if (localBan) {
      addMessage('Your device is blocked due to previous violation. Contact admin to appeal.', 'system');
      showRemoteSpinnerOnly(true);
      statusText.textContent = 'Blocked.';
      return;
    }

    partnerId = null;
    isInitiator = false;

    chatMessages.innerHTML = '';
    chatMessages.appendChild(typingIndicator);

    showRemoteSpinnerOnly(true);
    skipBtn.disabled = false;

    startSearchLoop();
  }

  skipBtn.onclick = () => {
    socket.emit('skip');
    addMessage('You skipped.', 'system');
    disableChat();
    startSearchLoop();
  };

  // ---------------------- SOCKET EVENTS ----------------------
  socket.on('waiting', msg => { statusText.textContent = msg; });

  socket.on('chat-message', ({ message }) => {
    addMessage(message, 'them');
  });

  socket.on('typing', () => {
    typingIndicator.style.display = 'block';
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });

  socket.on('stop-typing', () => {
    typingIndicator.style.display = 'none';
  });

  socket.on('adminMessage', msg => {
    if (notifyDot) notifyDot.style.display = 'block';
    notifyBell.classList.add('shake');

    pushAdminNotification('📢 ' + msg);
    addMessage('📢 Admin: ' + msg, 'system');
  });

  socket.on('banned', ({ message }) => {
    addMessage(message || 'You are banned.', 'system');
    // set local ban flag for user's device fingerprint to block rejoin
    const myFp = DeviceFingerprint.getFingerprint();
    if (myFp) {
      try { localStorage.setItem('spark_local_banned_device_v1', myFp); } catch (e) {}
    }
    // block UI
    stopNsfwDetection();
    showRemoteSpinnerOnly(true);
    statusText.textContent = 'Blocked.';
  });

  socket.on('partner-disconnected', () => {
    addMessage('Disconnected.', 'system');
    disableChat();
    partnerId = null;

    if (peerConnection) peerConnection.close();
    peerConnection = null;

    stopNsfwDetection();

    startSearchLoop();
  });

  socket.on('partner-found', async data => {
    partnerId = data.id || data.partnerId;
    isInitiator = !!data.initiator;

    hideAllSpinners();
    statusText.textContent = 'Connecting...';

    createPeerConnection();

    if (isInitiator) {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit('signal', { to: partnerId, data: offer });
    }
  });

  socket.on('signal', async ({ from, data }) => {
    if (!peerConnection) createPeerConnection();

    if (data.type === 'offer') {
      await peerConnection.setRemoteDescription(data);

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      socket.emit('signal', { to: from, data: answer });

    } else if (data.type === 'answer') {
      await peerConnection.setRemoteDescription(data);

    } else if (data.candidate) {
      await peerConnection.addIceCandidate(data.candidate);
    }
  });

  socket.on('banConfirmed', ({ fingerprint, reason }) => {
    const myFp = DeviceFingerprint.getFingerprint();
    if (fingerprint && myFp && fingerprint === myFp) {
      try {
        localStorage.setItem('spark_local_banned_device_v1', fingerprint);
      } catch (e) {}
      addMessage('تم حظرك محلياً بواسطة المشرف.', 'system');
      stopNsfwDetection();
      showRemoteSpinnerOnly(true);
      statusText.textContent = 'Blocked.';
    }
  });

  // ---------------------- WEBRTC ----------------------
  function createPeerConnection() {
    peerConnection = new RTCPeerConnection(servers);

    if (localStream) {
      localStream.getTracks().forEach(t =>
        peerConnection.addTrack(t, localStream)
      );
    }

    peerConnection.ontrack = e => {
      remoteVideo.srcObject = e.streams[0];
      enableChat();
      addMessage('Connected with a stranger!', 'system');
      showRemoteSpinnerOnly(false);
    };

    peerConnection.onicecandidate = e => {
      if (e.candidate) {
        socket.emit('signal', {
          to: partnerId,
          data: { candidate: e.candidate }
        });
      }
    };

    peerConnection.onconnectionstatechange = () => {
      const s = peerConnection.connectionState;

      if (['disconnected', 'failed', 'closed'].includes(s)) {
        disableChat();
        addMessage('Connection lost.', 'system');

        partnerId = null;
        stopNsfwDetection();
        if (autoReconnect) startSearchLoop();
      }
    };
  }

  // ---------------------- EXIT ----------------------
  exitBtn.onclick = () => {
    location.href = 'index.html';
  };

  // ---------------------- MEDIA INIT ----------------------
  async function initMedia() {
    if (localStream) return true;

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });

      localVideo.srcObject = localStream;
      updateMicButton();
      return true;

    } catch (e) {
      console.error(e);
      statusText.textContent = 'Camera/Mic denied.';
      localStream = null;
      updateMicButton();
      return false;
    }
  }

  // ---------------------- AUTO START ----------------------
  ensureNotifyEmpty();
  updateMicButton();
  startSearch();

  window.onbeforeunload = () => {
    try { socket.emit('stop'); } catch (e) {}
    if (localStream) localStream.getTracks().forEach(t => t.stop());
  };

});
