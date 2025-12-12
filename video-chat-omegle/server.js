// File: server.js
// Full server — PostgreSQL persistence, cleanup, admin panel, low-memory for Render free plan.
// TL;DR: place schema.sql in same dir, set env DATABASE_URL (or use fallback), then run.

const express = require("express");
const path = require("path");
const fs = require("fs");
const basicAuth = require("express-basic-auth");
const geoip = require("geoip-lite");
const { Pool } = require("pg");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const httpLib = require("http");
const socketIo = require("socket.io");

// ---------- Configuration ----------
const DB_FALLBACK = "postgresql://unomegle:aHJr5qb4oCxffr2qs92cH2FPCxW6T2qX@dpg-d4u3diur433s73d9j580-a.oregon-postgres.render.com/unomegle";
const DATABASE_URL = process.env.DATABASE_URL || DB_FALLBACK;
const PORT = process.env.PORT || 3000;
const ADMIN_USERS = { admin: process.env.ADMIN_PASS || "admin" };
const BAN_DURATION_MS = 24 * 60 * 60 * 1000; // 24h
const VISITORS_HISTORY_KEEP_DAYS = 30;
const REPORTS_KEEP_DAYS = 90;

// ---------- App setup ----------
const app = express();
// Render runs behind a single proxy; set to 1 to avoid permissive trust proxy warnings
app.set("trust proxy", 1);

app.use(express.static(__dirname));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(compression());

// rate limiter — use ip as key, short window for free plan, small max to limit work
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  // keyGenerator uses req.ip which respects trust proxy above
  keyGenerator: (req) => req.ip || req.connection.remoteAddress || "anon"
});
app.use(limiter);

// basic admin auth
const adminAuth = basicAuth({
  users: ADMIN_USERS,
  challenge: true,
  realm: "Admin Area",
});

// ---------- DB pool ----------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Render Postgres
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000
});

// simple query helper
async function q(text, params=[]) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// ensure schema.sql exists and run it
async function ensureSchema() {
  const sqlPath = path.join(__dirname, "schema.sql");
  if (!fs.existsSync(sqlPath)) {
    console.error("schema.sql not found in project root. Create schema.sql and redeploy.");
    process.exit(1);
  }
  const sql = fs.readFileSync(sqlPath, "utf8");
  // Run as a single batch. Keep reasonably idempotent CREATE TABLE IF NOT EXISTS statements.
  await q(sql);
}
ensureSchema().catch(err => {
  console.error("Schema init failed:", err);
  process.exit(1);
});

// ---------- Caches (lightweight) ----------
let bannedCountriesCache = new Set();
async function loadBannedCountriesCache() {
  try {
    const res = await q("SELECT code FROM banned_countries");
    bannedCountriesCache = new Set(res.rows.map(r => r.code));
  } catch (e) {
    bannedCountriesCache = new Set();
  }
}

let bansIpCache = new Map(); // ip -> Date
let bansFpCache = new Map(); // fp -> Date
async function loadBansCache() {
  try {
    const res = await q("SELECT kind, value, expires FROM bans WHERE expires > NOW()");
    bansIpCache = new Map();
    bansFpCache = new Map();
    for (const r of res.rows) {
      if (r.kind === "ip") bansIpCache.set(r.value, new Date(r.expires));
      else if (r.kind === "fingerprint") bansFpCache.set(r.value, new Date(r.expires));
    }
  } catch (e) {
    bansIpCache = new Map();
    bansFpCache = new Map();
  }
}

// initial caches
loadBannedCountriesCache().catch(()=>{});
loadBansCache().catch(()=>{});
setInterval(() => { loadBannedCountriesCache().catch(()=>{}); loadBansCache().catch(()=>{}); }, 5 * 60 * 1000);

