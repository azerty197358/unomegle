-- File: schema.sql
-- PostgreSQL schema for the app — idempotent CREATEs

CREATE TABLE IF NOT EXISTS visitors (
  socket_id TEXT PRIMARY KEY,
  ip TEXT,
  fingerprint TEXT,
  country TEXT,
  ts TIMESTAMP DEFAULT NOW(),
  waiting BOOLEAN DEFAULT FALSE,
  paired BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS visitors_history (
  id SERIAL PRIMARY KEY,
  ip TEXT,
  fingerprint TEXT,
  country TEXT,
  ts TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS banned_countries (
  code TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS bans (
  kind TEXT NOT NULL,               -- "ip" or "fingerprint"
  value TEXT NOT NULL,
  expires TIMESTAMP NOT NULL,
  PRIMARY KEY(kind, value)
);

CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  target TEXT NOT NULL,
  reporter TEXT NOT NULL,
  ts TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS report_screenshots (
  target TEXT PRIMARY KEY,
  image TEXT,
  ts TIMESTAMP DEFAULT NOW()
);

-- indexes to help queries (lightweight)
CREATE INDEX IF NOT EXISTS idx_visitors_history_ts ON visitors_history (ts);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports (target);
CREATE INDEX IF NOT EXISTS idx_visitors_country ON visitors_history (country);
