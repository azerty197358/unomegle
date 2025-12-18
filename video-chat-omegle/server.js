     1	const express = require("express");
     2	const path = require("path");
     3	const basicAuth = require("express-basic-auth");
     4	const geoip = require("geoip-lite");
     5	const Database = require("better-sqlite3");
     6	const jwt = require("jsonwebtoken");
     7	const bcrypt = require("bcryptjs");
     8	
     9	const app = express();
    10	app.set("trust proxy", true);
    11	const http = require("http").createServer(app);
    12	const io = require("socket.io")(http);
    13	
    14	app.use(express.static(__dirname));
    15	app.use(express.urlencoded({ extended: true }));
    16	app.use(express.json());
    17	
    18	// ======== إعدادات JWT والمصادقة ========
    19	const JWT_SECRET = process.env.JWT_SECRET || "your-super-secret-key-change-this-in-production";
    20	const JWT_EXPIRES_IN = "24h";
    21	
    22	// بيانات اعتماد الأدمن (يجب حفظها في قاعدة البيانات لاحقاً)
    23	const ADMIN_USERS = { 
    24	    admin: bcrypt.hashSync("admin123", 10) // كلمة المرور: admin123
    25	};
    26	
    27	// middleware للتحقق من التوكن
    28	const authenticateToken = (req, res, next) => {
    29	    const authHeader = req.headers['authorization'];
    30	    const token = authHeader && authHeader.split(' ')[1];
    31	
    32	    if (!token) {
    33	        return res.status(401).json({ success: false, message: 'Access token required' });
    34	    }
    35	
    36	    jwt.verify(token, JWT_SECRET, (err, user) => {
    37	        if (err) {
    38	            return res.status(403).json({ success: false, message: 'Invalid or expired token' });
    39	        }
    40	        req.user = user;
    41	        next();
    42	    });
    43	};
    44	
    45	// بيانات اعتماد الأدمن القديم (للتوافق)
    46	const adminAuth = basicAuth({
    47	  users: { admin: "admin" },
    48	  challenge: true,
    49	  realm: "Admin Area",
    50	});
    51	
    52	// ============== قاعدة البيانات ==============
    53	const dbFile = path.join(__dirname, "stats.db");
    54	const db = new Database(dbFile);
    55	
    56	// إنشاء الجداول
    57	db.exec(`
    58	CREATE TABLE IF NOT EXISTS visitors(
    59	  id INTEGER PRIMARY KEY AUTOINCREMENT,
    60	  ip TEXT NOT NULL, fp TEXT, country TEXT, ts INTEGER NOT NULL
    61	);
    62	CREATE INDEX IF NOT EXISTS idx_visitors_ts ON visitors(ts);
    63	CREATE INDEX IF NOT EXISTS idx_visitors_ip ON visitors(ip);
    64	
    65	CREATE TABLE IF NOT EXISTS reports(
    66	  id INTEGER PRIMARY KEY AUTOINCREMENT,
    67	  targetId TEXT NOT NULL, reporterId TEXT NOT NULL,
    68	  screenshot TEXT, ts INTEGER NOT NULL
    69	);
    70	
    71	CREATE TABLE IF NOT EXISTS bans(
    72	  id INTEGER PRIMARY KEY AUTOINCREMENT,
    73	  type TEXT NOT NULL, value TEXT NOT NULL,
    74	  expiry INTEGER NOT NULL, UNIQUE(type,value)
    75	);
    76	
    77	CREATE TABLE IF NOT EXISTS banned_countries(code TEXT PRIMARY KEY);
    78	
    79	CREATE TABLE IF NOT EXISTS admin_users(
    80	  id INTEGER PRIMARY KEY AUTOINCREMENT,
    81	  username TEXT UNIQUE NOT NULL,
    82	  password TEXT NOT NULL,
    83	  permissions TEXT DEFAULT 'ban,broadcast,reports',
    84	  created_at INTEGER DEFAULT (strftime('%s', 'now'))
    85	);
    86	`);
    87	
    88	// إنشاء أول أدمن إذا لم يكن موجوداً
    89	const existingAdmin = db.prepare("SELECT * FROM admin_users WHERE username = ?").get("admin");
    90	if (!existingAdmin) {
    91	    const hashedPassword = bcrypt.hashSync("admin123", 10);
    92	    db.prepare("INSERT INTO admin_users (username, password, permissions) VALUES (?, ?, ?)")
    93	      .run("admin", hashedPassword, "ban,broadcast,reports");
    94	    console.log("✅ Admin user created - Username: admin, Password: admin123");
    95	}
    96	
    97	// الاستعلامات المعدة
    98	const stmtInsertVisitor = db.prepare("INSERT INTO visitors(ip,fp,country,ts) VALUES(?,?,?,?)");
    99	const stmtUniqueVisitors24h = db.prepare("SELECT COUNT(DISTINCT ip||'|'||COALESCE(fp,'')) as cnt FROM visitors WHERE ts > ?");
   100	const stmtVisitorsByCountry24h = db.prepare("SELECT country,COUNT(DISTINCT ip||'|'||COALESCE(fp,'')) as cnt FROM visitors WHERE ts > ? GROUP BY country ORDER BY cnt DESC");
   101	const stmtInsertReport = db.prepare("INSERT INTO reports(targetId,reporterId,screenshot,ts) VALUES(?,?,?,?)");
   102	const stmtGetReports = db.prepare("SELECT * FROM reports");
   103	const stmtDeleteReports = db.prepare("DELETE FROM reports WHERE targetId=?");
   104	const stmtInsertBan = db.prepare("INSERT OR REPLACE INTO bans(type,value,expiry) VALUES(?,?,?)");
   105	const stmtDeleteBan = db.prepare("DELETE FROM bans WHERE type=? AND value=?");
   106	const stmtActiveBans = db.prepare("SELECT * FROM bans WHERE expiry > ?");
   107	const stmtInsertBannedCountry = db.prepare("INSERT OR IGNORE INTO banned_countries(code) VALUES(?)");
   108	const stmtDeleteBannedCountry = db.prepare("DELETE FROM banned_countries WHERE code=?");
   109	const stmtClearBannedCountries = db.prepare("DELETE FROM banned_countries");
   110	const stmtGetBannedCountries = db.prepare("SELECT code FROM banned_countries");
   111	const stmtGetAdminUser = db.prepare("SELECT * FROM admin_users WHERE username = ?");
   112	
   113	// قائمة الدول
   114	const COUNTRIES = {
   115	  "AF":"Afghanistan","AL":"Albania","DZ":"Algeria","AS":"American Samoa","AD":"Andorra","AO":"Angola","AI":"Anguilla",
   116	  "AQ":"Antarctica","AG":"Antigua and Barbuda","AR":"Argentina","AM":"Armenia","AW":"Aruba","AU":"Australia","AT":"Austria",
   117	  "AZ":"Azerbaijan","BS":"Bahamas","BH":"Bahrain","BD":"Bangladesh","BB":"Barbados","BY":"Belarus","BE":"Belgium","BZ":"Belize",
   118	  "BJ":"Benin","BM":"Bermuda","BT":"Bhutan","BO":"Bolivia","BA":"Bosnia and Herzegovina","BW":"Botswana","BR":"Brazil",
   119	  "IO":"British Indian Ocean Territory","VG":"British Virgin Islands","BN":"Brunei","BG":"Bulgaria","BF":"Burkina Faso",
   120	  "BI":"Burundi","CV":"Cabo Verde","KH":"Cambodia","CM":"Cameroon","CA":"Canada","KY":"Cayman Islands","CF":"Central African Republic",
   121	  "TD":"Chad","CL":"Chile","CN":"China","CX":"Christmas Island","CC":"Cocos (Keeling) Islands","CO":"Colombia","KM":"Comoros",
   122	  "CG":"Congo - Brazzaville","CD":"Congo - Kinshasa","CK":"Cook Islands","CR":"Costa Rica","CI":"Côte d'Ivoire","HR":"Croatia",
   123	  "CU":"Cuba","CW":"Curaçao","CY":"Cyprus","CZ":"Czechia","DK":"Denmark","DJ":"Djibouti","DM":"Dominica","DO":"Dominican Republic",
   124	  "EC":"Ecuador","EG":"Egypt","SV":"El Salvador","GQ":"Equatorial Guinea","ER":"Eritrea","EE":"Estonia","ET":"Ethiopia",
   125	  "FK":"Falkland Islands","FO":"Faroe Islands","FJ":"Fiji","FI":"Finland","FR":"France","GF":"French Guiana","PF":"French Polynesia",
   126	  "GA":"Gabon","GM":"Gambia","GE":"Georgia","DE":"Germany","GH":"Ghana","GI":"Gibraltar","GR":"Greece","GL":"Greenland","GD":"Grenada",
   127	  "GP":"Guadeloupe","GU":"Guam","GT":"Guatemala","GG":"Guernsey","GN":"Guinea","GW":"Guinea-Bissau","GY":"Guyana","HT":"Haiti",
   128	  "HN":"Honduras","HK":"Hong Kong","HU":"Hungary","IS":"Iceland","IN":"India","ID":"Indonesia","IR":"Iran","IQ":"Iraq","IE":"Ireland",
   129	  "IM":"Isle of Man","IL":"Israel","IT":"Italy","JM":"Jamaica","JP":"Japan","JE":"Jersey","JO":"Jordan","KZ":"Kazakhstan","KE":"Kenya",
   130	  "KI":"Kiribati","XK":"Kosovo","KW":"Kuwait","KG":"Kyrgyzstan","LA":"Laos","LV":"Latvia","LB":"Lebanon","LS":"Lesotho","LR":"Liberia",
   131	  "LY":"Libya","LI":"Liechtenstein","LT":"Lithuania","LU":"Luxembourg","MO":"Macao","MK":"North Macedonia","MG":"Madagascar","MW":"Malawi",
   132	  "MY":"Malaysia","MV":"Maldives","ML":"Mali","MT":"Malta","MH":"Marshall Islands","MQ":"Martinique","MR":"Mauritania","MU":"Mauritius",
   133	  "YT":"Mayotte","MX":"Mexico","FM":"Micronesia","MD":"Moldova","MC":"Monaco","MN":"Mongolia","ME":"Montenegro","MS":"Montserrat",
   134	  "MA":"Morocco","MZ":"Mozambique","MM":"Myanmar","NA":"Namibia","NR":"Nauru","NP":"Nepal","NL":"Netherlands","NC":"New Caledonia",
   135	  "NZ":"New Zealand","NI":"Nicaragua","NE":"Niger","NG":"Nigeria","NU":"Niue","KP":"North Korea","MP":"Northern Mariana Islands","NO":"Norway",
   136	  "OM":"Oman","PK":"Pakistan","PW":"Palau","PS":"Palestine","PA":"Panama","PG":"Papua New Guinea","PY":"Paraguay","PE":"Peru","PH":"Philippines",
   137	  "PL":"Poland","PT":"Portugal","PR":"Puerto Rico","QA":"Qatar","RE":"Réunion","RO":"Romania","RU":"Russia","RW":"Rwanda","WS":"Samoa",
   138	  "SM":"San Marino","ST":"São Tomé & Príncipe","SA":"Saudi Arabia","SN":"Senegal","RS":"Serbia","SC":"Seychelles","SL":"Sierra Leone",
   139	  "SG":"Singapore","SX":"Sint Maarten","SK":"Slovakia","SI":"Slovenia","SB":"Solomon Islands","SO":"Somalia","ZA":"South Africa","KR":"South Korea",
   140	  "SS":"South Sudan","ES":"Spain","LK":"Sri Lanka","BL":"St. Barthélemy","SH":"St. Helena","KN":"St. Kitts & Nevis","LC":"St. Lucia","MF":"St. Martin",
   141	  "PM":"St. Pierre & Miquelon","VC":"St. Vincent & the Grenadines","SD":"Sudan","SR":"Suriname","SJ":"Svalbard & Jan Mayen","SE":"Sweden","CH":"Switzerland",
   142	  "SY":"Syria","TW":"Taiwan","TJ":"Tajikistan","TZ":"Tanzania","TH":"Thailand","TL":"Timor-Leste","TG":"Togo","TK":"Tokelau","TO":"Tonga",
   143	  "TT":"Trinidad & Tobago","TN":"Tunisia","TR":"Turkey","TM":"Turkmenistan","TC":"Turks & Caicos Islands","TV":"Tuvalu","UG":"Uganda","UA":"Ukraine",
   144	  "AE":"United Arab Emirates","GB":"United Kingdom","US":"United States","UY":"Uruguay","UZ":"Uzbekistan","VU":"Vanuatu","VA":"Vatican City",
   145	  "VE":"Venezuela","VN":"Vietnam","VI":"U.S. Virgin Islands","WF":"Wallis & Futuna","EH":"Western Sahara","YE":"Yemen","ZM":"Zambia","ZW":"Zimbabwe"
   146	};
   147	
   148	// ======== دوال المساعدة ========
   149	function emitAdminUpdate() {
   150	  io.emit("adminUpdate", getAdminSnapshot());
   151	}
   152	
   153	function banUser(ip, fp) {
   154	  const expiry = Date.now() + BAN_DURATION;
   155	  if (ip) stmtInsertBan.run("ip", ip, expiry);
   156	  if (fp) stmtInsertBan.run("fp", fp, expiry);
   157	  emitAdminUpdate();
   158	}
   159	
   160	function unbanUser(ip, fp) {
   161	  if (ip) stmtDeleteBan.run("ip", ip);
   162	  if (fp) stmtDeleteBan.run("fp", fp);
   163	  emitAdminUpdate();
   164	}
   165	
   166	function getAdminSnapshot() {
   167	  const now = Date.now();
   168	  const cutoff24h = now - 24*3600*1000;
   169	
   170	  const unique24h = stmtUniqueVisitors24h.get(cutoff24h).cnt;
   171	  const byCountry24h = stmtVisitorsByCountry24h.all(cutoff24h);
   172	  const activeBans = stmtActiveBans.all(now);
   173	  const activeIpBans = activeBans.filter(r => r.type === "ip").map(r => ({ ip: r.value, expires: r.expiry }));
   174	  const activeFpBans = activeBans.filter(r => r.type === "fp").map(r => ({ fp: r.value, expires: r.expiry }));
   175	
   176	  const dbReports = stmtGetReports.all();
   177	  const reportsMap = new Map();
   178	  for (const row of dbReports) {
   179	    if (!reportsMap.has(row.targetId)) reportsMap.set(row.targetId, { count: 0, reporters: new Set(), screenshot: null });
   180	    const obj = reportsMap.get(row.targetId);
   181	    obj.count++;
   182	    obj.reporters.add(row.reporterId);
   183	    if (row.screenshot) obj.screenshot = row.screenshot;
   184	  }
   185	  const reportedUsers = Array.from(reportsMap.entries()).map(([target, obj]) => ({
   186	    target, count: obj.count,
   187	    reporters: Array.from(obj.reporters),
   188	    screenshot: obj.screenshot
   189	  }));
   190	
   191	  const recentVisitors = db.prepare(`
   192	    SELECT ip, fp, country, ts
   193	    FROM visitors
   194	    WHERE id IN (
   195	      SELECT MAX(id)
   196	      FROM visitors
   197	      GROUP BY ip
   198	    )
   199	    ORDER BY ts DESC
   200	    LIMIT 50
   201	  `).all();
   202	
   203	  const bannedCountries = stmtGetBannedCountries.all().map(r => r.code);
   204	
   205	  return {
   206	    stats: {
   207	      connected: io.of("/").sockets.size,
   208	      waiting: waitingQueue.length,
   209	      partnered: partners.size / 2,
   210	      totalVisitors: unique24h,
   211	      countryCounts: Object.fromEntries(byCountry24h.map(r => [r.country, r.cnt]))
   212	    },
   213	    activeIpBans, activeFpBans, reportedUsers, recentVisitors, bannedCountries
   214	  };
   215	}
   216	
   217	// ======== نقاط نهاية المصادقة الجديدة ========
   218	
   219	// تسجيل الدخول
   220	app.post("/api/admin/login", async (req, res) => {
   221	  try {
   222	    const { username, password } = req.body;
   223	
   224	    if (!username || !password) {
   225	      return res.status(400).json({ success: false, message: "Username and password required" });
   226	    }
   227	
   228	    // البحث عن المستخدم في قاعدة البيانات
   229	    const user = stmtGetAdminUser.get(username);
   230	    
   231	    if (!user) {
   232	      return res.status(401).json({ success: false, message: "اسم المستخدم أو كلمة المرور غير صحيحة" });
   233	    }
   234	
   235	    // التحقق من كلمة المرور
   236	    const isValidPassword = await bcrypt.compare(password, user.password);
   237	    
   238	    if (!isValidPassword) {
   239	      return res.status(401).json({ success: false, message: "اسم المستخدم أو كلمة المرور غير صحيحة" });
   240	    }
   241	
   242	    // إنشاء التوكن
   243	    const token = jwt.sign(
   244	      { 
   245	        userId: user.id, 
   246	        username: user.username,
   247	        permissions: user.permissions ? user.permissions.split(',') : ['ban', 'broadcast', 'reports']
   248	      },
   249	      JWT_SECRET,
   250	      { expiresIn: JWT_EXPIRES_IN }
   251	    );
   252	
   253	    res.json({ 
   254	      success: true, 
   255	      token: token,
   256	      user: { 
   257	        username: user.username,
   258	        permissions: user.permissions ? user.permissions.split(',') : ['ban', 'broadcast', 'reports']
   259	      }
   260	    });
   261	
   262	  } catch (error) {
   263	    console.error("Login error:", error);
   264	    res.status(500).json({ success: false, message: "خطأ في الخادم" });
   265	  }
   266	});
   267	
   268	// التحقق من التوكن
   269	app.post("/api/admin/verify", authenticateToken, (req, res) => {
   270	  res.json({ 
   271	    success: true, 
   272	    user: req.user,
   273	    message: "Token is valid"
   274	  });
   275	});
   276	
   277	// تحديث التوكن
   278	app.post("/api/admin/refresh", authenticateToken, (req, res) => {
   279	  const newToken = jwt.sign(
   280	    { 
   281	      userId: req.user.userId, 
   282	      username: req.user.username,
   283	      permissions: req.user.permissions
   284	    },
   285	    JWT_SECRET,
   286	    { expiresIn: JWT_EXPIRES_IN }
   287	  );
   288	
   289	  res.json({ 
   290	    success: true, 
   291	    token: newToken
   292	  });
   293	});
   294	
   295	// التحقق من الصلاحيات
   296	app.post("/api/admin/permissions", authenticateToken, (req, res) => {
   297	  const { level } = req.body;
   298	  const hasPermission = req.user.permissions && req.user.permissions.includes(level);
   299	  res.json({ hasPermission: !!hasPermission });
   300	});
   301	
   302	// ======== المسارات القديمة (مع التوكن الجديد) ========
   303	
   304	app.get("/admin", adminAuth, (req, res) => {
   305	  res.sendFile(path.join(__dirname, "admin-dashboard.html"));
   306	});
   307	
   308	app.get("/admin/countries-list", authenticateToken, (req, res) => {
   309	  res.send({ all: Object.keys(COUNTRIES), banned: stmtGetBannedCountries.all().map(r => r.code) });
   310	});
   311	
   312	app.post("/admin/block-country", authenticateToken, (req, res) => {
   313	  const code = (req.body.code || "").toUpperCase();
   314	  if (!code || !COUNTRIES[code]) return res.status(400).send({ error: "invalid" });
   315	  stmtInsertBannedCountry.run(code);
   316	  emitAdminUpdate();
   317	  res.send({ ok: true });
   318	});
   319	
   320	app.post("/admin/unblock-country", authenticateToken, (req, res) => {
   321	  stmtDeleteBannedCountry.run((req.body.code || "").toUpperCase());
   322	  emitAdminUpdate();
   323	  res.send({ ok: true });
   324	});
   325	
   326	app.post("/admin/clear-blocked", authenticateToken, (req, res) => {
   327	  stmtClearBannedCountries.run();
   328	  emitAdminUpdate();
   329	  res.send({ ok: true });
   330	});
   331	
   332	app.get("/admin/stats-data", authenticateToken, (req, res) => {
   333	  const from = req.query.from ? new Date(req.query.from) : null;
   334	  const to = req.query.to ? new Date(req.query.to) : null;
   335	  const params = [];
   336	  let where = "";
   337	  if (from) { where += " WHERE ts >= ?"; params.push(from.getTime()); }
   338	  if (to) { where += (where ? " AND" : " WHERE") + " ts <= ?"; params.push(to.getTime() + 24*3600*1000 -1); }
   339	
   340	  // Daily visitors
   341	  const dailyMap = new Map();
   342	  const rows = db.prepare("SELECT ts FROM visitors" + where).all(params);
   343	  for (const r of rows) {
   344	    const key = new Date(r.ts).toISOString().slice(0,10);
   345	    dailyMap.set(key, (dailyMap.get(key)||0) + 1);
   346	  }
   347	  const daily = Array.from(dailyMap.entries()).sort((a,b)=>a[0].localeCompare(b[0])).map(([date,count])=>({date,count}));
   348	
   349	  // Countries with visitor count
   350	  const countryRows = db.prepare("SELECT country,COUNT(DISTINCT ip||'|'||COALESCE(fp,'')) as cnt FROM visitors" + where + " GROUP BY country ORDER BY cnt DESC LIMIT 50").all(params);
   351	  const countries = countryRows.map(r => ({ country: r.country || "Unknown", count: r.cnt }));
   352	
   353	  // Recent visitors (last 500 for stats panel)
   354	  const recent = db.prepare("SELECT ip,fp,country,ts FROM visitors ORDER BY ts DESC LIMIT 500").all();
   355	
   356	  res.send({ daily, countries, recent });
   357	});
   358	
   359	app.post("/admin-broadcast", authenticateToken, (req, res) => {
   360	  const msg = req.body.message || "";
   361	  if (msg.trim()) io.emit("adminMessage", msg.trim());
   362	  res.send({ ok: true });
   363	});
   364	
   365	app.post("/unban-ip", authenticateToken, (req, res) => {
   366	  unbanUser(req.body.ip, null);
   367	  res.send({ ok: true });
   368	});
   369	
   370	app.post("/unban-fingerprint", authenticateToken, (req, res) => {
   371	  unbanUser(null, req.body.fp);
   372	  res.send({ ok: true });
   373	});
   374	
   375	app.post("/manual-ban", authenticateToken, (req, res) => {
   376	  const target = req.body.target;
   377	  if (!target) return res.status(400).send({ error: true });
   378	  const ip = userIp.get(target);
   379	  const fp = userFingerprint.get(target);
   380	  banUser(ip, fp);
   381	  const s = io.sockets.sockets.get(target);
   382	  if (s) {
   383	    s.emit("banned", { message: "You were banned by admin." });
   384	    s.disconnect(true);
   385	  }
   386	  res.send({ ok: true });
   387	});
   388	
   389	app.post("/remove-report", authenticateToken, (req, res) => {
   390	  const target = req.body.target;
   391	  if (!target) return res.status(400).send({ error: true });
   392	  stmtDeleteReports.run(target);
   393	  emitAdminUpdate();
   394	  res.send({ ok: true });
   395	});
   396	
   397	// ======== Socket.io Logic ========
   398	const waitingQueue = [];
   399	const partners = new Map();
   400	const userFingerprint = new Map();
   401	const userIp = new Map();
   402	const BAN_DURATION = 24 * 60 * 60 * 1000;
   403	
   404	io.on("connection", (socket) => {
   405	  const ip = socket.handshake.headers["cf-connecting-ip"] || socket.handshake.address || "unknown";
   406	  userIp.set(socket.id, ip);
   407	
   408	  let country = null;
   409	  const headerCountry = socket.handshake.headers["cf-ipcountry"] || socket.handshake.headers["x-country"];
   410	  if (headerCountry) country = headerCountry.toUpperCase();
   411	  else {
   412	    try {
   413	      const g = geoip.lookup(ip);
   414	      if (g && g.country) country = g.country;
   415	    } catch (e) { country = null; }
   416	  }
   417	
   418	  const ts = Date.now();
   419	  stmtInsertVisitor.run(ip, null, country, ts);
   420	
   421	  const ipBan = stmtActiveBans.all(Date.now()).find(r => r.type === "ip" && r.value === ip);
   422	  if (ipBan) {
   423	    socket.emit("banned", { message: "You are banned (IP)." });
   424	    socket.disconnect(true);
   425	    return;
   426	  }
   427	
   428	  const bannedCountries = stmtGetBannedCountries.all().map(r => r.code);
   429	  if (country && bannedCountries.includes(country)) {
   430	    socket.emit("country-blocked", { message: "الموقع محظور في بلدك", country });
   431	    return;
   432	  }
   433	
   434	  emitAdminUpdate();
   435	
   436	  socket.on("identify", ({ fingerprint }) => {
   437	    if (fingerprint) {
   438	      userFingerprint.set(socket.id, fingerprint);
   439	      db.prepare("UPDATE visitors SET fp=? WHERE ip=? AND ts=?").run(fingerprint, ip, ts);
   440	      const fpBan = stmtActiveBans.all(Date.now()).find(r => r.type === "fp" && r.value === fingerprint);
   441	      if (fpBan) {
   442	        socket.emit("banned", { message: "Device banned." });
   443	        socket.disconnect(true);
   444	        return;
   445	      }
   446	    }
   447	    emitAdminUpdate();
   448	  });
   449	
   450	  socket.on("find-partner", () => {
   451	    const fp = userFingerprint.get(socket.id);
   452	    if (fp) {
   453	      const fExp = stmtActiveBans.all(Date.now()).find(r => r.type === "fp" && r.value === fp);
   454	      if (fExp) {
   455	        socket.emit("banned", { message: "You are banned (device)." });
   456	        socket.disconnect(true);
   457	        return;
   458	      }
   459	    }
   460	    if (!waitingQueue.includes(socket.id) && !partners.has(socket.id)) waitingQueue.push(socket.id);
   461	    tryMatch();
   462	    emitAdminUpdate();
   463	  });
   464	
   465	  function tryMatch() {
   466	    while (waitingQueue.length >= 2) {
   467	      const a = waitingQueue.shift();
   468	      const b = waitingQueue.shift();
   469	      if (!a || !b) break;
   470	      if (!io.sockets.sockets.get(a) || !io.sockets.sockets.get(b)) continue;
   471	      partners.set(a, b);
   472	      partners.set(b, a);
   473	      io.to(a).emit("partner-found", { id: b, initiator: true });
   474	      io.to(b).emit("partner-found", { id: a, initiator: false });
   475	    }
   476	  }
   477	
   478	  socket.on("admin-screenshot", ({ image, partnerId }) => {
   479	    if (!image) return;
   480	    const target = partnerId || partners.get(socket.id);
   481	    if (!target) return;
   482	    const row = db.prepare("SELECT * FROM reports WHERE targetId=? ORDER BY ts DESC LIMIT 1").get(target);
   483	    if (row) db.prepare("UPDATE reports SET screenshot=? WHERE id=?").run(image, row.id);
   484	    emitAdminUpdate();
   485	  });
   486	
   487	  socket.on("signal", ({ to, data }) => {
   488	    const t = io.sockets.sockets.get(to);
   489	    if (t) t.emit("signal", { from: socket.id, data });
   490	  });
   491	
   492	  socket.on("chat-message", ({ to, message }) => {
   493	    const t = io.sockets.sockets.get(to);
   494	    if (t) t.emit("chat-message", { message });
   495	  });
   496	
   497	  socket.on("report", ({ partnerId }) => {
   498	    if (!partnerId) return;
   499	    const exists = db.prepare("SELECT * FROM reports WHERE targetId=? AND reporterId=?").get(partnerId, socket.id);
   500	    if (exists) return;
   501	    stmtInsertReport.run(partnerId, socket.id, null, Date.now());
   502	    emitAdminUpdate();
   503	
   504	    const count = db.prepare("SELECT COUNT(*) as cnt FROM reports WHERE targetId=?").get(partnerId).cnt;
   505	    if (count >= 3) {
   506	      const targetSocket = io.sockets.sockets.get(partnerId);
   507	      const targetIp = userIp.get(partnerId);
   508	      const targetFp = userFingerprint.get(partnerId);
   509	      banUser(targetIp, targetFp);
   510	      if (targetSocket) {
   511	        targetSocket.emit("banned", { message: "You have been banned for 24h due to multiple reports." });
   512	        targetSocket.disconnect(true);
   513	      }
   514	      emitAdminUpdate();
   515	    }
   516	  });
   517	
   518	  socket.on("skip", () => {
   519	    const p = partners.get(socket.id);
   520	    if (p) {
   521	      const other = io.sockets.sockets.get(p);
   522	      if (other) other.emit("partner-disconnected");
   523	      partners.delete(p);
   524	      partners.delete(socket.id);
   525	    }
   526	    if (!waitingQueue.includes(socket.id)) waitingQueue.push(socket.id);
   527	    tryMatch();
   528	    emitAdminUpdate();
   529	  });
   530	
   531	  socket.on("disconnect", () => {
   532	    const idx = waitingQueue.indexOf(socket.id);
   533	    if (idx !== -1) waitingQueue.splice(idx, 1);
   534	
   535	    const p = partners.get(socket.id);
   536	    if (p) {
   537	      const other = io.sockets.sockets.get(p);
   538	      if (other) other.emit("partner-disconnected");
   539	      partners.delete(p);
   540	    }
   541	    partners.delete(socket.id);
   542	    userFingerprint.delete(socket.id);
   543	    userIp.delete(socket.id);
   544	    emitAdminUpdate();
   545	  });
   546	});
   547	
   548	const PORT = process.env.PORT || 3000;
   549	http.listen(PORT, () => console.log("🚀 Server listening on port " + PORT));
   550	
   551	console.log("📋 Admin Panel: http://localhost:" + PORT + "/admin");
   552	console.log("🔐 Default Admin: Username=admin, Password=admin123");
