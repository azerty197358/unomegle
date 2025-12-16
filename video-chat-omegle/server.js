// FULL SERVER — REPORT SYSTEM + LIVE ADMIN PANEL + VISITORS + GEO + Country Blocking + Admin Tabs
// التعديل الوحيد: إحصاء الزيارات الفريدة خلال 24 ساعة + حفظ كل شيء في SQLite
// Minimal critical comments only.

const express = require("express");
const path = require("path");
const fs = require("fs");
const basicAuth = require("express-basic-auth");
const geoip = require("geoip-lite");
const Database = require("better-sqlite3"); // مجاني وخفيف

const app = express();
app.set("trust proxy", true);

const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static(__dirname));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const ADMIN_USERS = { admin: "admin" }; // change creds as needed
const adminAuth = basicAuth({
  users: ADMIN_USERS,
  challenge: true,
  realm: "Admin Area",
});

// ===============  SQLite  ===============
const dbFile = path.join(__dirname, "stats.db");
const db = new Database(dbFile);

// تهيئة الجداول (مرة واحدة)
db.exec(`
CREATE TABLE IF NOT EXISTS visitors(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  fp TEXT,
  country TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visitors_ts ON visitors(ts);

CREATE TABLE IF NOT EXISTS reports(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  targetId TEXT NOT NULL,
  reporterId TEXT NOT NULL,
  screenshot TEXT,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bans(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL, -- 'ip' or 'fp'
  value TEXT NOT NULL,
  expiry INTEGER NOT NULL,
  UNIQUE(type,value)
);

CREATE TABLE IF NOT EXISTS banned_countries(
  code TEXT PRIMARY KEY
);
`);

const stmtInsertVisitor = db.prepare("INSERT INTO visitors(ip,fp,country,ts) VALUES(?,?,?,?)");
const stmtUniqueVisitors24h = db.prepare(`
  SELECT COUNT(DISTINCT ip||'|'||COALESCE(fp,'')) as cnt
  FROM visitors
  WHERE ts > ?
`);
const stmtVisitorsByCountry24h = db.prepare(`
  SELECT country,COUNT(DISTINCT ip||'|'||COALESCE(fp,'')) as cnt
  FROM visitors
  WHERE ts > ?
  GROUP BY country
  ORDER BY cnt DESC
`);
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

// ===============  Countries list (static)  ===============
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

// ===============  core data (existing)  ===============
const waitingQueue = [];
const partners = new Map(); // socket.id -> partnerId
const userFingerprint = new Map(); // socket.id -> fingerprint
const userIp = new Map(); // socket.id -> ip

const BAN_DURATION = 24 * 60 * 60 * 1000; // 24h

// ===============  helpers  ===============
function emitAdminUpdate() {
  io.of("/").emit("adminUpdate", getAdminSnapshot());
}

function banUser(ip, fp) {
  const expiry = Date.now() + BAN_DURATION;
  if (ip) stmtInsertBan.run("ip", ip, expiry);
  if (fp) stmtInsertBan.run("fp", fp, expiry);
}

function unbanUser(ip, fp) {
  if (ip) stmtDeleteBan.run("ip", ip);
  if (fp) stmtDeleteBan.run("fp", fp);
  emitAdminUpdate();
}

function getAdminSnapshot() {
  const now = Date.now();
  const cutoff24h = now - 24*3600*1000;

  // unique visitors last 24h
  const unique24h = stmtUniqueVisitors24h.get(cutoff24h).cnt;
  const byCountry24h = stmtVisitorsByCountry24h.all(cutoff24h);

  // active bans
  const activeBans = stmtActiveBans.all(now);
  const activeIpBans = activeBans.filter(r => r.type === "ip").map(r => ({ ip: r.value, expires: r.expiry }));
  const activeFpBans = activeBans.filter(r => r.type === "fp").map(r => ({ fp: r.value, expires: r.expiry }));

  // reports
  const dbReports = stmtGetReports.all();
  const reportsMap = new Map(); // targetId -> {count,reporters,screenshot}
  for (const row of dbReports) {
    if (!reportsMap.has(row.targetId)) reportsMap.set(row.targetId, { count: 0, reporters: new Set(), screenshot: null });
    const obj = reportsMap.get(row.targetId);
    obj.count++;
    obj.reporters.add(row.reporterId);
    if (row.screenshot) obj.screenshot = row.screenshot;
  }
  const reportedUsers = Array.from(reportsMap.entries()).map(([target, obj]) => ({
    target,
    count: obj.count,
    reporters: Array.from(obj.reporters),
    screenshot: obj.screenshot
  }));

  // recent visitors (last 500)
  const recentVisitors = db.prepare("SELECT ip,fp,country,ts FROM visitors ORDER BY ts DESC LIMIT 500").all();

  // banned countries
  const bannedCountries = stmtGetBannedCountries.all().map(r => r.code);

  return {
    stats: {
      connected: io.of("/").sockets.size,
      waiting: waitingQueue.length,
      partnered: partners.size / 2,
      totalVisitors: unique24h,
      countryCounts: Object.fromEntries(byCountry24h.map(r => [r.country, r.cnt]))
    },
    activeIpBans,
    activeFpBans,
    reportedUsers,
    recentVisitors,
    bannedCountries
  };
}

