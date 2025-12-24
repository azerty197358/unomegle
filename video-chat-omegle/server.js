const express = require("express");
const path = require("path");
const basicAuth = require("express-basic-auth");
const geoip = require("geoip-lite");
const Database = require("better-sqlite3");
const http = require("http");
const socketIo = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

/* ====== نظام الحماية security.js ====== */
const ALLOWED_IPS = ['197.205.96.254'];        // عدّلها لاحقاً
function realIP(req){
  return (req.headers['cf-connecting-ip']   ||
          req.headers['x-forwarded-for']?.split(',')[0].trim() ||
          req.headers['x-real-ip']          ||
          req.connection.remoteAddress);
}
function ipFilter(req,res,next){
  if(!ALLOWED_IPS.includes(realIP(req))) return res.status(403).send('Forbidden');
  next();
}

/* ====== Basic Auth ====== */
const ADMIN_USERS = { admin: 'admin' };        // عدّل الباسورد
const adminAuth = basicAuth({ 
  users: ADMIN_USERS, 
  challenge: true, 
  realm: 'Admin Area' 
});

/* ====== دمج الحماية في ملف واحد ====== */
function applySecurity(app){
  app.use(ipFilter);           // يُطبق على كل المسارات تلقائياً
  return { adminAuth };        // تُستخدم يدوياً على المسارات التي تريدها
}

// تطبيق نظام الحماية
applySecurity(app);

app.set("trust proxy", true);
app.use(express.static(__dirname));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ============== قاعدة البيانات المحسنة ==============
const dbFile = path.join(__dirname, "stats.db");
const db = new Database(dbFile);

// إنشاء الجداول المحسنة مع تخزين دائم
db.exec(`
-- الزوار (تخزين دائم)
CREATE TABLE IF NOT EXISTS visitors(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  fp TEXT,
  country TEXT,
  user_agent TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- الإحصائيات اليومية (تخزين دائم)
CREATE TABLE IF NOT EXISTS daily_stats(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date DATE UNIQUE NOT NULL,
  visitor_count INTEGER DEFAULT 0,
  unique_visitors INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- سجل الحظر الدائم
CREATE TABLE IF NOT EXISTS bans_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  reason TEXT,
  banned_by TEXT DEFAULT 'system',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,
  unbanned_at DATETIME
);

-- سجل البلاغات الدائم
CREATE TABLE IF NOT EXISTS reports_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL,
  reporter TEXT,
  reason TEXT,
  screenshot TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- الحظر الفعال الحالي
CREATE TABLE IF NOT EXISTS active_bans(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  expiry INTEGER NOT NULL,
  UNIQUE(type,value)
);

-- البلاغات الحالية
CREATE TABLE IF NOT EXISTS active_reports(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  targetId TEXT NOT NULL,
  reporterId TEXT NOT NULL,
  screenshot TEXT,
  ts INTEGER NOT NULL
);

-- الدول المحظورة
CREATE TABLE IF NOT EXISTS banned_countries(
  code TEXT PRIMARY KEY,
  blocked_by TEXT DEFAULT 'admin',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- إنشاء فهارس للأداء
CREATE INDEX IF NOT EXISTS idx_visitors_created ON visitors(created_at);
CREATE INDEX IF NOT EXISTS idx_visitors_country ON visitors(country);
CREATE INDEX IF NOT EXISTS idx_visitors_ip_fp ON visitors(ip, fp);
CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
CREATE INDEX IF NOT EXISTS idx_bans_history_created ON bans_history(created_at);
CREATE INDEX IF NOT EXISTS idx_bans_history_type_value ON bans_history(type, value);
CREATE INDEX IF NOT EXISTS idx_reports_history_created ON reports_history(created_at);
CREATE INDEX IF NOT EXISTS idx_reports_history_target ON reports_history(target);
`);

