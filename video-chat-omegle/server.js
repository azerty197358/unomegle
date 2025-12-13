// FULL SERVER — REPORT SYSTEM + LIVE ADMIN PANEL + VISITORS + GEO + Country Blocking + Admin
// SQLITE PERSISTENCE — COMPLETE INTEGRATION
// ENHANCED: Beautiful UI + Fixed messaging + Improved UX

const express = require("express");
const path = require("path");
const geoip = require("geoip-lite");
const Database = require("better-sqlite3");

const app = express();
app.set("trust proxy", true);

const http = require("http").createServer(app);
const io = require("socket.io")(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(__dirname));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ================= ADMIN IP AUTHENTICATION ================= */
const ADMIN_IP = "197.205.203.158"; // ⚠️ CHANGE THIS TO YOUR IP

// Helper function to normalize IP addresses
function normalizeIp(ip) {
  if (!ip) return ip;
  if (ip.startsWith('::ffff:')) {
    return ip.substring(7);
  }
  return ip;
}

function adminAuth(req, res, next) {
  const clientIp = normalizeIp(req.ip);
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
        body { 
          font-family: 'Segoe UI', system-ui, sans-serif; 
          padding: 50px; 
          text-align: center; 
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .error-box { background: rgba(255,255,255,0.1); padding: 40px; border-radius: 20px; backdrop-filter: blur(10px); }
        .error { color: #ff6b6b; font-size: 48px; margin-bottom: 20px; }
        .ip-info { margin-top: 20px; font-family: monospace; background: rgba(0,0,0,0.3); padding: 15px; border-radius: 8px; }
      </style>
    </head>
    <body>
      <div class="error-box">
        <h1 class="error">🚫 Access Denied</h1>
        <p>Admin access restricted to IP: <strong>${ADMIN_IP}</strong></p>
        <div class="ip-info">
          <p>Your IP: <strong>${clientIp}</strong></p>
          <p>Raw IP: <strong>${req.ip}</strong></p>
        </div>
      </div>
    </body>
    </html>
  `);
}

/* ================= SQLITE PERSISTENCE ================= */
const db = new Database("data.db");
db.pragma('journal_mode = WAL');

// Initialize tables
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

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT,
  message TEXT,
  timestamp INTEGER
);
`);

// Create indexes
try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_visitors_ts ON visitors(ts);
    CREATE INDEX IF NOT EXISTS idx_visitors_ip ON visitors(ip);
    CREATE INDEX IF NOT EXISTS idx_visitors_fp ON visitors(fp);
    CREATE INDEX IF NOT EXISTS idx_banned_ips_expires ON banned_ips(expires);
    CREATE INDEX IF NOT EXISTS idx_banned_fps_expires ON banned_fps(expires);
    CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  `);
} catch(e) {
  console.log("Index creation warning:", e.message);
}

// Countries list
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

/* ================= CORE DATA ================= */
const waitingQueue = [];
const partners = new Map();
const userFingerprint = new Map();
const userIp = new Map();
const BAN_DURATION = 24 * 60 * 60 * 1000;
const adminSockets = new Set();

/* ================= PERSISTENCE HELPERS ================= */
function initializeAdminProtection() {
  try {
    const normalizedAdminIp = normalizeIp(ADMIN_IP);
    console.log("=== INITIALIZING ADMIN PROTECTION ===");
    const deleted = db.prepare("DELETE FROM banned_ips WHERE ip=?").run(normalizedAdminIp);
    console.log("Cleared", deleted.changes, "existing admin IP bans");
    console.log("Admin protection initialized successfully");
  } catch(e) {
    console.error("Error initializing admin protection:", e);
  }
}

function isIpBanned(ip) {
  if (!ip) return false;
  const normalizedIp = normalizeIp(ip);
  if (normalizedIp === normalizeIp(ADMIN_IP)) return false;
  
  try {
    const r = db.prepare("SELECT expires FROM banned_ips WHERE ip=?").get(normalizedIp);
    if (!r) return false;
    if (r.expires < Date.now()) {
      db.prepare("DELETE FROM banned_ips WHERE ip=?").run(normalizedIp);
      return false;
    }
    return true;
  } catch(e) {
    console.error("Error in isIpBanned:", e);
    return false;
  }
}

function isFpBanned(fp) {
  if (!fp) return false;
  try {
    const r = db.prepare("SELECT expires FROM banned_fps WHERE fp=?").get(fp);
    if (!r) return false;
    if (r.expires < Date.now()) {
      db.prepare("DELETE FROM banned_fps WHERE fp=?").run(fp);
      return false;
    }
    return true;
  } catch(e) {
    console.error("Error in isFpBanned:", e);
    return false;
  }
}

function banUser(ip, fp) {
  try {
    const exp = Date.now() + BAN_DURATION;
    
    if (ip && normalizeIp(ip) === normalizeIp(ADMIN_IP)) {
      console.warn("⚠️ ATTEMPT TO BAN ADMIN IP BLOCKED:", ip);
      return;
    }
    
    if (ip) {
      const normalizedIp = normalizeIp(ip);
      db.prepare("INSERT OR REPLACE INTO banned_ips VALUES (?,?)").run(normalizedIp, exp);
    }
    if (fp) {
      db.prepare("INSERT OR REPLACE INTO banned_fps VALUES (?,?)").run(fp, exp);
    }
  } catch(e) {
    console.error("❌ Error in banUser:", e);
  }
}

function unbanUser(ip, fp) {
  try {
    if (ip) db.prepare("DELETE FROM banned_ips WHERE ip=?").run(normalizeIp(ip));
    if (fp) db.prepare("DELETE FROM banned_fps WHERE fp=?").run(fp);
  } catch(e) {
    console.error("❌ Error in unbanUser:", e);
  }
}

function getBannedCountries() {
  try {
    return new Set(db.prepare("SELECT code FROM banned_countries").all().map(r => r.code));
  } catch(e) {
    return new Set();
  }
}

function loadCountryCounts() {
  const counts = {};
  const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
  try {
    const rows = db.prepare("SELECT country, COUNT(DISTINCT ip) c FROM visitors WHERE ts > ? AND country IS NOT NULL GROUP BY country").all(twentyFourHoursAgo);
    for (const r of rows) {
      if (r.country) counts[r.country] = r.c;
    }
  } catch(e) {
    console.error("Error in loadCountryCounts:", e);
  }
  return counts;
}

/* ================= ADMIN SNAPSHOT ================= */
function getAdminSnapshot() {
  const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
  
  // Clean expired bans
  try {
    db.prepare("DELETE FROM banned_ips WHERE expires <= ?").run(Date.now());
    db.prepare("DELETE FROM banned_fps WHERE expires <= ?").run(Date.now());
  } catch(e) {
    console.error("Error cleaning expired bans:", e);
  }

  let activeIpBans = [], activeFpBans = [], reportsMap = new Map();

  try {
    activeIpBans = db.prepare("SELECT ip,expires FROM banned_ips ORDER BY expires DESC").all();
    activeFpBans = db.prepare("SELECT fp,expires FROM banned_fps ORDER BY expires DESC").all();
    const reports = db.prepare("SELECT * FROM reports").all();
    for (const r of reports) {
      if (!reportsMap.has(r.target)) reportsMap.set(r.target, []);
      reportsMap.get(r.target).push(r.reporter);
    }
  } catch(e) {
    console.error("Error in getAdminSnapshot:", e);
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

  const recentVisitors = db.prepare(`SELECT ip,fp,country,ts FROM visitors ORDER BY ts DESC LIMIT 500`).all();
  const countryCounts = loadCountryCounts();
  const totalVisitorsResult = db.prepare("SELECT COUNT(DISTINCT ip) c FROM visitors WHERE ts > ?").get(twentyFourHoursAgo);
  const totalVisitors = totalVisitorsResult ? totalVisitorsResult.c : 0;

  return {
    stats: {
      connected: io.of("/").sockets.size,
      waiting: waitingQueue.length,
      partnered: partners.size / 2,
      totalVisitors: totalVisitors,
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
  const snapshot = getAdminSnapshot();
  adminSockets.forEach(socket => {
    try {
      socket.emit("adminUpdate", snapshot);
    } catch(e) {
      console.error("Error emitting to admin socket:", e);
      adminSockets.delete(socket);
    }
  });
}

/* ================= SOCKET.IO ================= */
io.on("connection", socket => {
  const rawIp = socket.handshake.headers["x-forwarded-for"] || socket.handshake.address || "unknown";
  const ip = normalizeIp(rawIp);
  userIp.set(socket.id, ip);

  // NEW: Load and send recent messages to new connections
  socket.on("request-messages", () => {
    try {
      const messages = db.prepare("SELECT sender, message, timestamp FROM messages ORDER BY timestamp DESC LIMIT 50").all();
      socket.emit("message-history", messages.reverse());
    } catch(e) {
      console.error("Error loading messages:", e);
    }
  });

  console.log("🔌 New connection:", {
    socketId: socket.id,
    ip: ip,
    isAdmin: ip === normalizeIp(ADMIN_IP),
    timestamp: new Date().toISOString()
  });

  let country = null;
  const headerCountry = socket.handshake.headers["cf-ipcountry"] || socket.handshake.headers["x-country"];
  if (headerCountry) {
    country = headerCountry.toUpperCase();
  } else {
    try {
      const g = geoip.lookup(ip);
      if (g && g.country) country = g.country;
    } catch(e) {
      country = null;
    }
  }

  // Check banned countries
  if (country && getBannedCountries().has(country)) {
    socket.emit("country-blocked", { message: "🌍 Access restricted in your country", country });
    socket.disconnect();
    return;
  }

  // Check IP ban
  if (ip !== normalizeIp(ADMIN_IP) && isIpBanned(ip)) {
    socket.emit("banned", { message: "🚫 Your IP is banned" });
    socket.disconnect(true);
    return;
  }

  // Log visitor
  const ts = Date.now();
  try {
    db.prepare("INSERT INTO visitors VALUES (?,?,?,?)").run(ip, null, country, ts);
  } catch(e) {
    console.error("❌ Error inserting visitor:", e);
  }

  // Admin connection
  if (ip === normalizeIp(ADMIN_IP)) {
    adminSockets.add(socket);
    socket.emit("adminUpdate", getAdminSnapshot());
    socket.emit("adminMessage", "🔐 Admin connection established");
  }

  socket.on("identify", ({ fingerprint }) => {
    if (!fingerprint) return;
    userFingerprint.set(socket.id, fingerprint);
    
    try {
      db.prepare(`UPDATE visitors SET fp=? WHERE ip=? AND ts=?`).run(fingerprint, ip, ts);
    } catch(e) {
      console.error("❌ Error updating fingerprint:", e);
    }

    if (isFpBanned(fingerprint)) {
      socket.emit("banned", { message: "🚫 Device banned" });
      socket.disconnect(true);
      return;
    }

    emitAdminUpdate();
  });

  socket.on("find-partner", () => {
    const fp = userFingerprint.get(socket.id);
    if (fp && isFpBanned(fp)) {
      socket.emit("banned", { message: "🚫 Device banned" });
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
      const socketA = io.sockets.sockets.get(a);
      const socketB = io.sockets.sockets.get(b);
      if (!socketA || !socketB) continue;
      partners.set(a, b);
      partners.set(b, a);
      socketA.emit("partner-found", { id: b, initiator: true });
      socketB.emit("partner-found", { id: a, initiator: false });
    }
  }

  socket.on("signal", ({ to, data }) => {
    io.to(to).emit("signal", { from: socket.id, data });
  });

  // FIXED: Chat message handler with persistence
  socket.on("chat-message", ({ to, message, sender }) => {
    // Save message to DB
    try {
      db.prepare("INSERT INTO messages (sender, message, timestamp) VALUES (?,?,?)")
        .run(sender || socket.id, message, Date.now());
    } catch(e) {
      console.error("❌ Error saving message:", e);
    }
    
    io.to(to).emit("chat-message", { message, sender: sender || socket.id });
  });

  socket.on("admin-screenshot", ({ image, partnerId }) => {
    if (!image || !partnerId) return;
    try {
      db.prepare("INSERT OR REPLACE INTO screenshots VALUES (?,?)").run(partnerId, image);
    } catch(e) {
      console.error("❌ Error saving screenshot:", e);
    }
    emitAdminUpdate();
  });

  socket.on("report", ({ partnerId }) => {
    if (!partnerId) return;
    try {
      db.prepare("INSERT INTO reports VALUES (?,?)").run(partnerId, socket.id);
      const count = db.prepare("SELECT COUNT(*) c FROM reports WHERE target=?").get(partnerId).c;

      if (count >= 3) {
        const ip2 = userIp.get(partnerId);
        const fp2 = userFingerprint.get(partnerId);
        banUser(ip2, fp2);
        const s = io.sockets.sockets.get(partnerId);
        if (s) {
          s.emit("banned", { message: "🔨 Banned by community reports" });
          s.disconnect(true);
        }
      }
    } catch(e) {
      console.error("❌ Error in report:", e);
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
    
    const wasAdmin = adminSockets.delete(socket);
    
    emitAdminUpdate();
  });

  socket.on("admin-join", () => {
    adminSockets.add(socket);
    socket.emit("adminUpdate", getAdminSnapshot());
    socket.emit("adminMessage", "🔐 Admin session reconnected");
  });

  socket.on("error", (err) => {
    console.error("❌ Socket error:", socket.id, err);
  });
});

/* ================= ADMIN ROUTES ================= */
app.get("/admin", adminAuth, (req, res) => {
  res.redirect("/admin/dashboard");
});

// NEW: Get recent messages API
app.get("/admin/messages", adminAuth, (req, res) => {
  try {
    const messages = db.prepare("SELECT * FROM messages ORDER BY timestamp DESC LIMIT 100").all();
    res.json({ messages });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

function adminHeader(title) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>لوحة الإدية - ${title}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🛡️</text></svg>">
<style>
  :root {
    --primary: #6366f1;
    --primary-dark: #4f46e5;
    --success: #10b981;
    --danger: #ef4444;
    --warning: #f59e0b;
    --dark: #1f2937;
    --gray: #6b7280;
    --light: #f9fafb;
    --card-bg: #ffffff;
    --shadow: 0 4px 6px -1px rgba(0,0,0,0.1);
    --shadow-lg: 0 20px 25px -5px rgba(0,0,0,0.1);
    --radius: 12px;
  }
  
  * { box-sizing: border-box; margin: 0; padding: 0; }
  
  body {
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    min-height: 100vh;
    color: var(--dark);
    padding: 20px;
  }
  
  .container {
    max-width: 1400px;
    margin: 0 auto;
    background: var(--card-bg);
    border-radius: var(--radius);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
  }
  
  .header {
    background: linear-gradient(135deg, var(--primary), var(--primary-dark));
    color: white;
    padding: 25px 30px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 15px;
  }
  
  .header h1 {
    font-size: 28px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  
  .admin-badge {
    background: rgba(255,255,255,0.2);
    padding: 6px 12px;
    border-radius: 20px;
    font-size: 13px;
    font-family: monospace;
  }
  
  .nav-tabs {
    display: flex;
    background: var(--light);
    padding: 0 20px;
    border-bottom: 2px solid #e5e7eb;
    overflow-x: auto;
    gap: 5px;
  }
  
  .tab {
    padding: 16px 24px;
    text-decoration: none;
    color: var(--gray);
    border-bottom: 3px solid transparent;
    transition: all 0.3s ease;
    font-weight: 500;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  
  .tab.active, .tab:hover {
    color: var(--primary);
    border-bottom-color: var(--primary);
  }
  
  .content {
    padding: 30px;
  }
  
  .error-banner {
    background: var(--danger);
    color: white;
    padding: 15px 20px;
    border-radius: 8px;
    margin-bottom: 20px;
    display: none;
    animation: slideDown 0.3s ease;
  }
  
  @keyframes slideDown {
    from { opacity: 0; transform: translateY(-10px); }
    to { opacity: 1; transform: translateY(0); }
  }
  
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 24px;
    margin-bottom: 24px;
  }
  
  .card {
    background: var(--card-bg);
    border-radius: var(--radius);
    padding: 24px;
    box-shadow: var(--shadow);
    border: 1px solid #e5e7eb;
    transition: transform 0.2s ease;
  }
  
  .card:hover {
    transform: translateY(-2px);
  }
  
  .card h3 {
    color: var(--dark);
    margin-bottom: 18px;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 18px;
  }
  
  .stat {
    font-size: 32px;
    font-weight: 700;
    color: var(--primary);
    display: block;
    margin: 10px 0;
  }
  
  .stat-label {
    font-size: 14px;
    color: var(--gray);
  }
  
  button {
    padding: 10px 18px;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 500;
    transition: all 0.2s ease;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  
  button:hover {
    transform: scale(1.03);
  }
  
  .btn-primary { background: var(--primary); color: white; }
  .btn-success { background: var(--success); color: white; }
  .btn-danger { background: var(--danger); color: white; }
  .btn-warning { background: var(--warning); color: white; }
  
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  }
  
  th, td {
    padding: 12px;
    border-bottom: 1px solid #e5e7eb;
    text-align: left;
  }
  
  th {
    background: var(--light);
    font-weight: 600;
    color: var(--dark);
  }
  
  tr:hover {
    background: #f9fafb;
  }
  
  input, textarea, select {
    width: 100%;
    padding: 12px;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    font-family: inherit;
    font-size: 14px;
    transition: border-color 0.2s;
  }
  
  input:focus, textarea:focus {
    outline: none;
    border-color: var(--primary);
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
  }
  
  textarea {
    resize: vertical;
    min-height: 100px;
  }
  
  .badge {
    padding: 4px 10px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 600;
    display: inline-block;
  }
  
  .badge-success { background: #d1fae5; color: #065f46; }
  .badge-danger { background: #fee2e2; color: #991b1b; }
  .badge-warning { background: #fef3c7; color: #92400e; }
  
  .screenshot-thumb {
    max-width: 160px;
    max-height: 100px;
    border-radius: 8px;
    border: 2px solid #e5e7eb;
    cursor: pointer;
    transition: transform 0.2s;
  }
  
  .screenshot-thumb:hover {
    transform: scale(1.05);
  }
  
  .country-list {
    max-height: 420px;
    overflow: auto;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 10px;
  }
  
  .country-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px;
    border-bottom: 1px solid #f3f4f6;
  }
  
  .country-item:last-child {
    border-bottom: none;
  }
  
  .flex-between {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
  }
  
  .text-muted {
    color: var(--gray);
    font-size: 13px;
  }
  
  @media (max-width: 768px) {
    .grid { grid-template-columns: 1fr; }
    .nav-tabs { flex-wrap: wrap; }
    .header { flex-direction: column; text-align: center; }
  }
  
  .toast {
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: var(--dark);
    color: white;
    padding: 16px 24px;
    border-radius: 8px;
    box-shadow: var(--shadow-lg);
    display: none;
    animation: slideUp 0.3s ease;
    z-index: 1000;
  }
  
  @keyframes slideUp {
    from { opacity: 0; transform: translateY(20px); }
    to { opacity: 1; transform: translateY(0); }
  }
  
  .loading {
    display: inline-block;
    width: 20px;
    height: 20px;
    border: 3px solid #f3f3f3;
    border-top: 3px solid var(--primary);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>🛡️ لوحة الإدارة - ${title}</h1>
    <div class="admin-badge">Admin IP: ${ADMIN_IP}</div>
  </div>
  
  <div class="nav-tabs" id="tabs">
    <a class="tab" href="/admin/dashboard">📊 Dashboard</a>
    <a class="tab" href="/admin/countries">🌍 Countries</a>
    <a class="tab" href="/admin/stats">📈 Stats</a>
    <a class="tab" href="/admin/reports">🚨 Reports</a>
    <a class="tab" href="/admin/bans">🚫 Bans</a>
  </div>
  
  <div class="content">
    <div class="error-banner" id="errorBanner"></div>
`;
}

function adminFooter() {
  return `
  </div>
</div>

<div class="toast" id="toast"></div>

<script src="/socket.io/socket.io.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script>
  const socket = io({ reconnection: true, reconnectionDelay: 1000 });
  
  // Toast notification system
  function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.style.background = type === 'success' ? 'var(--success)' : 
                            type === 'error' ? 'var(--danger)' : 'var(--dark)';
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 4000);
  }
  
  socket.on('connect', ()=> {
    console.log('✅ Connected to server');
    socket.emit('admin-join');
    showToast('🔌 Connected to admin panel', 'success');
  });
  
  socket.on('disconnect', ()=> {
    showToast('⚠️ Disconnected from server', 'error');
  });
  
  socket.on('adminUpdate', snap => {
    if (typeof handleAdminUpdate === 'function') {
      try {
        handleAdminUpdate(snap);
      } catch(e) {
        console.error('❌ Error in handleAdminUpdate:', e);
        showToast('Error updating data', 'error');
      }
    }
  });
  
  socket.on('adminMessage', (msg) => {
    console.log('📢 Admin message:', msg);
    showToast(msg, 'info');
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
<div class="grid">
  <div class="card">
    <h3>📊 Live Stats</h3>
    <div class="stat-label">Connected Users</div>
    <span id="stat-connected" class="stat">0</span>
    
    <div class="stat-label">Waiting Queue</div>
    <span id="stat-waiting" class="stat">0</span>
    
    <div class="stat-label">Active Pairs</div>
    <span id="stat-partnered" class="stat">0</span>
    
    <div class="stat-label">Visitors (24h)</div>
    <span id="stat-totalvisitors" class="stat">0</span>
    
    <h4 style="margin-top: 20px;">📍 By Country (24h)</h4>
    <div id="country-list" class="text-muted" style="max-height: 150px; overflow: auto;"></div>
  </div>

  <div class="card">
    <h3>📢 Broadcast Message</h3>
    <form id="broadcastForm">
      <textarea id="broadcastMsg" placeholder="اكتب رسالتك هنا..."></textarea>
      <button type="submit" class="btn-primary" style="margin-top: 10px; width: 100%;">
        <span>📡</span> Send Broadcast
      </button>
    </form>
    
    <h3 style="margin-top: 24px;">🚫 Active Bans</h3>
    <div id="active-bans-info" class="text-muted">Loading...</div>
  </div>
</div>

<div class="grid">
  <div class="card">
    <h3>🚨 Reported Users</h3>
    <div id="reported-list" class="text-muted">No reports</div>
  </div>
  
  <div class="card">
    <h3>👥 Recent Visitors</h3>
    <div id="visitors-list" style="max-height: 300px; overflow: auto;" class="text-muted">Loading...</div>
  </div>
</div>

<script>
  document.getElementById('broadcastForm').onsubmit = async e => {
    e.preventDefault();
    const msg = document.getElementById('broadcastMsg').value.trim();
    if (!msg) return;
    
    try {
      const response = await fetch('/admin-broadcast', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({message: msg})
      });
      const data = await response.json();
      if (data.ok) {
        document.getElementById('broadcastMsg').value = '';
        showToast('✅ Broadcast sent successfully', 'success');
      }
    } catch(err) {
      showToast('❌ Broadcast failed', 'error');
    }
  };

  function handleAdminUpdate(snap) {
    // Stats
    document.getElementById('stat-connected').textContent = snap.stats.connected || 0;
    document.getElementById('stat-waiting').textContent = snap.stats.waiting || 0;
    document.getElementById('stat-partnered').textContent = snap.stats.partnered || 0;
    document.getElementById('stat-totalvisitors').textContent = snap.stats.totalVisitors || 0;

    // Countries
  const cl = document.getElementById('country-list');
  const entries = Object.entries(snap.stats.countryCounts || {});
  if (entries.length === 0) {
    cl.textContent = 'No data (24h)';
  } else {
    cl.innerHTML = entries.sort((a,b)=>b[1]-a[1])
      .map(([country, cnt]) => '<div>' + COUNTRY_NAME(country) + ': <strong>' + cnt + '</strong></div>')
      .join('');
  }

    // Active bans count
    const ipCount = snap.activeIpBans?.length || 0;
    const fpCount = snap.activeFpBans?.length || 0;
    document.getElementById('active-bans-info').innerHTML = 
      `<span class="badge badge-danger">IP Bans: ${ipCount}</span> 
       <span class="badge badge-warning" style="margin-left: 8px;">Device Bans: ${fpCount}</span>`;

    // Reports
    const rep = document.getElementById('reported-list');
    if (!snap.reportedUsers?.length) {
      rep.textContent = 'No reports';
    } else {
      rep.innerHTML = snap.reportedUsers.map(r => `
        <div style="padding: 10px; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 8px;">
          <div class="flex-between">
            <strong>${r.target}</strong>
            <span class="badge badge-danger">${r.count} reports</span>
          </div>
        </div>
      `).join('');
    }

    // Visitors
    const vis = document.getElementById('visitors-list');
    if (!snap.recentVisitors?.length) {
      vis.textContent = 'No visitors';
    } else {
      vis.innerHTML = snap.recentVisitors.slice(0, 50).map(v => `
        <div style="padding: 8px 0; border-bottom: 1px solid #f3f4f6;">
          <div><strong>${v.ip}</strong> <span class="badge" style="background: #e0e7ff; color: #3730a3;">${v.country || 'Unknown'}</span></div>
          <div class="text-muted">${new Date(v.ts).toLocaleString()}</div>
        </div>
      `).join('');
    }
  }
</script>
` + adminFooter();
  res.send(html);
});

