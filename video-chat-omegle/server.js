/********************************************************************************************
 * FULL SERVER — MATCHMAKING + REPORT SYSTEM + SCREENSHOT CAPTURE + ADMIN PANEL + GEO + BANS
 ********************************************************************************************/

const express = require("express");
const fs = require("fs");
const path = require("path");
const basicAuth = require("express-basic-auth");
const geoip = require("geoip-lite");

const app = express();
app.set("trust proxy", true);

const http = require("http").createServer(app);
const io = require("socket.io")(http);

// ---------------- STATIC ----------------
app.use(express.static(__dirname));
app.use(express.json({ limit: "20mb" })); // لرفع الصور base64
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// ---------------- ADMIN AUTH ----------------
const adminAuth = basicAuth({
  users: { admin: "admin" },
  challenge: true,
  realm: "Admin",
});

// ---------------- CORE STORAGE ----------------
const waitingQueue = [];
const partners = new Map();
const userFingerprint = new Map();
const userIp = new Map();

// reports & bans
const reports = new Map(); // socket → Set(reporters)
const bannedIps = new Map();
const bannedFingerprints = new Map();
const screenshotMap = new Map(); // partnerId → filename

const BAN_DURATION = 24 * 60 * 60 * 1000;

// visitors
const visitors = new Map();
const visitorsHistory = [];
const countryCounts = new Map();

// ensure screenshot directory
const screenshotDir = path.join(__dirname, "screenshots");
if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);


// --------------------------------------------------------------------------------------------
//  ADMIN SNAPSHOT
// --------------------------------------------------------------------------------------------
function getAdminSnapshot() {
  const activeIpBans = [];
  const activeFpBans = [];

  for (const [ip, exp] of bannedIps) {
    if (exp > Date.now()) activeIpBans.push({
      ip,
      expires: exp,
      screenshot: screenshotMap.get(ip) || null
    });
  }

  for (const [fp, exp] of bannedFingerprints) {
    if (exp > Date.now()) activeFpBans.push({
      fp,
      expires: exp,
      screenshot: screenshotMap.get(fp) || null
    });
  }

  const reportedUsers = [];
  for (const [target, set] of reports) {
    reportedUsers.push({
      target,
      count: set.size
    });
  }

  return {
    stats: {
      connected: io.of("/").sockets.size,
      waiting: waitingQueue.length,
      paired: partners.size / 2,
      totalVisitors: visitorsHistory.length,
      countryCounts: Object.fromEntries(countryCounts)
    },
    activeIpBans,
    activeFpBans,
    reportedUsers
  };
}

function emitAdminUpdate() {
  io.emit("adminUpdate", getAdminSnapshot());
}


