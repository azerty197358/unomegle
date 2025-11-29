// ==============================================
// FULL SERVER — AUTO BAN (IP + Fingerprint Only)
// CLEAN ADMIN PANEL + BROADCAST + UNBAN SYSTEM
// NO MANUAL REPORTING — AUTO-DETECTION ONLY
// ==============================================

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

// ==========================
// ADMIN AUTH
// ==========================
const adminAuth = basicAuth({
  users: { admin: "admin" },
  challenge: true,
  realm: "Admin Area",
});

// ==========================
// MATCHMAKING
// ==========================
const waitingQueue = [];
const partners = new Map();

// ==========================
// BAN LISTS (IP + Fingerprint)
// ==========================
const bannedIps = new Map();
const bannedFingerprints = new Map();

// ==============================================
// ADMIN PANEL — CLEAN / NO REPORTS PAGE
// ==============================================
app.get("/admin", adminAuth, (req, res) => {
  let html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8" />
    <title>Admin Panel</title>
    <style>
      body { font-family: Arial; background: #f5f5f5; padding: 20px; }
      button { padding: 6px 10px; border: none; color: #fff; cursor: pointer; }
      .ban-btn { background: #d00; }
      .unban-btn { background: #28a745; }
      textarea { width: 300px; }
      .section { background:#fff; padding:15px; margin-bottom:20px; border-radius:6px; }
    </style>
  </head>
  <body>
    <h1>Admin Panel</h1>

    <div class="section">
      <h2>Broadcast Message</h2>
      <form method="POST" action="/admin-broadcast">
        <textarea name="message" rows="3"></textarea><br><br>
        <button style="background:#28a745;padding:10px 14px">Send</button>
      </form>
    </div>

    <div class="section">
      <h2>Banned IPs</h2>`;

  for (const [ip, exp] of bannedIps) {
    if (exp === Infinity || exp > Date.now()) {
      html += `<p><b>${ip}</b> — ${exp === Infinity ? "Permanent" : new Date(exp).toLocaleString()}</p>`;
      html += `
      <form method='POST' action='/unban-ip'>
        <input type='hidden' name='ip' value='${ip}'>
        <button class='unban-btn'>Unban IP</button>
      </form><hr>`;
    }
  }

  html += `</div>

    <div class="section">
      <h2>Banned Devices (Fingerprints)</h2>`;

  for (const [fp, exp] of bannedFingerprints) {
    if (exp === Infinity || exp > Date.now()) {
      html += `<p><b>${fp}</b> — ${exp === Infinity ? "Permanent" : new Date(exp).toLocaleString()}</p>`;
      html += `
      <form method='POST' action='/unban-fingerprint'>
        <input type='hidden' name='fp' value='${fp}'>
        <button class='unban-btn'>Unban Device</button>
      </form><hr>`;
    }
  }

  html += `</div></body></html>`;

  res.send(html);
});

// ==============================================
// ADMIN ACTIONS
// ==============================================
app.post('/admin-broadcast', adminAuth, (req, res) => {
  const msg = req.body.message;
  if (!msg || msg.trim() === '') return res.send('Empty');
  io.emit('adminMessage', msg.trim());
  res.redirect('/admin');
});

app.post('/unban-ip', adminAuth, (req, res) => {
  const ip = req.body.ip;
  bannedIps.delete(ip);
  res.redirect('/admin');
});

app.post('/unban-fingerprint', adminAuth, (req, res) => {
  const fp = req.body.fp;
  bannedFingerprints.delete(fp);
  res.redirect('/admin');
});

// ==============================================
// SOCKET HANDLING
// ==============================================
io.on('connection', (socket) => {
  const ip = socket.handshake.headers['cf-connecting-ip'] || socket.handshake.address;

  // IP Ban Check
  const ipBan = bannedIps.get(ip);
  if (ipBan && (ipBan === Infinity || ipBan > Date.now())) {
    socket.emit('banned', { message: 'You are banned (IP).' });
    socket.disconnect();
    return;
  }

  // Identify device
  socket.on('identify', ({ fingerprint }) => {
    const fpBan = bannedFingerprints.get(fingerprint);
    if (fpBan && (fpBan === Infinity || fpBan > Date.now())) {
      socket.emit('banConfirmed', { fingerprint });
      socket.disconnect();
    }
  });

  // Find partner
  socket.on('find-partner', () => {
    if (partners.has(socket.id)) return;
    if (waitingQueue.includes(socket.id)) return;

    if (waitingQueue.length > 0) {
      const other = waitingQueue.shift();
      partners.set(socket.id, other);
      partners.set(other, socket.id);

      socket.emit('partner-found', { id: other, initiator: true });
      io.to(other).emit('partner-found', { id: socket.id, initiator: false });
    } else {
      waitingQueue.push(socket.id);
      socket.emit('waiting', 'Looking...');
    }
  });

  // WebRTC relay
  socket.on('signal', ({ to, data }) => {
    const t = io.sockets.sockets.get(to);
    if (t) t.emit('signal', { from: socket.id, data });
  });

  // Chat
  socket.on('chat-message', ({ to, message }) => {
    const t = io.sockets.sockets.get(to);
    if (t) t.emit('chat-message', { from: socket.id, message });
  });

  // AUTO BAN (IP + fingerprint)
  socket.on('requestBan', ({ partnerId, fingerprint }) => {
    if (fingerprint) bannedFingerprints.set(fingerprint, Infinity);

    const other = io.sockets.sockets.get(partnerId);
    if (other) {
      const otherIp = other.handshake.headers['cf-connecting-ip'] || other.handshake.address;
      bannedIps.set(otherIp, Infinity);
      other.emit('banned', { message: 'Auto-ban applied.' });
      other.disconnect();
    }
  });

  // Skip
  socket.on('skip', () => {
    const p = partners.get(socket.id);
    if (p) {
      const other = io.sockets.sockets.get(p);
      if (other) other.emit('partner-disconnected');
      partners.delete(p);
      partners.delete(socket.id);
    }
    waitingQueue.push(socket.id);
    socket.emit('waiting', 'Looking...');
  });

  // Disconnect
  socket.on('disconnect', () => {
    const idx = waitingQueue.indexOf(socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);

    const p = partners.get(socket.id);
    if (p) {
      const other = io.sockets.sockets.get(p);
      if (other) other.emit('partner-disconnected');
      partners.delete(p);
    }

    partners.delete(socket.id);
  });
});

// ==============================================
// START SERVER
// ==============================================
http.listen(3000, () => console.log("Server running on port 3000"));