// Countries page
app.get("/admin/countries", adminAuth, (req, res) => {
  const html = adminHeader("Countries") + `
<div class="card">
  <h3>🌍 Country Blocking</h3>
  <div style="display: grid; grid-template-columns: 1fr 300px; gap: 24px; margin-top: 20px;">
    <div>
      <h4>All Countries</h4>
      <div class="country-list" id="all-countries">
        <div class="loading"></div>
      </div>
    </div>
    <div>
      <h4>Blocked Countries</h4>
      <div id="blocked-countries" style="border: 1px solid #e5e7eb; border-radius: 8px; padding: 15px; min-height: 120px;">
        <span class="text-muted">Loading...</span>
      </div>
      <button id="clear-blocks" class="btn-danger" style="margin-top: 15px; width: 100%;">
        <span>🗑️</span> Clear All Blocks
      </button>
    </div>
  </div>
  <div class="text-muted" style="margin-top: 15px;">
    💡 Tip: Blocking a country will prevent all users from that country from accessing the service
  </div>
</div>

<script>
  async function loadCountries() {
    try {
      const res = await fetch('/admin/countries-list');
      const data = await res.json();
      
      // All countries
      const container = document.getElementById('all-countries');
      const codes = Object.keys(ALL_COUNTRIES).sort((a,b)=>ALL_COUNTRIES[a].localeCompare(ALL_COUNTRIES[b]));
      
      container.innerHTML = codes.map(code => `
        <div class="country-item">
          <div style="display: flex; align-items: center; gap: 10px;">
            <input type="checkbox" id="cb-${code}" ${data.banned.includes(code) ? 'checked' : ''} 
                   onchange="toggleCountry('${code}')" style="width: auto;">
            <label for="cb-${code}"><strong>${code}</strong> — ${ALL_COUNTRIES[code]}</label>
          </div>
          <button class="${data.banned.includes(code) ? 'btn-success' : 'btn-danger'}" 
                  onclick="toggleCountry('${code}')" style="padding: 6px 12px; font-size: 12px;">
            ${data.banned.includes(code) ? '✅ Unblock' : '⛔ Block'}
          </button>
        </div>
      `).join('');
      
      // Blocked list
      const bc = document.getElementById('blocked-countries');
      if (data.banned.length === 0) {
        bc.innerHTML = '<span class="text-muted">No blocked countries</span>';
      } else {
        bc.innerHTML = data.banned.map(c => 
          `<div style="padding: 8px;"><strong>${c}</strong> — ${COUNTRY_NAME(c)}</div>`
        ).join('');
      }
    } catch(e) {
      showToast('❌ Error loading countries', 'error');
    }
  }
  
  async function toggleCountry(code) {
    const res = await fetch('/admin/block-country', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ code })
    });
    const data = await res.json();
    if (!data.ok) showToast('❌ Operation failed', 'error');
  }
  
  document.getElementById('clear-blocks').onclick = async () => {
    if (!confirm('⚠️ Clear all blocked countries?')) return;
    const res = await fetch('/admin/clear-blocked', {method: 'POST'});
    const data = await res.json();
    if (data.ok) {
      showToast('✅ All blocks cleared', 'success');
      loadCountries();
    }
  };
  
  loadCountries();
  socket.on('adminUpdate', loadCountries);
</script>
` + adminFooter();
  res.send(html);
});

