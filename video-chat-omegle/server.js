// =============== FULL SERVER – REPORT SYSTEM + LIVE ADMIN PANEL ===============
// 1) Unique-visitor counter per last-24h (fp+ip)  2) SQLite persistence  3) Free
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const basicAuth= require('express-basic-auth');
const geoip    = require('geoip-lite');
const sqlite3  = require('sqlite3').verbose();          // ← مجاني
const { open } = require('sqlite');
const sqlite   = require('sqlite');

// ---------- express & socket ----------
const app  = express();
const http = require('http').createServer(app);
const io   = require('socket.io')(http);
app.set('trust proxy', true);
app.use(express.static(__dirname));
app.use(express.json());
app.use(express.urlencoded({ extended:true }));

// ---------- auth ----------
const ADMIN_USERS = { admin: 'admin' };                       // غيّر كلمة المرور
const adminAuth = basicAuth({ users: ADMIN_USERS, challenge:true, realm:'Admin Area' });

// ---------- SQLite init ----------
let db;
(async () => {
  db = await sqlite.open({ filename:'analytics.db', driver:sqlite3.Database });
  // جدول الزيارات (فريد خلال 24س)
  await db.exec(`CREATE TABLE IF NOT EXISTS visits(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fp TEXT NOT NULL,
    ip TEXT NOT NULL,
    country TEXT,
    ts INTEGER NOT NULL,
    UNIQUE(fp,ip)
  )`);
  // جدول الحظر
  await db.exec(`CREATE TABLE IF NOT EXISTS bans(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT CHECK(type IN ('ip','fp')) NOT NULL,
    value TEXT NOT NULL,
    expiry INTEGER NOT NULL,
    UNIQUE(type,value)
  )`);
  // جدول التقارير
  await db.exec(`CREATE TABLE IF NOT EXISTS reports(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target TEXT NOT NULL,
    reporter TEXT NOT NULL,
    screenshot TEXT,
    ts INTEGER NOT NULL
  )`);
})();
// ---------- helpers ----------
const COUNTRIES = { /* نفس الكائن الطويل في كودك… اقتطاع للاختصار */ };
const BANNED_COUNTRIES_FILE = path.join(__dirname,'banned_countries.json');
let bannedCountries = new Set();
function loadBannedCountries(){
  try{ bannedCountries = new Set(JSON.parse(fs.readFileSync(BANNED_COUNTRIES_FILE,'utf8'))); }catch{}
}
function saveBannedCountries(){
  fs.writeFileSync(BANNED_COUNTRIES_FILE, JSON.stringify([...bannedCountries]));
}
loadBannedCountries();

// ---------- core maps (بيانات الرن تايم) ----------
const waitingQueue = [];
const partners = new Map();           // socket.id -> partnerId
const userFp   = new Map();           // socket.id -> fingerprint
const userIp   = new Map();           // socket.id -> ip
const reports  = new Map();           // targetId -> Set(reporters)
const reportScreens = new Map();      // targetId -> base64
const BAN_MS   = 24*60*60*1000;

// ---------- SQLite utils ----------
async function addUniqueVisit(fp,ip,country){
  const ts = Date.now();
  await db.run('INSERT OR IGNORE INTO visits(fp,ip,country,ts) VALUES (?,?,?,?)',
               [fp,ip,country||'',ts]);
}
async function countUnique24h(){
  const since = Date.now() - 24*60*60*1000;
  const row = await db.get('SELECT COUNT(*) as c FROM visits WHERE ts > ?',[since]);
  return row.c;
}
async function loadBans(){
  const now = Date.now();
  const rows = await db.all('SELECT type,value,expiry FROM bans WHERE expiry > ?',[now]);
  for(const r of rows){
    if(r.type==='ip') bannedIps.set(r.value, r.expiry);
    else bannedFps.set(r.value, r.expiry);
  }
}
async function saveBan(type,value,expiry){
  await db.run('INSERT OR REPLACE INTO bans(type,value,expiry) VALUES (?,?,?)',
               [type,value,expiry]);
}
async function removeBan(type,value){
  await db.run('DELETE FROM bans WHERE type=? AND value=?',[type,value]);
}
async function loadReports(){
  const rows = await db.all('SELECT target,reporter,screenshot FROM reports');
  for(const r of rows){
    if(!reports.has(r.target)) reports.set(r.target, new Set());
    reports.get(r.target).add(r.reporter);
    if(r.screenshot) reportScreens.set(r.target, r.screenshot);
  }
}
async function saveReport(target,reporter,screenshot=null){
  await db.run('INSERT INTO reports(target,reporter,screenshot,ts) VALUES (?,?,?,?)',
               [target,reporter,screenshot,Date.now()]);
}
async function clearReports(target){
  await db.run('DELETE FROM reports WHERE target=?',[target]);
}

