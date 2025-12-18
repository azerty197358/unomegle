// file: public/js/webrtc-stable-client.js
// WebRTC client with enhanced connection management, error handling, and status-only updates
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
  // ---------------------- GLOBAL STATE ----------------------
  let localStream = null;
  let peerConnection = null;
  let partnerId = null;
  let isInitiator = false;
  let micEnabled = true;
  let autoReconnect = true;
  // Timer management
  const activeTimers = new Set();
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

  // ---------------------- BAN STATE ----------------------
  let isCurrentlyBanned = false; // متغير حالة الحظر الحالية

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
    } catch (e) {
      console.error('Fingerprint generation failed:', e);
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
      console.warn(`Socket not connected, cannot emit ${event}`);
      return false;
    } catch (e) {
      console.error(`Error emitting ${event}:`, e);
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
  function backoffDelay(attempt) {
    return Math.min(30000, Math.pow(2, attempt) * BASE_BACKOFF_MS + Math.floor(Math.random() * 500));
  }
  function bufferRemoteCandidate(candidateObj) {
    bufferedRemoteCandidates.push(candidateObj);
  }
  function flushBufferedCandidates() {
    while (bufferedRemoteCandidates.length && peerConnection) {
      const c = bufferedRemoteCandidates.shift();
      try {
        peerConnection.addIceCandidate(c).catch(() => {});
      } catch (e) {}
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
    } catch (e) {
      console.debug('setSenderMaxBitrate failed', e);
    }
  }

  // ---------------------- CONNECTION CLEANUP ----------------------
  function cleanupConnection() {
    console.log('Cleaning up connection...');
    clearAllTimers();
    if (peerConnection) {
      try {
        if (keepAliveChannel) {
          keepAliveChannel.close();
          keepAliveChannel = null;
        }
        peerConnection.close();
      } catch (e) {
        console.error('Error closing peer connection:', e);
      }
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
    if (!partnerId) return;
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
    if (!chatInput.disabled) sendTyping();
  };

  // ---------------------- SEND CHAT ----------------------
  function sendMessage() {
    const msg = chatInput.value.trim();
    if (!msg || !partnerId) return;
    addMessage(msg, 'you');
    safeEmit('chat-message', { to: partnerId, message: msg });
    chatInput.value = '';
    typing = false;
    safeEmit('stop-typing', { to: partnerId });
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
        if (!v || !v.srcObject) return reject(new Error('Remote video not available'));
        let width = v.videoWidth || v.clientWidth || 640;
        let height = v.videoHeight || v.clientHeight || 480;
        if (width === 0 || height === 0) {
          setTimeout(() => {
            width = v.videoWidth || v.clientWidth || 640;
            height = v.videoHeight || v.clientHeight || 480;
            if (width === 0 || height === 0) return reject(new Error('Remote video has no frames yet'));
            const canvas2 = document.createElement('canvas');
            canvas2.width = width;
            canvas2.height = height;
            const ctx2 = canvas2.getContext('2d');
            ctx2.drawImage(v, 0, 0, width, height);
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
      safeEmit("report", { partnerId });
      safeEmit("skip");
      if (now === 1) {
        try {
          addMessage("Capturing screenshot for admin review...", "system");
          const image = await captureRemoteVideoFrame();
          safeEmit("admin-screenshot", { image, partnerId });
          addMessage("Screenshot sent to admin.", "system");
        } catch (err) {
          console.error('Screenshot capture failed', err);
          addMessage("Failed to capture screenshot (no remote frame available).", "system");
        }
      }
      cleanupConnection();
      disableChat();
      updateStatusMessage('You reported the user — skipping...');
      clearSafeTimer(searchTimer);
      clearSafeTimer(pauseTimer);
      searchTimer = setSafeTimer(startSearchLoop, 300);
    };
  }

  // ---------------------- UI CONTROLS ----------------------
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
    if (partnerId || isCurrentlyBanned) return;
    showRemoteSpinnerOnly(true);
    updateStatusMessage('Searching...');
    safeEmit('find-partner');
    clearSafeTimer(searchTimer);
    searchTimer = setSafeTimer(() => {
      if (!partnerId) {
        safeEmit('stop');
        showRemoteSpinnerOnly(false);
        updateStatusMessage('Pausing...');
        clearSafeTimer(pauseTimer);
        pauseTimer = setSafeTimer(startSearchLoop, 1800);
      }
    }, 3500);
  }
  async function startSearch() {
    if (isCurrentlyBanned) return;
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
    startSearchLoop();
  }
  skipBtn.onclick = () => {
    safeEmit('skip');
    updateStatusMessage('You skipped.');
    disableChat();
    cleanupConnection();
    clearSafeTimer(searchTimer);
    clearSafeTimer(pauseTimer);
    startSearchLoop();
  };

  // ---------------------- BAN HANDLING ----------------------
  let banInterval = null;

  function clearBanState() {
    if (banInterval) {
      clearInterval(banInterval);
      banInterval = null;
    }
    localStorage.removeItem('banEndTime');
    isCurrentlyBanned = false;
  }

  function checkLocalBan() {
    const banEnd = localStorage.getItem('banEndTime');
    if (!banEnd) return false;
    const endTime = parseInt(banEnd, 10);
    if (isNaN(endTime)) {
      localStorage.removeItem('banEndTime');
      return false;
    }
    if (endTime < Date.now()) {
      clearBanState();
      return false;
    }
    return true;
  }

  function updateBanMessage() {
    const endTime = parseInt(localStorage.getItem('banEndTime') || '0', 10);
    const unblockTime = new Date(endTime).toLocaleString();
    const banMsg = document.getElementById('banMessage');
    if (banMsg) {
      banMsg.innerHTML = `<strong>تم حظرك لقد قمت بعمل جنسي</strong><br>سيفك حظرك في: ${unblockTime}`;
    }
  }

  function showBannedState() {
    isCurrentlyBanned = true;
    cleanupConnection();
    disableChat();
    if (skipBtn) skipBtn.disabled = true;
    if (micBtn) micBtn.disabled = true;
    if (reportBtn) reportBtn.disabled = true;
    showRemoteSpinnerOnly(false);
    hideAllSpinners();

    const existingStatus = document.getElementById('statusMessage');
    if (existingStatus) existingStatus.remove();

    chatMessages.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'msg system';
    msg.id = 'banMessage';
    msg.style.textAlign = 'center';
    msg.style.fontSize = '1.2em';
    msg.style.color = '#ff4444';
    chatMessages.appendChild(msg);
    updateBanMessage();

    if (banInterval) clearInterval(banInterval);
    banInterval = setInterval(() => {
      if (!checkLocalBan()) {
        clearInterval(banInterval);
        banInterval = null;
        resumeFromBan();
      } else {
        updateBanMessage();
      }
    }, 1000);
  }

  function resumeFromBan() {
    clearBanState();
    addMessage('تم فك الحظر عنك بواسطة الإدارة أو انتهت مدة الحظر. مرحباً بعودتك!', 'system');
    updateStatusMessage('جاري البحث عن شريك...');
    startSearch();
  }

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

  // عند استلام banned من السيرفر (حظر جديد)
  socket.on('banned', ({ duration = 24 * 60 * 60 * 1000 }) => {
    localStorage.setItem('banEndTime', Date.now() + duration);
    showBannedState();
  });

  // عند استلام unbanned من السيرفر (فك حظر فوري)
  socket.on('unbanned', () => {
    resumeFromBan();
  });

  socket.on('partner-disconnected', () => {
    updateStatusMessage('Partner disconnected.');
    disableChat();
    cleanupConnection();
    reconnectAttempts = 0;
    clearSafeTimer(searchTimer);
    clearSafeTimer(pauseTimer);
    setSafeTimer(startSearchLoop, 500);
  });

  // باقي الأحداث كما هي...
  socket.on('partner-found', async data => {
    if (isCurrentlyBanned) return; // حماية إضافية
    const foundId = data?.id || data?.partnerId;
    if (!foundId) {
      console.error('Invalid partner data received:', data);
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
    try {
      createPeerConnection();
      if (isInitiator) {
        makingOffer = true;
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        safeEmit('signal', { to: partnerId, data: offer });
      }
    } catch (e) {
      console.error('Failed to create peer connection or offer:', e);
      updateStatusMessage('Connection setup failed. Retrying...');
      cleanupConnection();
      setSafeTimer(startSearchLoop, 1000);
    } finally {
      makingOffer = false;
    }
  });

  socket.on('signal', async ({ from, data }) => {
    if (isCurrentlyBanned) return;
    if (!from || !data) {
      console.error('Invalid signal data:', { from, data });
      return;
    }
    if (partnerId && partnerId !== from) {
      console.warn('Signal from unexpected partner:', from, 'expected:', partnerId);
      return;
    }
    if (!peerConnection) {
      try {
        createPeerConnection();
      } catch (e) {
        console.error('Failed to create peer connection for signal:', e);
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
    } catch (e) {
      console.error('Signal handling error:', e);
      updateStatusMessage('Signal processing failed.');
    }
  });

  // ---------------------- WEBRTC (باقي الكود بدون تغيير) ----------------------
  // ... (جميع دوال WebRTC كما هي في الكود الأصلي)

  // ---------------------- AUTO START ----------------------
  async function initialize() {
    ensureNotifyEmpty();
    updateMicButton();

    try {
      const fingerprint = await generateFingerprint();
      safeEmit('identify', { fingerprint });
    } catch (e) {
      console.error('Failed to send fingerprint:', e);
    }

    // التحقق من الحظر المحلي فقط عند التحميل الأولي
    if (checkLocalBan()) {
      showBannedState();
    } else {
      startSearch();
    }
  }
  initialize();

  // ---------------------- GLOBAL ERROR HANDLERS ----------------------
  window.addEventListener('error', (e) => {
    console.error('Global error:', e.error);
    updateStatusMessage('An unexpected error occurred. Refreshing...');
    setSafeTimer(() => location.reload(), 3000);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled promise rejection:', e.reason);
    updateStatusMessage('Connection error detected. Recovering...');
    if (autoReconnect && !partnerId) {
      setSafeTimer(startSearchLoop, 1000);
    }
  });
  window.onbeforeunload = () => {
    safeEmit('stop');
    cleanupConnection();
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
    }
  };
});