// ---------- Admin snapshot (reads from DB on-demand) ----------
async function getAdminSnapshot() {
  // counts
  const connected = io.of("/").sockets.size;
  const waiting = (await q("SELECT count(*) FROM visitors WHERE waiting = TRUE")).rows[0] ? parseInt((await q("SELECT count(*) FROM visitors WHERE waiting = TRUE")).rows[0].count,10) : 0;
  const partnered = (await q("SELECT count(*) FROM visitors WHERE paired = TRUE")).rows[0] ? parseInt((await q("SELECT count(*) FROM visitors WHERE paired = TRUE")).rows[0].count,10) : 0;
  const countriesRes = await q("SELECT country, count(*) FROM visitors_history WHERE country IS NOT NULL GROUP BY country");
  const countryCounts = {};
  for (const r of countriesRes.rows) countryCounts[r.country] = parseInt(r.count, 10);
  const totalVisitorsRes = await q("SELECT count(*) FROM visitors_history");
  const totalVisitors = parseInt(totalVisitorsRes.rows[0].count, 10);

  // bans
  const ipBans = [];
  for (const [ip, expires] of bansIpCache) {
    if (expires instanceof Date && expires.getTime() > Date.now()) ipBans.push({ ip, expires: expires.getTime() });
  }
  const fpBans = [];
  for (const [fp, expires] of bansFpCache) {
    if (expires instanceof Date && expires.getTime() > Date.now()) fpBans.push({ fp, expires: expires.getTime() });
  }

  // reported users
  const repRes = await q("SELECT target, COUNT(DISTINCT reporter) AS cnt FROM reports GROUP BY target ORDER BY cnt DESC");
  const reportedUsers = [];
  for (const r of repRes.rows) {
    const ss = await q("SELECT image FROM report_screenshots WHERE target = $1", [r.target]);
    const reporters = (await q("SELECT reporter FROM reports WHERE target = $1 LIMIT 20", [r.target])).rows.map(x => x.reporter);
    reportedUsers.push({ target: r.target, count: parseInt(r.cnt,10), reporters, screenshot: ss.rows[0] ? ss.rows[0].image : null });
  }

  const recentVisitors = (await q("SELECT ip, fingerprint AS fp, country, ts FROM visitors_history ORDER BY ts DESC LIMIT 500")).rows;

  return {
    stats: { connected, waiting, partnered, totalVisitors, countryCounts },
    activeIpBans: ipBans,
    activeFpBans: fpBans,
    reportedUsers,
    recentVisitors,
    bannedCountries: Array.from(bannedCountriesCache)
  };
}

// helper to emit snapshot to admin sockets
function emitAdminUpdate() {
  getAdminSnapshot().then(snap => io.of("/").emit("adminUpdate", snap)).catch(err => console.error("emitAdminUpdate error:", err));
}

// ---------- Ban helpers (persist) ----------
async function banUserPersist(kind, value, durationMs) {
  const expires = new Date(Date.now() + durationMs);
  await q("INSERT INTO bans(kind, value, expires) VALUES($1,$2,$3) ON CONFLICT (kind, value) DO UPDATE SET expires = EXCLUDED.expires", [kind, value, expires]);
  await loadBansCache();
  emitAdminUpdate();
}
async function unbanPersist(kind, value) {
  await q("DELETE FROM bans WHERE kind=$1 AND value=$2", [kind, value]);
  await loadBansCache();
  emitAdminUpdate();
}

// banned countries helpers
async function addBannedCountry(code) {
  await q("INSERT INTO banned_countries(code) VALUES($1) ON CONFLICT DO NOTHING", [code]);
  await loadBannedCountriesCache();
  emitAdminUpdate();
}
async function removeBannedCountry(code) {
  await q("DELETE FROM banned_countries WHERE code=$1", [code]);
  await loadBannedCountriesCache();
  emitAdminUpdate();
}
async function clearBannedCountries() {
  await q("TRUNCATE banned_countries");
  await loadBannedCountriesCache();
  emitAdminUpdate();
}

