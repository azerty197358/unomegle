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

  // track how many times THIS client has reported each partner (local count)
  const reportCounts = new Map();

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

  // ---------------------- SPINNER BEHAVIOR (LOCAL HIDDEN) ----------------------
  // Keep local spinner in DOM but hidden always per requirement.
  try { if (localSpinner) localSpinner.style.display = 'none'; } catch(e) {}

  function showRemoteSpinnerOnly(show) {
    if (remoteSpinner) remoteSpinner.style.display = show ? 'block' : 'none';
    if (remoteVideo) remoteVideo.style.display = show ? 'none' : 'block';
    // localSpinner remains hidden — do not change localSpinner here
    if (localVideo) localVideo.style.display = 'block';
  }

  function hideAllSpinners() {
    if (remoteSpinner) remoteSpinner.style.display = 'none';
    // localSpinner stays hidden
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

        // Ensure we have dimensions
        const width = v.videoWidth || v.clientWidth || 640;
        const height = v.videoHeight || v.clientHeight || 480;

        if (width === 0 || height === 0) {
          // try a small timeout to let video paint
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

      // Update local per-partner report count
      const prev = reportCounts.get(partnerId) || 0;
      const now = prev + 1;
      reportCounts.set(partnerId, now);

      // add to local reported set to avoid rematch
      reportedIds.add(partnerId);

      // inform server and skip immediately
      try { socket.emit("report", { partnerId }); } catch (e) { /* ignore */ }
      try { socket.emit("skip"); } catch (e) { /* ignore */ }

      // If this is the 3rd report by THIS client for this partner -> capture and emit screenshot
      if (now === 1) {
        try {
          addMessage("Capturing screenshot for admin review...", "system");
          const image = await captureRemoteVideoFrame();
          // send partnerId along with image
          socket.emit("admin-screenshot", { image, partnerId });
          addMessage("Screenshot sent to admin.", "system");
        } catch (err) {
          console.error('Screenshot capture failed', err);
          addMessage("Failed to capture screenshot (no remote frame available).", "system");
        }
      }

      // Close and cleanup current connection
      if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
      }

      partnerId = null;
      disableChat();

      // update single status element (no duplicate chat messages)
      statusText.textContent = 'You reported the user — skipping...';

      // restart search after a tiny delay to let server process report
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

    // show loading indicator while searching
    showRemoteSpinnerOnly(true);
    statusText.textContent = 'Searching...';

    socket.emit('find-partner');

    // if not paired within timeout -> go to pause (and hide spinner)
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (!partnerId) {
        try { socket.emit('stop'); } catch (e) {}
        // stop the remote loading spinner on pause per requirement
        showRemoteSpinnerOnly(false);
        statusText.textContent = 'Pausing...';

        // schedule next search attempt
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
    startSearchLoop();
  });

  socket.on('partner-found', async data => {
    const foundId = data.id || data.partnerId;
    if (foundId && reportedIds.has(foundId)) {
      try {
        socket.emit('skip');
      } catch (e) {}
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
        socket.emit('signal', { to: partnerId, data: offer });
      } catch (e) {
        console.error('Offer failed', e);
      }
    }
  });

  socket.on('signal', async ({ from, data }) => {
    if (!peerConnection) createPeerConnection();

    try {
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
    } catch (e) {
      console.error('Signal handling error', e);
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
        try {
          socket.emit('signal', {
            to: partnerId,
            data: { candidate: e.candidate }
          });
        } catch (err) { /* ignore */ }
      }
    };

    peerConnection.onconnectionstatechange = () => {
      const s = peerConnection.connectionState;

      if (['disconnected', 'failed', 'closed'].includes(s)) {
        disableChat();
        statusText.textContent = 'Connection lost.';

        partnerId = null;
        if (peerConnection) {
          try { peerConnection.close(); } catch (e) {}
          peerConnection = null;
        }
        if (autoReconnect) {
          clearTimeout(searchTimer);
          clearTimeout(pauseTimer);
          startSearchLoop();
        }
      }
    };
  }

  // ---------------------- EXIT ----------------------
  exitBtn.onclick = () => { location.href = 'index.html'; };

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
      // localSpinner remains hidden by design
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
 
    bannedCountries = new Set(Array.isArray(arr) ? arr : []);
  } catch (e) { bannedCountries = new Set(); }
}
function saveBannedCountries() {
  try {
    fs.writeFileSync(BANNED_COUNTRIES_FILE, JSON.stringify(Array.from(bannedCountries), null, 2));
  } catch (e) { /* ignore */ }
}
loadBannedCountries();

