CREATE TABLE IF NOT EXISTS regattas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL
);

ALTER TABLE races ADD COLUMN regatta_id TEXT;

INSERT INTO regattas (id, name, start_date, end_date)
SELECT
  'regatta_legacy',
  'Legacy Regatta',
  COALESCE(MIN(race_date), date('now')),
  COALESCE(MAX(race_date), date('now'))
FROM races
WHERE EXISTS (SELECT 1 FROM races);

UPDATE races
SET regatta_id = 'regatta_legacy'
WHERE regatta_id IS NULL
  AND EXISTS (SELECT 1 FROM regattas WHERE id = 'regatta_legacy');

DELETE FROM regattas
WHERE id = 'regatta_legacy'
  AND NOT EXISTS (SELECT 1 FROM races WHERE regatta_id = 'regatta_legacy');

CREATE INDEX IF NOT EXISTS idx_races_regatta_id ON races (regatta_id);
