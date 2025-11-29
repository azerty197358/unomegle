// CLEANED script.js — AUTO-DETECTION ONLY (NO MANUAL REPORTING)
// Fully compatible with updated server
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
    chatMessages.appendChild(d);
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
  notifyBell.onclick = e => {
    e.stopPropagation();
    notifyDot.style.display = 'none';
    notifyBell.classList.remove('shake');
    notifyMenu.style.display = notifyMenu.style.display === 'block' ? 'none' : 'block';
  };
  document.onclick = () => notifyMenu.style.display = 'none';
  document.addEventListener('keydown', e => { if (e.key === 'Escape') notifyMenu.style.display = 'none'; });

  // ---------------------- CHAT ----------------------
  function sendMessage() {
    const msg = chatInput.value.trim();
    if (!msg || !partnerId) return;
    addMessage(msg, 'you');
    socket.emit('chat-message', { to: partnerId, message: msg });
    chatInput.value = '';
  }
  sendBtn.onclick = sendMessage;
  chatInput.onkeypress = e => { if (e.key === 'Enter') sendMessage(); };

  // ---------------------- MIC CONTROL ----------------------
  function updateMicButton() {
    micBtn.textContent = micEnabled ? '🎤' : '🔇';
    micBtn.disabled = !localStream;
  }

  micBtn.onclick = () => {
    if (!localStream) return;
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    updateMicButton();
  };

  // ---------------------- DEVICE FINGERPRINT ----------------------
  const DeviceFingerprint = (function () {
    const KEY_ID = 'spark_device_id_v1';
    const KEY_FP = 'spark_fingerprint_v1';

    function uuidv4() {
      const arr = new Uint8Array(16);
      crypto.getRandomValues(arr);
      arr[6] = (arr[6] & 0x0f) | 0x40;
      arr[8] = (arr[8] & 0x3f) | 0x80;
      const hex = [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    }

    async function sha256hex(str) {
      const data = new TextEncoder().encode(str);
      const hash = await crypto.subtle.digest('SHA-256', data);
      return [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('');
    }

    return {
      async ensure() {
        let id = localStorage.getItem(KEY_ID);
        let fp = localStorage.getItem(KEY_FP);
        if (!id) {
          id = uuidv4();
          localStorage.setItem(KEY_ID, id);
        }
        if (!fp) {
          fp = await sha256hex(navigator.userAgent + '||' + id);
          localStorage.setItem(KEY_FP, fp);
        }
        return { deviceId: id, fingerprint: fp };
      },
      getDeviceId() { return localStorage.getItem(KEY_ID); },
      getFingerprint() { return localStorage.getItem(KEY_FP); }
    };
  })();

  DeviceFingerprint.ensure();

  // ---------------------- NSFW DETECTION ----------------------
  const DETECT_MS = 3000;
  const PORN_THRESHOLD = 0.75;
  const NEED_HITS = 2;
  let nsfwModel = null;
  let detectInterval = null;
  let consecutive = 0;

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  async function loadNsfw() {
    if (!window.tf) await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0/dist/tf.min.js');
    if (!window.nsfwjs) await loadScript('https://cdn.jsdelivr.net/npm/nsfwjs@2.4.0/dist/nsfwjs.min.js');
    nsfwModel = await nsfwjs.load();
  }

  async function checkPornFrame() {
    if (!remoteVideo || remoteVideo.readyState < 2 || !partnerId) return;
    if (!nsfwModel) return;

    const c = document.createElement('canvas');
    c.width = 224;
    c.height = 224;
    const ctx = c.getContext('2d');

    try { ctx.drawImage(remoteVideo, 0, 0, 224, 224); } catch { return; }

    const preds = await nsfwModel.classify(c);
    let prob = 0;
    for (const p of preds) {
      const name = p.className.toLowerCase();
      if (name.includes('porn')) prob = Math.max(prob, p.probability);
    }

    if (prob >= PORN_THRESHOLD) {
      consecutive++;
      if (consecutive >= NEED_HITS) autoBan();
    } else {
      consecutive = 0;
    }
  }

  async function autoBan() {
    const { fingerprint } = await DeviceFingerprint.ensure();
    socket.emit('requestBan', { partnerId, fingerprint });
    try { localStorage.setItem('spark_local_banned_device_v1', fingerprint); } catch {}
    if (peerConnection) peerConnection.close();
    partnerId = null;
    stopDetect();
  }

  async function startDetect() {
    if (!nsfwModel) await loadNsfw();
    detectInterval = setInterval(checkPornFrame, DETECT_MS);
  }

  function stopDetect() {
    if (detectInterval) clearInterval(detectInterval);
    detectInterval = null;
    consecutive = 0;
  }

  remoteVideo.addEventListener('play', () => setTimeout(startDetect, 400));
  remoteVideo.addEventListener('pause', stopDetect);

  // ---------------------- MATCHMAKING ----------------------
  function startSearchLoop() {
    if (localStorage.getItem('spark_local_banned_device_v1')) {
      addMessage('You are banned.', 'system');
      statusText.textContent = 'Blocked.';
      return;
    }
    statusText.textContent = 'Searching...';
    socket.emit('find-partner');
  }

  async function startSearch() {
    if (!await initMedia()) return;
    partnerId = null;
    startSearchLoop();
  }

  skipBtn.onclick = () => {
    socket.emit('skip');
    addMessage('You skipped.', 'system');
    startSearchLoop();
  };

  // ---------------------- SOCKET EVENTS ----------------------
  socket.on('waiting', msg => statusText.textContent = msg);

  socket.on('chat-message', ({ message }) => addMessage(message, 'them'));

  socket.on('adminMessage', msg => {
    notifyDot.style.display = 'block';
    notifyBell.classList.add('shake');
    pushAdminNotification('📢 ' + msg);
  });

  socket.on('partner-disconnected', () => {
    addMessage('Disconnected.', 'system');
    partnerId = null;
    if (peerConnection) peerConnection.close();
    stopDetect();
    startSearchLoop();
  });

  socket.on('partner-found', async data => {
    partnerId = data.id || data.partnerId;
    isInitiator = !!data.initiator;
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

  // server-side ban confirmed
  socket.on('banConfirmed', ({ fingerprint }) => {
    if (DeviceFingerprint.getFingerprint() === fingerprint) {
      localStorage.setItem('spark_local_banned_device_v1', fingerprint);
      addMessage('You have been banned.', 'system');
      statusText.textContent = 'Blocked.';
    }
  });

  // ---------------------- WEBRTC ----------------------
  function createPeerConnection() {
    peerConnection = new RTCPeerConnection(servers);
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));

    peerConnection.ontrack = e => {
      remoteVideo.srcObject = e.streams[0];
      addMessage('Connected!', 'system');
    };

    peerConnection.onicecandidate = e => {
      if (e.candidate) socket.emit('signal', { to: partnerId, data: { candidate: e.candidate } });
    };

    peerConnection.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(peerConnection.connectionState)) {
        partnerId = null;
        stopDetect();
        startSearchLoop();
      }
    };
  }

  // ---------------------- EXIT ----------------------
  exitBtn.onclick = () => location.href = 'index.html';

  // ---------------------- MEDIA INIT ----------------------
  async function initMedia() {
    if (localStream) return true;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
      updateMicButton();
      return true;
    } catch (e) {
      statusText.textContent = 'Camera/Mic denied.';
      return false;
    }
  }

  // ---------------------- AUTO START ----------------------
  ensureNotifyEmpty();
  updateMicButton();
  startSearch();

});
