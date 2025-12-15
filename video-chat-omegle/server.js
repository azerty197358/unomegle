// ==================== RENDER FREE TIER OPTIMIZATIONS ====================
// 1. Lightweight health endpoint for uptime monitoring
// 2. Auto-cleanup of old data every 12 hours
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
const bcrypt = require('bcryptjs');
const session = require('express-session');

const app = express();
app.set("trust proxy", 1); // Trust Render's proxy

const http = require("http").createServer(app);
const io = require("socket.io")(http, {
  // Optimize Socket.io for free tier
  transports: ["websocket"],
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6,
});

// ==================== MIDDLEWARE ====================
app.use(compression());
app.use(express.static(__dirname, { maxAge: "1d" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(express.json({ limit: "10kb" }));

// Session middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-super-secret-key-change-this-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false, // Set to true if using HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  },
  name: 'adminSessionId' // Custom session cookie name
}));

// Rate limiting - prevent abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/admin/", limiter);

// ==================== SQLITE PERSISTENCE ====================
const db = new Database("data.db", { 
  fileMustExist: false,
  timeout: 15000,
  verbose: null
});

// Create all tables with indexes
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
  reporter TEXT,
  target_ip TEXT,
  target_fp TEXT,
  ts INTEGER
);

CREATE TABLE IF NOT EXISTS screenshots (
  target TEXT PRIMARY KEY,
  image TEXT
);

CREATE TABLE IF NOT EXISTS banned_countries (
  code TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_visitors_ip ON visitors(ip);
CREATE INDEX IF NOT EXISTS idx_visitors_ts ON visitors(ts);
CREATE INDEX IF NOT EXISTS idx_visitors_country ON visitors(country);
CREATE INDEX IF NOT EXISTS idx_banned_ips_expires ON banned_ips(expires);
CREATE INDEX IF NOT EXISTS idx_banned_fps_expires ON banned_fps(expires);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target);
CREATE INDEX IF NOT EXISTS idx_reports_ts ON reports(ts);
`);

// Create default admin user if not exists
const defaultUsername = 'admin';
const defaultPassword = 'changeme123'; // CHANGE THIS AFTER FIRST LOGIN!
const hashedDefaultPassword = bcrypt.hashSync(defaultPassword, 10);

db.prepare(`
  INSERT OR IGNORE INTO admin_users (username, password_hash, created_at) 
  VALUES (?, ?, ?)
`).run(defaultUsername, hashedDefaultPassword, Date.now());

console.log(`[Admin] Default user created: username="${defaultUsername}", password="${defaultPassword}"`);

// ==================== AUTHENTICATION MIDDLEWARES ====================

// Middleware to check if user is authenticated
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  res.redirect('/admin/login');
}

// Middleware for already logged-in users (prevent accessing login page)
function redirectIfAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return res.redirect('/admin/dashboard');
  }
  next();
}

// ==================== ADMIN AUTH ROUTES ====================

// Login page
app.get("/admin/login", redirectIfAuth, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Admin Login</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        body { font-family: Arial, sans-serif; background: #f7f7f7; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .login-box { background: #fff; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); width: 100%; max-width: 400px; }
        .login-box h2 { margin: 0 0 20px 0; text-align: center; }
        .form-group { margin-bottom: 15px; }
        .form-group label { display: block; margin-bottom: 5px; font-weight: bold; }
        .form-group input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }
        .btn-login { width: 100%; padding: 10px; background: #007bff; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; }
        .btn-login:hover { background: #0056b3; }
        .error { color: #d9534f; margin-top: 10px; text-align: center; }
      </style>
    </head>
    <body>
      <div class="login-box">
        <h2>Admin Login</h2>
        <form method="POST" action="/admin/login">
          <div class="form-group">
            <label for="username">Username</label>
            <input type="text" id="username" name="username" required>
          </div>
          <div class="form-group">
            <label for="password">Password</label>
            <input type="password" id="password" name="password" required>
          </div>
          <button type="submit" class="btn-login">Login</button>
          ${req.query.error ? '<div class="error">Invalid username or password</div>' : ''}
        </form>
      </div>
    </body>
    </html>
  `);
});

// Login handler
app.post("/admin/login", redirectIfAuth, (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.redirect('/admin/login?error=1');
  }

  const user = db.prepare("SELECT id, password_hash FROM admin_users WHERE username = ?").get(username);
  
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    console.log(`[Admin] Failed login attempt for username: "${username}"`);
    return res.redirect('/admin/login?error=1');
  }

  // Successful login
  req.session.userId = user.id;
  req.session.username = username;
  console.log(`[Admin] Successful login for username: "${username}"`);
  res.redirect('/admin/dashboard');
});

