// FULL SERVER — REPORT SYSTEM + LIVE ADMIN PANEL + VISITORS + GEO + Country Blocking + Admin
// SQLITE PERSISTENCE — COMPLETE INTEGRATION
// MODIFIED: IP-based admin access + 24h unique visitor counting

const express = require("express");
const path = require("path");
const fs = require("fs");
const geoip = require("geoip-lite");
const Database = require("better-sqlite3");

const app = express();
app.set("trust proxy", true); // Trust proxy headers for real IP

const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static(__dirname));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ================= ADMIN IP AUTHENTICATION ================= */
const ADMIN_IP = "197.205.203.158";

function adminAuth(req, res, next) {
  // Get client IP (handles X-Forwarded-For, CF-Connecting-IP, etc.)
  const clientIp = req.ip;
  
  // Log for debugging
  console.log("Admin access attempt from IP:", clientIp);
  
  if (clientIp === ADMIN_IP) {
    return next(); // Allow access
  }
  
  // Deny access with 403
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

/* ================= SQLITE PERSISTENCE ================= */
const db = new Database("data.db");

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
`);

// --- static list of countries (ISO2 -> name) ---
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

/* ================= CORE DATA (IN-MEMORY FOR ACTIVE SESSIONS) ================= */
const waitingQueue = [];
const partners = new Map(); // socket.id -> partnerId
const userFingerprint = new Map(); // socket.id -> fingerprint
const userIp = new Map(); // socket.id -> ip
const BAN_DURATION = 24 * 60 * 60 * 1000; // 24h

/* ================= PERSISTENCE HELPERS ================= */
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

// === MODIFIED: Count unique IPs in last 24 hours ===
function loadCountryCounts() {
  const counts = {};
  const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
  for (const r of db.prepare("SELECT country, COUNT(DISTINCT ip) c FROM visitors WHERE ts > ? AND country IS NOT NULL GROUP BY country").all(twentyFourHoursAgo)) {
    if (r.country) counts[r.country] = r.c;
  }
  return counts;
}

/* ================= ADMIN SNAPSHOT ================= */
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

  // MODIFIED: Show all recent visitors but stats are 24h unique
  const recentVisitors = db.prepare(`
    SELECT ip,fp,country,ts FROM visitors
    ORDER BY ts DESC LIMIT 500
  `).all();

  const countryCounts = loadCountryCounts();
  
  // MODIFIED: Count unique IPs in last 24 hours
  const totalVisitors = db.prepare("SELECT COUNT(DISTINCT ip) c FROM visitors WHERE ts > ?").get(twentyFourHoursAgo).c;

  return {
    stats: {
      connected: io.of("/").sockets.size,
      waiting: waitingQueue.length,
      partnered: partners.size / 2,
      totalVisitors: totalVisitors, // Now 24h unique count
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

/* ================= SOCKET.IO ================= */
io.on("connection", socket => {
  const ip =
    socket.handshake.headers["cf-connecting-ip"] ||
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
  // Log every connection (for reports/forensics)
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
      io.to(b).emit("partner-found", { id: a, initiator: false });
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

/* ================= ADMIN ROUTES ================= */
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

// Dashboard
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

// Countries page
app.get("/admin/countries", adminAuth, (req, res) => {
  const html = adminHeader("Countries") + `
<div class="panel">
  <h3>Countries — Block / Unblock</h3>
  <div style="display:flex;gap:12px">
    <div style="flex:1">
      <div class="country-list" id="all-countries"></div>
    </div>
    <div style="width:320px">
      <h4>Blocked Countries</h4>
      <div id="blocked-countries" style="min-height:120px;border:1px solid #eee;padding:8px;border-radius:6px"></div>
      <div style="margin-top:12px">
        <button id="clear-blocks" style="background:#d9534f;padding:8px 10px;color:#fff;border-radius:6px">Clear All Blocks</button>
      </div>
    </div>
  </div>
  <div style="margin-top:12px;color:#666;font-size:13px">
    ملاحظة: الحظر سيؤدي إلى تعطيل الكاميرا والدردشة واظهار رسالة "الموقع محظور في بلدك" للمستخدمين من هذه الدول فور اتصالهم.
  </div>
</div>
<script>
  async function loadCountries() {
    const res = await fetch('/admin/countries-list');
    const data = await res.json();
    const banned = new Set(data.banned || []);
    const container = document.getElementById('all-countries');
    container.innerHTML = '';
    const codes = Object.keys(ALL_COUNTRIES).sort((a,b)=>ALL_COUNTRIES[a].localeCompare(ALL_COUNTRIES[b]));
    codes.forEach(code => {
      const div = document.createElement('div'); div.className='country-item';
      const left = document.createElement('div'); left.className='flex';
      const checkbox = document.createElement('input'); checkbox.type='checkbox'; checkbox.checked = banned.has(code);
      checkbox.dataset.code = code;
      const label = document.createElement('div'); label.textContent = code + ' — ' + ALL_COUNTRIES[code];
      left.appendChild(checkbox); left.appendChild(label);
      const action = document.createElement('div');
      const btn = document.createElement('button'); btn.textContent = checkbox.checked ? 'Unblock' : 'Block';
      btn.style.background = checkbox.checked ? '#28a745' : '#d9534f'; btn.style.color='#fff';
      btn.onclick = async () => {
        if (checkbox.checked) {
          await fetch('/admin/unblock-country', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ code })});
        } else {
          await fetch('/admin/block-country', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ code })});
        }
        loadCountries();
      };
      action.appendChild(btn);
      div.appendChild(left); div.appendChild(action);
      container.appendChild(div);
    });

    document.getElementById('clear-blocks').onclick = async () => {
      if (!confirm('Clear all blocked countries?')) return;
      await fetch('/admin/clear-blocked', {method:'POST'});
      loadCountries();
    };

    const bc = document.getElementById('blocked-countries');
    bc.innerHTML = '';
    if (data.banned.length === 0) bc.textContent = 'No blocked countries';
    else data.banned.forEach(c => {
      const d = document.createElement('div'); d.textContent = c + ' — ' + COUNTRY_NAME(c); bc.appendChild(d);
    });
  }

  loadCountries();
