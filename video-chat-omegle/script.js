// =====================================================
// نظام إدارة الاتصال المحسّن - Chat Application
// =====================================================
class ChatApp {
  constructor() {
    this.socket = io();
    this.config = {
      PING_INTERVAL: 4000,
      PONG_TIMEOUT: 11000,
      STATS_POLL_MS: 3000,
      BITRATE_HIGH: 800000,
      BITRATE_MEDIUM: 400000,
      BITRATE_LOW: 160000,
      TYPING_PAUSE: 1500,
      SEARCH_TIMEOUT: 3500,
      AD_TIMEOUT: 50000,
      MAX_CONSECUTIVE_FAILS: 3,
      NORMAL_PAUSE_DURATION: 3000
    };
  
    this.state = {
      localStream: null,
      peerConnection: null,
      partnerId: null,
      isInitiator: false,
      micEnabled: true,
      isBanned: false,
      consecutiveSearchFails: 0,
      makingOffer: false,
      ignoreOffer: false,
      partnerVideoReady: false,
      localVideoReadySent: false,
      isAdPlaying: false,
      currentAdIndex: 0
    };
    this.timers = new Set();
    this.statsInterval = null;
    this.pingTimer = null;
    this.searchTimer = null;
    this.pauseTimer = null;
    this.typingTimer = null;
  
    this.bufferedRemoteCandidates = [];
    this.reportedIds = new Set();
    this.reportCounts = new Map();
  
    this.servers = { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };
  
    this.adVideosList = [
      'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251224_122947959.mp4',
      'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251221_081055765.mp4',
      'https://raw.githubusercontent.com/azerty197358/myads/main/Single%20girl%20video%20chat%20-%20Video%20Calls%20Apps%20(360p%20,h264).mp4',
      'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251221_153328953.mp4',
      'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251224_123428027.mp4'
    ];
  
    this.adVideo = null;
    this.keepAliveChannel = null;
    this.lastPong = Date.now();
    this.typing = false;
  
    this.init();
  }
  // =====================================================
  // تهيئة التطبيق
  // =====================================================
  async init() {
    this.setupDOMElements();
    this.setupEventListeners();
    this.setupTypingIndicator();
    this.createAdVideoElement();
    this.ensureNotifyEmpty();
    this.updateMicButton();
  
    try {
      const fingerprint = await this.generateFingerprint();
      this.safeEmit('identify', { fingerprint });
    } catch (e) {
      console.error('Failed to send fingerprint:', e);
    }
  
    this.startSearch();
  }
  setupDOMElements() {
    this.elements = {
      notifyBell: document.getElementById('notifyIcon'),
      notifyDot: document.getElementById('notifyDot'),
      notifyMenu: document.getElementById('notifyMenu'),
      localVideo: document.getElementById('localVideo'),
      remoteVideo: document.getElementById('remoteVideo'),
      localSpinner: document.getElementById('localSpinner'),
      remoteSpinner: document.getElementById('remoteSpinner'),
      reportBtn: document.getElementById('reportBtn'),
      micBtn: document.getElementById('micBtn'),
      chatMessages: document.getElementById('chatMessages'),
      chatInput: document.getElementById('chatInput'),
      sendBtn: document.getElementById('sendBtn'),
      skipBtn: document.getElementById('skipBtn'),
      exitBtn: document.getElementById('exitBtn')
    };
  }
  // =====================================================
  // إدارة المؤقتات
  // =====================================================
  setSafeTimer(callback, delay) {
    const timerId = setTimeout(() => {
      this.timers.delete(timerId);
      callback();
    }, delay);
    this.timers.add(timerId);
    return timerId;
  }
  clearSafeTimer(timerId) {
    if (timerId) {
      clearTimeout(timerId);
      this.timers.delete(timerId);
    }
  }
  clearAllTimers() {
    this.timers.forEach(timerId => clearTimeout(timerId));
    this.timers.clear();
    if (this.statsInterval) clearInterval(this.statsInterval);
    if (this.pingTimer) clearInterval(this.pingTimer);
  }
  // =====================================================
  // إدارة البيانات والاتصال
  // =====================================================
  safeEmit(event, data) {
    try {
      if (this.socket.connected) {
        this.socket.emit(event, data);
        return true;
      }
      console.warn(`Socket not connected, cannot emit ${event}`);
      return false;
    } catch (e) {
      console.error(`Error emitting ${event}:`, e);
      return false;
    }
  }
  async generateFingerprint() {
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
    
      try {
        const audioCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
        const oscillator = audioCtx.createOscillator();
        oscillator.type = 'triangle';
        oscillator.frequency.setValueAtTime(10000, audioCtx.currentTime);
        oscillator.connect(audioCtx.destination);
        oscillator.start();
        oscillator.stop();
        components.push('audio-supported');
      } catch (e) {
        components.push('audio-unsupported');
      }
    
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
  // =====================================================
  // إدارة واجهة المستخدم
  // =====================================================
  addMessage(msg, type = 'system') {
    const d = document.createElement('div');
    d.className = `msg ${type}`;
    d.textContent = msg;
    const typing = document.querySelector('.msg.system[style*="italic"]');
    if (typing && typing.parentNode === this.elements.chatMessages) {
      this.elements.chatMessages.insertBefore(d, typing);
    } else {
      this.elements.chatMessages.appendChild(d);
    }
    this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
  }
  updateStatusMessage(msg) {
    let statusMsg = document.getElementById('statusMessage');
    if (statusMsg) {
      statusMsg.textContent = msg;
    } else {
      statusMsg = document.createElement('div');
      statusMsg.id = 'statusMessage';
      statusMsg.className = 'msg status';
      statusMsg.textContent = msg;
      const typing = document.querySelector('.msg.system[style*="italic"]');
      if (typing && typing.parentNode === this.elements.chatMessages) {
        this.elements.chatMessages.insertBefore(statusMsg, typing);
      } else {
        this.elements.chatMessages.appendChild(statusMsg);
      }
    }
    this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
  }
  pushAdminNotification(text) {
    const item = document.createElement('div');
    item.className = 'notify-item';
    item.textContent = text;
    this.elements.notifyMenu.prepend(item);
    const empty = this.elements.notifyMenu.querySelector('.notify-empty');
    if (empty) empty.remove();
  }
  ensureNotifyEmpty() {
    if (this.elements.notifyMenu.children.length === 0) {
      const d = document.createElement('div');
      d.textContent = 'No notifications';
      d.className = 'notify-empty';
      this.elements.notifyMenu.appendChild(d);
    }
  }
  enableChat() {
    this.elements.chatInput.disabled = this.state.isBanned;
    this.elements.sendBtn.disabled = this.state.isBanned;
  }
  disableChat() {
    this.elements.chatInput.disabled = true;
    this.elements.sendBtn.disabled = true;
  }
  updateMicButton() {
    this.elements.micBtn.textContent = this.state.micEnabled ? '🎤' : '🔇';
    this.elements.micBtn.disabled = !this.state.localStream || this.state.isBanned;
    this.elements.micBtn.style.opacity = (this.state.localStream && !this.state.isBanned) ? '1' : '0.8';
  }
  showRemoteSpinnerOnly(show) {
    if (this.elements.remoteSpinner) this.elements.remoteSpinner.style.display = show ? 'block' : 'none';
    if (this.elements.remoteVideo) this.elements.remoteVideo.style.display = show ? 'none' : 'block';
    if (this.elements.localVideo) this.elements.localVideo.style.display = 'block';
  }
hideAllSpinners() {
  if (this.elements.remoteSpinner) this.elements.remoteSpinner.style.display = 'none';
  if (this.elements.localSpinner) this.elements.localSpinner.style.display = 'none';
  if (this.elements.remoteVideo) this.elements.remoteVideo.style.display = 'block';
  if (this.elements.localVideo) this.elements.localVideo.style.display = 'block';
}  // =====================================================
  // إدارة الإعلانات
  // =====================================================
  createAdVideoElement() {
    if (this.adVideo) {
      this.adVideo.remove();
    }
    this.adVideo = document.createElement('video');
    this.adVideo.id = 'adVideo';
    this.adVideo.autoplay = false;
    this.adVideo.muted = true;
    this.adVideo.playsInline = true;
    this.adVideo.preload = 'auto';
    this.adVideo.style.position = 'absolute';
    this.adVideo.style.top = '0';
    this.adVideo.style.left = '0';
    this.adVideo.style.width = '100%';
    this.adVideo.style.height = '100%';
    this.adVideo.style.objectFit = 'cover';
    this.adVideo.style.zIndex = '100';
    this.adVideo.style.display = 'none';
    this.adVideo.style.backgroundColor = '#000';
    this.adVideo.controls = false;
    this.elements.remoteVideo.parentNode.appendChild(this.adVideo);
  }
  playAdVideo() {
    if (this.state.isAdPlaying || this.adVideosList.length === 0) {
      this.state.consecutiveSearchFails = 0;
      this.config.NORMAL_PAUSE_DURATION = 3000;
      this.updateStatusMessage('Searching...');
      this.startSearchLoop();
      return;
    }
  
    this.clearSafeTimer(this.searchTimer);
    this.clearSafeTimer(this.pauseTimer);
    this.searchTimer = null;
    this.pauseTimer = null;
    this.state.isAdPlaying = true;
  
    const adUrl = this.adVideosList[this.state.currentAdIndex];
    this.state.currentAdIndex = (this.state.currentAdIndex + 1) % this.adVideosList.length;
  
    this.updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger Say hello 😊🤝');
  
    this.adVideo.onerror = () => {
      console.error('Error loading ad video:', adUrl);
      this.hideAdVideo();
    };
  
    this.adVideo.oncanplay = () => {
      this.adVideo.play().catch(e => {
        console.warn('Auto-play prevented:', e);
        document.addEventListener('click', this.tryPlayAdOnClick.bind(this), { once: true });
      });
    };
  
    this.adVideo.onended = this.hideAdVideo.bind(this);
    this.adVideo.src = adUrl;
    this.adVideo.style.display = 'block';
    this.elements.remoteVideo.style.display = 'none';
  
    const adTimeout = this.setSafeTimer(this.hideAdVideo.bind(this), this.config.AD_TIMEOUT);
  
    this.adTimeout = adTimeout;
  }
  tryPlayAdOnClick() {
    this.adVideo.play().catch(console.warn);
  }
  hideAdVideo() {
    if (!this.state.isAdPlaying) return;
  
    this.clearSafeTimer(this.adTimeout);
    document.removeEventListener('click', this.tryPlayAdOnClick.bind(this));
    this.adVideo.pause();
    this.adVideo.style.display = 'none';
    this.elements.remoteVideo.style.display = 'block';
    this.adVideo.src = '';
    this.state.isAdPlaying = false;
    this.state.consecutiveSearchFails = 0;
    this.config.NORMAL_PAUSE_DURATION = 3000;
    this.updateStatusMessage('Searching...');
    this.startSearchLoop();
  }
  // =====================================================
  // إدارة الاتصال
  // =====================================================
  cleanupConnection() {
    console.log('Cleaning up connection...');
    this.clearAllTimers();
  
    if (this.state.peerConnection) {
      try {
        if (this.keepAliveChannel) {
          this.keepAliveChannel.close();
          this.keepAliveChannel = null;
        }
        this.state.peerConnection.close();
      } catch (e) {
        console.error('Error closing peer connection:', e);
      }
      this.state.peerConnection = null;
    }
  
    if (this.elements.remoteVideo) {
      this.elements.remoteVideo.srcObject = null;
    }
  
    this.bufferedRemoteCandidates.length = 0;
    this.state.partnerId = null;
    this.state.isInitiator = false;
    this.state.makingOffer = false;
    this.state.ignoreOffer = false;
    this.state.partnerVideoReady = false;
    this.state.localVideoReadySent = false;
  }
  sendLocalVideoReady() {
    if (this.state.localVideoReadySent || !this.state.partnerId) return;
    this.state.localVideoReadySent = true;
    this.safeEmit('video-ready', { to: this.state.partnerId });
  }
  // =====================================================
  // إدارة البحث والمطابقة
  // =====================================================
  startSearchLoop() {
    if (this.state.isBanned) {
      this.updateStatusMessage('⛔ You have been banned for 24 hours 🕐 for engaging in inappropriate behavior 🚫 and violating our policy terms 📜. ⚠️');
      this.showRemoteSpinnerOnly(false);
      return;
    }
  
    if (this.state.partnerId || this.state.isAdPlaying) return;
  
    this.showRemoteSpinnerOnly(true);
    this.updateStatusMessage('Searching...');
    this.safeEmit('find-partner');
  
    this.clearSafeTimer(this.searchTimer);
    this.searchTimer = this.setSafeTimer(() => {
      if (!this.state.partnerId && !this.state.isAdPlaying) {
        this.safeEmit('stop');
        this.showRemoteSpinnerOnly(false);
        this.state.consecutiveSearchFails++;
      
        if (this.state.consecutiveSearchFails >= this.config.MAX_CONSECUTIVE_FAILS) {
          this.playAdVideo();
          return;
        }
      
        this.clearSafeTimer(this.pauseTimer);
        this.pauseTimer = this.setSafeTimer(() => {
          if (this.config.NORMAL_PAUSE_DURATION !== 3000) {
            this.config.NORMAL_PAUSE_DURATION = 3000;
          }
          this.startSearchLoop();
        }, this.config.NORMAL_PAUSE_DURATION);
      }
    }, this.config.SEARCH_TIMEOUT);
  }
  async startSearch() {
    if (this.state.isBanned) {
      this.updateStatusMessage('⛔ You have been banned for 24 hours 🕐 for engaging in inappropriate behavior 🚫 and violating our policy terms 📜. ⚠️');
      this.showRemoteSpinnerOnly(false);
      return;
    }
  
    const mediaReady = await this.initMedia();
    if (!mediaReady) return;
  
    this.cleanupConnection();
    this.elements.chatMessages.innerHTML = '';
    this.elements.chatMessages.appendChild(this.typingIndicator);
    this.showRemoteSpinnerOnly(true);
    this.elements.skipBtn.disabled = false;
    this.state.consecutiveSearchFails = 0;
    this.config.NORMAL_PAUSE_DURATION = 3000;
    this.startSearchLoop();
  }
  // =====================================================
  // إدارة الوسائط
  // =====================================================
  async initMedia() {
    if (this.state.isBanned) {
      this.updateStatusMessage('⛔ You have been banned for 24 hours 🕐 for engaging in inappropriate behavior 🚫 and violating our policy terms 📜. ⚠️');
      return false;
    }
  
    if (this.state.localStream) return true;
  
    const attempt = async () => {
      try {
        this.state.localStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true
        });
        this.elements.localVideo.srcObject = this.state.localStream;
       
        // إزالة المؤشر الدائري من شاشة المستخدم المحلي
        if (this.elements.localSpinner) {
          this.elements.localSpinner.style.display = 'none';
        }
       
        this.updateMicButton();
        this.updateStatusMessage('Media access granted. Starting search...');
        return true;
      } catch (e) {
        console.error('Media access denied:', e);
        this.updateStatusMessage('📹🎤 Please allow camera and microphone access to continue. Retrying in 2 seconds...');
        this.setSafeTimer(attempt, 2000);
        return false;
      }
    };
  
