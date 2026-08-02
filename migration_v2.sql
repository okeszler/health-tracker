-- Nur nötig, falls du das v1-Schema schon deployed hast.
-- Neuaufsetzen: einfach schema.sql neu ausführen.

ALTER TABLE metrics ADD COLUMN muscle_pct REAL;
ALTER TABLE metrics ADD COLUMN body_water_pct REAL;
ALTER TABLE metrics DROP COLUMN water_ml;

CREATE TABLE IF NOT EXISTS lab_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date TEXT NOT NULL,
  test_name TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_labs_test ON lab_results(test_name);
CREATE INDEX IF NOT EXISTS idx_labs_date ON lab_results(entry_date);

DELETE FROM goals WHERE key = 'water_ml';
