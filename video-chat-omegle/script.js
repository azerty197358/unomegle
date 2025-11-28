// ========================================================
//  SPARKCHAT — FULL FIXED VERSION (NO FEATURES REMOVED)
// ========================================================

// ======================
//  SOCKET INIT (FIXED)
// ======================
let socket;

// ننتظر DOM لكي تكون العناصر موجودة
window.addEventListener("DOMContentLoaded", () => {
    socket = io();
});

// ========================================================
//  THE MAIN LOGIC
// ========================================================
window.onload = () => {

  // ========== DOM ELEMENTS ==========
  const notifyBell = document.getElementById("notifyIcon");
  const notifyDot = document.getElementById("notifyDot");

  const localVideo = document.getElementById("localVideo");
  const remoteVideo = document.getElementById("remoteVideo");
  const localSpinner = document.getElementById("localSpinner");
  const remoteSpinner = document.getElementById("remoteSpinner");

  const chatMessages = document.getElementById("chatMessages");
  const statusText = document.getElementById("status");

  const chatInput = document.getElementById("chatInput");
  const sendBtn = document.getElementById("sendBtn");
  const skipBtn = document.getElementById("skipBtn");

  const micBtn = document.getElementById("micBtn");
  const reportBtn = document.getElementById("reportBtn");

  // ========== GLOBAL VARS ==========
  let localStream = null;
  let peerConnection = null;
  let partnerId = null;
  let matchId = null;
  let matchAcked = false;
  let isInitiator = false;

  let micEnabled = true;
  let searchTimer = null;
  let pauseTimer = null;

  const servers = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };

  // ========== ADMIN NOTIFICATIONS (FIXED) ==========
  socket.on("adminMessage", msg => {
      // إظهار النقطة
      notifyDot.style.display = "block";
      notifyBell.classList.add("shake");

      // عرض داخل الدردشة
      addMessage("📢 Admin: " + msg, "system");
  });

  notifyBell.onclick = () => {
      notifyDot.style.display = "none";
      notifyBell.classList.remove("shake");
      alert("لا توجد إشعارات جديدة");
  };

  // ========== TYPING SYSTEM ==========
  const typingIndicator = document.createElement("div");
  typingIndicator.className = "msg system";
  typingIndicator.style.fontStyle = "italic";
  typingIndicator.style.display = "none";
  typingIndicator.textContent = "الشخص الآخر يكتب الآن...";
  chatMessages.appendChild(typingIndicator);

  let typing = false;
  let typingTimer = null;
  const TYPING_DEBOUNCE = 1500;

  function sendTyping() {
    if (!partnerId) return;
    if (!typing) {
      typing = true;
      socket.emit("typing", { to: partnerId });
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      typing = false;
      socket.emit("stop-typing", { to: partnerId });
    }, TYPING_DEBOUNCE);
  }

  chatInput.addEventListener("input", () => {
      if (!chatInput.disabled) sendTyping();
  });

  // ========== CHAT SYSTEM ==========
  function sendMessage() {
    const msg = chatInput.value.trim();
    if (!msg || !partnerId) return;

    addMessage(msg, "you");
    socket.emit("chat-message", { to: partnerId, message: msg });

    chatInput.value = "";
    typing = false;
    clearTimeout(typingTimer);
    socket.emit("stop-typing", { to: partnerId });
  }

  sendBtn.onclick = sendMessage;
  chatInput.onkeypress = e => { if (e.key === "Enter") sendMessage(); };

  // ========== ADD MESSAGE (IMPORTANT FUNCTION) ==========
  function addMessage(msg, type = "system") {
    const d = document.createElement("div");
    d.className = `msg ${type}`;
    d.textContent = msg;

    chatMessages.insertBefore(d, typingIndicator);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // ========== MIC CONTROL (FIXED) ==========
  function updateMicButton() {
    micBtn.textContent = micEnabled ? "🎤" : "🔇";
  }

  micBtn.onclick = () => {
    if (!localStream) return;
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    updateMicButton();
  };

  // ========== REPORT SYSTEM (FIXED) ==========
  reportBtn.onclick = async () => {
    if (!partnerId)
      return alert("لا يوجد شخص للإبلاغ عنه.");

    if (!remoteVideo || remoteVideo.readyState < 2)
      return alert("لا يمكن التقاط لقطة الآن.");

    const canvas = document.createElement("canvas");
    canvas.width = remoteVideo.videoWidth || 640;
    canvas.height = remoteVideo.videoHeight || 480;

    const ctx = canvas.getContext("2d");
    ctx.drawImage(remoteVideo, 0, 0, canvas.width, canvas.height);

    socket.emit("reportPorn", {
      partnerId,
      matchId,
      timestamp: new Date().toISOString().replace(/[:]/g, "-"),
      screenshot: canvas.toDataURL("image/png")
    });

    alert("🚨 تم إرسال الإبلاغ بنجاح!");
  };

  // ========== MEDIA ==========
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
    } catch (err) {
      statusText.textContent = "Camera/Mic access denied.";
      return false;
    }
  }

  // ========== UI ==========
  function enableChat() {
    chatInput.disabled = false;
    sendBtn.disabled = false;
  }

  function disableChat() {
    chatInput.disabled = true;
    sendBtn.disabled = true;
    chatInput.value = "";
  }

  function showRemoteSpinnerOnly(show) {
    remoteSpinner.style.display = show ? "block" : "none";
    remoteVideo.style.display = show ? "none" : "block";
  }

  function hideAllSpinners() {
    remoteSpinner.style.display = "none";
    localSpinner.style.display = "none";
    remoteVideo.style.display = "block";
    localVideo.style.display = "block";
  }

  // ========== MATCHMAKING ==========
  function startSearchLoop() {
    showRemoteSpinnerOnly(true);
    statusText.textContent = "Searching...";

    socket.emit("find-partner", {});

    searchTimer = setTimeout(() => {
      if (!partnerId) {
        statusText.textContent = "Pausing...";
        pauseTimer = setTimeout(startSearchLoop, 2000);
      }
    }, 4000);
  }

  async function startSearch() {
    if (!(await initMedia())) return;

    peerConnection = null;
    partnerId = null;
    matchId = null;

    chatMessages.innerHTML = "";
    chatMessages.appendChild(typingIndicator);

    showRemoteSpinnerOnly(true);
    skipBtn.disabled = false;

    startSearchLoop();
  }

  skipBtn.onclick = () => {
    socket.emit("skip");
    disableChat();
    addMessage("You skipped.", "system");
    startSearchLoop();
  };

  // ========== SOCKET EVENTS ==========
  socket.on("waiting", msg => {
    statusText.textContent = msg || "Waiting...";
  });

  socket.on("chat-message", ({ message }) => {
    addMessage(message, "them");
  });

  socket.on("typing", () => {
    typingIndicator.style.display = "block";
  });

  socket.on("stop-typing", () => {
    typingIndicator.style.display = "none";
  });

  socket.on("partner-disconnected", () => {
    statusText.textContent = "Stranger disconnected.";
    disableChat();
    addMessage("Disconnected.", "system");
    partnerId = null;
    peerConnection = null;
    startSearchLoop();
  });

  socket.on("partner-found", async payload => {
    clearTimeout(searchTimer);
    clearTimeout(pauseTimer);

    partnerId = payload.id;
    isInitiator = payload.initiator;

    hideAllSpinners();
    statusText.textContent = "Connecting...";

    createPeerConnection();
    if (isInitiator) {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit("signal", { to: partnerId, data: offer });
    }
  });

  socket.on("signal", async ({ from, data }) => {
    if (!peerConnection) createPeerConnection();

    if (data.type === "offer") {
      await peerConnection.setRemoteDescription(data);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit("signal", { to: from, data: answer });

    } else if (data.type === "answer") {
      await peerConnection.setRemoteDescription(data);

    } else if (data.candidate) {
      peerConnection.addIceCandidate(data.candidate);
    }
  });

  // ========== WEBRTC ==========
  function createPeerConnection() {
    peerConnection = new RTCPeerConnection(servers);

    if (localStream) {
      localStream.getTracks().forEach(track =>
        peerConnection.addTrack(track, localStream)
      );
    }

    peerConnection.ontrack = e => {
      remoteVideo.srcObject = e.streams[0];
      statusText.textContent = "Connected!";
      enableChat();
      addMessage("Connected with a stranger. Say hi!", "system");
      showRemoteSpinnerOnly(false);
    };

    peerConnection.onconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(peerConnection.connectionState)) {
        disableChat();
        addMessage("Connection lost.", "system");
        partnerId = null;
        startSearchLoop();
      }
    };

    peerConnection.onicecandidate = e => {
      if (e.candidate) {
        socket.emit("signal", { to: partnerId, data: { candidate: e.candidate } });
      }
    };
  }

  // ========== AUTO START ==========
  startSearch();

  // ========== CLEANUP ==========
  window.addEventListener("beforeunload", () => {
    socket.emit("stop");
    if (localStream) localStream.getTracks().forEach(t => t.stop());
  });

};
