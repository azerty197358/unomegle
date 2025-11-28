// ========================================================
//  SPARKCHAT — Matching Reliability + Typing Indicator
// ========================================================

window.onload = () => {

  // ====== GLOBALS ======
  const socket = io();
  let localStream = null;
  let peerConnection = null;
  let partnerId = null;        // partner socket id
  let matchId = null;          // server matching token (if provided)
  let matchAcked = false;      // we acked match
  let isInitiator = false;
  let autoReconnect = true;
  let isStopped = false;
  let micEnabled = true;

  let searchTimer = null;
  let pauseTimer = null;

  const servers = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };

  // ====== DOM ELEMENTS ======
  const localVideo = document.getElementById("localVideo");
  const remoteVideo = document.getElementById("remoteVideo");
  const localSpinner = document.getElementById("localSpinner");
  const remoteSpinner = document.getElementById("remoteSpinner");

  const statusText = document.getElementById("status");

  const startBtn = document.getElementById("startBtn");
  const skipBtn = document.getElementById("skipBtn");
  const stopBtn = document.getElementById("stopBtn");

  const chatInput = document.getElementById("chatInput");
  const sendBtn = document.getElementById("sendBtn");
  const chatMessages = document.getElementById("chatMessages");

  const micBtn = document.getElementById("micBtn");
  const reportBtn = document.getElementById("reportBtn");

  // typing indicator element
  const typingIndicator = document.createElement("div");
  typingIndicator.className = "msg system";
  typingIndicator.style.fontStyle = "italic";
  typingIndicator.style.display = "none";
  typingIndicator.textContent = "الشخص الآخر يكتب الآن...";
  chatMessages.appendChild(typingIndicator);

  // ====== TYPING STATE ======
  let typing = false;
  let typingTimer = null;
  const TYPING_DEBOUNCE = 1500; // ms

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
    if (chatInput.disabled) return;
    sendTyping();
  });

  // when sending message, send stop-typing immediately
  function sendMessage() {
    const msg = chatInput.value.trim();
    if (!msg || !partnerId) return;

    addMessage(msg, "you");
    socket.emit("chat-message", { to: partnerId, message: msg });
    chatInput.value = "";

    // stop typing
    typing = false;
    clearTimeout(typingTimer);
    socket.emit("stop-typing", { to: partnerId });
  }

  // ====== REPORT FUNCTION ======
  reportBtn.onclick = async () => {
    if (!partnerId) return alert("لا يوجد شخص للإبلاغ عنه.");
    if (!remoteVideo || remoteVideo.readyState < 2) return alert("لا يمكن التقاط لقطة الآن.");

    const canvas = document.createElement("canvas");
    canvas.width = remoteVideo.videoWidth || 640;
    canvas.height = remoteVideo.videoHeight || 480;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(remoteVideo, 0, 0, canvas.width, canvas.height);

    const screenshot = canvas.toDataURL("image/png");
    socket.emit("reportPorn", {
      partnerId,
      matchId: matchId || null,
      timestamp: new Date().toISOString().replace(/[:]/g, "-"),
      screenshot
    });

    alert("🚨 تم إرسال الإبلاغ بنجاح!");
  };

  socket.on("reportHandled", (msg) => {
    console.log("Report response:", msg && msg.message);
  });

  // ====== MIC FUNCTIONS ======
  function updateMicButton() { micBtn.textContent = micEnabled ? "🎤" : "🔇"; }
  function toggleMicrophone() {
    if (!localStream) return;
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(t => (t.enabled = micEnabled));
    updateMicButton();
  }
  micBtn.onclick = toggleMicrophone;

  // ====== UI HELPERS ======
  function showRemoteSpinnerOnly(show) {
    remoteSpinner.style.display = show ? "block" : "none";
    remoteVideo.style.display = show ? "none" : "block";
  }
  function hideAllSpinners() {
    remoteSpinner.style.display = "none";
    localSpinner.style.display = "none";
    localVideo.style.display = "block";
    remoteVideo.style.display = "block";
  }
  function addMessage(msg, type = "system") {
    const d = document.createElement("div");
    d.className = `msg ${type}`;
    d.textContent = msg;
    // insert before typingIndicator so indicator stays at bottom
    chatMessages.insertBefore(d, typingIndicator);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
  function enableChat() { chatInput.disabled = false; sendBtn.disabled = false; chatInput.focus(); }
  function disableChat() { chatInput.disabled = true; sendBtn.disabled = true; chatInput.value = ""; }
  function resetUI() {
    disableChat();
    addMessage("Disconnected. Press Start.", "system");
    startBtn.disabled = false;
    skipBtn.disabled = true;
    stopBtn.disabled = true;
    hideAllSpinners();
    partnerId = null;
    matchId = null;
    matchAcked = false;
    typingIndicator.style.display = "none";
  }

  // ====== MEDIA ======
  async function initMedia() {
    if (localStream) return true;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
      updateMicButton();
      return true;
    } catch (err) {
      statusText.textContent = "Camera/Mic access denied.";
      console.error(err);
      return false;
    }
  }

  // ====== SEARCH SYSTEM (improved) ======
  function startSearchLoop() {
    if (isStopped || partnerId) return;

    showRemoteSpinnerOnly(true);
    statusText.textContent = "Searching...";

    // send lightweight client hints to improve server matching
    const clientInfo = {
      locale: "ar",
      version: "1.0",
      timestamp: Date.now()
    };

    socket.emit("find-partner", clientInfo);

    searchTimer = setTimeout(() => {
      if (!partnerId && !isStopped) {
        socket.emit("stop");
        showRemoteSpinnerOnly(false);
        statusText.textContent = "Pausing...";
        pauseTimer = setTimeout(startSearchLoop, 2000);
      }
    }, 4000);
  }

  async function startSearch() {
    if (!(await initMedia())) return;

    closePeerConnection();
    partnerId = null;
    matchId = null;
    matchAcked = false;
    isInitiator = false;
    chatMessages.innerHTML = "";
    chatMessages.appendChild(typingIndicator);

    showRemoteSpinnerOnly(true);
    startBtn.disabled = true;
    skipBtn.disabled = false;
    stopBtn.disabled = false;

    startSearchLoop();
  }

  // ====== BUTTONS ======
  startBtn.onclick = () => { isStopped = false; autoReconnect = true; startSearch(); };

  skipBtn.onclick = () => {
    statusText.textContent = "Skipping...";
    clearTimeout(searchTimer);
    clearTimeout(pauseTimer);
    socket.emit("skip");
    closePeerConnection();
    disableChat();
    addMessage("You skipped.", "system");
    showRemoteSpinnerOnly(true);
    startSearchLoop();
  };

  stopBtn.onclick = () => {
    statusText.textContent = "Stopped.";
    isStopped = true;
    autoReconnect = false;
    clearTimeout(searchTimer);
    clearTimeout(pauseTimer);
    socket.emit("stop");
    closePeerConnection();
    resetUI();
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
      localVideo.srcObject = null;
    }
  };

  sendBtn.onclick = sendMessage;
  chatInput.onkeypress = e => { if (e.key === "Enter") sendMessage(); };

  // ====== SOCKET HANDLERS ======
  socket.on("waiting", msg => { statusText.textContent = msg || "Waiting..."; });

  socket.on("chat-message", ({ from, message }) => {
    // optionally verify from === partnerId (if provided)
    addMessage(message, "them");
  });

  socket.on("typing", ({ from }) => {
    // show indicator only if from matches current partner (if partnerId known)
    if (!partnerId || (from && from !== partnerId)) return;
    typingIndicator.style.display = "block";
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });

  socket.on("stop-typing", ({ from }) => {
    if (!partnerId || (from && from !== partnerId)) return;
    typingIndicator.style.display = "none";
  });

  socket.on("partner-disconnected", () => {
    statusText.textContent = "Stranger disconnected.";
    disableChat();
    addMessage("Disconnected.", "system");
    clearTimeout(searchTimer);
    clearTimeout(pauseTimer);
    partnerId = null;
    matchId = null;
    matchAcked = false;
    closePeerConnection();
    if (autoReconnect && !isStopped) startSearchLoop();
    else resetUI();
  });

  // partner-found may be old format ({ id }) or new ({ partnerId, matchId, initiator })
  socket.on("partner-found", async (payload) => {
    clearTimeout(searchTimer);
    clearTimeout(pauseTimer);

    // normalize payload
    let pid = null;
    let mid = null;
    let initiator = false;

    if (payload == null) return;

    if (payload.partnerId || payload.matchId) {
      pid = payload.partnerId || payload.id || null;
      mid = payload.matchId || null;
      initiator = !!payload.initiator;
    } else if (payload.id) {
      pid = payload.id;
      initiator = !!payload.initiator;
    } else if (typeof payload === "string") {
      pid = payload;
    }

    if (!pid) {
      // nothing usable — fallback: ignore
      console.warn("partner-found payload missing id", payload);
      return;
    }

    partnerId = pid;
    matchId = mid;
    isInitiator = initiator;

    statusText.textContent = "Match found. Waiting confirmation...";
    showRemoteSpinnerOnly(true);

    // If server provided a matchId, perform handshake to ensure both sides ready
    if (matchId) {
      // ack back to server
      socket.emit("match-ack", { to: partnerId, matchId });

      // wait for server to emit match-confirmed for this matchId
      // set a fallback timeout: if nothing within 6s, proceed anyway (graceful)
      let confirmed = false;
      const CONFIRM_TIMEOUT = 6000;

      const onConfirmed = (data) => {
        if (!data) return;
        if (data.matchId !== matchId) return;
        confirmed = true;
        socket.off("match-confirmed", onConfirmed);
        proceedAfterMatch();
      };

      socket.on("match-confirmed", onConfirmed);

      setTimeout(() => {
        if (!confirmed) {
          socket.off("match-confirmed", onConfirmed);
          console.warn("match-confirm timeout — proceeding (fallback).");
          proceedAfterMatch();
        }
      }, CONFIRM_TIMEOUT);

    } else {
      // no matchId provided — proceed as before
      proceedAfterMatch();
    }
  });

  // helper to proceed after match handshake
  async function proceedAfterMatch() {
    statusText.textContent = "Connecting...";
    hideAllSpinners();
    createPeerConnection();

    // if initiator create offer
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

  // ====== WEBRTC ======
  function createPeerConnection() {
    peerConnection = new RTCPeerConnection(servers);

    if (localStream) {
      localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    }

    peerConnection.ontrack = e => {
      remoteVideo.srcObject = e.streams[0];
      statusText.textContent = "Connected!";
      enableChat();
      addMessage("Connected with a stranger. Say hi!", "system");
      showRemoteSpinnerOnly(false);
    };

    peerConnection.onicecandidate = e => {
      if (e.candidate) {
        socket.emit("signal", { to: partnerId, data: { candidate: e.candidate }, matchId });
      }
    };

    peerConnection.onconnectionstatechange = () => {
      const s = peerConnection.connectionState;
      if (s === "connected") statusText.textContent = "Connected!";
      if (["disconnected", "failed", "closed"].includes(s)) {
        statusText.textContent = "Connection lost.";
        disableChat();
        addMessage("Connection lost.", "system");
        closePeerConnection();
        partnerId = null;
        matchId = null;
        matchAcked = false;
        if (autoReconnect && !isStopped) startSearchLoop();
        else resetUI();
      }
    };
  }

  function closePeerConnection() {
    if (peerConnection) {
      peerConnection.ontrack = null;
      peerConnection.onicecandidate = null;
      peerConnection.onconnectionstatechange = null;
      try { peerConnection.close(); } catch {}
    }
    peerConnection = null;
    remoteVideo.srcObject = null;
  }

  // ====== CLEANUP on unload ======
  window.addEventListener("beforeunload", () => {
    try { socket.emit("stop"); } catch {}
    if (localStream) localStream.getTracks().forEach(t => t.stop());
  });

};
