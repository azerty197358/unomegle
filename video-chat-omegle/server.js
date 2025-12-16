const express = require("express");
const path = require("path");
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

// بيانات اعتماد الأدمن
const ADMIN_USERS = { admin: "admin" };
const adminAuth = basicAuth({
  users: ADMIN_USERS,
  challenge: true,
  realm: "Admin Area",
});

// ============== قاعدة البيانات ==============
const dbFile = path.join(__dirname, "stats.db");
const db = new Database(dbFile);

// إنشاء الجداول
db.exec(`
CREATE TABLE IF NOT EXISTS visitors(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL, fp TEXT, country TEXT, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visitors_ts ON visitors(ts);
CREATE INDEX IF NOT EXISTS idx_visitors_ip ON visitors(ip);

CREATE TABLE IF NOT EXISTS reports(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  targetId TEXT NOT NULL, reporterId TEXT NOT NULL,
  screenshot TEXT, ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bans(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL, value TEXT NOT NULL,
  expiry INTEGER NOT NULL, UNIQUE(type,value)
);

CREATE TABLE IF NOT EXISTS banned_countries(code TEXT PRIMARY KEY);
`);

// الاستعلامات المعدة
const stmtInsertVisitor = db.prepare("INSERT INTO visitors(ip,fp,country,ts) VALUES(?,?,?,?)");
const stmtUniqueVisitors24h = db.prepare("SELECT COUNT(DISTINCT ip||'|'||COALESCE(fp,'')) as cnt FROM visitors WHERE ts > ?");
const stmtVisitorsByCountry24h = db.prepare("SELECT country,COUNT(DISTINCT ip||'|'||COALESCE(fp,'')) as cnt FROM visitors WHERE ts > ? GROUP BY country ORDER BY cnt DESC");
const stmtInsertReport = db.prepare("INSERT INTO reports(targetId,reporterId,screenshot,ts) VALUES(?,?,?,?)");
const stmtGetReports = db.prepare("SELECT * FROM reports");
const stmtDeleteReports = db.prepare("DELETE FROM reports WHERE targetId=?");
const stmtInsertBan = db.prepare("INSERT OR REPLACE INTO bans(type,value,expiry) VALUES(?,?,?)");
const stmtDeleteBan = db.prepare("DELETE FROM bans WHERE type=? AND value=?");
const stmtActiveBans = db.prepare("SELECT * FROM bans WHERE expiry > ?");
const stmtInsertBannedCountry = db.prepare("INSERT OR IGNORE INTO banned_countries(code) VALUES(?)");
const stmtDeleteBannedCountry = db.prepare("DELETE FROM banned_countries WHERE code=?");
const stmtClearBannedCountries = db.prepare("DELETE FROM banned_countries");
const stmtGetBannedCountries = db.prepare("SELECT code FROM banned_countries");

// قائمة الدول
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

// المتغيرات الأساسية
const waitingQueue = [];
const partners = new Map();
const userFingerprint = new Map();
const userIp = new Map();
const BAN_DURATION = 24 * 60 * 60 * 1000;

// ======== دوال المساعدة ========
function emitAdminUpdate() {
  io.emit("adminUpdate", getAdminSnapshot());
}

function banUser(ip, fp) {
  const expiry = Date.now() + BAN_DURATION;
  if (ip) stmtInsertBan.run("ip", ip, expiry);
  if (fp) stmtInsertBan.run("fp", fp, expiry);
  emitAdminUpdate(); // إصلاح: التحديث الفوري بعد الحظر
}

function unbanUser(ip, fp) {
  if (ip) stmtDeleteBan.run("ip", ip);
  if (fp) stmtDeleteBan.run("fp", fp);
  emitAdminUpdate();
}