// الاستعلامات المعدلة
const stmtInsertVisitor = db.prepare("INSERT INTO visitors(ip,fp,country,user_agent) VALUES(?,?,?,?)");
const stmtUniqueVisitors24h = db.prepare(`
  SELECT COUNT(DISTINCT ip||'|'||COALESCE(fp,'')) as cnt 
  FROM visitors 
  WHERE created_at > datetime('now', '-24 hours')
`);

const stmtVisitorsByCountry24h = db.prepare(`
  SELECT country, COUNT(DISTINCT ip||'|'||COALESCE(fp,'')) as cnt 
  FROM visitors 
  WHERE created_at > datetime('now', '-24 hours') 
  GROUP BY country 
  ORDER BY cnt DESC
`);

const stmtInsertActiveReport = db.prepare("INSERT INTO active_reports(targetId,reporterId,screenshot,ts) VALUES(?,?,?,?)");
const stmtGetActiveReports = db.prepare("SELECT * FROM active_reports");
const stmtDeleteActiveReports = db.prepare("DELETE FROM active_reports WHERE targetId=?");
const stmtInsertActiveBan = db.prepare("INSERT OR REPLACE INTO active_bans(type,value,expiry) VALUES(?,?,?)");
const stmtDeleteActiveBan = db.prepare("DELETE FROM active_bans WHERE type=? AND value=?");
const stmtGetActiveBans = db.prepare("SELECT * FROM active_bans WHERE expiry > ?");
const stmtInsertBannedCountry = db.prepare("INSERT OR IGNORE INTO banned_countries(code) VALUES(?)");
const stmtDeleteBannedCountry = db.prepare("DELETE FROM banned_countries WHERE code=?");
const stmtClearBannedCountries = db.prepare("DELETE FROM banned_countries");
const stmtGetBannedCountries = db.prepare("SELECT code FROM banned_countries");

// دوال جديدة للتعامل مع التخزين الدائم
const stmtInsertDailyStats = db.prepare(`
  INSERT OR REPLACE INTO daily_stats(date, visitor_count, unique_visitors) 
  VALUES(?, COALESCE((SELECT visitor_count FROM daily_stats WHERE date = ?) + 1, 1), 
         COALESCE((SELECT unique_visitors FROM daily_stats WHERE date = ?), 0))
`);

const stmtUpdateDailyUnique = db.prepare(`
  UPDATE daily_stats SET unique_visitors = unique_visitors + 1 WHERE date = ?
`);

const stmtInsertBanHistory = db.prepare(`
  INSERT INTO bans_history(type, value, reason, expires_at) 
  VALUES(?, ?, ?, ?)
`);

const stmtUpdateBanUnbanned = db.prepare(`
  UPDATE bans_history SET unbanned_at = CURRENT_TIMESTAMP 
  WHERE type = ? AND value = ? AND unbanned_at IS NULL
`);

const stmtInsertReportHistory = db.prepare(`
  INSERT INTO reports_history(target, reporter, screenshot) 
  VALUES(?, ?, ?)
`);