</script>
` + adminFooter();
  res.send(html);
});

// Stats page
app.get("/admin/stats", adminAuth, (req, res) => {
  const html = adminHeader("Stats") + `
<div class="panel">
  <h3>Visitors Analytics</h3>
  <div style="display:flex;gap:12px;align-items:flex-start">
    <div style="flex:1">
      <canvas id="visitorsChart" height="160"></canvas>
    </div>
    <div style="width:360px">
      <h4>By Country</h4>
      <canvas id="countryChart" height="200"></canvas>
      <h4 style="margin-top:12px">Controls</h4>
      <div>
        <label>From: <input type="date" id="fromDate"></label><br><br>
        <label>To: <input type="date" id="toDate"></label><br><br>
        <button id="refreshStats" style="background:#007bff;color:#fff;padding:8px 10px;border-radius:6px">Refresh</button>
      </div>
    </div>
  </div>
  <h4 style="margin-top:14px">Recent Visitors (last 500)</h4>
  <div id="stat-visitors-list" style="max-height:240px;overflow:auto;border:1px solid #eee;padding:8px;border-radius:6px"></div>
</div>
<script>
  let visitorsChart = null, countryChart = null;

  async function loadStats() {
    const from = document.getElementById('fromDate').value;
    const to = document.getElementById('toDate').value;
    const params = new URLSearchParams();
    if (from) params.append('from', from);
    if (to) params.append('to', to);
    const res = await fetch('/admin/stats-data?' + params.toString());
    const data = await res.json();

    const ctx = document.getElementById('visitorsChart').getContext('2d');
    const labels = data.daily.map(d=>d.date);
    const values = data.daily.map(d=>d.count);
    if (visitorsChart) visitorsChart.destroy();
    visitorsChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Daily Visitors',
          data: values,
          fill: false,
          tension: 0.2,
          pointRadius: 3,
          borderWidth: 2
        }]
      },
      options: { responsive:true, scales:{ x:{ display:true }, y:{ beginAtZero:true } } }
    });

    const ctx2 = document.getElementById('countryChart').getContext('2d');
    const cLabels = data.countries.map(c=>c.country);
    const cVals = data.countries.map(c=>c.count);
    if (countryChart) countryChart.destroy();
    countryChart = new Chart(ctx2, {
      type: 'bar',
      data: { labels:cLabels, datasets:[{ label:'By Country', data:cVals, borderWidth:1 }] },
      options:{ responsive:true, scales:{ y:{ beginAtZero:true } } }
    });

    const list = document.getElementById('stat-visitors-list'); list.innerHTML='';
    data.recent.forEach(v => {
      const d = document.createElement('div');
      d.textContent = new Date(v.ts).toLocaleString() + ' — ' + (v.country||'Unknown') + ' — ' + v.ip + (v.fp?(' — '+v.fp.slice(0,8)):'');
      list.appendChild(d);
    });
  }

  document.getElementById('refreshStats').onclick = loadStats;
  loadStats();
