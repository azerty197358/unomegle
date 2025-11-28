// ========================================================
//  SPARKCHAT — Updated to work with NO Start/Stop buttons
// ========================================================

// ======================
//  ADMIN NOTIFICATIONS
// ======================
const notifyBell = document.getElementById("notifyIcon");
const notifyDot = document.getElementById("notifyDot");

let unreadCount = 0;

// عند وصول رسالة من الأدمن
socket.on("adminMessage", msg => {
    unreadCount++;
    notifyDot.style.display = "block";  
    notifyBell.classList.add("shake");
    addMessage("system", msg);
});

// عند الضغط على الأيقونة
notifyBell.onclick = () => {
    unreadCount = 0;
    notifyDot.style.display = "none";
    notifyBell.classList.remove("shake");
    alert("لا توجد إشعارات جديدة");
};



// ========================
//        MAIN LOGIC
// ========================
window.onload = () => {

  // ===== Global Variables =====
  const socket = io();

  let localStream = null;
  let peerConnection = null;
  let partnerId = null;
  let matchId = null;
  let matchAcked = false;
  let isInitiator = false;
  let autoReconnect = true;
  let isStopped = false;
  let micEnabled = true;

  let searchTimer = null;
  let pauseTimer = null;

  const servers = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };


  // ===== DOM Elements =====
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

  // (لا يوجد Start/Stop أصلاً)
  const startBtn = { disabled: true };
  const stopBtn = { disabled: true, style: { display: "none" } };


  // ======================
  //  Typing Indicator
  // ======================
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


  // ======================
  //   Sending Messages
  // ======================
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



  // ======================
  //       REPORT
  // ======================
  reportBtn.onclick = async () => {
    if (!partnerId) return alert("لا يوجد شخص للإبلاغ عنه.");
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



  // ======================
  //        MIC
  // ======================
  function updateMicButton() {
    micBtn.textContent = micEnabled ? "🎤" : "🔇";
  }

  micBtn.onclick = () => {
    if (!localStream) return;
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(t => (t.enabled = micEnabled));
    updateMicButton();
  };



  // ======================
  //          UI
  // ======================
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
  }

  function disableChat() {
    chatInput.disabled = true;
    sendBtn.disabled = true;
    chatInput.value = "";
  }

  function resetUI() {
    disableChat();
    addMessage("Disconnected.", "system");
    skipBtn.disabled = false;
    hideAllSpinners();
    partnerId = null;
    matchId = null;
    matchAcked = false;
    typingIndicator.style.display = "none";
  }



  // ======================
  //     MEDIA ACCESS
  // ======================
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
      console.error(err);
      return false;
    }
  }



  // =========================================
  //         MATCHMAKING SYSTEM
  // =========================================
  function startSearchLoop() {
    if (isStopped || partnerId) return;

    showRemoteSpinnerOnly(true);
    statusText.textContent = "Searching...";

    socket.emit("find-partner", {
      locale: "ar",
      version: "1.0",
      timestamp: Date.now()
    });

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
    skipBtn.disabled = false;

    startSearchLoop();
  }



  // ======================
  //        SKIP
  // ======================
  skipBtn.onclick = () => {
    statusText.textContent = "Skipping...";

    clearTimeout(searchTimer);
    clearTimeout(pauseTimer);

    socket.emit("skip");

    closePeerConnection();
    disableChat();
    addMessage("You skipped.", "system");

    startSearchLoop();
  };



  // ======================
  //       SOCKET.IO
  // ======================
  socket.on("waiting", msg => {
    statusText.textContent = msg || "Waiting...";
  });

  socket.on("chat-message", ({ message }) => {
    addMessage(message, "them");
  });

  socket.on("typing", () => {
    typingIndicator.style.display = "block";
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });

  socket.on("stop-typing", () => {
    typingIndicator.style.display = "none";
  });

  socket.on("partner-disconnected", () => {
    statusText.textContent = "Stranger disconnected.";
    disableChat();
    addMessage("Disconnected.", "system");

    partnerId = null;
    closePeerConnection();

    if (autoReconnect) startSearchLoop();
    else resetUI();
  });

  socket.on("partner-found", async payload => {
    clearTimeout(searchTimer);
    clearTimeout(pauseTimer);

    partnerId = payload.partnerId || payload.id;
    matchId = payload.matchId || null;
    isInitiator = !!payload.initiator;

    statusText.textContent = "Connecting...";
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

      // fallback: لو ما وصل التأكيد
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
    statusText.textContent = "Connecting...";
    hideAllSpinners();

    createPeerConnection();

    if (isInitiator) {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      socket.emit("signal", {
        to: partnerId,
        data: offer,
        matchId
      });
    }
  }

  socket.on("signal", async ({ from, data }) => {
    if (!peerConnection) createPeerConnection();

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
  });



  // ======================
  //        WEBRTC
  // ======================
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

    peerConnection.onicecandidate = e => {
      if (e.candidate) {
        socket.emit("signal", {
          to: partnerId,
          data: { candidate: e.candidate },
          matchId
        });
      }
    };

    peerConnection.onconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(peerConnection.connectionState)) {
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
      try { peerConnection.close(); } catch {}
    }
    peerConnection = null;
    remoteVideo.srcObject = null;
  }



  // ======================
  //   AUTO START CHAT
  // ======================
  startSearch();



  // ======================
  //       CLEANUP
  // ======================
  window.addEventListener("beforeunload", () => {
    socket.emit("stop");
    if (localStream) localStream.getTracks().forEach(t => t.stop());
  });
};
