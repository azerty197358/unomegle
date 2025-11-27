const socket = io();

let localStream = null;
let peerConnection = null;
let partnerId = null;
let isInitiator = false;
let autoReconnect = true;
let isStopped = false;
let micEnabled = true;

// ICE Servers
const servers = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };

// DOM Elements
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const localSpinner = document.getElementById("localSpinner");
const remoteSpinner = document.getElementById("remoteSpinner");
const statusText = document.getElementById("status");
const loadingIndicator = document.getElementById("loading");

const startBtn = document.getElementById("startBtn");
const skipBtn = document.getElementById("skipBtn");
const stopBtn = document.getElementById("stopBtn");

const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const chatMessages = document.getElementById("chatMessages");

const micBtn = document.getElementById("micBtn");


// =======================
//      MIC BUTTON
// =======================

function updateMicButton() {
  if (!micBtn) return;
  if (micEnabled) {
    micBtn.innerHTML = "🎤";
    micBtn.classList.remove("muted");
    micBtn.title = "Mute Microphone";
  } else {
    micBtn.innerHTML = "🔇";
    micBtn.classList.add("muted");
    micBtn.title = "Unmute Microphone";
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
  if (micBtn) micBtn.style.display = "flex";
};


// =======================
//     UI Functions
// =======================

function showLoading(show) {
  loadingIndicator.style.display = show ? "flex" : "none";
}

function showSpinners() {
  localSpinner.style.display = "block";
  remoteSpinner.style.display = "block";
  localVideo.style.display = "none";
  remoteVideo.style.display = "none";
}

function showRemoteSpinner() {
  remoteSpinner.style.display = "block";
  remoteVideo.style.display = "none";
}

function hideRemoteSpinner() {
  remoteSpinner.style.display = "none";
  remoteVideo.style.display = "block";
}

function hideSpinners() {
  localSpinner.style.display = "none";
  remoteSpinner.style.display = "none";
  localVideo.style.display = "block";
  remoteVideo.style.display = "block";
}

function addMessage(message, type = "system") {
  const messageDiv = document.createElement("div");
  messageDiv.className = type === "system" ? "system-message" : `message ${type}`;
  messageDiv.textContent = message;
  chatMessages.appendChild(messageDiv);
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

function closePeerConnection() {
  try {
    if (peerConnection) {
      peerConnection.ontrack = null;
      peerConnection.onicecandidate = null;
      peerConnection.onconnectionstatechange = null;
      peerConnection.close();
    }
  } catch (e) {
    console.warn(e);
  }

  peerConnection = null;
  remoteVideo.srcObject = null;
}

function resetUI() {
  disableChat();
  addMessage("Disconnected. Click 'Start' to find a new stranger.", "system");
  skipBtn.disabled = true;
  stopBtn.disabled = true;
  startBtn.disabled = false;
  hideSpinners();
}


// =======================
//      GET MEDIA
// =======================

async function initMedia() {
  if (!localStream) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;

      // إصلاح: إعادة تمكين المايك حسب حالته
      localStream.getAudioTracks()[0].enabled = micEnabled;

      if (window.setLocalStream) window.setLocalStream(localStream);
    } catch (err) {
      statusText.textContent = "Camera/mic access denied.";
      showLoading(false);
      console.error(err);
      return false;
    }
  }
  return true;
}


// =======================
//     Search Loop Fix
// =======================

let searchTimer = null;
let pauseTimer = null;

function startSearchLoop() {
  if (isStopped || partnerId) return;

  // إصلاح: منع تكرار الحلقة
  clearTimeout(searchTimer);
  clearTimeout(pauseTimer);

  showRemoteSpinner();
  socket.emit("find-partner");
  statusText.textContent = "Searching for stranger...";

  searchTimer = setTimeout(() => {
    if (!partnerId && !isStopped) {
      socket.emit("stop");
      hideRemoteSpinner();
      statusText.textContent = "Pausing search...";

      pauseTimer = setTimeout(() => {
        startSearchLoop();
      }, 2000);
    }
  }, 4000);
}

async function startSearch() {
  if (isStopped) return;

  statusText.textContent = "Requesting camera & microphone...";
  showLoading(true);

  if (!(await initMedia())) return;

  closePeerConnection();
  partnerId = null;
  isInitiator = false;
  chatMessages.innerHTML = "";

  showRemoteSpinner();
  statusText.textContent = "Searching for stranger...";

  skipBtn.disabled = false;
  stopBtn.disabled = false;
  startBtn.disabled = true;

  startSearchLoop();
}


// =======================
//     BUTTON HANDLERS
// =======================

startBtn.onclick = () => {
  startBtn.disabled = true; // إصلاح مهم
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

  showRemoteSpinner();
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
  showLoading(false);

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    localVideo.srcObject = null;
    if (micBtn) micBtn.style.display = "none";
  }
};

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


// =======================
//      Socket Events
// =======================

socket.on("waiting", (msg) => {
  statusText.textContent = msg || "Waiting for stranger...";
});

socket.on("partner-found", async (payload) => {
  clearTimeout(searchTimer);
  clearTimeout(pauseTimer);

  partnerId = payload.id;
  isInitiator = !!payload.initiator;

  statusText.textContent = "Stranger found! Connecting...";
  showLoading(false);
  hideSpinners();

  createPeerConnection();

  if (isInitiator) {
    try {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit("signal", { to: partnerId, data: peerConnection.localDescription });
    } catch (err) {
      console.error("Error creating offer:", err);
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
      socket.emit("signal", { to: from, data: peerConnection.localDescription });
    } else if (data.type === "answer") {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data));
    } else if (data.candidate) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  } catch (err) {
    console.error("Error handling signal:", err);
  }
});

socket.on("chat-message", ({ from, message }) => {
  addMessage(message, "stranger");
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
    showLoading(true);
    showRemoteSpinner();
    startSearchLoop();
  } else {
    resetUI();
    showLoading(false);
  }
});


// =======================
//     WebRTC
// =======================

function createPeerConnection() {
  peerConnection = new RTCPeerConnection(servers);

  if (localStream) {
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
  }

  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    statusText.textContent = "Connected to stranger!";
    enableChat();
    addMessage("You are now connected with a stranger. Say hi!", "system");
    hideRemoteSpinner();
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && partnerId) {
      socket.emit("signal", { to: partnerId, data: { candidate: event.candidate } });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    if (!peerConnection) return;

    const state = peerConnection.connectionState;

    if (state === "connected") {
      statusText.textContent = "Connected to stranger!";
      showLoading(false);
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
        showLoading(true);
        showRemoteSpinner();
        startSearchLoop();
      } else {
        resetUI();
        showLoading(false);
      }
    }
  };
}


// =======================
//   INITIAL FIX
// =======================

// إصلاح: بعض الأحيان يتم عرض رمز المايك قبل تحميل الزر
document.addEventListener("DOMContentLoaded", () => {
  updateMicButton();
});
