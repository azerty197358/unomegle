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
  const exitBtn = document.getElementById('exitBtn');
  // ---------------------- قائمة فيديوهات الإعلانات ----------------------
  const adVideosList = [
    'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251221_081055765.mp4',
    'https://raw.githubusercontent.com/azerty197358/myads/main/Single%20girl%20video%20chat%20-%20Video%20Calls%20Apps%20(360p,%20h264).mp4',
    'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251221_153328953.mp4'
  ];
  let currentAdIndex = 0;
  let isAdPlaying = false;
  let adVideo = null;
  function createAdVideoElement() {
    if (adVideo) adVideo.remove();
    adVideo = document.createElement('video');
    adVideo.id = 'adVideo';
    adVideo.autoplay = false;
    adVideo.muted = true;
    adVideo.playsInline = true;
    adVideo.preload = 'auto';
    Object.assign(adVideo.style, {
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      zIndex: 100,
      display: 'none',
      backgroundColor: '#000'
    });
    adVideo.controls = false;
    remoteVideo.parentNode.appendChild(adVideo);
    return adVideo;
  }
  createAdVideoElement();
  // ---------------------- GLOBAL STATE ----------------------
  let localStream = null;
  let peerConnection = null;
  let partnerId = null;
  let isInitiator = false;
  let micEnabled = true;
  let isBanned = false;
  let consecutiveSearchFails = 0;
  const activeTimers = new Set();
  let searchTimer = null;
  let pauseTimer = null;
  let normalPauseDuration = 3000;
  const servers = { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };
  const reportedIds = new Set();
  const reportCounts = new Map();
  const bufferedRemoteCandidates = [];
  let makingOffer = false;
  let ignoreOffer = false;
  let keepAliveChannel = null;
  let lastPong = Date.now();
  const PING_INTERVAL = 4000;
  const PONG_TIMEOUT = 11000;
  let statsInterval = null;
  const STATS_POLL_MS = 3000;
  const BITRATE_HIGH = 800_000;
  const BITRATE_MEDIUM = 400_000;
  const BITRATE_LOW = 160_000;
  // ---------------------- FINGERPRINT ----------------------
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
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('fingerprint', 2, 15);
      ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
      ctx.fillText('fingerprint', 4, 17);
      components.push(canvas.toDataURL());
      const audioCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
      const oscillator = audioCtx.createOscillator();
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(10000, audioCtx.currentTime);
      oscillator.connect(audioCtx.destination);
      oscillator.start();
      oscillator.stop();
      components.push('audio-supported');
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
    } catch {
      return 'default-fp-' + Math.random().toString(36).substr(2, 9);
    }
  }
  // ---------------------- TIMER MANAGEMENT ----------------------
  function setSafeTimer(callback, delay) {
    const timerId = setTimeout(() => {
      activeTimers.delete(timerId);
      callback();
    }, delay);
    activeTimers.add(timerId);
    return timerId;
  }
  function clearSafeTimer(timerId) {
    if (timerId) {
      clearTimeout(timerId);
      activeTimers.delete(timerId);
    }
  }
  function clearAllTimers() {
    activeTimers.forEach(timerId => clearTimeout(timerId));
    activeTimers.clear();
    if (statsInterval) clearInterval(statsInterval);
    if (pingTimer) clearInterval(pingTimer);
  }
  // ---------------------- SAFE EMIT ----------------------
  function safeEmit(event, data) {
    try {
      if (socket.connected) {
        socket.emit(event, data);
        return true;
      }
      return false;
    } catch {
      return false;
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
  function updateStatusMessage(msg) {
    let statusMsg = document.getElementById('statusMessage');
    if (statusMsg) {
      statusMsg.textContent = msg;
    } else {
      statusMsg = document.createElement('div');
      statusMsg.id = 'statusMessage';
      statusMsg.className = 'msg status';
      statusMsg.textContent = msg;
      const typing = document.querySelector('.msg.system[style*="italic"]');
      if (typing && typing.parentNode === chatMessages) {
        chatMessages.insertBefore(statusMsg, typing);
      } else {
        chatMessages.appendChild(statusMsg);
      }
    }
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
  function bufferRemoteCandidate(candidateObj) {
    bufferedRemoteCandidates.push(candidateObj);
  }
  function flushBufferedCandidates() {
    while (bufferedRemoteCandidates.length && peerConnection) {
      const c = bufferedRemoteCandidates.shift();
      try {
        peerConnection.addIceCandidate(c).catch(() => {});
      } catch {}
    }
  }
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
    } catch {}
  }
  // ---------------------- AD VIDEO ----------------------
  function playAdVideo() {
    if (isAdPlaying || adVideosList.length === 0) {
      consecutiveSearchFails = 0;
      normalPauseDuration = 3000;
      updateStatusMessage('Searching...');
      startSearchLoop();
      return;
    }
    clearSafeTimer(searchTimer);
    clearSafeTimer(pauseTimer);
    searchTimer = null;
    pauseTimer = null;
    isAdPlaying = true;
    const adUrl = adVideosList[currentAdIndex];
    currentAdIndex = (currentAdIndex + 1) % adVideosList.length;
    updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger Say hello 😊🤝');
    adVideo.onerror = () => {
      hideAdVideo();
    };
    adVideo.oncanplay = () => {
      adVideo.play().catch(() => {
        document.addEventListener('click', tryPlayAdOnClick, { once: true });
      });
    };
    adVideo.onended = hideAdVideo;
    adVideo.src = adUrl;
    adVideo.style.display = 'block';
    remoteVideo.style.display = 'none';
    const adTimeout = setSafeTimer(hideAdVideo, 5000);
    function tryPlayAdOnClick() {
      adVideo.play().catch(() => {});
    }
    function hideAdVideo() {
      if (!isAdPlaying) return;
      clearSafeTimer(adTimeout);
      document.removeEventListener('click', tryPlayAdOnClick);
      adVideo.pause();
      adVideo.style.display = 'none';
      remoteVideo.style.display = 'block';
      adVideo.src = '';
      isAdPlaying = false;
      consecutiveSearchFails = 0;
      normalPauseDuration = 3000;
      updateStatusMessage('Searching...');
      startSearchLoop();
    }
  }
  // ---------------------- CONNECTION CLEANUP ----------------------
  function cleanupConnection() {
    clearAllTimers();
    if (peerConnection) {
      try {
        if (keepAliveChannel) {
          keepAliveChannel.close();
          keepAliveChannel = null;
        }
        peerConnection.close();
      } catch {}
      peerConnection = null;
    }
    if (remoteVideo) remoteVideo.srcObject = null;
    bufferedRemoteCandidates.length = 0;
    partnerId = null;
    isInitiator = false;
    makingOffer = false;
    ignoreOffer = false;
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
    if (!partnerId || isBanned) return;
    if (!typing) {
      typing = true;
      safeEmit('typing', { to: partnerId });
    }
    clearSafeTimer(typingTimer);
    typingTimer = setSafeTimer(() => {
      typing = false;
      safeEmit('stop-typing', { to: partnerId });
    }, TYPING_PAUSE);
  }
  chatInput.oninput = () => {
    if (!chatInput.disabled && !isBanned) sendTyping();
  };
  // ---------------------- CHAT ----------------------
  function sendMessage() {
    if (isBanned) return;
    const msg = chatInput.value.trim();
    if (!msg || !partnerId) return;
    addMessage(msg, 'you');
    safeEmit('chat-message', { to: partnerId, message: msg });
    chatInput.value = '';
    typing = false;
    safeEmit('stop-typing', { to: partnerId });
  }
  sendBtn.onclick = sendMessage;
  chatInput.onkeypress = e => { if (e.key === 'Enter' && !isBanned) sendMessage(); };
  // ---------------------- MIC ----------------------
  function updateMicButton() {
    micBtn.textContent = micEnabled ? '🎤' : '🔇';
    micBtn.disabled = !localStream || isBanned;
    micBtn.style.opacity = (localStream && !isBanned) ? '1' : '0.8';
  }
  micBtn.onclick = () => {
    if (!localStream || isBanned) return;
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    updateMicButton();
  };
  // ---------------------- SPINNER ----------------------
  try { if (localSpinner) localSpinner.style.display = 'none'; } catch {}
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
  // ---------------------- SCREENSHOT ----------------------
  function captureRemoteVideoFrame() {
    return new Promise((resolve, reject) => {
      try {
        const v = remoteVideo;
        if (!v || !v.srcObject) return reject(new Error('Remote video not available'));
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
  // ---------------------- REPORT ----------------------
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
      safeEmit("report", { partnerId });
      safeEmit("skip");
      if (now === 1) {
        try {
          addMessage("Capturing screenshot for admin review...", "system");
          const image = await captureRemoteVideoFrame();
          safeEmit("admin-screenshot", { image, partnerId });
          addMessage("📋 A report about this user has been sent ✉️⚠️. Action is being reviewed 🔍⏳.", "system");
        } catch {
          addMessage("Failed to capture screenshot (no remote frame available).", "system");
        }
      }
      cleanupConnection();
      disableChat();
      updateStatusMessage('You reported the user — skipping...');
      clearSafeTimer(searchTimer);
      clearSafeTimer(pauseTimer);
      consecutiveSearchFails = 0;
      normalPauseDuration = 3000;
      startSearchLoop();
    };
  }
  // ---------------------- UI CONTROLS ----------------------
  function enableChat() {
    chatInput.disabled = isBanned;
    sendBtn.disabled = isBanned;
  }
  function disableChat() {
    chatInput.disabled = true;
    sendBtn.disabled = true;
  }
  // ---------------------- MATCHMAKING ----------------------
  function startSearchLoop() {
    if (isBanned) {
      updateStatusMessage('⛔ You have been banned for 24 hours 🕐 for engaging in inappropriate behavior 🚫 and violating our policy terms 📜. ⚠️');
      showRemoteSpinnerOnly(false);
      return;
    }
    if (partnerId || isAdPlaying) return;
    showRemoteSpinnerOnly(true);
    updateStatusMessage('Searching...');
    safeEmit('find-partner');
    clearSafeTimer(searchTimer);
    searchTimer = setSafeTimer(() => {
      if (!partnerId && !isAdPlaying) {
        safeEmit('stop');
        showRemoteSpinnerOnly(false);
        consecutiveSearchFails++;
        if (consecutiveSearchFails >= 3) {
          playAdVideo();
          return;
        }
        clearSafeTimer(pauseTimer);
        pauseTimer = setSafeTimer(() => {
          if (normalPauseDuration !== 3000) normalPauseDuration = 3000;
          startSearchLoop();
        }, normalPauseDuration);
      }
    }, 1500); // أسرع من 3.5 ثانية
  }
  async function startSearch() {
    if (isBanned) {
      updateStatusMessage('⛔ You have been banned for 24 hours 🕐 for engaging in inappropriate behavior 🚫 and violating our policy terms 📜. ⚠️');
      showRemoteSpinnerOnly(false);
      return;
    }
    const mediaReady = await initMedia();
    if (!mediaReady) {
      updateStatusMessage('Media initialization failed. Please allow camera/mic access.');
      return;
    }
    cleanupConnection();
    chatMessages.innerHTML = '';
    chatMessages.appendChild(typingIndicator);
    showRemoteSpinnerOnly(true);
    skipBtn.disabled = false;
    consecutiveSearchFails = 0;
    normalPauseDuration = 3000;
    startSearchLoop();
  }
  skipBtn.onclick = () => {
    if (isBanned) return;
    safeEmit('skip');
    updateStatusMessage('You skipped.');
    disableChat();
    cleanupConnection();
    clearSafeTimer(searchTimer);
    clearSafeTimer(pauseTimer);
    consecutiveSearchFails = 0;
    normalPauseDuration = 3000;
    startSearchLoop();
  };
  // ---------------------- SOCKET EVENTS ----------------------
  socket.on('waiting', msg => {
    if (!isBanned) updateStatusMessage(msg);
  });
  socket.on('chat-message', ({ message }) => {
    if (!isBanned) addMessage(message, 'them');
  });
  socket.on('typing', () => {
    if (!isBanned) {
      typingIndicator.style.display = 'block';
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  });
  socket.on('stop-typing', () => {
    if (!isBanned) typingIndicator.style.display = 'none';
  });
  socket.on('adminMessage', msg => {
    if (notifyDot) notifyDot.style.display = 'block';
    notifyBell.classList.add('shake');
    pushAdminNotification('📢 ' + msg);
    addMessage('📢 Admin: ' + msg, 'system');
  });
  socket.on('banned', ({ message }) => {
    isBanned = true;
    addMessage(message || 'You are banned.', 'system');
    showRemoteSpinnerOnly(true);
    updateStatusMessage('⛔ You have been banned for 24 hours 🕐 for engaging in inappropriate behavior 🚫 and violating our policy terms 📜. ⚠️');
    cleanupConnection();
    disableChat();
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    if (localVideo) localVideo.srcObject = null;
    updateMicButton();
  });
  socket.on('unbanned', ({ message }) => {
    isBanned = false;
    addMessage(message || 'You have been unbanned.', 'system');
    updateStatusMessage('You have been unbanned.');
    startSearch();
  });
  socket.on('partner-disconnected', () => {
    if (!isBanned) {
      updateStatusMessage('Partner disconnected.');
      disableChat();
      cleanupConnection();
      clearSafeTimer(searchTimer);
      clearSafeTimer(pauseTimer);
      consecutiveSearchFails = 0;
      normalPauseDuration = 3000;
      setSafeTimer(startSearchLoop, 500);
    }
  });
  socket.on('partner-found', async data => {
    if (isBanned) {
      safeEmit('skip');
      return;
    }
    const foundId = data?.id || data?.partnerId;
    if (!foundId) {
      updateStatusMessage('Invalid partner data. Retrying...');
      setSafeTimer(startSearchLoop, 1000);
      return;
    }
    if (reportedIds.has(foundId)) {
      safeEmit('skip');
      updateStatusMessage('Found reported user — skipping...');
      cleanupConnection();
      setSafeTimer(startSearchLoop, 200);
      return;
    }
    partnerId = foundId;
    isInitiator = !!data.initiator;
    hideAllSpinners();
    updateStatusMessage('Connecting...');
    consecutiveSearchFails = 0;
    normalPauseDuration = 3000;
    try {
      createPeerConnection();
      if (isInitiator) {
        makingOffer = true;
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        safeEmit('signal', { to: partnerId, data: offer });
      }
    } catch {
      updateStatusMessage('Connection setup failed. Retrying...');
      cleanupConnection();
      setSafeTimer(startSearchLoop, 1000);
    } finally {
      makingOffer = false;
    }
  });
  socket.on('signal', async ({ from, data }) => {
    if (isBanned) return;
    if (!from || !data) return;
    if (partnerId && partnerId !== from) return;
    if (!peerConnection) {
      try {
        createPeerConnection();
      } catch {
        return;
      }
    }
    if (data.candidate && !peerConnection.remoteDescription) {
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
        safeEmit('signal', { to: from, data: answer });
      } else if (data.type === 'answer') {
        await peerConnection.setRemoteDescription(data);
      } else if (data.candidate) {
        await peerConnection.addIceCandidate(data.candidate);
      }
    } catch {
      updateStatusMessage('Signal processing failed.');
    }
  });
  // ---------------------- WEBRTC ----------------------
  function createPeerConnection() {
    if (peerConnection) {
      try { peerConnection.close(); } catch {}
      peerConnection = null;
    }
    try {
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
        } catch {
          keepAliveChannel = null;
        }
      } else {
        peerConnection.ondatachannel = (ev) => {
          keepAliveChannel = ev.channel;
          setupKeepAliveChannel(keepAliveChannel);
        };
      }
      peerConnection.ontrack = e => {
        if (!e.streams || e.streams.length === 0) return;
        remoteVideo.srcObject = e.streams[0];
        enableChat();
        updateStatusMessage('Connected');
        showRemoteSpinnerOnly(false);
        flushBufferedCandidates();
        consecutiveSearchFails = 0;
        normalPauseDuration = 3000;
        startStatsMonitor();
      };
      peerConnection.onicecandidate = e => {
        if (e.candidate && partnerId) {
          safeEmit('signal', { to: partnerId, data: { candidate: e.candidate } });
        }
      };
      peerConnection.onconnectionstatechange = () => {
        if (!peerConnection) return;
        const s = peerConnection.connectionState;
        if (s === 'connected') {
          updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger Say hello 😊🤝');
          consecutiveSearchFails = 0;
        } else if (['disconnected', 'failed', 'closed'].includes(s)) {
          if (!isBanned) {
            updateStatusMessage('Connection lost.');
            disableChat();
            cleanupConnection();
            clearSafeTimer(searchTimer);
            clearSafeTimer(pauseTimer);
            consecutiveSearchFails = 0;
            normalPauseDuration = 3000;
            setSafeTimer(startSearchLoop, 500);
          }
        }
      };
      peerConnection.onnegotiationneeded = async () => {
        if (!peerConnection || makingOffer || !partnerId) return;
        try {
          makingOffer = true;
          const offer = await peerConnection.createOffer();
          await peerConnection.setLocalDescription(offer);
          safeEmit('signal', { to: partnerId, data: offer });
        } catch {} finally {
          makingOffer = false;
        }
      };
    } catch {
      throw new Error('Failed to create peer connection');
    }
  }
  // ---------------------- KEEPALIVE ----------------------
  let pingTimer = null;
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
      } catch {}
    };
    dc.onclose = () => stopPingLoop();
    dc.onerror = () => stopPingLoop();
  }
  function startPingLoop() {
    stopPingLoop();
    pingTimer = setInterval(() => {
      if (!keepAliveChannel || keepAliveChannel.readyState !== 'open') {
        stopPingLoop();
        return;
      }
      try {
        keepAliveChannel.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      } catch {
        stopPingLoop();
      }
      if (Date.now() - lastPong > PONG_TIMEOUT) {
        stopPingLoop();
        cleanupConnection();
        clearSafeTimer(searchTimer);
        clearSafeTimer(pauseTimer);
        consecutiveSearchFails = 0;
        normalPauseDuration = 3000;
        setSafeTimer(startSearchLoop, 500);
      }
    }, PING_INTERVAL);
  }
  function stopPingLoop() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }
  // ---------------------- STATS MONITOR ----------------------
  function startStatsMonitor() {
    stopStatsMonitor();
    statsInterval = setInterval(async () => {
      if (!peerConnection || peerConnection.connectionState !== 'connected') {
        stopStatsMonitor();
        return;
      }
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
        if (outboundVideoReport?.packetsSent > 0) {
          if (remoteInboundRtp?.packetsLost >= 0) {
            const lost = remoteInboundRtp.packetsLost;
            const sent = (remoteInboundRtp.packetsReceived || 0) + lost;
            lossRatio = sent > 0 ? lost / sent : 0;
          } else if (outboundVideoReport.packetsLost >= 0) {
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
      } catch {}
    }, STATS_POLL_MS);
  }
  function stopStatsMonitor() {
    if (statsInterval) {
      clearInterval(statsInterval);
      statsInterval = null;
    }
  }
  // ---------------------- EXIT ----------------------
  exitBtn.onclick = () => {
    cleanupConnection();
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    location.href = 'index.html';
  };
  // ---------------------- MEDIA INIT ----------------------
  async function initMedia() {
    if (isBanned) {
      updateStatusMessage('⛔ You have been banned for 24 hours 🕐 for engaging in inappropriate behavior 🚫 and violating our policy terms 📜. ⚠️');
      return false;
    }
    if (localStream) return true;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
      updateMicButton();
      return true;
    } catch {
      updateStatusMessage('Camera/Mic access denied. Please check permissions.');
      localStream = null;
      updateMicButton();
      return false;
    }
  }
  // ---------------------- AUTO START ----------------------
  async function initialize() {
    ensureNotifyEmpty();
    updateMicButton();
    try {
      const fingerprint = await generateFingerprint();
      safeEmit('identify', { fingerprint });
    } catch {}
    startSearch();
  }
  initialize();
  // ---------------------- GLOBAL ERROR HANDLERS ----------------------
  window.addEventListener('error', () => {
    updateStatusMessage('An unexpected error occurred. Refreshing...');
    setSafeTimer(() => location.reload(), 3000);
  });
  window.addEventListener('unhandledrejection', () => {
    updateStatusMessage('Connection error detected. Recovering...');
    setSafeTimer(startSearchLoop, 1000);
  });
  window.onbeforeunload = () => {
    safeEmit('stop');
    cleanupConnection();
    if (localStream) localStream.getTracks().forEach(t => t.stop());
  };
});
