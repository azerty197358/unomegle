// SPARKCHAT — script.js (FULL FIX + LTR DESIGN + MOBILE FIXES)
// FINAL VERSION WITH PERFECT REPORT CAPTURE + LOCAL NSFW DETECTION + DEVICE FINGERPRINT BAN REQUEST
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
  let matchId = null;
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
    notifyDot.style.display = 'none';
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

  // ---------------------- REPORT BUTTON (FIXED 100%) ----------------------
  reportBtn.onclick = async () => {
    if (!partnerId) {
      alert("No user to report.");
      return;
    }

    const video = remoteVideo;

    if (!video.srcObject) {
      alert("Video stream not ready yet.");
      return;
    }

    const waitForFrame = () => {
      return new Promise(resolve => {
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          return resolve();
        }
        video.addEventListener("loadeddata", () => resolve(), { once: true });
      });
    };

    await waitForFrame();

    try {
      const width = video.videoWidth;
      const height = video.videoHeight;

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, width, height);

      const imgData = canvas.toDataURL("image/png");

      // include fingerprint/device info
      const deviceId = DeviceFingerprint.getDeviceId();
      socket.emit("reportPorn", {
        partnerId,
        matchId,
        screenshot: imgData,
        timestamp: Date.now(),
        deviceId,
        fingerprint: DeviceFingerprint.getFingerprint()
      });

      addMessage("🚨 Report sent!", "system");

    } catch (err) {
      console.error("Screenshot failed:", err);
      alert("Failed to take screenshot. Try again when video is visible.");
    }
  };

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
  // Purpose: give server stable id even إذا تغيّر الـ IP. Not perfect vs VM/proxy, but raises bar.
  const DeviceFingerprint = (function () {
    const STORAGE_KEY_ID = 'spark_device_id_v1';
    const STORAGE_KEY_FP = 'spark_fingerprint_v1';

    // generate random UUID v4
    function uuidv4() {
      const arr = new Uint8Array(16);
      crypto.getRandomValues(arr);
      // RFC4122 version 4
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

    // collect passive attributes
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

    // sha-256 hex
    async function sha256hex(str) {
      const enc = new TextEncoder();
      const data = enc.encode(str);
      const hash = await crypto.subtle.digest('SHA-256', data);
      const b = Array.from(new Uint8Array(hash)).map(n => n.toString(16).padStart(2, '0')).join('');
      return b;
    }

    // public
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

  // ensure fingerprint ready ASAP
  DeviceFingerprint.ensure().catch(console.error);

  // ---------------------- NSFW DETECTOR (client-side using nsfwjs + tfjs) ----------------------
  // Config (user requested كل 3 ثوانٍ)
  const DETECT_INTERVAL_MS = 3000;  // 3 seconds
  const DOWNSAMPLE_WIDTH = 224;
  const PORN_THRESHOLD = 0.75;
  const CONSECUTIVE_REQUIRED = 2;
  const COOLDOWN_AFTER_REPORT_MS = 60 * 1000; // 1 min cooldown local

  // script cdn urls
  const TF_CDN = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0/dist/tf.min.js';
  const NSFWJS_CDN = 'https://cdn.jsdelivr.net/npm/nsfwjs@2.4.0/dist/nsfwjs.min.js';

  let nsfwModel = null;
  let detectIntervalHandle = null;
  let consecutiveHits = 0;
  let lastReportTs = 0;

  // hidden canvas
  const detectorCanvas = document.createElement('canvas');
  detectorCanvas.style.display = 'none';
  const detectorCtx = detectorCanvas.getContext('2d');
  document.body.appendChild(detectorCanvas);

  // overlay to block remote video
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

  // dynamic script loader
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
    nsfwModel = await nsfwjs.load(); // mobilenet
    return nsfwModel;
  }

  async function analyzeFrameProb() {
    if (!remoteVideo || remoteVideo.readyState < 2 || remoteVideo.videoWidth === 0) return null;
    const aspect = remoteVideo.videoWidth / remoteVideo.videoHeight;
    detectorCanvas.width = DOWNSAMPLE_WIDTH;
    detectorCanvas.height = Math.round(DOWNSAMPLE_WIDTH / aspect);
    try {
      detectorCtx.drawImage(remoteVideo, 0, 0, detectorCanvas.width, detectorCanvas.height);
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
          prob = Math.max(prob, p.probability * 0.6);
        }
      }
      return prob;
    } catch (err) {
      console.error('nsfw classify error', err);
      return null;
    }
  }

  function takeFullScreenshotDataURL() {
    if (!remoteVideo || remoteVideo.videoWidth === 0) return null;
    const c = document.createElement('canvas');
    c.width = remoteVideo.videoWidth;
    c.height = remoteVideo.videoHeight;
    const cctx = c.getContext('2d');
    try {
      cctx.drawImage(remoteVideo, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    } catch (err) {
      console.error('screenshot draw error', err);
      return null;
    }
  }

  async function handleAutoDetection(prob) {
    const now = Date.now();
    if (now - lastReportTs < COOLDOWN_AFTER_REPORT_MS) return;
    lastReportTs = now;

    // show overlay and blur
    blockOverlay.style.display = 'flex';
    updateBlockOverlayPos();
    remoteVideo.style.filter = 'blur(12px)';

    // take screenshot
    const screenshot = takeFullScreenshotDataURL();
    const { deviceId, fingerprint } = await DeviceFingerprint.ensure().catch(() => ({ deviceId: DeviceFingerprint.getDeviceId(), fingerprint: DeviceFingerprint.getFingerprint() }));

    // send auto report
    try {
      socket.emit('reportPorn', {
        partnerId,
        matchId,
        screenshot,
        timestamp: Date.now(),
        reason: 'auto-detected-client',
        model: 'nsfwjs-client',
        probability: prob,
        deviceId,
        fingerprint
      });
      addMessage('🚨 Automatic report sent (client-side).', 'system');
    } catch (e) {
      console.error('emit reportPorn failed', e);
    }

    // request server-side ban (server must enforce)
    try {
      socket.emit('requestBan', {
        partnerId,
        fingerprint,
        deviceId,
        reason: 'explicit-content-auto'
      });
    } catch (e) { console.error('emit requestBan failed', e); }

    // local block to prevent rejoin
    try {
      localStorage.setItem('spark_local_banned_device_v1', fingerprint || ('device:' + (deviceId || 'unknown')));
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
    stopNsfwDetection();
  }

  async function nsfwTick() {
    if (!partnerId || !remoteVideo || remoteVideo.paused || remoteVideo.readyState < 2) {
      consecutiveHits = 0;
      return;
    }
    const prob = await analyzeFrameProb();
    if (prob === null) return;
    if (prob >= PORN_THRESHOLD) {
      consecutiveHits++;
    } else {
      consecutiveHits = Math.max(0, consecutiveHits - 1);
    }
    if (consecutiveHits >= CONSECUTIVE_REQUIRED) {
      await handleAutoDetection(prob);
    }
  }

  async function startNsfwDetection() {
    if (detectIntervalHandle) return;
    try {
      await loadNsfwModel();
    } catch (e) {
      console.error('Failed to load nsfw model', e);
      return;
    }
    consecutiveHits = 0;
    detectIntervalHandle = setInterval(nsfwTick, DETECT_INTERVAL_MS);
  }

  function stopNsfwDetection() {
    if (detectIntervalHandle) {
      clearInterval(detectIntervalHandle);
      detectIntervalHandle = null;
    }
    consecutiveHits = 0;
    blockOverlay.style.display = 'none';
    if (remoteVideo) remoteVideo.style.filter = '';
  }

  // expose control API
  window.NSFW_DETECTOR = {
    start: startNsfwDetection,
    stop: stopNsfwDetection,
    forceReport: async (note) => {
      // manual report using existing reportBtn logic but include fingerprint
      if (!partnerId) { addMessage('No partner to report.', 'system'); return; }
      const scr = takeFullScreenshotDataURL();
      const { deviceId, fingerprint } = await DeviceFingerprint.ensure().catch(() => ({ deviceId: DeviceFingerprint.getDeviceId(), fingerprint: DeviceFingerprint.getFingerprint() }));
      socket.emit('reportPorn', {
        partnerId,
        matchId,
        screenshot: scr,
        timestamp: Date.now(),
        reason: 'manual:' + (note || ''),
        model: 'manual-client',
        deviceId,
        fingerprint
      });
      addMessage('🚨 Manual report sent.', 'system');
    }
  };

  // start detection automatically when remote plays
  if (remoteVideo) {
    remoteVideo.addEventListener('play', () => {
      // if local banned, do not start detection or connection
      const localBan = localStorage.getItem('spark_local_banned_device_v1');
      if (localBan) {
        addMessage('This device is locally banned — you are blocked from matching.', 'system');
        // ensure UI shows remote hidden
        showRemoteSpinnerOnly(true);
        return;
      }
      // small delay then start
      setTimeout(() => { startNsfwDetection().catch(console.error); }, 300);
    });
    remoteVideo.addEventListener('pause', stopNsfwDetection);
  }

  // ---------------------- MATCHMAKING ----------------------
  function startSearchLoop() {
    if (partnerId) return;

    // check local ban before starting
    const localBan = localStorage.getItem('spark_local_banned_device_v1');
    if (localBan) {
      addMessage('Your device is blocked due to previous violation. Contact admin to appeal.', 'system');
      showRemoteSpinnerOnly(true);
      statusText.textContent = 'Blocked.';
      return;
    }

    showRemoteSpinnerOnly(true);
    statusText.textContent = 'Searching...';

    socket.emit('find-partner', {
      locale: 'en',
      version: '1.0',
      timestamp: Date.now()
    });

    searchTimer = setTimeout(() => {
      if (!partnerId) {
        socket.emit('stop');
        statusText.textContent = 'Pausing...';
        pauseTimer = setTimeout(startSearchLoop, 1800);
      }
    }, 3500);
  }

  async function startSearch() {
    if (!(await initMedia())) return;

    // check local ban before starting
    const localBan = localStorage.getItem('spark_local_banned_device_v1');
    if (localBan) {
      addMessage('Your device is blocked due to previous violation. Contact admin to appeal.', 'system');
      showRemoteSpinnerOnly(true);
      statusText.textContent = 'Blocked.';
      return;
    }

    partnerId = null;
    matchId = null;
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
    notifyDot.style.display = 'block';
    notifyBell.classList.add('shake');

    pushAdminNotification('📢 ' + msg);
    addMessage('📢 Admin: ' + msg, 'system');
  });

  socket.on('partner-disconnected', () => {
    addMessage('Disconnected.', 'system');
    disableChat();
    partnerId = null;

    if (peerConnection) peerConnection.close();
    peerConnection = null;

    // stop NSFW detection if running
    stopNsfwDetection();

    startSearchLoop();
  });

  socket.on('partner-found', async data => {
    partnerId = data.partnerId || data.id;
    matchId = data.matchId || null;
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

  // server may confirm ban applied
  socket.on('banConfirmed', ({ fingerprint, reason }) => {
    // if this device fingerprint matches, set local ban
    const myFp = DeviceFingerprint.getFingerprint();
    if (fingerprint && myFp && fingerprint === myFp) {
      try {
        localStorage.setItem('spark_local_banned_device_v1', fingerprint);
      } catch (e) {}
      addMessage('تم حظرك محلياً بواسطة المشرف.', 'system');
      // force UI block
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
        // stop detection
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
    socket.emit('stop');
    if (localStream) localStream.getTracks().forEach(t => t.stop());
  };

});
