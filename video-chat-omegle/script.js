// file: public/js/webrtc-stable-client.js
// WebRTC client with adaptive bitrate, ICE-restart, keepalive, candidate buffering, reconnect backoff,
// typing indicators, fingerprinting, and full compatibility with server.js
// 
// CSS مقترح لتجميل الرسائل (أضف هذا إلى ملف CSS الخاص بك):
// .msg { padding: 10px; margin: 5px 0; border-radius: 10px; max-width: 80%; word-wrap: break-word; }
// .msg.system { background: #e0e0e0; color: #555; font-size: 0.9em; }
// .msg.you { background: #007bff; color: white; margin-left: auto; }
// .msg.them { background: #f1f1f1; color: #333; margin-right: auto; }
// .msg.status { background: #fff3cd; color: #856404; font-weight: bold; text-align: center; border: 1px solid #ffeaa7; }

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

  // تم إزالة statusText لأننا نستخدم updateStatusMessage الآن
  // const statusText = document.getElementById('status');

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

  // Reconnection/backoff state
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 6;
  const BASE_BACKOFF_MS = 800;

  // Candidate buffering
  const bufferedRemoteCandidates = [];

  // Negotiation guard
  let makingOffer = false;
  let ignoreOffer = false;

  // Datachannel for keepalive
  let keepAliveChannel = null;
  let lastPong = Date.now();
  const PING_INTERVAL = 4000;
  const PONG_TIMEOUT = 11000;

  // Stats monitor
  let statsInterval = null;
  const STATS_POLL_MS = 3000;
  
  // Bitrate targets (bps)
  const BITRATE_HIGH = 800_000;
  const BITRATE_MEDIUM = 400_000;
  const BITRATE_LOW = 160_000;

  // ---------------------- FINGERPRINT GENERATION ----------------------
  async function generateFingerprint() {
    try {
      const components = [
        navigator.userAgent,
        navigator.language,
        screen.colorDepth,
        screen.width,
        screen.height,
        navigator.hardwareConcurrency || 0,
        new Date().getTimezoneOffset(),
        Intl.DateTimeFormat().resolvedOptions().timeZone || ''
      ];

      // Canvas fingerprint
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('fingerprint', 2, 15);
      ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
      ctx.fillText('fingerprint', 4, 17);
      components.push(canvas.toDataURL());

      // Audio fingerprint
      const audioCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
      const oscillator = audioCtx.createOscillator();
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(10000, audioCtx.currentTime);
      oscillator.connect(audioCtx.destination);
      oscillator.start();
      oscillator.stop();
      components.push('audio-supported');

      // Hash function
      const hashCode = (str) => {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
          const char = str.charCodeAt(i);
          hash = ((hash << 5) - hash) + char;
          hash = hash & hash;
        }
        return hash.toString(16);
      };

      return hashCode(components.join('||'));
    } catch (e) {
      console.error('Fingerprint generation failed:', e);
      return 'default-fp-' + Math.random().toString(36).substr(2, 9);
    }
  }

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

  // دالة جديدة لتحديث رسالة الحالة (تستبدل القديمة بالجديدة)
  function updateStatusMessage(msg) {
    // ابحث عن عنصر رسالة الحالة الحالية
    let statusMsg = document.getElementById('statusMessage');
    
    if (statusMsg) {
      // إذا وجدت، فقط حدّث النص
      statusMsg.textContent = msg;
    } else {
      // إذا لم تجد، أنشئ عنصرًا جديدًا
      statusMsg = document.createElement('div');
      statusMsg.id = 'statusMessage';
      statusMsg.className = 'msg status';
      statusMsg.textContent = msg;
      
      // أضفها قبل typing indicator أو في النهاية
      const typing = document.querySelector('.msg.system[style*="italic"]');
      if (typing && typing.parentNode === chatMessages) {
        chatMessages.insertBefore(statusMsg, typing);
      } else {
        chatMessages.appendChild(statusMsg);
      }
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

  // Exponential backoff (ms)
  function backoffDelay(attempt) {
    return Math.min(30000, Math.pow(2, attempt) * BASE_BACKOFF_MS + Math.floor(Math.random() * 500));
  }

  // Store remote candidates until pc created
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

  // Set max bitrate for outbound video sender
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
    notifyMenu.style.display = notifyMenu.style.display === 'block' ? 'none' : 'block';
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
        updateStatusMessage("No user to report.");
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
      updateStatusMessage('You reported the user — skipping...');
      clearTimeout(searchTimer);
      clearTimeout(pauseTimer);
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
    updateStatusMessage('Searching...');
    socket.emit('find-partner');
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (!partnerId) {
        try { socket.emit('stop'); } catch (e) {}
        showRemoteSpinnerOnly(false);
        updateStatusMessage('Pausing...');
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
    updateStatusMessage('You skipped.');
    disableChat();
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    partnerId = null;
    clearTimeout(searchTimer);
    clearTimeout(pauseTimer);
    startSearchLoop();
  };

  // ---------------------- SOCKET EVENTS ----------------------
  socket.on('waiting', msg => { updateStatusMessage(msg); });

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
    updateStatusMessage('Blocked.');
  });

  socket.on('partner-disconnected', () => {
    updateStatusMessage('Partner disconnected.');
    disableChat();
    partnerId = null;
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    clearTimeout(searchTimer);
    clearTimeout(pauseTimer);
    reconnectAttempts = 0;
    startSearchLoop();
  });

  socket.on('partner-found', async data => {
    const foundId = data.id || data.partnerId;
    if (foundId && reportedIds.has(foundId)) {
      try { socket.emit('skip'); } catch (e) {}
      updateStatusMessage('Found reported user — skipping...');
      partnerId = null;
      clearTimeout(searchTimer);
      clearTimeout(pauseTimer);
      setTimeout(startSearchLoop, 200);
      return;
    }
    partnerId = foundId;
    isInitiator = !!data.initiator;
    hideAllSpinners();
    updateStatusMessage('Connecting...');
    createPeerConnection();

    // initiator starts offer
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

    // Buffer candidates that arrive before remote description is set
    if (data && data.candidate && !peerConnection.remoteDescription) {
      bufferRemoteCandidate(data.candidate);
      return;
    }

    try {
      if (data.type === 'offer') {
        const offerCollision = (makingOffer || peerConnection.signalingState !== 'stable');
        ignoreOffer = !isInitiator && offerCollision;
        if (ignoreOffer) return;
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

  // ---------------------- WEBRTC ----------------------
  function createPeerConnection() {
    if (peerConnection) {
      try { peerConnection.close(); } catch (e) {}
      peerConnection = null;
    }

    peerConnection = new RTCPeerConnection(servers);
    makingOffer = false;
    ignoreOffer = false;

    // Add local tracks
    if (localStream) {
      localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    }

    // Create datachannel when initiator
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
        updateStatusMessage('Connected');
        reconnectAttempts = 0;
      } else if (['disconnected', 'failed', 'closed'].includes(s)) {
        updateStatusMessage('Connection lost.');
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

  // Attempt recovery: try ICE-restart a few times, otherwise rematch
  async function attemptRecovery() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      partnerId = null;
      clearInterval(statsInterval);
      clearTimeout(searchTimer);
      clearTimeout(pauseTimer);
      startSearchLoop();
      reconnectAttempts = 0;
      return;
    }
    reconnectAttempts++;
    const delay = backoffDelay(reconnectAttempts);
    updateStatusMessage(`Reconnecting... attempt ${reconnectAttempts}`);
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
      if (!keepAliveChannel || keepAliveChannel.readyState !== 'open') return;
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
      updateStatusMessage('Camera/Mic denied.');
      localStream = null;
      updateMicButton();
      return false;
    }
  }

  // ---------------------- AUTO START ----------------------
  async function initialize() {
    ensureNotifyEmpty();
    updateMicButton();
    
    // Generate and send fingerprint for device ban system
    const fingerprint = await generateFingerprint();
    socket.emit('identify', { fingerprint });
    
    startSearch();
  }

  initialize();

  window.onbeforeunload = () => {
    try { socket.emit('stop'); } catch (e) {}
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    try { if (peerConnection) peerConnection.close(); } catch (e) {}
  };
});