// --------------------------------------------------------------------------------------------
//  ADMIN PANEL PAGE (WITH IMAGES)
// --------------------------------------------------------------------------------------------
app.get("/admin", adminAuth, (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>Admin Panel</title>
<style>
body{font-family:Arial;background:#f3f3f3;padding:20px}
.card{background:#fff;padding:15px;border-radius:8px;margin-bottom:20px;box-shadow:0 2px 10px #0001}
h2{margin-top:0}
img{max-width:150px;border-radius:6px}
.banned-item{margin-bottom:12px;padding:10px;background:#fafafa;border-radius:6px}
button{padding:6px 10px;border:none;border-radius:6px;cursor:pointer;color:white;background:#28a745}
</style>
</head>
<body>

<h1>Admin Dashboard</h1>

<div class="card">
  <h2>Stats</h2>
  <div>Connected: <span id="conn">0</span></div>
  <div>Waiting: <span id="wait">0</span></div>
  <div>Paired: <span id="pair">0</span></div>
  <div>Total Visitors: <span id="vis">0</span></div>
</div>

<div class="card">
  <h2>Banned IPs</h2>
  <div id="bip"></div>
</div>

<div class="card">
  <h2>Banned Devices</h2>
  <div id="bfp"></div>
</div>

<div class="card">
  <h2>Reports</h2>
  <div id="rep"></div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
const s = io();
s.emit("admin-join");

s.on("adminUpdate", snap => {

  document.getElementById("conn").textContent = snap.stats.connected;
  document.getElementById("wait").textContent = snap.stats.waiting;
  document.getElementById("pair").textContent = snap.stats.partnered;
  document.getElementById("vis").textContent = snap.stats.totalVisitors;

  // banned IPs
  const bip = document.getElementById("bip");
  bip.innerHTML = "";
  snap.activeIpBans.forEach(b => {
    const d = document.createElement("div");
    d.className = "banned-item";
    d.innerHTML = \`
      <b>\${b.ip}</b><br>
      Expires: \${new Date(b.expires).toLocaleString()}<br>
      \${b.screenshot ? '<img src="/screenshots/' + b.screenshot + '">' : '(no image)'}<br><br>
      <button onclick="fetch('/unban-ip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ip:'\${b.ip}'})})">Unban</button>
    \`;
    bip.appendChild(d);
  });

  // banned devices
  const bfp = document.getElementById("bfp");
  bfp.innerHTML = "";
  snap.activeFpBans.forEach(b => {
    const d = document.createElement("div");
    d.className = "banned-item";
    d.innerHTML = \`
      <b>\${b.fp}</b><br>
      Expires: \${new Date(b.expires).toLocaleString()}<br>
      \${b.screenshot ? '<img src="/screenshots/' + b.screenshot + '">' : '(no image)'}<br><br>
      <button onclick="fetch('/unban-fingerprint',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fp:'\${b.fp}'})})">Unban</button>
    \`;
    bfp.appendChild(d);
  });

  // reports
  const rep = document.getElementById("rep");
  rep.innerHTML = "";
  snap.reportedUsers.forEach(r => {
    const d = document.createElement("div");
    d.className = "banned-item";
    d.textContent = r.target + " — " + r.count + " reports";
    rep.appendChild(d);
  });

});
</script>

</body>
</html>
  `);
});


// ------------------------ UNBAN API ------------------------
app.post("/unban-ip", adminAuth, (req, res) => {
  const { ip } = req.body;
  bannedIps.delete(ip);
  emitAdminUpdate();
  res.send({ ok: true });
});

app.post("/unban-fingerprint", adminAuth, (req, res) => {
  const { fp } = req.body;
  bannedFingerprints.delete(fp);
  emitAdminUpdate();
  res.send({ ok: true });
});


// ------------------------ SOCKET.IO ------------------------
io.on("connection", (socket) => {

  const ip =
    socket.handshake.headers["cf-connecting-ip"] ||
    socket.handshake.address ||
    "unknown";

  userIp.set(socket.id, ip);

  // GEO
  let country = null;
  const g = geoip.lookup(ip);
  if (g) country = g.country;

  visitors.set(socket.id, { ip, country, ts: Date.now() });
  visitorsHistory.push({ ip, country, ts: Date.now() });

  // -------- BAN CHECK --------
  if (bannedIps.has(ip) && bannedIps.get(ip) > Date.now()) {
    socket.emit("banned", { message: "IP banned" });
    socket.disconnect();
    return;
  }

  // fingerprint check
  socket.on("identify", ({ fingerprint }) => {
    userFingerprint.set(socket.id, fingerprint);

    if (bannedFingerprints.has(fingerprint) &&
        bannedFingerprints.get(fingerprint) > Date.now()) {
      socket.emit("banned", { message: "Device banned" });
      socket.disconnect();
      return;
    }

    emitAdminUpdate();
  });

  emitAdminUpdate();


  // --------------------------------------------------------------------------------------------
  // MATCHMAKING
  // --------------------------------------------------------------------------------------------
  socket.on("find-partner", () => {
    if (!waitingQueue.includes(socket.id)) waitingQueue.push(socket.id);
    match();
    emitAdminUpdate();
  });

  function match() {
    while (waitingQueue.length >= 2) {
      const a = waitingQueue.shift();
      const b = waitingQueue.shift();

      if (!io.sockets.sockets.get(a) || !io.sockets.sockets.get(b)) continue;

      partners.set(a, b);
      partners.set(b, a);

      io.to(a).emit("partner-found", { id: b, initiator: true });
      io.to(b).emit("partner-found", { id: a, initiator: false });
    }
  }


  // --------------------------------------------------------------------------------------------
  //  SIGNAL RELAY
  // --------------------------------------------------------------------------------------------
  socket.on("signal", ({ to, data }) => {
    const t = io.sockets.sockets.get(to);
    if (t) t.emit("signal", { from: socket.id, data });
  });


  // --------------------------------------------------------------------------------------------
  // CHAT
  // --------------------------------------------------------------------------------------------
  socket.on("chat-message", ({ to, message }) => {
    const t = io.sockets.sockets.get(to);
    if (t) t.emit("chat-message", { message });
  });


  // --------------------------------------------------------------------------------------------
  // REPORT SYSTEM + SCREENSHOT TRIGGER
  // --------------------------------------------------------------------------------------------
  socket.on("report", ({ partnerId }) => {
    if (!partnerId) return;

    if (!reports.has(partnerId)) reports.set(partnerId, new Set());
    reports.get(partnerId).add(socket.id);

    const count = reports.get(partnerId).size;

    if (count >= 3) {
      const target = io.sockets.sockets.get(partnerId);

      // اطلب من العميل التقاط صورة
      if (target) {
        target.emit("capture-request");
      }

      // ban logic
      const ip = userIp.get(partnerId);
      const fp = userFingerprint.get(partnerId);

      bannedIps.set(ip, Date.now() + BAN_DURATION);
      bannedFingerprints.set(fp, Date.now() + BAN_DURATION);

      if (target) {
        target.emit("banned", { message: "You are banned for repeated reports." });
        target.disconnect();
      }
    }

    emitAdminUpdate();
  });


  // --------------------------------------------------------------------------------------------
  //  RECEIVE SCREENSHOT FROM CLIENT
  // --------------------------------------------------------------------------------------------
  socket.on("screenshot-upload", ({ base64 }) => {
    if (!base64) return;

    const ip = userIp.get(socket.id);
    const fp = userFingerprint.get(socket.id);

    const filename = socket.id + "-" + Date.now() + ".png";
    const filepath = path.join(screenshotDir, filename);

    const data = base64.replace(/^data:image\/png;base64,/, "");
    fs.writeFileSync(filepath, data, "base64");

    // store screenshot for bans
    if (ip) screenshotMap.set(ip, filename);
    if (fp) screenshotMap.set(fp, filename);

    emitAdminUpdate();
  });


  // --------------------------------------------------------------------------------------------
  // DISCONNECT
  // --------------------------------------------------------------------------------------------
  socket.on("disconnect", () => {
    const p = partners.get(socket.id);
    if (p) {
      const other = io.sockets.sockets.get(p);
      if (other) other.emit("partner-disconnected");
      partners.delete(p);
      partners.delete(socket.id);
    }

    const idx = waitingQueue.indexOf(socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);

    emitAdminUpdate();
  });

});


// ------------------ START ------------------
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log("SERVER RUNNING ON PORT", PORT));
