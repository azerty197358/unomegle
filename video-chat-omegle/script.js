// ========================================================
// SPARKCHAT — script.js (FULL FIX, NOTIFICATIONS DROPDOWN, MOBILE FIXES)
// ========================================================

// Wait for DOM to exist, then init socket and app
window.addEventListener('DOMContentLoaded', () => {
  const socket = io();

  // --- DOM elements ---
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
  const statusText = document.getElementById('status');
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const skipBtn = document.getElementById('skipBtn');

  const exitBtn = document.getElementById('exitBtn');

  // --- global state ---
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

  // --- Helpers ---
  function addMessage(text, type = 'system') {
    const d = document.createElement('div');
    d.className = `msg ${type}`;
    d.textContent = text;
    // insert before typing indicator if exists
    const typing = document.querySelector('.msg.system[style*="italic"]');
    if (typing && typing.parentNode === chatMessages) {
      chatMessages.insertBefore(d, typing);
    } else {
      chatMessages.appendChild(d);
    }
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function pushAdminNotification(msg) {
    const item = document.createElement('div');
    item.className = 'notify-item';
    item.textContent = msg;
    notifyMenu.prepend(item);
    // If menu empty state existed, remove it
    const empty = notifyMenu.querySelector('.notify-empty');
    if (empty) empty.remove();
  }

  function ensureNotifyEmpty() {
    if (notifyMenu.children.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'notify-empty';
      empty.textContent = 'لا إشعارات';
      notifyMenu.appendChild(empty);
    }
  }

  // --- Notifications dropdown interactions ---
  notifyBell.addEventListener('click', (e) => {
    e.stopPropagation();
    notifyDot.style.display = 'none';
    notifyBell.classList.remove('shake');
    notifyMenu.style.display = notifyMenu.style.display === 'block' ? 'none' : 'block';
  });

  // Close dropdown on outside click or ESC
  document.addEventListener('click', (e) => {
    if (notifyMenu.style.display === 'block') notifyMenu.style.display = 'none';
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') notifyMenu.style.display = 'none'; });

  // --- Typing indicator ---
  const typingIndicator = document.createElement('div');
  typingIndicator.className = 'msg system';
  typingIndicator.style.fontStyle = 'italic';
  typingIndicator.style.display = 'none';
  typingIndicator.textContent = 'الشخص الآخر يكتب الآن...';
  chatMessages.appendChild(typingIndicator);

  let typing = false;
  let typingTimer = null;
  const TYPING_DEBOUNCE = 1500;

  function sendTyping(to) {
    if (!to) return;
    if (!typing) {
      typing = true;
      socket.emit('typing', { to });
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      typing = false;
      socket.emit('stop-typing', { to });
    }, TYPING_DEBOUNCE);
  }

  chatInput.addEventListener('input', () => {
    if (!chatInput.disabled && partnerId) sendTyping(partnerId);
  });

  // --- Send message ---
  function sendMessage() {
    const msg = chatInput.value.trim();
    if (!msg || !partnerId) return;
    addMessage(msg, 'you');
    socket.emit('chat-message', { to: partnerId, message: msg });
    chatInput.value = '';
    typing = false;
    clearTimeout(typingTimer);
    socket.emit('stop-typing', { to: partnerId });
  }
  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });

  // --- Mic toggle (works because localStream is set when media allowed) ---
  function updateMicButton() { micBtn.textContent = micEnabled ? '🎤' : '🔇'; }
  micBtn.addEventListener('click', () => {
    if (!localStream) return alert('الميك غير متاح حتى تسمح بالوصول للكاميرا والميك.');
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    updateMicButton();
  });

  // --- Report ---
  reportBtn.addEventListener('click', async () => {
    if (!partnerId) return alert('لا يوجد شخص للإبلاغ عنه.');
    if (!remoteVideo || remoteVideo.readyState < 2) return alert('لا يمكن التقاط لقطة الآن.');

    const canvas = document.createElement('canvas');
    canvas.width = remoteVideo.videoWidth || 640;
    canvas.height = remoteVideo.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(remoteVideo, 0, 0, canvas.width, canvas.height);

    socket.emit('reportPorn', {
      partnerId,
      matchId,
      timestamp: new Date().toISOString().replace(/[:]/g, '-'),
      screenshot: canvas.toDataURL('image/png')
    });

    addMessage('🚨 تم إرسال الإبلاغ بنجاح!', 'system');
  });

  // --- UI helpers ---
  function enableChat() { chatInput.disabled = false; sendBtn.disabled = false; }
  function disableChat() { chatInput.disabled = true; sendBtn.disabled = true; chatInput.value = ''; }
  function showRemoteSpinnerOnly(show) {
    remoteSpinner.style.display = show ? 'block' : 'none';
    remoteVideo.style.display = show ? 'none' : 'block';
  }
  function hideAllSpinners() { remoteSpinner.style.display = 'none'; localSpinner.style.display = 'none'; remoteVideo.style.display = 'block'; localVideo.style.display = 'block'; }

  // --- Media init ---
  async function initMedia() {
    if (localStream) return true;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
      updateMicButton();
      return true;
    } catch (err) {
      statusText.textContent = 'Camera/Mic access denied.';
      console.error(err);
      return false;
    }
  }

  // --- Matchmaking / search loop ---
  function startSearchLoop() {
    if (partnerId) return;
    showRemoteSpinnerOnly(true);
    statusText.textContent = 'Searching...';
    socket.emit('find-partner', { locale: 'ar', version: '1.0', timestamp: Date.now() });

    searchTimer = setTimeout(() => {
      if (!partnerId) {
        socket.emit('stop');
        showRemoteSpinnerOnly(false);
        statusText.textContent = 'Pausing...';
        pauseTimer = setTimeout(startSearchLoop, 2000);
      }
    }, 4000);
  }

  async function startSearch() {
    if (!(await initMedia())) return;
    if (peerConnection) try { peerConnection.close(); } catch(e){}
    peerConnection = null;
    partnerId = null;
    matchId = null;
    isInitiator = false;

    chatMessages.innerHTML = '';
    chatMessages.appendChild(typingIndicator);
    showRemoteSpinnerOnly(true);
    skipBtn.disabled = false;
    startSearchLoop();
  }

  skipBtn.addEventListener('click', () => {
    statusText.textContent = 'Skipping...';
    clearTimeout(searchTimer); clearTimeout(pauseTimer);
    socket.emit('skip');
    if (peerConnection) try { peerConnection.close(); } catch(e){}
    peerConnection = null;
    disableChat();
    addMessage('You skipped.', 'system');
    startSearchLoop();
  });

  // --- Socket events (core) ---
  socket.on('waiting', msg => statusText.textContent = msg || 'Waiting...');
  socket.on('chat-message', ({ message }) => addMessage(message, 'them'));
  socket.on('typing', () => { typingIndicator.style.display = 'block'; chatMessages.scrollTop = chatMessages.scrollHeight; });
  socket.on('stop-typing', () => { typingIndicator.style.display = 'none'; });

  socket.on('adminMessage', msg => {
    // show dropdown dot + push notification + show in chat
    notifyDot.style.display = 'block';
    notifyBell.classList.add('shake');
    pushAdminNotification('📢 ' + msg);
    addMessage('📢 Admin: ' + msg, 'system');
  });

  socket.on('partner-disconnected', () => {
    statusText.textContent = 'Stranger disconnected.';
    disableChat();
    addMessage('Disconnected.', 'system');
    partnerId = null;
    if (peerConnection) try { peerConnection.close(); } catch(e){}
    peerConnection = null;
    if (autoReconnect) startSearchLoop();
  });

  socket.on('partner-found', async payload => {
    clearTimeout(searchTimer); clearTimeout(pauseTimer);
    partnerId = payload.partnerId || payload.id || payload;
    matchId = payload.matchId || null;
    isInitiator = !!payload.initiator;
    statusText.textContent = 'Connecting...';
    showRemoteSpinnerOnly(true);

    // proceedAfterMatch behavior
    hideAllSpinners();
    createPeerConnection();

    if (isInitiator) {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit('signal', { to: partnerId, data: offer, matchId });
    }
  });

  socket.on('signal', async ({ from, data }) => {
    if (!peerConnection) createPeerConnection();
    try {
      if (data.type === 'offer') {
        await peerConnection.setRemoteDescription(data);
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('signal', { to: from, data: answer, matchId });
      } else if (data.type === 'answer') {
        await peerConnection.setRemoteDescription(data);
      } else if (data.candidate) {
        await peerConnection.addIceCandidate(data.candidate);
      }
    } catch (err) {
      console.error('Signal handling error', err);
    }
  });

  // --- WebRTC ---
  function createPeerConnection() {
    peerConnection = new RTCPeerConnection(servers);
    if (localStream) localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = e => {
      remoteVideo.srcObject = e.streams[0];
      statusText.textContent = 'Connected!';
      enableChat();
      addMessage('Connected with a stranger. Say hi!', 'system');
      showRemoteSpinnerOnly(false);
    };

    peerConnection.onicecandidate = e => {
      if (e.candidate) {
        socket.emit('signal', { to: partnerId, data: { candidate: e.candidate }, matchId });
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

  // --- start automatically ---
  startSearch();

  // --- cleanup ---
  window.addEventListener('beforeunload', () => {
    try { socket.emit('stop'); } catch {}
    if (localStream) localStream.getTracks().forEach(t => t.stop());
  });

  // --- exit button ---
  exitBtn.addEventListener('click', () => { location.href = 'index.html'; });

  // --- init UI placeholders ---
  ensureNotifyEmpty();
  updateMicButton();
});