// ===============  admin page (FULL HTML)  ===============
app.get("/admin", adminAuth, (req, res) => {
  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Admin Panel — Live (Tabs)</title>
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
</style>
</head>
<body>
<h1>Admin — Live Dashboard (Tabs)</h1>

<div class="topbar" id="tabs">
  <div class="tab active" data-tab="dashboard">Dashboard</div>
  <div class="tab" data-tab="countries">Countries</div>
  <div class="tab" data-tab="stats">Stats</div>
  <div class="tab" data-tab="reports">Reports</div>
  <div class="tab" data-tab="bans">Bans</div>
  <div style="margin-left:auto;color:#666">Signed in as admin</div>
</div>

<div id="content">
  <!-- Dashboard -->
  <div class="panel" id="panel-dashboard">
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
        <h3>Reported Users</h3>
        <div id="reported-list" class="small"></div>
      </div>

      <div class="card">
        <h3>Recent Visitors</h3>
        <div id="visitors-list" class="small" style="max-height:360px;overflow:auto"></div>
      </div>
    </div>
  </div>

  <!-- Countries Panel -->
  <div class="panel" id="panel-countries" style="display:none">
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

  <!-- Stats Panel -->
  <div class="panel" id="panel-stats" style="display:none">
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

  <!-- Reports Panel -->
  <div class="panel" id="panel-reports" style="display:none">
    <h3>Reports</h3>
    <div id="reports-panel"></div>
  </div>

  <!-- Bans Panel -->
  <div class="panel" id="panel-bans" style="display:none">
    <h3>Manage Bans</h3>
    <div id="bans-panel"></div>
  </div>

</div>

<script src="/socket.io/socket.io.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script>
  const socket = io();
  socket.emit('admin-join');

  // tabs
  document.querySelectorAll('.tab').forEach(t => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
      t.classList.add('active');
      const tab = t.dataset.tab;
      document.querySelectorAll('[id^=panel-]').forEach(p=>p.style.display='none');
      document.getElementById('panel-' + tab).style.display = 'block';
      if (tab === 'countries') loadCountries();
      if (tab === 'stats') loadStats();
      if (tab === 'reports') renderReports();
      if (tab === 'bans') renderBans();
    };
  });

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

    // bans
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

    // reports
    const rep = document.getElementById('reported-list');
    rep.innerHTML = '';
    if (snap.reportedUsers.length === 0) rep.textContent = 'No reports';
    else snap.reportedUsers.forEach(r => {
      const div = document.createElement('div');
      div.className = 'rep-card';
      const left = document.createElement('div');
      left.style.display='inline-block'; left.style.verticalAlign='top'; left.style.width='160px';
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
        fetch('/manual-ban', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ target: r.target })}).then(()=>{});
      };
      const removeBtn = document.createElement('button'); removeBtn.textContent='Remove Report'; removeBtn.style.background='#6c757d'; removeBtn.style.marginRight='8px';
      removeBtn.onclick = ()=> {
        if (!confirm('Remove report for user ' + r.target + ' ?')) return;
        fetch('/remove-report', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ target: r.target })}).then(()=>{});
      };
      btnWrap.appendChild(banBtn); btnWrap.appendChild(removeBtn); right.appendChild(btnWrap);
      div.appendChild(left); div.appendChild(right); rep.appendChild(div);
    });

    // visitors list
    const vis = document.getElementById('visitors-list');
    vis.innerHTML = '';
    if (snap.recentVisitors.length === 0) vis.textContent = 'No visitors yet';
    else snap.recentVisitors.forEach(v => {
      const d = document.createElement('div');
      d.textContent = new Date(v.ts).toLocaleString() + ' — ' + (v.country || 'Unknown') + ' — ' + v.ip + (v.fp ? ' — ' + v.fp.slice(0,8) : '');
      vis.appendChild(d);
    });

    // blocked countries (summary)
    const bc = document.getElementById('blocked-countries');
    bc.innerHTML = '';
    if (snap.bannedCountries.length === 0) bc.textContent = 'No blocked countries';
    else snap.bannedCountries.forEach(c => {
      const div = document.createElement('div'); div.textContent = (c + ' — ' + (COUNTRY_NAME(c) || c)); bc.appendChild(div);
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
    fetch('/admin-broadcast', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({message: msg})}).then(()=>{});
    document.getElementById('broadcastMsg').value = '';
  };

  // --- Countries tab logic ---
  const ALL_COUNTRIES = ${JSON.stringify(COUNTRIES)};
  function COUNTRY_NAME(code){ return ALL_COUNTRIES[code] || code; }

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
          await fetch('/admin/unblock-country', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ code })}).then(()=>{});
        } else {
          await fetch('/admin/block-country', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ code })}).then(()=>{});
        }
        loadCountries();
      };
      action.appendChild(btn);
      div.appendChild(left); div.appendChild(action);
      container.appendChild(div);
    });

    // clear all
    document.getElementById('clear-blocks').onclick = async () => {
      if (!confirm('Clear all blocked countries?')) return;
      await fetch('/admin/clear-blocked', {method:'POST'}).then(()=>{});
      loadCountries();
    };

    // update blocked-countries list
    const bc = document.getElementById('blocked-countries');
    bc.innerHTML = '';
    if (data.banned.length === 0) bc.textContent = 'No blocked countries';
    else data.banned.forEach(c => {
      const d = document.createElement('div'); d.textContent = c + ' — ' + COUNTRY_NAME(c); bc.appendChild(d);
    });
  }

  // --- Stats tab logic ---
  let visitorsChart = null, countryChart = null;
  async function loadStats() {
    const from = document.getElementById('fromDate').value;
    const to = document.getElementById('toDate').value;
    const params = new URLSearchParams();
    if (from) params.append('from', from);
    if (to) params.append('to', to);
    const res = await fetch('/admin/stats-data?' + params.toString());
    const data = await res.json();

    // visitors line
    const ctx = document.getElementById('visitorsChart').getContext('2d');
    const labels = data.daily.map(d=>d.date);
    const values = data.daily.map(d=>d.count);
    if (visitorsChart) visitorsChart.destroy();
    visitorsChart = new Chart(ctx, { type:'line', data:{ labels, datasets:[{ label:'Visitors', data:values, fill:false, tension:0.2 }] }, options:{ responsive:true } });

    // countries bar
    const ctx2 = document.getElementById('countryChart').getContext('2d');
    const cLabels = data.countries.map(c=>c.country);
    const cVals = data.countries.map(c=>c.count);
    if (countryChart) countryChart.destroy();
    countryChart = new Chart(ctx2, { type:'bar', data:{ labels:cLabels, datasets:[{ label:'By Country', data:cVals }] }, options:{ responsive:true } });

    // visitors list
    const list = document.getElementById('stat-visitors-list'); list.innerHTML='';
    data.recent.forEach(v => {
      const d = document.createElement('div'); d.textContent = new Date(v.ts).toLocaleString() + ' — ' + (v.country||'Unknown') + ' — ' + v.ip + (v.fp?(' — '+v.fp.slice(0,8)):''); list.appendChild(d);
    });
  }

  document.getElementById('refreshStats').onclick = loadStats;

  // --- Reports/Bans renderers reuse adminUpdate snapshot ---
  function renderReports(){
    // snapshot will populate reports via adminUpdate
  }
  function renderBans(){
    // snapshot will populate bans via adminUpdate
  }

  // helper to render reports/bans will be handled by adminUpdate snapshot updates

  // initial load
  socket.on('adminUpdate', snap => { renderSnapshot(snap); });
  // manual call to load countries for initial
  loadCountries();
  loadStats();