// Stats page
app.get("/admin/stats", adminAuth, (req, res) => {
  const html = adminHeader("Stats") + `
<div class="card">
  <h3>📈 Analytics Dashboard</h3>
  <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 24px; margin-top: 20px;">
    <div>
      <canvas id="visitorsChart" height="100"></canvas>
    </div>
    <div>
      <h4>By Country (24h)</h4>
      <canvas id="countryChart" height="200"></canvas>
      <div style="margin-top: 20px;">
        <label>From: <input type="date" id="fromDate" style="margin-left: 8px;"></label><br><br>
        <label>To: <input type="date" id="toDate" style="margin-left: 23px;"></label><br><br>
        <button id="refreshStats" class="btn-primary" style="width: 100%;">🔄 Refresh</button>
      </div>
    </div>
  </div>
  
  <h4 style="margin-top: 24px;">Recent Visitors</h4>
  <div id="stat-visitors-list" style="max-height: 300px; overflow: auto; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px;">
    <span class="text-muted">Loading...</span>
  </div>
</div>

<script>
  let visitorsChart = null, countryChart = null;
  
  async function loadStats() {
    try {
      const from = document.getElementById('fromDate').value;
      const to = document.getElementById('toDate').value;
      const params = new URLSearchParams();
      if (from) params.append('from', from);
      if (to) params.append('to', to);
      
      const res = await fetch('/admin/stats-data?' + params);
      const data = await res.json();
      
      // Visitors chart
      const ctx = document.getElementById('visitorsChart').getContext('2d');
      if (visitorsChart) visitorsChart.destroy();
      visitorsChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: data.daily.map(d => d.date),
          datasets: [{
            label: 'Daily Visitors',
            data: data.daily.map(d => d.count),
            borderColor: '#6366f1',
            backgroundColor: 'rgba(99, 102, 241, 0.1)',
            tension: 0.4,
            fill: true
          }]
        },
        options: {
          responsive: true,
          plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true } }
        }
      });
      
      // Country chart
      const ctx2 = document.getElementById('countryChart').getContext('2d');
      if (countryChart) countryChart.destroy();
      countryChart = new Chart(ctx2, {
        type: 'doughnut',
        data: {
          labels: data.countries.slice(0, 8).map(c => COUNTRY_NAME(c.country)),
          datasets: [{
            data: data.countries.slice(0, 8).map(c => c.count),
            backgroundColor: ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316']
          }]
        },
        options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
      });
      
      // Recent visitors
      const list = document.getElementById('stat-visitors-list');
      list.innerHTML = data.recent.slice(0, 30).map(v => `
        <div style="padding: 10px; border-bottom: 1px solid #f3f4f6;">
          <div class="flex-between">
            <strong>${v.ip}</strong>
            <span class="badge" style="background: #e0e7ff; color: #3730a3;">${v.country || 'Unknown'}</span>
          </div>
          <div class="text-muted">${new Date(v.ts).toLocaleString()}</div>
        </div>
      `).join('');
    } catch(e) {
      showToast('❌ Error loading stats', 'error');
    }
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
<div class="card">
  <h3>🚨 User Reports</h3>
  <div id="reports-panel" style="margin-top: 20px;">
    <span class="text-muted">Loading reports...</span>
  </div>
</div>

<script>
  function handleAdminUpdate(snap) {
    const container = document.getElementById('reports-panel');
    if (!snap.reportedUsers?.length) {
      container.innerHTML = '<span class="text-muted">No reports</span>';
      return;
    }
    
    container.innerHTML = snap.reportedUsers.map(r => `
      <div style="border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 15px;">
        <div class="flex-between" style="margin-bottom: 15px;">
          <div>
            <strong style="font-size: 18px;">${r.target}</strong>
            <span class="badge badge-danger" style="margin-left: 10px;">${r.count} reports</span>
          </div>
          <div>
            <button class="btn-danger" onclick="banUser('${r.target}')">
              <span>🔨</span> Ban User
            </button>
            <button class="btn-warning" onclick="removeReport('${r.target}')" style="margin-left: 8px;">
              <span>🗑️</span> Remove
            </button>
          </div>
        </div>
        
        ${r.screenshot ? 
          `<div style="margin: 15px 0;"><img src="${r.screenshot}" class="screenshot-thumb" onclick="window.open('${r.screenshot}', '_blank')"></div>` : 
          '<div class="text-muted">No screenshot</div>'}
        
        <div class="text-muted">Reporters: ${r.reporters?.join(', ') || '—'}</div>
      </div>
    `).join('');
  }
  
  async function banUser(target) {
    if (!confirm('⚠️ Ban user ' + target + '?')) return;
    const res = await fetch('/manual-ban', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ target })
    });
    const data = await res.json();
    if (data.ok) showToast('✅ User banned successfully', 'success');
  }
  
  async function removeReport(target) {
    if (!confirm('⚠️ Remove report for ' + target + '?')) return;
    const res = await fetch('/remove-report', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ target })
    });
    const data = await res.json();
    if (data.ok) showToast('✅ Report removed', 'success');
  }
</script>
` + adminFooter();
  res.send(html);
});