</script>
` + adminFooter();
  res.send(html);
});

// Reports page
app.get("/admin/reports", adminAuth, (req, res) => {
  const html = adminHeader("Reports") + `
<div class="panel">
  <h3>Reports</h3>
  <div id="reports-panel"></div>
</div>
<script>
  function renderReportsPanel(snap) {
    const container = document.getElementById('reports-panel');
    container.innerHTML = '';
    if (!snap.reportedUsers || snap.reportedUsers.length === 0) return container.textContent = 'No reports';
    snap.reportedUsers.forEach(r => {
      const div = document.createElement('div'); div.className='rep-card';
      const left = document.createElement('div'); left.style.display='inline-block'; left.style.verticalAlign='top'; left.style.width='160px';
      const right = document.createElement('div'); right.style.display='inline-block'; right.style.verticalAlign='top'; right.style.marginLeft='12px'; right.style.width='calc(100% - 180px)';
      if (r.screenshot) {
        const img = document.createElement('img'); img.src = r.screenshot; img.className='screenshot-thumb'; left.appendChild(img);
        const showBtn = document.createElement('button'); showBtn.textContent='Show Screenshot'; showBtn.style.background='#007bff'; showBtn.style.marginTop='6px';
        showBtn.onclick = ()=>{ const w = window.open("","_blank"); w.document.write('<meta charset="utf-8"><title>Screenshot</title><img src="'+r.screenshot+'" style="max-width:100%;display:block;margin:10px auto;">')};
        left.appendChild(showBtn);
      } else left.innerHTML = '<div style="color:#777;font-size:13px">No screenshot</div>';
      right.innerHTML = '<b>Target:</b> ' + r.target + '<br><b>Reports:</b> ' + r.count;
      const small = document.createElement('div'); small.style.fontSize='12px'; small.style.color='#666'; small.style.marginTop='8px';
      small.textContent = 'Reporters: ' + (r.reporters.length ? r.reporters.join(', ') : '—');
      right.appendChild(small);

      const btnWrap = document.createElement('div'); btnWrap.style.marginTop='8px';
      const banBtn = document.createElement('button'); banBtn.textContent='Ban User'; banBtn.className='ban'; banBtn.style.marginRight='8px';
      banBtn.onclick = ()=> {
        if (!confirm('Ban user ' + r.target + ' ?')) return;
        fetch('/manual-ban', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ target: r.target })});
      };
      const removeBtn = document.createElement('button'); removeBtn.textContent='Remove Report'; removeBtn.style.background='#6c757d'; removeBtn.style.marginRight='8px';
      removeBtn.onclick = ()=> {
        if (!confirm('Remove report for user ' + r.target + ' ?')) return;
        fetch('/remove-report', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ target: r.target })});
      };
      btnWrap.appendChild(banBtn); btnWrap.appendChild(removeBtn); right.appendChild(btnWrap);
      div.appendChild(left); div.appendChild(right); container.appendChild(div);
    });
  }

  function handleAdminUpdate(snap){ renderReportsPanel(snap); }
</script>
` + adminFooter();
  res.send(html);
});

// Bans page
app.get("/admin/bans", adminAuth, (req, res) => {
  const html = adminHeader("Bans") + `
<div class="panel">
  <h3>Manage Bans</h3>
  <div id="bans-panel"></div>