// ---------- Cleanup job ----------
async function cleanupOldData() {
  try {
    await q("DELETE FROM visitors_history WHERE ts < NOW() - INTERVAL '30 days'");
    await q("DELETE FROM reports WHERE ts < NOW() - INTERVAL '90 days'");
    await q("DELETE FROM report_screenshots WHERE ts < NOW() - INTERVAL '90 days'");
    // keep bans and banned_countries (admin-managed)
    // refresh caches
    await loadBannedCountriesCache();
    await loadBansCache();
  } catch (e) {
    console.error("cleanupOldData error:", e);
  }
}
cleanupOldData();
setInterval(cleanupOldData, 24 * 60 * 60 * 1000);

// ---------- Persistence helpers ----------
async function persistVisitor(socketId, ip, country, fingerprint=null, waiting=false, paired=false) {
  const now = new Date();
  try {
    await q(
      `INSERT INTO visitors(socket_id, ip, fingerprint, country, ts, waiting, paired)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (socket_id) DO UPDATE SET ip=EXCLUDED.ip, fingerprint=EXCLUDED.fingerprint, country=EXCLUDED.country, ts=EXCLUDED.ts, waiting=EXCLUDED.waiting, paired=EXCLUDED.paired`,
      [socketId, ip, fingerprint, country, now, waiting, paired]
    );
    await q("INSERT INTO visitors_history(ip, fingerprint, country, ts) VALUES($1,$2,$3,$4)", [ip, fingerprint, country, now]);
  } catch (e) {
    console.error("persistVisitor error:", e);
  }
}

// persist report and possibly ban when threshold reached
async function persistReport(target, reporter) {
  try {
    await q("INSERT INTO reports(target, reporter) VALUES($1,$2)", [target, reporter]);
    const res = await q("SELECT COUNT(DISTINCT reporter) AS cnt FROM reports WHERE target=$1", [target]);
    const cnt = parseInt(res.rows[0].cnt, 10);
    if (cnt >= 3) {
      const t = await q("SELECT ip, fingerprint FROM visitors WHERE socket_id = $1", [target]);
      if (t.rows[0]) {
        const targetIp = t.rows[0].ip;
        const targetFp = t.rows[0].fingerprint;
        if (targetIp) await banUserPersist("ip", targetIp, BAN_DURATION_MS);
        if (targetFp) await banUserPersist("fingerprint", targetFp, BAN_DURATION_MS);
      }
    }
  } catch (e) {
    console.error("persistReport error:", e);
  }
}

async function saveScreenshot(target, image) {
  try {
    await q("INSERT INTO report_screenshots(target, image, ts) VALUES($1,$2,NOW()) ON CONFLICT (target) DO UPDATE SET image=EXCLUDED.image, ts=NOW()", [target, image]);
  } catch (e) {
    console.error("saveScreenshot error:", e);
  }
}

// ---------- Admin UI templates ----------
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

function adminHeader(title) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Admin — ${title}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial;padding:16px;background:#f7f7f7} .topbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px} .tab{padding:8px 12px;border-radius:6px;background:#fff;cursor:pointer;border:1px solid #eee} .panel{background:#fff;padding:12px;border-radius:8px} .screenshot-thumb{max-width:140px;max-height:90px;border:1px solid #eee;margin-left:8px;vertical-align:middle} .rep-card{padding:10px;border:1px solid #eee;border-radius:8px;margin-bottom:8px;background:#fff}</style></head><body><h1>Admin — ${title}</h1><div class="topbar"><a class="tab" href="/admin/dashboard">Dashboard</a><a class="tab" href="/admin/countries">Countries</a><a class="tab" href="/admin/stats">Stats</a><a class="tab" href="/admin/reports">Reports</a><a class="tab" href="/admin/bans">Bans</a><div style="margin-left:auto;color:#666">Signed in as admin</div></div>`;
}
function adminFooter() {
  return `<script src="/socket.io/socket.io.js"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script><script>const socket=io(); socket.emit('admin-join'); socket.on('connect', ()=> socket.emit('admin-join')); socket.on('adminUpdate', snap => { if (typeof handleAdminUpdate === 'function') handleAdminUpdate(snap); }); const ALL_COUNTRIES = ${JSON.stringify(COUNTRIES)}; function COUNTRY_NAME(c){return ALL_COUNTRIES[c]||c;}</script></body></html>`;
}

