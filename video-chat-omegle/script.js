const socket = io();
let localStream;
let peerConnection;
let partnerId;

const servers = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }]
};

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const statusText = document.getElementById("status");
const startBtn = document.getElementById("startBtn");
const skipBtn = document.getElementById("skipBtn");
const stopBtn = document.getElementById("stopBtn");

startBtn.onclick = async () => {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  localVideo.srcObject = localStream;
  statusText.textContent = "Searching for partner...";
};

socket.on("waiting", (msg) => {
  statusText.textContent = msg;
});

socket.on("partner-found", async (id) => {
  partnerId = id;
  statusText.textContent = "Partner found! Connecting...";
  createPeerConnection();

  // إذا كان أنت المبادر
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit("signal", offer);
});

socket.on("signal", async ({ from, data }) => {
  if (!peerConnection) createPeerConnection();
  if (data.type === "offer") {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit("signal", answer);
  } else if (data.type === "answer") {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data));
  } else if (data.candidate) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (err) {
      console.error("Error adding ICE candidate:", err);
    }
  }
});

socket.on("partner-disconnected", () => {
  statusText.textContent = "Partner disconnected.";
  remoteVideo.srcObject = null;
  if (peerConnection) peerConnection.close();
});

function createPeerConnection() {
  peerConnection = new RTCPeerConnection(servers);

  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("signal", { candidate: event.candidate });
    }
  };
}
