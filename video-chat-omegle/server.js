// File: server.js
// FULL SERVER — REPORT SYSTEM + LIVE ADMIN PANEL + VISITORS + GEO
// Minimal critical comments only.

const express = require("express");
const path = require("path");
const fs = require("fs");
const basicAuth = require("express-basic-auth");
const geoip = require("geoip-lite");

const app = express();
app.set("trust proxy", true);

const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static(__dirname));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const adminAuth = basicAuth({
  users: { admin: "admin" },
  challenge: true,
  realm: "Admin Area",
});

// core data
const waitingQueue = [];
const partners = new Map(); // socket.id -> partnerId
const userFingerprint = new Map(); // socket.id -> fingerprint
const userIp = new Map(); // socket.id -> ip

// bans/reports
const bannedIps = new Map(); // ip -> expiry
const bannedFingerprints = new Map(); // fp -> expiry
const reports = new Map(); // targetId -> Set(reporterSocketId)
const reportScreenshots = new Map(); // targetId -> Base64 image (memory)
const BAN_DURATION = 24 * 60 * 60 * 1000; // 24h

// visitors tracking (historical)
const visitors = new Map(); // socketId -> { ip, fp, country, ts }
const visitorsHistory = []; // [{ip, fp, country, ts}]
const countryCounts = new Map();

function getAdminSnapshot() {
  const activeIpBans = [];
  for (const [ip, exp] of bannedIps) {
    if (exp === Infinity || exp > Date.now()) activeIpBans.push({ ip, expires: exp });
    else bannedIps.delete(ip);
  }
  const activeFpBans = [];
  for (const [fp, exp] of bannedFingerprints) {
    if (exp === Infinity || exp > Date.now()) activeFpBans.push({ fp, expires: exp });
    else bannedFingerprints.delete(fp);
  }

  // union of reported targets and targets with screenshots so admins see screenshots even if report arrived before/after
  const allTargets = new Set([...reports.keys(), ...reportScreenshots.keys()]);
  const reportedUsers = [];
  for (const target of allTargets) {
    const reporters = reports.get(target) || new Set();
    reportedUsers.push({
      target,
      count: reporters.size,
      reporters: Array.from(reporters),
      screenshot: reportScreenshots.get(target) || null
    });
  }

  const recentVisitors = visitorsHistory.slice(-200).map(v => ({ ip: v.ip, fp: v.fp, country: v.country, ts: v.ts }));

  return {
    stats: {
      connected: io.of("/").sockets.size,
      waiting: waitingQueue.length,
      partnered: partners.size / 2,
      totalVisitors: visitorsHistory.length,
      countryCounts: Object.fromEntries(countryCounts),
    },
    activeIpBans,
    activeFpBans,
    reportedUsers,
    recentVisitors,
  };
}

function emitAdminUpdate() {
  const snap = getAdminSnapshot();
  io.of("/").emit("adminUpdate", snap);
}

function banUser(ip, fp) {
  const expiry = Date.now() + BAN_DURATION;
  if (ip) bannedIps.set(ip, expiry);
  if (fp) bannedFingerprints.set(fp, expiry);
}

function unbanUser(ip, fp) {
  if (ip) bannedIps.delete(ip);
  if (fp) bannedFingerprints.delete(fp);
  emitAdminUpdate();
}