// ---------- runtime ban maps ----------
const bannedIps = new Map();
const bannedFps = new Map();
loadBans();   // عند الإقلاع
loadReports();

// ---------- admin snapshot ----------
function getAdminSnapshot(){
  const now = Date.now();
  // تنظيف منتهي
  for(const [ip,exp] of bannedIps.entries()) if(exp<now) bannedIps.delete(ip);
  for(const [fp,exp] of bannedFps.entries()) if(exp<now) bannedFps.delete(fp);

  return {
    stats:{
      connected: io.of('/').sockets.size,
      waiting: waitingQueue.length,
      partnered: partners.size/2,
      unique24h: countUnique24hSync()  // نستدعيها مباشرة لأنها async
    },
    activeIpBans: [...bannedIps.entries()].map(([v,e])=>({ip:v,expires:e})),
    activeFpBans: [...bannedFps.entries()].map(([v,e])=>({fp:v,expires:e})),
    reportedUsers: Array.from(new Set([...reports.keys(),...reportScreens.keys()])).map(t=>{
      const st = reports.get(t)||new Set();
      return { target:t, count:st.size, reporters:[...st], screenshot:reportScreens.get(t)||null };
    }),
    bannedCountries: [...bannedCountries]
  };
}
let unique24hCache = 0;
async function countUnique24hSync(){
  unique24hCache = await countUnique24h();
  return unique24hCache;
}
function emitAdminUpdate(){
  const snap = getAdminSnapshot();
  io.of('/').emit('adminUpdate', snap);
}

// ---------- ban helpers ----------
function banUser(ip,fp){
  const exp = Date.now() + BAN_MS;
  if(ip){ bannedIps.set(ip,exp); saveBan('ip',ip,exp); }
  if(fp){ bannedFps.set(fp,exp); saveBan('fp',fp,exp); }
}
function unbanUser(ip,fp){
  if(ip){ bannedIps.delete(ip); removeBan('ip',ip); }
  if(fp){ bannedFps.delete(fp); removeBan('fp',fp); }
  emitAdminUpdate();
}