// Bans page
app.get("/admin/bans", adminAuth, (req, res) => {
  const html = adminHeader("Bans") + `
<div class="grid">
  <div class="card">
    <h3>🌐 IP Bans</h3>
    <div id="ip-bans-list" class="text-muted">Loading IP bans...</div>
  </div>
  
  <div class="card">
    <h3>📱 Device Bans</h3>
    <div id="fp-bans-list" class="text-muted">Loading device bans...</div>
  </div>
</div>

<script>
  function handleAdminUpdate(snap) {
    // IP Bans
    const ipList = document.getElementById('ip-bans-list');
    if (!snap.activeIpBans?.length) {
      ipList.innerHTML = '<span class="text-muted">No IP bans</span>';
    } else {
      ipList.innerHTML = snap.activeIpBans.map(b => `
        <div style="padding: 12px; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 8px;">
          <div class="flex-between">
            <div>
              <strong>${b.ip}</strong>
              <div class="text-muted">Expires: ${new Date(b.expires).toLocaleString()}</div>
            </div>
            <button class="btn-success" onclick="unbanIp('${b.ip}')">✅ Unban</button>
          </div>
        </div>
      `).join('');
    }
    
    // FP Bans
    const fpList = document.getElementById('fp-bans-list');
    if (!snap.activeFpBans?.length) {
      fpList.innerHTML = '<span class="text-muted">No device bans</span>';
    } else {
      fpList.innerHTML = snap.activeFpBans.map(b => `
        <div style="padding: 12px; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 8px;">
          <div class="flex-between">
            <div>
              <strong>${b.fp.substring(0, 20)}...</strong>
              <div class="text-muted">Expires: ${new Date(b.expires).toLocaleString()}</div>
            </div>
            <button class="btn-success" onclick="unbanFp('${b.fp}')">✅ Unban</button>
          </div>
        </div>
      `).join('');
    }
  }
  
  async function unbanIp(ip) {
    const res = await fetch('/unban-ip', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ ip })
    });
    const data = await res.json();
    if (data.ok) showToast('✅ IP unbanned', 'success');
  }
  
  async function unbanFp(fp) {
    const res = await fetch('/unban-fingerprint', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ fp })
    });
    const data = await res.json();
    if (data.ok) showToast('✅ Device unbanned', 'success');
  }
</script>
` + adminFooter();
  res.send(html);
});

