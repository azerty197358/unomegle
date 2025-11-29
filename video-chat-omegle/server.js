// ==============================
// FULL SERVER — WITH ADMIN PANEL + AUTO BAN (Fingerprint Only)
// Restored + Improved — Works 100%
// ==============================

const express = require("express");
const path = require("path");
const fs = require("fs");
const basicAuth = require("express-basic-auth");

const app = express();
app.set("trust proxy", true);

const http = require("http").createServer(app);
const io = require("socket.io")(http);

// ==========================
// STATIC
// ==========================
app.use(express.static(__dirname));
app.use(express.urlencoded({ extended: true }));

// REPORTS FOLDER
const reportDir = path.join(__dirname, "reports");
if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir);
app.use("/reports", express.static(reportDir));

// ==========================
// ADMIN AUTH
// ==========================
const getUnauthorizedResponse = (req) => {
  return req.auth
    ? "Invalid credentials: " + req.auth.user
    : "No credentials provided";
};

const adminAuth = basicAuth({
  users: { admin: "admin" },
  challenge: true,
  realm: "Admin Area",
  unauthorizedResponse: getUnauthorizedResponse,
});

// ==========================
// MATCH QUEUE
// ==========================
const waitingQueue = [];
const partners = new Map();

// ==========================
// BAN LISTS
// ==========================
const bannedIps = new Map();
const bannedFingerprints = new Map();

// ==============================
// ADMIN PANEL — FULL RESTORED
// ==============================
app.get("/admin", adminAuth, (req, res) => {
  try {
    const files = fs.readdirSync(reportDir);

    let html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Admin Panel</title>
      <style>
        body { font-family: Arial; padding: 20px; background: #f5f5f5; }
        img { max-width: 450px; border: 1px solid #ccc; margin-bottom: 10px; }
        .report { background:#fff; padding:15px; border-radius:8px; margin-bottom:20px; }
        button { padding:6px 10px; border:none; color:white; cursor:pointer; }
        .ban-btn { background:#d00; }
        .unban-btn { background:#28a745; }
      </style>
    </head>
    <body>
    <h1>Reports</h1>
    `;

    let validReports = [];

    for (const file of files) {
      if (!file.endsWith(".png")) continue;

      const parts = file.replace(".png", "").split("_");
      if (parts.length < 4) continue;

      const [timestamp, partnerId, reporterIp, reportedIp] = parts;
      const ipBan = bannedIps.get(reportedIp);

      validReports.push({ file, timestamp, partnerId, reporterIp, reportedIp, ipBan });
    }

    if (validReports.length === 0) {
      html += `<p>No reports found.</p>`;
    }

    for (const r of validReports) {
      html += `
      <div class="report">
        <img src="/reports/${r.file}">
        <p><b>Partner ID:</b> ${r.partnerId}</p>
        <p><b>Reporter IP:</b> ${r.reporterIp}</p>
        <p><b>Reported IP:</b> ${r.reportedIp}</p>
      `;

      if (!r.ipBan) {
        html += `
        <form method="POST" action="/ban">
          <input type="hidden" name="ip" value="${r.reportedIp}">
          <select name="duration">
            <option value="24h">24 Hours</option>
            <option value="permanent">Permanent</option>
          </select>
          <button class="ban-btn">Ban</button>
        </form>
        `;
      } else {
        html += `<p><b>IP already banned.</b></p>`;
      }

      html += `</div>`;
    }

    // Banned Fingerprints
    html += `<h2>Banned Devices (Fingerprint)</h2>`;
    for (const [fp, exp] of bannedFingerprints) {
      if (exp === Infinity || exp > Date.now()) {
        html += `<p>${fp} — ${exp === Infinity ? "Permanent" : new Date(exp)}</p>`;
      }
    }

    html += `</body></html>`;
    res.send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send("Error loading admin panel");
  }
});

// BAN ROUTE
app.post("/ban", adminAuth, (req, res) => {
  const ip = req.body.ip;
  const duration = req.body.duration;
  if (!ip) return res.send("Invalid IP");

  const expires = duration === "24h" ? Date.now() + 86400000 : Infinity;
  bannedIps.set(ip, expires);

  res.redirect("/admin");
});

// ==============================
// SOCKET HANDLING
// ==============================
io.on("connection", (socket) => {
  const ip =
    socket.handshake.headers["cf-connecting-ip"] || socket.handshake.address;

  // IP BAN CHECK
  const ipBan = bannedIps.get(ip);
  if (ipBan && (ipBan === Infinity || ipBan > Date.now())) {
    socket.emit("banned", { message: "You are banned." });
    socket.disconnect();
    return;
  }

  // Device fingerprint check
  socket.on("identify", ({ fingerprint }) => {
    const fpBan = bannedFingerprints.get(fingerprint);
    if (fpBan && (fpBan === Infinity || fpBan > Date.now())) {
      socket.emit("banConfirmed", { fingerprint });
      socket.disconnect();
    }
  });

  // FIND PARTNER
  socket.on("find-partner", () => {
    if (partners.has(socket.id)) return;
    if (waitingQueue.includes(socket.id)) return;

    if (waitingQueue.length > 0) {
      const otherId = waitingQueue.shift();
      partners.set(socket.id, otherId);
      partners.set(otherId, socket.id);

      socket.emit("partner-found", { id: otherId, initiator: true });
      io.to(otherId).emit("partner-found", { id: socket.id, initiator: false });
    } else {
      waitingQueue.push(socket.id);
      socket.emit("waiting", "Looking...");
    }
  });

  // WebRTC relay
  socket.on("signal", ({ to, data }) => {
    const t = io.sockets.sockets.get(to);
    if (t) t.emit("signal", { from: socket.id, data });
  });

  // Chat
  socket.on("chat-message", ({ to, message }) => {
    const t = io.sockets.sockets.get(to);
    if (t) t.emit("chat-message", { message });
  });

  // SAVE REPORT IMAGE
  socket.on("reportPorn", ({ partnerId, screenshot, timestamp }) => {
    try {
      if (!screenshot) return;
      const other = io.sockets.sockets.get(partnerId);
      const otherIp = other
        ? other.handshake.headers["cf-connecting-ip"] || other.handshake.address
        : "Unknown";

      const img = screenshot.replace(/^data:image\/png;base64,/, "");
      const safeTime = ("" + timestamp).replace(/:/g, "-");
      const file = `${safeTime}_${partnerId}_${ip}_${otherIp}.png`;

      fs.writeFileSync(path.join(reportDir, file), img, "base64");
    } catch (e) {
      console.error(e);
    }
  });

  // AUTO BAN — Fingerprint ONLY
  socket.on("requestBan", ({ fingerprint }) => {
    if (!fingerprint) return;
    bannedFingerprints.set(fingerprint, Infinity);
    socket.emit("banConfirmed", { fingerprint });
  });

  // SKIP
  socket.on("skip", () => {
    const p = partners.get(socket.id);
    if (p) {
      const other = io.sockets.sockets.get(p);
      if (other) other.emit("partner-disconnected");
      partners.delete(p);
      partners.delete(socket.id);
    }
    waitingQueue.push(socket.id);
    socket.emit("waiting", "Looking...");
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    const idx = waitingQueue.indexOf(socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);

    const p = partners.get(socket.id);
    if (p) {
      const o = io.sockets.sockets.get(p);
      if (o) o.emit("partner-disconnected");
      partners.delete(p);
    }

    partners.delete(socket.id);
  });
});

// ==============================
// START SERVER
// ==============================
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log("Server running on port", PORT));
