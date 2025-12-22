window.addEventListener('DOMContentLoaded', () => {
  const socket = io();

  // === العناصر ===
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

  // === فيديوهات الإعلانات ===
  const adVideosList = [
    'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251221_081055765.mp4',
    'https://raw.githubusercontent.com/azerty197358/myads/main/Single%20girl%20video%20chat%20-%20Video%20Calls%20Apps%20(360p%2C%20h264).mp4',
    'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251221_153328953.mp4'
  ];

  let currentAdIndex = 0;
  let isAdPlaying = false;
  let adVideo = null;

  function createAdVideoElement() {
    if (adVideo) adVideo.remove();
    adVideo = document.createElement('video');
    Object.assign(adVideo, {
      id: 'adVideo',
      autoplay: false,
      muted: true,
      playsInline: true,
      preload: 'auto'
    });
    Object.assign(adVideo.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      zIndex: '100',
      display: 'none',
      backgroundColor: '#000'
    });
    remoteVideo.parentNode.appendChild(adVideo);
  }
  createAdVideoElement();

  // === المتغيرات ===
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

  // === Helpers ===
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

  function addMessage(msg, type = 'system') {
    const d = document.createElement('div');
    d.className = `msg ${type}`;
    d.textContent = msg;
    chatMessages.appendChild(d);
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

  function setSafeTimer(callback, delay) {
    const id = setTimeout(() => {
      activeTimers.delete(id);
      callback();
    }, delay);
    activeTimers.add(id);
    return id;
  }

  function clearSafeTimer(id) {
    if (id) {
      clearTimeout(id);
      activeTimers.delete(id);
    }
  }

  function clearAllTimers() {
    activeTimers.forEach(id => clearTimeout(id));
    activeTimers.clear();
    if (statsInterval) clearInterval(statsInterval);
  }

  function enableChat() {
    chatInput.disabled = isBanned;
    sendBtn.disabled = isBanned;
  }

  function disableChat() {
    chatInput.disabled = true;
    sendBtn.disabled = true;
  }

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

  // === Advertisement ===
  function playAdVideo() {
    if (isAdPlaying || adVideosList.length === 0) {
      consecutiveSearchFails = 0;
      normalPauseDuration = 3000;
      updateStatusMessage('Searching...');
      startSearchLoop();
      return;
    }

    isAdPlaying = true;
    const adUrl = adVideosList[currentAdIndex];
    currentAdIndex = (currentAdIndex + 1) % adVideosList.length;

    updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger Say hello 😊🤝');

    adVideo.onerror = () => {
      console.error('Error loading ad video:', adUrl);
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
      adVideo.play().catch(console.warn);
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

  // === WebRTC ===
  function createPeerConnection() {
    if (peerConnection) {
      try { peerConnection.close(); } catch (e) {}
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
      } catch (e) {
        keepAliveChannel = null;
      }
    } else {
      peerConnection.ondatachannel = (ev) => {
        keepAliveChannel = ev.channel;
        setupKeepAliveChannel(keepAliveChannel);
      };
    }

    peerConnection.ontrack = (e) => {
      if (!e.streams || e.streams.length === 0) return;
      remoteVideo.srcObject = e.streams[0];
      enableChat();
      updateStatusMessage('Connected');
      showRemoteSpinnerOnly(false);
      flushBufferedCandidates();
      consecutiveSearchFails = 0;
      startStatsMonitor();
    };

    peerConnection.onicecandidate = (e) => {
      if (e.candidate && partnerId) {
        safeEmit('signal', { to: partnerId, data: { candidate: e.candidate } });
      }
    };

    peerConnection.onconnectionstatechange = () => {
      if (!peerConnection) return;
      const s = peerConnection.connectionState;
      if (['disconnected', 'failed', 'closed'].includes(s)) {
        if (!isBanned) {
          updateStatusMessage('Connection lost.');
          disableChat();
          cleanupConnection();
          clearSafeTimer(searchTimer);
          clearSafeTimer(pauseTimer);
          consecutiveSearchFails = 0;
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
      } catch (e) {
        console.error('Negotiation error:', e);
      } finally {
        makingOffer = false;
      }
    };
  }

  function cleanupConnection() {
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
  }

  function flushBufferedCandidates() {
    while (bufferedRemoteCandidates.length && peerConnection) {
      const c = bufferedRemoteCandidates.shift();
      peerConnection.addIceCandidate(c).catch(() => {});
    }
  }

  // === Matchmaking ===
  function startSearchLoop() {
    if (isBanned) {
      updateStatusMessage('⛔ You have been banned for 24 hours 🕐 for engaging in inappropriate behavior 🚫 and violating our policy terms 📜. ⚠️');
      showRemoteSpinnerOnly(false);
      return;
    }
    if (partnerId) return;
    showRemoteSpinnerOnly(true);
    updateStatusMessage('Searching...');
    safeEmit('find-partner');
    clearSafeTimer(searchTimer);
    searchTimer = setSafeTimer(() => {
      if (!partnerId) {
        safeEmit('stop');
        showRemoteSpinnerOnly(false);
        consecutiveSearchFails++;
        if (consecutiveSearchFails >= 3) {
          playAdVideo();
          return;
        }
        clearSafeTimer(pauseTimer);
        pauseTimer = setSafeTimer(() => {
          normalPauseDuration = 3000;
          startSearchLoop();
        }, normalPauseDuration);
      }
    }, 3500);
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

  // === Socket Events ===
  socket.on('waiting', (msg) => {
    if (!isBanned) updateStatusMessage(msg);
  });

  socket.on('partner-found', async (data) => {
    if (isBanned) {
      safeEmit('skip');
      return;
    }
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
    if (isBanned) return;
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

  // === Media Init ===
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
    } catch (e) {
      console.error('Media initialization error:', e);
      updateStatusMessage('Camera/Mic access denied. Please check permissions.');
      localStream = null;
      updateMicButton();
      return false;
    }
  }

  // === Chat ===
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
  chatInput.onkeypress = (e) => {
    if (e.key === 'Enter' && !isBanned) sendMessage();
  };

  // === Mic ===
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

  // === Exit ===
  exitBtn.onclick = () => {
    cleanupConnection();
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
    }
    location.href = 'index.html';
  };

  // === Initialize ===
  async function initialize() {
    updateMicButton();
    startSearch();
  }

  initialize();

  // === Global Error Handlers ===
  window.addEventListener('error', (e) => {
    console.error('Global error:', e.error);
    updateStatusMessage('An unexpected error occurred. Refreshing...');
    setSafeTimer(() => location.reload(), 3000);
  });

  window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled promise rejection:', e.reason);
    updateStatusMessage('Connection error detected. Recovering...');
    setSafeTimer(startSearchLoop, 1000);
  });

  window.onbeforeunload = () => {
    safeEmit('stop');
    cleanupConnection();
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
    }
  };
});
