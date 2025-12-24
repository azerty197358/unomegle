<script>
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
    'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251221_153328953.mp4',
    'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251221_153328953.mp4',
    'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251224_122947959.mp4',
    'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251224_123428027.mp4'
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
    adVideo.style.position = 'absolute';
    adVideo.style.top = '0';
    adVideo.style.left = '0';
    adVideo.style.width = '100%';
    adVideo.style.height = '100%';
    adVideo.style.objectFit = 'cover';
    adVideo.style.zIndex = '100';
    adVideo.style.display = 'none';
    adVideo.style.backgroundColor = '#000';
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

  // متغيرات جديدة للتحقق من جاهزية الشريك
  let partnerReady = false;        // هل أرسل الشريك إشارة "partner-ready"
  let localReadySent = false;      // هل أرسلنا إشارة "partner-ready" بالفعل

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
          hash = ((hash << 5) - hash) + str.charCodeAt(i);
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
    activeTimers.forEach(id => clearTimeout(id));
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
    if (!statusMsg) {
      statusMsg = document.createElement('div');
      statusMsg.id = 'statusMessage';
      statusMsg.className = 'msg status';
      chatMessages.appendChild(statusMsg);
    }
    statusMsg.textContent = msg;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function showRemoteSpinnerOnly(show) {
    if (remoteSpinner) remoteSpinner.style.display = show ? 'block' : 'none';
    if (remoteVideo) remoteVideo.style.display = show ? 'none' : 'block';
  }

  function hideAllSpinners() {
    if (remoteSpinner) remoteSpinner.style.display = 'none';
    if (remoteVideo) remoteVideo.style.display = 'block';
    if (localVideo) localVideo.style.display = 'block';
  }

  function bufferRemoteCandidate(candidateObj) {
    bufferedRemoteCandidates.push(candidateObj);
  }

  function flushBufferedCandidates() {
    while (bufferedRemoteCandidates.length && peerConnection) {
      const c = bufferedRemoteCandidates.shift();
      try { peerConnection.addIceCandidate(c).catch(() => {}); } catch (e) {}
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

  // ---------------------- إعلان ----------------------
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
    isAdPlaying = true;
    const adUrl = adVideosList[currentAdIndex];
    currentAdIndex = (currentAdIndex + 1) % adVideosList.length;

    updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger Say hello 😊🤝');
    adVideo.onerror = () => { console.error('Ad load error'); hideAdVideo(); };
    adVideo.oncanplay = () => adVideo.play().catch(() => {});
    adVideo.onended = hideAdVideo;
    adVideo.src = adUrl;
    adVideo.style.display = 'block';
    remoteVideo.style.display = 'none';

    const adTimeout = setSafeTimer(hideAdVideo, 50000);

    function hideAdVideo() {
      if (!isAdPlaying) return;
      clearSafeTimer(adTimeout);
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

  // ---------------------- CONNECTION CLEANUP مع إعادة محاولة قوية ----------------------
  function cleanupConnection(andRestart = true) {
    console.log('Cleaning up connection...');
    clearAllTimers();

    if (keepAliveChannel) {
      keepAliveChannel.close();
      keepAliveChannel = null;
    }
    if (peerConnection) {
      try { peerConnection.close(); } catch (e) {}
      peerConnection = null;
    }
    if (remoteVideo) remoteVideo.srcObject = null;

    bufferedRemoteCandidates.length = 0;
    partnerId = null;
    isInitiator = false;
    makingOffer = false;
    ignoreOffer = false;
    partnerReady = false;
    localReadySent = false;

    if (andRestart && !isBanned && !isAdPlaying) {
      setSafeTimer(() => startSearchLoop(), 500);
    }
  }

  // ---------------------- TYPING & CHAT ----------------------
  const typingIndicator = document.createElement('div');
  typingIndicator.className = 'msg system';
  typingIndicator.style.fontStyle = 'italic';
  typingIndicator.textContent = 'Stranger is typing...';
  typingIndicator.style.display = 'none';
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

  chatInput.oninput = () => { if (!chatInput.disabled && !isBanned) sendTyping(); };

  function sendMessage() {
    if (isBanned || !partnerId) return;
    const msg = chatInput.value.trim();
    if (!msg) return;
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
  }
  micBtn.onclick = () => {
    if (!localStream || isBanned) return;
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    updateMicButton();
  };

  // ---------------------- REPORT ----------------------
  reportBtn.onclick = async () => {
    if (!partnerId) return;
    reportedIds.add(partnerId);
    reportCounts.set(partnerId, (reportCounts.get(partnerId) || 0) + 1);
    safeEmit("report", { partnerId });
    safeEmit("skip");

    try {
      addMessage("Capturing screenshot...", "system");
      const image = await captureRemoteVideoFrame();
      safeEmit("admin-screenshot", { image, partnerId });
      addMessage("📋 Report sent ✉️⚠️", "system");
    } catch (e) {
      addMessage("Failed to capture screenshot.", "system");
    }

    cleanupConnection();
    disableChat();
    updateStatusMessage('Reported — skipping...');
    consecutiveSearchFails = 0;
    startSearchLoop();
  };

  function captureRemoteVideoFrame() {
    return new Promise((resolve, reject) => {
      const v = remoteVideo;
      if (!v || !v.srcObject || v.videoWidth === 0) return reject();
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      canvas.getContext('2d').drawImage(v, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    });
  }

  function enableChat() { chatInput.disabled = sendBtn.disabled = isBanned; }
  function disableChat() { chatInput.disabled = sendBtn.disabled = true; }

  // ---------------------- MATCHMAKING مع تحقق جاهزية الشريك ----------------------
  function startSearchLoop() {
    if (isBanned || partnerId || isAdPlaying) return;
    showRemoteSpinnerOnly(true);
    updateStatusMessage('Searching...');
    safeEmit('find-partner');

    clearSafeTimer(searchTimer);
    searchTimer = setSafeTimer(() => {
      if (partnerId || isAdPlaying) return;
      safeEmit('stop');
      showRemoteSpinnerOnly(false);
      consecutiveSearchFails++;
      if (consecutiveSearchFails >= 3) return playAdVideo();

      clearSafeTimer(pauseTimer);
      pauseTimer = setSafeTimer(startSearchLoop, normalPauseDuration);
    }, 3500);
  }

  async function startSearch() {
    if (isBanned) {
      updateStatusMessage('⛔ Banned for 24 hours');
      return;
    }
    const ok = await initMedia();
    if (!ok) return;

    cleanupConnection(false);
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
    updateStatusMessage('Skipped.');
    disableChat();
    cleanupConnection();
    consecutiveSearchFails = 0;
    startSearchLoop();
  };

  // ---------------------- MEDIA INIT ----------------------
  async function initMedia() {
    if (localStream) return true;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
      updateMicButton();
      return true;
    } catch (e) {
      updateStatusMessage('📹🎤 Allow camera & mic. Retrying...');
      setTimeout(() => initMedia(), 2000);
      return false;
    }
  }

  // ---------------------- إرسال إشارة الجاهزية بعد إعداد الـ stream ----------------------
  function sendLocalReadyIfPossible() {
    if (localReadySent || !localStream || !partnerId) return;
    // نتحقق أن الفيديو المحلي يحتوي على إطارات (videoWidth > 0)
    if (localVideo.videoWidth > 0) {
      safeEmit('partner-ready', { to: partnerId });
      localReadySent = true;
    } else {
      // ننتظر قليلاً ثم نحاول مرة أخرى
      setTimeout(sendLocalReadyIfPossible, 300);
    }
  }

  // ---------------------- SOCKET EVENTS ----------------------
  socket.on('partner-found', async data => {
    if (isBanned) { safeEmit('skip'); return; }
    const foundId = data?.id || data?.partnerId;
    if (!foundId || reportedIds.has(foundId)) {
      safeEmit('skip');
      setSafeTimer(startSearchLoop, 200);
      return;
    }

    partnerId = foundId;
    isInitiator = !!data.initiator;
    partnerReady = false;
    localReadySent = false;

    hideAllSpinners();
    updateStatusMessage('Connecting...');

    try {
      createPeerConnection();
      sendLocalReadyIfPossible(); // نحاول إرسال الجاهزية فوراً

      if (isInitiator) {
        makingOffer = true;
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        safeEmit('signal', { to: partnerId, data: offer });
        makingOffer = false;
      }
    } catch (e) {
      console.error('Partner found error:', e);
      cleanupConnection();
    }
  });

  // استقبال إشارة أن الشريك جاهز (كاميرته وبثه جاهز)
  socket.on('partner-ready', ({ from }) => {
    if (from !== partnerId) return;
    partnerReady = true;

    // إذا كنا نحن أيضاً جاهزين، نبدأ الاتصال الكامل
    if (localReadySent) {
      updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger Say hello 😊🤝');
      enableChat();
    }
  });

  socket.on('signal', async ({ from, data }) => {
    if (isBanned || from !== partnerId) return;

    if (!peerConnection) createPeerConnection();

    if (data.candidate && !peerConnection.remoteDescription) {
      bufferRemoteCandidate(data.candidate);
      return;
    }

    try {
      if (data.type === 'offer') {
        const offerCollision = makingOffer || peerConnection.signalingState !== 'stable';
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

      // بعد كل إشارة ناجحة نحاول إرسال جاهزيتنا
      sendLocalReadyIfPossible();
    } catch (e) {
      console.error('Signal error:', e);
      cleanupConnection(); // تخطي الاضطرابات
    }
  });

  // باقي الأحداث
  socket.on('waiting', msg => updateStatusMessage(msg));
  socket.on('chat-message', ({ message }) => addMessage(message, 'them'));
  socket.on('typing', () => { typingIndicator.style.display = 'block'; });
  socket.on('stop-typing', () => { typingIndicator.style.display = 'none'; });
  socket.on('partner-disconnected', () => {
    updateStatusMessage('Partner disconnected.');
    disableChat();
    cleanupConnection();
  });
  socket.on('banned', ({ message }) => {
    isBanned = true;
    addMessage(message || 'Banned.', 'system');
    updateStatusMessage('⛔ Banned for 24 hours');
    cleanupConnection(false);
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    localVideo.srcObject = null;
  });

  // ---------------------- WEBRTC ----------------------
  let pingTimer = null;

  function createPeerConnection() {
    if (peerConnection) peerConnection.close();
    peerConnection = new RTCPeerConnection(servers);

    if (localStream) localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));

    if (isInitiator) {
      keepAliveChannel = peerConnection.createDataChannel('keepAlive', { ordered: true });
      setupKeepAliveChannel(keepAliveChannel);
    } else {
      peerConnection.ondatachannel = ev => {
        keepAliveChannel = ev.channel;
        setupKeepAliveChannel(keepAliveChannel);
      };
    }

    peerConnection.ontrack = e => {
      if (e.streams[0]) {
        remoteVideo.srcObject = e.streams[0];
        flushBufferedCandidates();
        startStatsMonitor();

        // عند ظهور البث البعيد، نؤكد أن كلا الطرفين جاهزان
        if (partnerReady && localReadySent) {
          updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger Say hello 😊🤝');
          enableChat();
        }
      }
    };

    peerConnection.onicecandidate = e => {
      if (e.candidate && partnerId) safeEmit('signal', { to: partnerId, data: { candidate: e.candidate } });
    };

    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      if (state === 'connected') {
        if (partnerReady && localReadySent) {
          updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger Say hello 😊🤝');
          enableChat();
        }
      } else if (['disconnected', 'failed', 'closed'].includes(state)) {
        updateStatusMessage('Connection lost.');
        disableChat();
        cleanupConnection();
      }
    };

    peerConnection.onnegotiationneeded = async () => {
      if (makingOffer || !partnerId) return;
      try {
        makingOffer = true;
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        safeEmit('signal', { to: partnerId, data: offer });
      } catch (e) { console.error(e); } finally { makingOffer = false; }
    };
  }

  function setupKeepAliveChannel(dc) {
    dc.onopen = () => { lastPong = Date.now(); startPingLoop(); };
    dc.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'ping') dc.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        if (msg.type === 'pong') lastPong = Date.now();
      } catch (e) {}
    };
    dc.onclose = dc.onerror = () => stopPingLoop();
  }

  function startPingLoop() {
    stopPingLoop();
    pingTimer = setInterval(() => {
      if (!keepAliveChannel || keepAliveChannel.readyState !== 'open') return stopPingLoop();
      keepAliveChannel.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      if (Date.now() - lastPong > PONG_TIMEOUT) {
        stopPingLoop();
        cleanupConnection();
      }
    }, PING_INTERVAL);
  }

  function stopPingLoop() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  function startStatsMonitor() {
    stopStatsMonitor();
    statsInterval = setInterval(async () => {
      if (!peerConnection || peerConnection.connectionState !== 'connected') return stopStatsMonitor();
      // نفس الكود السابق لتعديل البِت ريت حسب الشبكة
      try {
        const stats = await peerConnection.getStats();
        // ... (الكود الأصلي للـ stats)
      } catch (e) {}
    }, STATS_POLL_MS);
  }

  function stopStatsMonitor() {
    if (statsInterval) clearInterval(statsInterval);
    statsInterval = null;
  }

  exitBtn.onclick = () => {
    cleanupConnection(false);
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    location.href = 'index.html';
  };

  // ---------------------- INITIALIZE ----------------------
  async function initialize() {
    updateMicButton();
    try {
      const fp = await generateFingerprint();
      safeEmit('identify', { fingerprint: fp });
    } catch (e) {}
    startSearch();
  }

  initialize();

  // ---------------------- ERROR HANDLING قوي ----------------------
  window.addEventListener('error', e => {
    console.error('Global error:', e.error);
    setSafeTimer(() => location.reload(), 5000);
  });

  window.addEventListener('unhandledrejection', e => {
    console.error('Unhandled rejection:', e.reason);
    cleanupConnection();
  });

  window.onbeforeunload = () => {
    safeEmit('stop');
    cleanupConnection(false);
  };
});
</script>