// admin page
app.get("/admin", adminAuth, (req, res) => {
  res.send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Admin Panel — Live</title>
<style>
  body{font-family:Arial;padding:16px;background:#f7f7f7}
  .row{display:flex;gap:16px;align-items:flex-start}
  .card{background:#fff;padding:12px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.05);flex:1}
  .small{font-size:13px;color:#666}
  table{width:100%;border-collapse:collapse}
  th,td{padding:8px;border-bottom:1px solid #eee;text-align:left;font-size:13px}
  button{padding:6px 10px;border:none;border-radius:6px;cursor:pointer;color:#fff}
  .unban{background:#28a745}
  .ban{background:#d9534f}
  .broadcast{background:#007bff}
  .stat{font-size:20px;font-weight:700}
  .screenshot-thumb{max-width:140px;max-height:90px;border:1px solid #eee;margin-left:8px;vertical-align:middle}
  .rep-card{padding:10px;border:1px solid #eee;border-radius:8px;margin-bottom:8px;background:#fff}
</style>
</head>
<body>
<h1>Admin — Live Dashboard</h1>

<div class="row">
  <div class="card" style="max-width:320px">
    <h3>Live Stats</h3>
    <div>Connected: <span id="stat-connected" class="stat">0</span></div>
    <div>Waiting: <span id="stat-waiting" class="stat">0</span></div>
    <div>Paired: <span id="stat-partnered" class="stat">0</span></div>
    <div>Total visitors: <span id="stat-totalvisitors">0</span></div>
    <h4>By Country</h4>
    <div id="country-list" class="small"></div>
  </div>

  <div class="card">
    <h3>Broadcast</h3>
    <form id="broadcastForm">
      <textarea id="broadcastMsg" rows="3" style="width:100%"></textarea><br><br>
      <button class="broadcast">Send</button>
    </form>

    <h3 style="margin-top:12px">Active IP Bans</h3>
    <div id="ip-bans" class="small"></div>

    <h3>Active Device Bans</h3>
    <div id="fp-bans" class="small"></div>
  </div>
</div>

<div class="row" style="margin-top:12px">
  <div class="card">
    <h3>Reported Users</h3>
    <div id="reported-list" class="small"></div>
  </div>

  <div class="card">
    <h3>Recent Visitors</h3>
    <div id="visitors-list" class="small" style="max-height:360px;overflow:auto"></div>
  </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  socket.emit('admin-join');

  function renderSnapshot(snap) {
    document.getElementById('stat-connected').textContent = snap.stats.connected;
    document.getElementById('stat-waiting').textContent = snap.stats.waiting;
    document.getElementById('stat-partnered').textContent = snap.stats.partnered;
    document.getElementById('stat-totalvisitors').textContent = snap.stats.totalVisitors;

    const cl = document.getElementById('country-list');
    cl.innerHTML = '';
    const entries = Object.entries(snap.stats.countryCounts);
    if (entries.length === 0) cl.textContent = 'No data';
    else {
      entries.sort((a,b)=>b[1]-a[1]);
      entries.forEach(([country, cnt]) => {
        const d = document.createElement('div');
        d.textContent = country + ': ' + cnt;
        cl.appendChild(d);
      });
    }

    const ipb = document.getElementById('ip-bans');
    ipb.innerHTML = '';
    if (snap.activeIpBans.length === 0) ipb.textContent = 'No active IP bans';
    else snap.activeIpBans.forEach(b => {
      const div = document.createElement('div');
      const dt = new Date(b.expires).toLocaleString();
      div.innerHTML = '<b>'+b.ip+'</b> — expires: '+dt + ' ';
      const btn = document.createElement('button');
      btn.textContent = 'Unban';
      btn.className = 'unban';
      btn.onclick = () => {
        fetch('/unban-ip', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ip:b.ip})}).then(()=>{});
      };
      div.appendChild(btn);
      ipb.appendChild(div);
    });

    const fpb = document.getElementById('fp-bans');
    fpb.innerHTML = '';
    if (snap.activeFpBans.length === 0) fpb.textContent = 'No active device bans';
    else snap.activeFpBans.forEach(b => {
      const div = document.createElement('div');
      const dt = new Date(b.expires).toLocaleString();
      div.innerHTML = '<b>'+b.fp+'</b> — expires: '+dt + ' ';
      const btn = document.createElement('button');
      btn.textContent = 'Unban';
      btn.className = 'unban';
      btn.onclick = () => {
        fetch('/unban-fingerprint', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({fp:b.fp})}).then(()=>{});
      };
      div.appendChild(btn);
      fpb.appendChild(div);
    });

    const rep = document.getElementById('reported-list');
    rep.innerHTML = '';
    if (snap.reportedUsers.length === 0) rep.textContent = 'No reports';
    else snap.reportedUsers.forEach(r => {
      const div = document.createElement('div');
      div.className = 'rep-card';

      // layout: image left, info right
      const left = document.createElement('div');
      left.style.display = 'inline-block';
      left.style.verticalAlign = 'top';
      left.style.width = '160px';

      const right = document.createElement('div');
      right.style.display = 'inline-block';
      right.style.verticalAlign = 'top';
      right.style.marginLeft = '12px';
      right.style.width = 'calc(100% - 180px)';

      if (r.screenshot) {
        const img = document.createElement('img');
        img.src = r.screenshot;
        img.className = 'screenshot-thumb';
        left.appendChild(img);

        const showBtn = document.createElement('button');
        showBtn.textContent = 'Show Screenshot';
        showBtn.style.background = '#007bff';
        showBtn.style.marginTop = '6px';
        showBtn.onclick = () => {
          const w = window.open("", "_blank");
          w.document.write('<meta charset="utf-8"><title>Screenshot</title><img src="' + r.screenshot + '" style="max-width:100%;display:block;margin:10px auto;">');
        };
        left.appendChild(showBtn);
      } else {
        left.innerHTML = '<div style="color:#777;font-size:13px">No screenshot</div>';
      }

      right.innerHTML = '<b>Target:</b> ' + r.target + '<br><b>Reports:</b> ' + r.count;

      const small = document.createElement('div');
      small.style.fontSize='12px'; small.style.color='#666'; small.style.marginTop = '8px';
      small.textContent = 'Reporters: ' + (r.reporters.length ? r.reporters.join(', ') : '—');
      right.appendChild(small);

      // action buttons
      const btnWrap = document.createElement('div');
      btnWrap.style.marginTop = '8px';

      const banBtn = document.createElement('button');
      banBtn.textContent = 'Ban User';
      banBtn.className = 'ban';
      banBtn.style.marginRight = '8px';
      banBtn.onclick = () => {
        if (!confirm('Ban user ' + r.target + ' ?')) return;
        fetch('/manual-ban', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ target: r.target })
        }).then(()=>{});
      };
      btnWrap.appendChild(banBtn);

      const removeBtn = document.createElement('button');
      removeBtn.textContent = 'Remove Report';
      removeBtn.style.background = '#6c757d';
      removeBtn.style.marginRight = '8px';
      removeBtn.onclick = () => {
        if (!confirm('Remove report for user ' + r.target + ' ?')) return;
        fetch('/remove-report', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ target: r.target })
        }).then(()=>{});
      };
      btnWrap.appendChild(removeBtn);

      right.appendChild(btnWrap);

      div.appendChild(left);
      div.appendChild(right);

      rep.appendChild(div);
    });

    const vis = document.getElementById('visitors-list');
    vis.innerHTML = '';
    if (snap.recentVisitors.length === 0) vis.textContent = 'No visitors yet';
    else snap.recentVisitors.forEach(v => {
      const d = document.createElement('div');
      d.textContent = new Date(v.ts).toLocaleString() + ' — ' + (v.country || 'Unknown') + ' — ' + v.ip + (v.fp ? ' — ' + v.fp.slice(0,8) : '');
      vis.appendChild(d);
    });
  }

  socket.on('connect', () => {
    socket.emit('admin-join');
  });

  socket.on('adminUpdate', (snap) => {
    renderSnapshot(snap);
  });

  document.getElementById('broadcastForm').onsubmit = e => {
    e.preventDefault();
    const msg = document.getElementById('broadcastMsg').value.trim();
    if (!msg) return;
    fetch('/admin-broadcast', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({message: msg})});
    document.getElementById('broadcastMsg').value = '';
  };
</script>
</body>
</html>
  `);
});

// admin endpoints
app.post("/admin-broadcast", adminAuth, (req, res) => {
  const msg = req.body.message || (req.body && req.body.message);
  if (msg && msg.trim()) {
    io.emit("adminMessage", msg.trim());
  }
  res.status(200).send({ ok: true });
});

app.post("/unban-ip", adminAuth, (req, res) => {
  const ip = req.body.ip || (req.body && req.body.ip);
  unbanUser(ip, null);
  res.status(200).send({ ok: true });
});

app.post("/unban-fingerprint", adminAuth, (req, res) => {
  const fp = req.body.fp || (req.body && req.body.fp);
  unbanUser(null, fp);
  res.status(200).send({ ok: true });
});

app.post("/manual-ban", adminAuth, (req, res) => {
  const target = req.body.target;
  if (!target) return res.status(400).send({ error: true });

  const ip = userIp.get(target);
  const fp = userFingerprint.get(target);

  banUser(ip, fp);

  const s = io.sockets.sockets.get(target);
  if (s) {
    s.emit("banned", { message: "You were banned by admin." });
    s.disconnect(true);
  }

  emitAdminUpdate();
  res.send({ ok: true });
});

// remove report (admin)
app.post("/remove-report", adminAuth, (req, res) => {
  const target = req.body.target;
  if (!target) return res.status(400).send({ error: true });

  reports.delete(target);
  reportScreenshots.delete(target);

  emitAdminUpdate();
  res.send({ ok: true });
});

// socket logic
io.on("connection", (socket) => {
  const ip = socket.handshake.headers["cf-connecting-ip"] || socket.handshake.address || (socket.request && socket.request.connection && socket.request.connection.remoteAddress) || "unknown";
  userIp.set(socket.id, ip);

  let country = null;
  const headerCountry = socket.handshake.headers["cf-ipcountry"] || socket.handshake.headers["x-country"];
  if (headerCountry) country = headerCountry.toUpperCase();
  else {
    try {
      const g = geoip.lookup(ip);
      if (g && g.country) country = g.country;
    } catch (e) { country = null; }
  }
  const ts = Date.now();
  visitors.set(socket.id, { ip, fp: null, country, ts });
  visitorsHistory.push({ ip, fp: null, country, ts });
  if (country) countryCounts.set(country, (countryCounts.get(country) || 0) + 1);

  const ipBan = bannedIps.get(ip);
  if (ipBan && ipBan > Date.now()) {
    socket.emit("banned", { message: "You are banned (IP)." });
    socket.disconnect(true);
    emitAdminUpdate();
    return;
  }

  emitAdminUpdate();

  socket.on("identify", ({ fingerprint }) => {
    if (fingerprint) {
      userFingerprint.set(socket.id, fingerprint);
      const v = visitors.get(socket.id);
      if (v) { v.fp = fingerprint; visitorsHistory[visitorsHistory.length -1].fp = fingerprint; }
      const fpBan = bannedFingerprints.get(fingerprint);
      if (fpBan && fpBan > Date.now()) {
        socket.emit("banned", { message: "Device banned." });
        socket.disconnect(true);
        emitAdminUpdate();
        return;
      }
    }
    emitAdminUpdate();
  });

  socket.on("find-partner", () => {
    const fp = userFingerprint.get(socket.id);
    if (fp) {
      const fExp = bannedFingerprints.get(fp);
      if (fExp && fExp > Date.now()) {
        socket.emit("banned", { message: "You are banned (device)." });
        socket.disconnect(true);
        emitAdminUpdate();
        return;
      }
    }

    if (!waitingQueue.includes(socket.id) && !partners.has(socket.id)) waitingQueue.push(socket.id);
    tryMatch();
    emitAdminUpdate();
  });

  function tryMatch() {
    while (waitingQueue.length >= 2) {
      const a = waitingQueue.shift();
      const b = waitingQueue.shift();
      if (!a || !b) break;
      if (!io.sockets.sockets.get(a) || !io.sockets.sockets.get(b)) continue;
      partners.set(a, b);
      partners.set(b, a);
      io.to(a).emit("partner-found", { id: b, initiator: true });
      io.to(b).emit("partner-found", { id: a, initiator: false });
    }
  }

  // receive screenshot from user (client should send { image, partnerId? })
  socket.on("admin-screenshot", ({ image, partnerId }) => {
    if (!image) return;
    const target = partnerId || partners.get(socket.id);
    if (!target) return;
    reportScreenshots.set(target, image);
    emitAdminUpdate();
  });

  socket.on("signal", ({ to, data }) => {
    const t = io.sockets.sockets.get(to);
    if (t) t.emit("signal", { from: socket.id, data });
  });

  socket.on("chat-message", ({ to, message }) => {
    const t = io.sockets.sockets.get(to);
    if (t) t.emit("chat-message", { message });
  });

  socket.on("report", ({ partnerId }) => {
    if (!partnerId) return;
    if (!reports.has(partnerId)) reports.set(partnerId, new Set());
    const set = reports.get(partnerId);
    set.add(socket.id);
    emitAdminUpdate();

    if (set.size >= 3) {
      const targetSocket = io.sockets.sockets.get(partnerId);
      const targetIp = userIp.get(partnerId);
      const targetFp = userFingerprint.get(partnerId);
      banUser(targetIp, targetFp);
      if (targetSocket) {
        targetSocket.emit("banned", { message: "You have been banned for 24h due to multiple reports." });
        targetSocket.disconnect(true);
      }
      emitAdminUpdate();
    }
  });

  socket.on("skip", () => {
    const p = partners.get(socket.id);
    if (p) {
      const other = io.sockets.sockets.get(p);
      if (other) other.emit("partner-disconnected");
      partners.delete(p);
      partners.delete(socket.id);
    }
    if (!waitingQueue.includes(socket.id)) waitingQueue.push(socket.id);
    tryMatch();
    emitAdminUpdate();
  });

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

    const v = visitors.get(socket.id);
    if (v) {
      if (v.country && countryCounts.has(v.country)) {
        const c = countryCounts.get(v.country) - 1;
        if (c <= 0) countryCounts.delete(v.country);
        else countryCounts.set(v.country, c);
      }
    }
    visitors.delete(socket.id);
    userFingerprint.delete(socket.id);
    userIp.delete(socket.id);

    // do NOT remove reports or screenshots on disconnect — persist until admin removes or auto-ban triggers
    emitAdminUpdate();
  });

  socket.on("admin-join", () => {
    socket.emit("adminUpdate", getAdminSnapshot());
  });

  emitAdminUpdate();
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log("Server listening on port " + PORT));
