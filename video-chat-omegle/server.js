// ==================== RENDER FREE TIER OPTIMIZATIONS ====================
// 1. Lightweight health endpoint for uptime monitoring (UptimeRobot, etc.)
// 2. Auto-cleanup of old data every 6 hours
// 3. Socket.io optimized for low resource usage
// 4. Rate limiting to prevent abuse
// 5. Compression enabled
// 6. Graceful shutdown handling
// 7. Memory usage monitoring
// =======================================================================

const express = require("express");
const path = require("path");
const fs = require("fs");
const geoip = require("geoip-lite");
const Database = require("better-sqlite3");
const compression = require("compression");
const rateLimit = require("express-rate-limit");

const app = express();
app.set("trust proxy", 1); // Trust Render's proxy

const http = require("http").createServer(app);
const io = require("socket.io")(http, {
  // Optimize Socket.io for free tier
  transports: ["websocket"], // Use only websocket (faster, lower overhead)
  pingTimeout: 60000, // 60s timeout
  pingInterval: 25000, // 25s interval
  maxHttpBufferSize: 1e6, // Limit message size to 1MB
});

// ==================== MIDDLEWARE ====================
app.use(compression()); // Compress all responses
app.use(express.static(__dirname, { maxAge: "1d" })); // Cache static files for 1 day
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(express.json({ limit: "10kb" }));

// Rate limiting - prevent abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/admin/", limiter); // Apply rate limiting to admin routes

// ==================== ADMIN IP AUTHENTICATION ====================
const ADMIN_IP = process.env.ADMIN_IP || "197.205.203.158";

