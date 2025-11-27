// ====== SOCKET & GLOBALS ======
const socket = io();
let localStream = null;
let peerConnection = null;
let partnerId = null;
let isInitiator = false;
let autoReconnect = true;
let isStopped = false;
let micEnabled = true;

const servers = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };

// ====== DOM ======
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");

const localSpinner = document.getElementById("localSpinner");  // داخل شاشة الغريب
const remoteSpinner = document.getElementById("remoteSpinner"); // أيضا داخل شاشة الغريب

const statusText = document.getElementById("status");

const startBtn = document.getElementById("startBtn");
const skipBtn = document.getElementById("skipBtn");
const stopBtn = document.getElementById("stopBtn");

const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const chatMessages = document.getElementById("chatMessages");

const micBtn = document.getElementById("micBtn");

// ====== MIC BUTTON ======
function updateMicButton() {
  if (!micBtn) return;

  if (micEnabled) {
    micBtn.innerHTML = "🎤";
    micBtn.title = "Mute microphone";
  } else {
    micBtn.innerHTML = "🔇";
    micBtn.title = "Unmute microphone";
  }
}

function toggleMicrophone() {
  if (!localStream) return;

  micEnabled = !micEnabled;

  localStream.getAudioTracks().forEach(track => {
    track.enabled = micEnabled;
  });

  updateMicButton();
}

window.toggleMicrophone = toggleMicrophone;

window.setLocalStream = function (stream) {
  localStream = stream;
  updateMicButton();
  micBtn.style.display = "flex";
};

// ====== SPINNERS (جديدة ومُصلّحة) ======

function showRemoteSpinnerOnly(show) {
  remoteSpinner.style.display = show ? "block" : "none";
  remoteVideo.style.display = show ? "none" : "block";
}

function showBothSpinners() {
  localSpinner.style.display = "block";
  remoteSpinner.style.display = "block";
  localVideo.style.display = "none";
  remoteVideo.style.display = "none";
}

function hideAllSpinners() {
  localSpinner.style.display = "none";
  remoteSpinner.style.display = "none";
  localVideo.style.display = "block";
  remoteVideo.style.display = "block";
}

// ====== CHAT ======
function addMessage(message, type = "system") {
  const d = document.createElement("div");

  if (type === "system") {
    d.className = "msg system";
  } else if (type === "you") {
    d.className = "msg you";
  } else {
    d.className = "msg them";
  }

  d.textContent = message;
  chatMessages.appendChild(d);
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

// ====== RESET ======
function closePeerConnection() {
  try {
    if (peerConnection) {
      peerConnection.ontrack = null;
      peerConnection.onicecandidate = null;
      peerConnection.onconnectionstatechange = null;
      peerConnection.close();
    }
  } catch { }

  peerConnection = null;
  remoteVideo.srcObject = null;
}

function resetUI() {
  disableChat();
  addMessage("Disconnected. Click 'Start' to find a new stranger.", "system");

  skipBtn.disabled = true;
  stopBtn.disabled = true;
  startBtn.disabled = false;

  hideAllSpinners();
}

// ====== MEDIA ======
async function initMedia() {
  if (!localStream) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });
      localVideo.srcObject = localStream;

      if (window.setLocalStream) window.setLocalStream(localStream);

    } catch (err) {
      statusText.textContent = "Camera/mic access denied.";
      console.error(err);
      return false;
    }
  }
  return true;
}

// ====== SEARCH LOOP ======
let searchTimer = null;
let pauseTimer = null;

function startSearchLoop() {
  if (isStopped || partnerId) return;

  showRemoteSpinnerOnly(true);
  statusText.textContent = "Searching for stranger...";

  socket.emit("find-partner");

  searchTimer = setTimeout(() => {

    if (!partnerId && !isStopped) {
      socket.emit("stop");

      showRemoteSpinnerOnly(false);
      statusText.textContent = "Pausing...";

      pauseTimer = setTimeout(() => {
        startSearchLoop();
      }, 2000);
    }

  }, 4000);
}

