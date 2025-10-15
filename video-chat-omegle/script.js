// script.js
const socket = io();
let localStream = null;
let peerConnection = null;
let partnerId = null;
let isInitiator = false;
let connected = false;

const servers = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const statusText = document.getElementById("status");
const startBtn = document.getElementById("startBtn");
const skipBtn = document.getElementById("skipBtn");
const stopBtn = document.getElementById("stopBtn");

function logStatus(text) {
  statusText.textContent = text;
  console.log(text);
}

// جلب الميكروفون والكاميرا (مرة واحدة)
async function initMedia() {
  if (!localStream) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
    } catch (err) {
      console.error("getUserMedia error:", err);
      alert("يرجى السماح بالوصول إلى الكاميرا والميكروفون.");
      throw err;
    }
  }
}

// انشاء RTCPeerConnection وتوصيل المسارات
function createPeerConnection() {
  peerConnection = new RTCPeerConnection(servers);

  // إضافة المسارات المحلية
  if (localStream) {
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
  }

  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("signal", { data: { candidate: event.candidate } });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    console.log("PC state:", peerConnection.connectionState);
    if (peerConnection.connectionState === "connected") {
      connected = true;
      logStatus("Connected with partner.");
    } else if (peerConnection.connectionState === "disconnected" || peerConnection.connectionState === "failed" || peerConnection.connectionState === "closed") {
      connected = false;
      logStatus("Peer connection closed/disconnected.");
    }
  };
}

// ابدأ البحث عن شريك
startBtn.addEventListener("click", async () => {
  try {
    await initMedia
