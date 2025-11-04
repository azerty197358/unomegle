const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
app.use(express.static(__dirname));

const nsfwjs = require('nsfwjs');
const tf = require('@tensorflow/tfjs-node');

const waitingQueue = [];
const partners = new Map();
// Banned IPs: Map<ip, expiration> where expiration is timestamp (ms) or Infinity for permanent
const bannedIps = new Map();

let model = null; // Lazy load the model

io.on("connection", (socket) => {
  const clientIp = socket.handshake.address.address;
 
  // Check for ban
  const banExpire = bannedIps.get(clientIp);
  if (banExpire && (banExpire === Infinity || banExpire > Date.now())) {
    socket.emit("banned", { message: "You are temporarily/permanently banned from this service." });
    socket.disconnect(true);
    return;
  }
  console.log("Connected:", socket.id, "IP:", clientIp);

  socket.on("find-partner", () => {
    if (partners.has(socket.id)) return;
    if (waitingQueue.includes(socket.id)) return;
    if (waitingQueue.length > 0) {
      const otherId = waitingQueue.shift();
      const otherSocket = io.sockets.sockets.get(otherId);
   
      if (!otherSocket) {
        socket.emit("waiting", "Looking for a stranger...");
        if (waitingQueue.length > 0) socket.emit("find-partner");
        return;
      }
      partners.set(socket.id, otherId);
      partners.set(otherId, socket.id);
      socket.emit("partner-found", { id: otherId, initiator: true });
      otherSocket.emit("partner-found", { id: socket.id, initiator: false });
      console.log(`Paired ${socket.id} <-> ${otherId}`);
    } else {
      waitingQueue.push(socket.id);
      socket.emit("waiting", "Looking for a stranger...");
    }
  });

  socket.on("signal", (payload) => {
    const to = payload.to;
    const data = payload.data;
    if (!to) return;
    const target = io.sockets.sockets.get(to);
    if (target) {
      target.emit("signal", { from: socket.id, data });
    }
  });

  // Handle chat messages
  socket.on("chat-message", (payload) => {
    const to = payload.to;
    const message = payload.message;
    if (!to) return;
    const target = io.sockets.sockets.get(to);
    if (target) {
      target.emit("chat-message", { from: socket.id, message });
    }
  });

  // Handle report porn with automatic analysis
  socket.on("reportPorn", async (payload) => {
    const { screenshot, timestamp, partnerId } = payload;
    if (!partnerId || !screenshot) return;

    const reportedSocket = io.sockets.sockets.get(partnerId);
    const reporterIp = clientIp;
    const reportedIp = reportedSocket ? reportedSocket.handshake.address.address : "Unknown";

    if (reportedIp === "Unknown") {
      socket.emit("reportHandled", { message: "Could not identify the reported user." });
      return;
    }

    try {
      // Lazy load the model if not already loaded (from local path)
      if (!model) {
        console.log("Loading NSFW model from local path...");
        model = await nsfwjs.load('./model/'); // Load from local ./model/ folder
        console.log("NSFW model loaded successfully.");
      }

      // Extract base64 image data (remove data:image/png;base64, prefix)
      const base64Data = screenshot.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
      const imageBuffer = Buffer.from(base64Data, 'base64');

      // Decode image to tensor
      const image = await tf.node.decodeImage(imageBuffer, 3); // 3 channels for RGB

      // Classify
      const predictions = await model.classify(image);
      image.dispose();

      // Check for 'Porn' or 'Hentai' class with high probability (threshold 0.7)
      const pornPredictions = predictions.filter(p => ['Porn', 'Hentai'].includes(p.className));
      const highestProb = pornPredictions.reduce((max, p) => p.probability > max ? p.probability : max, 0);
      const isNudity = highestProb > 0.7;

      console.log(`NSFW Analysis for IP ${reportedIp}: ${isNudity ? `Nudity detected (prob: ${highestProb})` : 'No nudity detected'}`);

      if (isNudity) {
        // Ban for 24 hours
        const banDuration = 24 * 60 * 60 * 1000; // 24 hours in ms
        bannedIps.set(reportedIp, Date.now() + banDuration);
        console.log(`Banned IP ${reportedIp} for 24 hours due to nudity detection.`);

        // Optionally, disconnect the reported user if online
        if (reportedSocket) {
          reportedSocket.emit("banned", { message: "You have been banned for 24 hours due to reported inappropriate content." });
          reportedSocket.disconnect(true);
        }

        socket.emit("reportHandled", { message: "Nudity detected! User banned for 24 hours.", nudityDetected: true });
      } else {
        socket.emit("reportHandled", { message: "No nudity detected in the screenshot.", nudityDetected: false });
      }
    } catch (error) {
      console.error("Error in NSFW analysis:", error);
      socket.emit("reportHandled", { message: "Error analyzing the report. Please try again.", error: true });
    }
  });

  socket.on("skip", () => {
    const partnerId = partners.get(socket.id);
  
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit("partner-disconnected", { reason: "skipped" });
        partners.delete(partnerId);
      }
      partners.delete(socket.id);
    }
    if (!waitingQueue.includes(socket.id)) waitingQueue.push(socket.id);
    socket.emit("waiting", "Looking for a new stranger...");
  
    if (waitingQueue.length >= 2) {
      const first = waitingQueue.shift();
      const second = waitingQueue.shift();
      const s1 = io.sockets.sockets.get(first);
      const s2 = io.sockets.sockets.get(second);
    
      if (s1 && s2) {
        partners.set(first, second);
        partners.set(second, first);
        s1.emit("partner-found", { id: second, initiator: true });
        s2.emit("partner-found", { id: first, initiator: false });
      } else {
        if (s1 && !waitingQueue.includes(first)) waitingQueue.push(first);
        if (s2 && !waitingQueue.includes(second)) waitingQueue.push(second);
      }
    }
  });

  socket.on("stop", () => {
    const idx = waitingQueue.indexOf(socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);
    const partnerId = partners.get(socket.id);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit("partner-disconnected", { reason: "stopped" });
        partners.delete(partnerId);
      }
      partners.delete(socket.id);
    }
    socket.emit("stopped", "Stopped searching");
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
    const idx = waitingQueue.indexOf(socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);
    const partnerId = partners.get(socket.id);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit("partner-disconnected", { reason: "peer-left" });
        partners.delete(partnerId);
      }
      partners.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
