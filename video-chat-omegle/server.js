const express = require("express");
const path = require("path");
const fs = require("fs");
const basicAuth = require('express-basic-auth');

const app = express();
app.set('trust proxy', true);

const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static(__dirname));

const reportDir = path.join(__dirname, 'reports');
if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir);

app.use('/reports', express.static(reportDir));

app.use(express.urlencoded({ extended: true }));

const getUnauthorizedResponse = (req) => {
  return req.auth
    ? ('Credentials ' + req.auth.user + ':' + req.auth.password + ' rejected')
    : 'No credentials provided';
};

const adminAuth = basicAuth({
  users: { 'admin': 'admin' },
  challenge: true,
  realm: 'Admin Area',
  unauthorizedResponse: getUnauthorizedResponse
});

const waitingQueue = [];
const partners = new Map();
const bannedIps = new Map();


// ============================================
//              ADMIN PANEL
// ============================================
app.get('/admin', adminAuth, (req, res) => {
  try {
    const files = fs.readdirSync(reportDir);
    let html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
      <meta charset="UTF-8">
      <title>Admin Panel</title>
      <style>
        body { font-family:Arial; padding:20px; background:#f5f5f5; }
        img { max-width:450px; border:1px solid #ccc; display:block; margin-bottom:10px; }
        .report { background:#fff; padding:15px; border-radius:8px; margin-bottom:20px; }
        button { padding:6px 10px; border:none; color:white; cursor:pointer; }
        .ban-btn { background:#d00; }
        .unban-btn { background:#28a745; }
      </style>
      </head>
      <body>
      <h1>Reports</h1>

      <h2>Broadcast Message</h2>
      <form method="POST" action="/admin-broadcast">
        <textarea name="message" rows="3" style="width:300px"></textarea><br><br>
        <button type="submit" style="background:#28a745;padding:10px 14px;color:#fff;">Send</button>
      </form>
    `;

    let validReports = [];

    for (const file of files) {
      if (!file.endsWith(".png")) continue;

      const parts = file.replace(".png", "").split("_");
      if (parts.length !== 4) continue;

      const [timestamp, partnerId, reporterIp, reportedIp] = parts;

      const banExpire = bannedIps.get(reportedIp);

      // Skip expired bans & delete files
      if (banExpire && banExpire <= Date.now()) {
        fs.unlinkSync(path.join(reportDir, file));
        bannedIps.delete(reportedIp);
        continue;
      }

      validReports.push({
        file,
        timestamp,
        partnerId,
        reporterIp,
        reportedIp,
        banExpire
      });
    }

    if (validReports.length === 0) {
      html += `<p>No reports.</p>`;
    } else {
      for (const r of validReports) {
        html += `
          <div class="report">
            <img src="/reports/${r.file}">
            <p><b>Timestamp:</b> ${r.timestamp}</p>
            <p><b>Partner ID:</b> ${r.partnerId}</p>
            <p><b>Reporter IP:</b> ${r.reporterIp}</p>
            <p><b>Reported IP:</b> ${r.reportedIp}</p>
        `;

        if (r.banExpire) {
          const expStr =
            r.banExpire === Infinity
              ? "Permanent"
              : new Date(r.banExpire).toLocaleString();

          html += `
            <p><b>Ban Expires:</b> ${expStr}</p>
            <form method="POST" action="/unban">
              <input type="hidden" name="ip" value="${r.reportedIp}">
              <button class="unban-btn">Unban</button>
            </form>
          `;
        } else {
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
        }

        html += `</div>`;
      }
    }

    // BANNED IP LIST
    html += `<h2>Banned IPs</h2>`;
    let hasBanned = false;

    for (const [ip, exp] of bannedIps) {
      if (exp === Infinity || exp > Date.now()) {
        hasBanned = true;
        const show =
          exp === Infinity ? "Permanent" : new Date(exp).toLocaleString();

        html += `
          <p><b>${ip}</b> — ${show}</p>
          <form method="POST" action="/unban">
            <input type="hidden" name="ip" value="${ip}">
            <button class="unban-btn">Unban</button>
          </form>
          <hr>
        `;
      }
    }

    if (!hasBanned) html += `<p>No banned IPs.</p>`;

    html += `</body></html>`;
    res.send(html);

  } catch (err) {
    console.error(err);
    res.status(500).send("Admin page error.");
  }
});


// =====================
//  BROADCAST SYSTEM
// =====================
app.post('/admin-broadcast', adminAuth, (req, res) => {
  const msg = req.body.message;

  if (!msg || msg.trim() === "") return res.send("Empty message.");

  io.emit("adminMessage", msg.trim());
  console.log("Admin broadcast:", msg);

  res.redirect("/admin");
});
// =====================
//  BAN / UNBAN
// =====================
app.post("/ban", adminAuth, (req, res) => {
  const ip = req.body.ip;
  const duration = req.body.duration;

  if (!ip) return res.send("Invalid IP.");

  let expire;
  if (duration === "24h") {
    expire = Date.now() + 24 * 60 * 60 * 1000;
  } else {
    expire = Infinity;
  }

  bannedIps.set(ip, expire);
  res.redirect("/admin");
});

app.post("/unban", adminAuth, (req, res) => {
  const ip = req.body.ip;
  if (bannedIps.has(ip)) bannedIps.delete(ip);
  res.redirect("/admin");
});


// ======================================
//             SOCKET.IO
// ======================================
io.on("connection", (socket) => {

  const clientIp =
    socket.handshake.headers['cf-connecting-ip'] ||
    (socket.handshake.headers['x-forwarded-for']
      ? socket.handshake.headers['x-forwarded-for'].split(",")[0].trim()
      : socket.handshake.address);

  const banExpire = bannedIps.get(clientIp);
  if (banExpire && (banExpire === Infinity || banExpire > Date.now())) {
    socket.emit("banned", {
      message:
        banExpire === Infinity
          ? "You are permanently banned."
          : "You are banned for 24 hours."
    });
    socket.disconnect();
    return;
  }

  console.log("Connected:", socket.id, "IP:", clientIp);


  // Find partner
  socket.on("find-partner", () => {
    if (partners.has(socket.id)) return;
    if (waitingQueue.includes(socket.id)) return;

    if (waitingQueue.length > 0) {
      const otherId = waitingQueue.shift();
      const otherSocket = io.sockets.sockets.get(otherId);

      if (!otherSocket) {
        waitingQueue.push(socket.id);
        socket.emit("waiting", "Looking...");
        return;
      }

      partners.set(socket.id, otherId);
      partners.set(otherId, socket.id);

      socket.emit("partner-found", { id: otherId, initiator: true });
      otherSocket.emit("partner-found", { id: socket.id, initiator: false });

    } else {
      waitingQueue.push(socket.id);
      socket.emit("waiting", "Looking...");
    }
  });


  // WebRTC Signals
  socket.on("signal", ({ to, data }) => {
    const target = io.sockets.sockets.get(to);
    if (target) target.emit("signal", { from: socket.id, data });
  });


  // Chat messages
  socket.on("chat-message", ({ to, message }) => {
    const target = io.sockets.sockets.get(to);
    if (target) target.emit("chat-message", { from: socket.id, message });
  });


  // REPORT PORN
  socket.on("reportPorn", ({ screenshot, timestamp, partnerId }) => {
    if (!screenshot || !timestamp || !partnerId) return;

    const reported = io.sockets.sockets.get(partnerId);

    const reportedIp = reported
      ? (reported.handshake.headers["cf-connecting-ip"] ||
          reported.handshake.headers["x-forwarded-for"] ||
          reported.handshake.address)
      : "Unknown";

    const reporterIp = clientIp;

    if (reportedIp === "Unknown") {
      socket.emit("reportHandled", { message: "Cannot identify user." });
      return;
    }

    try {
      const img = screenshot.replace(/^data:image\/png;base64,/, "");
      const safeTime = timestamp.replace(/:/g, "-");

      const file = `${safeTime}_${partnerId}_${reporterIp}_${reportedIp}.png`;
      fs.writeFileSync(path.join(reportDir, file), img, "base64");

      socket.emit("reportHandled", {
        message: "Report submitted. Skipping..."
      });

      // Disconnect partner
      const other = io.sockets.sockets.get(partnerId);
      if (other) other.emit("partner-disconnected", { reason: "reported" });

      partners.delete(partnerId);
      partners.delete(socket.id);

      waitingQueue.push(socket.id);
      socket.emit("waiting", "Looking...");

    } catch (err) {
      console.error(err);
    }
  });


  // Skip
  socket.on("skip", () => {
    const partnerId = partners.get(socket.id);
    if (partnerId) {
      const other = io.sockets.sockets.get(partnerId);
      if (other) other.emit("partner-disconnected", { reason: "skipped" });
      partners.delete(partnerId);
      partners.delete(socket.id);
    }

    waitingQueue.push(socket.id);
    socket.emit("waiting", "Looking...");
  });


  // Disconnect
  socket.on("disconnect", () => {
    const idx = waitingQueue.indexOf(socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);

    const partnerId = partners.get(socket.id);
    if (partnerId) {
      const other = io.sockets.sockets.get(partnerId);
      if (other) other.emit("partner-disconnected", { reason: "peer-left" });
      partners.delete(partnerId);
    }

    partners.delete(socket.id);

    console.log("Disconnected:", socket.id);
  });

});


const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log("Server running on port", PORT));