// ---------- Admin routes ----------
app.get("/admin", adminAuth, (req,res) => res.redirect("/admin/dashboard"));

app.get("/admin/dashboard", adminAuth, async (req,res) => {
  const html = adminHeader("Dashboard") + `
<div class="panel">
  <div style="display:flex;gap:12px">
    <div style="max-width:320px">
      <h3>Live Stats</h3>
      <div>Connected: <span id="stat-connected">0</span></div>
      <div>Waiting: <span id="stat-waiting">0</span></div>
      <div>Paired: <span id="stat-partnered">0</span></div>
      <div>Total visitors: <span id="stat-totalvisitors">0</span></div>
      <h4>By Country</h4><div id="country-list"></div>
    </div>
    <div style="flex:1">
      <h3>Broadcast</h3>
      <form id="broadcastForm"><textarea id="broadcastMsg" rows="3" style="width:100%"></textarea><br><br><button>Send</button></form>
      <h3>Active IP Bans</h3><div id="ip-bans"></div>
      <h3>Active Device Bans</h3><div id="fp-bans"></div>
    </div>
  </div>
  <h3 style="margin-top:12px">Reported Users</h3><div id="reported-list"></div>
  <h3 style="margin-top:12px">Recent Visitors</h3><div id="visitors-list" style="max-height:300px;overflow:auto"></div>
</div>
<script>
document.getElementById('broadcastForm').onsubmit = e => { e.preventDefault(); const msg = document.getElementById('broadcastMsg').value.trim(); if (!msg) return; fetch('/admin-broadcast', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg})}); document.getElementById('broadcastMsg').value=''; };
function renderSnapshot(snap){
  document.getElementById('stat-connected').textContent = snap.stats.connected;
  document.getElementById('stat-waiting').textContent = snap.stats.waiting;
  document.getElementById('stat-partnered').textContent = snap.stats.partnered;
  document.getElementById('stat-totalvisitors').textContent = snap.stats.totalVisitors;
  const cl=document.getElementById('country-list'); cl.innerHTML=''; const entries=Object.entries(snap.stats.countryCounts); if(entries.length===0) cl.textContent='No data'; else { entries.sort((a,b)=>b[1]-a[1]); entries.forEach(([country,cnt])=>{ const d=document.createElement('div'); d.textContent = (COUNTRY_NAME(country)||country)+': '+cnt; cl.appendChild(d); }); }
  const ipb=document.getElementById('ip-bans'); ipb.innerHTML=''; if(snap.activeIpBans.length===0) ipb.textContent='No IP bans'; else snap.activeIpBans.forEach(b=>{ const div=document.createElement('div'); const dt=new Date(b.expires).toLocaleString(); div.innerHTML='<b>'+b.ip+'</b> — expires: '+dt; ipb.appendChild(div);});
  const fpb=document.getElementById('fp-bans'); fpb.innerHTML=''; if(snap.activeFpBans.length===0) fpb.textContent='No device bans'; else snap.activeFpBans.forEach(b=>{ const div=document.createElement('div'); const dt=new Date(b.expires).toLocaleString(); div.innerHTML='<b>'+b.fp+'</b> — expires: '+dt; fpb.appendChild(div);});
  const rep=document.getElementById('reported-list'); rep.innerHTML=''; if(!snap.reportedUsers||snap.reportedUsers.length===0) rep.textContent='No reports'; else snap.reportedUsers.forEach(r=>{ const d=document.createElement('div'); d.style.border='1px solid #eee'; d.style.padding='8px'; d.style.marginBottom='8px'; d.innerHTML='<b>Target:</b> '+r.target+' — <b>Reports:</b> '+r.count; rep.appendChild(d); });
  const vis=document.getElementById('visitors-list'); vis.innerHTML=''; if(!snap.recentVisitors||snap.recentVisitors.length===0) vis.textContent='No visitors'; else snap.recentVisitors.forEach(v=>{ const d=document.createElement('div'); d.textContent = new Date(v.ts).toLocaleString()+' — '+(v.country||'Unknown')+' — '+v.ip+(v.fp?(' — '+v.fp.slice(0,8)):'' ); vis.appendChild(d);});
}
function handleAdminUpdate(snap){ renderSnapshot(snap); }
</script>
` + adminFooter();
  res.send(html);
});

