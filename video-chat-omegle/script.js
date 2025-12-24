window.addEventListener('DOMContentLoaded', () => {
  // ==================== نظام إدارة الاتصالات المحسن ====================
  class ConnectionManager {
    constructor() {
      this.state = {
        socket: null,
        peerConnection: null,
        partnerId: null,
        isInitiator: false,
        micEnabled: true,
        isBanned: false,
        localStream: null,
        partnerVideoReady: false,
        localVideoReadySent: false,
        makingOffer: false,
        ignoreOffer: false,
        isAdPlaying: false,
        isSearching: false,
        connectionAttempts: 0,
        maxConnectionAttempts: 3,
        connectionTimeout: 10000
      };

      this.servers = {
        iceServers: [
          { urls: ['stun:stun.l.google.com:19302'] },
          { urls: ['stun:stun1.l.google.com:19302'] },
          { urls: ['stun:stun2.l.google.com:19302'] },
          { urls: ['stun:stun3.l.google.com:19302'] }
        ],
        iceCandidatePoolSize: 10
      };

      this.bufferedRemoteCandidates = [];
      this.activeTimers = new Set();
      this.reportedIds = new Set();
      this.reportCounts = new Map();
      this.consecutiveSearchFails = 0;
      this.normalPauseDuration = 3000;
      
      // عناصر DOM
      this.elements = {};
      this.initializeDOM();
      
      // الإعلانات
      this.adVideosList = [
        'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251224_122947959.mp4',
        'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251221_081055765.mp4',
        'https://raw.githubusercontent.com/azerty197358/myads/main/Single%20girl%20video%20chat%20-%20Video%20Calls%20Apps%20(360p,%20h264).mp4',
        'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251221_153328953.mp4',
        'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251224_123428027.mp4'
      ];
      this.currentAdIndex = 0;
      this.adVideo = null;
    }

    // ==================== تهيئة عناصر DOM ====================
    initializeDOM() {
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

      this.setupEventListeners();
      this.createAdVideoElement();
      this.createTypingIndicator();
    }

    // ==================== إعداد مستمعي الأحداث ====================
    setupEventListeners() {
      // نظام الإشعارات
      this.elements.notifyBell.onclick = (e) => {
        e.stopPropagation();
        if (this.elements.notifyDot) this.elements.notifyDot.style.display = 'none';
        this.elements.notifyBell.classList.remove('shake');
        this.elements.notifyMenu.style.display = 
          this.elements.notifyMenu.style.display === 'block' ? 'none' : 'block';
      };

      document.onclick = () => { this.elements.notifyMenu.style.display = 'none'; };
      document.addEventListener('keydown', e => { 
        if (e.key === 'Escape') this.elements.notifyMenu.style.display = 'none'; 
      });

      // عناصر التحكم في الدردشة
      this.elements.sendBtn.onclick = () => this.sendMessage();
      this.elements.chatInput.onkeypress = (e) => { 
        if (e.key === 'Enter' && !this.state.isBanned) this.sendMessage(); 
      };

      // الميكروفون
      this.elements.micBtn.onclick = () => this.toggleMic();

      // تخطي
      this.elements.skipBtn.onclick = () => this.skipPartner();

      // الخروج
      this.elements.exitBtn.onclick = () => this.exitApplication();

      // الإبلاغ
      if (this.elements.reportBtn) {
        this.elements.reportBtn.style.display = 'flex';
        this.elements.reportBtn.onclick = () => this.reportCurrentUser();
      }
    }

    // ==================== نظام المؤقتات الآمن ====================
    setSafeTimer(callback, delay) {
      const timerId = setTimeout(() => {
        this.activeTimers.delete(timerId);
        callback();
      }, delay);
      this.activeTimers.add(timerId);
      return timerId;
    }

    clearSafeTimer(timerId) {
      if (timerId) {
        clearTimeout(timerId);
        this.activeTimers.delete(timerId);
      }
    }

    clearAllTimers() {
      this.activeTimers.forEach(timerId => clearTimeout(timerId));
      this.activeTimers.clear();
      if (this.statsInterval) clearInterval(this.statsInterval);
      if (this.pingTimer) clearInterval(this.pingTimer);
    }

    // ==================== نظام الإعلانات ====================
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
        this.consecutiveSearchFails = 0;
        this.normalPauseDuration = 3000;
        this.updateStatusMessage('Searching...');
        this.startSearchLoop();
        return;
      }

      this.clearAllTimers();
      this.state.isAdPlaying = true;
      const adUrl = this.adVideosList[this.currentAdIndex];
      this.currentAdIndex = (this.currentAdIndex + 1) % this.adVideosList.length;
      
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

      this.adVideo.onended = () => this.hideAdVideo();
      this.adVideo.src = adUrl;
      this.adVideo.style.display = 'block';
      this.elements.remoteVideo.style.display = 'none';

      const adTimeout = this.setSafeTimer(() => this.hideAdVideo(), 50000);
    }

    tryPlayAdOnClick() {
      this.adVideo.play().catch(console.warn);
    }

    hideAdVideo() {
      if (!this.state.isAdPlaying) return;
      
      this.adVideo.pause();
      this.adVideo.style.display = 'none';
      this.elements.remoteVideo.style.display = 'block';
      this.adVideo.src = '';
      this.state.isAdPlaying = false;
      this.consecutiveSearchFails = 0;
      this.normalPauseDuration = 3000;
      
      this.updateStatusMessage('Searching...');
      this.startSearchLoop();
    }

    // ==================== إدارة الإشعارات ====================
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

    // ==================== إدارة الرسائل والدردشة ====================
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
      if (!statusMsg) {
        statusMsg = document.createElement('div');
        statusMsg.id = 'statusMessage';
        statusMsg.className = 'msg status';
        this.elements.chatMessages.appendChild(statusMsg);
      }
      statusMsg.textContent = msg;
      this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
    }

    createTypingIndicator() {
      this.typingIndicator = document.createElement('div');
      this.typingIndicator.className = 'msg system';
      this.typingIndicator.style.display = 'none';
      this.typingIndicator.style.fontStyle = 'italic';
      this.typingIndicator.textContent = 'Stranger is typing...';
      this.elements.chatMessages.appendChild(this.typingIndicator);
      
      this.typing = false;
      this.typingTimer = null;
      this.TYPING_PAUSE = 1500;
      
      this.elements.chatInput.oninput = () => {
        if (!this.elements.chatInput.disabled && !this.state.isBanned) {
          this.sendTyping();
        }
      };
    }

    sendTyping() {
      if (!this.state.partnerId || this.state.isBanned) return;
      
      if (!this.typing) {
        this.typing = true;
        this.safeEmit('typing', { to: this.state.partnerId });
      }
      
      this.clearSafeTimer(this.typingTimer);
      this.typingTimer = this.setSafeTimer(() => {
        this.typing = false;
        this.safeEmit('stop-typing', { to: this.state.partnerId });
      }, this.TYPING_PAUSE);
    }

    sendMessage() {
      if (this.state.isBanned) return;
      
      const msg = this.elements.chatInput.value.trim();
      if (!msg || !this.state.partnerId) return;
      
      this.addMessage(msg, 'you');
      this.safeEmit('chat-message', { to: this.state.partnerId, message: msg });
      this.elements.chatInput.value = '';
      this.typing = false;
      this.safeEmit('stop-typing', { to: this.state.partnerId });
    }

    // ==================== إدارة الميكروفون ====================
    updateMicButton() {
      this.elements.micBtn.textContent = this.state.micEnabled ? '🎤' : '🔇';
      this.elements.micBtn.disabled = !this.state.localStream || this.state.isBanned;
      this.elements.micBtn.style.opacity = (this.state.localStream && !this.state.isBanned) ? '1' : '0.8';
    }

    toggleMic() {
      if (!this.state.localStream || this.state.isBanned) return;
      
      this.state.micEnabled = !this.state.micEnabled;
      this.state.localStream.getAudioTracks().forEach(t => t.enabled = this.state.micEnabled);
      this.updateMicButton();
    }

    // ==================== إدارة السبينر ====================
    showRemoteSpinnerOnly(show) {
      if (this.elements.remoteSpinner) {
        this.elements.remoteSpinner.style.display = show ? 'block' : 'none';
      }
      if (this.elements.remoteVideo) {
        this.elements.remoteVideo.style.display = show ? 'none' : 'block';
      }
      if (this.elements.localVideo) {
        this.elements.localVideo.style.display = 'block';
      }
    }

    hideAllSpinners() {
      if (this.elements.remoteSpinner) this.elements.remoteSpinner.style.display = 'none';
      if (this.elements.remoteVideo) this.elements.remoteVideo.style.display = 'block';
      if (this.elements.localVideo) this.elements.localVideo.style.display = 'block';
    }

    // ==================== إدارة الدردشة ====================
    enableChat() {
      this.elements.chatInput.disabled = this.state.isBanned;
      this.elements.sendBtn.disabled = this.state.isBanned;
    }

    disableChat() {
      this.elements.chatInput.disabled = true;
      this.elements.sendBtn.disabled = true;
    }

    // ==================== نظام إعدادات الوسائط ====================
    async initMedia() {
      if (this.state.isBanned) {
        this.updateStatusMessage('⛔ You have been banned for 24 hours 🕐 for engaging in inappropriate behavior 🚫 and violating our policy terms 📜. ⚠️');
        return false;
      }

      if (this.state.localStream) return true;

      try {
        this.state.localStream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 30 }
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });

        this.elements.localVideo.srcObject = this.state.localStream;
        this.updateMicButton();
        this.updateStatusMessage('Media access granted. Starting search...');
        return true;
      } catch (e) {
        console.error('Media access denied:', e);
        this.updateStatusMessage('📹🎤 Please allow camera and microphone access to continue. Retrying in 2 seconds...');
        
        // محاولة مرة أخرى
        await new Promise(resolve => setTimeout(resolve, 2000));
        return await this.initMedia();
      }
    }

    // ==================== توليد بصمة المستخدم ====================
    async generateFingerprint() {
      try {
        const components = [
          navigator.userAgent,
          navigator.language,
          screen.colorDepth,
          screen.width + 'x' + screen.height,
          navigator.hardwareConcurrency || 0,
          new Date().getTimezoneOffset(),
          Intl.DateTimeFormat().resolvedOptions().timeZone || '',
          !!window.WebGLRenderingContext
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

    // ==================== إرسال آمن عبر السوكيت ====================
    safeEmit(event, data) {
      try {
        if (this.state.socket && this.state.socket.connected) {
          this.state.socket.emit(event, data);
          return true;
        }
        console.warn(`Socket not connected, cannot emit ${event}`);
        return false;
      } catch (e) {
        console.error(`Error emitting ${event}:`, e);
        return false;
      }
    }

    // ==================== إدارة البحث عن شركاء ====================
    startSearchLoop() {
      if (this.state.isBanned || this.state.partnerId || this.state.isAdPlaying) {
        return;
      }

      this.showRemoteSpinnerOnly(true);
      this.updateStatusMessage('Searching for a partner...');
      this.state.isSearching = true;

      this.safeEmit('find-partner');

      this.searchTimer = this.setSafeTimer(() => {
        if (!this.state.partnerId && !this.state.isAdPlaying) {
          this.safeEmit('stop');
          this.showRemoteSpinnerOnly(false);
          
          this.consecutiveSearchFails++;
          if (this.consecutiveSearchFails >= 3) {
            this.playAdVideo();
            return;
          }

          this.pauseTimer = this.setSafeTimer(() => {
            if (this.normalPauseDuration !== 3000) this.normalPauseDuration = 3000;
            this.startSearchLoop();
          }, this.normalPauseDuration);
        }
      }, 3500);
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
      this.consecutiveSearchFails = 0;
      this.normalPauseDuration = 3000;

      this.startSearchLoop();
    }

    skipPartner() {
      if (this.state.isBanned) return;

      this.safeEmit('skip');
      this.updateStatusMessage('You skipped the conversation.');
      this.disableChat();
      this.cleanupConnection();
      this.clearAllTimers();
      this.consecutiveSearchFails = 0;
      this.normalPauseDuration = 3000;
      this.startSearchLoop();
    }

    // ==================== إدارة تقارير المستخدمين ====================
    async reportCurrentUser() {
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
      this.clearAllTimers();
      this.consecutiveSearchFails = 0;
      this.normalPauseDuration = 3000;
      this.startSearchLoop();
    }

    async captureRemoteVideoFrame() {
      return new Promise((resolve, reject) => {
        try {
          const v = this.elements.remoteVideo;
          if (!v || !v.srcObject) {
            return reject(new Error('Remote video not available'));
          }

          const captureFrame = () => {
            const width = v.videoWidth || v.clientWidth || 640;
            const height = v.videoHeight || v.clientHeight || 480;

            if (width === 0 || height === 0) {
              setTimeout(captureFrame, 250);
              return;
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(v, 0, 0, width, height);
            resolve(canvas.toDataURL('image/png'));
          };

          if (v.readyState >= 2) { // HAVE_CURRENT_DATA or better
            captureFrame();
          } else {
            v.addEventListener('loadeddata', captureFrame, { once: true });
            setTimeout(() => reject(new Error('Video frame timeout')), 1000);
          }
        } catch (err) {
          reject(err);
        }
      });
    }

    // ==================== إشارات جاهزية الفيديو ====================
    sendLocalVideoReady() {
      if (this.state.localVideoReadySent || !this.state.partnerId) return;
      
      this.state.localVideoReadySent = true;
      this.safeEmit('video-ready', { to: this.state.partnerId });
    }

    // ==================== إدارة اتصال WebRTC ====================
    async createPeerConnection() {
      if (this.state.peerConnection) {
        try {
          this.state.peerConnection.close();
        } catch (e) {
          console.error('Error closing existing peer connection:', e);
        }
      }

      try {
        this.state.peerConnection = new RTCPeerConnection(this.servers);
        this.state.makingOffer = false;
        this.state.ignoreOffer = false;

        // إضافة المسارات المحلية
        if (this.state.localStream) {
          this.state.localStream.getTracks().forEach(track => {
            this.state.peerConnection.addTrack(track, this.state.localStream);
          });
        }

        // إعداد القنوات
        this.setupDataChannels();
        this.setupPeerConnectionEvents();

      } catch (e) {
        console.error('Failed to create peer connection:', e);
        throw e;
      }
    }

    setupDataChannels() {
      if (this.state.isInitiator) {
        try {
          this.keepAliveChannel = this.state.peerConnection.createDataChannel('keepAlive', {
            ordered: true,
            maxRetransmits: 3
          });
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
    }

    setupPeerConnectionEvents() {
      const pc = this.state.peerConnection;

      pc.ontrack = (e) => {
        if (!e.streams || e.streams.length === 0) return;

        this.elements.remoteVideo.srcObject = e.streams[0];
        this.sendLocalVideoReady();

        if (this.state.partnerVideoReady) {
          this.finalizeConnection();
        }
      };

      pc.onicecandidate = (e) => {
        if (e.candidate && this.state.partnerId) {
          this.safeEmit('signal', {
            to: this.state.partnerId,
            data: { candidate: e.candidate }
          });
        }
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        console.log('ICE connection state:', state);

        if (state === 'failed' || state === 'disconnected') {
          this.handleConnectionFailure();
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        console.log('Connection state:', state);

        if (state === 'connected') {
          this.state.connectionAttempts = 0;
        } else if (state === 'failed') {
          this.handleConnectionFailure();
        }
      };

      pc.onnegotiationneeded = async () => {
        if (!pc || this.state.makingOffer || !this.state.partnerId) return;

        try {
          this.state.makingOffer = true;
          const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
          });

          await pc.setLocalDescription(offer);
          this.safeEmit('signal', {
            to: this.state.partnerId,
            data: offer
          });
        } catch (e) {
          console.error('Negotiation error:', e);
        } finally {
          this.state.makingOffer = false;
        }
      };
    }

    setupKeepAliveChannel(dc) {
      if (!dc) return;

      dc.onopen = () => {
        this.lastPong = Date.now();
        this.startPingLoop();
      };

      dc.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'ping') {
            dc.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          } else if (msg.type === 'pong') {
            this.lastPong = Date.now();
          }
        } catch (e) {
          console.error('Keep alive message parsing error:', e);
        }
      };

      dc.onclose = () => this.stopPingLoop();
      dc.onerror = (err) => console.error('Keep alive channel error:', err);
    }

    startPingLoop() {
      this.stopPingLoop();
      
      this.pingTimer = setInterval(() => {
        if (!this.keepAliveChannel || this.keepAliveChannel.readyState !== 'open') {
          this.stopPingLoop();
          return;
        }

        try {
          this.keepAliveChannel.send(JSON.stringify({
            type: 'ping',
            ts: Date.now()
          }));
        } catch (e) {
          this.stopPingLoop();
        }

        if (Date.now() - this.lastPong > 11000) {
          console.warn('Pong timeout - connection may be dead');
          this.stopPingLoop();
          this.handleConnectionFailure();
        }
      }, 4000);
    }

    stopPingLoop() {
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
    }

    // ==================== معالجة إشارات WebRTC ====================
    async handleSignal({ from, data }) {
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
          await this.createPeerConnection();
        } catch (e) {
          console.error('Failed to create peer connection for signal:', e);
          return;
        }
      }

      if (data.candidate && !this.state.peerConnection.remoteDescription) {
        this.bufferedRemoteCandidates.push(data.candidate);
        return;
      }

      try {
        if (data.type === 'offer') {
          const offerCollision = (this.state.makingOffer || 
            this.state.peerConnection.signalingState !== 'stable');
          
          this.state.ignoreOffer = !this.state.isInitiator && offerCollision;
          if (this.state.ignoreOffer) return;

          await this.state.peerConnection.setRemoteDescription(data);
          const answer = await this.state.peerConnection.createAnswer();
          await this.state.peerConnection.setLocalDescription(answer);
          
          this.safeEmit('signal', { to: from, data: answer });

        } else if (data.type === 'answer') {
          await this.state.peerConnection.setRemoteDescription(data);
          this.flushBufferedCandidates();

        } else if (data.candidate) {
          await this.state.peerConnection.addIceCandidate(data.candidate);
        }
      } catch (e) {
        console.error('Signal handling error:', e);
        this.handleConnectionFailure();
      }
    }

    flushBufferedCandidates() {
      while (this.bufferedRemoteCandidates.length && this.state.peerConnection) {
        const candidate = this.bufferedRemoteCandidates.shift();
        try {
          this.state.peerConnection.addIceCandidate(candidate).catch(() => {});
        } catch (e) {
          console.error('Error adding buffered candidate:', e);
        }
      }
    }

    // ==================== معالجة فشل الاتصال ====================
    handleConnectionFailure() {
      if (this.state.isBanned) return;

      this.state.connectionAttempts++;
      
      if (this.state.connectionAttempts >= this.state.maxConnectionAttempts) {
        this.updateStatusMessage('Connection failed multiple times. Skipping partner...');
        this.safeEmit('skip');
        this.cleanupConnection();
        this.startSearchLoop();
      } else {
        this.updateStatusMessage(`Connection issue detected (attempt ${this.state.connectionAttempts}/${this.state.maxConnectionAttempts})...`);
        this.reconnectWithDelay(1000 * this.state.connectionAttempts);
      }
    }

    reconnectWithDelay(delay) {
      this.setSafeTimer(() => {
        if (!this.state.partnerId || this.state.isBanned) return;
        this.createPeerConnection();
      }, delay);
    }

    // ==================== تنظيف الاتصال ====================
    cleanupConnection() {
      console.log('Cleaning up connection...');

      this.clearAllTimers();
      this.stopPingLoop();
      this.stopStatsMonitor();

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
      this.state.connectionAttempts = 0;
      this.state.isSearching = false;
    }

    // ==================== إنهاء الاتصال النهائي ====================
    finalizeConnection() {
      this.updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger Say hello 😊🤝');
      this.hideAllSpinners();
      this.enableChat();
      this.startStatsMonitor();
    }

    // ==================== مراقبة إحصائيات الجودة ====================
    startStatsMonitor() {
      this.stopStatsMonitor();

      this.statsInterval = setInterval(async () => {
        if (!this.state.peerConnection || 
            this.state.peerConnection.connectionState !== 'connected') {
          this.stopStatsMonitor();
          return;
        }

        try {
          const stats = await this.state.peerConnection.getStats();
          let videoOutbound = null;
          let videoInbound = null;

          stats.forEach(report => {
            if (report.type === 'outbound-rtp' && report.kind === 'video') {
              videoOutbound = report;
            }
            if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
              videoInbound = report;
            }
          });

          if (videoOutbound) {
            await this.adjustBitrateBasedOnStats(videoOutbound, videoInbound);
          }
        } catch (e) {
          console.debug('Stats monitor error:', e);
        }
      }, 3000);
    }

    async adjustBitrateBasedOnStats(outbound, inbound) {
      let lossRatio = 0;
      let rtt = 0;

      if (outbound.packetsSent > 0) {
        if (inbound?.packetsLost >= 0) {
          const lost = inbound.packetsLost;
          const received = inbound.packetsReceived || 0;
          const sent = received + lost;
          lossRatio = sent > 0 ? lost / sent : 0;
        }
      }

      // استخراج RTT من الإحصائيات
      const stats = await this.state.peerConnection.getStats();
      stats.forEach(report => {
        if (report.type === 'candidate-pair' && report.currentRtt) {
          rtt = report.currentRtt;
        }
      });

      // ضبط معدل البت بناءً على الجودة
      let targetBitrate;
      if (lossRatio > 0.08 || rtt > 0.5) {
        targetBitrate = 160000; // منخفض
      } else if (lossRatio > 0.03 || rtt > 0.25) {
        targetBitrate = 400000; // متوسط
      } else {
        targetBitrate = 800000; // عالي
      }

      await this.setSenderMaxBitrate(targetBitrate);
    }

    async setSenderMaxBitrate(targetBps) {
      if (!this.state.peerConnection) return;

      try {
        const senders = this.state.peerConnection.getSenders();
        for (const sender of senders) {
          if (!sender.track || sender.track.kind !== 'video') continue;

          const params = sender.getParameters();
          if (!params.encodings) {
            params.encodings = [{}];
          }

          params.encodings = params.encodings.map(enc => ({
            ...enc,
            maxBitrate: targetBps
          }));

          await sender.setParameters(params);
        }
      } catch (e) {
        console.debug('setSenderMaxBitrate failed', e);
      }
    }

    stopStatsMonitor() {
      if (this.statsInterval) {
        clearInterval(this.statsInterval);
        this.statsInterval = null;
      }
    }

    // ==================== معالجة أحداث السوكيت ====================
    setupSocketEvents(socket) {
      this.state.socket = socket;

      socket.on('waiting', (msg) => {
        if (!this.state.isBanned) this.updateStatusMessage(msg);
      });

      socket.on('chat-message', ({ message }) => {
        if (!this.state.isBanned) this.addMessage(message, 'them');
      });

      socket.on('typing', () => {
        if (!this.state.isBanned) {
          this.typingIndicator.style.display = 'block';
          this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
        }
      });

      socket.on('stop-typing', () => {
        if (!this.state.isBanned) this.typingIndicator.style.display = 'none';
      });

      socket.on('adminMessage', (msg) => {
        if (this.elements.notifyDot) this.elements.notifyDot.style.display = 'block';
        this.elements.notifyBell.classList.add('shake');
        this.pushAdminNotification('📢 ' + msg);
        this.addMessage('📢 Admin: ' + msg, 'system');
      });

      socket.on('banned', ({ message }) => {
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

      socket.on('unbanned', ({ message }) => {
        this.state.isBanned = false;
        this.addMessage(message || 'You have been unbanned.', 'system');
        this.updateStatusMessage('You have been unbanned.');
        this.startSearch();
      });

      socket.on('partner-disconnected', () => {
        if (!this.state.isBanned) {
          this.updateStatusMessage('Partner disconnected.');
          this.disableChat();
          this.cleanupConnection();
          this.clearAllTimers();
          this.consecutiveSearchFails = 0;
          this.normalPauseDuration = 3000;
          this.setSafeTimer(() => this.startSearchLoop(), 500);
        }
      });

      socket.on('video-ready', ({ from }) => {
        if (this.state.partnerId && from === this.state.partnerId) {
          this.state.partnerVideoReady = true;
          
          if (this.state.localVideoReadySent) {
            this.finalizeConnection();
          }
        }
      });

      socket.on('partner-found', async (data) => {
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
        this.consecutiveSearchFails = 0;
        this.normalPauseDuration = 3000;

        try {
          await this.createPeerConnection();
          
          if (this.state.isInitiator) {
            this.state.makingOffer = true;
            const offer = await this.state.peerConnection.createOffer({
              offerToReceiveAudio: true,
              offerToReceiveVideo: true
            });
            
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

      socket.on('signal', (data) => this.handleSignal(data));
    }

    // ==================== الخروج من التطبيق ====================
    exitApplication() {
      this.cleanupConnection();
      
      if (this.state.localStream) {
        this.state.localStream.getTracks().forEach(t => t.stop());
      }
      
      if (this.state.socket) {
        this.safeEmit('stop');
      }
      
      location.href = 'index.html';
    }

    // ==================== تهيئة التطبيق ====================
    async initialize() {
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
  }

  // ==================== تهيئة ونظام معالجة الأخطاء ====================
  let connectionManager;

  try {
    connectionManager = new ConnectionManager();
    
    // إعداد السوكيت
    const socket = io();
    connectionManager.setupSocketEvents(socket);

    // تهيئة التطبيق
    connectionManager.initialize();

  } catch (error) {
    console.error('Failed to initialize connection manager:', error);
    document.body.innerHTML = '<div style="padding: 20px; color: red;">Application initialization failed. Please refresh.</div>';
  }

  // معالجة الأخطاء العامة
  window.addEventListener('error', (e) => {
    console.error('Global error:', e.error);
    
    if (connectionManager) {
      connectionManager.updateStatusMessage('An unexpected error occurred. Recovering...');
      connectionManager.cleanupConnection();
      connectionManager.setSafeTimer(() => connectionManager.startSearchLoop(), 2000);
    }
  });

  window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled promise rejection:', e.reason);
    
    if (connectionManager) {
      connectionManager.updateStatusMessage('Connection error detected. Recovering...');
      connectionManager.cleanupConnection();
      connectionManager.setSafeTimer(() => connectionManager.startSearchLoop(), 1000);
    }
  });

  window.onbeforeunload = () => {
    if (connectionManager) {
      connectionManager.exitApplication();
    }
  };
});
