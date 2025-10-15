// script.js
const socket = io();
let localStream = null;
let peerConnection = null;
let partnerId = null;
let isInitiator = false;
let autoReconnect = true; // لتفعيل إعادة البحث التلقائي
let isStopped = false;    // لمعرفة إن المستخدم أوقف البحث يدوياً

const servers = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const statusText = document.getElementById("status");
const startBtn = document.getElementById("startBtn");
const skipBtn = document.getElementById("skipBtn");
const stopBtn = document.getElementById("stopBtn");

function closePeerConnection() {
  try {
    if (peerConnection) {
      peerConnection.ontrack = null;
      peerConnection.onicecandidate = null;
      peerConnection.close();
    }
  } catch (e) { console.warn(e); }
  peerConnection = null;
  remoteVideo.srcObject = null;
}

async function startSearch() {
  if (isStopped) return; // لا تبدأ البحث إذا المستخدم أوقفه

  statusText.textContent = "Requesting camera & microphone...";
  try {
    if (!localStream) {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
    }
  } catch (err) {
    statusText.textContent = "Camera/mic access denied.";
    console.error(err);
    return;
  }

  closePeerConnection();
  partnerId = null;
  isInitiator = false;

  socket.emit("find-partner");
  statusText.textContent = "Searching for partner...";
}

startBtn.onclick = () => {
  isStopped = false;
  autoReconnect = true;
  startSearch();
};

skipBtn.onclick = () => {
  statusText.textContent = "Skipping...";
  socket.emit("skip");
  closePeerConnection();
};

stopBtn.onclick = () => {
  statusText.textContent = "Stopped.";
  isStopped = true;
  autoReconnect = false;
  socket.emit("stop");
  closePeerConnection();
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    localVideo.srcObject = null;
  }
};

// ======== SOCKET EVENTS ========
socket.on("waiting", (msg) => {
  statusText.textContent = msg || "Waiting...";
});

socket.on("partner-found", async (payload) => {
  partnerId = payload.id;
  isInitiator = !!payload.initiator;
  statusText.textContent = "Partner found! Connecting...";
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

// عند مغادرة الشريك
socket.on("partner-disconnected", (info) => {
  statusText.textContent = "Partner disconnected.";
  closePeerConnection();
  partnerId = null;
  isInitiator = false;

  if (autoReconnect && !isStopped) {
    statusText.textContent = "Searching for new partner...";
    setTimeout(() => {
      startSearch();
    }, 3000);
  }
});

// ======== PEER CONNECTION ========
function createPeerConnection() {
  peerConnection = new RTCPeerConnection(servers);

  if (localStream) {
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
  }

  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
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
      statusText.textContent = "Connected!";
    } else if (["disconnected", "failed", "closed"].includes(state)) {
      statusText.textContent = "Connection closed.";
      closePeerConnection();
      if (autoReconnect && !isStopped) {
        statusText.textContent = "Reconnecting...";
        setTimeout(() => startSearch(), 3000);
      }
    }
  };
}
