const socket = io();
let localStream = null;
let peerConnection = null;
let partnerId = null;
let isInitiator = false;
let autoReconnect = true;
let isStopped = false;
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
function showLoading(show) {
  loadingIndicator.style.display = show ? "flex" : "none";
}
function showSpinners() {
  localSpinner.style.display = "block";
  remoteSpinner.style.display = "block";
  localVideo.style.display = "none";
  remoteVideo.style.display = "none";
}
// دالة جديدة لإظهار الـ spinner فقط في شاشة الغريب
function showRemoteSpinner() {
  remoteSpinner.style.display = "block";
  remoteVideo.style.display = "none";
}
function hideSpinners() {
  localSpinner.style.display = "none";
  remoteSpinner.style.display = "none";
  localVideo.style.display = "block";
  remoteVideo.style.display = "block";
}
function addMessage(message, type = "system") {
  const messageDiv = document.createElement("div");
 
  if (type === "system") {
    messageDiv.className = "system-message";
    messageDiv.textContent = message;
  } else {
    messageDiv.className = `message ${type}`;
    messageDiv.textContent = message;
  }
 
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
  } catch (e) { console.warn(e); }
  peerConnection = null;
  remoteVideo.srcObject = null;
  hideSpinners(); // إخفاء الـ spinners عند إغلاق الاتصال
}
function resetUI() {
  disableChat();
  addMessage("Disconnected. Click 'Start' to find a new stranger.", "system");
  skipBtn.disabled = true;
  stopBtn.disabled = true;
  startBtn.disabled = false;
  hideSpinners();
}
async function initMedia() {
  if (!localStream) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
    } catch (err) {
      statusText.textContent = "Camera/mic access denied.";
      showLoading(false);
      console.error(err);
      return false;
    }
  }
  return true;
}

let searchTimer = null;
let pauseTimer = null;

function startSearchLoop() {
  if (isStopped || partnerId) return;

  showLoading(true);
  socket.emit("find-partner");
  statusText.textContent = "Searching for stranger...";

  // Start 3-second search timer
  searchTimer = setTimeout(() => {
    if (!partnerId && !isStopped) {
      socket.emit("stop"); // Remove from queue
      showLoading(false);
      statusText.textContent = "Pausing search...";
      // Pause for 1 second
      pauseTimer = setTimeout(() => {
        startSearchLoop(); // Restart the search loop
      }, 1000);
    }
  }, 3000);
}

async function startSearch() {
  if (isStopped) return;
  statusText.textContent = "Requesting camera & microphone...";
  showLoading(true);

  if (!(await initMedia())) return;

  closePeerConnection();
  partnerId = null;
  isInitiator = false;
  chatMessages.innerHTML = '';
  // إظهار الـ spinner في شاشة الغريب أثناء البحث
  remoteSpinner.style.display = "block";
  remoteVideo.style.display = "none";
  statusText.textContent = "Searching for stranger...";
  skipBtn.disabled = false;
  stopBtn.disabled = false;
  startBtn.disabled = true;

  startSearchLoop();
}
// Event Listeners
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
  // إظهار الـ spinner فقط في شاشة الغريب أثناء التخطي والبحث الجديد
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
  }
};
sendBtn.onclick = sendMessage;
chatInput.onkeypress = (e) => {
  if (e.key === "Enter") sendMessage();
};
function sendMessage() {
  const message = chatInput.value.trim();
  if (!message || !partnerId) return;
 
  // Add message to chat
  addMessage(message, "you");
 
  // Send message to partner
  socket.emit("chat-message", { to: partnerId, message });
 
  // Clear input
  chatInput.value = "";
}
// Socket Events
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
  hideSpinners(); // إخفاء الـ spinners عند العثور على شريك
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
socket.on("partner-disconnected", (info) => {
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
    // إظهار الـ spinner فقط في شاشة الغريب أثناء إعادة الاتصال
    showRemoteSpinner();
    startSearchLoop();
  } else {
    resetUI();
    showLoading(false);
  }
});
// Peer Connection
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
    } else if (["disconnected", "failed", "closed"].includes(state)) {
      statusText.textContent = "Connection lost.";
      clearTimeout(searchTimer);
      clearTimeout(pauseTimer);
      closePeerConnection();
      disableChat();
      addMessage("Connection lost.", "system");
     
      if (autoReconnect && !isStopped) {
        statusText.textContent = "Reconnecting...";
        showLoading(true);
        // إظهار الـ spinner فقط في شاشة الغريب أثناء إعادة الاتصال
        showRemoteSpinner();
        startSearchLoop();
      } else {
        resetUI();
        showLoading(false);
      }
    }
  };
}
