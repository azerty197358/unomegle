// ==============================
// FULL SERVER — ADMIN PANEL + MESSAGING + AUTO BAN (IP + FINGERPRINT)
// RESTORED + CLEAN + COMPLETE
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
const adminAuth = basicAuth({
  users: { admin: "admin" },
  challenge: true,
  realm: "Admin Area",
});

// MATCHMAKING
const waitingQueue = [];
const partners = new Map();

// BANS (IP + FINGERPRINT)
const bannedIps = new Map();
const bannedFingerprints = new Map();

// ==============================
// ADMIN PANEL (RESTORED)
// ==============================
app.get("/admin", adminAuth, (req, res) => {
  const files = fs.readdirSync(reportDir);

  let html = `<!DOCTYPE html><html><head><meta charset='utf-8'><title>Admin Panel</title>
    <style>
      body{font-family:Arial;background:#f5f5f5;padding:20px;}
      img{max-width:450px;border:1px solid #ccc;margin-bottom:10px;}
      .report{background:#fff;padding:15px;margin-bottom:20px;border-radius:8px;}
      button{padding:6px 10px;border:none;color:#fff;cursor:pointer;}
      .ban-btn{background:#d00;}
      .unban-btn{background:#28a745;}
    </style></head><body>`;

  html += `<h1>Reports</h1>`;

  const reports = [];
  for (const file of files) {
    if (!file.endsWith('.png')) continue;
    const p = file.replace('.png','').split('_');
    if (p.length < 4) continue;
    const [ts, partnerId, reporterIp, reportedIp] = p;
    reports.push({ file, ts, partnerId, reporterIp, reportedIp });
  }

  for (const r of reports) {
    html += `<div class='report'>
      <img src='/reports/${r.file}'>
      <p><b>Reported IP:</b> ${r.reportedIp}</p>
      <form method='POST' action='/ban'>
        <input type='hidden' name='ip' value='${r.reportedIp}'>
        <select name='duration'>
          <option value='24h'>24h</option>
          <option value='permanent'>Permanent</option>
        </select>
        <button class='ban-btn'>Ban IP</button>
      </form>
    </div>`;
  }

  html += `<h2>Banned IPs</h2>`;
  for (const [ip, exp] of bannedIps) {
    if (exp === Infinity || exp > Date.now()) {
      html += `<p>${ip} — ${exp === Infinity ? 'Permanent' : new Date(exp)}</p>`;
    }
  }

  html += `<h2>Banned Fingerprints</h2>`;
  for (const [fp, exp] of bannedFingerprints) {
    if (exp === Infinity || exp > Date.now()) {
      html += `<p>${fp} — ${exp === Infinity ? 'Permanent' : new Date(exp)}</p>`;
    }
  }

  // Admin broadcast
  html += `
    <h2>Broadcast Message</h2>
    <form method='POST' action='/admin-broadcast'>
      <textarea name='message' rows='3' style='width:300px'></textarea><br><br>
      <button style='background:#28a745;padding:10px 14px;'>Send</button>
    </form>
  `;

  html += `</body></html>`;
  res.send(html);
});

// ===============================
// ADMIN BROADCAST RESTORED
// ===============================
app.post('/admin-broadcast', adminAuth, (req, res) => {
  const msg = req.body.message;
  if (!msg || msg.trim()==='') return res.send('Empty');
  io.emit('adminMessage', msg.trim());
  res.redirect('/admin');
});

// BAN ROUTE (IP)
app.post('/ban', adminAuth, (req, res) => {
  const ip = req.body.ip;
  const d = req.body.duration;
  if (!ip) return res.send('Invalid');
  bannedIps.set(ip, d==='24h' ? Date.now()+86400000 : Infinity);
  res.redirect('/admin');
});

// ==============================
// SOCKET HANDLING
// ==============================
io.on('connection', (socket) => {
  const ip = socket.handshake.headers['cf-connecting-ip'] || socket.handshake.address;

  // IP Ban
  const ipBan = bannedIps.get(ip);
  if (ipBan && (ipBan === Infinity || ipBan > Date.now())) {
    socket.emit('banned', { message: 'You are banned by IP.' });
    socket.disconnect();
    return;
  }

  // ------------------------------
  // DEVICE IDENTIFY
  // ------------------------------
  socket.on('identify', ({ fingerprint }) => {
    const fpBan = bannedFingerprints.get(fingerprint);
    if (fpBan && (fpBan === Infinity || fpBan > Date.now())) {
      socket.emit('banConfirmed', { fingerprint });
      socket.disconnect();
    }
  });

  // ------------------------------
  // FIND PARTNER
  // ------------------------------
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

  // ------------------------------
  // SIGNAL
  // ------------------------------
  socket.on('signal', ({ to, data }) => {
    const t = io.sockets.sockets.get(to);
    if (t) t.emit('signal', { from: socket.id, data });
  });

  // ------------------------------
  // MESSAGE RELAY (RESTORED)
  // ------------------------------
  socket.on('chat-message', ({ to, message }) => {
    const t = io.sockets.sockets.get(to);
    if (t) t.emit('chat-message', { from: socket.id, message });
  });

  // ------------------------------
  // SAVE REPORT
  // ------------------------------
  socket.on('reportPorn', ({ partnerId, screenshot, timestamp, fingerprint }) => {
    try {
      const other = io.sockets.sockets.get(partnerId);
      const otherIp = other ? (other.handshake.headers['cf-connecting-ip'] || other.handshake.address) : 'Unknown';
      const img = screenshot.replace(/^data:image\/png;base64,/, "");
      const safeTime = ('' + timestamp).replace(/:/g, '-');
      const file = `${safeTime}_${partnerId}_${ip}_${otherIp}.png`;
      fs.writeFileSync(path.join(reportDir, file), img, 'base64');
    } catch (e) {}
  });

  // ------------------------------
  // AUTO BAN (IP + FINGERPRINT)
  // ------------------------------
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

  // ------------------------------
  // SKIP
  // ------------------------------
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

  // ------------------------------
  // DISCONNECT
  // ------------------------------
  socket.on('disconnect', () => {
    const i = waitingQueue.indexOf(socket.id);
    if (i !== -1) waitingQueue.splice(i, 1);

    const p = partners.get(socket.id);
    if (p) {
      const other = io.sockets.sockets.get(p);
      if (other) other.emit('partner-disconnected');
      partners.delete(p);
    }

    partners.delete(socket.id);
  });
});

// ==============================
// START SERVER
// ==============================
http.listen(3000, () => console.log("Server running on port 3000"));
