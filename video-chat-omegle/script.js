// ========================== CLIENT.JS الكامل ==========================
window.addEventListener('DOMContentLoaded', () => {
  const socket = io();

  // ---------------- DOM ----------------
  const notifyBell   = document.getElementById('notifyIcon');
  const notifyDot    = document.getElementById('notifyDot');
  const notifyMenu   = document.getElementById('notifyMenu');
  const localVideo   = document.getElementById('localVideo');
  const remoteVideo  = document.getElementById('remoteVideo');
  const localSpinner = document.getElementById('localSpinner');
  const remoteSpinner= document.getElementById('remoteSpinner');
  const reportBtn    = document.getElementById('reportBtn');
  const micBtn       = document.getElementById('micBtn');
  const chatMessages = document.getElementById('chatMessages');
  const chatInput    = document.getElementById('chatInput');
  const sendBtn      = document.getElementById('sendBtn');
  const skipBtn      = document.getElementById('skipBtn');
  const exitBtn      = document.getElementById('exitBtn');

  // ---------------- STATE ----------------
  let localStream   = null;
  let peerConnection= null;
  let partnerId     = null;
  let isInitiator   = false;
  let micEnabled    = true;
  let isBanned      = false;

  // عداد التوقفات
  let pauseCount    = 0;
  const MAX_PAUSE   = 3;

  const activeTimers= new Set();
  let searchTimer   = null;
  let pauseTimer    = null;

  const servers = { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };
  const reportedIds = new Set();
  const reportCounts= new Map();

  // حذفنا كل متغيرات ودوال إعادة الاتصال
  const bufferedRemoteCandidates = [];
  let makingOffer = false, ignoreOffer = false;

  // ---------------- باقي الدوال المساعدة (بدون recovery) ----------------
  function setSafeTimer(cb, delay) {
    const id = setTimeout(() => { activeTimers.delete(id); cb(); }, delay);
    activeTimers.add(id); return id;
  }
  function clearSafeTimer(id) { if (id) { clearTimeout(id); activeTimers.delete(id); } }
  function clearAllTimers() {
    activeTimers.forEach(id => clearTimeout(id)); activeTimers.clear();
  }
  function safeEmit(event, data) {
    try { if (socket.connected) { socket.emit(event, data); return true; } } catch (e) {}
    return false;
  }
  function addMessage(msg, type = 'system') {
    const d = document.createElement('div'); d.className = `msg ${type}`; d.textContent = msg;
    chatMessages.appendChild(d); chatMessages.scrollTop = chatMessages.scrollHeight;
  }
  function updateStatusMessage(msg) {
    let s = document.getElementById('statusMessage');
    if (!s) { s = document.createElement('div'); s.id = 'statusMessage'; s.className = 'msg status'; chatMessages.appendChild(s); }
    s.textContent = msg; chatMessages.scrollTop = chatMessages.scrollHeight;
  }
  function pushAdminNotification(txt) {
    const item = document.createElement('div'); item.className = 'notify-item'; item.textContent = txt;
    notifyMenu.prepend(item); const empty = notifyMenu.querySelector('.notify-empty'); if (empty) empty.remove();
  }
  function ensureNotifyEmpty() { if (notifyMenu.children.length === 0) { const d = document.createElement('div'); d.className = 'notify-empty'; d.textContent = 'No notifications'; notifyMenu.appendChild(d); } }

  // ---------------- زر PAUSE + منطق الفيديو ----------------
  const pauseBtn = document.createElement('button');
  pauseBtn.textContent = '⏸ Pause';
  pauseBtn.id = 'pauseBtn';
  pauseBtn.style.marginLeft = '6px';
  skipBtn.parentElement.appendChild(pauseBtn);

  pauseBtn.onclick = () => {
    if (isBanned) return;
    pauseCount++;
    if (pauseCount >= MAX_PAUSE) {
      pauseCount = 0;
      playVideoInRemote();
    } else {
      updateStatusMessage(`Pause ${pauseCount}/${MAX_PAUSE}`);
    }
  };

  function playVideoInRemote() {
    // أنهِ الاتصال الحالي
    cleanupConnection();
    disableChat();

    // أنشئ عنصر فيديو
    const vid = document.createElement('video');
    vid.src = 'videos/sample.mp4'; // << غيّر إلى مسار الفيديو الصحيح
    vid.autoplay = true;
    vid.controls = false;
    vid.muted = false;
    vid.style.width = remoteVideo.style.width;
    vid.style.height = remoteVideo.style.height;
    vid.style.objectFit = 'cover';

    remoteVideo.srcObject = null;
    remoteVideo.style.display = 'none';
    remoteVideo.parentElement.appendChild(vid);

    vid.onended = () => {
      vid.remove();
      remoteVideo.style.display = 'block';
      updateStatusMessage('Video ended — skipping...');
      safeEmit('skip');
      setSafeTimer(startSearchLoop, 800);
    };
  }

  // ---------------- باقي دوال التنظيف والـ UI ----------------
  function cleanupConnection() {
    clearAllTimers();
    if (peerConnection) {
      try { if (keepAliveChannel) keepAliveChannel.close(); peerConnection.close(); } catch (e) {}
      peerConnection = null; keepAliveChannel = null;
    }
    if (remoteVideo) remoteVideo.srcObject = null;
    bufferedRemoteCandidates.length = 0;
    partnerId = null; isInitiator = false; makingOffer = false; ignoreOffer = false;
  }
  function enableChat() { chatInput.disabled = isBanned; sendBtn.disabled = isBanned; }
  function disableChat() { chatInput.disabled = true; sendBtn.disabled = true; }
  function updateMicButton() {
    micBtn.textContent = micEnabled ? '🎤' : '🔇';
    micBtn.disabled = !localStream || isBanned;
    micBtn.style.opacity = (localStream && !isBanned) ? '1' : '0.8';
  }
  function hideAllSpinners() {
    if (remoteSpinner) remoteSpinner.style.display = 'none';
    if (remoteVideo) remoteVideo.style.display = 'block';
    if (localVideo) localVideo.style.display = 'block';
  }
  function showRemoteSpinnerOnly(show) {
    if (remoteSpinner) remoteSpinner.style.display = show ? 'block' : 'none';
    if (remoteVideo) remoteVideo.style.display = show ? 'none' : 'block';
    if (localVideo) localVideo.style.display = 'block';
  }

  // ---------------- MATCHMAKING بدون recovery ----------------
  function startSearchLoop() {
    if (isBanned) { updateStatusMessage('⛔ You are banned for 24 hours.'); showRemoteSpinnerOnly(false); return; }
    if (partnerId) return;
    showRemoteSpinnerOnly(true);
    updateStatusMessage('Searching...');
    safeEmit('find-partner');
    clearSafeTimer(searchTimer);
    searchTimer = setSafeTimer(() => {
      if (!partnerId) { safeEmit('stop'); showRemoteSpinnerOnly(false); updateStatusMessage('Pausing...'); clearSafeTimer(pauseTimer); pauseTimer = setSafeTimer(startSearchLoop, 1800); }
    }, 3500);
  }
  async function startSearch() {
    if (isBanned) { updateStatusMessage('⛔ You are banned for 24 hours.'); showRemoteSpinnerOnly(false); return; }
    const mediaReady = await initMedia();
    if (!mediaReady) { updateStatusMessage('Media initialization failed.'); return; }
    cleanupConnection(); chatMessages.innerHTML = ''; showRemoteSpinnerOnly(true); skipBtn.disabled = false; startSearchLoop();
  }
  skipBtn.onclick = () => {
    if (isBanned) return;
    safeEmit('skip'); updateStatusMessage('You skipped.'); disableChat(); cleanupConnection(); clearSafeTimer(searchTimer); clearSafeTimer(pauseTimer); startSearchLoop();
  };

  // ---------------- SOCKET EVENTS (بدون recovery) ----------------
  socket.on('waiting', msg => { if (!isBanned) updateStatusMessage(msg); });
  socket.on('chat-message', ({ message }) => { if (!isBanned) addMessage(message, 'them'); });
  socket.on('typing', () => { if (!isBanned) document.getElementById('typingIndicator').style.display = 'block'; });
  socket.on('stop-typing', () => document.getElementById('typingIndicator').style.display = 'none');
  socket.on('adminMessage', msg => { if (notifyDot) notifyDot.style.display = 'block'; notifyBell.classList.add('shake'); pushAdminNotification('📢 ' + msg); addMessage('📢 Admin: ' + msg, 'system'); });
  socket.on('banned', ({ message }) => { isBanned = true; addMessage(message || 'You are banned.', 'system'); showRemoteSpinnerOnly(true); updateStatusMessage('⛔ You are banned for 24 hours.'); cleanupConnection(); disableChat(); if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; } if (localVideo) localVideo.srcObject = null; updateMicButton(); });
  socket.on('unbanned', ({ message }) => { isBanned = false; addMessage(message || 'You have been unbanned.', 'system'); updateStatusMessage('You have been unbanned.'); startSearch(); });
  socket.on('partner-disconnected', () => { if (!isBanned) { updateStatusMessage('Partner disconnected.'); disableChat(); cleanupConnection(); clearSafeTimer(searchTimer); clearSafeTimer(pauseTimer); setSafeTimer(startSearchLoop, 500); } });

  socket.on('partner-found', async data => {
    if (isBanned) { safeEmit('skip'); return; }
    const foundId = data?.id || data?.partnerId;
    if (!foundId) { console.error('Invalid partner data'); updateStatusMessage('Invalid partner data. Retrying...'); setSafeTimer(startSearchLoop, 1000); return; }
    if (reportedIds.has(foundId)) { safeEmit('skip'); updateStatusMessage('Found reported user — skipping...'); cleanupConnection(); setSafeTimer(startSearchLoop, 200); return; }
    partnerId = foundId; isInitiator = !!data.initiator; hideAllSpinners(); updateStatusMessage('Connecting...');
    try { createPeerConnection(); if (isInitiator) { makingOffer = true; const offer = await peerConnection.createOffer(); await peerConnection.setLocalDescription(offer); safeEmit('signal', { to: partnerId, data: offer }); } } catch (e) { console.error('Failed to create peer connection:', e); updateStatusMessage('Connection setup failed. Retrying...'); cleanupConnection(); setSafeTimer(startSearchLoop, 1000); } finally { makingOffer = false; }
  });

  socket.on('signal', async ({ from, data }) => {
    if (isBanned) return;
    if (!from || !data) return;
    if (partnerId && partnerId !== from) return;
    if (!peerConnection) try { createPeerConnection(); } catch (e) { return; }
    if (data.candidate && !peerConnection.remoteDescription) { bufferedRemoteCandidates.push(data.candidate); return; }
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
    } catch (e) { console.error('Signal handling error:', e); updateStatusMessage('Signal processing failed.'); }
  });

  // ---------------- WEBRTC (بدون recovery) ----------------
  let keepAliveChannel = null, lastPong = Date.now(), pingTimer = null;
  const PING_INTERVAL = 4000, PONG_TIMEOUT = 11000;
  function createPeerConnection() {
    if (peerConnection) { try { peerConnection.close(); } catch (e) {} peerConnection = null; }
    peerConnection = new RTCPeerConnection(servers); makingOffer = false; ignoreOffer = false;
    if (localStream) localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    if (isInitiator) {
      try { keepAliveChannel = peerConnection.createDataChannel('keepAlive', { ordered: true }); setupKeepAliveChannel(keepAliveChannel); } catch (e) { keepAliveChannel = null; }
    } else peerConnection.ondatachannel = ev => { keepAliveChannel = ev.channel; setupKeepAliveChannel(keepAliveChannel); };
    peerConnection.ontrack = e => {
      if (!e.streams || e.streams.length === 0) return;
      remoteVideo.srcObject = e.streams[0];
      enableChat();
      updateStatusMessage('Connected');
      showRemoteSpinnerOnly(false);
      flushBufferedCandidates();
      startStatsMonitor();
    };
    peerConnection.onicecandidate = e => { if (e.candidate && partnerId) safeEmit('signal', { to: partnerId, data: { candidate: e.candidate } }); };
    peerConnection.onconnectionstatechange = () => {
      if (!peerConnection) return;
      const s = peerConnection.connectionState;
      if (s === 'connected') { updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger. Say hello 😊🤝'); } else if (['disconnected', 'failed', 'closed'].includes(s)) {
        if (!isBanned) { updateStatusMessage('Connection lost.'); disableChat(); cleanupConnection(); setSafeTimer(startSearchLoop, 1000); }
      }
    };
    peerConnection.onnegotiationneeded = async () => {
      if (!peerConnection || makingOffer || !partnerId) return;
      try { makingOffer = true; const offer = await peerConnection.createOffer(); await peerConnection.setLocalDescription(offer); safeEmit('signal', { to: partnerId, data: offer }); } catch (e) { console.error('Negotiation error:', e); } finally { makingOffer = false; }
    };
  }
  function setupKeepAliveChannel(dc) {
    if (!dc) return;
    dc.onopen = () => { lastPong = Date.now(); startPingLoop(); };
    dc.onmessage = ev => { try { const msg = JSON.parse(ev.data); if (msg.type === 'ping') dc.send(JSON.stringify({ type: 'pong', ts: Date.now() })); else if (msg.type === 'pong') lastPong = Date.now(); } catch (e) {} };
    dc.onclose = () => stopPingLoop();
    dc.onerror = err => console.error('KeepAlive error:', err);
  }
  function startPingLoop() {
    stopPingLoop();
    pingTimer = setInterval(() => {
      if (!keepAliveChannel || keepAliveChannel.readyState !== 'open') { stopPingLoop(); return; }
      try { keepAliveChannel.send(JSON.stringify({ type: 'ping', ts: Date.now() })); } catch (e) { stopPingLoop(); }
      if (Date.now() - lastPong > PONG_TIMEOUT) { stopPingLoop(); }
    }, PING_INTERVAL);
  }
  function stopPingLoop() { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } }
  function flushBufferedCandidates() { while (bufferedRemoteCandidates.length && peerConnection) { const c = bufferedRemoteCandidates.shift(); try { peerConnection.addIceCandidate(c).catch(() => {}); } catch (e) {} } }

  // ---------------- STATS MONITOR ----------------
  let statsInterval = null;
  const STATS_POLL_MS = 3000;
  const BITRATE_HIGH = 800_000, BITRATE_MEDIUM = 400_000, BITRATE_LOW = 160_000;
  async function setSenderMaxBitrate(targetBps) {
    if (!peerConnection) return;
    try { const senders = peerConnection.getSenders(); for (const sender of senders) { if (!sender.track || sender.track.kind !== 'video') continue; const params = sender.getParameters(); if (!params.encodings) params.encodings = [{}]; params.encodings = params.encodings.map(enc => ({ ...enc, maxBitrate: targetBps })); await sender.setParameters(params); } } catch (e) {}
  }
  function startStatsMonitor() {
    stopStatsMonitor();
    statsInterval = setInterval(async () => {
      if (!peerConnection || peerConnection.connectionState !== 'connected') { stopStatsMonitor(); return; }
      try {
        const stats = await peerConnection.getStats(null);
        let outboundVideoReport = null, remoteInboundRtp = null;
        stats.forEach(report => {
          if (report.type === 'outbound-rtp' && report.kind === 'video') outboundVideoReport = report;
          if (report.type === 'remote-inbound-rtp' && report.kind === 'video') remoteInboundRtp = report;
        });
        let lossRatio = 0;
        if (outboundVideoReport?.packetsSent > 0) {
          if (remoteInboundRtp?.packetsLost >= 0) {
            const lost = remoteInboundRtp.packetsLost;
            const sent = (remoteInboundRtp.packetsReceived || 0) + lost;
            lossRatio = sent > 0 ? lost / sent : 0;
          } else if (outboundVideoReport.packetsLost >= 0) {
            lossRatio = outboundVideoReport.packetsLost / Math.max(1, outboundVideoReport.packetsSent);
          }
        }
        let rtt = 0;
        stats.forEach(r => { if (r.type === 'candidate-pair' && r.currentRtt) rtt = r.currentRtt; });
        if (lossRatio > 0.08 || rtt > 0.5) await setSenderMaxBitrate(BITRATE_LOW);
        else if (lossRatio > 0.03 || rtt > 0.25) await setSenderMaxBitrate(BITRATE_MEDIUM);
        else await setSenderMaxBitrate(BITRATE_HIGH);
      } catch (e) {}
    }, STATS_POLL_MS);
  }
  function stopStatsMonitor() { if (statsInterval) { clearInterval(statsInterval); statsInterval = null; } }

  // ---------------- EXIT & MEDIA ----------------
  exitBtn.onclick = () => {
    cleanupConnection();
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    location.href = 'index.html';
  };
  async function initMedia() {
    if (isBanned) { updateStatusMessage('⛔ You are banned for 24 hours.'); return false; }
    if (localStream) return true;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
      updateMicButton();
      return true;
    } catch (e) {
      updateStatusMessage('Camera/Mic access denied.');
      localStream = null;
      updateMicButton();
      return false;
    }
  }

  // ---------------- INITIALIZE ----------------
  async function initialize() {
    ensureNotifyEmpty();
    updateMicButton();
    try {
      const fingerprint = await generateFingerprint();
      safeEmit('identify', { fingerprint });
    } catch (e) {}
    startSearch();
  }
  initialize();

  // ---------------- GLOBAL ERROR HANDLERS ----------------
  window.addEventListener('error', e => {
    console.error('Global error:', e.error);
    updateStatusMessage('An unexpected error occurred. Refreshing...');
    setSafeTimer(() => location.reload(), 3000);
  });
  window.addEventListener('unhandledrejection', e => {
    console.error('Unhandled promise rejection:', e.reason);
    updateStatusMessage('Connection error detected.');
    if (!partnerId && !isBanned) setSafeTimer(startSearchLoop, 1000);
  });
  window.onbeforeunload = () => {
    safeEmit('stop');
    cleanupConnection();
    if (localStream) localStream.getTracks().forEach(t => t.stop());
  };

  // ---------------- (typing indicator) ----------------
  const typingIndicator = document.createElement('div');
  typingIndicator.id = 'typingIndicator';
  typingIndicator.className = 'msg system';
  typingIndicator.style.display = 'none';
  typingIndicator.style.fontStyle = 'italic';
  typingIndicator.textContent = 'Stranger is typing...';
  chatMessages.appendChild(typingIndicator);
  let typing = false, typingTimer = null;
  const TYPING_PAUSE = 1500;
  function sendTyping() {
    if (!partnerId || isBanned) return;
    if (!typing) { typing = true; safeEmit('typing', { to: partnerId }); }
    clearSafeTimer(typingTimer);
    typingTimer = setSafeTimer(() => { typing = false; safeEmit('stop-typing', { to: partnerId }); }, TYPING_PAUSE);
  }
  chatInput.oninput = () => { if (!chatInput.disabled && !isBanned) sendTyping(); };
  sendBtn.onclick = () => {
    if (isBanned) return;
    const msg = chatInput.value.trim();
    if (!msg || !partnerId) return;
    addMessage(msg, 'you');
    safeEmit('chat-message', { to: partnerId, message: msg });
    chatInput.value = '';
    typing = false;
    safeEmit('stop-typing', { to: partnerId });
  };
  chatInput.onkeypress = e => { if (e.key === 'Enter' && !isBanned) sendBtn.click(); };
  micBtn.onclick = () => {
    if (!localStream || isBanned) return;
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    updateMicButton();
  };
});

// ---------------- دالة البصمة (لم تتغير) ----------------
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
    ctx.textBaseline = 'top'; ctx.font = '14px Arial'; ctx.fillStyle = '#f60'; ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069'; ctx.fillText('fingerprint', 2, 15);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)'; ctx.fillText('fingerprint', 4, 17);
    components.push(canvas.toDataURL());
    const audioCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
    const oscillator = audioCtx.createOscillator(); oscillator.type = 'triangle'; oscillator.frequency.setValueAtTime(10000, audioCtx.currentTime);
    oscillator.connect(audioCtx.destination); oscillator.start(); oscillator.stop();
    components.push('audio-supported');
    const hashCode = str => { let hash = 0; for (let i = 0; i < str.length; i++) { const char = str.charCodeAt(i); hash = ((hash << 5) - hash) + char; hash = hash & hash; } return hash.toString(16); };
    return hashCode(components.join('||'));
  } catch (e) { return 'default-fp-' + Math.random().toString(36).substr(2, 9); }
}
