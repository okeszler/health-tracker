-- Health Metrics Tracker – D1 Schema (v2)

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date TEXT NOT NULL,          -- YYYY-MM-DD
  weight_kg REAL,
  body_fat_pct REAL,
  muscle_pct REAL,
  body_water_pct REAL,
  bp_systolic INTEGER,
  bp_diastolic INTEGER,
  pulse INTEGER,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_metrics_date ON metrics(entry_date);

-- Laborwerte: flexibel, ein beliebiger Testname + Einheit pro Eintrag,
-- rückwirkend erfassbar, mehrere Werte pro Tag möglich
CREATE TABLE IF NOT EXISTS lab_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date TEXT NOT NULL,          -- YYYY-MM-DD
  test_name TEXT NOT NULL,           -- z.B. "Testosteron"
  value REAL NOT NULL,
  unit TEXT,                         -- z.B. "nmol/l", "mg/dl"
  note TEXT,                         -- z.B. "Beginn Metformin"
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_labs_test ON lab_results(test_name);
CREATE INDEX IF NOT EXISTS idx_labs_date ON lab_results(entry_date);

CREATE TABLE IF NOT EXISTS goals (
  key TEXT PRIMARY KEY,
  value REAL
);

INSERT OR IGNORE INTO goals (key, value) VALUES
  ('weight_kg', 85),
  ('body_fat_pct', 20);
