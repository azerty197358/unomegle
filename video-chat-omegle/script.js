// ملف main.js - كود كامل منظم ومستقر
class VideoChatApp {
    constructor() {
        // تهيئة جميع المتغيرات
        this.socket = null;
        this.peerConnection = null;
        this.localStream = null;
        this.remoteStream = null;
        this.partnerId = null;
        this.isInitiator = false;
        this.isConnected = false;
        this.isSearching = false;
        this.isBanned = false;
        this.reconnectionAttempts = 0;
        this.maxReconnectionAttempts = 3;
        
        // عناصر DOM
        this.elements = {};
        
        // تتبع الوقت
        this.connectionStartTime = null;
        this.searchStartTime = null;
        
        // الإعدادات
        this.config = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' }
            ],
            reconnectDelay: 1000,
            searchTimeout: 10000,
            connectionTimeout: 15000,
            keepAliveInterval: 5000
        };
        
        // الإعلانات
        this.adVideos = [
            'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251221_081055765.mp4',
            'https://raw.githubusercontent.com/azerty197358/myads/main/Single%20girl%20video%20chat%20-%20Video%20Calls%20Apps%20(360p,%20h264).mp4',
            'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251221_153328953.mp4'
        ];
        
        this.initialize();
    }

    async initialize() {
        try {
            await this.initializeDOM();
            await this.initializeSocket();
            await this.initializeMedia();
            this.setupEventListeners();
            this.startApplication();
        } catch (error) {
            console.error('Initialization failed:', error);
            this.showError('Failed to initialize application');
        }
    }

    async initializeDOM() {
        // جمع جميع عناصر DOM
        this.elements = {
            // الفيديو
            localVideo: document.getElementById('localVideo'),
            remoteVideo: document.getElementById('remoteVideo'),
            localSpinner: document.getElementById('localSpinner'),
            remoteSpinner: document.getElementById('remoteSpinner'),
            
            // الأزرار
            micBtn: document.getElementById('micBtn'),
            reportBtn: document.getElementById('reportBtn'),
            skipBtn: document.getElementById('skipBtn'),
            exitBtn: document.getElementById('exitBtn'),
            sendBtn: document.getElementById('sendBtn'),
            
            // الدردشة
            chatMessages: document.getElementById('chatMessages'),
            chatInput: document.getElementById('chatInput'),
            
            // التنبيهات
            notifyIcon: document.getElementById('notifyIcon'),
            notifyDot: document.getElementById('notifyDot'),
            notifyMenu: document.getElementById('notifyMenu'),
            
            // الحالة
            statusMessage: document.getElementById('statusMessage') || this.createStatusElement()
        };

        // إنشاء مؤشر الكتابة
        this.createTypingIndicator();
        
        // إنشاء عنصر الفيديو الإعلاني
        this.createAdVideoElement();
    }

    createStatusElement() {
        const statusEl = document.createElement('div');
        statusEl.id = 'statusMessage';
        statusEl.className = 'status-message';
        document.querySelector('.video-container').appendChild(statusEl);
        return statusEl;
    }

    createTypingIndicator() {
        this.typingIndicator = document.createElement('div');
        this.typingIndicator.className = 'typing-indicator';
        this.typingIndicator.style.display = 'none';
        this.typingIndicator.textContent = 'Stranger is typing...';
        this.elements.chatMessages.appendChild(this.typingIndicator);
    }

    createAdVideoElement() {
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
        document.querySelector('.remote-video-container').appendChild(this.adVideo);
    }

    async initializeSocket() {
        return new Promise((resolve, reject) => {
            try {
                this.socket = io({
                    reconnection: true,
                    reconnectionAttempts: 5,
                    reconnectionDelay: 1000,
                    reconnectionDelayMax: 5000,
                    timeout: 20000
                });

                this.socket.on('connect', () => {
                    console.log('Socket connected:', this.socket.id);
                    this.updateStatus('Connected to server');
                    resolve();
                });

                this.socket.on('connect_error', (error) => {
                    console.error('Socket connection error:', error);
                    reject(error);
                });

                this.setupSocketListeners();
            } catch (error) {
                reject(error);
            }
        });
    }

    setupSocketListeners() {
        // استقبال الشريك
        this.socket.on('partner-found', async (data) => {
            console.log('Partner found:', data);
            await this.handlePartnerFound(data);
        });

        // إشارات WebRTC
        this.socket.on('signal', async (data) => {
            await this.handleSignal(data);
        });

        // رسائل الدردشة
        this.socket.on('chat-message', (data) => {
            this.handleChatMessage(data);
        });

        // مؤشر الكتابة
        this.socket.on('typing', () => {
            this.showTypingIndicator();
        });

        this.socket.on('stop-typing', () => {
            this.hideTypingIndicator();
        });

        // انفصال الشريك
        this.socket.on('partner-disconnected', () => {
            this.handlePartnerDisconnected();
        });

        // الحظر
        this.socket.on('banned', (data) => {
            this.handleBanned(data);
        });

        // رسائل المسؤول
        this.socket.on('adminMessage', (message) => {
            this.showAdminMessage(message);
        });

        // الانتظار
        this.socket.on('waiting', (message) => {
            this.updateStatus(message);
        });
    }

    async initializeMedia() {
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({
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

            this.elements.localVideo.srcObject = this.localStream;
            this.updateMicButton();
            this.hideLocalSpinner();
            
            return true;
        } catch (error) {
            console.error('Media initialization error:', error);
            this.showError('Cannot access camera/microphone. Please check permissions.');
            return false;
        }
    }

    setupEventListeners() {
        // زر الميكروفون
        this.elements.micBtn.addEventListener('click', () => this.toggleMic());

        // زر التخطي
        this.elements.skipBtn.addEventListener('click', () => this.skipPartner());

        // زر الإبلاغ
        this.elements.reportBtn.addEventListener('click', () => this.reportPartner());

        // زر الخروج
        this.elements.exitBtn.addEventListener('click', () => this.exit());

        // إرسال الرسالة
        this.elements.sendBtn.addEventListener('click', () => this.sendMessage());
        this.elements.chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.sendMessage();
        });

        // مؤشر الكتابة
        this.elements.chatInput.addEventListener('input', () => {
            if (this.partnerId && !this.isBanned) {
                this.socket.emit('typing', { to: this.partnerId });
                clearTimeout(this.typingTimeout);
                this.typingTimeout = setTimeout(() => {
                    this.socket.emit('stop-typing', { to: this.partnerId });
                }, 1500);
            }
        });

        // إعادة الاتصال عند فقدان الاتصال
        window.addEventListener('online', () => {
            if (!this.isConnected && !this.isBanned) {
                this.reconnect();
            }
        });
    }

    startApplication() {
        this.updateStatus('Starting...');
        this.startSearch();
    }

    async startSearch() {
        if (this.isBanned) {
            this.updateStatus('You are banned');
            return;
        }

        if (this.isSearching) return;
        
        this.isSearching = true;
        this.searchStartTime = Date.now();
        
        this.cleanupConnection();
        this.clearChat();
        this.disableChat();
        this.showRemoteSpinner();
        this.updateStatus('Searching for a stranger...');

        this.socket.emit('find-partner');

        // مهلة البحث
        this.searchTimeout = setTimeout(() => {
            if (this.isSearching && !this.isConnected) {
                this.handleSearchTimeout();
            }
        }, this.config.searchTimeout);
    }

    async handlePartnerFound(data) {
        clearTimeout(this.searchTimeout);
        this.isSearching = false;
        
        const partnerId = data?.id || data?.partnerId;
        if (!partnerId) {
            this.updateStatus('Invalid partner data');
            this.retrySearch();
            return;
        }

        this.partnerId = partnerId;
        this.isInitiator = !!data.initiator;
        
        this.updateStatus('Connecting to stranger...');
        this.hideRemoteSpinner();

        try {
            await this.createPeerConnection();
            
            if (this.isInitiator) {
                await this.createAndSendOffer();
            }
            
            this.startConnectionTimer();
        } catch (error) {
            console.error('Connection failed:', error);
            this.updateStatus('Connection failed. Retrying...');
            this.retrySearch();
        }
    }

    async createPeerConnection() {
        // تنظيف الاتصال السابق
        if (this.peerConnection) {
            this.peerConnection.close();
        }

        // إنشاء اتصال جديد
        this.peerConnection = new RTCPeerConnection({
            iceServers: this.config.iceServers,
            iceCandidatePoolSize: 10
        });

        // إضافة التدفق المحلي
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                this.peerConnection.addTrack(track, this.localStream);
            });
        }

        // إعداد معالجات الأحداث
        this.setupPeerConnectionEvents();
    }

    setupPeerConnectionEvents() {
        // عند استقبال التدفق البعيد
        this.peerConnection.ontrack = (event) => {
            if (event.streams && event.streams[0]) {
                this.remoteStream = event.streams[0];
                this.elements.remoteVideo.srcObject = this.remoteStream;
                this.onConnectionEstablished();
            }
        };

        // مرشحات ICE
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate && this.partnerId) {
                this.socket.emit('signal', {
                    to: this.partnerId,
                    data: { candidate: event.candidate }
                });
            }
        };

        // تغيير حالة الاتصال
        this.peerConnection.onconnectionstatechange = () => {
            const state = this.peerConnection.connectionState;
            console.log('Connection state:', state);

            switch (state) {
                case 'connected':
                    this.onConnectionEstablished();
                    break;
                case 'disconnected':
                case 'failed':
                    this.onConnectionLost();
                    break;
                case 'closed':
                    this.cleanupConnection();
                    break;
            }
        };

        // ICE Gathering state
        this.peerConnection.onicegatheringstatechange = () => {
            console.log('ICE gathering state:', this.peerConnection.iceGatheringState);
        };

        // ICE Connection state
        this.peerConnection.oniceconnectionstatechange = () => {
            console.log('ICE connection state:', this.peerConnection.iceConnectionState);
        };
    }

    async createAndSendOffer() {
        try {
            const offer = await this.peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true,
                voiceActivityDetection: true
            });

            await this.peerConnection.setLocalDescription(offer);

            this.socket.emit('signal', {
                to: this.partnerId,
                data: offer
            });
        } catch (error) {
            console.error('Error creating offer:', error);
            throw error;
        }
    }

    async handleSignal(data) {
        if (!this.peerConnection || !data) return;

        try {
            if (data.data.type === 'offer') {
                await this.peerConnection.setRemoteDescription(data.data);
                const answer = await this.peerConnection.createAnswer();
                await this.peerConnection.setLocalDescription(answer);
                
                this.socket.emit('signal', {
                    to: data.from,
                    data: answer
                });
            } else if (data.data.type === 'answer') {
                await this.peerConnection.setRemoteDescription(data.data);
            } else if (data.data.candidate) {
                try {
                    await this.peerConnection.addIceCandidate(data.data.candidate);
                } catch (error) {
                    console.warn('Failed to add ICE candidate:', error);
                }
            }
        } catch (error) {
            console.error('Error handling signal:', error);
        }
    }

    onConnectionEstablished() {
        clearTimeout(this.connectionTimeout);
        this.isConnected = true;
        this.isSearching = false;
        this.connectionStartTime = Date.now();
        this.reconnectionAttempts = 0;

        this.hideRemoteSpinner();
        this.enableChat();
        this.updateStatus('Connected! Say hello! 👋');
        
        // بدء مراقبة الاتصال
        this.startConnectionMonitor();
    }

    onConnectionLost() {
        if (this.isConnected) {
            this.isConnected = false;
            this.updateStatus('Connection lost. Reconnecting...');
            
            if (this.reconnectionAttempts < this.maxReconnectionAttempts) {
                this.reconnectionAttempts++;
                setTimeout(() => this.reconnect(), this.config.reconnectDelay * this.reconnectionAttempts);
            } else {
                this.handleDisconnection();
            }
        }
    }

    async reconnect() {
        if (this.partnerId && this.peerConnection) {
            try {
                // محاولة إعادة الاتصال مع نفس الشريك
                this.updateStatus('Reconnecting...');
                
                // إنشاء عرض جديد
                if (this.isInitiator) {
                    await this.createAndSendOffer();
                }
            } catch (error) {
                console.error('Reconnection failed:', error);
                this.handleDisconnection();
            }
        } else {
            this.handleDisconnection();
        }
    }

    handleDisconnection() {
        this.cleanupConnection();
        this.disableChat();
        this.updateStatus('Disconnected. Searching for new partner...');
        this.startSearch();
    }

    handlePartnerDisconnected() {
        this.updateStatus('Stranger disconnected');
        this.handleDisconnection();
    }

    handleSearchTimeout() {
        this.isSearching = false;
        
        // عرض إعلان بعد مهلة البحث
        if (!this.isConnected) {
            this.showAdvertisement();
        } else {
            this.retrySearch();
        }
    }

    showAdvertisement() {
        if (this.adVideos.length === 0) {
            this.retrySearch();
            return;
        }

        this.updateStatus('Playing advertisement...');
        
        // اختيار إعلان عشوائي
        const randomAd = this.adVideos[Math.floor(Math.random() * this.adVideos.length)];
        this.adVideo.src = randomAd;
        this.adVideo.style.display = 'block';
        this.elements.remoteVideo.style.display = 'none';

        this.adVideo.play().catch(error => {
            console.warn('Ad autoplay failed:', error);
            // المتابعة حتى لو فشل التشغيل التلقائي
            this.onAdComplete();
        });

        // إكمال الإعلان بعد مدة قصيرة أو عند انتهائه
        this.adVideo.onended = () => this.onAdComplete();
        setTimeout(() => this.onAdComplete(), 5000);
    }

    onAdComplete() {
        this.adVideo.style.display = 'none';
        this.elements.remoteVideo.style.display = 'block';
        this.adVideo.src = '';
        
        this.retrySearch();
    }

    retrySearch() {
        this.updateStatus('Searching again...');
        setTimeout(() => this.startSearch(), 1000);
    }

    startConnectionTimer() {
        this.connectionTimeout = setTimeout(() => {
            if (!this.isConnected) {
                this.updateStatus('Connection timeout. Retrying...');
                this.retrySearch();
            }
        }, this.config.connectionTimeout);
    }

    startConnectionMonitor() {
        this.connectionMonitor = setInterval(() => {
            if (this.isConnected && this.peerConnection) {
                const state = this.peerConnection.iceConnectionState;
                if (state === 'disconnected' || state === 'failed') {
                    this.onConnectionLost();
                }
            } else {
                clearInterval(this.connectionMonitor);
            }
        }, 3000);
    }

    // وظائف المساعدة للـ UI
    updateStatus(message) {
        if (this.elements.statusMessage) {
            this.elements.statusMessage.textContent = message;
        }
    }

    showError(message) {
        console.error(message);
        this.updateStatus(`Error: ${message}`);
        
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-message';
        errorDiv.textContent = message;
        this.elements.chatMessages.appendChild(errorDiv);
    }

    showRemoteSpinner() {
        if (this.elements.remoteSpinner) {
            this.elements.remoteSpinner.style.display = 'block';
        }
        if (this.elements.remoteVideo) {
            this.elements.remoteVideo.style.display = 'none';
        }
    }

    hideRemoteSpinner() {
        if (this.elements.remoteSpinner) {
            this.elements.remoteSpinner.style.display = 'none';
        }
        if (this.elements.remoteVideo) {
            this.elements.remoteVideo.style.display = 'block';
        }
    }

    hideLocalSpinner() {
        if (this.elements.localSpinner) {
            this.elements.localSpinner.style.display = 'none';
        }
    }

    enableChat() {
        this.elements.chatInput.disabled = false;
        this.elements.sendBtn.disabled = false;
        this.elements.chatInput.focus();
    }

    disableChat() {
        this.elements.chatInput.disabled = true;
        this.elements.sendBtn.disabled = true;
    }

    clearChat() {
        this.elements.chatMessages.innerHTML = '';
        this.createTypingIndicator();
    }

    showTypingIndicator() {
        if (this.typingIndicator) {
            this.typingIndicator.style.display = 'block';
        }
    }

    hideTypingIndicator() {
        if (this.typingIndicator) {
            this.typingIndicator.style.display = 'none';
        }
    }

    // وظائف التفاعل
    toggleMic() {
        if (this.localStream) {
            const audioTracks = this.localStream.getAudioTracks();
            audioTracks.forEach(track => {
                track.enabled = !track.enabled;
            });
            
            const isMuted = !audioTracks[0]?.enabled;
            this.elements.micBtn.textContent = isMuted ? '🔇' : '🎤';
            this.elements.micBtn.title = isMuted ? 'Unmute' : 'Mute';
        }
    }

    updateMicButton() {
        if (this.localStream) {
            const audioTracks = this.localStream.getAudioTracks();
            const isMuted = !audioTracks[0]?.enabled;
            this.elements.micBtn.textContent = isMuted ? '🔇' : '🎤';
            this.elements.micBtn.disabled = false;
        } else {
            this.elements.micBtn.disabled = true;
        }
    }

    async sendMessage() {
        const message = this.elements.chatInput.value.trim();
        if (!message || !this.partnerId || this.isBanned) return;

        // إضافة الرسالة للدردشة المحلية
        this.addMessage(message, 'outgoing');
        this.elements.chatInput.value = '';
        
        // إرسال للشريك
        this.socket.emit('chat-message', {
            to: this.partnerId,
            message: message
        });

        // إخفاء مؤشر الكتابة
        clearTimeout(this.typingTimeout);
        this.socket.emit('stop-typing', { to: this.partnerId });
    }

    handleChatMessage(data) {
        if (data.message && !this.isBanned) {
            this.addMessage(data.message, 'incoming');
        }
    }

    addMessage(text, type) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `chat-message ${type}`;
        messageDiv.textContent = text;
        
        this.elements.chatMessages.appendChild(messageDiv);
        this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
    }

    async skipPartner() {
        if (this.partnerId) {
            this.socket.emit('skip', { partnerId: this.partnerId });
        }
        
        this.updateStatus('Skipping...');
        this.handleDisconnection();
    }

    async reportPartner() {
        if (!this.partnerId) {
            this.updateStatus('No user to report');
            return;
        }

        this.socket.emit('report', { partnerId: this.partnerId });
        this.addMessage('User has been reported', 'system');
        
        // تخطي المستخدم بعد الإبلاغ
        this.skipPartner();
    }

    handleBanned(data) {
        this.isBanned = true;
        this.cleanupConnection();
        this.disableChat();
        
        const message = data?.message || 'You have been banned for 24 hours';
        this.updateStatus(message);
        this.addMessage(message, 'system');
        
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }
    }

    showAdminMessage(message) {
        this.addMessage(`Admin: ${message}`, 'system');
        
        // إشعار
        if (this.elements.notifyDot) {
            this.elements.notifyDot.style.display = 'block';
        }
    }

    // التنظيف
    cleanupConnection() {
        clearTimeout(this.searchTimeout);
        clearTimeout(this.connectionTimeout);
        clearInterval(this.connectionMonitor);
        clearTimeout(this.typingTimeout);

        if (this.peerConnection) {
            try {
                this.peerConnection.close();
            } catch (error) {
                console.warn('Error closing peer connection:', error);
            }
            this.peerConnection = null;
        }

        if (this.elements.remoteVideo) {
            this.elements.remoteVideo.srcObject = null;
        }

        this.remoteStream = null;
        this.partnerId = null;
        this.isInitiator = false;
        this.isConnected = false;
        this.isSearching = false;
    }

    exit() {
        this.cleanupConnection();
        
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
        }
        
        if (this.socket) {
            this.socket.disconnect();
        }
        
        window.location.href = 'index.html';
    }
}