// countries endpoints
app.get("/admin/countries", adminAuth, (req,res) => {
  const html = adminHeader("Countries") + `<div class="panel"><h3>Countries — Block / Unblock</h3><div id="country-area"></div><script>async function load(){ const res=await fetch('/admin/countries-list'); const data=await res.json(); const container=document.getElementById('country-area'); container.innerHTML=''; const codes=Object.keys(${JSON.stringify(COUNTRIES)}).sort((a,b)=>${JSON.stringify(COUNTRIES)}[a].localeCompare(${JSON.stringify(COUNTRIES)}[b])); const banned=new Set(data.banned||[]); codes.forEach(code=>{ const row=document.createElement('div'); row.style.display='flex'; row.style.justifyContent='space-between'; const left=document.createElement('div'); left.textContent=code+' — '+(${JSON.stringify(COUNTRIES)}[code]||code); const btn=document.createElement('button'); btn.textContent = banned.has(code)?'Unblock':'Block'; btn.onclick=async()=>{ if(banned.has(code)) await fetch('/admin/unblock-country',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})}); else await fetch('/admin/block-country',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})}); load(); }; row.appendChild(left); row.appendChild(btn); container.appendChild(row); }); } load(); </script></div>` + adminFooter();
  res.send(html);
});

app.get("/admin/countries-list", adminAuth, async (req,res) => {
  const r = await q("SELECT code FROM banned_countries");
  res.send({ all: Object.keys(COUNTRIES), banned: r.rows.map(x=>x.code) });
});

app.post("/admin/block-country", adminAuth, async (req,res) => {
  const code = (req.body.code || "").toUpperCase();
  if (!code || !COUNTRIES[code]) return res.status(400).send({ error: "invalid" });
  await addBannedCountry(code);
  res.send({ ok:true, banned: Array.from(bannedCountriesCache) });
});

app.post("/admin/unblock-country", adminAuth, async (req,res) => {
  const code = (req.body.code || "").toUpperCase();
  if (!code) return res.status(400).send({ error: "invalid" });
  await removeBannedCountry(code);
  res.send({ ok:true, banned: Array.from(bannedCountriesCache) });
});

app.post("/admin/clear-blocked", adminAuth, async (req,res) => {
  await clearBannedCountries();
  res.send({ ok:true });
});

// stats-data
app.get("/admin/stats-data", adminAuth, async (req,res) => {
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;
  let where = [];
  let params = [];
  if (from) { params.push(from.toISOString()); where.push(`ts >= $${params.length}`); }
  if (to) { params.push(new Date(to.getTime() + 24*3600*1000 - 1).toISOString()); where.push(`ts <= $${params.length}`); }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const dailySql = `SELECT to_char(ts::date, 'YYYY-MM-DD') as date, count(*) FROM visitors_history ${whereSql} GROUP BY date ORDER BY date`;
  const daily = (await q(dailySql, params)).rows.map(r=>({ date: r.date, count: parseInt(r.count,10) }));
  const countries = (await q("SELECT country, count(*) FROM visitors_history GROUP BY country ORDER BY count DESC LIMIT 50")).rows.map(r=>({ country: r.country, count: parseInt(r.count,10) }));
  const recent = (await q("SELECT ip, fingerprint as fp, country, ts FROM visitors_history ORDER BY ts DESC LIMIT 500")).rows;
  res.send({ daily, countries, recent });
});