function adminAuth(req, res, next) {
  const clientIp = req.ip;
  console.log("Admin access attempt from IP:", clientIp);
  
  if (clientIp === ADMIN_IP) {
    return next();
  }
  
  return res.status(403).send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Access Denied</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 50px; text-align: center; }
        .error { color: #d9534f; }
      </style>
    </head>
    <body>
      <h1 class="error">403 Forbidden</h1>
      <p>Admin access is restricted to IP: <strong>${ADMIN_IP}</strong></p>
      <p>Your IP: <strong>${clientIp}</strong></p>
    </body>
    </html>
  `);
}

// ==================== SQLITE PERSISTENCE ====================
const db = new Database("data.db", { 
  // Optimize SQLite for better performance
  fileMustExist: false,
  timeout: 5000,
  verbose: null
});

// Create tables with indexes for performance
db.exec(`
CREATE TABLE IF NOT EXISTS visitors (
  ip TEXT,
  fp TEXT,
  country TEXT,
  ts INTEGER
);

CREATE TABLE IF NOT EXISTS banned_ips (
  ip TEXT PRIMARY KEY,
  expires INTEGER
);

CREATE TABLE IF NOT EXISTS banned_fps (
  fp TEXT PRIMARY KEY,
  expires INTEGER
);

CREATE TABLE IF NOT EXISTS reports (
  target TEXT,
  reporter TEXT
);

CREATE TABLE IF NOT EXISTS screenshots (
  target TEXT PRIMARY KEY,
  image TEXT
);

CREATE TABLE IF NOT EXISTS banned_countries (
  code TEXT PRIMARY KEY
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_visitors_ip ON visitors(ip);
CREATE INDEX IF NOT EXISTS idx_visitors_ts ON visitors(ts);
CREATE INDEX IF NOT EXISTS idx_visitors_country ON visitors(country);
CREATE INDEX IF NOT EXISTS idx_banned_ips_expires ON banned_ips(expires);
CREATE INDEX IF NOT EXISTS idx_banned_fps_expires ON banned_fps(expires);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target);
`);

// ==================== COUNTRY LIST (UNCHANGED) ====================
const COUNTRIES = {
  "AF":"Afghanistan","AL":"Albania","DZ":"Algeria","AS":"American Samoa","AD":"Andorra","AO":"Angola","AI":"Anguilla",
  "AQ":"Antarctica","AG":"Antigua and Barbuda","AR":"Argentina","AM":"Armenia","AW":"Aruba","AU":"Australia","AT":"Austria",
  "AZ":"Azerbaijan","BS":"Bahamas","BH":"Bahrain","BD":"Bangladesh","BB":"Barbados","BY":"Belarus","BE":"Belgium","BZ":"Belize",
  "BJ":"Benin","BM":"Bermuda","BT":"Bhutan","BO":"Bolivia","BA":"Bosnia and Herzegovina","BW":"Botswana","BR":"Brazil",
  "IO":"British Indian Ocean Territory","VG":"British Virgin Islands","BN":"Brunei","BG":"Bulgaria","BF":"Burkina Faso",
  "BI":"Burundi","CV":"Cabo Verde","KH":"Cambodia","CM":"Cameroon","CA":"Canada","KY":"Cayman Islands","CF":"Central African Republic",
  "TD":"Chad","CL":"Chile","CN":"China","CX":"Christmas Island","CC":"Cocos (Keeling) Islands","CO":"Colombia","KM":"Comoros",
  "CG":"Congo - Brazzaville","CD":"Congo - Kinshasa","CK":"Cook Islands","CR":"Costa Rica","CI":"Côte d’Ivoire","HR":"Croatia",
  "CU":"Cuba","CW":"Curaçao","CY":"Cyprus","CZ":"Czechia","DK":"Denmark","DJ":"Djibouti","DM":"Dominica","DO":"Dominican Republic",
  "EC":"Ecuador","EG":"Egypt","SV":"El Salvador","GQ":"Equatorial Guinea","ER":"Eritrea","EE":"Estonia","ET":"Ethiopia",
  "FK":"Falkland Islands","FO":"Faroe Islands","FJ":"Fiji","FI":"Finland","FR":"France","GF":"French Guiana","PF":"French Polynesia",
  "GA":"Gabon","GM":"Gambia","GE":"Georgia","DE":"Germany","GH":"Ghana","GI":"Gibraltar","GR":"Greece","GL":"Greenland","GD":"Grenada",
  "GP":"Guadeloupe","GU":"Guam","GT":"Guatemala","GG":"Guernsey","GN":"Guinea","GW":"Guinea-Bissau","GY":"Guyana","HT":"Haiti",
  "HN":"Honduras","HK":"Hong Kong","HU":"Hungary","IS":"Iceland","IN":"India","ID":"Indonesia","IR":"Iran","IQ":"Iraq","IE":"Ireland",
  "IM":"Isle of Man","IL":"Israel","IT":"Italy","JM":"Jamaica","JP":"Japan","JE":"Jersey","JO":"Jordan","KZ":"Kazakhstan","KE":"Kenya",
  "KI":"Kiribati","XK":"Kosovo","KW":"Kuwait","KG":"Kyrgyzstan","LA":"Laos","LV":"Latvia","LB":"Lebanon","LS":"Lesotho","LR":"Liberia",
  "LY":"Libya","LI":"Liechtenstein","LT":"Lithuania","LU":"Luxembourg","MO":"Macao","MK":"North Macedonia","MG":"Madagascar","MW":"Malawi",
  "MY":"Malaysia","MV":"Maldives","ML":"Mali","MT":"Malta","MH":"Marshall Islands","MQ":"Martinique","MR":"Mauritania","MU":"Mauritius",
  "YT":"Mayotte","MX":"Mexico","FM":"Micronesia","MD":"Moldova","MC":"Monaco","MN":"Mongolia","ME":"Montenegro","MS":"Montserrat",
  "MA":"Morocco","MZ":"Mozambique","MM":"Myanmar","NA":"Namibia","NR":"Nauru","NP":"Nepal","NL":"Netherlands","NC":"New Caledonia",
  "NZ":"New Zealand","NI":"Nicaragua","NE":"Niger","NG":"Nigeria","NU":"Niue","KP":"North Korea","MP":"Northern Mariana Islands","NO":"Norway",
  "OM":"Oman","PK":"Pakistan","PW":"Palau","PS":"Palestine","PA":"Panama","PG":"Papua New Guinea","PY":"Paraguay","PE":"Peru","PH":"Philippines",
  "PL":"Poland","PT":"Portugal","PR":"Puerto Rico","QA":"Qatar","RE":"Réunion","RO":"Romania","RU":"Russia","RW":"Rwanda","WS":"Samoa",
  "SM":"San Marino","ST":"São Tomé & Príncipe","SA":"Saudi Arabia","SN":"Senegal","RS":"Serbia","SC":"Seychelles","SL":"Sierra Leone",
  "SG":"Singapore","SX":"Sint Maarten","SK":"Slovakia","SI":"Slovenia","SB":"Solomon Islands","SO":"Somalia","ZA":"South Africa","KR":"South Korea",
  "SS":"South Sudan","ES":"Spain","LK":"Sri Lanka","BL":"St. Barthélemy","SH":"St. Helena","KN":"St. Kitts & Nevis","LC":"St. Lucia","MF":"St. Martin",
  "PM":"St. Pierre & Miquelon","VC":"St. Vincent & the Grenadines","SD":"Sudan","SR":"Suriname","SJ":"Svalbard & Jan Mayen","SE":"Sweden","CH":"Switzerland",
  "SY":"Syria","TW":"Taiwan","TJ":"Tajikistan","TZ":"Tanzania","TH":"Thailand","TL":"Timor-Leste","TG":"Togo","TK":"Tokelau","TO":"Tonga",
  "TT":"Trinidad & Tobago","TN":"Tunisia","TR":"Turkey","TM":"Turkmenistan","TC":"Turks & Caicos Islands","TV":"Tuvalu","UG":"Uganda","UA":"Ukraine",
  "AE":"United Arab Emirates","GB":"United Kingdom","US":"United States","UY":"Uruguay","UZ":"Uzbekistan","VU":"Vanuatu","VA":"Vatican City",
  "VE":"Venezuela","VN":"Vietnam","VI":"U.S. Virgin Islands","WF":"Wallis & Futuna","EH":"Western Sahara","YE":"Yemen","ZM":"Zambia","ZW":"Zimbabwe"
};

// ==================== CORE DATA (IN-MEMORY) ====================
const waitingQueue = [];
const partners = new Map();
const userFingerprint = new Map();
const userIp = new Map();
const BAN_DURATION = 24 * 60 * 60 * 1000; // 24h

// ==================== PERSISTENCE HELPERS ====================
function isIpBanned(ip) {
  if (!ip) return false;
  const r = db.prepare("SELECT expires FROM banned_ips WHERE ip=?").get(ip);
  if (!r) return false;
  if (r.expires < Date.now()) {
    db.prepare("DELETE FROM banned_ips WHERE ip=?").run(ip);
    return false;
  }
  return true;
}

function isFpBanned(fp) {
  if (!fp) return false;
  const r = db.prepare("SELECT expires FROM banned_fps WHERE fp=?").get(fp);
  if (!r) return false;
  if (r.expires < Date.now()) {
    db.prepare("DELETE FROM banned_fps WHERE fp=?").run(fp);
    return false;
  }
  return true;
}

function banUser(ip, fp) {
  const exp = Date.now() + BAN_DURATION;
  if (ip) db.prepare("INSERT OR REPLACE INTO banned_ips VALUES (?,?)").run(ip, exp);
  if (fp) db.prepare("INSERT OR REPLACE INTO banned_fps VALUES (?,?)").run(fp, exp);
}

function unbanUser(ip, fp) {
  if (ip) db.prepare("DELETE FROM banned_ips WHERE ip=?").run(ip);
  if (fp) db.prepare("DELETE FROM banned_fps WHERE fp=?").run(fp);
}

function getBannedCountries() {
  return new Set(db.prepare("SELECT code FROM banned_countries").all().map(r => r.code));
}

function loadCountryCounts() {
  const counts = {};
  const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
  for (const r of db.prepare("SELECT country, COUNT(DISTINCT ip) c FROM visitors WHERE ts > ? AND country IS NOT NULL GROUP BY country").all(twentyFourHoursAgo)) {
    if (r.country) counts[r.country] = r.c;
  }
  return counts;
}

// ==================== ADMIN SNAPSHOT ====================
function getAdminSnapshot() {
  const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
  
  const activeIpBans = db.prepare("SELECT ip,expires FROM banned_ips WHERE expires>?").all(Date.now());
  const activeFpBans = db.prepare("SELECT fp,expires FROM banned_fps WHERE expires>?").all(Date.now());

  const reportsMap = new Map();
  for (const r of db.prepare("SELECT * FROM reports").all()) {
    if (!reportsMap.has(r.target)) reportsMap.set(r.target, []);
    reportsMap.get(r.target).push(r.reporter);
  }

  const reportedUsers = [];
  for (const [target, reporters] of reportsMap) {
    const sc = db.prepare("SELECT image FROM screenshots WHERE target=?").get(target);
    reportedUsers.push({
      target,
      count: reporters.length,
      reporters,
      screenshot: sc ? sc.image : null
    });
  }

  const recentVisitors = db.prepare(`
    SELECT ip,fp,country,ts FROM visitors
    ORDER BY ts DESC LIMIT 500
  `).all();

  const countryCounts = loadCountryCounts();
  const totalVisitors = db.prepare("SELECT COUNT(DISTINCT ip) c FROM visitors WHERE ts > ?").get(twentyFourHoursAgo).c;

  return {
    stats: {
      connected: io.of("/").sockets.size,
      waiting: waitingQueue.length,
      partnered: partners.size / 2,
      totalVisitors,
      countryCounts
    },
    activeIpBans,
    activeFpBans,
    reportedUsers,
    recentVisitors,
    bannedCountries: Array.from(getBannedCountries())
  };
}

function emitAdminUpdate() {
  io.emit("adminUpdate", getAdminSnapshot());
}

// ==================== SOCKET.IO ====================
io.on("connection", socket => {
  const ip =
    socket.handshake.headers["cf-connecting-ip"] ||
    socket.handshake.headers["x-forwarded-for"] ||
    socket.handshake.address ||
    (socket.request && socket.request.connection && socket.request.connection.remoteAddress) ||
    "unknown";

  userIp.set(socket.id, ip);

  let country = null;
  const headerCountry = socket.handshake.headers["cf-ipcountry"] || socket.handshake.headers["x-country"];
  if (headerCountry) country = headerCountry.toUpperCase();
  else {
    try {
      const g = geoip.lookup(ip);
      if (g && g.country) country = g.country;
    } catch { country = null; }
  }

  if (country && getBannedCountries().has(country)) {
    socket.emit("country-blocked", { message: "الموقع محظور في بلدك", country });
    return;
  }

  if (isIpBanned(ip)) {
    socket.emit("banned", { message: "IP banned" });
    socket.disconnect(true);
    return;
  }

  const ts = Date.now();
  db.prepare("INSERT INTO visitors VALUES (?,?,?,?)").run(ip, null, country, ts);
  emitAdminUpdate();

  socket.on("identify", ({ fingerprint }) => {
    if (!fingerprint) return;
    userFingerprint.set(socket.id, fingerprint);
    db.prepare(`UPDATE visitors SET fp=? WHERE ip=? AND ts=?`).run(fingerprint, ip, ts);

    if (isFpBanned(fingerprint)) {
      socket.emit("banned", { message: "Device banned" });
      socket.disconnect(true);
    }

    emitAdminUpdate();
  });

  socket.on("find-partner", () => {
    const fp = userFingerprint.get(socket.id);
    if (fp && isFpBanned(fp)) {
      socket.emit("banned", { message: "Device banned" });
      socket.disconnect(true);
      return;
    }

    if (!waitingQueue.includes(socket.id) && !partners.has(socket.id)) {
      waitingQueue.push(socket.id);
    }
    tryMatch();
    emitAdminUpdate();
  });

  function tryMatch() {
    while (waitingQueue.length >= 2) {
      const a = waitingQueue.shift();
      const b = waitingQueue.shift();
      if (!io.sockets.sockets.get(a) || !io.sockets.sockets.get(b)) continue;
      partners.set(a, b);
      partners.set(b, a);
      io.to(a).emit("partner-found", { id: b, initiator: true });
      io.to(b).emit("partner-found", { id: b, initiator: false });
    }
  }

  socket.on("signal", ({ to, data }) => {
    io.to(to).emit("signal", { from: socket.id, data });
  });

  socket.on("chat-message", ({ to, message }) => {
    io.to(to).emit("chat-message", { message });
  });

  socket.on("admin-screenshot", ({ image, partnerId }) => {
    if (!image || !partnerId) return;
    db.prepare("INSERT OR REPLACE INTO screenshots VALUES (?,?)").run(partnerId, image);
    emitAdminUpdate();
  });

  socket.on("report", ({ partnerId }) => {
    if (!partnerId) return;
    db.prepare("INSERT INTO reports VALUES (?,?)").run(partnerId, socket.id);

    const count = db.prepare("SELECT COUNT(*) c FROM reports WHERE target=?").get(partnerId).c;

    if (count >= 3) {
      const ip2 = userIp.get(partnerId);
      const fp2 = userFingerprint.get(partnerId);
      banUser(ip2, fp2);
      const s = io.sockets.sockets.get(partnerId);
      if (s) {
        s.emit("banned", { message: "Banned by reports" });
        s.disconnect(true);
      }
    }

    emitAdminUpdate();
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
    const i = waitingQueue.indexOf(socket.id);
    if (i !== -1) waitingQueue.splice(i, 1);

    const p = partners.get(socket.id);
    if (p) {
      const other = io.sockets.sockets.get(p);
      if (other) other.emit("partner-disconnected");
      partners.delete(p);
    }
    partners.delete(socket.id);

    userFingerprint.delete(socket.id);
    userIp.delete(socket.id);

    emitAdminUpdate();
  });

  socket.on("admin-join", () => {
    socket.emit("adminUpdate", getAdminSnapshot());
  });
});

// ==================== ADMIN ROUTES (UNCHANGED) ====================
app.get("/admin", adminAuth, (req, res) => {
  res.redirect("/admin/dashboard");
});

function adminHeader(title) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Admin — ${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:;base64,iVBORw0KGgo=">
<style>
  body{font-family:Arial;padding:16px;background:#f7f7f7}
  .topbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
  .tab{padding:8px 12px;border-radius:6px;background:#fff;cursor:pointer;border:1px solid #eee}
  .tab.active{box-shadow:0 2px 10px rgba(0,0,0,0.06);background:#fff}
  .panel{background:#fff;padding:12px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.05)}
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
  .country-list{max-height:420px;overflow:auto;border:1px solid #eee;padding:8px;border-radius:6px}
  .country-item{display:flex;justify-content:space-between;align-items:center;padding:6px 4px;border-bottom:1px solid #f2f2f2}
  .flex{display:flex;gap:8px;align-items:center}
  @media(max-width:900px){ .row{flex-direction:column} }
</style>
</head>
<body>
<h1>Admin — ${title}</h1>
<div class="topbar" id="tabs">
  <a class="tab" href="/admin/dashboard">Dashboard</a>
  <a class="tab" href="/admin/countries">Countries</a>
  <a class="tab" href="/admin/stats">Stats</a>
  <a class="tab" href="/admin/reports">Reports</a>
  <a class="tab" href="/admin/bans">Bans</a>
  <div style="margin-left:auto;color:#666">Admin IP: ${ADMIN_IP}</div>
</div>
`;
}

