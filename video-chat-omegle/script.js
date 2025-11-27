const socket = io();

// HTML refs
const startBtn = document.getElementById("startBtn");
const skipBtn = document.getElementById("skipBtn");
const stopBtn = document.getElementById("stopBtn");
const sendBtn = document.getElementById("sendBtn");
const chatInput = document.getElementById("chatInput");
const remoteSpinner = document.getElementById("remoteSpinner");
const statusBar = document.getElementById("status");

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");

// WebRTC
let pc;
let localStream;

// ------------------- Start Button -------------------
startBtn.addEventListener("click", async () => {
    startBtn.disabled = true;
    statusBar.innerText = "Starting camera...";

    try {
        // ----- 1. تشغيل الكاميرا -----
        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });

        localVideo.srcObject = localStream;  // <<< المهم !!!

        statusBar.innerText = "Connecting to server...";
        remoteSpinner.style.display = "block";

        // ----- 2. طلب شريك -----
        socket.emit("findPartner");

    } catch (err) {
        console.error(err);
        alert("Camera or microphone error.");
        startBtn.disabled = false;
    }
});

// ------------------- Socket Events -------------------
socket.on("partnerFound", async () => {
    statusBar.innerText = "Partner found. Connecting...";

    createPeer();

    // Create Offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("offer", offer);
});

socket.on("offer", async (offer) => {
    createPeer();

    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit("answer", answer);
});

socket.on("answer", async (answer) => {
    await pc.setRemoteDescription(answer);
});

socket.on("ice", async (ice) => {
    if (pc) pc.addIceCandidate(ice);
});

// ------------------- Peer Setup -------------------
function createPeer() {
    pc = new RTCPeerConnection({
        iceServers: [
            { urls: "stun:stun.l.google.com:19302" }
        ]
    });

    // Add local stream tracks
    localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
    });

    // Remote stream
    pc.ontrack = (e) => {
        remoteVideo.srcObject = e.streams[0];
        remoteSpinner.style.display = "none";
        statusBar.innerText = "Connected";
    };

    pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit("ice", e.candidate);
    };
}

// ------------------- Chat -------------------
sendBtn.addEventListener("click", sendChat);
chatInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") sendChat();
});

function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;

    appendMsg("you", text);
    socket.emit("chat", text);
    chatInput.value = "";
}

socket.on("chat", (text) => {
    appendMsg("them", text);
});

function appendMsg(type, text) {
    const box = document.getElementById("chatMessages");

    let div = document.createElement("div");
    div.className = "msg " + type;
    div.innerText = text;

    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

// ------------------- Skip -------------------
skipBtn.addEventListener("click", () => {
    socket.emit("skip");
    resetCall();
});

// ------------------- Stop -------------------
stopBtn.addEventListener("click", () => {
    socket.emit("stop");
    resetCall();
});

function resetCall() {
    if (pc) pc.close();
    pc = null;
    remoteVideo.srcObject = null;
    remoteSpinner.style.display = "none";
    statusBar.innerText = "Ready";
}
