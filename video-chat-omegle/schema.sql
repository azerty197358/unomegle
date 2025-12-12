-- schema.sql
CREATE TABLE IF NOT EXISTS visitors (
  socket_id TEXT PRIMARY KEY,
  ip TEXT,
  fingerprint TEXT,
  country CHAR(2),
  ts TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS visitors_history (
  id BIGSERIAL PRIMARY KEY,
  ip TEXT,
  fingerprint TEXT,
  country CHAR(2),
  ts TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reports (
  id BIGSERIAL PRIMARY KEY,
  target TEXT NOT NULL,
  reporter TEXT NOT NULL,
  ts TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_screenshots (
  target TEXT PRIMARY KEY,
  image TEXT,
  ts TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bans (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL, -- 'ip' | 'fingerprint'
  value TEXT NOT NULL,
  expires TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS bans_kind_value_idx ON bans(kind, value);

CREATE TABLE IF NOT EXISTS banned_countries (
  code CHAR(2) PRIMARY KEY,
  ts TIMESTAMP WITH TIME ZONE DEFAULT now()
);