function adminFooter() {
  return `
<script src="/socket.io/socket.io.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script>
  const socket = io();
  socket.emit('admin-join');
  socket.on('connect', ()=> socket.emit('admin-join'));
  socket.on('adminUpdate', snap => {
    if (typeof handleAdminUpdate === 'function') handleAdminUpdate(snap);
  });
  const ALL_COUNTRIES = ${JSON.stringify(COUNTRIES)};
  function COUNTRY_NAME(code){ return ALL_COUNTRIES[code] || code; }
</script>
</body>
</html>
`;
}

// ==================== RENDER: HEALTH CHECK ENDPOINT ====================
// This endpoint is very lightweight and perfect for uptime monitoring
app.get("/health", (req, res) => {
  res.status(200).json({ 
    status: "ok", 
    timestamp: Date.now(),
    connections: io.of("/").sockets.size,
    memory: process.memoryUsage()
  });
});

// ==================== RENDER: PERIODIC CLEANUP ====================
// Clean old visitor data (older than 30 days) every 6 hours
// This keeps database small and fast
function cleanupOldData() {
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const deleted = db.prepare("DELETE FROM visitors WHERE ts < ?").run(thirtyDaysAgo);
  console.log(`[Cleanup] Deleted ${deleted.changes} old visitor records`);
  
  // Also clean expired bans
  db.prepare("DELETE FROM banned_ips WHERE expires < ?").run(Date.now());
  db.prepare("DELETE FROM banned_fps WHERE expires < ?").run(Date.now());
}
// Run cleanup every 6 hours
setInterval(cleanupOldData, 6 * 60 * 60 * 1000);
// Run once on startup
cleanupOldData();