// ---------- admin page ----------
app.get('/admin', adminAuth, (req,res)=>{
  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8"><title>Admin Panel – SQLite Edition</title>
<style>
  body{font-family:Arial;padding:16px;background:#f7f7f7}
  .card{background:#fff;padding:12px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.05);margin-bottom:12px}
  .stat{font-size:20px;font-weight:700}
  button{padding:6px 10px;border:none;border-radius:6px;cursor:pointer;color:#fff}
  .ban{background:#d9534f}.unban{background:#28a745}.broadcast{background:#007bff}
  table{width:100%;border-collapse-collapse;font-size:13px}
  th,td{padding:6px;border-bottom:1px solid #eee}
</style>
</head>
<body>
<h1>Admin Panel – SQLite</h1>
<div class="card">
  <h3>Live Stats</h3>
  <div>Connected: <span id="c1" class="stat">0</span></div>
  <div>Waiting: <span id="c2" class="stat">0</span></div>
  <div>Paired: <span id="c3" class="stat">0</span></div>
  <div>Unique visitors (24h): <span id="c4" class="stat">0</span></div>
</div>
<div class="card">
  <h3>Broadcast</h3>
  <form id="bcast"><textarea id="msg" rows="3" style="width:100%"></textarea><br><br>
  <button class="broadcast">Send</button></form>
</div>
<div class="card"><h3>Active IP Bans</h3><div id="ipb"></div></div>
<div class="card"><h3>Active Device Bans</h3><div id="fpb"></div></div>
<div class="card"><h3>Reported Users</h3><div id="rep"></div></div>
<script src="/socket.io/socket.io.js"></script>
<script>
const socket=io(); socket.emit('admin-join');
function render(s){
  document.getElementById('c1').textContent=s.stats.connected;
  document.getElementById('c2').textContent=s.stats.waiting;
  document.getElementById('c3').textContent=s.stats.partnered;
  document.getElementById('c4').textContent=s.stats.unique24h;
  // ip bans
  const ipb=document.getElementById('ipb'); ipb.innerHTML='';
  if(!s.activeIpBans.length) ipb.textContent='No IP bans';
  else s.activeIpBans.forEach(b=>{
    const dv=document.createElement('div');
    dv.innerHTML='<b>'+b.ip+'</b> — <button class="unban">Unban</button>';
    dv.querySelector('button').onclick=()=>fetch('/unban-ip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ip:b.ip})});
    ipb.appendChild(dv);
  });
  // fp bans
  const fpb=document.getElementById('fpb'); fpb.innerHTML='';
  if(!s.activeFpBans.length) fpb.textContent='No device bans';
  else s.activeFpBans.forEach(b=>{
    const dv=document.createElement('div');
    dv.innerHTML='<b>'+b.fp.slice(0,12)+'…</b> — <button class="unban">Unban</button>';
    dv.querySelector('button').onclick=()=>fetch('/unban-fp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fp:b.fp})});
    fpb.appendChild(dv);
  });
  // reports
  const rep=document.getElementById('rep'); rep.innerHTML='';
  if(!s.reportedUsers.length) rep.textContent='No reports';
  else s.reportedUsers.forEach(u=>{
    const dv=document.createElement('div'); dv.className='card';
    dv.innerHTML='<b>Target:</b> '+u.target+' <b>Count:</b> '+u.count+
      ' <button class="ban">Ban</button> <button class="unban">Clear</button>';
    dv.querySelector('.ban').onclick=()=>fetch('/manual-ban',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({target:u.target})});
    dv.querySelector('.unban').onclick=()=>fetch('/clear-report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({target:u.target})});
    rep.appendChild(dv);
  });
}
socket.on('adminUpdate',render);
document.getElementById('bcast').onsubmit=e=>{
  e.preventDefault();
  const v=document.getElementById('msg').value.trim();
  if(v) fetch('/admin-broadcast',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:v})});
  document.getElementById('msg').value='';
};
</script>
</body>
</html>`);
});

// ---------- admin endpoints ----------
app.post('/admin-broadcast', adminAuth, (req,res)=>{
  const m=(req.body||{}).message||'';
  if(m.trim()) io.emit('adminMessage',m.trim());
  res.send({ok:true});
});
app.post('/unban-ip', adminAuth, (req,res)=>{
  unbanUser(req.body.ip,null); res.send({ok:true});
});
app.post('/unban-fp', adminAuth, (req,res)=>{
  unbanUser(null,req.body.fp); res.send({ok:true});
});
app.post('/manual-ban', adminAuth, async (req,res)=>{
  const t=req.body.target;
  if(!t) return res.status(400).send({error:true});
  const ip=userIp.get(t), fp=userFp.get(t);
  banUser(ip,fp);
  const s=io.sockets.sockets.get(t);
  if(s){ s.emit('banned',{message:'Banned by admin'}); s.disconnect(true); }
  emitAdminUpdate();
  res.send({ok:true});
});
app.post('/clear-report', adminAuth, async (req,res)=>{
  const t=req.body.target;
  if(!t) return res.status(400).send({error:true});
  reports.delete(t); reportScreens.delete(t);
  await clearReports(t);
  emitAdminUpdate();
  res.send({ok:true});
});

// ---------- socket logic ----------
io.on('connection', async socket=>{
  const ip=socket.handshake.headers['cf-connecting-ip']||
          socket.handshake.address||
          (socket.request?.connection?.remoteAddress)||'unknown';
  userIp.set(socket.id,ip);

  let country=socket.handshake.headers['cf-ipcountry']||socket.handshake.headers['x-country'];
  if(!country){
    const g=geoip.lookup(ip);
    if(g&&g.country) country=g.country;
  }

  // حظر دولة فوري
  if(country&&bannedCountries.has(country)){
    socket.emit('country-blocked',{message:'الموقع محظور في بلدك',country});
    // socket.disconnect(true); // اختَر بنفسك
    return;
  }

  // حظر IP
  if(bannedIps.has(ip) && bannedIps.get(ip)>Date.now()){
    socket.emit('banned',{message:'IP banned'}); socket.disconnect(true); return;
  }

  // إضافة زيارة فريدة
  socket.on('identify', async ({fingerprint})=>{
    if(fingerprint){
      userFp.set(socket.id,fingerprint);
      await addUniqueVisit(fingerprint,ip,country);
      if(bannedFps.has(fingerprint) && bannedFps.get(fingerprint)>Date.now()){
        socket.emit('banned',{message:'Device banned'}); socket.disconnect(true); return;
      }
    }
    emitAdminUpdate();
  });

  socket.on('find-partner',()=>{
    const fp=userFp.get(socket.id);
    if(fp && bannedFps.has(fp) && bannedFps.get(fp)>Date.now())
      { socket.emit('banned',{message:'Device banned'}); socket.disconnect(true); return; }
    if(!waitingQueue.includes(socket.id) && !partners.has(socket.id))
      waitingQueue.push(socket.id);
    tryMatch();
    emitAdminUpdate();
  });
  function tryMatch(){
    while(waitingQueue.length>=2){
      const a=waitingQueue.shift(), b=waitingQueue.shift();
      if(!a||!b) break;
      if(!io.sockets.sockets.get(a)||!io.sockets.sockets.get(b)) continue;
      partners.set(a,b); partners.set(b,a);
      io.to(a).emit('partner-found',{id:b, initiator:true});
      io.to(b).emit('partner-found',{id:a, initiator:false});
    }
  }

  socket.on('signal',({to,data})=> io.to(to).emit('signal',{from:socket.id,data}) );
  socket.on('chat-message',({to,message})=> io.to(to).emit('chat-message',{message}) );

  socket.on('report',async ({partnerId})=>{
    if(!partnerId) return;
    if(!reports.has(partnerId)) reports.set(partnerId,new Set());
    const set=reports.get(partnerId);
    set.add(socket.id);
    await saveReport(partnerId,socket.id);
    emitAdminUpdate();
    if(set.size>=3){
      const target=io.sockets.sockets.get(partnerId);
      const tip=userIp.get(partnerId), tfp=userFp.get(partnerId);
      banUser(tip,tfp);
      if(target){ target.emit('banned',{message:'Banned for multiple reports'}); target.disconnect(true); }
      emitAdminUpdate();
    }
  });

  socket.on('admin-join',()=> socket.emit('adminUpdate',getAdminSnapshot()) );

  socket.on('disconnect',()=>{
    const idx=waitingQueue.indexOf(socket.id);
    if(idx!==-1) waitingQueue.splice(idx,1);
    const p=partners.get(socket.id);
    if(p){
      const o=io.sockets.sockets.get(p);
      if(o) o.emit('partner-disconnected');
      partners.delete(p);
    }
    partners.delete(socket.id);
    userIp.delete(socket.id);
    userFp.delete(socket.id);
    emitAdminUpdate();
  });

  emitAdminUpdate();
});

// ---------- listen ----------
const PORT=process.env.PORT||3000;
http.listen(PORT,()=>{
  console.log('Server on port',PORT);
  countUnique24hSync(); // تهيئة العدد
});