// admin actions
app.post("/admin-broadcast", adminAuth, (req,res) => {
  const msg = req.body.message || "";
  if (msg && msg.trim()) io.emit("adminMessage", msg.trim());
  res.send({ ok:true });
});

app.post("/unban-ip", adminAuth, async (req,res) => {
  const ip = req.body.ip;
  if (!ip) return res.status(400).send({ error:true });
  await unbanPersist("ip", ip);
  res.send({ ok:true });
});

app.post("/unban-fingerprint", adminAuth, async (req,res) => {
  const fp = req.body.fp;
  if (!fp) return res.status(400).send({ error:true });
  await unbanPersist("fingerprint", fp);
  res.send({ ok:true });
});

app.post("/manual-ban", adminAuth, async (req,res) => {
  const target = req.body.target;
  if (!target) return res.status(400).send({ error:true });
  const t = await q("SELECT ip, fingerprint FROM visitors WHERE socket_id = $1", [target]);
  if (t.rows[0]) {
    if (t.rows[0].ip) await banUserPersist("ip", t.rows[0].ip, BAN_DURATION_MS);
    if (t.rows[0].fingerprint) await banUserPersist("fingerprint", t.rows[0].fingerprint, BAN_DURATION_MS);
  }
  const s = io.sockets.sockets.get(target);
  if (s) { s.emit("banned", { message: "You were banned by admin." }); s.disconnect(true); }
  emitAdminUpdate();
  res.send({ ok:true });
});

app.post("/remove-report", adminAuth, async (req,res) => {
  const target = req.body.target;
  if (!target) return res.status(400).send({ error:true });
  await q("DELETE FROM reports WHERE target = $1", [target]);
  await q("DELETE FROM report_screenshots WHERE target = $1", [target]);
  emitAdminUpdate();
  res.send({ ok:true });
});

// ---------- Socket.io logic ----------
const http = httpLib.createServer(app);
const io = socketIo(http, { pingTimeout: 30000, transports: ["websocket", "polling"] });