/* ================= ADMIN API ENDPOINTS ================= */
app.get("/admin/countries-list", adminAuth, (req, res) => {
  try {
    res.json({ all: Object.keys(COUNTRIES), banned: Array.from(getBannedCountries()) });
  } catch(e) {
    res.status(500).json({ error: "Internal error" });
  }
});

app.post("/admin/block-country", adminAuth, (req, res) => {
  try {
    const code = (req.body.code || "").toUpperCase();
    if (!code || !COUNTRIES[code]) return res.status(400).json({ error: "Invalid country code" });
    db.prepare("INSERT OR REPLACE INTO banned_countries VALUES (?)").run(code);
    showToast('🌍 Country ' + code + ' blocked', 'success');
    emitAdminUpdate();
    res.json({ ok: true, banned: Array.from(getBannedCountries()) });
  } catch(e) {
    res.status(500).json({ error: "Internal error" });
  }
});

app.post("/admin/unblock-country", adminAuth, (req, res) => {
  try {
    const code = (req.body.code || "").toUpperCase();
    db.prepare("DELETE FROM banned_countries WHERE code=?").run(code);
    emitAdminUpdate();
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: "Internal error" });
  }
});

app.post("/admin/clear-blocked", adminAuth, (req, res) => {
  try {
    db.prepare("DELETE FROM banned_countries").run();
    emitAdminUpdate();
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: "Internal error" });
  }
});

