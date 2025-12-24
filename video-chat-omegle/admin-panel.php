<?php
require_once __DIR__.'/auth.php';
?>
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Admin Panel — Live Dashboard with Database</title>
<style>
  :root {
    --primary: #4b6cb7;
    --primary-dark: #182848;
    --success: #10b981;
    --danger: #ef4444;
    --warning: #f59e0b;
    --dark: #1e293b;
    --gray: #64748b;
    --light-gray: #f1f5f9;
    --white: #ffffff;
    --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    --shadow-lg: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
  }
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }
  body {
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    background: linear-gradient(135deg, var(--light-gray) 0%, #e2e8f0 100%);
    padding: 20px;
    min-height: 100vh;
    color: var(--dark);
  }
  h1 {
    color: var(--primary-dark);
    margin-bottom: 24px;
    font-size: 28px;
    font-weight: 700;
  }
  /* Enhanced Tabs */
  .topbar {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 24px;
    background: var(--white);
    padding: 12px;
    border-radius: 12px;
    box-shadow: var(--shadow);
  }
  .tab {
    padding: 12px 20px;
    border-radius: 8px;
    background: var(--light-gray);
    cursor: pointer;
    border: none;
    transition: all 0.3s ease;
    font-weight: 600;
    color: var(--gray);
    position: relative;
  }
  .tab:hover {
    background: #e2e8f0;
    transform: translateY(-2px);
  }
  .tab.active {
    background: linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%);
    color: var(--white);
    box-shadow: var(--shadow);
  }
  .tab.active::after {
    content: '';
    position: absolute;
    bottom: -12px;
    left: 50%;
    transform: translateX(-50%);
    width: 0;
    height: 0;
    border-left: 8px solid transparent;
    border-right: 8px solid transparent;
    border-top: 8px solid var(--primary-dark);
  }
  /* Panels */
  .panel {
    background: var(--white);
    padding: 24px;
    border-radius: 12px;
    box-shadow: var(--shadow-lg);
    animation: fadeIn 0.3s ease;
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .row {
    display: flex;
    gap: 24px;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  /* Cards */
  .card {
    background: var(--white);
    padding: 20px;
    border-radius: 12px;
    box-shadow: var(--shadow);
    flex: 1;
    min-width: 300px;
    transition: transform 0.3s ease;
  }
  .card:hover {
    transform: translateY(-4px);
  }
  .card h3 {
    color: var(--primary-dark);
    margin-bottom: 16px;
    font-size: 18px;
    padding-bottom: 8px;
    border-bottom: 2px solid var(--light-gray);
  }
  .card h4 {
    color: var(--primary);
    margin: 16px 0 12px 0;
    font-size: 16px;
  }
  /* Stats */
  .stat {
    font-size: 32px;
    font-weight: 800;
    color: var(--primary);
    display: block;
    margin: 4px 0;
  }
  /* Enhanced Country List */
  #country-list {
    max-height: 240px;
    overflow-y: auto;
    padding: 12px;
    background: var(--light-gray);
    border-radius: 8px;
  }
  /* Top Countries List - New Design */
  .top-countries-list {
    max-height: 400px;
    overflow-y: auto;
    margin-top: 16px;
  }
  .country-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    margin-bottom: 8px;
    background: var(--white);
    border-radius: 8px;
    box-shadow: var(--shadow);
    transition: all 0.3s ease;
    border-left: 4px solid var(--primary);
  }
  .country-item:hover {
    background: #f8fafc;
    transform: translateX(4px);
    box-shadow: 0 6px 12px rgba(0, 0, 0, 0.1);
  }
  .country-name {
    font-weight: 600;
    color: var(--dark);
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .country-flag {
    font-size: 18px;
  }
  .country-count {
    font-weight: 700;
    color: var(--primary);
    font-size: 16px;
    background: linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%);
    color: white;
    padding: 4px 12px;
    border-radius: 20px;
    min-width: 40px;
    text-align: center;
  }
  .country-rank {
    background: var(--light-gray);
    color: var(--gray);
    padding: 4px 8px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 600;
    margin-right: 8px;
  }
  #ip-bans, #fp-bans, #reported-list, #visitors-list, #blocked-countries {
    max-height: 400px;
    overflow-y: auto;
    padding: 12px;
    background: var(--light-gray);
    border-radius: 8px;
  }
  /* Buttons */
  button {
    padding: 10px 16px;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 600;
    transition: all 0.2s ease;
    color: var(--white);
  }
  button:hover {
    transform: scale(1.05);
    opacity: 0.9;
  }
  .unban { background: linear-gradient(135deg, var(--success) 0%, #059669 100%); }
  .ban { background: linear-gradient(135deg, var(--danger) 0%, #dc2626 100%); }
  .broadcast { background: linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%); }
  .clear { background: linear-gradient(135deg, var(--danger) 0%, #b91c1c 100%); }
  .export { background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); }
  /* Forms */
  textarea {
    width: 100%;
    border: 2px solid #e2e8f0;
    border-radius: 8px;
    padding: 12px;
    font-family: inherit;
    font-size: 14px;
    transition: border-color 0.3s;
  }
  textarea:focus {
    outline: none;
    border-color: var(--primary);
  }
  /* Country List */
  .country-list {
    max-height: 500px;
    overflow-y: auto;
  }
  .country-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px;
    margin-bottom: 8px;
    background: var(--white);
    border-radius: 8px;
    box-shadow: var(--shadow);
    transition: all 0.2s ease;
  }
  .country-item:hover {
    background: #f8fafc;
    transform: translateX(4px);
  }
  .flex {
    display: flex;
    gap: 12px;
    align-items: center;
  }
  input[type="checkbox"] {
    width: 18px;
    height: 18px;
    cursor: pointer;
  }
  /* Reports */
  .rep-card {
    padding: 16px;
    border-left: 4px solid var(--primary);
    border-radius: 8px;
    margin-bottom: 12px;
    background: var(--light-gray);
    transition: all 0.3s ease;
  }
  .rep-card:hover {
    box-shadow: var(--shadow);
    border-left-color: var(--danger);
  }
  .rep-card img {
    border-radius: 8px;
    border: 2px solid var(--white);
  }
  /* Dashboard Grid */
  .dashboard-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 24px;
  }
  /* Stats Panel */
  .charts-container {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 24px;
  }
  /* Enhanced Stats Grid */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 16px;
    margin-bottom: 20px;
  }
  .stat-item {
    background: var(--white);
    padding: 16px;
    border-radius: 8px;
    box-shadow: var(--shadow);
    text-align: center;
    transition: transform 0.3s ease;
  }
  .stat-item:hover {
    transform: translateY(-2px);
  }
  .stat-label {
    font-size: 12px;
    color: var(--gray);
    font-weight: 600;
    text-transform: uppercase;
    margin-bottom: 8px;
  }
  .stat-value {
    font-size: 28px;
    font-weight: 800;
    color: var(--primary);
  }
  /* Fixed Chart Container */
  .chart-container {
    position: relative;
    height: 400px;
    width: 100%;
  }
  /* Stats Country List */
  .stats-country-list {
    max-height: 300px;
    overflow-y: auto;
    padding: 12px;
    background: var(--light-gray);
    border-radius: 8px;
  }
  /* Data Export Section */
  .export-section {
    margin-top: 24px;
    background: var(--white);
    padding: 20px;
    border-radius: 12px;
    box-shadow: var(--shadow);
  }
  .export-options {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 16px;
  }
  .export-option {
    background: var(--light-gray);
    padding: 12px 16px;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.3s ease;
    border: 2px solid transparent;
  }
  .export-option:hover {
    background: #e2e8f0;
    border-color: var(--primary);
  }
  @media (max-width: 768px) {
    .row, .charts-container, .dashboard-grid {
      grid-template-columns: 1fr;
    }
    .topbar {
      overflow-x: auto;
    }
    .tab {
      padding: 10px 14px;
      font-size: 14px;
    }
    .stats-grid {
      grid-template-columns: 1fr;
    }
    .chart-container {
      height: 300px;
    }
  }
</style>
<base target="_blank">
</head>
<body>
<h1>📊 Admin Live Dashboard with Database</h1>
<div class="topbar" id="tabs">
  <div class="tab active" data-tab="dashboard">📈 Dashboard</div>
  <div class="tab" data-tab="countries">🌍 Countries</div>
  <div class="tab" data-tab="stats">📊 Statistics</div>
  <div class="tab" data-tab="reports">🚨 Reports</div>
  <div class="tab" data-tab="bans">⚠️ Bans</div>
  <div class="tab" data-tab="database">🗄️ Database</div>
  <div style="margin-left:auto;color:var(--gray);font-size:14px;font-weight:600">👤 Admin Mode</div>
</div>
<div id="content">
  <!-- Dashboard Panel -->
  <div class="panel" id="panel-dashboard">
    <div class="dashboard-grid">
      <div class="card">
        <h3>📡 Live Statistics</h3>
        <div class="stats-grid">
          <div class="stat-item">
            <div class="stat-label">Connected Users</div>
            <span id="stat-connected" class="stat-value">0</span>
          </div>
          <div class="stat-item">
            <div class="stat-label">Waiting</div>
            <span id="stat-waiting" class="stat-value">0</span>
          </div>
          <div class="stat-item">
            <div class="stat-label">Paired</div>
            <span id="stat-partnered" class="stat-value">0</span>
          </div>
          <div class="stat-item">
            <div class="stat-label">Total Visitors</div>
            <span id="stat-totalvisitors" class="stat-value">0</span>
          </div>
        </div>
      
        <h4>🌐 Top Countries</h4>
        <div id="country-list" class="top-countries-list"></div>
      </div>
      <div class="card">
        <h3>📢 Broadcast Message</h3>
        <form id="broadcastForm">
          <textarea id="broadcastMsg" rows="4" placeholder="Type your message to broadcast to all users..."></textarea><br><br>
          <button class="broadcast">Send Broadcast</button>
        </form>
      </div>
      <div class="card">
        <h3>🚫 Active Bans</h3>
        <h4>IP Bans</h4>
        <div id="ip-bans" class="small"></div>
      
        <h4>Device Bans</h4>
        <div id="fp-bans" class="small"></div>
      </div>
      <div class="card">
        <h3>🚨 Reported Users</h3>
        <div id="reported-list" class="small"></div>
      </div>
      <div class="card" style="grid-column: 1 / -1;">
        <h3>👥 Recent Unique Visitors (Last 50 IPs)</h3>
        <div id="visitors-list" class="small"></div>
      </div>
    </div>
  </div>
  <!-- Countries Panel -->
  <div class="panel" id="panel-countries" style="display:none">
    <h2>🌍 Country Management</h2>
    <div style="display:grid;grid-template-columns:1fr 320px;gap:24px">
      <div>
        <h3>All Countries</h3>
        <div class="country-list" id="all-countries"></div>
      </div>
      <div>
        <div class="card">
          <h4>🔒 Blocked Countries</h4>
          <div id="blocked-countries"></div>
          <button id="clear-blocks" class="clear" style="width:100%;margin-top:16px">Clear All Blocks</button>
        </div>
      </div>
    </div>
    <div style="margin-top:16px;background:#fff3cd;padding:12px;border-radius:8px;color:#856404;">
      💡 الملاحظة: الحظر سيؤدي إلى تعطيل الكاميرا والدردشة وإظهار رسالة "الموقع محظور في بلدك" للمستخدمين من هذه الدول فور اتصالهم.
    </div>
  </div>
  <!-- Stats Panel -->
  <div class="panel" id="panel-stats" style="display:none">
    <h2>📊 Visitors Analytics</h2>
    <div class="charts-container">
      <div class="card">
        <h3>Daily Visitors Trend</h3>
        <div class="chart-container">
          <canvas id="visitorsChart"></canvas>
        </div>
      </div>
      <div class="card">
        <h3>Top Countries</h3>
        <div id="stats-country-list" class="stats-country-list"></div>
      
        <h4 style="margin-top:24px">📅 Date Range</h4>
        <div style="display:flex;flex-direction:column;gap:12px">
          <label style="display:flex;flex-direction:column;gap:4px">
            <span class="small">From</span>
            <input type="date" id="fromDate" style="padding:8px;border:2px solid #e2e8f0;border-radius:6px">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px">
            <span class="small">To</span>
            <input type="date" id="toDate" style="padding:8px;border:2px solid #e2e8f0;border-radius:6px">
          </label>
          <button id="refreshStats" class="broadcast" style="width:100%">Refresh Charts</button>
        </div>
      </div>
    </div>
  </div>
  <!-- Reports Panel -->
  <div class="panel" id="panel-reports" style="display:none">
    <h2>🚨 User Reports</h2>
    <div id="reports-panel"></div>
  </div>
  <!-- Bans Panel -->
  <div class="panel" id="panel-bans" style="display:none">
    <h2>⚠️ Ban Management</h2>
    <div id="bans-panel"></div>
  </div>
  <!-- Database Panel -->
  <div class="panel" id="panel-database" style="display:none">
    <h2>🗄️ Database Management</h2>
    
    <div class="export-section">
      <h3>📊 Export Data</h3>
      <p style="color:var(--gray);margin-bottom:16px;">جميع بيانات الزوار والأحصائيات مخزنة بشكل دائم في قاعدة البيانات ولن تحذف أبداً.</p>
      
      <div class="export-options">
        <div class="export-option" onclick="exportData('visitors')">
          <div style="font-size:32px;">👥</div>
          <div style="font-weight:600;">All Visitors Data</div>
          <div style="font-size:12px;color:var(--gray);">جميع الزوار (IP، الدولة، الوقت)</div>
        </div>
        
        <div class="export-option" onclick="exportData('statistics')">
          <div style="font-size:32px;">📈</div>
          <div style="font-weight:600;">Daily Statistics</div>
          <div style="font-size:12px;color:var(--gray);">الإحصائيات اليومية</div>
        </div>
        
        <div class="export-option" onclick="exportData('bans')">
          <div style="font-size:32px;">🚫</div>
          <div style="font-weight:600;">Bans History</div>
          <div style="font-size:12px;color:var(--gray);">سجل الحظر</div>
        </div>
        
        <div class="export-option" onclick="exportData('reports')">
          <div style="font-size:32px;">🚨</div>
          <div style="font-weight:600;">Reports History</div>
          <div style="font-size:12px;color:var(--gray);">سجل البلاغات</div>
        </div>
        
        <div class="export-option" onclick="exportData('full')">
          <div style="font-size:32px;">💾</div>
          <div style="font-weight:600;">Full Database Backup</div>
          <div style="font-size:12px;color:var(--gray);">نسخة احتياطية كاملة</div>
        </div>
      </div>
      
      <div style="margin-top:24px;">
        <button class="export" onclick="exportData('full')" style="padding:12px 24px;font-size:16px;">
          ⬇️ Download Complete Database Backup
        </button>
      </div>
    </div>
    
    <div class="card" style="margin-top:24px;">
      <h3>📈 Database Statistics</h3>
      <div id="db-stats" style="padding:16px;background:var(--light-gray);border-radius:8px;">
        جاري تحميل إحصائيات قاعدة البيانات...
      </div>
      <button onclick="loadDatabaseStats()" class="broadcast" style="margin-top:16px;">
        🔄 Refresh Database Stats
      </button>
    </div>
    
    <div class="card" style="margin-top:24px;background:#fff3cd;border-color:#f59e0b;">
      <h3 style="color:#d97706;">⚠️ Important Notice</h3>
      <p style="color:#92400e;">
        • جميع بيانات الزوار تخزن بشكل دائم ولا تحذف تلقائياً<br>
        • يمكنك تصدير البيانات في أي وقت بصيغة JSON<br>
        • النسخ الاحتياطية تحفظ جميع الإحصائيات والتواريخ<br>
        • يمكن استيراد البيانات لاحقاً إذا لزم الأمر
      </p>
    </div>
  </div>
</div>
<script src="https://cdn.socket.io/4.0.0/socket.io.min.js "></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js "></script>
<script>
  const socket = io();
  socket.emit('admin-join');
  
  // Tabs
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
      if (tab === 'database') loadDatabaseStats();
    };
  });
  
  function renderSnapshot(snap) {
    document.getElementById('stat-connected').textContent = snap.stats.connected || 0;
    document.getElementById('stat-waiting').textContent = snap.stats.waiting || 0;
    document.getElementById('stat-partnered').textContent = snap.stats.partnered || 0;
    document.getElementById('stat-totalvisitors').textContent = snap.stats.totalVisitors || 0;
    
    // Enhanced Countries list with new design
    const cl = document.getElementById('country-list');
    cl.innerHTML = '';
    const entries = Object.entries(snap.stats.countryCounts || {});
    if (entries.length === 0) {
      cl.textContent = 'No data';
    } else {
      entries.sort((a,b)=>b[1]-a[1]);
      const topN = 15;
      const toShow = entries.slice(0, topN);
    
      toShow.forEach(([country, cnt], index) => {
        const d = document.createElement('div');
        d.className = 'country-item';
      
        const rank = document.createElement('span');
        rank.className = 'country-rank';
        rank.textContent = `#${index + 1}`;
      
        const nameDiv = document.createElement('div');
        nameDiv.className = 'country-name';
      
        const flag = document.createElement('span');
        flag.className = 'country-flag';
        flag.textContent = getCountryFlag(country);
      
        const name = document.createElement('span');
        name.textContent = country;
      
        nameDiv.appendChild(rank);
        nameDiv.appendChild(flag);
        nameDiv.appendChild(name);
      
        const count = document.createElement('span');
        count.className = 'country-count';
        count.textContent = cnt;
      
        d.appendChild(nameDiv);
        d.appendChild(count);
        cl.appendChild(d);
      });
    }
    
    // IP Bans
    const ipb = document.getElementById('ip-bans');
    ipb.innerHTML = snap.activeIpBans.length ? '' : '<div style="color:var(--gray)">No active IP bans</div>';
    snap.activeIpBans.forEach(b => {
      const div = document.createElement('div');
      div.style.padding = '8px';
      div.style.marginBottom = '8px';
      div.style.background = 'rgba(239, 68, 68, 0.1)';
      div.style.borderRadius = '6px';
      div.innerHTML = `<b style="color:var(--danger)">${b.ip}</b><br><small>expires: ${new Date(b.expires).toLocaleString()}</small> `;
      const btn = document.createElement('button');
      btn.textContent = 'Unban'; btn.className = 'unban';
      btn.style.padding = '6px 10px';
      btn.onclick = () => fetch('/unban-ip', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ip:b.ip})});
      div.appendChild(btn);
      ipb.appendChild(div);
    });
    
    // Fingerprint Bans
    const fpb = document.getElementById('fp-bans');
    fpb.innerHTML = snap.activeFpBans.length ? '' : '<div style="color:var(--gray)">No active device bans</div>';
    snap.activeFpBans.forEach(b => {
      const div = document.createElement('div');
      div.style.padding = '8px';
      div.style.marginBottom = '8px';
      div.style.background = 'rgba(239, 68, 68, 0.1)';
      div.style.borderRadius = '6px';
      div.innerHTML = `<b style="color:var(--danger)">${b.fp}</b><br><small>expires: ${new Date(b.expires).toLocaleString()}</small> `;
      const btn = document.createElement('button');
      btn.textContent = 'Unban'; btn.className = 'unban';
      btn.style.padding = '6px 10px';
      btn.onclick = () => fetch('/unban-fingerprint', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({fp:b.fp})});
      div.appendChild(btn);
      fpb.appendChild(div);
    });
    
    // Reported Users
    const rep = document.getElementById('reported-list');
    rep.innerHTML = snap.reportedUsers.length ? '' : '<div style="color:var(--gray)">No reports</div>';
    snap.reportedUsers.forEach(r => {
      const div = document.createElement('div'); div.className = 'rep-card';
    
      if (r.screenshot) {
        const img = document.createElement('img');
        img.src = r.screenshot; img.className = 'screenshot-thumb';
        img.style.maxWidth = '160px'; img.style.marginRight = '16px';
        const showBtn = document.createElement('button');
        showBtn.textContent = 'View Screenshot';
        showBtn.style.cssText = 'background:var(--primary);margin-top:8px;padding:6px';
        showBtn.onclick = () => {
          const w = window.open("", "_blank");
          w.document.write(`<meta charset="utf-8"><title>Screenshot</title><img src="${r.screenshot}" style="max-width:100%;display:block;margin:10px auto;">`);
        };
        div.appendChild(img); div.appendChild(showBtn);
      } else div.innerHTML += '<div style="color:var(--gray);margin-bottom:8px">📷 No screenshot</div>';
    
      div.innerHTML += `<div style="margin-top:12px"><b>Target:</b> ${r.target}<br><b>Reports:</b> <span style="color:var(--danger)">${r.count}</span></div>`;
    
      const small = document.createElement('div'); small.style.cssText = 'font-size:12px;color:var(--gray);margin-top:8px';
      small.textContent = 'Reporters: ' + (r.reporters.length ? r.reporters.join(', ') : '—');
      div.appendChild(small);
      const btnWrap = document.createElement('div'); btnWrap.style.marginTop = '12px'; btnWrap.style.display = 'flex'; btnWrap.style.gap = '8px';
      const banBtn = document.createElement('button'); banBtn.textContent = 'Ban User'; banBtn.className = 'ban';
      banBtn.onclick = () => {
        if (!confirm(`Ban user ${r.target}?`)) return;
        fetch('/manual-ban', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ target: r.target })}).then(()=>{});
      };
      const removeBtn = document.createElement('button'); removeBtn.textContent = 'Remove Report';
      removeBtn.style.cssText = 'background:var(--gray)';
      removeBtn.onclick = () => {
        if (!confirm(`Remove report for user ${r.target}?`)) return;
        fetch('/remove-report', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ target: r.target })}).then(()=>{});
      };
      btnWrap.appendChild(banBtn); btnWrap.appendChild(removeBtn); div.appendChild(btnWrap);
      rep.appendChild(div);
    });
    
    // Recent Visitors
    const vis = document.getElementById('visitors-list');
    vis.innerHTML = snap.recentVisitors.length ? '' : '<div style="color:var(--gray)">No visitors yet</div>';
    snap.recentVisitors.forEach(v => {
      const d = document.createElement('div');
      d.style.padding = '8px';
      d.style.borderBottom = '1px solid #e2e8f0';
      d.innerHTML = `<small style="color:var(--gray)">${new Date(v.ts).toLocaleString()}</small> —
                     <b>${v.country || 'Unknown'}</b> — ${v.ip}${v.fp ? ' — ' + v.fp.slice(0,8) : ''}`;
      vis.appendChild(d);
    });
    
    // Blocked Countries
    const bc = document.getElementById('blocked-countries');
    bc.innerHTML = snap.bannedCountries.length ? '' : '<div style="color:var(--gray)">No blocked countries</div>';
    snap.bannedCountries.forEach(c => {
      const d = document.createElement('div');
      d.style.padding = '8px'; d.style.marginBottom = '6px';
      d.style.background = 'rgba(239, 68, 68, 0.1)'; d.style.borderRadius = '6px';
      d.innerHTML = `<b>${c}</b> — ${COUNTRY_NAME(c)}`;
      bc.appendChild(d);
    });
  }
  
  socket.on('connect', () => socket.emit('admin-join'));
  socket.on('adminUpdate', renderSnapshot);
  
  // Broadcast form
  document.getElementById('broadcastForm').onsubmit = e => {
    e.preventDefault();
    const msg = document.getElementById('broadcastMsg').value.trim();
    if (!msg) return;
    fetch('/admin-broadcast', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({message: msg})}).then(()=>{});
    document.getElementById('broadcastMsg').value = '';
  };
  
  // Helper function to get country flags
  function getCountryFlag(countryCode) {
    const flagMap = {
      'US': '🇺🇸', 'GB': '🇬🇧', 'FR': '🇫🇷', 'DE': '🇩🇪', 'IT': '🇮🇹', 'ES': '🇪🇸',
      'CA': '🇨🇦', 'AU': '🇦🇺', 'JP': '🇯🇵', 'KR': '🇰🇷', 'CN': '🇨🇳', 'IN': '🇮🇳',
      'BR': '🇧🇷', 'RU': '🇷🇺', 'MX': '🇲🇽', 'AR': '🇦🇷', 'ZA': '🇿🇦', 'EG': '🇪🇬',
      'TR': '🇹🇷', 'IR': '🇮🇷', 'TH': '🇹🇭', 'VN': '🇻🇳', 'PH': '🇵🇭', 'MY': '🇲🇾',
      'SG': '🇸🇬', 'ID': '🇮🇩', 'BD': '🇧🇩', 'PK': '🇵🇰', 'NG': '🇳🇬', 'KE': '🇰🇪',
      'SA': '🇸🇦', 'AE': '🇦🇪', 'IL': '🇮🇱', 'UA': '🇺🇦', 'PL': '🇵🇱', 'SE': '🇸🇪',
      'NO': '🇳🇴', 'DK': '🇩🇰', 'FI': '🇫🇮', 'NL': '🇳🇱', 'BE': '🇧🇪', 'CH': '🇨🇭',
      'AT': '🇦🇹', 'CZ': '🇨🇿', 'HU': '🇭🇺', 'RO': '🇷🇴', 'BG': '🇧🇬', 'HR': '🇭🇷',
      'RS': '🇷🇸', 'SK': '🇸🇰', 'SI': '🇸🇮', 'LT': '🇱🇹', 'LV': '🇱🇻', 'EE': '🇪🇪',
      'IE': '🇮🇪', 'PT': '🇵🇹', 'GR': '🇬🇷', 'CY': '🇨🇾', 'MT': '🇲🇹', 'LU': '🇱🇺'
    };
    return flagMap[countryCode] || '🌍';
  }
  
  // Countries
  const ALL_COUNTRIES = {
    "AF":"Afghanistan","AL":"Albania","DZ":"Algeria","AS":"American Samoa","AD":"Andorra","AO":"Angola","AI":"Anguilla",
    "AQ":"Antarctica","AG":"Antigua and Barbuda","AR":"Argentina","AM":"Armenia","AW":"Aruba","AU":"Australia","AT":"Austria",
    "AZ":"Azerbaijan","BS":"Bahamas","BH":"Bahrain","BD":"Bangladesh","BB":"Barbados","BY":"Belarus","BE":"Belgium","BZ":"Belize",
    "BJ":"Benin","BM":"Bermuda","BT":"Bhutan","BO":"Bolivia","BA":"Bosnia and Herzegovina","BW":"Botswana","BR":"Brazil",
    "IO":"British Indian Ocean Territory","VG":"British Virgin Islands","BN":"Brunei","BG":"Bulgaria","BF":"Burkina Faso",
    "BI":"Burundi","CV":"Cabo Verde","KH":"Cambodia","CM":"Cameroon","CA":"Canada","KY":"Cayman Islands","CF":"Central African Republic",
    "TD":"Chad","CL":"Chile","CN":"China","CX":"Christmas Island","CC":"Cocos (Keeling) Islands","CO":"Colombia","KM":"Comoros",
    "CG":"Congo - Brazzaville","CD":"Congo - Kinshasa","CK":"Cook Islands","CR":"Costa Rica","CI":"Côte d'Ivoire","HR":"Croatia",
    "CU":"Cuba","CW":"Curaçao","CY":"Cyprus","CZ":"Czechia","DK":"Denmark","DJ":"Dijbouti","DM":"Dominica","DO":"Dominican Republic",
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
      const btn = document.createElement('button'); btn.textContent = checkbox.checked ? '🟢 Unblock' : '🔴 Block';
      btn.style.background = checkbox.checked ? 'var(--success)' : 'var(--danger)'; btn.style.color='#fff';
      btn.onclick = async () => {
        const endpoint = checkbox.checked ? '/admin/unblock-country' : '/admin/block-country';
        await fetch(endpoint, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ code })}).then(()=>{});
        loadCountries();
      };
      action.appendChild(btn);
      div.appendChild(left); div.appendChild(action);
      container.appendChild(div);
    });
    
    document.getElementById('clear-blocks').onclick = async () => {
      if (!confirm('Clear all blocked countries?')) return;
      await fetch('/admin/clear-blocked', {method:'POST'}).then(()=>{});
      loadCountries();
    };
    
    const bc = document.getElementById('blocked-countries');
    bc.innerHTML = data.banned.length ? '' : '<div style="color:var(--gray)">No blocked countries</div>';
    data.banned.forEach(c => {
      const d = document.createElement('div');
      d.style.padding = '8px'; d.style.marginBottom = '6px';
      d.style.background = 'rgba(239, 68, 68, 0.1)'; d.style.borderRadius = '6px';
      d.innerHTML = `<b>${c}</b> — ${COUNTRY_NAME(c)}`;
      bc.appendChild(d);
    });
  }
  
  // Charts
  let visitorsChart = null;
  
  async function loadStats() {
    const from = document.getElementById('fromDate').value;
    const to = document.getElementById('toDate').value;
    const params = new URLSearchParams();
    if (from) params.append('from', from);
    if (to) params.append('to', to);
  
    const res = await fetch('/admin/stats-data?' + params.toString());
    const data = await res.json();
    
    // Line chart with fixed container
    const ctx = document.getElementById('visitorsChart').getContext('2d');
    const labels = data.daily.map(d=>d.date);
    const values = data.daily.map(d=>d.count);
    
    if (visitorsChart) visitorsChart.destroy();
    visitorsChart = new Chart(ctx, {
      type:'line',
      data:{
        labels,
        datasets:[{
          label:'Daily Visitors',
          data:values,
          fill:true,
          tension:0.4,
          borderColor:'#4b6cb7',
          backgroundColor: 'rgba(75, 108, 183, 0.1)',
          pointRadius: 6,
          pointHoverRadius: 8,
          borderWidth: 3,
          pointBackgroundColor: '#fff',
          pointBorderColor: '#4b6cb7'
        }]
      },
      options:{
        responsive:true,
        maintainAspectRatio:false,
        scales: {
          y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.03)' } },
          x: { grid: { color: 'rgba(0,0,0,0.03)' } }
        },
        plugins: {
          legend: { display: true, position: 'top', labels: { font: { size: 14 } } },
          tooltip: {
            mode: 'index',
            intersect: false,
            backgroundColor: 'rgba(30, 41, 59, 0.9)',
            titleColor: '#fff',
            bodyColor: '#fff'
          }
        }
      }
    });
    
    // Update country list in stats panel
    const countryList = document.getElementById('stats-country-list');
    countryList.innerHTML = '';
    data.countries.forEach((country, index) => {
      const div = document.createElement('div');
      div.className = 'country-item';
    
      const rank = document.createElement('span');
      rank.className = 'country-rank';
      rank.textContent = `#${index + 1}`;
    
      const nameDiv = document.createElement('div');
      nameDiv.className = 'country-name';
    
      const flag = document.createElement('span');
      flag.className = 'country-flag';
      flag.textContent = getCountryFlag(country.country);
    
      const name = document.createElement('span');
      name.textContent = country.country;
    
      nameDiv.appendChild(rank);
      nameDiv.appendChild(flag);
      nameDiv.appendChild(name);
    
      const count = document.createElement('span');
      count.className = 'country-count';
      count.textContent = country.count;
    
      div.appendChild(nameDiv);
      div.appendChild(count);
      countryList.appendChild(div);
    });
  }
  
  document.getElementById('refreshStats').onclick = loadStats;
  
  // Database functions
  async function loadDatabaseStats() {
    try {
      const res = await fetch('/admin/database-stats');
      const data = await res.json();
      
      const statsDiv = document.getElementById('db-stats');
      statsDiv.innerHTML = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px;">
          <div class="stat-item">
            <div class="stat-label">Total Visitors</div>
            <div class="stat-value">${data.totalVisitors || 0}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Daily Records</div>
            <div class="stat-value">${data.dailyStats || 0}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Bans History</div>
            <div class="stat-value">${data.totalBans || 0}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Reports History</div>
            <div class="stat-value">${data.totalReports || 0}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Database Size</div>
            <div class="stat-value">${formatBytes(data.dbSize || 0)}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Last Backup</div>
            <div class="stat-value" style="font-size: 14px;">${data.lastBackup || 'Never'}</div>
          </div>
        </div>
      `;
    } catch (error) {
      console.error('Error loading database stats:', error);
      document.getElementById('db-stats').innerHTML = 
        '<div style="color: var(--danger);">Error loading database statistics</div>';
    }
  }
  
  function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }
  
  async function exportData(type) {
    try {
      const res = await fetch(`/admin/export-data?type=${type}`);
      const data = await res.json();
      
      // Create download link
      const jsonString = JSON.stringify(data, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      
      // Set filename based on type and current date
      const date = new Date().toISOString().split('T')[0];
      let filename = '';
      switch(type) {
        case 'visitors': filename = `visitors-data-${date}.json`; break;
        case 'statistics': filename = `daily-stats-${date}.json`; break;
        case 'bans': filename = `bans-history-${date}.json`; break;
        case 'reports': filename = `reports-history-${date}.json`; break;
        default: filename = `database-backup-${date}.json`;
      }
      
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      alert(`✅ Data exported successfully as ${filename}`);
    } catch (error) {
      console.error('Error exporting data:', error);
      alert('❌ Error exporting data. Please try again.');
    }
  }
  
  function renderReports(){ /* Handled by adminUpdate */ }
  function renderBans(){ /* Handled by adminUpdate */ }
  
  // Initial load
  loadCountries();
  loadStats();
  // Load database stats if on database tab
  if (window.location.hash === '#database') {
    loadDatabaseStats();
  }
</script>
</body>
</html>
