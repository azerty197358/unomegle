// file: public/js/webrtc-stable-client.js   
// TL;DR: WebRTC client with adaptive bitrate, ICE-restart, keepalive, candidate buffering, and reconnect backoff.

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
        // apply single encoding maxBitrate
        params.encodings = params.encodings.map(enc => ({ ...enc, maxBitrate: targetBps }));
        await sender.setParameters(params);
      }
    } catch (e) {
      // some browsers don't support setParameters; ignore gracefully
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
    partnerId = null;
    clearTimeout(searchTimer);
    clearTimeout(pauseTimer);
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
    startSearchLoop();
  });

  socket.on('partner-found', async data => {
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
    // handle incoming signal (offer/answer/candidate)
    if (!peerConnection) createPeerConnection();

    // candidates may come before pc is ready: buffer them
    if (data && data.candidate && !peerConnection.remoteDescription) {
      bufferRemoteCandidate(data.candidate);
      return;
    }

    try {
      if (data.type === 'offer') {
        const offerCollision = (makingOffer || peerConnection.signalingState !== 'stable');
        ignoreOffer = !isInitiator && offerCollision;
        if (ignoreOffer) {
          // let the other side continue or resolve glare
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

  // ---------------------- WEBRTC ----------------------
  function createPeerConnection() {
    // cleanup old if any
    if (peerConnection) {
      try { peerConnection.close(); } catch (e) {}
      peerConnection = null;
    }

    peerConnection = new RTCPeerConnection(servers);
    makingOffer = false;
    ignoreOffer = false;

    // add local tracks
    if (localStream) {
      localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    }

    // create datachannel when initiator
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
      // flush any buffered candidates now that remoteDescription likely set
      flushBufferedCandidates();
      // reset reconnect attempts
      reconnectAttempts = 0;
      // start stats monitor
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
        // try ICE restart first, else rematch
        if (autoReconnect) attemptRecovery();
      }
    };

    peerConnection.oniceconnectionstatechange = async () => {
      const s = peerConnection.iceConnectionState;
      console.debug('iceConnectionState', s);
      if (s === 'failed') {
        // try ICE restart
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
      // give up and rematch
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
    statusText.textContent = `Reconnecting... attempt ${reconnectAttempts}`;
    setTimeout(async () => {
      try {
        if (!peerConnection) {
          // try to recreate with same local tracks and new PC, then ICE restart
          createPeerConnection();
          if (isInitiator) {
            makingOffer = true;
            const offer = await peerConnection.createOffer({ iceRestart: true });
            await peerConnection.setLocalDescription(offer);
            socket.emit('signal', { to: partnerId, data: offer });
          } else {
            // Non-initiator waits for remote to restart, but proactively try negotiation if allowed:
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

  // iceRestart wrapper with backoff guard
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

  // perform iceRestart: createOffer({iceRestart:true}) and send
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

  // another helper to attempt ice restart only if signalling state allows
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
      // start periodic ping
      startPingLoop();
    };
    dc.onmessage = (ev) => {
      if (!ev.data) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'ping') {
          // reply with pong
          dc.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        } else if (msg.type === 'pong') {
          lastPong = Date.now();
        }
      } catch (e) {}
    };
    dc.onclose = () => {
      // closed -> treat as potential issue
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
        // channel not available => can't rely on it
        return;
      }
      // send ping
      try {
        keepAliveChannel.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      } catch (e) {}
      // if no pong within timeout -> try recovery
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
        let remoteInboundRtp = null; // sometimes available as remote-inbound-rtp
        stats.forEach(report => {
          if (report.type === 'outbound-rtp' && report.kind === 'video') {
            outboundVideoReport = report;
          }
          if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
            remoteInboundRtp = report;
          }
        });

        // compute packet loss ratio if possible
        let lossRatio = 0;
        if (outboundVideoReport && typeof outboundVideoReport.packetsSent === 'number') {
          // try to get remotes if available
          // fallback: use remoteInboundRtp for packetsLost
          if (remoteInboundRtp && typeof remoteInboundRtp.packetsLost === 'number') {
            const lost = remoteInboundRtp.packetsLost;
            const sent = remoteInboundRtp.packetsReceived + lost || 1;
            lossRatio = lost / sent;
          } else if ('packetsLost' in outboundVideoReport) {
            lossRatio = outboundVideoReport.packetsLost / Math.max(1, outboundVideoReport.packetsSent);
          }
        }

        // RTT / jitter checks
        let rtt = 0;
        stats.forEach(r => { if (r.type === 'candidate-pair' && r.currentRtt) rtt = r.currentRtt; });

        // Decide bitrate level based on metrics
        if (lossRatio > 0.08 || rtt > 0.5) {
          // high loss or high rtt -> low bitrate
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
  };

  // ---------------------- UTILITY: Start/Stop Ping & Stats on PC close ----------------------
  const origPCClose = () => {
    stopPingLoop();
    stopStatsMonitor();
  };
  // ensure we stop timers when peerConnection closed explicitly elsewhere
  // (we already stop in the onconnectionstatechange handlers above)

});
