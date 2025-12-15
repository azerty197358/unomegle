const express = require("express");
const path = require("path");
const fs = require("fs");
const basicAuth = require("express-basic-auth");
const geoip = require("geoip-lite");
const Database = require("better-sqlite3");

const app = express();
app.set("trust proxy", true);

const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static(__dirname));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const ADMIN_USERS = { admin: "admin" };
const adminAuth = basicAuth({
  users: ADMIN_USERS,
  challenge: true,
  realm: "Admin Area",
});

// --- SQLite Database Setup ---
const DB_PATH = path.join(__dirname, "chat.db");
const db = new Database(DB_PATH);

// Initialize schema
db.exec(`
CREATE TABLE IF NOT EXISTS visitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL,
  ip TEXT NOT NULL,
  country TEXT,
  first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_visitors_fp_ip ON visitors(fingerprint, ip);
CREATE INDEX IF NOT EXISTS idx_visitors_time ON visitors(last_seen);

CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id INTEGER,
  socket_id TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (visitor_id) REFERENCES visitors(id)
);

CREATE TABLE IF NOT EXISTS country_stats (
  date DATE NOT NULL,
  country TEXT NOT NULL,
  unique_count INTEGER DEFAULT 0,
  PRIMARY KEY (date, country)
);

CREATE TABLE IF NOT EXISTS reports (
  target_id TEXT NOT NULL,
  reporter_id TEXT NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  screenshot TEXT,
  PRIMARY KEY (target_id, reporter_id)
);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_id);

CREATE TABLE IF NOT EXISTS bans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT CHECK(type IN ('ip', 'fingerprint')) NOT NULL,
  value TEXT NOT NULL,
  expiry DATETIME NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bans_type_value ON bans(type, value);
CREATE INDEX IF NOT EXISTS idx_bans_expiry ON bans(expiry);

CREATE TABLE IF NOT EXISTS banned_countries (
  code TEXT PRIMARY KEY
);

-- Cleanup old data (older than 30 days)
DELETE FROM visits WHERE timestamp < datetime('now', '-30 days');
DELETE FROM visitors WHERE last_seen < datetime('now', '-30 days');
DELETE FROM reports WHERE timestamp < datetime('now', '-30 days');
`);

// --- Core application state (only for real-time session management) ---
const waitingQueue = [];
const partners = new Map(); // socket.id -> partnerId
const userFingerprint = new Map(); // socket.id -> fingerprint
const userIp = new Map(); // socket.id -> ip

// --- Database helper functions ---

// Check if visitor is unique in last 24h
function getOrCreateVisitor(fingerprint, ip, country) {
  const stmt = db.prepare(`
    SELECT id FROM visitors 
    WHERE fingerprint = ? AND ip = ? AND last_seen > datetime('now', '-24 hours')
  `);
  let visitor = stmt.get(fingerprint, ip);
  
  if (visitor) {
    // Update last_seen
    db.prepare("UPDATE visitors SET last_seen = CURRENT_TIMESTAMP WHERE id = ?").run(visitor.id);
    return visitor.id;
  } else {
    // Create new visitor
    const result = db.prepare(
      "INSERT INTO visitors (fingerprint, ip, country) VALUES (?, ?, ?)"
    ).run(fingerprint, ip, country);
    
    // Increment country stats for today
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`
      INSERT INTO country_stats (date, country, unique_count)
      VALUES (?, ?, 1)
      ON CONFLICT(date, country) DO UPDATE SET unique_count = unique_count + 1
    `).run(today, country || 'Unknown');
    
    return result.lastInsertRowid;
  }
}

function getActiveBans() {
  const now = new Date().toISOString();
  const ipBans = db.prepare(
    "SELECT value as ip, expiry FROM bans WHERE type = 'ip' AND expiry > ?"
  ).all(now);
  
  const fpBans = db.prepare(
    "SELECT value as fp, expiry FROM bans WHERE type = 'fingerprint' AND expiry > ?"
  ).all(now);
  
  return { ipBans, fpBans };
}

