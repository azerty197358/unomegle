// ========================================================
//  SPARKCHAT — client script (fixed & organized)
// ========================================================

/* Minimal comments. Focus: reliability & defensive checks. */

window.addEventListener("load", () => {
  // ====== Socket & globals ======
  const socket = io();

  let localStream = null;
  let peerConnection = null;
  let partnerId = null;
  let matchId = null;
  let isInitiator = false;
  let autoReconnect = true;
  let micEnabled = true;

  let searchTimer = null;
  let pauseTimer = null;
  const TYPING_DEBOUNCE = 1500;

  const servers = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };

  // ====== DOM (guarded) ======
  const localVideo = document.getElementById("localVideo");
  const remoteVideo = document.getElementById("remoteVideo");
  const localSpinner = document.getElementById("localSpinner");
  const remoteSpinner = document.getElementById("remoteSpinner");

  const statusText = document.getElementById("status");

  const skipBtn = document.getElementById("skipBtn");
  const chatInput = document.getElementById("chatInput");
  const sendBtn = document.getElementById("sendBtn");
  const chatMessages = document.getElementById("chatMessages");

  const micBtn = document.getElementById("micBtn");
  const reportBtn = document.getElementById("reportBtn");

  const notifyBell = document.getElementById("notifyIcon");
  const notifyDot = document.getElementById("notifyDot");

  // Basic sanity checks
  if (!socket) { console.error("Socket.IO not available"); return; }
  if (!chatMessages || !chatInput || !sendBtn || !skipBtn) {
    console.error("Essential chat DOM elements missing"); return;
  }
  if (!localVideo || !remoteVideo) {
    console.warn("Video elements missing — continuing in text-only mode");
  }

  // ====== Typing indicator ======
  const typingIndicator = document.createElement("div");
  typingIndicator.className = "msg system";
  typingIndicator.style.fontStyle = "italic";
  typingIndicator.style.display = "none";
  typingIndicator.textContent = "الشخص الآخر يكتب الآن...";
  chatMessages.appendChild(typingIndicator);

  let typing = false;
  let typingTimer = null;

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

  // ====== UI helpers ======
  function addMessage(msg, type = "system") {
    const d = document.createElement("div");
    d.className = `msg ${type}`;
    d.textContent = msg;
    chatMessages.insertBefore(d, typingIndicator);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function enableChat() {
    chatInput.disabled = false;
    sendBtn.disabled = false;
    chatInput.focus();
  }

  function disableChat() {
    chatInput.disabled = true;
    sendBtn.disabled = true;
    chatInput.value = "";
  }

  function showRemoteSpinnerOnly(show) {
    if (remoteSpinner) remoteSpinner.style.display = show ? "block" : "none";
    if (remoteVideo) remoteVideo.style.display = show ? "none" : "block";
  }

  function hideAllSpinners() {
    if (remoteSpinner) remoteSpinner.style.display = "none";
    if (localSpinner) localSpinner.style.display = "none";
    if (remoteVideo) remoteVideo.style.display = "block";
    if (localVideo) localVideo.style.display = "block";
  }

  // ====== Sending messages ======
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

  sendBtn.addEventListener("click", sendMessage);
  chatInput.addEventListener("keypress", e => { if (e.key === "Enter") sendMessage(); });

  // ====== Report button ======
  if (reportBtn) {
    reportBtn.addEventListener("click", async () => {
      if (!partnerId) return alert("لا يوجد شخص للإبلاغ عنه.");
      if (!remoteVideo || (remoteVideo.readyState || 0) < 2) return alert("لا يمكن التقاط لقطة الآن.");
      const canvas = document.createElement("canvas");
      canvas.width = remoteVideo.videoWidth || 640;
      canvas.height = remoteVideo.videoHeight || 480;
      const ctx = canvas.getContext("2d');
      ctx.drawImage(remoteVideo, 0, 0, canvas.width, canvas.height);
      socket.emit("reportPorn", {
        partnerId,
        matchId,
        timestamp: new Date().toISOString().replace(/[:]/g, "-"),
        screenshot: canvas.toDataURL("image/png")
      });
      alert("🚨 تم إرسال الإبلاغ بنجاح!");
    });
  }

  // ====== Mic ======
  function updateMicButton() { if (micBtn) micBtn.textContent = micEnabled ? "🎤" : "🔇"; }

  if (micBtn) {
    micBtn.addEventListener("click", () => {
      if (!localStream) return;
      micEnabled = !micEnabled;
      localStream.getAudioTracks().forEach(t => (t.enabled = micEnabled));
      updateMicButton();
    });
  }

  // ====== Media ======
  async function initMedia() {
    if (localStream) return true;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (localVideo) localVideo.srcObject = localStream;
      updateMicButton();
      return true;
    } catch (err) {
      if (statusText) statusText.textContent = "Camera/Mic access denied.";
      console.error("getUserMedia failed:", err);
      return false;
    }
  }

  // ====== Matchmaking ======
  function startSearchLoop() {
    if (partnerId) return;
    showRemoteSpinnerOnly(true);
    if (statusText) statusText.textContent = "Searching...";
    socket.emit("find-partner", { locale: "ar", version: "1.0", timestamp: Date.now() });

    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (!partnerId) {
        socket.emit("stop");
        showRemoteSpinnerOnly(false);
        if (statusText) statusText.textContent = "Pausing...";
        pauseTimer = setTimeout(startSearchLoop, 2000);
      }
    }, 4000);
  }

  async function startSearch() {
    if (!(await initMedia())) return;
    closePeerConnection();
    partnerId = null;
    matchId = null;
    isInitiator = false;
    chatMessages.innerHTML = "";
    chatMessages.appendChild(typingIndicator);
    showRemoteSpinnerOnly(true);
    skipBtn.disabled = false;
    startSearchLoop();
  }

  // ====== Skip ======
  skipBtn.addEventListener("click", () => {
    if (statusText) statusText.textContent = "Skipping...";
    clearTimeout(searchTimer);
    clearTimeout(pauseTimer);
    socket.emit("skip");
    closePeerConnection();
    disableChat();
    addMessage("You skipped.", "system");
    startSearchLoop();
  });

  // ====== WebRTC helper ======
  function createPeerConnection() {
    peerConnection = new RTCPeerConnection(servers);
    if (localStream) localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = e => {
      if (remoteVideo) remoteVideo.srcObject = e.streams[0];
      if (statusText) statusText.textContent = "Connected!";
      enableChat();
      addMessage("Connected with a stranger. Say hi!", "system");
      showRemoteSpinnerOnly(false);
    };

    peerConnection.onicecandidate = e => {
      if (e.candidate && partnerId) {
        socket.emit("signal", { to: partnerId, data: { candidate: e.candidate }, matchId });
      }
    };

    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      if (["disconnected", "failed", "closed"].includes(state)) {
        disableChat();
        addMessage("Connection lost.", "system");
        partnerId = null;
        closePeerConnection();
        if (autoReconnect) startSearchLoop();
      }
    };
  }

  function closePeerConnection() {
    if (peerConnection) {
      try { peerConnection.close(); } catch (e) {}
    }
    peerConnection = null;
    if (remoteVideo) remoteVideo.srcObject = null;
  }

  // ====== Socket listeners ======
  socket.on("waiting", msg => { if (statusText) statusText.textContent = msg || "Waiting..."; });

  socket.on("chat-message", ({ from, message }) => {
    // show incoming message
    addMessage(message, "stranger");
  });

  socket.on("typing", () => { typingIndicator.style.display = "block"; chatMessages.scrollTop = chatMessages.scrollHeight; });
  socket.on("stop-typing", () => { typingIndicator.style.display = "none"; });

  socket.on("partner-disconnected", ({ reason } = {}) => {
    if (statusText) statusText.textContent = "Stranger disconnected.";
    disableChat();
    addMessage("Disconnected.", "system");
    partnerId = null;
    closePeerConnection();
    if (autoReconnect) startSearchLoop();
    else { /* no-op */ }
  });

  socket.on("partner-found", async payload => {
    clearTimeout(searchTimer);
    clearTimeout(pauseTimer);

    partnerId = payload.partnerId || payload.id;
    matchId = payload.matchId || null;
    isInitiator = !!payload.initiator;

    if (statusText) statusText.textContent = "Connecting...";
    showRemoteSpinnerOnly(true);

    if (matchId) {
      socket.emit("match-ack", { to: partnerId, matchId });

      let confirmed = false;
      const CONFIRM_TIMEOUT = 6000;

      const onConfirm = d => {
        if (!d || d.matchId !== matchId) return;
        confirmed = true;
        socket.off("match-confirmed", onConfirm);
        proceedAfterMatch();
      };
      socket.on("match-confirmed", onConfirm);

      setTimeout(() => {
        if (!confirmed) {
          socket.off("match-confirmed", onConfirm);
          proceedAfterMatch();
        }
      }, CONFIRM_TIMEOUT);
    } else {
      proceedAfterMatch();
    }
  });

  async function proceedAfterMatch() {
    if (statusText) statusText.textContent = "Connecting...";
    hideAllSpinners();
    createPeerConnection();
    if (isInitiator) {
      try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit("signal", { to: partnerId, data: offer, matchId });
      } catch (err) { console.error("Offer error:", err); }
    }
  }

  socket.on("signal", async ({ from, data }) => {
    if (!peerConnection) createPeerConnection();
    try {
      if (data.type === "offer") {
        await peerConnection.setRemoteDescription(data);
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit("signal", { to: from, data: answer, matchId });
      } else if (data.type === "answer") {
        await peerConnection.setRemoteDescription(data);
      } else if (data.candidate) {
        await peerConnection.addIceCandidate(data.candidate);
      }
    } catch (err) {
      console.error("Signal handling error:", err);
    }
  });

  socket.on("banned", ({ message }) => {
    alert(message || "You are banned.");
    try { socket.disconnect(); } catch (e) {}
  });

  // ====== Admin message / notifications (now that socket & addMessage exist) ======
  if (notifyBell) {
    socket.on("adminMessage", (msg) => {
      addMessage("📢 Admin: " + msg, "system");
      if (notifyDot) notifyDot.style.display = "block";
      notifyBell.classList.add("shake");
    });

    notifyBell.addEventListener("click", () => {
      if (notifyDot) notifyDot.style.display = "none";
      notifyBell.classList.remove("shake");
    });
  } else {
    // still subscribe so admin messages appear in chat
    socket.on("adminMessage", (msg) => addMessage("📢 Admin: " + msg, "system"));
  }

  // ====== Auto-start ======
  startSearch();

  // ====== Cleanup ======
  window.addEventListener("beforeunload", () => {
    try { socket.emit("stop"); } catch {}
    if (localStream) localStream.getTracks().forEach(t => t.stop());
  });
});
