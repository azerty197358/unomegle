// ========================================================
//  SPARKCHAT — FIXED & STABLE VERSION
// ========================================================

// Socket يجب إنشاؤه فقط بعد تحميل DOM
let socket;

// ========================
// START AFTER DOM LOAD
// ========================
window.addEventListener("DOMContentLoaded", () => {

  // Create socket safely
  socket = io();

  // DOM elements
  const notifyBell = document.getElementById("notifyIcon");
  const notifyDot = document.getElementById("notifyDot");
  const notifyMenu = document.getElementById("notifyMenu");

  // Add admin message into dropdown
  function pushAdminNotification(msg) {
    const d = document.createElement("div");
    d.className = "notify-item";
    d.textContent = msg;
    notifyMenu.appendChild(d);
  }

  // Admin message handler
  socket.on("adminMessage", msg => {
    notifyDot.style.display = "block";
    notifyBell.classList.add("shake");

    pushAdminNotification("📢 " + msg);

    // ALSO show inside chat
    if (typeof addMessage === "function") {
      addMessage("📢 Admin: " + msg, "system");
    }
  });

  // Toggle dropdown
  notifyBell.onclick = () => {
    notifyDot.style.display = "none";
    notifyBell.classList.remove("shake");

    notifyMenu.style.display =
      notifyMenu.style.display === "block" ? "none" : "block";
  };

});


// ========================================================
//  MAIN LOGIC (runs after full page load)
// ========================================================
window.onload = () => {

  // =======================
  // GLOBAL VARIABLES
  // =======================
  let localStream = null;
  let peerConnection = null;
  let partnerId = null;
  let matchId = null;
  let micEnabled = true;

  const servers = {
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }]
  };

  // DOM
  const localVideo = document.getElementById("localVideo");
  const remoteVideo = document.getElementById("remoteVideo");
  const micBtn = document.getElementById("micBtn");
  const reportBtn = document.getElementById("reportBtn");
  const chatMessages = document.getElementById("chatMessages");
  const statusText = document.getElementById("status");

  // =======================
  //  MESSAGES
  // =======================
  function addMessage(msg, type = "system") {
    const d = document.createElement("div");
    d.className = `msg ${type}`;
    d.textContent = msg;
    chatMessages.appendChild(d);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // =======================
  //  MICROPHONE
  // =======================
  function updateMicButton() {
    micBtn.textContent = micEnabled ? "🎤" : "🔇";
  }

  micBtn.onclick = () => {
    if (!localStream) return;
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    updateMicButton();
  };

  // =======================
  //  REPORT
  // =======================
  reportBtn.onclick = async () => {
    if (!partnerId) return alert("لا يوجد شخص للإبلاغ عنه.");
    if (!remoteVideo || remoteVideo.readyState < 2)
      return alert("لا يمكن التقاط لقطة.");

    const canvas = document.createElement("canvas");
    canvas.width = remoteVideo.videoWidth;
    canvas.height = remoteVideo.videoHeight;

    const ctx = canvas.getContext("2d");
    ctx.drawImage(remoteVideo, 0, 0, canvas.width, canvas.height);

    socket.emit("reportPorn", {
      partnerId,
      matchId,
      timestamp: Date.now(),
      screenshot: canvas.toDataURL("image/png")
    });

    alert("🚨 تم إرسال الإبلاغ بنجاح!");
  };

  // =======================
  //  MEDIA
  // =======================
  async function initMedia() {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });

    localVideo.srcObject = localStream;
    updateMicButton();
  }

  // =======================
  //  WEBRTC
  // =======================
  function createPeerConnection() {
    peerConnection = new RTCPeerConnection(servers);

    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    peerConnection.ontrack = e => {
      remoteVideo.srcObject = e.streams[0];
      statusText.textContent = "Connected!";
    };

    peerConnection.onicecandidate = e => {
      if (e.candidate) {
        socket.emit("signal", {
          to: partnerId,
          data: { candidate: e.candidate },
        });
      }
    };
  }

  // =======================
  //  SOCKET EVENTS
  // =======================
  socket.on("partner-found", async p => {
    partnerId = p.id;
    await initMedia();
    createPeerConnection();
  });

  socket.on("signal", async ({ data }) => {
    if (data.type === "offer") {
      await peerConnection.setRemoteDescription(data);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit("signal", { to: partnerId, data: answer });

    } else if (data.type === "answer") {
      await peerConnection.setRemoteDescription(data);

    } else if (data.candidate) {
      peerConnection.addIceCandidate(data.candidate);
    }
  });

  // Auto start
  socket.emit("find-partner");
};
