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
  //// ---------------------- GLOBAL STATE ----------------------
  let localStream = null;
  let peerConnection = null;
  let partnerId = null;
  let isInitiator = false;
  let micEnabled = true;
  // متغير جديد لتتبع حالة الحظر
  let isBanned = false;
  // Timer management
  const activeTimers = new Set();
  let searchTimer = null;
  let pauseTimer = null;
  const servers = { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };
  const reportedIds = new Set();
  const reportCounts = new Map();
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
      // Canvas fingerprint
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
      // Audio fingerprint
      const audioCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
      const oscillator = audioCtx.createOscillator();
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(10000, audioCtx.currentTime);
      oscillator.connect(audioCtx.destination);
      oscillator.start();
      oscillator.stop();
      components.push('audio-supported');
      // Hash function
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
  // Status message handler
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
  // Store remote candidates until pc created
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
  // Set max bitrate for outbound video sender
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
    if (remoteVideo) {
      remoteVideo.srcObject = null;
    }
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
  // ---------------------- SEND CHAT ----------------------
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
  chatInput.onkeypress = e => { if (e.key === 'Enter' && !isBanned) sendMessage(); };
  // ---------------------- MIC CONTROL ----------------------
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
        if (!v || !v.srcObject) {
          return reject(new Error('Remote video not available'));
        }
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
  // ---------------------- REPORT & SKIP BUTTONS ----------------------
  if (reportBtn) {
    reportBtn.style.display = 'flex';
    reportBtn.onclick = async () => {
      if (!partnerId) {
        updateStatusMessage("لا يوجد مستخدم للإبلاغ عنه.");
        return;
      }
      const prev = reportCounts.get(partnerId) || 0;
      const now = prev + 1;
      reportCounts.set(partnerId, now);
      reportedIds.add(partnerId);

      safeEmit("report", { partnerId });
      // لا نرسل skip هنا، سنقوم بالتخطي مباشرة بعد التنظيف
      if (now === 1) {
        try {
          addMessage("جاري التقاط لقطة شاشة لمراجعة الإدارة...", "system");
          const image = await captureRemoteVideoFrame();
          safeEmit("admin-screenshot", { image, partnerId });
          addMessage("تم إرسال اللقطة إلى الإدارة.", "system");
        } catch (err) {
          console.error('فشل التقاط اللقطة', err);
          addMessage("فشل التقاط لقطة (لا توجد إطارات متاحة).", "system");
        }
      }

      // تخطي المستخدم الحالي مباشرة وبدء البحث عن آخر
      cleanupConnection();
      disableChat();
      updateStatusMessage('تم الإبلاغ عن المستخدم — جاري البحث عن مستخدم آخر...');
      clearSafeTimer(searchTimer);
      clearSafeTimer(pauseTimer);
      startSearchLoop(); // بدء البحث فوراً بدون تأخير
    };
  }

  skipBtn.onclick = () => {
    if (isBanned) return;
    updateStatusMessage('تم التخطي.');
    disableChat();
    cleanupConnection();
    clearSafeTimer(searchTimer);
    clearSafeTimer(pauseTimer);
    startSearchLoop();
  };
  // ---------------------- UI CONTROLS ----------------------
  function enableChat() {
    chatInput.disabled = isBanned;
    sendBtn.disabled = isBanned;
  }
  function disableChat() {
    chatInput.disabled = true;
    sendBtn.disabled = true;
  }
  // ---------------------- MATCHMAKING ----------------------
  function startSearchLoop() {
    if (isBanned) {
      updateStatusMessage('لقد تم حظرك لمدة 24 ساعة بسبب سلوك غير لائق وانتهاك شروط السياسة.');
      showRemoteSpinnerOnly(false);
      return;
    }
    if (partnerId) return;
    showRemoteSpinnerOnly(true);
    updateStatusMessage('جاري البحث عن مستخدم...');
    safeEmit('find-partner');
  }

  async function startSearch() {
    if (isBanned) {
      updateStatusMessage('لقد تم حظرك لمدة 24 ساعة بسبب سلوك غير لائق وانتهاك شروط السياسة.');
      showRemoteSpinnerOnly(false);
      return;
    }
    const mediaReady = await initMedia();
    if (!mediaReady) {
      updateStatusMessage('فشل تهيئة الوسائط. يرجى السماح بالوصول إلى الكاميرا/الميكروفون.');
      return;
    }
    cleanupConnection();
    chatMessages.innerHTML = '';
    chatMessages.appendChild(typingIndicator);
    showRemoteSpinnerOnly(true);
    skipBtn.disabled = false;
    startSearchLoop();
  }
  // ---------------------- SOCKET EVENTS ----------------------
  socket.on('waiting', msg => {
    if (!isBanned) updateStatusMessage(msg);
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
  socket.on('adminMessage', msg => {
    if (notifyDot) notifyDot.style.display = 'block';
    notifyBell.classList.add('shake');
    pushAdminNotification('📢 ' + msg);
    addMessage('📢 الإدارة: ' + msg, 'system');
  });
  socket.on('banned', ({ message }) => {
    isBanned = true;
    addMessage(message || 'تم حظرك.', 'system');
    showRemoteSpinnerOnly(true);
    updateStatusMessage('لقد تم حظرك لمدة 24 ساعة بسبب سلوك غير لائق وانتهاك شروط السياسة.');
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
    addMessage(message || 'تم فك الحظر عنك.', 'system');
    updateStatusMessage('تم فك الحظر عنك. يمكنك الآن استخدام التطبيق مرة أخرى.');
    startSearch();
  });
  socket.on('partner-disconnected', () => {
    if (!isBanned) {
      updateStatusMessage('انقطع اتصال الشريك.');
      disableChat();
      cleanupConnection();
      startSearchLoop(); // لا إعادة محاولة، بل نبحث عن مستخدم جديد مباشرة
    }
  });
  socket.on('partner-found', async data => {
    if (isBanned) return;
    const foundId = data?.id || data?.partnerId;
    if (!foundId) {
      console.error('بيانات شريك غير صالحة:', data);
      updateStatusMessage('بيانات غير صالحة. جاري البحث مجدداً...');
      startSearchLoop();
      return;
    }
    if (reportedIds.has(foundId)) {
      updateStatusMessage('تم العثور على مستخدم تم الإبلاغ عنه مسبقاً — جاري التخطي...');
      cleanupConnection();
      startSearchLoop();
      return;
    }
    partnerId = foundId;
    isInitiator = !!data.initiator;
    hideAllSpinners();
    updateStatusMessage('جاري الاتصال...');
    try {
      createPeerConnection();
      if (isInitiator) {
        makingOffer = true;
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        safeEmit('signal', { to: partnerId, data: offer });
      }
    } catch (e) {
      console.error('فشل إنشاء الاتصال:', e);
      updateStatusMessage('فشل إعداد الاتصال. جاري البحث عن مستخدم آخر...');
      cleanupConnection();
      startSearchLoop();
    } finally {
      makingOffer = false;
    }
  });
  socket.on('signal', async ({ from, data }) => {
    if (isBanned) return;
    if (!from || !data) {
      console.error('بيانات إشارة غير صالحة:', { from, data });
      return;
    }
    if (partnerId && partnerId !== from) {
      console.warn('إشارة من شريك غير متوقع:', from, 'متوقع:', partnerId);
      return;
    }
    if (!peerConnection) {
      try {
        createPeerConnection();
      } catch (e) {
        console.error('فشل إنشاء اتصال للإشارة:', e);
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
      console.error('خطأ في معالجة الإشارة:', e);
      updateStatusMessage('فشل معالجة الإشارة. جاري البحث عن مستخدم آخر...');
      cleanupConnection();
      startSearchLoop();
    }
  });
  // ---------------------- WEBRTC ----------------------
  function createPeerConnection() {
    if (peerConnection) {
      try { peerConnection.close(); } catch (e) {}
      peerConnection = null;
    }
    try {
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
          console.error('فشل إنشاء قناة البيانات:', e);
          keepAliveChannel = null;
        }
      } else {
        peerConnection.ondatachannel = (ev) => {
          keepAliveChannel = ev.channel;
          setupKeepAliveChannel(keepAliveChannel);
        };
      }
      peerConnection.ontrack = e => {
        if (!e.streams || e.streams.length === 0) return;
        remoteVideo.srcObject = e.streams[0];
        enableChat();
        updateStatusMessage('متصل');
        showRemoteSpinnerOnly(false);
        flushBufferedCandidates();
        startStatsMonitor();
      };
      peerConnection.onicecandidate = e => {
        if (e.candidate && partnerId) {
          safeEmit('signal', { to: partnerId, data: { candidate: e.candidate } });
        }
      };
      peerConnection.onconnectionstatechange = () => {
        if (!peerConnection) return;
        const s = peerConnection.connectionState;
        console.debug('connectionState:', s);
        if (s === 'connected') {
          updateStatusMessage('متصل');
        } else if (['disconnected', 'failed', 'closed'].includes(s)) {
          if (!isBanned) {
            updateStatusMessage('انقطع الاتصال.');
            disableChat();
            cleanupConnection();
            startSearchLoop(); // لا إعادة محاولة، بل نبحث عن مستخدم جديد
          }
        }
      };
      peerConnection.oniceconnectionstatechange = () => {
        if (!peerConnection) return;
        const s = peerConnection.iceConnectionState;
        console.debug('iceConnectionState:', s);
        if (s === 'failed') {
          // لا نحاول ICE restart، بل نتخطى مباشرة
          cleanupConnection();
          startSearchLoop();
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
          console.error('خطأ في التفاوض:', e);
        } finally {
          makingOffer = false;
        }
      };
    } catch (e) {
      console.error('فشل إنشاء اتصال Peer:', e);
      throw e;
    }
  }
  // ---------------------- KEEPALIVE (datachannel) ----------------------
  let pingTimer = null;
  function setupKeepAliveChannel(dc) {
    if (!dc) return;
    dc.onopen = () => {
      lastPong = Date.now();
      startPingLoop();
    };
    dc.onmessage = (ev) => {
      if (!ev.data) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'ping') {
          dc.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        } else if (msg.type === 'pong') {
          lastPong = Date.now();
        }
      } catch (e) {
        console.error('خطأ في تحليل رسالة KeepAlive:', e);
      }
    };
    dc.onclose = () => {
      console.debug('قناة keepAlive مغلقة');
      stopPingLoop();
    };
    dc.onerror = (err) => {
      console.error('خطأ في قناة keepAlive:', err);
    };
  }
  function startPingLoop() {
    stopPingLoop();
    pingTimer = setInterval(() => {
      if (!keepAliveChannel || keepAliveChannel.readyState !== 'open') {
        stopPingLoop();
        return;
      }
      try {
        keepAliveChannel.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      } catch (e) {
        console.error('خطأ في إرسال ping:', e);
        stopPingLoop();
      }
      if (Date.now() - lastPong > PONG_TIMEOUT) {
        console.warn('انتهت مهلة PONG -> تخطي الاتصال');
        stopPingLoop();
        cleanupConnection();
        startSearchLoop();
      }
    }, PING_INTERVAL);
  }
  function stopPingLoop() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }
  // ---------------------- STATS MONITOR (adaptive bitrate) ----------------------
  function startStatsMonitor() {
    stopStatsMonitor();
    statsInterval = setInterval(async () => {
      if (!peerConnection || peerConnection.connectionState !== 'connected') {
        stopStatsMonitor();
        return;
      }
      try {
        const stats = await peerConnection.getStats(null);
        let outboundVideoReport = null;
        let remoteInboundRtp = null;
        stats.forEach(report => {
          if (report.type === 'outbound-rtp' && report.kind === 'video') {
            outboundVideoReport = report;
          }
          if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
            remoteInboundRtp = report;
          }
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
        if (lossRatio > 0.08 || rtt > 0.5) {
          await setSenderMaxBitrate(BITRATE_LOW);
        } else if (lossRatio > 0.03 || rtt > 0.25) {
          await setSenderMaxBitrate(BITRATE_MEDIUM);
        } else {
          await setSenderMaxBitrate(BITRATE_HIGH);
        }
      } catch (e) {
        console.debug('خطأ في مراقب الإحصائيات:', e);
      }
    }, STATS_POLL_MS);
  }
  function stopStatsMonitor() {
    if (statsInterval) {
      clearInterval(statsInterval);
      statsInterval = null;
    }
  }
  // ---------------------- EXIT ----------------------
  exitBtn.onclick = () => {
    cleanupConnection();
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
    }
    location.href = 'index.html';
  };
  // ---------------------- MEDIA INIT ----------------------
  async function initMedia() {
    if (isBanned) {
      updateStatusMessage('لقد تم حظرك. يرجى الاتصال بالإدارة للحصول على المساعدة.');
      return false;
    }
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
      console.error('خطأ في تهيئة الوسائط:', e);
      updateStatusMessage('تم رفض الوصول إلى الكاميرا/الميكروفون. يرجى التحقق من الأذونات.');
      localStream = null;
      updateMicButton();
      return false;
    }
  }
  // ---------------------- AUTO START ----------------------
  async function initialize() {
    ensureNotifyEmpty();
    updateMicButton();
    try {
      const fingerprint = await generateFingerprint();
      safeEmit('identify', { fingerprint });
    } catch (e) {
      console.error('فشل إرسال البصمة:', e);
    }
    startSearch();
  }
  initialize();
  // ---------------------- GLOBAL ERROR HANDLERS ----------------------
  window.addEventListener('error', (e) => {
    console.error('خطأ عام:', e.error);
    updateStatusMessage('حدث خطأ غير متوقع. جاري إعادة التحميل...');
    setSafeTimer(() => location.reload(), 3000);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('رفض وعد غير معالج:', e.reason);
    updateStatusMessage('تم اكتشاف خطأ في الاتصال. جاري البحث عن مستخدم جديد...');
    cleanupConnection();
    startSearchLoop();
  });
  window.onbeforeunload = () => {
    safeEmit('stop');
    cleanupConnection();
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
    }
  };
});
