CREATE TABLE IF NOT EXISTS sailors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sail_number TEXT DEFAULT '',
  club TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS races (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  race_date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS results (
  race_id TEXT NOT NULL,
  sailor_id TEXT NOT NULL,
  status TEXT NOT NULL,
  position INTEGER,
  PRIMARY KEY (race_id, sailor_id)
);

CREATE INDEX IF NOT EXISTS idx_results_race_id ON results (race_id);
CREATE INDEX IF NOT EXISTS idx_results_sailor_id ON results (sailor_id);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO app_meta (key, value)
VALUES ('updated_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
