// ==============================================================
// SERVER.JS — REPORT SYSTEM + ACTIVE BAN LIST + ADMIN PANEL
// ==============================================================

const express = require("express");
const path = require("path");
const fs = require("fs");
const basicAuth = require("express-basic-auth");

const app = express();
app.set("trust proxy", true);

const http = require("http").createServer(app);
const io = require("socket.io")(http);

// ==============================================================
// STATIC
// ==============================================================
app.use(express.static(__dirname));
app.use(express.urlencoded({ extended: true }));

// ==============================================================
// ADMIN LOGIN
// ==============================================================
const adminAuth = basicAuth({
  users: { admin: "admin" },
  challenge: true,
  realm: "Admin Panel",
});

// ==============================================================
// MATCHMAKING DATA
// ==============================================================
const waitingQueue = [];
const partners = new Map(); // socket.id → partner.id

// ==============================================================
// BAN + REPORT DATA
// ==============================================================
const bannedIps = new Map();           // ip → expiryTime
const bannedFingerprints = new Map();  // fp → expiryTime

const reports = new Map();  // targetId → Set(reporters)
                            // نسجل السوكيتات المبلّغة لمنع التكرار

const userFingerprint = new Map();     // socket.id → fp
const userIp = new Map();              // socket.id → ip

const BAN_DURATION = 24 * 60 * 60 * 1000; // 24 ساعة

// ==============================================================
// HELPER FUNCTIONS
// ==============================================================

// حظر المستخدم (يشمل IP + Fingerprint)
function banUser(ip, fp) {
  const expiry = Date.now() + BAN_DURATION;
  bannedIps.set(ip, expiry);
  if (fp) bannedFingerprints.set(fp, expiry);
}

// إزالة الحظر
function unbanUser(ip, fp) {
  if (ip) bannedIps.delete(ip);
  if (fp) bannedFingerprints.delete(fp);
}