// Note: we persist most state in DB; keep socket logic lightweight.
io.on("connection", (socket) => {
  const ip = socket.handshake.headers["cf-connecting-ip"] || socket.handshake.address || (socket.request && socket.request.connection && socket.request.connection.remoteAddress) || "unknown";
  const headerCountry = (socket.handshake.headers["cf-ipcountry"] || socket.handshake.headers["x-country"] || "").toUpperCase();
  let country = headerCountry || (geoip.lookup(ip) ? geoip.lookup(ip).country : null);

  // quick ban checks via cache
  const ipBan = bansIpCache.get(ip);
  if (ipBan && ipBan.getTime && ipBan.getTime() > Date.now()) {
    socket.emit("banned", { message: "You are banned (IP)." });
    socket.disconnect(true);
    return;
  }
  if (country && bannedCountriesCache.has(country)) {
    socket.emit("country-blocked", { message: "الموقع محظور في بلدك", country });
    return;
  }

  // persist visitor
  persistVisitor(socket.id, ip, country, null, false, false).catch(()=>{});
  emitAdminUpdate();

  socket.on("identify", async ({ fingerprint }) => {
    if (fingerprint) {
      await q("UPDATE visitors SET fingerprint=$1 WHERE socket_id=$2", [fingerprint, socket.id]);
      // Update latest visitors_history fingerprint row (best-effort)
      try {
        await q("UPDATE visitors_history SET fingerprint=$1 WHERE ip=$2 AND ts = (SELECT max(ts) FROM visitors_history WHERE ip=$2)", [fingerprint, ip]);
      } catch (e) {}
      await loadBansCache(); // ensure fresh
      const fpBan = bansFpCache.get(fingerprint);
      if (fpBan && fpBan.getTime && fpBan.getTime() > Date.now()) {
        socket.emit("banned", { message: "Device banned." });
        socket.disconnect(true);
        return;
      }
    }
    emitAdminUpdate();
  });

  socket.on("find-partner", async () => {
    // minimal in-memory matchmaking (kept simple)
    if (!global.waitingQueue) global.waitingQueue = [];
    if (!global.partners) global.partners = new Map();
    if (!global.waitingQueue.includes(socket.id) && !global.partners.has(socket.id)) global.waitingQueue.push(socket.id);
    // try match
    while (global.waitingQueue.length >= 2) {
      const a = global.waitingQueue.shift();
      const b = global.waitingQueue.shift();
      if (!a || !b) break;
      const sa = io.sockets.sockets.get(a);
      const sb = io.sockets.sockets.get(b);
      if (!sa || !sb) continue;
      global.partners.set(a, b);
      global.partners.set(b, a);
      await q("UPDATE visitors SET waiting=FALSE, paired=TRUE WHERE socket_id IN ($1,$2)", [a,b]).catch(()=>{});
      sa.emit("partner-found", { id: b, initiator: true });
      sb.emit("partner-found", { id: a, initiator: false });
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

  socket.on("report", async ({ partnerId }) => {
    if (!partnerId) return;
    await persistReport(partnerId, socket.id);
    emitAdminUpdate();
    // disconnect target if newly banned
    const rpCount = (await q("SELECT COUNT(DISTINCT reporter) AS cnt FROM reports WHERE target=$1", [partnerId])).rows[0].cnt;
    if (parseInt(rpCount,10) >= 3) {
      const t = await q("SELECT ip, fingerprint FROM visitors WHERE socket_id = $1", [partnerId]);
      if (t.rows[0]) {
        const targetIp = t.rows[0].ip;
        const targetFp = t.rows[0].fingerprint;
        if (targetIp) await banUserPersist("ip", targetIp, BAN_DURATION_MS);
        if (targetFp) await banUserPersist("fingerprint", targetFp, BAN_DURATION_MS);
      }
      const targetSocket = io.sockets.sockets.get(partnerId);
      if (targetSocket) {
        targetSocket.emit("banned", { message: "You have been banned for 24h due to multiple reports." });
        targetSocket.disconnect(true);
      }
      emitAdminUpdate();
    }
  });

  socket.on("admin-screenshot", async ({ image, partnerId }) => {
    if (!image) return;
    const target = partnerId || (global.partners && global.partners.get(socket.id));
    if (!target) return;
    await saveScreenshot(target, image);
    emitAdminUpdate();
  });

  socket.on("skip", () => {
    if (global.partners) {
      const p = global.partners.get(socket.id);
      if (p) {
        const other = io.sockets.sockets.get(p);
        if (other) other.emit("partner-disconnected");
        global.partners.delete(p);
      }
      global.partners.delete(socket.id);
    }
    if (!global.waitingQueue) global.waitingQueue = [];
    if (!global.waitingQueue.includes(socket.id)) global.waitingQueue.push(socket.id);
    emitAdminUpdate();
  });

  socket.on("disconnect", async () => {
    // mark not waiting/paired
    try {
      await q("UPDATE visitors SET waiting=FALSE, paired=FALSE WHERE socket_id=$1", [socket.id]);
    } catch (e) {}
    if (global.partners) {
      const p = global.partners.get(socket.id);
      if (p) {
        const other = io.sockets.sockets.get(p);
        if (other) other.emit("partner-disconnected");
        global.partners.delete(p);
      }
      global.partners.delete(socket.id);
    }
    emitAdminUpdate();
  });

  socket.on("admin-join", async () => {
    socket.emit("adminUpdate", await getAdminSnapshot());
  });
});

// ---------- Start server ----------
http.listen(PORT, () => {
  console.log("Server listening on port " + PORT);
  // emit initial admin update once ready
  setTimeout(() => emitAdminUpdate(), 1500);
});