</div>
<script>
  function renderBansPanel(snap) {
    const container = document.getElementById('bans-panel'); container.innerHTML = '';
    const iph = document.createElement('div'); iph.innerHTML = '<h4>IP Bans</h4>'; container.appendChild(iph);
    if (snap.activeIpBans.length === 0) iph.appendChild(document.createTextNode('No IP bans'));
    else snap.activeIpBans.forEach(b => {
      const div = document.createElement('div'); div.style.marginBottom='8px';
      const dt = new Date(b.expires).toLocaleString();
      div.innerHTML = '<b>'+b.ip+'</b> — expires: '+dt + ' ';
      const btn = document.createElement('button'); btn.textContent='Unban'; btn.className='unban';
      btn.onclick = ()=> fetch('/unban-ip', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ip:b.ip})});
      div.appendChild(btn); container.appendChild(div);
    });

    const dph = document.createElement('div'); dph.innerHTML = '<h4 style="margin-top:12px">Device Bans</h4>'; container.appendChild(dph);
    if (snap.activeFpBans.length === 0) dph.appendChild(document.createTextNode('No device bans'));
    else snap.activeFpBans.forEach(b => {
      const div = document.createElement('div'); div.style.marginBottom='8px';
      const dt = new Date(b.expires).toLocaleString();
      div.innerHTML = '<b>'+b.fp+'</b> — expires: '+dt + ' ';
      const btn = document.createElement('button'); btn.textContent='Unban'; btn.className='unban';
      btn.onclick = ()=> fetch('/unban-fingerprint', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({fp:b.fp})});
      div.appendChild(btn); container.appendChild(div);
    });
  }
  function handleAdminUpdate(snap){ renderBansPanel(snap); }
</script>
` + adminFooter();
  res.send(html);
});

/* ================= ADMIN API ENDPOINTS ================= */
app.get("/admin/countries-list", adminAuth, (req, res) => {
  res.send({ all: Object.keys(COUNTRIES), banned: Array.from(getBannedCountries()) });
});

app.post("/admin/block-country", adminAuth, (req, res) => {
  const code = (req.body.code || "").toUpperCase();
  if (!code || !COUNTRIES[code]) return res.status(400).send({ error: "invalid" });
  db.prepare("INSERT OR REPLACE INTO banned_countries VALUES (?)").run(code);
  emitAdminUpdate();
  res.send({ ok: true, banned: Array.from(getBannedCountries()) });
});

app.post("/admin/unblock-country", adminAuth, (req, res) => {
  const code = (req.body.code || "").toUpperCase();
  if (!code) return res.status(400).send({ error: "invalid" });
  db.prepare("DELETE FROM banned_countries WHERE code=?").run(code);
  emitAdminUpdate();
  res.send({ ok: true, banned: Array.from(getBannedCountries()) });
});

app.post("/admin/clear-blocked", adminAuth, (req, res) => {
  db.prepare("DELETE FROM banned_countries").run();
  emitAdminUpdate();
  res.send({ ok: true });
});

app.get("/admin/stats-data", adminAuth, (req, res) => {
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;
  
  const dailyMap = new Map();
  for (const v of db.prepare("SELECT * FROM visitors").all()) {
    const t = new Date(v.ts);
    if (from && t < from) continue;
    if (to && t > new Date(to.getTime() + 24*3600*1000 -1)) continue;
    const key = t.toISOString().slice(0,10);
    dailyMap.set(key, (dailyMap.get(key)||0) + 1);
  }
  const daily = Array.from(dailyMap.entries()).sort((a,b)=>a[0].localeCompare(b[0])).map(([date,count])=>({date,count}));

  const countries = db.prepare("SELECT country, COUNT(DISTINCT ip) c FROM visitors WHERE country IS NOT NULL AND ts > ? GROUP BY country ORDER BY c DESC LIMIT 50")
    .all(Date.now() - (24 * 60 * 60 * 1000))
    .map(r => ({country: r.country, count: r.c}));

  const recent = db.prepare("SELECT ip,fp,country,ts FROM visitors ORDER BY ts DESC LIMIT 500").all();

  res.send({ daily, countries, recent });
});

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

app.post("/remove-report", adminAuth, (req, res) => {
  const target = req.body.target;
  if (!target) return res.status(400).send({ error: true });

  db.prepare("DELETE FROM reports WHERE target=?").run(target);
  db.prepare("DELETE FROM screenshots WHERE target=?").run(target);

  emitAdminUpdate();
  res.send({ ok: true });
});

/* ================= START SERVER ================= */
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log("Server listening on port " + PORT));