</script>
</body>
</html>`);
});

// ===============  admin endpoints  ===============
app.get("/admin/countries-list", adminAuth, (req, res) => {
  const banned = stmtGetBannedCountries.all().map(r => r.code);
  res.send({ all: Object.keys(COUNTRIES), banned });
});

app.post("/admin/block-country", adminAuth, (req, res) => {
  const code = (req.body.code || "").toUpperCase();
  if (!code || !COUNTRIES[code]) return res.status(400).send({ error: "invalid" });
  stmtInsertBannedCountry.run(code);
  emitAdminUpdate();
  res.send({ ok: true });
});

app.post("/admin/unblock-country", adminAuth, (req, res) => {
  const code = (req.body.code || "").toUpperCase();
  stmtDeleteBannedCountry.run(code);
  emitAdminUpdate();
  res.send({ ok: true });
});

app.post("/admin/clear-blocked", adminAuth, (req, res) => {
  stmtClearBannedCountries.run();
  emitAdminUpdate();
  res.send({ ok: true });
});

app.get("/admin/stats-data", adminAuth, (req, res) => {
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;
  const params = [];
  let where = "";
  if (from) { where += " WHERE ts >= ?"; params.push(from.getTime()); }
  if (to) { where += (where ? " AND" : " WHERE") + " ts <= ?"; params.push(to.getTime() + 24*3600*1000 -1); }

  // daily
  const dailyMap = new Map();
  const rows = db.prepare("SELECT ts FROM visitors" + where).all(params);
  for (const r of rows) {
    const key = new Date(r.ts).toISOString().slice(0,10);
    dailyMap.set(key, (dailyMap.get(key)||0) + 1);
  }
  const daily = Array.from(dailyMap.entries()).sort((a,b)=>a[0].localeCompare(b[0])).map(([date,count])=>({date,count}));

  // countries
  const countryRows = db.prepare("SELECT country,COUNT(DISTINCT ip||'|'||COALESCE(fp,'')) as cnt FROM visitors" + where + " GROUP BY country ORDER BY cnt DESC LIMIT 50").all(params);
  const countries = countryRows.map(r => ({ country: r.country || "Unknown", count: r.cnt }));

  // recent
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
  emitAdminUpdate();
  res.send({ ok: true });
});

app.post("/remove-report", adminAuth, (req, res) => {
  const target = req.body.target;
  if (!target) return res.status(400).send({ error: true });
  stmtDeleteReports.run(target);
  emitAdminUpdate();
  res.send({ ok: true });
});

// ===============  socket logic (enhanced)  ===============
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
  // insert visitor
  stmtInsertVisitor.run(ip, null, country, ts);

  // check bans
  const ipBan = stmtActiveBans.all(Date.now()).find(r => r.type === "ip" && r.value === ip);
  if (ipBan) {
    socket.emit("banned", { message: "You are banned (IP)." });
    socket.disconnect(true);
    emitAdminUpdate();
    return;
  }

  // check country block
  const bannedCountries = stmtGetBannedCountries.all().map(r => r.code);
  if (country && bannedCountries.includes(country)) {
    socket.emit("country-blocked", { message: "الموقع محظور في بلدك", country });
    emitAdminUpdate();
    return;
  }

  emitAdminUpdate();

  socket.on("identify", ({ fingerprint }) => {
    if (fingerprint) {
      userFingerprint.set(socket.id, fingerprint);
      // update fp in last inserted row (simplest way)
      db.prepare("UPDATE visitors SET fp=? WHERE ip=? AND ts=?").run(fingerprint, ip, ts);
      const fpBan = stmtActiveBans.all(Date.now()).find(r => r.type === "fp" && r.value === fingerprint);
      if (fpBan) {
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
      const fExp = stmtActiveBans.all(Date.now()).find(r => r.type === "fp" && r.value === fp);
      if (fExp) {
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

  socket.on("admin-screenshot", ({ image, partnerId }) => {
    if (!image) return;
    const target = partnerId || partners.get(socket.id);
    if (!target) return;
    // store screenshot in last report row for this target
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
    if (exists) return; // لا تكرار
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

  socket.on("admin-join", () => {
    socket.emit("adminUpdate", getAdminSnapshot());
  });

  emitAdminUpdate();
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log("Server listening on port " + PORT));