function isBanned(type, value) {
  if (!value) return false;
  const now = new Date().toISOString();
  const ban = db.prepare(
    "SELECT expiry FROM bans WHERE type = ? AND value = ? AND expiry > ?"
  ).get(type, String(value), now);
  return !!ban;
}

function addBan(type, value, hours = 24) {
  if (!value) return;
  const expiry = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  db.prepare(
    "INSERT OR REPLACE INTO bans (type, value, expiry) VALUES (?, ?, ?)"
  ).run(type, String(value), expiry);
}

function removeBan(type, value) {
  db.prepare("DELETE FROM bans WHERE type = ? AND value = ?").run(type, value);
}

function addReport(targetId, reporterId, screenshot = null) {
  try {
    db.prepare(
      "INSERT OR IGNORE INTO reports (target_id, reporter_id) VALUES (?, ?)"
    ).run(targetId, reporterId);
    
    if (screenshot) {
      db.prepare(
        "UPDATE reports SET screenshot = ? WHERE target_id = ? AND reporter_id = ?"
      ).run(screenshot, targetId, reporterId);
    }
    return true;
  } catch (e) {
    return false;
  }
}

function getReportedUsers() {
  const rows = db.prepare(`
    SELECT target_id, COUNT(*) as count, GROUP_CONCAT(reporter_id) as reporters
    FROM reports
    GROUP BY target_id
  `).all();
  
  return rows.map(r => ({
    target: r.target_id,
    count: r.count,
    reporters: r.reporters ? r.reporters.split(',') : []
  }));
}

function getReportsAndScreenshots() {
  const rows = db.prepare(`
    SELECT target_id, reporter_id, screenshot
    FROM reports
    WHERE screenshot IS NOT NULL
  `).all();
  
  const screenshots = {};
  rows.forEach(r => {
    if (!screenshots[r.target_id]) screenshots[r.target_id] = r.screenshot;
  });
  return screenshots;
}

function removeReports(targetId) {
  db.prepare("DELETE FROM reports WHERE target_id = ?").run(targetId);
}

function getRecentVisitors(limit = 500) {
  return db.prepare(`
    SELECT v.ip, v.fingerprint as fp, v.country, max(vi.timestamp) as ts
    FROM visitors v
    JOIN visits vi ON v.id = vi.visitor_id
    GROUP BY v.id
    ORDER BY ts DESC
    LIMIT ?
  `).all(limit);
}

function getCountryStats() {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare(
    "SELECT country, unique_count FROM country_stats WHERE date = ?"
  ).all(today);
}

function getBannedCountries() {
  return db.prepare("SELECT code FROM banned_countries").all().map(r => r.code);
}

function addBannedCountry(code) {
  db.prepare("INSERT OR IGNORE INTO banned_countries (code) VALUES (?)").run(code);
}

function removeBannedCountry(code) {
  db.prepare("DELETE FROM banned_countries WHERE code = ?").run(code);
}

function clearBannedCountries() {
  db.prepare("DELETE FROM banned_countries").run();
}

function cleanupOldData() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("DELETE FROM visits WHERE timestamp < ?").run(thirtyDaysAgo);
  db.prepare("DELETE FROM visitors WHERE last_seen < ?").run(thirtyDaysAgo);
  db.prepare("DELETE FROM reports WHERE timestamp < ?").run(thirtyDaysAgo);
  // Clean old ban entries too
  db.prepare("DELETE FROM bans WHERE expiry < CURRENT_TIMESTAMP").run();
}

// Cleanup every hour
setInterval(cleanupOldData, 60 * 60 * 1000);