function getAdminSnapshot() {
  const now = Date.now();
  const cutoff24h = now - 24*3600*1000;

  const unique24h = stmtUniqueVisitors24h.get(cutoff24h).cnt;
  const byCountry24h = stmtVisitorsByCountry24h.all(cutoff24h);
  const activeBans = stmtActiveBans.all(now);
  const activeIpBans = activeBans.filter(r => r.type === "ip").map(r => ({ ip: r.value, expires: r.expiry }));
  const activeFpBans = activeBans.filter(r => r.type === "fp").map(r => ({ fp: r.value, expires: r.expiry }));

  const dbReports = stmtGetReports.all();
  const reportsMap = new Map();
  for (const row of dbReports) {
    if (!reportsMap.has(row.targetId)) reportsMap.set(row.targetId, { count: 0, reporters: new Set(), screenshot: null });
    const obj = reportsMap.get(row.targetId);
    obj.count++;
    obj.reporters.add(row.reporterId);
    if (row.screenshot) obj.screenshot = row.screenshot;
  }
  const reportedUsers = Array.from(reportsMap.entries()).map(([target, obj]) => ({
    target, count: obj.count,
    reporters: Array.from(obj.reporters),
    screenshot: obj.screenshot
  }));

  // **NEW: عرض آخر 50 IP فريد فقط**
  const recentVisitors = db.prepare(`
    SELECT ip, fp, country, ts
    FROM visitors
    WHERE id IN (
      SELECT MAX(id)
      FROM visitors
      GROUP BY ip
    )
    ORDER BY ts DESC
    LIMIT 50
  `).all();

  const bannedCountries = stmtGetBannedCountries.all().map(r => r.code);

  return {
    stats: {
      connected: io.of("/").sockets.size,
      waiting: waitingQueue.length,
      partnered: partners.size / 2,
      totalVisitors: unique24h,
      countryCounts: Object.fromEntries(byCountry24h.map(r => [r.country, r.cnt]))
    },
    activeIpBans, activeFpBans, reportedUsers, recentVisitors, bannedCountries
  };
}

// ======== المسارات ========
app.get("/admin", adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "admin-panel.html"));
});

app.get("/admin/countries-list", adminAuth, (req, res) => {
  res.send({ all: Object.keys(COUNTRIES), banned: stmtGetBannedCountries.all().map(r => r.code) });
});

app.post("/admin/block-country", adminAuth, (req, res) => {
  const code = (req.body.code || "").toUpperCase();
  if (!code || !COUNTRIES[code]) return res.status(400).send({ error: "invalid" });
  stmtInsertBannedCountry.run(code);
  emitAdminUpdate();
  res.send({ ok: true });
});

app.post("/admin/unblock-country", adminAuth, (req, res) => {
  stmtDeleteBannedCountry.run((req.body.code || "").toUpperCase());
  emitAdminUpdate();
  res.send({ ok: true });
});

app.post("/admin/clear-blocked", adminAuth, (req, res) => {
  stmtClearBannedCountries.run();
  emitAdminUpdate();
  res.send({ ok: true });
});

// **NEW: تحسين بيانات المخطط البياني لتشمل الدول**
app.get("/admin/stats-data", adminAuth, (req, res) => {
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;
  const params = [];
  let where = "";
  if (from) { where += " WHERE ts >= ?"; params.push(from.getTime()); }
  if (to) { where += (where ? " AND" : " WHERE") + " ts <= ?"; params.push(to.getTime() + 24*3600*1000 -1); }

  // Daily visitors
  const dailyMap = new Map();
  const rows = db.prepare("SELECT ts FROM visitors" + where).all(params);
  for (const r of rows) {
    const key = new Date(r.ts).toISOString().slice(0,10);
    dailyMap.set(key, (dailyMap.get(key)||0) + 1);
  }
  const daily = Array.from(dailyMap.entries()).sort((a,b)=>a[0].localeCompare(b[0])).map(([date,count])=>({date,count}));

  // Countries with visitor count
  const countryRows = db.prepare("SELECT country,COUNT(DISTINCT ip||'|'||COALESCE(fp,'')) as cnt FROM visitors" + where + " GROUP BY country ORDER BY cnt DESC LIMIT 50").all(params);
  const countries = countryRows.map(r => ({ country: r.country || "Unknown", count: r.cnt }));

  // Recent visitors (last 500 for stats panel)
  const recent = db.prepare("SELECT ip,fp,country,ts FROM visitors ORDER BY ts DESC LIMIT 500").all();

  res.send({ daily, countries, recent });
});

