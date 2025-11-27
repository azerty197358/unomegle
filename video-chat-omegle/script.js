// ========================================================
//  SPARKCHAT — Full Clean Script (Fixed & Verified)
// ========================================================

window.onload = () => {

  // ====== GLOBALS ======
  const socket = io();

  let localStream = null;
  let peerConnection = null;
  let partnerId = null;
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

  // ========================================================
  //  REPORT FUNCTION
  // ========================================================

  reportBtn.onclick = async () => {
    if (!partnerId) return alert("لا يوجد شخص للإبلاغ عنه.");

    if (!remoteVideo || remoteVideo.readyState < 2)
      return alert("لا يمكن التقاط لقطة الآن.");

    const canvas = document.createElement("canvas");
    canvas.width = remoteVideo.videoWidth;
    canvas.height = remoteVideo.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(remoteVideo, 0, 0, canvas.width, canvas.height);

    const screenshot = canvas.toDataURL("image/png");

    socket.emit("reportPorn", {
      partnerId,
      timestamp: new Date().toISOString().replace(/[:]/g, "-"),
      screenshot
    });

    alert("🚨 تم إرسال الإبلاغ بنجاح!");
  };

  socket.on("reportHandled", (msg) => {
    console.log("Report response:", msg.message);
  });

  // ========================================================
  //  MIC FUNCTIONS
  // ========================================================

  function updateMicButton() {
    micBtn.textContent = micEnabled ? "🎤" : "🔇";
  }

  function toggleMicrophone() {
    if (!localStream) return;

    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(t => (t.enabled = micEnabled));
    updateMicButton();
  }

  micBtn.onclick = toggleMicrophone;

  // ========================================================
  //  UI HELPERS
  // ========================================================

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
    chatMessages.appendChild(d);
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
    addMessage("Disconnected. Press Start.", "system");
    startBtn.disabled = false;
    skipBtn.disabled = true;
    stopBtn.disabled = true;
    hideAllSpinners();
  }

  // ========================================================
  //  MEDIA
  // ========================================================

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

  // ========================================================
  //  SEARCH SYSTEM
  // ========================================================

  function startSearchLoop() {
    if (isStopped || partnerId) return;

    showRemoteSpinnerOnly(true);
    statusText.textContent = "Searching...";
    socket.emit("find-partner");

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
    isInitiator = false;

    chatMessages.innerHTML = "";
    showRemoteSpinnerOnly(true);

    startBtn.disabled = true;
    skipBtn.disabled = false;
    stopBtn.disabled = false;

    startSearchLoop();
  }

  // ========================================================
  //  BUTTONS
  // ========================================================

  startBtn.onclick = () => {
    isStopped = false;
    autoReconnect = true;
    startSearch();
  };

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

  // ========================================================
  //  CHAT
  // ========================================================

  function sendMessage() {
    const msg = chatInput.value.trim();
    if (!msg || !partnerId) return;

    addMessage(msg, "you");
    socket.emit("chat-message", { to: partnerId, message: msg });
    chatInput.value = "";
  }

  sendBtn.onclick = sendMessage;
  chatInput.onkeypress = e => e.key === "Enter" && sendMessage();

  // ========================================================
  //  SOCKET EVENTS
  // ========================================================

  socket.on("waiting", msg => {
    statusText.textContent = msg || "Waiting...";
  });

  socket.on("chat-message", ({ message }) => {
    addMessage(message, "them");
  });

  socket.on("partner-disconnected", () => {
    statusText.textContent = "Stranger disconnected.";
    disableChat();
    addMessage("Disconnected.", "system");

    clearTimeout(searchTimer);
    clearTimeout(pauseTimer);

    partnerId = null;
    closePeerConnection();

    if (autoReconnect && !isStopped) startSearchLoop();
    else resetUI();
  });

  // ================================================
  //  🔥 FIXED HERE: partnerId was not being set 🔥
  // ================================================
  socket.on("partner-found", async ({ partnerId: pid, initiator }) => {
    clearTimeout(searchTimer);
    clearTimeout(pauseTimer);

    partnerId = pid;      // ← FIXED
    isInitiator = initiator;

    statusText.textContent = "Connecting...";
    hideAllSpinners();

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
      await peerConnection.addIceCandidate(data.candidate);
    }
  });

  // ========================================================
  //  WEBRTC
  // ========================================================

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
      addMessage("Say hi!", "system");
      showRemoteSpinnerOnly(false);
    };

    peerConnection.onicecandidate = e => {
      if (e.candidate) {
        socket.emit("signal", {
          to: partnerId,
          data: { candidate: e.candidate }
        });
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
      peerConnection.close();
    }
    peerConnection = null;
    remoteVideo.srcObject = null;
  }

};