// --- Admin functions ---
function getAdminSnapshot() {
  const { ipBans, fpBans } = getActiveBans();
  
  // Clean expired bans from maps (just in case)
  const now = Date.now();
  for (const [ip, exp] of bannedIps) if (exp < now) bannedIps.delete(ip);
  for (const [fp, exp] of bannedFingerprints) if (exp < now) bannedFingerprints.delete(fp);
  
  const reportedUsers = getReportedUsers();
  const recentVisitors = getRecentVisitors();
  const countryCounts = getCountryStats();
  const bannedCountries = getBannedCountries();
  
  const stats = {
    connected: io.of("/").sockets.size,
    waiting: waitingQueue.length,
    partnered: partners.size / 2,
    totalVisitors: db.prepare("SELECT COUNT(DISTINCT id) as count FROM visitors").get().count,
    countryCounts: countryCounts.reduce((acc, row) => {
      acc[row.country] = row.unique_count;
      return acc;
    }, {})
  };
  
  return {
    stats,
    activeIpBans: ipBans,
    activeFpBans: fpBans,
    reportedUsers: reportedUsers.map(r => ({
      ...r,
      screenshot: getReportsAndScreenshots()[r.target] || null
    })),
    recentVisitors,
    bannedCountries
  };
}

function emitAdminUpdate() {
  io.of("/").emit("adminUpdate", getAdminSnapshot());
}

