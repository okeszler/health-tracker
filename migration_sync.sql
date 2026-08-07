-- Health Sync Import (Google Drive) – neue Tabellen.
-- Ausführen mit: npx wrangler d1 execute health-tracker --remote --file=migration_sync.sql

-- merkt sich, welche Drive-Dateien schon importiert wurden, damit ein
-- erneuter Sync nichts doppelt zählt
CREATE TABLE IF NOT EXISTS sync_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  drive_file_id TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  modified_time TEXT,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tagessumme Schritte (mehrere Dateien pro Tag möglich -> wird aufaddiert)
CREATE TABLE IF NOT EXISTS sync_steps_daily (
  entry_date TEXT PRIMARY KEY,
  steps INTEGER NOT NULL DEFAULT 0
);

-- Tages-Pulsstatistik. avg wird aus sum_bpm/samples berechnet (nicht direkt
-- gespeichert), damit neue Dateien am selben Tag korrekt reinrechnen.
CREATE TABLE IF NOT EXISTS sync_pulse_daily (
  entry_date TEXT PRIMARY KEY,
  sum_bpm REAL NOT NULL DEFAULT 0,
  samples INTEGER NOT NULL DEFAULT 0,
  min_bpm INTEGER,
  max_bpm INTEGER
);

-- Tages-Schlafdauer nach Schlafstadium in Sekunden
CREATE TABLE IF NOT EXISTS sync_sleep_daily (
  entry_date TEXT PRIMARY KEY,
  total_seconds INTEGER NOT NULL DEFAULT 0,
  deep_seconds INTEGER NOT NULL DEFAULT 0,
  light_seconds INTEGER NOT NULL DEFAULT 0,
  rem_seconds INTEGER NOT NULL DEFAULT 0,
  awake_seconds INTEGER NOT NULL DEFAULT 0,
  other_seconds INTEGER NOT NULL DEFAULT 0
);

-- Einzelne Trainingseinheiten (Walking, Running, ...), ein Eintrag pro Aktivität
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

-- Gewicht aus Health Connect (falls die App das mal befüllt) -- letzter
-- Tageswert wird überschrieben, nicht aufaddiert
CREATE TABLE IF NOT EXISTS sync_weight_daily (
  entry_date TEXT PRIMARY KEY,
  weight_kg REAL
);