// ====== START ======
async function startSearch() {
  if (isStopped) return;

  statusText.textContent = "Requesting camera & microphone...";

  if (!(await initMedia())) return;

  closePeerConnection();
  partnerId = null;
  isInitiator = false;

  chatMessages.innerHTML = "";

  showRemoteSpinnerOnly(true);

  statusText.textContent = "Searching for stranger...";

  skipBtn.disabled = false;
  stopBtn.disabled = false;
  startBtn.disabled = true;

  startSearchLoop();
}

// ====== BUTTONS ======
startBtn.onclick = () => {
  isStopped = false;
  autoReconnect = true;
  startSearch();
};

skipBtn.onclick = () => {
  statusText.textContent = "Skipping stranger...";

  clearTimeout(searchTimer);
  clearTimeout(pauseTimer);

  socket.emit("skip");

  closePeerConnection();
  disableChat();

  addMessage("You skipped the stranger.", "system");

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
    micBtn.style.display = "none";
  }
};

// ====== SEND MESSAGE ======
sendBtn.onclick = sendMessage;

chatInput.onkeypress = (e) => {
  if (e.key === "Enter") sendMessage();
};

function sendMessage() {
  const message = chatInput.value.trim();

  if (!message || !partnerId) return;

  addMessage(message, "you");
  socket.emit("chat-message", { to: partnerId, message });

  chatInput.value = "";
}

// ====== SOCKET EVENTS ======
socket.on("waiting", (msg) => {
  statusText.textContent = msg || "Waiting...";
});

socket.on("chat-message", ({ from, message }) => {
  addMessage(message, "them");
});

socket.on("partner-disconnected", () => {
  statusText.textContent = "Stranger disconnected.";

  clearTimeout(searchTimer);
  clearTimeout(pauseTimer);

  closePeerConnection();
  disableChat();
  addMessage("Stranger disconnected.", "system");

  partnerId = null;
  isInitiator = false;

  if (autoReconnect && !isStopped) {
    statusText.textContent = "Searching for new stranger...";
    showRemoteSpinnerOnly(true);
    startSearchLoop();
  } else {
    resetUI();
  }
});

// ====== SIGNALING ======
socket.on("partner-found", async ({ id, initiator }) => {
  clearTimeout(searchTimer);
  clearTimeout(pauseTimer);

  partnerId = id;
  isInitiator = initiator;

  statusText.textContent = "Stranger found! Connecting...";

  hideAllSpinners();
  createPeerConnection();

  if (isInitiator) {
    try {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      socket.emit("signal", {
        to: partnerId,
        data: peerConnection.localDescription
      });

    } catch (err) {
      console.error("Offer error:", err);
    }
  }
});

socket.on("signal", async ({ from, data }) => {
  if (!peerConnection) createPeerConnection();

  try {
    if (data.type === "offer") {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data));

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      socket.emit("signal", {
        to: from,
        data: peerConnection.localDescription
      });

    } else if (data.type === "answer") {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data));

    } else if (data.candidate) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    }

  } catch (err) {
    console.error("Signal error:", err);
  }
});

// ====== WEBRTC ======
function createPeerConnection() {
  peerConnection = new RTCPeerConnection(servers);

  if (localStream) {
    localStream.getTracks().forEach(track =>
      peerConnection.addTrack(track, localStream)
    );
  }

  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];

    statusText.textContent = "Connected!";
    enableChat();
    addMessage("Connected with a stranger. Say hi!", "system");

    showRemoteSpinnerOnly(false);
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && partnerId) {
      socket.emit("signal", {
        to: partnerId,
        data: { candidate: event.candidate }
      });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;

    if (state === "connected") {
      statusText.textContent = "Connected!";
    }

    if (["disconnected", "failed", "closed"].includes(state)) {
      statusText.textContent = "Connection lost.";

      clearTimeout(searchTimer);
      clearTimeout(pauseTimer);

      closePeerConnection();
      disableChat();
      addMessage("Connection lost.", "system");

      if (autoReconnect && !isStopped) {
        statusText.textContent = "Reconnecting...";
        showRemoteSpinnerOnly(true);
        startSearchLoop();
      } else {
        resetUI();
      }
    }
  };
}
