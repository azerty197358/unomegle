// app.js
window.addEventListener('DOMContentLoaded', () => {
  // ---------------------- SOCKET ----------------------
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

  const reportedIds = new Set();
  const reportCounts = new Map();

  // NEW: reconnection/backoff state
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 6;
  const BASE_BACKOFF_MS = 800; // used in exponential backoff

  // NEW: candidate buffering (remote candidates arriving before pc is ready)
  const bufferedRemoteCandidates = [];

  // NEW: negotiation guard
  let makingOffer = false;
  let ignoreOffer = false; // if glare resolved

  // NEW: datachannel for keepalive
  let keepAliveChannel = null;
  let lastPong = Date.now();
  const PING_INTERVAL = 4000;
  const PONG_TIMEOUT = 11000;

  // NEW: stats monitor
  let statsInterval = null;
  const STATS_POLL_MS = 3000;
  // bitrate targets (bps)
  const BITRATE_HIGH = 800_000;
  const BITRATE_MEDIUM = 400_000;
  const BITRATE_LOW = 160_000;

  // ---------------------- AD / SKIP COUNT CONFIG ----------------------
  let skipCount = 0;
  const SKIP_THRESHOLD = 3;
  const AD_DURATION_MS = 5000;
  const AD_SCRIPT_SRC = 'https://nap5k.com/tag.min.js';
  const AD_SCRIPT_ZONE = '10313447';
  let adOverlayVisible = false;

  // ---------------------- AD WHILE SEARCHING ----------------------
  let searchAdTimer = null;
  const SEARCH_AD_INTERVAL = 30000;   // 30 seconds
  const SEARCH_AD_DURATION = 5000;    // 5 seconds

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

  // exponential backoff (ms)
  function backoffDelay(attempt) {
    return Math.min(30000, Math.pow(2, attempt) * BASE_BACKOFF_MS + Math.floor(Math.random() * 500));
  }

  // store remote candidates until pc created
  function bufferRemoteCandidate(candidateObj) {
    bufferedRemoteCandidates.push(candidateObj);
  }

  function flushBufferedCandidates() {
    while (bufferedRemoteCandidates.length && peerConnection) {
      const c = bufferedRemoteCandidates.shift();
      try {
        peerConnection.addIceCandidate(c).catch(() => {/* ignore */});
      } catch (e) {}
    }
  }

  // set max bitrate for outbound video sender
  async function setSenderMaxBitrate(targetBps) {
    if (!peerConnection) return;
    try {
      const senders = peerConnection.getSenders();
      for (const sender of senders) {
        if (!sender.track || sender.track.kind !== 'video') continue;
        const params = sender.getParameters();
        if (!params.encodings) params.encodings = [{}];
        params.encodings = params.encodings.map(enc => ({ ...enc, maxBitrate: targetBps }));
        await sender.setParameters(params);
      }
    } catch (e) {
      console.debug('setSenderMaxBitrate failed', e);
    }
  }

  // ---------------------- NOTIFICATION MENU ----------------------
  notifyBell.onclick = (e) => {
    e.stopPropagation();
    if (notifyDot) notifyDot.style.display = 'none';
    notifyBell.classList.remove('shake');
    notifyMenu.style.display =
      notifyMenu.style.display === 'block' ? 'none' : 'block';
  };

  document.onclick = () => { notifyMenu.style.display = 'none'; };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') notifyMenu.style.display = 'none'; });

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

  // ---------------------- SPINNER BEHAVIOR ----------------------
  try { if (localSpinner) localSpinner.style.display = 'none'; } catch(e) {}
  function showRemoteSpinnerOnly(show) {
    if (remoteSpinner) remoteSpinner.style.display = show ? 'block' : 'none';
    if (remoteVideo) remoteVideo.style.display = show ? 'none' : 'block';
    if (localVideo) localVideo.style.display = 'block';
  }
  function hideAllSpinners() {
    if (remoteSpinner) remoteSpinner.style.display = 'none';
    if (remoteVideo) remoteVideo.style.display = 'block';
    if (localVideo) localVideo.style.display = 'block';
  }

  // ---------------------- SCREENSHOT UTIL ----------------------
  function captureRemoteVideoFrame() {
    return new Promise((resolve, reject) => {
      try {
        const v = remoteVideo;
        if (!v || !v.srcObject) {
          return reject(new Error('Remote video not available'));
        }
        const width = v.videoWidth || v.clientWidth || 640;
        const height = v.videoHeight || v.clientHeight || 480;
        if (width === 0 || height === 0) {
          setTimeout(() => {
            const w2 = v.videoWidth || v.clientWidth || 640;
            const h2 = v.videoHeight || v.clientHeight || 480;
            if (w2 === 0 || h2 === 0) return reject(new Error('Remote video has no frames yet'));
            const canvas2 = document.createElement('canvas');
            canvas2.width = w2;
            canvas2.height = h2;
            const ctx2 = canvas2.getContext('2d');
            ctx2.drawImage(v, 0, 0, w2, h2);
            resolve(canvas2.toDataURL('image/png'));
          }, 250);
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(v, 0, 0, width, height);
        resolve(canvas.toDataURL('image/png'));
      } catch (err) {
        reject(err);
      }
    });
  }

  // ---------------------- REPORT BUTTON ----------------------
  if (reportBtn) {
    reportBtn.style.display = 'flex';
    reportBtn.onclick = async () => {
      if (!partnerId) {
        addMessage("No user to report.", "system");
        return;
      }
      const prev = reportCounts.get(partnerId) || 0;
      const now = prev + 1;
      reportCounts.set(partnerId, now);
      reportedIds.add(partnerId);
      try { socket.emit("report", { partnerId }); } catch (e) { /* ignore */ }
      try { socket.emit("skip"); } catch (e) { /* ignore */ }

      if (now === 1) {
        try {
          addMessage("Capturing screenshot for admin review...", "system");
          const image = await captureRemoteVideoFrame();
          socket.emit("admin-screenshot", { image, partnerId });
          addMessage("Screenshot sent to admin.", "system");
        } catch (err) {
          console.error('Screenshot capture failed', err);
          addMessage("Failed to capture screenshot (no remote frame available).", "system");
        }
      }

      if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
      }
      partnerId = null;
      disableChat();
      statusText.textContent = 'You reported the user — skipping...';
      clearTimeout(searchTimer);
      clearTimeout(pauseTimer);
      // stop search ad timer if running
      if (searchAdTimer) {
        clearInterval(searchAdTimer);
        searchAdTimer = null;
      }
      searchTimer = setTimeout(startSearchLoop, 300);
    };
  }

  // ---------------------- UI ----------------------
  function enableChat() {
    chatInput.disabled = false;
    sendBtn.disabled = false;
  }
  function disableChat() {
    chatInput.disabled = true;
    sendBtn.disabled = true;
  }

  // ---------------------- MATCHMAKING ----------------------
  function startSearchLoop() {
    if (partnerId) return;
    showRemoteSpinnerOnly(true);
    statusText.textContent = 'Searching...';
    socket.emit('find-partner');

    // تشغيل مؤقت الإعلان أثناء البحث (كل 30 ثانية)
    if (!searchAdTimer) {
      searchAdTimer = setInterval(() => {
        if (!partnerId) showSearchAd();
      }, SEARCH_AD_INTERVAL);
    }

    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (!partnerId) {
        try { socket.emit('stop'); } catch (e) {}
        showRemoteSpinnerOnly(false);
        statusText.textContent = 'Pausing...';
        clearTimeout(pauseTimer);
        pauseTimer = setTimeout(startSearchLoop, 1800);
      }
    }, 3500);
  }

  async function startSearch() {
    if (!(await initMedia())) return;
    partnerId = null;
    isInitiator = false;
    chatMessages.innerHTML = '';
    chatMessages.appendChild(typingIndicator);
    showRemoteSpinnerOnly(true);
    skipBtn.disabled = false;
    startSearchLoop();
  }

  skipBtn.onclick = () => {
    try { socket.emit('skip'); } catch (e) {}
    statusText.textContent = 'You skipped.';
    disableChat();
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    // increment skip counter and, if threshold met, instruct remote to show ad
    skipCount++;
    try {
      if (skipCount % SKIP_THRESHOLD === 0) {
        if (partnerId) {
          try { socket.emit('display-ad', { to: partnerId }); } catch (e) {}
        }
      }
    } catch (e) { console.warn('skipCount emit failed', e); }

    partnerId = null;
    clearTimeout(searchTimer);
    clearTimeout(pauseTimer);

    // stop search ad timer if running, restart when loop restarts
    if (searchAdTimer) {
      clearInterval(searchAdTimer);
      searchAdTimer = null;
    }

    startSearchLoop();
  };

  // ---------------------- SOCKET EVENTS ----------------------
  socket.on('waiting', msg => { statusText.textContent = msg; });

  socket.on('chat-message', ({ message }) => { addMessage(message, 'them'); });

  socket.on('typing', () => {
    typingIndicator.style.display = 'block';
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });

  socket.on('stop-typing', () => { typingIndicator.style.display = 'none'; });

  socket.on('adminMessage', msg => {
    if (notifyDot) notifyDot.style.display = 'block';
    notifyBell.classList.add('shake');
    pushAdminNotification('📢 ' + msg);
    addMessage('📢 Admin: ' + msg, 'system');
  });

  socket.on('banned', ({ message }) => {
    addMessage(message || 'You are banned.', 'system');
    showRemoteSpinnerOnly(true);
    statusText.textContent = 'Blocked.';
  });

  socket.on('partner-disconnected', () => {
    statusText.textContent = 'Partner disconnected.';
    disableChat();
    partnerId = null;
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    clearTimeout(searchTimer);
    clearTimeout(pauseTimer);
    reconnectAttempts = 0;
    // stop search ad timer
    if (searchAdTimer) {
      clearInterval(searchAdTimer);
      searchAdTimer = null;
    }
    startSearchLoop();
  });

  socket.on('partner-found', async data => {
    // stop search ad timer immediately when found
    if (searchAdTimer) {
      clearInterval(searchAdTimer);
      searchAdTimer = null;
    }

    const foundId = data.id || data.partnerId;
    if (foundId && reportedIds.has(foundId)) {
      try { socket.emit('skip'); } catch (e) {}
      statusText.textContent = 'Found reported user — skipping...';
      partnerId = null;
      clearTimeout(searchTimer);
      clearTimeout(pauseTimer);
      setTimeout(startSearchLoop, 200);
      return;
    }
    partnerId = foundId;
    isInitiator = !!data.initiator;
    hideAllSpinners();
    statusText.textContent = 'Connecting...';
    createPeerConnection();

    if (isInitiator) {
      try {
        makingOffer = true;
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('signal', { to: partnerId, data: offer });
      } catch (e) {
        console.error('Offer failed', e);
      } finally {
        makingOffer = false;
      }
    }
  });

  socket.on('signal', async ({ from, data }) => {
    if (!peerConnection) createPeerConnection();

    if (data && data.candidate && !peerConnection.remoteDescription) {
      bufferRemoteCandidate(data.candidate);
      return;
    }

    try {
      if (data.type === 'offer') {
        const offerCollision = (makingOffer || peerConnection.signalingState !== 'stable');
        ignoreOffer = !isInitiator && offerCollision;
        if (ignoreOffer) {
          return;
        }
        await peerConnection.setRemoteDescription(data);
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('signal', { to: from, data: answer });
      } else if (data.type === 'answer') {
        await peerConnection.setRemoteDescription(data);
      } else if (data.candidate) {
        await peerConnection.addIceCandidate(data.candidate);
      }
    } catch (e) {
      console.error('Signal handling error', e);
    }
  });

  // ---------------------- AD DISPLAY HANDLER (REMOTE) ----------------------
  socket.on('display-ad', async () => {
    if (adOverlayVisible) return;
    adOverlayVisible = true;

    const wasChatEnabled = !chatInput.disabled;
    const wasRemotePlaying = !remoteVideo.paused && !remoteVideo.ended;

    const overlay = document.createElement('div');
    overlay.id = 'cc-ad-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = '99999';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.6)';

    const container = document.createElement('div');
    container.id = 'cc-ad-container';
    container.style.maxWidth = '90%';
    container.style.maxHeight = '90%';
    container.style.background = 'transparent';
    container.style.padding = '10px';
    container.style.borderRadius = '8px';
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.justifyContent = 'center';

    overlay.appendChild(container);
    document.body.appendChild(overlay);

    const adScript = document.createElement('script');
    adScript.dataset.zone = AD_SCRIPT_ZONE;
    adScript.src = AD_SCRIPT_SRC;
    adScript.id = 'cc-injected-ad-script';
    container.appendChild(adScript);

    try { remoteVideo.pause(); } catch (e) {}
    disableChat();

    setTimeout(() => {
      const s = document.getElementById('cc-injected-ad-script');
      if (s && s.parentNode) s.parentNode.removeChild(s);
      const ov = document.getElementById('cc-ad-overlay');
      if (ov && ov.parentNode) ov.parentNode.removeChild(ov);

      if (wasChatEnabled) enableChat();
      try {
        if (wasRemotePlaying) {
          remoteVideo.play().catch(() => {});
        }
      } catch (e) {}

      adOverlayVisible = false;
    }, AD_DURATION_MS);
  });

  // ---------------------- SHOW SEARCH AD (LOCAL overlay shown while searching) ----------------------
  function showSearchAd() {
    if (partnerId) return;

    // avoid showing if ad already visible
    if (document.getElementById('search-ad-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'search-ad-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.background = 'rgba(0,0,0,0.65)';
    overlay.style.zIndex = '999999';
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.color = '#fff';
    overlay.style.fontSize = '26px';
    overlay.style.fontWeight = 'bold';

    const label = document.createElement('div');
    label.textContent = "ADs";
    label.style.position = 'absolute';
    label.style.top = '20px';
    label.style.background = 'red';
    label.style.padding = '8px 18px';
    label.style.borderRadius = '8px';
    overlay.appendChild(label);

    const box = document.createElement('div');
    box.textContent = "الإعلان يظهر الآن...";
    box.style.padding = '20px 40px';
    box.style.background = 'rgba(0,0,0,0.4)';
    box.style.borderRadius = '10px';
    overlay.appendChild(box);

    document.body.appendChild(overlay);

    // زيادة مدة التوقف عند ظهور الإعلان (تم رفعها قليلاً)
    clearTimeout(pauseTimer);
    pauseTimer = setTimeout(startSearchLoop, 3000);

    setTimeout(() => {
      const ov = document.getElementById('search-ad-overlay');
      if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    }, SEARCH_AD_DURATION);
  }

  // ---------------------- WEBRTC ----------------------
  function createPeerConnection() {
    if (peerConnection) {
      try { peerConnection.close(); } catch (e) {}
      peerConnection = null;
    }

    peerConnection = new RTCPeerConnection(servers);
    makingOffer = false;
    ignoreOffer = false;

    if (localStream) {
      localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    }

    if (isInitiator) {
      try {
        keepAliveChannel = peerConnection.createDataChannel('keepAlive', { ordered: true });
        setupKeepAliveChannel(keepAliveChannel);
      } catch (e) { keepAliveChannel = null; }
    } else {
      peerConnection.ondatachannel = (ev) => {
        keepAliveChannel = ev.channel;
        setupKeepAliveChannel(keepAliveChannel);
      };
    }

    peerConnection.ontrack = e => {
      remoteVideo.srcObject = e.streams[0];
      enableChat();
      addMessage('Connected with a stranger!', 'system');
      showRemoteSpinnerOnly(false);
      flushBufferedCandidates();
      reconnectAttempts = 0;
      startStatsMonitor();
    };

    peerConnection.onicecandidate = e => {
      if (e.candidate) {
        try {
          socket.emit('signal', { to: partnerId, data: { candidate: e.candidate } });
        } catch (err) { /* ignore */ }
      }
    };

    peerConnection.onconnectionstatechange = () => {
      const s = peerConnection.connectionState;
      console.debug('connectionState', s);
      if (s === 'connected') {
        statusText.textContent = 'Connected';
        reconnectAttempts = 0;
      } else if (['disconnected', 'failed', 'closed'].includes(s)) {
        statusText.textContent = 'Connection lost.';
        disableChat();
        if (peerConnection) {
          try { peerConnection.close(); } catch (e) {}
          peerConnection = null;
        }
        if (autoReconnect) attemptRecovery();
      }
    };

    peerConnection.oniceconnectionstatechange = async () => {
      const s = peerConnection.iceConnectionState;
      console.debug('iceConnectionState', s);
      if (s === 'failed') {
        await attemptIceRestartWithBackoff();
      }
    };

    peerConnection.onnegotiationneeded = async () => {
      if (makingOffer) return;
      try {
        makingOffer = true;
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('signal', { to: partnerId, data: offer });
      } catch (e) {
        console.error('Negotiation error', e);
      } finally {
        makingOffer = false;
      }
    };
  }

  // attempt recovery: try ICE-restart a few times, otherwise rematch
  async function attemptRecovery() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      partnerId = null;
      clearInterval(statsInterval);
      clearTimeout(searchTimer);
      clearTimeout(pauseTimer);
      // stop search ad timer
      if (searchAdTimer) {
        clearInterval(searchAdTimer);
        searchAdTimer = null;
      }
      startSearchLoop();
      reconnectAttempts = 0;
      return;
    }
    reconnectAttempts++;
    const delay = backoffDelay(reconnectAttempts);
    statusText.textContent = `Reconnecting... attempt ${reconnectAttempts}`;
    setTimeout(async () => {
      try {
        if (!peerConnection) {
          createPeerConnection();
          if (isInitiator) {
            makingOffer = true;
            const offer = await peerConnection.createOffer({ iceRestart: true });
            await peerConnection.setLocalDescription(offer);
            socket.emit('signal', { to: partnerId, data: offer });
          } else {
            try { await performIceRestartIfPossible(); } catch (_) {}
          }
        } else {
          await attemptIceRestartWithBackoff();
        }
      } catch (e) {
        console.error('attemptRecovery error', e);
      }
    }, delay);
  }

  let lastIceRestartAt = 0;
  const ICE_RESTART_MIN_INTERVAL = 5000;
  async function attemptIceRestartWithBackoff() {
    const now = Date.now();
    if (now - lastIceRestartAt < ICE_RESTART_MIN_INTERVAL) return;
    lastIceRestartAt = now;
    try {
      await performIceRestart();
    } catch (e) {
      console.error('ICE restart failed', e);
    }
  }

  async function performIceRestart() {
    if (!peerConnection || !partnerId) return;
    try {
      makingOffer = true;
      const offer = await peerConnection.createOffer({ iceRestart: true });
      await peerConnection.setLocalDescription(offer);
      socket.emit('signal', { to: partnerId, data: offer });
    } finally {
      makingOffer = false;
    }
  }

  async function performIceRestartIfPossible() {
    if (!peerConnection || peerConnection.signalingState !== 'stable') return;
    try {
      const offer = await peerConnection.createOffer({ iceRestart: true });
      await peerConnection.setLocalDescription(offer);
      socket.emit('signal', { to: partnerId, data: offer });
    } catch (e) { console.error(e); }
  }

  // ---------------------- KEEPALIVE (datachannel) ----------------------
  function setupKeepAliveChannel(dc) {
    if (!dc) return;
    dc.onopen = () => {
      lastPong = Date.now();
      startPingLoop();
    };
    dc.onmessage = (ev) => {
      if (!ev.data) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'ping') {
          dc.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        } else if (msg.type === 'pong') {
          lastPong = Date.now();
        }
      } catch (e) {}
    };
    dc.onclose = () => {
      console.debug('keepAlive channel closed');
    };
    dc.onerror = (err) => {
      console.debug('keepAlive channel error', err);
    };
  }

  let pingTimer = null;
  function startPingLoop() {
    stopPingLoop();
    pingTimer = setInterval(() => {
      if (!keepAliveChannel || keepAliveChannel.readyState !== 'open') {
        return;
      }
      try {
        keepAliveChannel.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      } catch (e) {}
      if (Date.now() - lastPong > PONG_TIMEOUT) {
        console.warn('PONG timeout -> triggering recovery');
        attemptRecovery();
      }
    }, PING_INTERVAL);
  }
  function stopPingLoop() { if (pingTimer) clearInterval(pingTimer); pingTimer = null; }

  // ---------------------- STATS MONITOR (adaptive bitrate) ----------------------
  function startStatsMonitor() {
    stopStatsMonitor();
    statsInterval = setInterval(async () => {
      if (!peerConnection) return;
      try {
        const stats = await peerConnection.getStats(null);
        let outboundVideoReport = null;
        let remoteInboundRtp = null;
        stats.forEach(report => {
          if (report.type === 'outbound-rtp' && report.kind === 'video') {
            outboundVideoReport = report;
          }
          if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
            remoteInboundRtp = report;
          }
        });

        let lossRatio = 0;
        if (outboundVideoReport && typeof outboundVideoReport.packetsSent === 'number') {
          if (remoteInboundRtp && typeof remoteInboundRtp.packetsLost === 'number') {
            const lost = remoteInboundRtp.packetsLost;
            const sent = remoteInboundRtp.packetsReceived + lost || 1;
            lossRatio = lost / sent;
          } else if ('packetsLost' in outboundVideoReport) {
            lossRatio = outboundVideoReport.packetsLost / Math.max(1, outboundVideoReport.packetsSent);
          }
        }

        let rtt = 0;
        stats.forEach(r => { if (r.type === 'candidate-pair' && r.currentRtt) rtt = r.currentRtt; });

        if (lossRatio > 0.08 || rtt > 0.5) {
          await setSenderMaxBitrate(BITRATE_LOW);
        } else if (lossRatio > 0.03 || rtt > 0.25) {
          await setSenderMaxBitrate(BITRATE_MEDIUM);
        } else {
          await setSenderMaxBitrate(BITRATE_HIGH);
        }
      } catch (e) {
        console.debug('stats monitor error', e);
      }
    }, STATS_POLL_MS);
  }
  function stopStatsMonitor() { if (statsInterval) { clearInterval(statsInterval); statsInterval = null; } }

  // ---------------------- EXIT ----------------------
  exitBtn.onclick = () => { location.href = 'index.html'; };

  // ---------------------- MEDIA INIT ----------------------
  async function initMedia() {
    if (localStream) return true;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
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
    try { if (peerConnection) peerConnection.close(); } catch (e) {}
    // clear ad timer on unload
    if (searchAdTimer) {
      clearInterval(searchAdTimer);
      searchAdTimer = null;
    }
  };

  // ---------------------- UTILITY: Start/Stop Ping & Stats on PC close ----------------------
  const origPCClose = () => {
    stopPingLoop();
    stopStatsMonitor();
  };
});