// Logout handler
app.get("/admin/logout", requireAuth, (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error("[Admin] Logout error:", err);
    res.redirect('/admin/login');
  });
});

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
  let success = false;
  if (ip) {
    const result = db.prepare("DELETE FROM banned_ips WHERE ip=?").run(ip);
    if (result.changes > 0) success = true;
  }
  if (fp) {
    const result = db.prepare("DELETE FROM banned_fps WHERE fp=?").run(fp);
    if (result.changes > 0) success = true;
  }
  return success;
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
  try {
    const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
    
    const activeIpBans = db.prepare("SELECT ip,expires FROM banned_ips WHERE expires>?").all(Date.now());
    const activeFpBans = db.prepare("SELECT fp,expires FROM banned_fps WHERE expires>?").all(Date.now());

    // Get reports with enriched data
    const reportsMap = new Map();
    for (const r of db.prepare("SELECT * FROM reports ORDER BY ts DESC").all()) {
      if (!reportsMap.has(r.target)) {
        reportsMap.set(r.target, {
          target: r.target,
          reporters: [],
          count: 0,
          target_ip: r.target_ip,
          target_fp: r.target_fp,
          screenshot: null
        });
      }
      const entry = reportsMap.get(r.target);
      entry.reporters.push(r.reporter);
      entry.count = entry.reporters.length;
    }

    // Add screenshots to each report entry
    for (const [target, data] of reportsMap) {
      const sc = db.prepare("SELECT image FROM screenshots WHERE target=?").get(target);
      if (sc) data.screenshot = sc.image;
    }

    const reportedUsers = Array.from(reportsMap.values());

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
  } catch (error) {
    console.error("[Admin Snapshot Error]", error);
    return {
      stats: { connected: 0, waiting: 0, partnered: 0, totalVisitors: 0, countryCounts: {} },
      activeIpBans: [],
      activeFpBans: [],
      reportedUsers: [],
      recentVisitors: [],
      bannedCountries: [],
      error: error.message
    };
  }
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
    
    const targetIp = userIp.get(partnerId);
    const targetFp = userFingerprint.get(partnerId);
    
    db.prepare("INSERT INTO reports VALUES (?,?,?,?,?)").run(
      partnerId, 
      socket.id,
      targetIp || null,
      targetFp || null,
      Date.now()
    );

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
    try {
      socket.emit("adminUpdate", getAdminSnapshot());
    } catch (error) {
      console.error("[Admin Join Error]", error);
    }
  });
});

// ==================== ADMIN ROUTES ====================

// Main admin redirect
app.get("/admin", requireAuth, (req, res) => {
  res.redirect("/admin/dashboard");
});

