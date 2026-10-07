-- Health Metrics Tracker – vollständiges D1-Schema (aktueller Stand)
--
-- Für eine NEUE Datenbank reicht diese eine Datei:
--   npx wrangler d1 execute health-tracker --remote --file=schema.sql
-- Die migration_*.sql-Dateien sind nur für bestehende, ältere Installationen
-- gedacht und hier bereits alle enthalten.

-- ── Manuelle Einträge ───────────────────────────────────────────────

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

-- Laborwerte: frei benannt (Testname + Einheit), rückwirkend erfassbar,
-- mehrere Werte pro Tag möglich
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

-- ── Login ───────────────────────────────────────────────────────────

-- Rate-Limiting gegen Brute-Force auf die PIN
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts(ip, attempted_at);

-- ── Health Sync (Google Drive) ──────────────────────────────────────

-- bereits importierte Drive-Dateien, damit ein erneuter Sync nichts doppelt liest
CREATE TABLE IF NOT EXISTS sync_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  drive_file_id TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  modified_time TEXT,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Einzelmessungen; Tageswerte werden erst beim Lesen aggregiert
-- (siehe functions/api/sync-data.js)
CREATE TABLE IF NOT EXISTS sync_steps_readings (
  entry_date TEXT NOT NULL,
  reading_time TEXT NOT NULL,
  steps INTEGER NOT NULL,
  UNIQUE(entry_date, reading_time, steps)
);
CREATE INDEX IF NOT EXISTS idx_sync_steps_readings_date ON sync_steps_readings(entry_date);

CREATE TABLE IF NOT EXISTS sync_pulse_readings (
  entry_date TEXT NOT NULL,
  reading_time TEXT NOT NULL,
  bpm INTEGER NOT NULL,
  UNIQUE(entry_date, reading_time, bpm)
);
CREATE INDEX IF NOT EXISTS idx_sync_pulse_readings_date ON sync_pulse_readings(entry_date);

CREATE TABLE IF NOT EXISTS sync_sleep_readings (
  entry_date TEXT NOT NULL,
  reading_time TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  stage TEXT,
  UNIQUE(entry_date, reading_time, duration_seconds, stage)
);
CREATE INDEX IF NOT EXISTS idx_sync_sleep_readings_date ON sync_sleep_readings(entry_date);

-- Waage (Samsung Health): Muskel/Wasser beim Import von kg in % umgerechnet
CREATE TABLE IF NOT EXISTS sync_weight_readings (
  entry_date TEXT NOT NULL,
  reading_time TEXT NOT NULL,
  weight_kg REAL NOT NULL,
  body_fat_pct REAL,
  muscle_pct REAL,
  body_water_pct REAL,
  UNIQUE(entry_date, reading_time, weight_kg)
);
CREATE INDEX IF NOT EXISTS idx_sync_weight_readings_date ON sync_weight_readings(entry_date);

-- Blutdruck: Einzelmessungen, mehrere pro Tag möglich
CREATE TABLE IF NOT EXISTS sync_bp_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date TEXT NOT NULL,
  reading_time TEXT,
  systolic REAL,
  diastolic REAL,
  pulse REAL,
  note TEXT,
  UNIQUE(entry_date, reading_time, systolic, diastolic)
);
CREATE INDEX IF NOT EXISTS idx_sync_bp_date ON sync_bp_readings(entry_date);

-- Trainingseinheiten, ein Eintrag pro Aktivität
CREATE TABLE IF NOT EXISTS sync_activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date TEXT NOT NULL,
  start_time TEXT,
  activity_type TEXT,
  source_app TEXT,
  elapsed_seconds INTEGER,
  active_seconds INTEGER,
  distance_km REAL,
  calories REAL,
  steps INTEGER,
  avg_hr REAL,
  max_hr REAL,
  UNIQUE(entry_date, start_time, activity_type)
);
CREATE INDEX IF NOT EXISTS idx_sync_activities_date ON sync_activities(entry_date);
