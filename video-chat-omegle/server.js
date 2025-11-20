const express = require("express");
const path = require("path"); // New: For absolute paths
const fs = require("fs"); // New: For file system operations
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
app.use(express.static(__dirname));

// Serve reports folder statically
const reportDir = path.join(__dirname, 'reports');
if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir);
app.use('/reports', express.static(reportDir));

const nsfwjs = require('nsfwjs');
const tf = require('@tensorflow/tfjs-node');
const waitingQueue = [];
const partners = new Map();
const bannedIps = new Map();
let model = null; // Lazy load the model

// Admin page route
app.get('/admin', (req, res) => {
  try {
    const files = fs.readdirSync(reportDir);
    let html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Admin Reports</title>
        <style>
          body { font-family: Arial, sans-serif; background: #f5f5f5; padding: 20px; }
          h1 { color: #f60; }
          .report { margin-bottom: 20px; border: 1px solid #ccc; padding: 10px; background: #fff; border-radius: 5px; }
          img { max-width: 500px; height: auto; }
        </style>
      </head>
      <body>
        <h1>Reported Screenshots</h1>
    `;
    if (files.length === 0) {
      html += '<p>No reports yet.</p>';
    } else {
      files.forEach(file => {
        const [timestamp, partnerId, reporterIp, reportedIp] = file.replace('.png', '').split('_');
        html += `
          <div class="report">
            <img src="/reports/${file}" alt="Reported Screenshot">
            <p><strong>Timestamp:</strong> ${timestamp}</p>
            <p><strong>Partner ID:</strong> ${partnerId}</p>
            <p><strong>Reporter IP:</strong> ${reporterIp}</p>
            <p><strong>Reported IP:</strong> ${reportedIp}</p>
          </div>
        `;
      });
    }
    html += '</body></html>';
    res.send(html);
  } catch (error) {
    console.error('Error loading admin page:', error);
    res.status(500).send('Error loading reports.');
  }
});

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
  // Handle report porn with automatic analysis and save to admin
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
      // Save screenshot to reports folder with metadata in filename
      const base64Data = screenshot.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
      const imageBuffer = Buffer.from(base64Data, 'base64');
      const safeTimestamp = timestamp.replace(/[:]/g, '-');
      const fileName = `${safeTimestamp}_${partnerId}_${reporterIp}_${reportedIp}.png`;
      const filePath = path.join(reportDir, fileName);
      fs.writeFileSync(filePath, imageBuffer);
      console.log(`Saved report screenshot: ${fileName}`);

      // Lazy load the model if not already loaded (local absolute path to model.json)
      if (!model) {
        console.log("Loading NSFW model from local path...");
        const modelPath = path.join(__dirname, 'model/model.json');
        model = await nsfwjs.load(`file://${modelPath}`);
        console.log("NSFW model loaded successfully.");
      }
      // Decode image to tensor
      const image = await tf.node.decodeImage(imageBuffer, 3); // RGB channels
      // Classify
      const predictions = await model.classify(image);
      image.dispose();
      // Check for NSFW classes ('Porn', 'Hentai', etc.) with threshold > 0.7
      const nsfwPredictions = predictions.filter(p => ['Porn', 'Hentai', 'Sexy'].includes(p.className));
      const highestProb = nsfwPredictions.reduce((max, p) => Math.max(max, p.probability), 0);
      const isNudity = highestProb > 0.7;
      console.log(`NSFW Analysis for IP ${reportedIp}: ${isNudity ? `Nudity detected (prob: ${highestProb.toFixed(2)})` : 'No nudity detected'}`);
      if (isNudity) {
        // Ban for 24 hours
        const banDuration = 24 * 60 * 60 * 1000; // ms
        bannedIps.set(reportedIp, Date.now() + banDuration);
        console.log(`Banned IP ${reportedIp} for 24 hours.`);
        // Disconnect reported user
        if (reportedSocket) {
          reportedSocket.emit("banned", { message: "Banned for 24 hours due to inappropriate content." });
          reportedSocket.disconnect(true);
        }
        socket.emit("reportHandled", { message: "Nudity detected! User banned for 24 hours.", nudityDetected: true });
      } else {
        socket.emit("reportHandled", { message: "No nudity detected.", nudityDetected: false });
      }
    } catch (error) {
      console.error("Error in NSFW analysis:", error);
      socket.emit("reportHandled", { message: "Analysis error. Try again.", error: true });
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
    // Pair if queue has 2+
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
