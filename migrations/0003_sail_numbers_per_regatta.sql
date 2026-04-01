CREATE TABLE IF NOT EXISTS sailor_regatta_numbers (
  sailor_id TEXT NOT NULL,
  regatta_id TEXT NOT NULL,
  sail_number TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (sailor_id, regatta_id)
);

INSERT INTO sailor_regatta_numbers (sailor_id, regatta_id, sail_number)
SELECT s.id, r.id, s.sail_number
FROM sailors s
CROSS JOIN regattas r
WHERE s.sail_number IS NOT NULL
  AND s.sail_number <> ''
ON CONFLICT(sailor_id, regatta_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_srn_regatta ON sailor_regatta_numbers (regatta_id);
CREATE INDEX IF NOT EXISTS idx_srn_sailor ON sailor_regatta_numbers (sailor_id);
