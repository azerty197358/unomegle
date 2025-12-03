// File: public/js/room-client.js
// Description: Client-side room logic with country-ban overlay and resilient WebRTC/signaling behavior.

window.addEventListener('DOMContentLoaded', () => {

  /* ============================
     Dependencies / Socket init
     ============================ */
  const socket = io();

  /* ============================
     DOM ELEMENTS
     ============================ */
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

  /* ============================
     GLOBAL STATE
     ============================ */
  let localStream = null;
  let peerConnection = null;
  let partnerId = null;
  let isInitiator = false;

  let micEnabled = true;
  let autoReconnect = true;

  // Adaptive search backoff (ms)
  let searchAttempt = 0;
  const SEARCH_BASE = 1500;
  const SEARCH_MAX = 20000;

  let searchTimer = null;
  let pauseTimer = null;

  const servers = { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };

  const reportedIds = new Set();
  const reportCounts = new Map();

  // For robust signaling & ICE candidate handling
  let signalQueue = []; // {to, data, tries}
  const SIGNAL_MAX_RETRIES = 6;

  let candidateQueue = []; // candidates received before remoteDescription set

  /* ============================
     UTILS / UI HELPERS
     ============================ */

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

  // Full-screen red overlay for banned-country / critical notices
  let banOverlay = null;
  function ensureBanOverlay() {
    if (banOverlay) return;
    banOverlay = document.createElement('div');
    banOverlay.id = 'banOverlay';
    banOverlay.style.position = 'fixed';
    banOverlay.style.left = '0';
    banOverlay.style.top = '0';
    banOverlay.style.width = '100%';
    banOverlay.style.height = '100%';
    banOverlay.style.zIndex = '9999';
    banOverlay.style.display = 'none';
    banOverlay.style.justifyContent = 'center';
    banOverlay.style.alignItems = 'center';
    banOverlay.style.backgroundColor = 'rgba(200,0,0,0.95)';
    banOverlay.style.color = '#fff';
    banOverlay.style.textAlign = 'center';
    banOverlay.style.padding = '20px';
    banOverlay.style.boxSizing = 'border-box';
    banOverlay.innerHTML = `
      <div style="max-width:900px;">
        <h1 id="banHeader" style="color:#ffdddd;font-size:2.4rem;margin-bottom:0.5rem;">الموقع محظور في بلدك</h1>
        <p id="banMsg" style="color:#ffeeee;font-size:1.2rem;margin-bottom:1.2rem;">لا يمكنك استخدام هذه الخدمة من موقعك الحالي.</p>
        <button id="banExitBtn" style="font-size:1rem;padding:0.6rem 1rem;border-radius:6px;border:none;cursor:pointer;">العودة للرئيسية</button>
      </div>
    `;
    document.body.appendChild(banOverlay);
    document.getElementById('banExitBtn').onclick = () => { location.href = 'index.html'; };
  }

  function showBanOverlay(message) {
    ensureBanOverlay();
    const msgEl = document.getElementById('banMsg');
    if (msgEl && message) msgEl.textContent = message;
    banOverlay.style.display = 'flex';
  }

  function hideBanOverlay() {
    if (banOverlay) banOverlay.style.display = 'none';
  }

  function updateMicButton() {
    micBtn.textContent = micEnabled ? '🎤' : '🔇';
    micBtn.disabled = !localStream;
    micBtn.style.opacity = localStream ? '1' : '0.6';
  }

  function enableChat() {
    chatInput.disabled = false;
    sendBtn.disabled = false;
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

  /* ============================
     NETWORK / SIGNALING RESILIENCE
     ============================ */

  function enqueueSignal(item) {
    // item: { to, data }
    signalQueue.push({ ...item, tries: 0, lastTry: 0 });
    processSignalQueue();
  }

  function processSignalQueue() {
    if (!socket || !socket.connected) return;
    const now = Date.now();
    // iterate and send items that are allowed to try
    for (let i = signalQueue.length - 1; i >= 0; i--) {
      const it = signalQueue[i];
      if (it.tries >= SIGNAL_MAX_RETRIES) {
        // drop it to avoid infinite loop
        signalQueue.splice(i, 1);
        continue;
      }
      // exponential backoff between retries
      const backoff = Math.min(1000 * Math.pow(2, it.tries), 10000);
      if (now - (it.lastTry || 0) < backoff) continue;
      try {
        socket.emit('signal', { to: it.to, data: it.data });
        it.tries++;
        it.lastTry = now;
        // remove completed if it's an ACK-based pattern is not available;
        // we keep it to retry a few times in unreliable networks
        if (it.tries >= SIGNAL_MAX_RETRIES) signalQueue.splice(i, 1);
      } catch (e) {
        // leave for retry
      }
    }
  }

  // process queued signals periodically
  setInterval(processSignalQueue, 1200);

  /* ============================
     SCREENSHOT UTIL
     ============================ */

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

  /* ============================
     REPORT BUTTON
     ============================ */
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
      try { socket.emit("report", { partnerId }); } catch (e) {}
      try { socket.emit("skip"); } catch (e) {}
      if (now >= 1) { // keep threshold small for client-side example
        try {
          addMessage("Capturing screenshot for admin review...", "system");
          const image = await captureRemoteVideoFrame();
          socket.emit("admin-screenshot", { image, partnerId });
          addMessage("Screenshot sent to admin.", "system");
        } catch (err) {
          addMessage("Failed to capture screenshot (no remote frame available).", "system");
        }
      }
      closeAndCleanup();
      statusText.textContent = 'You reported the user — skipping...';
      clearTimeout(searchTimer);
      clearTimeout(pauseTimer);
      searchAttempt = 0;
      searchTimer = setTimeout(startSearchLoop, 300);
    };
  }

  /* ============================
     CLEANUP / BAN HANDLING
     ============================ */

  function disableAllScreens() {
    // Hide videos and UI, stop media
    if (localVideo) localVideo.style.display = 'none';
    if (remoteVideo) remoteVideo.style.display = 'none';
    if (localSpinner) localSpinner.style.display = 'none';
    if (remoteSpinner) remoteSpinner.style.display = 'none';
    disableChat();
    skipBtn.disabled = true;
    reportBtn && (reportBtn.disabled = true);
    micBtn && (micBtn.disabled = true);
  }

  function closeAndCleanup() {
    // stop media and close connection
    try {
      if (localStream) {
        localStream.getTracks().forEach(t => {
          try { t.stop(); } catch (e) {}
        });
      }
    } catch (e) {}
    localStream = null;

    if (peerConnection) {
      try { peerConnection.close(); } catch (e) {}
      peerConnection = null;
    }
    partnerId = null;
    candidateQueue = [];
    signalQueue = [];
    disableAllScreens();
  }

  socket.on('banned-country', ({ message }) => {
    addMessage(message || 'Blocked by country policy.', 'system');
    showBanOverlay(message || 'الموقع محظور في بلدك.');
    closeAndCleanup();
    statusText.textContent = 'Blocked.';
  });

  // legacy 'banned' event handling from existing server code
  socket.on('banned', ({ message }) => {
    addMessage(message || 'You are banned.', 'system');
    showBanOverlay(message || 'الموقع محظور في بلدك.');
    closeAndCleanup();
    statusText.textContent = 'Blocked.';
  });

  /* ============================
     TYPING INDICATOR & CHAT
     ============================ */

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
      try { socket.emit('typing', { to: partnerId }); } catch (e) {}
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      typing = false;
      try { socket.emit('stop-typing', { to: partnerId }); } catch (e) {}
    }, TYPING_PAUSE);
  }

  chatInput.oninput = () => {
    if (!chatInput.disabled) sendTyping();
  };

  function sendMessage() {
    const msg = chatInput.value.trim();
    if (!msg || !partnerId) return;
    addMessage(msg, 'you');
    try { socket.emit('chat-message', { to: partnerId, message: msg }); } catch (e) {}
    chatInput.value = '';
    typing = false;
    try { socket.emit('stop-typing', { to: partnerId }); } catch (e) {}
  }

  sendBtn.onclick = sendMessage;
  chatInput.onkeypress = e => { if (e.key === 'Enter') sendMessage(); };

  /* ============================
     MIC CONTROL
     ============================ */

  micBtn.onclick = () => {
    if (!localStream) return alert('Microphone not ready yet.');
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    updateMicButton();
  };

  try { if (localSpinner) localSpinner.style.display = 'none'; } catch(e) {}

  /* ============================
     MATCHMAKING / SEARCH LOOP (adaptive)
     ============================ */

  function computeSearchDelay(attempt) {
    // exponential backoff with jitter
    const base = Math.min(SEARCH_BASE * Math.pow(1.8, attempt), SEARCH_MAX);
    const jitter = Math.floor(Math.random() * Math.min(800, base * 0.25));
    return base + jitter;
  }

  function startSearchLoop() {
    if (partnerId) return;
    showRemoteSpinnerOnly(true);
    statusText.textContent = 'Searching...';

    try { socket.emit('find-partner'); } catch (e) {}

    clearTimeout(searchTimer);
    const timeout = 6000 + Math.min(4000 * searchAttempt, 12000); // wait longer for pairing under slow networks
    searchTimer = setTimeout(() => {
      if (!partnerId) {
        try { socket.emit('stop'); } catch (e) {}
        showRemoteSpinnerOnly(false);
        statusText.textContent = 'Pausing...';
        // schedule next search with backoff
        searchAttempt = Math.min(searchAttempt + 1, 8);
        clearTimeout(pauseTimer);
        pauseTimer = setTimeout(() => {
          startSearchLoop();
        }, computeSearchDelay(searchAttempt));
      }
    }, timeout);
  }

  async function startSearch() {
    const ok = await initMedia();
    if (!ok) return;
    partnerId = null;
    isInitiator = false;
    chatMessages.innerHTML = '';
    chatMessages.appendChild(typingIndicator);
    showRemoteSpinnerOnly(true);
    skipBtn.disabled = false;
    searchAttempt = 0;
    startSearchLoop();
  }

  skipBtn.onclick = () => {
    try { socket.emit('skip'); } catch (e) {}
    statusText.textContent = 'You skipped.';
    disableChat();
    if (peerConnection) {
      try { peerConnection.close(); } catch (e) {}
      peerConnection = null;
    }
    partnerId = null;
    clearTimeout(searchTimer);
    clearTimeout(pauseTimer);
    startSearchLoop();
  };

  /* ============================
     SOCKET EVENTS
     ============================ */

  socket.on('connect', () => {
    addMessage('Connected to signalling server.', 'system');
    statusText.textContent = 'Online';
    // try to flush any pending signals
    processSignalQueue();
  });

  socket.on('disconnect', (reason) => {
    addMessage('Disconnected from server.', 'system');
    statusText.textContent = 'Offline';
  });

  socket.on('connect_error', (err) => {
    addMessage('Connection error to signalling server.', 'system');
    statusText.textContent = 'Connection error';
  });

  socket.on('waiting', msg => { statusText.textContent = msg; });

  socket.on('chat-message', ({ message }) => { addMessage(message, 'them'); });

  socket.on('typing', () => { typingIndicator.style.display = 'block'; chatMessages.scrollTop = chatMessages.scrollHeight; });

  socket.on('stop-typing', () => { typingIndicator.style.display = 'none'; });

  socket.on('adminMessage', msg => {
    if (notifyDot) notifyDot.style.display = 'block';
    notifyBell.classList.add('shake');
    pushAdminNotification('📢 ' + msg);
    addMessage('📢 Admin: ' + msg, 'system');
  });

  socket.on('partner-disconnected', () => {
    statusText.textContent = 'Partner disconnected.';
    disableChat();
    partnerId = null;
    if (peerConnection) {
      try { peerConnection.close(); } catch (e) {}
      peerConnection = null;
    }
    clearTimeout(searchTimer);
    clearTimeout(pauseTimer);
    searchAttempt = 0;
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
    if (isInitiator) {
      try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        enqueueSignal({ to: partnerId, data: offer });
      } catch (e) {
        console.error('Offer failed', e);
        addMessage('Failed to create offer. Retrying...', 'system');
      }
    }
  });

  socket.on('signal', async ({ from, data }) => {
    if (!peerConnection) createPeerConnection();
    try {
      if (data.type === 'offer') {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data));
        // drain any queued candidates
        while (candidateQueue.length) {
          const c = candidateQueue.shift();
          try { await peerConnection.addIceCandidate(c); } catch (err) { console.warn('Late candidate rejected', err); }
        }
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        enqueueSignal({ to: from, data: answer });
      } else if (data.type === 'answer') {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data));
        // drain queued candidates
        while (candidateQueue.length) {
          const c = candidateQueue.shift();
          try { await peerConnection.addIceCandidate(c); } catch (err) { console.warn('Late candidate rejected', err); }
        }
      } else if (data.candidate) {
        const cand = new RTCIceCandidate(data.candidate);
        // if remoteDescription not set yet, queue candidate
        if (!peerConnection.remoteDescription || !peerConnection.remoteDescription.type) {
          candidateQueue.push(cand);
        } else {
          await peerConnection.addIceCandidate(cand);
        }
      }
    } catch (e) {
      console.error('Signal handling error', e);
    }
  });

  /* ============================
     WEBRTC CORE (robust)
     ============================ */

  function createPeerConnection() {
    peerConnection = new RTCPeerConnection(servers);

    // Add local tracks if available
    if (localStream) {
      localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    }

    // remote track
    peerConnection.ontrack = e => {
      try {
        remoteVideo.srcObject = e.streams[0];
      } catch (err) {}
      enableChat();
      addMessage('Connected with a stranger!', 'system');
      showRemoteSpinnerOnly(false);
    };

    // ICE candidate produced locally
    peerConnection.onicecandidate = e => {
      if (e.candidate) {
        // send candidate via reliable queue
        enqueueSignal({ to: partnerId, data: { candidate: e.candidate } });
      }
    };

    peerConnection.onconnectionstatechange = async () => {
      const s = peerConnection.connectionState;
      if (['disconnected', 'failed', 'closed'].includes(s)) {
        disableChat();
        statusText.textContent = 'Connection lost.';
        // attempt iceRestart on failure
        if (s === 'failed' && autoReconnect && partnerId) {
          try {
            addMessage('Attempting ICE restart...', 'system');
            const offer = await peerConnection.createOffer({ iceRestart: true });
            await peerConnection.setLocalDescription(offer);
            enqueueSignal({ to: partnerId, data: offer });
            // give some time to recover; if still failing, cleanup occurs by onconnectionstatechange closure
            return;
          } catch (err) {
            console.warn('ICE restart failed', err);
          }
        }
        partnerId = null;
        if (peerConnection) {
          try { peerConnection.close(); } catch (e) {}
          peerConnection = null;
        }
        if (autoReconnect) {
          clearTimeout(searchTimer);
          clearTimeout(pauseTimer);
          searchAttempt = 0;
          startSearchLoop();
        }
      }
    };

    // keepalive datachannel optional (makes browsers keep connection more stable)
    try {
      const dc = peerConnection.createDataChannel('keepalive');
      dc.onopen = () => {};
      dc.onmessage = () => {};
    } catch (e) {}

    // catch unexpected errors
    peerConnection.onerror = (err) => {
      console.warn('PeerConnection error', err);
    };
  }

  /* ============================
     MEDIA INIT
     ============================ */

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

  /* ============================
     AUTO-START + Unload handling
     ============================ */

  ensureNotifyEmpty();
  updateMicButton();
  startSearch();

  window.onbeforeunload = () => {
    try { socket.emit('stop'); } catch (e) {}
    if (localStream) localStream.getTracks().forEach(t => t.stop());
  };

  /* ============================
     NETWORK AWARENESS
     ============================ */

  window.addEventListener('online', () => {
    addMessage('Network online. Trying to reconnect...', 'system');
    statusText.textContent = 'Online';
    // flush signals & try search again if idle
    processSignalQueue();
    if (!partnerId) {
      searchAttempt = 0;
      clearTimeout(searchTimer);
      clearTimeout(pauseTimer);
      startSearchLoop();
    }
  });

  window.addEventListener('offline', () => {
    addMessage('Network offline. Waiting...', 'system');
    statusText.textContent = 'Offline';
  });

  // periodic flush for queued signals
  setInterval(() => {
    if (socket && socket.connected) processSignalQueue();
  }, 2000);

});
