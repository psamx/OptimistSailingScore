CREATE TABLE IF NOT EXISTS regatta_participants (
  regatta_id TEXT NOT NULL,
  sailor_id TEXT NOT NULL,
  PRIMARY KEY (regatta_id, sailor_id)
);

INSERT INTO regatta_participants (regatta_id, sailor_id)
SELECT DISTINCT r.regatta_id, res.sailor_id
FROM races r
JOIN results res ON res.race_id = r.id
WHERE r.regatta_id IS NOT NULL
ON CONFLICT(regatta_id, sailor_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_regatta_participants_regatta ON regatta_participants (regatta_id);
CREATE INDEX IF NOT EXISTS idx_regatta_participants_sailor ON regatta_participants (sailor_id);
