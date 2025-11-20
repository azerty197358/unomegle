const express = require("express");
const path = require("path"); // New: For absolute paths
const fs = require("fs"); // New: For file system operations
const basicAuth = require('express-basic-auth'); // New: For basic authentication
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
app.use(express.static(__dirname));

// Serve reports folder statically (but we'll secure it via admin page)
const reportDir = path.join(__dirname, 'reports');
if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir);
app.use('/reports', express.static(reportDir));

// Middleware for basic auth on admin routes
const getUnauthorizedResponse = (req) => {
  return req.auth
    ? ('Credentials ' + req.auth.user + ':' + req.auth.password + ' rejected')
    : 'No credentials provided';
};
const adminAuth = basicAuth({
  users: { 'admin': 'supersecretpassword' }, // Change this to your desired username and password
  unauthorizedResponse: getUnauthorizedResponse
});
app.use(express.urlencoded({ extended: true })); // For parsing POST forms

const waitingQueue = [];
const partners = new Map();
const bannedIps = new Map();

// Admin page route (secured)
app.get('/admin', adminAuth, (req, res) => {
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
          form { display: inline; }
          button { background: #ff0000; color: white; border: none; padding: 5px 10px; cursor: pointer; }
          button:hover { background: #cc0000; }
          select { margin-right: 5px; }
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
            <form action="/ban" method="POST">
              <input type="hidden" name="ip" value="${reportedIp}">
              <select name="duration">
                <option value="24h">24 Hours</option>
                <option value="permanent">Permanent</option>
              </select>
              <button type="submit">Ban IP</button>
            </form>
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

// Ban route (secured, POST)
app.post('/ban', adminAuth, (req, res) => {
  const ip = req.body.ip;
  const duration = req.body.duration;
  if (!ip) {
    return res.status(400).send('Invalid IP.');
  }
  let banExpire;
  if (duration === 'permanent') {
    banExpire = Infinity;
  } else if (duration === '24h') {
    banExpire = Date.now() + 24 * 60 * 60 * 1000;
  } else {
    return res.status(400).send('Invalid duration.');
  }
  bannedIps.set(ip, banExpire);
  console.log(`Banned IP ${ip} ${duration === 'permanent' ? 'permanently' : 'for 24 hours'}.`);
  res.redirect('/admin');
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
  // Handle report porn: save screenshot for manual review
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
      socket.emit("reportHandled", { message: "Report submitted for admin review." });
    } catch (error) {
      console.error("Error saving report:", error);
      socket.emit("reportHandled", { message: "Error submitting report. Try again.", error: true });
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