app.get("/admin/stats-data", adminAuth, (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;
    
    const dailyMap = new Map();
    const visitors = db.prepare("SELECT * FROM visitors").all();
    for (const v of visitors) {
      const t = new Date(v.ts);
      if (from && t < from) continue;
      if (to && t > new Date(to.getTime() + 24*3600*1000 -1)) continue;
      const key = t.toISOString().slice(0,10);
      dailyMap.set(key, (dailyMap.get(key)||0) + 1);
    }
    const daily = Array.from(dailyMap.entries())
      .sort((a,b)=>a[0].localeCompare(b[0]))
      .map(([date,count]) => ({date,count}));

    const countries = db.prepare(
      "SELECT country, COUNT(DISTINCT ip) c FROM visitors WHERE country IS NOT NULL AND ts > ? GROUP BY country ORDER BY c DESC LIMIT 50"
    ).all(Date.now() - (24 * 60 * 60 * 1000))
    .map(r => ({country: r.country, count: r.c}));

    const recent = db.prepare("SELECT ip,fp,country,ts FROM visitors ORDER BY ts DESC LIMIT 500").all();

    res.send({ daily, countries, recent });
  } catch(e) {
    res.status(500).send({ error: "Internal error" });
  }
});

app.post("/admin-broadcast", adminAuth, (req, res) => {
  try {
    const msg = req.body.message?.trim();
    if (msg) {
      io.emit("adminMessage", msg);
      console.log("📢 Broadcast:", msg);
    }
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: "Internal error" });
  }
});