// تهيئة التطبيق عند تحميل الصفحة
window.addEventListener('DOMContentLoaded', () => {
    try {
        window.videoChatApp = new VideoChatApp();
    } catch (error) {
        console.error('Failed to initialize app:', error);
        document.body.innerHTML = `
            <div style="text-align: center; padding: 50px; color: white;">
                <h1>Error Loading Application</h1>
                <p>Please refresh the page or check your internet connection.</p>
                <button onclick="location.reload()" style="padding: 10px 20px; margin-top: 20px;">
                    Refresh Page
                </button>
            </div>
        `;
    }
});

// CSS إضافي لتحسين التجربة
const additionalCSS = `
    .video-container {
        position: relative;
        width: 100%;
        height: 100%;
    }
    
    .remote-video-container {
        position: relative;
        width: 100%;
        height: 100%;
        background: #000;
    }
    
    .status-message {
        position: absolute;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.7);
        color: white;
        padding: 10px 20px;
        border-radius: 20px;
        z-index: 1000;
        font-size: 14px;
        max-width: 80%;
        text-align: center;
    }
    
    .spinner {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 50px;
        height: 50px;
        border: 5px solid rgba(255, 255, 255, 0.3);
        border-radius: 50%;
        border-top-color: white;
        animation: spin 1s linear infinite;
    }
    
    @keyframes spin {
        to { transform: translate(-50%, -50%) rotate(360deg); }
    }
    
    .chat-message {
        margin: 10px;
        padding: 10px 15px;
        border-radius: 15px;
        max-width: 70%;
        word-wrap: break-word;
    }
    
    .chat-message.outgoing {
        background: #0084ff;
        color: white;
        margin-left: auto;
    }
    
    .chat-message.incoming {
        background: #3a3b3c;
        color: white;
        margin-right: auto;
    }
    
    .chat-message.system {
        background: transparent;
        color: #aaa;
        font-style: italic;
        text-align: center;
        margin: 5px auto;
        font-size: 12px;
    }
    
    .typing-indicator {
        color: #aaa;
        font-style: italic;
        margin: 10px;
        font-size: 12px;
    }
    
    .error-message {
        color: #ff6b6b;
        padding: 10px;
        text-align: center;
        background: rgba(255, 107, 107, 0.1);
        border-radius: 5px;
        margin: 10px;
    }
    
    .control-button {
        transition: all 0.3s ease;
    }
    
    .control-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
    
    .control-button:hover:not(:disabled) {
        transform: scale(1.1);
    }
`;

// إضافة الـ CSS للصفحة
const style = document.createElement('style');
style.textContent = additionalCSS;
document.head.appendChild(style);