// --- HTTP Routes ---
app.get("/admin", adminAuth, (req, res) => {
  const COUNTRIES_JSON = JSON.stringify({
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
  });
  
  // ... (Rest of the HTML/JS admin panel code remains the same as original)
  // Include the full admin panel HTML with tabs from the original code
  // The JavaScript part stays identical, just ensure the COUNTRY_NAME function works
  `);
});

// Admin API routes
app.get("/admin/countries-list", adminAuth, (req, res) => {
  res.send({ all: Object.keys(JSON.parse(fs.readFileSync(__dirname + '/countries.json', 'utf8'))), banned: getBannedCountries() });
});

app.post("/admin/block-country", adminAuth, (req, res) => {
  const code = (req.body.code || "").toUpperCase();
  if (!code) return res.status(400).send({ error: "invalid" });
  addBannedCountry(code);
  emitAdminUpdate();
  res.send({ ok: true, banned: getBannedCountries() });
});

app.post("/admin/unblock-country", adminAuth, (req, res) => {
  const code = (req.body.code || "").toUpperCase();
  removeBannedCountry(code);
  emitAdminUpdate();
  res.send({ ok: true, banned: getBannedCountries() });
});

app.post("/admin/clear-blocked", adminAuth, (req, res) => {
  clearBannedCountries();
  emitAdminUpdate();
  res.send({ ok: true });
});

app.get("/admin/stats-data", adminAuth, (req, res) => {
  const from = req.query.from;
  const to = req.query.to;
  
  let dailyQuery = "SELECT DATE(timestamp) as date, COUNT(DISTINCT visitor_id) as count FROM visits WHERE 1=1";
  let countryQuery = "SELECT country, SUM(unique_count) as count FROM country_stats WHERE 1=1";
  
  if (from) {
    dailyQuery += ` AND DATE(timestamp) >= '${from}'`;
    countryQuery += ` AND date >= '${from}'`;
  }
  if (to) {
    dailyQuery += ` AND DATE(timestamp) <= '${to}'`;
    countryQuery += ` AND date <= '${to}'`;
  }
  
  dailyQuery += " GROUP BY DATE(timestamp) ORDER BY date";
  countryQuery += " GROUP BY country ORDER BY count DESC LIMIT 50";
  
  const daily = db.prepare(dailyQuery).all();
  const countries = db.prepare(countryQuery).all();
  const recent = getRecentVisitors();
  
  res.send({ daily, countries, recent });
});

app.post("/admin-broadcast", adminAuth, (req, res) => {
  const msg = req.body.message || "";
  if (msg.trim()) {
    io.emit("adminMessage", msg.trim());
  }
  res.send({ ok: true });
});

app.post("/unban-ip", adminAuth, (req, res) => {
  const ip = req.body.ip;
  removeBan('ip', ip);
  emitAdminUpdate();
  res.send({ ok: true });
});

app.post("/unban-fingerprint", adminAuth, (req, res) => {
  const fp = req.body.fp;
  removeBan('fingerprint', fp);
  emitAdminUpdate();
  res.send({ ok: true });
});

app.post("/manual-ban", adminAuth, (req, res) => {
  const target = req.body.target;
  if (!target) return res.status(400).send({ error: true });
  
  const ip = userIp.get(target);
  const fp = userFingerprint.get(target);
  
  if (ip) addBan('ip', ip);
  if (fp) addBan('fingerprint', fp);
  
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
  removeReports(target);
  emitAdminUpdate();
  res.send({ ok: true });
});

// --- Socket.IO Logic ---
io.on("connection", (socket) => {
  const ip = socket.handshake.headers["cf-connecting-ip"] || 
             socket.handshake.address || 
             (socket.request?.connection?.remoteAddress) || "unknown";
  
  userIp.set(socket.id, ip);
  
  // Get country
  let country = null;
  const headerCountry = socket.handshake.headers["cf-ipcountry"] || socket.handshake.headers["x-country"];
  if (headerCountry) country = headerCountry.toUpperCase();
  else {
    try {
      const g = geoip.lookup(ip);
      if (g?.country) country = g.country;
    } catch (e) {}
  }
  
  // Check country ban
  const isCountryBanned = db.prepare("SELECT code FROM banned_countries WHERE code = ?").get(country);
  if (isCountryBanned) {
    socket.emit("country-blocked", { message: "الموقع محظور في بلدك", country });
    emitAdminUpdate();
    return;
  }
  
  // Check IP ban
  if (isBanned('ip', ip)) {
    socket.emit("banned", { message: "You are banned (IP)." });
    socket.disconnect(true);
    emitAdminUpdate();
    return;
  }
  
  emitAdminUpdate();
  
  socket.on("identify", ({ fingerprint }) => {
    if (fingerprint) {
      userFingerprint.set(socket.id, fingerprint);
      
      // Check fingerprint ban
      if (isBanned('fingerprint', fingerprint)) {
        socket.emit("banned", { message: "Device banned." });
        socket.disconnect(true);
        emitAdminUpdate();
        return;
      }
      
      // Get/create visitor record
      const visitorId = getOrCreateVisitor(fingerprint, ip, country);
      
      // Log this visit session
      db.prepare("INSERT INTO visits (visitor_id, socket_id, country) VALUES (?, ?, ?)").run(visitorId, socket.id, country);
      
      emitAdminUpdate();
    }
  });
  
  socket.on("find-partner", () => {
    const fp = userFingerprint.get(socket.id);
    if (fp && isBanned('fingerprint', fp)) {
      socket.emit("banned", { message: "You are banned (device)." });
      socket.disconnect(true);
      emitAdminUpdate();
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
      if (!a || !b) break;
      if (!io.sockets.sockets.get(a) || !io.sockets.sockets.get(b)) continue;
      partners.set(a, b);
      partners.set(b, a);
      io.to(a).emit("partner-found", { id: b, initiator: true });
      io.to(b).emit("partner-found", { id: a, initiator: false });
    }
  }
  
  socket.on("admin-screenshot", ({ image, partnerId }) => {
    if (!image) return;
    const target = partnerId || partners.get(socket.id);
    if (!target) return;
    
    const reporterFp = userFingerprint.get(socket.id);
    if (reporterFp) {
      addReport(target, reporterFp, image);
      emitAdminUpdate();
    }
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
    
    const reporterFp = userFingerprint.get(socket.id);
    if (!reporterFp) return;
    
    addReport(partnerId, reporterFp);
    emitAdminUpdate();
    
    // Check if should auto-ban
    const reportCount = db.prepare(
      "SELECT COUNT(*) as count FROM reports WHERE target_id = ?"
    ).get(partnerId).count;
    
    if (reportCount >= 3) {
      const targetIp = userIp.get(partnerId);
      const targetFp = userFingerprint.get(partnerId);
      
      if (targetIp) addBan('ip', targetIp);
      if (targetFp) addBan('fingerprint', targetFp);
      
      const targetSocket = io.sockets.sockets.get(partnerId);
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
    
    userFingerprint.delete(socket.id);
    userIp.delete(socket.id);
    
    emitAdminUpdate();
  });
  
  socket.on("admin-join", () => {
    socket.emit("adminUpdate", getAdminSnapshot());
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log("Server listening on port " + PORT);
  console.log("Database: " + DB_PATH);
});