    return await attempt();
  }
  // =====================================================
  // إدارة WebRTC
  // =====================================================
  createPeerConnection() {
    if (this.state.peerConnection) {
      try { this.state.peerConnection.close(); } catch (e) {}
      this.state.peerConnection = null;
    }
  
    try {
      this.state.peerConnection = new RTCPeerConnection(this.servers);
      this.state.makingOffer = false;
      this.state.ignoreOffer = false;
    
      if (this.state.localStream) {
        this.state.localStream.getTracks().forEach(t => {
          this.state.peerConnection.addTrack(t, this.state.localStream);
        });
      }
    
      if (this.state.isInitiator) {
        try {
          this.keepAliveChannel = this.state.peerConnection.createDataChannel('keepAlive', { ordered: true });
          this.setupKeepAliveChannel(this.keepAliveChannel);
        } catch (e) {
          console.error('Failed to create data channel:', e);
          this.keepAliveChannel = null;
        }
      } else {
        this.state.peerConnection.ondatachannel = (ev) => {
          this.keepAliveChannel = ev.channel;
          this.setupKeepAliveChannel(this.keepAliveChannel);
        };
      }
    
      this.state.peerConnection.ontrack = e => {
        if (!e.streams || e.streams.length === 0) return;
        this.elements.remoteVideo.srcObject = e.streams[0];
        this.sendLocalVideoReady();
      
        if (this.state.partnerVideoReady) {
          this.updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger Say hello 😊🤝');
          this.hideAllSpinners();
          this.enableChat();
          this.startStatsMonitor();
        }
      };
    
      this.state.peerConnection.onicecandidate = e => {
        if (e.candidate && this.state.partnerId) {
          this.safeEmit('signal', { to: this.state.partnerId, data: { candidate: e.candidate } });
        }
      };
    
      this.state.peerConnection.onconnectionstatechange = () => {
        if (!this.state.peerConnection) return;
        const s = this.state.peerConnection.connectionState;
      
        if (s === 'connected') {
          // Connection established
        } else if (['disconnected', 'failed', 'closed'].includes(s)) {
          if (!this.state.isBanned) {
            this.updateStatusMessage('Connection lost.');
            this.disableChat();
            this.cleanupConnection();
            this.clearSafeTimer(this.searchTimer);
            this.clearSafeTimer(this.pauseTimer);
            this.state.consecutiveSearchFails = 0;
            this.config.NORMAL_PAUSE_DURATION = 3000;
            this.setSafeTimer(() => this.startSearchLoop(), 500);
          }
        }
      };
    
      this.state.peerConnection.onnegotiationneeded = async () => {
        if (!this.state.peerConnection || this.state.makingOffer || !this.state.partnerId) return;
      
        try {
          this.state.makingOffer = true;
          const offer = await this.state.peerConnection.createOffer();
          await this.state.peerConnection.setLocalDescription(offer);
          this.safeEmit('signal', { to: this.state.partnerId, data: offer });
        } catch (e) {
          console.error('Negotiation error:', e);
        } finally {
          this.state.makingOffer = false;
        }
      };
    } catch (e) {
      console.error('Failed to create peer connection:', e);
      throw e;
    }
  }
  setupKeepAliveChannel(dc) {
    if (!dc) return;
  
    dc.onopen = () => {
      this.lastPong = Date.now();
      this.startPingLoop();
    };
  
    dc.onmessage = (ev) => {
      if (!ev.data) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'ping') {
          dc.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        } else if (msg.type === 'pong') {
          this.lastPong = Date.now();
        }
      } catch (e) {}
    };
  
    dc.onclose = () => this.stopPingLoop();
    dc.onerror = (err) => console.error('keepAlive error:', err);
  }
  startPingLoop() {
    this.stopPingLoop();
    this.pingTimer = setInterval(() => {
      if (!this.keepAliveChannel || this.keepAliveChannel.readyState !== 'open') {
        this.stopPingLoop();
        return;
      }
    
      try {
        this.keepAliveChannel.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      } catch (e) {
        this.stopPingLoop();
      }
    
      if (Date.now() - this.lastPong > this.config.PONG_TIMEOUT) {
        this.stopPingLoop();
        this.cleanupConnection();
        this.clearSafeTimer(this.searchTimer);
        this.clearSafeTimer(this.pauseTimer);
        this.state.consecutiveSearchFails = 0;
        this.config.NORMAL_PAUSE_DURATION = 3000;
        this.setSafeTimer(() => this.startSearchLoop(), 500);
      }
    }, this.config.PING_INTERVAL);
  }
  stopPingLoop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
  async setSenderMaxBitrate(targetBps) {
    if (!this.state.peerConnection) return;
  
    try {
      const senders = this.state.peerConnection.getSenders();
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
  startStatsMonitor() {
    this.stopStatsMonitor();
    this.statsInterval = setInterval(async () => {
      if (!this.state.peerConnection || this.state.peerConnection.connectionState !== 'connected') {
        this.stopStatsMonitor();
        return;
      }
    
      try {
        const stats = await this.state.peerConnection.getStats(null);
        let outboundVideoReport = null;
        let remoteInboundRtp = null;
      
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
      
        if (lossRatio > 0.08 || rtt > 0.5) {
          await this.setSenderMaxBitrate(this.config.BITRATE_LOW);
        } else if (lossRatio > 0.03 || rtt > 0.25) {
          await this.setSenderMaxBitrate(this.config.BITRATE_MEDIUM);
        } else {
          await this.setSenderMaxBitrate(this.config.BITRATE_HIGH);
        }
      } catch (e) {
        console.debug('Stats monitor error:', e);
      }
    }, this.config.STATS_POLL_MS);
  }
  stopStatsMonitor() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }
  // =====================================================
  // إدارة المرشحين (Candidates)
  // =====================================================
  bufferRemoteCandidate(candidateObj) {
    this.bufferedRemoteCandidates.push(candidateObj);
  }
  flushBufferedCandidates() {
    while (this.bufferedRemoteCandidates.length && this.state.peerConnection) {
      const c = this.bufferedRemoteCandidates.shift();
      try {
        this.state.peerConnection.addIceCandidate(c).catch(() => {});
      } catch (e) {}
    }
  }
  // =====================================================
  // إدارة الإبلاغ (Report)
  // =====================================================
  async captureRemoteVideoFrame() {
    return new Promise((resolve, reject) => {
      try {
        const v = this.elements.remoteVideo;
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
  // =====================================================
  // إعداد مستمعي الأحداث
  // =====================================================
  setupEventListeners() {
    // Notification menu
    this.elements.notifyBell.onclick = (e) => {
      e.stopPropagation();
      if (this.elements.notifyDot) this.elements.notifyDot.style.display = 'none';
      this.elements.notifyBell.classList.remove('shake');
      this.elements.notifyMenu.style.display = this.elements.notifyMenu.style.display === 'block' ? 'none' : 'block';
    };
  
    document.onclick = () => { this.elements.notifyMenu.style.display = 'none'; };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') this.elements.notifyMenu.style.display = 'none'; });
  
    // Skip button
    this.elements.skipBtn.onclick = () => {
      if (this.state.isBanned) return;
      this.safeEmit('skip');
      this.updateStatusMessage('You skipped.');
      this.disableChat();
      this.cleanupConnection();
      this.clearSafeTimer(this.searchTimer);
      this.clearSafeTimer(this.pauseTimer);
      this.state.consecutiveSearchFails = 0;
      this.config.NORMAL_PAUSE_DURATION = 3000;
      this.startSearchLoop();
    };
  
    // Exit button
    this.elements.exitBtn.onclick = () => {
      this.cleanupConnection();
      if (this.state.localStream) {
        this.state.localStream.getTracks().forEach(t => t.stop());
      }
      location.href = 'index.html';
    };
  
    // Mic button
    this.elements.micBtn.onclick = () => {
      if (!this.state.localStream || this.state.isBanned) return;
      this.state.micEnabled = !this.state.micEnabled;
      this.state.localStream.getAudioTracks().forEach(t => t.enabled = this.state.micEnabled);
      this.updateMicButton();
    };
  
    // Report button
    if (this.elements.reportBtn) {
      this.elements.reportBtn.style.display = 'flex';
      this.elements.reportBtn.onclick = async () => {
        if (!this.state.partnerId) {
          this.updateStatusMessage("No user to report.");
          return;
        }
      
        const prev = this.reportCounts.get(this.state.partnerId) || 0;
        const now = prev + 1;
        this.reportCounts.set(this.state.partnerId, now);
        this.reportedIds.add(this.state.partnerId);
      
        this.safeEmit("report", { partnerId: this.state.partnerId });
        this.safeEmit("skip");
      
        if (now === 1) {
          try {
            this.addMessage("Capturing screenshot for admin review...", "system");
            const image = await this.captureRemoteVideoFrame();
            this.safeEmit("admin-screenshot", { image, partnerId: this.state.partnerId });
            this.addMessage("📋 A report about this user has been sent ✉️⚠️. Action is being reviewed 🔍⏳.", "system");
          } catch (err) {
            console.error('Screenshot capture failed', err);
            this.addMessage("Failed to capture screenshot (no remote frame available).", "system");
          }
        }
      
        this.cleanupConnection();
        this.disableChat();
        this.updateStatusMessage('You reported the user — skipping...');
        this.clearSafeTimer(this.searchTimer);
        this.clearSafeTimer(this.pauseTimer);
        this.state.consecutiveSearchFails = 0;
        this.config.NORMAL_PAUSE_DURATION = 3000;
        this.startSearchLoop();
      };
    }
  }
  setupTypingIndicator() {
    this.typingIndicator = document.createElement('div');
    this.typingIndicator.className = 'msg system';
    this.typingIndicator.style.display = 'none';
    this.typingIndicator.style.fontStyle = 'italic';
    this.typingIndicator.textContent = 'Stranger is typing...';
    this.elements.chatMessages.appendChild(this.typingIndicator);
  
    const sendTyping = () => {
      if (!this.state.partnerId || this.state.isBanned) return;
      if (!this.typing) {
        this.typing = true;
        this.safeEmit('typing', { to: this.state.partnerId });
      }
      this.clearSafeTimer(this.typingTimer);
      this.typingTimer = this.setSafeTimer(() => {
        this.typing = false;
        this.safeEmit('stop-typing', { to: this.state.partnerId });
      }, this.config.TYPING_PAUSE);
    };
  
    this.elements.chatInput.oninput = () => {
      if (!this.elements.chatInput.disabled && !this.state.isBanned) sendTyping();
    };
  
    const sendMessage = () => {
      if (this.state.isBanned) return;
      const msg = this.elements.chatInput.value.trim();
      if (!msg || !this.state.partnerId) return;
      this.addMessage(msg, 'you');
      this.safeEmit('chat-message', { to: this.state.partnerId, message: msg });
      this.elements.chatInput.value = '';
      this.typing = false;
      this.safeEmit('stop-typing', { to: this.state.partnerId });
    };
  
    this.elements.sendBtn.onclick = sendMessage;
    this.elements.chatInput.onkeypress = e => { if (e.key === 'Enter' && !this.state.isBanned) sendMessage(); };
  }
  // =====================================================
  // مستمعي Socket
  // =====================================================
  setupSocketListeners() {
    this.socket.on('waiting', msg => {
      if (!this.state.isBanned) this.updateStatusMessage(msg);
    });
  
    this.socket.on('chat-message', ({ message }) => {
      if (!this.state.isBanned) this.addMessage(message, 'them');
    });
  
    this.socket.on('typing', () => {
      if (!this.state.isBanned) {
        this.typingIndicator.style.display = 'block';
        this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
      }
    });
  
    this.socket.on('stop-typing', () => {
      if (!this.state.isBanned) this.typingIndicator.style.display = 'none';
    });
  
    this.socket.on('adminMessage', msg => {
      if (this.elements.notifyDot) this.elements.notifyDot.style.display = 'block';
      this.elements.notifyBell.classList.add('shake');
      this.pushAdminNotification('📢 ' + msg);
      this.addMessage('📢 Admin: ' + msg, 'system');
    });
  
    this.socket.on('banned', ({ message }) => {
      this.state.isBanned = true;
      this.addMessage(message || 'You are banned.', 'system');
      this.showRemoteSpinnerOnly(true);
      this.updateStatusMessage('⛔ You have been banned for 24 hours 🕐 for engaging in inappropriate behavior 🚫 and violating our policy terms 📜. ⚠️');
      this.cleanupConnection();
      this.disableChat();
      if (this.state.localStream) {
        this.state.localStream.getTracks().forEach(t => t.stop());
        this.state.localStream = null;
      }
      if (this.elements.localVideo) this.elements.localVideo.srcObject = null;
      this.updateMicButton();
    });
  
    this.socket.on('unbanned', ({ message }) => {
      this.state.isBanned = false;
      this.addMessage(message || 'You have been unbanned.', 'system');
      this.updateStatusMessage('You have been unbanned.');
      this.startSearch();
    });
  
    this.socket.on('partner-disconnected', () => {
      if (!this.state.isBanned) {
        this.updateStatusMessage('Partner disconnected.');
        this.disableChat();
        this.cleanupConnection();
        this.clearSafeTimer(this.searchTimer);
        this.clearSafeTimer(this.pauseTimer);
        this.state.consecutiveSearchFails = 0;
        this.config.NORMAL_PAUSE_DURATION = 3000;
        this.setSafeTimer(() => this.startSearchLoop(), 500);
      }
    });
  
    this.socket.on('video-ready', ({ from }) => {
      if (this.state.partnerId && from === this.state.partnerId) {
        this.state.partnerVideoReady = true;
        if (this.state.localVideoReadySent) {
          this.updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger Say hello 😊🤝');
          this.hideAllSpinners();
          this.enableChat();
          this.startStatsMonitor();
        }
      }
    });
  
    this.socket.on('partner-found', async data => {
      if (this.state.isBanned) {
        this.safeEmit('skip');
        return;
      }
    
      const foundId = data?.id || data?.partnerId;
      if (!foundId) {
        console.error('Invalid partner data received:', data);
        this.updateStatusMessage('Invalid partner data. Retrying...');
        this.setSafeTimer(() => this.startSearchLoop(), 1000);
        return;
      }
    
      if (this.reportedIds.has(foundId)) {
        this.safeEmit('skip');
        this.updateStatusMessage('Found reported user — skipping...');
        this.cleanupConnection();
        this.setSafeTimer(() => this.startSearchLoop(), 200);
        return;
      }
    
      this.state.partnerId = foundId;
      this.state.isInitiator = !!data.initiator;
      this.state.partnerVideoReady = false;
      this.state.localVideoReadySent = false;
    
      this.hideAllSpinners();
      this.updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger Say hello 😊🤝');
      this.state.consecutiveSearchFails = 0;
      this.config.NORMAL_PAUSE_DURATION = 3000;
    
      try {
        this.createPeerConnection();
        if (this.state.isInitiator) {
          this.state.makingOffer = true;
          const offer = await this.state.peerConnection.createOffer();
          await this.state.peerConnection.setLocalDescription(offer);
          this.safeEmit('signal', { to: this.state.partnerId, data: offer });
        }
      } catch (e) {
        console.error('Failed to create peer connection or offer:', e);
        this.updateStatusMessage('Connection setup failed. Retrying...');
        this.cleanupConnection();
        this.setSafeTimer(() => this.startSearchLoop(), 1000);
      } finally {
        this.state.makingOffer = false;
      }
    });
  
    this.socket.on('signal', async ({ from, data }) => {
      if (this.state.isBanned) return;
      if (!from || !data) {
        console.error('Invalid signal data:', { from, data });
        return;
      }
    
      if (this.state.partnerId && this.state.partnerId !== from) {
        console.warn('Signal from unexpected partner:', from, 'expected:', this.state.partnerId);
        return;
      }
    
      if (!this.state.peerConnection) {
        try {
          this.createPeerConnection();
        } catch (e) {
          console.error('Failed to create peer connection for signal:', e);
          return;
        }
      }
    
      if (data.candidate && !this.state.peerConnection.remoteDescription) {
        this.bufferRemoteCandidate(data.candidate);
        return;
      }
    
      try {
        if (data.type === 'offer') {
          const offerCollision = (this.state.makingOffer || this.state.peerConnection.signalingState !== 'stable');
          this.state.ignoreOffer = !this.state.isInitiator && offerCollision;
          if (this.state.ignoreOffer) return;
        
          await this.state.peerConnection.setRemoteDescription(data);
          const answer = await this.state.peerConnection.createAnswer();
          await this.state.peerConnection.setLocalDescription(answer);
          this.safeEmit('signal', { to: from, data: answer });
        } else if (data.type === 'answer') {
          await this.state.peerConnection.setRemoteDescription(data);
        } else if (data.candidate) {
          await this.state.peerConnection.addIceCandidate(data.candidate);
        }
      } catch (e) {
        console.error('Signal handling error:', e);
        this.updateStatusMessage('Connection error – skipping partner...');
        this.safeEmit('skip');
        this.cleanupConnection();
        this.setSafeTimer(() => this.startSearchLoop(), 1000);
      }
    });
  }
}
// =====================================================
// تهيئة التطبيق عند تحميل DOM
// =====================================================
window.addEventListener('DOMContentLoaded', () => {
  const app = new ChatApp();
  // إعداد مستمعي Socket بعد إنشاء التطبيق
  app.setupSocketListeners();
  // معالجة الأخطاء العالمية
  window.addEventListener('error', (e) => {
    console.error('Global error:', e.error);
    app.updateStatusMessage('An unexpected error occurred. Recovering...');
    app.cleanupConnection();
    app.setSafeTimer(() => app.startSearchLoop(), 2000);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled promise rejection:', e.reason);
    app.updateStatusMessage('Connection error detected. Recovering...');
    app.cleanupConnection();
    app.setSafeTimer(() => app.startSearchLoop(), 1000);
  });
  window.onbeforeunload = () => {
    app.safeEmit('stop');
    app.cleanupConnection();
    if (app.state.localStream) {
      app.state.localStream.getTracks().forEach(t => t.stop());
    }
  };
});