app.post("/unban-ip", adminAuth, (req, res) => {
  try {
    const ip = req.body.ip;
    if (!ip) return res.status(400).json({ error: "IP required" });
    unbanUser(ip, null);
    emitAdminUpdate();
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: "Internal error" });
  }
});

app.post("/unban-fingerprint", adminAuth, (req, res) => {
  try {
    const fp = req.body.fp;
    if (!fp) return res.status(400).json({ error: "Fingerprint required" });
    unbanUser(null, fp);
    emitAdminUpdate();
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: "Internal error" });
  }
});

app.post("/manual-ban", adminAuth, (req, res) => {
  try {
    const target = req.body.target;
    if (!target) return res.status(400).json({ error: "Target required" });
    const ip = userIp.get(target);
    const fp = userFingerprint.get(target);
    banUser(ip, fp);
    const s = io.sockets.sockets.get(target);
    if (s) {
      s.emit("banned", { message: "🔨 Banned by admin" });
      s.disconnect(true);
    }
    emitAdminUpdate();
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: "Internal error" });
  }
});

app.post("/remove-report", adminAuth, (req, res) => {
  try {
    const target = req.body.target;
    if (!target) return res.status(400).json({ error: "Target required" });
    db.prepare("DELETE FROM reports WHERE target=?").run(target);
    db.prepare("DELETE FROM screenshots WHERE target=?").run(target);
    emitAdminUpdate();
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: "Internal error" });
  }
});

/* ================= START SERVER ================= */
const PORT = process.env.PORT || 3000;
initializeAdminProtection();

http.listen(PORT, () => {
  console.log("===========================================");
  console.log("🚀 Server running on port " + PORT);
  console.log("👑 Admin IP: " + ADMIN_IP);
  console.log("📊 Admin Panel: http://localhost:" + PORT + "/admin");
  console.log("===========================================");
});