// ==============================================================
// ADMIN PANEL — CLEAN & ORGANIZED
// ==============================================================
app.get("/admin", adminAuth, (req, res) => {

  let bannedHTML = "";
  for (const [ip, exp] of bannedIps) {
    if (exp > Date.now()) {
      bannedHTML += `
        <div>
          <b>IP:</b> ${ip} — expires: ${new Date(exp).toLocaleString()}
          <form method="POST" action="/unban-ip" style="display:inline">
            <input type="hidden" name="ip" value="${ip}">
            <button class="unban-btn">Unban</button>
          </form>
        </div><hr>`;
    }
  }

  let fingerprintHTML = "";
  for (const [fp, exp] of bannedFingerprints) {
    if (exp > Date.now()) {
      fingerprintHTML += `
        <div>
          <b>Device:</b> ${fp} — expires: ${new Date(exp).toLocaleString()}
          <form method="POST" action="/unban-fingerprint" style="display:inline">
            <input type="hidden" name="fp" value="${fp}">
            <button class="unban-btn">Unban</button>
          </form>
        </div><hr>`;
    }
  }

  let reportsHTML = "";
  for (const [target, reporters] of reports.entries()) {
    reportsHTML += `
      <div>
        <b>User ID:</b> ${target}  
        <b>Reports:</b> ${reporters.size}
      </div><hr>`;
  }

  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
    <title>Admin Panel</title>
    <style>
      body { font-family:Arial; padding:20px; background:#f5f5f5; }
      .section { background:#fff; padding:15px; margin-bottom:20px; border-radius:6px; }
      textarea { width:300px; }
      button { padding:6px 10px; border:none; cursor:pointer; color:#fff; }
      .unban-btn { background:#28a745; }
      .broadcast-btn { background:#007bff; }
    </style>
  </head>

  <body>
    <h1>Admin Panel</h1>

    <div class="section">
      <h2>Broadcast Message</h2>
      <form method="POST" action="/admin-broadcast">
        <textarea name="message" rows="3"></textarea><br><br>
        <button class="broadcast-btn">Send</button>
      </form>
    </div>

    <div class="section">
      <h2>Active Bans (IP)</h2>
      ${bannedHTML || "No active IP bans"}
    </div>

    <div class="section">
      <h2>Active Device Bans (Fingerprint)</h2>
      ${fingerprintHTML || "No active device bans"}
    </div>

    <div class="section">
      <h2>Reported Users</h2>
      ${reportsHTML || "No reported users yet"}
    </div>

  </body>
  </html>
  `);
});

// ==============================================================
// ADMIN ACTIONS
// ==============================================================
app.post("/admin-broadcast", adminAuth, (req, res) => {
  if (req.body.message?.trim()) {
    io.emit("adminMessage", req.body.message.trim());
  }
  res.redirect("/admin");
});

app.post("/unban-ip", adminAuth, (req, res) => {
  bannedIps.delete(req.body.ip);
  res.redirect("/admin");
});

app.post("/unban-fingerprint", adminAuth, (req, res) => {
  bannedFingerprints.delete(req.body.fp);
  res.redirect("/admin");
});

// ==============================================================
// SOCKET HANDLING
// ==============================================================
io.on("connection", (socket) => {

  // ------------------ IDENTIFY IP ------------------
  const ip =
    socket.handshake.headers["cf-connecting-ip"] ||
    socket.handshake.address;

  userIp.set(socket.id, ip);

  // Ban check (IP)
  const banExpire = bannedIps.get(ip);
  if (banExpire && banExpire > Date.now()) {
    socket.emit("banned", { message: "You are banned." });
    socket.disconnect();
    return;
  }

  // ------------------ IDENTIFY FINGERPRINT ------------------
  socket.on("identify", ({ fingerprint }) => {
    userFingerprint.set(socket.id, fingerprint);

    const fpBan = bannedFingerprints.get(fingerprint);
    if (fpBan && fpBan > Date.now()) {
      socket.emit("banned", { message: "Your device is banned." });
      socket.disconnect();
    }
  });

  // ------------------ MATCHMAKING ------------------
  socket.on("find-partner", () => {
    if (partners.has(socket.id)) return;
    if (!waitingQueue.includes(socket.id)) waitingQueue.push(socket.id);

    if (waitingQueue.length >= 2) {
      const a = waitingQueue.shift();
      const b = waitingQueue.shift();

      partners.set(a, b);
      partners.set(b, a);

      io.to(a).emit("partner-found", { id: b, initiator: true });
      io.to(b).emit("partner-found", { id: a, initiator: false });
    }
  });

  // ------------------ REPORT SYSTEM ------------------
  socket.on("report", ({ partnerId }) => {
    if (!partnerId) return;

    if (!reports.has(partnerId)) reports.set(partnerId, new Set());

    const reporterSet = reports.get(partnerId);

    // لمنع التبليغ مرتين من نفس المستخدم
    reporterSet.add(socket.id);

    // إذا وصل عدد البلاغات ≥ 3 يتم الحظر
    if (reporterSet.size >= 3) {
      const targetSocket = io.sockets.sockets.get(partnerId);

      if (targetSocket) {
        const targetIp = userIp.get(partnerId);
        const targetFp = userFingerprint.get(partnerId);

        banUser(targetIp, targetFp);

        targetSocket.emit("banned", { message: "You have been banned for 24h due to multiple reports." });
        targetSocket.disconnect();
      }
    }
  });

  // ------------------ RELAY ------------------
  socket.on("signal", ({ to, data }) => {
    const t = io.sockets.sockets.get(to);
    if (t) t.emit("signal", { from: socket.id, data });
  });

  socket.on("chat-message", ({ to, message }) => {
    const t = io.sockets.sockets.get(to);
    if (t) t.emit("chat-message", { message });
  });

  // ------------------ SKIP ------------------
  socket.on("skip", () => {
    const p = partners.get(socket.id);
    if (p) {
      const other = io.sockets.sockets.get(p);
      if (other) other.emit("partner-disconnected");
      partners.delete(p);
      partners.delete(socket.id);
    }

    if (!waitingQueue.includes(socket.id)) waitingQueue.push(socket.id);
  });

  // ------------------ DISCONNECT ------------------
  socket.on("disconnect", () => {
    const idx = waitingQueue.indexOf(socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);

    const p = partners.get(socket.id);
    if (p) {
      const other = io.sockets.sockets.get(p);
      if (other) other.emit("partner-disconnected");
      partners.delete(p);
    }

    partners.delete(socket.id);
    reports.delete(socket.id);
    userFingerprint.delete(socket.id);
    userIp.delete(socket.id);
  });

});

// ==============================================================
// START SERVER
// ==============================================================
http.listen(3000, () => console.log("Server running on port 3000"));