function adminHeader(title, username) {
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
  .error-alert{padding:10px;background:#d9534f;color:white;border-radius:6px;margin-bottom:12px}
  .user-info{margin-left:auto;color:#666;display:flex;align-items:center;gap:12px}
  .logout-btn{padding:6px 12px;background:#6c757d;color:white;border-radius:4px;text-decoration:none}
  .code{font-family:monospace;font-size:12px;background:#f4f4f4;padding:2px 4px;border-radius:3px}
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
  <div class="user-info">
    <span>👤 ${username}</span>
    <a href="/admin/logout" class="logout-btn">Logout</a>
  </div>
</div>
`;
}

function adminFooter() {
  return `
<script src="/socket.io/socket.io.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js "></script>
<script>
  const socket = io();
  socket.emit('admin-join');
  socket.on('connect', ()=> socket.emit('admin-join'));
  socket.on('adminUpdate', snap => {
    if (snap.error) {
      console.error('Admin update error:', snap.error);
      alert('خطأ في تحميل البيانات: ' + snap.error);
      return;
    }
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
app.get("/health", (req, res) => {
  res.status(200).json({ 
    status: "ok", 
    timestamp: Date.now(),
    connections: io.of("/").sockets.size,
    memory: process.memoryUsage()
  });
});

// ==================== RENDER: PERIODIC CLEANUP ====================
function cleanupOldData() {
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const deleted = db.prepare("DELETE FROM visitors WHERE ts < ?").run(thirtyDaysAgo);
  console.log(`[Cleanup] Deleted ${deleted.changes} old visitor records`);
  
  const deletedReports = db.prepare("DELETE FROM reports WHERE ts < ?").run(thirtyDaysAgo);
  console.log(`[Cleanup] Deleted ${deletedReports.changes} old report records`);
  
  db.prepare("DELETE FROM banned_ips WHERE expires < ?").run(Date.now());
  db.prepare("DELETE FROM banned_fps WHERE expires < ?").run(Date.now());
}
setInterval(cleanupOldData, 12 * 60 * 60 * 1000);
cleanupOldData();

// ==================== RENDER: MEMORY MONITORING ====================
function logMemoryUsage() {
  const usage = process.memoryUsage();
  console.log(`[Memory] RSS: ${(usage.rss / 1024 / 1024).toFixed(2)}MB | Heap: ${(usage.heapUsed / 1024 / 1024).toFixed(2)}MB`);
}
setInterval(logMemoryUsage, 5 * 60 * 1000);

// ==================== ADMIN PAGES ====================
app.get("/admin/dashboard", requireAuth, (req, res) => {
  const html = adminHeader("Dashboard", req.session.username) + `
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

      <h3>Device Bans</h3>
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
    fetch('/admin-broadcast', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({message: msg})})
      .then(r => {
        if (r.ok) document.getElementById('broadcastMsg').value = '';
        else alert('Failed to send broadcast');
      });
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
    else snap.reportedUsers.slice(0,10).forEach(r => {
      const div = document.createElement('div'); div.className='rep-card';
      div.innerHTML = \`
        <b>Target:</b> <span class="code">\${r.target}</span> — <b>Reports:</b> \${r.count}<br>
        <small>IP: \${r.target_ip || 'N/A'} | FP: \${r.target_fp ? r.target_fp.slice(0,8)+'...' : 'N/A'}</small>
      \`;
      rep.appendChild(div);
    });

    const vis = document.getElementById('visitors-list'); vis.innerHTML='';
    if (snap.recentVisitors.length === 0) vis.textContent = 'No visitors yet';
    else snap.recentVisitors.slice(0,100).forEach(v => {
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

app.get("/admin/countries", requireAuth, (req, res) => {
  const html = adminHeader("Countries", req.session.username) + `
<div class="panel">
  <h3>Block/Unblock Countries</h3>
  <div class="country-list" id="country-list"></div>
  <br>
  <button id="save-countries" class="broadcast">Save Changes</button>
</div>
<script>
  function renderCountries(snap) {
    const cList = document.getElementById('country-list');
    cList.innerHTML = '';
    const bannedSet = new Set(snap.bannedCountries);
    Object.entries(ALL_COUNTRIES).forEach(([code, name]) => {
      const label = document.createElement('label');
      label.className = 'country-item';
      label.innerHTML = \`
        <span><b>\${name}</b> (\${code})</span>
        <input type="checkbox" \${bannedSet.has(code) ? 'checked' : ''} data-code="\${code}">
      \`;
      cList.appendChild(label);
    });
  }

  document.getElementById('save-countries').onclick = () => {
    const checkboxes = document.querySelectorAll('#country-list input[type=checkbox]');
    const banned = Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.dataset.code);
    fetch('/admin-update-countries', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({bannedCountries: banned})
    }).then(r => {
      if (r.ok) alert('Saved');
      else alert('Failed to save');
    });
  };

  function handleAdminUpdate(snap){ renderCountries(snap); }
</script>
` + adminFooter();
  res.send(html);
});

app.get("/admin/stats", requireAuth, (req, res) => {
  const html = adminHeader("Stats", req.session.username) + `
<div class="panel">
  <h3>Visitor Stats (Last 24h)</h3>
  <canvas id="countryChart" height="100"></canvas>
</div>
<script>
  function handleAdminUpdate(snap){
    const ctx = document.getElementById('countryChart').getContext('2d');
    const entries = Object.entries(snap.stats.countryCounts).sort((a,b)=>b[1]-a[1]).slice(0,15);
    const labels = entries.map(e=>COUNTRY_NAME(e[0])||e[0]);
    const data = entries.map(e=>e[1]);
    if (window.myChart) window.myChart.destroy();
    window.myChart = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Visitors', data, backgroundColor: '#007bff' }] },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
    });
  }
</script>
` + adminFooter();
  res.send(html);
});

app.get("/admin/reports", requireAuth, (req, res) => {
  const html = adminHeader("Reports", req.session.username) + `
<div class="panel">
  <h3>All Reports</h3>
  <div id="reports-list"></div>
</div>
<script>
  function handleAdminUpdate(snap){
    const list = document.getElementById('reports-list');
    list.innerHTML = '';
    if (!snap.reportedUsers.length) list.textContent = 'No reports';
    snap.reportedUsers.forEach(r => {
      const card = document.createElement('div'); card.className='rep-card';
      const ipBanBtn = r.target_ip ? \`<button class="ban" onclick="banIp('\${r.target_ip}')">Ban IP</button>\` : '';
      const fpBanBtn = r.target_fp ? \`<button class="ban" onclick="banFp('\${r.target_fp}')">Ban FP</button>\` : '';
      const ipUnbanBtn = r.target_ip ? \`<button class="unban" onclick="unbanIp('\${r.target_ip}')">Unban IP</button>\` : '';
      const fpUnbanBtn = r.target_fp ? \`<button class="unban" onclick="unbanFp('\${r.target_fp}')">Unban FP</button>\` : '';
      
      card.innerHTML = \`
        <b>Target ID:</b> <span class="code">\${r.target}</span><br>
        <b>Reports:</b> \${r.count}<br>
        <b>Reporters:</b> \${r.reporters.join(', ')}<br>
        \${r.target_ip ? '<b>IP:</b> <span class="code">' + r.target_ip + '</span><br>' : ''}
        \${r.target_fp ? '<b>FP:</b> <span class="code">' + r.target_fp.slice(0,16) + '...</span><br>' : ''}
        \${r.screenshot ? '<img class="screenshot-thumb" src="' + r.screenshot + '"><br>' : ''}
        <div style="margin-top:8px;display:flex;gap:8px">
          \${ipBanBtn} \${fpBanBtn} \${ipUnbanBtn} \${fpUnbanBtn}
        </div>
      \`;
      list.appendChild(card);
    });
  }

  function banIp(ip) {
    fetch('/ban-ip', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ip})})
      .then(r => alert(r.ok ? 'IP banned' : 'Failed to ban IP'));
  }
  function banFp(fp) {
    fetch('/ban-fingerprint', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({fp})})
      .then(r => alert(r.ok ? 'FP banned' : 'Failed to ban FP'));
  }
  function unbanIp(ip) {
    fetch('/unban-ip', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ip})})
      .then(r => alert(r.ok ? 'IP unbanned' : 'Failed to unban IP'));
  }
  function unbanFp(fp) {
    fetch('/unban-fingerprint', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({fp})})
      .then(r => alert(r.ok ? 'FP unbanned' : 'Failed to unban FP'));
  }
</script>
` + adminFooter();
  res.send(html);
});

app.get("/admin/bans", requireAuth, (req, res) => {
  const html = adminHeader("Bans", req.session.username) + `
<div class="panel">
  <h3>Manually Ban User</h3>
  <form id="banForm">
    <select id="banType" style="width:100%;padding:8px;margin-bottom:12px">
      <option value="ip">Ban by IP Address</option>
      <option value="fp">Ban by Fingerprint</option>
    </select>
    <input type="text" id="banTarget" placeholder="Enter IP or Fingerprint" style="width:100%;padding:8px">
    <br><br>
    <button class="ban">Ban Now</button>
  </form>
  <br>
  <div id="ban-result" class="small"></div>

  <h3>Manually Unban User</h3>
  <form id="unbanForm">
    <select id="unbanType" style="width:100%;padding:8px;margin-bottom:12px">
      <option value="ip">Unban by IP Address</option>
      <option value="fp">Unban by Fingerprint</option>
    </select>
    <input type="text" id="unbanTarget" placeholder="Enter IP or Fingerprint" style="width:100%;padding:8px">
    <br><br>
    <button class="unban">Unban Now</button>
  </form>
  <br>
  <div id="unban-result" class="small"></div>
</div>
<script>
  document.getElementById('banForm').onsubmit = e => {
    e.preventDefault();
    const type = document.getElementById('banType').value;
    const target = document.getElementById('banTarget').value.trim();
    if (!target) return;
    
    const endpoint = type === 'ip' ? '/ban-ip' : '/ban-fingerprint';
    fetch(endpoint, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({[type]: target})})
      .then(r => {
        document.getElementById('ban-result').textContent = r.ok ? 
          '✅ Banned successfully: ' + target : 
          '❌ Failed to ban';
      });
  };

  document.getElementById('unbanForm').onsubmit = e => {
    e.preventDefault();
    const type = document.getElementById('unbanType').value;
    const target = document.getElementById('unbanTarget').value.trim();
    if (!target) return;
    
    const endpoint = type === 'ip' ? '/unban-ip' : '/unban-fingerprint';
    fetch(endpoint, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({[type]: target})})
      .then(r => {
        document.getElementById('unban-result').textContent = r.ok ? 
          '✅ Unbanned successfully: ' + target : 
          '❌ Failed to unban (may not exist)';
      });
  };
</script>
` + adminFooter();
  res.send(html);
});

// ==================== ADMIN API ENDPOINTS ====================
app.post("/admin-broadcast", requireAuth, (req, res) => {
  const msg = req.body.message;
  if (!msg || typeof msg !== 'string' || msg.trim() === '') return res.status(400).json({error: 'Invalid message'});
  io.emit("broadcast", { message: msg });
  console.log("[Admin] Broadcast sent by", req.session.username, ":", msg);
  res.sendStatus(200);
});

app.post("/unban-ip", requireAuth, (req, res) => {
  const ip = req.body.ip;
  if (!ip || typeof ip !== 'string') return res.status(400).json({error: 'Invalid IP'});
  
  const success = unbanUser(ip, null);
  if (success) {
    console.log(`[Admin] ${req.session.username} unbanned IP:`, ip);
    emitAdminUpdate();
    res.sendStatus(200);
  } else {
    res.status(404).json({error: 'IP not found in ban list'});
  }
});

app.post("/unban-fingerprint", requireAuth, (req, res) => {
  const fp = req.body.fp;
  if (!fp || typeof fp !== 'string') return res.status(400).json({error: 'Invalid fingerprint'});
  
  const success = unbanUser(null, fp);
  if (success) {
    console.log(`[Admin] ${req.session.username} unbanned fingerprint:`, fp);
    emitAdminUpdate();
    res.sendStatus(200);
  } else {
    res.status(404).json({error: 'Fingerprint not found in ban list'});
  }
});

app.post("/admin-update-countries", requireAuth, (req, res) => {
  const banned = Array.isArray(req.body.bannedCountries) ? req.body.bannedCountries : [];
  db.prepare("DELETE FROM banned_countries").run();
  for (const code of banned) {
    if (typeof code === 'string' && code.length === 2) {
      db.prepare("INSERT INTO banned_countries VALUES (?)").run(code);
    }
  }
  console.log(`[Admin] ${req.session.username} updated banned countries:`, banned.length);
  emitAdminUpdate();
  res.sendStatus(200);
});

app.post("/ban-ip", requireAuth, (req, res) => {
  const ip = req.body.ip;
  if (!ip || typeof ip !== 'string' || !ip.match(/^(\d{1,3}\.){3}\d{1,3}$/)) {
    return res.status(400).json({error: 'Invalid IP address format'});
  }
  // Prevent self-banning
  if (ip === req.ip || ip === req.connection.remoteAddress) {
    return res.status(403).json({error: 'Cannot ban your own IP'});
  }
  banUser(ip, null);
  console.log(`[Admin] ${req.session.username} manually banned IP:`, ip);
  emitAdminUpdate();
  res.sendStatus(200);
});

app.post("/ban-fingerprint", requireAuth, (req, res) => {
  const fp = req.body.fp;
  if (!fp || typeof fp !== 'string' || fp.length < 10) {
    return res.status(400).json({error: 'Invalid fingerprint format'});
  }
  banUser(null, fp);
  console.log(`[Admin] ${req.session.username} manually banned fingerprint:`, fp);
  emitAdminUpdate();
  res.sendStatus(200);
});

// DEPRECATED: These endpoints are unreliable due to socket ID volatility
app.post("/ban-id", requireAuth, (req, res) => {
  const id = req.body.id;
  const ip = userIp.get(id);
  const fp = userFingerprint.get(id);
  if (ip || fp) {
    banUser(ip, fp);
    console.log(`[Admin] ${req.session.username} banned user ID:`, id);
    emitAdminUpdate();
    res.sendStatus(200);
  } else {
    res.status(404).json({error: 'User not found or offline'});
  }
});

app.post("/unban-id", requireAuth, (req, res) => {
  const id = req.body.id;
  const ip = userIp.get(id);
  const fp = userFingerprint.get(id);
  if (ip || fp) {
    unbanUser(ip, fp);
    console.log(`[Admin] ${req.session.username} unbanned user ID:`, id);
    emitAdminUpdate();
    res.sendStatus(200);
  } else {
    res.status(404).json({error: 'User not found or offline'});
  }
});

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
  console.log(`[Admin] Default login - Username: admin, Password: changeme123`);
  console.log("⚠️  IMPORTANT: Change the default password after first login!");
  logMemoryUsage();
});
