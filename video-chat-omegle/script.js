// SPARKCHAT — script.js (FULL FIX + LTR DESIGN + MOBILE FIXES)
// FINAL VERSION WITH PERFECT REPORT CAPTURE

window.addEventListener('DOMContentLoaded', () => {

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
  let matchId = null;
  let isInitiator = false;

  let micEnabled = true;
  let autoReconnect = true;

  let searchTimer = null;
  let pauseTimer = null;

  const servers = { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };

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
    notifyDot.style.display = 'none';
    notifyBell.classList.remove('shake');

    notifyMenu.style.display = notifyMenu.style.display === 'block'
      ? 'none'
      : 'block';
  };

  document.onclick = () => {
    notifyMenu.style.display = 'none';
  };

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') notifyMenu.style.display = 'none';
  });

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

  // ---------------------- REPORT BUTTON (FIXED 100%) ----------------------
  reportBtn.onclick = async () => {
    if (!partnerId) {
      alert("No user to report.");
      return;
    }

    const video = remoteVideo;

    if (!video.srcObject) {
      alert("Video stream not ready yet.");
      return;
    }

    // انتظر أول فريم فعلي من الفيديو
    const waitForFrame = () => {
      return new Promise(resolve => {
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          return resolve();
        }
        video.addEventListener("loadeddata", () => resolve(), { once: true });
      });
    };

    await waitForFrame();

    try {
      const width = video.videoWidth;
      const height = video.videoHeight;

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, width, height);

      const imgData = canvas.toDataURL("image/png");

      socket.emit("reportPorn", {
        partnerId,
        matchId,
        screenshot: imgData,
        timestamp: Date.now()
      });

      addMessage("🚨 Report sent!", "system");

    } catch (err) {
      console.error("Screenshot failed:", err);
      alert("Failed to take screenshot. Try again when video is visible.");
    }
  };

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
  }

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

  // ---------------------- MATCHMAKING ----------------------
  function startSearchLoop() {
    if (partnerId) return;

    showRemoteSpinnerOnly(true);
    statusText.textContent = 'Searching...';

    socket.emit('find-partner', {
      locale: 'en',
      version: '1.0',
      timestamp: Date.now()
    });

    searchTimer = setTimeout(() => {
      if (!partnerId) {
        socket.emit('stop');
        statusText.textContent = 'Pausing...';
        pauseTimer = setTimeout(startSearchLoop, 1800);
      }
    }, 3500);
  }

  async function startSearch() {
    if (!(await initMedia())) return;

    partnerId = null;
    matchId = null;
    isInitiator = false;

    chatMessages.innerHTML = '';
    chatMessages.appendChild(typingIndicator);

    showRemoteSpinnerOnly(true);
    skipBtn.disabled = false;

    startSearchLoop();
  }

  skipBtn.onclick = () => {
    socket.emit('skip');
    addMessage('You skipped.', 'system');
    disableChat();
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
    notifyDot.style.display = 'block';
    notifyBell.classList.add('shake');

    pushAdminNotification('📢 ' + msg);
    addMessage('📢 Admin: ' + msg, 'system');
  });

  socket.on('partner-disconnected', () => {
    addMessage('Disconnected.', 'system');
    disableChat();
    partnerId = null;

    if (peerConnection) peerConnection.close();
    peerConnection = null;

    startSearchLoop();
  });

  socket.on('partner-found', async data => {
    partnerId = data.partnerId || data.id;
    matchId = data.matchId || null;
    isInitiator = !!data.initiator;

    hideAllSpinners();
    statusText.textContent = 'Connecting...';

    createPeerConnection();

    if (isInitiator) {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit('signal', { to: partnerId, data: offer });
    }
  });

  socket.on('signal', async ({ from, data }) => {
    if (!peerConnection) createPeerConnection();

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
        socket.emit('signal', {
          to: partnerId,
          data: { candidate: e.candidate }
        });
      }
    };

    peerConnection.onconnectionstatechange = () => {
      const s = peerConnection.connectionState;

      if (['disconnected', 'failed', 'closed'].includes(s)) {
        disableChat();
        addMessage('Connection lost.', 'system');

        partnerId = null;
        if (autoReconnect) startSearchLoop();
      }
    };
  }

  // ---------------------- EXIT ----------------------
  exitBtn.onclick = () => {
    location.href = 'index.html';
  };

  // ---------------------- AUTO START ----------------------
  ensureNotifyEmpty();
  updateMicButton();
  startSearch();

  window.onbeforeunload = () => {
    socket.emit('stop');
    if (localStream) localStream.getTracks().forEach(t => t.stop());
  };
});