// قائمة الدول
const COUNTRIES = {
  "AF":"Afghanistan","AL":"Albania","DZ":"Algeria","AS":"American Samoa","AD":"Andorra","AO":"Angola","AI":"Anguilla",
  "AQ":"Antarctica","AG":"Antigua and Barbuda","AR":"Argentina","AM":"Armenia","AW":"Aruba","AU":"Australia","AT":"Austria",
  "AZ":"Azerbaijan","BS":"Bahamas","BH":"Bahrain","BD":"Bangladesh","BB":"Barbados","BY":"Belarus","BE":"Belgium","BZ":"Belize",
  "BJ":"Benin","BM":"Bermuda","BT":"Bhutan","BO":"Bolivia","BA":"Bosnia and Herzegovina","BW":"Botswana","BR":"Brazil",
  "IO":"British Indian Ocean Territory","VG":"British Virgin Islands","BN":"Brunei","BG":"Bulgaria","BF":"Burkina Faso",
  "BI":"Burundi","CV":"Cabo Verde","KH":"Cambodia","CM":"Cameroon","CA":"Canada","KY":"Cayman Islands","CF":"Central African Republic",
  "TD":"Chad","CL":"Chile","CN":"China","CX":"Christmas Island","CC":"Cocos (Keeling) Islands","CO":"Colombia","KM":"Comoros",
  "CG":"Congo - Brazzaville","CD":"Congo - Kinshasa","CK":"Cook Islands","CR":"Costa Rica","CI":"Côte d'Ivoire","HR":"Croatia",
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

// ======== دوال المساعدة المحسنة ========
function emitAdminUpdate() {
  io.emit("adminUpdate", getAdminSnapshot());
}

function banUser(ip, fp, reason = "Manual ban by admin") {
  const expiry = Date.now() + BAN_DURATION;
  
  // تخزين في الحظر الفعال
  if (ip) {
    stmtInsertActiveBan.run("ip", ip, expiry);
    stmtInsertBanHistory.run("ip", ip, reason, new Date(expiry).toISOString());
  }
  if (fp) {
    stmtInsertActiveBan.run("fp", fp, expiry);
    stmtInsertBanHistory.run("fp", fp, reason, new Date(expiry).toISOString());
  }
  
  emitAdminUpdate();
}

function unbanUser(ip, fp) {
  // إزالة من الحظر الفعال
  if (ip) {
    stmtDeleteActiveBan.run("ip", ip);
    stmtUpdateBanUnbanned.run("ip", ip);
  }
  if (fp) {
    stmtDeleteActiveBan.run("fp", fp);
    stmtUpdateBanUnbanned.run("fp", fp);
  }
  
  emitAdminUpdate();
}

function storeVisitor(ip, country, fingerprint, userAgent) {
  // أولاً، التحقق إذا كان هذا الزائر جديداً (مميز فريد)
  const today = new Date().toISOString().split('T')[0];
  
  const existingVisitor = db.prepare(`
    SELECT 1 FROM visitors WHERE (ip = ? AND fp = ?) OR (ip = ? AND fp IS NULL AND ? IS NULL)
  `).get(ip, fingerprint, ip, fingerprint);
  
  if (!existingVisitor) {
    // زائر فريد جديد
    stmtInsertVisitor.run(ip, fingerprint, country, userAgent);
    stmtInsertDailyStats.run(today, today, today);
  } else {
    // زائر متكرر - تحديث الإحصائيات فقط
    stmtUpdateDailyUnique.run(today);
  }
}

function getAdminSnapshot() {
  const now = Date.now();
  
  // الإحصائيات الحية
  const unique24h = stmtUniqueVisitors24h.get().cnt;
  const byCountry24h = stmtVisitorsByCountry24h.all();
  
  // الحظر الفعال
  const activeBans = stmtGetActiveBans.all(now);
  const activeIpBans = activeBans.filter(r => r.type === "ip").map(r => ({ ip: r.value, expires: r.expiry }));
  const activeFpBans = activeBans.filter(r => r.type === "fp").map(r => ({ fp: r.value, expires: r.expiry }));
  
  // البلاغات الفعالة
  const dbReports = stmtGetActiveReports.all();
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
  
  // آخر 50 زائر فريد (بناءً على IP)
  const recentVisitors = db.prepare(`
    SELECT DISTINCT ip, fp, country, created_at as ts
    FROM visitors
    WHERE id IN (
      SELECT MAX(id)
      FROM visitors
      GROUP BY ip
    )
    ORDER BY created_at DESC
    LIMIT 50
  `).all();
  
  // الدول المحظورة
  const bannedCountries = stmtGetBannedCountries.all().map(r => r.code);
  
  // إحصائيات إضافية من قاعدة البيانات
  const totalVisitors = db.prepare("SELECT COUNT(DISTINCT ip||'|'||COALESCE(fp,'')) as cnt FROM visitors").get().cnt;
  const totalDailyStats = db.prepare("SELECT COUNT(*) as cnt FROM daily_stats").get().cnt;
  const totalBansHistory = db.prepare("SELECT COUNT(*) as cnt FROM bans_history").get().cnt;
  const totalReportsHistory = db.prepare("SELECT COUNT(*) as cnt FROM reports_history").get().cnt;
  
  return {
    stats: {
      connected: io.of("/").sockets.size,
      waiting: waitingQueue.length,
      partnered: partners.size / 2,
      totalVisitors: totalVisitors,
      uniqueVisitors24h: unique24h,
      countryCounts: Object.fromEntries(byCountry24h.map(r => [r.country || "Unknown", r.cnt]))
    },
    activeIpBans, 
    activeFpBans, 
    reportedUsers, 
    recentVisitors, 
    bannedCountries,
    databaseStats: {
      totalVisitors,
      dailyStats: totalDailyStats,
      bansHistory: totalBansHistory,
      reportsHistory: totalReportsHistory,
      lastBackup: db.prepare("SELECT MAX(created_at) as last FROM bans_history").get().last
    }
  };
}

// ======== مسارات جديدة لإدارة قاعدة البيانات ========

// إحصائيات قاعدة البيانات
app.get("/admin/database-stats", adminAuth, (req, res) => {
  try {
    const stats = getAdminSnapshot().databaseStats;
    
    // الحصول على حجم قاعدة البيانات
    const dbSize = db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get();
    
    res.json({
      ...stats,
      dbSize: dbSize ? dbSize.size : 0
    });
  } catch (error) {
    console.error("Error getting database stats:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// تصدير البيانات
app.get("/admin/export-data", adminAuth, (req, res) => {
  const { type } = req.query;
  const exportDate = new Date().toISOString();
  
  try {
    switch(type) {
      case 'visitors':
        const visitors = db.prepare("SELECT * FROM visitors ORDER BY created_at DESC").all();
        res.json({
          type: 'visitors',
          count: visitors.length,
          exported_at: exportDate,
          data: visitors
        });
        break;
        
      case 'statistics':
        const stats = db.prepare("SELECT * FROM daily_stats ORDER BY date DESC").all();
        res.json({
          type: 'daily_statistics',
          count: stats.length,
          exported_at: exportDate,
          data: stats
        });
        break;
        
      case 'bans':
        const bans = db.prepare("SELECT * FROM bans_history ORDER BY created_at DESC").all();
        res.json({
          type: 'bans_history',
          count: bans.length,
          exported_at: exportDate,
          data: bans
        });
        break;
        
      case 'reports':
        const reports = db.prepare("SELECT * FROM reports_history ORDER BY created_at DESC").all();
        res.json({
          type: 'reports_history',
          count: reports.length,
          exported_at: exportDate,
          data: reports
        });
        break;
        
      default: // full backup
        const backup = {
          visitors: db.prepare("SELECT * FROM visitors ORDER BY created_at DESC").all(),
          daily_stats: db.prepare("SELECT * FROM daily_stats ORDER BY date DESC").all(),
          bans_history: db.prepare("SELECT * FROM bans_history ORDER BY created_at DESC").all(),
          reports_history: db.prepare("SELECT * FROM reports_history ORDER BY created_at DESC").all(),
          active_bans: db.prepare("SELECT * FROM active_bans").all(),
          active_reports: db.prepare("SELECT * FROM active_reports").all(),
          banned_countries: db.prepare("SELECT * FROM banned_countries").all()
        };
        
        res.json({
          type: 'full_backup',
          exported_at: exportDate,
          database_version: '2.0',
          ...backup
        });
    }
  } catch (error) {
    console.error("Error exporting data:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ======== المسارات الحالية المعدلة ========
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

// بيانات المخطط البياني مع تحسينات
app.get("/admin/stats-data", adminAuth, (req, res) => {
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;
  
  let where = "";
  const params = [];
  
  if (from) {
    where += " WHERE date >= ?";
    params.push(from.toISOString().split('T')[0]);
  }
  if (to) {
    where += where ? " AND" : " WHERE";
    where += " date <= ?";
    params.push(to.toISOString().split('T')[0]);
  }
  
  // الإحصائيات اليومية
  const daily = db.prepare(`SELECT date, visitor_count as count FROM daily_stats ${where} ORDER BY date`).all(params);
  
  // الدول مع عدد الزوار
  let countryQuery = `
    SELECT country, COUNT(DISTINCT ip||'|'||COALESCE(fp,'')) as cnt 
    FROM visitors 
  `;
  
  const countryParams = [];
  if (from) {
    countryQuery += " WHERE date(created_at) >= ?";
    countryParams.push(from.toISOString().split('T')[0]);
  }
  if (to) {
    countryQuery += countryParams.length ? " AND" : " WHERE";
    countryQuery += " date(created_at) <= ?";
    countryParams.push(to.toISOString().split('T')[0]);
  }
  
  countryQuery += " GROUP BY country ORDER BY cnt DESC LIMIT 50";
  
  const countryRows = db.prepare(countryQuery).all(countryParams);
  const countries = countryRows.map(r => ({ country: r.country || "Unknown", count: r.cnt }));
  
  res.json({ daily, countries });
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
  
  banUser(ip, fp, "Manual ban by admin");
  
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
  
  stmtDeleteActiveReports.run(target);
  emitAdminUpdate();
  
  res.send({ ok: true });
});

// ======== Socket.io Logic المعدلة ========
io.on("connection", (socket) => {
  const ip = socket.handshake.headers["cf-connecting-ip"] || socket.handshake.address || "unknown";
  const userAgent = socket.handshake.headers["user-agent"] || "unknown";
  
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
  
  // تخزين الزائر في قاعدة البيانات
  storeVisitor(ip, country, null, userAgent);
  
  // التحقق من الحظر
  const ipBan = stmtGetActiveBans.all(Date.now()).find(r => r.type === "ip" && r.value === ip);
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
      
      // تحديث الزائر بالمميز الفريد
      db.prepare("UPDATE visitors SET fp=? WHERE ip=? AND fp IS NULL LIMIT 1").run(fingerprint, ip);
      
      const fpBan = stmtGetActiveBans.all(Date.now()).find(r => r.type === "fp" && r.value === fingerprint);
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
      const fExp = stmtGetActiveBans.all(Date.now()).find(r => r.type === "fp" && r.value === fp);
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
    
    const row = db.prepare("SELECT * FROM active_reports WHERE targetId=? ORDER BY ts DESC LIMIT 1").get(target);
    if (row) {
      db.prepare("UPDATE active_reports SET screenshot=? WHERE id=?").run(image, row.id);
      db.prepare("UPDATE reports_history SET screenshot=? WHERE id=?").run(image, row.id);
    }
    
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
    
    const exists = db.prepare("SELECT * FROM active_reports WHERE targetId=? AND reporterId=?").get(partnerId, socket.id);
    if (exists) return;
    
    stmtInsertActiveReport.run(partnerId, socket.id, null, Date.now());
    stmtInsertReportHistory.run(partnerId, socket.id, null);
    
    emitAdminUpdate();
    
    const count = db.prepare("SELECT COUNT(*) as cnt FROM active_reports WHERE targetId=?").get(partnerId).cnt;
    if (count >= 3) {
      const targetSocket = io.sockets.sockets.get(partnerId);
      const targetIp = userIp.get(partnerId);
      const targetFp = userFingerprint.get(partnerId);
      
      banUser(targetIp, targetFp, "Automatically banned after 3 reports");
      
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
server.listen(PORT, () => {
  console.log("Server listening on port " + PORT);
  console.log("Admin panel: http://localhost:" + PORT + "/admin");
});