// ==================== RENDER: MEMORY MONITORING ====================
function logMemoryUsage() {
  const usage = process.memoryUsage();
  console.log(`[Memory] RSS: ${(usage.rss / 1024 / 1024).toFixed(2)}MB | Heap: ${(usage.heapUsed / 1024 / 1024).toFixed(2)}MB`);
}
// Log every 5 minutes
setInterval(logMemoryUsage, 5 * 60 * 1000);

// ==================== ADMIN ROUTES (UNCHANGED) ====================
app.get("/admin/dashboard", adminAuth, (req, res) => {
  const html = adminHeader("Dashboard") + `
<div class="panel">
  <div class="row">
    <div class="card" style="max-width:320px">
      <h3>Live Stats</h3>
      <div>Connected: <span id="stat-connected" class="stat">0</span></div>
      <div>Waiting: <span id="stat-waiting" class="stat">0</span></div>
      <div>Paired: <span id="stat-partnered" class="stat">0</span></div>
      <div>Unique Visitors (24h): <span id="stat-totalvisitors" class="stat">0</span></div>
      <h4>By Country (24h)</h4>
      <div id="country-list" class="small"></div>
    </div>

    <div class="card" style="flex:1">
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
      <h3>Reported Users (summary)</h3>
      <div id="reported-list" class="small"></div>
    </div>

    <div class="card">
      <h3>Recent Visitors</h3>
      <div id="visitors-list" class="small" style="max-height:360px;overflow:auto"></div>
    </div>
  </div>
</div>
<script>
  document.getElementById('broadcastForm').onsubmit = e => {
    e.preventDefault();
    const msg = document.getElementById('broadcastMsg').value.trim();
    if (!msg) return;
    fetch('/admin-broadcast', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({message: msg})});
    document.getElementById('broadcastMsg').value = '';
  };

  function renderSnapshot(snap) {
    document.getElementById('stat-connected').textContent = snap.stats.connected;
    document.getElementById('stat-waiting').textContent = snap.stats.waiting;
    document.getElementById('stat-partnered').textContent = snap.stats.partnered;
    document.getElementById('stat-totalvisitors').textContent = snap.stats.totalVisitors;

    const cl = document.getElementById('country-list');
    cl.innerHTML = '';
    const entries = Object.entries(snap.stats.countryCounts);
    if (entries.length === 0) cl.textContent = 'No data (24h)';
    else {
      entries.sort((a,b)=>b[1]-a[1]);
      entries.forEach(([country, cnt]) => {
        const d = document.createElement('div');
        d.textContent = (COUNTRY_NAME(country) || country) + ': ' + cnt;
        cl.appendChild(d);
      });
    }

    const ipb = document.getElementById('ip-bans'); ipb.innerHTML='';
    if (snap.activeIpBans.length === 0) ipb.textContent = 'No active IP bans';
    else snap.activeIpBans.forEach(b => {
      const div = document.createElement('div');
      const dt = new Date(b.expires).toLocaleString();
      div.innerHTML = '<b>'+b.ip+'</b> — expires: '+dt + ' ';
      const btn = document.createElement('button'); btn.textContent = 'Unban'; btn.className='unban';
      btn.onclick = () => fetch('/unban-ip', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ip:b.ip})});
      div.appendChild(btn); ipb.appendChild(div);
    });

    const fpb = document.getElementById('fp-bans'); fpb.innerHTML='';
    if (snap.activeFpBans.length === 0) fpb.textContent = 'No active device bans';
    else snap.activeFpBans.forEach(b => {
      const div = document.createElement('div');
      const dt = new Date(b.expires).toLocaleString();
      div.innerHTML = '<b>'+b.fp+'</b> — expires: '+dt + ' ';
      const btn = document.createElement('button'); btn.textContent = 'Unban'; btn.className='unban';
      btn.onclick = () => fetch('/unban-fingerprint', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({fp:b.fp})});
      div.appendChild(btn); fpb.appendChild(div);
    });

    const rep = document.getElementById('reported-list'); rep.innerHTML='';
    if (snap.reportedUsers.length === 0) rep.textContent = 'No reports';
    else snap.reportedUsers.forEach(r => {
      const div = document.createElement('div'); div.className='rep-card';
      div.innerHTML = '<b>Target:</b> ' + r.target + ' — <b>Reports:</b> ' + r.count;
      rep.appendChild(div);
    });

    const vis = document.getElementById('visitors-list'); vis.innerHTML='';
    if (snap.recentVisitors.length === 0) vis.textContent = 'No visitors yet';
    else snap.recentVisitors.forEach(v => {
      const d = document.createElement('div');
      d.textContent = new Date(v.ts).toLocaleString() + ' — ' + (v.country || 'Unknown') + ' — ' + v.ip + (v.fp ? ' — ' + v.fp.slice(0,8) : '');
      vis.appendChild(d);
    });
  }

  function handleAdminUpdate(snap){ renderSnapshot(snap); }
</script>
` + adminFooter();
  res.send(html);
});

// ... (keep all other admin routes exactly as they were) ...
// [Full admin routes code from original - truncated for brevity]

// ==================== RENDER: GRACEFUL SHUTDOWN ====================
process.on('SIGTERM', () => {
  console.log('[Shutdown] SIGTERM received, shutting down gracefully...');
  http.close(() => {
    console.log('[Shutdown] HTTP server closed');
    db.close();
    console.log('[Shutdown] Database closed');
    process.exit(0);
  });
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log("=====================================");
  console.log(`Server listening on port ${PORT}`);
  console.log(`Health endpoint: http://localhost:${PORT}/health`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
  console.log("=====================================");
  logMemoryUsage();
});