app.post("/admin-broadcast", adminAuth, (req, res) => {
  const msg = req.body.message || "";
  if (msg.trim()) io.emit("adminMessage", msg.trim());
  res.send({ ok: true });
});

app.post("/unban-ip", adminAuth, (req, res) => {
  unbanUser(req.body.ip, null);
  res.send({ ok: true });
});

app.post("/unban-fingerprint", adminAuth, (req, res) => {
  unbanUser(null, req.body.fp);
  res.send({ ok: true });
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
  res.send({ ok: true });
});

app.post("/remove-report", adminAuth, (req, res) => {
  const target = req.body.target;
  if (!target) return res.status(400).send({ error: true });
  stmtDeleteReports.run(target);
  emitAdminUpdate();
  res.send({ ok: true });
});

// ======== Socket.io Logic ========
io.on("connection", (socket) => {
  const ip = socket.handshake.headers["cf-connecting-ip"] || socket.handshake.address || "unknown";
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
  stmtInsertVisitor.run(ip, null, country, ts);

  const ipBan = stmtActiveBans.all(Date.now()).find(r => r.type === "ip" && r.value === ip);
  if (ipBan) {
    socket.emit("banned", { message: "You are banned (IP)." });
    socket.disconnect(true);
    return;
  }

  const bannedCountries = stmtGetBannedCountries.all().map(r => r.code);
  if (country && bannedCountries.includes(country)) {
    socket.emit("country-blocked", { message: "الموقع محظور في بلدك", country });
    return;
  }

  emitAdminUpdate();

  socket.on("identify", ({ fingerprint }) => {
    if (fingerprint) {
      userFingerprint.set(socket.id, fingerprint);
      db.prepare("UPDATE visitors SET fp=? WHERE ip=? AND ts=?").run(fingerprint, ip, ts);
      const fpBan = stmtActiveBans.all(Date.now()).find(r => r.type === "fp" && r.value === fingerprint);
      if (fpBan) {
        socket.emit("banned", { message: "Device banned." });
        socket.disconnect(true);
        return;
      }
    }
    emitAdminUpdate();
  });

  socket.on("find-partner", () => {
    const fp = userFingerprint.get(socket.id);
    if (fp) {
      const fExp = stmtActiveBans.all(Date.now()).find(r => r.type === "fp" && r.value === fp);
      if (fExp) {
        socket.emit("banned", { message: "You are banned (device)." });
        socket.disconnect(true);
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

  socket.on("admin-screenshot", ({ image, partnerId }) => {
    if (!image) return;
    const target = partnerId || partners.get(socket.id);
    if (!target) return;
    const row = db.prepare("SELECT * FROM reports WHERE targetId=? ORDER BY ts DESC LIMIT 1").get(target);
    if (row) db.prepare("UPDATE reports SET screenshot=? WHERE id=?").run(image, row.id);
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
    const exists = db.prepare("SELECT * FROM reports WHERE targetId=? AND reporterId=?").get(partnerId, socket.id);
    if (exists) return;
    stmtInsertReport.run(partnerId, socket.id, null, Date.now());
    emitAdminUpdate();

    const count = db.prepare("SELECT COUNT(*) as cnt FROM reports WHERE targetId=?").get(partnerId).cnt;
    if (count >= 3) {
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
    userFingerprint.delete(socket.id);
    userIp.delete(socket.id);
    emitAdminUpdate();
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log("Server listening on port " + PORT));
