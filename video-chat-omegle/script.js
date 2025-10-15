// script.js
const socket = io();
let localStream = null;
let peerConnection = null;
let partnerId = null;
let isInitiator = false;

const servers = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const statusText = document.getElementById("status");
const startBtn = document.getElementById("startBtn");
const skipBtn = document.getElementById("skipBtn");
const stopBtn = document.getElementById("stopBtn");

// utility to clean up peer connection
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

// start searching for partner (called when user clicks Start or after skip)
async function startSearch() {
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

  // clean any old connection
  closePeerConnection();
  partnerId = null;
  isInitiator = false;

  // tell server to find a partner
  socket.emit("find-partner");
  statusText.textContent = "Searching for partner...";
}

startBtn.onclick = startSearch;

skipBtn.onclick = () => {
  statusText.textContent = "Skipping...";
  // notify server to skip; server will requeue you
  socket.emit("skip");
  // close current peer connection locally and keep localStream to find new partner
  closePeerConnection();
};

stopBtn.onclick = () => {
  statusText.textContent = "Stopped.";
  socket.emit("stop");
  closePeerConnection();
  // stop local tracks
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    localVideo.srcObject = null;
  }
};

// server messages
socket.on("waiting", (msg) => {
  statusText.textContent = msg || "Waiting...";
});

socket.on("partner-found", async (payload) => {
  partnerId = payload.id;
  isInitiator = !!payload.initiator;
  statusText.textContent = "Partner found! Connecting...";
  // create peer connection and attach tracks
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

// forward signals from server
socket.on("signal", async ({ from, data }) => {
  // if no peerConnection, create it (non-initiator)
  if (!peerConnection) createPeerConnection();

  try {
    if (data.type === "offer") {
      // remote sent offer
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

socket.on("partner-disconnected", (info) => {
  statusText.textContent = "Partner disconnected.";
  closePeerConnection();
  partnerId = null;
  isInitiator = false;
  // If partner disconnected unexpectedly, you may auto-search again or wait:
  // Here, we'll stay waiting until user presses Start or Skip to re-find.
});

// helper: create peer connection and attach local tracks
function createPeerConnection() {
  peerConnection = new RTCPeerConnection(servers);

  // add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
  }

  peerConnection.ontrack = (event) => {
    // show remote stream
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
    console.log("PC state:", state);
    if (state === "connected") {
      statusText.textContent = "Connected!";
    } else if (state === "disconnected" || state === "failed" || state === "closed") {
      statusText.textContent = "Connection closed.";
    }
  };
}
