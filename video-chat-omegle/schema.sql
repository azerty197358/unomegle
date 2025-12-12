-- visitors: active sockets
CREATE TABLE IF NOT EXISTS visitors (
    socket_id TEXT PRIMARY KEY,
    ip TEXT,
    fingerprint TEXT,
    country TEXT,
    ts TIMESTAMP DEFAULT NOW()
);

-- visitors history
CREATE TABLE IF NOT EXISTS visitors_history (
    id SERIAL PRIMARY KEY,
    ip TEXT,
    fingerprint TEXT,
    country TEXT,
    ts TIMESTAMP DEFAULT NOW()
);

-- banned countries
CREATE TABLE IF NOT EXISTS banned_countries (
    code TEXT PRIMARY KEY
);

-- bans (ip / fingerprint)
CREATE TABLE IF NOT EXISTS bans (
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    expires TIMESTAMP NOT NULL,
    PRIMARY KEY(kind, value)
);

-- reports
CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY,
    target TEXT NOT NULL,
    reporter TEXT NOT NULL,
    ts TIMESTAMP DEFAULT NOW()
);

-- screenshots
CREATE TABLE IF NOT EXISTS report_screenshots (
    target TEXT PRIMARY KEY,
    image TEXT,
    ts TIMESTAMP DEFAULT NOW()
);
