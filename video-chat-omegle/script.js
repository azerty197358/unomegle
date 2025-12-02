// File: script.js (final version with full working chat)
// Minimal comments — only explain why for critical parts.

window.addEventListener('DOMContentLoaded', () => {

  const socket = io();

  // ---------------------- DOM ----------------------
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

  // container for available users listing (create if not present)
  let availableListContainer = document.getElementById('availableList');
  if (!availableListContainer) {
    availableListContainer = document.createElement('div');
    availableListContainer.id = 'availableList';
    availableListContainer.style.display = 'none';
    availableListContainer.style.position = 'absolute';
    availableListContainer.style.right = '8px';
    availableListContainer.style.top = '60px';
    availableListContainer.style.zIndex = '999';
    availableListContainer.style.maxHeight = '300px';
    availableListContainer.style.overflow = 'auto';
    availableListContainer.style.background = 'rgba(0,0,0,0.7)';
    availableListContainer.style.color = '#fff';
    availableListContainer.style.padding = '8px';
    availableListContainer.style.borderRadius = '6px';
    document.body.appendChild(availableListContainer);
  }

  // ---------------------- STATE ----------------------
  let localStream = null;
  let peerConnection = null;
  let partnerId = null;
  let isInitiator = false;

  let micEnabled = true;
  let autoReconnect = true;

  let searchTimer = null;
  let pauseTimer = null;

  // improved ICE servers + pool for better connectivity
  const servers = {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
      { urls: ['stun:stun.stunprotocol.org:3478'] },
      { urls: ['stun:global.stun.twilio.com:3478?transport=udp'] }
    ],
    iceCandidatePoolSize: 10
  };

  // reconnect/backoff
  let reconnectAttempts = 0;
  const maxReconnect = 5;

  // ping/pong keepalive over datachannel
  let controlChannel = null;
  let pingIntervalId = null;
  const PING_INTERVAL = 15000;

  // report counts per partner
  const reportCounts = new Map();

  // search retry counter
  let searchAttempts = 0;
  const MAX_SEARCH_ATTEMPTS_BEFORE_LIST = 3;

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

  function pauseSpinners(paused) {
    // pause CSS animation by changing animationPlayState
    [remoteSpinner, localSpinner].forEach(sp => {
      if (!sp) return;
      try {
        sp.style.animationPlayState = paused ? 'paused' : 'running';
      } catch (e) { /* ignore */ }
    });
  }

  // display available users list UI
  function showAvailableList(list) {
    availableListContainer.innerHTML = '';
    if (!list || list.length === 0) {
      availableListContainer.textContent = 'No available users right now.';
      availableListContainer.style.display = 'block';
      return;
    }

    list.forEach(u => {
      const el = document.createElement('div');
      el.className = 'available-item';
      el.textContent = `User: ${u.id}${u.age ? ' • ' + u.age : ''}${u.city ? ' • ' + u.city : ''}`;
      el.style.cursor = 'pointer';
      el.style.padding = '6px';
      el.style.borderBottom = '1px solid rgba(255,255,255,0.06)';
      el.onclick = () => {
        availableListContainer.style.display = 'none';
        addMessage(`Attempting direct connect to ${u.id}...`, 'system');
        // Ask server to connect directly to this id
        socket.emit('request-connect', { to: u.id });
        startSearchLoop(); // keep search loop active until partner-found
      };
      availableListContainer.appendChild(el);
    });

    // allow user to hide the list
    const closeBtn = document.createElement('div');
    closeBtn.textContent = 'Close';
    closeBtn.style.textAlign = 'center';
    closeBtn.style.padding = '6px';
    closeBtn.style.cursor = 'pointer';
    closeBtn.onclick = () => { availableListContainer.style.display = 'none'; };
    availableListContainer.appendChild(closeBtn);

    availableListContainer.style.display = 'block';
  }

  // capture remote video screenshot and return base64 jpeg
  function captureRemoteSnapshot() {
    return new Promise((resolve, reject) => {
      try {
        const video = remoteVideo;
        if (!video || !video.srcObject) return reject(new Error('Remote video not available'));

        // create canvas sized to video
        const canvas = document.createElement('canvas');
        const w = video.videoWidth || 640;
        const h = video.videoHeight || 480;
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        resolve(dataUrl);
      } catch (e) { reject(e); }
    });
  }

  // ---------------------- NOTIFICATION MENU ----------------------
  notifyBell.onclick = (e) => {
    e.stopPropagation();
    if (notifyDot) notifyDot.style.display = 'none';
    notifyBell.classList.remove('shake');

    notifyMenu.style.display =
      notifyMenu.style.display === 'block' ? 'none' : 'block';
  };

  document.onclick = () => { notifyMenu.style.display = 'none'; availableListContainer.style.display = 'none'; };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { notifyMenu.style.display = 'none'; availableListContainer.style.display = 'none'; } });

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

  // ---------------------- REPORT BUTTON ----------------------
  if (reportBtn) {
    reportBtn.style.display = 'flex';
    reportBtn.onclick = async () => {
      if (!partnerId) return addMessage("No user to report.", "system");

      const prev = reportCounts.get(partnerId) || 0;
      const now = prev + 1;
      reportCounts.set(partnerId, now);

      socket.emit("report", { partnerId });
      addMessage(`🚨 You reported the user. (Total reports for this user: ${now})`, "system");

      if (now >= 3) {
        addMessage('🔍 Third report reached — capturing snapshot...', 'system');

        try {
          const snap = await captureRemoteSnapshot();
          socket.emit('report-with-screenshot', { partnerId, image: snap });
          pushAdminNotification(`Report + screenshot sent for ${partnerId}`);
        } catch (e) {
          console.error('Snapshot failed', e);
          addMessage('Failed to capture snapshot.', 'system');
        }
      }
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

  function showRemoteSpinnerOnly(show) {
    remoteSpinner.style.display = show ? 'block' : 'none';
    remoteVideo.style.display = show ? 'none' : 'block';
  }

  function hideAllSpinners() {
    remoteSpinner.style.display = 'none';
    localSpinner.style.display = 'none';
    remoteVideo.style.display = 'block';
    localVideo.style.display = 'block';
    pauseSpinners(false);
  }

  // ---------------------- MATCHMAKING ----------------------
  function startSearchLoop() {
    if (partnerId) return;

    showRemoteSpinnerOnly(true);
    statusText.textContent = 'Searching...';
    pauseSpinners(false);

    socket.emit('find-partner');
    searchAttempts++;

    // if no partner after timeout -> try again or request available list
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (!partnerId) {
        try { socket.emit('stop'); } catch (e) {}
        statusText.textContent = 'Pausing...';
        pauseSpinners(true); // pause spinner rotation while pausing
        pauseTimer = setTimeout(() => {
          pauseSpinners(false);
          // if too many search attempts, request available list from server
          if (searchAttempts >= MAX_SEARCH_ATTEMPTS_BEFORE_LIST) {
            searchAttempts = 0;
            socket.emit('list-available');
          }
          startSearchLoop();
        }, 1800);
      }
    }, 3500);
  }

  async function startSearch() {
    if (!(await initMedia())) return;

    partnerId = null;
    isInitiator = false;

    chatMessages.innerHTML = '';
    chatMessages.appendChild(typingIndicator);

    hideAllSpinners();
    showRemoteSpinnerOnly(true);
    skipBtn.disabled = false;

    searchAttempts = 0;
    startSearchLoop();
  }

  skipBtn.onclick = () => {
    // request server to skip current partner and search for a different one
    socket.emit('skip', { partnerId });
    addMessage('You skipped.', 'system');
    disableChat();

    // ensure we disconnect current connection cleanly
    if (peerConnection) {
      try { peerConnection.close(); } catch (e) {}
      peerConnection = null;
    }
    partnerId = null;
    // immediately search for a new partner
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
    addMessage('Disconnected.', 'system');
    disableChat();
    partnerId = null;

    if (peerConnection) peerConnection.close();
    peerConnection = null;

    // try reconnecting/searching
    reconnectAttempts = 0;
    if (autoReconnect) startSearchLoop();
  });

  socket.on('partner-found', async data => {
    partnerId = data.id || data.partnerId;
    isInitiator = !!data.initiator;

    hideAllSpinners();
    statusText.textContent = 'Connecting...';

    // reset search attempts
    searchAttempts = 0;

    createPeerConnection();

    // if initiator: make offer
    if (isInitiator) {
      try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('signal', { to: partnerId, data: offer });
      } catch (e) { console.error(e); }
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
    } catch (e) { console.error('Signal handling error', e); }
  });

  // receive available list
  socket.on('available-list', (list) => {
    showAvailableList(list);
  });

  // ---------------------- WEBRTC ----------------------
  function createPeerConnection() {
    // ensure previous cleaned
    if (peerConnection) {
      try { peerConnection.close(); } catch (e) {}
    }

    peerConnection = new RTCPeerConnection(servers);

    // add local tracks
    if (localStream) {
      localStream.getTracks().forEach(t =>
        peerConnection.addTrack(t, localStream)
      );
    }

    // create control data channel if initiator for keepalive/pings
    if (isInitiator) {
      try {
        controlChannel = peerConnection.createDataChannel('control');
        setupControlChannel(controlChannel);
      } catch (e) { console.warn('Data channel create failed', e); }
    } else {
      peerConnection.ondatachannel = ev => {
        if (ev.channel && ev.channel.label === 'control') {
          controlChannel = ev.channel;
          setupControlChannel(controlChannel);
        }
      };
    }

    peerConnection.ontrack = e => {
      remoteVideo.srcObject = e.streams[0];
      enableChat();
      addMessage('Connected with a stranger!', 'system');
      showRemoteSpinnerOnly(false);
      // reset any reconnect attempts
      reconnectAttempts = 0;
      // ensure spinner runs
      pauseSpinners(false);
    };

    peerConnection.onicecandidate = e => {
      if (e.candidate) {
        socket.emit('signal', {
          to: partnerId,
          data: { candidate: e.candidate }
        });
      }
    };

    // try to handle negotiation for certain browsers
    peerConnection.onnegotiationneeded = async () => {
      try {
        if (!isInitiator) return; // let initiator drive negotiation
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('signal', { to: partnerId, data: offer });
      } catch (e) {
        console.error('Negotiation failed', e);
      }
    };

    peerConnection.onconnectionstatechange = () => {
      const s = peerConnection.connectionState;

      if (s === 'connected') {
        // normal
        addMessage('Peer connection established.', 'system');
      }

      if (['disconnected', 'failed', 'closed'].includes(s)) {
        disableChat();
        addMessage('Connection lost.', 'system');

        // attempt exponential backoff reconnect search (client-side reconnect logic)
        partnerId = null;
        if (autoReconnect) attemptReconnectOrSearch();
      }
    };
  }

  // data channel keepalive + simple ping/pong
  function setupControlChannel(dc) {
    dc.onopen = () => {
      // start ping interval to keep NAT open and detect liveness
      if (pingIntervalId) clearInterval(pingIntervalId);
      pingIntervalId = setInterval(() => {
        if (dc && dc.readyState === 'open') {
          try { dc.send(JSON.stringify({ type: 'ping', ts: Date.now() })); } catch (e) {}
        }
      }, PING_INTERVAL);
    };

    dc.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d && d.type === 'pong') {
          // could measure RTT if needed
        }
      } catch (e) { /* ignore non-json messages */ }
    };

    dc.onclose = () => {
      if (pingIntervalId) clearInterval(pingIntervalId);
      pingIntervalId = null;
    };
  }

  function attemptReconnectOrSearch() {
    reconnectAttempts++;
    if (reconnectAttempts <= maxReconnect) {
      const backoff = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts)); // cap at 30s
      addMessage(`Reconnecting/searching in ${Math.round(backoff/1000)}s...`, 'system');
      setTimeout(() => {
        startSearchLoop();
      }, backoff);
    } else {
      // give up automatic reconnect, show available list
      addMessage('Auto-reconnect attempts exhausted. Showing available users...', 'system');
      socket.emit('list-available');
    }
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

  // ---------------------- ADDITIONAL SOCKETS / HANDLES ----------------------
  // server may notify admin-side events or request snapshots
  socket.on('request-snapshot', async ({ forPartner }) => {
    if (!forPartner || forPartner !== partnerId) return;
    try {
      const snap = await captureRemoteSnapshot();
      socket.emit('snapshot-response', { to: 'admin', partnerId, image: snap });
    } catch (e) {
      socket.emit('snapshot-response', { to: 'admin', partnerId, error: 'snapshot-failed' });
    }
  });

});
